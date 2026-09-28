#!/usr/bin/env python3
"""
Cascade intelligence MCP server.

Exposes the hook runtime in scripts/hooks/ as MCP tools, so Claude Code (or any
MCP client) can query it directly:

  knowledge_search    TF-IDF search over Knowledge/ and memory files
  route_task          which specialist agent fits a task, and how confident
  record_outcome      log whether an agent succeeded, for pattern learning
  intelligence_stats  index size, learned patterns, observation counts
  drift_checkpoint    snapshot the git commit before spawning parallel agents
  drift_check         files changed by more than one commit since then

Every tool shells out to a Node module in scripts/hooks/, so this server and the
Claude Code hooks read and write the same .cascade/ state.

Workspace: CASCADE_ROOT, or the directory the server starts in. That's the
folder holding your Knowledge/ directory and the .cascade/ state.

Failures (no index yet, Node missing, not a git repo) are raised, so MCP
clients see them as tool errors rather than as results.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

from mcp.server.fastmcp import FastMCP

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
HOOKS_DIR = REPO_ROOT / "scripts" / "hooks"
WORKSPACE = Path(os.environ.get("CASCADE_ROOT") or os.getcwd()).expanduser().resolve()

# vector-search.cjs's CLI returns at most this many matches.
MAX_SEARCH_RESULTS = 5

mcp = FastMCP("cascade")


def _run(cmd: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    """Run a command in the workspace. stdin is closed on purpose: this server
    talks MCP over its own stdin, and a child that inherited it (hook-handler.cjs
    reads stdin) would swallow the client's requests."""
    if not WORKSPACE.is_dir():
        raise RuntimeError(f"Workspace {WORKSPACE} isn't a directory. Check CASCADE_ROOT.")
    if shutil.which(cmd[0]) is None:
        raise RuntimeError(f"{cmd[0]} isn't on PATH.")
    try:
        return subprocess.run(
            cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=timeout, cwd=str(WORKSPACE),
            env={**os.environ, "CASCADE_ROOT": str(WORKSPACE)},
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{' '.join(cmd[:2])} timed out after {timeout}s.") from None


def _node(*args: str) -> str:
    """Run Node with the given arguments. Returns stdout; raises on failure."""
    proc = _run(["node", *args])
    out = proc.stdout.strip()
    if proc.returncode != 0:
        raise RuntimeError(out or proc.stderr.strip() or f"Exited with code {proc.returncode}.")
    return out


def _hook(script: str, *args: str) -> str:
    """Run one of the modules in scripts/hooks/ as a CLI and return its output."""
    path = HOOKS_DIR / script
    if not path.exists():
        raise RuntimeError(f"Cascade hook not found: {path}")
    return _node(str(path), *args)


def _require_git_head() -> None:
    """The drift tools compare commits, so they need a git repo with a commit.
    drift-detector.cjs swallows git errors, so check up front."""
    if _run(["git", "rev-parse", "--verify", "--quiet", "HEAD"]).returncode != 0:
        raise RuntimeError(
            f"{WORKSPACE} isn't a git repo with at least one commit, so there's nothing to track drift against."
        )


@mcp.tool()
def knowledge_search(query: str, top_k: int = MAX_SEARCH_RESULTS) -> str:
    """Search Knowledge/ and memory files by TF-IDF similarity.

    Returns up to top_k matches (1-5), best first, as JSON with id, score,
    summary, category and confidence. The index is built at session start by
    the Cascade hooks, or by running `node scripts/hooks/intelligence.cjs init`.
    """
    if not query.strip():
        raise ValueError("Give me something to search for.")
    top_k = max(1, min(top_k, MAX_SEARCH_RESULTS))
    raw = _hook("vector-search.cjs", "search", query)
    try:
        matches = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(raw or "vector-search.cjs returned nothing.") from None
    if not matches:
        return f"No matches for {query!r}."
    return json.dumps(matches[:top_k], indent=2)


@mcp.tool()
def route_task(task: str) -> str:
    """Recommend a specialist agent for a task, from Cascade's domain patterns.
    Returns JSON with agent, confidence and the pattern that matched."""
    if not task.strip():
        raise ValueError("Describe the task to route.")
    return _hook("router.cjs", task)


@mcp.tool()
def record_outcome(agent: str, task: str, success: bool) -> str:
    """Log whether an agent succeeded at a task. At session end, Cascade turns
    repeated successes into learned patterns (failures are logged, not used)."""
    if not task.strip():
        raise ValueError("Nothing recorded: task is empty.")
    path = HOOKS_DIR / "intelligence.cjs"
    if not path.exists():
        raise RuntimeError(f"Cascade hook not found: {path}")
    script = (
        "const [mod, agent, task, ok] = process.argv.slice(1);"
        "require(mod).recordOutcome(agent, task, ok === 'true');"
    )
    _node("-e", script, str(path), agent or "unknown", task, "true" if success else "false")
    return f"Recorded: {agent or 'unknown'} {'succeeded' if success else 'failed'} at {task[:80]!r}"


@mcp.tool()
def intelligence_stats() -> str:
    """Current knowledge index size, learned patterns, and observation counts."""
    return _hook("hook-handler.cjs", "stats", "--json") or "No stats yet. Start a session first."


@mcp.tool()
def drift_checkpoint() -> str:
    """Snapshot the current git commit before spawning parallel agents, so
    drift_check can spot files that more than one commit changed."""
    _require_git_head()
    return _hook("drift-detector.cjs", "checkpoint") or "Checkpoint set."


@mcp.tool()
def drift_check() -> str:
    """List files changed by more than one commit since the last checkpoint.
    Only committed work counts; uncommitted edits aren't seen."""
    _require_git_head()
    return _hook("drift-detector.cjs", "check") or "No drift since the last checkpoint."


if __name__ == "__main__":
    mcp.run()

# Cascade

**An AI-native operations layer for knowledge work.**

Cascade is the framework behind [samwarren.io](https://samwarren.io) — the
runtime that turns Claude Code into a conversational layer across whatever
work system you plug it into. It does six things:

1. **Classifies intent** — you type plain English, Cascade routes it to the right skill or agent without waiting for slash commands.
2. **Surfaces context on every turn** — a TF-IDF index over your `Knowledge/` folder + an episodic memory of past actions fires relevant snippets into the prompt automatically.
3. **Dispatches to specialists** — keyword patterns match each request to a specialist agent (Python work to `python-pro`, SQL to `sql-pro`, React to `nextjs-developer`), and a strong match tells Claude to spawn it.
4. **Routes to the right model tier** — a deterministic classifier recommends Opus / Sonnet / Haiku per prompt, with asymmetric thresholds that bias toward the cheap tier for trivia and demand strong evidence before escalating. Every decision is logged for retrospective tuning.
5. **Takes corrections** — tell it a learned command habit is right or wrong (`instincts.cjs reinforce <id>` / `correct <id>`) and its confidence moves, surviving the next re-mine. Agent and model routing don't learn on their own; their rules are plain pattern tables you edit.
6. **Mines instincts from its own history** — commands you repeat across sessions become confidence-scored habits ("before committing → run prettier") surfaced when the prompt matches their domain.

This repo is the **framework** — the hook runtime, the MCP servers, the
bootstrap. Your instance of it (your Knowledge, your routing table, your
task system) lives in your own private repo or workspace.

Started as a fork of Aman Khan's
[personal-os](https://github.com/amanaiproduct/personal-os) template. The
hook runtime grew on top of it; the template's task and backlog layer
lives in Aman's repo, not this one.

## What's in here

```
cascade/
├── README.md             this doc
├── install.sh            installer
├── LICENSE               MIT
├── NOTICE.md             credits + license notices for adapted code
├── core/
│   └── mcp/
│       ├── server.py           Cascade's intelligence MCP — knowledge_search, route_task, record_outcome, drift checks
│       ├── salesforce_mcp.py   Optional Salesforce MCP — query, list reports, update dashboards
│       └── requirements.txt
├── scripts/
│   ├── context-health.py       context window breakdown — run whenever you're curious
│   └── hooks/
│       ├── hook-handler.cjs    main dispatcher
│       ├── intelligence.cjs    knowledge indexing + TF-IDF search + domain-override table
│       ├── router.cjs          keyword-pattern routing to specialist agents
│       ├── model-router.cjs    per-prompt Claude tier recommendation (Opus/Sonnet/Haiku) + decision log
│       ├── instincts.cjs       confidence-scored command habits mined from the observation DB
│       ├── read-gate.cjs       PreToolUse guardrail — read-before-edit + lint-config protection
│       ├── session.cjs         session state + metrics
│       ├── observations.cjs    episodic memory, SQLite FTS5 backing store
│       ├── vector-search.cjs   TF-IDF vectorizer + cosine similarity
│       └── drift-detector.cjs  git-state conflict detection across parallel agents
```

## What this is not

- **Not a Claude Code config.** For that, see
  [claude-dotfiles](https://github.com/swsounds42/claude-dotfiles) — the
  portable agent library and settings template that's meant to be symlinked
  into `~/.claude/`.
- **Not a personal assistant you can use as-is.** Cascade is shaped by the
  Knowledge, Tasks, and Goals of whoever's running it. Clone this, then
  build your own.
- **Not a product.** It's a framework, a set of patterns, and a reference
  implementation.

## Quick start

```bash
git clone git@github.com:swsounds42/cascade.git ~/cascade
cd ~/cascade
./install.sh
```

The installer will:

1. Detect your OS (macOS or Linux)
2. Install Python deps for the MCP server (`pip install -r core/mcp/requirements.txt`)
3. Symlink `scripts/hooks/*.cjs` into `~/.claude/hooks/` so Claude Code fires them on session start + tool use
4. Print MCP server registration instructions for your `~/.claude/settings.json`

## Setting up your workspace

Cascade works out of the folder you run Claude Code in, or the folder
`CASCADE_ROOT` points to. All it needs there is a `Knowledge/` directory
(plus `git init`, if you want drift detection):

```bash
mkdir -p ~/ops/Knowledge && cd ~/ops && git init
```

Drop notes into `Knowledge/`. The TF-IDF index rebuilds on every session
start — your notes become searchable context automatically. Cascade keeps
its own state (index, observations, routing history) in `.cascade/`
alongside them.

Want a task list, a backlog, and daily and weekly planning loops to go with
it? That's what Aman Khan's
[personal-os](https://github.com/amanaiproduct/personal-os) gives you, and
it's where Cascade started. Use it as your workspace and run the hooks on
top.

## Intelligence hooks, in one paragraph

The hooks in `scripts/hooks/` fire on three Claude Code events:

- **`SessionStart`** — indexes any files in `Knowledge/` via TF-IDF. Loads episodic memory from SQLite. Prints a stat line so you know how much brain surface area just came online.
- **`UserPromptSubmit`** — on every prompt, looks up relevant knowledge and past similar actions. Surfaces the top matches in the prompt as context. Recommends the specialist agent whose patterns match the request, which Claude tier the task warrants (model-router), and any learned command habits that apply (instincts).
- **`PreToolUse`** — the read-gate: blocks edits to files that haven't been Read this session (kills the blind-edit retry loop) and blocks edits to lint/formatter configs so the agent fixes code instead of weakening rules. Fail-open, kill-switchable.
- **`PostToolUse`** — records every tool call as an episodic observation. Checkpoints git state before parallel agent dispatches. Flags files touched by multiple agents in the same wave (drift detection).

Everything is local — SQLite for episodic memory, JSON for TF-IDF vectors.
No external services, no phone-home.

## MCP server

`core/mcp/server.py` exposes the intelligence layer as Model Context Protocol
tools so Claude Code (and other MCP clients) can query it directly:

| Tool | What it does |
|------|--------------|
| `knowledge_search(query, top_k)` | TF-IDF search over `Knowledge/` and memory files (up to 5 matches) |
| `route_task(task)` | Specialist-agent recommendation with confidence and the pattern that matched |
| `record_outcome(agent, task, success)` | Log whether an agent succeeded; repeated successes become learned patterns at session end |
| `intelligence_stats()` | Index size, learned patterns, observation counts |
| `drift_checkpoint()` | Snapshot the current git commit before spawning parallel agents |
| `drift_check()` | Report files changed by more than one commit since the last checkpoint (committed work only) |

Each tool calls the matching module in `scripts/hooks/` (Node required), so
the MCP server and the hooks share the same `.cascade/` state. The drift
tools need the workspace to be a git repo.

Register it in `~/.claude/settings.json` (the installer prints this with
your paths filled in):

```json
{
  "mcpServers": {
    "cascade": {
      "command": "/absolute/path/to/cascade/core/mcp/.venv/bin/python3",
      "args": ["/absolute/path/to/cascade/core/mcp/server.py"]
    }
  }
}
```

If your workspace isn't the folder you launch Claude Code from, set
`CASCADE_ROOT` in both places: export it in your shell so the hooks see it,
and add `"env": {"CASCADE_ROOT": "/path/to/your/workspace"}` to the server
entry. Otherwise the hooks and the server keep separate `.cascade/` state.

## Optional: Salesforce MCP

`core/mcp/salesforce_mcp.py` is a small read-mostly Salesforce connector
for anyone doing RevOps work. Exposes `sf_query`, `sf_list_reports`,
`sf_update_report_filters`, `sf_refresh_dashboard`, and friends. Requires
three env vars:

```
SALESFORCE_CLIENT_ID
SALESFORCE_CLIENT_SECRET
SALESFORCE_INSTANCE_URL
```

It signs in with the OAuth client-credentials flow, so your connected app
needs that flow enabled.

## Built on

- [Claude Code](https://claude.com/claude-code) — the runtime.
- [Model Context Protocol](https://modelcontextprotocol.io) — the tool-exposure layer.
- SQLite FTS5 for episodic memory, plain TF-IDF for Knowledge search — both chosen because local-first beats network-dependent for something that fires on every prompt.

## License

MIT. See `LICENSE`.

A few files adapt code from [Ruflo](https://github.com/ruvnet/ruflo) and
[Nelson](https://github.com/Aspegio/nelson), both MIT; their notices are in
`NOTICE.md`. None of the personal-os template's files remain, but earlier
commits in this repo's history include them, and those stay under Aman
Khan's [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
license.

## See also

- [claude-dotfiles](https://github.com/swsounds42/claude-dotfiles) — portable `~/.claude/` config, agent library
- [samwarren.io/projects/cascade](https://samwarren.io/projects/cascade) — the case study, the thesis, the stats

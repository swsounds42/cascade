# Cascade

**An AI-native operations layer for knowledge work.**

Cascade is the framework behind [samwarren.io](https://samwarren.io) — the
runtime that turns Claude Code into a conversational layer across whatever
work system you plug it into. It does four things:

1. **Classifies intent** — you type plain English, Cascade routes it to the right skill or agent without waiting for slash commands.
2. **Surfaces context on every turn** — a TF-IDF index over your `Knowledge/` folder + an episodic memory of past actions fires relevant snippets into the prompt automatically.
3. **Dispatches to specialists** — domain-aware routing biases toward the agent with the best track record for your current task.
4. **Learns from corrections** — every outcome gets recorded; patterns promote to long-term biases over time.

This repo is the **framework** — the hook runtime, the MCP servers, the
workflow templates, the bootstrap. Your instance of it (your Knowledge,
your Tasks, your Goals, your routing table) lives in your own private
repo or workspace.

## What's in here

```
cascade/
├── README.md             this doc
├── AGENTS.md             the default agent instructions — starting contract
├── install.sh            installer
├── LICENSE               MIT
├── core/
│   ├── mcp/
│   │   ├── server.py           Cascade's intelligence MCP — exposes knowledge_search, route_task, record_outcome, drift_check
│   │   ├── salesforce_mcp.py   Optional Salesforce MCP — query, list reports, update dashboards
│   │   └── requirements.txt
│   ├── integrations/README.md  notes on wiring up external tools
│   └── templates/              scaffolding for your own Cascade instance
│       ├── AGENTS.md
│       ├── config.yaml
│       └── gitignore
├── scripts/
│   ├── context-health.py       context window breakdown — run whenever you're curious
│   └── hooks/
│       ├── hook-handler.cjs    main dispatcher
│       ├── intelligence.cjs    knowledge indexing + TF-IDF search
│       ├── router.cjs          domain-aware task routing with outcome history
│       ├── session.cjs         session state + metrics
│       ├── observations.cjs    episodic memory, SQLite FTS5 backing store
│       ├── vector-search.cjs   TF-IDF vectorizer + cosine similarity
│       └── drift-detector.cjs  git-state conflict detection across parallel agents
└── examples/
    └── workflows/              generic workflow templates — backlog processing, morning standup, weekly review, content generation
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
5. Optionally scaffold a starter personal-OS directory from `core/templates/`

## Scaffolding your own instance

After install, start your own personal ops layer in a new directory:

```bash
mkdir ~/ops && cd ~/ops
cp ~/cascade/core/templates/* .
cp ~/cascade/AGENTS.md .
mkdir Knowledge Tasks
touch BACKLOG.md GOALS.md
```

Edit `AGENTS.md` to describe how you want your assistant to behave. Drop
notes into `Knowledge/`. The TF-IDF index rebuilds on every session start
— your notes become searchable context automatically.

From there, read the workflows in `examples/workflows/` to understand the
loops Cascade is optimized for:

- **`morning-standup.md`** — "What should I work on today?" with goal-alignment checks
- **`backlog-processing.md`** — clearing `BACKLOG.md` into structured tasks with dedup
- **`weekly-review.md`** — retrospective prompts
- **`content-generation.md`** — writing in a specific voice with source-grounded research

## Intelligence hooks, in one paragraph

The hooks in `scripts/hooks/` fire on three Claude Code events:

- **`SessionStart`** — indexes any files in `Knowledge/` via TF-IDF. Loads episodic memory from SQLite. Prints a stat line so you know how much brain surface area just came online.
- **`UserPromptSubmit`** — on every prompt, looks up relevant knowledge and past similar actions. Surfaces the top matches in the prompt as context. Recommends which specialist agent historically handles this kind of request best.
- **`PostToolUse`** — records every tool call as an episodic observation. Checkpoints git state before parallel agent dispatches. Flags files touched by multiple agents in the same wave (drift detection).

Everything is local — SQLite for episodic memory, JSON for TF-IDF vectors.
No external services, no phone-home.

## MCP server

`core/mcp/server.py` exposes the intelligence layer as Model Context Protocol
tools so Claude Code (and other MCP clients) can query it directly:

| Tool | What it does |
|------|--------------|
| `knowledge_search(query, top_k)` | Semantic search over `Knowledge/` via TF-IDF |
| `route_task(description)` | Domain-aware specialist-agent recommendation with confidence + historical hit rate |
| `record_outcome(agent, task, success, notes)` | Teach the router which agents work for what |
| `intelligence_stats()` | Current index size, memory entries, recent routing decisions |
| `drift_checkpoint(label)` | Snapshot git state before spawning parallel agents |
| `drift_check()` | Report files touched by multiple agents since the last checkpoint |

Register it in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "cascade": {
      "command": "python3",
      "args": ["/absolute/path/to/cascade/core/mcp/server.py"]
    }
  }
}
```

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

Written for connected-app OAuth with JWT; see the docstring at the top of
the file.

## Built on

- [Claude Code](https://claude.com/claude-code) — the runtime.
- [Model Context Protocol](https://modelcontextprotocol.io) — the tool-exposure layer.
- SQLite FTS5 for episodic memory, plain TF-IDF for Knowledge search — both chosen because local-first beats network-dependent for something that fires on every prompt.

## License

MIT. See `LICENSE`.

## See also

- [claude-dotfiles](https://github.com/swsounds42/claude-dotfiles) — portable `~/.claude/` config, agent library
- [samwarren.io/projects/cascade](https://samwarren.io/projects/cascade) — the case study, the thesis, the stats

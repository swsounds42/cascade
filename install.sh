#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# install.sh — Set up Cascade on a fresh machine
#
# What it does:
#   1. Detects OS (macOS or Linux)
#   2. Creates a Python venv and installs MCP server deps
#   3. Symlinks the hook runtime into ~/.claude/hooks/
#   4. Prints MCP server registration instructions
#
# Flags:
#   --dry   preview without writing
#   --force skip backup prompts
# ─────────────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_HOOKS_DIR="$CLAUDE_DIR/hooks"
MCP_DIR="$REPO_DIR/core/mcp"
VENV_DIR="$MCP_DIR/.venv"

DRY_RUN=false
FORCE=false

for arg in "$@"; do
  case $arg in
    --dry) DRY_RUN=true ;;
    --force) FORCE=true ;;
  esac
done

# ─── Colors ──────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}+${NC} $1"; }
info() { echo -e "${BLUE}i${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
err()  { echo -e "${RED}x${NC} $1"; }

echo ""
echo "=== Cascade Install ==="
echo "Repo:   $REPO_DIR"
echo "Target: $CLAUDE_HOOKS_DIR"
echo ""

# ─── OS detection ────────────────────────────────────────────
OS="unknown"
if   [[ "$OSTYPE" == "darwin"* ]];   then OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then OS="linux"
fi
info "Detected OS: $OS"

$DRY_RUN && warn "DRY RUN — no changes will be made"

# ─── Python deps for MCP server ──────────────────────────────
echo ""
echo "--- Python MCP server ---"

if ! command -v python3 &>/dev/null; then
  err "python3 not found. Install Python 3.11+ first."
  exit 1
fi

if $DRY_RUN; then
  info "Would create venv at $VENV_DIR and install core/mcp/requirements.txt"
else
  if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
    ok "Created venv at $VENV_DIR"
  else
    info "venv already exists at $VENV_DIR"
  fi
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  pip install --quiet --upgrade pip
  pip install --quiet -r "$MCP_DIR/requirements.txt"
  ok "Installed MCP requirements"
  deactivate
fi

# ─── Symlink hooks ───────────────────────────────────────────
echo ""
echo "--- Hook runtime ---"

if ! command -v node &>/dev/null; then
  warn "node not found. The hooks and the MCP server run on Node.js (22+ for the SQLite observation layer)."
fi

mkdir -p "$CLAUDE_HOOKS_DIR"

link_hook() {
  local name="$1"
  local src="$REPO_DIR/scripts/hooks/$name"
  local dst="$CLAUDE_HOOKS_DIR/$name"

  if [ ! -f "$src" ]; then
    warn "Skipping $name (not in repo)"
    return
  fi

  if $DRY_RUN; then
    info "Would link $dst -> $src"
    return
  fi

  # Backup existing non-symlink
  if [ -f "$dst" ] && [ ! -L "$dst" ]; then
    if $FORCE; then
      mv "$dst" "${dst}.bak.$(date +%s)"
      warn "Backed up existing $name"
    else
      warn "$dst exists and is not a symlink."
      read -p "  Back up and replace? [y/N] " -n 1 -r
      echo ""
      [[ $REPLY =~ ^[Yy]$ ]] && mv "$dst" "${dst}.bak.$(date +%s)" || { warn "Skipping $name"; return; }
    fi
  fi

  [ -L "$dst" ] && rm "$dst"
  ln -sfn "$src" "$dst"
  ok "Linked $name"
}

for hook in hook-handler.cjs intelligence.cjs router.cjs model-router.cjs instincts.cjs read-gate.cjs session.cjs observations.cjs vector-search.cjs drift-detector.cjs; do
  link_hook "$hook"
done

# ─── Print MCP registration instructions ─────────────────────
echo ""
echo "--- MCP server registration ---"

PYTHON_PATH="$VENV_DIR/bin/python3"
MCP_SERVER="$MCP_DIR/server.py"

cat <<EOF

To register Cascade's intelligence MCP with Claude Code, add this to
$CLAUDE_DIR/settings.json under "mcpServers":

  "cascade": {
    "command": "$PYTHON_PATH",
    "args": ["$MCP_SERVER"]
  }

If you also want the Salesforce connector, add:

  "salesforce": {
    "command": "$PYTHON_PATH",
    "args": ["$MCP_DIR/salesforce_mcp.py"],
    "env": {
      "SALESFORCE_CLIENT_ID": "<your id>",
      "SALESFORCE_CLIENT_SECRET": "<your secret>",
      "SALESFORCE_INSTANCE_URL": "https://yourcompany.my.salesforce.com"
    }
  }

EOF

echo ""
ok "Cascade is installed."
info "Next: set up a workspace — see README.md 'Setting up your workspace'."
echo ""

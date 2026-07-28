#!/usr/bin/env node
/**
 * Cascade Read-Gate — PreToolUse guardrail
 *
 * Two fail-open guardrails, enforced deterministically by a hook (not prose):
 *
 *   1. Read-before-write — block Edit/Write/MultiEdit/NotebookEdit to an
 *      EXISTING file that has not been Read this session. Directly enforces the
 *      "read-before-edit discipline": blind edits are one of the biggest silent
 *      token-waste patterns (retry loops from editing stale context). A Read is
 *      objective and verifiable; "are you sure?" is not.
 *
 *   2. Config-protection — block edits to lint/formatter config files so the
 *      agent fixes the source to satisfy the rules instead of weakening them.
 *
 * Adapted (not copied) from affaan-m/ECC's GateGuard + config-protection (MIT).
 * ECC demands the agent "present facts" (unverifiable); Cascade gates on the
 * objective "was this file Read?" signal instead.
 *
 * Block mechanism: stderr message + exit code 2 — the same contract Cascade's
 * `pre-bash` handler already uses (hook-handler.cjs).
 *
 * Scope (proving): enforces ONLY when the session cwd is inside this repo,
 * unless CASCADE_READGATE_GLOBAL=1. Wiring it globally is therefore safe — it
 * is a no-op everywhere else until you flip that one env var.
 *
 * Kill switch: CASCADE_READGATE=off|0|false  → allow everything.
 * State: ~/.cascade/readgate/state-<sid>.json — atomic writes, 30-min expiry.
 *
 * SAFETY: any error, unparseable input, or unknown shape → ALLOW. This hook
 * must never brick editing because of its own bug.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---- Config -------------------------------------------------------------

// Repo root derived from this file's location (<repo>/scripts/hooks/read-gate.cjs)
// — portable, no hardcoded user path.
const REPO_ROOT = process.env.CASCADE_ROOT || path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(os.homedir(), '.cascade', 'readgate');
const TTL_MS = 30 * 60 * 1000; // 30 min inactivity → fresh slate

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Linter/formatter configs agents tend to weaken instead of fixing code.
// pyproject.toml and tsconfig.json are deliberately EXCLUDED (legit to edit).
const PROTECTED_CONFIGS = new Set([
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
  '.prettierrc', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.toml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
  'biome.json', 'biome.jsonc',
  'ruff.toml', '.ruff.toml',
  '.shellcheckrc',
  '.stylelintrc', '.stylelintrc.js', '.stylelintrc.cjs', '.stylelintrc.json', '.stylelintrc.yml', '.stylelintrc.yaml',
  '.markdownlint.json', '.markdownlint.jsonc', '.markdownlint.yaml', '.markdownlint.yml', '.markdownlintrc',
]);

// ---- Helpers ------------------------------------------------------------

function isDisabled() {
  return /^(0|off|false|no|disabled?)$/i.test(String(process.env.CASCADE_READGATE || '').trim());
}
function isGlobal() {
  return /^(1|on|true|yes|global)$/i.test(String(process.env.CASCADE_READGATE_GLOBAL || '').trim());
}

function inScope(input) {
  if (isGlobal()) return true;
  const cwd = path.resolve(input.cwd || process.cwd());
  const root = path.resolve(REPO_ROOT);
  return cwd === root || cwd.startsWith(root + path.sep);
}

function sessionKey(input) {
  const raw = input.session_id || input.transcript_path || input.cwd || process.cwd() || 'global';
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
}
function statePath(key) { return path.join(STATE_DIR, `state-${key}.json`); }

function loadState(key) {
  try {
    const p = statePath(key);
    if (!fs.existsSync(p)) return { seen: {}, last_active: 0 };
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!st || typeof st !== 'object' || typeof st.seen !== 'object') return { seen: {}, last_active: 0 };
    if (Date.now() - (st.last_active || 0) > TTL_MS) return { seen: {}, last_active: 0 }; // expired
    return st;
  } catch { return { seen: {}, last_active: 0 }; }
}

function saveState(key, st) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const cutoff = Date.now() - TTL_MS;
    for (const k of Object.keys(st.seen)) { if (st.seen[k] < cutoff) delete st.seen[k]; } // prune
    st.last_active = Date.now();
    const tmp = `${statePath(key)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st), 'utf8');
    fs.renameSync(tmp, statePath(key)); // atomic
  } catch { /* state is best-effort; never fatal */ }
}

function markSeen(key, target) {
  const st = loadState(key);
  st.seen[target] = Date.now();
  saveState(key, st);
}

function resolveTargetPath(input) {
  const ti = input.tool_input || input.toolInput || {};
  const fp = ti.file_path || ti.notebook_path || ti.path || ti.file;
  if (!fp || typeof fp !== 'string') return null;
  const cwd = input.cwd || process.cwd();
  return path.isAbsolute(fp) ? fp : path.resolve(cwd, fp);
}

function fileExists(p) {
  try { fs.lstatSync(p); return true; }
  catch (e) { return !(e && e.code === 'ENOENT'); } // non-ENOENT error → assume exists (gate-safe)
}

// ---- Core ---------------------------------------------------------------

/**
 * @param {string} raw  Raw JSON hook payload from stdin.
 * @returns {string|undefined}  A block reason (→ deny) or undefined (→ allow).
 */
function run(raw) {
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { return; } // unparseable → allow
  if (isDisabled()) return;       // kill switch → allow
  if (!inScope(input)) return;    // outside proving scope → allow

  const tool = input.tool_name || input.toolName || '';
  const key = sessionKey(input);
  const target = resolveTargetPath(input);

  // Any Read makes the file "seen". Never block a Read.
  if (tool === 'Read') {
    if (target) markSeen(key, target);
    return;
  }

  if (!EDIT_TOOLS.has(tool)) return; // not an edit tool → allow
  if (!target) return;               // unresolvable path → allow

  const base = path.basename(target);
  const exists = fileExists(target);

  // 1) Config-protection takes precedence.
  if (exists && PROTECTED_CONFIGS.has(base)) {
    return `Cascade read-gate: "${base}" is a linter/formatter config. Fix the source code to satisfy the rules instead of weakening the config. (override: CASCADE_READGATE=off)`;
  }

  // 2) Read-before-write on existing files.
  if (exists) {
    const st = loadState(key);
    if (!st.seen[target]) {
      return `Cascade read-gate: Read "${base}" before editing it — it hasn't been Read this session. Blind edits cause expensive retry loops. Read ${target} first, then retry the edit. (override: CASCADE_READGATE=off)`;
    }
    markSeen(key, target); // refresh; allow
    return;
  }

  // New file (doesn't exist) → allow, and mark seen so follow-up edits pass.
  markSeen(key, target);
  return;
}

module.exports = { run, PROTECTED_CONFIGS, REPO_ROOT };

// ---- CLI entry ----------------------------------------------------------
if (require.main === module) {
  let data = '';
  const finish = () => {
    let reason;
    try { reason = run(data); } catch { reason = undefined; } // fail-open
    if (reason) { process.stderr.write(reason + '\n'); process.exit(2); } // block
    process.exit(0); // allow
  };
  if (process.stdin.isTTY) { finish(); }
  else {
    const timer = setTimeout(finish, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
    process.stdin.resume();
  }
}

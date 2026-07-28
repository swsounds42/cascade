#!/usr/bin/env node
/**
 * Cascade Instincts — confidence-scored learned behaviors
 * ──────────────────────────────────────────────────────
 * Revives Cascade's dormant learning loop. The existing intelligence.cjs
 * consolidate() works on agent-outcome "pending insights" (which never get
 * written, so it's cold). THIS module instead mines the rich observation DB
 * (observations.cjs — 30k+ captured tool calls) that the old loop ignored.
 *
 * An instinct is an atomic, confidence-weighted, evidence-backed behavior —
 * the unit ECC's continuous-learning-v2 introduced. Cascade's version:
 *
 *   { id, trigger, action, domain, scope, confidence (0.3–0.9), evidence, source }
 *
 * v1 mines COMMAND HABITS deterministically (no LLM): commands you repeat
 * across sessions become instincts ("before committing → run prettier"), with
 * confidence scaled by frequency + session-spread, and ECC's promotion rule
 * (seen in 2+ projects → global scope). Manual reinforce/correct adjust
 * confidence and survive re-mining.
 *
 * SEMANTIC mining (deriving behavioral rules from corrections, ECC's Haiku
 * observer) is NOT done here — it needs an LLM. The store + surfacing are built
 * so that pass can append instincts with source:'llm-observer' later. See
 * `addInstinct()` and the README seam.
 *
 * Storage: $CASCADE_ROOT/.cascade/instincts/instincts.json (gitignored).
 * Surfaced on the route hook as a [CASCADE INSTINCTS] block.
 *
 * CLI:
 *   node instincts.cjs mine [--min N] [--quiet]   # (re)mine the observation DB
 *   node instincts.cjs show [--all]               # list instincts
 *   node instincts.cjs match "<prompt>"           # instincts relevant to a prompt
 *   node instincts.cjs surface "<prompt>"         # the [CASCADE INSTINCTS] block
 *   node instincts.cjs reinforce <id>             # +confidence (you confirmed it)
 *   node instincts.cjs correct <id>               # −confidence / disable (it was wrong)
 *
 * Fail-safe: every path degrades to empty/no-op; never throws to hook callers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = process.env.CASCADE_ROOT || process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, '.cascade', 'instincts');
const STORE_PATH = path.join(DATA_DIR, 'instincts.json');

const CONF_MIN = 0.3, CONF_MAX = 0.9;
const DEFAULT_MIN_COUNT = 4;     // a command must repeat this often to become an instinct
const DEFAULT_MIN_SESSIONS = 2;  // …across at least this many sessions (a habit, not a one-off)

// Shell plumbing / navigation — frequent but NOT behavioral instincts.
const NOISE_COMMANDS = new Set(['cd','ls','ll','pwd','echo','cat','grep','rg','find','fd','head','tail','sort','uniq','wc','which','type','mkdir','rmdir','touch','rm','mv','cp','ln','chmod','chown','export','source','sleep','clear','tree','open','printf','sed','awk','cut','tr','xargs','tee','env','set','unset','history','man','less','more','diff','cmp','basename','dirname','realpath','readlink','date','whoami','hostname','kill','ps','top','df','du','tar','zip','unzip','jq','col','column','curl','wget']);
// Bare interpreters with no script = inline one-offs, not a habit.
const BARE_INTERPRETERS = new Set(['python3','python','node','bun','deno','ruby','perl','sh','bash','zsh']);
// Shell keywords / control words that leak in as a first token.
['read','until','while','for','do','done','then','fi','esac','case','time','watch','secrets','eval','exec','trap','wait','exit','return','local','declare'].forEach((x) => NOISE_COMMANDS.add(x));

// ---- Store --------------------------------------------------------------

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (!s || !Array.isArray(s.instincts)) return { version: 1, instincts: [], adjustments: {} };
    if (!s.adjustments) s.adjustments = {};
    return s;
  } catch { return { version: 1, instincts: [], adjustments: {} }; }
}
function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
}
function clamp(x) { return Math.max(CONF_MIN, Math.min(CONF_MAX, x)); }
function instinctId(domain, sig) {
  return crypto.createHash('sha1').update(`${domain}|${sig}`).digest('hex').slice(0, 10);
}

// ---- Command parsing ----------------------------------------------------

function extractCommand(inputSummary) {
  if (typeof inputSummary !== 'string') return null;
  // input_summary is JSON.stringify(tool_input) truncated to 500 chars (+ '…').
  try {
    const j = JSON.parse(inputSummary.replace(/…$/, ''));
    if (j && typeof j.command === 'string') return j.command;
  } catch { /* truncated JSON — fall back to regex */ }
  const m = inputSummary.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  return null;
}

function commandSignature(cmd) {
  if (typeof cmd !== 'string') return null;
  let c = cmd.trim()
    .replace(/^(sudo\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, '') // strip env assigns / sudo
    .replace(/^rtk\s+(?:proxy\s+)?/, '');                          // unwrap rtk proxy
  const toks = c.split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const first = toks[0].split('/').pop();
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('-')) continue;                       // skip flags
    if (/^["'`]/.test(t) || /[|&;><$(){}]/.test(t)) break; // stop at quotes/operators
    const word = t.split('/').pop().replace(/["'`]/g, ''); // basename, de-quote
    if (word && /^[A-Za-z0-9@._-]+$/.test(word)) return `${first} ${word}`;
    break;
  }
  return first;
}

const DOMAIN_RULES = [
  [/\b(prettier|eslint|biome|stylelint|ruff|black|gofmt|rustfmt)\b/, 'formatting'],
  [/\b(vitest|jest|pytest|mocha|tsc|playwright|rspec)\b/, 'verification'],
  [/^(npm|pnpm|yarn|bun) (i|install|add|ci)\b|^pip\b|^poetry\b|^bundle\b/, 'deps'],
  [/^gh\b/, 'github'],
  [/^git\b/, 'git'],
  [/^sf\b|\bsfdx\b|\bsalesforce\b/, 'salesforce'],
  [/\b(docker|kubectl|terraform|vercel|wrangler)\b/, 'infra'],
];
function domainFor(sig) {
  const s = sig.toLowerCase(); // raw — anchors (^) must work, so no padding
  for (const [re, d] of DOMAIN_RULES) if (re.test(s)) return d;
  return 'workflow';
}
const TRIGGERS = {
  git: 'before committing / when doing git work',
  formatting: 'after editing code, before committing',
  verification: 'before marking work done / when verifying',
  deps: 'when managing dependencies',
  github: 'when working with GitHub PRs or issues',
  salesforce: 'when doing Salesforce work',
  infra: 'when deploying or managing infra',
  workflow: 'in this kind of task',
};

// ---- Mining -------------------------------------------------------------

function confidence(count, sessions) {
  return clamp(0.30 + 0.05 * Math.min(count, 12) + 0.03 * Math.min(sessions, 10));
}

function mine(opts = {}) {
  const minCount = opts.minCount || DEFAULT_MIN_COUNT;
  const minSessions = opts.minSessions || DEFAULT_MIN_SESSIONS;
  let db;
  try { db = require('./observations.cjs').getDB(); } catch { db = null; }
  if (!db) return { ok: false, reason: 'observation DB unavailable', instincts: [] };

  let rows;
  try {
    rows = db.prepare(`
      SELECT o.input_summary AS inp, o.session_id AS sid, o.timestamp AS ts, s.project_path AS proj
      FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
      WHERE o.tool_name = 'Bash'
    `).all();
  } catch (e) { return { ok: false, reason: e.message, instincts: [] }; }

  const agg = new Map(); // sig -> {count, sessions:Set, projects:Set, last, sample}
  for (const r of rows) {
    const cmd = extractCommand(r.inp);
    if (!cmd || cmd.trim().startsWith('#')) continue;       // skip comments / empty
    const sig = commandSignature(cmd);
    if (!sig || sig.length < 2) continue;
    if (NOISE_COMMANDS.has(sig.split(' ')[0])) continue;    // skip shell plumbing
    if (BARE_INTERPRETERS.has(sig)) continue;               // skip bare interpreters
    if (!agg.has(sig)) agg.set(sig, { count: 0, sessions: new Set(), projects: new Set(), last: 0, sample: cmd });
    const a = agg.get(sig);
    a.count++;
    if (r.sid) a.sessions.add(r.sid);
    if (r.proj) a.projects.add(path.basename(r.proj));
    if (r.ts > a.last) a.last = r.ts;
  }

  const store = readStore();
  const adj = store.adjustments || {};
  const mined = [];
  for (const [sig, a] of agg) {
    if (a.count < minCount || a.sessions.size < minSessions) continue;
    const domain = domainFor(sig);
    const id = instinctId(domain, sig);
    if (adj[id] && adj[id].disabled) continue; // user corrected this away
    let conf = confidence(a.count, a.sessions.size);
    if (adj[id] && typeof adj[id].delta === 'number') conf = clamp(conf + adj[id].delta);
    mined.push({
      id, trigger: TRIGGERS[domain], action: `run \`${sig}\``,
      domain,
      scope: a.projects.size >= 2 ? 'global' : `project:${[...a.projects][0] || 'unknown'}`,
      confidence: Number(conf.toFixed(2)),
      evidence: { count: a.count, sessions: a.sessions.size, projects: a.projects.size, sample: (a.sample || '').slice(0, 120), last_seen: a.last },
      source: 'observation-mining',
    });
  }
  mined.sort((x, y) => y.confidence - x.confidence || y.evidence.count - x.evidence.count);

  // Preserve any LLM/manual instincts that mining doesn't produce.
  const kept = (store.instincts || []).filter(i => i.source && i.source !== 'observation-mining');
  store.instincts = [...mined, ...kept];
  store.generated_at = new Date().toISOString();
  writeStore(store);
  return { ok: true, instincts: store.instincts, minedCount: mined.length };
}

// ---- Surfacing ----------------------------------------------------------

const STOP = new Set(['the','a','an','to','of','and','or','for','in','on','is','it','my','i','this','that','with','do','run','make','can','you','please','need','want','should','how']);
function tokens(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}
// Prompt phrasing → domain, so "commit" pulls git/formatting/verification
// instincts even without an exact word match against the trigger text.
const DOMAIN_HINTS = {
  git: /\b(commit|committing|push|pushing|stage|staged|branch|merge|rebase|git)\b/,
  formatting: /\b(commit|committing|format|formatting|lint|prettier|clean ?up)\b/,
  verification: /\b(test|tests|verify|verifying|check|typecheck|tsc|ci|build|done|ship)\b/,
  deps: /\b(install|installing|dependenc|package|upgrade|bump)\b/,
  github: /\b(pr|prs|pull request|gh|issue|github|review|merge)\b/,
  salesforce: /\b(salesforce|soql|apex|sfdx|\bsf\b|opp|attribution|campaign)\b/,
  infra: /\b(deploy|deploying|docker|terraform|vercel|wrangler|infra|release)\b/,
};
function match(prompt, opts = {}) {
  const store = readStore();
  const minConf = opts.minConf != null ? opts.minConf : 0.5;
  const raw = (prompt || '').toLowerCase();
  const pt = new Set(tokens(prompt));
  if (!pt.size) return [];
  const scored = [];
  for (const inst of store.instincts || []) {
    if (inst.confidence < minConf) continue;
    const hay = tokens(`${inst.trigger} ${inst.action} ${inst.domain}`);
    let hits = 0;
    for (const w of hay) if (pt.has(w)) hits++;
    const domainHit = DOMAIN_HINTS[inst.domain] && DOMAIN_HINTS[inst.domain].test(raw) ? 2 : 0;
    const total = hits + domainHit;
    if (total > 0) scored.push({ inst, score: total + inst.confidence });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit || 3).map(s => s.inst);
}
function surface(prompt) {
  const hits = match(prompt);
  if (!hits.length) return '';
  const lines = hits.map(i =>
    `  • (${i.confidence.toFixed(2)}) ${i.trigger} → ${i.action}  [seen ${i.evidence?.count ?? '?'}× / ${i.evidence?.sessions ?? '?'} sessions]`);
  return `[CASCADE INSTINCTS] Learned from your history:\n${lines.join('\n')}`;
}

// ---- Manual reinforcement ----------------------------------------------

function adjust(id, delta, disabled) {
  const store = readStore();
  store.adjustments = store.adjustments || {};
  const cur = store.adjustments[id] || { delta: 0 };
  if (disabled) cur.disabled = true;
  else { cur.delta = Math.max(-0.6, Math.min(0.6, (cur.delta || 0) + delta)); cur.disabled = false; } // delta accumulates freely; confidence is clamped at apply time
  store.adjustments[id] = cur;
  // reflect on the live instinct too
  const inst = (store.instincts || []).find(i => i.id === id);
  if (inst) {
    if (disabled) store.instincts = store.instincts.filter(i => i.id !== id);
    else inst.confidence = Number(clamp(inst.confidence + delta).toFixed(2));
  }
  writeStore(store);
  return store.adjustments[id];
}

module.exports = { mine, match, surface, adjust, readStore, commandSignature, extractCommand, domainFor };

// ---- CLI ----------------------------------------------------------------
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? (rest[i + 1] || true) : undefined; };
  try {
    if (cmd === 'mine') {
      const r = mine({ minCount: Number(flag('--min')) || undefined });
      if (!r.ok) { console.log('[instincts] mine failed: ' + r.reason); process.exit(0); }
      if (!rest.includes('--quiet')) {
        console.log(`[instincts] mined ${r.minedCount} command-habit instinct(s) from observations.`);
        for (const i of r.instincts.filter(x => x.source === 'observation-mining').slice(0, 15)) {
          console.log(`  ${i.id}  (${i.confidence})  ${i.domain.padEnd(12)} ${i.action}  [${i.evidence.count}× / ${i.evidence.sessions}s / ${i.scope}]`);
        }
      }
    } else if (cmd === 'show') {
      const store = readStore();
      const list = (store.instincts || []).filter(i => rest.includes('--all') || i.confidence >= 0.5);
      console.log(`[instincts] ${list.length} instinct(s):`);
      for (const i of list) console.log(`  ${i.id}  (${i.confidence})  ${i.domain.padEnd(12)} ${i.action}  [${i.evidence?.count ?? '?'}× / ${i.scope}] {${i.source}}`);
    } else if (cmd === 'match') {
      console.log(JSON.stringify(match(rest.join(' ')), null, 2));
    } else if (cmd === 'surface') {
      const block = surface(rest.join(' '));
      console.log(block || '(no relevant instincts)');
    } else if (cmd === 'reinforce') {
      console.log(JSON.stringify(adjust(rest[0], +0.1, false)));
    } else if (cmd === 'correct') {
      const r = adjust(rest[0], -0.2, rest.includes('--disable'));
      console.log(JSON.stringify(r));
    } else {
      console.log('usage: node instincts.cjs [mine|show|match "q"|surface "q"|reinforce <id>|correct <id> [--disable]]');
    }
  } catch (e) { console.log('[instincts] error: ' + e.message); }
  process.exit(0);
}

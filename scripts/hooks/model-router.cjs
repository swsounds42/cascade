#!/usr/bin/env node
/**
 * Cascade Model Router (aggressive mode)
 * Recommends a Claude model tier (Opus / Sonnet / Haiku) for a given prompt.
 *
 * Architecture:
 *   - Tier 1: deterministic regex rules (zero latency, free)
 *   - Tier 2: length-based fallback — short prompts default to Haiku
 *   - Tier 3: Sonnet default when nothing else fires
 *   - Output: advisory tag emitted by hook-handler.cjs `route` event
 *
 * Aggressive thresholds (asymmetric on purpose):
 *   - Opus emit:  ≥0.85 — narrow set of escalations, only when really sure
 *   - Haiku emit: ≥0.65 — broad set of downgrades, bias toward saving credits
 *   - Sonnet stays silent (the default needs no tag)
 *
 * Rationale: you pay per Opus token. The cost of Opus running on trivia is
 * ~5× wasted credits, silent and recurring. The cost of Haiku failing on hard work
 * is one wasted turn that the user notices and retries with `!opus`. Lean toward
 * Haiku when uncertain — the failure mode is recoverable, the success mode saves money.
 *
 * Logged for retrospective tuning. After ~200-500 logged decisions, recalibrate.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.CASCADE_ROOT
  || path.resolve(__dirname, '..', '..');
const DECISIONS_FILE = path.join(PROJECT_ROOT, '.cascade', 'sessions', 'model-decisions.jsonl');

// Asymmetric thresholds — see header comment for rationale.
const EMIT_THRESHOLD_OPUS  = 0.85;  // Opus needs strong signal
const EMIT_THRESHOLD_HAIKU = 0.65;  // Haiku catches more downgrades

// Length-based fallback: prompts shorter than this fall to Haiku unless they
// match a higher-tier pattern. Empirically, short prompts are usually quick
// edits, lookups, or confirmations.
const SHORT_PROMPT_CHARS = 80;
const SHORT_PROMPT_WORDS = 12;

// Pattern rules — first match wins. Order = specificity (specific → general).
// Each rule: { pattern, model, tier, confidence, reason }
// The skill-name patterns (gsd-*, gws-*, recipe-*, sf-*) match the public GSD /
// Google Workspace / Salesforce skill packs — swap in your own skill families.
const MODEL_PATTERNS = [
  // ───────────────────────── EXPLICIT OVERRIDES (highest priority) ─────────────────────────
  { pattern: /(?:^|\s)!opus\b|--opus\b|\bforce.opus\b|\buse.opus\b/i,
    model: 'opus',   tier: 'override', confidence: 1.0, reason: 'Explicit !opus override' },
  { pattern: /(?:^|\s)!sonnet\b|--sonnet\b|\bforce.sonnet\b|\buse.sonnet\b/i,
    model: 'sonnet', tier: 'override', confidence: 1.0, reason: 'Explicit !sonnet override' },
  { pattern: /(?:^|\s)!haiku\b|--haiku\b|\bforce.haiku\b|\buse.haiku\b/i,
    model: 'haiku',  tier: 'override', confidence: 1.0, reason: 'Explicit !haiku override' },

  // ───────────────────────── OPUS — deep reasoning, novel design, hard problems ─────────────────────────

  // GSD skills that imply deep reasoning
  { pattern: /\b(gsd-plan-phase|gsd-new-project|gsd-research-phase|gsd-ai-integration-phase)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.95, reason: 'GSD planning/research skill' },
  { pattern: /\b(gsd-debug|gsd-forensics|gsd-eval-review|gsd-discuss-phase|gsd-autonomous)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.92, reason: 'GSD deep-thinking skill' },

  // Architecture / system design
  { pattern: /\b(architecture|system.design|design.system|design.review|architectural.decision)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.88, reason: 'Architecture / system design' },
  // "Design a new caching layer / ingestion pipeline / data platform"
  // Verbs are design/architect/reimagine ONLY (not build — that's implementation, Sonnet).
  // Nouns are architecture-scale ONLY (not service/module — those are implementation nouns).
  // Allows 1-3 words between articles and noun, so "the data ingestion pipeline" matches.
  { pattern: /\b(design|architect|reimagine)\s+(?:a\s+|the\s+|some\s+|new\s+|our\s+)*(?:\w+\s+){1,3}(system|architecture|infrastructure|pipeline|engine|framework|platform|stack|layer)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'Design a system/architecture' },
  // Loose "novel/greenfield" — kept for telemetry, silent at OPUS threshold
  { pattern: /\b(novel|greenfield|new.from.scratch).{0,20}(feature|design|architecture|system|product)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.78, reason: 'Novel design work (loose)' },

  // Hard debugging — production / cross-system signals
  { pattern: /\bdebug.{0,30}(production|critical|cross.system|intermittent|race.condition|deadlock|memory.leak)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'Hard debugging (production-grade)' },
  { pattern: /\b(root.cause|systematic.debug|production.outage|incident.response|why.is.this.crashing)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'Production-grade debugging' },
  // Looser debug signals — silent at threshold
  { pattern: /\bdebug.{0,30}(hard|tough|tricky|complex)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.78, reason: 'Self-described hard debug (loose)' },

  // Security / risk-critical analysis
  { pattern: /\b(security.review|security.audit|threat.model|vulnerability.assess|pen.test|penetration.test)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.88, reason: 'Security-critical analysis' },

  // Strategic / executive output
  { pattern: /\b(board.update|investor.update|exec.brief|strategic.memo|exec.summary)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.90, reason: 'Strategic / executive output' },

  // Explicit deep-thinking requests — emit at threshold (genuine reasoning signals)
  { pattern: /\b(think.hard|think.deeply|deeply.analyze|reason.through|reason.carefully)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'Explicit deep-reasoning request' },
  { pattern: /\b(deep.{0,5}(look|hard|thorough)|hard.look|thorough.review|really.{0,5}analyze)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'Diagnostic / thorough-review request' },
  // Deep-dive TIGHT — phrase AND a domain keyword (AND via lookaheads). Emits at threshold.
  { pattern: /^(?=[\s\S]*\b(deep[\s-]?(dive|thinking|think|research|analysis)|extensive analysis)\b)(?=[\s\S]*\b(system|architecture|architect|decision|problem|strategy|tradeoff|design|root[\s-]?cause)\b)/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'Deep-dive on a system/decision (reasoning)' },
  // Deep-dive LOOSE — kept silent at threshold (overused phrase, no domain anchor)
  { pattern: /\b(deep.dive|deep.thinking|deep.research|extensive.analysis)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.78, reason: 'Deep-dive (loose)' },

  // System / routing audits — diagnostic work, warrants Opus
  { pattern: /\b(audit|introspect).{0,15}(routing|system|skill|agent|cascade|pipeline|infra|architecture)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'System / routing audit' },
  { pattern: /\bsee.if.{0,15}(it|this|that|the|its).{0,5}(really|actually).{0,5}(works|fires|matches)/i,
    model: 'opus', tier: 'reasoning', confidence: 0.85, reason: 'Verification of system behavior' },
  { pattern: /\b(why.{0,10}(isnt|doesnt|wont).{0,15}(work|fire|match)|nagging.feeling|something.{0,5}(is.off|seems.off|feels.off|is.broken|isnt.right))\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.86, reason: 'Diagnostic intuition signal' },

  // Multi-phase / large refactors — silent at threshold (Sonnet handles fine)
  { pattern: /\b(multi.phase.plan|complex.refactor|major.refactor|migration.plan|legacy.modernization)\b/i,
    model: 'opus', tier: 'reasoning', confidence: 0.76, reason: 'Multi-phase refactor (loose)' },

  // ───────────────────────── HAIKU — trivial, mechanical, lookup ─────────────────────────

  // Pure confirmations / acknowledgments
  { pattern: /^(yes|no|ok|okay|sounds good|continue|proceed|go ahead|do it|sure|yep|nope)[\s.!?]*$/i,
    model: 'haiku', tier: 'trivial', confidence: 0.95, reason: 'Confirmation / acknowledgment' },

  // Mechanical confirmations (longer forms)
  { pattern: /\b(lgtm|ship.it|looks.good|approve.this|merge.it|reject.this|deny.this|accept.this|abort.this|cancel.this|done|all.set)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.85, reason: 'Approval / mechanical confirmation' },

  // Mechanical text fixes
  { pattern: /\b(typo|fix.typo|spelling|misspell|rename.var|rename.variable)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.92, reason: 'Mechanical text fix' },
  { pattern: /\b(format|lint|prettier|eslint).fix\b|\bfix.(format|lint|style|whitespace|indentation)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.88, reason: 'Format/lint fix' },

  // Commit / git ceremony
  { pattern: /\b(generate.commit|commit.message|git.commit.message|write.commit)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.92, reason: 'Commit message generation' },

  // Cascade quick commands
  { pattern: /\bcascade,?\s+(backlog|focus|status|note|hull|review)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.90, reason: 'Cascade quick command' },

  // GSD trivial / lookup skills
  { pattern: /\b(gsd-fast|gsd-note|gsd-add-todo|gsd-add-backlog|gsd-progress|gsd-stats|gsd-help|gsd-list-workspaces|gsd-check-todos|gsd-recap)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.88, reason: 'GSD lookup / quick-capture skill' },

  // Google Workspace mechanical ops
  { pattern: /\bgws-(gmail|calendar|sheets|drive|docs|slides|tasks|chat|meet|forms|keep|people)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.78, reason: 'Google Workspace mechanical op' },

  // Recipe skills (deterministic workflows)
  { pattern: /\brecipe-[a-z\-]+/i,
    model: 'haiku', tier: 'trivial', confidence: 0.78, reason: 'Recipe / deterministic workflow' },

  // Salesforce mechanical ops (queries, metadata, deploy — not strategic)
  { pattern: /\bsf-(soql|metadata|deploy|debug|docs|connected.apps|permissions)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.72, reason: 'SF mechanical op' },

  // Mechanical single-field changes
  { pattern: /\b(update|change|set|tweak|edit|modify).{0,18}(field|value|status|config|setting|line|attribute|property|column)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.78, reason: 'Mechanical single-field change' },

  // Simple deletions / removals
  { pattern: /\b(delete|remove|drop|clear|clean.up).{0,18}(file|line|field|entry|record|column|row|directory|folder)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.75, reason: 'Simple deletion' },

  // Script / command execution
  { pattern: /\b(run|execute|invoke|trigger|kick.off).{0,15}(script|command|test|query|cli|process|migration|job|workflow)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.72, reason: 'Run/execute mechanical' },

  // Specific file/line edits
  { pattern: /\b(add|update|change|append).{0,20}\bto\b.{0,20}(line|file|config|setting|column|row|sheet)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.72, reason: 'Specific file/line edit' },

  // Read-only lookups
  { pattern: /^(show|read|cat|view|display|list|print|tail|grep|find)(?:\s+me)?\s+/i,
    model: 'haiku', tier: 'trivial', confidence: 0.82, reason: 'Read-only lookup' },
  { pattern: /^(what|where|when|how|who).{0,60}\?[\s.!]*$/i,
    model: 'haiku', tier: 'trivial', confidence: 0.75, reason: 'Simple Q&A' },
  { pattern: /\b(what.does|how.does|where.is)\s+\w+\s+(do|work|live|exist)/i,
    model: 'haiku', tier: 'trivial', confidence: 0.72, reason: 'Brief lookup' },
  { pattern: /\bexplain\s+\w+\s+(briefly|in.one.line|quickly)/i,
    model: 'haiku', tier: 'trivial', confidence: 0.75, reason: 'Brief explanation' },

  // Self-described trivial
  { pattern: /\b(simple|trivial|quick|tiny|small|minor).{0,12}(fix|change|edit|task|tweak|update|patch)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.82, reason: 'Self-described trivial' },

  // Single-line / one-liner edits
  { pattern: /\b(one.liner|single.line|just.add|just.change|just.fix|just.update).{0,40}/i,
    model: 'haiku', tier: 'trivial', confidence: 0.80, reason: 'One-line edit' },

  // Status / list / count requests
  { pattern: /\b(check|show).{0,15}(status|count|number.of|how.many)\b/i,
    model: 'haiku', tier: 'trivial', confidence: 0.72, reason: 'Status / count check' },

  // ───────────────────────── SONNET (explicit) — standard work ─────────────────────────
  // These protect legitimate code work from the length-based Haiku fallback below.
  // Tier='standard' means shouldEmit() returns false — no directive printed, work runs inline on Sonnet.

  { pattern: /\b(code.review|review.this.code|pr.review|review.my.code|review.the.changes)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.70, reason: 'Code review (standard size)' },
  { pattern: /\b(write|draft).{0,18}(email|slack.message|slack.post|message|post|reply)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.70, reason: 'Standard writing task' },
  { pattern: /\b(refactor|cleanup|restructure|reorganize)\b(?!.*(major|large|complex|legacy))/i,
    model: 'sonnet', tier: 'standard', confidence: 0.65, reason: 'Standard refactor' },

  // Standard build / implementation tasks (code noun present)
  { pattern: /\b(implement|build|add|create|write|wire.up).{0,30}(feature|function|endpoint|component|service|api|handler|module|class|method|hook|util|helper|migration|schema|model|middleware|controller|route|repository|validator|parser|page|view|form)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.72, reason: 'Standard build task' },

  // Test writing
  { pattern: /\b(write|add|generate).{0,15}(tests?|specs?|test.cases?|unit.tests?|integration.tests?|e2e.tests?)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.72, reason: 'Test writing' },

  // Bug fix (general — typo/lint already caught earlier as Haiku)
  { pattern: /\bfix.{0,30}(bug|issue|error|exception|problem|failure|crash|regression|broken)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.70, reason: 'Bug fix (standard)' },

  // Multi-file / module-scoped work
  { pattern: /\b(across|multiple|several|various)\s+(files|modules|components|services|endpoints|handlers)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.72, reason: 'Multi-file work' },

  // Docs / README updates (non-trivial wording, but not Opus)
  { pattern: /\b(update|write|draft|revise).{0,15}(docs?|documentation|readme|guide|tutorial|changelog)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.70, reason: 'Documentation update' },

  // Conversational work direction — rescues medium-length prompts that would silently
  // hit Sonnet 'default' anyway, giving them an explicit tier/reason. The 50-char floor
  // ensures short trivia (which must keep flowing to the Haiku short-prompt fallback)
  // is never caught here. The 400-char ceiling excludes large specs (already caught above).
  // The negative lookahead blocks escalation-eligible subjects so this never promotes
  // something that should be Opus.
  { pattern: /^(?=[\s\S]{50,400}$)(?!.*\b(deep|system|architecture|debug|audit|security|design)\b).*\b(let'?s|we should|we need|can you|i want to|go ahead and|please)\b.*\b(fix|update|build|review|refactor|sweep|clean|rework|wire|hook up|pull|re-?pull|set up|add|remove|redo|rebuild)\b/i,
    model: 'sonnet', tier: 'standard', confidence: 0.65, reason: 'Conversational work direction (standard)' },
];

/**
 * Returns true when a short prompt carries clear "real-work signal" that should
 * rescue it from the aggressive short→Haiku length fallback and let it fall
 * through to the Sonnet default instead.
 *
 * Conservative by design — only four narrow categories. The router deliberately
 * biases toward Haiku for true trivia; this guard rescues only obvious work signals.
 * Do NOT add a bare multi-sentence / period-splitting heuristic — that over-triggers
 * on things like "Thanks. Yep."
 *
 * @param {string} prompt - raw prompt text
 * @returns {boolean}
 */
function hasRealWorkSignal(prompt) {
  const p = prompt.toLowerCase();

  // Category 1 — Troubleshooting / breakage
  const troubleshooting = [
    /\b(can'?t|cannot|won'?t|doesn'?t|isn'?t|not)\s+(see|work|working|load|loading|render|rendering|start|starting|run|running|build|building|connect|connecting|find|showing|display)\b/,
    /\b(broken|broke|fails?|failing|failed|errors?|crash(es|ing|ed)?|stuck|hangs?|hanging|stopped working)\b/,
    /\bwhy\s+(is|isn'?t|are|aren'?t|does|doesn'?t|do|don'?t|won'?t|can'?t|did)\b/,
  ];

  // Category 2 — Scoped question / procedure
  const scopedQuestion = [
    /\bhow\s+do\s+i\b/,
    /\bwalk\s+me\s+through\b/,
    /\bstep[\s-]by[\s-]step\b/,
    /\bwhat'?s\s+next\b/,
    /\b(how|what|which|where|should)\b[^?]*\?/,
  ];

  // Category 3 — Review / feedback
  const reviewFeedback = [
    /\b(feedback|thoughts on|notes on|review this|take a look|what do you think|look(s)? (right|good|off|wrong))\b/,
  ];

  // Category 4 — Non-trivial work verbs (intentionally NARROW)
  // Excludes trivial verbs like fix/update/add/delete/commit/run — those stay Haiku.
  const workVerbs = [
    /\b(debug|refactor|re-?design|investigate|troubleshoot|optimi[sz]e|re-?work|re-?architect|diagnose|root[\s-]cause)\b/,
  ];

  const allCategories = [...troubleshooting, ...scopedQuestion, ...reviewFeedback, ...workVerbs];
  return allCategories.some(re => re.test(p));
}

function routeModel(task) {
  if (!task || !task.trim()) {
    return { model: 'haiku', tier: 'default-empty', confidence: 0.65, reason: 'Empty prompt — Haiku' };
  }

  // Tier 1: explicit pattern match (first match wins, ordered specific → general).
  for (const rule of MODEL_PATTERNS) {
    if (rule.pattern.test(task)) {
      return {
        model: rule.model,
        tier: rule.tier,
        confidence: rule.confidence,
        reason: rule.reason,
      };
    }
  }

  // Tier 2: length-based fallback — short prompts default to Haiku.
  // Empirically: short prompts are usually quick edits, lookups, or
  // confirmations. If they're not, the user can override with `!opus` / `!sonnet`.
  const trimmed = task.trim();
  const len = trimmed.length;
  const wordCount = trimmed.split(/\s+/).length;
  if (len < SHORT_PROMPT_CHARS && wordCount < SHORT_PROMPT_WORDS) {
    // Content-aware guard: skip the Haiku downgrade when the short prompt carries
    // clear real-work signal. Let it fall through to the Sonnet default instead.
    // hasRealWorkSignal() is conservative — only fires on troubleshooting, scoped
    // questions, review/feedback, or narrow non-trivial work verbs.
    if (!hasRealWorkSignal(trimmed)) {
      return {
        model: 'haiku',
        tier: 'short-prompt',
        confidence: 0.70,
        reason: `Short prompt (${len} chars, ${wordCount} words) — likely simple`,
      };
    }
    // Falls through to Sonnet default below.
  }

  // Tier 3: Sonnet default for medium-length unmatched prompts.
  return { model: 'sonnet', tier: 'default', confidence: 0.50, reason: 'No pattern matched — Sonnet default' };
}

function logDecision(task, decision) {
  if (process.env.CASCADE_MODEL_ROUTER === 'off') return;
  try {
    const dir = path.dirname(DECISIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      task: String(task).slice(0, 240),
      model: decision.model,
      tier: decision.tier,
      confidence: decision.confidence,
      reason: decision.reason,
    };
    fs.appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + '\n');
  } catch { /* non-fatal — never break the hook */ }
}

function shouldEmit(decision) {
  // Sonnet (the recommended session default) stays silent — no tag means "Sonnet is fine".
  if (decision.model === 'sonnet') return false;
  // Opus needs strong evidence to escalate.
  if (decision.model === 'opus')  return decision.confidence >= EMIT_THRESHOLD_OPUS;
  // Haiku has a lower bar — we want more downgrades.
  if (decision.model === 'haiku') return decision.confidence >= EMIT_THRESHOLD_HAIKU;
  return false;
}

function formatDirective(decision) {
  const pct = Math.round(decision.confidence * 100);
  if (decision.model === 'opus') {
    return `[CASCADE MODEL] ⚡ ESCALATE: this task warrants Opus (${pct}% — ${decision.reason}). `
         + `Spawn the work via Task tool with \`model: 'opus'\` rather than running inline on the session model.`;
  }
  if (decision.model === 'haiku') {
    return `[CASCADE MODEL] DOWNGRADE: this is Haiku-tier work (${pct}% — ${decision.reason}). `
         + `Spawn via Task tool with \`model: 'haiku'\` to save credits, or handle inline only if already on Haiku.`;
  }
  return `[CASCADE MODEL] Suggest ${decision.model} (${pct}% — ${decision.reason})`;
}

module.exports = {
  routeModel,
  logDecision,
  shouldEmit,
  formatDirective,
  MODEL_PATTERNS,
  EMIT_THRESHOLD_OPUS,
  EMIT_THRESHOLD_HAIKU,
  SHORT_PROMPT_CHARS,
  SHORT_PROMPT_WORDS,
};

// CLI mode for testing classifications
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--stats') {
    if (!fs.existsSync(DECISIONS_FILE)) {
      console.log('No decisions logged yet.');
      process.exit(0);
    }
    const lines = fs.readFileSync(DECISIONS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    const totals = { opus: 0, sonnet: 0, haiku: 0 };
    const tiers = {};
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        totals[o.model] = (totals[o.model] || 0) + 1;
        tiers[o.tier] = (tiers[o.tier] || 0) + 1;
      } catch { /* skip */ }
    }
    const total = lines.length;
    console.log(`Decisions logged: ${total}`);
    console.log('By model:');
    for (const [m, n] of Object.entries(totals)) {
      console.log(`  ${m.padEnd(8)} ${n} (${total ? Math.round(n / total * 100) : 0}%)`);
    }
    console.log('By tier:');
    for (const [t, n] of Object.entries(tiers)) {
      console.log(`  ${t.padEnd(12)} ${n}`);
    }
    process.exit(0);
  }
  if (args[0] === '--tail') {
    const n = parseInt(args[1] || '20', 10);
    if (!fs.existsSync(DECISIONS_FILE)) { console.log('No decisions logged yet.'); process.exit(0); }
    const lines = fs.readFileSync(DECISIONS_FILE, 'utf-8').trim().split('\n').filter(Boolean).slice(-n);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        console.log(`${o.ts.slice(11, 19)}  ${o.model.padEnd(7)} ${String(Math.round(o.confidence * 100)).padStart(3)}%  ${o.reason}`);
        console.log(`            "${o.task.slice(0, 80)}"`);
      } catch { /* skip */ }
    }
    process.exit(0);
  }

  const task = args.join(' ');
  if (!task) {
    console.log('Usage: model-router.cjs <prompt>          # classify a prompt');
    console.log('       model-router.cjs --stats           # summary of logged decisions');
    console.log('       model-router.cjs --tail [n]        # last n logged decisions');
    process.exit(0);
  }
  const decision = routeModel(task);
  console.log(JSON.stringify(decision, null, 2));
  console.log('---');
  console.log('Would emit:', shouldEmit(decision) ? 'YES' : 'NO (silent — Sonnet default or below threshold)');
  if (shouldEmit(decision)) console.log(formatDirective(decision));
}

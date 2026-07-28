#!/usr/bin/env node
/**
 * Cascade Task Router
 * Routes tasks to optimal agents based on domain patterns + learned outcomes.
 * Reads from outcomes log to bias toward historically successful agents.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.CASCADE_ROOT || process.cwd();
const OUTCOMES_FILE = path.join(PROJECT_ROOT, '.cascade', 'sessions', 'outcomes.jsonl');

// Domain patterns mapped to specialist agents.
// Ordered by specificity — first match wins. Specific tech BEFORE broad CRM.
//
// Every alternation is wrapped in \b(...)\b. Without word boundaries, short tokens
// match inside unrelated words: `ui` → "build/built/guide/quick/acquired",
// `api` → "rapid/therapist", `add` → "address/padding", etc.
//
// Patterns dropped vs prior version:
//   - vue|nuxt|composition.api      (no Vue in stack — re-add if yours has it)
//   - terraform|infrastructure|iac  (no IaC in stack)
//   - graphql|openapi               (not used; kept api|endpoint|rest)
//   - implement|create|build|add... (catch-all that routed everything to general-purpose)
//   - pipeline|contact|deal         (overloaded tokens that shadowed specific rows)
const TASK_PATTERNS = {
  // Specific tech — checked FIRST so they win over the broader CRM/RevOps row
  'mcp|model.context.protocol|mcp.server': 'mcp-developer',
  'n8n|workflow|automation|webhook|zapier|make\\.com': 'general-purpose',

  // Frontend — \b boundary on every token to kill the `ui` substring bug
  '\\b(react|next\\.?js|nextjs|jsx|tsx|frontend|tailwind)\\b': 'nextjs-developer',
  '\\b(css|styling|responsive.design|page.layout|css.layout)\\b': 'frontend-developer',
  '\\b(html.slides|slide.deck|pitch.deck|presentation.html)\\b': 'frontend-developer',

  // Backend
  '\\b(python|django|flask|fastapi|pip)\\b': 'python-pro',
  '\\b(typescript|node|express|npm|bun|deno)\\b': 'typescript-pro',
  '\\b(database|sql|postgres|migration|schema)\\b|\\bsoql\\b': 'sql-pro',

  // API design — `rest` requires context (rest API / RESTful) because bare `rest`
  // false-positives on "the rest of X" / "take a rest". Same for `api` as standalone
  // word — kept since "api" rarely appears in conversational English.
  '\\b(api|endpoint|openapi|swagger|restful|rest.?api)\\b': 'api-designer',

  // Infrastructure
  '\\b(docker|container|compose|kubernetes|k8s)\\b': 'docker-expert',
  '\\b(deploy|ci.?cd|github.action|cloud.run|gcp.deploy)\\b': 'devops-engineer',

  // Quality — anchored 'fix' to bug-related nouns to prevent 'fix the typo' false matches
  '\\b(test|spec|coverage|jest|pytest|vitest)\\b': 'test-automator',
  '\\b(code.review|pr.review|review.this.code|code.quality|lint)\\b': 'code-reviewer',
  '\\b(security.review|security.audit|vulnerability|cve|threat.model)\\b': 'security-engineer',
  '\\b(performance|optimize|slow|latency|profile)\\b': 'performance-engineer',

  // Research / analysis
  '\\b(research|investigate|deep.dive|deeply.analyze)\\b': 'research-analyst',
  '\\bdebug\\b|\\b(bug|error|broken|failing|crash)\\b|\\bfix.{0,15}(bug|crash|issue|error|test|build)\\b': 'debugger',

  // Content / writing
  '\\b(blog|article|newsletter|content.strategy)\\b': 'general-purpose',
  '\\b(documentation|docs|readme|api.guide)\\b': 'technical-writer',

  // CRM / RevOps domain — kept at BOTTOM (was shadowing specific rows above).
  // Removed overloaded tokens (pipeline|contact|deal). Domain-skill overrides in
  // intelligence.cjs handle the high-precision CRM routing now.
  '\\b(hubspot|salesforce|crm|revops|outreach|gong|forecast)\\b': 'general-purpose',
};

// Load historical outcomes to bias routing
function loadOutcomes() {
  if (!fs.existsSync(OUTCOMES_FILE)) return {};
  try {
    const lines = fs.readFileSync(OUTCOMES_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    // Only look at last 200 outcomes
    const recent = lines.slice(-200);
    const stats = {};
    for (const line of recent) {
      try {
        const o = JSON.parse(line);
        if (!stats[o.agent]) stats[o.agent] = { success: 0, total: 0 };
        stats[o.agent].total++;
        if (o.success) stats[o.agent].success++;
      } catch { /* skip bad lines */ }
    }
    return stats;
  } catch { return {}; }
}

function routeTask(task) {
  if (!task) return { agent: 'general-purpose', confidence: 0.3, reason: 'No task description' };

  const taskLower = task.toLowerCase();
  const outcomes = loadOutcomes();

  for (const [pattern, agent] of Object.entries(TASK_PATTERNS)) {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(taskLower)) {
      let confidence = 0.8;
      let reason = `Matched pattern: ${pattern.substring(0, 40)}`;

      // Boost or penalize based on historical success
      if (outcomes[agent] && outcomes[agent].total >= 3) {
        const rate = outcomes[agent].success / outcomes[agent].total;
        confidence = Math.min(0.95, confidence + (rate - 0.5) * 0.3);
        reason += ` | history: ${(rate * 100).toFixed(0)}% success (${outcomes[agent].total} tasks)`;
      }

      return { agent, confidence: Math.round(confidence * 100) / 100, reason };
    }
  }

  return { agent: 'general-purpose', confidence: 0.5, reason: 'Default — no specific pattern matched' };
}

module.exports = { routeTask, TASK_PATTERNS };

if (require.main === module) {
  const task = process.argv.slice(2).join(' ');
  if (task) {
    console.log(JSON.stringify(routeTask(task), null, 2));
  } else {
    console.log('Usage: router.cjs <task description>');
  }
}

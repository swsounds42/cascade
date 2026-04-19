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

// Domain patterns mapped to specialist agents
// Ordered by specificity — first match wins
const TASK_PATTERNS = {
  // RevOps domain
  'hubspot|crm|contact|deal|pipeline|revops|revenue': 'general-purpose',
  'gong|forecasting|forecast|call recording': 'general-purpose',
  'salesforce|outreach|sales.engagement': 'general-purpose',

  // Integration / workflow
  'n8n|workflow|automation|webhook|zapier|make\\.com': 'general-purpose',
  'mcp|model.context.protocol|mcp.server': 'mcp-developer',
  'api|endpoint|rest|graphql|openapi': 'api-designer',

  // Frontend
  'react|next\\.?js|component|jsx|tsx|frontend|ui': 'nextjs-developer',
  'vue|nuxt|composition.api': 'vue-expert',
  'css|tailwind|styling|responsive|layout': 'frontend-developer',
  'html|presentation|slide|deck': 'frontend-developer',

  // Backend
  'python|django|flask|fastapi|pip': 'python-pro',
  'typescript|node|express|npm|bun|deno': 'typescript-pro',
  'database|sql|postgres|query|migration|schema': 'sql-pro',

  // Infrastructure
  'docker|container|compose|kubernetes|k8s': 'docker-expert',
  'deploy|ci.?cd|pipeline|github.action': 'devops-engineer',
  'terraform|infrastructure|iac': 'terraform-engineer',

  // Quality
  'test|spec|coverage|jest|pytest|vitest': 'test-automator',
  'review|audit|code.quality|lint': 'code-reviewer',
  'security|vulnerability|cve|auth|permission': 'security-engineer',
  'performance|optimize|slow|latency|profile': 'performance-engineer',

  // Content / writing
  'blog|article|newsletter|writing|content': 'general-purpose',
  'documentation|docs|readme|guide': 'technical-writer',

  // Research / analysis
  'research|analyze|investigate|compare|evaluate': 'research-analyst',
  'debug|bug|error|fix|broken|failing': 'debugger',

  // Code tasks (broad — low priority)
  'implement|create|build|add|write.code|refactor': 'general-purpose',
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

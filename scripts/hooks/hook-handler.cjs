#!/usr/bin/env node
/**
 * Cascade Hook Handler
 * Main dispatcher for Claude Code lifecycle hooks.
 * Adapted from Ruflo's hook-handler (MIT, see NOTICE.md), tuned for personal-os.
 *
 * Hook events:
 *   session-start   → Init intelligence index, restore/start session
 *   session-end     → Consolidate patterns, archive session
 *   route           → Return relevant context for current prompt
 *   pre-bash        → Validate commands (block dangerous ones)
 *   post-edit       → Record file edits for learning
 *   post-task       → Record task completion for pattern learning
 *   stats           → Show intelligence stats
 */
'use strict';

const path = require('path');
const fs = require('fs');

const helpersDir = __dirname;

function safeRequire(modulePath) {
  try {
    if (fs.existsSync(modulePath)) return require(modulePath);
  } catch { /* silent */ }
  return null;
}

const router = safeRequire(path.join(helpersDir, 'router.cjs'));
const modelRouter = safeRequire(path.join(helpersDir, 'model-router.cjs'));
const session = safeRequire(path.join(helpersDir, 'session.cjs'));
const intelligence = safeRequire(path.join(helpersDir, 'intelligence.cjs'));
const driftDetector = safeRequire(path.join(helpersDir, 'drift-detector.cjs'));
const observations = safeRequire(path.join(helpersDir, 'observations.cjs'));
const instincts = safeRequire(path.join(helpersDir, 'instincts.cjs'));

const [,, command, ...args] = process.argv;

// Read stdin for hook data from Claude Code
async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    }, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
    process.stdin.resume();
  });
}

async function main() {
  let stdinData = '';
  try { stdinData = await readStdin(); } catch { /* ignore */ }

  let hookInput = {};
  if (stdinData.trim()) {
    try { hookInput = JSON.parse(stdinData); } catch { /* ignore */ }
  }

  const prompt = hookInput.prompt || hookInput.command || hookInput.toolInput
    || process.env.PROMPT || process.env.TOOL_INPUT_command || '';

  const handlers = {
    'session-start': () => {
      // Restore or start a new session
      if (session) {
        const existing = session.restore();
        if (!existing) session.start();
      }

      // Initialize intelligence layer (index Knowledge/)
      if (intelligence && intelligence.init) {
        try {
          const result = intelligence.init();
          if (result && result.nodes > 0) {
            const cats = result.categories || {};
            const catStr = Object.entries(cats).map(([k, v]) => `${k}:${v}`).join(', ');
            console.log(`[CASCADE] Intelligence loaded: ${result.nodes} entries [${catStr}]`);
          }
        } catch (e) {
          console.log('[CASCADE] Intelligence init skipped: ' + e.message);
        }
      }

      // Record session in observation layer
      if (observations && observations.startSession) {
        try {
          const sid = hookInput.session_id || (session && session.status && session.status().id) || `cascade-${Date.now()}`;
          observations.startSession(sid, process.env.CASCADE_ROOT || process.cwd(), hookInput.cwd || process.cwd());
        } catch { /* non-fatal */ }
      }
    },

    'session-end': () => {
      // Consolidate learned patterns
      if (intelligence && intelligence.consolidate) {
        try {
          const result = intelligence.consolidate();
          if (result && result.entries > 0) {
            let msg = `[CASCADE] Consolidated: ${result.entries} insights`;
            if (result.promoted > 0) msg += `, ${result.promoted} patterns promoted`;
            console.log(msg);
          }
        } catch { /* non-fatal */ }
      }

      // Close observation session
      if (observations && observations.endSession) {
        try {
          const sid = hookInput.session_id || (session && session.status && session.status().id);
          if (sid) observations.endSession(sid);
        } catch { /* non-fatal */ }
      }

      // End session + archive
      if (session && session.end) {
        try {
          const s = session.end();
          if (s && s.duration) {
            console.log(`[CASCADE] Session ended (${Math.round(s.duration / 1000 / 60)}m)`);
          }
        } catch { /* non-fatal */ }
      }
    },

    'route': () => {
      // Return relevant knowledge context for the current prompt
      if (intelligence && intelligence.getContext) {
        try {
          const ctx = intelligence.getContext(prompt);
          if (ctx) console.log(ctx);
        } catch { /* non-fatal */ }
      }

      // Show routing recommendation — fires at lower threshold (0.5) with stronger language
      // at high confidence. The hook can't force invocation; it nudges the model.
      if (router && router.routeTask && prompt) {
        const result = router.routeTask(prompt);
        if (result.confidence >= 0.7) {
          console.log(`[CASCADE ROUTING] ⚡ MUST INVOKE: spawn '${result.agent}' agent (${(result.confidence * 100).toFixed(0)}% match — ${result.reason}). Do NOT do this inline.`);
        } else if (result.confidence >= 0.5) {
          console.log(`[CASCADE ROUTING] Consider: '${result.agent}' agent (${(result.confidence * 100).toFixed(0)}% match — ${result.reason})`);
        }
      }

      // Model routing — recommend a Claude tier (Opus / Sonnet / Haiku) based on task complexity.
      // Silent for Sonnet (the default); only emits when escalation/downgrade is warranted.
      // Logs every decision to .cascade/sessions/model-decisions.jsonl for retrospective tuning.
      if (modelRouter && modelRouter.routeModel && prompt && process.env.CASCADE_MODEL_ROUTER !== 'off') {
        try {
          const decision = modelRouter.routeModel(prompt);
          if (modelRouter.shouldEmit(decision)) {
            console.log(modelRouter.formatDirective(decision));
          }
          modelRouter.logDecision(prompt, decision);
        } catch { /* non-fatal */ }
      }

      // Surface learned instincts — command habits mined from the observation
      // DB (instincts.cjs). Silent unless a high-confidence habit matches the
      // prompt's domain. Cheap: reads the small instincts.json, never the DB.
      if (instincts && instincts.surface && prompt) {
        try {
          const block = instincts.surface(prompt);
          if (block) console.log(block);
        } catch { /* non-fatal */ }
      }
    },

    'pre-bash': () => {
      const cmd = (hookInput.command || prompt || '').toLowerCase();
      const dangerous = [
        'rm -rf /', 'rm -rf ~', 'rm -rf *',
        'format c:', 'del /s /q c:\\',
        ':(){:|:&};:', // fork bomb
        'dd if=/dev/zero', // disk wipe
      ];
      for (const d of dangerous) {
        if (cmd.includes(d)) {
          console.error(`[CASCADE BLOCKED] Dangerous command: ${d}`);
          process.exit(2); // exit 2 = block the action
        }
      }
    },

    'post-edit': () => {
      // Track edit metrics
      if (session && session.metric) {
        try { session.metric('edits'); } catch { /* no session */ }
      }

      // Record edit for intelligence consolidation
      if (intelligence && intelligence.recordEdit) {
        try {
          const file = hookInput.file_path
            || (hookInput.toolInput && hookInput.toolInput.file_path)
            || args[0] || '';
          intelligence.recordEdit(file);
        } catch { /* non-fatal */ }
      }

      // Capture observation for cross-session recall
      if (observations && observations.recordObservation) {
        try {
          const sid = hookInput.session_id || (session && session.status && session.status().id);
          const toolName = hookInput.tool_name || hookInput.toolName || args[0] || 'unknown';
          const toolInput = hookInput.tool_input || hookInput.toolInput || {};
          const toolOutput = hookInput.tool_response || hookInput.toolOutput || hookInput.output || '';
          if (sid) {
            observations.recordObservation({
              sessionId: sid,
              toolName,
              input: toolInput,
              output: toolOutput,
            });
          }
        } catch { /* non-fatal */ }
      }
    },

    'post-agent': () => {
      // Track agent spawn metrics
      if (session && session.metric) {
        try { session.metric('agentsSpawned'); } catch { /* no session */ }
      }

      // Auto-checkpoint: set drift checkpoint on first agent spawn of a wave
      // so we can detect conflicts when agents complete
      if (driftDetector && driftDetector.checkpoint) {
        try {
          const s = session && session.status ? session.status() : null;
          const spawned = s && s.metrics ? s.metrics.agentsSpawned : 0;
          // Checkpoint on first spawn (subsequent spawns in same wave skip)
          if (spawned === 1) {
            driftDetector.checkpoint();
            console.log('[CASCADE] Drift checkpoint set (parallel agents detected)');
          }
        } catch { /* non-fatal */ }
      }
    },

    'post-task': () => {
      // Track task metrics
      if (session && session.metric) {
        try { session.metric('tasks'); } catch { /* no session */ }
      }

      // Record outcome for pattern learning
      if (intelligence && intelligence.recordOutcome) {
        try {
          const agent = hookInput.agent || args[0] || 'unknown';
          const task = hookInput.task || prompt || args[1] || '';
          intelligence.recordOutcome(agent, task, true);
        } catch { /* non-fatal */ }
      }

      // Capture subagent outcome as an observation
      if (observations && observations.recordObservation) {
        try {
          const sid = hookInput.session_id || (session && session.status && session.status().id);
          const agent = hookInput.agent || hookInput.subagent_type || args[0] || 'unknown';
          const task = hookInput.task || hookInput.description || prompt || '';
          const result = hookInput.result || hookInput.output || '';
          if (sid) {
            observations.recordObservation({
              sessionId: sid,
              toolName: `Agent(${agent})`,
              input: { task },
              output: result,
            });
          }
        } catch { /* non-fatal */ }
      }

      // Auto-drift-check: after subagent completes, if multiple agents
      // were spawned this session, run drift detection automatically
      if (driftDetector && driftDetector.check) {
        try {
          const s = session && session.status ? session.status() : null;
          const spawned = s && s.metrics ? s.metrics.agentsSpawned : 0;
          if (spawned >= 2) {
            const result = driftDetector.check();
            if (result && result.drift) {
              console.log(`[CASCADE DRIFT] ⚠ ${result.conflicts} file(s) touched by multiple agents — review before continuing`);
            }
          }
        } catch { /* non-fatal */ }
      }
    },

    'stats': () => {
      if (intelligence && intelligence.stats) {
        intelligence.stats(args.includes('--json'));
      } else {
        console.log('[CASCADE] Intelligence not loaded. Start a session first.');
      }
      if (observations && observations.stats) {
        const s = observations.stats();
        if (s && s.ok) {
          const mb = (s.db_size_bytes / 1024 / 1024).toFixed(2);
          console.log(`[CASCADE] Observations: ${s.observations} across ${s.sessions} sessions (${mb} MB, ${s.summaries} summaries)`);
        }
      }
    },
  };

  if (command && handlers[command]) {
    try {
      handlers[command]();
    } catch (e) {
      console.log('[CASCADE] Hook error (' + command + '): ' + e.message);
    }
  } else if (command) {
    // Unknown hook — pass through silently
  } else {
    console.log('Cascade Hook Handler');
    console.log('Commands: ' + Object.keys(handlers).join(', '));
  }
}

main().catch(e => {
  console.log('[CASCADE] Hook handler error: ' + e.message);
}).finally(() => {
  process.exit(0);
});

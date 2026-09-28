#!/usr/bin/env node
/**
 * Cascade Session Manager
 * Tracks session state, metrics, and context across Claude Code sessions.
 * Data persists in .cascade/sessions/ for cross-session learning.
 * Start/restore/end structure follows Ruflo's session helper (MIT, see NOTICE.md).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = process.env.CASCADE_ROOT || process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, '.cascade', 'sessions');
const SESSION_FILE = path.join(DATA_DIR, 'current.json');
const OUTCOMES_FILE = path.join(DATA_DIR, 'outcomes.jsonl');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(p) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; }
  catch { return null; }
}

function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

const commands = {
  start: () => {
    ensureDir(DATA_DIR);
    const sessionId = `cascade-${Date.now()}`;
    const session = {
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd: PROJECT_ROOT,
      context: {},
      metrics: {
        edits: 0,
        commands: 0,
        tasks: 0,
        searches: 0,
        agentsSpawned: 0,
        errors: 0,
      },
      agentOutcomes: [],
    };
    writeJSON(SESSION_FILE, session);
    return session;
  },

  restore: () => {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const session = readJSON(SESSION_FILE);
    if (!session) return null;
    session.restoredAt = new Date().toISOString();
    writeJSON(SESSION_FILE, session);
    return session;
  },

  end: () => {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const session = readJSON(SESSION_FILE);
    if (!session) return null;
    session.endedAt = new Date().toISOString();
    session.duration = Date.now() - new Date(session.startedAt).getTime();

    // Archive completed session
    const archivePath = path.join(DATA_DIR, `${session.id}.json`);
    writeJSON(archivePath, session);

    // Append outcomes to the learning log
    if (session.agentOutcomes && session.agentOutcomes.length > 0) {
      ensureDir(path.dirname(OUTCOMES_FILE));
      const lines = session.agentOutcomes.map(o => JSON.stringify(o)).join('\n') + '\n';
      fs.appendFileSync(OUTCOMES_FILE, lines, 'utf-8');
    }

    // Clean up current session
    try { fs.unlinkSync(SESSION_FILE); } catch { /* ok */ }
    return session;
  },

  metric: (name) => {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const session = readJSON(SESSION_FILE);
    if (!session) return null;
    if (session.metrics[name] !== undefined) {
      session.metrics[name]++;
      writeJSON(SESSION_FILE, session);
    }
    return session;
  },

  recordOutcome: (agent, task, success, notes) => {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const session = readJSON(SESSION_FILE);
    if (!session) return null;
    if (!session.agentOutcomes) session.agentOutcomes = [];
    session.agentOutcomes.push({
      agent: agent || 'unknown',
      task: (task || '').substring(0, 200),
      success: !!success,
      notes: (notes || '').substring(0, 500),
      timestamp: new Date().toISOString(),
    });
    writeJSON(SESSION_FILE, session);
    return session;
  },

  status: () => {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return readJSON(SESSION_FILE);
  },
};

module.exports = commands;

if (require.main === module) {
  const [,, command, ...args] = process.argv;
  if (command && commands[command]) {
    const result = commands[command](...args);
    if (result) console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage: session.cjs <start|restore|end|status|metric>');
  }
}

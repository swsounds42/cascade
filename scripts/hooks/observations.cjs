#!/usr/bin/env node
/**
 * Cascade Observation Layer
 * ─────────────────────────
 * Auto-captures tool observations across Claude Code sessions. SQLite-backed
 * with FTS5 full-text search. Zero external dependencies — uses Node 22's
 * built-in `node:sqlite`. MIT-compatible.
 *
 * Storage: $CASCADE_ROOT/.cascade/observations/db.sqlite
 *
 * Public API:
 *   getDB()                             → lazy-init, returns DatabaseSync
 *   startSession(id, projectPath, cwd)  → create session row
 *   endSession(id, summary?)            → mark ended + optional summary
 *   recordObservation({...})            → insert observation + FTS
 *   searchObservations(query, opts)     → FTS5 query, ranked
 *   recentObservations(opts)            → timeline view
 *   recentSessions(limit)               → session list
 *   stats()                             → counts per table
 *   close()                             → cleanup
 *
 * All functions no-op gracefully if node:sqlite isn't available (returns null
 * or empty array) so Cascade hooks never fail because of this module.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Lazy-load sqlite — gracefully degrade if unavailable
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* degraded mode */ }

const PROJECT_ROOT = process.env.CASCADE_ROOT || process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, '.cascade', 'observations');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    project_path TEXT,
    cwd TEXT,
    prompt_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    file_path TEXT,
    input_summary TEXT,
    output_summary TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
  CREATE INDEX IF NOT EXISTS idx_obs_file ON observations(file_path);
  CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(timestamp DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    input_summary,
    output_summary,
    file_path UNINDEXED,
    tool_name UNINDEXED,
    content='observations',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, input_summary, output_summary, file_path, tool_name)
    VALUES (new.id, new.input_summary, new.output_summary, new.file_path, new.tool_name);
  END;

  CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN
    DELETE FROM observations_fts WHERE rowid = old.id;
  END;

  CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    summary TEXT,
    topics TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
    summary,
    topics UNINDEXED,
    content='session_summaries',
    content_rowid='rowid'
  );
`;

let _db = null;

/**
 * Lazy-initialize the SQLite database and apply schema.
 * Returns null if node:sqlite is unavailable (Node < 22.5).
 */
function getDB() {
  if (!sqlite) return null;
  if (_db) return _db;

  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    _db = new sqlite.DatabaseSync(DB_PATH);
    _db.exec(SCHEMA);
    return _db;
  } catch (e) {
    // Any init failure = degraded mode; never throw to hook callers
    _db = null;
    return null;
  }
}

/** Truncate strings safely for storage. Objects get JSON-stringified. */
function summarize(value, max = 500) {
  if (value == null) return null;
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

/** Extract file_path from common tool input shapes (Read/Edit/Write/etc.). */
function extractFilePath(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path
    || input.path
    || input.notebook_path
    || (input.paths && input.paths[0])
    || null;
}

/**
 * Create a new session row. Idempotent by id.
 * @param {string} id - session identifier
 * @param {string} projectPath - absolute project root
 * @param {string} cwd - working directory
 */
function startSession(id, projectPath, cwd) {
  const db = getDB();
  if (!db || !id) return false;
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO sessions (id, started_at, project_path, cwd)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, Date.now(), projectPath || PROJECT_ROOT, cwd || process.cwd());
    return true;
  } catch { return false; }
}

/**
 * Mark a session ended. Optionally save a summary.
 * @param {string} id - session id
 * @param {string?} summary - optional summary text
 * @param {string[]?} topics - optional topic tags
 */
function endSession(id, summary, topics) {
  const db = getDB();
  if (!db || !id) return false;
  try {
    db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(Date.now(), id);
    if (summary) {
      db.prepare(`
        INSERT OR REPLACE INTO session_summaries (session_id, summary, topics, created_at)
        VALUES (?, ?, ?, ?)
      `).run(id, summary, JSON.stringify(topics || []), Date.now());
    }
    return true;
  } catch { return false; }
}

/**
 * Record an observation from a tool call.
 * Silently no-ops on error — callers can fire-and-forget.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.toolName
 * @param {any} opts.input - tool input (will be summarized)
 * @param {any} opts.output - tool output (will be summarized)
 */
function recordObservation(opts) {
  const db = getDB();
  if (!db || !opts || !opts.sessionId || !opts.toolName) return false;

  try {
    const filePath = extractFilePath(opts.input);
    const inputSummary = summarize(opts.input, 500);
    const outputSummary = summarize(opts.output, 800);

    db.prepare(`
      INSERT INTO observations (session_id, timestamp, tool_name, file_path, input_summary, output_summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(opts.sessionId, Date.now(), opts.toolName, filePath, inputSummary, outputSummary);

    db.prepare(`
      UPDATE sessions SET tool_call_count = tool_call_count + 1 WHERE id = ?
    `).run(opts.sessionId);

    return true;
  } catch { return false; }
}

/**
 * Full-text search across observations using SQLite FTS5.
 * Ranks by BM25 relevance, then recency.
 *
 * @param {string} query - user query (natural language)
 * @param {object} opts
 * @param {number} opts.limit - max results (default 10)
 * @param {number} opts.sinceDays - only search observations newer than N days
 * @param {string} opts.sessionId - restrict to one session
 * @returns {Array<object>} - observation rows with rank score
 */
function searchObservations(query, opts = {}) {
  const db = getDB();
  if (!db || !query || !query.trim()) return [];

  const limit = opts.limit || 10;
  const sinceMs = opts.sinceDays ? Date.now() - (opts.sinceDays * 24 * 60 * 60 * 1000) : null;

  try {
    // Sanitize for FTS5: quote each word to avoid syntax errors on punctuation
    const ftsQuery = query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .map(w => `"${w}"`)
      .join(' OR ');

    if (!ftsQuery) return [];

    let sql = `
      SELECT
        o.id, o.session_id, o.timestamp, o.tool_name, o.file_path,
        o.input_summary, o.output_summary,
        bm25(observations_fts) AS rank
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
    `;
    const params = [ftsQuery];

    if (sinceMs) { sql += ` AND o.timestamp >= ?`; params.push(sinceMs); }
    if (opts.sessionId) { sql += ` AND o.session_id = ?`; params.push(opts.sessionId); }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  } catch { return []; }
}

/** Recent observations in reverse chronological order. */
function recentObservations(opts = {}) {
  const db = getDB();
  if (!db) return [];
  const limit = opts.limit || 20;
  try {
    let sql = `
      SELECT id, session_id, timestamp, tool_name, file_path, input_summary, output_summary
      FROM observations
    `;
    const params = [];
    if (opts.sessionId) { sql += ` WHERE session_id = ?`; params.push(opts.sessionId); }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params);
  } catch { return []; }
}

/** Recent sessions with observation counts. */
function recentSessions(limit = 10) {
  const db = getDB();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        s.id, s.started_at, s.ended_at, s.project_path, s.tool_call_count,
        (SELECT summary FROM session_summaries WHERE session_id = s.id) AS summary
      FROM sessions s
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(limit);
  } catch { return []; }
}

/** Database stats for /stats command. */
function stats() {
  const db = getDB();
  if (!db) return { ok: false, reason: 'node:sqlite unavailable' };
  try {
    const sessions = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;
    const observations = db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n;
    const summaries = db.prepare(`SELECT COUNT(*) AS n FROM session_summaries`).get().n;
    const oldest = db.prepare(`SELECT MIN(started_at) AS t FROM sessions`).get().t;
    const dbBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    return {
      ok: true,
      sessions,
      observations,
      summaries,
      oldest_session_at: oldest,
      db_size_bytes: dbBytes,
      db_path: DB_PATH
    };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** Close the DB handle (primarily for tests). */
function close() {
  if (_db) { try { _db.close(); } catch { /* ignore */ } }
  _db = null;
}

module.exports = {
  getDB,
  startSession,
  endSession,
  recordObservation,
  searchObservations,
  recentObservations,
  recentSessions,
  stats,
  close,
};

// CLI test harness: `node observations.cjs stats` / `search "query"` / `recent`
if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'stats': console.log(JSON.stringify(stats(), null, 2)); break;
    case 'search': console.log(JSON.stringify(searchObservations(args.join(' '), { limit: 5 }), null, 2)); break;
    case 'recent': console.log(JSON.stringify(recentObservations({ limit: 10 }), null, 2)); break;
    case 'sessions': console.log(JSON.stringify(recentSessions(10), null, 2)); break;
    default:
      console.log('usage: node observations.cjs [stats|search "q"|recent|sessions]');
  }
}

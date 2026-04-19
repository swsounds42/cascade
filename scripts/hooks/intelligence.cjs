#!/usr/bin/env node
/**
 * Cascade Intelligence Layer
 * Indexes Knowledge/ directory + auto-memory for contextual pattern matching.
 * Provides: init, getContext, recordEdit, recordOutcome, consolidate, stats
 *
 * On session start: indexes Knowledge/ files + MEMORY.md into ranked context.
 * On each prompt: returns top relevant patterns via Jaccard similarity.
 * On session end: consolidates pending insights and promotes patterns.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = process.env.CASCADE_ROOT || process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, '.cascade', 'intelligence');
const STORE_PATH = path.join(DATA_DIR, 'knowledge-index.json');
const RANKED_PATH = path.join(DATA_DIR, 'ranked-context.json');
const PENDING_PATH = path.join(DATA_DIR, 'pending-insights.jsonl');
const PATTERNS_PATH = path.join(DATA_DIR, 'learned-patterns.json');

// Vector search upgrade — TF-IDF + cosine similarity
let vectorSearch = null;
try { vectorSearch = require(path.join(__dirname, 'vector-search.cjs')); } catch { /* fall back to Jaccard */ }
let vectorIndex = null;

// Episodic memory — observation layer (SQLite FTS5, Node built-in)
let observationsModule = null;
try { observationsModule = require(path.join(__dirname, 'observations.cjs')); } catch { /* absent = skip episodic */ }

// Directories to index for knowledge
const KNOWLEDGE_DIRS = [
  path.join(PROJECT_ROOT, 'Knowledge'),
  path.join(os.homedir(), '.claude', 'projects'),
];

// File extensions to index
const INDEXABLE_EXTENSIONS = new Set(['.md', '.txt', '.yaml', '.yml', '.json']);

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

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function jaccardScore(wordsA, wordsB) {
  if (!wordsA.length || !wordsB.length) return 0;
  const setB = new Set(wordsB);
  let overlap = 0;
  for (const w of wordsA) {
    if (setB.has(w)) overlap++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? overlap / union : 0;
}

/**
 * Recursively index markdown/text files from Knowledge/ and memory dirs.
 * Each file section becomes an entry with tokenized words for matching.
 */
function indexKnowledgeBase() {
  const entries = [];
  const seen = new Set();

  for (const dir of KNOWLEDGE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      indexDirectory(dir, entries, seen, 0);
    } catch { /* skip inaccessible dirs */ }
  }

  return entries;
}

function indexDirectory(dir, entries, seen, depth) {
  if (depth > 4) return; // prevent deep recursion
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    // Skip hidden dirs, node_modules, symlink loops
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;

    // Follow symlinks cautiously
    if (item.isDirectory() || (item.isSymbolicLink() && fs.existsSync(fullPath))) {
      try {
        const realPath = fs.realpathSync(fullPath);
        if (seen.has(realPath)) continue;
        seen.add(realPath);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          indexDirectory(fullPath, entries, seen, depth + 1);
        }
      } catch { continue; }
    }

    if (!item.isFile() && !item.isSymbolicLink()) continue;
    const ext = path.extname(item.name).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.length < 20) continue; // skip trivially small files

      // Split by headings for granular matching
      const sections = content.split(/^##?\s+/m).filter(s => s.trim().length > 30);

      if (sections.length <= 1) {
        // Index whole file as one entry
        entries.push(makeEntry(entries.length, content.substring(0, 1000), item.name, fullPath));
      } else {
        for (const section of sections) {
          const lines = section.split('\n');
          const title = lines[0] ? lines[0].trim().substring(0, 100) : item.name;
          entries.push(makeEntry(entries.length, section.substring(0, 800), title, fullPath));
        }
      }
    } catch { /* skip unreadable files */ }
  }
}

function makeEntry(index, content, summary, sourcePath) {
  return {
    id: `kb-${index}`,
    content: content,
    summary: summary,
    source: sourcePath,
    category: categorizeByPath(sourcePath),
    confidence: 0.6,
    words: tokenize(content + ' ' + summary),
  };
}

function categorizeByPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes('career') || lower.includes('positioning')) return 'career';
  if (lower.includes('learning')) return 'learning';
  if (lower.includes('revops') || lower.includes('revenue') || lower.includes('pipeline')) return 'revops';
  if (lower.includes('transcript') || lower.includes('meeting')) return 'meetings';
  if (lower.includes('memory')) return 'memory';
  if (lower.includes('workflow')) return 'workflow';
  return 'knowledge';
}

// --- Learned patterns (short-term -> long-term promotion) ---

function loadPatterns() {
  return readJSON(PATTERNS_PATH) || { shortTerm: [], longTerm: [] };
}

function savePatterns(patterns) {
  writeJSON(PATTERNS_PATH, patterns);
}

var cachedEntries = null;

module.exports = {
  /**
   * Initialize: index Knowledge/ and memory files into ranked context.
   * Called on session start.
   */
  init: function() {
    cachedEntries = indexKnowledgeBase();

    // Merge in learned patterns as high-confidence entries
    const patterns = loadPatterns();
    for (const p of patterns.longTerm) {
      cachedEntries.push({
        id: `pattern-${cachedEntries.length}`,
        content: p.content,
        summary: p.summary || 'Learned pattern',
        source: 'learned',
        category: 'pattern',
        confidence: Math.min(0.95, 0.7 + (p.uses || 0) * 0.02),
        words: tokenize(p.content + ' ' + (p.summary || '')),
      });
    }

    // Build vector index if available (TF-IDF + cosine > Jaccard)
    if (vectorSearch) {
      try {
        vectorIndex = vectorSearch.buildIndex(cachedEntries);
      } catch { vectorIndex = null; }
    }

    // Write ranked index for Jaccard fallback
    const ranked = cachedEntries.map(e => ({
      id: e.id, content: e.content.substring(0, 500), summary: e.summary,
      category: e.category, confidence: e.confidence, words: e.words,
    }));
    writeJSON(RANKED_PATH, { version: 1, computedAt: Date.now(), count: ranked.length, entries: ranked });

    const searchMode = vectorIndex ? 'tfidf' : 'jaccard';
    return { nodes: cachedEntries.length, edges: 0, categories: countCategories(cachedEntries), searchMode };
  },

  /**
   * Get relevant context for a prompt via Jaccard similarity.
   * Returns formatted string for injection into Claude's context.
   */
  getContext: function(prompt) {
    if (!prompt) return null;

    // Lazy-load vector index if not in memory (e.g., route hook without prior init)
    if (vectorSearch && !vectorIndex) {
      try {
        const idxPath = path.join(DATA_DIR, 'vector-index.json');
        if (fs.existsSync(idxPath)) {
          vectorIndex = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
        }
      } catch { /* fall through */ }
    }

    const blocks = [];

    // Block 1: Semantic memory — curated Knowledge/
    if (vectorSearch && vectorIndex) {
      try {
        const results = vectorSearch.search(prompt, vectorIndex, 5);
        if (results && results.length > 0) {
          const lines = ['[CASCADE INTELLIGENCE] Relevant knowledge (tfidf):'];
          for (const r of results) {
            const label = r.category ? `[${r.category}]` : '';
            lines.push(`  * (${r.score.toFixed(2)}) ${label} ${r.summary}`);
          }
          blocks.push(lines.join('\n'));
        }
      } catch { /* fall through to Jaccard */ }
    }

    // Jaccard fallback when vector search returns nothing
    if (!blocks.length) {
      const ranked = readJSON(RANKED_PATH);
      const entries = (ranked && ranked.entries) || cachedEntries || [];
      if (entries.length) {
        const promptWords = tokenize(prompt);
        if (promptWords.length) {
          const scored = [];
          for (const e of entries) {
            const score = jaccardScore(promptWords, e.words || tokenize(e.content + ' ' + e.summary));
            if (score > 0.05) scored.push({ entry: e, score });
          }
          scored.sort((a, b) => b.score - a.score);
          const top = scored.slice(0, 5);
          if (top.length) {
            const lines = ['[CASCADE INTELLIGENCE] Relevant knowledge (jaccard):'];
            for (const s of top) {
              const label = s.entry.category ? `[${s.entry.category}]` : '';
              const summary = (s.entry.summary || s.entry.content || '').substring(0, 80);
              lines.push(`  * (${s.score.toFixed(2)}) ${label} ${summary}`);
            }
            blocks.push(lines.join('\n'));
          }
        }
      }
    }

    // Block 2: Episodic memory — past tool observations (FTS5 keyword search)
    // Complements semantic memory with "what happened last time" recall.
    if (observationsModule && observationsModule.searchObservations) {
      try {
        const obs = observationsModule.searchObservations(prompt, { limit: 3, sinceDays: 30 });
        if (obs && obs.length > 0) {
          const lines = ['[CASCADE MEMORY] Past observations (episodic):'];
          for (const o of obs) {
            const when = o.timestamp ? new Date(o.timestamp).toISOString().slice(0, 10) : '';
            const file = o.file_path ? ` @ ${path.basename(o.file_path)}` : '';
            const preview = (o.input_summary || o.output_summary || '').replace(/\s+/g, ' ').slice(0, 70);
            lines.push(`  * ${when} ${o.tool_name}${file} — ${preview}`);
          }
          blocks.push(lines.join('\n'));
        }
      } catch { /* episodic memory optional */ }
    }

    return blocks.length ? blocks.join('\n') : null;
  },

  /**
   * Record a file edit for pending consolidation.
   */
  recordEdit: function(file) {
    if (!file) return;
    ensureDir(DATA_DIR);
    const line = JSON.stringify({ type: 'edit', file, timestamp: Date.now() }) + '\n';
    fs.appendFileSync(PENDING_PATH, line, 'utf-8');
  },

  /**
   * Record a task outcome for pattern learning.
   * Called by post-task hook with success/failure + context.
   */
  recordOutcome: function(agent, taskDescription, success) {
    if (!taskDescription) return;
    ensureDir(DATA_DIR);
    const line = JSON.stringify({
      type: 'outcome',
      agent: agent || 'unknown',
      task: taskDescription.substring(0, 300),
      success: !!success,
      timestamp: Date.now(),
    }) + '\n';
    fs.appendFileSync(PENDING_PATH, line, 'utf-8');
  },

  /**
   * Consolidate pending insights: promote repeated successes to patterns.
   * Called on session end.
   */
  consolidate: function() {
    if (!fs.existsSync(PENDING_PATH)) return { entries: 0, promoted: 0 };

    let content;
    try {
      content = fs.readFileSync(PENDING_PATH, 'utf-8').trim();
    } catch { return { entries: 0, promoted: 0 }; }

    if (!content) return { entries: 0, promoted: 0 };

    const lines = content.split('\n').filter(Boolean);
    const outcomes = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'outcome' && parsed.success) outcomes.push(parsed);
      } catch { /* skip */ }
    }

    // Promote: if an agent+task-pattern succeeded 3+ times, create a learned pattern
    const patterns = loadPatterns();
    let promoted = 0;

    if (outcomes.length >= 2) {
      // Group by agent
      const byAgent = {};
      for (const o of outcomes) {
        if (!byAgent[o.agent]) byAgent[o.agent] = [];
        byAgent[o.agent].push(o.task);
      }

      for (const [agent, tasks] of Object.entries(byAgent)) {
        if (tasks.length < 2) continue;
        const combined = tasks.join(' ');
        const words = tokenize(combined);
        const summary = `${agent} succeeds on: ${tasks[0].substring(0, 60)}`;

        // Check if similar pattern already exists
        const existing = patterns.longTerm.find(p =>
          jaccardScore(tokenize(p.content), words) > 0.5
        );

        if (existing) {
          existing.uses = (existing.uses || 1) + tasks.length;
          existing.lastSeen = Date.now();
        } else {
          // Add to short-term first
          patterns.shortTerm.push({
            content: combined.substring(0, 500),
            summary,
            agent,
            uses: tasks.length,
            createdAt: Date.now(),
            lastSeen: Date.now(),
          });
        }
      }

      // Promote short-term patterns with 3+ uses to long-term
      const toPromote = patterns.shortTerm.filter(p => (p.uses || 0) >= 3);
      for (const p of toPromote) {
        patterns.longTerm.push(p);
        promoted++;
      }
      patterns.shortTerm = patterns.shortTerm.filter(p => (p.uses || 0) < 3);

      // Cap long-term at 500 patterns (evict lowest-use)
      if (patterns.longTerm.length > 500) {
        patterns.longTerm.sort((a, b) => (b.uses || 0) - (a.uses || 0));
        patterns.longTerm = patterns.longTerm.slice(0, 500);
      }

      savePatterns(patterns);
    }

    // Clear pending
    try { fs.writeFileSync(PENDING_PATH, '', 'utf-8'); } catch { /* ok */ }

    return { entries: lines.length, promoted };
  },

  stats: function(json) {
    const ranked = readJSON(RANKED_PATH);
    const patterns = loadPatterns();
    const count = ranked && ranked.entries ? ranked.entries.length : 0;
    const info = {
      knowledgeEntries: count,
      computedAt: ranked ? ranked.computedAt : null,
      shortTermPatterns: patterns.shortTerm.length,
      longTermPatterns: patterns.longTerm.length,
    };
    if (json) {
      console.log(JSON.stringify(info));
    } else {
      console.log(`[CASCADE] Knowledge: ${count} entries | Patterns: ${patterns.shortTerm.length} short-term, ${patterns.longTerm.length} long-term`);
    }
  },
};

function countCategories(entries) {
  const counts = {};
  for (const e of entries) {
    counts[e.category] = (counts[e.category] || 0) + 1;
  }
  return counts;
}

if (require.main === module) {
  const [,, command] = process.argv;
  const cmds = { init: 'init', stats: 'stats', consolidate: 'consolidate' };
  if (command === 'init') {
    const result = module.exports.init();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'stats') {
    module.exports.stats(false);
  } else if (command === 'consolidate') {
    const result = module.exports.consolidate();
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage: intelligence.cjs <init|stats|consolidate>');
  }
}

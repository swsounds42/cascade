#!/usr/bin/env node
/**
 * Cascade Vector Search
 * TF-IDF vectorization + cosine similarity for Knowledge/ search.
 * Pure JS — no external dependencies. Sub-millisecond at <5000 entries.
 *
 * Upgrades over Jaccard:
 *   - IDF weighting: rare/domain-specific words score higher
 *   - Cosine similarity: direction-based matching, not just overlap
 *   - Persistent index: rebuilds only when files change
 *
 * Designed with upgrade path: swap vectorize() for real embeddings later.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = process.env.CASCADE_ROOT || process.cwd();
const INDEX_PATH = path.join(PROJECT_ROOT, '.cascade', 'intelligence', 'vector-index.json');

// --- Tokenization ---

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'up', 'out', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'it', 'its', 'of', 'by', 'as', 'not', 'no', 'so',
  'if', 'then', 'than', 'too', 'very', 'just', 'about', 'also', 'more',
  'some', 'any', 'all', 'each', 'every', 'both', 'few', 'many', 'much',
  'own', 'other', 'such', 'only', 'same', 'into', 'over', 'after', 'before',
  'between', 'through', 'during', 'without', 'again', 'further', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'what', 'which', 'who',
  'whom', 'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'him',
  'her', 'me', 'my', 'i', 'am',
  // Conversational fillers — never domain content. Adding these prevents
  // false positives like "let's keep going" → gws-keep (where "lets" + "going"
  // are filler, leaving only "keep" which collides with the Google product name).
  // NOTE: "work" deliberately NOT included — it IS a domain term ("resume work",
  // "verify work" are real intent triggers for gsd-resume-work / gsd-verify-work).
  'lets', 'let', 'going', 'doing', 'getting', 'making', 'taking', 'using',
  'thing', 'things', 'stuff', 'way', 'ways', 'actually', 'really', 'pretty',
  'right', 'okay', 'yeah', 'yes', 'sure', 'gonna', 'wanna', 'kinda', 'sorta',
  'now', 'still', 'maybe', 'probably', 'definitely', 'something', 'anything',
  'everything', 'nothing', 'someone', 'anyone', 'everyone', 'nobody',
  'good', 'great', 'nice', 'bad', 'big', 'small', 'one', 'two', 'three',
]);

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// --- TF-IDF ---

function buildIDF(documents) {
  const docCount = documents.length;
  const docFreq = {};

  for (const doc of documents) {
    const seen = new Set(doc.tokens);
    for (const token of seen) {
      docFreq[token] = (docFreq[token] || 0) + 1;
    }
  }

  const idf = {};
  for (const [token, freq] of Object.entries(docFreq)) {
    idf[token] = Math.log((docCount + 1) / (freq + 1)) + 1; // smoothed IDF
  }
  return idf;
}

function tfidfVector(tokens, idf) {
  // Term frequency
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }

  // TF-IDF weighted sparse vector
  const vec = {};
  let norm = 0;
  for (const [term, count] of Object.entries(tf)) {
    const weight = (count / tokens.length) * (idf[term] || 1);
    vec[term] = weight;
    norm += weight * weight;
  }

  // L2 normalize for cosine similarity
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const term in vec) {
      vec[term] /= norm;
    }
  }

  return vec;
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  // Sparse dot product — iterate shorter vector
  const [shorter, longer] = Object.keys(vecA).length <= Object.keys(vecB).length
    ? [vecA, vecB] : [vecB, vecA];

  for (const term in shorter) {
    if (longer[term]) {
      dot += shorter[term] * longer[term];
    }
  }
  return dot; // already L2-normalized, so dot product = cosine similarity
}

// --- Index Management ---

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    }
  } catch { /* rebuild */ }
  return null;
}

function saveIndex(index) {
  const dir = path.dirname(INDEX_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index), 'utf-8');
}

/**
 * Build or load the TF-IDF index from knowledge entries.
 * @param {Array} entries - Array of { id, content, summary, source, category }
 * @param {boolean} forceRebuild - Rebuild even if cache exists
 * @returns {Object} index with idf, vectors, metadata
 */
function buildIndex(entries, forceRebuild) {
  // Check if we can use cached index
  const hash = crypto.createHash('md5')
    .update(entries.map(e => e.id + e.content.length).join('|'))
    .digest('hex');

  if (!forceRebuild) {
    const cached = loadIndex();
    if (cached && cached.hash === hash) {
      return cached;
    }
  }

  // Tokenize all entries
  const documents = entries.map(e => ({
    id: e.id,
    tokens: tokenize(e.content + ' ' + (e.summary || '')),
    summary: (e.summary || '').substring(0, 100),
    category: e.category || 'knowledge',
    confidence: e.confidence || 0.6,
  }));

  // Build IDF from corpus
  const idf = buildIDF(documents);

  // Compute TF-IDF vectors for each document
  const vectors = {};
  for (const doc of documents) {
    vectors[doc.id] = {
      vec: tfidfVector(doc.tokens, idf),
      summary: doc.summary,
      category: doc.category,
      confidence: doc.confidence,
    };
  }

  const index = {
    hash,
    builtAt: Date.now(),
    entryCount: entries.length,
    vocabSize: Object.keys(idf).length,
    idf,
    vectors,
  };

  saveIndex(index);
  return index;
}

/**
 * Search the index for entries most similar to a query.
 * @param {string} query - Natural language query
 * @param {Object} index - The TF-IDF index from buildIndex()
 * @param {number} topK - Number of results to return
 * @returns {Array} Ranked results with score, summary, category
 */
function search(query, index, topK) {
  if (!query || !index || !index.idf) return [];

  topK = topK || 5;
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const queryVec = tfidfVector(queryTokens, index.idf);

  const results = [];
  for (const [id, entry] of Object.entries(index.vectors)) {
    const score = cosineSimilarity(queryVec, entry.vec);
    if (score > 0.05) {
      results.push({
        id,
        score: Math.round(score * 1000) / 1000,
        summary: entry.summary,
        category: entry.category,
        confidence: entry.confidence,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

module.exports = { buildIndex, search, tokenize, tfidfVector, cosineSimilarity };

if (require.main === module) {
  const [,, cmd, ...rest] = process.argv;
  if (cmd === 'search' && rest.length) {
    const index = loadIndex();
    if (!index) {
      console.log('No index found. Run intelligence.cjs init first.');
      process.exit(1);
    }
    const results = search(rest.join(' '), index, 5);
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('Usage: vector-search.cjs search <query>');
  }
}

/**
 * LABA LONG-CONTEXT ENGINE  v3.0
 * window.LabaContextEngine
 *
 * Handles long conversations intelligently.
 * Compresses context windows, semantically summarises old turns,
 * chunks and prioritises active context, manages hidden state.
 */
(function () {
  'use strict';
  if (window.LabaContextEngine) return;

  var LOG = '[LLCE]';
  function log() { console.log.apply(console, [LOG].concat([].slice.call(arguments))); }

  var MAX_TOKENS   = 3000;  // target context window
  var SUMMARY_AT   = 20;    // compress after this many turns
  var CHUNK_SIZE   = 800;   // chars per chunk for indexing

  // ── Session State ─────────────────────────────────────────────────────────
  var _sessions = {}; // sessionId → { turns:[], summaries:[], hiddenState:{} }

  function _ensure(sid) {
    if (!_sessions[sid]) _sessions[sid] = { turns: [], summaries: [], hiddenState: {}, turnsSinceCompress: 0 };
    return _sessions[sid];
  }

  // ── Add Turn ──────────────────────────────────────────────────────────────
  function addTurn(sessionId, role, text) {
    var sess = _ensure(sessionId);
    sess.turns.push({ role: role, text: text, ts: Date.now(), tokens: Math.ceil(text.length / 4) });
    sess.turnsSinceCompress++;

    // Auto-compress when too many turns
    if (sess.turnsSinceCompress >= SUMMARY_AT) {
      _compress(sess);
    }
  }

  // ── Compress Old Turns ────────────────────────────────────────────────────
  function _compress(sess) {
    var half = Math.floor(sess.turns.length / 2);
    var old  = sess.turns.slice(0, half);
    var kept = sess.turns.slice(half);

    // Extractive summary of old turns
    var summaryText = _extractiveSummary(old);
    sess.summaries.push({ text: summaryText, compressedAt: Date.now(), turnCount: old.length });
    sess.turns = kept;
    sess.turnsSinceCompress = 0;
    log('compressed', old.length, 'turns into summary (', summaryText.length, 'chars)');
  }

  // ── Extractive Summary ────────────────────────────────────────────────────
  function _extractiveSummary(turns) {
    var lines = turns.map(function (t) {
      return t.role + ': ' + t.text.slice(0, 120);
    });
    return '[Earlier conversation summary]:\n' + lines.join('\n');
  }

  // ── Build Context Window ──────────────────────────────────────────────────
  // Returns a string ready to be prepended to the next prompt.
  function buildContext(sessionId, query, maxTokens) {
    var sess = _ensure(sessionId);
    maxTokens = maxTokens || MAX_TOKENS;
    var budget = maxTokens;
    var parts  = [];

    // 1. Summaries (oldest first, abbreviated)
    for (var si = sess.summaries.length - 1; si >= 0 && budget > 200; si--) {
      var s = sess.summaries[si];
      var t = s.text.slice(0, 300);
      parts.unshift(t);
      budget -= Math.ceil(t.length / 4);
    }

    // 2. Recent turns (most recent first, trim to budget)
    var recent = sess.turns.slice().reverse();
    for (var ti = 0; ti < recent.length && budget > 50; ti++) {
      var turn = recent[ti];
      var txt  = turn.role + ': ' + turn.text.slice(0, 400);
      parts.push(txt);
      budget -= Math.ceil(txt.length / 4);
    }

    return parts.join('\n').trim();
  }

  // ── Semantic Chunk Indexer ─────────────────────────────────────────────────
  function chunkDocument(docText) {
    if (!docText) return [];
    var chunks = [];
    for (var i = 0; i < docText.length; i += CHUNK_SIZE) {
      chunks.push({ text: docText.slice(i, i + CHUNK_SIZE), offset: i });
    }
    return chunks;
  }

  // ── Prioritised Retrieval ─────────────────────────────────────────────────
  // Simple keyword overlap scoring — no embeddings required
  function retrieve(chunks, query, topK) {
    topK = topK || 3;
    var queryWords = query.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 3; });
    var scored = chunks.map(function (chunk) {
      var score = queryWords.reduce(function (acc, word) {
        return acc + (chunk.text.toLowerCase().split(word).length - 1);
      }, 0);
      return { chunk: chunk.text, score: score };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, topK).filter(function (r) { return r.score > 0; });
  }

  // ── Hidden State ──────────────────────────────────────────────────────────
  function setHiddenState(sessionId, key, value) {
    _ensure(sessionId).hiddenState[key] = value;
  }
  function getHiddenState(sessionId, key) {
    return (_sessions[sessionId] || {}).hiddenState[key];
  }

  // ── Clear Session ─────────────────────────────────────────────────────────
  function clearSession(sessionId) {
    delete _sessions[sessionId];
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(sessionId) {
    var sess = _sessions[sessionId];
    if (!sess) return null;
    return {
      activeTurns:   sess.turns.length,
      summaryCount:  sess.summaries.length,
      totalTokensEst: sess.turns.reduce(function (a, t) { return a + t.tokens; }, 0),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaContextEngine = {
    version:        '3.0',
    addTurn:        addTurn,
    buildContext:   buildContext,
    chunkDocument:  chunkDocument,
    retrieve:       retrieve,
    setHiddenState: setHiddenState,
    getHiddenState: getHiddenState,
    clearSession:   clearSession,
    getStats:       getStats,
  };

  log('v3.0 ready — long-context engine online (max', MAX_TOKENS, 'tokens, compress at', SUMMARY_AT, 'turns)');
}());

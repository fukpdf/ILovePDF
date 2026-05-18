// summary-worker.js v1.0 — Isolated TF-IDF text scoring worker
// Phase 2C: Extracts chunkTextScore from advanced-worker.js into a dedicated
//           terminate-after-job worker — no shared WorkerPool slot consumed.
//
// PROBLEM SOLVED:
//   ai-summarize processor calls runAdvancedWorker({op:'chunk-text-score'}) which
//   uses a shared WorkerPool slot.  On timeout the slot is leaked permanently.
//
// Protocol:
//   IN:  { op: 'summarize'|'chunk-text-score', text: string, maxSentences: number, jobId }
//   OUT: { summary, wordCount, sentenceCount, topCount, jobId }
//   ERR: { __error: string }

'use strict';

// ── TF-IDF sentence scorer ──────────────────────────────────────────────────
// Exact replica of chunkTextScore() from advanced-worker.js — self-contained.
function chunkTextScore(text, maxSentences) {
  var max = Math.min(25, Math.max(3, parseInt(maxSentences || 7, 10)));

  var sentences = (text.match(/[^.!?\n]{10,}[.!?]/g) || [])
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length >= 15; });

  if (!sentences.length) {
    sentences = text.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  var allWords = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  var freq     = {};
  for (var wi = 0; wi < allWords.length; wi++) {
    var w = allWords[wi];
    freq[w] = (freq[w] || 0) + 1;
  }

  var scored = sentences.map(function (s) {
    var sWords = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    var score  = 0;
    for (var si = 0; si < sWords.length; si++) score += (freq[sWords[si]] || 0);
    return { s: s, score: sWords.length ? score / sWords.length : 0 };
  });

  // Sort descending by score, then deduplicate near-identical sentences
  var sorted  = scored.slice().sort(function (a, b) { return b.score - a.score; });
  var seen    = [];
  var deduped = [];

  for (var di = 0; di < sorted.length && deduped.length < max; di++) {
    var candidate = sorted[di].s.trim().toLowerCase();
    var isDup = seen.some(function (prev) {
      var aSet = new Set(prev.split(/\s+/));
      var bArr = candidate.split(/\s+/);
      var intr = 0;
      bArr.forEach(function (tok) { if (aSet.has(tok)) intr++; });
      var un = aSet.size + bArr.length - intr;
      return un > 0 && intr / un > 0.60;
    });
    if (!isDup) {
      deduped.push(sorted[di].s);
      seen.push(candidate);
    }
  }

  return {
    summary:       deduped.join(' '),
    wordCount:     allWords.length,
    sentenceCount: sentences.length,
    topCount:      deduped.length,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
self.onmessage = function (e) {
  var data = e.data || {};
  var op   = data.op;

  if (op !== 'summarize' && op !== 'chunk-text-score') {
    self.postMessage({ __error: 'summary-worker: unknown op: ' + op });
    return;
  }
  if (!data.text || typeof data.text !== 'string') {
    self.postMessage({ __error: 'summary-worker: text must be a non-empty string' });
    return;
  }

  try {
    var result = chunkTextScore(data.text, data.maxSentences);
    self.postMessage(Object.assign({}, result, { jobId: data.jobId || '' }));
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: data.jobId || '' });
  }
};

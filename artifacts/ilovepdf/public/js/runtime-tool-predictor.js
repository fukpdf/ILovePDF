// RuntimeToolPredictor v1.0 — Arc 12 / Phase E / Enterprise Tool Intelligence Layer
// Next-tool prediction engine. Learns tool-to-tool transition sequences.
// Integrates: RuntimeAdaptiveAI (base predictions), RuntimeToolRegistry,
//             RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolPredictor) return;

  var LOG = '[ToolPredictor]';

  // ── Sequence model ────────────────────────────────────────────────────────────
  // _model[fromId][toId] = count of transitions
  var _model    = {};
  var _history  = [];    // recent tool sequence, ring buffer cap=20
  var _metrics  = { recorded: 0, predicted: 0, hits: 0 };
  var MAX_HIST  = 20;
  var TOP_N     = 5;

  // ── Seed known patterns ───────────────────────────────────────────────────────
  var SEED_SEQUENCES = [
    ['merge-pdf',    'compress-pdf'],
    ['compress-pdf', 'merge-pdf'],
    ['ocr-pdf',      'ai-summarizer'],
    ['ocr-pdf',      'ai-translate'],
    ['split-pdf',    'merge-pdf'],
    ['pdf-to-word',  'word-to-pdf'],
    ['pdf-to-jpg',   'jpg-to-pdf'],
    ['jpg-to-pdf',   'merge-pdf'],
    ['merge-pdf',    'watermark-pdf'],
    ['merge-pdf',    'protect-pdf'],
  ];

  function _seed() {
    SEED_SEQUENCES.forEach(function (pair) {
      _record(pair[0], pair[1]);
    });
  }

  // ── Record a transition (internal, no metrics increment) ─────────────────────
  function _record(from, to) {
    if (!from || !to || from === to) return;
    if (!_model[from]) _model[from] = {};
    _model[from][to] = (_model[from][to] || 0) + 1;
  }

  // ── Record tool usage (public) ────────────────────────────────────────────────
  function recordUsage(toolId) {
    if (!toolId) return;
    var prev = _history.length > 0 ? _history[_history.length - 1] : null;

    _history.push(toolId);
    if (_history.length > MAX_HIST) _history.shift();

    if (prev && prev !== toolId) {
      _record(prev, toolId);
      _metrics.recorded++;
    }

    // Also sync with RuntimeAdaptiveAI
    try {
      var ai = G.RuntimeAdaptiveAI;
      if (ai && ai.recordToolUse) ai.recordToolUse(toolId);
    } catch (_) {}

    // Update registry
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.updateMetrics) reg.updateMetrics(toolId, { launch: true });
    } catch (_) {}

    _tel('usage', { toolId: toolId, prev: prev });
  }

  // ── Predict next tool ─────────────────────────────────────────────────────────
  function predictNextTool(toolId) {
    _metrics.predicted++;
    var predictions = [];

    // 1. Own model
    var transitions = _model[toolId];
    if (transitions) {
      var sorted = Object.keys(transitions).sort(function (a, b) {
        return transitions[b] - transitions[a];
      });
      sorted.forEach(function (id) {
        predictions.push({ toolId: id, score: transitions[id], source: 'learned' });
      });
    }

    // 2. Merge with RuntimeAdaptiveAI predictions
    try {
      var ai = G.RuntimeAdaptiveAI;
      if (ai && ai.predictNext) {
        var aiPreds = ai.predictNext(toolId) || [];
        aiPreds.forEach(function (id, i) {
          var existing = predictions.find(function (p) { return p.toolId === id; });
          if (existing) {
            existing.score += (aiPreds.length - i);   // boost if confirmed by AI
            existing.source = 'learned+ai';
          } else {
            predictions.push({ toolId: id, score: aiPreds.length - i, source: 'ai' });
          }
        });
      }
    } catch (_) {}

    // Sort by score descending, return top N
    predictions.sort(function (a, b) { return b.score - a.score; });
    return predictions.slice(0, TOP_N);
  }

  // ── Top sequences ─────────────────────────────────────────────────────────────
  function getTopSequences(n) {
    var pairs = [];
    Object.keys(_model).forEach(function (from) {
      Object.keys(_model[from]).forEach(function (to) {
        pairs.push({ from: from, to: to, count: _model[from][to] });
      });
    });
    pairs.sort(function (a, b) { return b.count - a.count; });
    return pairs.slice(0, n || 10);
  }

  function getHistory() { return _history.slice(); }
  function getModel()   { return JSON.parse(JSON.stringify(_model)); }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:predictor:' + event, data, ['arc12', 'predictor']);
    } catch (_) {}
  }

  // ── Event wiring ──────────────────────────────────────────────────────────────
  try {
    G.addEventListener('arc9:tool-recorded', function (e) {
      var id = e && e.detail && e.detail.toolId;
      if (id) recordUsage(id);
    });
  } catch (_) {}

  // Seed on load
  _seed();

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolPredictor = Object.freeze({
    recordUsage:    recordUsage,
    predictNextTool: predictNextTool,
    getTopSequences: getTopSequences,
    getHistory:     getHistory,
    getModel:       getModel,
    getMetrics:     function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));

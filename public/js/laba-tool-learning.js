/**
 * LABA DYNAMIC TOOL LEARNING  v3.0
 * window.LabaToolLearning
 *
 * Learns from successful workflows, optimises routing,
 * tracks user behaviour, improves confidence scores,
 * and auto-ranks tools.
 */
(function () {
  'use strict';
  if (window.LabaToolLearning) return;

  var LOG = '[LLTL]';
  function log() { console.log.apply(console, [LOG].concat([].slice.call(arguments))); }

  var STORE_KEY = 'laba_tool_learning_v1';

  // ── Persistent Stats ──────────────────────────────────────────────────────
  var _stats = {}; // toolId → { uses, successes, failures, avgMs, lastUsed, userScore }

  function _load() {
    try { var r = localStorage.getItem(STORE_KEY); if (r) _stats = JSON.parse(r); } catch (_) {}
  }
  function _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(_stats)); } catch (_) {}
  }
  _load();

  function _ensure(toolId) {
    if (!_stats[toolId]) {
      _stats[toolId] = { uses: 0, successes: 0, failures: 0, avgMs: 0, lastUsed: 0, userScore: 0.8 };
    }
    return _stats[toolId];
  }

  // ── Record Outcome ────────────────────────────────────────────────────────
  function recordSuccess(toolId, durationMs) {
    var s = _ensure(toolId);
    s.uses++;
    s.successes++;
    s.lastUsed = Date.now();
    // Exponential moving average for duration
    s.avgMs = s.avgMs === 0 ? durationMs : Math.round(s.avgMs * 0.7 + durationMs * 0.3);
    // Boost user score slightly
    s.userScore = Math.min(0.99, s.userScore + 0.005);
    _save();
    log('recorded success:', toolId, durationMs + 'ms | score:', s.userScore.toFixed(3));
  }

  function recordFailure(toolId) {
    var s = _ensure(toolId);
    s.uses++;
    s.failures++;
    s.lastUsed = Date.now();
    s.userScore = Math.max(0.1, s.userScore - 0.02);
    _save();
    log('recorded failure:', toolId, '| score:', s.userScore.toFixed(3));
  }

  function recordUserRating(toolId, thumbsUp) {
    var s = _ensure(toolId);
    s.userScore = thumbsUp
      ? Math.min(0.99, s.userScore + 0.05)
      : Math.max(0.1, s.userScore - 0.05);
    _save();
  }

  // ── Get Confidence Boost ──────────────────────────────────────────────────
  // Returns a confidence modifier [−0.3, +0.3] based on learned history
  function getConfidenceBoost(toolId) {
    var s = _stats[toolId];
    if (!s || s.uses < 2) return 0;
    var successRate = s.uses > 0 ? s.successes / s.uses : 0.5;
    return (successRate - 0.5) * 0.6; // maps 0→−0.3, 1→+0.3
  }

  // ── Ranked Tool List ──────────────────────────────────────────────────────
  function getRankedTools() {
    var TOOLS = window.LabaToolRegistry ? window.LabaToolRegistry.tools : [];
    return TOOLS.map(function (tool) {
      var s = _stats[tool.id] || { uses: 0, userScore: 0.8 };
      return {
        tool:      tool,
        uses:      s.uses,
        userScore: s.userScore,
        rank:      s.userScore + (s.uses > 5 ? 0.1 : 0), // small boost for frequently used
      };
    }).sort(function (a, b) { return b.rank - a.rank; });
  }

  // ── Optimised Intent Routing ──────────────────────────────────────────────
  // Wraps LabaToolRegistry.findByIntent with learned bias
  function findByIntentLearned(text, fileExt) {
    var base = window.LabaToolRegistry && window.LabaToolRegistry.findByIntent(text, fileExt);
    if (!base) return null;

    // If the learned tool has a significantly lower score, suggest an alternative
    var baseScore = _stats[base.id] ? _stats[base.id].userScore : 0.8;
    if (baseScore < 0.5) {
      // Try to find a better alternative
      var ranked = getRankedTools();
      var better = ranked.find(function (r) {
        return r.userScore > baseScore + 0.2 && r.tool.accepts.some(function (a) {
          return !fileExt || a === fileExt.toLowerCase();
        });
      });
      if (better) {
        log('learning: substituting', base.id, '→', better.tool.id, 'based on learned quality');
        return better.tool;
      }
    }

    return base;
  }

  // ── Suggest Alternatives ──────────────────────────────────────────────────
  function suggestAlternatives(toolId, fileExt) {
    var ranked = getRankedTools();
    return ranked
      .filter(function (r) {
        return r.tool.id !== toolId &&
               r.tool.accepts.some(function (a) { return !fileExt || a === fileExt; }) &&
               r.userScore >= 0.7;
      })
      .slice(0, 3)
      .map(function (r) { return r.tool; });
  }

  // ── Workflow Pattern Learning ─────────────────────────────────────────────
  var _workflowPatterns = {}; // "toolA→toolB" → count

  function recordWorkflowStep(prevToolId, nextToolId) {
    var key = prevToolId + '→' + nextToolId;
    _workflowPatterns[key] = (_workflowPatterns[key] || 0) + 1;
  }

  function getTopWorkflows(limit) {
    return Object.keys(_workflowPatterns)
      .map(function (k) { return { pattern: k, count: _workflowPatterns[k] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, limit || 5);
  }

  // ── Stats Export ──────────────────────────────────────────────────────────
  function getStats() {
    return {
      tools:            Object.assign({}, _stats),
      topWorkflows:     getTopWorkflows(5),
      totalToolUses:    Object.values(_stats).reduce(function (a, s) { return a + s.uses; }, 0),
      bestTool:         getRankedTools()[0] ? getRankedTools()[0].tool.id : null,
    };
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  function reset() {
    _stats = {};
    _workflowPatterns = {};
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    log('learning data reset');
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.LabaToolLearning = {
    version:              '3.0',
    recordSuccess:        recordSuccess,
    recordFailure:        recordFailure,
    recordUserRating:     recordUserRating,
    recordWorkflowStep:   recordWorkflowStep,
    getConfidenceBoost:   getConfidenceBoost,
    getRankedTools:       getRankedTools,
    findByIntentLearned:  findByIntentLearned,
    suggestAlternatives:  suggestAlternatives,
    getTopWorkflows:      getTopWorkflows,
    getStats:             getStats,
    reset:                reset,
  };

  log('v3.0 ready — dynamic tool learning online (' + Object.keys(_stats).length + ' tools tracked)');
}());

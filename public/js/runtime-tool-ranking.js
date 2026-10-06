(function (G) {
  'use strict';
  if (G.RuntimeToolRanking) return;

  var LOG = '[Arc13:Ranking]';

  // Weighted score formula (sums to 1.0)
  var W_USAGE    = 0.40;
  var W_SUCCESS  = 0.30;
  var W_LATENCY  = 0.20;
  var W_RECOVERY = 0.10;

  var _scores   = {};   // toolId → { score, usage, success, latency, recovery, rank }
  var _metrics  = { computed: 0, lastComputedTs: 0 };
  var REFRESH_MS = 90 * 1000;   // recompute every 90s

  // ── Score computation ────────────────────────────────────────────────────────
  function _computeAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg || !reg.getAllTools) return;
    var tools = reg.getAllTools();
    if (!tools.length) return;

    // Gather raw values
    var rawLaunches = tools.map(function (t) { return t.launches || 0; });
    var maxLaunches = Math.max.apply(null, rawLaunches) || 1;
    var rawLatency  = tools.map(function (t) { return t.avgExecutionMs || 0; });
    var maxLatency  = Math.max.apply(null, rawLatency) || 1;

    var scored = tools.map(function (t) {
      var launches  = t.launches || 0;
      var successes = t.successes || 0;
      var failures  = t.failures  || 0;
      var total     = successes + failures;
      var crashCnt  = t.crashCount || 0;

      // Usage score 0-100: normalized launches
      var usageScore = (launches / maxLaunches) * 100;

      // Success rate score 0-100
      var successScore = total > 0 ? (successes / total) * 100 : 50;

      // Latency score 0-100: lower latency = higher score
      var lat = t.avgExecutionMs || 0;
      var latencyScore = lat > 0 ? Math.max(0, 100 - (lat / maxLatency) * 100) : 50;

      // Recovery score 0-100: fewer crashes = higher score
      var recScore = Math.max(0, 100 - crashCnt * 10);

      // Weighted composite
      var composite = usageScore  * W_USAGE
                    + successScore * W_SUCCESS
                    + latencyScore * W_LATENCY
                    + recScore     * W_RECOVERY;

      return {
        id:            t.id,
        score:         Math.round(composite * 10) / 10,
        usageScore:    Math.round(usageScore),
        successScore:  Math.round(successScore),
        latencyScore:  Math.round(latencyScore),
        recoveryScore: Math.round(recScore),
        launches:      launches,
        successRate:   total > 0 ? Math.round((successes / total) * 100) : null,
        avgExecutionMs: lat,
      };
    });

    // Assign global rank by composite score
    scored.sort(function (a, b) { return b.score - a.score; });
    scored.forEach(function (s, i) { s.rank = i + 1; });

    _scores = {};
    scored.forEach(function (s) { _scores[s.id] = s; });
    _metrics.computed++;
    _metrics.lastComputedTs = Date.now();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getScore(toolId) {
    if (!_scores[toolId]) _computeAll();
    return _scores[toolId] ? Object.assign({}, _scores[toolId]) : null;
  }

  function getRankings() {
    if (!Object.keys(_scores).length) _computeAll();
    return Object.keys(_scores).map(function (id) { return Object.assign({}, _scores[id]); })
      .sort(function (a, b) { return a.rank - b.rank; });
  }

  function getTopN(n) {
    return getRankings().slice(0, n || 10);
  }

  function getMostReliable(n) {
    return getRankings().sort(function (a, b) {
      return (b.successRate || 0) - (a.successRate || 0);
    }).slice(0, n || 10);
  }

  function getFastest(n) {
    return getRankings().filter(function (t) { return t.avgExecutionMs > 0; })
      .sort(function (a, b) { return a.avgExecutionMs - b.avgExecutionMs; })
      .slice(0, n || 10);
  }

  function forceRefresh() { _computeAll(); }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-refresh
  setTimeout(function _tick() {
    _computeAll();
    setTimeout(_tick, REFRESH_MS);
  }, REFRESH_MS);

  // Recompute on registry updates
  G.addEventListener('arc12:metrics-updated', function () {
    // Debounced — only recompute if last compute > 5s ago
    if (Date.now() - _metrics.lastComputedTs > 5000) _computeAll();
  });

  G.RuntimeToolRanking = Object.freeze({
    getScore:       getScore,
    getRankings:    getRankings,
    getTopN:        getTopN,
    getMostReliable: getMostReliable,
    getFastest:     getFastest,
    forceRefresh:   forceRefresh,
    getMetrics:     getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));

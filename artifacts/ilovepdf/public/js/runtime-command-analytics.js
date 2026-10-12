(function (G) {
  'use strict';
  if (G.RuntimeCommandAnalytics) return;

  var LOG = '[Arc14:CommandAnalytics]';

  var WINDOWS = [
    { id: '5m',  label: '5 min',  ms: 5  * 60 * 1000 },
    { id: '15m', label: '15 min', ms: 15 * 60 * 1000 },
    { id: '1h',  label: '1 hr',   ms: 60 * 60 * 1000 },
    { id: '6h',  label: '6 hr',   ms: 6  * 60 * 60 * 1000 },
    { id: '24h', label: '24 hr',  ms: 24 * 60 * 60 * 1000 },
  ];

  var _samples  = [];
  var MAX_SAMP  = 1000;
  var _metrics  = { samples: 0, trendsComputed: 0 };
  var SAMPLE_MS = 60 * 1000;

  function _sample() {
    var hm   = G.RuntimeHeatmaps;
    var curr = hm && hm.getCurrent ? hm.getCurrent() : null;
    if (!curr) return;
    _samples.push({
      ts:               curr.ts,
      memory_pct:       curr.memory ? curr.memory.pct : 0,
      workers_active:   curr.workers ? curr.workers.active : 0,
      failures_pct:     curr.failures ? curr.failures.pct : 0,
      incidents_active: curr.incidents ? curr.incidents.active : 0,
      sla_violations:   curr.sla ? curr.sla.violations : 0,
      cb_open:          curr.circuitBreakers ? curr.circuitBreakers.open : 0,
    });
    if (_samples.length > MAX_SAMP) _samples.shift();
    _metrics.samples++;
  }

  function _window(windowId) {
    var w    = WINDOWS.find(function (x) { return x.id === windowId; }) || WINDOWS[1];
    var from = Date.now() - w.ms;
    return _samples.filter(function (s) { return s.ts >= from; });
  }

  function _trend(series, key) {
    if (series.length < 2) return 0;
    var n = series.length, sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    var t0 = series[0].ts;
    series.forEach(function (s) {
      var x = (s.ts - t0) / 60000;
      var y = s[key] || 0;
      sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
    });
    var denom = n * sumX2 - sumX * sumX;
    if (!denom) return 0;
    _metrics.trendsComputed++;
    return (n * sumXY - sumX * sumY) / denom;
  }

  function _growth(series, key) {
    if (series.length < 2) return 0;
    var first = series[0][key] || 0;
    var last  = series[series.length - 1][key] || 0;
    return first > 0 ? Math.round(((last - first) / first) * 100) : 0;
  }

  function _avg(series, key) {
    if (!series.length) return 0;
    return series.reduce(function (sum, s) { return sum + (s[key] || 0); }, 0) / series.length;
  }

  function getTrends(windowId) {
    var series = _window(windowId || '15m');
    return {
      windowId:      windowId || '15m',
      sampleCount:   series.length,
      memory:        { trend: _trend(series, 'memory_pct'),       avg: _avg(series, 'memory_pct'),       growth: _growth(series, 'memory_pct') },
      workers:       { trend: _trend(series, 'workers_active'),   avg: _avg(series, 'workers_active'),   growth: _growth(series, 'workers_active') },
      failures:      { trend: _trend(series, 'failures_pct'),     avg: _avg(series, 'failures_pct'),     growth: _growth(series, 'failures_pct') },
      incidents:     { trend: _trend(series, 'incidents_active'), avg: _avg(series, 'incidents_active'), growth: _growth(series, 'incidents_active') },
      slaViolations: { trend: _trend(series, 'sla_violations'),   avg: _avg(series, 'sla_violations'),   growth: _growth(series, 'sla_violations') },
      cbOpen:        { trend: _trend(series, 'cb_open'),          avg: _avg(series, 'cb_open'),          growth: _growth(series, 'cb_open') },
    };
  }

  function getGrowthRates(windowId) {
    var t = getTrends(windowId || '1h');
    return { memory: t.memory.growth, workers: t.workers.growth, failures: t.failures.growth,
             incidents: t.incidents.growth, slaViolations: t.slaViolations.growth };
  }

  function getSamples(windowId, limit) {
    var series = _window(windowId || '15m');
    if (limit) series = series.slice(-limit);
    return series;
  }

  function getToolUsageTrend() {
    var reg  = G.RuntimeToolRegistry;
    var rank = G.RuntimeToolRanking;
    if (!reg || !reg.getAllTools) return [];
    return reg.getAllTools().map(function (t) {
      var r = rank && rank.getScore ? rank.getScore(t.id) : null;
      return { toolId: t.id, launches: t.launches || 0,
               successRate: (t.successes + t.failures) > 0 ? Math.round((t.successes / (t.successes + t.failures)) * 100) : null,
               score: r ? r.score : null, rank: r ? r.rank : null };
    }).sort(function (a, b) { return b.launches - a.launches; });
  }

  function getWindows() { return WINDOWS.slice(); }
  function getMetrics() { return Object.assign({}, _metrics); }

  setInterval(_sample, SAMPLE_MS);
  G.addEventListener('arc14:heatmap-updated', function () { _sample(); });

  G.RuntimeCommandAnalytics = Object.freeze({
    getTrends:         getTrends,
    getGrowthRates:    getGrowthRates,
    getSamples:        getSamples,
    getToolUsageTrend: getToolUsageTrend,
    getWindows:        getWindows,
    getMetrics:        getMetrics,
    WINDOWS:           WINDOWS.slice(),
  });

}(typeof window !== 'undefined' ? window : this));

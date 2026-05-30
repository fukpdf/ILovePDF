(function (G) {
  'use strict';
  if (G.RuntimeToolSLA) return;

  var LOG = '[Arc13:SLA]';

  // Default SLA targets (ms / mb / score)
  var DEFAULTS = {
    startupMs:   { p50: 500,  p90: 1500,  p99: 3000  },
    executionMs: { p50: 2000, p90: 6000,  p99: 15000 },
    memoryMb:    { p50: 50,   p90: 150,   p99: 300   },
    thermal:     { p50: 30,   p90: 60,    p99: 80    },
  };

  var _slas       = {};   // toolId → { startupMs, executionMs, memoryMb, thermal } (override targets)
  var _violations = [];   // { toolId, metric, percentile, actual, target, ts }
  var _metrics    = { checked: 0, violated: 0, critical: 0 };
  var MAX_VIOL    = 200;
  var CHECK_MS    = 45 * 1000;   // check every 45s

  function _getSLA(toolId) {
    return _slas[toolId] || DEFAULTS;
  }

  function setSLA(toolId, sla) {
    _slas[toolId] = Object.assign({}, DEFAULTS, sla);
    console.debug(LOG, 'SLA configured:', toolId, _slas[toolId]);
  }

  function getSLA(toolId) {
    return Object.assign({}, _getSLA(toolId));
  }

  function _record(toolId, metric, percentile, actual, target) {
    var critical = actual > target * 2;
    _violations.push({ toolId: toolId, metric: metric, percentile: percentile,
      actual: actual, target: target, critical: critical, ts: Date.now() });
    if (_violations.length > MAX_VIOL) _violations.shift();
    _metrics.violated++;
    if (critical) _metrics.critical++;

    // Fire event
    try {
      G.dispatchEvent(new CustomEvent('arc13:sla-violated', {
        detail: { toolId: toolId, metric: metric, percentile: percentile,
                  actual: actual, target: target, critical: critical },
      }));
    } catch (_) {}

    // Raise incident for critical SLA breaches
    if (critical) {
      var ic = G.RuntimeIncidentCorrelation;
      if (ic && ic.raise) {
        try {
          ic.raise({ severity: 'P2', source: 'arc13:sla',
            message: toolId + ' SLA critical breach: ' + metric + ' p' + percentile + ' = ' + actual.toFixed(0) });
        } catch (_) {}
      }
      // Trigger circuit breaker on critical breach
      var cb = G.RuntimeToolCircuitBreaker;
      if (cb && cb.recordFailure) {
        try { cb.recordFailure(toolId, {}); } catch (_) {}
      }
    }
    console.warn(LOG, toolId, metric, 'p' + percentile, 'violated:', actual.toFixed(0), '>', target, critical ? '(CRITICAL)' : '');
  }

  // ── Check one tool ───────────────────────────────────────────────────────────
  function checkTool(toolId) {
    _metrics.checked++;
    var profiler = G.RuntimeToolProfiler;
    if (!profiler || !profiler.getProfile) return;
    var profile = profiler.getProfile(toolId);
    if (!profile) return;
    var sla = _getSLA(toolId);

    var checks = [
      { metric: 'startupMs',   data: profile.startupMs   },
      { metric: 'executionMs', data: profile.executionMs  },
      { metric: 'memoryMb',    data: profile.memoryMb     },
      { metric: 'thermal',     data: profile.thermal      },
    ];

    checks.forEach(function (c) {
      if (!c.data || !sla[c.metric]) return;
      var t = sla[c.metric];
      if (c.data.p50 != null && t.p50 != null && c.data.p50 > t.p50) _record(toolId, c.metric, 50, c.data.p50, t.p50);
      if (c.data.p90 != null && t.p90 != null && c.data.p90 > t.p90) _record(toolId, c.metric, 90, c.data.p90, t.p90);
      if (c.data.p99 != null && t.p99 != null && c.data.p99 > t.p99) _record(toolId, c.metric, 99, c.data.p99, t.p99);
    });
  }

  function checkAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg || !reg.getAllTools) return;
    reg.getAllTools().forEach(function (t) { checkTool(t.id); });
  }

  function getViolations(toolId) {
    if (toolId) return _violations.filter(function (v) { return v.toolId === toolId; });
    return _violations.slice();
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-check every 45s
  setTimeout(function _tick() {
    checkAll();
    setTimeout(_tick, CHECK_MS);
  }, CHECK_MS);

  G.RuntimeToolSLA = Object.freeze({
    setSLA:       setSLA,
    getSLA:       getSLA,
    checkTool:    checkTool,
    checkAll:     checkAll,
    getViolations: getViolations,
    getMetrics:   getMetrics,
    DEFAULTS:     Object.freeze(JSON.parse(JSON.stringify(DEFAULTS))),
  });

}(typeof window !== 'undefined' ? window : this));

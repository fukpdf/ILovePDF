// RuntimePolicyEngine v1.0 — Arc 15 / Phase A
// =============================================================================
// Enterprise policy engine: register, evaluate, and enforce runtime policies
// with severity tiers, priority ordering, and automatic action dispatch.
//
// Built-in policies:
//   sla-breach         — SLA violation detected (CRITICAL, priority 10)
//   memory-spike       — Heap usage > 85% (WARN, priority 8)
//   thermal-spike      — Thermal pressure > 90% (WARN, priority 7)
//   incident-escalation— Open incidents > 5 (CRITICAL, priority 9)
//   circuit-breaker    — Circuit breakers open (EMERGENCY, priority 10)
//
// Events dispatched:
//   arc15:policy-triggered  — { policyId, label, severity, action, ts, data }
//   arc15:policy-registered — { id, label }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimePolicyEngine) return;

  var LOG = '[Arc15:PolicyEngine]';

  var SEV_INFO      = 'INFO';
  var SEV_WARN      = 'WARN';
  var SEV_CRITICAL  = 'CRITICAL';
  var SEV_EMERGENCY = 'EMERGENCY';

  var _policies = {};
  var _seq      = 0;
  var _history  = [];  // last 200 trigger events
  var MAX_HIST  = 200;

  var _metrics = {
    evaluated: 0, triggered: 0, suppressed: 0, errors: 0,
    bySeverity: { INFO: 0, WARN: 0, CRITICAL: 0, EMERGENCY: 0 },
  };

  // Dedup window: suppress same policy re-trigger within this interval
  var DEDUP_MS = 30 * 1000;
  var _lastTrigger = {};  // policyId → ts

  function _dedup(id) {
    var last = _lastTrigger[id] || 0;
    if (Date.now() - last < DEDUP_MS) { _metrics.suppressed++; return true; }
    _lastTrigger[id] = Date.now();
    return false;
  }

  function _dispatch(evtName, detail) {
    try { G.dispatchEvent(new CustomEvent(evtName, { detail: detail })); } catch (_) {}
  }

  // ── Built-in policy conditions ─────────────────────────────────────────────
  var BUILTIN = [
    {
      id: 'sla-breach', label: 'SLA Breach Policy',
      severity: SEV_CRITICAL, priority: 10, enabled: true, action: 'escalate-incident',
      condition: function () {
        var sla = G.RuntimeToolSLA;
        if (!sla || !sla.getMetrics) return null;
        try {
          var m = sla.getMetrics();
          if (m && m.breaches > 0)
            return { message: 'SLA breach: ' + m.breaches + ' breach(es)', breaches: m.breaches };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'memory-spike', label: 'Memory Spike Policy',
      severity: SEV_WARN, priority: 8, enabled: true, action: 'run-recovery',
      condition: function () {
        try {
          if (!G.performance || !G.performance.memory) return null;
          var mem = G.performance.memory;
          var pct = (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100;
          if (pct > 85) return { message: 'Heap at ' + pct.toFixed(1) + '%', pct: pct };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'thermal-spike', label: 'Thermal Spike Policy',
      severity: SEV_WARN, priority: 7, enabled: true, action: 'pause-subsystem',
      condition: function () {
        var analy = G.RuntimeCommandAnalytics;
        if (!analy || !analy.getTrends) return null;
        try {
          var t = analy.getTrends('5m');
          if (t && t.thermal && t.thermal.avg > 90)
            return { message: 'Thermal pressure: ' + t.thermal.avg.toFixed(0) + '%', avg: t.thermal.avg };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'incident-escalation', label: 'Incident Escalation Policy',
      severity: SEV_CRITICAL, priority: 9, enabled: true, action: 'clear-alerts',
      condition: function () {
        var ic = G.RuntimeIncidentCenter;
        if (!ic || !ic.getMetrics) return null;
        try {
          var m = ic.getMetrics();
          if (m && m.open > 5) return { message: m.open + ' open incidents', open: m.open };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'circuit-breaker', label: 'Circuit Breaker Policy',
      severity: SEV_EMERGENCY, priority: 10, enabled: true, action: 'quarantine-subsystem',
      condition: function () {
        var cb = G.RuntimeToolCircuitBreaker;
        if (!cb || !cb.getMetrics) return null;
        try {
          var m = cb.getMetrics();
          if (m && m.open > 0) return { message: m.open + ' breaker(s) open', open: m.open };
        } catch (_) {}
        return null;
      },
    },
  ];

  BUILTIN.forEach(function (p) { p.builtIn = true; p.createdAt = Date.now(); _policies[p.id] = p; });

  // ── Public API ─────────────────────────────────────────────────────────────
  function registerPolicy(opts) {
    opts = opts || {};
    var id = opts.id || ('pol-' + (++_seq));
    if (_policies[id]) return id;
    _policies[id] = {
      id:        id,
      label:     opts.label     || id,
      severity:  opts.severity  || SEV_INFO,
      priority:  opts.priority  || 1,
      enabled:   opts.enabled !== false,
      condition: typeof opts.condition === 'function' ? opts.condition : function () { return null; },
      action:    opts.action    || 'log',
      builtIn:   false,
      createdAt: Date.now(),
    };
    _dispatch('arc15:policy-registered', { id: id, label: _policies[id].label });
    return id;
  }

  function removePolicy(id) {
    if (_policies[id] && !_policies[id].builtIn) { delete _policies[id]; return true; }
    return false;
  }

  function enablePolicy(id)  { if (_policies[id]) { _policies[id].enabled = true;  return true; } return false; }
  function disablePolicy(id) { if (_policies[id]) { _policies[id].enabled = false; return true; } return false; }

  function evaluate(id) {
    var pol = _policies[id];
    if (!pol || !pol.enabled) return null;
    _metrics.evaluated++;
    try {
      var data = pol.condition();
      if (!data) return null;
      if (_dedup(id)) return null;
      _metrics.triggered++;
      if (_metrics.bySeverity[pol.severity] != null) _metrics.bySeverity[pol.severity]++;
      var evt = {
        policyId: id, label: pol.label, severity: pol.severity,
        action: pol.action, ts: Date.now(), data: data,
      };
      _history.unshift(evt);
      if (_history.length > MAX_HIST) _history.pop();
      _dispatch('arc15:policy-triggered', evt);
      return evt;
    } catch (e) {
      _metrics.errors++;
      console.warn(LOG, 'policy error [' + id + ']:', e.message);
      return null;
    }
  }

  function evaluateAll() {
    var sorted = Object.values(_policies)
      .filter(function (p) { return p.enabled; })
      .sort(function (a, b) { return b.priority - a.priority; });
    var triggered = [];
    sorted.forEach(function (p) { var r = evaluate(p.id); if (r) triggered.push(r); });
    return triggered;
  }

  function getPolicies(filter) {
    var list = Object.values(_policies);
    if (filter && filter.enabled !== undefined) list = list.filter(function (p) { return p.enabled === filter.enabled; });
    if (filter && filter.severity)             list = list.filter(function (p) { return p.severity === filter.severity; });
    return list.sort(function (a, b) { return b.priority - a.priority; });
  }

  function getHistory(n) { return _history.slice(0, n || 50); }
  function getMetrics()  { return Object.assign({}, _metrics, { total: Object.keys(_policies).length }); }

  // Auto-evaluate every 2 minutes
  setInterval(function () { try { evaluateAll(); } catch (_) {} }, 2 * 60 * 1000);

  G.RuntimePolicyEngine = Object.freeze({
    registerPolicy: registerPolicy,
    removePolicy:   removePolicy,
    enablePolicy:   enablePolicy,
    disablePolicy:  disablePolicy,
    evaluate:       evaluate,
    evaluateAll:    evaluateAll,
    getPolicies:    getPolicies,
    getHistory:     getHistory,
    getMetrics:     getMetrics,
    SEV: Object.freeze({ INFO: SEV_INFO, WARN: SEV_WARN, CRITICAL: SEV_CRITICAL, EMERGENCY: SEV_EMERGENCY }),
  });

  console.debug(LOG, 'v1.0 ready — policies:', Object.keys(_policies).length);
}(window));

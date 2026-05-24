// RuntimeIncidentCenter v1.0 — Arc 8 / Phase F
// =====================================================================
// Unified incident registry for ALL runtime failure modes.
// Distinct from RuntimeIncidentEngine (Phase 7 — security anomaly
// classification) — this covers ALL operational runtime incidents.
//
// Severity levels:
//   P0 — Critical: platform unusable, data loss risk
//   P1 — High: tool family down, recovery required
//   P2 — Medium: degraded performance, partial failure
//   P3 — Low: warning-level anomaly, auto-recovered
//
// Incident categories:
//   memory-panic | worker-crash | event-leakage | mutation |
//   deploy-mismatch | hydration-failure | thermal-emergency |
//   offline-queue-overflow | trace-slow-path | control-plane-error
//
// Features:
//   - Deduplication: hash by (category + context) within 5-min window
//   - Escalation: P3→P2 after 5 occurrences; P2→P1 after 3; P1→P0 after 2
//   - Auto-recommendations: quarantine / recovery advice per category
//   - Timeline correlation with RuntimeEventTimeline
//   - window.getRuntimeIncidents()
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeIncidentCenter) return;

  var LOG     = '[IncidentCenter]';
  var VERSION = '1.0';

  // ── Severity ──────────────────────────────────────────────────────
  var P0 = 0, P1 = 1, P2 = 2, P3 = 3;
  var SEV_NAMES = ['P0-CRITICAL', 'P1-HIGH', 'P2-MEDIUM', 'P3-LOW'];

  // ── Escalation thresholds ─────────────────────────────────────────
  var ESCALATE_COUNTS = { 3: 5, 2: 3, 1: 2 };  // sev → count-before-escalate
  var DEDUP_WINDOW_MS = 5 * 60 * 1000;  // 5 min

  // ── Recommendations ───────────────────────────────────────────────
  var RECOMMENDATIONS = {
    'memory-panic':         'Reduce active processor count; trigger extreme-mode ULTRA_LOW_MEMORY.',
    'worker-crash':         'Isolate crashed family; use RuntimeProcessorWorkers.setThermalLimit().',
    'event-leakage':        'Audit event listener registration in tool activation path.',
    'mutation':             'Check runtime immutability guard; review recent flag changes.',
    'deploy-mismatch':      'Force page reload or clear service worker cache.',
    'hydration-failure':    'Retry with RuntimeStreamingHydration.flush(); check P0 modules.',
    'thermal-emergency':    'Trigger THERMAL_EMERGENCY extreme mode; reduce worker concurrency.',
    'offline-queue-overflow': 'Clear offline queue; check network recovery path.',
    'trace-slow-path':      'Profile with RuntimePerformanceProfiler; check long-task attribution.',
    'control-plane-error':  'Review command audit trail via RuntimeControlPlane.getAudit().',
  };

  // ── Storage ───────────────────────────────────────────────────────
  var _incidents = {};  // key → incident record
  var _list      = [];  // ordered list (reference into _incidents)
  var MAX_LIST   = 500;
  var _metrics   = { total: 0, escalations: 0, deduplications: 0, P0: 0, P1: 0, P2: 0, P3: 0 };

  function _hash(category, context) {
    return category + ':' + (context || '');
  }

  // ── Record an incident ────────────────────────────────────────────
  function record(category, severity, context, data) {
    severity = Math.max(P0, Math.min(P3, severity || P3));
    var key  = _hash(category, context);
    var now  = Date.now();

    // Deduplication: reuse if same category+context within window
    var existing = _incidents[key];
    if (existing && (now - existing.lastTs) < DEDUP_WINDOW_MS) {
      existing.count++;
      existing.lastTs = now;
      existing.data   = data || existing.data;
      _metrics.deduplications++;

      // Escalation check
      var threshold = ESCALATE_COUNTS[existing.severity];
      if (threshold && existing.count >= threshold && existing.severity > P0) {
        existing.severity--;
        existing.escalated = true;
        _metrics.escalations++;
        _metrics[SEV_NAMES[existing.severity].split('-')[0]]++;
        _tel('escalated', { key: key, sev: SEV_NAMES[existing.severity], count: existing.count });
        console.warn(LOG, 'ESCALATED:', key, '→', SEV_NAMES[existing.severity]);
        try {
          G.dispatchEvent(new CustomEvent('arc8:incident', {
            detail: { key: key, category: category, severity: existing.severity, escalated: true },
          }));
        } catch (_) {}
      }
      return existing.id;
    }

    // New incident
    var id = 'inc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
    var inc = {
      id:          id,
      category:    category,
      severity:    severity,
      context:     context  || null,
      data:        data     || null,
      firstTs:     now,
      lastTs:      now,
      count:       1,
      escalated:   false,
      resolved:    false,
      recommendation: RECOMMENDATIONS[category] || 'Inspect runtime telemetry for context.',
    };

    _incidents[key] = inc;
    _list.push(inc);
    if (_list.length > MAX_LIST) { var old = _list.shift(); delete _incidents[_hash(old.category, old.context)]; }

    _metrics.total++;
    var sevKey = SEV_NAMES[severity].split('-')[0];
    _metrics[sevKey] = (_metrics[sevKey] || 0) + 1;
    _tel('record', { id: id, category: category, sev: SEV_NAMES[severity] });

    if (severity <= P1) {
      console.warn(LOG, SEV_NAMES[severity] + ':', category, context || '');
    } else {
      console.debug(LOG, SEV_NAMES[severity] + ':', category, context || '');
    }

    try {
      G.dispatchEvent(new CustomEvent('arc8:incident', {
        detail: { id: id, category: category, severity: severity, context: context },
      }));
    } catch (_) {}

    return id;
  }

  function resolve(id) {
    var inc = Object.keys(_incidents).map(function (k) { return _incidents[k]; })
              .find(function (i) { return i.id === id; });
    if (inc) { inc.resolved = true; }
  }

  // ── Telemetry ─────────────────────────────────────────────────────
  var _tel_buf = [];
  function _tel(ev, d) {
    _tel_buf.push({ ts: Date.now(), ev: ev, d: d });
    if (_tel_buf.length > 100) _tel_buf.shift();
  }

  // ── Auto-capture from runtime events ──────────────────────────────
  G.addEventListener('processor-memory:panic', function (evt) {
    try {
      var d = evt && evt.detail;
      record('memory-panic', P1, d && d.family, d);
    } catch (_) {}
  });

  G.addEventListener('processor-workers:isolated', function (evt) {
    try {
      var d = evt && evt.detail;
      record('worker-crash', P1, d && d.family, d);
    } catch (_) {}
  });

  G.addEventListener('extreme-mode:activate', function (evt) {
    try {
      var d = evt && evt.detail;
      var sev = d && d.mode === 'THERMAL_EMERGENCY' ? P1 : P2;
      record('thermal-emergency', sev, d && d.mode, d);
    } catch (_) {}
  });

  G.addEventListener('memory-firewall:budget-exceeded', function (evt) {
    try {
      var d = evt && evt.detail;
      record('memory-panic', P2, d && d.toolId, d);
    } catch (_) {}
  });

  G.addEventListener('deploy:sync-ready', function (evt) {
    try {
      var d = evt && evt.detail;
      // Only flag if buildId mismatch (deploy sync fires on new deploy)
      if (d && d.mismatch) record('deploy-mismatch', P2, d.buildId, d);
    } catch (_) {}
  });

  G.addEventListener('profiler:longtask', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.ms > 500) record('trace-slow-path', P3, d.attr, d);
    } catch (_) {}
  });

  G.addEventListener('arc8:command', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.result && d.result.ok === false) {
        record('control-plane-error', P3, d.cmd, d);
      }
    } catch (_) {}
  });

  // ── Query ─────────────────────────────────────────────────────────
  function query(opts) {
    opts = opts || {};
    var result = _list.filter(function (i) { return !i.resolved; });
    if (opts.severity !== undefined) result = result.filter(function (i) { return i.severity <= opts.severity; });
    if (opts.category) result = result.filter(function (i) { return i.category === opts.category; });
    if (opts.since)    result = result.filter(function (i) { return i.lastTs >= opts.since; });
    if (opts.limit)    result = result.slice(-opts.limit);
    return result;
  }

  G.getRuntimeIncidents = function (opts) { return query(opts || {}); };

  G.RuntimeIncidentCenter = Object.freeze({
    VERSION:  VERSION,
    P0: P0, P1: P1, P2: P2, P3: P3,
    record:   record,
    resolve:  resolve,
    query:    query,
    getMetrics: function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _tel_buf.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — incident registry active | window.getRuntimeIncidents()');

}(window));

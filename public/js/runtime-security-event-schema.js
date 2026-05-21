// RuntimeSecurityEventSchema v1.0 — Phase 5 / Task 8 (Security Event Dashboard Prep)
// =============================================================================
// Normalized security event schema, severity classification, anomaly scoring,
// event aggregation, and structured event routing.
//
// This module is the BACKEND for the security event dashboard.
// It does NOT render a UI. It:
//   • Defines a canonical event schema (type, severity, source, metadata)
//   • Classifies incoming SecurityTelemetry events by severity
//   • Maintains rolling aggregation windows (1min, 5min, 1hr)
//   • Computes anomaly score based on event rate + type mix
//   • Aggregates deployment events, worker health, and runtime incidents
//   • Exposes structured data for any future dashboard UI
//
// Severity levels:
//   CRITICAL (4) — active exploit / confirmed tamper / data breach risk
//   HIGH (3)     — security control bypassed / seal failure / SRI mismatch
//   MEDIUM (2)   — suspicious activity / rate limit / foreign origin
//   LOW (1)      — informational security signal / minor deviation
//   INFO (0)     — normal operational event
//
// window.RuntimeSecurityEventSchema
//   .classify(event)              → { severity, sevScore, category, display }
//   .record(rawEvent)             → NormalizedEvent
//   .getAggregation(window)       → AggregationReport (window: '1m'|'5m'|'1h')
//   .getAnomalyScore()            → { score, level, reasons }
//   .getDeploymentSummary()       → DeploymentEventSummary
//   .getWorkerHealthSummary()     → WorkerHealthSummary
//   .getIncidentTimeline(limit)   → NormalizedEvent[]
//   .status()                     → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecurityEventSchema) return;

  var VERSION = '1.0';
  var LOG     = '[SecSchema]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Severity schema ────────────────────────────────────────────────────────
  var SEV = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
  var SEV_NAMES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  // ── Event type → severity mapping ──────────────────────────────────────────
  var EVENT_SEVERITY = {
    // CRITICAL — confirmed tamper / exploit
    'integrity-failure':    { sev: 'CRITICAL', category: 'sri',        display: 'File integrity failure' },
    'seal-failure':         { sev: 'CRITICAL', category: 'deploy',     display: 'Deployment seal failure' },
    'proto-pollution':      { sev: 'CRITICAL', category: 'exploit',    display: 'Prototype pollution detected' },
    'panic-activated':      { sev: 'CRITICAL', category: 'runtime',    display: 'Runtime panic activated' },

    // HIGH — security control failure
    'sri-mismatch':         { sev: 'HIGH',     category: 'sri',        display: 'SRI hash mismatch' },
    'worker-blocked':       { sev: 'HIGH',     category: 'worker',     display: 'Unauthorized worker blocked' },
    'deploy-mismatch':      { sev: 'HIGH',     category: 'deploy',     display: 'Deployment fingerprint mismatch' },
    'nonce-violation':      { sev: 'HIGH',     category: 'csp',        display: 'CSP nonce violation' },
    'foreign-degrade':      { sev: 'HIGH',     category: 'deploy',     display: 'Foreign deployment degradation' },

    // MEDIUM — suspicious activity
    'origin-violation':     { sev: 'MEDIUM',   category: 'network',    display: 'Cross-origin violation' },
    'replay-attempt':       { sev: 'MEDIUM',   category: 'auth',       display: 'Replay attack attempt' },
    'devtools-degraded':    { sev: 'MEDIUM',   category: 'tamper',     display: 'DevTools degradation active' },
    'runtime-drift':        { sev: 'MEDIUM',   category: 'runtime',    display: 'Runtime state drift detected' },

    // LOW — informational security signals
    'worker-restart':       { sev: 'LOW',      category: 'worker',     display: 'Worker restart event' },
    'blob-leak':            { sev: 'LOW',      category: 'resource',   display: 'Blob URL leak auto-revoked' },
    'tier-change':          { sev: 'LOW',      category: 'security',   display: 'Security tier changed' },
    'wasm-event':           { sev: 'LOW',      category: 'wasm',       display: 'WASM lifecycle event' },

    // INFO — operational
    'perf-pressure':        { sev: 'INFO',     category: 'perf',       display: 'Memory pressure event' },
    'panic-recovered':      { sev: 'INFO',     category: 'runtime',    display: 'Runtime panic recovered' },
    'ok':                   { sev: 'INFO',     category: 'runtime',    display: 'System OK signal' },
  };

  // ── Normalize / classify an event ──────────────────────────────────────────
  function classify(event) {
    var type = (event && event.type) || 'unknown';
    var schema = EVENT_SEVERITY[type];
    if (!schema) {
      schema = { sev: 'INFO', category: 'unknown', display: 'Unknown event: ' + type };
    }
    return {
      severity: schema.sev,
      sevScore: SEV[schema.sev] || 0,
      category: schema.category,
      display:  schema.display,
    };
  }

  // ── Normalized event store ─────────────────────────────────────────────────
  var _events = [];
  var MAX_EVENTS = 2000;

  function record(rawEvent) {
    if (!rawEvent) return null;

    var cls = classify(rawEvent);
    var normalized = {
      id:         _events.length,
      type:       (rawEvent.type || 'unknown'),
      severity:   cls.severity,
      sevScore:   cls.sevScore,
      category:   cls.category,
      display:    cls.display,
      ts:         rawEvent.ts || Date.now(),
      data:       _sanitizeData(rawEvent),
      source:     rawEvent.source || 'browser',
    };

    if (_events.length >= MAX_EVENTS) _events.shift();
    _events.push(normalized);

    // Trigger anomaly recalculation periodically
    _stats.eventCount++;
    if (_stats.eventCount % 10 === 0) {
      _updateAnomalyScore();
    }

    return normalized;
  }

  function _sanitizeData(ev) {
    var safe = {};
    var SAFE_KEYS = ['path', 'reason', 'tier', 'score', 'workerId', 'chunkId',
                     'count', 'retries', 'memMB', 'heapMB', 'blocked', 'ok',
                     'event', 'version', 'variant', 'byteLength'];
    for (var k of SAFE_KEYS) {
      if (k in ev && ev[k] !== undefined && ev[k] !== null) {
        safe[k] = typeof ev[k] === 'string' ? ev[k].slice(0, 100) : ev[k];
      }
    }
    return safe;
  }

  // ── Rolling aggregation windows ────────────────────────────────────────────
  var WINDOWS = { '1m': 60000, '5m': 300000, '1h': 3600000 };

  function getAggregation(windowKey) {
    var windowMs = WINDOWS[windowKey] || WINDOWS['5m'];
    var cutoff   = Date.now() - windowMs;
    var windowed = _events.filter(function (e) { return e.ts >= cutoff; });

    var bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    var byType  = {};
    var byCategory = {};

    for (var e of windowed) {
      bySev[e.severity] = (bySev[e.severity] || 0) + 1;
      byType[e.type]     = (byType[e.type]     || 0) + 1;
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    }

    var rate = windowMs > 0 ? Math.round(windowed.length / (windowMs / 60000) * 10) / 10 : 0;

    return {
      window:     windowKey,
      windowMs:   windowMs,
      count:      windowed.length,
      eventsPerMin: rate,
      bySeverity: bySev,
      byType:     byType,
      byCategory: byCategory,
      topEvents:  windowed.slice(-10).reverse(),
    };
  }

  // ── Anomaly scoring ─────────────────────────────────────────────────────────
  var _anomalyScore = 0;
  var _anomalyLevel = 'NORMAL';
  var _anomalyReasons = [];

  function _updateAnomalyScore() {
    var agg1m  = getAggregation('1m');
    var agg5m  = getAggregation('5m');
    var reasons = [];
    var score   = 0;

    // Rate spike
    if (agg1m.eventsPerMin > 20) {
      score += 30;
      reasons.push('High event rate: ' + agg1m.eventsPerMin + '/min');
    } else if (agg1m.eventsPerMin > 10) {
      score += 15;
      reasons.push('Elevated event rate: ' + agg1m.eventsPerMin + '/min');
    }

    // Critical events
    if (agg5m.bySeverity.CRITICAL > 0) {
      score += 40 * agg5m.bySeverity.CRITICAL;
      reasons.push(agg5m.bySeverity.CRITICAL + ' CRITICAL event(s) in 5min');
    }

    // High events
    if (agg5m.bySeverity.HIGH > 2) {
      score += 15;
      reasons.push(agg5m.bySeverity.HIGH + ' HIGH events in 5min');
    }

    // Specific high-risk combos
    if (agg5m.byType['integrity-failure'] > 0 && agg5m.byType['seal-failure'] > 0) {
      score += 25;
      reasons.push('Simultaneous SRI + seal failures — coordinated attack pattern');
    }
    if (agg5m.byType['origin-violation'] > 5) {
      score += 20;
      reasons.push('Multiple origin violations — possible reconnaissance');
    }

    _anomalyScore   = Math.min(100, score);
    _anomalyReasons = reasons;
    _anomalyLevel   = score >= 70 ? 'CRITICAL' : score >= 40 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'NORMAL';

    if (score >= 40) {
      console.warn(LOG, 'anomaly score:', score, '| level:', _anomalyLevel, '| reasons:', reasons.join('; '));
      _s(function () {
        if (G.RuntimeEventBus) {
          G.RuntimeEventBus.emit('security:anomaly', {
            score:   _anomalyScore,
            level:   _anomalyLevel,
            reasons: _anomalyReasons,
          });
        }
      });
    }
  }

  function getAnomalyScore() {
    _updateAnomalyScore();
    return {
      score:   _anomalyScore,
      level:   _anomalyLevel,
      reasons: _anomalyReasons.slice(),
    };
  }

  // ── Deployment event aggregation ───────────────────────────────────────────
  function getDeploymentSummary() {
    var DEPLOY_TYPES = ['seal-failure', 'deploy-mismatch', 'foreign-degrade', 'nonce-violation'];
    var recent = _events.filter(function (e) {
      return DEPLOY_TYPES.includes(e.type);
    }).slice(-50);

    var sealStatus = _s(function () {
      var ds = G.RuntimeDeploySeal;
      return ds && typeof ds.status === 'function' ? ds.status() : null;
    }, null);

    return {
      totalDeployEvents: recent.length,
      sealStatus:        sealStatus,
      recentEvents:      recent.slice(-10),
      byType:            _countBy(recent, 'type'),
    };
  }

  // ── Worker health aggregation ──────────────────────────────────────────────
  function getWorkerHealthSummary() {
    var WORKER_TYPES = ['worker-blocked', 'worker-restart', 'wasm-event'];
    var recent = _events.filter(function (e) {
      return WORKER_TYPES.includes(e.type);
    }).slice(-100);

    var hbStatus = _s(function () {
      var hb = G.RuntimeP4Heartbeat;
      return hb && typeof hb.status === 'function' ? hb.status() : null;
    }, null);

    return {
      totalWorkerEvents: recent.length,
      heartbeatStatus:   hbStatus,
      blockedWorkers:    recent.filter(function (e) { return e.type === 'worker-blocked'; }).length,
      restarts:          recent.filter(function (e) { return e.type === 'worker-restart'; }).length,
      recentEvents:      recent.slice(-10),
    };
  }

  // ── Incident timeline ──────────────────────────────────────────────────────
  function getIncidentTimeline(limit) {
    limit = limit || 50;
    return _events
      .filter(function (e) { return e.sevScore >= SEV.MEDIUM; })
      .slice(-limit)
      .reverse();
  }

  // ── Helper ─────────────────────────────────────────────────────────────────
  function _countBy(arr, key) {
    var counts = {};
    for (var item of arr) {
      var v = item[key];
      if (v) counts[v] = (counts[v] || 0) + 1;
    }
    return counts;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  var _stats = { eventCount: 0, subscribedAt: null };

  // ── Subscribe to SecurityTelemetry ─────────────────────────────────────────
  function _subscribe() {
    // Listen via RuntimeEventBus for security events forwarded by other systems
    _s(function () {
      var bus = G.RuntimeEventBus;
      if (!bus || typeof bus.on !== 'function') return;

      var TRACKED = [
        'seal:failure', 'seal:failure',
        'sri:mismatch', 'sri:quarantine',
        'worker:blocked',
        'security:anomaly',
        'perf:memory-pressure',
      ];

      TRACKED.forEach(function (evt) {
        bus.on(evt, function (data) {
          record(Object.assign({ type: evt.replace(':', '-'), source: 'bus' }, data || {}));
        });
      });

      _stats.subscribedAt = Date.now();
      console.debug(LOG, 'subscribed to RuntimeEventBus events');
    });

    // Also tap SecurityTelemetry if available
    _s(function () {
      var st = G.SecurityTelemetry;
      if (!st) return;
      // Wrap record method to intercept all events
      var _orig = st.record;
      if (typeof _orig !== 'function') return;
      // Can't mutate frozen object — use a proxy check via bus or telemetry pipeline
      console.debug(LOG, 'SecurityTelemetry detected — using bus subscription for events');
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _subscribe();
    _updateAnomalyScore();
    console.info(LOG, 'v' + VERSION + ' ready | event store cap:', MAX_EVENTS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1500); }, { once: true });
  } else {
    setTimeout(_boot, 1500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeSecurityEventSchema = Object.freeze({
    VERSION:              VERSION,
    SEV:                  SEV,
    SEV_NAMES:            SEV_NAMES,
    EVENT_SEVERITY:       EVENT_SEVERITY,
    classify:             classify,
    record:               record,
    getAggregation:       getAggregation,
    getAnomalyScore:      getAnomalyScore,
    getDeploymentSummary: getDeploymentSummary,
    getWorkerHealthSummary: getWorkerHealthSummary,
    getIncidentTimeline:  getIncidentTimeline,
    status: function () {
      var bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
      _events.forEach(function (e) { bySev[e.severity] = (bySev[e.severity] || 0) + 1; });
      return {
        stored:       _events.length,
        maxStore:     MAX_EVENTS,
        bySeverity:   bySev,
        anomaly:      getAnomalyScore(),
        eventCount:   _stats.eventCount,
        subscribedAt: _stats.subscribedAt,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));

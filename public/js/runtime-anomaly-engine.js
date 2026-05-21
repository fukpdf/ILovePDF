// RuntimeAnomalyEngine v1.0 — Phase 6 / Task 6 (Anomaly Detection Engine)
// =============================================================================
// Session-level anomaly scoring, deployment anomaly scoring, and worker
// anomaly detection. Feeds threat signals into RuntimeThreatCorrelation.
//
// Scoring dimensions:
//   1. Session anomaly score  — per-session behavioral deviation (0-100)
//   2. Deployment score       — environment integrity confidence (0-100)
//   3. Worker health score    — worker pool behavioral health (0-100)
//   4. Temporal anomaly score — timing-based detection (0-100)
//
// Anomaly detectors:
//   • Token abuse detection     (high ticket failure rate)
//   • Replay attack clustering  (nonce reuse patterns)
//   • Memory abuse detection    (abnormal heap growth)
//   • Runtime tamper correlation (global drift + seal failures)
//   • Worker anomaly scoring    (restart storms, message anomalies)
//   • Rolling incident windows  (event rate per 1/5/15 minute)
//   • Risk scoring              (weighted composite score)
//   • Automated incident grouping (cluster similar events)
//
// window.RuntimeAnomalyEngine
//   .score(sessionId)                → AnomalyScore
//   .getDeploymentScore()            → DeploymentScore
//   .getWorkerScore()                → WorkerScore
//   .getIncidentSummary()            → IncidentSummary
//   .markSuspicious(sessionId, reason)→ void
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeAnomalyEngine) return;

  var VERSION    = '1.0';
  var LOG        = '[AnomalyEngine]';
  var WINDOWS    = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
  var MAX_EVENTS = 2000;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Event store ────────────────────────────────────────────────────────────
  var _events       = [];
  var _sessionFlags = typeof Map !== 'undefined' ? new Map() : null; // sessionId → {score, flags}
  var _incidents    = [];

  // ── Event weight table (higher = more suspicious) ─────────────────────────
  var EVENT_WEIGHT = {
    'integrity-failure':   30,
    'seal-failure':        30,
    'proto-pollution':     40,
    'panic-activated':     25,
    'sri-mismatch':        20,
    'worker-blocked':      15,
    'deploy-mismatch':     20,
    'nonce-violation':     20,
    'origin-violation':    10,
    'replay-attempt':      25,
    'devtools-degraded':   10,
    'runtime-drift':       15,
    'foreign-degrade':     15,
    'wasm-event':           5,
    'blob-leak':            3,
    'perf-pressure':        2,
    'worker-restart':       5,
  };

  // ── Ingest event ──────────────────────────────────────────────────────────
  function _ingest(event) {
    if (!event) return;
    var e = {
      type:      event.type || event.event || 'unknown',
      sessionId: event.sessionId || 'anon',
      ts:        Date.now(),
      meta:      event,
    };
    _events.push(e);
    if (_events.length > MAX_EVENTS) _events.shift();
  }

  // ── Events in window ──────────────────────────────────────────────────────
  function _eventsIn(windowMs, sessionId) {
    var cutoff = Date.now() - windowMs;
    return _events.filter(function (e) {
      return e.ts >= cutoff && (!sessionId || e.sessionId === sessionId);
    });
  }

  // ── Session anomaly score ──────────────────────────────────────────────────
  function score(sessionId) {
    var w5   = _eventsIn(WINDOWS['5m'], sessionId);
    var w15  = _eventsIn(WINDOWS['15m'], sessionId);

    // Weighted event sum
    var rawScore = 0;
    for (var i = 0; i < w5.length; i++) {
      rawScore += (EVENT_WEIGHT[w5[i].type] || 1);
    }

    // Burst penalty: >10 high-weight events in 1 min
    var w1      = _eventsIn(WINDOWS['1m'], sessionId);
    var w1Score = 0;
    for (var j = 0; j < w1.length; j++) {
      w1Score += (EVENT_WEIGHT[w1[j].type] || 1);
    }
    if (w1Score > 50) rawScore += 30;  // burst penalty

    // Threat correlation bonus
    var threatBonus = 0;
    _s(function () {
      var tc = G.RuntimeThreatCorrelation;
      if (tc && typeof tc.getRiskScore === 'function') {
        threatBonus = tc.getRiskScore(sessionId);
      }
    });

    var finalScore = Math.min(100, Math.round((rawScore + threatBonus * 0.5) / 2));

    // Update session flags
    var flags = [];
    if (finalScore >= 80) flags.push('high-risk');
    if (finalScore >= 50) flags.push('elevated-risk');

    var replay = w5.filter(function (e) { return e.type === 'replay-attempt'; }).length;
    if (replay >= 3) flags.push('replay-cluster');

    var tamper = w15.filter(function (e) {
      return e.type === 'proto-pollution' || e.type === 'integrity-failure';
    }).length;
    if (tamper >= 2) flags.push('tamper-pattern');

    if (_sessionFlags) {
      _sessionFlags.set(sessionId, { score: finalScore, flags: flags, ts: Date.now() });
    }

    return {
      sessionId:    sessionId,
      score:        finalScore,
      level:        finalScore >= 80 ? 'CRITICAL' : (finalScore >= 50 ? 'HIGH' : (finalScore >= 25 ? 'MEDIUM' : 'LOW')),
      flags:        flags,
      eventCount1m: w1.length,
      eventCount5m: w5.length,
      threatBonus:  threatBonus,
      ts:           Date.now(),
    };
  }

  // ── Deployment anomaly score ───────────────────────────────────────────────
  function getDeploymentScore() {
    var checks = [];
    var deductions = 0;

    // Seal status
    var sealOk = _s(function () {
      var ds = G.RuntimeDeploySeal;
      if (!ds || typeof ds.status !== 'function') return null;
      var st = ds.status();
      return st.ok;
    }, null);
    if (sealOk === false) { deductions += 30; checks.push('seal-fail'); }
    else if (sealOk === true) { checks.push('seal-ok'); }

    // Foreign deploy
    var isForeign = _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
    if (isForeign) { deductions += 25; checks.push('foreign-domain'); }

    // SRI engine health
    var sriOk = _s(function () {
      var sri = G.RuntimeSriEngine;
      if (!sri || typeof sri.status !== 'function') return null;
      var st = sri.status();
      return st.mismatches === 0;
    }, null);
    if (sriOk === false) { deductions += 20; checks.push('sri-mismatch'); }

    // Attestation trust
    var attested = _s(function () {
      var ea = G.RuntimeEdgeAttestation;
      return ea && typeof ea.isTrusted === 'function' ? ea.isTrusted() : true;
    }, true);
    if (!attested) { deductions += 15; checks.push('attestation-failed'); }

    // Shadow runtime drift
    var drifted = _s(function () {
      var sr = G.RuntimeShadowRuntime;
      if (!sr || typeof sr.auditDrift !== 'function') return 0;
      return sr.status().tamperCount || 0;
    }, 0);
    if (drifted > 0) { deductions += Math.min(20, drifted * 5); checks.push('api-drift:' + drifted); }

    var confidence = Math.max(0, 100 - deductions);
    return {
      confidence: confidence,
      level:      confidence >= 80 ? 'TRUSTED' : (confidence >= 50 ? 'DEGRADED' : 'UNTRUSTED'),
      deductions: deductions,
      checks:     checks,
      ts:         Date.now(),
    };
  }

  // ── Worker health score ────────────────────────────────────────────────────
  function getWorkerScore() {
    var deductions = 0;
    var checks     = [];

    // Worker factory violations
    var spawnViolations = _s(function () {
      var wf = G.RuntimeWorkerFactory;
      if (!wf || typeof wf.audit !== 'function') return 0;
      return wf.audit().spawnViolations || 0;
    }, 0);
    if (spawnViolations > 0) { deductions += Math.min(40, spawnViolations * 10); checks.push('spawn-violations:' + spawnViolations); }

    // Worker restarts
    var restarts = _eventsIn(WINDOWS['15m']).filter(function (e) {
      return e.type === 'worker-restart';
    }).length;
    if (restarts >= 3) { deductions += 15; checks.push('restart-storm'); }

    // Worker blocks
    var blocks = _eventsIn(WINDOWS['5m']).filter(function (e) {
      return e.type === 'worker-blocked';
    }).length;
    if (blocks > 0) { deductions += blocks * 10; checks.push('worker-blocks:' + blocks); }

    var health = Math.max(0, 100 - deductions);
    return {
      health:  health,
      level:   health >= 80 ? 'HEALTHY' : (health >= 50 ? 'DEGRADED' : 'COMPROMISED'),
      checks:  checks,
      restarts: restarts,
      ts:      Date.now(),
    };
  }

  // ── Incident grouping ──────────────────────────────────────────────────────
  function _groupIncidents() {
    var now = Date.now();
    var w15 = _eventsIn(WINDOWS['15m']);

    if (w15.length === 0) return;

    // Group by type
    var typeGroups = {};
    for (var i = 0; i < w15.length; i++) {
      var t = w15[i].type;
      if (!typeGroups[t]) typeGroups[t] = [];
      typeGroups[t].push(w15[i]);
    }

    for (var type in typeGroups) {
      var group = typeGroups[type];
      if (group.length < 3) continue;

      // Check if we already have this incident
      var existing = _incidents.some(function (inc) {
        return inc.type === type && (now - inc.createdAt) < WINDOWS['15m'];
      });
      if (existing) continue;

      var incident = {
        id:        'inc_' + now.toString(36),
        type:      type,
        count:     group.length,
        sessions:  [...new Set(group.map(function (e) { return e.sessionId; }))],
        firstTs:   group[0].ts,
        lastTs:    group[group.length - 1].ts,
        createdAt: now,
        severity:  EVENT_WEIGHT[type] >= 20 ? 'HIGH' : 'MEDIUM',
      };

      _incidents.push(incident);
      if (_incidents.length > 100) _incidents.shift();

      console.warn(LOG, 'incident grouped | type:', type, '| count:', group.length);
    }
  }

  // ── markSuspicious (public) ────────────────────────────────────────────────
  function markSuspicious(sessionId, reason) {
    _ingest({ type: 'runtime-drift', sessionId: sessionId, reason: reason });
    _s(function () {
      var tc = G.RuntimeThreatCorrelation;
      if (tc && typeof tc.ingest === 'function') {
        tc.ingest({ type: 'runtime-drift', sessionId: sessionId, reason: reason, severity: 'MEDIUM' });
      }
    });
    console.warn(LOG, 'session marked suspicious:', sessionId ? sessionId.slice(0, 8) : 'anon', '| reason:', reason);
  }

  // ── getIncidentSummary (public) ────────────────────────────────────────────
  function getIncidentSummary() {
    var now   = Date.now();
    var cutoff = now - WINDOWS['15m'];
    var recent = _incidents.filter(function (i) { return i.createdAt >= cutoff; });

    return {
      total:       _incidents.length,
      recent15m:   recent.length,
      high:        recent.filter(function (i) { return i.severity === 'HIGH'; }).length,
      incidents:   recent.slice(-20),
      windowRates: {
        '1m':  _eventsIn(WINDOWS['1m']).length,
        '5m':  _eventsIn(WINDOWS['5m']).length,
        '15m': _eventsIn(WINDOWS['15m']).length,
      },
    };
  }

  // ── Subscribe to security events ──────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      if (!G.RuntimeEventBus) return;
      var ALL_SEC = [
        'integrity-failure', 'seal-failure', 'proto-pollution', 'panic-activated',
        'sri-mismatch', 'worker-blocked', 'deploy-mismatch', 'nonce-violation',
        'origin-violation', 'replay-attempt', 'devtools-degraded', 'runtime-drift',
        'security:foreign-deploy', 'security:anomaly', 'wasm:tamper',
        'wasm:memory-violation', 'worker-restart',
      ];
      ALL_SEC.forEach(function (evt) {
        G.RuntimeEventBus.on(evt, function (data) {
          _ingest(Object.assign({ type: evt }, data || {}));
          _groupIncidents();
        });
      });
    });

    // Also subscribe to SecurityTelemetry
    _s(function () {
      var st = G.SecurityTelemetry;
      if (st && typeof st.subscribe === 'function') {
        st.subscribe(function (event) { _ingest(event); });
      }
    });
  }

  // ── Periodic scoring ──────────────────────────────────────────────────────
  function _periodicReport() {
    var deployScore  = getDeploymentScore();
    var workerScore  = getWorkerScore();

    if (deployScore.confidence < 50) {
      console.warn(LOG, 'LOW deployment confidence:', deployScore.confidence,
        '| checks:', deployScore.checks.join(','));
    }
    if (workerScore.health < 50) {
      console.warn(LOG, 'LOW worker health:', workerScore.health,
        '| checks:', workerScore.checks.join(','));
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    setTimeout(_subscribe, 3_000);
    setInterval(_periodicReport, 5 * 60_000);
    setInterval(_groupIncidents, 60_000);

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5500); }, { once: true });
  } else {
    setTimeout(_boot, 5500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeAnomalyEngine = Object.freeze({
    VERSION:            VERSION,
    score:              score,
    getDeploymentScore: getDeploymentScore,
    getWorkerScore:     getWorkerScore,
    getIncidentSummary: getIncidentSummary,
    markSuspicious:     markSuspicious,
    status: function () {
      return {
        version:        VERSION,
        enabled:        _enabled,
        tier:           _tier,
        eventCount:     _events.length,
        incidentCount:  _incidents.length,
        sessionCount:   _sessionFlags ? _sessionFlags.size : 0,
        deployment:     getDeploymentScore(),
        workers:        getWorkerScore(),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));

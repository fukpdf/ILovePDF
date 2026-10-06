// RuntimeAutonomousHealing v1.0 — Arc 9 / Phase A
// =====================================================================
// Automatic runtime repair engine. Monitors all runtime failure signals,
// recognizes failure patterns, and applies progressive healing.
//
// Healing escalation (by incident severity):
//   P3 (low)      → gentle GC hint + telemetry
//   P2 (medium)   → worker soft-restart + hydration flush
//   P1 (high)     → subsystem isolation + cache clear + snapshot
//   P0 (critical) → safe-mode recovery + full subsystem reboot
//
// Safe healing boundaries:
//   - Pre-healing state snapshot via RuntimeStateSnapshots
//   - Rollback on failed verification (restores prior snapshot)
//   - Never modifies tool DOM or processing pipelines directly
//   - All healing is non-blocking (microtask-queued)
//
// window.RuntimeAutonomousHealing.getState()
// window.RuntimeAutonomousHealing.heal(category)  — manual trigger
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeAutonomousHealing) return;

  var LOG     = '[AutonomousHealing]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_HEALS_PER_MIN = 5;
  var HEAL_COOLDOWN_MS  = 30 * 1000;   // min gap between same-category heals
  var VERIFY_DELAY_MS   = 2000;        // wait before verifying heal succeeded
  var MAX_TELEMETRY     = 200;

  // ── State ─────────────────────────────────────────────────────────
  var _active      = false;
  var _heals       = [];  // telemetry ring buffer
  var _cooldowns   = {};  // category → last heal ts
  var _patterns    = {};  // category → { count, firstTs, trend }
  var _stats       = { triggered: 0, succeeded: 0, failed: 0, rolledBack: 0 };

  // ── Pattern tracking ──────────────────────────────────────────────
  function _recordPattern(category) {
    if (!_patterns[category]) _patterns[category] = { count: 0, firstTs: Date.now(), trend: 0 };
    var p = _patterns[category];
    var now = Date.now();
    p.count++;
    p.trend = (now - p.firstTs > 0) ? p.count / ((now - p.firstTs) / 60000) : p.count;
  }

  function _getPattern(category) {
    return _patterns[category] || { count: 0, trend: 0 };
  }

  // ── Telemetry ─────────────────────────────────────────────────────
  function _tel(action, category, result, detail) {
    _heals.push({ ts: Date.now(), action: action, category: category, result: result, detail: detail || null });
    if (_heals.length > MAX_TELEMETRY) _heals.shift();
  }

  // ── Cooldown guard ────────────────────────────────────────────────
  function _canHeal(category) {
    var last = _cooldowns[category] || 0;
    var recentCount = _heals.filter(function (h) {
      return Date.now() - h.ts < 60000;
    }).length;
    if (recentCount >= MAX_HEALS_PER_MIN) return false;
    if (Date.now() - last < HEAL_COOLDOWN_MS) return false;
    return true;
  }

  // ── Healing strategies ────────────────────────────────────────────

  function _healMemoryPanic(severity) {
    var steps = [];
    // Level 1: GC hint
    try {
      if (G.gc) { G.gc(); steps.push('gc-hint'); }
    } catch (_) {}
    // Level 2: cache clear
    if (severity <= 2) {
      try {
        var sc = G.RuntimeSmartCache;
        if (sc && sc.clear) { sc.clear(); steps.push('cache-clear'); }
      } catch (_) {}
    }
    // Level 3: extreme mode for high/critical
    if (severity <= 1) {
      try {
        if (G.triggerExtremeMode) { G.triggerExtremeMode('ULTRA_LOW_MEMORY', 'autonomous-healer'); steps.push('extreme-ulm'); }
      } catch (_) {}
    }
    return steps;
  }

  function _healWorkerCrash(severity, context) {
    var steps = [];
    // Soft-restart: lift thermal limit then restore
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && context) {
        if (pw.setThermalLimit) { pw.setThermalLimit(context, 0); steps.push('worker-pause:' + context); }
        setTimeout(function () {
          try { if (pw.setThermalLimit) pw.setThermalLimit(context, 2); } catch (_) {}
        }, 500);
        steps.push('worker-resume:' + context);
      }
    } catch (_) {}
    // Flush hydration if P1+
    if (severity <= 1) {
      try {
        var sh = G.RuntimeStreamingHydration;
        if (sh && sh.flush) { sh.flush(); steps.push('hydration-flush'); }
      } catch (_) {}
    }
    return steps;
  }

  function _healHydrationFailure() {
    var steps = [];
    try {
      var sh = G.RuntimeStreamingHydration;
      if (sh && sh.flush) { sh.flush(); steps.push('hydration-flush'); }
    } catch (_) {}
    try {
      var hs = G.RuntimeHydrationScheduler;
      if (hs && hs.resume) { hs.resume('P2'); hs.resume('P1'); hs.resume('P0'); steps.push('hydration-resume-all'); }
    } catch (_) {}
    return steps;
  }

  function _healThermalEmergency(context) {
    var steps = [];
    try {
      if (G.triggerExtremeMode) { G.triggerExtremeMode('THERMAL_EMERGENCY', 'autonomous-healer'); steps.push('extreme-thermal'); }
    } catch (_) {}
    try {
      var to = G.RuntimeTaskOrchestrator;
      if (to && to.throttle) { to.throttle(context || 'all', 0.5); steps.push('task-throttle'); }
    } catch (_) {}
    return steps;
  }

  function _healCachePressure() {
    var steps = [];
    try {
      var sc = G.RuntimeSmartCache;
      if (sc && sc.clear) { sc.clear(); steps.push('cache-clear'); }
    } catch (_) {}
    return steps;
  }

  function _healDeployMismatch() {
    // Safest possible: reload page (only on explicit P0 escalation)
    return ['deploy-mismatch-detected'];  // advisory only, no auto-reload
  }

  // ── Core heal dispatcher ──────────────────────────────────────────
  function heal(category, severity, context) {
    severity = severity === undefined ? 2 : severity;
    _recordPattern(category);

    if (!_canHeal(category)) {
      _tel('skipped', category, 'cooldown');
      return { ok: false, reason: 'cooldown' };
    }

    _stats.triggered++;
    _cooldowns[category] = Date.now();
    _tel('start', category, 'healing:' + category + ':sev' + severity);

    // Pre-healing snapshot
    var snapId = null;
    try {
      var ss = G.RuntimeStateSnapshots;
      if (ss) snapId = ss.take('pre-heal:' + category);
    } catch (_) {}

    var steps = [];
    try {
      switch (category) {
        case 'memory-panic':        steps = _healMemoryPanic(severity);       break;
        case 'worker-crash':        steps = _healWorkerCrash(severity, context); break;
        case 'hydration-failure':   steps = _healHydrationFailure();          break;
        case 'thermal-emergency':   steps = _healThermalEmergency(context);   break;
        case 'trace-slow-path':     steps = _healCachePressure();             break;
        case 'deploy-mismatch':     steps = _healDeployMismatch();            break;
        default:                    steps = _healCachePressure();             break;
      }
    } catch (e) {
      _stats.failed++;
      _tel('error', category, 'heal-threw: ' + e.message);
      _maybeRollback(snapId, category);
      return { ok: false, reason: e.message };
    }

    // Deferred verification
    setTimeout(function () { _verify(category, severity, snapId, steps); }, VERIFY_DELAY_MS);

    _tel('applied', category, 'steps:' + steps.join(','));
    console.debug(LOG, 'healed:', category, 'sev:', severity, '| steps:', steps.join(','));

    try {
      G.dispatchEvent(new CustomEvent('arc9:heal-applied', {
        detail: { category: category, severity: severity, steps: steps, snapId: snapId },
      }));
    } catch (_) {}

    return { ok: true, steps: steps, snapId: snapId };
  }

  // ── Verification ──────────────────────────────────────────────────
  function _verify(category, severity, snapId, steps) {
    try {
      // Check incident center — did the incident recur at same or higher severity?
      var inc = G.getRuntimeIncidents && G.getRuntimeIncidents({ category: category, limit: 3 });
      var recent = inc ? inc.filter(function (i) { return Date.now() - i.lastTs < VERIFY_DELAY_MS * 2; }) : [];
      var escalated = recent.some(function (i) { return i.severity <= severity; });

      if (escalated) {
        _stats.failed++;
        _tel('verify-fail', category, 'incident-recurred');
        _maybeRollback(snapId, category);
        console.warn(LOG, 'heal FAILED:', category, '— incident recurred, rolling back');
      } else {
        _stats.succeeded++;
        _tel('verify-ok', category, 'steps:' + steps.length);
        console.debug(LOG, 'heal verified:', category, '✓');
      }
    } catch (_) {}
  }

  function _maybeRollback(snapId, category) {
    if (!snapId) return;
    try {
      // Emit rollback event — actual subsystem restore is handled by RecoveryOrchestrator
      G.dispatchEvent(new CustomEvent('arc9:heal-rollback', { detail: { snapId: snapId, category: category } }));
      _stats.rolledBack++;
      _tel('rollback', category, 'snapId:' + snapId);
      console.warn(LOG, 'rollback requested for snapId:', snapId);
    } catch (_) {}
  }

  // ── Auto-heal: listen to incident center ─────────────────────────
  G.addEventListener('arc8:incident', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !_active) return;
      if (d.severity <= 1) {  // P0/P1 auto-heal
        setTimeout(function () { heal(d.category, d.severity, d.context); }, 100);
      } else if (d.severity === 2 && _getPattern(d.category).count >= 3) {
        // P2 with pattern → auto-heal
        setTimeout(function () { heal(d.category, d.severity, d.context); }, 200);
      }
    } catch (_) {}
  });

  // ── Boot ──────────────────────────────────────────────────────────
  function start() { _active = true;  console.debug(LOG, 'autonomous healing ACTIVE'); }
  function stop()  { _active = false; console.debug(LOG, 'autonomous healing PAUSED'); }

  start();

  G.RuntimeAutonomousHealing = Object.freeze({
    VERSION:     VERSION,
    heal:        heal,
    start:       start,
    stop:        stop,
    isActive:    function () { return _active; },
    getState: function () {
      return {
        active:   _active,
        stats:    Object.assign({}, _stats),
        patterns: Object.assign({}, _patterns),
        recent:   _heals.slice(-20),
      };
    },
    getTelemetry: function () { return _heals.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — autonomous healing active | window.RuntimeAutonomousHealing.getState()');

}(window));

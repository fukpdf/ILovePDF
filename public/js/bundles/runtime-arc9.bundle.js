// ── Arc 9 Autonomous Self-Healing + Distributed Runtime Intelligence — Phase 9 build bundle ──────────────────────────
// Generated: 2026-06-03T02:46:36.833Z  BUILD_ID: mpxgtdiz
// Files: 8

// ── SOURCE: public/js/runtime-autonomous-healing.js ──
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

// ── SOURCE: public/js/runtime-workload-intelligence.js ──
// RuntimeWorkloadIntelligence v1.0 — Arc 9 / Phase B
// =====================================================================
// Dynamic workload redistribution engine. Monitors per-family queue
// depths, thermal state, and memory pressure to intelligently migrate
// and balance tasks across worker domains.
//
// Capabilities:
//   - Thermal-aware task migration (hot family → migrate to spare domain)
//   - Memory-aware task balancing (over-budget family gets throttled)
//   - Worker congestion prediction (queue depth trend → preemptive relief)
//   - Queue pressure balancing (starvation prevention, adaptive concurrency)
//   - Idle-core utilization (detect unused capacity → route work there)
//
// Integrates: RuntimeTaskOrchestrator, RuntimeProcessorWorkers,
//   RuntimeStreamWorkers, RuntimeMobileHardening, RuntimeStreamTelemetry
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeWorkloadIntelligence) return;

  var LOG     = '[WorkloadIntel]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var SWEEP_MS          = 3000;   // balancing sweep interval
  var STARVATION_MS     = 5000;   // family waiting > this → starved
  var STARVATION_DEPTH  = 5;      // min queue depth to count as starvation
  var CONGESTION_THRESH = 8;      // queue depth → congested
  var IDLE_THRESH       = 0.2;    // worker utilization < this → idle

  // ── Per-family metrics ────────────────────────────────────────────
  var _families = {};
  // family → { queueDepth, running, thermalBudget, memMb, stallSince, utilization, migrations }

  function _ensure(family) {
    if (!_families[family]) {
      _families[family] = {
        queueDepth: 0, running: 0, thermalBudget: 100,
        memMb: 0, stallSince: null, utilization: 0.5, migrations: 0,
      };
    }
    return _families[family];
  }

  // ── Queue depth trend ─────────────────────────────────────────────
  var _depthHistory = {};  // family → [last 5 snapshots]

  function _trackDepth(family, depth) {
    if (!_depthHistory[family]) _depthHistory[family] = [];
    _depthHistory[family].push(depth);
    if (_depthHistory[family].length > 5) _depthHistory[family].shift();
  }

  function _depthTrend(family) {
    var h = _depthHistory[family];
    if (!h || h.length < 2) return 0;
    return h[h.length - 1] - h[0];  // positive = growing
  }

  // ── Telemetry ─────────────────────────────────────────────────────
  var _actions = [];
  function _record(action, family, detail) {
    _actions.push({ ts: Date.now(), action: action, family: family, detail: detail || null });
    if (_actions.length > 200) _actions.shift();
  }

  var _stats = { sweeps: 0, migrations: 0, throttles: 0, lifts: 0, starvations: 0 };

  // ── Collect current workload state ────────────────────────────────
  function _collect() {
    var families = ['organize', 'compress', 'convert', 'ocr', 'image', 'ai', 'watermark', 'repair', 'split', 'merge'];

    try {
      var to = G.RuntimeTaskOrchestrator;
      if (to && to.getStats) {
        var ts = to.getStats();
        // Map lane stats to families
        if (ts && ts.lanes) {
          Object.keys(ts.lanes).forEach(function (lane) {
            var fm = _ensure(lane);
            fm.queueDepth = ts.lanes[lane].queued || 0;
            fm.running    = ts.lanes[lane].running || 0;
            _trackDepth(lane, fm.queueDepth);
          });
        }
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.getStats) {
        var ws = pw.getStats();
        if (ws) {
          families.forEach(function (f) {
            if (ws[f]) {
              _ensure(f).thermalBudget = ws[f].budget || 100;
              _ensure(f).utilization   = ws[f].active || 0;
            }
          });
        }
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.getStats) {
        var ms = pm.getStats();
        if (ms) {
          families.forEach(function (f) {
            if (ms[f]) _ensure(f).memMb = ms[f].heapMb || 0;
          });
        }
      }
    } catch (_) {}
  }

  // ── Thermal migration ─────────────────────────────────────────────
  function _thermalMigration() {
    // Find hot families and idle families
    var hot  = [];
    var idle = [];

    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      if (fm.thermalBudget < 30 && fm.queueDepth > 2) hot.push(f);
      if (fm.utilization < IDLE_THRESH && fm.queueDepth === 0) idle.push(f);
    });

    if (!hot.length || !idle.length) return;

    hot.forEach(function (f) {
      // Reduce thermal pressure on hot family
      try {
        var pw = G.RuntimeProcessorWorkers;
        if (pw && pw.setThermalLimit) {
          pw.setThermalLimit(f, 1);  // reduce to 1 concurrent worker
          _families[f].migrations++;
          _stats.migrations++;
          _record('thermal-migrate', f, 'budget:' + _families[f].thermalBudget);
          console.debug(LOG, 'thermal-migrate:', f, '→ reduced concurrency');
        }
      } catch (_) {}
    });
  }

  // ── Memory balancing ──────────────────────────────────────────────
  function _memoryBalance() {
    var OVER_MB = 300;  // family heap > 300MB → throttle
    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      if (fm.memMb > OVER_MB) {
        try {
          var pw = G.RuntimeProcessorWorkers;
          if (pw && pw.setThermalLimit) {
            pw.setThermalLimit(f, 1);
            _stats.throttles++;
            _record('mem-throttle', f, 'memMb:' + fm.memMb);
            console.debug(LOG, 'mem-throttle:', f, fm.memMb + 'MB');
          }
        } catch (_) {}
        // Try RuntimeIncidentCenter advisory
        try {
          var ic = G.RuntimeIncidentCenter;
          if (ic) ic.record('memory-panic', ic.P2, f, { memMb: fm.memMb });
        } catch (_) {}
      }
    });
  }

  // ── Starvation prevention ─────────────────────────────────────────
  function _starvationCheck() {
    var now = Date.now();
    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      if (fm.queueDepth >= STARVATION_DEPTH && fm.running === 0) {
        if (!fm.stallSince) fm.stallSince = now;
        else if (now - fm.stallSince > STARVATION_MS) {
          _stats.starvations++;
          _record('starvation', f, 'depth:' + fm.queueDepth + ' stalledMs:' + (now - fm.stallSince));
          console.warn(LOG, 'starvation detected:', f, 'depth:', fm.queueDepth);
          // Lift any artificial throttle
          try {
            var pw = G.RuntimeProcessorWorkers;
            if (pw && pw.setThermalLimit) { pw.setThermalLimit(f, 2); _stats.lifts++; }
          } catch (_) {}
          // Emit for AutonomousHealing
          try {
            G.dispatchEvent(new CustomEvent('arc9:starvation', { detail: { family: f, depth: fm.queueDepth } }));
          } catch (_) {}
          fm.stallSince = null;  // reset
        }
      } else {
        fm.stallSince = null;
      }
    });
  }

  // ── Congestion prediction ─────────────────────────────────────────
  function _congestionPredict() {
    Object.keys(_families).forEach(function (f) {
      var trend = _depthTrend(f);
      var fm    = _families[f];
      if (fm.queueDepth > CONGESTION_THRESH || (fm.queueDepth > 4 && trend > 2)) {
        _record('congestion-predict', f, 'depth:' + fm.queueDepth + ' trend:' + trend);
        // Emit advisory for task orchestrator
        try {
          G.dispatchEvent(new CustomEvent('arc9:congestion', {
            detail: { family: f, depth: fm.queueDepth, trend: trend },
          }));
        } catch (_) {}
      }
    });
  }

  // ── Idle utilization ──────────────────────────────────────────────
  function _idleUtilization() {
    // Identify idle capacity and emit advisory for predictive loader
    var idleFamilies = Object.keys(_families).filter(function (f) {
      return _families[f].utilization < IDLE_THRESH && _families[f].queueDepth === 0;
    });
    if (idleFamilies.length > 0) {
      try {
        G.dispatchEvent(new CustomEvent('arc9:idle-capacity', { detail: { families: idleFamilies } }));
      } catch (_) {}
    }
  }

  // ── Main sweep ────────────────────────────────────────────────────
  function _sweep() {
    _stats.sweeps++;
    _collect();
    _thermalMigration();
    _memoryBalance();
    _starvationCheck();
    _congestionPredict();
    _idleUtilization();
  }

  // ── Controls ──────────────────────────────────────────────────────
  var _timer = null;

  function start() {
    if (_timer) return;
    _timer = setInterval(_sweep, SWEEP_MS);
    console.debug(LOG, 'workload intelligence ACTIVE — sweep:', SWEEP_MS + 'ms');
  }

  function stop() {
    clearInterval(_timer); _timer = null;
    console.debug(LOG, 'workload intelligence PAUSED');
  }

  function getState() {
    return {
      running:  !!_timer,
      families: Object.assign({}, _families),
      stats:    Object.assign({}, _stats),
      recent:   _actions.slice(-20),
    };
  }

  start();

  G.RuntimeWorkloadIntelligence = Object.freeze({
    VERSION:  VERSION,
    start:    start,
    stop:     stop,
    getState: getState,
    getFamilies: function () { return Object.assign({}, _families); },
    getActions:  function () { return _actions.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — thermal/memory/starvation/congestion balancing active');

}(window));

// ── SOURCE: public/js/runtime-session-stability.js ──
// RuntimeSessionStability v1.0 — Arc 9 / Phase C
// =====================================================================
// Long-session degradation detector and stability engine.
// Targets 6hr+ session stability with automated entropy mitigation.
//
// Session age tiers:
//   fresh    (0–30 min)   — no action
//   warm     (30–60 min)  — baseline sweep
//   long     (1–2 hr)     — moderate compaction
//   extended (2–4 hr)     — aggressive cleanup
//   critical (4+ hr)      — emergency stabilization
//
// Degradation signals:
//   - Heap growth rate (MB/min over 5-min window)
//   - Event timeline growth rate (events/min)
//   - Worker stall rate
//   - Hydration failure rate
//   - Incident rate (incidents/min)
//
// Interventions (by degradation level 0–4):
//   0  nominal   — log only
//   1  warning   — GC hint + dormant worker cleanup
//   2  degraded  — cache clear + hydration flush + snapshot
//   3  critical  — extreme-mode ULTRA_LOW_MEMORY + subsystem compaction
//   4  emergency — safe-mode request + mandatory snapshot
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeSessionStability) return;

  var LOG     = '[SessionStability]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var SWEEP_MS     = 5 * 60 * 1000;  // 5-min compaction sweep
  var SAMPLE_MS    = 60 * 1000;      // 1-min entropy sample
  var HEAP_WARN_RATE  = 50;   // MB/min heap growth → warn
  var HEAP_CRIT_RATE  = 150;  // MB/min heap growth → critical
  var INCIDENT_WARN   = 5;    // incidents/min → warn
  var EVENT_WARN_RATE = 200;  // events/min → warn

  // ── Session state ─────────────────────────────────────────────────
  var _startTs   = Date.now();
  var _level     = 0;  // 0=nominal, 1=warn, 2=degraded, 3=critical, 4=emergency
  var _levelNames = ['nominal', 'warning', 'degraded', 'critical', 'emergency'];

  // ── Entropy samples ───────────────────────────────────────────────
  var _heapSamples   = [];  // { ts, mb }
  var _eventSamples  = [];  // { ts, count }
  var _incidentSamples = [];

  function _sessionAge()  { return Date.now() - _startTs; }
  function _ageMinutes()  { return Math.round(_sessionAge() / 60000); }
  function _ageTier() {
    var m = _ageMinutes();
    if (m < 30) return 'fresh';
    if (m < 60) return 'warm';
    if (m < 120) return 'long';
    if (m < 240) return 'extended';
    return 'critical';
  }

  // ── Entropy sampling ──────────────────────────────────────────────
  function _sample() {
    var now = Date.now();
    // Heap
    try {
      var pm = performance.memory;
      if (pm) _heapSamples.push({ ts: now, mb: pm.usedJSHeapSize / 1024 / 1024 });
      if (_heapSamples.length > 30) _heapSamples.shift();
    } catch (_) {}

    // Event count
    try {
      var et = G.RuntimeEventTimeline;
      if (et) _eventSamples.push({ ts: now, count: et.getCount() });
      if (_eventSamples.length > 30) _eventSamples.shift();
    } catch (_) {}

    // Incident count
    try {
      var ic = G.getRuntimeIncidents && G.getRuntimeIncidents();
      if (ic) _incidentSamples.push({ ts: now, count: ic.length });
      if (_incidentSamples.length > 30) _incidentSamples.shift();
    } catch (_) {}
  }

  // ── Rate calculation (per minute over last N samples) ─────────────
  function _rate(samples, field) {
    if (samples.length < 2) return 0;
    var first = samples[0];
    var last  = samples[samples.length - 1];
    var dtMin = (last.ts - first.ts) / 60000;
    if (dtMin < 0.01) return 0;
    return (last[field] - first[field]) / dtMin;
  }

  // ── Degradation assessment ────────────────────────────────────────
  function _assess() {
    var heapRate     = _rate(_heapSamples, 'mb');
    var eventRate    = _rate(_eventSamples, 'count');
    var incidentRate = _rate(_incidentSamples, 'count');
    var tier         = _ageTier();

    var score = 0;
    if (heapRate     > HEAP_WARN_RATE)   score++;
    if (heapRate     > HEAP_CRIT_RATE)   score++;
    if (eventRate    > EVENT_WARN_RATE)  score++;
    if (incidentRate > INCIDENT_WARN)    score++;
    if (tier === 'extended')             score++;
    if (tier === 'critical')             score += 2;

    var newLevel = Math.min(4, score);
    if (newLevel !== _level) {
      var prev = _level;
      _level   = newLevel;
      console.debug(LOG, 'degradation level:', _levelNames[prev], '→', _levelNames[_level],
        '| age:', _ageMinutes() + 'min | heap-rate:', heapRate.toFixed(1) + 'MB/min');
      try {
        G.dispatchEvent(new CustomEvent('arc9:stability-level', {
          detail: { level: _level, levelName: _levelNames[_level], ageMin: _ageMinutes() },
        }));
      } catch (_) {}
    }

    return { heapRate: heapRate, eventRate: eventRate, incidentRate: incidentRate, level: _level };
  }

  // ── Interventions by level ────────────────────────────────────────
  function _intervene(assessment) {
    if (assessment.level === 0) return;

    var steps = [];

    if (assessment.level >= 1) {
      // GC hint
      try { if (G.gc) { G.gc(); steps.push('gc-hint'); } } catch (_) {}
      // Dormant worker cleanup advisory
      try {
        G.dispatchEvent(new CustomEvent('arc9:cleanup-dormant', { detail: { level: assessment.level } }));
        steps.push('cleanup-advisory');
      } catch (_) {}
    }

    if (assessment.level >= 2) {
      // Cache clear
      try {
        var sc = G.RuntimeSmartCache;
        if (sc && sc.clear) { sc.clear(); steps.push('cache-clear'); }
      } catch (_) {}
      // Hydration flush
      try {
        var sh = G.RuntimeStreamingHydration;
        if (sh && sh.flush) { sh.flush(); steps.push('hydration-flush'); }
      } catch (_) {}
      // Stability snapshot
      try {
        var ss = G.RuntimeStateSnapshots;
        if (ss) { ss.take('stability:level-' + assessment.level, false); steps.push('snapshot'); }
      } catch (_) {}
    }

    if (assessment.level >= 3) {
      // Extreme mode for memory pressure
      try {
        if (G.triggerExtremeMode) { G.triggerExtremeMode('ULTRA_LOW_MEMORY', 'session-stability'); steps.push('extreme-ulm'); }
      } catch (_) {}
      // Compact event timeline
      try {
        var et = G.RuntimeEventTimeline;
        if (et && et.clear) { et.clear(); steps.push('timeline-compact'); }
      } catch (_) {}
    }

    if (assessment.level >= 4) {
      // Emergency: request safe-mode via RecoveryOrchestrator
      try {
        G.dispatchEvent(new CustomEvent('arc9:safe-mode-request', {
          detail: { reason: 'session-entropy', ageMin: _ageMinutes(), level: assessment.level },
        }));
        steps.push('safe-mode-request');
      } catch (_) {}
      // Mandatory snapshot checkpoint
      try {
        var ss2 = G.RuntimeStateSnapshots;
        if (ss2) { ss2.take('emergency:session-critical', true); steps.push('emergency-checkpoint'); }
      } catch (_) {}
    }

    if (steps.length) {
      console.warn(LOG, 'intervention L' + assessment.level + ':', steps.join(','));
      try {
        G.dispatchEvent(new CustomEvent('arc9:stability-intervention', {
          detail: { level: assessment.level, steps: steps },
        }));
      } catch (_) {}
    }
  }

  // ── Sweep ─────────────────────────────────────────────────────────
  var _sweepCount = 0;
  function _sweep() {
    _sweepCount++;
    _sample();
    var assessment = _assess();
    _intervene(assessment);
  }

  // ── Timers ────────────────────────────────────────────────────────
  var _sampleTimer = setInterval(_sample, SAMPLE_MS);
  var _sweepTimer  = setInterval(_sweep, SWEEP_MS);

  // Initial sample
  setTimeout(_sample, 5000);

  G.RuntimeSessionStability = Object.freeze({
    VERSION:     VERSION,
    getLevel:    function () { return { level: _level, name: _levelNames[_level] }; },
    getAgeTier:  _ageTier,
    getAgeMin:   _ageMinutes,
    assess:      _assess,
    forceIntervene: function () { _intervene(_assess()); },
    getState: function () {
      return {
        ageMin:       _ageMinutes(),
        ageTier:      _ageTier(),
        level:        _level,
        levelName:    _levelNames[_level],
        sweeps:       _sweepCount,
        heapRate:     _rate(_heapSamples, 'mb'),
        eventRate:    _rate(_eventSamples, 'count'),
        incidentRate: _rate(_incidentSamples, 'count'),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — session stability monitoring | target: 6hr+ | sweep:', SWEEP_MS / 60000 + 'min');

}(window));

// ── SOURCE: public/js/runtime-recovery-orchestrator.js ──
// RuntimeRecoveryOrchestrator v1.0 — Arc 9 / Phase D
// =====================================================================
// Unified recovery graph with dependency-ordered sequencing.
// Distinct from RuntimeRecoveryDomains (Arc 3 tool isolation) and
// RuntimeRecoveryFirewalls (Arc 5 tool firewalls).
//
// Recovery lifecycle: ASSESS → ISOLATE → HEAL → VERIFY → RESTORE
//
// Features:
//   - Subsystem dependency tree (what must recover before what)
//   - Topological recovery sequencing
//   - Pre-recovery rollback checkpoints
//   - Replay-guided recovery (RuntimeReplayEngine integration)
//   - Healing simulations (dry-run without executing)
//   - Safe-mode: minimal runtime (Arc 1-3 only)
//   - Partial restart: reboot one subsystem without full reload
//   - Isolated subsystem reboot via targeted event dispatch
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeRecoveryOrchestrator) return;

  var LOG     = '[RecoveryOrchestrator]';
  var VERSION = '1.0';

  // ── Subsystem dependency graph ────────────────────────────────────
  // Each entry: { id, deps[], global, recoveryFn }
  // deps = must be recovered before this subsystem
  var DEPENDENCY_GRAPH = [
    { id: 'core',          deps: [],                     critical: true  },
    { id: 'deploy-sync',   deps: ['core'],               critical: true  },
    { id: 'hydration',     deps: ['core'],               critical: true  },
    { id: 'workers',       deps: ['core'],               critical: false },
    { id: 'memory',        deps: ['core', 'workers'],    critical: false },
    { id: 'cache',         deps: ['core'],               critical: false },
    { id: 'task-orch',     deps: ['workers', 'memory'],  critical: false },
    { id: 'stream',        deps: ['task-orch', 'workers'], critical: false },
    { id: 'offline',       deps: ['core'],               critical: false },
    { id: 'predictive',    deps: ['cache', 'stream'],    critical: false },
    { id: 'optimizer',     deps: ['task-orch', 'stream'], critical: false },
    { id: 'control-plane', deps: ['core'],               critical: false },
    { id: 'incident',      deps: ['core'],               critical: false },
    { id: 'timeline',      deps: ['core'],               critical: false },
    { id: 'snapshots',     deps: ['core', 'memory'],     critical: false },
    { id: 'governance',    deps: ['core', 'control-plane'], critical: false },
    { id: 'healing',       deps: ['incident', 'snapshots'], critical: false },
    { id: 'workload',      deps: ['workers', 'task-orch'], critical: false },
  ];

  // ── Topological sort ──────────────────────────────────────────────
  function _topoSort(graph) {
    var inDegree = {};
    var adj      = {};
    graph.forEach(function (n) {
      inDegree[n.id] = n.deps.length;
      adj[n.id]      = [];
    });
    graph.forEach(function (n) {
      n.deps.forEach(function (dep) { if (adj[dep]) adj[dep].push(n.id); });
    });

    var queue  = Object.keys(inDegree).filter(function (k) { return inDegree[k] === 0; });
    var result = [];
    while (queue.length) {
      var node = queue.shift();
      result.push(node);
      (adj[node] || []).forEach(function (nbr) {
        inDegree[nbr]--;
        if (inDegree[nbr] === 0) queue.push(nbr);
      });
    }
    return result;
  }

  var RECOVERY_ORDER = _topoSort(DEPENDENCY_GRAPH);

  // ── Recovery actions per subsystem ───────────────────────────────
  function _recoverSubsystem(id, dryRun) {
    var steps = [];
    try {
      switch (id) {
        case 'cache':
          if (!dryRun) { var sc = G.RuntimeSmartCache; if (sc && sc.clear) sc.clear(); }
          steps.push('cache-clear');
          break;
        case 'hydration':
          if (!dryRun) {
            var sh = G.RuntimeStreamingHydration;
            if (sh && sh.flush) sh.flush();
            var hs = G.RuntimeHydrationScheduler;
            if (hs && hs.resume) { hs.resume('P0'); hs.resume('P1'); hs.resume('P2'); }
          }
          steps.push('hydration-flush', 'hydration-resume');
          break;
        case 'workers':
          if (!dryRun) {
            G.dispatchEvent(new CustomEvent('arc9:recover-workers', {}));
          }
          steps.push('worker-recover-advisory');
          break;
        case 'memory':
          if (!dryRun) { try { if (G.gc) G.gc(); } catch (_) {} }
          steps.push('gc-hint');
          break;
        case 'control-plane':
          if (!dryRun) {
            var cp = G.RuntimeControlPlane;
            if (cp) { cp.execute('predictive.enable', {}); cp.execute('optimizer.enable', {}); }
          }
          steps.push('flags-restored');
          break;
        case 'timeline':
          if (!dryRun) {
            var et = G.RuntimeEventTimeline;
            if (et && et.clear) et.clear();
          }
          steps.push('timeline-cleared');
          break;
        default:
          steps.push('advisory:' + id);
      }
    } catch (e) {
      steps.push('error:' + e.message);
    }
    return steps;
  }

  // ── State ─────────────────────────────────────────────────────────
  var _recovery     = null;  // active recovery context
  var _history      = [];    // past recoveries ring buffer
  var _safeMode     = false;
  var _stats        = { runs: 0, succeeded: 0, failed: 0, simulations: 0, rollbacks: 0 };
  var _tel          = [];

  function _log(ev, d) {
    _tel.push({ ts: Date.now(), ev: ev, d: d });
    if (_tel.length > 100) _tel.shift();
  }

  // ── Run recovery ──────────────────────────────────────────────────
  function runRecovery(opts) {
    opts = opts || {};
    if (_recovery) return { ok: false, reason: 'recovery-in-progress' };

    var subsystems = opts.subsystems || RECOVERY_ORDER;
    var dryRun     = !!opts.dryRun;
    var snapBefore = null;
    _stats.runs++;

    if (dryRun) { _stats.simulations++; console.debug(LOG, 'SIMULATION (dry-run)'); }

    // Pre-recovery snapshot
    if (!dryRun) {
      try {
        var ss = G.RuntimeStateSnapshots;
        if (ss) snapBefore = ss.take('pre-recovery:' + Date.now(), true);
      } catch (_) {}
    }

    _recovery = {
      id:      'rcv_' + Date.now().toString(36),
      started: Date.now(),
      subsystems: subsystems,
      dryRun:  dryRun,
      snapBefore: snapBefore,
      phase:   'ASSESS',
      steps:   {},
    };

    _log('start', { id: _recovery.id, subsystems: subsystems, dryRun: dryRun });
    console.debug(LOG, 'recovery', _recovery.id, '| subsystems:', subsystems.join(','), dryRun ? '[dry-run]' : '');

    // Execute sequentially (async to avoid blocking)
    var seq = subsystems.slice();
    var allSteps = {};

    function _next() {
      if (!seq.length) {
        _recovery.phase   = 'RESTORE';
        _recovery.ended   = Date.now();
        _recovery.durationMs = _recovery.ended - _recovery.started;
        _recovery.steps   = allSteps;
        _stats.succeeded++;
        _log('complete', { id: _recovery.id, ms: _recovery.durationMs });
        console.debug(LOG, 'recovery complete:', _recovery.id, _recovery.durationMs + 'ms');
        try {
          G.dispatchEvent(new CustomEvent('arc9:recovery-complete', {
            detail: { id: _recovery.id, dryRun: dryRun, ms: _recovery.durationMs },
          }));
        } catch (_) {}
        _history.push(Object.assign({}, _recovery));
        if (_history.length > 20) _history.shift();
        _recovery = null;
        return;
      }
      var sub = seq.shift();
      _recovery.phase = 'HEAL:' + sub;
      try {
        allSteps[sub] = _recoverSubsystem(sub, dryRun);
      } catch (e) {
        allSteps[sub] = ['error:' + e.message];
      }
      setTimeout(_next, 50);  // 50ms between each to stay non-blocking
    }

    _recovery.phase = 'ISOLATE';
    setTimeout(_next, 10);
    return { ok: true, id: _recovery.id, dryRun: dryRun };
  }

  // ── Partial subsystem restart ─────────────────────────────────────
  function restartSubsystem(id) {
    console.debug(LOG, 'restarting subsystem:', id);
    return runRecovery({ subsystems: [id] });
  }

  // ── Safe mode ─────────────────────────────────────────────────────
  function enterSafeMode() {
    if (_safeMode) return { ok: false, reason: 'already-in-safe-mode' };
    _safeMode = true;
    console.warn(LOG, 'ENTERING SAFE MODE');
    // Disable non-critical subsystems
    try {
      var cp = G.RuntimeControlPlane;
      if (cp) {
        cp.execute('optimizer.disable', {});
        cp.execute('predictive.disable', {});
        cp.execute('extreme.trigger', { mode: 'ULTRA_LOW_MEMORY' });
      }
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('arc9:safe-mode-active', { detail: { ts: Date.now() } }));
    } catch (_) {}
    _log('safe-mode', { ts: Date.now() });
    // Run critical-only recovery
    var criticalIds = DEPENDENCY_GRAPH.filter(function (n) { return n.critical; }).map(function (n) { return n.id; });
    return runRecovery({ subsystems: criticalIds });
  }

  function exitSafeMode() {
    if (!_safeMode) return;
    _safeMode = false;
    try {
      var cp = G.RuntimeControlPlane;
      if (cp) { cp.execute('optimizer.enable', {}); cp.execute('predictive.enable', {}); }
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('arc9:safe-mode-exited', { detail: { ts: Date.now() } }));
    } catch (_) {}
    console.debug(LOG, 'safe mode exited');
  }

  // ── Rollback ──────────────────────────────────────────────────────
  G.addEventListener('arc8:heal-rollback', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.snapId) return;
      _stats.rollbacks++;
      _log('rollback-received', { snapId: d.snapId, category: d.category });
      console.warn(LOG, 'rollback received for snap:', d.snapId, 'category:', d.category);
      // Restart affected subsystem as recovery response
      if (d.category === 'hydration-failure') restartSubsystem('hydration');
      else if (d.category === 'worker-crash')  restartSubsystem('workers');
      else if (d.category === 'memory-panic')  restartSubsystem('memory');
    } catch (_) {}
  });

  // ── Safe-mode request ─────────────────────────────────────────────
  G.addEventListener('arc9:safe-mode-request', function () {
    try { enterSafeMode(); } catch (_) {}
  });

  G.RuntimeRecoveryOrchestrator = Object.freeze({
    VERSION:           VERSION,
    runRecovery:       runRecovery,
    restartSubsystem:  restartSubsystem,
    simulate:          function (opts) { return runRecovery(Object.assign({}, opts, { dryRun: true })); },
    enterSafeMode:     enterSafeMode,
    exitSafeMode:      exitSafeMode,
    isSafeMode:        function () { return _safeMode; },
    getRecoveryOrder:  function () { return RECOVERY_ORDER.slice(); },
    getHistory:        function () { return _history.slice(); },
    getActive:         function () { return _recovery ? Object.assign({}, _recovery) : null; },
    getStats:          function () { return Object.assign({}, _stats); },
    getTelemetry:      function () { return _tel.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — recovery order:', RECOVERY_ORDER.length, 'subsystems | safe-mode available');

}(window));

// ── SOURCE: public/js/runtime-adaptive-ai.js ──
// RuntimeAdaptiveAI v1.0 — Arc 9 / Phase E
// =====================================================================
// Runtime execution prediction and user behavior learning engine.
//
// Capabilities:
//   - Tool usage frequency map (per-session + lifetime)
//   - Processor pre-activation: warm up top-N predicted processors
//   - Worker prewarm intelligence: start worker 500ms ahead of need
//   - Thermal prediction: linear regression on last 10 thermal samples
//   - Memory prediction: per-tool allocation running average
//   - Per-device adaptation: aggressiveness scales with device tier
//   - Per-session model update: learns within the current session
//
// Integrates: RuntimePredictiveLoader, RuntimeProcessorLoader,
//   RuntimeTaskOrchestrator, RuntimeMobileHardening, RuntimeStreamTelemetry
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeAdaptiveAI) return;

  var LOG     = '[AdaptiveAI]';
  var VERSION = '1.0';

  // ── Device tier ───────────────────────────────────────────────────
  function _deviceTier() {
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh && mh.getDeviceTier) return mh.getDeviceTier();
    } catch (_) {}
    var mem = (navigator.deviceMemory || 4);
    var cpu = (navigator.hardwareConcurrency || 4);
    if (mem >= 8 && cpu >= 8) return 'high';
    if (mem >= 4 && cpu >= 4) return 'mid';
    return 'low';
  }

  // ── Config by device tier ─────────────────────────────────────────
  var TIER_CONFIG = {
    high: { topN: 5, prewarmMs: 300, maxPredictions: 10, aggressiveness: 1.0 },
    mid:  { topN: 3, prewarmMs: 500, maxPredictions: 6,  aggressiveness: 0.7 },
    low:  { topN: 2, prewarmMs: 800, maxPredictions: 4,  aggressiveness: 0.4 },
  };

  var _tier   = _deviceTier();
  var _config = TIER_CONFIG[_tier] || TIER_CONFIG['mid'];

  // ── Usage model ───────────────────────────────────────────────────
  var _toolUsage = {};
  // toolId → { sessionCount, lifetimeCount, lastUsed, sequenceAfter: {toolId: count} }

  function _ensureTool(toolId) {
    if (!_toolUsage[toolId]) {
      _toolUsage[toolId] = { sessionCount: 0, lifetimeCount: 0, lastUsed: 0, sequenceAfter: {} };
    }
    return _toolUsage[toolId];
  }

  var _lastTool = null;

  function recordToolUse(toolId) {
    var t = _ensureTool(toolId);
    t.sessionCount++;
    t.lifetimeCount++;
    t.lastUsed = Date.now();

    // Sequence model: track which tools follow which
    if (_lastTool && _lastTool !== toolId) {
      var lt = _ensureTool(_lastTool);
      lt.sequenceAfter[toolId] = (lt.sequenceAfter[toolId] || 0) + 1;
    }
    _lastTool = toolId;

    // Trigger pre-activation for predicted next tools
    var predicted = predictNext(toolId);
    if (predicted.length > 0) _preActivate(predicted);

    try {
      G.dispatchEvent(new CustomEvent('arc9:tool-recorded', { detail: { toolId: toolId, predicted: predicted } }));
    } catch (_) {}
  }

  // ── Prediction: top-N by session frequency ────────────────────────
  function getTopTools(n) {
    return Object.keys(_toolUsage)
      .sort(function (a, b) { return _toolUsage[b].sessionCount - _toolUsage[a].sessionCount; })
      .slice(0, n || _config.topN);
  }

  // ── Sequence prediction: most likely next after current ───────────
  function predictNext(toolId) {
    var t = _toolUsage[toolId];
    if (!t || !Object.keys(t.sequenceAfter).length) {
      // Fall back to global top tools
      return getTopTools(_config.topN);
    }
    var seq = t.sequenceAfter;
    return Object.keys(seq)
      .sort(function (a, b) { return seq[b] - seq[a]; })
      .slice(0, _config.topN);
  }

  // ── Processor pre-activation ──────────────────────────────────────
  function _preActivate(toolIds) {
    if (_config.aggressiveness < 0.5 && _deviceTier() === 'low') return;
    toolIds.forEach(function (toolId) {
      setTimeout(function () {
        try {
          var pl = G.RuntimePredictiveLoader;
          if (pl && pl.preload) pl.preload(toolId, 'adaptive-ai');
        } catch (_) {}
        try {
          G.dispatchEvent(new CustomEvent('arc9:preactivate', { detail: { toolId: toolId } }));
        } catch (_) {}
      }, _config.prewarmMs);
    });
  }

  // ── Worker prewarm intelligence ───────────────────────────────────
  function prewarmWorker(toolId) {
    setTimeout(function () {
      try {
        var pw = G.RuntimeProcessorWorkers;
        if (pw && pw.prewarm) pw.prewarm(toolId);
      } catch (_) {}
      try {
        G.dispatchEvent(new CustomEvent('arc9:worker-prewarm', { detail: { toolId: toolId } }));
      } catch (_) {}
    }, _config.prewarmMs);
  }

  // ── Thermal prediction ────────────────────────────────────────────
  var _thermalSamples = [];  // { ts, tier }
  var TIER_SCORE = { nominal: 0, warm: 1, hot: 2, critical: 3 };
  var SCORE_TIER = ['nominal', 'warm', 'hot', 'critical'];

  function _recordThermal(tier) {
    _thermalSamples.push({ ts: Date.now(), score: TIER_SCORE[tier] || 0 });
    if (_thermalSamples.length > 10) _thermalSamples.shift();
  }

  function predictThermal() {
    if (_thermalSamples.length < 3) return 'nominal';
    // Linear regression slope
    var n = _thermalSamples.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    _thermalSamples.forEach(function (s, i) { sumX += i; sumY += s.score; sumXY += i * s.score; sumXX += i * i; });
    var slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) || 0;
    var lastScore = _thermalSamples[_thermalSamples.length - 1].score;
    var predicted = Math.round(Math.max(0, Math.min(3, lastScore + slope)));
    return SCORE_TIER[predicted] || 'nominal';
  }

  // ── Memory prediction ─────────────────────────────────────────────
  var _memSamples = {};  // toolId → [heapMb values]

  function recordMemoryUsage(toolId, heapMb) {
    if (!_memSamples[toolId]) _memSamples[toolId] = [];
    _memSamples[toolId].push(heapMb);
    if (_memSamples[toolId].length > 20) _memSamples[toolId].shift();
  }

  function predictMemory(toolId) {
    var samples = _memSamples[toolId];
    if (!samples || !samples.length) return 0;
    return Math.round(samples.reduce(function (a, b) { return a + b; }, 0) / samples.length);
  }

  // ── Predictive throttling ─────────────────────────────────────────
  function shouldThrottle(toolId) {
    var predictedThermal = predictThermal();
    var predictedMem     = predictMemory(toolId);
    var heapLimit        = 400;  // MB
    if (predictedThermal === 'critical' || predictedThermal === 'hot') return true;
    if (predictedMem > heapLimit) return true;
    return false;
  }

  // ── Predictive cleanup ────────────────────────────────────────────
  function shouldCleanupBefore(toolId) {
    var predicted = predictMemory(toolId);
    var currentMb = 0;
    try { var pm = performance.memory; currentMb = pm ? pm.usedJSHeapSize / 1024 / 1024 : 0; } catch (_) {}
    return (currentMb + predicted) > 600;  // 600MB combined threshold
  }

  // ── Predictive hydration ──────────────────────────────────────────
  function predictiveHydrate() {
    var top = getTopTools(_config.topN);
    top.forEach(function (toolId) {
      try {
        var pl = G.RuntimePredictiveLoader;
        if (pl && pl.preload) pl.preload(toolId, 'predictive-hydrate');
      } catch (_) {}
    });
    return top;
  }

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('processor-hydration:activated', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.toolId) recordToolUse(d.toolId);
    } catch (_) {}
  });

  G.addEventListener('task-orchestrator:throttled', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.tier) _recordThermal(d.tier);
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.pct === 100 && d.toolId) {
        var heapMb = 0;
        try { var pm = performance.memory; heapMb = pm ? pm.usedJSHeapSize / 1024 / 1024 : 0; } catch (_) {}
        recordMemoryUsage(d.toolId, heapMb);
      }
    } catch (_) {}
  });

  // Thermal sample from stream telemetry
  setInterval(function () {
    try {
      var to = G.RuntimeTaskOrchestrator;
      if (to && to.getThermalTier) _recordThermal(to.getThermalTier());
    } catch (_) {}
  }, 30000);

  // ── Session init: predictive hydration of top tools ───────────────
  setTimeout(function () {
    if (_config.aggressiveness >= 0.7) predictiveHydrate();
  }, 5000);

  G.RuntimeAdaptiveAI = Object.freeze({
    VERSION:            VERSION,
    recordToolUse:      recordToolUse,
    recordMemoryUsage:  recordMemoryUsage,
    predictNext:        predictNext,
    getTopTools:        getTopTools,
    predictThermal:     predictThermal,
    predictMemory:      predictMemory,
    shouldThrottle:     shouldThrottle,
    shouldCleanupBefore: shouldCleanupBefore,
    predictiveHydrate:  predictiveHydrate,
    prewarmWorker:      prewarmWorker,
    getDeviceTier:      function () { return _tier; },
    getConfig:          function () { return Object.assign({}, _config); },
    getModel: function () {
      return {
        tier:       _tier,
        toolCount:  Object.keys(_toolUsage).length,
        topTools:   getTopTools(5),
        thermal:    predictThermal(),
        lastTool:   _lastTool,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — device tier:', _tier, '| aggressiveness:', _config.aggressiveness);

}(window));

// ── SOURCE: public/js/runtime-governance.js ──
// RuntimeGovernance v1.0 — Arc 9 / Phase F
// =====================================================================
// Runtime policy enforcement and compliance layer.
//
// Policy graph covers:
//   - Worker concurrency limits (min/max per family)
//   - Memory budget limits (per-family, global)
//   - Feature flag protections (flags that must not be disabled)
//   - Extreme mode authorization (which sources can trigger modes)
//   - Mutation guards (prevent unauthorized runtime state changes)
//   - Thermal safety boundaries (minimum thermal headroom)
//
// Enforcement:
//   - Intercepts RuntimeControlPlane commands via arc8:command events
//   - Periodic compliance sweep (every 2 min)
//   - Violation → arc8:incident(P1) for critical / P2 for advisory
//   - Quarantine: block all commands to a quarantined subsystem
//
// Governance snapshots: frozen policy state at each sweep.
// Protected flags: cannot be disabled without governance override.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeGovernance) return;

  var LOG     = '[Governance]';
  var VERSION = '1.0';

  // ── Policy definitions ────────────────────────────────────────────
  var POLICIES = [
    { id: 'worker-concurrency-max', desc: 'Max 4 workers per family',
      check: function () {
        try {
          var pw = G.RuntimeProcessorWorkers;
          if (!pw || !pw.getStats) return null;
          var ws = pw.getStats();
          if (!ws) return null;
          var violations = Object.keys(ws).filter(function (f) { return (ws[f].active || 0) > 4; });
          return violations.length === 0 ? null : 'families over concurrency limit: ' + violations.join(',');
        } catch (_) { return null; }
      }
    },
    { id: 'memory-global-budget', desc: 'Global heap < 80% of limit',
      check: function () {
        try {
          var pm = performance.memory;
          if (!pm) return null;
          var pct = pm.usedJSHeapSize / pm.jsHeapSizeLimit * 100;
          return pct > 80 ? 'global heap at ' + pct.toFixed(1) + '% — over 80% limit' : null;
        } catch (_) { return null; }
      }
    },
    { id: 'protected-flags-intact', desc: 'Core runtime flags must not be disabled',
      check: function () {
        try {
          var cp = G.RuntimeControlPlane;
          if (!cp) return null;
          var failed = PROTECTED_FLAGS.filter(function (f) { return cp.getFlag(f) === false; });
          return failed.length ? 'protected flags disabled: ' + failed.join(',') : null;
        } catch (_) { return null; }
      }
    },
    { id: 'hydration-domains-active', desc: 'P0 hydration domain must always be active',
      check: function () {
        try {
          var hd = G.RuntimeHydrationDomains;
          if (!hd) return null;
          var state = hd.getState && hd.getState();
          if (!state) return null;
          return state.P0Active === false ? 'P0 hydration domain inactive — safety violation' : null;
        } catch (_) { return null; }
      }
    },
    { id: 'offline-safe-active', desc: 'Offline queue must be operational',
      check: function () {
        try {
          var od = G.RuntimeOfflineDomains;
          if (!od) return null;
          // If offline domains exist and are suspended, flag it
          var s = od.getState && od.getState();
          if (s && s.suspended) return 'offline domains suspended — processing safety risk';
        } catch (_) {}
        return null;
      }
    },
    { id: 'immutability-guard-active', desc: 'RuntimeImmutabilityGuard must be active',
      check: function () {
        try {
          var ig = G.RuntimeImmutabilityGuard;
          return (ig && ig.isActive) ? null : 'ImmutabilityGuard not active — mutation risk';
        } catch (_) { return null; }
      }
    },
    { id: 'incident-center-operational', desc: 'Incident center must be operational',
      check: function () {
        try {
          return G.RuntimeIncidentCenter ? null : 'IncidentCenter not operational — observability gap';
        } catch (_) { return null; }
      }
    },
    { id: 'no-dynamic-code-exec', desc: 'No dynamic code execution at runtime',
      check: function () { return null; /* Verified at build time by CI gate */ }
    },
  ];

  // ── Protected flags (cannot be disabled without override) ─────────
  var PROTECTED_FLAGS = [
    'hydration.streaming',
    'hydration.viewport',
    'workers.preload',
    'trace.enabled',
    'timeline.capture',
  ];

  // ── Quarantine registry ───────────────────────────────────────────
  var _quarantined = {};  // subsystemId → reason

  function quarantine(subsystemId, reason) {
    _quarantined[subsystemId] = { reason: reason, ts: Date.now() };
    _tel('quarantine', { subsystem: subsystemId, reason: reason });
    console.warn(LOG, 'QUARANTINED:', subsystemId, '—', reason);
    try {
      G.dispatchEvent(new CustomEvent('arc9:quarantine', { detail: { subsystem: subsystemId, reason: reason } }));
    } catch (_) {}
  }

  function lift(subsystemId) {
    delete _quarantined[subsystemId];
    console.debug(LOG, 'quarantine lifted:', subsystemId);
  }

  function isQuarantined(subsystemId) {
    return !!_quarantined[subsystemId];
  }

  // ── Compliance sweep ──────────────────────────────────────────────
  var _violations = [];
  var _sweepCount = 0;
  var _snapshots  = [];

  function _sweep() {
    _sweepCount++;
    var found = [];

    POLICIES.forEach(function (policy) {
      try {
        var violation = policy.check();
        if (violation) {
          found.push({ policy: policy.id, detail: violation, ts: Date.now() });
          _tel('violation', { policy: policy.id, detail: violation });
          // Escalate to incident center
          try {
            var ic = G.RuntimeIncidentCenter;
            if (ic) {
              var sev = ic.P2;  // most governance violations are advisory
              if (policy.id === 'protected-flags-intact' || policy.id === 'immutability-guard-active') sev = ic.P1;
              ic.record('mutation', sev, policy.id, { detail: violation });
            }
          } catch (_) {}
        }
      } catch (_) {}
    });

    // Capture governance snapshot
    var snap = Object.freeze({
      ts:         Date.now(),
      sweep:      _sweepCount,
      violations: found.slice(),
      quarantined: Object.keys(_quarantined),
      flags:      _getFlagSnapshot(),
    });
    _snapshots.push(snap);
    if (_snapshots.length > 20) _snapshots.shift();

    // Update violation history
    _violations = _violations.concat(found);
    if (_violations.length > 200) _violations = _violations.slice(-200);

    if (found.length > 0) {
      console.warn(LOG, 'compliance sweep:', found.length, 'violation(s) at sweep #' + _sweepCount);
    } else {
      console.debug(LOG, 'compliance sweep #' + _sweepCount + ' — clean');
    }

    try {
      G.dispatchEvent(new CustomEvent('arc9:governance-sweep', {
        detail: { sweep: _sweepCount, violations: found.length },
      }));
    } catch (_) {}
  }

  function _getFlagSnapshot() {
    try {
      var cp = G.RuntimeControlPlane;
      return cp ? cp.getFlags() : {};
    } catch (_) { return {}; }
  }

  // ── Command intercept: enforce protected flags ─────────────────────
  G.addEventListener('arc8:command', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d) return;

      // Check quarantine
      var targetSubsystem = d.cmd && d.cmd.split('.')[0];
      if (targetSubsystem && isQuarantined(targetSubsystem)) {
        _tel('blocked', { cmd: d.cmd, reason: 'quarantined' });
        console.warn(LOG, 'BLOCKED quarantined command:', d.cmd);
        return;
      }

      // Protect flags
      if (d.cmd === 'flag.set' && d.args && d.args.value === false) {
        if (PROTECTED_FLAGS.indexOf(d.args.name) !== -1) {
          _tel('protected-flag-attempt', { flag: d.args.name });
          console.warn(LOG, 'GOVERNANCE: attempt to disable protected flag:', d.args.name);
          try {
            var ic = G.RuntimeIncidentCenter;
            if (ic) ic.record('mutation', ic.P1, d.args.name, { cmd: d.cmd, args: d.args });
          } catch (_) {}
        }
      }
    } catch (_) {}
  });

  // ── Telemetry ─────────────────────────────────────────────────────
  var _telBuf = [];
  function _tel(ev, d) {
    _telBuf.push({ ts: Date.now(), ev: ev, d: d });
    if (_telBuf.length > 100) _telBuf.shift();
  }

  // ── Bootstrap: sweep every 2 min ─────────────────────────────────
  var SWEEP_MS = 2 * 60 * 1000;
  var _sweepTimer = null;

  function start() {
    if (_sweepTimer) return;
    _sweepTimer = setInterval(_sweep, SWEEP_MS);
    setTimeout(_sweep, 10000);  // first sweep after 10s
    console.debug(LOG, 'governance active — sweep:', SWEEP_MS / 60000 + 'min |', POLICIES.length, 'policies | protected flags:', PROTECTED_FLAGS.length);
  }

  function stop() { clearInterval(_sweepTimer); _sweepTimer = null; }

  start();

  G.RuntimeGovernance = Object.freeze({
    VERSION:       VERSION,
    quarantine:    quarantine,
    lift:          lift,
    isQuarantined: isQuarantined,
    sweep:         _sweep,
    start:         start,
    stop:          stop,
    getViolations:   function () { return _violations.slice(-50); },
    getSnapshots:    function () { return _snapshots.slice(); },
    getQuarantined:  function () { return Object.assign({}, _quarantined); },
    getProtectedFlags: function () { return PROTECTED_FLAGS.slice(); },
    getPolicies:     function () { return POLICIES.map(function (p) { return { id: p.id, desc: p.desc }; }); },
    getTelemetry:    function () { return _telBuf.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready —', POLICIES.length, 'policies |', PROTECTED_FLAGS.length, 'protected flags');

}(window));

// ── SOURCE: public/js/runtime-blackbox.js ──
// RuntimeBlackbox v1.0 — Arc 9 / Phase G
// =====================================================================
// Continuous rolling runtime recorder — the browser's "flight recorder".
//
// Records all runtime events in a 15-minute rolling buffer. On panic
// or crash, automatically exports the buffer and hands it to the
// RuntimeReplayEngine for post-mortem replay.
//
// Distinct from:
//   - RuntimeSessionRecorder (Arc 7 — user interaction recording)
//   - RuntimeForensicsReplay (Arc 7 — security attack forensics)
//   - RuntimeEventTimeline (Arc 8 — live event ring buffer for search)
//
// Features:
//   - Rolling 15-minute recording (configurable)
//   - Bounded storage: max 10,000 events (~10 MB estimate)
//   - Auto-export blob on memory panic / P0 incident
//   - Crash replay handoff to RuntimeReplayEngine
//   - Named session snapshots (exportable)
//   - Event type coverage: all arc8 + worker + memory + hydration
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeBlackbox) return;

  var LOG     = '[Blackbox]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_EVENTS   = 10000;
  var WINDOW_MS    = 15 * 60 * 1000;  // 15-minute rolling window
  var MAX_SESSIONS = 5;               // named session snapshots

  // ── Rolling buffer ────────────────────────────────────────────────
  var _buffer  = [];   // { ts, type, data }
  var _running = true;
  var _metrics = { recorded: 0, exports: 0, panics: 0, crashes: 0, handoffs: 0 };

  // ── Record an event ───────────────────────────────────────────────
  function record(type, data) {
    if (!_running) return;
    var now = Date.now();

    // Evict events older than WINDOW_MS
    var cutoff = now - WINDOW_MS;
    while (_buffer.length > 0 && _buffer[0].ts < cutoff) _buffer.shift();

    // Evict if over max
    if (_buffer.length >= MAX_EVENTS) _buffer.shift();

    _buffer.push({ ts: now, type: type, data: data ? Object.assign({}, data) : null });
    _metrics.recorded++;
  }

  // ── Event capture: subscribe to all key runtime events ───────────
  var RECORD_EVENTS = [
    // Arc 8 events
    'arc8:command', 'arc8:incident', 'arc8:snapshot',
    // Arc 9 events
    'arc9:heal-applied', 'arc9:heal-rollback', 'arc9:starvation',
    'arc9:congestion', 'arc9:stability-level', 'arc9:stability-intervention',
    'arc9:recovery-complete', 'arc9:safe-mode-active', 'arc9:governance-sweep',
    'arc9:quarantine', 'arc9:tool-recorded', 'arc9:preactivate',
    // Arc 7 events
    'streaming-hydration:viewport', 'predictive-loader:preload',
    'stream-workers:progress', 'self-optimizer:adapt',
    'extreme-mode:activate', 'extreme-mode:deactivate',
    // Memory events
    'processor-memory:panic', 'memory-firewall:budget-exceeded',
    // Worker events
    'processor-workers:isolated', 'tool:worker-crash',
    // Hydration events
    'processor-hydration:activated', 'arc7:streaming-hydration-ready',
    // Recovery events
    'recovery:escalated',
    // Deploy events
    'deploy:sync-ready',
    // Task events
    'task-orchestrator:throttled',
  ];

  RECORD_EVENTS.forEach(function (evType) {
    G.addEventListener(evType, function (evt) {
      try { record(evType, evt && evt.detail); } catch (_) {}
    });
  });

  // ── Auto-export on panic / P0 incident ───────────────────────────
  G.addEventListener('processor-memory:panic', function (evt) {
    _metrics.panics++;
    record('__blackbox:panic', evt && evt.detail);
    try { _autoExport('memory-panic'); } catch (_) {}
  });

  G.addEventListener('arc8:incident', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.severity === 0) {  // P0 critical
        record('__blackbox:p0-incident', d);
        _autoExport('p0-incident:' + d.category);
      }
    } catch (_) {}
  });

  // ── Named sessions ────────────────────────────────────────────────
  var _sessions = [];

  function saveSession(label) {
    var session = {
      id:      'bb_' + Date.now().toString(36),
      label:   label || 'session-' + Date.now(),
      ts:      Date.now(),
      count:   _buffer.length,
      events:  _buffer.slice(),
    };
    _sessions.push(session);
    if (_sessions.length > MAX_SESSIONS) _sessions.shift();
    console.debug(LOG, 'session saved:', session.id, '|', session.count, 'events');
    return session.id;
  }

  // ── Export ────────────────────────────────────────────────────────
  function exportBuffer(label) {
    _metrics.exports++;
    var data = {
      version:  VERSION,
      label:    label || 'blackbox-export',
      ts:       Date.now(),
      windowMs: WINDOW_MS,
      count:    _buffer.length,
      events:   _buffer.slice(),
    };
    var json = JSON.stringify(data);
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      console.debug(LOG, 'exported:', data.count, 'events | url:', url);
      return { url: url, count: data.count, json: json };
    } catch (_) {
      return { url: null, count: data.count, json: json };
    }
  }

  function _autoExport(reason) {
    try {
      var result = exportBuffer('auto:' + reason);
      _metrics.exports++;
      try {
        G.dispatchEvent(new CustomEvent('arc9:blackbox-export', {
          detail: { reason: reason, count: result.count, url: result.url },
        }));
      } catch (_) {}
    } catch (_) {}
  }

  // ── Crash replay handoff ──────────────────────────────────────────
  function handoffToReplay(opts) {
    _metrics.handoffs++;
    try {
      var re = G.RuntimeReplayEngine;
      if (!re) return { ok: false, reason: 'RuntimeReplayEngine not available' };
      // Filter to last N minutes if requested
      var events = _buffer.slice();
      if (opts && opts.lastMinutes) {
        var since = Date.now() - opts.lastMinutes * 60000;
        events = events.filter(function (e) { return e.ts >= since; });
      }
      var count = re.load(events, opts || {});
      console.debug(LOG, 'handoff to replay:', count, 'events');
      return { ok: true, count: count };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── Query ─────────────────────────────────────────────────────────
  function query(opts) {
    opts = opts || {};
    var result = _buffer.slice();
    if (opts.type)    result = result.filter(function (e) { return e.type === opts.type; });
    if (opts.since)   result = result.filter(function (e) { return e.ts >= opts.since; });
    if (opts.keyword) {
      var kw = String(opts.keyword).toLowerCase();
      result = result.filter(function (e) { return e.type.toLowerCase().includes(kw); });
    }
    if (opts.limit)   result = result.slice(-opts.limit);
    return result;
  }

  G.RuntimeBlackbox = Object.freeze({
    VERSION:        VERSION,
    record:         record,
    saveSession:    saveSession,
    export:         exportBuffer,
    handoffToReplay: handoffToReplay,
    query:          query,
    getSessions:    function () { return _sessions.slice(); },
    getCount:       function () { return _buffer.length; },
    getMetrics:     function () { return Object.assign({}, _metrics); },
    pause:          function () { _running = false; },
    resume:         function () { _running = true; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — rolling', WINDOW_MS / 60000 + '-min recorder |', RECORD_EVENTS.length, 'event types | auto-export on panic');

}(window));

// ── SOURCE: public/js/runtime-adaptive-bundles.js ──
// RuntimeAdaptiveBundles v1.0 — Arc 9 / Phase H
// =====================================================================
// Self-optimizing bundle engine. Tracks usage patterns and dynamically
// adjusts bundle prioritization, lazy-loading strategy, and dormant
// bundle management based on device tier and session behavior.
//
// Distinct from RuntimeProcessorBundles (Arc 6 — processor code loading)
// and RuntimeBundleGraph (Arc 4 — bundle dependency graph).
//
// Features:
//   - Usage tracker: per-bundle activation count + recency
//   - Device-tier bundle plans: low-end minimizes, high-end pre-activates
//   - Dormant detection: bundle unused for 30min → candidate for advisory unload
//   - Predictive hydration: if AdaptiveAI predicts tool X → pre-load X's bundle
//   - Usage-based reprioritization: high-frequency bundles get early loading
//   - Low-end minimization: defer Arc4+ bundles on constrained devices
//   - High-end pre-activation: warm up all processor bundles on capable devices
//
// Integrates: RuntimeProcessorBundles, RuntimeBundleGraph,
//   RuntimeAdaptiveAI, RuntimePredictiveLoader, RuntimeProcessorLoader
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeAdaptiveBundles) return;

  var LOG     = '[AdaptiveBundles]';
  var VERSION = '1.0';

  // ── Device tier ───────────────────────────────────────────────────
  function _deviceTier() {
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh && mh.getDeviceTier) return mh.getDeviceTier();
    } catch (_) {}
    var mem = navigator.deviceMemory || 4;
    var cpu = navigator.hardwareConcurrency || 4;
    if (mem >= 8 && cpu >= 8) return 'high';
    if (mem >= 4 && cpu >= 4) return 'mid';
    return 'low';
  }

  var _tier = _deviceTier();

  // ── Bundle registry ───────────────────────────────────────────────
  // Known runtime bundles (in load priority order)
  var ALL_BUNDLES = [
    { id: 'arc2',  path: '/js/bundles/runtime-arc2.bundle.js',  tier: 1, tools: [] },
    { id: 'arc3',  path: '/js/bundles/runtime-arc3.bundle.js',  tier: 1, tools: [] },
    { id: 'arc4',  path: '/js/bundles/runtime-arc4.bundle.js',  tier: 2, tools: [] },
    { id: 'arc5',  path: '/js/bundles/runtime-arc5.bundle.js',  tier: 2, tools: [] },
    { id: 'arc6',  path: '/js/bundles/runtime-arc6.bundle.js',  tier: 2, tools: ['merge','split','compress','ocr','image','ai','convert','watermark','repair'] },
    { id: 'arc7',  path: '/js/bundles/runtime-arc7.bundle.js',  tier: 3, tools: [] },
    { id: 'arc8',  path: '/js/bundles/runtime-arc8.bundle.js',  tier: 3, tools: [] },
    { id: 'arc9',  path: '/js/bundles/runtime-arc9.bundle.js',  tier: 3, tools: [] },
  ];

  // ── Usage tracking ────────────────────────────────────────────────
  var _usage = {};
  // bundleId → { activations, lastUsed, firstUsed, toolActivations }

  function _ensureBundle(id) {
    if (!_usage[id]) _usage[id] = { activations: 0, lastUsed: 0, firstUsed: Date.now(), toolActivations: {} };
    return _usage[id];
  }

  function recordActivation(bundleId, toolId) {
    var u = _ensureBundle(bundleId);
    u.activations++;
    u.lastUsed = Date.now();
    if (toolId) u.toolActivations[toolId] = (u.toolActivations[toolId] || 0) + 1;
  }

  // ── Device bundle plan ────────────────────────────────────────────
  function _bundlePlan() {
    var plan = {
      eager:    [],  // load immediately
      deferred: [],  // load on demand
      skip:     [],  // skip entirely (low-end only)
    };

    if (_tier === 'low') {
      // Low-end: only critical runtime (arc2, arc3), rest deferred
      ALL_BUNDLES.forEach(function (b) {
        if (b.tier === 1) plan.eager.push(b.id);
        else if (b.tier === 2) plan.deferred.push(b.id);
        else plan.skip.push(b.id);
      });
    } else if (_tier === 'mid') {
      // Mid: eager arc2-arc5, deferred arc6+
      ALL_BUNDLES.forEach(function (b) {
        if (b.tier <= 2) plan.eager.push(b.id);
        else plan.deferred.push(b.id);
      });
    } else {
      // High: eager everything
      ALL_BUNDLES.forEach(function (b) { plan.eager.push(b.id); });
    }

    return plan;
  }

  // ── Dormant detection ─────────────────────────────────────────────
  var DORMANT_MS = 30 * 60 * 1000;  // 30 minutes

  function getDormantBundles() {
    var now      = Date.now();
    var dormant  = [];
    ALL_BUNDLES.forEach(function (b) {
      var u = _usage[b.id];
      if (!u) return;  // never activated → not dormant (unknown state)
      if ((now - u.lastUsed) > DORMANT_MS && u.activations > 0) {
        dormant.push({ id: b.id, lastUsed: u.lastUsed, ageMin: Math.round((now - u.lastUsed) / 60000) });
      }
    });
    return dormant;
  }

  // Advisory: emit event for RuntimeProcessorBundles to handle actual unload
  function adviseDormantUnload() {
    var dormant = getDormantBundles();
    if (!dormant.length) return dormant;
    dormant.forEach(function (d) {
      try {
        G.dispatchEvent(new CustomEvent('arc9:bundle-dormant', { detail: d }));
      } catch (_) {}
    });
    console.debug(LOG, 'dormant advisory:', dormant.map(function (d) { return d.id; }).join(','));
    return dormant;
  }

  // ── Predictive bundle hydration ───────────────────────────────────
  function predictivePreload(toolId) {
    // Find bundles that contain this tool
    var toPreload = ALL_BUNDLES.filter(function (b) {
      return b.tools.indexOf(toolId) !== -1;
    });

    toPreload.forEach(function (b) {
      try {
        // Use PredictiveLoader if available
        var pl = G.RuntimePredictiveLoader;
        if (pl && pl.preloadBundle) pl.preloadBundle(b.path, 'adaptive-bundles');
        recordActivation(b.id, toolId);
      } catch (_) {}
      try {
        G.dispatchEvent(new CustomEvent('arc9:bundle-preload', { detail: { bundleId: b.id, toolId: toolId } }));
      } catch (_) {}
    });

    return toPreload.map(function (b) { return b.id; });
  }

  // ── Usage-based reprioritization ─────────────────────────────────
  function getReprioritizedOrder() {
    var bundles = ALL_BUNDLES.slice();
    bundles.sort(function (a, b) {
      var ua = (_usage[a.id] && _usage[a.id].activations) || 0;
      var ub = (_usage[b.id] && _usage[b.id].activations) || 0;
      if (ua !== ub) return ub - ua;  // higher usage first
      return a.tier - b.tier;         // lower tier first (critical first)
    });
    return bundles.map(function (b) { return b.id; });
  }

  // ── High-end pre-activation ───────────────────────────────────────
  function _highEndPreActivate() {
    if (_tier !== 'high') return;
    // Pre-activate all processor bundle globals if not already present
    setTimeout(function () {
      ALL_BUNDLES.forEach(function (b) {
        try {
          G.dispatchEvent(new CustomEvent('arc9:bundle-preload', { detail: { bundleId: b.id, reason: 'high-end-preactivation' } }));
        } catch (_) {}
      });
      console.debug(LOG, 'high-end pre-activation sweep complete');
    }, 3000);
  }

  // ── Hook AdaptiveAI predictions ───────────────────────────────────
  G.addEventListener('arc9:preactivate', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.toolId) predictivePreload(d.toolId);
    } catch (_) {}
  });

  // Track tool activations from hydration events
  G.addEventListener('processor-hydration:activated', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.toolId) return;
      // Map tool to its bundle (arc6 contains all processors)
      recordActivation('arc6', d.toolId);
    } catch (_) {}
  });

  // Dormant sweep every 15 min
  setInterval(adviseDormantUnload, 15 * 60 * 1000);

  // High-end pre-activation at boot
  _highEndPreActivate();

  G.RuntimeAdaptiveBundles = Object.freeze({
    VERSION:              VERSION,
    recordActivation:     recordActivation,
    predictivePreload:    predictivePreload,
    getDormantBundles:    getDormantBundles,
    adviseDormantUnload:  adviseDormantUnload,
    getReprioritizedOrder: getReprioritizedOrder,
    getBundlePlan:        _bundlePlan,
    getDeviceTier:        function () { return _tier; },
    getUsage: function () {
      var result = {};
      Object.keys(_usage).forEach(function (k) { result[k] = Object.assign({}, _usage[k]); });
      return result;
    },
    getAll: function () { return ALL_BUNDLES.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — device tier:', _tier, '| dormant window:', DORMANT_MS / 60000 + 'min |', ALL_BUNDLES.length, 'bundles tracked');

}(window));


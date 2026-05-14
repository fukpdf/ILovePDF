// Runtime Health Monitor v1.0 — Phase 2 (T031)
// Continuous runtime health monitoring. Detects worker leaks, memory leaks,
// stalled tasks, blocked UI, runaway retries, queue congestion, and
// degradation escalation. Emits scored health events.
//
// Health score: 0–100 (100 = perfect, 0 = critical failure)
// Runs an interval-based check every HEALTH_CHECK_MS (default 30 s).
//
// Integrates: RuntimeState, RuntimeTelemetry, RuntimeEventBus, RuntimeMemory,
//             RuntimeWorkers, RuntimeScheduler, RuntimeQueue, RuntimeProgress,
//             WorkerLeakDetector, DeadlockMonitor, Phase1CAudit
//
// [FUTURE: PredictiveHealth] Health scores will feed an ML predictor that
// warns of impending failures 30–60 s before they occur, enabling proactive
// worker recycling and memory reclamation.
//
// Exposed as: window.RuntimeHealth
(function () {
  'use strict';

  if (window.RuntimeHealth) return;

  var LOG = '[RHM]';

  var HEALTH_CHECK_MS = 30000; // 30 s

  // ── Health score ledger ────────────────────────────────────────────────────
  // Each check produces deductions from 100 based on detected issues.
  var _score     = 100;
  var _lastCheck = 0;
  var _history   = [];   // last 20 snapshots
  var MAX_HISTORY = 20;

  var _subscribers = new Set();

  // ── Anomaly detectors ─────────────────────────────────────────────────────

  function _checkWorkers() {
    var issues = [];
    var deduction = 0;

    if (window.WorkerLeakDetector && window.WorkerLeakDetector.getStats) {
      try {
        var wld = window.WorkerLeakDetector.getStats();
        if (wld.zombies > 0) {
          issues.push('zombie-workers:' + wld.zombies);
          deduction += Math.min(wld.zombies * 10, 30);
          if (window.RuntimeTelemetry) {
            try { window.RuntimeTelemetry.record('worker:zombie', { count: wld.zombies }); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    if (window.RuntimeWorkers && window.RuntimeWorkers.getStats) {
      try {
        var rws = window.RuntimeWorkers.getStats();
        if (rws.cooldowns > 3) {
          issues.push('worker-cooldowns:' + rws.cooldowns);
          deduction += 10;
        }
        if (rws.inflight > 8) {
          issues.push('worker-inflight-high:' + rws.inflight);
          deduction += 5;
        }
      } catch (_) {}
    }

    return { deduction: deduction, issues: issues };
  }

  function _checkMemory() {
    var issues = [];
    var deduction = 0;

    if (window.RuntimeMemory) {
      try {
        var tier = window.RuntimeMemory.getTier();
        if (tier === 'EMERGENCY') { issues.push('memory-emergency'); deduction += 40; }
        else if (tier === 'CRITICAL') { issues.push('memory-critical'); deduction += 25; }
        else if (tier === 'WARNING')  { issues.push('memory-warning');  deduction += 10; }
      } catch (_) {}
    }

    if (window.MemPressure && window.MemPressure.stats) {
      try {
        var ms = window.MemPressure.stats();
        if (ms.pct >= 90) { issues.push('heap-' + ms.pct + '%'); deduction += 15; }
      } catch (_) {}
    }

    return { deduction: deduction, issues: issues };
  }

  function _checkTasks() {
    var issues = [];
    var deduction = 0;

    if (window.RuntimeProgress && window.RuntimeProgress.getStats) {
      try {
        var ps = window.RuntimeProgress.getStats();
        var stalledCount = ps.tasks.filter(function (t) { return t.stalled; }).length;
        if (stalledCount > 0) {
          issues.push('stalled-tasks:' + stalledCount);
          deduction += stalledCount * 15;
        }
        if (ps.activeTasks > 5) {
          issues.push('task-pileup:' + ps.activeTasks);
          deduction += 5;
        }
      } catch (_) {}
    }

    if (window.RuntimeScheduler && window.RuntimeScheduler.getStats) {
      try {
        var ss = window.RuntimeScheduler.getStats();
        if (ss.waitQueueSize > 10) {
          issues.push('queue-congestion:' + ss.waitQueueSize);
          deduction += 10;
        }
      } catch (_) {}
    }

    return { deduction: deduction, issues: issues };
  }

  function _checkRetries() {
    var issues = [];
    var deduction = 0;

    if (window.RetryOrchestrator && window.RetryOrchestrator.getStats) {
      try {
        var rs = window.RetryOrchestrator.getStats();
        if (rs.inCooldown) { issues.push('retry-storm'); deduction += 20; }
        if (rs.stormRingSize > 5) { issues.push('retry-high:' + rs.stormRingSize); deduction += 5; }
      } catch (_) {}
    }

    return { deduction: deduction, issues: issues };
  }

  function _checkDeadlocks() {
    var issues = [];
    var deduction = 0;

    if (window.DeadlockMonitor && window.DeadlockMonitor.getStats) {
      try {
        var ds = window.DeadlockMonitor.getStats();
        if (ds.deadlocksDetected > 0) {
          issues.push('deadlocks:' + ds.deadlocksDetected);
          deduction += 30;
        }
      } catch (_) {}
    }

    return { deduction: deduction, issues: issues };
  }

  function _checkSession() {
    var issues = [];
    var deduction = 0;

    if (window.RuntimeState) {
      try {
        var ageMin = Math.round(window.RuntimeState.sessionAgeMs() / 60000);
        if (ageMin > 120) { issues.push('session-very-long:' + ageMin + 'min'); deduction += 5; }
        else if (ageMin > 60) { issues.push('session-long:' + ageMin + 'min'); deduction += 2; }

        var mode = window.RuntimeState.get('runtimeMode');
        if (mode === 'emergency') { issues.push('runtime-emergency-mode'); deduction += 20; }
        else if (mode === 'degraded') { issues.push('runtime-degraded-mode'); deduction += 5; }
      } catch (_) {}
    }

    return { deduction: deduction, issues: issues };
  }

  // ── Full health check ─────────────────────────────────────────────────────
  function check() {
    var ts = Date.now();
    var allIssues = [];
    var totalDeduction = 0;

    var checks = [
      _checkWorkers(),
      _checkMemory(),
      _checkTasks(),
      _checkRetries(),
      _checkDeadlocks(),
      _checkSession(),
    ];

    checks.forEach(function (r) {
      totalDeduction += r.deduction;
      allIssues = allIssues.concat(r.issues);
    });

    var newScore = Math.max(0, Math.min(100, 100 - totalDeduction));
    var prevScore = _score;
    _score     = newScore;
    _lastCheck = ts;

    var snapshot = {
      ts:       ts,
      score:    newScore,
      issues:   allIssues,
      degraded: newScore < 70,
    };

    _history.push(snapshot);
    if (_history.length > MAX_HISTORY) _history.shift();

    // Update RuntimeState
    if (window.RuntimeState) {
      try {
        window.RuntimeState.set('healthScore', newScore);
        window.RuntimeState.set('lastHealthCheck', ts);
      } catch (_) {}
    }

    // Emit events
    if (window.RuntimeEventBus) {
      try {
        if (newScore < 50) {
          window.RuntimeEventBus.emit('health:degraded', snapshot);
        } else if (prevScore < 50 && newScore >= 50) {
          window.RuntimeEventBus.emit('health:recovered', snapshot);
        }
      } catch (_) {}
    }

    // Telemetry
    if (window.RuntimeTelemetry && allIssues.length > 0) {
      try { window.RuntimeTelemetry.record('health:check', { score: newScore, issues: allIssues.length }); } catch (_) {}
    }

    // Notify subscribers
    _subscribers.forEach(function (fn) {
      try { fn(snapshot); } catch (_) {}
    });

    // Console output (only when degraded or recovering)
    if (newScore < 80 || (prevScore < 80 && newScore >= 80)) {
      var level = newScore < 50 ? 'warn' : 'debug';
      console[level](LOG, 'score:', newScore + '/100',
        allIssues.length ? '— issues: ' + allIssues.join(', ') : '— recovering');
    }

    return snapshot;
  }

  // ── Auto-remediation ──────────────────────────────────────────────────────
  // On very poor health, trigger lightweight remediation.
  function _autoRemediate(snapshot) {
    if (snapshot.score >= 50) return;
    // Terminate zombie workers
    if (window.WorkerLeakDetector && window.WorkerLeakDetector.terminateZombies) {
      try { window.WorkerLeakDetector.terminateZombies(); } catch (_) {}
    }
    // Light cleanup
    if (window.RuntimeCleanup && window.RuntimeCleanup.lightCleanup) {
      try { window.RuntimeCleanup.lightCleanup('health-remediation'); } catch (_) {}
    }
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('health:auto-remediate', { score: snapshot.score }); } catch (_) {}
    }
  }

  // ── Monitor loop ──────────────────────────────────────────────────────────
  var _monitorId = null;

  function startMonitor(intervalMs) {
    if (_monitorId) return;
    intervalMs = intervalMs || HEALTH_CHECK_MS;
    _monitorId = setInterval(function () {
      try {
        var snap = check();
        _autoRemediate(snap);
      } catch (e) {
        console.warn(LOG, 'monitor error:', e.message);
      }
    }, intervalMs);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval('rhm-monitor', _monitorId);
  }

  function stopMonitor() {
    if (_monitorId) { clearInterval(_monitorId); _monitorId = null; }
  }

  // ── Subscription ──────────────────────────────────────────────────────────
  function onHealthChange(fn) {
    if (typeof fn !== 'function') return function () {};
    _subscribers.add(fn);
    return function () { _subscribers.delete(fn); };
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      score:      _score,
      lastCheck:  _lastCheck,
      history:    _history.slice(-5),
      monitoring: !!_monitorId,
    };
  }

  startMonitor();

  window.addEventListener('pagehide', function () {
    stopMonitor();
    _subscribers.clear();
  }, { passive: true });

  window.RuntimeHealth = {
    check:           check,
    startMonitor:    startMonitor,
    stopMonitor:     stopMonitor,
    onHealthChange:  onHealthChange,
    getScore:        function () { return _score; },
    getHistory:      function () { return _history.slice(); },
    getStats:        getStats,
  };

  console.debug('[RuntimeHealth] ready — T031 health monitor active');
}());

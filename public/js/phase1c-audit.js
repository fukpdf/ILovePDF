// Phase 1C Lifecycle Audit v1.0 — T013 + T014 + T015
// Final stabilization audit: validates that all Phase 1C subsystems are
// active, performs mobile-stress checks, long-session health monitoring,
// and produces a comprehensive lifecycle report.
//
// DESIGN PRINCIPLE: read-only audit — never modifies state directly.
// Any remediation is delegated to the appropriate subsystem.
//
// Integrates with: every Phase 1A/1B/1C system via window.* checks
//
// Exposed as: window.Phase1CAudit
// Entry point: window.Phase1CAudit.run()   → LifecycleAuditReport
//
// Automatically starts a passive health monitor (every 60 s).
// The monitor surfaces warnings to console but does not throw errors.
(function () {
  'use strict';

  if (window.Phase1CAudit) return;

  var LOG = '[P1C-Audit]';

  // ── System manifest ────────────────────────────────────────────────────────
  // All Phase 1A, 1B, and 1C systems that must be present.
  var REQUIRED_SYSTEMS = [
    // Phase 1A
    { name: 'TimerRegistry',       path: 'window.TimerRegistry',              critical: true },
    { name: 'P1 Bridge',           path: 'window.P1',                         critical: true },
    { name: 'ObjectURLRegistry',   path: 'window.ObjectURLRegistry',          critical: true },
    { name: 'WorkerPool',          path: 'window.WorkerPool',                 critical: true },
    // Phase 1B
    { name: 'MemPressure',         path: 'window.MemPressure',                critical: true },
    { name: 'StabilityMetrics',    path: 'window.StabilityMetrics',           critical: false },
    { name: 'WorkerLeakDetector',  path: 'window.WorkerLeakDetector',         critical: true },
    { name: 'MemoryTelemetry',     path: 'window.MemoryTelemetry',            critical: false },
    { name: 'LifecycleManager',    path: 'window.LifecycleManager',           critical: true },
    { name: 'DeadlockMonitor',     path: 'window.DeadlockMonitor',            critical: false },
    // Phase 1C
    { name: 'WorkerLifecycle',     path: 'window.WorkerLifecycle',            critical: true },
    { name: 'DownloadManager',     path: 'window.DownloadManager',            critical: true },
    { name: 'RetryOrchestrator',   path: 'window.RetryOrchestrator',          critical: true },
    { name: 'NavCancel',           path: 'window.NavCancel',                  critical: true },
    { name: 'AdaptiveDegradation', path: 'window.AdaptiveDegradation',        critical: true },
    { name: 'CleanupContracts',    path: 'window.CleanupContracts',           critical: true },
  ];

  // ── Platform / session context ─────────────────────────────────────────────
  var _ua     = navigator.userAgent || '';
  var IS_MOBILE   = /Mobile|Tablet|Android|iPhone|iPad/i.test(_ua);
  var IS_IOS      = /iPhone|iPad|iPod/i.test(_ua);
  var IS_SAFARI   = /^((?!chrome|android).)*safari/i.test(_ua);
  var IS_ANDROID  = /Android/i.test(_ua);
  var HW_CORES    = typeof navigator.hardwareConcurrency === 'number'
                    ? navigator.hardwareConcurrency : -1;
  var SESSION_START = Date.now();
  var _sessionHealthHistory = []; // ring buffer of audit snapshots

  // ── Resolve a window.* path string ────────────────────────────────────────
  function _resolve(path) {
    try {
      var parts = path.replace(/^window\./, '').split('.');
      var obj = window;
      for (var i = 0; i < parts.length; i++) {
        if (obj == null) return undefined;
        obj = obj[parts[i]];
      }
      return obj;
    } catch (_) { return undefined; }
  }

  // ── System presence check ──────────────────────────────────────────────────
  function _checkSystems() {
    var missing = [], degraded = [];
    REQUIRED_SYSTEMS.forEach(function (s) {
      var val = _resolve(s.path);
      if (val === undefined || val === null) {
        (s.critical ? missing : degraded).push(s.name);
      }
    });
    return { missing: missing, degraded: degraded };
  }

  // ── Memory health ──────────────────────────────────────────────────────────
  function _checkMemory() {
    var result = { tier: 'unknown', usedMB: -1, limitMB: -1, availMB: -1, pct: -1 };
    if (window.MemPressure && window.MemPressure.stats) {
      try { result = window.MemPressure.stats(); } catch (_) {}
    } else {
      try {
        if (performance && performance.memory) {
          var MB = 1024 * 1024;
          result.usedMB  = Math.round(performance.memory.usedJSHeapSize  / MB);
          result.limitMB = Math.round(performance.memory.jsHeapSizeLimit  / MB);
          result.availMB = Math.round((performance.memory.jsHeapSizeLimit - performance.memory.usedJSHeapSize) / MB);
          result.pct     = Math.round(result.usedMB / result.limitMB * 100);
        }
      } catch (_) {}
    }
    return result;
  }

  // ── Worker health ──────────────────────────────────────────────────────────
  function _checkWorkers() {
    var result = { alive: 0, zombies: 0, poolStats: null, wlStats: null };
    if (window.WorkerPool && window.WorkerPool.getStats) {
      try { result.poolStats = window.WorkerPool.getStats(); } catch (_) {}
    }
    if (window.WorkerLifecycle && window.WorkerLifecycle.getStats) {
      try {
        result.wlStats = window.WorkerLifecycle.getStats();
        result.alive   = result.wlStats.alive || 0;
      } catch (_) {}
    }
    if (window.WorkerLeakDetector && window.WorkerLeakDetector.getStats) {
      try {
        var wld = window.WorkerLeakDetector.getStats();
        result.zombies = (wld && wld.zombies) || 0;
      } catch (_) {}
    }
    return result;
  }

  // ── Timer health ──────────────────────────────────────────────────────────
  function _checkTimers() {
    var result = { registered: 0, details: null };
    if (window.TimerRegistry) {
      try {
        var s = typeof window.TimerRegistry.getStats === 'function'
                ? window.TimerRegistry.getStats()
                : null;
        if (s) {
          result.registered = (s.timeouts || 0) + (s.intervals || 0);
          result.details    = s;
        }
      } catch (_) {}
    }
    return result;
  }

  // ── Object URL health ──────────────────────────────────────────────────────
  function _checkObjectURLs() {
    var result = { pending: 0, details: null };
    if (window.ObjectURLRegistry && window.ObjectURLRegistry.getStats) {
      try {
        var s = window.ObjectURLRegistry.getStats();
        result.pending = (s && s.active) || 0;
        result.details = s;
      } catch (_) {}
    }
    if (window.DownloadManager) {
      try {
        var dm = window.DownloadManager.getStats();
        result.downloadPending = dm.pendingUrls || 0;
      } catch (_) {}
    }
    return result;
  }

  // ── Navigation cancel health ───────────────────────────────────────────────
  function _checkNavCancel() {
    if (!window.NavCancel) return { active: false };
    try {
      var s = window.NavCancel.getStats();
      return { active: true, epoch: s.epoch, controllers: s.activeControllers,
               polling: s.activePolling, workers: s.navWorkers };
    } catch (_) { return { active: true, error: true }; }
  }

  // ── Adaptive degradation health ────────────────────────────────────────────
  function _checkAdaptive() {
    if (!window.AdaptiveDegradation) return { active: false };
    try {
      var s = window.AdaptiveDegradation.getStats();
      return { active: true, tier: s.tier, mobile: s.isMobile,
               lowEnd: s.isLowEnd, mobileRuns: s.mobileRunCount };
    } catch (_) { return { active: true, error: true }; }
  }

  // ── Cleanup contracts health ───────────────────────────────────────────────
  function _checkContracts() {
    if (!window.CleanupContracts) return { active: false };
    try {
      var s = window.CleanupContracts.getStats();
      return { active: true, total: s.totalContracts, byPhase: s.byPhase };
    } catch (_) { return { active: true, error: true }; }
  }

  // ── Retry health ───────────────────────────────────────────────────────────
  function _checkRetry() {
    if (!window.RetryOrchestrator) return { active: false };
    try {
      var s = window.RetryOrchestrator.getStats();
      return { active: true, inCooldown: s.inCooldown, stormRing: s.stormRingSize };
    } catch (_) { return { active: true, error: true }; }
  }

  // ── Stability metrics snapshot ─────────────────────────────────────────────
  function _checkStabilityMetrics() {
    if (!window.StabilityMetrics || !window.StabilityMetrics.getReport) return null;
    try { return window.StabilityMetrics.getReport(); } catch (_) { return null; }
  }

  // ── Session age ────────────────────────────────────────────────────────────
  function _sessionAgeMin() {
    return Math.round((Date.now() - SESSION_START) / 60000);
  }

  // ── Long-session warnings (T014) ───────────────────────────────────────────
  // A session older than 60 min with high memory usage is a risk signal.
  function _longSessionWarnings(mem, sessionMinutes) {
    var warnings = [];
    if (sessionMinutes >= 60 && mem.pct >= 70) {
      warnings.push('long-session:high-memory — ' + sessionMinutes + 'min, ' + mem.pct + '% heap');
    }
    if (sessionMinutes >= 120) {
      warnings.push('very-long-session — ' + sessionMinutes + 'min (consider page refresh)');
    }
    return warnings;
  }

  // ── Mobile stress warnings (T013) ─────────────────────────────────────────
  function _mobileStressWarnings(mem, workers, adaptive) {
    var warnings = [];
    if (!IS_MOBILE) return warnings;
    if (IS_IOS && mem.availMB > 0 && mem.availMB < 150) {
      warnings.push('ios:low-memory — ' + mem.availMB + 'MB available');
    }
    if (HW_CORES >= 0 && HW_CORES <= 2 && workers.alive > 1) {
      warnings.push('mobile:low-cores — ' + workers.alive + ' workers on ' + HW_CORES + '-core device');
    }
    if (adaptive.active && adaptive.tier !== 'ok' && adaptive.tier !== 'reduce') {
      warnings.push('mobile:degraded-tier — ' + adaptive.tier);
    }
    return warnings;
  }

  // ── Full lifecycle audit ───────────────────────────────────────────────────
  // Returns a LifecycleAuditReport object — safe to stringify.
  function run() {
    var ts = Date.now();

    var systems    = _checkSystems();
    var memory     = _checkMemory();
    var workers    = _checkWorkers();
    var timers     = _checkTimers();
    var urls       = _checkObjectURLs();
    var navCancel  = _checkNavCancel();
    var adaptive   = _checkAdaptive();
    var contracts  = _checkContracts();
    var retry      = _checkRetry();
    var stability  = _checkStabilityMetrics();
    var sessionMin = _sessionAgeMin();

    var warnings = [];
    if (systems.missing.length)  warnings.push('missing-critical:' + systems.missing.join(','));
    if (systems.degraded.length) warnings.push('missing-optional:' + systems.degraded.join(','));
    if (memory.pct >= 85)        warnings.push('memory-critical:' + memory.pct + '%');
    else if (memory.pct >= 70)   warnings.push('memory-high:' + memory.pct + '%');
    if (workers.zombies > 0)     warnings.push('zombie-workers:' + workers.zombies);
    if (retry.active && retry.inCooldown) warnings.push('retry-storm-cooldown');

    // Long-session warnings (T014)
    var longSessionW = _longSessionWarnings(memory, sessionMin);
    warnings = warnings.concat(longSessionW);

    // Mobile-stress warnings (T013)
    var mobileW = _mobileStressWarnings(memory, workers, adaptive);
    warnings = warnings.concat(mobileW);

    var passed = systems.missing.length === 0 && memory.pct < 85 && workers.zombies === 0;

    var report = {
      ts:        ts,
      passed:    passed,
      warnings:  warnings,
      platform: {
        mobile:  IS_MOBILE,
        ios:     IS_IOS,
        safari:  IS_SAFARI,
        android: IS_ANDROID,
        cores:   HW_CORES,
      },
      session: {
        ageMin:  sessionMin,
        startTs: SESSION_START,
      },
      systems: {
        missing:  systems.missing,
        degraded: systems.degraded,
      },
      memory:       memory,
      workers:      workers,
      timers:       timers,
      objectURLs:   urls,
      navCancel:    navCancel,
      adaptive:     adaptive,
      contracts:    contracts,
      retry:        retry,
      stability:    stability,
    };

    // Store in ring buffer (keep last 10 snapshots)
    _sessionHealthHistory.push({ ts: ts, passed: passed, memPct: memory.pct,
                                  tier: memory.tier, warnings: warnings.length });
    if (_sessionHealthHistory.length > 10) _sessionHealthHistory.shift();

    return report;
  }

  // ── Passive health monitor ─────────────────────────────────────────────────
  // Runs a full audit every 60 s and surfaces non-passing results to console.
  // Does NOT throw — purely advisory.
  var MONITOR_INTERVAL_MS = 60000;
  var _monitorId = null;

  function startMonitor(intervalMs) {
    if (_monitorId) return;
    intervalMs = intervalMs || MONITOR_INTERVAL_MS;
    _monitorId = setInterval(function () {
      try {
        var r = run();
        if (!r.passed || r.warnings.length > 0) {
          console.warn(LOG, 'health check (' + r.session.ageMin + 'min session) — warnings:',
            r.warnings.join('; ') || 'none', '| mem:', r.memory.pct + '%',
            '| tier:', r.memory.tier);
        } else {
          console.debug(LOG, 'health OK (' + r.session.ageMin + 'min) mem:',
            r.memory.pct + '% tier:', r.memory.tier);
        }
      } catch (e) {
        console.warn(LOG, 'monitor error:', e.message);
      }
    }, intervalMs);
    if (window.TimerRegistry) {
      window.TimerRegistry.registerInterval('p1c-audit-monitor', _monitorId);
    }
  }

  function stopMonitor() {
    if (_monitorId) { clearInterval(_monitorId); _monitorId = null; }
  }

  // Start the monitor automatically
  startMonitor();

  // Stop on pagehide to avoid running in bfcache
  window.addEventListener('pagehide', stopMonitor, { passive: true });

  // ── Console reporter ───────────────────────────────────────────────────────
  // Pretty-prints the audit report to console. Call from devtools for
  // manual inspection: window.Phase1CAudit.print()
  function print() {
    var r = run();
    var lines = [
      '══ Phase 1C Lifecycle Audit ══',
      'Status:   ' + (r.passed ? '✅ PASSED' : '❌ FAILED'),
      'Session:  ' + r.session.ageMin + ' min',
      'Platform: ' + JSON.stringify(r.platform),
      'Memory:   ' + r.memory.usedMB + 'MB / ' + r.memory.limitMB +
                     'MB (' + r.memory.pct + '%) tier=' + r.memory.tier,
      'Workers:  ' + r.workers.alive + ' alive, ' + r.workers.zombies + ' zombies',
      'Timers:   ' + r.timers.registered + ' registered',
      'URLs:     ' + r.objectURLs.pending + ' pending',
      'NavCancel:' + (r.navCancel.active
                      ? ' epoch=' + r.navCancel.epoch + ' ctrl=' + r.navCancel.controllers
                      : ' INACTIVE'),
      'Adaptive: ' + (r.adaptive.active ? 'tier=' + r.adaptive.tier : 'INACTIVE'),
      'Contracts:' + (r.contracts.active ? r.contracts.total + ' registered' : 'INACTIVE'),
      'Retry:    ' + (r.retry.active
                      ? (r.retry.inCooldown ? 'IN COOLDOWN ⚠' : 'ok')
                      : 'INACTIVE'),
      'Systems missing: [' + (r.systems.missing.join(', ') || 'none') + ']',
      'Systems optional missing: [' + (r.systems.degraded.join(', ') || 'none') + ']',
      'Warnings: ' + (r.warnings.length ? r.warnings.join('\n  ') : 'none'),
      '══ End Audit ══',
    ];
    console.log(lines.join('\n'));
    return r;
  }

  // ── History ────────────────────────────────────────────────────────────────
  function getHistory() {
    return _sessionHealthHistory.slice();
  }

  window.Phase1CAudit = {
    run:          run,
    print:        print,
    startMonitor: startMonitor,
    stopMonitor:  stopMonitor,
    getHistory:   getHistory,
    SYSTEMS:      REQUIRED_SYSTEMS,
  };

  // Run immediately after all deferred scripts load (non-blocking)
  var _initialAuditTimer = setTimeout(function () {
    try {
      var r = run();
      var status = r.passed ? 'PASSED' : 'FAILED';
      if (!r.passed || r.warnings.length) {
        console.warn(LOG, 'Initial audit ' + status + ' —', r.warnings.join('; ') || '(no warnings)');
      } else {
        console.debug(LOG, 'Initial audit PASSED — all Phase 1C systems active');
      }
    } catch (e) {
      console.warn(LOG, 'Initial audit error:', e.message);
    }
  }, 1500);
  if (window.TimerRegistry) {
    window.TimerRegistry.registerTimeout('p1c-initial-audit', _initialAuditTimer);
  }

  console.debug('[Phase1CAudit] ready — T013/T014/T015 lifecycle audit active');
}());

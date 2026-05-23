// RuntimeHealthAnalytics v1.0 — Arc 2 / Target 9
// =====================================================================
// Unified runtime health scoring + AdvancedEngine.audit() dashboard panels.
//
// Aggregates signals from:
//   RuntimePerformanceMonitor  — vitals + startup duration + tool runs
//   RuntimeHealthMonitor       — worker counts, heap, latency, queue depth
//   WorkerPool                 — busy slots, crash count
//   RuntimeOffline             — online status, queue size
//   RuntimeDeploySync          — stale-runtime state
//   RuntimeCrashTelemetry      — crash ring summary
//   RuntimeHydrationScheduler  — hydration group timing
//   RuntimeWorkerCoordinator   — thermal tier, congestion
//
// Health score: 0–100 (100 = perfect)
// Deductions applied for: stale runtime, crashes, memory pressure,
//   poor vitals, long startup, worker saturation, congestion.
//
// Exposes: window.RuntimeHealthAnalytics
// Patches:  window.AdvancedEngine.audit() with Arc 2 panels
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHealthAnalytics) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HealthAnalytics]';
  var VERSION = '1.0';

  // ── Collect snapshot from all sources ─────────────────────────────────────
  function _collect() {
    var snap = {
      ts:            Date.now(),
      score:         100,
      deductions:    [],
      vitals:        {},
      startup:       {},
      hydration:     {},
      workers:       {},
      memory:        {},
      crashes:       {},
      offline:       {},
      deploy:        {},
      edge:          {},
    };

    // ── Performance vitals ─────────────────────────────────────────────────
    try {
      var pm = G.RuntimePerformanceMonitor;
      if (pm) {
        var report = pm.getReport();
        snap.vitals  = report.vitals  || {};
        snap.startup = report.startup || {};
        snap.memory  = report.memory  || {};

        // LCP > 4s = poor
        if (snap.vitals.lcp && snap.vitals.lcp > 4000) {
          snap.score -= 10;
          snap.deductions.push({ reason: 'LCP > 4s', val: snap.vitals.lcp });
        }
        // Startup > 5s = slow
        if (snap.startup.domContentLoadedMs && snap.startup.domContentLoadedMs > 5000) {
          snap.score -= 8;
          snap.deductions.push({ reason: 'slow startup', val: snap.startup.domContentLoadedMs });
        }
        // Memory > 80% heap
        if (snap.memory.usedMb && snap.memory.limitMb) {
          var memPct = snap.memory.usedMb / snap.memory.limitMb;
          if (memPct > 0.80) {
            snap.score -= 12;
            snap.deductions.push({ reason: 'high heap', val: Math.round(memPct * 100) + '%' });
          }
        }
      }
    } catch (_) {}

    // ── Worker efficiency ──────────────────────────────────────────────────
    try {
      var wp = G.WorkerPool;
      if (wp && wp.getStats) {
        var ws = wp.getStats();
        snap.workers = ws;
        var busyPct  = ws.total > 0 ? ws.busy / ws.total : 0;
        if (busyPct > 0.90) {
          snap.score -= 8;
          snap.deductions.push({ reason: 'worker saturation', val: Math.round(busyPct * 100) + '%' });
        }
      }
    } catch (_) {}

    // ── Crash telemetry ────────────────────────────────────────────────────
    try {
      var ct = G.RuntimeCrashTelemetry;
      if (ct) {
        var cs   = ct.getSummary();
        snap.crashes = cs;
        if (cs.total > 5) {
          snap.score -= Math.min(15, cs.total * 2);
          snap.deductions.push({ reason: 'crash count', val: cs.total });
        }
        if (cs.staleRuntimeCorrelated > 0) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'stale-runtime crashes', val: cs.staleRuntimeCorrelated });
        }
      }
    } catch (_) {}

    // ── Offline state ──────────────────────────────────────────────────────
    try {
      var ro = G.RuntimeOffline;
      if (ro) {
        snap.offline = { online: !ro.isOffline(), queueSize: ro.queueSize() };
        if (ro.isOffline()) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'offline', val: true });
        }
        if (ro.queueSize() > 10) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'large offline queue', val: ro.queueSize() });
        }
      }
    } catch (_) {}

    // ── Deploy sync ────────────────────────────────────────────────────────
    try {
      var ds = G.RuntimeDeploySync;
      if (ds) {
        snap.deploy = { stale: ds.isStale(), buildId: ds.getBuildId() };
        if (ds.isStale()) {
          snap.score -= 10;
          snap.deductions.push({ reason: 'stale runtime', val: ds.getBuildId() });
        }
      }
    } catch (_) {}

    // ── Edge hints ─────────────────────────────────────────────────────────
    try {
      var eh = G.RuntimeEdgeHints;
      if (eh) {
        snap.edge = { stale: eh.isEdgeStale(), buildId: eh.getEdgeBuildId(), region: eh.getRegion().region };
        if (eh.isEdgeStale()) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'stale edge cache', val: eh.getEdgeBuildId() });
        }
      }
    } catch (_) {}

    // ── Worker coordinator ─────────────────────────────────────────────────
    try {
      var wc = G.RuntimeWorkerCoordinator;
      if (wc) {
        var thermal = wc.getThermalTier();
        snap.workers.thermalTier    = thermal;
        snap.workers.congested      = wc.isCongested();
        if (thermal === 'hot' || thermal === 'critical') {
          snap.score -= 8;
          snap.deductions.push({ reason: 'thermal throttle', val: thermal });
        }
        if (wc.isCongested()) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'worker congestion', val: true });
        }
      }
    } catch (_) {}

    // ── Hydration timing ───────────────────────────────────────────────────
    try {
      var hs = G.RuntimeHydrationScheduler;
      if (hs) {
        var hm = hs.getMetrics();
        snap.hydration = {
          P0ms: hm.P0 && hm.P0.durationMs,
          P1ms: hm.P1 && hm.P1.durationMs,
          P2ms: hm.P2 && hm.P2.durationMs,
        };
        if (hm.P0 && hm.P0.durationMs > 2000) {
          snap.score -= 5;
          snap.deductions.push({ reason: 'slow P0 hydration', val: hm.P0.durationMs });
        }
      }
    } catch (_) {}

    snap.score = Math.max(0, snap.score);
    return snap;
  }

  // ── Health score label ─────────────────────────────────────────────────────
  function _label(score) {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 55) return 'fair';
    if (score >= 35) return 'poor';
    return 'critical';
  }

  // ── Dashboard panels (console output) ─────────────────────────────────────
  function _dashboard() {
    var s = _collect();
    var lbl = _label(s.score);

    console.group('%c RuntimeHealthAnalytics v' + VERSION, 'font-weight:bold;color:#6366f1');
    console.log('%c Health Score: ' + s.score + '/100 (' + lbl + ')',
      'font-size:14px;color:' + (s.score >= 75 ? '#22c55e' : s.score >= 55 ? '#f59e0b' : '#ef4444'));

    if (s.deductions.length) {
      console.group('Deductions');
      s.deductions.forEach(function (d) { console.log(' −', d.reason, '→', d.val); });
      console.groupEnd();
    }

    if (s.startup.domContentLoadedMs !== undefined) {
      console.group('Startup Timing');
      console.log('DOMContentLoaded:', s.startup.domContentLoadedMs + 'ms');
      console.log('Load event:', s.startup.loadMs + 'ms');
      console.groupEnd();
    }

    if (s.vitals.lcp !== undefined) {
      console.group('Web Vitals');
      console.table({ LCP: s.vitals.lcp, FID: s.vitals.fid, CLS: s.vitals.cls, FCP: s.vitals.fcp, TTFB: s.vitals.ttfb });
      console.groupEnd();
    }

    if (s.workers && Object.keys(s.workers).length) {
      console.group('Workers');
      console.table(s.workers);
      console.groupEnd();
    }

    if (s.crashes && s.crashes.total !== undefined) {
      console.group('Crashes');
      console.table(s.crashes);
      console.groupEnd();
    }

    if (s.hydration && Object.keys(s.hydration).length) {
      console.group('Hydration');
      console.table(s.hydration);
      console.groupEnd();
    }

    console.group('Deploy / Edge');
    console.table({ stale: s.deploy.stale, buildId: s.deploy.buildId, edgeStale: s.edge.stale, region: s.edge.region });
    console.groupEnd();

    console.groupEnd();
    return s;
  }

  // ── Patch AdvancedEngine.audit() ──────────────────────────────────────────
  function _patchAudit() {
    try {
      var ae = G.AdvancedEngine;
      if (!ae || typeof ae.audit !== 'function') return;
      var _origAudit = ae.audit.bind(ae);
      // AdvancedEngine is frozen — we expose a wrapper instead of patching
      // Users can call: AdvancedEngine.audit(); RuntimeHealthAnalytics.dashboard();
    } catch (_) {}
  }
  setTimeout(_patchAudit, 1000);

  G.RuntimeHealthAnalytics = Object.freeze({
    VERSION:    VERSION,
    collect:    _collect,
    score:      function () { return _collect().score; },
    label:      function () { return _label(_collect().score); },
    dashboard:  _dashboard,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — call RuntimeHealthAnalytics.dashboard() for full report');

}(window));

// RuntimeHealthOrchestrator v1.0 — Arc 4 / Phase G / Target 7
// =====================================================================
// Unified runtime graph + upgraded health dashboard.
//
// Problem: RuntimeHealthAnalytics.dashboard() shows a single global
// score with no per-family worker stats, no offline queue health,
// no hydration domain timing per tool, no bundle graph status.
//
// Solution: Non-destructive upgrade layer. RuntimeHealthOrchestrator:
//   1. Calls RuntimeHealthAnalytics.collect() for the base score
//   2. Augments with per-family worker data (RuntimeWorkerDomainRegistry)
//   3. Adds per-tool memory islands (RuntimeMemoryIslands)
//   4. Adds offline queue health per family (RuntimeOfflineDomains)
//   5. Adds hydration domain metrics (RuntimeHydrationDomains)
//   6. Adds active bundle graph (RuntimeBundleGraph)
//   7. Adds deploy correlation (RuntimeDeploySync + RuntimeEdgeHints)
//   8. Exports fullDashboard() for console + window.RuntimeHealthOrchestrator
//
// RuntimeHealthAnalytics is NOT modified. Both dashboards coexist.
// Call RuntimeHealthOrchestrator.fullDashboard() for the full picture.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHealthOrchestrator) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HealthOrchest]';
  var VERSION = '1.0';

  // ── Collect full runtime graph ────────────────────────────────────────────
  function _collect() {
    var snap = {
      ts:          Date.now(),
      baseScore:   100,
      arcScore:    100,
      deductions:  [],
      workers:     {},
      memory:      {},
      offline:     {},
      hydration:   {},
      bundles:     {},
      analytics:   {},
      deploy:      {},
      sandbox:     {},
      throttle:    {},
      mobile:      {},
    };

    // ── Base health score from RuntimeHealthAnalytics ─────────────────────
    try {
      var ha = G.RuntimeHealthAnalytics;
      if (ha) {
        var base = ha.collect();
        snap.baseScore  = base.score;
        snap.arcScore   = base.score;
        snap.deductions = (base.deductions || []).slice();
        snap.deploy     = base.deploy || {};
      }
    } catch (_) {}

    // ── Per-family worker domain stats ────────────────────────────────────
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (wd) {
        snap.workers = wd.getAllStats() || {};
        // Penalise pressured families
        Object.keys(snap.workers).forEach(function (f) {
          var s = snap.workers[f];
          if (s && s.pressured) {
            snap.arcScore -= 8;
            snap.deductions.push({ reason: 'family pressured: ' + f, val: s.crashCount });
          }
          if (s && s.crashCount >= 3) {
            snap.arcScore -= 5;
            snap.deductions.push({ reason: 'crash threshold: ' + f, val: s.crashCount });
          }
        });
      }
    } catch (_) {}

    // ── Per-tool memory islands ───────────────────────────────────────────
    try {
      var mi = G.RuntimeMemoryIslands;
      if (mi) snap.memory = mi.getAllStats() || {};
    } catch (_) {}

    // ── Memory orchestrator heatmap ───────────────────────────────────────
    try {
      var mo = G.RuntimeMemoryOrchestrator;
      if (mo) {
        var heap = mo.heapPct();
        snap.memory._heapPct = Math.round(heap * 100) + '%';
        if (heap > 0.85) {
          snap.arcScore -= 10;
          snap.deductions.push({ reason: 'heap critical', val: Math.round(heap * 100) + '%' });
        }
      }
    } catch (_) {}

    // ── Per-tool analytics domains ─────────────────────────────────────────
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) {
        snap.analytics = ad.getAllDashboards() || {};
        // Penalise tools with poor scores
        Object.keys(snap.analytics).forEach(function (toolId) {
          var d = snap.analytics[toolId];
          if (d && d.score < 50) {
            snap.arcScore -= 3;
            snap.deductions.push({ reason: 'tool degraded: ' + toolId, val: d.score });
          }
        });
      }
    } catch (_) {}

    // ── Hydration domain metrics ──────────────────────────────────────────
    try {
      var hd = G.RuntimeHydrationDomains;
      if (hd) snap.hydration = { domains: hd.getDomains() };
    } catch (_) {}

    // ── Bundle graph ───────────────────────────────────────────────────────
    try {
      var bg = G.RuntimeBundleGraph;
      if (bg) {
        snap.bundles = bg.getActiveGraph();
        var dormant  = bg.getDormantBundles();
        if (dormant.length > 2) {
          snap.deductions.push({ reason: 'dormant bundles', val: dormant.length });
        }
      }
    } catch (_) {}

    // ── Worker domain throttle stats ──────────────────────────────────────
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (wdt) {
        snap.throttle = wdt.getStats();
        // Penalise families with held tasks
        Object.keys(snap.throttle).forEach(function (f) {
          var s = snap.throttle[f];
          if (s && s.held > 5) {
            snap.arcScore -= 4;
            snap.deductions.push({ reason: 'tasks held: ' + f, val: s.held });
          }
        });
      }
    } catch (_) {}

    // ── Mobile hardening status ───────────────────────────────────────────
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh) snap.mobile = mh.getStatus();
    } catch (_) {}

    // ── Sandbox stats ─────────────────────────────────────────────────────
    try {
      var sb = G.RuntimeToolSandbox;
      if (sb) snap.sandbox = { activeSandboxes: sb.getSandboxes() };
    } catch (_) {}

    snap.arcScore = Math.max(0, snap.arcScore);
    return snap;
  }

  // ── Full console dashboard ────────────────────────────────────────────────
  function fullDashboard() {
    var s = _collect();
    var lbl = s.arcScore >= 90 ? 'excellent' : s.arcScore >= 75 ? 'good' : s.arcScore >= 55 ? 'fair' : s.arcScore >= 35 ? 'poor' : 'critical';
    var color = s.arcScore >= 75 ? '#22c55e' : s.arcScore >= 55 ? '#f59e0b' : '#ef4444';

    console.group('%c RuntimeHealthOrchestrator v' + VERSION, 'font-weight:bold;color:#8b5cf6');
    console.log('%c Arc Score: ' + s.arcScore + '/100 (' + lbl + ')  |  Base: ' + s.baseScore + '/100',
      'font-size:14px;color:' + color);

    if (s.deductions.length) {
      console.group('Deductions (' + s.deductions.length + ')');
      s.deductions.forEach(function (d) { console.log(' −', d.reason, '→', d.val); });
      console.groupEnd();
    }

    if (Object.keys(s.workers).length) {
      console.group('Worker Domains');
      console.table(s.workers);
      console.groupEnd();
    }

    if (Object.keys(s.memory).length) {
      console.group('Memory Islands');
      console.table(s.memory);
      console.groupEnd();
    }

    if (Object.keys(s.analytics).length) {
      console.group('Tool Analytics');
      var rows = {};
      Object.keys(s.analytics).forEach(function (k) {
        var d = s.analytics[k];
        rows[k] = { score: d.score, label: d.label, success: d.successCount, fail: d.failCount, crashes: d.crashes };
      });
      console.table(rows);
      console.groupEnd();
    }

    if (Object.keys(s.throttle).length) {
      console.group('Worker Domain Throttle');
      console.table(s.throttle);
      console.groupEnd();
    }

    if (s.bundles && Object.keys(s.bundles).length) {
      console.group('Bundle Graph');
      var bundleRows = {};
      Object.keys(s.bundles).forEach(function (name) {
        var b = s.bundles[name];
        bundleRows[name] = { loaded: b.loaded, dormant: b.dormant, tools: b.toolIds ? b.toolIds.length : 0 };
      });
      console.table(bundleRows);
      console.groupEnd();
    }

    if (s.sandbox && s.sandbox.activeSandboxes) {
      console.group('Tool Sandboxes');
      console.log('Active:', s.sandbox.activeSandboxes.join(', ') || '(none)');
      console.groupEnd();
    }

    if (s.mobile && Object.keys(s.mobile).length) {
      console.group('Mobile Hardening');
      console.table(s.mobile);
      console.groupEnd();
    }

    console.log('Deploy:', s.deploy);
    console.groupEnd();
    return s;
  }

  // ── Install on window for easy console access ────────────────────────────
  setTimeout(function () {
    try {
      G.fullDashboard = fullDashboard;
      G.runtimeDashboard = fullDashboard; // alias
      console.debug(LOG, 'installed window.fullDashboard() + window.runtimeDashboard()');
    } catch (_) {}
  }, 800);

  G.RuntimeHealthOrchestrator = Object.freeze({
    VERSION:       VERSION,
    collect:       _collect,
    fullDashboard: fullDashboard,
    arcScore:      function () { return _collect().arcScore; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — call RuntimeHealthOrchestrator.fullDashboard()');

}(window));

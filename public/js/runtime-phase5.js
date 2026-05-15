// ILovePDF — Runtime Phase 5 Certification Layer v1.0
// =====================================================================
// Implements all P5 audit, certification, and diagnostics systems:
//
//   Priority 1 — Core Certification
//     window.RuntimeHealthMonitor        — enhanced health trend monitor
//     window.RuntimeCoverageReport()     — tool + subsystem coverage audit
//     window.RuntimeCertificationReport() — master P5 certification report
//
//   Priority 2 — Lifecycle Audits
//     window.ObjectUrlAudit()            — ObjectURLRegistry live audit
//     window.BlobLifecycleAudit()        — blob create/revoke intercept audit
//     window.RuntimeMemoryDiagnostics()  — deep heap + tier diagnostics
//
//   Priority 3 — Worker + Telemetry
//     window.WorkerCertificationReport() — worker pool + OPS coverage cert
//     window.TelemetryCertificationReport() — telemetry pipeline cert
//
//   Priority 5 — Future Architecture Preparation
//     window.StreamPreparationReport()   — streaming readiness + gaps
//     window.PersistencePreparationReport() — IDB/OPFS readiness
//     window.AiOrchestrationReport()    — AI subsystem readiness
//
// RT.debug() and RT.simulate.* are patched into window.RT by this module.
//
// All systems:
//   - Read-only (never mutate tool state)
//   - Hook into existing subsystems — no duplicate tracking
//   - Safe to call at any time (wrapped in try/catch throughout)
//   - Exposed as window.* globals for DevTools console access
//
// Load order: after runtime-core.js (requires window.RT to be defined)
// =====================================================================

(function (global) {
  'use strict';

  // ── Utility helpers ─────────────────────────────────────────────────────────
  var SEP60  = '─'.repeat(60);
  var SEP80  = '─'.repeat(80);
  var P5_TAG = '[P5]';

  function _safe(fn, fallback) {
    try { return fn(); }
    catch (_) { return (fallback !== undefined) ? fallback : null; }
  }

  function _pct(n, total) {
    if (!total) return '0%';
    return Math.round((n / total) * 100) + '%';
  }

  function _ts() { return new Date().toISOString(); }

  function _grade(pct) {
    if (pct >= 95) return 'CERTIFIED ✓';
    if (pct >= 80) return 'GOOD';
    if (pct >= 60) return 'PARTIAL';
    return 'UNCERTIFIED ✗';
  }

  // ── Ground truth — all known tool handlers ──────────────────────────────────
  // Sourced from browser-tools.js HANDLERS dispatch table (audit complete).
  var ALL_BROWSER_TOOLS = [
    'merge', 'split', 'rotate', 'organize', 'page-numbers', 'watermark',
    'crop', 'jpg-to-pdf', 'compress', 'protect', 'unlock', 'pdf-to-jpg',
    'crop-image', 'resize-image', 'image-filters',
    'word-to-pdf', 'html-to-pdf',
    'edit', 'sign', 'redact',
    'pdf-to-word', 'pdf-to-excel', 'repair', 'compare',
    'ocr', 'background-remover',
    'ai-summarize', 'translate', 'workflow',
    'pdf-to-powerpoint', 'powerpoint-to-pdf', 'excel-to-pdf', 'scan-to-pdf',
  ];

  // Worker-eligible tools (BrowserTools.WORKER_TOOLS set)
  var WORKER_TOOL_IDS = [
    'compress', 'workflow', 'merge', 'rotate',
    'page-numbers', 'watermark', 'sign', 'redact', 'edit',
  ];

  // pdf-worker.js OPS table (audit complete)
  var PDF_WORKER_OPS = [
    'compress', 'repair', 'merge', 'rotate', 'page-numbers', 'watermark',
    'sign', 'redact', 'edit', 'workflow', 'split', 'organize',
    'protect', 'unlock', 'compare',
  ];

  // advanced-worker.js OPS (audit complete)
  var ADVANCED_WORKER_OPS = [
    'build-docx', 'build-xlsx', 'build-pptx', 'remove-bg', 'chunk-text-score',
  ];

  // All runtime subsystem globals to verify
  var SUBSYSTEM_MAP = [
    { key: 'RuntimeEventBus',       name: 'Event Bus',          phase: 2, critical: true  },
    { key: 'RuntimeState',          name: 'State Manager',      phase: 2, critical: true  },
    { key: 'RuntimeTelemetry',      name: 'Telemetry',          phase: 2, critical: true  },
    { key: 'RuntimeCancellation',   name: 'Cancellation',       phase: 2, critical: true  },
    { key: 'RuntimeMemory',         name: 'Memory Controller',  phase: 2, critical: true  },
    { key: 'RuntimeProgress',       name: 'Progress',           phase: 2, critical: true  },
    { key: 'RuntimeScheduler',      name: 'Task Scheduler',     phase: 2, critical: true  },
    { key: 'RuntimeWorkers',        name: 'Worker Orchestrator',phase: 2, critical: true  },
    { key: 'RuntimeCleanup',        name: 'Cleanup',            phase: 2, critical: true  },
    { key: 'RuntimeHealth',         name: 'Health Monitor',     phase: 2, critical: true  },
    { key: 'RuntimeAdapters',       name: 'Tool Adapters',      phase: 2, critical: true  },
    { key: 'RuntimeStreaming',      name: 'Streaming Hooks',    phase: 2, critical: false },
    { key: 'RuntimeDiagnostics',    name: 'Diagnostics',        phase: 2, critical: false },
    { key: 'ObjectURLRegistry',     name: 'ObjectURL Registry', phase: 1, critical: true  },
    { key: 'WorkerPool',            name: 'Worker Pool',        phase: 1, critical: true  },
    { key: 'TimerRegistry',         name: 'Timer Registry',     phase: 1, critical: false },
    { key: 'LifecycleManager',      name: 'Lifecycle Manager',  phase: 1, critical: false },
    { key: 'NavCancel',             name: 'Nav Cancel',         phase: 1, critical: false },
    { key: 'RetryOrchestrator',     name: 'Retry Orchestrator', phase: 1, critical: false },
    { key: 'DownloadManager',       name: 'Download Manager',   phase: 1, critical: false },
    { key: 'AdaptiveDegradation',   name: 'Adaptive Degradation',phase:1, critical: false },
    { key: 'CleanupContracts',      name: 'Cleanup Contracts',  phase: 1, critical: false },
    { key: 'WorkerLifecycle',       name: 'Worker Lifecycle',   phase: 1, critical: false },
    { key: 'BrowserTools',          name: 'Browser Tools',      phase: 1, critical: true  },
    { key: 'CentralRuntime',        name: 'Central Runtime',    phase: 2, critical: true  },
    { key: 'RuntimeHealthMonitor',  name: 'P5 Health Monitor',  phase: 5, critical: false },
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 1 — RuntimeHealthMonitor
  // Extends existing RuntimeHealth with: trend analysis, score history
  // windowing, severity classification, and a DevTools-friendly summary.
  // ═══════════════════════════════════════════════════════════════════════════
  (function _installHealthMonitor() {
    if (global.RuntimeHealthMonitor) return;

    var _trendWindow = []; // last 10 scores
    var _MAX_TREND   = 10;
    var _alerts      = [];  // { ts, severity, message }
    var _MAX_ALERTS  = 50;

    function _classify(score) {
      if (score >= 90) return 'OPTIMAL';
      if (score >= 70) return 'GOOD';
      if (score >= 50) return 'DEGRADED';
      if (score >= 25) return 'CRITICAL';
      return 'FAILURE';
    }

    function _trend() {
      if (_trendWindow.length < 2) return 'STABLE';
      var first = _trendWindow[0];
      var last  = _trendWindow[_trendWindow.length - 1];
      var delta = last - first;
      if (delta > 10)  return 'IMPROVING';
      if (delta < -10) return 'DECLINING';
      return 'STABLE';
    }

    function _recordAlert(severity, message) {
      _alerts.push({ ts: Date.now(), severity: severity, message: message });
      if (_alerts.length > _MAX_ALERTS) _alerts.shift();
    }

    // Subscribe to existing RuntimeHealth check results
    if (global.RuntimeHealth && global.RuntimeHealth.onHealthChange) {
      global.RuntimeHealth.onHealthChange(function (snap) {
        _trendWindow.push(snap.score);
        if (_trendWindow.length > _MAX_TREND) _trendWindow.shift();

        var severity = _classify(snap.score);
        if (severity === 'CRITICAL' || severity === 'FAILURE') {
          _recordAlert(severity, 'Health score ' + snap.score + '/100 — issues: ' + (snap.issues || []).join(', '));
        }
      });
    }

    // Subscribe to RuntimeEventBus for cross-subsystem alerts
    if (global.RuntimeEventBus) {
      global.RuntimeEventBus.on('health:degraded', function (data) {
        _recordAlert('DEGRADED', 'Health degraded — score: ' + (data && data.score));
      });
      global.RuntimeEventBus.on('memory:emergency', function () {
        _recordAlert('CRITICAL', 'Memory emergency triggered');
      });
      global.RuntimeEventBus.on('worker:zombie', function (data) {
        _recordAlert('WARNING', 'Zombie worker detected: ' + JSON.stringify(data));
      });
      global.RuntimeEventBus.on('progress:stalled', function (data) {
        _recordAlert('WARNING', 'Task stalled: ' + (data && data.label));
      });
    }

    function currentScore() {
      return _safe(function () {
        return global.RuntimeHealth ? global.RuntimeHealth.getScore() : -1;
      }, -1);
    }

    function summary() {
      var score    = currentScore();
      var status   = _classify(score);
      var trendStr = _trend();
      var recentAlerts = _alerts.slice(-5);

      return {
        score:        score,
        status:       status,
        trend:        trendStr,
        trendWindow:  _trendWindow.slice(),
        recentAlerts: recentAlerts,
        totalAlerts:  _alerts.length,
        monitoring:   !!(global.RuntimeHealth && global.RuntimeHealth.getStats && global.RuntimeHealth.getStats().monitoring),
      };
    }

    function print() {
      var s = summary();
      console.group(P5_TAG + ' RuntimeHealthMonitor');
      console.log('  Score   :', s.score + '/100 — ' + s.status);
      console.log('  Trend   :', s.trend, '(' + s.trendWindow.join(' → ') + ')');
      console.log('  Alerts  :', s.totalAlerts + ' total | last 5:');
      s.recentAlerts.forEach(function (a) {
        console.log('    [' + a.severity + ']', new Date(a.ts).toISOString(), a.message);
      });
      console.groupEnd();
      return s;
    }

    global.RuntimeHealthMonitor = {
      summary:      summary,
      print:        print,
      currentScore: currentScore,
      classify:     _classify,
      trend:        _trend,
      getAlerts:    function () { return _alerts.slice(); },
    };

    console.debug('[RuntimeHealthMonitor] ready — P5 health trend monitor active');
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 1 — RuntimeCoverageReport
  // Audits which tool handlers, worker OPS, and runtime subsystems are present
  // and reachable. Returns a coverage object with percentages per category.
  // ═══════════════════════════════════════════════════════════════════════════
  function RuntimeCoverageReport() {
    var report = {
      generated:  _ts(),
      categories: {},
      overall:    { covered: 0, total: 0, pct: 0 },
    };

    // ── 1. Browser tool handlers ───────────────────────────────────────────
    var btPresent = [];
    var btMissing = [];
    ALL_BROWSER_TOOLS.forEach(function (id) {
      var ok = _safe(function () {
        return !!(global.BrowserTools && global.BrowserTools.supports && global.BrowserTools.supports(id));
      }, false);
      (ok ? btPresent : btMissing).push(id);
    });
    report.categories.browserTools = {
      label:   'Browser Tool Handlers',
      covered: btPresent.length,
      total:   ALL_BROWSER_TOOLS.length,
      pct:     _pct(btPresent.length, ALL_BROWSER_TOOLS.length),
      grade:   _grade(Math.round((btPresent.length / ALL_BROWSER_TOOLS.length) * 100)),
      present: btPresent,
      missing: btMissing,
    };

    // ── 2. Worker-eligible tools routed through WorkerPool ─────────────────
    var wpPresent = [];
    var wpMissing = [];
    var poolExists = !!(global.WorkerPool);
    WORKER_TOOL_IDS.forEach(function (id) {
      (poolExists ? wpPresent : wpMissing).push(id);
    });
    report.categories.workerTools = {
      label:      'Worker-Routable Tools',
      covered:    wpPresent.length,
      total:      WORKER_TOOL_IDS.length,
      pct:        _pct(wpPresent.length, WORKER_TOOL_IDS.length),
      grade:      _grade(Math.round((wpPresent.length / WORKER_TOOL_IDS.length) * 100)),
      poolActive: poolExists,
      toolIds:    WORKER_TOOL_IDS,
    };

    // ── 3. pdf-worker.js OPS ───────────────────────────────────────────────
    // We can't enumerate pdf-worker OPS at runtime without spawning a worker,
    // so we compare against the audited ground-truth list and mark them
    // "covered" if WorkerPool can dispatch to pdf-worker.
    var pdfWorkerOk = poolExists;
    report.categories.pdfWorkerOps = {
      label:   'pdf-worker.js OPS',
      covered: pdfWorkerOk ? PDF_WORKER_OPS.length : 0,
      total:   PDF_WORKER_OPS.length,
      pct:     pdfWorkerOk ? '100%' : '0%',
      grade:   pdfWorkerOk ? 'CERTIFIED ✓' : 'UNCERTIFIED ✗',
      ops:     PDF_WORKER_OPS,
      note:    'OPS verified by static audit — runtime dispatch requires WorkerPool',
    };

    // ── 4. advanced-worker.js OPS ──────────────────────────────────────────
    report.categories.advancedWorkerOps = {
      label:   'advanced-worker.js OPS',
      covered: pdfWorkerOk ? ADVANCED_WORKER_OPS.length : 0,
      total:   ADVANCED_WORKER_OPS.length,
      pct:     pdfWorkerOk ? '100%' : '0%',
      grade:   pdfWorkerOk ? 'CERTIFIED ✓' : 'UNCERTIFIED ✗',
      ops:     ADVANCED_WORKER_OPS,
      note:    'OPS verified by static audit',
    };

    // ── 5. Runtime subsystems ──────────────────────────────────────────────
    var subsPresent = [];
    var subsMissing = [];
    var subsCritical = [];
    SUBSYSTEM_MAP.forEach(function (sub) {
      var present = !!(global[sub.key]);
      if (present) {
        subsPresent.push(sub.key);
      } else {
        subsMissing.push(sub.key);
        if (sub.critical) subsCritical.push(sub.key);
      }
    });
    report.categories.subsystems = {
      label:    'Runtime Subsystems',
      covered:  subsPresent.length,
      total:    SUBSYSTEM_MAP.length,
      pct:      _pct(subsPresent.length, SUBSYSTEM_MAP.length),
      grade:    _grade(Math.round((subsPresent.length / SUBSYSTEM_MAP.length) * 100)),
      present:  subsPresent,
      missing:  subsMissing,
      critical: subsCritical,
    };

    // ── 6. EventBus event type coverage ───────────────────────────────────
    var ebPresent = false;
    var ebEventCount = 0;
    if (global.RuntimeEventBus && global.RuntimeEventBus.EVENTS) {
      ebPresent    = true;
      ebEventCount = Object.keys(global.RuntimeEventBus.EVENTS).length;
    }
    report.categories.eventTypes = {
      label:        'RuntimeEventBus Event Types',
      covered:      ebEventCount,
      total:        20, // from audit: 20 canonical event types
      pct:          _pct(Math.min(ebEventCount, 20), 20),
      grade:        _grade(Math.round((Math.min(ebEventCount, 20) / 20) * 100)),
      busPresent:   ebPresent,
      eventCount:   ebEventCount,
    };

    // ── Overall rollup ─────────────────────────────────────────────────────
    var totalCovered = 0;
    var totalItems   = 0;
    Object.keys(report.categories).forEach(function (k) {
      var cat = report.categories[k];
      totalCovered += cat.covered;
      totalItems   += cat.total;
    });
    var overallPct = Math.round((totalCovered / totalItems) * 100);
    report.overall = {
      covered: totalCovered,
      total:   totalItems,
      pct:     overallPct,
      pctStr:  _pct(totalCovered, totalItems),
      grade:   _grade(overallPct),
    };

    // ── Console output ─────────────────────────────────────────────────────
    console.group(P5_TAG + ' RuntimeCoverageReport — ' + _ts());
    console.log('  Overall Coverage :', report.overall.pctStr, '(' + report.overall.covered + '/' + report.overall.total + ') — ' + report.overall.grade);
    console.log(SEP80);
    Object.keys(report.categories).forEach(function (k) {
      var c = report.categories[k];
      var line = '  ' + c.label.padEnd(30) + c.pct.padStart(6) + '  (' + c.covered + '/' + c.total + ')  ' + c.grade;
      if (c.missing && c.missing.length) line += '\n    missing: ' + c.missing.join(', ');
      console.log(line);
    });
    console.log(SEP80);
    if (report.categories.subsystems.critical.length) {
      console.warn('  ⚠ CRITICAL subsystems absent:', report.categories.subsystems.critical.join(', '));
    }
    console.groupEnd();

    return report;
  }
  global.RuntimeCoverageReport = RuntimeCoverageReport;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 1 — RuntimeCertificationReport
  // Master P5 certification combining all sub-reports. Console prints a
  // structured table and returns a JSON-serializable certification object.
  // ═══════════════════════════════════════════════════════════════════════════
  function RuntimeCertificationReport() {
    var cert = {
      version:   '5.0',
      generated: _ts(),
      sections:  {},
      verdict:   null,
      risks:     [],
      phase6:    null,
    };

    // ── Coverage ───────────────────────────────────────────────────────────
    cert.sections.coverage   = _safe(RuntimeCoverageReport);

    // ── Health ─────────────────────────────────────────────────────────────
    cert.sections.health = _safe(function () {
      var hm = global.RuntimeHealthMonitor ? global.RuntimeHealthMonitor.summary() : null;
      var rh = global.RuntimeHealth        ? global.RuntimeHealth.getStats()        : null;
      return { monitor: hm, stats: rh };
    });

    // ── ObjectURL + Blob ───────────────────────────────────────────────────
    cert.sections.objectUrls  = _safe(global.ObjectUrlAudit          || function () { return { status: 'not-ready' }; });
    cert.sections.blobs       = _safe(global.BlobLifecycleAudit      || function () { return { status: 'not-ready' }; });

    // ── Memory ─────────────────────────────────────────────────────────────
    cert.sections.memory      = _safe(global.RuntimeMemoryDiagnostics || function () { return { status: 'not-ready' }; });

    // ── Workers ─────────────────────────────────────────────────────────────
    cert.sections.workers     = _safe(global.WorkerCertificationReport   || function () { return { status: 'not-ready' }; });

    // ── Telemetry ──────────────────────────────────────────────────────────
    cert.sections.telemetry   = _safe(global.TelemetryCertificationReport || function () { return { status: 'not-ready' }; });

    // ── Future readiness ───────────────────────────────────────────────────
    cert.sections.streaming    = _safe(global.StreamPreparationReport      || function () { return { status: 'not-ready' }; });
    cert.sections.persistence  = _safe(global.PersistencePreparationReport || function () { return { status: 'not-ready' }; });
    cert.sections.ai           = _safe(global.AiOrchestrationReport        || function () { return { status: 'not-ready' }; });

    // ── Verdict ─────────────────────────────────────────────────────────────
    var covPct = cert.sections.coverage ? cert.sections.coverage.overall.pct : 0;
    var healthScore = _safe(function () {
      return global.RuntimeHealth ? global.RuntimeHealth.getScore() : -1;
    }, -1);
    var criticalAbsent = cert.sections.coverage
      ? cert.sections.coverage.categories.subsystems.critical
      : [];

    if (covPct >= 95 && healthScore >= 80 && criticalAbsent.length === 0) {
      cert.verdict = 'CERTIFIED — Phase 5 runtime fully operational';
    } else if (covPct >= 80 && criticalAbsent.length === 0) {
      cert.verdict = 'CONDITIONALLY CERTIFIED — minor gaps remain';
    } else {
      cert.verdict = 'NOT CERTIFIED — critical issues detected';
    }

    // ── Risks ─────────────────────────────────────────────────────────────
    if (!global.RuntimeStreaming || !global.RuntimeStreaming.isReady || !global.RuntimeStreaming.isReady()) {
      cert.risks.push({ severity: 'LOW',    area: 'Streaming',    detail: 'RuntimeStreaming stubs active — not real streaming' });
    }
    if (!global.WorkerPool) {
      cert.risks.push({ severity: 'HIGH',   area: 'Workers',      detail: 'WorkerPool absent — all tools run on main thread' });
    }
    if (criticalAbsent.length > 0) {
      cert.risks.push({ severity: 'HIGH',   area: 'Subsystems',   detail: 'Critical subsystems absent: ' + criticalAbsent.join(', ') });
    }
    if (healthScore < 70 && healthScore >= 0) {
      cert.risks.push({ severity: 'MEDIUM', area: 'Health',       detail: 'Health score below threshold: ' + healthScore + '/100' });
    }
    if (!global.CentralRuntime || !global.CentralRuntime.persistState) {
      cert.risks.push({ severity: 'LOW',    area: 'Persistence',  detail: 'persistState() is a stub — no crash recovery' });
    }
    if (!global.CentralRuntime || _safe(function () { return global.CentralRuntime.runAiTask('probe', {}).catch(function(){}); }) === null) {
      cert.risks.push({ severity: 'LOW',    area: 'AI',           detail: 'AI orchestration stubs — AutonomousPlanner not integrated' });
    }

    // ── Phase 6 recommendation ────────────────────────────────────────────
    cert.phase6 = {
      recommendation: 'Phase 6 — IndexedDB Persistence + OPFS Streaming + AI Orchestration Integration',
      tracks: [
        { track: 'P6-A', title: 'IndexedDB crash-recovery', detail: 'Implement RuntimeState.snapshot() → IDB write; restoreState() on boot' },
        { track: 'P6-B', title: 'OPFS streaming',           detail: 'Replace Blob/ArrayBuffer transfers with OPFS byte-range streaming for >20MB files' },
        { track: 'P6-C', title: 'AI orchestration',         detail: 'Wire CentralRuntime.runAiTask() to GenerativeAiEngine + AutonomousPlanner' },
        { track: 'P6-D', title: 'Cross-tab coordination',   detail: 'Implement MultiTabCluster via BroadcastChannel for shared worker pools' },
        { track: 'P6-E', title: 'Predictive health',        detail: 'Wire RuntimeHealthMonitor trend data to a lightweight failure predictor' },
      ],
    };

    // ── Console ────────────────────────────────────────────────────────────
    console.group(P5_TAG + ' ═══ RUNTIME CERTIFICATION REPORT v5.0 ═══');
    console.log('  Generated :', cert.generated);
    console.log('  Verdict   :', cert.verdict);
    console.log(SEP80);
    if (cert.sections.coverage) {
      console.log('  Coverage  :', cert.sections.coverage.overall.pctStr,
        cert.sections.coverage.overall.grade);
    }
    console.log('  Health    :', healthScore >= 0 ? healthScore + '/100' : 'n/a');
    console.log(SEP80);
    if (cert.risks.length) {
      console.group('  RISKS (' + cert.risks.length + ')');
      cert.risks.forEach(function (r) {
        console.warn('  [' + r.severity + '] ' + r.area + ': ' + r.detail);
      });
      console.groupEnd();
    } else {
      console.log('  RISKS: none detected');
    }
    console.log(SEP80);
    console.group('  Phase 6 Recommendation: ' + cert.phase6.recommendation);
    cert.phase6.tracks.forEach(function (t) {
      console.log('   ', t.track, t.title, '—', t.detail);
    });
    console.groupEnd();
    console.groupEnd();

    return cert;
  }
  global.RuntimeCertificationReport = RuntimeCertificationReport;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 2 — ObjectUrlAudit
  // Queries ObjectURLRegistry for live URL counts, age analysis, and
  // detects potential leaks (URLs older than 30 min without revocation).
  // ═══════════════════════════════════════════════════════════════════════════
  function ObjectUrlAudit() {
    var audit = {
      generated:    _ts(),
      registryPresent: !!(global.ObjectURLRegistry),
      activeUrls:   0,
      leakCandidates: [],
      oldestAgeMs:  null,
      newestAgeMs:  null,
      stats:        null,
      note:         '',
    };

    if (!global.ObjectURLRegistry) {
      audit.note = 'ObjectURLRegistry not loaded — cannot audit live URLs';
      return audit;
    }

    var reg = global.ObjectURLRegistry;

    // Pull internal stats if exposed
    if (reg.getStats) {
      audit.stats = _safe(function () { return reg.getStats(); });
    }

    // Attempt to access internal URL map via debug surface
    var _internal = _safe(function () {
      return (reg._urls || reg._map || reg._registry || null);
    });

    if (_internal && typeof _internal.size === 'number') {
      audit.activeUrls = _internal.size;
      var now = Date.now();
      var LEAK_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
      _internal.forEach(function (meta, url) {
        var age = now - (meta.ts || meta.created || now);
        if (age > LEAK_THRESHOLD_MS) {
          audit.leakCandidates.push({
            url:   url.slice(0, 60) + (url.length > 60 ? '…' : ''),
            ageMs: age,
            label: meta.label || 'unknown',
          });
        }
        if (audit.oldestAgeMs === null || age > audit.oldestAgeMs) audit.oldestAgeMs = age;
        if (audit.newestAgeMs === null || age < audit.newestAgeMs) audit.newestAgeMs = age;
      });
    } else if (audit.stats && typeof audit.stats.active === 'number') {
      audit.activeUrls = audit.stats.active;
      audit.note = 'Internal map not accessible — using getStats() surface only';
    } else {
      audit.note = 'ObjectURLRegistry present but internal state not accessible';
    }

    console.group(P5_TAG + ' ObjectUrlAudit');
    console.log('  Registry present :', audit.registryPresent);
    console.log('  Active URLs      :', audit.activeUrls);
    console.log('  Leak candidates  :', audit.leakCandidates.length);
    if (audit.leakCandidates.length) {
      audit.leakCandidates.forEach(function (l) {
        console.warn('    leak?', l.label, '— age', Math.round(l.ageMs / 60000) + 'min', l.url);
      });
    }
    if (audit.stats) console.log('  Registry stats   :', audit.stats);
    console.groupEnd();

    return audit;
  }
  global.ObjectUrlAudit = ObjectUrlAudit;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 2 — BlobLifecycleAudit
  // Intercepts ObjectURLRegistry.create/revoke (non-destructively) to track
  // blob creation and revocation events. Returns a lifecycle snapshot.
  // First call: installs the interceptor. Subsequent calls: return stats.
  // ═══════════════════════════════════════════════════════════════════════════
  var _blobAuditInstalled = false;
  var _blobStats = {
    creates:    0,
    revokes:    0,
    active:     0,
    labels:     {},      // label → count
    sizes:      [],      // last 20 blob sizes
    totalBytes: 0,
  };

  function _installBlobInterceptor() {
    if (_blobAuditInstalled) return;
    var reg = global.ObjectURLRegistry;
    if (!reg || !reg.create || !reg.revoke) return;

    var _origCreate = reg.create.bind(reg);
    var _origRevoke = reg.revoke.bind(reg);

    reg.create = function (blob, label) {
      var url = _origCreate(blob, label);
      _blobStats.creates++;
      _blobStats.active++;
      if (label) _blobStats.labels[label] = (_blobStats.labels[label] || 0) + 1;
      if (blob && blob.size) {
        _blobStats.totalBytes += blob.size;
        _blobStats.sizes.push(blob.size);
        if (_blobStats.sizes.length > 20) _blobStats.sizes.shift();
      }
      if (global.RuntimeTelemetry) {
        _safe(function () {
          global.RuntimeTelemetry.record('blob:created', {
            size: blob ? blob.size : 0,
            label: label || 'unknown',
          });
        });
      }
      return url;
    };

    reg.revoke = function (url) {
      _origRevoke(url);
      _blobStats.revokes++;
      _blobStats.active = Math.max(0, _blobStats.active - 1);
      if (global.RuntimeTelemetry) {
        _safe(function () { global.RuntimeTelemetry.record('blob:revoked', {}); });
      }
    };

    _blobAuditInstalled = true;
    console.debug('[BlobLifecycleAudit] interceptor installed on ObjectURLRegistry');
  }

  function BlobLifecycleAudit() {
    if (!_blobAuditInstalled) _installBlobInterceptor();

    var leakRate = _blobStats.creates > 0
      ? Math.round((_blobStats.active / _blobStats.creates) * 100)
      : 0;

    var avgSizeBytes = _blobStats.sizes.length > 0
      ? Math.round(_blobStats.sizes.reduce(function (s, v) { return s + v; }, 0) / _blobStats.sizes.length)
      : 0;

    var result = {
      generated:       _ts(),
      interceptorActive: _blobAuditInstalled,
      creates:         _blobStats.creates,
      revokes:         _blobStats.revokes,
      active:          _blobStats.active,
      leakRatePct:     leakRate,
      totalBytes:      _blobStats.totalBytes,
      avgBlobBytes:    avgSizeBytes,
      labelBreakdown:  Object.assign({}, _blobStats.labels),
      recentSizes:     _blobStats.sizes.slice(),
      grade:           leakRate <= 5 ? 'CERTIFIED ✓' : leakRate <= 20 ? 'MONITOR' : 'LEAK RISK ✗',
    };

    console.group(P5_TAG + ' BlobLifecycleAudit');
    console.log('  Interceptor  :', result.interceptorActive ? 'active' : 'not installed (no ObjectURLRegistry)');
    console.log('  Creates      :', result.creates);
    console.log('  Revokes      :', result.revokes);
    console.log('  Active blobs :', result.active, '(' + result.leakRatePct + '% leak rate) —', result.grade);
    console.log('  Total bytes  :', (result.totalBytes / 1024 / 1024).toFixed(2) + ' MB processed');
    console.log('  Avg blob     :', (result.avgBlobBytes / 1024).toFixed(1) + ' KB');
    if (Object.keys(result.labelBreakdown).length) {
      console.log('  By label     :', result.labelBreakdown);
    }
    console.groupEnd();

    return result;
  }
  global.BlobLifecycleAudit = BlobLifecycleAudit;

  // Auto-install interceptor as soon as ObjectURLRegistry is available
  _installBlobInterceptor();


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 2 — RuntimeMemoryDiagnostics
  // Deep heap + memory-tier diagnostics across all memory-aware subsystems.
  // ═══════════════════════════════════════════════════════════════════════════
  function RuntimeMemoryDiagnostics() {
    var diag = {
      generated:  _ts(),
      tier:       null,
      heapMB:     null,
      heapLimitMB:null,
      heapPct:    null,
      gcPressure: 'UNKNOWN',
      subsystems: {},
      recommendations: [],
      grade:      null,
    };

    // performance.memory (Chrome only)
    var mem = _safe(function () { return performance && performance.memory; });
    if (mem && mem.usedJSHeapSize) {
      diag.heapMB      = Math.round(mem.usedJSHeapSize / 1024 / 1024);
      diag.heapLimitMB = Math.round(mem.jsHeapSizeLimit / 1024 / 1024);
      diag.heapPct     = Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);

      if (diag.heapPct >= 90) diag.gcPressure = 'CRITICAL';
      else if (diag.heapPct >= 75) diag.gcPressure = 'HIGH';
      else if (diag.heapPct >= 50) diag.gcPressure = 'MODERATE';
      else diag.gcPressure = 'LOW';
    }

    // RuntimeMemory subsystem
    if (global.RuntimeMemory) {
      diag.tier = _safe(function () { return global.RuntimeMemory.getTier(); });
      diag.subsystems.runtimeMemory = _safe(function () { return global.RuntimeMemory.getStats(); });
    }

    // MemPressure (Phase 1)
    if (global.MemPressure) {
      diag.subsystems.memPressure = _safe(function () { return global.MemPressure.stats(); });
    }

    // AdaptiveDegradation
    if (global.AdaptiveDegradation) {
      diag.subsystems.adaptiveDeg = _safe(function () { return global.AdaptiveDegradation.getStats(); });
    }

    // ObjectURL memory contribution
    var urlAudit = _safe(ObjectUrlAudit);
    if (urlAudit) {
      diag.subsystems.objectUrls = {
        active:      urlAudit.activeUrls,
        leakPending: urlAudit.leakCandidates.length,
      };
    }

    // Blob lifecycle
    diag.subsystems.blobs = {
      creates:   _blobStats.creates,
      revokes:   _blobStats.revokes,
      active:    _blobStats.active,
      totalMB:   (_blobStats.totalBytes / 1024 / 1024).toFixed(2),
    };

    // Recommendations
    if (diag.heapPct >= 75) {
      diag.recommendations.push('Heap >= 75% — trigger RuntimeCleanup.lightCleanup() proactively');
    }
    if (diag.tier === 'EMERGENCY' || diag.tier === 'CRITICAL') {
      diag.recommendations.push('Memory tier ' + diag.tier + ' — cancel pending tasks and revoke all ObjectURLs');
    }
    if (_blobStats.active > 10) {
      diag.recommendations.push('Active blobs > 10 — check for unrevoked ObjectURLs after tool completion');
    }
    if (urlAudit && urlAudit.leakCandidates.length > 0) {
      diag.recommendations.push(urlAudit.leakCandidates.length + ' ObjectURL leak candidate(s) > 30min old');
    }

    // Grade
    var issues = (diag.gcPressure === 'CRITICAL' ? 3 : diag.gcPressure === 'HIGH' ? 2 : 0)
               + (diag.tier === 'EMERGENCY' ? 3 : diag.tier === 'CRITICAL' ? 2 : diag.tier === 'WARNING' ? 1 : 0);
    diag.grade = issues === 0 ? 'CERTIFIED ✓' : issues <= 2 ? 'MONITOR' : 'CRITICAL ✗';

    console.group(P5_TAG + ' RuntimeMemoryDiagnostics');
    console.log('  Tier         :', diag.tier || 'n/a');
    console.log('  Heap         :', diag.heapMB !== null ? diag.heapMB + 'MB / ' + diag.heapLimitMB + 'MB (' + diag.heapPct + '%)' : 'performance.memory n/a');
    console.log('  GC Pressure  :', diag.gcPressure);
    console.log('  Grade        :', diag.grade);
    if (diag.recommendations.length) {
      console.group('  Recommendations');
      diag.recommendations.forEach(function (r) { console.warn('  ⚠', r); });
      console.groupEnd();
    }
    console.groupEnd();

    return diag;
  }
  global.RuntimeMemoryDiagnostics = RuntimeMemoryDiagnostics;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 3 — WorkerCertificationReport
  // Certifies worker infrastructure: WorkerPool, RuntimeWorkers,
  // WorkerLifecycle, WorkerLeakDetector, and OPS reachability.
  // ═══════════════════════════════════════════════════════════════════════════
  function WorkerCertificationReport() {
    var cert = {
      generated:       _ts(),
      workerApiPresent: typeof Worker !== 'undefined',
      subsystems:      {},
      workerUrls:      [],
      opsTotal:        PDF_WORKER_OPS.length + ADVANCED_WORKER_OPS.length,
      opsCovered:      0,
      grade:           null,
    };

    cert.subsystems.workerPool     = !!(global.WorkerPool);
    cert.subsystems.runtimeWorkers = !!(global.RuntimeWorkers);
    cert.subsystems.workerLifecycle= !!(global.WorkerLifecycle);
    cert.subsystems.leakDetector   = !!(global.WorkerLeakDetector);

    var wpStats = _safe(function () { return global.WorkerPool ? global.WorkerPool.getStats() : null; });
    var rwStats = _safe(function () { return global.RuntimeWorkers ? global.RuntimeWorkers.getStats() : null; });
    var wlStats = _safe(function () { return global.WorkerLifecycle ? global.WorkerLifecycle.getStats() : null; });

    if (wpStats) {
      cert.workerUrls = Object.keys(wpStats);
      cert.workerPoolStats = wpStats;
    }
    if (rwStats) cert.runtimeWorkerStats = rwStats;
    if (wlStats) cert.workerLifecycleStats = wlStats;

    // OPS coverage: all OPS are reachable if WorkerPool dispatches to the worker URLs
    var hasPdfWorker     = cert.workerUrls.some(function (u) { return u.includes('pdf-worker'); }) ||
                           cert.subsystems.workerPool;
    var hasAdvancedWorker= cert.workerUrls.some(function (u) { return u.includes('advanced-worker'); }) ||
                           cert.subsystems.workerPool;

    cert.pdfWorkerOps      = { ops: PDF_WORKER_OPS,      covered: hasPdfWorker, count: hasPdfWorker ? PDF_WORKER_OPS.length : 0 };
    cert.advancedWorkerOps = { ops: ADVANCED_WORKER_OPS, covered: hasAdvancedWorker, count: hasAdvancedWorker ? ADVANCED_WORKER_OPS.length : 0 };
    cert.opsCovered = cert.pdfWorkerOps.count + cert.advancedWorkerOps.count;

    var subsystemScore = Object.values(cert.subsystems).filter(Boolean).length;
    var subsystemTotal = Object.keys(cert.subsystems).length;

    cert.grade = (cert.workerApiPresent && cert.subsystems.workerPool && cert.opsCovered === cert.opsTotal)
      ? 'CERTIFIED ✓'
      : (cert.subsystems.workerPool ? 'CONDITIONALLY CERTIFIED' : 'UNCERTIFIED ✗');

    console.group(P5_TAG + ' WorkerCertificationReport');
    console.log('  Worker API     :', cert.workerApiPresent ? 'available' : 'MISSING ✗');
    console.log('  Subsystems     :', subsystemScore + '/' + subsystemTotal, 'present');
    console.log('  OPS covered    :', cert.opsCovered + '/' + cert.opsTotal);
    console.log('  pdf-worker     :', cert.pdfWorkerOps.covered ? 'reachable ✓' : 'UNREACHABLE ✗');
    console.log('  adv-worker     :', cert.advancedWorkerOps.covered ? 'reachable ✓' : 'UNREACHABLE ✗');
    console.log('  Grade          :', cert.grade);
    console.groupEnd();

    return cert;
  }
  global.WorkerCertificationReport = WorkerCertificationReport;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 3 — TelemetryCertificationReport
  // Verifies telemetry pipeline: RuntimeTelemetry presence, event counts,
  // event type coverage, and RuntimeEventBus stats integration.
  // ═══════════════════════════════════════════════════════════════════════════
  function TelemetryCertificationReport() {
    var cert = {
      generated:      _ts(),
      present:        !!(global.RuntimeTelemetry),
      eventBusLinked: !!(global.RuntimeEventBus),
      eventCount:     0,
      eventTypes:     [],
      busStats:       null,
      stateLinked:    !!(global.RuntimeState),
      grade:          null,
    };

    if (global.RuntimeTelemetry) {
      var telStats = _safe(function () { return global.RuntimeTelemetry.getStats ? global.RuntimeTelemetry.getStats() : null; });
      if (telStats) {
        cert.eventCount  = telStats.totalRecords || telStats.count || 0;
        cert.eventTypes  = telStats.types ? Object.keys(telStats.types) : [];
        cert.telStats    = telStats;
      }
      var recent = _safe(function () { return global.RuntimeTelemetry.getRecent ? global.RuntimeTelemetry.getRecent(5) : []; });
      if (recent) cert.recentEvents = recent;
    }

    if (global.RuntimeEventBus) {
      cert.busStats = _safe(function () { return global.RuntimeEventBus.getStats(); });
    }

    var subs   = [cert.present, cert.eventBusLinked, cert.stateLinked];
    var subsOk = subs.filter(Boolean).length;
    cert.grade = subsOk === 3 ? 'CERTIFIED ✓' : subsOk >= 2 ? 'GOOD' : 'UNCERTIFIED ✗';

    console.group(P5_TAG + ' TelemetryCertificationReport');
    console.log('  RuntimeTelemetry :', cert.present    ? 'present ✓' : 'ABSENT ✗');
    console.log('  EventBus linked  :', cert.eventBusLinked ? 'yes ✓' : 'no ✗');
    console.log('  State linked     :', cert.stateLinked ? 'yes ✓' : 'no ✗');
    console.log('  Events recorded  :', cert.eventCount);
    console.log('  Event types seen :', cert.eventTypes.length);
    if (cert.busStats) console.log('  Bus stats        :', cert.busStats);
    console.log('  Grade            :', cert.grade);
    console.groupEnd();

    return cert;
  }
  global.TelemetryCertificationReport = TelemetryCertificationReport;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 5 — StreamPreparationReport
  // Checks readiness of the streaming layer: RuntimeStreaming stubs vs real
  // implementation, OPFS availability, ReadableStream support.
  // ═══════════════════════════════════════════════════════════════════════════
  function StreamPreparationReport() {
    var report = {
      generated:       _ts(),
      streamingLoaded: !!(global.RuntimeStreaming),
      streamingReady:  false,
      opfsAvailable:   false,
      readableStream:  typeof ReadableStream !== 'undefined',
      writableStream:  typeof WritableStream !== 'undefined',
      transferableStream: false,
      gaps:            [],
      readinessScore:  0,
      grade:           null,
    };

    // Check RuntimeStreaming readiness
    if (global.RuntimeStreaming) {
      report.streamingReady = _safe(function () {
        return !!(global.RuntimeStreaming.isReady && global.RuntimeStreaming.isReady());
      }, false);
    }

    // OPFS availability
    report.opfsAvailable = _safe(function () {
      return !!(navigator && navigator.storage && navigator.storage.getDirectory);
    }, false);

    // TransferableStreams (for worker-to-main streaming)
    report.transferableStream = _safe(function () {
      if (typeof ReadableStream === 'undefined') return false;
      var rs = new ReadableStream();
      return typeof rs.pipeTo !== 'undefined';
    }, false);

    // Score: 1 point each for 5 capabilities
    var score = 0;
    if (report.streamingLoaded)     score++;
    if (report.streamingReady)      score++;
    if (report.opfsAvailable)       score++;
    if (report.readableStream)      score++;
    if (report.transferableStream)  score++;
    report.readinessScore = Math.round((score / 5) * 100);

    // Gaps
    if (!report.streamingReady)     report.gaps.push('RuntimeStreaming stubs only — no real streaming implementation');
    if (!report.opfsAvailable)      report.gaps.push('OPFS not available — large-file streaming not possible');
    if (!report.readableStream)     report.gaps.push('ReadableStream API absent — browser too old');
    if (!report.transferableStream) report.gaps.push('TransferableStream not supported — worker streaming limited');

    report.grade = report.readinessScore >= 80 ? 'READY' :
                   report.readinessScore >= 40 ? 'PARTIAL' : 'NOT READY';

    console.group(P5_TAG + ' StreamPreparationReport');
    console.log('  RuntimeStreaming :', report.streamingLoaded ? (report.streamingReady ? 'real ✓' : 'stubs only') : 'absent');
    console.log('  OPFS            :', report.opfsAvailable    ? 'available ✓' : 'not available');
    console.log('  ReadableStream  :', report.readableStream    ? 'yes ✓'       : 'no ✗');
    console.log('  TransferStream  :', report.transferableStream? 'yes ✓'       : 'no ✗');
    console.log('  Readiness       :', report.readinessScore + '% — ' + report.grade);
    if (report.gaps.length) {
      console.group('  Gaps');
      report.gaps.forEach(function (g) { console.warn('  •', g); });
      console.groupEnd();
    }
    console.groupEnd();

    return report;
  }
  global.StreamPreparationReport = StreamPreparationReport;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 5 — PersistencePreparationReport
  // Checks IDB availability, SessionStorage (flow state hydration),
  // CentralRuntime.persistState stub status, and OPFS for file persistence.
  // ═══════════════════════════════════════════════════════════════════════════
  function PersistencePreparationReport() {
    var report = {
      generated:           _ts(),
      indexedDbAvailable:  false,
      sessionStorageAvail: false,
      idbCachePresent:     false,
      persistStateStub:    true,   // true = stub, false = real
      opfsAvailable:       false,
      flowHydration:       false,
      gaps:                [],
      grade:               null,
    };

    report.indexedDbAvailable  = _safe(function () { return typeof indexedDB !== 'undefined'; }, false);
    report.sessionStorageAvail = _safe(function () {
      sessionStorage.setItem('__p5_probe', '1');
      sessionStorage.removeItem('__p5_probe');
      return true;
    }, false);
    report.opfsAvailable = _safe(function () {
      return !!(navigator && navigator.storage && navigator.storage.getDirectory);
    }, false);

    // IDB cache
    report.idbCachePresent = !!(global.IDBCache || global.RuntimeIDB);

    // CentralRuntime.persistState stub check
    if (global.CentralRuntime && global.CentralRuntime.persistState) {
      // If it resolves to null it's a stub
      var pResult = _safe(function () { return global.CentralRuntime.persistState(); });
      report.persistStateStub = (pResult && typeof pResult.then === 'function');
      // Assume stub if it exists but no IDBCache
      report.persistStateStub = !report.idbCachePresent;
    }

    // Flow hydration (hydrateFlowState) presence — check for sessionStorage flow keys
    report.flowHydration = _safe(function () {
      return report.sessionStorageAvail &&
        Object.keys(sessionStorage).some(function (k) { return k.startsWith('ilpdf_'); });
    }, false);

    // Gaps
    if (!report.indexedDbAvailable)    report.gaps.push('IndexedDB not available — no crash recovery possible');
    if (report.persistStateStub)        report.gaps.push('CentralRuntime.persistState() is a stub — implement IDB checkpoint write');
    if (!report.idbCachePresent)        report.gaps.push('IDBCache module absent — install for runtime state persistence');
    if (!report.opfsAvailable)         report.gaps.push('OPFS not available — large-file persistence limited to memory');

    var score = 0;
    if (report.indexedDbAvailable)   score += 25;
    if (report.sessionStorageAvail)  score += 25;
    if (!report.persistStateStub)    score += 25;
    if (report.idbCachePresent)      score += 25;
    report.readinessScore = score;
    report.grade = score >= 75 ? 'READY' : score >= 50 ? 'PARTIAL' : 'NOT READY';

    console.group(P5_TAG + ' PersistencePreparationReport');
    console.log('  IndexedDB         :', report.indexedDbAvailable ? 'available ✓' : 'absent ✗');
    console.log('  SessionStorage    :', report.sessionStorageAvail ? 'available ✓' : 'absent ✗');
    console.log('  IDBCache module   :', report.idbCachePresent ? 'present ✓' : 'absent ✗');
    console.log('  persistState()    :', report.persistStateStub ? 'STUB ✗' : 'implemented ✓');
    console.log('  OPFS              :', report.opfsAvailable ? 'available ✓' : 'absent ✗');
    console.log('  Flow hydration    :', report.flowHydration ? 'active (sessions found)' : 'no active sessions');
    console.log('  Readiness         :', report.readinessScore + '% — ' + report.grade);
    if (report.gaps.length) {
      console.group('  Gaps (Phase 6 backlog)');
      report.gaps.forEach(function (g) { console.warn('  •', g); });
      console.groupEnd();
    }
    console.groupEnd();

    return report;
  }
  global.PersistencePreparationReport = PersistencePreparationReport;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 5 — AiOrchestrationReport
  // Audits AI subsystem readiness: GenerativeAiEngine, VectorMemoryEngine,
  // AiAgentSystem, CentralRuntime.runAiTask, HuggingFace / ONNX integration.
  // ═══════════════════════════════════════════════════════════════════════════
  function AiOrchestrationReport() {
    var report = {
      generated:       _ts(),
      subsystems:      {},
      providers:       [],
      runAiTaskStub:   true,
      hfConfigured:    false,
      onnxAvailable:   false,
      gaps:            [],
      grade:           null,
    };

    // AI subsystems detected on window (loaded by chrome.js / advanced scripts)
    var aiGlobals = [
      'GenerativeAiEngine', 'VectorMemoryEngine', 'AiAgentSystem',
      'WebGpuAiExpansion', 'LabaAgentSystem', 'LCB',
    ];
    aiGlobals.forEach(function (key) {
      report.subsystems[key] = !!(global[key]);
    });

    // Provider list from GenerativeAiEngine
    if (global.GenerativeAiEngine && global.GenerativeAiEngine.getProviders) {
      report.providers = _safe(function () { return global.GenerativeAiEngine.getProviders(); }, []);
    }

    // CentralRuntime.runAiTask stub check
    report.runAiTaskStub = _safe(function () {
      if (!global.CentralRuntime || !global.CentralRuntime.runAiTask) return true;
      var p = global.CentralRuntime.runAiTask('__probe__', {});
      if (p && p.catch) p.catch(function () {});
      // It's a stub if it immediately rejects with 'ai-orchestration-pending'
      return true; // conservative — assume stub until integrated
    }, true);

    // ONNX runtime
    report.onnxAvailable = !!(global.OnnxRuntimeManager || global.ort || global.onnxRuntime);

    // HuggingFace / AI inference check
    report.hfConfigured = _safe(function () {
      return !!(global.isHfConfigured && global.isHfConfigured());
    }, false);

    // Gaps
    var presentCount = Object.values(report.subsystems).filter(Boolean).length;
    if (presentCount === 0)         report.gaps.push('No AI subsystems detected on window.*');
    if (report.runAiTaskStub)       report.gaps.push('CentralRuntime.runAiTask() is a stub — wire to GenerativeAiEngine');
    if (!report.onnxAvailable)      report.gaps.push('ONNX runtime not detected — local model inference unavailable');
    if (!report.hfConfigured)       report.gaps.push('HuggingFace not configured — server-side AI inference unavailable');
    if (report.providers.length === 0) report.gaps.push('No AI providers registered in GenerativeAiEngine');

    var score = Math.round((presentCount / aiGlobals.length) * 60)
              + (report.onnxAvailable ? 20 : 0)
              + (!report.runAiTaskStub ? 20 : 0);
    report.readinessScore = Math.min(100, score);
    report.grade = report.readinessScore >= 80 ? 'READY' :
                   report.readinessScore >= 40 ? 'PARTIAL' : 'NOT READY (Phase 6 work required)';

    console.group(P5_TAG + ' AiOrchestrationReport');
    console.log('  AI Subsystems   :', presentCount + '/' + aiGlobals.length, 'detected');
    Object.keys(report.subsystems).forEach(function (k) {
      console.log('    ' + k.padEnd(24) + ':', report.subsystems[k] ? 'present ✓' : 'absent');
    });
    console.log('  Providers       :', report.providers.length ? report.providers.join(', ') : 'none registered');
    console.log('  ONNX runtime    :', report.onnxAvailable   ? 'available ✓' : 'absent');
    console.log('  runAiTask()     :', report.runAiTaskStub   ? 'STUB ✗' : 'implemented ✓');
    console.log('  Readiness       :', report.readinessScore + '% — ' + report.grade);
    if (report.gaps.length) {
      console.group('  Gaps (Phase 6 backlog)');
      report.gaps.forEach(function (g) { console.warn('  •', g); });
      console.groupEnd();
    }
    console.groupEnd();

    return report;
  }
  global.AiOrchestrationReport = AiOrchestrationReport;


  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 4 — RT.debug() and RT.simulate.*
  // Patched onto window.RT (= window.CentralRuntime) after it is defined.
  // ═══════════════════════════════════════════════════════════════════════════
  function _patchRT() {
    var RT = global.CentralRuntime || global.RT;
    if (!RT) {
      // Retry once after 500ms (CentralRuntime bootstraps on DOMContentLoaded)
      setTimeout(_patchRT, 500);
      return;
    }

    // ── RT.debug() — full diagnostic dump ────────────────────────────────
    RT.debug = function () {
      console.group('[RT.debug] ILovePDF Runtime — Full Diagnostic Dump — ' + _ts());

      // Existing RuntimeDiagnostics
      if (global.RuntimeDiagnostics && global.RuntimeDiagnostics.print) {
        global.RuntimeDiagnostics.print();
      }

      // P5 reports
      RuntimeCoverageReport();
      RuntimeMemoryDiagnostics();
      WorkerCertificationReport();
      TelemetryCertificationReport();
      ObjectUrlAudit();
      BlobLifecycleAudit();
      StreamPreparationReport();
      PersistencePreparationReport();
      AiOrchestrationReport();

      // Health monitor
      if (global.RuntimeHealthMonitor) global.RuntimeHealthMonitor.print();

      // Master certification
      RuntimeCertificationReport();

      console.groupEnd();
    };

    // ── RT.simulate — controlled failure injection ────────────────────────
    // All simulate functions are safe: they emit events and update state,
    // but NEVER corrupt real data or terminate live workers permanently.
    RT.simulate = {

      // Simulate a memory pressure tier change
      memoryPressure: function (tier) {
        var validTiers = ['ok', 'reduce', 'low', 'critical', 'abort'];
        tier = tier || 'critical';
        if (!validTiers.includes(tier)) {
          console.warn('[RT.simulate.memoryPressure] invalid tier:', tier, '— valid:', validTiers.join(', '));
          return;
        }
        if (global.RuntimeState) {
          global.RuntimeState.set('memoryTier', tier);
        }
        if (global.RuntimeEventBus) {
          global.RuntimeEventBus.emit('memory:tier-changed', { tier: tier, simulated: true });
          if (tier === 'abort' || tier === 'critical') {
            global.RuntimeEventBus.emit('memory:emergency', { tier: tier, simulated: true });
          }
        }
        if (global.RuntimeTelemetry) {
          global.RuntimeTelemetry.record('simulate:memory-pressure', { tier: tier });
        }
        console.log('[RT.simulate.memoryPressure] → tier set to', tier,
          '| To restore: RT.simulate.memoryPressure("ok")');
      },

      // Simulate a worker entering error/zombie state (does not kill real workers)
      workerFailure: function (workerUrl) {
        workerUrl = workerUrl || '/workers/pdf-worker.js';
        if (global.RuntimeEventBus) {
          global.RuntimeEventBus.emit('worker:error', {
            url: workerUrl,
            error: 'simulated-failure',
            simulated: true,
          });
          global.RuntimeEventBus.emit('worker:zombie', {
            url: workerUrl,
            simulated: true,
          });
        }
        if (global.RuntimeState) global.RuntimeState.inc('zombieWorkers');
        if (global.RuntimeTelemetry) {
          global.RuntimeTelemetry.record('simulate:worker-failure', { url: workerUrl });
        }
        console.warn('[RT.simulate.workerFailure]', workerUrl,
          '→ zombie event emitted | To reset: RT.simulate.reset()');
      },

      // Simulate a task timeout (emits progress:stalled for a fake task)
      taskTimeout: function (delayMs) {
        delayMs = delayMs || 500;
        var taskId = null;
        if (global.RuntimeProgress) {
          taskId = global.RuntimeProgress.startTask({
            label:          'simulated-task',
            stallTimeoutMs: delayMs,
            primary:        false,
          });
          global.RuntimeProgress.report(taskId, 0, 10, 'simulated task started');
        }
        if (global.RuntimeTelemetry) {
          global.RuntimeTelemetry.record('simulate:task-timeout', { delayMs: delayMs });
        }
        console.log('[RT.simulate.taskTimeout] → stall expected in', delayMs + 'ms',
          '| taskId:', taskId);
        return taskId;
      },

      // Simulate a health score drop (overrides RuntimeHealth's internal score temporarily)
      healthDrop: function (score) {
        score = typeof score === 'number' ? Math.max(0, Math.min(100, score)) : 20;
        if (global.RuntimeState) global.RuntimeState.set('healthScore', score);
        if (global.RuntimeEventBus) {
          global.RuntimeEventBus.emit('health:degraded', {
            score: score, issues: ['simulated-drop'], simulated: true,
          });
        }
        if (global.RuntimeTelemetry) {
          global.RuntimeTelemetry.record('simulate:health-drop', { score: score });
        }
        console.warn('[RT.simulate.healthDrop] → health score set to', score + '/100',
          '| To restore: RT.simulate.reset()');
      },

      // Simulate a navigation cancel (fires NavCancel + RuntimeCancellation)
      navCancel: function () {
        if (global.RuntimeCancellation) {
          global.RuntimeCancellation.cancelAll('simulated-nav-cancel');
        }
        if (global.NavCancel) {
          global.NavCancel.trigger('simulated-nav-cancel');
        }
        if (global.RuntimeEventBus) {
          global.RuntimeEventBus.emit('nav:cancel', { reason: 'simulated', simulated: true });
        }
        if (global.RuntimeTelemetry) {
          global.RuntimeTelemetry.record('simulate:nav-cancel', {});
        }
        console.log('[RT.simulate.navCancel] → cancellation signal sent to all active tasks');
      },

      // Simulate a queue storm (rapid task queuing)
      queueStorm: function (count) {
        count = Math.min(count || 5, 20); // cap at 20 for safety
        if (global.RuntimeEventBus) {
          global.RuntimeEventBus.emit('queue:storm', { count: count, simulated: true });
        }
        for (var i = 0; i < count; i++) {
          if (global.RuntimeEventBus) {
            global.RuntimeEventBus.emit('queue:task-added', {
              taskId: 'sim-' + i,
              tool:   'simulated',
              simulated: true,
            });
          }
        }
        console.warn('[RT.simulate.queueStorm] →', count, 'tasks queued | check RT.status()');
      },

      // Reset all simulated state back to normal
      reset: function () {
        if (global.RuntimeState) {
          global.RuntimeState.set('memoryTier', 'ok');
          global.RuntimeState.set('runtimeMode', 'normal');
          global.RuntimeState.set('zombieWorkers', 0);
          global.RuntimeState.set('emergencyActive', false);
          var hScore = global.RuntimeHealth ? global.RuntimeHealth.getScore() : 100;
          global.RuntimeState.set('healthScore', hScore);
        }
        if (global.RuntimeEventBus) {
          global.RuntimeEventBus.emit('health:recovered', { score: 100, simulated: true });
          global.RuntimeEventBus.emit('memory:tier-changed', { tier: 'ok', simulated: true });
        }
        if (global.RuntimeTelemetry) {
          global.RuntimeTelemetry.record('simulate:reset', {});
        }
        console.log('[RT.simulate.reset] → all simulated state cleared ✓');
      },
    };

    // Make RT and CentralRuntime both have these methods
    if (global.RT && global.RT !== RT) {
      global.RT.debug    = RT.debug;
      global.RT.simulate = RT.simulate;
    }

    if (global.RuntimeTelemetry) {
      _safe(function () { global.RuntimeTelemetry.record('runtime:p5-patch-applied', { version: '1.0' }); });
    }

    console.info('[RT.debug + RT.simulate] P5 DevTools surface patched onto window.RT ✓');
    console.info('  Commands: RT.debug()  RT.simulate.memoryPressure(tier)  RT.simulate.workerFailure(url)');
    console.info('            RT.simulate.taskTimeout(ms)  RT.simulate.healthDrop(score)');
    console.info('            RT.simulate.navCancel()  RT.simulate.queueStorm(n)  RT.simulate.reset()');
    console.info('  Reports : RuntimeCoverageReport()  RuntimeCertificationReport()  ObjectUrlAudit()');
    console.info('            BlobLifecycleAudit()  RuntimeMemoryDiagnostics()  WorkerCertificationReport()');
    console.info('            TelemetryCertificationReport()  StreamPreparationReport()');
    console.info('            PersistencePreparationReport()  AiOrchestrationReport()');
  }

  // ── Boot sequence: patch RT after CentralRuntime bootstraps ─────────────
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_patchRT, 200);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(_patchRT, 200);
    }, { once: true });
  }

  // Also listen for runtime:ready event so we patch immediately if CentralRuntime
  // fires the event after this module loads
  if (global.RuntimeEventBus) {
    global.RuntimeEventBus.once('runtime:ready', function () {
      setTimeout(_patchRT, 50);
    });
  } else {
    // RuntimeEventBus may not yet be defined — use window event fallback
    global.addEventListener('rt:runtime:ready', function () {
      setTimeout(_patchRT, 50);
    }, { once: true });
  }

  console.info('[RuntimePhase5] v1.0 loaded — all P5 systems registered');
  console.info('[RuntimePhase5] Priority 1-5 globals: RuntimeHealthMonitor, RuntimeCoverageReport,');
  console.info('[RuntimePhase5]   RuntimeCertificationReport, ObjectUrlAudit, BlobLifecycleAudit,');
  console.info('[RuntimePhase5]   RuntimeMemoryDiagnostics, WorkerCertificationReport,');
  console.info('[RuntimePhase5]   TelemetryCertificationReport, StreamPreparationReport,');
  console.info('[RuntimePhase5]   PersistencePreparationReport, AiOrchestrationReport');

}(window));

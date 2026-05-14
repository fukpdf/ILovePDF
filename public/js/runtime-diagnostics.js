// Runtime Dev Diagnostics v1.0 — Phase 2 (T033)
// Safe browser-side runtime diagnostics. Exposes developer console commands
// for inspecting the entire runtime state without modifying it.
//
// NEVER call these in production hot paths — diagnostics only.
// Designed for developer use via browser DevTools console.
//
// Usage (in DevTools):
//   RuntimeDiagnostics.print()      — full runtime report in console
//   RuntimeDiagnostics.memory()     — memory tier, usage, and pressure
//   RuntimeDiagnostics.workers()    — active workers and cooldowns
//   RuntimeDiagnostics.tasks()      — active tasks and queue depth
//   RuntimeDiagnostics.health()     — health score and recent history
//   RuntimeDiagnostics.telemetry()  — recent telemetry events
//   RuntimeDiagnostics.streaming()  — stream markers and capabilities
//   RuntimeDiagnostics.snapshot()   — full JSON-serializable snapshot
//
// Integrates: all Phase 2 runtime systems + Phase 1A/1B/1C systems
//
// [FUTURE: RuntimeDashboard] Diagnostics will feed a live visual dashboard
// (separate HTML panel) for production monitoring without DevTools.
//
// Exposed as: window.RuntimeDiagnostics
(function () {
  'use strict';

  if (window.RuntimeDiagnostics) return;

  var SEP = '─'.repeat(60);

  // ── Safe getter ───────────────────────────────────────────────────────────
  function _safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback !== undefined ? fallback : null; }
  }

  // ── Section printers ──────────────────────────────────────────────────────
  function memory() {
    var lines = ['', '  ██ MEMORY', SEP];
    var rm = _safe(function () { return window.RuntimeMemory ? window.RuntimeMemory.getStats() : null; });
    var mp = _safe(function () { return window.MemPressure ? window.MemPressure.stats() : null; });
    var ad = _safe(function () { return window.AdaptiveDegradation ? window.AdaptiveDegradation.getStats() : null; });

    if (rm) {
      lines.push('  Runtime Tier : ' + rm.tier + (rm.isMobile ? ' (mobile)' : ''));
      lines.push('  MemPressure  : ' + (mp ? mp.tier + ' — ' + mp.usedMB + 'MB / ' + mp.limitMB + 'MB (' + mp.pct + '%)' : 'n/a'));
      lines.push('  Config       : workers=' + rm.config.maxWorkers + ' previews=' + rm.config.maxPreviews +
        ' scale=' + rm.config.canvasScale + ' chunk=' + rm.config.chunkMB + 'MB');
    }
    if (ad) {
      lines.push('  Adaptive     : tier=' + ad.tier + ' mobileRuns=' + ad.mobileRunCount);
    }
    console.log(lines.join('\n'));
    return { rm: rm, mp: mp, ad: ad };
  }

  function workers() {
    var lines = ['', '  ██ WORKERS', SEP];
    var rw = _safe(function () { return window.RuntimeWorkers ? window.RuntimeWorkers.getStats() : null; });
    var wl = _safe(function () { return window.WorkerLifecycle ? window.WorkerLifecycle.getStats() : null; });
    var wp = _safe(function () { return window.WorkerPool ? window.WorkerPool.getStats() : null; });

    if (wl) {
      lines.push('  WL Alive     : ' + wl.alive + ' workers (epoch count: ' + wl.epochCount + ')');
    }
    if (rw) {
      lines.push('  RW Cooldowns : ' + rw.cooldowns + ' | In-flight: ' + rw.inflight);
    }
    if (wp) {
      var urls = Object.keys(wp);
      urls.forEach(function (url) {
        var p = wp[url];
        lines.push('  Pool [' + url.split('/').pop() + '] : busy=' + (p.busy || 0) +
          ' queued=' + ((p.queued || 0) + (p.queuedHigh || 0) + (p.queuedLow || 0)));
      });
      if (!urls.length) lines.push('  WorkerPool: no pools active');
    }
    console.log(lines.join('\n'));
    return { rw: rw, wl: wl, wp: wp };
  }

  function tasks() {
    var lines = ['', '  ██ TASKS & QUEUES', SEP];
    var rs  = _safe(function () { return window.RuntimeScheduler ? window.RuntimeScheduler.getStats() : null; });
    var rp  = _safe(function () { return window.RuntimeProgress  ? window.RuntimeProgress.getStats() : null; });
    var rq  = _safe(function () { return window.RuntimeQueue     ? window.RuntimeQueue.getStats() : null; });
    var nc  = _safe(function () { return window.NavCancel        ? window.NavCancel.getStats() : null; });

    if (rs) lines.push('  Scheduler    : wait=' + rs.waitQueueSize + ' types=' + JSON.stringify(rs.typeCounts));
    if (rp) lines.push('  Progress     : active=' + rp.activeTasks + ' primary=' + rp.primaryTaskId);
    if (rq) lines.push('  Queue        : jobs=' + rq.activeJobs + ' dedupeKeys=' + rq.dedupeKeys);
    if (nc) lines.push('  NavCancel    : epoch=' + nc.epoch + ' ctrl=' + nc.activeControllers + ' poll=' + nc.activePolling);
    if (rp && rp.tasks.length) {
      rp.tasks.forEach(function (t) {
        lines.push('    Task [' + t.id + ']: ' + t.label + ' ' + t.overall + '% ' + (t.stalled ? '⚠STALLED' : ''));
      });
    }
    console.log(lines.join('\n'));
    return { rs: rs, rp: rp, rq: rq, nc: nc };
  }

  function health() {
    var lines = ['', '  ██ HEALTH', SEP];
    var rh  = _safe(function () { return window.RuntimeHealth ? window.RuntimeHealth.getStats() : null; });
    var p1c = _safe(function () { return window.Phase1CAudit  ? window.Phase1CAudit.run() : null; });
    var rt  = _safe(function () { return window.RetryOrchestrator ? window.RetryOrchestrator.getStats() : null; });

    if (rh) {
      var scoreBar = '█'.repeat(Math.round(rh.score / 10)) + '░'.repeat(10 - Math.round(rh.score / 10));
      lines.push('  Score        : ' + rh.score + '/100 [' + scoreBar + ']');
      if (rh.history.length) {
        var last = rh.history[rh.history.length - 1];
        lines.push('  Last Check   : ' + (last.issues.length ? last.issues.join(', ') : 'no issues'));
      }
    }
    if (p1c) {
      lines.push('  Phase1CAudit : ' + (p1c.passed ? 'PASSED' : 'FAILED') +
        (p1c.warnings.length ? ' — ' + p1c.warnings.join('; ') : ''));
    }
    if (rt) {
      lines.push('  Retries      : storm=' + (rt.inCooldown ? '⚠YES' : 'no') + ' ring=' + rt.stormRingSize);
    }
    console.log(lines.join('\n'));
    return { rh: rh, p1c: p1c, rt: rt };
  }

  function telemetry(n) {
    n = n || 20;
    var lines = ['', '  ██ TELEMETRY (last ' + n + ')', SEP];
    var events = _safe(function () {
      return window.RuntimeTelemetry ? window.RuntimeTelemetry.getRecentEvents(n) : [];
    }, []);
    events.forEach(function (ev) {
      var t = new Date(ev.ts).toISOString().slice(11, 23);
      var d = ev.data ? ' ' + JSON.stringify(ev.data).slice(0, 60) : '';
      lines.push('  [' + t + '] ' + ev.name + d);
    });
    if (!events.length) lines.push('  (no events)');
    console.log(lines.join('\n'));
    return events;
  }

  function streaming() {
    var lines = ['', '  ██ STREAMING HOOKS', SEP];
    var caps = _safe(function () {
      return window.RuntimeStreaming ? window.RuntimeStreaming.getCapabilities() : null;
    });
    if (caps) {
      lines.push('  OPFS         : ' + (caps.opfsAvailable ? 'available' : 'unavailable'));
      lines.push('  IDB          : ' + (caps.idbAvailable ? 'available' : 'unavailable'));
      lines.push('  StreamEngine : ' + (caps.streamEngineActive ? 'ACTIVE' : 'pending (stubs only)'));
      lines.push('  Threshold    : ' + caps.streamThresholdMB + 'MB');
      lines.push('  Markers      : ' + caps.markerCount);
    }
    var markers = _safe(function () {
      return window.P1 && window.P1.getStreamMarkers ? window.P1.getStreamMarkers() : [];
    }, []);
    if (markers.length) {
      markers.slice(-10).forEach(function (m) { lines.push('    [marker] ' + m.label); });
    }
    console.log(lines.join('\n'));
    return { caps: caps, markers: markers };
  }

  // ── Full print ────────────────────────────────────────────────────────────
  function print() {
    var rs  = _safe(function () { return window.RuntimeState ? window.RuntimeState.snapshot() : {}; }, {});
    var age = rs.startTs ? Math.round((Date.now() - rs.startTs) / 60000) : '?';

    console.log('\n╔' + '═'.repeat(58) + '╗');
    console.log('║' + '  Runtime Diagnostics — ILovePDF CentralRuntime v2.0    '.padEnd(58) + '║');
    console.log('║' + ('  Session: ' + age + ' min | Mode: ' + (rs.runtimeMode || '?')).padEnd(58) + '║');
    console.log('╚' + '═'.repeat(58) + '╝');

    memory();
    workers();
    tasks();
    health();
    streaming();

    var ts = _safe(function () { return window.TaskScheduler ? window.TaskScheduler.stats() : null; });
    if (ts) {
      console.log('\n  ██ TASK SCHEDULER', '\n' + SEP);
      Object.keys(ts).forEach(function (k) {
        if (k === 'paused') { console.log('  Paused :', ts.paused); return; }
        var s = ts[k];
        console.log('  [' + k + '] active=' + s.active + ' queued=' + s.queued + ' limit=' + s.limit);
      });
    }

    console.log('\n  Run RuntimeDiagnostics.snapshot() for full JSON export.\n');
  }

  // ── JSON snapshot ─────────────────────────────────────────────────────────
  function snapshot() {
    return {
      ts:         Date.now(),
      runtimeState:   _safe(function () { return window.RuntimeState ? window.RuntimeState.snapshot() : null; }),
      memory:         _safe(function () { return window.RuntimeMemory ? window.RuntimeMemory.getStats() : null; }),
      memPressure:    _safe(function () { return window.MemPressure ? window.MemPressure.stats() : null; }),
      workers:        _safe(function () { return window.RuntimeWorkers ? window.RuntimeWorkers.getStats() : null; }),
      workerLifecycle:_safe(function () { return window.WorkerLifecycle ? window.WorkerLifecycle.getStats() : null; }),
      workerPool:     _safe(function () { return window.WorkerPool ? window.WorkerPool.getStats() : null; }),
      taskScheduler:  _safe(function () { return window.TaskScheduler ? window.TaskScheduler.stats() : null; }),
      scheduler:      _safe(function () { return window.RuntimeScheduler ? window.RuntimeScheduler.getStats() : null; }),
      progress:       _safe(function () { return window.RuntimeProgress ? window.RuntimeProgress.getStats() : null; }),
      queue:          _safe(function () { return window.RuntimeQueue ? window.RuntimeQueue.getStats() : null; }),
      cancellation:   _safe(function () { return window.RuntimeCancellation ? window.RuntimeCancellation.getStats() : null; }),
      navCancel:      _safe(function () { return window.NavCancel ? window.NavCancel.getStats() : null; }),
      health:         _safe(function () { return window.RuntimeHealth ? window.RuntimeHealth.getStats() : null; }),
      cleanup:        _safe(function () { return window.RuntimeCleanup ? window.RuntimeCleanup.getStats() : null; }),
      contracts:      _safe(function () { return window.CleanupContracts ? window.CleanupContracts.getStats() : null; }),
      telemetry:      _safe(function () { return window.RuntimeTelemetry ? window.RuntimeTelemetry.getReport() : null; }),
      streaming:      _safe(function () { return window.RuntimeStreaming ? window.RuntimeStreaming.getCapabilities() : null; }),
      adapters:       _safe(function () { return window.RuntimeAdapters ? window.RuntimeAdapters.getStats() : null; }),
      eventBus:       _safe(function () { return window.RuntimeEventBus ? window.RuntimeEventBus.getStats() : null; }),
      phase1Audit:    _safe(function () { return window.Phase1CAudit ? window.Phase1CAudit.run() : null; }),
      p1Diagnostics:  _safe(function () { return window.P1 ? window.P1.diagnostics() : null; }),
    };
  }

  window.RuntimeDiagnostics = {
    print:      print,
    memory:     memory,
    workers:    workers,
    tasks:      tasks,
    health:     health,
    telemetry:  telemetry,
    streaming:  streaming,
    snapshot:   snapshot,
  };

  console.debug('[RuntimeDiagnostics] ready — T033: call RuntimeDiagnostics.print() in DevTools');
}());

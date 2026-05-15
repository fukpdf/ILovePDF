// CentralRuntime v1.0 — Phase 2 (T020)
// The brain of the ILovePDF browser-side compute platform.
// Ties together all Phase 2 subsystems into a single, authoritative runtime.
//
// CentralRuntime responsibilities:
//   - Tool orchestration via RuntimeAdapters
//   - Task routing via RuntimeScheduler
//   - Worker allocation via RuntimeWorkers
//   - Cancellation routing via RuntimeCancellation
//   - Memory awareness via RuntimeMemory
//   - Cleanup coordination via RuntimeCleanup
//   - Progress coordination via RuntimeProgress
//   - Telemetry coordination via RuntimeTelemetry
//   - Event bus via RuntimeEventBus
//   - State management via RuntimeState
//   - Health monitoring via RuntimeHealth
//
// DESIGN PRINCIPLE: CentralRuntime is a thin coordinator, NOT a monolith.
// It registers subsystems, exposes a unified surface, and bootstraps the
// runtime lifecycle. Each subsystem remains independently importable.
//
// ALL tools begin routing through CentralRuntime.execute() for full
// lifecycle management. Existing code continues to work unchanged.
//
// [FUTURE: RuntimeEvolution] CentralRuntime will gain:
//   - Cross-tab coordination (MultiTabCluster)
//   - Persistent job queue (IndexedDB-backed)
//   - Streaming task routing (OPFS byte-range)
//   - AI orchestration layer (AutonomousPlanner)
//   - Micro-frontend module federation bridge
//
// Exposed as: window.CentralRuntime (also window.RT for short)
(function () {
  'use strict';

  if (window.CentralRuntime) return;

  var VERSION = '2.0.0';
  var LOG = '[CRT]';
  var _startTs = Date.now();

  // ── Subsystem registry ────────────────────────────────────────────────────
  // Map<name, api> — subsystems self-register via CentralRuntime.register()
  var _subsystems = new Map();

  function register(name, api) {
    if (!name || !api) return;
    _subsystems.set(name, api);
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('runtime:subsystem-registered', { name: name }); } catch (_) {}
    }
  }

  function get(name) {
    return _subsystems.get(name) || null;
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  // Discovers all available Phase 2 subsystems and registers them.
  function _bootstrap() {
    var subs = [
      ['eventBus',      window.RuntimeEventBus],
      ['state',         window.RuntimeState],
      ['telemetry',     window.RuntimeTelemetry],
      ['cancellation',  window.RuntimeCancellation],
      ['memory',        window.RuntimeMemory],
      ['progress',      window.RuntimeProgress],
      ['scheduler',     window.RuntimeScheduler],
      ['workers',       window.RuntimeWorkers],
      ['queue',         window.RuntimeQueue],
      ['cleanup',       window.RuntimeCleanup],
      ['health',        window.RuntimeHealth],
      ['adapters',      window.RuntimeAdapters],
      ['streaming',     window.RuntimeStreaming],
      ['diagnostics',   window.RuntimeDiagnostics],
      // Phase 1C (backward-compatible)
      ['navCancel',     window.NavCancel],
      ['retryOrch',     window.RetryOrchestrator],
      ['downloadMgr',   window.DownloadManager],
      ['adaptiveDeg',   window.AdaptiveDegradation],
      ['cleanupContr',  window.CleanupContracts],
      ['workerLC',      window.WorkerLifecycle],
      // Phase 5 — Certification layer
      ['p5healthMon',   window.RuntimeHealthMonitor],
      ['p5coverage',    { report: window.RuntimeCoverageReport }],
      ['p5cert',        { report: window.RuntimeCertificationReport }],
      // Phase 6 — Persistence + Streaming + Cross-tab + AI
      ['idb',           window.RuntimeIDB],
      ['crossTab',      window.RuntimeCrossTab],
      ['aiOrch',        window.RuntimeAIOrchestrator],
      // Phase 8 — Production hardening + enterprise platform
      ['security',           window.RuntimeSecurity],
      ['memoryDefense',      window.RuntimeMemoryDefense],
      ['benchmarkEngine',    window.RuntimeBenchmark],
      ['distributedSched',   window.RuntimeDistributedScheduler],
      ['resultCache',        window.RuntimeResultCache],
      ['aiUpgrade',          window.RuntimeAIUpgrade],
      ['telemetryEnterprise',window.RuntimeTelemetryEnterprise],
      // Phase 9 — Distributed Browser OS + GPU Compute Platform
      ['wasmEngine',         window.RuntimeWasmEngine],
      ['gpuEngine',          window.RuntimeGpuEngine],
      ['kernel',             window.RuntimeKernel],
      ['sharedCluster',      window.RuntimeSharedCluster],
      ['sandbox',            window.RuntimeSandbox],
      ['incrementalPdf',     window.RuntimeIncrementalPdf],
      ['zeroCopy',           window.RuntimeZeroCopy],
      ['workspace',          window.RuntimeWorkspace],
      ['localAi',            window.RuntimeLocalAI],
      ['browserOSCert',      window.RuntimeBrowserOSCertification],
      // Phase 1A/1B
      ['p1',            window.P1],
      ['memPressure',   window.MemPressure],
      ['taskScheduler', window.TaskScheduler],
      ['workerPool',    window.WorkerPool],
      ['objectURLReg',  window.ObjectURLRegistry],
      ['timerReg',      window.TimerRegistry],
      ['lifecycleMgr',  window.LifecycleManager],
      ['adaptiveRT',    window.AdaptiveRuntime],
    ];
    subs.forEach(function (pair) {
      if (pair[1]) register(pair[0], pair[1]);
    });

    // Announce readiness
    if (window.RuntimeState) {
      try { window.RuntimeState.set('runtimeReady', true); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('runtime:ready', { version: VERSION, subsystems: _subsystems.size }); } catch (_) {}
    }
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('runtime:ready', { version: VERSION, subsystems: _subsystems.size }); } catch (_) {}
    }
  }

  // ── Core execute ──────────────────────────────────────────────────────────
  // The primary entry point for all tool operations.
  //
  // CentralRuntime.execute(toolId, fn, opts) → Promise<result>
  //
  // This replaces the scattered:
  //   BrowserTools.process(tool, file, opts)
  //   QueueClient.tryProcess(tool, files, opts, ui)
  // calls inside tool-page.js as tools are gradually migrated.
  //
  // fn receives: (progress: fn(pct, msg), token: CancellationToken)
  //
  // opts:
  //   type?      task type ('render'|'ocr'|'ai'|'compress'|'convert'|...)
  //   priority?  'high'|'normal'|'low'
  //   retries?   max retries (default 2)
  //   queued?    true → route through queue (server-side processing)
  //   tool?      tool object (required for queue path)
  //   files?     file array (required for queue path)
  //   options?   tool options object (for queue path)
  //   uiAdaptor? UI binding object (for queue path)
  //   label?     human-readable label for telemetry
  //   timeoutMs? per-task timeout
  //
  // [FUTURE: SmartRouter] execute() will use file size, MemPressure tier,
  // and tool benchmarks to auto-select browser vs server-side processing.
  async function execute(toolId, fn, opts) {
    opts = opts || {};

    // Pre-flight: emergency gate
    if (window.RuntimeState && window.RuntimeState.isEmergency()) {
      if (opts.type !== 'cleanup') {
        console.warn(LOG, 'execute blocked — runtime emergency mode');
        return Promise.reject(new Error('runtime-emergency'));
      }
    }

    // Pre-flight: health gate (score < 20 = critical failure — no new tasks)
    if (window.RuntimeHealth && window.RuntimeHealth.getScore() < 20) {
      console.warn(LOG, 'execute blocked — health score critical');
      return Promise.reject(new Error('runtime-health-critical'));
    }

    // Create a tool adapter (handles cancellation, progress, retries, telemetry)
    var adapter = window.RuntimeAdapters
      ? window.RuntimeAdapters.forTool(toolId, {
          priority:  opts.priority,
          type:      opts.type,
          retries:   opts.retries,
          timeoutMs: opts.timeoutMs,
        })
      : null;

    if (!adapter) {
      // Minimal fallback: just run fn directly
      return fn(function () {}, null);
    }

    // Queue path
    if (opts.queued && opts.tool) {
      return adapter.runQueued(opts.tool, opts.files, opts.options, opts.uiAdaptor);
    }

    // Browser path: adapter.run handles scheduling + cancellation + progress
    return adapter.run(function (progress) {
      return fn(progress, adapter.token);
    }, { stages: opts.stages });
  }

  // ── Queue bridge ──────────────────────────────────────────────────────────
  // Convenience: route a tool through the queue engine.
  async function executeQueued(tool, files, options, uiAdaptor, opts) {
    opts = opts || {};
    return execute(tool.id || 'queue-job', null, Object.assign({
      queued:     true,
      tool:       tool,
      files:      files,
      options:    options,
      uiAdaptor:  uiAdaptor || (window.RuntimeAdapters ? window.RuntimeAdapters.buildUiAdaptor() : null),
    }, opts));
  }

  // ── Worker dispatch ───────────────────────────────────────────────────────
  // Convenience: dispatch a task to a web worker through the orchestrator.
  function dispatchWorker(workerUrl, message, transferables, opts) {
    return window.RuntimeWorkers
      ? window.RuntimeWorkers.dispatch(workerUrl, message, transferables, opts)
      : (window.WorkerPool
          ? window.WorkerPool.run(workerUrl, message, transferables || [], opts)
          : Promise.reject(new Error('no worker runtime available')));
  }

  // ── Cancellation helpers ──────────────────────────────────────────────────
  function cancelTool(toolId) {
    if (window.RuntimeCancellation) {
      try { return window.RuntimeCancellation.cancelScope(toolId, 'cancel-tool'); } catch (_) {}
    }
    return 0;
  }

  function cancelAll(reason) {
    if (window.RuntimeCancellation) {
      try { window.RuntimeCancellation.cancelAll(reason || 'runtime-cancel-all'); } catch (_) {}
    }
    if (window.RuntimeAdapters) {
      try { window.RuntimeAdapters.cancelAll(reason); } catch (_) {}
    }
    if (window.RuntimeQueue) {
      try { window.RuntimeQueue.cancelAll(reason); } catch (_) {}
    }
  }

  // ── Unified cleanup ───────────────────────────────────────────────────────
  function cleanup(reason) {
    if (window.RuntimeCleanup) {
      return window.RuntimeCleanup.cleanupAll(reason || 'runtime-cleanup');
    }
    if (window.CleanupContracts) {
      window.CleanupContracts.cleanup(reason);
    }
  }

  // ── Status & diagnostics ──────────────────────────────────────────────────
  function status() {
    return {
      version:       VERSION,
      ready:         window.RuntimeState ? window.RuntimeState.get('runtimeReady') : false,
      mode:          window.RuntimeState ? window.RuntimeState.get('runtimeMode') : 'unknown',
      memoryTier:    window.RuntimeMemory ? window.RuntimeMemory.getTier() : 'unknown',
      healthScore:   window.RuntimeHealth ? window.RuntimeHealth.getScore() : -1,
      activeTasks:   window.RuntimeState ? window.RuntimeState.get('activeTasks') : 0,
      subsystems:    _subsystems.size,
      uptimeMs:      Date.now() - _startTs,
    };
  }

  function print() {
    if (window.RuntimeDiagnostics) {
      window.RuntimeDiagnostics.print();
    } else {
      console.log('[CentralRuntime]', status());
    }
  }

  // ── Lifecycle hooks ───────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    cancelAll('pagehide');
    cleanup('pagehide');
    if (window.RuntimeState) { try { window.RuntimeState.set('runtimeMode', 'shutdown'); } catch (_) {} }
    if (window.RuntimeEventBus) { try { window.RuntimeEventBus.emit('runtime:shutdown', { reason: 'pagehide' }); } catch (_) {} }
  }, { passive: true });

  // LifecycleManager integration
  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      if (reason === 'pagehide' || reason === 'pagehide-bfcache') return; // handled above
      // Tab hidden: cancel background scope only
      if (window.RuntimeCancellation) {
        try { window.RuntimeCancellation.cancelScope('background', reason); } catch (_) {}
      }
    });
    window.LifecycleManager.onResume(function () {
      if (window.RuntimeState) {
        try {
          var mode = window.RuntimeState.get('runtimeMode');
          if (mode === 'degraded') window.RuntimeState.set('runtimeMode', 'normal');
        } catch (_) {}
      }
    });
  }

  // ── Micro-frontend hooks (T032 extension) ─────────────────────────────────
  // [FUTURE: ModuleFederation] These stubs will be the module federation
  // boundary. Each "tool micro-frontend" will receive the runtime via
  // CentralRuntime.getModuleRuntime(moduleId) and communicate only through
  // the RuntimeEventBus — never by reaching across module boundaries.
  var _moduleRuntimes = new Map();

  function getModuleRuntime(moduleId) {
    if (!_moduleRuntimes.has(moduleId)) {
      // [FUTURE: ModuleFederation] return a scoped runtime view with
      // isolated state, scoped cancellation, and shared memory controller.
      _moduleRuntimes.set(moduleId, {
        moduleId:      moduleId,
        execute:       function (fn, opts) { return execute(moduleId, fn, opts); },
        cancel:        function (reason) { return cancelTool(moduleId); },
        on:            function (type, fn) { return window.RuntimeEventBus ? window.RuntimeEventBus.on(type, fn) : function () {}; },
        emit:          function (type, data) { return window.RuntimeEventBus ? window.RuntimeEventBus.emit(type, data) : null; },
      });
    }
    return _moduleRuntimes.get(moduleId);
  }

  // ── IndexedDB persistence — Phase 6A + 6F ────────────────────────────────
  // Delegates to RuntimeIDB which is loaded after this file.
  // At definition time the module may not exist; checked at call time.
  function persistState() {
    var idb = window.RuntimeIDB;
    if (idb && idb.persistState) return idb.persistState();
    return Promise.resolve(null);
  }

  function restoreState() {
    var idb = window.RuntimeIDB;
    if (idb && idb.restoreState) return idb.restoreState();
    return Promise.resolve(null);
  }

  // ── OPFS streaming — Phase 6B ─────────────────────────────────────────────
  // Returns an OPFS FileHandle for large-file streaming via RuntimeStreaming.
  function getOpfsHandle(filename) {
    var streaming = window.RuntimeStreaming;
    if (streaming && streaming.openFile && filename) {
      return streaming.openFile({ name: filename, size: 0, type: '' });
    }
    return Promise.resolve(null);
  }

  // ── AI orchestration — Phase 6E ───────────────────────────────────────────
  // Delegates to RuntimeAIOrchestrator.runAiTask(); falls back to
  // direct GenerativeAiEngine.generate() if orchestrator not loaded.
  function runAiTask(taskType, payload) {
    var aiOrch = window.RuntimeAIOrchestrator;
    if (aiOrch && aiOrch.runAiTask) return aiOrch.runAiTask(taskType, payload || {});
    // Direct fallback to GenerativeAiEngine
    var GAE = window.GenerativeAiEngine;
    if (GAE && typeof GAE.generate === 'function') {
      var text = (payload && (payload.text || payload.prompt)) || '';
      return GAE.generate(text, { intent: taskType })
        .then(function (r) { return { result: typeof r === 'string' ? r : (r && r.result) || String(r), provider: 'GenerativeAiEngine-direct' }; });
    }
    console.warn(LOG, 'AI orchestration not loaded — taskType:', taskType);
    return Promise.reject(new Error('ai-orchestrator-not-loaded'));
  }

  // ── Bootstrap (deferred to allow all scripts to load) ────────────────────
  // Bootstrap runs after DOMContentLoaded to give deferred scripts time to load.
  var _bootstrapped = false;
  function _doBootstrap() {
    if (_bootstrapped) return;
    _bootstrapped = true;
    _bootstrap();
    console.info(LOG, 'CentralRuntime v' + VERSION + ' ready — ' + _subsystems.size + ' subsystems registered');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_doBootstrap, 100);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_doBootstrap, 100); }, { once: true });
  }

  // ── Public surface ────────────────────────────────────────────────────────
  window.CentralRuntime = {
    VERSION: VERSION,

    // Subsystem registry
    register:       register,
    get:            get,

    // Core execution
    execute:        execute,
    executeQueued:  executeQueued,
    dispatchWorker: dispatchWorker,

    // Cancellation
    cancelTool:     cancelTool,
    cancelAll:      cancelAll,

    // Cleanup
    cleanup:        cleanup,

    // Status
    status:         status,
    print:          print,

    // Micro-frontend hooks
    getModuleRuntime: getModuleRuntime,

    // Future: IndexedDB
    persistState:   persistState,
    restoreState:   restoreState,

    // Future: OPFS
    getOpfsHandle:  getOpfsHandle,

    // Future: AI
    runAiTask:      runAiTask,
  };

  // Short alias for convenience in DevTools: RT.print(), RT.status(), etc.
  window.RT = window.CentralRuntime;

  console.debug(LOG, 'CentralRuntime v' + VERSION + ' loaded — T020 bootstrap pending');
}());

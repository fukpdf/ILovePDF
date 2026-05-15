// PdfWorkerRuntimeFactory v1.0 — Shared runtime + adapter factory for PDF tools.
//
// ELIMINATES DUPLICATION: merge-runtime.js and rotate-runtime.js each contain
// ~200 lines of identical boilerplate (_resetRunState, _memoryGuard, _shouldUseSafeMode,
// _buildProgressReporter, _runPostCleanup, execute() with fallback, pagehide listener,
// _applyPatch retry, etc.). Every new tool would repeat this.
//
// This factory internalises all shared logic. Each tool provides only the
// configuration that differs (toolId, progress messages, telemetry attrs, filename).
//
// ADAPTER MODES (cfg.adapterMode):
//   'worker'           — dispatches to pdf-worker.js via RuntimeWorkers/WorkerPool.
//                        Use for tools already in pdf-worker.js OPS table:
//                        page-numbers, watermark (and any future additions).
//   'scheduler-only'   — runs the original browser-tools.js handler (main thread)
//                        inside a RuntimeScheduler slot. Adds concurrency control,
//                        cancellation, telemetry. Use for tools NOT in pdf-worker.js:
//                        split, organize, protect, unlock.
//
// BACKWARD COMPAT: merge-runtime.js and rotate-runtime.js are NOT replaced.
// They continue to work via the existing patch chain. The registry intercepts
// only newly registered tools.
//
// FEATURE FLAGS:
//   Each tool gets its own window.RUNTIME_<TOOL>_ENABLED flag (set in cfg.flagName).
//   Registry's isEnabled() check short-circuits to legacy if the flag is false.
//   The execute() wrapper also re-checks the flag before calling the runtime path.
//
// FUTURE HOOKS (preserved from merge/rotate runtimes):
//   [FUTURE: StreamEngine] — all file reads are marked via RuntimeStreaming.markFullLoad.
//   [FUTURE: IndexedDB]    — output buffer could be persisted before Blob creation.
//   [FUTURE: OPFSRuntime]  — output written to OPFS before URL hand-off.
//
// Exposed as: window.PdfWorkerRuntimeFactory
// Requires: window.PdfRuntimeRegistry (must load before this file)

(function () {
  'use strict';

  if (window.PdfWorkerRuntimeFactory) return;

  var WORKER_URL = '/workers/pdf-worker.js';

  // ══════════════════════════════════════════════════════════════════════════
  // SHARED UTILITIES — extracted from merge-runtime.js / rotate-runtime.js
  // ══════════════════════════════════════════════════════════════════════════

  // ── Memory guard ──────────────────────────────────────────────────────────
  // Three-tier check: RuntimeMemory tier → MemPressure heap estimate → inline.
  // files is null for post-worker checks (no size to estimate).
  function _sharedMemoryGuard(phase, files, toolId) {
    if (window.RuntimeMemory) {
      if (window.RuntimeMemory.isEmergency()) throw new Error('memory_pressure');
      if (window.RuntimeMemory.isCritical() && window.RuntimeCleanup) {
        try { window.RuntimeCleanup.lightCleanup(toolId + '-critical-guard'); } catch (_) {}
      }
    }
    if (files && window.MemPressure && window.MemPressure.wouldExceedLimit) {
      var totalBytes = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
      // 3× estimate: raw input buffer + pdf-lib internal copy + output buffer
      if (window.MemPressure.wouldExceedLimit(totalBytes * 3, 1.3)) {
        throw new Error('memory_pressure');
      }
    }
    try {
      var mem = performance && performance.memory;
      if (mem && mem.usedJSHeapSize > 900 * 1024 * 1024) throw new Error('memory_pressure');
    } catch (e) {
      if (e.message === 'memory_pressure') throw e;
    }
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record(toolId + ':memory-guard-ok', { phase: phase }); } catch (_) {}
    }
  }

  // ── Safe-mode detection ───────────────────────────────────────────────────
  // Returns true when we should serialise operations and skip previews.
  // Mirrors MergeRuntime._shouldUseSafeMode() exactly.
  function _sharedSafeMode(files) {
    var ua        = navigator.userAgent || '';
    var isMobile  = /Mobile|Tablet|Android|iPhone|iPad/i.test(ua);
    var isLowCore = (navigator.hardwareConcurrency || 4) <= 2;
    var totalMB   = files.reduce(function (s, f) { return s + (f.size || 0); }, 0) / (1024 * 1024);
    var isCritical = window.RuntimeMemory && window.RuntimeMemory.isCritical();
    return isCritical || (isMobile && totalMB > 50) || (isLowCore && totalMB > 100) || totalMB > 500;
  }

  // ── Progress ticker ───────────────────────────────────────────────────────
  // Advances startPct→85% asymptotically while the tool/worker is running.
  // Stops when the caller invokes stopTicker().
  function _startProgressTicker(startPct, msgs, timerOwner, onProgress) {
    var pct    = startPct || 15;
    var msgIdx = 0;
    msgs = (msgs && msgs.length) ? msgs : ['Processing…'];
    var span = 85 - pct;

    var intervalId = setInterval(function () {
      if (pct >= 85) { clearInterval(intervalId); return; }
      // Asymptotic advance: large steps early, tiny at the end — realistic feel.
      var step = Math.max(1, Math.round((85 - pct) * 0.13));
      pct = Math.min(85, pct + step);
      // Map progress through the messages array evenly.
      msgIdx = Math.min(msgs.length - 1, Math.floor(((pct - startPct) / span) * msgs.length));
      onProgress(pct, msgs[msgIdx]);
    }, 750);

    if (window.TimerRegistry) window.TimerRegistry.registerInterval(timerOwner, intervalId);

    return function stopTicker() {
      clearInterval(intervalId);
      if (window.TimerRegistry) window.TimerRegistry.clearOwner(timerOwner);
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADAPTER: SCHEDULER-ONLY (main-thread, non-worker tools)
  // ══════════════════════════════════════════════════════════════════════════
  // Runs split / organize / protect / unlock on the main thread through the
  // original BrowserTools.process handler, wrapped in telemetry + progress.
  //
  // Flow: pre-check → origProcess(toolId, files, opts) → { blob, filename }
  //       → convert blob → ArrayBuffer → return { buffer, blobSize }
  //
  // The Blob→ArrayBuffer conversion is a mild overhead (~1ms for typical PDFs)
  // but gives runToolRuntime() a uniform interface for both adapter modes.

  async function _schedulerOnlyDispatch(cfg, files, opts, onProgress, token) {
    var toolId = cfg.toolId;
    var file   = files[0];

    // Pre-check: cancellation + emergency memory
    if (token && token.cancelled) throw new Error('cancelled-before-dispatch');
    if (window.RuntimeMemory && window.RuntimeMemory.isEmergency()) {
      throw new Error('memory_pressure');
    }

    // Telemetry span for this dispatch phase
    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan(toolId + ':dispatch', {
        name: file.name, size: file.size,
      });
    }

    // [FUTURE: StreamEngine] Mark full-load points so StreamEngine can intercept.
    if (window.RuntimeStreaming && window.RuntimeStreaming.markFullLoad) {
      window.RuntimeStreaming.markFullLoad(toolId + ':file-read-phase', {
        name: file.name, size: file.size,
        description: 'Full PDF read by main-thread handler (scheduler-only mode)',
      });
    }

    onProgress(5, 'Preparing…');

    // Get the pre-registry saved origProcess.
    // For non-WORKER tools this routes: rotate-patch → merge-patch → original
    // → HANDLERS[toolId](files, opts) → returns { blob, filename }.
    var origProcess = window.PdfRuntimeRegistry
      ? window.PdfRuntimeRegistry.getOrigProcess()
      : null;
    if (!origProcess) {
      if (spanId !== null && window.RuntimeTelemetry) {
        window.RuntimeTelemetry.endSpan(spanId, 'no-orig-process');
      }
      throw new Error('PdfRuntimeRegistry.getOrigProcess() unavailable');
    }

    onProgress(15, 'Processing…');

    // Progress ticker: advances 15→85% while origProcess runs (main-thread pdf-lib work).
    var tickerOwner = cfg.timerOwner || (toolId + '-stk');
    var stopTicker  = _startProgressTicker(
      15,
      cfg.workerProgressMessages || ['Processing…', 'Building PDF…', 'Finalising…'],
      tickerOwner,
      onProgress
    );

    var resultObj;
    try {
      // origProcess routes to the original BrowserTools.process for this toolId,
      // which calls the HANDLERS function (e.g. split(), organize()) on the main thread.
      // Returns: { blob: Blob, filename: string }
      resultObj = await origProcess(toolId, files, opts);
    } catch (dispatchErr) {
      if (spanId !== null && window.RuntimeTelemetry) {
        window.RuntimeTelemetry.endSpan(spanId, 'dispatch-error');
      }
      throw dispatchErr;
    } finally {
      stopTicker();
    }

    // Validate result
    var resultBlob = (resultObj && resultObj.blob) ? resultObj.blob : resultObj;
    if (!resultBlob || !resultBlob.size || resultBlob.size === 0) {
      if (spanId !== null && window.RuntimeTelemetry) {
        window.RuntimeTelemetry.endSpan(spanId, 'empty-result');
      }
      throw new Error('Tool produced empty output — falling back');
    }

    // Convert Blob → ArrayBuffer for the uniform runToolRuntime() interface.
    // [FUTURE: OPFSRuntime] Write to OPFS here instead of extracting buffer.
    onProgress(90, 'Saving…');
    var buffer = await resultBlob.arrayBuffer();

    if (spanId !== null && window.RuntimeTelemetry) {
      window.RuntimeTelemetry.endSpan(spanId, 'ok');
    }

    onProgress(95, 'Done!');
    return { buffer: buffer, blobSize: resultBlob.size };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADAPTER: WORKER-DISPATCH (off-main-thread, tools in pdf-worker.js OPS)
  // ══════════════════════════════════════════════════════════════════════════
  // Reads the single input file into an ArrayBuffer, dispatches to pdf-worker.js
  // via RuntimeWorkers.dispatch() (Phase 2) with WorkerPool.run() fallback.
  // Follows the RotateWorkerAdapter pattern exactly.
  //
  // Progress phases:
  //   5% → preparing
  //   10→50% → file read
  //   50→85% → worker ticker (asymptotic)
  //   95% → saving
  //   100% → done

  async function _workerDispatch(cfg, files, opts, onProgress, token) {
    var toolId     = cfg.toolId;
    var file       = files[0];
    var totalBytes = file.size;

    // Pre-check: cancellation + memory
    if (token && token.cancelled) throw new Error('cancelled-before-read');
    if (window.RuntimeMemory && window.RuntimeMemory.isEmergency()) {
      throw new Error('memory_pressure');
    }
    if (window.MemPressure && window.MemPressure.wouldExceedLimit) {
      // 2× estimate: input buffer + pdf-lib internal copy
      if (window.MemPressure.wouldExceedLimit(totalBytes * 2, 1.5)) {
        throw new Error('memory_pressure');
      }
    }

    // Telemetry: outer dispatch span
    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan(toolId + ':worker-dispatch', {
        name: file.name, size: totalBytes,
      });
    }

    onProgress(5, 'Preparing file…');

    // [FUTURE: StreamEngine] Replace arrayBuffer() with OPFS byte-range reader.
    if (window.RuntimeStreaming && window.RuntimeStreaming.markFullLoad) {
      window.RuntimeStreaming.markFullLoad(toolId + ':read-file', {
        name: file.name, size: totalBytes,
        description: 'Full PDF read as ArrayBuffer before worker dispatch',
      });
    }

    // File read phase (progress 10→50%)
    var readSpanId = null;
    if (window.RuntimeTelemetry) {
      readSpanId = window.RuntimeTelemetry.startSpan(toolId + ':file-read', {
        name: file.name, size: totalBytes,
      });
    }

    onProgress(10, 'Reading file…');

    if (token && token.cancelled) {
      if (spanId    !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId,    'cancelled');
      if (readSpanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(readSpanId, 'cancelled');
      throw new Error('cancelled-during-read');
    }

    var buf;
    try {
      // [FUTURE: StreamEngine] file.arrayBuffer() → OPFS byte-range stream
      buf = await file.arrayBuffer();
    } catch (readErr) {
      if (readSpanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(readSpanId, 'read-error');
      if (spanId     !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId,     'read-error');
      throw readErr;
    }

    if (readSpanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(readSpanId, 'ok');
    onProgress(50, 'Dispatching to worker…');

    if (token && token.cancelled) {
      buf = null;
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'cancelled');
      throw new Error('cancelled-after-read');
    }

    // Worker dispatch phase (progress 50→85% via ticker)
    var dedupeKey = cfg.buildDedupeKey
      ? cfg.buildDedupeKey(files, opts)
      : (toolId + ':' + file.name + ':' + file.size);

    var workerMsg = {
      tool:    toolId,
      buffers: [buf],
      options: opts,
    };

    var tickerOwner = cfg.timerOwner || (toolId + '-wtk');
    var stopTicker  = _startProgressTicker(
      50,
      cfg.workerProgressMessages || ['Processing…', 'Building PDF…', 'Finalising…'],
      tickerOwner,
      onProgress
    );

    var workerResult;
    try {
      if (window.RuntimeWorkers && window.RuntimeWorkers.dispatch) {
        // Phase 2 path — full orchestration: cooldown, dedup, timeout, telemetry.
        // transferables: buf ownership moves to worker (zero-copy).
        workerResult = await window.RuntimeWorkers.dispatch(
          WORKER_URL,
          workerMsg,
          [buf],
          {
            priority:  'normal',
            label:     toolId + '-worker',
            dedupeKey: dedupeKey,
            timeoutMs: cfg.workerTimeout || cfg.timeoutMs || 90000,
            token:     token,
          }
        );
      } else if (window.WorkerPool && window.WorkerPool.run) {
        // Fallback: direct WorkerPool.run (Phase 1 / legacy path)
        var wpToken = null;
        if (window.WorkerPool.CancelToken) wpToken = window.WorkerPool.CancelToken();
        if (token && wpToken) {
          token.onCancel(function () { try { wpToken.cancel(); } catch (_) {} });
        }
        var wpOpts = {};
        if (wpToken) wpOpts.token = wpToken;
        workerResult = await window.WorkerPool.run(WORKER_URL, workerMsg, [buf], wpOpts);
      } else {
        // No worker infrastructure — signal caller to use legacy fallback.
        throw new Error('no-worker-runtime');
      }
    } finally {
      stopTicker();
      buf = null; // release buffer reference immediately
    }

    // Validate worker output
    if (!workerResult || !workerResult.buffer) {
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'empty-result');
      throw new Error('Worker produced empty output — falling back');
    }

    var probe = new Blob([workerResult.buffer], { type: 'application/pdf' });
    if (probe.size === 0) {
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'zero-size');
      throw new Error('Worker produced empty output — falling back');
    }

    if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'ok');
    onProgress(100, 'Done!');

    // [FUTURE: StreamEngine] workerResult.buffer → OPFS write + stream URL
    return { buffer: workerResult.buffer, blobSize: probe.size };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FACTORY: createPdfToolRuntime(cfg)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // cfg fields (required):
  //   toolId:      {string}   BrowserTools.process toolId — e.g. 'split'
  //   namespace:   {string}   window key for the runtime — e.g. 'SplitRuntime'
  //   flagName:    {string}   feature-flag window key — e.g. 'RUNTIME_SPLIT_ENABLED'
  //   LOG:         {string}   log prefix — e.g. '[SRT]'
  //   adapterMode: {string}   'worker' | 'scheduler-only'
  //
  // cfg fields (optional):
  //   timeoutMs:               {number}   cancellation token timeout (default 90000)
  //   timerOwner:              {string}   TimerRegistry owner key for progress ticker
  //   workerTimeout:           {number}   worker-mode: RuntimeWorkers timeout (default = timeoutMs)
  //   workerProgressMessages:  {string[]} messages shown during ticker phase
  //   buildDedupeKey:          {fn(files,opts)→string}  worker-mode: dedup key
  //   buildProgressTitle:      {fn(files,opts)→string}  showProcessing title
  //   buildProgressSubtitle:   {fn(files,opts)→string}  showProcessing subtitle
  //   buildSpanAttrs:          {fn(files,opts)→object}  telemetry span attrs
  //   buildSuccessAttrs:       {fn(files,blob,opts,ms)→object} telemetry success attrs
  //   buildFilename:           {fn(files,opts)→string}  output filename

  function createPdfToolRuntime(cfg) {
    // ── Config validation ─────────────────────────────────────────────────
    if (!cfg || !cfg.toolId)    throw new Error('[PdfWorkerRuntimeFactory] cfg.toolId required');
    if (!cfg.namespace)         throw new Error('[PdfWorkerRuntimeFactory] cfg.namespace required');
    if (!cfg.flagName)          throw new Error('[PdfWorkerRuntimeFactory] cfg.flagName required');
    if (!cfg.LOG)               throw new Error('[PdfWorkerRuntimeFactory] cfg.LOG required');
    if (cfg.adapterMode !== 'worker' && cfg.adapterMode !== 'scheduler-only') {
      throw new Error('[PdfWorkerRuntimeFactory] cfg.adapterMode must be "worker" or "scheduler-only"');
    }

    var LOG   = cfg.LOG;
    var toolId = cfg.toolId;

    // ── Feature flag ──────────────────────────────────────────────────────
    // Only set the default if not already overridden by external code.
    if (typeof window[cfg.flagName] === 'undefined') {
      window[cfg.flagName] = true;
    }

    // ── Per-run state ─────────────────────────────────────────────────────
    // All variables reset between runs via _resetRunState().
    var _currentToken = null;  // RuntimeCancellation token
    var _currentSpan  = null;  // RuntimeTelemetry span id
    var _progressTask = null;  // RuntimeProgress task (scheduler fallback only)
    var _cleanupIds   = { blobs: [], generic: [] };

    function _resetRunState() {
      _currentToken = null;
      _currentSpan  = null;
      _progressTask = null;
      _cleanupIds   = { blobs: [], generic: [] };
    }

    // ── Memory guard wrappers ─────────────────────────────────────────────
    function _memoryGuard(phase, files) {
      _sharedMemoryGuard(phase, files || null, toolId);
    }

    // ── Safe-mode detection ───────────────────────────────────────────────
    function _shouldUseSafeMode(files) {
      return _sharedSafeMode(files);
    }

    // ── Progress reporter ─────────────────────────────────────────────────
    // Updates RuntimeProgress (when _progressTask exists) AND window.showProcessing.
    function _buildProgressReporter(files, opts) {
      var title    = cfg.buildProgressTitle    ? cfg.buildProgressTitle(files, opts)    : (toolId + '…');
      var subtitle = cfg.buildProgressSubtitle ? cfg.buildProgressSubtitle(files, opts) : 'Processing…';

      return function onProgress(pct, msg) {
        if (_progressTask) {
          try { window.RuntimeProgress.report(_progressTask.taskId, 0, pct, msg); } catch (_) {}
        }
        if (window.showProcessing) {
          try { window.showProcessing(title, msg || subtitle); } catch (_) {}
        }
      };
    }

    // ── Post-run cleanup ──────────────────────────────────────────────────
    // Idempotent — safe to call multiple times.
    function _runPostCleanup(reason) {
      reason = reason || 'unknown';

      if (window.RuntimeCleanup) {
        try {
          _cleanupIds.blobs.forEach(function (id) { window.RuntimeCleanup.untrackBlob(id); });
          _cleanupIds.generic.forEach(function (id) { window.RuntimeCleanup.untrackGeneric(id); });
        } catch (_) {}
      }

      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record(toolId + ':cleanup', { reason: reason }); } catch (_) {}
      }

      _resetRunState();
    }

    // ── Dispatch router ───────────────────────────────────────────────────
    // Selects adapter mode based on cfg.adapterMode.
    async function _doDispatch(files, opts, onProgress, token) {
      if (cfg.adapterMode === 'worker') {
        return _workerDispatch(cfg, files, opts, onProgress, token);
      }
      return _schedulerOnlyDispatch(cfg, files, opts, onProgress, token);
    }

    // ── Core runtime path ─────────────────────────────────────────────────
    // Full runtime-driven processing. Returns { blob, filename } on success.
    // Throws to trigger the auto-fallback in execute().
    async function runToolRuntime(files, opts) {
      var startTs = Date.now();

      // ── Pre-flight memory guard ────────────────────────────────────────
      _memoryGuard('pre-start', files);

      // ── Cancellation token ─────────────────────────────────────────────
      _currentToken = window.RuntimeCancellation
        ? window.RuntimeCancellation.createScopedToken(toolId, {
            label:     toolId + '-run',
            timeoutMs: cfg.timeoutMs || 90000,
          })
        : null;

      // ── Telemetry span ─────────────────────────────────────────────────
      var spanAttrs = cfg.buildSpanAttrs
        ? cfg.buildSpanAttrs(files, opts)
        : { name: files[0] && files[0].name };
      spanAttrs.safeMode = _shouldUseSafeMode(files);

      if (window.RuntimeTelemetry) {
        _currentSpan = window.RuntimeTelemetry.startSpan(toolId + ':full-run', spanAttrs);
        window.RuntimeTelemetry.record(toolId + ':start', spanAttrs);
      }

      // ── Progress reporter ──────────────────────────────────────────────
      var onProgress = _buildProgressReporter(files, opts);
      onProgress(2, 'Preparing…');
      _memoryGuard('pre-read', files);

      if (_currentToken && _currentToken.cancelled) throw new Error('cancelled');

      // ── RuntimeScheduler slot ──────────────────────────────────────────
      // RuntimeScheduler.run() manages its own internal RuntimeProgress task
      // when opts.label is set — do NOT create a duplicate _progressTask here.
      var workerResult;
      if (window.RuntimeScheduler) {
        // Scheduler creates its own progress task via opts.label; no _progressTask needed.
        workerResult = await window.RuntimeScheduler.run(
          function () {
            return _doDispatch(files, opts, onProgress, _currentToken);
          },
          {
            type:     toolId,
            priority: 'normal',
            label:    toolId,
            token:    _currentToken,
          }
        );
      } else {
        // No scheduler: create own progress task as fallback only.
        if (window.RuntimeProgress) {
          _progressTask = window.RuntimeProgress.createSimpleTask(toolId, _currentToken);
        }
        workerResult = await _doDispatch(files, opts, onProgress, _currentToken);
      }

      // ── Post-dispatch memory guard ─────────────────────────────────────
      _memoryGuard('post-dispatch', null);

      onProgress(96, 'Preparing download…');

      // [FUTURE: StreamEngine] workerResult.buffer → OPFS write + stream URL
      // [FUTURE: IndexedDB]    Persist buffer to IDB before Blob creation
      var blob = new Blob([workerResult.buffer], { type: 'application/pdf' });
      workerResult = null; // release buffer reference immediately

      // Track for cleanup
      if (window.RuntimeCleanup && window.RuntimeCleanup.trackGeneric) {
        var cleanId = window.RuntimeCleanup.trackGeneric(function () {
          // placeholder — OPFS cleanup will go here when StreamEngine lands
        }, toolId + '-output-blob');
        _cleanupIds.generic.push(cleanId);
      }

      // ── Telemetry: success ─────────────────────────────────────────────
      var durationMs   = Date.now() - startTs;
      var successAttrs = cfg.buildSuccessAttrs
        ? cfg.buildSuccessAttrs(files, blob, opts, durationMs)
        : {};
      successAttrs.durationMs  = durationMs;
      successAttrs.outputBytes = blob.size;

      if (window.RuntimeTelemetry) {
        window.RuntimeTelemetry.record(toolId + ':success', successAttrs);
        if (_currentSpan !== null) window.RuntimeTelemetry.endSpan(_currentSpan, 'ok');
      }

      if (_progressTask) { try { _progressTask.complete(); } catch (_) {} }

      // ── Filename ───────────────────────────────────────────────────────
      var filename = cfg.buildFilename
        ? cfg.buildFilename(files, opts)
        : (window.BrowserTools && window.BrowserTools.brandedFilename
            ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
            : 'ILovePDF-' + toolId + '.pdf');

      _runPostCleanup('success');

      return { blob: blob, filename: filename };
    }

    // ── Legacy path ───────────────────────────────────────────────────────
    // Called when: (a) feature flag is false, or (b) runtime path throws
    // with a non-terminal error. Routes to the saved origProcess chain.
    async function runToolLegacy(files, opts) {
      var origProcess = window.PdfRuntimeRegistry
        ? window.PdfRuntimeRegistry.getOrigProcess()
        : null;
      if (!origProcess) throw new Error('PdfRuntimeRegistry.getOrigProcess() unavailable for legacy path');

      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record(toolId + ':legacy-path', {}); } catch (_) {}
      }

      // origProcess is the pre-registry chain (rotate → merge → original).
      // For these tools it routes to the original HANDLERS function.
      return origProcess(toolId, files, opts);
    }

    // ── Full runtime entry point ──────────────────────────────────────────
    // This is what PdfRuntimeRegistry calls. Returns { blob, filename }.
    // Runtime errors auto-fallback to legacy; terminal errors (cancelled,
    // memory_pressure, runtime-emergency) are re-thrown as-is.
    async function execute(files, opts) {
      if (!window[cfg.flagName]) {
        return runToolLegacy(files, opts);
      }

      // Safe-mode telemetry reporting
      var safeMode = _shouldUseSafeMode(files);
      if (safeMode && window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record(toolId + ':safe-mode', {}); } catch (_) {}
      }

      try {
        return await runToolRuntime(files, opts);
      } catch (runtimeErr) {
        var failReason = (runtimeErr && runtimeErr.message) || 'unknown';

        // Terminal errors: do NOT fallback. These must surface to processFile().
        if (failReason === 'cancelled'           ||
            failReason.startsWith('cancelled-')  ||
            failReason === 'memory_pressure'     ||
            failReason === 'runtime-emergency') {
          _runPostCleanup('error:' + failReason);
          throw runtimeErr;
        }

        // Log and emit health event
        if (window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.record(toolId + ':runtime-fallback', { reason: failReason }); } catch (_) {}
        }
        if (window.RuntimeEventBus) {
          try { window.RuntimeEventBus.emit('health:degraded', {
            component: toolId + '-runtime', reason: failReason,
          }); } catch (_) {}
        }
        console.warn(LOG, 'runtime path failed — falling back to legacy. reason:', failReason);

        _runPostCleanup('fallback:' + failReason);
        return runToolLegacy(files, opts);
      }
    }

    // ── Register with PdfRuntimeRegistry ─────────────────────────────────
    // Must happen after the registry patch is applied. Since per-tool runtime
    // files load after pdf-runtime-registry.js, the registry is ready here.
    function _register() {
      if (!window.PdfRuntimeRegistry) {
        console.warn(LOG, 'PdfRuntimeRegistry not loaded — registration skipped for', toolId);
        return;
      }
      window.PdfRuntimeRegistry.register(
        toolId,
        execute,
        function () { return !!window[cfg.flagName]; }
      );
      console.debug(LOG, 'registered toolId:', toolId, 'with PdfRuntimeRegistry');
    }

    // ── Navigation safety: cancel active run on hide/pagehide ─────────────
    // PdfRuntimeRegistry installs ONE LifecycleManager + pagehide listener
    // that fans out to all registered onHide callbacks.
    if (window.PdfRuntimeRegistry) {
      window.PdfRuntimeRegistry.onHide(function (reason) {
        if (_currentToken && !_currentToken.cancelled) {
          _currentToken.cancel(reason === 'pagehide' ? 'pagehide' : 'tab-hidden');
          _runPostCleanup('nav-cancel:' + reason);
        }
        if (reason === 'pagehide' && _currentSpan !== null && window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.endSpan(_currentSpan, 'pagehide'); } catch (_) {}
        }
      });
    }

    // ── Streaming markers ─────────────────────────────────────────────────
    // [FUTURE: StreamEngine] These become stream entry points when active.
    if (window.RuntimeStreaming) {
      try {
        window.RuntimeStreaming.markFullLoad(toolId + ':output-blob', {
          description: 'Full output buffer held in JS heap as Blob',
        });
        window.RuntimeStreaming.markFullLoad(toolId + ':status-url', {
          description: 'Output Blob converted to Object URL for download',
        });
      } catch (_) {}
    }

    // ── Apply registration ─────────────────────────────────────────────────
    _register();

    // ── Public API ─────────────────────────────────────────────────────────
    var api = {
      // Core paths
      execute:        execute,
      runToolRuntime: runToolRuntime,
      runToolLegacy:  runToolLegacy,

      // Feature flag control
      enable:  function () { window[cfg.flagName] = true;  console.info(LOG, 'runtime ENABLED');  },
      disable: function () { window[cfg.flagName] = false; console.info(LOG, 'runtime DISABLED — legacy path active'); },

      // Diagnostics
      getDiagnostics: function () {
        return {
          toolId:         toolId,
          adapterMode:    cfg.adapterMode,
          runtimeEnabled: !!window[cfg.flagName],
          registryActive: !!(window.PdfRuntimeRegistry && window.PdfRuntimeRegistry.isPatchApplied()),
          activeToken:    _currentToken ? { cancelled: _currentToken.cancelled } : null,
          activeSpan:     _currentSpan,
          progressTask:   _progressTask ? _progressTask.taskId : null,
        };
      },

      // Manual cancel (for testing / emergency stop)
      cancelActive: function (reason) {
        if (_currentToken && !_currentToken.cancelled) {
          _currentToken.cancel(reason || 'manual-cancel');
          _runPostCleanup('manual-cancel');
          return true;
        }
        return false;
      },
    };

    window[cfg.namespace] = api;
    console.debug(LOG, cfg.namespace, 'ready |', cfg.flagName + ':', !!window[cfg.flagName], '| mode:', cfg.adapterMode);

    return api;
  }

  // ── Public surface ────────────────────────────────────────────────────────
  window.PdfWorkerRuntimeFactory = {
    createPdfToolRuntime: createPdfToolRuntime,
  };

  console.debug('[PdfWorkerRuntimeFactory] ready — createPdfToolRuntime() available');
}());

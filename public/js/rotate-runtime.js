// Rotate Runtime v1.0 — Phase 3 (Task Groups R003–R019)
// Second fully Runtime-driven tool. Follows MergeRuntime as canonical pattern.
//
// Differences from MergeRuntime:
//   - Single-file input (opts.degrees + opts.pages carried through)
//   - DedupeKey includes rotation angle and page range
//   - No artificial processing-time cutoff; cancellation/runtime pressure remain available
//
// DESIGN: Monkey-patches BrowserTools.process('rotate', ...) only.
//   - All other tools: completely unaffected
//   - processFile() in tool-page.js: zero modifications
//   - tryWithRetry(), OutputValidator, showStatus, Flow: zero modifications
//   - Runtime failures remain visible to the caller; no hidden legacy fallback is used.
//
// Runtime diagnostic flag: window.RUNTIME_ROTATE_ENABLED = true (default)
//               Set to false only to mark runtime as disabled in diagnostics;
//               it does not select an alternate processing pipeline.
//
// [FUTURE: StreamEngine] Replace _readFile() in RotateWorkerAdapter with
// OPFS byte-range chunks when StreamEngine ships.
//
// [FUTURE: IndexedDB] Persist rotated result to IDB before handing URL to
// showStatus() so refresh-after-rotate recovers the file without re-processing.
//
// [FUTURE: OPFSRuntime] Write intermediate rotated buffer to OPFS to avoid
// buffer+Blob double-hold in the JS heap on large single-file PDFs.
//
// [FUTURE: AIOrchestrator] After rotate:success, optionally trigger
// CentralRuntime.runAiTask('verify-orientation', outputBlob) to confirm
// all pages are in the expected orientation.
//
// Exposed as: window.RotateRuntime
(function () {
  'use strict';

  if (window.RotateRuntime) return;

  // ── Feature flag ──────────────────────────────────────────────────────────
  if (typeof window.RUNTIME_ROTATE_ENABLED === 'undefined') {
    window.RUNTIME_ROTATE_ENABLED = true;
  }

  var LOG   = '[RRT]';
  var OWNER = 'rotate-runtime';

  // ── Per-run state ─────────────────────────────────────────────────────────
  // All state resets between runs via _resetRunState().
  var _origProcess  = null; // saved before patch; never overwritten
  var _currentToken = null; // RuntimeCancellation token for active run
  var _currentSpan  = null; // RuntimeTelemetry span for full run
  var _progressTask = null; // RuntimeProgress task (scheduler-fallback only)
  var _cleanupIds   = { blobs: [], generic: [] };

  function _resetRunState() {
    _currentToken = null;
    _currentSpan  = null;
    _progressTask = null;
    _cleanupIds   = { blobs: [], generic: [] };
  }

  // ── Progress reporter ─────────────────────────────────────────────────────
  // Updates RuntimeProgress (when _progressTask exists) AND window.showProcessing
  // (already visible — we update the spinner text mid-run for better UX).
  function _buildProgressReporter(opts, progressTask) {
    var degrees = String((opts && opts.degrees) || '0');
    var pages   = String((opts && opts.pages)   || 'all');
    var subtitle = pages === 'all'
      ? 'Rotating all pages ' + degrees + '°…'
      : 'Rotating pages ' + pages + ' by ' + degrees + '°…';
    var _lastMilestone = -1;

    return function onProgress(pct, msg) {
      if (progressTask) {
        try { window.RuntimeProgress.report(progressTask.taskId, 0, pct, msg); } catch (_) {}
      }
      if (window.showProcessing) {
        try { window.showProcessing('Rotating PDF…', msg || subtitle); } catch (_) {}
      }
      // Per-tool milestone telemetry at 25% increments
      if (window.RuntimeTelemetry) {
        var _ms = Math.floor(pct / 25) * 25;
        if (_ms > 0 && _ms > _lastMilestone) {
          _lastMilestone = _ms;
          try { window.RuntimeTelemetry.record('rotate:progress', { pct: _ms, msg: msg || null }); } catch (_) {}
        }
      }
    };
  }

  // ── Memory safety ─────────────────────────────────────────────────────────
  // Three guard points: pre-start, pre-read, post-worker.
  function _memoryGuard(phase, file) {
    // Phase 2: RuntimeMemory tier
    if (window.RuntimeMemory) {
      if (window.RuntimeMemory.isEmergency()) {
        try { if (window.RuntimeTelemetry) window.RuntimeTelemetry.record('rotate:memory-pressure-advisory', { phase: phase }); } catch (_) {}
      }
      if (window.RuntimeMemory.isCritical()) {
        if (window.RuntimeCleanup) {
          try { window.RuntimeCleanup.lightCleanup('rotate-critical-guard'); } catch (_) {}
        }
      }
    }
    // Heap estimate: 3× file size (buffer + pdf-lib internal + output)
    if (file && window.MemPressure && window.MemPressure.wouldExceedLimit) {
      if (window.MemPressure.wouldExceedLimit(file.size * 3, 1.3)) {
        try { if (window.RuntimeTelemetry) window.RuntimeTelemetry.record('rotate:memory-estimate-advisory', { phase: phase }); } catch (_) {}
      }
    }
    // Inline heap check fallback
    try {
      var mem = performance && performance.memory;
      if (mem && mem.usedJSHeapSize > 900 * 1024 * 1024) {
        try { if (window.RuntimeTelemetry) window.RuntimeTelemetry.record('rotate:heap-pressure-advisory', { phase: phase }); } catch (_) {}
      }
    } catch (_) {}
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('rotate:memory-guard-ok', { phase: phase }); } catch (_) {}
    }
  }

  // ── Safe-mode detection ───────────────────────────────────────────────────
  // [Task Group R007] Mirrors MergeRuntime._shouldUseSafeMode() for rotate.
  function _shouldUseSafeMode(file) {
    var ua       = navigator.userAgent || '';
    var isMobile = /Mobile|Tablet|Android|iPhone|iPad/i.test(ua);
    var isLowCore = (navigator.hardwareConcurrency || 4) <= 2;
    var sizeMB    = (file ? file.size : 0) / (1024 * 1024);
    var isCritical = window.RuntimeMemory && window.RuntimeMemory.isCritical();
    return isCritical || (isMobile && sizeMB > 50) || (isLowCore && sizeMB > 100) || sizeMB > 500;
  }

  // ── Post-run cleanup ──────────────────────────────────────────────────────
  // [Task Group R011] Idempotent cleanup — safe to call multiple times.
  function _runPostRotateCleanup(reason, ownerToken, ownerSpan, ownerCleanupIds) {
    reason = reason || 'unknown';
    var cleanupIds = ownerCleanupIds || _cleanupIds;
    var span = ownerSpan !== undefined ? ownerSpan : _currentSpan;
    var ownsCurrentState = !ownerToken || _currentToken === ownerToken;

    if (window.RuntimeCleanup) {
      try {
        cleanupIds.blobs.forEach(function (id) { window.RuntimeCleanup.untrackBlob(id); });
        cleanupIds.generic.forEach(function (id) { window.RuntimeCleanup.untrackGeneric(id); });
      } catch (_) {}
    }

    if (window.RuntimeTelemetry) {
      // Emit named cancel event when cleanup is caused by a cancellation
      if (reason.startsWith('error:cancel') || reason.startsWith('nav-cancel:')) {
        try { window.RuntimeTelemetry.record('rotate:cancel', { reason: reason }); } catch (_) {}
      }
      // Close the active span if it is still open
      if (span !== null) {
        var _spanOutcome = (reason.startsWith('error:') || reason.startsWith('nav-cancel:')) ? 'error' : 'ok';
        try { window.RuntimeTelemetry.endSpan(span, _spanOutcome); } catch (_) {}
      }
      try { window.RuntimeTelemetry.record('rotate:cleanup', { reason: reason }); } catch (_) {}
    }

    if (ownsCurrentState) _resetRunState();
  }

  // ── Core runtime path ─────────────────────────────────────────────────────
  // [Task Group R003] Full runtime-driven rotate.
  // Returns { blob, filename } on success; runtime errors propagate to the caller.
  async function runRotateRuntime(file, opts) {
    var startTs = Date.now();
    var runToken = null;
    var runSpan = null;
    var runProgressTask = null;
    var runCleanupIds = { blobs: [], generic: [] };

    // ── Pre-flight memory guard ──────────────────────────────────────────────
    _memoryGuard('pre-start', file);

    // ── Cancellation token ───────────────────────────────────────────────────
    // [Task Group R010]
    runToken = window.RuntimeCancellation
      ? window.RuntimeCancellation.createScopedToken('rotate-pdf', {
          label:     'rotate-pdf-run',
          timeoutMs: 0, // no artificial processing-time cutoff
        })
      : null;
    _currentToken = runToken;

    // ── Telemetry span ───────────────────────────────────────────────────────
    // [Task Group R009]
    if (window.RuntimeTelemetry) {
      runSpan = window.RuntimeTelemetry.startSpan('rotate:full-run', {
        name:     file.name,
        size:     file.size,
        degrees:  (opts && opts.degrees) || '0',
        pages:    (opts && opts.pages)   || 'all',
        safeMode: _shouldUseSafeMode(file),
      });
      window.RuntimeTelemetry.record('rotate:start', {
        sizeMB:  Math.round(file.size / 1024 / 1024),
        degrees: (opts && opts.degrees) || '0',
        pages:   (opts && opts.pages)   || 'all',
      });
    }

    // ── RuntimeScheduler slot ────────────────────────────────────────────────
    // [Task Group R005] RuntimeScheduler.run() manages its own internal
    // RuntimeProgress task via opts.label — do NOT create _progressTask here.
    var onProgress = _buildProgressReporter(opts, runProgressTask);

    onProgress(2, 'Preparing…');
    _memoryGuard('pre-read', file);

    if (runToken && runToken.cancelled) throw new Error('cancelled');

    var workerResult;
    if (window.RuntimeScheduler) {
      // RuntimeScheduler acquires a concurrency slot and creates its own
      // progress task via opts.label — no duplicate task needed here.
      workerResult = await window.RuntimeScheduler.run(
        function () {
          return _doWorkerDispatch(file, opts, onProgress, runToken);
        },
        {
          type:     'rotate',
          priority: 'normal',
          label:    'rotate-pdf',
          token:    runToken,
        }
      );
    } else {
      // No scheduler: create a local progress task so the worker path remains usable
      if (window.RuntimeProgress) {
        runProgressTask = window.RuntimeProgress.createSimpleTask('rotate-pdf', runToken);
        if (_currentToken === runToken) _progressTask = runProgressTask;
      }
      workerResult = await _doWorkerDispatch(file, opts, onProgress, _currentToken);
    }

    // ── Post-worker memory guard ──────────────────────────────────────────────
    _memoryGuard('post-worker', null);

    onProgress(96, 'Preparing download…');

    // [FUTURE: StreamEngine] workerResult.buffer → OPFS write + stream URL
    // [FUTURE: IndexedDB] Persist buffer to IDB before Blob; enables refresh recovery
    // [FUTURE: OPFSRuntime] Write to OPFS first; return OPFS URL
    var blob = new Blob([workerResult.buffer], { type: 'application/pdf' });
    workerResult = null; // release buffer reference immediately

    // Register for cleanup tracking
    if (window.RuntimeCleanup && window.RuntimeCleanup.trackGeneric) {
      var cleanId = window.RuntimeCleanup.trackGeneric(function () {
        // placeholder; OPFS cleanup will go here
      }, 'rotate-output-blob');
      runCleanupIds.generic.push(cleanId);
    }

    // ── Telemetry: success ────────────────────────────────────────────────────
    var durationMs = Date.now() - startTs;
    if (window.RuntimeTelemetry) {
      window.RuntimeTelemetry.record('rotate:success', {
        durationMs:  durationMs,
        outputBytes: blob.size,
        degrees:     (opts && opts.degrees) || '0',
        pages:       (opts && opts.pages)   || 'all',
        safeMode:    _shouldUseSafeMode(file),
      });
      if (runSpan !== null) window.RuntimeTelemetry.endSpan(runSpan, 'ok');
    }

    if (runProgressTask) { try { runProgressTask.complete(); } catch (_) {} }

    // ── Filename ──────────────────────────────────────────────────────────────
    var filename = window.BrowserTools && window.BrowserTools.brandedFilename
      ? window.BrowserTools.brandedFilename(file.name, '.pdf')
      : 'ILovePDF-rotated.pdf';

    // ── Cleanup ───────────────────────────────────────────────────────────────
    _runPostRotateCleanup('success', runToken, runSpan, runCleanupIds);

    return { blob: blob, filename: filename };
  }

  // ── Worker dispatch bridge ─────────────────────────────────────────────────
  async function _doWorkerDispatch(file, opts, onProgress, token) {
    if (!window.RotateWorkerAdapter) {
      throw new Error('RotateWorkerAdapter not loaded');
    }
    return window.RotateWorkerAdapter.dispatch(file, opts, onProgress, token);
  }

  // ── Full runtime entry ─────────────────────────────────────────────────────
  // [Task Group R003] execute() is what the monkey-patch calls.
  // Returns { blob, filename } from the canonical runtime path, or throws.
  async function execute(file, opts) {
    var executionToken = null;
    var safeMode = _shouldUseSafeMode(file);
    if (safeMode && window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('rotate:safe-mode', {
        sizeMB: Math.round(file.size / 1024 / 1024),
      }); } catch (_) {}
    }

    try {
      var result = await runRotateRuntime(file, opts);
      return result;
    } catch (runtimeErr) {
      executionToken = _currentToken;
      var failReason = (runtimeErr && runtimeErr.message) || 'unknown';

      // [Task Group R012] Runtime errors are terminal; do not switch pipelines.
      if (failReason === 'cancelled'         ||
          failReason.startsWith('cancelled-') ||
          failReason === 'memory_pressure'    ||
          failReason === 'runtime-emergency') {
        _runPostRotateCleanup('error:' + failReason, executionToken);
        throw runtimeErr;
      }

      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record('rotate:runtime-error', { reason: failReason }); } catch (_) {}
      }
      if (window.RuntimeEventBus) {
        try { window.RuntimeEventBus.emit('health:degraded', { component: 'rotate-runtime', reason: failReason }); } catch (_) {}
      }
      _runPostRotateCleanup('error:' + failReason);
      throw runtimeErr;
    }
  }

  // ── Monkey-patch ──────────────────────────────────────────────────────────
  // [Task Group R002] Intercepts BrowserTools.process for 'rotate' ONLY.
  // All other tools pass through to _origProcess unchanged.
  // Idempotent: _origProcess guard prevents double-patching.
  function _patchBrowserTools() {
    if (!window.BrowserTools || _origProcess) return;

    // Check whether MergeRuntime already saved _origProcess.
    // If so, we wrap the ALREADY-PATCHED function — this means we must
    // unwrap by checking toolId before delegating non-rotate calls.
    // Since MergeRuntime's patch also passes non-merge through to its own
    // _origProcess, the chain is: rotate-patch → merge-patch → original.
    // This is correct: each patch layer handles only its own toolId.
    _origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = function (toolId, files, options) {
      if (toolId !== 'rotate') return _origProcess(toolId, files, options);
      // rotate receives files as array from tryWithRetry; extract file[0]
      var file = Array.isArray(files) ? files[0] : files;
      return execute(file, options || {});
    };

    console.debug(LOG, 'BrowserTools.process patched for rotate-pdf runtime routing');

    // Expose original for emergency bypass
    window.BrowserTools._origRotateProcess = _origProcess;
  }

  // ── Streaming markers ─────────────────────────────────────────────────────
  // [Task Group R013] Mark all full-load points for future StreamEngine.
  function _registerStreamMarkers() {
    if (!window.RuntimeStreaming) return;
    window.RuntimeStreaming.markFullLoad('rotate:file-read-phase', {
      description: 'Input PDF read as ArrayBuffer before worker dispatch',
    });
    window.RuntimeStreaming.markFullLoad('rotate:output-blob', {
      description: 'Full output buffer held in JS heap as Blob',
    });
    window.RuntimeStreaming.markFullLoad('rotate:status-url', {
      description: 'Output Blob converted to Object URL for download anchor',
    });
  }

  // ── Navigation / pagehide safety ──────────────────────────────────────────
  // [Task Group R010] Cancels active run on lifecycle events.
  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      if (_currentToken && !_currentToken.cancelled) {
        var hideToken = _currentToken;
        hideToken.cancel(reason === 'pagehide' ? 'pagehide' : 'tab-hidden');
        _runPostRotateCleanup('nav-cancel:' + reason, hideToken);
      }
    });
  }

  window.addEventListener('pagehide', function () {
    if (_currentToken && !_currentToken.cancelled) {
      _currentToken.cancel('pagehide');
    }
    if (_currentSpan !== null && window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.endSpan(_currentSpan, 'pagehide'); } catch (_) {}
    }
    _runPostRotateCleanup('pagehide');
  }, { passive: true });

  // ── Apply patch (deferred safety) ─────────────────────────────────────────
  // rotate-runtime.js loads after browser-tools.js and merge-runtime.js,
  // so BrowserTools is available synchronously. Retry loop is a safety net.
  (function _applyPatch() {
    if (window.BrowserTools) {
      _patchBrowserTools();
      _registerStreamMarkers();
    } else {
      var retries = 0;
      var tid = setInterval(function () {
        retries++;
        if (window.BrowserTools) {
          clearInterval(tid);
          _patchBrowserTools();
          _registerStreamMarkers();
        } else if (retries > 20) {
          clearInterval(tid);
          console.warn(LOG, 'BrowserTools not found after 20 attempts — patch skipped');
        }
      }, 100);
      if (window.TimerRegistry) window.TimerRegistry.registerInterval(OWNER + '-patch-retry', tid);
    }
  })();

  // ── Public API ─────────────────────────────────────────────────────────────
  window.RotateRuntime = {
    execute:          execute,
    runRotateRuntime: runRotateRuntime,

    // Kept as a compatibility flag for diagnostics/configuration. Disabling
    // the runtime no longer switches to a legacy processor; execution remains
    // on the canonical runtime path so there is no hidden alternate pipeline.
    enable:  function () { window.RUNTIME_ROTATE_ENABLED = true;  console.info(LOG, 'runtime ENABLED');  },
    disable: function () { window.RUNTIME_ROTATE_ENABLED = false; console.info(LOG, 'runtime DISABLED — execution remains runtime-owned'); },

    // [Task Group R003] Diagnostics
    getDiagnostics: function () {
      return {
        runtimeEnabled: window.RUNTIME_ROTATE_ENABLED,
        patchActive:    !!_origProcess,
        activeToken:    _currentToken ? { id: _currentToken.id, cancelled: _currentToken.cancelled } : null,
        activeSpan:     _currentSpan,
        progressTask:   _progressTask ? _progressTask.taskId : null,
        workerAdapter:  !!window.RotateWorkerAdapter,
      };
    },

    cancelActive: function (reason) {
      if (_currentToken && !_currentToken.cancelled) {
        var cancelToken = _currentToken;
        cancelToken.cancel(reason || 'manual-cancel');
        _runPostRotateCleanup('manual-cancel', cancelToken);
        return true;
      }
      return false;
    },
  };

  console.debug(LOG, 'RotateRuntime ready — Phase 3 pilot active | RUNTIME_ROTATE_ENABLED:', window.RUNTIME_ROTATE_ENABLED);
}());

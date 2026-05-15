// Merge Runtime v1.0 — Phase 3 (Task Groups A–L)
// First fully Runtime-driven tool. Integrates Merge PDF with:
// CentralRuntime, RuntimeAdapters, RuntimeWorkers, RuntimeMemory,
// RuntimeCancellation, RuntimeProgress, RuntimeCleanup, RuntimeTelemetry,
// RuntimeQueue, RuntimeScheduler — while preserving ALL existing behavior.
//
// DESIGN: Monkey-patches BrowserTools.process('merge', ...) transparently.
//   - All other tools: completely unaffected
//   - processFile() in tool-page.js: zero modifications
//   - tryWithRetry(), OutputValidator, showStatus, Flow: zero modifications
//   - On any runtime failure: auto-fallback to original BrowserTools.process()
//
// User experience: identical to legacy. Processing, progress, download, Flow
// step navigation all behave exactly as before. The runtime adds: telemetry,
// memory guards, cancellation, structured cleanup, and orchestration.
//
// Feature flag: window.RUNTIME_MERGE_ENABLED = true  (set before patch fires)
//               Set to false in DevTools to force legacy path.
//
// [FUTURE: StreamEngine] When StreamEngine lands, replace _readFiles() in
// MergeWorkerAdapter with OPFS byte-range chunks (zero-copy streaming).
//
// [FUTURE: IndexedDB] Persist merge result to IDB before handing URL to
// showStatus() so refresh-after-merge recovers the file without re-processing.
//
// [FUTURE: OPFS] Store intermediate per-file PDFs in OPFS during multi-file
// merge to avoid holding N full ArrayBuffers in the JS heap simultaneously.
//
// [FUTURE: AIOrchestrator] After a successful merge, optionally trigger
// CentralRuntime.runAiTask('auto-tag', outputBlob) to extract bookmarks.
//
// Exposed as: window.MergeRuntime
(function () {
  'use strict';

  if (window.MergeRuntime) return;

  // ── Feature flag ──────────────────────────────────────────────────────────
  // Guarded: only set to true if not already overridden externally.
  if (typeof window.RUNTIME_MERGE_ENABLED === 'undefined') {
    window.RUNTIME_MERGE_ENABLED = true;
  }

  var LOG   = '[MRT]';
  var OWNER = 'merge-runtime';

  // ── Ref to original BrowserTools.process (saved before patch) ─────────────
  var _origProcess = null;

  // ── Active cleanup tokens (blob URLs created during this run) ─────────────
  var _currentToken = null;  // RuntimeCancellation token for active merge
  var _currentSpan  = null;  // RuntimeTelemetry span for entire run

  // ── Runtime progress task ─────────────────────────────────────────────────
  var _progressTask = null;

  // ── Cleanup registry for this run ─────────────────────────────────────────
  var _cleanupIds = {
    blobs: [],
    generic: [],
  };

  // ── Reset per-run state ───────────────────────────────────────────────────
  function _resetRunState() {
    _currentToken = null;
    _currentSpan  = null;
    _progressTask = null;
    _cleanupIds   = { blobs: [], generic: [] };
  }

  // ── Progress reporter ─────────────────────────────────────────────────────
  // Updates both RuntimeProgress AND window.showProcessing (already visible).
  function _buildProgressReporter(totalFiles) {
    return function onProgress(pct, msg) {
      // RuntimeProgress update
      if (_progressTask) {
        try { window.RuntimeProgress.report(_progressTask.taskId, 0, pct, msg); } catch (_) {}
      }
      // Update the visible spinner text so the user sees meaningful progress
      var title = 'Merging ' + totalFiles + ' file' + (totalFiles > 1 ? 's' : '') + '…';
      var sub   = msg || ('Processing… ' + pct + '%');
      if (window.showProcessing) {
        try { window.showProcessing(title, sub); } catch (_) {}
      }
    };
  }

  // ── Memory safety checks ──────────────────────────────────────────────────
  // Called at three points: before read, before merge, before save.
  function _memoryGuard(phase, files) {
    // Phase 2 guard: RuntimeMemory tier
    if (window.RuntimeMemory) {
      if (window.RuntimeMemory.isEmergency()) {
        throw new Error('memory_pressure');
      }
      if (window.RuntimeMemory.isCritical()) {
        // Critical: still proceed, but trigger light cleanup first
        if (window.RuntimeCleanup) {
          try { window.RuntimeCleanup.lightCleanup('merge-critical-guard'); } catch (_) {}
        }
      }
    }

    // Heap check via MemPressure (Phase 1A)
    if (files && window.MemPressure) {
      var totalBytes = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
      // Estimate: 3× total file size needed in heap (buffers + pdf-lib + output)
      if (window.MemPressure.wouldExceedLimit && window.MemPressure.wouldExceedLimit(totalBytes * 3, 1.3)) {
        throw new Error('memory_pressure');
      }
    }

    // Legacy check (inline performance.memory)
    try {
      var mem = performance && performance.memory;
      if (mem && mem.usedJSHeapSize > 900 * 1024 * 1024) throw new Error('memory_pressure');
    } catch (e) {
      if (e.message === 'memory_pressure') throw e;
    }

    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('merge:memory-guard-ok', { phase: phase }); } catch (_) {}
    }
  }

  // ── Mobile / large-file safe mode ─────────────────────────────────────────
  // Returns true when we should serialise operations and skip previews.
  function _shouldUseSafeMode(files) {
    var ua = navigator.userAgent || '';
    var isMobile = /Mobile|Tablet|Android|iPhone|iPad/i.test(ua);
    var isLowCore = (navigator.hardwareConcurrency || 4) <= 2;
    var totalMB = files.reduce(function (s, f) { return s + f.size; }, 0) / (1024 * 1024);
    var isCritical = window.RuntimeMemory && window.RuntimeMemory.isCritical();

    // Trigger safe mode on: mobile + large files, low-core + large files,
    // or any critical memory tier.
    return isCritical || (isMobile && totalMB > 50) || (isLowCore && totalMB > 100) || totalMB > 500;
  }

  // ── Main runtime path ─────────────────────────────────────────────────────
  // This IS the runtime-driven merge. Returns { blob, filename } on success
  // or throws to trigger the legacy fallback.
  async function runMergeRuntime(files, opts) {
    var startTs = Date.now();

    // ── Pre-flight memory guard ──────────────────────────────────────────────
    _memoryGuard('pre-start', files);

    // ── Cancellation token ───────────────────────────────────────────────────
    _currentToken = window.RuntimeCancellation
      ? window.RuntimeCancellation.createScopedToken('merge-pdf', {
          label:     'merge-pdf-run',
          timeoutMs: 180000, // 3 minute hard cap
        })
      : null;

    // ── Telemetry span ───────────────────────────────────────────────────────
    if (window.RuntimeTelemetry) {
      _currentSpan = window.RuntimeTelemetry.startSpan('merge:full-run', {
        fileCount:  files.length,
        totalBytes: files.reduce(function (s, f) { return s + f.size; }, 0),
        safeMode:   _shouldUseSafeMode(files),
      });
      window.RuntimeTelemetry.record('merge:start', {
        fileCount: files.length,
        totalMB:   Math.round(files.reduce(function (s, f) { return s + f.size; }, 0) / 1024 / 1024),
      });
    }

    // ── RuntimeScheduler slot (uses 'render' tier) ───────────────────────────
    // Ensures we don't run concurrently with other render-tier tasks under
    // memory pressure. Wraps the worker dispatch only — file reads happen before.
    // NOTE: RuntimeScheduler.run() manages its own internal RuntimeProgress task
    // (via opts.label). We create _progressTask only as a fallback when the
    // scheduler is unavailable, to avoid duplicate progress entries.
    var onProgress = _buildProgressReporter(files.length);

    onProgress(2, 'Preparing…');
    _memoryGuard('pre-read', files);

    // ── Cancellation check before heavy work ─────────────────────────────────
    if (_currentToken && _currentToken.cancelled) throw new Error('cancelled');

    var workerResult;
    if (window.RuntimeScheduler) {
      // RuntimeScheduler creates its own progress task — no _progressTask needed
      workerResult = await window.RuntimeScheduler.run(
        function () {
          return _doWorkerDispatch(files, opts, onProgress, _currentToken);
        },
        {
          type:     'merge',
          priority: 'normal',
          label:    'merge-pdf',
          token:    _currentToken,
        }
      );
    } else {
      // No scheduler: create our own progress task as fallback
      if (window.RuntimeProgress) {
        _progressTask = window.RuntimeProgress.createSimpleTask('merge-pdf', _currentToken);
      }
      workerResult = await _doWorkerDispatch(files, opts, onProgress, _currentToken);
    }

    // ── Post-worker memory guard ──────────────────────────────────────────────
    _memoryGuard('post-worker', null);

    onProgress(96, 'Preparing download…');

    // [FUTURE: StreamEngine] When StreamEngine is active:
    //   - workerResult.buffer → write to OPFS file
    //   - return OPFS stream URL (avoids JS heap spike from Blob creation)
    // [FUTURE: IndexedDB] Persist workerResult.buffer to IDB before Blob creation
    //   so a page refresh can recover the output without re-processing.

    var blob = new Blob([workerResult.buffer], { type: 'application/pdf' });
    workerResult = null; // release buffer reference immediately

    // Track blob for cleanup
    if (window.RuntimeCleanup && window.RuntimeCleanup.trackGeneric) {
      var cleanId = window.RuntimeCleanup.trackGeneric(function () {
        // blob is GC'd naturally; this is a no-op placeholder for future OPFS cleanup
      }, 'merge-output-blob');
      _cleanupIds.generic.push(cleanId);
    }

    // ── Telemetry: success ────────────────────────────────────────────────────
    var durationMs = Date.now() - startTs;
    if (window.RuntimeTelemetry) {
      window.RuntimeTelemetry.record('merge:success', {
        durationMs:   durationMs,
        outputBytes:  blob.size,
        fileCount:    files.length,
        safeMode:     _shouldUseSafeMode(files),
      });
      if (_currentSpan !== null) window.RuntimeTelemetry.endSpan(_currentSpan, 'ok');
    }

    if (_progressTask) { try { _progressTask.complete(); } catch (_) {} }

    // ── Generate filename ────────────────────────────────────────────────────
    var firstName = (files[0] && files[0].name) || 'merged.pdf';
    var filename  = window.BrowserTools && window.BrowserTools.brandedFilename
      ? window.BrowserTools.brandedFilename(firstName, '.pdf')
      : 'ILovePDF-merged.pdf';

    // ── Cleanup ──────────────────────────────────────────────────────────────
    _runPostMergeCleanup('success');

    return { blob: blob, filename: filename };
  }

  // ── Worker dispatch (called from inside RuntimeScheduler.run) ─────────────
  async function _doWorkerDispatch(files, opts, onProgress, token) {
    if (!window.MergeWorkerAdapter) {
      throw new Error('MergeWorkerAdapter not loaded');
    }
    return window.MergeWorkerAdapter.dispatch(files, opts, onProgress, token);
  }

  // ── Legacy path ───────────────────────────────────────────────────────────
  // Direct call to saved original BrowserTools.process. Used when:
  //   a) RUNTIME_MERGE_ENABLED is false
  //   b) Runtime path throws and we auto-fallback
  async function runMergeLegacy(files, opts) {
    if (!_origProcess) throw new Error('Original BrowserTools.process not saved');
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('merge:legacy-path', { fileCount: files.length }); } catch (_) {}
    }
    return _origProcess('merge', files, opts);
  }

  // ── Post-run cleanup ──────────────────────────────────────────────────────
  // Runs after every merge attempt (success or failure).
  function _runPostMergeCleanup(reason) {
    reason = reason || 'unknown';

    // Clean up any tracked resources
    if (window.RuntimeCleanup) {
      try {
        // Untrack any IDs we registered
        _cleanupIds.blobs.forEach(function (id) { window.RuntimeCleanup.untrackBlob(id); });
        _cleanupIds.generic.forEach(function (id) { window.RuntimeCleanup.untrackGeneric(id); });
      } catch (_) {}
    }

    // Cancel any lingering token (no-op if already cancelled or successful)
    if (_currentToken && !_currentToken.cancelled) {
      // Don't cancel on success — token expires naturally
    }

    if (window.RuntimeTelemetry) {
      // Emit named cancel event when cleanup is caused by a cancellation
      if (reason.startsWith('error:cancel') || reason.startsWith('nav-cancel:')) {
        try { window.RuntimeTelemetry.record('merge:cancel', { reason: reason }); } catch (_) {}
      }
      // Close the active span if it is still open
      if (_currentSpan !== null) {
        var _spanOutcome = (reason.startsWith('error:') || reason.startsWith('nav-cancel:')) ? 'error' : 'ok';
        try { window.RuntimeTelemetry.endSpan(_currentSpan, _spanOutcome); } catch (_) {}
      }
      // Telemetry: cleanup timing
      try { window.RuntimeTelemetry.record('merge:cleanup', { reason: reason }); } catch (_) {}
    }

    _resetRunState();
  }

  // ── Full runtime entry (wraps runMergeRuntime + fallback) ─────────────────
  // This is what the monkey-patch calls. Returns { blob, filename } always
  // (either from runtime or legacy), or throws if both paths fail.
  async function execute(files, opts) {
    if (!window.RUNTIME_MERGE_ENABLED) {
      return runMergeLegacy(files, opts);
    }

    // [Task Group H] Mobile / large-file pre-flight report
    var safeMode = _shouldUseSafeMode(files);
    if (safeMode && window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('merge:safe-mode', {
        fileCount: files.length,
        totalMB:   Math.round(files.reduce(function (s, f) { return s + f.size; }, 0) / 1024 / 1024),
      }); } catch (_) {}
    }

    try {
      var result = await runMergeRuntime(files, opts);
      return result;
    } catch (runtimeErr) {
      // Capture failure reason for telemetry
      var failReason = (runtimeErr && runtimeErr.message) || 'unknown';

      // Don't fall back on cancellation or memory pressure —
      // these should surface to the user unchanged.
      if (failReason === 'cancelled' ||
          failReason.startsWith('cancelled-') ||
          failReason === 'memory_pressure' ||
          failReason === 'runtime-emergency') {
        _runPostMergeCleanup('error:' + failReason);
        throw runtimeErr; // re-throw so processFile() shows the right error message
      }

      // Log fallback
      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record('merge:runtime-fallback', { reason: failReason }); } catch (_) {}
      }
      if (window.RuntimeEventBus) {
        try { window.RuntimeEventBus.emit('health:degraded', { component: 'merge-runtime', reason: failReason }); } catch (_) {}
      }
      console.warn(LOG, 'runtime path failed — falling back to legacy. reason:', failReason);

      _runPostMergeCleanup('fallback:' + failReason);

      // [Task Group I] Auto-fallback to legacy path
      return runMergeLegacy(files, opts);
    }
  }

  // ── Monkey-patch ──────────────────────────────────────────────────────────
  // Intercepts BrowserTools.process for 'merge' only. Zero effect on other tools.
  // Safe to call multiple times (idempotent guard via _origProcess !== null).
  function _patchBrowserTools() {
    if (!window.BrowserTools || _origProcess) return;

    _origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = function (toolId, files, options) {
      // Non-merge tools: pass through completely unchanged
      if (toolId !== 'merge') return _origProcess(toolId, files, options);
      // Runtime path (may auto-fallback to legacy internally)
      return execute(Array.from(files), options || {});
    };

    console.debug(LOG, 'BrowserTools.process patched for merge-pdf runtime routing');

    // Expose the original for emergency bypass
    window.BrowserTools._origProcess = _origProcess;
  }

  // ── Diagnostics integration ───────────────────────────────────────────────
  // [Task Group J] Registers merge status into RuntimeDiagnostics snapshot.
  function _getMergeDiagnostics() {
    return {
      runtimeEnabled:  window.RUNTIME_MERGE_ENABLED,
      patchActive:     !!_origProcess,
      activeToken:     _currentToken ? { id: _currentToken.id, cancelled: _currentToken.cancelled } : null,
      activeSpan:      _currentSpan,
      progressTask:    _progressTask ? _progressTask.taskId : null,
      workerAdapter:   !!window.MergeWorkerAdapter,
    };
  }

  // ── Streaming markers ─────────────────────────────────────────────────────
  // [Task Group K] Mark all full-load points so StreamEngine can find them.
  function _registerStreamMarkers() {
    if (!window.RuntimeStreaming) return;
    // These markers document where OPFS/streaming will replace full-file loads.
    // They are informational only — no behavior change.
    // [FUTURE: StreamEngine] When active, these become stream entry points.
    window.RuntimeStreaming.markFullLoad('merge:file-read-phase',  { description: 'All input PDFs read as ArrayBuffer before worker dispatch' });
    window.RuntimeStreaming.markFullLoad('merge:output-blob',      { description: 'Full output buffer held in JS heap as Blob' });
    window.RuntimeStreaming.markFullLoad('merge:status-url',       { description: 'Output Blob converted to Object URL for download anchor' });
  }

  // ── Listen for navCancel epoch changes ────────────────────────────────────
  // If a navigation fires while a merge is running, cancel the token.
  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      if (_currentToken && !_currentToken.cancelled) {
        _currentToken.cancel(reason === 'pagehide' ? 'pagehide' : 'tab-hidden');
        _runPostMergeCleanup('nav-cancel:' + reason);
      }
    });
  }

  // ── Pagehide cleanup ──────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    if (_currentToken && !_currentToken.cancelled) {
      _currentToken.cancel('pagehide');
    }
    if (_currentSpan !== null && window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.endSpan(_currentSpan, 'pagehide'); } catch (_) {}
    }
    _runPostMergeCleanup('pagehide');
  }, { passive: true });

  // ── Apply patch (deferred to ensure BrowserTools.js has finished) ─────────
  // BrowserTools.js exposes window.BrowserTools at end of its IIFE.
  // merge-runtime.js loads after browser-tools.js, so BrowserTools is
  // available synchronously — but we double-check with a safety timeout.
  (function _applyPatch() {
    if (window.BrowserTools) {
      _patchBrowserTools();
      _registerStreamMarkers();
    } else {
      // Extremely unlikely (load order guarantees it), but safe to handle.
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

  window.MergeRuntime = {
    // Core paths
    execute:          execute,
    runMergeRuntime:  runMergeRuntime,
    runMergeLegacy:   runMergeLegacy,

    // Feature flag control
    enable:  function () { window.RUNTIME_MERGE_ENABLED = true;  console.info(LOG, 'runtime ENABLED');  },
    disable: function () { window.RUNTIME_MERGE_ENABLED = false; console.info(LOG, 'runtime DISABLED — legacy path active'); },

    // Diagnostics [Task Group J]
    getDiagnostics: _getMergeDiagnostics,

    // Manual cancel (for testing / emergency stop)
    cancelActive: function (reason) {
      if (_currentToken && !_currentToken.cancelled) {
        _currentToken.cancel(reason || 'manual-cancel');
        _runPostMergeCleanup('manual-cancel');
        return true;
      }
      return false;
    },
  };

  console.debug(LOG, 'MergeRuntime ready — Phase 3 pilot active | RUNTIME_MERGE_ENABLED:', window.RUNTIME_MERGE_ENABLED);
}());

// Merge Runtime v1.1 — canonical RuntimeScheduler/RuntimeWorkers path
// Runtime failures propagate; there is no hidden legacy fallback.
(function () {
  'use strict';

  if (window.MergeRuntime) return;

  var LOG = '[MRT]';
  var _origProcess = null;
  var _currentToken = null;
  var _currentSpan = null;
  var _progressTask = null;
  var _cleanupIds = { blobs: [], generic: [] };

  function _resetState() {
    _currentToken = null;
    _currentSpan = null;
    _progressTask = null;
    _cleanupIds = { blobs: [], generic: [] };
  }

  function _memoryGuard(phase, files) {
    if (window.RuntimeMemory) {
      if (window.RuntimeMemory.isEmergency() && window.RuntimeTelemetry) {
        window.RuntimeTelemetry.record('merge:memory-pressure-advisory', { phase: phase });
      }
      if (window.RuntimeMemory.isCritical() && window.RuntimeCleanup) {
        try { window.RuntimeCleanup.lightCleanup('merge-critical-guard'); } catch (_) {}
      }
    }
    if (files && window.MemPressure && window.MemPressure.wouldExceedLimit) {
      var bytes = files.reduce(function (sum, file) { return sum + (file.size || 0); }, 0);
      if (window.MemPressure.wouldExceedLimit(bytes * 3, 1.3) && window.RuntimeTelemetry) {
        window.RuntimeTelemetry.record('merge:memory-estimate-advisory', { phase: phase });
      }
    }
    if (window.RuntimeTelemetry) {
      window.RuntimeTelemetry.record('merge:memory-guard-ok', { phase: phase });
    }
  }

  function _progressReporter(fileCount, task) {
    return function (pct, msg) {
      if (task && window.RuntimeProgress) {
        try { window.RuntimeProgress.report(task.taskId, 0, pct, msg); } catch (_) {}
      }
      if (window.showProcessing) {
        try { window.showProcessing(
          'Merging ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + '…',
          msg || ('Processing… ' + pct + '%')
        ); } catch (_) {}
      }
    };
  }

  function _cleanup(reason, ownerToken, ownerSpan, ownerIds) {
    var explicitOwner = arguments.length >= 2;
    var ownsState = !explicitOwner || _currentToken === ownerToken;
    var ids = (explicitOwner && ownerToken === null)
      ? { blobs: [], generic: [] }
      : (ownerIds || _cleanupIds);
    var span = ownerSpan !== undefined ? ownerSpan : _currentSpan;

    if (window.RuntimeCleanup) {
      try {
        ids.blobs.forEach(function (id) { window.RuntimeCleanup.untrackBlob(id); });
        ids.generic.forEach(function (id) { window.RuntimeCleanup.untrackGeneric(id); });
      } catch (_) {}
    }

    if (window.RuntimeTelemetry) {
      if (reason.indexOf('cancel') === 0 || reason.indexOf('nav-cancel:') === 0) {
        try { window.RuntimeTelemetry.record('merge:cancel', { reason: reason }); } catch (_) {}
      }
      if (span !== null) {
        var outcome = (reason.indexOf('error:') === 0 || reason.indexOf('nav-cancel:') === 0) ? 'error' : 'ok';
        try { window.RuntimeTelemetry.endSpan(span, outcome); } catch (_) {}
      }
      try { window.RuntimeTelemetry.record('merge:cleanup', { reason: reason }); } catch (_) {}
    }

    if (ownsState) _resetState();
  }

  async function runMergeRuntime(files, opts) {
    if (!files || !files.length) throw new Error('No files provided');

    var runToken = null;
    var runSpan = null;
    var runTask = null;
    var runCleanupIds = { blobs: [], generic: [] };

    try {
      _memoryGuard('pre-start', files);

      runToken = window.RuntimeCancellation
        ? window.RuntimeCancellation.createScopedToken('merge-pdf', {
            label: 'merge-pdf-run',
            timeoutMs: 0
          })
        : null;
      _currentToken = runToken;

      if (window.RuntimeTelemetry) {
        runSpan = window.RuntimeTelemetry.startSpan('merge:full-run', {
          fileCount: files.length,
          totalBytes: files.reduce(function (sum, file) { return sum + (file.size || 0); }, 0)
        });
        _currentSpan = runSpan;
        window.RuntimeTelemetry.record('merge:start', {
          fileCount: files.length,
          totalBytes: files.reduce(function (sum, file) { return sum + (file.size || 0); }, 0)
        });
      }

      _memoryGuard('pre-read', files);
      if (runToken && runToken.cancelled) throw new Error('cancelled');

      var task = null;
      var onProgress = _progressReporter(files.length, null);
      var workerResult;

      if (window.RuntimeScheduler && typeof window.RuntimeScheduler.run === 'function') {
        workerResult = await window.RuntimeScheduler.run(
          function () {
            return window.MergeWorkerAdapter.dispatch(files, opts || {}, onProgress, runToken);
          },
          {
            type: 'merge',
            priority: 'normal',
            label: 'merge-pdf',
            token: runToken
          }
        );
      } else {
        if (window.RuntimeProgress) {
          task = window.RuntimeProgress.createSimpleTask('merge-pdf', runToken);
          if (_currentToken === runToken) _progressTask = task;
        }
        onProgress = _progressReporter(files.length, task);
        if (!window.MergeWorkerAdapter) throw new Error('MergeWorkerAdapter is not loaded');
        workerResult = await window.MergeWorkerAdapter.dispatch(files, opts || {}, onProgress, runToken);
      }

      _memoryGuard('post-worker', null);
      if (!workerResult || !workerResult.buffer) throw new Error('Merge worker returned no output');

      onProgress(96, 'Preparing download…');
      var blob = new Blob([workerResult.buffer], { type: 'application/pdf' });
      workerResult = null;
      if (!blob.size) throw new Error('Merge output is empty');

      if (window.RuntimeCleanup && window.RuntimeCleanup.trackGeneric) {
        var id = window.RuntimeCleanup.trackGeneric(function () {}, 'merge-output-blob');
        runCleanupIds.generic.push(id);
      }

      var filename = window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename((files[0] && files[0].name) || 'merged.pdf', '.pdf')
        : 'ILovePDF-merged.pdf';

      if (window.RuntimeTelemetry) {
        window.RuntimeTelemetry.record('merge:success', {
          outputBytes: blob.size,
          fileCount: files.length
        });
      }
      if (runTask) {
        try { runTask.complete(); } catch (_) {}
      }

      _cleanup('success', runToken, runSpan, runCleanupIds);
      return { blob: blob, filename: filename };
    } catch (err) {
      try { Object.defineProperty(err, '__mergeRunToken', { value: runToken, configurable: true }); } catch (_) {}
      throw err;
    }
  }

  async function execute(files, opts) {
    var executionToken = null;
    try {
      return await runMergeRuntime(files, opts || {});
    } catch (err) {
      executionToken = err && err.__mergeRunToken ? err.__mergeRunToken : null;
      var reason = (err && err.message) || 'unknown';
      if (window.RuntimeTelemetry) {
        try { window.RuntimeTelemetry.record('merge:runtime-error', { reason: reason }); } catch (_) {}
      }
      _cleanup('error:' + reason, executionToken);
      throw err;
    }
  }

  function _patchBrowserTools() {
    if (!window.BrowserTools || _origProcess) return;
    _origProcess = window.BrowserTools.process.bind(window.BrowserTools);
    window.BrowserTools.process = function (toolId, files, options) {
      if (toolId !== 'merge') return _origProcess(toolId, files, options);
      return execute(Array.from(files || []), options || {});
    };
    window.BrowserTools._origMergeProcess = _origProcess;
  }

  function _registerStreamMarkers() {
    if (!window.RuntimeStreaming) return;
    window.RuntimeStreaming.markFullLoad('merge:read-files', {
      description: 'Input PDFs currently read before shared worker dispatch'
    });
    window.RuntimeStreaming.markFullLoad('merge:output-blob', {
      description: 'Merged output buffer held as Blob before download'
    });
  }

  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      if (_currentToken && !_currentToken.cancelled) {
        var token = _currentToken;
        token.cancel(reason === 'pagehide' ? 'pagehide' : 'tab-hidden');
        _cleanup('nav-cancel:' + reason, token);
      }
    });
  }

  window.addEventListener('pagehide', function () {
    if (_currentToken && !_currentToken.cancelled) {
      var token = _currentToken;
      token.cancel('pagehide');
      _cleanup('nav-cancel:pagehide', token);
    }
  }, { passive: true });

  (function () {
    if (window.BrowserTools) {
      _patchBrowserTools();
      _registerStreamMarkers();
      return;
    }
    var retries = 0;
    var timer = setInterval(function () {
      retries++;
      if (window.BrowserTools) {
        clearInterval(timer);
        _patchBrowserTools();
        _registerStreamMarkers();
      } else if (retries > 20) {
        clearInterval(timer);
        console.warn(LOG, 'BrowserTools not found after 20 attempts — patch skipped');
      }
    }, 100);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval('merge-runtime-patch-retry', timer);
  }());

  window.MergeRuntime = {
    execute: execute,
    runMergeRuntime: runMergeRuntime,
    getDiagnostics: function () {
      return {
        runtimeEnabled: true,
        patchActive: !!_origProcess,
        activeToken: _currentToken ? { id: _currentToken.id, cancelled: _currentToken.cancelled } : null,
        activeSpan: _currentSpan,
        progressTask: _progressTask ? _progressTask.taskId : null,
        workerAdapter: !!window.MergeWorkerAdapter
      };
    },
    cancelActive: function (reason) {
      if (_currentToken && !_currentToken.cancelled) {
        var token = _currentToken;
        token.cancel(reason || 'manual-cancel');
        _cleanup('cancel:' + (reason || 'manual-cancel'), token);
        return true;
      }
      return false;
    }
  };

  console.debug(LOG, 'MergeRuntime ready — canonical runtime path');
}());

// MergePdfApp v2.0 — Phase 5 standard-tool migration.
// Tool-owned Merge processor using the shared WorkerPool for normal jobs and
// RuntimeStreamBridge multi-file streaming for large inputs. No artificial
// file-size, page-count, or processing-time rejection thresholds.
(function (G) {
  'use strict';

  var TAG = '[MergePdfApp]';
  var TOOL_ID = 'merge';
  var WORKER = '/workers/pdf-worker.js';
  var STREAM_THRESHOLD = 10 * 1024 * 1024;

  var _inFlight = false;
  var _jobId = 0;
  var _cancelToken = null;

  function _log(m, d) { console.debug(TAG, m, d !== undefined ? d : ''); }
  function _warn(m, d) { console.warn(TAG, m, d !== undefined ? d : ''); }

  function _step() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (i, s, p, h) {
        try { lf.update(i, s, p, h); } catch (_) {}
      };
    }
    return function () {};
  }

  function _cancel() {
    if (_cancelToken && typeof _cancelToken.cancel === 'function') {
      try { _cancelToken.cancel(); } catch (_) {}
    }
    _cancelToken = null;
    _inFlight = false;
  }

  async function _runWorker(files, opts, jobId, onStep) {
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') {
      throw new Error('worker_processing_unavailable');
    }

    _cancelToken = G.WorkerPool.CancelToken ? new G.WorkerPool.CancelToken() : null;
    var bridge = G.RuntimeStreamBridge;
    var totalBytes = files.reduce(function (sum, file) {
      return sum + (file && file.size || 0);
    }, 0);

    // Merge is multi-file, so use the bridge's bounded multi-file stream path
    // once the aggregate input is large enough. This keeps source bytes off the
    // main-thread heap while the worker accumulates one source file at a time.
    if (bridge && typeof bridge.streamFilesToWorkerReadable === 'function' &&
        totalBytes >= STREAM_THRESHOLD) {
      var streamed = await bridge.streamFilesToWorkerReadable(
        WORKER,
        files,
        { tool: TOOL_ID, options: opts || {}, jobId: String(jobId) },
        {
          token: _cancelToken,
          onProgress: function (pct, label) {
            try {
              onStep(1, 'active', Math.max(25, Math.min(84, pct || 25)),
                label || 'Streaming files…');
            } catch (_) {}
          }
        }
      );
      if (!streamed || !(streamed.buffer instanceof ArrayBuffer)) {
        throw new Error('worker_processing_failed');
      }
      return streamed.buffer;
    }

    // Normal path: WorkerPool owns the persistent shared worker slot.
    var buffers = [];
    for (var i = 0; i < files.length; i++) {
      if (_cancelToken && _cancelToken.cancelled) throw new Error('cancelled');
      buffers.push(await files[i].arrayBuffer());
      try {
        onStep(0, 'active', 5 + Math.round(((i + 1) / files.length) * 15),
          'Reading file ' + (i + 1) + ' of ' + files.length + '…');
      } catch (_) {}
    }

    var transferables = buffers.slice();
    var result = await G.WorkerPool.run(
      WORKER,
      { tool: TOOL_ID, buffers: buffers, options: opts || {}, jobId: String(jobId) },
      transferables,
      { priority: 'high', token: _cancelToken }
    );

    if (!result || !(result.buffer instanceof ArrayBuffer)) {
      throw new Error('worker_processing_failed');
    }
    return result.buffer;
  }

  function _filename() {
    return 'ilovepdf-merged.pdf';
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Merge already in progress');
    if (!files || !files.length) throw new Error('No files provided');

    _inFlight = true;
    var jobId = ++_jobId;
    var onStep = _step();

    _log('start', {
      job: jobId,
      files: files.length,
      bytes: files.reduce(function (sum, file) { return sum + (file.size || 0); }, 0)
    });

    try {
      onStep(0, 'active', 5, 'Preparing files…');
      await Promise.resolve();
      onStep(0, 'done', 20);
      onStep(1, 'active', 25, 'Merging pages…');

      var resultBuf = await _runWorker(files, opts || {}, jobId, onStep);

      onStep(1, 'done', 85);
      onStep(2, 'active', 90, 'Finalizing…');

      var blob = new Blob([resultBuf], { type: 'application/pdf' });
      resultBuf = null;

      onStep(2, 'done', 100);
      _log('done', { job: jobId, size: blob.size });

      return { blob: blob, filename: _filename() };
    } catch (err) {
      _warn('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cancelToken = null;
      _inFlight = false;
    }
  }

  function mount() { _log('mounted'); }
  function unmount() { _cancel(); }
  function reset() { _cancel(); }
  function recover() { _cancel(); }
  function destroy() { _cancel(); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, cancellable: !!_cancelToken };
  }

  function _register() {
    if (!G.ToolAppManager) {
      _warn('ToolAppManager not available');
      return;
    }
    G.ToolAppManager.registerTool(TOOL_ID, function () {
      return {
        process: process,
        mount: mount,
        unmount: unmount,
        reset: reset,
        recover: recover,
        destroy: destroy,
        getState: getState
      };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register);
  } else {
    _register();
  }

  _log('v2.0 ready');
}(window));

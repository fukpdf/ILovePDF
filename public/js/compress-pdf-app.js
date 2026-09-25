// CompressPdfApp v2.0 — Phase 5 standard-tool migration.
// Tool-owned processor using the shared persistent PDF WorkerPool.
// Large single-file jobs use RuntimeStreamBridge. No artificial file/time limits.
(function (G) {
  'use strict';

  var TAG = '[CompressPdfApp]';
  var TOOL_ID = 'compress';
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
      return function (i, s, p, h) { try { lf.update(i, s, p, h); } catch (_) {} };
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

  async function _runWorker(file, opts, jobId) {
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') {
      throw new Error('worker_processing_unavailable');
    }

    _cancelToken = G.WorkerPool.CancelToken ? new G.WorkerPool.CancelToken() : null;
    var bridge = G.RuntimeStreamBridge;

    if (bridge && typeof bridge.pipelineStreamToWorker === 'function' &&
        file.size >= STREAM_THRESHOLD) {
      var streamed = await bridge.pipelineStreamToWorker(
        WORKER,
        file,
        { tool: TOOL_ID, options: opts || {} },
        {
          token: _cancelToken,
          onProgress: function (pct, label) {
            try {
              _step()(1, 'active', Math.max(25, Math.min(84, pct || 25)),
                label || 'Compressing PDF…');
            } catch (_) {}
          }
        }
      );
      if (!streamed || !streamed.buffer) throw new Error('worker_processing_failed');
      return streamed.buffer;
    }

    var buffer = await file.arrayBuffer();
    var result = await G.WorkerPool.run(
      WORKER,
      {
        tool: TOOL_ID,
        buffers: [buffer],
        options: opts || {},
        jobId: String(jobId)
      },
      [buffer],
      { priority: 'high', token: _cancelToken }
    );
    _cancelToken = null;
    if (!result || !result.buffer) throw new Error('worker_processing_failed');
    return result.buffer;
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Compression already in progress');
    if (!files || !files[0]) throw new Error('No file provided');

    _inFlight = true;
    var jobId = ++_jobId;
    var file = files[0];
    var onStep = _step();

    _log('start', { job: jobId, file: file.name, size: file.size });

    try {
      onStep(0, 'active', 5, 'Reading file…');
      await Promise.resolve();
      onStep(0, 'done', 20);
      onStep(1, 'active', 25, 'Optimizing content…');

      var resultBuf = await _runWorker(file, opts || {}, jobId);
      onStep(1, 'done', 85);
      onStep(2, 'active', 90, 'Finalizing…');

      var blob = new Blob([resultBuf], { type: 'application/pdf' });
      resultBuf = null;

      onStep(2, 'done', 100);
      _log('done', { job: jobId, size: blob.size });
      return {
        blob: blob,
        filename: _filename(file.name),
        alreadyOptimized: blob.size >= file.size
      };
    } catch (err) {
      _warn('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cancelToken = null;
      _inFlight = false;
    }
  }

  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return (base.toLowerCase().startsWith('ilovepdf') ? base : 'ilovepdf-' + base) + '.pdf';
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
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  _log('v2.0 ready');
}(window));

// Split Worker Adapter v1.1 — canonical RuntimeWorkers + adaptive streaming bridge
(function () {
  'use strict';
  if (window.SplitWorkerAdapter) return;
  var WORKER_URL = '/workers/pdf-worker.js';
  var TIMEOUT_MS = 0;
  var STREAM_THRESHOLD = 10*1024*1024;
  function key(file, opts) {
    opts = opts || {};
    return 'split:' + String(file && file.name || '') + ':' + String(file && file.size || 0) + ':' + String(file && file.lastModified || 0) + ':' + String(opts.range || '');
  }
  async function dispatch(file, opts, onProgress, token) {
    opts = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    if (!file) throw new Error('No file provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');
    if (file.size >= STREAM_THRESHOLD && window.RuntimeStreamBridge &&
        typeof window.RuntimeStreamBridge.pipelineStreamToWorker === 'function') {
      onProgress(5, 'Preparing streaming split…');
      var streamed = await window.RuntimeStreamBridge.pipelineStreamToWorker(
        WORKER_URL, file, { tool: 'split', options: opts },
        { token: token, onProgress: onProgress, streamThreshold: STREAM_THRESHOLD }
      );
      if (streamed) {
        if (!streamed.buffer || !streamed.buffer.byteLength) throw new Error('Worker produced empty output');
        onProgress(100, 'Done!');
        return { buffer: streamed.buffer };
      }
    }
    if (!window.RuntimeWorkers || typeof window.RuntimeWorkers.dispatch !== 'function') {
      throw new Error('RuntimeWorkers is unavailable — canonical Split worker runtime cannot dispatch');
    }
    onProgress(10, 'Reading PDF…');
    var buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error('Split input is empty');
    if (token && token.cancelled) throw new Error('cancelled-after-read');
    var result = await window.RuntimeWorkers.dispatch(
      WORKER_URL,
      { tool: 'split', buffers: [buffer], options: opts },
      [buffer],
      { priority: 'normal', label: 'split-worker', dedupeKey: key(file, opts), timeoutMs: TIMEOUT_MS, token: token }
    );
    if (!result || !result.buffer || !result.buffer.byteLength) throw new Error('Worker produced empty output');
    onProgress(100, 'Done!');
    return { buffer: result.buffer };
  }
  window.SplitWorkerAdapter = { dispatch: dispatch, WORKER_URL: WORKER_URL, TIMEOUT_MS: TIMEOUT_MS, STREAM_THRESHOLD: STREAM_THRESHOLD };
}());
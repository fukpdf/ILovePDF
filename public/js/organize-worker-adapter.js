// Organize Worker Adapter v1.0 — canonical RuntimeWorkers + adaptive streaming
(function () {
  'use strict';
  if (window.OrganizeWorkerAdapter) return;
  var WORKER_URL = '/workers/pdf-worker.js';
  var TIMEOUT_MS = 0;
  var STREAM_THRESHOLD = 10 * 1024 * 1024;
  function key(file, opts) {
    opts = opts || {};
    return 'organize:' + String(file && file.name || '') + ':' +
      String(file && file.size || 0) + ':' + String(file && file.lastModified || 0) + ':' +
      String(opts.pageOrder || '');
  }
  async function dispatch(file, opts, onProgress, token) {
    opts = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    if (!file) throw new Error('No file provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');
    if (file.size >= STREAM_THRESHOLD && window.RuntimeStreamBridge &&
        typeof window.RuntimeStreamBridge.pipelineStreamToWorker === 'function') {
      onProgress(5, 'Preparing streaming organize…');
      var streamed = await window.RuntimeStreamBridge.pipelineStreamToWorker(
        WORKER_URL, file, { tool: 'organize', options: opts },
        { token: token, onProgress: onProgress, streamThreshold: STREAM_THRESHOLD }
      );
      if (streamed) {
        if (!streamed.buffer || !streamed.buffer.byteLength) throw new Error('Worker produced empty output');
        onProgress(100, 'Done!');
        return { buffer: streamed.buffer };
      }
    }
    if (!window.RuntimeWorkers || typeof window.RuntimeWorkers.dispatch !== 'function') {
      throw new Error('RuntimeWorkers is unavailable — canonical Organize worker runtime cannot dispatch');
    }
    onProgress(10, 'Reading PDF…');
    var buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error('Organize input is empty');
    if (token && token.cancelled) throw new Error('cancelled-after-read');
    var result = await window.RuntimeWorkers.dispatch(
      WORKER_URL,
      { tool: 'organize', buffers: [buffer], options: opts },
      [buffer],
      { priority: 'normal', label: 'organize-worker', dedupeKey: key(file, opts), timeoutMs: TIMEOUT_MS, token: token }
    );
    if (!result || !result.buffer || !result.buffer.byteLength) throw new Error('Worker produced empty output');
    onProgress(100, 'Done!');
    return { buffer: result.buffer };
  }
  window.OrganizeWorkerAdapter = {
    dispatch: dispatch, WORKER_URL: WORKER_URL,
    TIMEOUT_MS: TIMEOUT_MS, STREAM_THRESHOLD: STREAM_THRESHOLD
  };
}());
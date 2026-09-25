// Watermark Worker Adapter v2.0 — canonical RuntimeWorkers + adaptive streaming
(function () {
  'use strict';
  if (window.WatermarkWorkerAdapter) return;
  var WORKER_URL = '/workers/pdf-worker.js';
  var TIMEOUT_MS = 0;
  var STREAM_THRESHOLD = 10 * 1024 * 1024;
  function key(file, opts) {
    opts = opts || {};
    return 'watermark:' + String(file && file.name || '') + ':' + String(file && file.size || 0) + ':' +
      String(file && file.lastModified || 0) + ':' + String(opts.text || 'WATERMARK').slice(0, 40) + ':' +
      String(opts.opacity || '0.3') + ':' + String(opts.position || 'center');
  }
  async function dispatch(file, opts, onProgress, token) {
    opts = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    if (!file) throw new Error('No file provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');
    if (file.size >= STREAM_THRESHOLD && window.RuntimeStreamBridge &&
        typeof window.RuntimeStreamBridge.pipelineStreamToWorker === 'function') {
      onProgress(5, 'Preparing streaming watermark…');
      var streamed = await window.RuntimeStreamBridge.pipelineStreamToWorker(
        WORKER_URL, file, { tool: 'watermark', options: opts },
        { token: token, onProgress: onProgress, streamThreshold: STREAM_THRESHOLD }
      );
      if (streamed) {
        if (!streamed.buffer || !streamed.buffer.byteLength) throw new Error('Worker produced empty output');
        onProgress(100, 'Done!');
        return { buffer: streamed.buffer };
      }
    }
    if (!window.RuntimeWorkers || typeof window.RuntimeWorkers.dispatch !== 'function') {
      throw new Error('RuntimeWorkers is unavailable — canonical Watermark worker runtime cannot dispatch');
    }
    onProgress(10, 'Reading PDF…');
    var buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error('Watermark input is empty');
    if (token && token.cancelled) throw new Error('cancelled-after-read');
    var result = await window.RuntimeWorkers.dispatch(
      WORKER_URL,
      { tool: 'watermark', buffers: [buffer], options: opts },
      [buffer],
      { priority: 'normal', label: 'watermark-worker', dedupeKey: key(file, opts), timeoutMs: TIMEOUT_MS, token: token }
    );
    if (!result || !result.buffer || !result.buffer.byteLength) throw new Error('Worker produced empty output');
    onProgress(100, 'Done!');
    return { buffer: result.buffer };
  }
  window.WatermarkWorkerAdapter = { dispatch: dispatch, WORKER_URL: WORKER_URL, TIMEOUT_MS: TIMEOUT_MS, STREAM_THRESHOLD: STREAM_THRESHOLD };
}());
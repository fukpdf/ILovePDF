// Compress Worker Adapter v1.0 — canonical RuntimeWorkers + zero fallback
(function () {
  'use strict';
  if (window.CompressWorkerAdapter) return;

  var WORKER_URL = '/workers/pdf-worker.js';
  var TIMEOUT_MS = 0;

  function key(file, opts) {
    opts = opts || {};
    return 'compress:' +
      String(file && file.name || '') + ':' +
      String(file && file.size || 0) + ':' +
      String(file && file.lastModified || 0) + ':' +
      String(opts.level || 'medium');
  }

  async function dispatch(file, opts, onProgress, token) {
    opts = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    if (!file) throw new Error('No file provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');
    if (!window.RuntimeWorkers || typeof window.RuntimeWorkers.dispatch !== 'function') {
      throw new Error('RuntimeWorkers is unavailable — canonical Compress worker runtime cannot dispatch');
    }

    onProgress(10, 'Reading PDF…');
    var buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error('Compress input is empty');
    if (token && token.cancelled) throw new Error('cancelled-after-read');

    var result = await window.RuntimeWorkers.dispatch(
      WORKER_URL,
      { tool: 'compress', buffers: [buffer], options: opts },
      [buffer],
      {
        priority: 'normal',
        label: 'compress-worker',
        dedupeKey: key(file, opts),
        timeoutMs: TIMEOUT_MS,
        token: token
      }
    );

    if (!result || !result.buffer || !result.buffer.byteLength) {
      throw new Error('Compress worker produced empty output');
    }
    onProgress(100, 'Done!');
    return { buffer: result.buffer };
  }

  window.CompressWorkerAdapter = Object.freeze({
    dispatch: dispatch,
    WORKER_URL: WORKER_URL,
    TIMEOUT_MS: TIMEOUT_MS
  });
}());

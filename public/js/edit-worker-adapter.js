// Edit Worker Adapter v2.0 — canonical RuntimeWorkers, no legacy fallback
(function () {
  'use strict';
  if (window.EditWorkerAdapter) return;
  var WORKER_URL = '/workers/pdf-worker.js', TIMEOUT_MS = 0;
  function key(file, opts) {
    opts = opts || {};
    return 'edit:' + String(file && file.name || '') + ':' + String(file && file.size || 0) + ':' +
      String(file && file.lastModified || 0) + ':' + String(opts.text || '').slice(0, 100) + ':' +
      String(opts.x || '50') + ':' + String(opts.y || '50') + ':' + String(opts.page || '1');
  }
  async function dispatch(file, opts, onProgress, token) {
    opts = opts || {}; onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    if (!file) throw new Error('No file provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');
    if (!window.RuntimeWorkers || typeof window.RuntimeWorkers.dispatch !== 'function')
      throw new Error('RuntimeWorkers is unavailable — canonical Edit worker runtime cannot dispatch');
    onProgress(10, 'Reading PDF…');
    var buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error('Edit input is empty');
    if (token && token.cancelled) throw new Error('cancelled-after-read');
    var result = await window.RuntimeWorkers.dispatch(
      WORKER_URL, { tool: 'edit', buffers: [buffer], options: opts }, [buffer],
      { priority: 'normal', label: 'edit-worker', dedupeKey: key(file, opts), timeoutMs: TIMEOUT_MS, token: token }
    );
    if (!result || !result.buffer || !result.buffer.byteLength) throw new Error('Edit worker produced empty output');
    onProgress(100, 'Done!');
    return { buffer: result.buffer };
  }
  window.EditWorkerAdapter = Object.freeze({dispatch:dispatch, WORKER_URL:WORKER_URL, TIMEOUT_MS:TIMEOUT_MS});
}());

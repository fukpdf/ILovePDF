// Compress Worker Adapter v2.0 — dedicated module worker with verified lossless kit
(function () {
  'use strict';
  if (window.CompressWorkerAdapter && window.CompressWorkerAdapter.__losslessKitV2) return;

  var WORKER_URL = '/workers/compression-kit-worker.js?v=20261010-qpdf-lossless-kit-v2';

  function key(file, opts) {
    opts = opts || {};
    return 'compress-kit:' +
      String(file && file.name || '') + ':' +
      String(file && file.size || 0) + ':' +
      String(file && file.lastModified || 0) + ':' +
      String(opts.mode || opts.compressionMode || 'deep') + ':' +
      String(opts.targetBytes || '');
  }

  function selectedMode(opts) {
    var mode = opts && (opts.mode || opts.compressionMode);
    if (mode === 'custom') return 'custom';
    if (mode === 'deep') return 'deep';
    throw new Error('Compression mode is missing or invalid. Select Deep or Custom; no default mode was substituted.');
  }

  function selectedTarget(opts, mode) {
    if (mode !== 'custom') return null;
    var value = opts && (opts.targetBytes || opts.targetSizeBytes);
    if (Number.isSafeInteger(value) && value > 0) return value;
    throw new Error('Custom compression requires a valid target size. Deep mode was not substituted.');
  }

  async function dispatch(file, opts, onProgress, token) {
    opts = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    if (!file) throw new Error('No file provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');

    var mode = selectedMode(opts);
    var targetBytes = selectedTarget(opts, mode);
    onProgress(5, 'Preparing browser-only compression…');
    var buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error('Compress input is empty');
    if (token && token.cancelled) throw new Error('cancelled-after-read');

    return await new Promise(function (resolve, reject) {
      var worker;
      var settled = false;
      var cancelPoll = null;
      var jobId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);

      function finish(err, value) {
        if (settled) return;
        settled = true;
        if (cancelPoll !== null) clearInterval(cancelPoll);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
        }
        if (err) reject(err);
        else resolve(value);
      }

      try {
        worker = new Worker(WORKER_URL, { type: 'module' });
      } catch (err) {
        finish(new Error('Could not start the local compression worker: ' + (err.message || err)));
        return;
      }

      worker.onmessage = function (event) {
        var message = event.data || {};
        if (message.id !== jobId) return;
        if (message.type === 'progress') {
          onProgress(Math.max(5, Math.min(95, Number(message.percent) || 15)), message.text || 'Compressing locally in your browser…');
          return;
        }
        if (message.type === 'error') {
          finish(new Error(message.message || 'Compression worker failed'));
          return;
        }
        if (message.type !== 'result' || !(message.buffer instanceof ArrayBuffer)) {
          finish(new Error('Compression worker returned an invalid response.'));
          return;
        }
        if (token && token.cancelled) {
          finish(new Error('Compression cancelled.'));
          return;
        }
        onProgress(95, 'Checking the verified output…');
        finish(null, {
          buffer: message.buffer,
          originalSize: file.size,
          savedPct: message.report && message.report.savedPercent || 0,
          report: message.report || null,
          jobId: jobId
        });
      };

      worker.onerror = function (event) {
        finish(new Error((event && event.message) || 'Compression worker crashed.'));
      };

      // Cancellation is polled on the UI thread, so a synchronous WASM call
      // can still be stopped by terminating its dedicated worker.
      cancelPoll = setInterval(function () {
        if (token && token.cancelled) finish(new Error('Compression cancelled.'));
      }, 100);

      try {
        worker.postMessage({
          id: jobId,
          type: 'compress',
          buffer: buffer,
          mode: mode,
          targetBytes: targetBytes
        }, [buffer]);
      } catch (err) {
        finish(new Error('Could not transfer PDF bytes to the local worker: ' + (err.message || err)));
      }
    });
  }

  window.CompressWorkerAdapter = Object.freeze({
    __losslessKitV2: true,
    dispatch: dispatch,
    WORKER_URL: WORKER_URL,
    key: key
  });
}());

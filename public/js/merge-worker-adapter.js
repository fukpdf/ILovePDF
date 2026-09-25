// Merge Worker Adapter v1.1 — canonical RuntimeWorkers bridge
// Multi-file Merge uses the shared PDF worker and RuntimeWorkers only.
// There is no direct WorkerPool fallback and no artificial processing timeout.
(function () {
  'use strict';

  if (window.MergeWorkerAdapter) return;

  var WORKER_URL = '/workers/pdf-worker.js';
  var TIMEOUT_MS = 0;

  function _dedupeKey(files) {
    var parts = [String(files.length)];
    files.forEach(function (file) {
      parts.push(String(file.name || '') + ':' + String(file.size || 0) + ':' + String(file.lastModified || 0));
    });
    return 'merge:' + parts.join('|');
  }

  async function _readFiles(files, onProgress, token) {
    var totalBytes = files.reduce(function (sum, file) { return sum + (file.size || 0); }, 0);
    var readBytes = 0;
    var buffers = [];

    if (window.RuntimeStreaming) {
      window.RuntimeStreaming.markFullLoad('merge:read-files', {
        count: files.length,
        totalBytes: totalBytes
      });
    }

    for (var i = 0; i < files.length; i++) {
      if (token && token.cancelled) throw new Error('cancelled-during-read');

      var file = files[i];
      var span = null;
      if (window.RuntimeTelemetry) {
        span = window.RuntimeTelemetry.startSpan('merge:file-read-' + i, {
          name: file.name,
          size: file.size
        });
      }

      try {
        onProgress(5, 'Reading ' + (i + 1) + ' of ' + files.length + ' files…');
        buffers.push(await file.arrayBuffer());
        readBytes += file.size || 0;
        var pct = totalBytes > 0
          ? 5 + Math.round((readBytes / totalBytes) * 45)
          : 5 + Math.round(((i + 1) / files.length) * 45);
        onProgress(Math.min(50, pct), 'File ' + (i + 1) + ' of ' + files.length + ' ready');
        if (span !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(span, 'ok');
      } catch (err) {
        if (span !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(span, 'error');
        throw err;
      }
    }
    return buffers;
  }

  function _startProgressTicker(onProgress) {
    var pct = 50;
    var messages = ['Merging documents…', 'Merging pages…', 'Building merged PDF…', 'Finalising pages…'];
    var timer = setInterval(function () {
      if (pct >= 85) {
        clearInterval(timer);
        return;
      }
      pct = Math.min(85, pct + Math.max(1, Math.round((85 - pct) * 0.12)));
      var index = Math.min(messages.length - 1, Math.floor((pct - 50) / 9));
      onProgress(pct, messages[index]);
    }, 800);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval('merge-runtime-progress', timer);
    return function () {
      clearInterval(timer);
      if (window.TimerRegistry) window.TimerRegistry.clearOwner('merge-runtime-progress');
    };
  }

  async function dispatch(files, opts, onProgress, token) {
    opts = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};

    if (!files || !files.length) throw new Error('No files provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');

    var totalBytes = files.reduce(function (sum, file) { return sum + (file.size || 0); }, 0);
    if (window.RuntimeMemory && window.RuntimeMemory.isEmergency() && window.RuntimeTelemetry) {
      window.RuntimeTelemetry.record('merge:memory-advisory', { totalBytes: totalBytes, state: 'emergency' });
    }

    var span = null;
    if (window.RuntimeTelemetry) {
      span = window.RuntimeTelemetry.startSpan('merge:worker-dispatch', {
        fileCount: files.length,
        totalBytes: totalBytes
      });
    }

    var buffers;
    try {
      // Large multi-file jobs use the shared streaming bridge so the main thread
      // never accumulates every source PDF at once. Smaller jobs stay on the
      // canonical RuntimeWorkers/WorkerPool dispatch path.
      var streamThreshold = 10 * 1024 * 1024;
      if (totalBytes >= streamThreshold && window.RuntimeStreamBridge &&
          typeof window.RuntimeStreamBridge.streamFilesToWorkerReadable === 'function') {
        onProgress(8, 'Preparing streaming merge…');
        var streamed = await window.RuntimeStreamBridge.streamFilesToWorkerReadable(
          WORKER_URL,
          files,
          { tool: 'merge', options: opts },
          { token: token, onProgress: onProgress }
        );
        if (!streamed || !streamed.buffer) throw new Error('Worker produced empty output');
        if (span !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(span, 'ok');
        onProgress(100, 'Done!');
        return { buffer: streamed.buffer, blobSize: streamed.buffer.byteLength };
      }

      buffers = await _readFiles(files, onProgress, token);
      if (token && token.cancelled) throw new Error('cancelled-after-read');

      onProgress(50, 'Merging documents…');
      var stopTicker = _startProgressTicker(onProgress);
      var workerResult;

      try {
        if (!window.RuntimeWorkers || typeof window.RuntimeWorkers.dispatch !== 'function') {
          throw new Error('RuntimeWorkers is unavailable — canonical Merge worker runtime cannot dispatch');
        }

        workerResult = await window.RuntimeWorkers.dispatch(
          WORKER_URL,
          { tool: 'merge', buffers: buffers, options: opts },
          buffers,
          {
            priority: 'normal',
            label: 'merge-worker',
            dedupeKey: _dedupeKey(files),
            timeoutMs: TIMEOUT_MS,
            token: token
          }
        );
      } finally {
        stopTicker();
        buffers = null;
      }

      if (!workerResult || !workerResult.buffer) throw new Error('Worker produced empty output');

      var blob = new Blob([workerResult.buffer], { type: 'application/pdf' });
      if (!blob.size) throw new Error('Worker produced empty output');

      if (span !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(span, 'ok');
      onProgress(100, 'Done!');

      return { buffer: workerResult.buffer, blobSize: blob.size };
    } catch (err) {
      if (span !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(span, 'error');
      buffers = null;
      throw err;
    }
  }

  window.MergeWorkerAdapter = {
    dispatch: dispatch,
    WORKER_URL: WORKER_URL,
    TIMEOUT_MS: TIMEOUT_MS
  };

  console.debug('[MergeWorkerAdapter] ready — canonical RuntimeWorkers bridge');
}());

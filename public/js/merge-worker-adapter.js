// Merge Worker Adapter v2.0 — streaming, browser-only merge dispatch.
(function () {
  'use strict';

  if (window.MergeWorkerAdapter) return;

  var LOG = '[MWA2]';
  var WORKER_URL = '/workers/pdf-lib-worker.js';
  var TIMEOUT_MS = 180000;

  function _dedupeKey(files) {
    var parts = [String(files.length)];
    files.forEach(function (f) { parts.push(f.name + ':' + f.size + ':' + (f.lastModified || 0)); });
    return 'merge:' + parts.join('|');
  }

  function _startProgressTicker(files, onProgress) {
    var pct = 50;
    var messages = ['Merging documents…', 'Merging pages…', 'Building merged PDF…', 'Finalising pages…'];
    var msgIdx = 0;
    var intervalId = setInterval(function () {
      if (pct >= 85) { clearInterval(intervalId); return; }
      pct = Math.min(85, pct + Math.max(1, Math.round((85 - pct) * 0.12)));
      msgIdx = Math.min(messages.length - 1, Math.floor((pct - 50) / 9));
      onProgress(pct, messages[msgIdx]);
    }, 800);
    return function () { clearInterval(intervalId); };
  }

  function _spawn() {
    if (window.RuntimeWorkerFactory && window.RuntimeWorkerFactory.spawn) {
      return window.RuntimeWorkerFactory.spawn(WORKER_URL);
    }
    return new Worker(WORKER_URL);
  }

  async function dispatch(files, opts, onProgress, token) {
    opts = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};
    if (!files || !files.length) throw new Error('No files provided');
    if (token && token.cancelled) throw new Error('cancelled-before-read');
    if (window.RuntimeMemory && window.RuntimeMemory.isEmergency()) throw new Error('memory_pressure');

    var totalBytes = files.reduce(function (s, f) { return s + f.size; }, 0);
    var spanId = window.RuntimeTelemetry
      ? window.RuntimeTelemetry.startSpan('merge:worker-dispatch', { fileCount: files.length, totalBytes: totalBytes })
      : null;
    var worker = null;
    var timer = null;
    var stopTicker = function () {};
    var cancelUnsubscribe = null;
    var settled = false;

    try {
      worker = _spawn();
      stopTicker = _startProgressTicker(files, onProgress);
      onProgress(5, 'Preparing files…');

      var result = await new Promise(function (resolve, reject) {
        var index = 0;
        var jobId = 'merge-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        function cleanup() {
          if (timer) { clearTimeout(timer); timer = null; }
          if (cancelUnsubscribe) { try { cancelUnsubscribe(); } catch (_) {} cancelUnsubscribe = null; }
        }
        function finish(err, value) {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) reject(err); else resolve(value);
        }
        function sendNext() {
          if (token && token.cancelled) return finish(new Error('cancelled-during-read'));
          if (index >= files.length) {
            worker.postMessage({ op: 'merge-stream-finish', jobId: jobId });
            return;
          }
          files[index].arrayBuffer().then(function (buffer) {
            if (token && token.cancelled) return finish(new Error('cancelled-during-read'));
            onProgress(5 + Math.round(((index + 1) / files.length) * 45), 'Reading ' + (index + 1) + ' of ' + files.length + ' files…');
            worker.postMessage({ op: 'merge-stream-item', index: index, buffer: buffer, jobId: jobId }, [buffer]);
          }).catch(function (e) { finish(e); });
        }
        worker.onmessage = function (ev) {
          var d = ev.data || {};
          if (d.__error) return finish(new Error(d.__error));
          if (d.type === 'merge-stream-ready') return sendNext();
          if (d.type === 'merge-stream-ack') { index = Number(d.index) + 1; return sendNext(); }
          if (d.type === 'merge-stream-done' && d.buffer instanceof ArrayBuffer) return finish(null, d.buffer);
        };
        worker.onerror = function (ev) { finish(new Error((ev && ev.message) || 'Merge worker error')); };
        worker.postMessage({ op: 'merge-stream-start', count: files.length, opts: opts, jobId: jobId });
        timer = setTimeout(function () { finish(new Error('Merge worker timed out.')); }, TIMEOUT_MS);
        if (token && typeof token.onCancel === 'function') {
          cancelUnsubscribe = token.onCancel(function () {
            try { worker.terminate(); } catch (_) {}
            finish(new Error('cancelled'));
          });
        }
      });

      if (window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'ok');
      onProgress(95, 'Saving merged PDF…');
      if (!result || result.byteLength === 0) throw new Error('Worker produced empty output');
      onProgress(100, 'Done!');
      return { buffer: result, blobSize: result.byteLength, dedupeKey: _dedupeKey(files) };
    } catch (err) {
      if (window.RuntimeTelemetry && spanId !== null) window.RuntimeTelemetry.endSpan(spanId, 'error');
      throw err;
    } finally {
      stopTicker();
      if (worker) { try { worker.terminate(); } catch (_) {} }
      if (timer) clearTimeout(timer);
    }
  }

  window.MergeWorkerAdapter = {
    dispatch: dispatch,
    WORKER_URL: WORKER_URL,
    TIMEOUT_MS: TIMEOUT_MS,
  };

  console.debug(LOG, 'streaming merge adapter ready');
}());
// Merge Worker Adapter v1.0 — Phase 3 (Task Group B)
// Runtime-aware wrapper around the pdf-worker.js merge dispatch.
// Adds: dedupeKey, timeout, retry integration, cooldown support,
// worker leak detection, auto-release, emergency cancellation.
//
// DESIGN: Wraps WorkerPool.run('/workers/pdf-worker.js') through
// RuntimeWorkers.dispatch() when available, with direct WorkerPool.run()
// fallback so existing behavior is fully preserved when Phase 2 is absent.
//
// Progress is reported per-file (read phase) + simulated tick (worker phase).
//
// [FUTURE: StreamEngine] Replace f.arrayBuffer() per-file with OPFS byte-range
// reader so giant PDFs do not spike the JS heap before dispatch.
//
// [FUTURE: CrossTabWorkers] RuntimeWorkers.dispatch() will check a sibling
// tab for an idle pdf-worker before spawning a new one locally.
//
// Exposed as: window.MergeWorkerAdapter
(function () {
  'use strict';

  if (window.MergeWorkerAdapter) return;

  var LOG        = '[MWA]';
  var WORKER_URL = '/workers/pdf-worker.js';
  var TIMEOUT_MS = 120000; // 2 minutes hard cap

  // ── DedupeKey: hash of file count + sizes + names ─────────────────────────
  // Prevents launching two identical merges concurrently (e.g., rapid double-click
  // that escapes the _processingInFlight guard at tool-page.js level).
  function _dedupeKey(files) {
    var parts = [String(files.length)];
    files.forEach(function (f) { parts.push(f.name + ':' + f.size); });
    return 'merge:' + parts.join('|');
  }

  // ── File-read progress helper ─────────────────────────────────────────────
  // Reads each file's ArrayBuffer sequentially, reporting progress as each
  // file completes (0–50% of total progress budget).
  // Returns Array<ArrayBuffer>.
  async function _readFiles(files, onProgress, token) {
    // [FUTURE: StreamEngine] Replace arrayBuffer() with OPFS byte-range reader
    window.RuntimeStreaming && window.RuntimeStreaming.markFullLoad(
      'merge:read-files', { count: files.length, totalBytes: files.reduce(function (s, f) { return s + f.size; }, 0) }
    );
    var buffers = [];
    var totalSize = files.reduce(function (s, f) { return s + f.size; }, 0);
    var readSoFar = 0;

    for (var i = 0; i < files.length; i++) {
      if (token && token.cancelled) throw new Error('cancelled-during-read');

      var spanId = null;
      if (window.RuntimeTelemetry) {
        spanId = window.RuntimeTelemetry.startSpan('merge:read-file-' + i, { name: files[i].name, size: files[i].size });
      }

      // [FUTURE: StreamEngine] files[i].arrayBuffer() → OPFS chunk reader
      var buf = await files[i].arrayBuffer();
      buffers.push(buf);
      readSoFar += files[i].size;

      if (spanId !== null && window.RuntimeTelemetry) {
        window.RuntimeTelemetry.endSpan(spanId, 'ok');
      }

      // Progress: 0→50% maps to file read completion
      var readPct = totalSize > 0 ? Math.round((readSoFar / totalSize) * 50) : Math.round(((i + 1) / files.length) * 50);
      onProgress(readPct, 'Reading ' + (i + 1) + ' of ' + files.length + ' files…');
    }
    return buffers;
  }

  // ── Worker-phase progress ticker ───────────────────────────────────────────
  // Advances from 50% to 85% while the worker is processing.
  // Stops when the worker promise settles. Does not hold up the result.
  function _startProgressTicker(files, onProgress) {
    var pct = 50;
    var messages = [
      'Merging documents…',
      'Merging pages…',
      'Building merged PDF…',
      'Finalising pages…',
    ];
    var msgIdx = 0;

    var intervalId = setInterval(function () {
      if (pct >= 85) { clearInterval(intervalId); return; }
      // Asymptotic advance: large jumps early, tiny later → realistic feel
      var step = Math.max(1, Math.round((85 - pct) * 0.12));
      pct = Math.min(85, pct + step);
      msgIdx = Math.min(messages.length - 1, Math.floor((pct - 50) / 9));
      onProgress(pct, messages[msgIdx]);
    }, 800);

    if (window.TimerRegistry) window.TimerRegistry.registerInterval('mwa-tick', intervalId);

    return function stopTicker() {
      clearInterval(intervalId);
      if (window.TimerRegistry) window.TimerRegistry.clearOwner('mwa-tick');
    };
  }

  // ── Core dispatch ──────────────────────────────────────────────────────────
  // dispatch(files, opts, onProgress, token?) → Promise<{ blob, filename }>
  //
  // opts: standard tool options (none used by merge currently)
  // onProgress(pct, msg): progress callback 0–100
  // token: RuntimeCancellation token (optional)
  async function dispatch(files, opts, onProgress, token) {
    opts        = opts || {};
    onProgress  = typeof onProgress === 'function' ? onProgress : function () {};

    // ── Cancellation check ───────────────────────────────────────────────────
    if (token && token.cancelled) throw new Error('cancelled-before-read');

    // ── Memory guard ─────────────────────────────────────────────────────────
    if (window.RuntimeMemory && window.RuntimeMemory.isEmergency()) {
      throw new Error('memory_pressure');
    }
    var totalBytes = files.reduce(function (s, f) { return s + f.size; }, 0);
    if (window.MemPressure && window.MemPressure.wouldExceedLimit) {
      // Estimate: 2× file size in JS heap (raw bytes + pdf-lib internal copies)
      if (window.MemPressure.wouldExceedLimit(totalBytes * 2, 1.5)) {
        throw new Error('memory_pressure');
      }
    }

    // ── Telemetry span ───────────────────────────────────────────────────────
    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan('merge:worker-dispatch', {
        fileCount: files.length,
        totalBytes: totalBytes,
      });
    }

    onProgress(5, 'Preparing files…');

    // ── Phase 1: read file bytes ─────────────────────────────────────────────
    var buffers;
    try {
      buffers = await _readFiles(files, onProgress, token);
    } catch (readErr) {
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'read-error');
      throw readErr;
    }

    if (token && token.cancelled) {
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'cancelled');
      throw new Error('cancelled-after-read');
    }

    onProgress(50, 'Merging documents…');

    // ── Phase 2: dispatch to worker ──────────────────────────────────────────
    var stopTicker = _startProgressTicker(files, onProgress);
    var dedupeKey  = _dedupeKey(files);

    // [FUTURE: StreamEngine] Chunk routing: instead of sending full buffers,
    // send OPFS file handles and stream page-by-page within the worker.
    var workerMsg = {
      tool:    'merge',
      buffers: buffers,
      options: opts,
    };

    var workerResult;
    try {
      if (window.RuntimeWorkers && window.RuntimeWorkers.dispatch) {
        // Phase 2 path: full orchestration (cooldown, dedup, timeout, telemetry)
        workerResult = await window.RuntimeWorkers.dispatch(
          WORKER_URL,
          workerMsg,
          buffers,   // transferables: ownership moves to worker (zero-copy)
          {
            priority:   'normal',
            label:      'merge-worker',
            dedupeKey:  dedupeKey,
            timeoutMs:  TIMEOUT_MS,
            token:      token,
          }
        );
      } else if (window.WorkerPool && window.WorkerPool.run) {
        // Fallback: direct WorkerPool.run (legacy Phase 1 path)
        var wpToken = null;
        if (window.WorkerPool.CancelToken) wpToken = window.WorkerPool.CancelToken();
        if (token && wpToken) {
          token.onCancel(function () { try { wpToken.cancel(); } catch (_) {} });
        }
        var wpOpts = {};
        if (wpToken) wpOpts.token = wpToken;
        workerResult = await window.WorkerPool.run(WORKER_URL, workerMsg, buffers, wpOpts);
      } else {
        // No worker support: signal caller to use main-thread fallback
        throw new Error('no-worker-runtime');
      }
    } finally {
      stopTicker();
      buffers = null; // release buffer references
    }

    // ── Phase 3: build output blob ───────────────────────────────────────────
    onProgress(95, 'Saving merged PDF…');
    // [FUTURE: StreamEngine] workerResult.buffer → OPFS write + stream URL

    if (!workerResult || !workerResult.buffer) {
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'empty-result');
      throw new Error('Worker produced empty output — falling back');
    }

    var blob = new Blob([workerResult.buffer], { type: 'application/pdf' });
    if (blob.size === 0) {
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'zero-size');
      throw new Error('Worker produced empty output — falling back');
    }

    if (spanId !== null && window.RuntimeTelemetry) {
      window.RuntimeTelemetry.endSpan(spanId, 'ok');
    }

    onProgress(100, 'Done!');
    return { buffer: workerResult.buffer, blobSize: blob.size };
  }

  window.MergeWorkerAdapter = {
    dispatch:    dispatch,
    WORKER_URL:  WORKER_URL,
    TIMEOUT_MS:  TIMEOUT_MS,
  };

  console.debug('[MergeWorkerAdapter] ready — Phase 3 worker adapter active');
}());

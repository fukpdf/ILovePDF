// Rotate Worker Adapter v1.0 — Phase 3 (Task Group R004)
// Runtime-aware wrapper around the pdf-worker.js rotate dispatch.
// Follows the MergeWorkerAdapter pattern exactly (canonical reference).
//
// Differences from merge:
//   - Single-file input (not N files) — simpler read phase
//   - Options: degrees + pages — included in dedupeKey
//   - Progress phases: read (0→50%) + worker ticker (50→85%)
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() with OPFS byte-range
// reader so large PDFs do not spike the JS heap before dispatch.
//
// [FUTURE: OPFSRuntime] Store rotated output in OPFS before Blob creation
// to eliminate the brief buffer+Blob double-hold in the JS heap.
//
// [FUTURE: CrossTabWorkers] RuntimeWorkers.dispatch() will check sibling
// tabs for an idle pdf-worker before spawning a new instance locally.
//
// Exposed as: window.RotateWorkerAdapter
(function () {
  'use strict';

  if (window.RotateWorkerAdapter) return;

  var LOG        = '[RWA]';
  var WORKER_URL = '/workers/pdf-worker.js';
  var TIMEOUT_MS = 90000; // 90s — rotate is faster than merge; hard cap

  // ── DedupeKey ─────────────────────────────────────────────────────────────
  // Combines file identity + options so two different rotations of the
  // same file (e.g. 90° vs 180°) are treated as distinct operations.
  function _dedupeKey(file, opts) {
    var deg   = String((opts && opts.degrees) || '90');
    var pages = String((opts && opts.pages)   || 'all');
    return 'rotate:' + file.name + ':' + file.size + ':' + deg + ':' + pages;
  }

  // ── File-read phase ────────────────────────────────────────────────────────
  // Reads the single input file into an ArrayBuffer, marking FUTURE stream
  // entry point and emitting per-read telemetry.
  // Progress range: 5→50% of total budget.
  async function _readFile(file, onProgress, token) {
    // [FUTURE: StreamEngine] Replace with OPFS byte-range reader
    window.RuntimeStreaming && window.RuntimeStreaming.markFullLoad(
      'rotate:read-file',
      { name: file.name, size: file.size }
    );

    if (token && token.cancelled) throw new Error('cancelled-during-read');

    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan('rotate:file-read', { name: file.name, size: file.size });
    }

    onProgress(10, 'Reading file…');

    // [FUTURE: StreamEngine] file.arrayBuffer() → OPFS byte-range stream
    var buf = await file.arrayBuffer();

    if (spanId !== null && window.RuntimeTelemetry) {
      window.RuntimeTelemetry.endSpan(spanId, 'ok');
    }

    onProgress(50, 'File ready — rotating…');
    return buf;
  }

  // ── Worker-phase progress ticker ───────────────────────────────────────────
  // Advances 50→85% while the worker is processing pages.
  // Stops when the worker promise settles.
  function _startProgressTicker(opts, onProgress) {
    var pct = 50;
    var degrees = String((opts && opts.degrees) || '90');
    var messages = [
      'Rotating pages ' + degrees + '°…',
      'Applying rotation…',
      'Rebuilding page layout…',
      'Finalising rotation…',
    ];
    var msgIdx = 0;

    var intervalId = setInterval(function () {
      if (pct >= 85) { clearInterval(intervalId); return; }
      var step = Math.max(1, Math.round((85 - pct) * 0.14));
      pct = Math.min(85, pct + step);
      msgIdx = Math.min(messages.length - 1, Math.floor((pct - 50) / 9));
      onProgress(pct, messages[msgIdx]);
    }, 700);

    if (window.TimerRegistry) window.TimerRegistry.registerInterval('rwa-tick', intervalId);

    return function stopTicker() {
      clearInterval(intervalId);
      if (window.TimerRegistry) window.TimerRegistry.clearOwner('rwa-tick');
    };
  }

  // ── Core dispatch ──────────────────────────────────────────────────────────
  // dispatch(file, opts, onProgress, token?) → Promise<{ buffer, blobSize }>
  //
  // file: single File object
  // opts: { degrees: '90'|'180'|'270'|'-90', pages: 'all'|'1-3,5' }
  // onProgress(pct, msg): 0–100
  // token: RuntimeCancellation token (optional)
  async function dispatch(file, opts, onProgress, token) {
    opts       = opts || {};
    onProgress = typeof onProgress === 'function' ? onProgress : function () {};

    // ── Cancellation pre-check ───────────────────────────────────────────────
    if (token && token.cancelled) throw new Error('cancelled-before-read');

    // ── Memory guards ────────────────────────────────────────────────────────
    if (window.RuntimeMemory && window.RuntimeMemory.isEmergency()) {
      throw new Error('memory_pressure');
    }
    // Estimate: 2× file size (input buffer + pdf-lib internal)
    if (window.MemPressure && window.MemPressure.wouldExceedLimit) {
      if (window.MemPressure.wouldExceedLimit(file.size * 2, 1.5)) {
        throw new Error('memory_pressure');
      }
    }

    // ── Telemetry span ───────────────────────────────────────────────────────
    var spanId = null;
    if (window.RuntimeTelemetry) {
      spanId = window.RuntimeTelemetry.startSpan('rotate:worker-dispatch', {
        name:    file.name,
        size:    file.size,
        degrees: opts.degrees || '90',
        pages:   opts.pages   || 'all',
      });
    }

    onProgress(5, 'Preparing file…');

    // ── Phase 1: read single file ────────────────────────────────────────────
    var buf;
    try {
      buf = await _readFile(file, onProgress, token);
    } catch (readErr) {
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'read-error');
      throw readErr;
    }

    if (token && token.cancelled) {
      buf = null;
      if (spanId !== null && window.RuntimeTelemetry) window.RuntimeTelemetry.endSpan(spanId, 'cancelled');
      throw new Error('cancelled-after-read');
    }

    // ── Phase 2: dispatch to worker ──────────────────────────────────────────
    // [FUTURE: StreamEngine] Send OPFS handle instead of full buffer
    var stopTicker = _startProgressTicker(opts, onProgress);
    var dedupeKey  = _dedupeKey(file, opts);

    var workerMsg = {
      tool:    'rotate',
      buffers: [buf],
      options: opts,
    };

    var workerResult;
    try {
      if (window.RuntimeWorkers && window.RuntimeWorkers.dispatch) {
        // Phase 2 path — full orchestration
        workerResult = await window.RuntimeWorkers.dispatch(
          WORKER_URL,
          workerMsg,
          [buf],     // transferables — zero-copy ownership transfer
          {
            priority:  'normal',
            label:     'rotate-worker',
            dedupeKey: dedupeKey,
            timeoutMs: TIMEOUT_MS,
            token:     token,
          }
        );
      } else if (window.WorkerPool && window.WorkerPool.run) {
        // Fallback: direct WorkerPool.run (legacy path)
        var wpToken = null;
        if (window.WorkerPool.CancelToken) wpToken = window.WorkerPool.CancelToken();
        if (token && wpToken) {
          token.onCancel(function () { try { wpToken.cancel(); } catch (_) {} });
        }
        var wpOpts = {};
        if (wpToken) wpOpts.token = wpToken;
        workerResult = await window.WorkerPool.run(WORKER_URL, workerMsg, [buf], wpOpts);
      } else {
        throw new Error('no-worker-runtime');
      }
    } finally {
      stopTicker();
      buf = null; // release buffer reference
    }

    // ── Phase 3: validate and return ─────────────────────────────────────────
    onProgress(95, 'Saving rotated PDF…');
    // [FUTURE: StreamEngine] workerResult.buffer → OPFS write + stream URL
    // [FUTURE: OPFSRuntime] Write output to OPFS before Blob

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

  window.RotateWorkerAdapter = {
    dispatch:    dispatch,
    WORKER_URL:  WORKER_URL,
    TIMEOUT_MS:  TIMEOUT_MS,
  };

  console.debug('[RotateWorkerAdapter] ready — Phase 3 worker adapter active');
}());

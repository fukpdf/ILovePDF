// Compress Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   compress IS in WORKER_TOOLS and pdf-worker.js OPS table (OPS.compress).
//   Dispatches to pdf-worker.js via RuntimeWorkers.dispatch() with WorkerPool fallback.
//   Multi-pass strategy in OPS.compress: object-stream rebuild + second defrag pass.
//   Memory multiplier is 4× because OPS.compress loads the doc, runs two save passes,
//   and holds both result buffers simultaneously to pick the smallest.
//
// Feature flag: window.RUNTIME_COMPRESS_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// DedupeKey: file identity only — compress has no user options that alter output.
//   Two concurrent compress requests for the same file are identical; dedup wins.
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() with OPFS byte-range reader
//   so large PDFs don't spike JS heap before dispatch.
//
// [FUTURE: OPFSRuntime] Write compressed output to OPFS before Blob creation
//   to avoid the brief buffer+Blob double-hold on large files.
//
// Exposed as: window.CompressRuntime
(function () {
  'use strict';

  if (window.CompressRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[CRT] PdfWorkerRuntimeFactory not loaded — CompressRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'compress',
    namespace:   'CompressRuntime',
    flagName:    'RUNTIME_COMPRESS_ENABLED',
    LOG:         '[CRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    // OPS.compress runs two pdf-lib save passes — safe in worker, no canvas needed.
    adapterMode:   'worker',
    timeoutMs:     120000,   // 2 min — compression can be slow on large scanned PDFs
    workerTimeout: 120000,
    timerOwner:    'crt-tick',

    // DedupeKey: compress has no user-facing options, so file identity is sufficient.
    buildDedupeKey: function (files) {
      return 'compress:' + files[0].name + ':' + files[0].size;
    },

    workerProgressMessages: [
      'Compressing PDF…',
      'Rebuilding document structure…',
      'Applying object streams…',
      'Running second optimisation pass…',
      'Finalising compressed output…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Compressing PDF…';
    },
    buildProgressSubtitle: function (files) {
      var mb = (files[0] && files[0].size) ? (files[0].size / (1024 * 1024)).toFixed(1) : '?';
      return 'Input: ' + mb + ' MB — optimising…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    // Memory estimate: 4× because OPS.compress holds original + 2 save passes.
    buildSpanAttrs: function (files) {
      return {
        name:          files[0] && files[0].name,
        size:          files[0] && files[0].size,
        memEstimate4x: files[0] ? files[0].size * 4 : 0,
      };
    },
    buildSuccessAttrs: function (files, blob) {
      var inputBytes  = files[0] && files[0].size;
      var outputBytes = blob.size;
      return {
        inputBytes:    inputBytes,
        savedBytes:    Math.max(0, inputBytes - outputBytes),
        reductionPct:  inputBytes ? Math.round((1 - outputBytes / inputBytes) * 100) : 0,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-compressed.pdf';
    },
  });
}());

// Compare Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   compare() in browser-tools.js is a multi-file, main-thread handler.
//   pdf-worker.js does NOT have an OPS.compare entry.
//   Two PDFs are loaded and compared; this is inherently multi-file and uses
//   main-thread pdf-lib. The factory wraps the handler inside a RuntimeScheduler
//   slot, adding: cancellation, telemetry, memory guards, progress reporting.
//
// Feature flag: window.RUNTIME_COMPARE_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Multi-file note: compare receives files = [fileA, fileB]. The scheduler-only
//   adapter passes the full files array to origProcess unchanged. Memory estimate
//   uses the total of both files × 4 (rendering + visual diff + output).
//
// [FUTURE: OPS.compare in pdf-worker.js] Moving the compare logic to the worker
//   would allow switching adapterMode to 'worker' with no other changes needed.
//
// [FUTURE: StreamEngine] OPFS byte-range readers for both input files would
//   reduce heap pressure during the load-and-compare phase.
//
// Exposed as: window.CompareRuntime
(function () {
  'use strict';

  if (window.CompareRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[CMRT] PdfWorkerRuntimeFactory not loaded — CompareRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'compare',
    namespace:   'CompareRuntime',
    flagName:    'RUNTIME_COMPARE_ENABLED',
    LOG:         '[CMRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode: 'scheduler-only',
    timeoutMs:   120000,   // 2 min — comparison rendering can be slow on large docs
    timerOwner:  'cmrt-tick',

    workerProgressMessages: [
      'Comparing PDFs…',
      'Loading original document…',
      'Loading revised document…',
      'Detecting differences…',
      'Building comparison report…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Comparing PDFs…';
    },
    buildProgressSubtitle: function (files) {
      var a = (files[0] && files[0].name) || 'Document A';
      var b = (files[1] && files[1].name) || 'Document B';
      return a + ' vs ' + b;
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    // Memory estimate: 4× total of BOTH files (rendering + visual diff + output).
    buildSpanAttrs: function (files) {
      var totalBytes = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
      return {
        fileA:         files[0] && files[0].name,
        fileB:         files[1] && files[1].name,
        sizeA:         files[0] && files[0].size,
        sizeB:         files[1] && files[1].size,
        totalBytes:    totalBytes,
        memEstimate4x: totalBytes * 4,
      };
    },
    buildSuccessAttrs: function (files, blob) {
      return {
        sizeA:       files[0] && files[0].size,
        sizeB:       files[1] && files[1].size,
        outputBytes: blob.size,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      var base = (files[0] && files[0].name) || 'comparison';
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(base, '.pdf')
        : 'ILovePDF-compare.pdf';
    },
  });
}());

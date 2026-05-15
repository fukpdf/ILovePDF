// Compare Runtime v2.0 — Phase 4 Worker Promotion
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   OPS.compare in pdf-worker.js performs a structural comparison using pure pdf-lib:
//   page counts, page dimensions, and document metadata — then generates a PDF report.
//
// Multi-file: cfg.multiFile = true instructs _workerDispatch to read ALL files
//   in the array (both fileA and fileB) and transfer both ArrayBuffers to the worker.
//   The dedup key incorporates both files so identical comparisons are deduplicated.
//
// Output: a PDF comparison report (not a .txt file). The worker uses pdf-lib to
//   render the report as a proper PDF, consistent with all other worker OPS.
//
// Feature flag: window.RUNTIME_COMPARE_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
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
    adapterMode:   'worker',
    multiFile:     true,    // read ALL files (fileA + fileB) before dispatch
    timeoutMs:     120000,  // 2 min — two PDFs to load + report to generate
    workerTimeout: 120000,
    timerOwner:    'cmrt-tick',

    // ── Dedup key: both file identities ──────────────────────────────────────
    buildDedupeKey: function (files) {
      var a = (files[0] && files[0].name + ':' + files[0].size) || 'noA';
      var b = (files[1] && files[1].name + ':' + files[1].size) || 'noB';
      return 'compare:' + a + ':' + b;
    },

    workerProgressMessages: [
      'Comparing PDFs…',
      'Loading Document A…',
      'Loading Document B…',
      'Analysing structure…',
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
        outputBytes: blob && blob.size,
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

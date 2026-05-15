// Page Numbers Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   page-numbers IS in WORKER_TOOLS and pdf-worker.js OPS table (OPS['page-numbers']).
//   Dispatches to pdf-worker.js via RuntimeWorkers.dispatch() (Phase 2 orchestration)
//   with WorkerPool.run() as fallback, matching the RotateWorkerAdapter pattern.
//
// Feature flag: window.RUNTIME_PAGE_NUMBERS_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// DedupeKey: includes file identity + startFrom + position, so two different
//   numbering configurations of the same file are treated as distinct.
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() in _workerDispatch with
//   OPFS byte-range reader so large PDFs don't spike the JS heap before dispatch.
//
// [FUTURE: OPFSRuntime] Store output in OPFS before Blob creation to avoid
//   the brief buffer+Blob double-hold in the JS heap on large PDFs.
//
// Exposed as: window.PageNumbersRuntime
(function () {
  'use strict';

  if (window.PageNumbersRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[PNRT] PdfWorkerRuntimeFactory not loaded — PageNumbersRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'page-numbers',
    namespace:   'PageNumbersRuntime',
    flagName:    'RUNTIME_PAGE_NUMBERS_ENABLED',
    LOG:         '[PNRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'pnrt-tick',

    // DedupeKey: file identity + numbering options → prevents two identical
    // page-number runs from launching concurrently (e.g. rapid double-click).
    buildDedupeKey: function (files, opts) {
      var pos   = (opts && opts.position)  || 'bottom-center';
      var start = (opts && opts.startFrom) || '1';
      return 'page-numbers:' + files[0].name + ':' + files[0].size + ':' + pos + ':' + start;
    },

    workerProgressMessages: [
      'Adding page numbers…',
      'Numbering pages…',
      'Applying number positions…',
      'Finalising document…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Adding page numbers…';
    },
    buildProgressSubtitle: function (files, opts) {
      var pos   = (opts && opts.position)  || 'bottom-center';
      var start = parseInt((opts && opts.startFrom) || '1', 10) || 1;
      return 'Position: ' + pos + ', starting at ' + start;
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:      files[0] && files[0].name,
        size:      files[0] && files[0].size,
        position:  (opts && opts.position)  || 'bottom-center',
        startFrom: (opts && opts.startFrom) || '1',
      };
    },
    buildSuccessAttrs: function (files, blob, opts, ms) {
      return {
        position:   (opts && opts.position)  || 'bottom-center',
        startFrom:  (opts && opts.startFrom) || '1',
        inputBytes: files[0] && files[0].size,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-numbered.pdf';
    },
  });
}());

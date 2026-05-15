// Split Runtime v2.0 — Phase 4 Worker Promotion
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   OPS.split in pdf-worker.js handles page-range extraction using pure pdf-lib.
//   The factory reads files[0], transfers the ArrayBuffer to the worker (zero-copy),
//   and returns a single-output PDF containing the selected pages.
//
// Feature flag: window.RUNTIME_SPLIT_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Exposed as: window.SplitRuntime
(function () {
  'use strict';

  if (window.SplitRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[SRT] PdfWorkerRuntimeFactory not loaded — SplitRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'split',
    namespace:   'SplitRuntime',
    flagName:    'RUNTIME_SPLIT_ENABLED',
    LOG:         '[SRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,   // 90s hard cap; split is fast even on large PDFs
    workerTimeout: 90000,
    timerOwner:    'srt-tick',

    // ── Dedup key: tool + file identity + page range ─────────────────────────
    buildDedupeKey: function (files, opts) {
      return 'split:' + (files[0] && files[0].name) + ':' + (files[0] && files[0].size) + ':' + (opts && opts.range || '');
    },

    workerProgressMessages: [
      'Splitting PDF…',
      'Extracting pages…',
      'Building output document…',
      'Finalising split…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Splitting PDF…';
    },
    buildProgressSubtitle: function (files, opts) {
      var range = (opts && opts.range) ? String(opts.range) : '';
      return range ? 'Extracting pages: ' + range : 'Extracting pages…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:  files[0] && files[0].name,
        size:  files[0] && files[0].size,
        range: (opts && opts.range) || '',
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      return {
        range:       (opts && opts.range) || '',
        inputBytes:  files[0] && files[0].size,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-split.pdf';
    },
  });
}());

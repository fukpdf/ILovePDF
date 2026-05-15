// Split Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   split() in browser-tools.js runs pure pdf-lib on the main thread.
//   pdf-worker.js does NOT have an OPS.split entry, so worker dispatch is not
//   available. The factory wraps the original handler inside a RuntimeScheduler
//   slot, adding: cancellation tokens, telemetry spans, memory guards,
//   concurrency control, and progress reporting.
//
// Feature flag: window.RUNTIME_SPLIT_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// [FUTURE: StreamEngine] When StreamEngine ships, replace the Blob→ArrayBuffer
// round-trip in _schedulerOnlyDispatch with OPFS chunk streaming.
//
// [FUTURE: OPS.split in pdf-worker.js] Adding split to the worker OPS table
// would allow switching adapterMode to 'worker' here with no other changes.
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
    adapterMode: 'scheduler-only',
    timeoutMs:   90000,   // 90s hard cap; split is fast even on large PDFs
    timerOwner:  'srt-tick',

    workerProgressMessages: [
      'Splitting PDF…',
      'Extracting pages…',
      'Building output document…',
      'Finalising split…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function (files) {
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
    buildSuccessAttrs: function (files, blob, opts, ms) {
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

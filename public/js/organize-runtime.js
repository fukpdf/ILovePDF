// Organize Runtime v2.0 — Phase 4 Worker Promotion
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   OPS.organize in pdf-worker.js reorders pages using pure pdf-lib.
//   The factory reads files[0], transfers the ArrayBuffer to the worker (zero-copy),
//   and returns a single PDF with pages in the requested order.
//
// Feature flag: window.RUNTIME_ORGANIZE_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Exposed as: window.OrganizeRuntime
(function () {
  'use strict';

  if (window.OrganizeRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[ORT] PdfWorkerRuntimeFactory not loaded — OrganizeRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'organize',
    namespace:   'OrganizeRuntime',
    flagName:    'RUNTIME_ORGANIZE_ENABLED',
    LOG:         '[ORT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'ort-tick',

    // ── Dedup key: tool + file identity + desired page order ─────────────────
    buildDedupeKey: function (files, opts) {
      return 'organize:' + (files[0] && files[0].name) + ':' + (files[0] && files[0].size) + ':' + (opts && opts.pageOrder || '');
    },

    workerProgressMessages: [
      'Reordering pages…',
      'Copying pages in new order…',
      'Building reordered document…',
      'Finalising…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Organizing PDF…';
    },
    buildProgressSubtitle: function (files, opts) {
      var order = (opts && opts.pageOrder) ? String(opts.pageOrder) : '';
      return order ? 'New order: ' + order : 'Reordering pages…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:      files[0] && files[0].name,
        size:      files[0] && files[0].size,
        pageOrder: (opts && opts.pageOrder) || '',
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      return {
        pageOrder:  (opts && opts.pageOrder) || '',
        inputBytes: files[0] && files[0].size,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-organized.pdf';
    },
  });
}());

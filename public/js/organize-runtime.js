// Organize Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   organize() (reorder pages) in browser-tools.js runs pure pdf-lib on the
//   main thread. pdf-worker.js does NOT have an OPS.organize entry.
//   The factory wraps the original handler inside a RuntimeScheduler slot,
//   adding: cancellation, telemetry, memory guards, progress reporting.
//
// Feature flag: window.RUNTIME_ORGANIZE_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// [FUTURE: OPS.organize in pdf-worker.js] Moving the page-reorder logic
// to the worker would allow switching adapterMode to 'worker' here.
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
    adapterMode: 'scheduler-only',
    timeoutMs:   90000,
    timerOwner:  'ort-tick',

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
    buildSuccessAttrs: function (files, blob, opts, ms) {
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

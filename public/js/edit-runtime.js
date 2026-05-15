// Edit Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   edit has OPS.edit in pdf-worker.js. Draws text onto a target page at an x/y
//   percentage position. Pure pdf-lib — no canvas, no main-thread APIs.
//
// Feature flag: window.RUNTIME_EDIT_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// DedupeKey: includes text + x/y + page to distinguish different edit operations
//   on the same file. Text is capped at 40 chars in the key (full text in opts).
//
// Memory multiplier: 2× (input + doc + output).
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() with OPFS byte-range reader.
// [FUTURE: OPFSRuntime] Write edited output to OPFS before Blob creation.
//
// Exposed as: window.EditRuntime
(function () {
  'use strict';

  if (window.EditRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[ERT] PdfWorkerRuntimeFactory not loaded — EditRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'edit',
    namespace:   'EditRuntime',
    flagName:    'RUNTIME_EDIT_ENABLED',
    LOG:         '[ERT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'ert-tick',

    buildDedupeKey: function (files, opts) {
      var text = String((opts && opts.text) || '').slice(0, 40);
      var x    = String((opts && opts.x)    || '50');
      var y    = String((opts && opts.y)    || '50');
      var pg   = String((opts && opts.page) || '1');
      return 'edit:' + files[0].name + ':' + files[0].size + ':' + text + ':' + x + ':' + y + ':' + pg;
    },

    workerProgressMessages: [
      'Editing PDF…',
      'Loading document…',
      'Placing text on page…',
      'Saving changes…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Editing PDF…';
    },
    buildProgressSubtitle: function (files, opts) {
      var page = (opts && opts.page) ? 'Page ' + opts.page : 'All pages';
      return page + ' — adding text…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:       files[0] && files[0].name,
        size:       files[0] && files[0].size,
        textLength: ((opts && opts.text) || '').length,
        page:       (opts && opts.page) || '1',
        fontSize:   (opts && opts.fontSize) || '14',
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      return {
        inputBytes:  files[0] && files[0].size,
        textLength:  ((opts && opts.text) || '').length,
        page:        (opts && opts.page) || '1',
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-edited.pdf';
    },
  });
}());

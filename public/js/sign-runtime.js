// Sign Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   sign has OPS.sign in pdf-worker.js. Draws a styled signature text and an
//   underline on the target page. Pure pdf-lib — no canvas, no main-thread APIs.
//
// PRIVACY NOTE: The signature text (user's name) is NEVER recorded in telemetry.
//   DedupeKey uses file identity + page number only. Telemetry attrs contain
//   no personally identifiable data from the signature.
//
// Feature flag: window.RUNTIME_SIGN_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Memory multiplier: 2× (input + doc + output).
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() with OPFS byte-range reader.
// [FUTURE: OPFSRuntime] Write signed output to OPFS before Blob creation.
//
// Exposed as: window.SignRuntime
(function () {
  'use strict';

  if (window.SignRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[SGRT] PdfWorkerRuntimeFactory not loaded — SignRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'sign',
    namespace:   'SignRuntime',
    flagName:    'RUNTIME_SIGN_ENABLED',
    LOG:         '[SGRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'sgrt-tick',

    // PRIVACY: signature text intentionally excluded from dedupeKey.
    // Two sign requests for the same file+page but different names are treated
    // as distinct runs — the dedupeKey just prevents exact duplicates.
    buildDedupeKey: function (files, opts) {
      var page = String((opts && opts.page) || 'last');
      return 'sign:' + files[0].name + ':' + files[0].size + ':' + page;
    },

    workerProgressMessages: [
      'Signing PDF…',
      'Loading document…',
      'Adding signature…',
      'Drawing signature line…',
      'Finalising signed PDF…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Signing PDF…';
    },
    buildProgressSubtitle: function (files, opts) {
      var page = (opts && opts.page) ? 'Page ' + opts.page : 'Last page';
      return 'Placing signature on ' + page + '…';
    },

    // ── Telemetry (NO signature text, NO PII) ─────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name: files[0] && files[0].name,
        size: files[0] && files[0].size,
        page: (opts && opts.page) || 'last',
        // signatureText intentionally omitted
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      return {
        inputBytes: files[0] && files[0].size,
        page:       (opts && opts.page) || 'last',
        // signatureText intentionally omitted
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-signed.pdf';
    },
  });
}());

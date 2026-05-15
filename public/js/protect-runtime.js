// Protect Runtime v2.0 — Phase 4 Worker Promotion
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   OPS.protect in pdf-worker.js applies a visual lock overlay using pure pdf-lib.
//   The factory reads files[0], transfers the ArrayBuffer to the worker (zero-copy),
//   and returns a PDF with the lock overlay drawn on every page.
//
// SECURITY NOTE: The password is forwarded to the worker only inside opts{}.
//   It is NEVER recorded in telemetry, dedup keys, span attrs, or log messages.
//
// Feature flag: window.RUNTIME_PROTECT_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Exposed as: window.ProtectRuntime
(function () {
  'use strict';

  if (window.ProtectRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[PRT] PdfWorkerRuntimeFactory not loaded — ProtectRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'protect',
    namespace:   'ProtectRuntime',
    flagName:    'RUNTIME_PROTECT_ENABLED',
    LOG:         '[PRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'prt-tick',

    // ── Dedup key: file identity only — password intentionally excluded ───────
    buildDedupeKey: function (files) {
      return 'protect:' + (files[0] && files[0].name) + ':' + (files[0] && files[0].size);
    },

    workerProgressMessages: [
      'Protecting PDF…',
      'Applying password protection…',
      'Drawing security overlay…',
      'Finalising protected document…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Protecting PDF…';
    },
    buildProgressSubtitle: function () {
      return 'Applying password protection…';
    },

    // ── Telemetry (NO password data anywhere) ─────────────────────────────────
    buildSpanAttrs: function (files) {
      return {
        name: files[0] && files[0].name,
        size: files[0] && files[0].size,
        // password intentionally omitted from telemetry
      };
    },
    buildSuccessAttrs: function (files, blob) {
      return {
        inputBytes: files[0] && files[0].size,
        // password intentionally omitted from telemetry
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-protected.pdf';
    },
  });
}());

// Unlock Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   unlock() in browser-tools.js runs pure pdf-lib on the main thread.
//   It loads the PDF with ignoreEncryption:true and re-saves without
//   encryption — works for owner-password protected PDFs (the typical case).
//   pdf-worker.js does NOT have an OPS.unlock entry.
//
// Feature flag: window.RUNTIME_UNLOCK_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// [FUTURE: OPS.unlock in pdf-worker.js] Moving unlock to the worker OPS
//   table would allow switching adapterMode to 'worker' here.
//
// Exposed as: window.UnlockRuntime
(function () {
  'use strict';

  if (window.UnlockRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[URT] PdfWorkerRuntimeFactory not loaded — UnlockRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'unlock',
    namespace:   'UnlockRuntime',
    flagName:    'RUNTIME_UNLOCK_ENABLED',
    LOG:         '[URT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode: 'scheduler-only',
    timeoutMs:   90000,
    timerOwner:  'urt-tick',

    workerProgressMessages: [
      'Unlocking PDF…',
      'Removing encryption…',
      'Rebuilding document structure…',
      'Finalising unlocked PDF…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Unlocking PDF…';
    },
    buildProgressSubtitle: function () {
      return 'Removing password protection…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files) {
      return {
        name: files[0] && files[0].name,
        size: files[0] && files[0].size,
      };
    },
    buildSuccessAttrs: function (files, blob, opts, ms) {
      return {
        inputBytes: files[0] && files[0].size,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-unlocked.pdf';
    },
  });
}());

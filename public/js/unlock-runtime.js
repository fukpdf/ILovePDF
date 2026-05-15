// Unlock Runtime v2.0 — Phase 4 Worker Promotion
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   OPS.unlock in pdf-worker.js loads the PDF with ignoreEncryption:true and
//   re-saves it without encryption — removes owner-password protection.
//   The factory reads files[0], transfers the ArrayBuffer to the worker (zero-copy),
//   and returns a clean, unlocked PDF.
//
// Feature flag: window.RUNTIME_UNLOCK_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
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
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'urt-tick',

    // ── Dedup key: tool + file identity ──────────────────────────────────────
    buildDedupeKey: function (files) {
      return 'unlock:' + (files[0] && files[0].name) + ':' + (files[0] && files[0].size);
    },

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
    buildSuccessAttrs: function (files, blob) {
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

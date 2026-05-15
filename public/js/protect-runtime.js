// Protect Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   protect() in browser-tools.js runs pure pdf-lib on the main thread.
//   pdf-worker.js does NOT have an OPS.protect entry.
//   The factory wraps the original handler inside a RuntimeScheduler slot,
//   adding: cancellation, telemetry, memory guards, progress reporting.
//
// SECURITY NOTE: The password itself is NEVER recorded in telemetry.
//   Only its length (if useful for debugging) would be logged, and even that
//   is omitted here — telemetry attrs contain no password data.
//
// Feature flag: window.RUNTIME_PROTECT_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// [FUTURE: Real PDF Encryption] browser-tools.js protect() currently draws
//   a visual lock overlay (pdf-lib has no native encryption API). When a real
//   PDF encryption library is integrated, this runtime can route to a worker.
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
    adapterMode: 'scheduler-only',
    timeoutMs:   90000,
    timerOwner:  'prt-tick',

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

    // ── Telemetry (NO password data) ──────────────────────────────────────────
    buildSpanAttrs: function (files) {
      return {
        name: files[0] && files[0].name,
        size: files[0] && files[0].size,
        // password intentionally omitted from telemetry
      };
    },
    buildSuccessAttrs: function (files, blob, opts, ms) {
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

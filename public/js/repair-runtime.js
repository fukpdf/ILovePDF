// Repair Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   repair has OPS.repair in pdf-worker.js. It loads the PDF with
//   throwOnInvalidObject:false to tolerate corrupt cross-reference tables, then
//   re-saves a clean copy. Safe for worker dispatch — no canvas, no main-thread APIs.
//
//   NOTE: repair is NOT in the legacy WORKER_TOOLS list in browser-tools.js
//   (that list pre-dates the runtime system). The OPS entry exists and is correct.
//   The runtime bypasses the WORKER_TOOLS check entirely — RuntimeWorkers routes
//   directly via the OPS table, so this is safe.
//
// Feature flag: window.RUNTIME_REPAIR_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Memory multiplier: 2× (input buffer + pdf-lib internal copy + output).
//   Corrupt PDFs may expand when repaired — estimate is conservative.
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() with OPFS byte-range reader.
// [FUTURE: OPFSRuntime] Write repaired output to OPFS before Blob creation.
//
// Exposed as: window.RepairRuntime
(function () {
  'use strict';

  if (window.RepairRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[RPRT] PdfWorkerRuntimeFactory not loaded — RepairRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'repair',
    namespace:   'RepairRuntime',
    flagName:    'RUNTIME_REPAIR_ENABLED',
    LOG:         '[RPRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     120000,   // 2 min — heavily corrupt PDFs can be slow to parse
    workerTimeout: 120000,
    timerOwner:    'rprt-tick',

    buildDedupeKey: function (files) {
      return 'repair:' + files[0].name + ':' + files[0].size;
    },

    workerProgressMessages: [
      'Repairing PDF…',
      'Analysing document structure…',
      'Rebuilding cross-reference table…',
      'Recovering page tree…',
      'Finalising repaired document…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Repairing PDF…';
    },
    buildProgressSubtitle: function () {
      return 'Scanning for structural errors…';
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
        inputBytes:  files[0] && files[0].size,
        outputBytes: blob.size,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-repaired.pdf';
    },
  });
}());

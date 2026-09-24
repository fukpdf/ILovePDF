// OCR Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   ocr() in browser-tools.js performs OCR locally in the browser with PDF.js
//   and Tesseract. pdf-worker.js does NOT have an OPS.ocr entry. The factory wraps
//   the local browser cycle
//   inside a RuntimeScheduler slot, adding: cancellation, telemetry, memory guards,
//   progress reporting, and retry-safe execution.
//
// Feature flag: window.RUNTIME_OCR_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Processing time is device-dependent. There is no artificial execution timeout;
//   cancellation remains user-controlled and lifecycle cleanup remains active.
//
// Memory: 3× estimate — client holds input file + upload buffer + response Blob.
//   Actual server-side memory is not tracked here.
//
// [FUTURE: StreamEngine] Streaming PDF reads could further reduce peak input RAM
//   for very large local OCR jobs.
// [FUTURE: IndexedDB] Cache OCR result by file hash to skip re-upload on retry.
// [FUTURE: AIOrchestrator] Could trigger post-OCR semantic indexing for AI search.
//
// Exposed as: window.OcrRuntime
(function () {
  'use strict';

  if (window.OcrRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[OCRT] PdfWorkerRuntimeFactory not loaded — OcrRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'ocr',
    namespace:   'OcrRuntime',
    flagName:    'RUNTIME_OCR_ENABLED',
    LOG:         '[OCRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    // OCR remains browser-local through BrowserTools/Tesseract; the scheduler
    // wrapper adds lifecycle/progress telemetry without a time ceiling.
    adapterMode: 'scheduler-only',
    timeoutMs:   0,
    timerOwner:  'ocrt-tick',

    workerProgressMessages: [
      'Starting OCR…',
      'Uploading document to server…',
      'Running text recognition…',
      'Processing pages…',
      'Rebuilding searchable PDF…',
      'Finalising OCR output…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Running OCR…';
    },
    buildProgressSubtitle: function (files, opts) {
      var mode = (opts && opts.ocrMode) ? String(opts.ocrMode) : 'standard';
      return 'Mode: ' + mode + ' — extracting text…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:    files[0] && files[0].name,
        size:    files[0] && files[0].size,
        ocrMode: (opts && opts.ocrMode) || 'standard',
        lang:    (opts && opts.lang)    || 'eng',
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      return {
        inputBytes:  files[0] && files[0].size,
        outputBytes: blob.size,
        ocrMode:     (opts && opts.ocrMode) || 'standard',
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-ocr.pdf';
    },
  });
}());

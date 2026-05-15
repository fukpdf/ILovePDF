// OCR Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   ocr() in browser-tools.js uploads the PDF to the server for OCR processing
//   (server-side text extraction + searchable PDF rebuild). pdf-worker.js does
//   NOT have an OPS.ocr entry. The factory wraps the server upload+response cycle
//   inside a RuntimeScheduler slot, adding: cancellation, telemetry, memory guards,
//   progress reporting, and retry-safe execution.
//
// Feature flag: window.RUNTIME_OCR_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Timeout: 180s — OCR is CPU-intensive on the server; large multi-page scanned
//   PDFs can take 60–90 seconds. The scheduler-only adapter's token propagates
//   this timeout; the origProcess fetch call is bounded by the token's TTL.
//
// Memory: 3× estimate — client holds input file + upload buffer + response Blob.
//   Actual server-side memory is not tracked here.
//
// [FUTURE: StreamEngine] Streamed upload (ReadableStream) would replace the full
//   file.arrayBuffer() pre-read, allowing upload to begin before full read.
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
    adapterMode: 'scheduler-only',
    timeoutMs:   180000,   // 3 min — server OCR on large scanned PDFs
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

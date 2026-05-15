// Translate Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'scheduler-only'
//   translate() in browser-tools.js uses the MyMemory public API (server-side
//   translation via the /api/translate proxy or direct chunked API calls).
//   pdf-worker.js does NOT have an OPS.translate entry. The factory wraps the
//   translation pipeline inside a RuntimeScheduler slot, adding: cancellation,
//   telemetry, memory guards, progress reporting, and retry-safe execution.
//
// Feature flag: window.RUNTIME_TRANSLATE_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// Timeout: 180s — translation is text-heavy; large documents with many chunks
//   can take 90–120 seconds across all API round-trips.
//
// Memory: 2× estimate — client holds input file + extracted text + rebuilt PDF.
//   Translation chunks are processed sequentially, so peak is modest.
//
// [FUTURE: StreamEngine] Streamed text extraction + incremental translation
//   would pipeline chunk-by-chunk without holding the full text in memory.
// [FUTURE: IndexedDB] Cache translated segments by source text hash to allow
//   partial resume on network interruption.
// [FUTURE: AIOrchestrator] Route to local LLM (LocalAIRuntime) when available
//   instead of the MyMemory API, for offline translation capability.
//
// Exposed as: window.TranslateRuntime
(function () {
  'use strict';

  if (window.TranslateRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[TRRT] PdfWorkerRuntimeFactory not loaded — TranslateRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'translate',
    namespace:   'TranslateRuntime',
    flagName:    'RUNTIME_TRANSLATE_ENABLED',
    LOG:         '[TRRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode: 'scheduler-only',
    timeoutMs:   180000,   // 3 min — chunked translation across many API calls
    timerOwner:  'trrt-tick',

    workerProgressMessages: [
      'Starting translation…',
      'Extracting text from PDF…',
      'Splitting into translation chunks…',
      'Translating content…',
      'Rebuilding translated PDF…',
      'Finalising document…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Translating PDF…';
    },
    buildProgressSubtitle: function (files, opts) {
      var from = (opts && opts.fromLang) || 'auto';
      var to   = (opts && opts.toLang)   || 'en';
      return from + ' → ' + to + '…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:     files[0] && files[0].name,
        size:     files[0] && files[0].size,
        fromLang: (opts && opts.fromLang) || 'auto',
        toLang:   (opts && opts.toLang)   || 'en',
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      return {
        inputBytes:  files[0] && files[0].size,
        outputBytes: blob.size,
        fromLang:    (opts && opts.fromLang) || 'auto',
        toLang:      (opts && opts.toLang)   || 'en',
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files, opts) {
      var base = (files[0] && files[0].name) || 'document.pdf';
      var to   = (opts && opts.toLang) ? '-' + opts.toLang : '';
      var stem = base.replace(/\.pdf$/i, '') + to;
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(stem + '.pdf', '.pdf')
        : 'ILovePDF-translated' + to + '.pdf';
    },
  });
}());

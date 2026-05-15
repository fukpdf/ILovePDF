// Watermark Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   watermark IS in WORKER_TOOLS and pdf-worker.js OPS table (OPS.watermark).
//   Dispatches to pdf-worker.js via RuntimeWorkers.dispatch() (Phase 2 orchestration)
//   with WorkerPool.run() as fallback, matching the RotateWorkerAdapter pattern.
//
// Feature flag: window.RUNTIME_WATERMARK_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// DedupeKey: includes file identity + text + opacity + position, so two
//   different watermark configs for the same file are treated as distinct.
//   The text is capped at 20 chars to keep the key readable in telemetry.
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() in _workerDispatch with
//   OPFS byte-range reader so large PDFs don't spike the JS heap.
//
// [FUTURE: OPFSRuntime] Write watermarked output to OPFS before Blob creation.
//
// Exposed as: window.WatermarkRuntime
(function () {
  'use strict';

  if (window.WatermarkRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[WRT] PdfWorkerRuntimeFactory not loaded — WatermarkRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'watermark',
    namespace:   'WatermarkRuntime',
    flagName:    'RUNTIME_WATERMARK_ENABLED',
    LOG:         '[WRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'wrt-tick',

    // DedupeKey: file identity + watermark config options.
    // Text capped at 20 chars in key — full text is in opts passed to worker.
    buildDedupeKey: function (files, opts) {
      var text    = String((opts && opts.text)     || 'WATERMARK').slice(0, 20);
      var opacity = String((opts && opts.opacity)  || '0.3');
      var pos     = String((opts && opts.position) || 'center');
      return 'watermark:' + files[0].name + ':' + files[0].size + ':' + text + ':' + opacity + ':' + pos;
    },

    workerProgressMessages: [
      'Applying watermark…',
      'Stamping pages…',
      'Processing text overlay…',
      'Finalising document…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Adding watermark…';
    },
    buildProgressSubtitle: function (files, opts) {
      var text = String((opts && opts.text) || 'WATERMARK').slice(0, 40);
      var pos  = (opts && opts.position) || 'center';
      return '"' + text + '" · ' + pos;
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:       files[0] && files[0].name,
        size:       files[0] && files[0].size,
        textLength: ((opts && opts.text) || '').length,
        opacity:    (opts && opts.opacity)  || '0.3',
        position:   (opts && opts.position) || 'center',
      };
    },
    buildSuccessAttrs: function (files, blob, opts, ms) {
      return {
        textLength:  ((opts && opts.text) || '').length,
        opacity:     (opts && opts.opacity)  || '0.3',
        position:    (opts && opts.position) || 'center',
        inputBytes:  files[0] && files[0].size,
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-watermarked.pdf';
    },
  });
}());

// Redact Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   redact has OPS.redact in pdf-worker.js. Draws opaque black rectangles at
//   percentage-based coordinates on target pages. Pure pdf-lib — no canvas.
//
// Feature flag: window.RUNTIME_REDACT_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// DedupeKey: file identity + all redaction coordinates and page target.
//   Different redaction rectangles on the same file are distinct operations.
//
// Memory multiplier: 2× (input + doc + output).
//   Image-heavy PDFs may hold larger in-memory representation.
//
// [FUTURE: StreamEngine] Replace file.arrayBuffer() with OPFS byte-range reader.
// [FUTURE: OPFSRuntime] Write redacted output to OPFS before Blob creation.
//
// Exposed as: window.RedactRuntime
(function () {
  'use strict';

  if (window.RedactRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[RDRT] PdfWorkerRuntimeFactory not loaded — RedactRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'redact',
    namespace:   'RedactRuntime',
    flagName:    'RUNTIME_REDACT_ENABLED',
    LOG:         '[RDRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     90000,
    workerTimeout: 90000,
    timerOwner:    'rdrt-tick',

    buildDedupeKey: function (files, opts) {
      var x  = String((opts && opts.x)      || '10');
      var y  = String((opts && opts.y)      || '40');
      var w  = String((opts && opts.width)  || '30');
      var h  = String((opts && opts.height) || '10');
      var pg = String((opts && opts.pages)  || 'all');
      return 'redact:' + files[0].name + ':' + files[0].size + ':' + x + ':' + y + ':' + w + ':' + h + ':' + pg;
    },

    workerProgressMessages: [
      'Redacting PDF…',
      'Locating redaction areas…',
      'Applying black boxes…',
      'Burning redactions into document…',
      'Finalising redacted PDF…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Redacting PDF…';
    },
    buildProgressSubtitle: function (files, opts) {
      var pages = (opts && opts.pages) ? String(opts.pages) : 'all';
      return pages === 'all' ? 'Redacting all pages…' : 'Redacting pages: ' + pages;
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      return {
        name:   files[0] && files[0].name,
        size:   files[0] && files[0].size,
        x:      (opts && opts.x)      || '10',
        y:      (opts && opts.y)      || '40',
        width:  (opts && opts.width)  || '30',
        height: (opts && opts.height) || '10',
        pages:  (opts && opts.pages)  || 'all',
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      return {
        inputBytes: files[0] && files[0].size,
        pages:      (opts && opts.pages) || 'all',
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-redacted.pdf';
    },
  });
}());

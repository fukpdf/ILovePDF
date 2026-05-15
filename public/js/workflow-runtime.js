// Workflow Runtime v1.0 — Phase 3 Bulk Migration
// Factory-generated via PdfWorkerRuntimeFactory.createPdfToolRuntime().
//
// Adapter mode: 'worker'
//   workflow has OPS.workflow in pdf-worker.js. Chains up to 3 PDF operations
//   (compress, rotate-90, rotate-180, watermark, page-numbers, sign) on a single
//   file. Each step reads the output of the prior step — pure pdf-lib chain.
//
// Feature flag: window.RUNTIME_WORKFLOW_ENABLED = true (default)
//   Set to false in DevTools to force legacy path.
//
// DedupeKey: file identity + all 3 step identifiers.
//   Different step combinations on the same file are distinct operations.
//
// Memory multiplier: 4× — chained operations hold the current buffer + doc +
//   output for each step. Each step creates a new ArrayBuffer before releasing
//   the prior one, so peak usage is ~2× per step. With 3 steps: max ~4×.
//
// Timeout: 180s — worst case: 3 slow steps on a large PDF.
//
// [FUTURE: StreamEngine] Each step's output could write to OPFS before the
//   next step reads it, reducing JS heap pressure in multi-step chains.
// [FUTURE: IndexedDB] Persist intermediate step results to IDB for crash recovery.
//
// Exposed as: window.WorkflowRuntime
(function () {
  'use strict';

  if (window.WorkflowRuntime) return;

  if (!window.PdfWorkerRuntimeFactory) {
    console.warn('[WFRT] PdfWorkerRuntimeFactory not loaded — WorkflowRuntime skipped');
    return;
  }

  window.PdfWorkerRuntimeFactory.createPdfToolRuntime({
    toolId:      'workflow',
    namespace:   'WorkflowRuntime',
    flagName:    'RUNTIME_WORKFLOW_ENABLED',
    LOG:         '[WFRT]',

    // ── Adapter ─────────────────────────────────────────────────────────────
    adapterMode:   'worker',
    timeoutMs:     180000,   // 3 min — 3 chained steps on large PDFs
    workerTimeout: 180000,
    timerOwner:    'wfrt-tick',

    buildDedupeKey: function (files, opts) {
      var s1 = String((opts && opts.step1) || '');
      var s2 = String((opts && opts.step2) || '');
      var s3 = String((opts && opts.step3) || '');
      return 'workflow:' + files[0].name + ':' + files[0].size + ':' + s1 + ':' + s2 + ':' + s3;
    },

    workerProgressMessages: [
      'Running workflow…',
      'Applying step 1…',
      'Applying step 2…',
      'Applying step 3…',
      'Finalising output…',
    ],

    // ── Progress UI ──────────────────────────────────────────────────────────
    buildProgressTitle: function () {
      return 'Running workflow…';
    },
    buildProgressSubtitle: function (files, opts) {
      var steps = [opts && opts.step1, opts && opts.step2, opts && opts.step3]
        .filter(Boolean)
        .join(' → ');
      return steps || 'Processing steps…';
    },

    // ── Telemetry ─────────────────────────────────────────────────────────────
    buildSpanAttrs: function (files, opts) {
      var steps = [opts && opts.step1, opts && opts.step2, opts && opts.step3].filter(Boolean);
      return {
        name:      files[0] && files[0].name,
        size:      files[0] && files[0].size,
        stepCount: steps.length,
        steps:     steps.join(','),
      };
    },
    buildSuccessAttrs: function (files, blob, opts) {
      var steps = [opts && opts.step1, opts && opts.step2, opts && opts.step3].filter(Boolean);
      return {
        inputBytes: files[0] && files[0].size,
        stepCount:  steps.length,
        steps:      steps.join(','),
      };
    },

    // ── Filename ──────────────────────────────────────────────────────────────
    buildFilename: function (files) {
      return window.BrowserTools && window.BrowserTools.brandedFilename
        ? window.BrowserTools.brandedFilename(files[0].name, '.pdf')
        : 'ILovePDF-workflow.pdf';
    },
  });
}());

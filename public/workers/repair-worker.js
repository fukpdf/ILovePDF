// repair-worker.js v1.0 — Dedicated terminate-after-job PDF repair worker
// Phase 2C: Isolated replacement for runPdfWorker('repair') via shared WorkerPool.
// Spawned per-job by repair-pdf-app.js. Terminated after each job.
//
// PROBLEM SOLVED:
//   Advanced Engine's repair processor calls runPdfWorker('repair') up to TWICE
//   (two passes). Each call occupies a shared WorkerPool slot. A single timeout
//   can leak up to 2 permanent "running" slots — the WorkerPool reaches exhaustion
//   after just 2-3 timeout events. This worker bypasses the pool entirely.
//
// Protocol:
//   IN:  { op: 'repair', buffer: ArrayBuffer, opts: { repairDepth: 'fast'|'standard'|'maximum' }, jobId }
//   OUT: { buffer: ArrayBuffer, pages: number, jobId }
//   ERR: { __error: string }
//
// deps: pdf-lib@1.17.1 (CDN)

'use strict';
importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

var PDFDocument = self.PDFLib.PDFDocument;

self.onmessage = async function (e) {
  var data   = e.data || {};
  var op     = data.op;
  var buffer = data.buffer;
  var opts   = data.opts  || {};
  var jobId  = data.jobId || '';
  var depth  = opts.repairDepth || 'standard';

  if (op !== 'repair') {
    self.postMessage({ __error: 'repair-worker: unknown op: ' + op });
    return;
  }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 10) {
    self.postMessage({ __error: 'repair-worker: buffer must be a non-empty ArrayBuffer' });
    return;
  }

  // ── Step 1: Try to load with increasingly lenient options ─────────────────
  var doc = null;
  var strategies = [
    { ignoreEncryption: true, throwOnInvalidObject: false },
    { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false },
  ];

  for (var si = 0; si < strategies.length; si++) {
    try {
      doc = await PDFDocument.load(buffer, strategies[si]);
      if (doc && doc.getPageCount() > 0) break;
      doc = null;
    } catch (_) { doc = null; }
  }

  if (!doc) {
    self.postMessage({
      __error: 'This PDF is too severely damaged to repair. The file structure may be completely corrupted.',
      jobId: jobId,
    });
    return;
  }

  try {
    // ── Fast mode: quick uncompressed save ──────────────────────────────────
    if (depth === 'fast') {
      var fastBytes = await doc.save({ useObjectStreams: false });
      var fastBuf   = (fastBytes.buffer instanceof ArrayBuffer) ? fastBytes.buffer : fastBytes.buffer.slice(0);
      self.postMessage({ buffer: fastBuf, pages: doc.getPageCount(), jobId: jobId }, [fastBuf]);
      return;
    }

    // ── Standard / Deep / Maximum: page-by-page copy ─────────────────────────
    var bestDoc = doc;
    try {
      var freshDoc  = await PDFDocument.create();
      var pageCount = doc.getPageCount();
      for (var pi = 0; pi < pageCount; pi++) {
        try {
          var copied = await freshDoc.copyPagesFrom(doc, [pi]);
          freshDoc.addPage(copied[0]);
        } catch (_) { /* skip unrecoverable page */ }
      }
      if (freshDoc.getPageCount() > 0) bestDoc = freshDoc;
    } catch (_) { /* keep original doc */ }

    // ── Maximum: second rebuild pass ─────────────────────────────────────────
    if (depth === 'maximum' && bestDoc !== doc) {
      try {
        var pass2 = await PDFDocument.create();
        for (var qi = 0; qi < bestDoc.getPageCount(); qi++) {
          try {
            var c2 = await pass2.copyPagesFrom(bestDoc, [qi]);
            pass2.addPage(c2[0]);
          } catch (_) {}
        }
        if (pass2.getPageCount() > 0) bestDoc = pass2;
      } catch (_) {}
    }

    // ── Rebuild metadata ─────────────────────────────────────────────────────
    try {
      bestDoc.setTitle(bestDoc.getTitle() || 'Repaired Document');
      bestDoc.setProducer('ILovePDF Repair');
      bestDoc.setModificationDate(new Date());
    } catch (_) {}

    var outPages = bestDoc.getPageCount();
    if (outPages < 1) {
      self.postMessage({ __error: 'Repair produced an empty document. The PDF may be too severely damaged.', jobId: jobId });
      return;
    }

    var out    = await bestDoc.save({ useObjectStreams: true });
    var outBuf = (out.buffer instanceof ArrayBuffer) ? out.buffer : out.buffer.slice(0);

    self.postMessage({ buffer: outBuf, pages: outPages, jobId: jobId }, [outBuf]);
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: jobId });
  }
};

// compress-worker.js v1.0 — Dedicated terminate-after-job PDF compression worker
// Phase 2C: Isolated replacement for runPdfWorker('compress') via shared WorkerPool.
// Spawned per-job by compress-pdf-app.js. Terminated after each job.
//
// PROBLEM SOLVED:
//   Advanced Engine's compress processor calls runPdfWorker('compress') which
//   occupies a shared WorkerPool slot. When withTimeout() fires and abandons the
//   inner proc() promise, the slot is permanently marked as "running" — the next
//   compress job cannot get a slot and hangs or silently fails.
//
//   This worker is spawned directly (new Worker('/workers/compress-worker.js'))
//   by compress-pdf-app.js — NO WorkerPool involvement — and terminated after
//   the response is received.
//
// Protocol:
//   IN:  { op: 'compress', buffer: ArrayBuffer, opts: {}, jobId: string }
//   OUT: { buffer: ArrayBuffer, originalSize: number, savedPct: number, jobId }
//   ERR: { __error: string }
//
// deps: pdf-lib@1.17.1 (CDN)

'use strict';
importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

var PDFDocument = self.PDFLib.PDFDocument;

self.onmessage = async function (e) {
  var data    = e.data || {};
  var op      = data.op;
  var buffer  = data.buffer;
  var opts    = data.opts    || {};
  var jobId   = data.jobId   || '';

  if (op !== 'compress') {
    self.postMessage({ __error: 'compress-worker: unknown op: ' + op });
    return;
  }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) {
    self.postMessage({ __error: 'compress-worker: buffer must be a non-empty ArrayBuffer' });
    return;
  }

  var originalSize = buffer.byteLength;

  try {
    var doc = await PDFDocument.load(buffer, {
      ignoreEncryption:    true,
      throwOnInvalidObject: false,
      updateMetadata:      false,
    });

    // Strip metadata (small savings but universal)
    try {
      doc.setTitle('');
      doc.setAuthor('');
      doc.setSubject('');
      doc.setKeywords([]);
      doc.setProducer('ILovePDF');
      doc.setCreator('ILovePDF');
    } catch (_) {}

    var out = await doc.save({
      useObjectStreams: true,
      addDefaultPage:  false,
      objectsPerTick:  200,
    });

    // Transfer the raw ArrayBuffer (out may be Uint8Array whose .buffer is a
    // detached SharedArrayBuffer on some runtimes — slice to own it)
    var outBuf = (out.buffer instanceof ArrayBuffer) ? out.buffer : out.buffer.slice(0);

    var savedPct = outBuf.byteLength < originalSize
      ? Math.round((1 - outBuf.byteLength / originalSize) * 100)
      : 0;

    // Always return something valid; caller decides whether to use it
    self.postMessage(
      { buffer: outBuf, originalSize: originalSize, savedPct: savedPct, jobId: jobId },
      [outBuf]
    );
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: jobId });
  }
};

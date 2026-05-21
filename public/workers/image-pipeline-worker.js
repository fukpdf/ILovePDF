// image-pipeline-worker.js v1.0 — Dedicated terminate-after-job image→PDF worker
// Phase 2C: Isolated replacement for browser-tools.js imagesToPdf() path.
//           Used by image-pdf-app.js for the 'jpg-to-pdf' tool.
//           Terminates after each job — never persists between jobs.
//
// PROBLEM SOLVED:
//   The jpg-to-pdf processor throws ERR.ORIG → browser-tools.js imagesToPdf().
//   On withTimeout() abandonment, any in-flight pdf-lib WASM state may be left
//   inconsistent, and canvases created for EXIF correction are never freed.
//   This worker runs pdf-lib in an isolated context that terminates after the job.
//
// Protocol:
//   IN:  { op: 'images-to-pdf', images: [{ data: ArrayBuffer, mime: string, name: string }],
//          jobId: string }
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
  var images = data.images || [];
  var jobId  = data.jobId  || '';

  if (op !== 'images-to-pdf') {
    self.postMessage({ __error: 'image-pipeline-worker: unknown op: ' + op });
    return;
  }
  if (!images.length) {
    self.postMessage({ __error: 'image-pipeline-worker: no images provided' });
    return;
  }

  try {
    var doc      = await PDFDocument.create();
    var embedded = 0;

    for (var ii = 0; ii < images.length; ii++) {
      var img     = images[ii];
      var bytes   = new Uint8Array(img.data);
      var isPng   = img.mime === 'image/png' ||
                    (img.name && /\.png$/i.test(img.name));
      var pdfImg  = null;

      // Try primary format, then fallback to the other
      try {
        pdfImg = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      } catch (_) {
        try {
          pdfImg = isPng ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        } catch (e2) {
          // Skip unembeddable image rather than aborting the whole job
          console.warn('image-pipeline-worker: skip unembeddable image', img.name, e2.message);
          continue;
        }
      }

      if (pdfImg) {
        var page = doc.addPage([pdfImg.width, pdfImg.height]);
        page.drawImage(pdfImg, { x: 0, y: 0, width: pdfImg.width, height: pdfImg.height });
        embedded++;
      }
    }

    if (embedded === 0) {
      self.postMessage({ __error: 'None of the provided images could be embedded into the PDF.', jobId: jobId });
      return;
    }

    var out    = await doc.save();
    var outBuf = (out.buffer instanceof ArrayBuffer) ? out.buffer : out.buffer.slice(0);

    self.postMessage({ buffer: outBuf, pages: embedded, jobId: jobId }, [outBuf]);
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: jobId });
  }
};

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();

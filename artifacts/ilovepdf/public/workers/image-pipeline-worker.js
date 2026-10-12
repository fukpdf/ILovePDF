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
  var data = e.data || {};
  var op = data.op;
  try {
    if (op === 'init') {
      self.__imagePdfDoc = await PDFDocument.create();
      self.__imagePdfEmbedded = 0;
      self.postMessage({ type: 'ready', jobId: data.jobId || '' });
      return;
    }

    if (op === 'add-image') {
      if (!self.__imagePdfDoc) throw new Error('image-pipeline-worker: pipeline not initialized');
      var bytes = new Uint8Array(data.data);
      var isPng = data.mime === 'image/png' || (data.name && /\.png$/i.test(data.name));
      var pdfImg = null;

      try {
        pdfImg = isPng ? await self.__imagePdfDoc.embedPng(bytes) : await self.__imagePdfDoc.embedJpg(bytes);
      } catch (_) {
        try {
          pdfImg = isPng ? await self.__imagePdfDoc.embedJpg(bytes) : await self.__imagePdfDoc.embedPng(bytes);
        } catch (e2) {
          console.warn('image-pipeline-worker: skip unembeddable image', data.name, e2.message);
          self.postMessage({ type: 'image-ack', index: data.index, skipped: true, jobId: data.jobId || '' });
          return;
        }
      }

      var page = self.__imagePdfDoc.addPage([pdfImg.width, pdfImg.height]);
      page.drawImage(pdfImg, { x: 0, y: 0, width: pdfImg.width, height: pdfImg.height });
      self.__imagePdfEmbedded++;
      // The transferred ArrayBuffer is detached on the main thread and the
      // worker releases its view before acknowledging the next image.
      bytes = null;
      pdfImg = null;
      self.postMessage({ type: 'image-ack', index: data.index, jobId: data.jobId || '' });
      return;
    }

    if (op === 'finalize') {
      if (!self.__imagePdfDoc) throw new Error('image-pipeline-worker: pipeline not initialized');
      if (!self.__imagePdfEmbedded) throw new Error('None of the provided images could be embedded into the PDF.');
      var out = await self.__imagePdfDoc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
      var outBuf = (out.buffer instanceof ArrayBuffer) ? out.buffer : out.buffer.slice(0);
      self.__imagePdfDoc = null;
      self.__imagePdfEmbedded = 0;
      self.postMessage({ type: 'done', buffer: outBuf, pages: data.pages || 0, jobId: data.jobId || '' }, [outBuf]);
      return;
    }

    if (op === 'images-to-pdf') {
      // Backward-compatible one-message protocol for older callers.
      var images = data.images || [];
      if (!images.length) throw new Error('image-pipeline-worker: no images provided');
      self.__imagePdfDoc = await PDFDocument.create();
      self.__imagePdfEmbedded = 0;
      for (var ii = 0; ii < images.length; ii++) {
        var img = images[ii];
        var bytes2 = new Uint8Array(img.data);
        var isPng2 = img.mime === 'image/png' || (img.name && /\.png$/i.test(img.name));
        var pdfImg2 = null;
        try { pdfImg2 = isPng2 ? await self.__imagePdfDoc.embedPng(bytes2) : await self.__imagePdfDoc.embedJpg(bytes2); }
        catch (_) {
          try { pdfImg2 = isPng2 ? await self.__imagePdfDoc.embedJpg(bytes2) : await self.__imagePdfDoc.embedPng(bytes2); }
          catch (e2) { continue; }
        }
        if (pdfImg2) {
          var page2 = self.__imagePdfDoc.addPage([pdfImg2.width, pdfImg2.height]);
          page2.drawImage(pdfImg2, { x: 0, y: 0, width: pdfImg2.width, height: pdfImg2.height });
          self.__imagePdfEmbedded++;
        }
      }
      if (!self.__imagePdfEmbedded) throw new Error('None of the provided images could be embedded into the PDF.');
      var out2 = await self.__imagePdfDoc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
      var outBuf2 = (out2.buffer instanceof ArrayBuffer) ? out2.buffer : out2.buffer.slice(0);
      self.__imagePdfDoc = null;
      self.__imagePdfEmbedded = 0;
      self.postMessage({ type: 'done', buffer: outBuf2, pages: self.__imagePdfEmbedded || 0, jobId: data.jobId || '' }, [outBuf2]);
      return;
    }

    throw new Error('image-pipeline-worker: unknown op: ' + op);
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: data.jobId || '' });
  }
};

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();

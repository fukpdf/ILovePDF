// Image/PDF worker boundary — Phase 2/3.
// JPEG/PNG -> PDF. Incremental protocol keeps only the currently transferred
// source image in the worker boundary; the PDF document stays resident.
importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

let doc = null;
let count = 0;

self.onmessage = async function (event) {
  const data = event.data || {};
  try {
    if (data.type === 'images-to-pdf-start') {
      if (!Number.isInteger(data.count) || data.count < 1) throw new Error('No images supplied');
      const PDFDocument = self.PDFLib && self.PDFLib.PDFDocument;
      if (!PDFDocument) throw new Error('PDF engine unavailable');
      doc = await PDFDocument.create();
      count = data.count;
      self.postMessage({ type: 'images-to-pdf-ready', count });
      return;
    }
    if (data.type === 'images-to-pdf-item') {
      if (!doc || !(data.buffer instanceof ArrayBuffer)) throw new Error('Invalid image stream state');
      const bytes = new Uint8Array(data.buffer);
      const mime = String(data.mime || '').toLowerCase();
      const image = /png/.test(mime) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const page = doc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      // Drop local byte references before acknowledging the next source file.
      self.postMessage({ type: 'images-to-pdf-ack', index: data.index });
      return;
    }
    if (data.type === 'images-to-pdf-finish') {
      if (!doc) throw new Error('Image PDF stream was not started');
      const output = await doc.save({ useObjectStreams: true });
      const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
      doc = null; count = 0;
      self.postMessage({ type: 'images-to-pdf-done', buffer }, [buffer]);
    }
  } catch (error) {
    doc = null; count = 0;
    self.postMessage({ type: 'images-to-pdf-error', message: error && error.message ? error.message : String(error) });
  }
};
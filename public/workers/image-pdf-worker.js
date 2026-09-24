// Image/PDF worker boundary — Phase 2.
// JPEG/PNG -> PDF only. Inputs and output use transferable ArrayBuffers.
importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

self.onmessage = async function (event) {
  const data = event.data || {};
  if (data.type !== 'images-to-pdf') return;
  try {
    if (!Array.isArray(data.images) || data.images.length === 0) throw new Error('No images supplied');
    const PDFDocument = self.PDFLib && self.PDFLib.PDFDocument;
    if (!PDFDocument) throw new Error('PDF engine unavailable');
    const doc = await PDFDocument.create();
    for (const item of data.images) {
      if (!item || !(item.buffer instanceof ArrayBuffer)) throw new Error('Invalid image buffer');
      const bytes = new Uint8Array(item.buffer);
      const mime = String(item.type || '').toLowerCase();
      const image = /png/.test(mime) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const page = doc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }
    const output = await doc.save({ useObjectStreams: true });
    const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    self.postMessage({ type: 'images-to-pdf-done', buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ type: 'images-to-pdf-error', message: error && error.message ? error.message : String(error) });
  }
};

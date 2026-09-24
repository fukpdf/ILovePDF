// Image/PDF browser worker boundary — Phase 2.
// Intentionally capability-scoped: JPEG/PNG -> PDF only. PDF rendering stays
// on the dedicated PDF.js rendering path until a worker-compatible renderer
// is bundled and fixture-tested.
importScripts('/workers/pdf-lib-worker.js');

self.onmessage = async function (e) {
  const d = e.data || {};
  if (d.type !== 'images-to-pdf') return;
  try {
    if (!Array.isArray(d.images) || !d.images.length) throw new Error('No images supplied');
    if (!self.PDFLib) throw new Error('PDF engine unavailable');
    const { PDFDocument } = self.PDFLib;
    const doc = await PDFDocument.create();
    for (const item of d.images) {
      if (!item || !item.buffer) throw new Error('Invalid image buffer');
      const bytes = new Uint8Array(item.buffer);
      const type = String(item.type || '').toLowerCase();
      const image = /png/.test(type) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const page = doc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }
    const out = await doc.save({ useObjectStreams: true });
    const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    self.postMessage({ type: 'images-to-pdf-done', buffer }, [buffer]);
  } catch (err) {
    self.postMessage({ type: 'images-to-pdf-error', message: err && err.message || String(err) });
  }
};

// PDF -> image worker boundary. Requires OffscreenCanvas-capable browsers.
// Rendering stays entirely in the worker; no DOM canvas is used.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');

self.onmessage = async function (event) {
  const data = event.data || {};
  if (data.type !== 'pdf-to-jpg') return;
  try {
    if (!(data.buffer instanceof ArrayBuffer)) throw new Error('Invalid PDF buffer');
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas is not supported');
    if (!self.pdfjsLib) throw new Error('PDF renderer unavailable');

    const loadingTask = self.pdfjsLib.getDocument({ data: new Uint8Array(data.buffer), disableWorker: true });
    const pdf = await loadingTask.promise;
    const quality = Math.min(1, Math.max(0.5, Number(data.quality) || 0.92));
    const scale = Math.min(4, Math.max(0.5, Number(data.scale) || 1.5));
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      pages.push({ page: pageNumber, width, height, buffer: await blob.arrayBuffer() });
      canvas.width = 1;
      canvas.height = 1;
    }

    self.postMessage({ type: 'pdf-to-jpg-done', pages }, pages.map(p => p.buffer));
    await pdf.destroy();
  } catch (error) {
    self.postMessage({ type: 'pdf-to-jpg-error', message: error && error.message ? error.message : String(error) });
  }
};

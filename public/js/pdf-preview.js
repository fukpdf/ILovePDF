// PDF.js loader + high-resolution page thumbnail renderer.
// Used by page-organizer.js to render crisp, readable previews.
//
// Public API:
//   window.PdfPreview.loadDocument(file) -> Promise<PdfDoc>
//        PdfDoc = { pdf, pageCount, file, fileBytes }
//   window.PdfPreview.renderPage(pdfDoc, pageNumber, targetWidthCss, rotation)
//        -> Promise<HTMLCanvasElement>
//   window.PdfPreview.unloadDocument(pdfDoc) -> void
(function () {
  const PDFJS_VERSION = '4.10.38';
  const PDFJS_SRC     = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
  const PDFJS_WORKER  = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

  let pdfjsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = import(PDFJS_SRC).then((mod) => {
      const lib = mod.GlobalWorkerOptions ? mod : (window.pdfjsLib || mod.default);
      const target = lib.GlobalWorkerOptions ? lib : mod;
      target.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = target;
      return target;
    });
    return pdfjsPromise;
  }

  async function loadDocument(file) {
    const pdfjsLib = await loadPdfJs();
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    // Pass a copy to PDF.js — it consumes the buffer, but we need the bytes
    // again for downstream pdf-lib assembly.
    const task = pdfjsLib.getDocument({
      data: fileBytes.slice(),
      disableAutoFetch: true,
      disableStream: true,
    });
    const pdf = await task.promise;
    return { pdf, pageCount: pdf.numPages, file, fileBytes };
  }

  function unloadDocument(doc) {
    try { doc?.pdf?.destroy?.(); } catch (_) {}
  }

  // Render `pageNumber` (1-indexed) into a canvas sized so the *css* width is
  // approximately `targetWidthCss` px. Uses devicePixelRatio for crispness.
  // `rotation` adds to the PDF's intrinsic rotation (0/90/180/270).
  async function renderPage(pdfDoc, pageNumber, targetWidthCss = 200, rotation = 0) {
    const page = await pdfDoc.pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1, rotation });
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cssScale = targetWidthCss / baseViewport.width;
    const viewport = page.getViewport({ scale: cssScale * dpr, rotation });

    const canvas = document.createElement('canvas');
    canvas.width  = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width  = (viewport.width  / dpr) + 'px';
    canvas.style.height = (viewport.height / dpr) + 'px';
    canvas.style.display = 'block';

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // White background so transparent PDFs don't render as black on dark UA.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport, intent: 'display' }).promise;
    return canvas;
  }

  window.PdfPreview = { loadDocument, renderPage, unloadDocument, loadPdfJs };
})();

// PDF.js loader + high-resolution page thumbnail renderer.
// Used by page-organizer.js and tool-page.js to render crisp, readable previews.
//
// Public API:
//   window.PdfPreview.loadDocument(file) -> Promise<PdfDoc>
//        PdfDoc = { pdf, pageCount, file, fileBytes }
//   window.PdfPreview.renderPage(pdfDoc, pageNumber, targetWidthCss, rotation)
//        -> Promise<HTMLCanvasElement>   (always resolves — returns placeholder on failure)
//   window.PdfPreview.unloadDocument(pdfDoc) -> void
//
// v2.0 — unified pdfjs loader, render semaphore, canvas safety guards, retry logic
(function () {
  'use strict';

  var PDFJS_VERSION = '4.10.38';
  var PDFJS_SRC     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.min.mjs';
  var PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.worker.min.mjs';

  // ── Shared global loader promise ──────────────────────────────────────────
  // Both pdf-preview.js and live-preview.js share this promise so only ONE
  // import() ever fires, regardless of call order or concurrency.
  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) {
      return Promise.resolve(window.pdfjsLib);
    }
    if (window.__pdfjsLibPromise) return window.__pdfjsLibPromise;
    window.__pdfjsLibPromise = import(PDFJS_SRC).then(function (mod) {
      var lib = mod.GlobalWorkerOptions ? mod : (mod.default || mod);
      if (!lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      }
      window.pdfjsLib = lib;
      return lib;
    }).catch(function (err) {
      window.__pdfjsLibPromise = null; // allow retry on next call
      throw err;
    });
    return window.__pdfjsLibPromise;
  }

  // ── Render semaphore (max 2 concurrent renders) ───────────────────────────
  var _renderSlots = 0;
  var _renderQueue = [];
  var MAX_CONCURRENT = (window.navigator && /Mobi/i.test(navigator.userAgent)) ? 1 : 2;

  function acquireRenderSlot() {
    if (_renderSlots < MAX_CONCURRENT) {
      _renderSlots++;
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      _renderQueue.push(resolve);
    });
  }

  function releaseRenderSlot() {
    if (_renderQueue.length > 0) {
      var next = _renderQueue.shift();
      next();
    } else {
      _renderSlots = Math.max(0, _renderSlots - 1);
    }
  }

  // ── Make a blank placeholder canvas (shown when render fails) ─────────────
  function makePlaceholder(w, h) {
    var c = document.createElement('canvas');
    c.width  = Math.max(1, Math.floor(w));
    c.height = Math.max(1, Math.floor(h));
    c.style.width   = c.width  + 'px';
    c.style.height  = c.height + 'px';
    c.style.display = 'block';
    try {
      var ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.strokeStyle = '#ccc';
        ctx.strokeRect(1, 1, c.width - 2, c.height - 2);
      }
    } catch (_) {}
    return c;
  }

  // ── Load a PDF file into a pdfDoc object ──────────────────────────────────
  async function loadDocument(file) {
    var pdfjsLib = await loadPdfJs();
    var fileBytes = new Uint8Array(await file.arrayBuffer());
    var task = pdfjsLib.getDocument({
      data: fileBytes.slice(),
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
    });
    var pdf = await task.promise;
    return { pdf: pdf, pageCount: pdf.numPages, file: file, fileBytes: fileBytes };
  }

  function unloadDocument(doc) {
    try { if (doc && doc.pdf && doc.pdf.destroy) doc.pdf.destroy(); } catch (_) {}
  }

  // ── Attempt a single canvas render at the given scale ────────────────────
  async function _tryRender(page, scale, dpr, rotation) {
    var viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
    var w = Math.floor(viewport.width);
    var h = Math.floor(viewport.height);
    if (w < 1 || h < 1 || !isFinite(w) || !isFinite(h)) {
      throw new Error('Invalid viewport dimensions: ' + w + 'x' + h);
    }
    // Hard cap: never allocate a canvas larger than 16 MP (avoids GPU OOM)
    var pixels = w * h;
    if (pixels > 16777216) {
      var ratio = Math.sqrt(16777216 / pixels);
      scale = scale * ratio;
      viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
      w = Math.floor(viewport.width);
      h = Math.floor(viewport.height);
    }
    var canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.style.width   = Math.floor(w / dpr) + 'px';
    canvas.style.height  = Math.floor(h / dpr) + 'px';
    canvas.style.display = 'block';
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not get 2D context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: viewport, intent: 'display' }).promise;
    return canvas;
  }

  // ── Public renderPage — always resolves, returns placeholder on failure ───
  // `targetWidthCss`: desired CSS px width of the output canvas
  // `rotation`:       extra rotation in degrees (0/90/180/270)
  async function renderPage(pdfDoc, pageNumber, targetWidthCss, rotation) {
    targetWidthCss = targetWidthCss || 200;
    rotation = rotation || 0;

    // Mobile cap: max 400px CSS width; desktop: max 700px
    var isMobile = window.navigator && /Mobi/i.test(navigator.userAgent);
    var maxWidth  = isMobile ? 400 : 700;
    if (targetWidthCss > maxWidth) targetWidthCss = maxWidth;

    var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

    await acquireRenderSlot();
    var page = null;
    try {
      page = await pdfDoc.pdf.getPage(pageNumber);
      var baseViewport = page.getViewport({ scale: 1, rotation: rotation });
      if (!baseViewport || baseViewport.width <= 0) throw new Error('Invalid page viewport');
      var scale = targetWidthCss / baseViewport.width;

      // First attempt at full scale
      try {
        var canvas = await _tryRender(page, scale, dpr, rotation);
        return canvas;
      } catch (firstErr) {
        console.warn('[PdfPreview] render attempt 1 failed (pg ' + pageNumber + '):', firstErr.message);
        // Retry at half scale with dpr=1
        try {
          var canvas2 = await _tryRender(page, scale * 0.5, 1, rotation);
          return canvas2;
        } catch (secondErr) {
          console.warn('[PdfPreview] render attempt 2 failed (pg ' + pageNumber + '):', secondErr.message);
          // Return a placeholder so the grid still shows something
          var ph = makePlaceholder(targetWidthCss, Math.floor(targetWidthCss * 1.414));
          return ph;
        }
      }
    } catch (outerErr) {
      console.warn('[PdfPreview] getPage failed (pg ' + pageNumber + '):', outerErr.message || outerErr);
      return makePlaceholder(targetWidthCss, Math.floor(targetWidthCss * 1.414));
    } finally {
      if (page && page.cleanup) { try { page.cleanup(); } catch (_) {} }
      releaseRenderSlot();
    }
  }

  window.PdfPreview = {
    loadDocument:   loadDocument,
    renderPage:     renderPage,
    unloadDocument: unloadDocument,
    loadPdfJs:      loadPdfJs,
  };
})();

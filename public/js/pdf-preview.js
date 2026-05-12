// PDF.js loader + high-resolution page thumbnail renderer.
// Stable Production Build — v2.0
//
// Public API:
//   window.PdfPreview.loadDocument(file) -> Promise<PdfDoc>
//   window.PdfPreview.renderPage(pdfDoc, pageNumber, targetWidthCss, rotation)
//        -> Promise<HTMLCanvasElement>   (returns error canvas on failure, never throws)
//   window.PdfPreview.unloadDocument(pdfDoc) -> void
//   window.PdfPreview.loadPdfJs() -> Promise<pdfjsLib>
(function () {
  'use strict';

  var PDFJS_VERSION = '4.10.38';
  var PDFJS_SRC    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.worker.min.mjs';

  // ── Shared global PDF.js loader ───────────────────────────────────────────
  // window.__pdfjsLibPromise is shared by ALL loaders (browser-tools, advanced-engine,
  // live-preview, edit-pdf-pro). This guarantees exactly ONE import() call regardless
  // of which file triggers loading first.
  // workerSrc is always enforced to match the library version.
  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) {
      // Library already loaded — correct workerSrc if another script drifted it.
      if (window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WORKER) {
        console.warn('[PdfPreview] workerSrc corrected:',
          window.pdfjsLib.GlobalWorkerOptions.workerSrc, '→', PDFJS_WORKER);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      }
      return Promise.resolve(window.pdfjsLib);
    }
    // Re-use any in-flight import from other modules.
    if (window.__pdfjsLibPromise) return window.__pdfjsLibPromise;

    window.__pdfjsLibPromise = import(PDFJS_SRC).then(function (mod) {
      var lib = mod.GlobalWorkerOptions ? mod : (mod.default || mod);
      if (!lib || !lib.getDocument) {
        throw new Error('PdfPreview: pdfjsLib.getDocument missing after import');
      }
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = lib;
      return lib;
    }).catch(function (err) {
      console.error('[PdfPreview] pdfjs import failed:', err);
      window.__pdfjsLibPromise = null;
      throw err;
    });
    return window.__pdfjsLibPromise;
  }

  // ── Render semaphore ──────────────────────────────────────────────────────
  // Limits concurrent canvas renders to prevent GPU OOM on mobile.
  // Mobile: 1 concurrent. Desktop: 2 concurrent.
  var _renderSlots = 0;
  var _renderQueue = [];
  var MAX_CONCURRENT = /Mobi|Android/i.test(navigator.userAgent) ? 1 : 2;

  function acquireRenderSlot() {
    if (_renderSlots < MAX_CONCURRENT) { _renderSlots++; return Promise.resolve(); }
    return new Promise(function (resolve) { _renderQueue.push(resolve); });
  }

  function releaseRenderSlot() {
    if (_renderQueue.length > 0) { _renderQueue.shift()(); }
    else { _renderSlots = Math.max(0, _renderSlots - 1); }
  }

  // ── Error canvas ──────────────────────────────────────────────────────────
  // Returned instead of throwing — callers always get a renderable element.
  function makeErrorCanvas(w, h, msg) {
    var c = document.createElement('canvas');
    c.width  = Math.max(100, Math.floor(w));
    c.height = Math.max(60,  Math.floor(h));
    c.style.cssText = 'display:block;width:' + c.width + 'px;height:' + c.height + 'px';
    try {
      var ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#fff0f0';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#cc0000';
        ctx.font = '11px monospace';
        ctx.fillText('Render error', 6, 16);
        var words = String(msg || '').split(' ');
        var lineText = '', y = 30;
        for (var i = 0; i < words.length; i++) {
          var test = lineText + (lineText ? ' ' : '') + words[i];
          if (ctx.measureText(test).width > c.width - 12) {
            ctx.fillText(lineText, 6, y); y += 14; lineText = words[i];
          } else { lineText = test; }
        }
        if (lineText) ctx.fillText(lineText, 6, y);
      }
    } catch (_) { /* canvas may be unusably small */ }
    return c;
  }

  // ── Load a PDF file ───────────────────────────────────────────────────────
  async function loadDocument(file) {
    var pdfjsLib;
    try {
      pdfjsLib = await loadPdfJs();
    } catch (err) {
      console.error('[PdfPreview] loadPdfJs failed:', err);
      throw err;
    }

    var fileBytes;
    try {
      fileBytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      console.error('[PdfPreview] file.arrayBuffer() failed:', err);
      throw err;
    }

    var pdf;
    try {
      pdf = await pdfjsLib.getDocument({
        data:             fileBytes.slice(),
        disableAutoFetch: true,
        disableStream:    true,
        isEvalSupported:  false,
        useWorkerFetch:   false,
      }).promise;
    } catch (err) {
      console.error('[PdfPreview] getDocument() failed:', err);
      throw err;
    }

    return { pdf: pdf, pageCount: pdf.numPages, file: file, fileBytes: fileBytes };
  }

  function unloadDocument(doc) {
    try { if (doc && doc.pdf && doc.pdf.destroy) doc.pdf.destroy(); }
    catch (err) { console.error('[PdfPreview] destroy failed:', err); }
  }

  // ── Low-level render attempt ──────────────────────────────────────────────
  async function _tryRender(page, scale, dpr, rotation, pageNumber) {
    var viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
    var w = Math.floor(viewport.width);
    var h = Math.floor(viewport.height);

    if (w < 1 || h < 1 || !isFinite(w) || !isFinite(h)) {
      throw new Error('Invalid viewport dimensions: ' + w + 'x' + h);
    }

    // Hard cap: 4 MP — safe on 2 GB Android RAM.
    var MP_CAP = 4 * 1024 * 1024;
    if (w * h > MP_CAP) {
      var ratio = Math.sqrt(MP_CAP / (w * h));
      scale *= ratio;
      viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
      w = Math.floor(viewport.width);
      h = Math.floor(viewport.height);
    }

    var canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.style.cssText = 'display:block;width:' + Math.floor(w / dpr) + 'px;height:' + Math.floor(h / dpr) + 'px';

    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas.getContext("2d") returned null (GPU limit or oversized canvas)');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    var renderTask = page.render({ canvasContext: ctx, viewport: viewport, intent: 'display' });

    // 10 s safety timeout — guards against hung workers on low-end Android.
    var timeoutHandle;
    var timeoutPromise = new Promise(function (_, reject) {
      timeoutHandle = setTimeout(function () {
        try { if (renderTask.cancel) renderTask.cancel(); } catch (_) {}
        reject(new Error('Render timeout (>10s) for page ' + pageNumber));
      }, 10000);
    });

    try {
      await Promise.race([renderTask.promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    return canvas;
  }

  // ── Public renderPage ─────────────────────────────────────────────────────
  // Returns a rendered canvas, or an error canvas on failure (never throws).
  // DPR is capped at 2: 3× DPR (typical Android) × large canvas → OOM.
  async function renderPage(pdfDoc, pageNumber, targetWidthCss, rotation) {
    targetWidthCss = targetWidthCss || 200;
    rotation       = rotation       || 0;
    var dpr        = Math.min(window.devicePixelRatio || 1, 2);

    // Re-enforce workerSrc before each render (advanced-engine.js may have set wrong version).
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions &&
        window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WORKER) {
      console.warn('[PdfPreview] workerSrc corrected before render');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    }

    await acquireRenderSlot();
    var page = null;
    try {
      page = await pdfDoc.pdf.getPage(pageNumber);

      var baseViewport = page.getViewport({ scale: 1, rotation: rotation });
      if (!baseViewport || baseViewport.width <= 0) {
        throw new Error('Invalid base viewport width: ' + (baseViewport && baseViewport.width));
      }

      // Scale to match requested CSS width.
      var scale = targetWidthCss / baseViewport.width;

      return await _tryRender(page, scale, dpr, rotation, pageNumber);

    } catch (err) {
      console.error('[PdfPreview] renderPage failed (page ' + pageNumber + '):', err);
      return makeErrorCanvas(
        targetWidthCss,
        Math.floor(targetWidthCss * 1.414),
        err && err.message ? err.message : String(err)
      );
    } finally {
      if (page) { try { page.cleanup(); } catch (_) {} }
      releaseRenderSlot();
    }
  }

  window.PdfPreview = {
    loadDocument:   loadDocument,
    renderPage:     renderPage,
    unloadDocument: unloadDocument,
    loadPdfJs:      loadPdfJs,
    PDFJS_VERSION:  PDFJS_VERSION,
    PDFJS_WORKER:   PDFJS_WORKER,
  };
})();

// PDF.js loader + high-resolution page thumbnail renderer.
// DEBUG BUILD — full console tracing, all errors exposed, no silent fallbacks.
//
// Public API:
//   window.PdfPreview.loadDocument(file) -> Promise<PdfDoc>
//   window.PdfPreview.renderPage(pdfDoc, pageNumber, targetWidthCss, rotation)
//        -> Promise<HTMLCanvasElement>   (throws on failure — no silent placeholders)
//   window.PdfPreview.unloadDocument(pdfDoc) -> void
(function () {
  'use strict';

  var PDFJS_VERSION = '4.10.38';
  var PDFJS_SRC     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.min.mjs';
  var PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.worker.min.mjs';

  console.log('[PDF_DEBUG] pdf-preview.js loaded. Target pdfjs version:', PDFJS_VERSION);
  console.log('[PDF_DEBUG] PDFJS_SRC:', PDFJS_SRC);
  console.log('[PDF_DEBUG] PDFJS_WORKER:', PDFJS_WORKER);
  console.log('[PDF_DEBUG] userAgent:', navigator.userAgent);
  console.log('[PDF_DEBUG] devicePixelRatio:', window.devicePixelRatio);
  console.log('[PDF_DEBUG] OffscreenCanvas supported:', typeof OffscreenCanvas !== 'undefined');

  // ── Shared global loader promise ──────────────────────────────────────────
  // IMPORTANT: Always force our workerSrc after loading to prevent other
  // scripts (e.g. advanced-engine.js @ 4.6.82) from leaving a mismatched worker.
  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) {
      // Library already loaded — still force our workerSrc in case another
      // script (advanced-engine.js uses 4.6.82) overwrote it with wrong version.
      if (window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WORKER) {
        console.warn('[PDF_DEBUG] workerSrc was', window.pdfjsLib.GlobalWorkerOptions.workerSrc,
                     '— overriding to', PDFJS_WORKER);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      }
      console.log('[PDF_DEBUG] Using cached pdfjsLib. workerSrc:', window.pdfjsLib.GlobalWorkerOptions.workerSrc);
      return Promise.resolve(window.pdfjsLib);
    }
    if (window.__pdfjsLibPromise) {
      console.log('[PDF_DEBUG] Waiting on existing __pdfjsLibPromise');
      return window.__pdfjsLibPromise;
    }
    console.log('[PDF_DEBUG] Firing dynamic import() for pdfjs', PDFJS_VERSION);
    window.__pdfjsLibPromise = import(PDFJS_SRC).then(function (mod) {
      console.log('[PDF_DEBUG] import() resolved. mod keys:', Object.keys(mod).join(', '));
      var lib = mod.GlobalWorkerOptions ? mod : (mod.default || mod);
      if (!lib || !lib.getDocument) {
        throw new Error('[PDF_DEBUG] pdfjsLib missing getDocument after import. mod=' + JSON.stringify(Object.keys(mod)));
      }
      // Always set our version — never rely on whatever was there before.
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      console.log('[PDF_DEBUG] workerSrc set to:', lib.GlobalWorkerOptions.workerSrc);
      console.log('[PDF_DEBUG] lib.version:', lib.version || 'unknown');
      window.pdfjsLib = lib;
      return lib;
    }).catch(function (err) {
      console.error('[PDF_RENDER_ERROR] import() of pdfjs failed:', err);
      window.__pdfjsLibPromise = null;
      throw err;
    });
    return window.__pdfjsLibPromise;
  }

  // ── Render semaphore (max 1 on mobile, 2 on desktop) ─────────────────────
  var _renderSlots = 0;
  var _renderQueue = [];
  var MAX_CONCURRENT = (window.navigator && /Mobi/i.test(navigator.userAgent)) ? 1 : 2;
  console.log('[PDF_DEBUG] MAX_CONCURRENT renders:', MAX_CONCURRENT);

  function acquireRenderSlot() {
    console.log('[PDF_DEBUG] acquireRenderSlot: slots=' + _renderSlots + '/' + MAX_CONCURRENT + ' queue=' + _renderQueue.length);
    if (_renderSlots < MAX_CONCURRENT) {
      _renderSlots++;
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      _renderQueue.push(resolve);
    });
  }

  function releaseRenderSlot() {
    console.log('[PDF_DEBUG] releaseRenderSlot: queue=' + _renderQueue.length);
    if (_renderQueue.length > 0) {
      var next = _renderQueue.shift();
      next();
    } else {
      _renderSlots = Math.max(0, _renderSlots - 1);
    }
  }

  // ── Make an error canvas (shown when render fails — displays error text) ──
  function makeErrorCanvas(w, h, msg) {
    var c = document.createElement('canvas');
    c.width  = Math.max(100, Math.floor(w));
    c.height = Math.max(60, Math.floor(h));
    c.style.width   = c.width + 'px';
    c.style.height  = c.height + 'px';
    c.style.display = 'block';
    c.style.border  = '2px solid red';
    try {
      var ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#fff0f0';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#cc0000';
        ctx.font = '11px monospace';
        var line = 'RENDER ERROR:';
        ctx.fillText(line, 6, 16);
        // Word-wrap message
        var words = String(msg || 'unknown').split(' ');
        var lineText = '';
        var y = 30;
        for (var i = 0; i < words.length; i++) {
          var test = lineText + (lineText ? ' ' : '') + words[i];
          if (ctx.measureText(test).width > c.width - 12) {
            ctx.fillText(lineText, 6, y);
            y += 14;
            lineText = words[i];
          } else {
            lineText = test;
          }
        }
        if (lineText) ctx.fillText(lineText, 6, y);
      }
    } catch (drawErr) {
      console.error('[PDF_RENDER_ERROR] makeErrorCanvas draw failed:', drawErr);
    }
    return c;
  }

  // ── Load a PDF file into a pdfDoc object ──────────────────────────────────
  async function loadDocument(file) {
    console.log('[PDF_DEBUG] loadDocument() called for:', file.name, 'size:', file.size);
    var pdfjsLib;
    try {
      pdfjsLib = await loadPdfJs();
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] loadPdfJs() failed in loadDocument:', err);
      throw err;
    }

    console.log('[PDF_DEBUG] Reading file arrayBuffer...');
    var fileBytes;
    try {
      fileBytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] file.arrayBuffer() failed:', err);
      throw err;
    }
    console.log('[PDF_DEBUG] fileBytes length:', fileBytes.length);

    console.log('[PDF_DEBUG] Calling pdfjsLib.getDocument()...');
    var task;
    try {
      task = pdfjsLib.getDocument({
        data: fileBytes.slice(),
        disableAutoFetch: true,
        disableStream: true,
        isEvalSupported: false,
        useWorkerFetch: false,
      });
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] getDocument() constructor threw:', err);
      throw err;
    }

    var pdf;
    try {
      pdf = await task.promise;
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] getDocument().promise rejected:', err);
      throw err;
    }

    console.log('[PDF_DEBUG] PDF loaded. numPages:', pdf.numPages);
    return { pdf: pdf, pageCount: pdf.numPages, file: file, fileBytes: fileBytes };
  }

  function unloadDocument(doc) {
    try {
      if (doc && doc.pdf && doc.pdf.destroy) doc.pdf.destroy();
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] unloadDocument destroy failed:', err);
    }
  }

  // ── Attempt a single canvas render ────────────────────────────────────────
  // DEBUG: scale=1, dpr=1 — strips all DPR/scaling complexity to isolate the render path.
  async function _tryRender(page, scale, dpr, rotation, pageNumber) {
    console.log('[PDF_DEBUG] _tryRender pg=' + pageNumber + ' scale=' + scale + ' dpr=' + dpr + ' rotation=' + rotation);

    var viewport;
    try {
      viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] getViewport failed:', err);
      throw err;
    }

    var w = Math.floor(viewport.width);
    var h = Math.floor(viewport.height);
    console.log('[PDF_DEBUG] viewport px:', w, 'x', h);

    if (w < 1 || h < 1 || !isFinite(w) || !isFinite(h)) {
      var dimErr = new Error('Invalid viewport dimensions: ' + w + 'x' + h);
      console.error('[PDF_RENDER_ERROR]', dimErr);
      throw dimErr;
    }

    // Hard cap: 4 MP max (conservative for mobile, was 16 MP — too large)
    var pixels = w * h;
    var MP_CAP = 4 * 1024 * 1024;
    if (pixels > MP_CAP) {
      var ratio = Math.sqrt(MP_CAP / pixels);
      console.warn('[PDF_DEBUG] Canvas too large (' + pixels + ' px), scaling down by', ratio.toFixed(3));
      scale = scale * ratio;
      try {
        viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
      } catch (err) {
        console.error('[PDF_RENDER_ERROR] getViewport (capped) failed:', err);
        throw err;
      }
      w = Math.floor(viewport.width);
      h = Math.floor(viewport.height);
      console.log('[PDF_DEBUG] capped viewport px:', w, 'x', h);
    }

    var canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.style.width   = Math.floor(w / dpr) + 'px';
    canvas.style.height  = Math.floor(h / dpr) + 'px';
    canvas.style.display = 'block';
    console.log('[PDF_DEBUG] canvas created: ' + canvas.width + 'x' + canvas.height +
                ' CSS: ' + canvas.style.width + 'x' + canvas.style.height);

    var ctx;
    try {
      ctx = canvas.getContext('2d', { alpha: false });
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] canvas.getContext(2d) threw:', err);
      throw err;
    }
    if (!ctx) {
      var ctxErr = new Error('canvas.getContext("2d") returned null (canvas may be too large or GPU limit hit)');
      console.error('[PDF_RENDER_ERROR]', ctxErr);
      throw ctxErr;
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    var renderTask;
    try {
      renderTask = page.render({ canvasContext: ctx, viewport: viewport, intent: 'display' });
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] page.render() constructor threw:', err);
      throw err;
    }

    // 10-second timeout guard
    var timeoutHandle;
    var timeoutPromise = new Promise(function (_, reject) {
      timeoutHandle = setTimeout(function () {
        console.error('[PDF_RENDER_ERROR] render timeout >10s for page', pageNumber,
                      '— canvas:', w + 'x' + h, 'scale:', scale, 'dpr:', dpr,
                      'workerSrc:', window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions.workerSrc);
        try { if (renderTask && renderTask.cancel) renderTask.cancel(); } catch (e) {}
        reject(new Error('Render timeout after 10s for page ' + pageNumber));
      }, 10000);
    });

    console.log('[PDF_DEBUG] renderTask started for pg=' + pageNumber);
    try {
      await Promise.race([renderTask.promise, timeoutPromise]);
    } catch (err) {
      console.error('[PDF_RENDER_ERROR] renderTask.promise rejected for pg=' + pageNumber + ':', err);
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }

    console.log('[PDF_DEBUG] renderTask COMPLETE for pg=' + pageNumber +
                ' canvas in DOM:', canvas.isConnected);

    // Hard proof: red border confirms render succeeded.
    canvas.style.border = '2px solid red';

    return canvas;
  }

  // ── Public renderPage ─────────────────────────────────────────────────────
  // DEBUG: forces dpr=1, scale=1 baseline to isolate the render path.
  // Returns an error canvas (never a blank placeholder) so failures are visible.
  async function renderPage(pdfDoc, pageNumber, targetWidthCss, rotation) {
    targetWidthCss = targetWidthCss || 200;
    rotation = rotation || 0;

    // DEBUG: force dpr=1 — eliminates DPR scaling as a variable.
    var dpr = 1;
    console.log('[PDF_DEBUG] renderPage() pg=' + pageNumber +
                ' targetWidth=' + targetWidthCss + ' rotation=' + rotation +
                ' dpr(forced)=' + dpr +
                ' actual devicePixelRatio=' + window.devicePixelRatio);

    // Ensure our workerSrc is still correct (advanced-engine may have overwritten it).
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions &&
        window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WORKER) {
      console.warn('[PDF_DEBUG] workerSrc conflict detected! Was:',
                   window.pdfjsLib.GlobalWorkerOptions.workerSrc,
                   '— correcting to:', PDFJS_WORKER);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    }

    await acquireRenderSlot();
    var page = null;
    try {
      console.log('[PDF_DEBUG] getPage(' + pageNumber + ')...');
      try {
        page = await pdfDoc.pdf.getPage(pageNumber);
      } catch (err) {
        console.error('[PDF_RENDER_ERROR] getPage(' + pageNumber + ') failed:', err);
        throw err;
      }

      var baseViewport;
      try {
        baseViewport = page.getViewport({ scale: 1, rotation: rotation });
      } catch (err) {
        console.error('[PDF_RENDER_ERROR] getViewport(scale=1) failed:', err);
        throw err;
      }

      console.log('[PDF_DEBUG] baseViewport (scale=1):', baseViewport.width, 'x', baseViewport.height);
      if (!baseViewport || baseViewport.width <= 0) {
        throw new Error('Invalid base viewport: width=' + (baseViewport && baseViewport.width));
      }

      // DEBUG: use scale=1 only — eliminates scaling bugs as a variable.
      var scale = 1;
      console.log('[PDF_DEBUG] Using fixed scale=1 (debug mode). targetWidthCss was:', targetWidthCss);

      var canvas = await _tryRender(page, scale, dpr, rotation, pageNumber);

      console.log('[PDF_DEBUG] Render SUCCESS pg=' + pageNumber +
                  ' canvas=' + canvas.width + 'x' + canvas.height +
                  ' isConnected=' + canvas.isConnected);
      return canvas;

    } catch (err) {
      console.error('[PDF_RENDER_ERROR] renderPage FAILED for pg=' + pageNumber + ':', err);
      // Return error canvas — visible red tile with error message.
      var errMsg = (err && err.message) ? err.message : String(err);
      var ph = makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), errMsg);
      return ph;
    } finally {
      if (page) {
        try { page.cleanup(); } catch (err) {
          console.error('[PDF_RENDER_ERROR] page.cleanup() failed:', err);
        }
      }
      releaseRenderSlot();
    }
  }

  window.PdfPreview = {
    loadDocument:   loadDocument,
    renderPage:     renderPage,
    unloadDocument: unloadDocument,
    loadPdfJs:      loadPdfJs,
  };

  console.log('[PDF_DEBUG] window.PdfPreview registered.');
})();

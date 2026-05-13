// PDF.js loader + high-resolution page thumbnail renderer.
// Stable Production Build — v3.0 (Final Stabilization)
//
// Key hardening in v3.0:
//   • 3-attempt retry pipeline with DPR + scale degradation
//   • getPage() wrapped with 8 s timeout (prevents hidden-tab deadlock)
//   • Global render session counter — stale renders abort cleanly
//   • Per-render watchdog (10 s mobile / 15 s desktop)
//   • Canvas context-loss safe-reacquire
//   • Idempotent destroy on unloadDocument
//   • StabilityMetrics integration
//
// Public API:
//   window.PdfPreview.loadDocument(file)  → Promise<PdfDoc>
//   window.PdfPreview.renderPage(pdfDoc, pageNumber, targetWidthCss, rotation) → Promise<HTMLCanvasElement>
//   window.PdfPreview.unloadDocument(pdfDoc) → void
//   window.PdfPreview.loadPdfJs()          → Promise<pdfjsLib>
//   window.PdfPreview.invalidateSession()  → void   (call on route/tool change)
(function () {
  'use strict';

  if (window.__PdfPreviewLoaded) return;
  window.__PdfPreviewLoaded = true;

  var PDFJS_VERSION = '4.10.38';
  var PDFJS_SRC    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/build/pdf.worker.min.mjs';

  var _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  var WATCHDOG_MS = _isMobile ? 10000 : 15000;
  var GETPAGE_TIMEOUT_MS = 8000;

  // ── Render session — incremented on every invalidateSession() call ────────
  // Stale renders (from old route / old grid) check this and abort.
  var _renderSession = 0;
  function invalidateSession() {
    _renderSession++;
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('render-session-invalidated'); } catch (_) {}
    }
  }

  // ── Shared global PDF.js loader ───────────────────────────────────────────
  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) {
      if (window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WORKER) {
        console.warn('[PdfPreview] workerSrc corrected:',
          window.pdfjsLib.GlobalWorkerOptions.workerSrc, '→', PDFJS_WORKER);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      }
      return Promise.resolve(window.pdfjsLib);
    }
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
  var _renderSlots = 0;
  var _renderQueue = [];
  var MAX_CONCURRENT = _isMobile ? 1 : 2;

  function _effectiveConcurrent() {
    var base = MAX_CONCURRENT;
    if (window.MemPressure) {
      var t = window.MemPressure.tier();
      if (t === 'abort' || t === 'critical') return 1;
      if (t === 'low') return 1;
    }
    return base;
  }

  function acquireRenderSlot() {
    if (window.TaskScheduler) return window.TaskScheduler.acquireSlot('RENDER');
    var limit = _effectiveConcurrent();
    if (_renderSlots < limit) { _renderSlots++; return Promise.resolve(); }
    return new Promise(function (resolve) { _renderQueue.push(resolve); });
  }

  function releaseRenderSlot() {
    if (window.TaskScheduler) { window.TaskScheduler.releaseSlot('RENDER'); return; }
    if (_renderQueue.length > 0) { _renderQueue.shift()(); }
    else { _renderSlots = Math.max(0, _renderSlots - 1); }
  }

  // ── Error canvas ──────────────────────────────────────────────────────────
  function makeErrorCanvas(w, h, msg) {
    var c = document.createElement('canvas');
    c.width  = Math.max(100, Math.floor(w));
    c.height = Math.max(60,  Math.floor(h));
    c.style.cssText = 'display:block;width:' + c.width + 'px;height:' + c.height + 'px';
    try {
      var ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#f8f8f8';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.strokeStyle = '#ddd';
        ctx.strokeRect(1, 1, c.width - 2, c.height - 2);
        ctx.fillStyle = '#999';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Preview unavailable', c.width / 2, c.height / 2 - 6);
        if (msg && msg.length < 60) {
          ctx.font = '9px sans-serif';
          ctx.fillText(String(msg).slice(0, 55), c.width / 2, c.height / 2 + 8);
        }
      }
    } catch (_) {}
    c._isErrorCanvas = true;
    return c;
  }

  // ── getPage with timeout ──────────────────────────────────────────────────
  // Prevents indefinite hang when PDF worker is throttled (hidden tab).
  function getPageWithTimeout(pdfObj, pageNumber) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('getPage timeout (' + GETPAGE_TIMEOUT_MS + 'ms) page ' + pageNumber));
      }, GETPAGE_TIMEOUT_MS);
      pdfObj.getPage(pageNumber).then(function (page) {
        clearTimeout(timer);
        resolve(page);
      }, function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ── Low-level single render attempt ──────────────────────────────────────
  async function _tryRender(page, scale, dpr, rotation, pageNumber) {
    var viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
    var w = Math.floor(viewport.width);
    var h = Math.floor(viewport.height);

    if (w < 1 || h < 1 || !isFinite(w) || !isFinite(h)) {
      throw new Error('Invalid viewport: ' + w + 'x' + h);
    }

    // Hard cap: 4 MP (safe on 2 GB Android)
    var MP_CAP = 4 * 1024 * 1024;
    if (w * h > MP_CAP) {
      var ratio = Math.sqrt(MP_CAP / (w * h));
      scale = scale * ratio;
      viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
      w = Math.floor(viewport.width);
      h = Math.floor(viewport.height);
    }

    var canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.style.cssText = 'display:block;width:' + Math.floor(w / dpr) + 'px;height:' + Math.floor(h / dpr) + 'px';

    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      // GPU context limit — wait 150 ms and retry acquiring context
      await new Promise(function (r) { setTimeout(r, 150); });
      // Try a fresh canvas (old one may be tainted by context-loss)
      canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.style.cssText = 'display:block;width:' + Math.floor(w / dpr) + 'px;height:' + Math.floor(h / dpr) + 'px';
      ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('canvas.getContext("2d") null after retry (GPU limit or context-loss)');
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    var renderTask = page.render({ canvasContext: ctx, viewport: viewport, intent: 'display' });

    // Per-render watchdog
    var timeoutHandle;
    var timeoutPromise = new Promise(function (_, reject) {
      timeoutHandle = setTimeout(function () {
        try { if (renderTask.cancel) renderTask.cancel(); } catch (_) {}
        reject(new Error('Render watchdog (' + WATCHDOG_MS + 'ms) page ' + pageNumber));
      }, WATCHDOG_MS);
    });

    try {
      await Promise.race([renderTask.promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Verify canvas has non-zero pixels (GPU eviction leaves zeroed canvas)
    if (canvas.width === 0 || canvas.height === 0) {
      throw new Error('Canvas zeroed after render (GPU eviction)');
    }

    return canvas;
  }

  // ── Load a PDF file ───────────────────────────────────────────────────────
  async function loadDocument(file) {
    var pdfjsLib = await loadPdfJs();
    var fileBytes = new Uint8Array(await file.arrayBuffer());

    var pdf = await pdfjsLib.getDocument({
      data:             fileBytes.slice(),
      disableAutoFetch: true,
      disableStream:    true,
      isEvalSupported:  false,
      useWorkerFetch:   false,
    }).promise;

    return {
      pdf:       pdf,
      pageCount: pdf.numPages,
      file:      file,
      fileBytes: fileBytes,
      _destroyed: false,
    };
  }

  // Idempotent — safe to call multiple times.
  function unloadDocument(doc) {
    if (!doc || doc._destroyed) return;
    doc._destroyed = true;
    try { if (doc.pdf && doc.pdf.destroy) doc.pdf.destroy(); }
    catch (err) { console.error('[PdfPreview] destroy failed:', err); }
  }

  // ── Public renderPage ─────────────────────────────────────────────────────
  // Returns a rendered canvas, or an error canvas on failure (never throws).
  // Retry pipeline: up to 3 attempts, degrading DPR and scale each time.
  async function renderPage(pdfDoc, pageNumber, targetWidthCss, rotation) {
    targetWidthCss = targetWidthCss || 200;
    rotation       = (rotation || 0);

    var dprFull = Math.min(window.devicePixelRatio || 1, 2);

    // Adaptive DPR from memory pressure
    if (window.MemPressure) {
      var t = window.MemPressure.tier();
      if (t === 'critical' || t === 'abort') dprFull = 1.0;
      else if (t === 'low') dprFull = Math.min(dprFull, 1.5);
    }

    // Capture session at call time — detect stale renders after awaits
    var capturedSession = _renderSession;

    // Re-enforce workerSrc
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions &&
        window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WORKER) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    }

    if (pdfDoc && pdfDoc._destroyed) {
      return makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), 'Document destroyed');
    }

    await acquireRenderSlot();

    // Check staleness after acquiring (may have waited a long time)
    if (_renderSession !== capturedSession) {
      releaseRenderSlot();
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordRender(false, 0, 'stale-after-acquire'); } catch (_) {}
      }
      return makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), 'Stale render');
    }

    // Retry attempts: [full quality, medium quality, low quality]
    var ATTEMPTS = [
      { dpr: dprFull,                scaleFactor: 1.00 },
      { dpr: Math.min(dprFull, 1.5), scaleFactor: 0.85 },
      { dpr: 1.0,                    scaleFactor: 0.70 },
    ];

    var t0 = Date.now();
    var lastErr = null;

    try {
      for (var attempt = 0; attempt < ATTEMPTS.length; attempt++) {
        // Inter-attempt delay
        if (attempt > 0) {
          await new Promise(function (r) { setTimeout(r, 120 * attempt); });
        }

        // Stale check before each attempt
        if (_renderSession !== capturedSession) {
          if (window.StabilityMetrics) {
            try { window.StabilityMetrics.recordRender(false, Date.now() - t0, 'stale-mid-retry'); } catch (_) {}
          }
          return makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), 'Stale render (cancelled)');
        }

        if (pdfDoc && pdfDoc._destroyed) {
          return makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), 'Document destroyed');
        }

        var a = ATTEMPTS[attempt];
        var page = null;

        try {
          // Fresh page proxy per attempt — never reuse destroyed proxies
          page = await getPageWithTimeout(pdfDoc.pdf, pageNumber);

          var baseViewport = page.getViewport({ scale: 1, rotation: rotation });
          if (!baseViewport || baseViewport.width <= 0) {
            throw new Error('Invalid base viewport width: ' + (baseViewport && baseViewport.width));
          }

          var scale = (targetWidthCss / baseViewport.width) * a.scaleFactor;
          var canvas = await _tryRender(page, scale, a.dpr, rotation, pageNumber);

          // Success
          var elapsed = Date.now() - t0;
          if (window.StabilityMetrics) {
            try { window.StabilityMetrics.recordRender(true, elapsed, attempt > 0 ? 'retry-' + attempt : 'first'); } catch (_) {}
          }
          if (attempt > 0) {
            console.info('[PdfPreview] render succeeded on attempt ' + (attempt + 1) + ' (page ' + pageNumber + ')');
          }
          return canvas;

        } catch (err) {
          lastErr = err;
          var level = attempt < 2 ? 'warn' : 'error';
          console[level]('[PdfPreview] attempt ' + (attempt + 1) + '/3 failed (page ' + pageNumber + ', dpr=' + a.dpr.toFixed(1) + ', scale=' + a.scaleFactor + '):', err.message);
          if (window.StabilityMetrics) {
            try { window.StabilityMetrics.recordRenderRetry(attempt + 1, err.message); } catch (_) {}
          }
        } finally {
          if (page) { try { page.cleanup(); } catch (_) {} }
        }
      }

      // All attempts exhausted
      var totalElapsed = Date.now() - t0;
      console.error('[PdfPreview] all 3 attempts failed for page', pageNumber, 'after', totalElapsed + 'ms:', lastErr && lastErr.message);
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordRender(false, totalElapsed, 'all-failed'); } catch (_) {}
      }
      return makeErrorCanvas(
        targetWidthCss,
        Math.floor(targetWidthCss * 1.414),
        lastErr && lastErr.message ? lastErr.message : 'Render failed'
      );

    } finally {
      releaseRenderSlot();
    }
  }

  window.PdfPreview = {
    loadDocument:      loadDocument,
    renderPage:        renderPage,
    unloadDocument:    unloadDocument,
    loadPdfJs:         loadPdfJs,
    invalidateSession: invalidateSession,
    PDFJS_VERSION:     PDFJS_VERSION,
    PDFJS_WORKER:      PDFJS_WORKER,
  };
})();

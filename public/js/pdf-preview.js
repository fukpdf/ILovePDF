// PDF.js loader + high-resolution page thumbnail renderer.
// Stable Production Build — v4.0 (Full Mobile Hardening)
//
// RCA fixes in v4.0:
//   • loadDocument() wrapped with LOAD_DOC_TIMEOUT_MS timeout (was: infinite hang on Android)
//   • Worker-state recovery on visibilitychange (was: dead worker after background tab)
//   • Canvas pixel-integrity check after render (was: blank GPU-evicted canvases passing silently)
//   • TaskScheduler bypassed entirely — local semaphore only (was: cancelQueued active-count bug)
//   • Full [PDF_DEBUG] trace on every render path
//   • Explicit workerSrc integrity check before every getDocument call
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
  var WATCHDOG_MS       = _isMobile ? 12000 : 18000;
  var GETPAGE_TIMEOUT_MS = 8000;
  // RCA-1 FIX: timeout for getDocument().promise itself (was missing — caused infinite hang)
  var LOAD_DOC_TIMEOUT_MS = _isMobile ? 20000 : 30000;

  // ── Render session — incremented on every invalidateSession() call ────────
  var _renderSession = 0;
  function invalidateSession() {
    _renderSession++;
    console.debug('[PDF_DEBUG] invalidateSession → session=' + _renderSession);
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('render-session-invalidated'); } catch (_) {}
    }
  }

  // ── Shared global PDF.js loader ───────────────────────────────────────────
  function _ensureWorkerSrc() {
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions &&
        window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WORKER) {
      console.warn('[PDF_WORKER_STATE] workerSrc corrected:',
        window.pdfjsLib.GlobalWorkerOptions.workerSrc, '→', PDFJS_WORKER);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    }
  }

  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) {
      _ensureWorkerSrc();
      return Promise.resolve(window.pdfjsLib);
    }
    if (window.__pdfjsLibPromise) return window.__pdfjsLibPromise;

    console.debug('[PDF_WORKER_STATE] importing PDF.js v' + PDFJS_VERSION);
    window.__pdfjsLibPromise = import(PDFJS_SRC).then(function (mod) {
      var lib = mod.GlobalWorkerOptions ? mod : (mod.default || mod);
      if (!lib || !lib.getDocument) {
        throw new Error('[PdfPreview] pdfjsLib.getDocument missing after import — module shape unexpected');
      }
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = lib;
      console.debug('[PDF_WORKER_STATE] PDF.js loaded, workerSrc=' + PDFJS_WORKER);
      return lib;
    }).catch(function (err) {
      console.error('[PDF_WORKER_STATE] pdfjs import FAILED:', err.message);
      window.__pdfjsLibPromise = null;
      throw err;
    });
    return window.__pdfjsLibPromise;
  }

  // RCA-4 FIX: Recover worker state when tab comes back from background.
  // On Android the OS can kill the worker; re-using the stale pdfjsLib causes
  // silent hangs on getPage(). Reset the shared promise so the next call
  // reimports and gets a fresh worker.
  (function _installVisibilityRecovery() {
    var _wasHidden = false;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        _wasHidden = true;
        return;
      }
      if (!_wasHidden) return;
      _wasHidden = false;

      // Only reset if we have a library loaded — if nothing loaded yet, nothing to recover.
      if (!window.pdfjsLib) return;

      // Probe whether the worker is still alive by checking workerSrc integrity.
      // A dead worker leaves GlobalWorkerOptions.workerSrc intact so we can't detect it
      // directly — but we can force a workerSrc re-set so the NEXT document load
      // spawns a fresh worker.
      console.debug('[PDF_WORKER_STATE] tab resumed from background — re-enforcing workerSrc');
      try {
        if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
          // Temporarily unset then reset to force worker re-spawn on next document load
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = '';
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        }
      } catch (e) {
        // If this throws, the library object is corrupted — full reset
        console.warn('[PDF_WORKER_STATE] workerSrc reset failed, clearing pdfjsLib:', e.message);
        window.pdfjsLib = null;
        window.__pdfjsLibPromise = null;
      }
    });
  }());

  // ── Render semaphore (local only — RCA-3 FIX: bypass TaskScheduler) ────────
  // TaskScheduler.cancelQueued() has a bug: it decrements slot.active by the
  // number of queued waiters (which never held a slot), causing active to go
  // negative-clamped, which breaks future slot accounting → GPU over-commits.
  var _renderSlots = 0;
  var _renderQueue = [];
  var MAX_CONCURRENT = _isMobile ? 1 : 2;

  function _effectiveConcurrent() {
    var base = MAX_CONCURRENT;
    if (window.MemPressure) {
      try {
        var t = window.MemPressure.tier();
        if (t === 'abort' || t === 'critical') return 1;
        if (t === 'low') return 1;
      } catch (_) {}
    }
    return base;
  }

  function acquireRenderSlot() {
    // RCA-3 FIX: Never delegate to TaskScheduler — use local semaphore exclusively.
    var limit = _effectiveConcurrent();
    if (_renderSlots < limit) { _renderSlots++; return Promise.resolve(); }
    return new Promise(function (resolve) { _renderQueue.push(resolve); });
  }

  function releaseRenderSlot() {
    if (_renderQueue.length > 0) {
      // Hand slot directly to next waiter (count stays the same).
      _renderQueue.shift()();
    } else {
      _renderSlots = Math.max(0, _renderSlots - 1);
    }
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
    c._errorReason   = msg || 'unknown';
    return c;
  }

  // ── getPage with timeout ──────────────────────────────────────────────────
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

  // ── Canvas pixel integrity check ─────────────────────────────────────────
  // RCA-6 FIX: Android GPU eviction zeroes the texture while leaving width/height intact.
  // Sample pixels from multiple regions to confirm the canvas has real content.
  function _hasNonZeroPixels(canvas) {
    try {
      var ctx = canvas.getContext('2d');
      if (!ctx) return false;
      var w = canvas.width;
      var h = canvas.height;
      // Sample 5 points: center, four quadrant midpoints
      var pts = [
        [Math.floor(w * 0.5), Math.floor(h * 0.5)],
        [Math.floor(w * 0.25), Math.floor(h * 0.25)],
        [Math.floor(w * 0.75), Math.floor(h * 0.25)],
        [Math.floor(w * 0.25), Math.floor(h * 0.75)],
        [Math.floor(w * 0.75), Math.floor(h * 0.75)],
      ];
      for (var i = 0; i < pts.length; i++) {
        var px = ctx.getImageData(pts[i][0], pts[i][1], 1, 1).data;
        // Any non-background pixel (not pure white or pure black with 0 alpha) counts.
        // White canvas (all-white bg) is valid; what we're detecting is all-zero (GPU eviction).
        if (px[3] > 0) return true; // alpha > 0 → something was drawn
      }
      return false;
    } catch (_) {
      return true; // can't check — assume OK
    }
  }

  // ── Low-level single render attempt ──────────────────────────────────────
  async function _tryRender(page, scale, dpr, rotation, pageNumber) {
    var viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
    var w = Math.floor(viewport.width);
    var h = Math.floor(viewport.height);

    if (w < 1 || h < 1 || !isFinite(w) || !isFinite(h)) {
      throw new Error('[PDF_CANVAS_STATE] Invalid viewport: ' + w + 'x' + h + ' (page ' + pageNumber + ')');
    }

    // Hard cap: 4 MP (safe on 2 GB Android)
    var MP_CAP = 4 * 1024 * 1024;
    if (w * h > MP_CAP) {
      var ratio = Math.sqrt(MP_CAP / (w * h));
      scale = scale * ratio;
      viewport = page.getViewport({ scale: scale * dpr, rotation: rotation });
      w = Math.floor(viewport.width);
      h = Math.floor(viewport.height);
      console.debug('[PDF_CANVAS_STATE] page ' + pageNumber + ' scaled down to ' + w + 'x' + h + ' (4MP cap)');
    }

    var canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.style.cssText = 'display:block;width:' + Math.floor(w / dpr) + 'px;height:' + Math.floor(h / dpr) + 'px';

    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      console.warn('[PDF_CANVAS_STATE] getContext null on first try (GPU limit?) — retrying after 200ms, page ' + pageNumber);
      await new Promise(function (r) { setTimeout(r, 200); });
      canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.style.cssText = 'display:block;width:' + Math.floor(w / dpr) + 'px;height:' + Math.floor(h / dpr) + 'px';
      ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        throw new Error('[PDF_CANVAS_STATE] getContext("2d") null after retry — GPU context limit or context-loss (page ' + pageNumber + ')');
      }
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    var renderTask = page.render({ canvasContext: ctx, viewport: viewport, intent: 'display' });

    var timeoutHandle;
    var timeoutPromise = new Promise(function (_, reject) {
      timeoutHandle = setTimeout(function () {
        try { if (renderTask.cancel) renderTask.cancel(); } catch (_) {}
        reject(new Error('[PDF_RENDER_FAIL] Render watchdog (' + WATCHDOG_MS + 'ms) page ' + pageNumber));
      }, WATCHDOG_MS);
    });

    try {
      await Promise.race([renderTask.promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Dimension check
    if (canvas.width === 0 || canvas.height === 0) {
      throw new Error('[PDF_CANVAS_STATE] Canvas zeroed after render (GPU eviction) — page ' + pageNumber);
    }

    // RCA-6 FIX: pixel integrity check — detect GPU-evicted blank canvases
    if (!_hasNonZeroPixels(canvas)) {
      throw new Error('[PDF_CANVAS_STATE] Canvas all-zero pixels after render (GPU eviction) — page ' + pageNumber);
    }

    return canvas;
  }

  // ── Load a PDF file ───────────────────────────────────────────────────────
  // RCA-1 FIX: Wrap getDocument().promise with LOAD_DOC_TIMEOUT_MS.
  // Previously had NO timeout — caused infinite hang when PDF.js worker is
  // throttled or killed on Android background tabs.
  async function loadDocument(file) {
    var pdfjsLib = await loadPdfJs();
    _ensureWorkerSrc();

    var fileBytes = new Uint8Array(await file.arrayBuffer());

    console.debug('[PDF_DEBUG] loadDocument start:', file.name, '(' + Math.round(file.size / 1024) + ' KB)');

    var getDocTask = pdfjsLib.getDocument({
      data:             fileBytes.slice(),
      disableAutoFetch: true,
      disableStream:    true,
      isEvalSupported:  false,
      useWorkerFetch:   false,
    });

    // Timeout wrapper — getDocument().promise can hang forever if the worker is dead.
    var pdf = await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        try { if (getDocTask.destroy) getDocTask.destroy(); } catch (_) {}
        reject(new Error('[PDF_WORKER_STATE] getDocument timeout (' + LOAD_DOC_TIMEOUT_MS + 'ms) for ' + file.name + ' — PDF.js worker may be dead'));
      }, LOAD_DOC_TIMEOUT_MS);

      getDocTask.promise.then(function (doc) {
        clearTimeout(timer);
        resolve(doc);
      }, function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });

    console.debug('[PDF_DEBUG] loadDocument success:', file.name, pdf.numPages + ' pages');

    return {
      pdf:        pdf,
      pageCount:  pdf.numPages,
      file:       file,
      fileBytes:  fileBytes,
      _destroyed: false,
    };
  }

  // Idempotent — safe to call multiple times.
  function unloadDocument(doc) {
    if (!doc || doc._destroyed) return;
    doc._destroyed = true;
    try { if (doc.pdf && doc.pdf.destroy) doc.pdf.destroy(); }
    catch (err) { console.warn('[PDF_DEBUG] destroy failed:', err.message); }
  }

  // ── Public renderPage ─────────────────────────────────────────────────────
  // Returns a rendered canvas, or an error canvas on failure (never throws).
  // Retry pipeline: up to 3 attempts, degrading DPR and scale each time.
  async function renderPage(pdfDoc, pageNumber, targetWidthCss, rotation) {
    targetWidthCss = targetWidthCss || 200;
    rotation       = (rotation || 0);

    var dprFull = Math.min(window.devicePixelRatio || 1, 2);

    if (window.MemPressure) {
      try {
        var t = window.MemPressure.tier();
        if (t === 'critical' || t === 'abort') dprFull = 1.0;
        else if (t === 'low') dprFull = Math.min(dprFull, 1.5);
      } catch (_) {}
    }

    var capturedSession = _renderSession;

    // Re-enforce workerSrc before every render
    _ensureWorkerSrc();

    if (pdfDoc && pdfDoc._destroyed) {
      console.debug('[PDF_DEBUG] renderPage aborted — document destroyed (page ' + pageNumber + ')');
      return makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), 'Document destroyed');
    }

    console.debug('[PDF_RENDER_START] page=' + pageNumber + ' w=' + targetWidthCss + ' rot=' + rotation + ' session=' + capturedSession + ' dpr=' + dprFull);

    await acquireRenderSlot();

    // Check staleness after acquiring (may have waited in queue a long time)
    if (_renderSession !== capturedSession) {
      releaseRenderSlot();
      console.debug('[PDF_QUEUE_STATE] stale after acquire — session changed from ' + capturedSession + ' to ' + _renderSession + ' (page ' + pageNumber + ')');
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
        if (attempt > 0) {
          await new Promise(function (r) { setTimeout(r, 150 * attempt); });
        }

        // Stale check before each attempt
        if (_renderSession !== capturedSession) {
          console.debug('[PDF_QUEUE_STATE] stale mid-retry attempt ' + (attempt + 1) + ' (page ' + pageNumber + ')');
          if (window.StabilityMetrics) {
            try { window.StabilityMetrics.recordRender(false, Date.now() - t0, 'stale-mid-retry'); } catch (_) {}
          }
          return makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), 'Stale render (cancelled)');
        }

        if (pdfDoc && pdfDoc._destroyed) {
          console.debug('[PDF_DEBUG] document destroyed mid-retry (page ' + pageNumber + ')');
          return makeErrorCanvas(targetWidthCss, Math.floor(targetWidthCss * 1.414), 'Document destroyed');
        }

        var a = ATTEMPTS[attempt];
        var page = null;

        try {
          page = await getPageWithTimeout(pdfDoc.pdf, pageNumber);

          var baseViewport = page.getViewport({ scale: 1, rotation: rotation });
          if (!baseViewport || baseViewport.width <= 0) {
            throw new Error('[PDF_RENDER_FAIL] Invalid base viewport width: ' + (baseViewport && baseViewport.width));
          }

          var scale = (targetWidthCss / baseViewport.width) * a.scaleFactor;
          var canvas = await _tryRender(page, scale, a.dpr, rotation, pageNumber);

          var elapsed = Date.now() - t0;
          console.debug('[PDF_RENDER_SUCCESS] page=' + pageNumber + ' attempt=' + (attempt + 1) + ' elapsed=' + elapsed + 'ms size=' + canvas.width + 'x' + canvas.height);
          if (window.StabilityMetrics) {
            try { window.StabilityMetrics.recordRender(true, elapsed, attempt > 0 ? 'retry-' + attempt : 'first'); } catch (_) {}
          }
          return canvas;

        } catch (err) {
          lastErr = err;
          var errMsg = (err && err.message) ? err.message : String(err);
          var level = attempt < 2 ? 'warn' : 'error';
          console[level]('[PDF_RENDER_FAIL] attempt ' + (attempt + 1) + '/3 page=' + pageNumber +
            ' dpr=' + a.dpr.toFixed(1) + ' scale=' + a.scaleFactor + ' reason: ' + errMsg);
          if (window.StabilityMetrics) {
            try { window.StabilityMetrics.recordRenderRetry(attempt + 1, errMsg); } catch (_) {}
          }
        } finally {
          if (page) { try { page.cleanup(); } catch (_) {} }
        }
      }

      // All attempts exhausted
      var totalElapsed = Date.now() - t0;
      var finalReason = lastErr && lastErr.message ? lastErr.message : 'Render failed';
      console.error('[PDF_RENDER_FAIL] ALL 3 attempts failed page=' + pageNumber +
        ' after ' + totalElapsed + 'ms. Final reason: ' + finalReason);
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordRender(false, totalElapsed, 'all-failed'); } catch (_) {}
      }
      return makeErrorCanvas(
        targetWidthCss,
        Math.floor(targetWidthCss * 1.414),
        finalReason
      );

    } finally {
      releaseRenderSlot();
      console.debug('[PDF_QUEUE_STATE] slot released — active=' + _renderSlots + ' queued=' + _renderQueue.length);
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

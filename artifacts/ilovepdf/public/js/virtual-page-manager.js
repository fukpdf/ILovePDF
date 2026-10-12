// Virtual Page Manager v1.0 — Phase 25B
// Memory-safe virtual rendering system for giant PDFs.
// Only pages within the active render window exist in memory.
// Non-visible canvases are destroyed immediately.
// GPU backing stores released on eviction.
// Exposes: window.VirtualPageManager
// Depends on: MemPressure (Phase 23A)
(function () {
  'use strict';

  var MB = 1024 * 1024;

  // ── Render window sizing (adaptive to memory pressure) ────────────────────
  function windowSize() {
    if (window.MemPressure) {
      var t = window.MemPressure.tier();
      if (t === 'abort' || t === 'critical') return 2;
      if (t === 'low')                        return 3;
      if (t === 'reduce')                     return 5;
      return 8;
    }
    return 5; // safe default
  }

  // ── Canvas recycler ───────────────────────────────────────────────────────
  // Pool of blank canvases to avoid repeated allocations.
  var CanvasRecycler = (function () {
    var _pool = [];
    var MAX_POOL = 4;

    function acquire(w, h) {
      for (var i = 0; i < _pool.length; i++) {
        var c = _pool[i];
        if (c.width === w && c.height === h) {
          _pool.splice(i, 1);
          return c;
        }
      }
      // Try OffscreenCanvas for GPU-decoupled rendering
      if (typeof OffscreenCanvas !== 'undefined') {
        try { return new OffscreenCanvas(w, h); } catch (_) {}
      }
      var canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      return canvas;
    }

    function recycle(canvas) {
      if (!canvas) return;
      if (_pool.length >= MAX_POOL) {
        // Pool full — destroy immediately
        try { canvas.width = 0; canvas.height = 0; } catch (_) {}
        return;
      }
      try {
        // Clear the canvas before returning to pool
        var ctx = canvas.getContext ? canvas.getContext('2d') : null;
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        _pool.push(canvas);
      } catch (_) {
        try { canvas.width = 0; canvas.height = 0; } catch (_2) {}
      }
    }

    function drainPool() {
      while (_pool.length) {
        var c = _pool.pop();
        try { c.width = 0; c.height = 0; } catch (_) {}
      }
    }

    return { acquire: acquire, recycle: recycle, drainPool: drainPool };
  }());

  // ── VirtualPageManager factory ────────────────────────────────────────────
  // One instance per tool invocation.
  function createVirtualPageManager(pdfDoc, opts) {
    opts = opts || {};

    var _pages      = {};    // { [pageNum]: { canvas, bitmap, renderTask, loaded, container } }
    var _visible    = [];    // currently visible page numbers
    var _prefetched = {};    // { [pageNum]: Promise<page> }
    var _destroyed  = false;
    var _peakPages  = 0;
    var _evictions  = 0;
    var _renders    = 0;

    // ── Scale selection ───────────────────────────────────────────────────
    function _scale(pageCount) {
      var preferred = opts.scale || 1.5;
      if (window.MemPressure) {
        var ms = window.MemPressure.renderScale('pdf');
        preferred = preferred * ms;
      }
      if (pageCount > 200) preferred = Math.min(preferred, 0.8);
      else if (pageCount > 100) preferred = Math.min(preferred, 1.0);
      else if (pageCount > 50)  preferred = Math.min(preferred, 1.2);
      // Guard against OOM for huge pages
      return Math.max(0.5, Math.min(2.0, preferred));
    }

    // ── Mount a single page into an optional container ────────────────────
    async function mountPage(pageNum, container) {
      if (_destroyed) throw new Error('vpm_destroyed');
      if (_pages[pageNum] && _pages[pageNum].loaded) return _pages[pageNum];

      var total = pdfDoc.numPages;
      if (pageNum < 1 || pageNum > total) throw new Error('invalid_page: ' + pageNum);

      var scale = _scale(total);

      // Use prefetched page proxy if available
      var pageProxy;
      if (_prefetched[pageNum]) {
        try { pageProxy = await _prefetched[pageNum]; }
        catch (_) { pageProxy = null; }
        delete _prefetched[pageNum];
      }
      if (!pageProxy) {
        pageProxy = await pdfDoc.getPage(pageNum);
      }

      var viewport = pageProxy.getViewport({ scale: scale });
      var w = Math.floor(viewport.width);
      var h = Math.floor(viewport.height);

      var canvas = CanvasRecycler.acquire(w, h);
      var ctx;

      if (canvas instanceof OffscreenCanvas || canvas.getContext) {
        ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
        }
      }

      var renderTask = null;
      if (ctx) {
        renderTask = pageProxy.render({ canvasContext: ctx, viewport: viewport });
        try { await renderTask.promise; } catch (_) {}
      }

      // Convert to ImageBitmap for GPU-decoupled storage if possible
      var bitmap = null;
      if (ctx && typeof createImageBitmap !== 'undefined') {
        try {
          bitmap = await createImageBitmap(canvas);
          // Release the canvas immediately — bitmap holds the GPU texture
          CanvasRecycler.recycle(canvas);
          canvas = null;
        } catch (_) {
          // ImageBitmap not available — keep canvas
        }
      }

      try { pageProxy.cleanup(); } catch (_) {}

      var entry = {
        pageNum:    pageNum,
        canvas:     canvas,
        bitmap:     bitmap,
        width:      w,
        height:     h,
        scale:      scale,
        loaded:     true,
        container:  container || null,
        mountedAt:  Date.now(),
      };

      _pages[pageNum] = entry;
      _renders++;
      _peakPages = Math.max(_peakPages, Object.keys(_pages).length);

      // Attach to DOM container if provided
      if (container && canvas) {
        canvas.style.cssText = 'max-width:100%;height:auto;display:block;margin:0 auto;';
        container.innerHTML  = '';
        container.appendChild(canvas);
      } else if (container && bitmap) {
        // Draw bitmap into a visible canvas in the container
        var visCanvas   = document.createElement('canvas');
        visCanvas.width  = w;
        visCanvas.height = h;
        var visCtx = visCanvas.getContext('2d');
        if (visCtx) visCtx.drawImage(bitmap, 0, 0);
        visCanvas.style.cssText = 'max-width:100%;height:auto;display:block;margin:0 auto;';
        container.innerHTML = '';
        container.appendChild(visCanvas);
      }

      return entry;
    }

    // ── Unmount a single page, releasing all GPU resources ────────────────
    function unmountPage(pageNum) {
      var entry = _pages[pageNum];
      if (!entry) return;
      // Release canvas
      if (entry.canvas) {
        CanvasRecycler.recycle(entry.canvas);
        entry.canvas = null;
      }
      // Release ImageBitmap (GPU texture)
      if (entry.bitmap) {
        try { entry.bitmap.close(); } catch (_) {}
        entry.bitmap = null;
      }
      // Cancel render task if still in flight
      if (entry.renderTask) {
        try { entry.renderTask.cancel(); } catch (_) {}
        entry.renderTask = null;
      }
      // Clear container
      if (entry.container) {
        try { entry.container.innerHTML = ''; } catch (_) {}
      }
      delete _pages[pageNum];
      _evictions++;
    }

    // ── Recycle a canvas explicitly ───────────────────────────────────────
    function recycleCanvas(canvas) {
      CanvasRecycler.recycle(canvas);
    }

    // ── Evict pages outside the visible window ────────────────────────────
    function evictFarPages(visibleRange) {
      // visibleRange: [first, last]
      var first = visibleRange[0];
      var last  = visibleRange[1];
      var win   = windowSize();
      var keepFirst = Math.max(1, first - Math.floor(win / 2));
      var keepLast  = last + Math.floor(win / 2);

      var loaded = Object.keys(_pages).map(Number);
      for (var i = 0; i < loaded.length; i++) {
        var pn = loaded[i];
        if (pn < keepFirst || pn > keepLast) {
          unmountPage(pn);
        }
      }
      _visible = [];
      for (var n = first; n <= last; n++) _visible.push(n);
    }

    // ── Prefetch pages ahead of current position ──────────────────────────
    function preloadAhead(currentPage, count) {
      count = count || Math.min(windowSize(), 4);
      var total = pdfDoc.numPages;
      for (var i = 1; i <= count; i++) {
        var next = currentPage + i;
        if (next > total) break;
        if (_pages[next] && _pages[next].loaded) continue;
        if (_prefetched[next]) continue;
        _prefetched[next] = pdfDoc.getPage(next).catch(function () { return null; });
      }
    }

    // ── Memory checkpoint ─────────────────────────────────────────────────
    // Check pressure and evict aggressively if needed.
    function memoryCheckpoint(currentPage) {
      if (!window.MemPressure) return;
      var t = window.MemPressure.tier();
      if (t === 'abort' || t === 'critical') {
        // Emergency: keep only current ±1
        evictFarPages([currentPage - 1, currentPage + 1]);
        CanvasRecycler.drainPool();
        // Cancel all prefetches
        _prefetched = {};
      } else if (t === 'low') {
        // Aggressive: keep current ±2
        evictFarPages([currentPage - 2, currentPage + 2]);
      }
    }

    // ── Thumbnail virtualization ──────────────────────────────────────────
    // Renders pages at tiny scale for sidebar thumbnails without GPU pressure.
    async function renderThumbnail(pageNum, maxDim) {
      maxDim = maxDim || 120;
      var page = await pdfDoc.getPage(pageNum);
      var vp   = page.getViewport({ scale: 1 });
      var scale = Math.min(maxDim / vp.width, maxDim / vp.height);
      var scaledVp = page.getViewport({ scale: scale });
      var w = Math.floor(scaledVp.width);
      var h = Math.floor(scaledVp.height);

      var canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);

      try {
        var rt = page.render({ canvasContext: ctx, viewport: scaledVp });
        await rt.promise;
      } catch (_) {}
      try { page.cleanup(); } catch (_) {}

      return canvas; // caller responsible for cleanup
    }

    // ── Auto downscale guard ──────────────────────────────────────────────
    // Returns a reduced scale if the page would exceed the safe pixel budget.
    function safeScaleForPage(viewportW, viewportH, targetScale) {
      var pixels = viewportW * targetScale * viewportH * targetScale;
      var budget = window.MemPressure ? (window.MemPressure.memAvail() / 4) : (256 * MB);
      // RGBA = 4 bytes/pixel
      if (pixels * 4 > budget) {
        targetScale = Math.sqrt(budget / (pixels * 4)) * targetScale;
        targetScale = Math.max(0.4, targetScale);
      }
      return targetScale;
    }

    // ── Destroy (cleanup everything) ──────────────────────────────────────
    function destroy() {
      _destroyed = true;
      var loaded = Object.keys(_pages).map(Number);
      for (var i = 0; i < loaded.length; i++) unmountPage(loaded[i]);
      _prefetched = {};
      CanvasRecycler.drainPool();
    }

    // ── Stats ─────────────────────────────────────────────────────────────
    function stats() {
      return {
        loadedPages:  Object.keys(_pages).length,
        prefetched:   Object.keys(_prefetched).length,
        windowSize:   windowSize(),
        peakPages:    _peakPages,
        evictions:    _evictions,
        renders:      _renders,
        visible:      _visible.slice(),
      };
    }

    return {
      mountPage:       mountPage,
      unmountPage:     unmountPage,
      recycleCanvas:   recycleCanvas,
      evictFarPages:   evictFarPages,
      preloadAhead:    preloadAhead,
      memoryCheckpoint: memoryCheckpoint,
      renderThumbnail: renderThumbnail,
      safeScaleForPage: safeScaleForPage,
      destroy:         destroy,
      stats:           stats,
    };
  }

  window.VirtualPageManager = {
    version: '1.0',
    create:  createVirtualPageManager,
    // Expose recycler for external use
    CanvasRecycler: CanvasRecycler,
    // Utility: current recommended window size
    windowSize: windowSize,
  };

}());

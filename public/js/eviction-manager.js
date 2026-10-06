// Eviction Manager v1.0 — Phase 25F
// Aggressive cleanup architecture for giant-file processing.
// Hooks into MemPressure automatically.
// ALL heavy objects must be released immediately after use.
// Exposes: window.EvictionManager
// Depends on: MemPressure (Phase 23A)
(function () {
  'use strict';

  // ── Registries — tracked objects that can be evicted ─────────────────────
  var _canvases    = new Set();  // HTMLCanvasElement / OffscreenCanvas
  var _bitmaps     = new Set();  // ImageBitmap
  var _pdfPages    = new Set();  // pdfjs page proxies
  var _blobUrls    = new Set();  // object: URLs
  var _workerRefs  = new Set();  // { worker, name }

  // Telemetry
  var _stats = {
    canvasReleases:  0,
    bitmapReleases:  0,
    pageReleases:    0,
    blobReleases:    0,
    workerKills:     0,
    emergencyFlushes: 0,
    pressureHooks:   0,
  };

  // ── Registration helpers ──────────────────────────────────────────────────
  function trackCanvas(canvas)   { if (canvas) _canvases.add(canvas); return canvas; }
  function trackBitmap(bitmap)   { if (bitmap) _bitmaps.add(bitmap);  return bitmap; }
  function trackPdfPage(page)    { if (page)   _pdfPages.add(page);   return page;   }
  function trackBlobUrl(url)     { if (url)    _blobUrls.add(url);    return url;    }
  function trackWorker(w, name)  {
    if (w) _workerRefs.add({ worker: w, name: name || 'unnamed' });
    return w;
  }

  // ── Untrack helpers (call after manual release) ───────────────────────────
  function untrackCanvas(canvas) { _canvases.delete(canvas); }
  function untrackBitmap(bitmap) { _bitmaps.delete(bitmap);  }
  function untrackBlobUrl(url)   { _blobUrls.delete(url);    }

  // ── Release functions ─────────────────────────────────────────────────────

  // releaseCanvas — zero dimensions, untrack
  function releaseCanvas(canvas) {
    if (!canvas) return;
    try { canvas.width = 0; canvas.height = 0; } catch (_) {}
    _canvases.delete(canvas);
    _stats.canvasReleases++;
  }

  // releaseBitmap — close GPU texture, untrack
  function releaseBitmap(bitmap) {
    if (!bitmap) return;
    try { if (typeof bitmap.close === 'function') bitmap.close(); } catch (_) {}
    _bitmaps.delete(bitmap);
    _stats.bitmapReleases++;
  }

  // releasePdfPage — cleanup pdfjs page proxy, release GPU resources
  function releasePdfPage(page) {
    if (!page) return;
    try { if (typeof page.cleanup === 'function') page.cleanup(); } catch (_) {}
    _pdfPages.delete(page);
    _stats.pageReleases++;
  }

  // releaseBlob — revoke object URL, untrack
  function releaseBlob(url) {
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch (_) {}
    _blobUrls.delete(url);
    _stats.blobReleases++;
  }

  // releaseWorkerCache — terminate idle / stale workers
  function releaseWorkerCache() {
    _workerRefs.forEach(function (entry) {
      try { entry.worker.terminate(); } catch (_) {}
      _stats.workerKills++;
    });
    _workerRefs.clear();
  }

  // ── Emergency pressure flush ───────────────────────────────────────────────
  // Releases ALL tracked resources immediately.
  function emergencyPressureFlush() {
    _stats.emergencyFlushes++;

    // Release all canvases
    _canvases.forEach(function (c) {
      try { c.width = 0; c.height = 0; } catch (_) {}
      _stats.canvasReleases++;
    });
    _canvases.clear();

    // Close all bitmaps
    _bitmaps.forEach(function (b) {
      try { b.close(); } catch (_) {}
      _stats.bitmapReleases++;
    });
    _bitmaps.clear();

    // Cleanup all PDF pages
    _pdfPages.forEach(function (p) {
      try { if (p.cleanup) p.cleanup(); } catch (_) {}
      _stats.pageReleases++;
    });
    _pdfPages.clear();

    // Revoke all blob URLs
    _blobUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (_) {}
      _stats.blobReleases++;
    });
    _blobUrls.clear();

    // Sweep OPFS stale files if possible
    if (window.OPFSManager && window.OPFSManager.sweep) {
      window.OPFSManager.sweep().catch(function () {});
    }

    // Hint GC (Chrome non-standard)
    if (typeof gc === 'function') { try { gc(); } catch (_) {} }

    _log('emergencyPressureFlush', { stats: Object.assign({}, _stats) });
  }

  // ── Selective pressure flush ───────────────────────────────────────────────
  // Releases only the most expensive tracked objects (bitmaps + canvases).
  function selectivePressureFlush() {
    _stats.pressureHooks++;

    var released = 0;
    _bitmaps.forEach(function (b) {
      try { b.close(); } catch (_) {}
      released++;
      _stats.bitmapReleases++;
    });
    _bitmaps.clear();

    // Release canvases that have no parent (detached)
    var staleCanvases = [];
    _canvases.forEach(function (c) {
      var isOrphan = !c.parentNode && !c._vpmMounted;
      if (isOrphan) staleCanvases.push(c);
    });
    staleCanvases.forEach(function (c) {
      try { c.width = 0; c.height = 0; } catch (_) {}
      _canvases.delete(c);
      released++;
      _stats.canvasReleases++;
    });

    _log('selectivePressureFlush', { released: released });
  }

  // ── Stale object cleanup ──────────────────────────────────────────────────
  // Removes orphaned canvases (detached from DOM, no active job).
  function cleanOrphanCanvases() {
    var orphans = [];
    _canvases.forEach(function (c) {
      if (c instanceof HTMLCanvasElement && !c.parentNode) orphans.push(c);
    });
    orphans.forEach(function (c) {
      try { c.width = 0; c.height = 0; } catch (_) {}
      _canvases.delete(c);
      _stats.canvasReleases++;
    });
    return orphans.length;
  }

  // ── Auto-release wrapper ───────────────────────────────────────────────────
  // Wraps an async function, releasing listed resources afterward.
  function withAutoRelease(fn, resources) {
    return async function () {
      try {
        return await fn.apply(this, arguments);
      } finally {
        (resources || []).forEach(function (r) {
          if (!r) return;
          if (r.__type === 'canvas')  releaseCanvas(r.value);
          if (r.__type === 'bitmap')  releaseBitmap(r.value);
          if (r.__type === 'page')    releasePdfPage(r.value);
          if (r.__type === 'blob')    releaseBlob(r.value);
        });
      }
    };
  }

  // ── Logger ────────────────────────────────────────────────────────────────
  function _log(event, data) {
    if (window.GiantFileTelemetry) {
      window.GiantFileTelemetry.record('eviction.' + event, data);
    }
  }

  // ── Hook into MemPressure ──────────────────────────────────────────────────
  // Register cleanup callbacks on memory tier changes.
  function _hookMemPressure() {
    if (!window.MemPressure) return;
    window.MemPressure.onPressure(function () {
      var t = window.MemPressure.tier();
      if (t === 'abort' || t === 'critical') {
        emergencyPressureFlush();
      } else if (t === 'low') {
        selectivePressureFlush();
      } else {
        cleanOrphanCanvases();
      }
    });
    window.MemPressure.onTierChange(function (newTier) {
      if (newTier === 'abort' || newTier === 'critical') {
        emergencyPressureFlush();
      } else if (newTier === 'low') {
        selectivePressureFlush();
      }
    });
  }
  _hookMemPressure();

  // Periodic orphan canvas cleanup every 90s
  setInterval(function () {
    var n = cleanOrphanCanvases();
    if (n > 0) _log('orphanCleanup', { released: n });
  }, 90000);

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return Object.assign({}, _stats, {
      activeCanvases:  _canvases.size,
      activeBitmaps:   _bitmaps.size,
      activePdfPages:  _pdfPages.size,
      activeBlobUrls:  _blobUrls.size,
      activeWorkers:   _workerRefs.size,
    });
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.EvictionManager = {
    version: '1.0',
    // Tracking
    trackCanvas:           trackCanvas,
    trackBitmap:           trackBitmap,
    trackPdfPage:          trackPdfPage,
    trackBlobUrl:          trackBlobUrl,
    trackWorker:           trackWorker,
    untrackCanvas:         untrackCanvas,
    untrackBitmap:         untrackBitmap,
    untrackBlobUrl:        untrackBlobUrl,
    // Release
    releaseCanvas:         releaseCanvas,
    releaseBitmap:         releaseBitmap,
    releasePdfPage:        releasePdfPage,
    releaseBlob:           releaseBlob,
    releaseWorkerCache:    releaseWorkerCache,
    // Flush
    emergencyPressureFlush: emergencyPressureFlush,
    selectivePressureFlush: selectivePressureFlush,
    cleanOrphanCanvases:    cleanOrphanCanvases,
    // Utilities
    withAutoRelease:       withAutoRelease,
    // Diagnostics
    getStats:              getStats,
  };

}());

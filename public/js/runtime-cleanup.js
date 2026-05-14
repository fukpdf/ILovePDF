// Runtime Cleanup Engine v1.0 — Phase 2 (T027)
// Unified cleanup orchestrator. Extends CleanupContracts (Phase 1C) with:
// centralized resource tracking (blobs, workers, canvases, previews,
// listeners, timers, image bitmaps, PDF renders, caches), ordered teardown,
// memory-tier-aware escalation, and telemetry.
//
// ALL cleanup routes through this engine. Existing CleanupContracts
// registrations are preserved and extended — not replaced.
//
// Integrates: CleanupContracts, RuntimeTelemetry, RuntimeEventBus,
//             RuntimeState, RuntimeMemory, LifecycleManager
//
// [FUTURE: ResourceManager] RuntimeCleanup will feed a persistent
// ResourceManager that tracks resources across OPFS boundaries and enables
// reclamation of stale OPFS files after browser restart.
//
// Exposed as: window.RuntimeCleanup
(function () {
  'use strict';

  if (window.RuntimeCleanup) return;

  var LOG = '[RCE]';

  // ── Resource trackers ─────────────────────────────────────────────────────
  // Each tracker holds a Set of resources + a cleanup function per resource.
  // WeakRef is used where supported to avoid extending resource lifetimes.

  var _HAS_WEAK_REF = typeof WeakRef !== 'undefined';

  function _Tracker(name, cleanFn) {
    var _resources = new Map(); // id → { ref|resource, meta }
    var _idCounter = 0;

    return {
      name: name,
      track: function (resource, meta) {
        var id = ++_idCounter;
        var entry = { meta: meta || null };
        if (_HAS_WEAK_REF && resource && typeof resource === 'object') {
          entry.ref = new WeakRef(resource);
          entry.resource = null; // don't hold strong ref if WeakRef available
        } else {
          entry.resource = resource;
        }
        _resources.set(id, entry);
        return id;
      },
      untrack: function (id) {
        _resources.delete(id);
      },
      cleanup: function (reason) {
        var cleaned = 0;
        _resources.forEach(function (entry, id) {
          var res = _HAS_WEAK_REF && entry.ref ? entry.ref.deref() : entry.resource;
          if (res !== undefined && res !== null) {
            try { cleanFn(res, entry.meta, reason); } catch (_) {}
          }
          cleaned++;
        });
        _resources.clear();
        return cleaned;
      },
      size: function () { return _resources.size; },
      stats: function () { return { name: name, count: _resources.size }; },
    };
  }

  // ── Resource type trackers ─────────────────────────────────────────────────

  // Blob URLs
  var _blobTracker = _Tracker('blobs', function (url) {
    try {
      var reg = window.ObjectURLRegistry;
      if (reg) reg.revoke(url);
      else URL.revokeObjectURL(url);
    } catch (_) {}
  });

  // Canvas elements
  var _canvasTracker = _Tracker('canvases', function (canvas) {
    try { canvas.width = 0; canvas.height = 0; } catch (_) {}
    try { var ctx = canvas.getContext('2d'); if (ctx) ctx.clearRect(0,0,0,0); } catch (_) {}
  });

  // ImageBitmap objects
  var _bitmapTracker = _Tracker('bitmaps', function (bmp) {
    try { bmp.close(); } catch (_) {}
  });

  // PDF.js documents
  var _pdfDocTracker = _Tracker('pdfDocs', function (doc) {
    try { doc.destroy(); } catch (_) {}
  });

  // Event listeners: { target, type, fn, opts }
  var _listenerTracker = _Tracker('listeners', function (entry) {
    try { entry.target.removeEventListener(entry.type, entry.fn, entry.opts || false); } catch (_) {}
  });

  // Arbitrary teardown callbacks (generic resource)
  var _genericTracker = _Tracker('generic', function (fn) {
    try { fn(); } catch (_) {}
  });

  // ── Public tracking API ───────────────────────────────────────────────────

  function trackBlob(url, meta)        { return _blobTracker.track(url, meta); }
  function untrackBlob(id)             { _blobTracker.untrack(id); }
  function trackCanvas(canvas, meta)   { return _canvasTracker.track(canvas, meta); }
  function untrackCanvas(id)           { _canvasTracker.untrack(id); }
  function trackBitmap(bmp, meta)      { return _bitmapTracker.track(bmp, meta); }
  function untrackBitmap(id)           { _bitmapTracker.untrack(id); }
  function trackPdfDoc(doc, meta)      { return _pdfDocTracker.track(doc, meta); }
  function untrackPdfDoc(id)           { _pdfDocTracker.untrack(id); }
  function trackListener(target, type, fn, opts) {
    return _listenerTracker.track({ target, type, fn, opts }, null);
  }
  function untrackListener(id)         { _listenerTracker.untrack(id); }
  function trackGeneric(fn, meta)      { return _genericTracker.track(fn, meta); }
  function untrackGeneric(id)          { _genericTracker.untrack(id); }

  // ── Ordered cleanup ───────────────────────────────────────────────────────
  // Phase order: workers first (stop producing), then data, then UI, then listeners.
  function cleanupAll(reason) {
    var t0 = Date.now();
    var counts = {};

    // Phase 1: CleanupContracts (covers workers, timers, etc.)
    if (window.CleanupContracts) {
      try { window.CleanupContracts.cleanup(reason || 'runtime-cleanup'); } catch (_) {}
    }

    // Phase 2: PDF documents (release decoded streams)
    counts.pdfDocs = _pdfDocTracker.cleanup(reason);

    // Phase 3: ImageBitmaps (GPU textures)
    counts.bitmaps = _bitmapTracker.cleanup(reason);

    // Phase 4: Canvas elements (GPU memory)
    counts.canvases = _canvasTracker.cleanup(reason);

    // Phase 5: Blob URLs (memory)
    counts.blobs = _blobTracker.cleanup(reason);

    // Phase 6: Listeners
    counts.listeners = _listenerTracker.cleanup(reason);

    // Phase 7: Generic callbacks
    counts.generic = _genericTracker.cleanup(reason);

    // Phase 8: CanvasPool
    if (window.CanvasPool && window.CanvasPool.releaseAll) {
      try { window.CanvasPool.releaseAll(); counts.canvasPool = true; } catch (_) {}
    }

    var total = Object.values(counts).reduce(function (s, v) {
      return s + (typeof v === 'number' ? v : 0);
    }, 0);
    var durationMs = Date.now() - t0;

    if (total > 0) {
      console.debug(LOG, 'cleanupAll(' + (reason || '') + ') — ' + total + ' resources in ' + durationMs + 'ms');
    }

    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('memory:cleanup', { counts: counts, durationMs: durationMs, reason: reason }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('memory:cleanup', { reason: reason, total: total, durationMs: durationMs }); } catch (_) {}
    }

    return { counts: counts, total: total, durationMs: durationMs };
  }

  // Lightweight cleanup for memory pressure (no PDF destroy — too slow)
  function lightCleanup(reason) {
    var counts = {};
    counts.bitmaps  = _bitmapTracker.cleanup(reason);
    counts.blobs    = _blobTracker.cleanup(reason);
    counts.canvases = _canvasTracker.cleanup(reason);
    if (window.CleanupContracts) {
      try { window.CleanupContracts.cleanup(reason || 'light-cleanup'); } catch (_) {}
    }
    return counts;
  }

  // ── Register runtime cleanup as a CleanupContracts contract ──────────────
  if (window.CleanupContracts) {
    window.CleanupContracts.register('runtime-cleanup-engine', {
      phase:   'generic',
      priority: 5,
      destroy:  function (reason) { cleanupAll(reason); },
      cleanup:  function (reason) { lightCleanup(reason); },
    });
  }

  // ── LifecycleManager integration ──────────────────────────────────────────
  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      if (reason === 'pagehide' || reason === 'pagehide-bfcache') {
        cleanupAll(reason);
      } else {
        // Tab hidden — light cleanup only
        lightCleanup(reason);
      }
    });
  }

  // ── Memory-tier-driven cleanup escalation ─────────────────────────────────
  if (window.RuntimeMemory && window.RuntimeMemory.onChange) {
    window.RuntimeMemory.onChange(function (newTier, oldTier) {
      if (newTier === 'EMERGENCY') {
        cleanupAll('memory-emergency');
      } else if (newTier === 'CRITICAL') {
        lightCleanup('memory-critical');
      }
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      tracked: {
        blobs:     _blobTracker.size(),
        canvases:  _canvasTracker.size(),
        bitmaps:   _bitmapTracker.size(),
        pdfDocs:   _pdfDocTracker.size(),
        listeners: _listenerTracker.size(),
        generic:   _genericTracker.size(),
      },
    };
  }

  window.RuntimeCleanup = {
    // Tracking
    trackBlob:       trackBlob,    untrackBlob:     untrackBlob,
    trackCanvas:     trackCanvas,  untrackCanvas:   untrackCanvas,
    trackBitmap:     trackBitmap,  untrackBitmap:   untrackBitmap,
    trackPdfDoc:     trackPdfDoc,  untrackPdfDoc:   untrackPdfDoc,
    trackListener:   trackListener,untrackListener: untrackListener,
    trackGeneric:    trackGeneric, untrackGeneric:  untrackGeneric,
    // Cleanup
    cleanupAll:      cleanupAll,
    lightCleanup:    lightCleanup,
    // Stats
    getStats:        getStats,
  };

  console.debug('[RuntimeCleanup] ready — T027 cleanup engine active');
}());

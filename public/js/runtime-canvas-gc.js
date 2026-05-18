// runtime-canvas-gc.js — Canvas Auto-GC (Phase 2D)
// ADDITIVE ONLY. Tracks all canvases globally beyond what CanvasPool manages:
// detached canvases, large retained surfaces, hidden render surfaces.
// Prevents memory snowballing across tool transitions.
//
// window.RuntimeCanvasGC — public API
(function () {
  'use strict';

  if (window.RuntimeCanvasGC) return;

  var LOG     = '[RCG]';
  var VERSION = '1.0.0';

  // ── Thresholds ───────────────────────────────────────────────────────────────
  var LARGE_CANVAS_PX   = 2 * 1024 * 1024;  // > 2 MP = large
  var HUGE_CANVAS_PX    = 8 * 1024 * 1024;  // > 8 MP = huge — force release
  var CANVAS_MAX_AGE_MS = 5 * 60 * 1000;    // 5 min retained → GC candidate
  var MAX_POOLED_LARGE  = 2;                 // max large canvases in pool at once

  // ── Tracked canvas registry ───────────────────────────────────────────────────
  // Map<id, { canvas, ts, label, released, px }>
  var _tracked  = new Map();
  var _nextId   = 1;
  var _stats    = { tracked: 0, gcReleased: 0, forcedZeroed: 0, errors: 0, peakPx: 0 };

  // ── Register a canvas for GC tracking ────────────────────────────────────────
  // Returns handle { id, done() }
  function track(canvas, label) {
    if (!canvas) return { id: -1, done: function () {} };
    var id  = _nextId++;
    var px  = (canvas.width || 0) * (canvas.height || 0);
    var entry = {
      id:       id,
      canvas:   canvas,
      ts:       Date.now(),
      label:    label || 'canvas-' + id,
      released: false,
      px:       px,
    };
    _tracked.set(id, entry);
    _stats.tracked++;
    if (px > _stats.peakPx) _stats.peakPx = px;

    return {
      id: id,
      done: function () {
        entry.released = true;
        _tracked.delete(id);
      },
    };
  }

  // ── Zero-out a canvas to release its GPU texture ─────────────────────────────
  function _releaseCanvas(canvas, reason) {
    try {
      canvas.width  = 0;
      canvas.height = 0;
      _stats.forcedZeroed++;
    } catch (e) {
      _stats.errors++;
    }
  }

  // ── Compute total tracked pixel count ────────────────────────────────────────
  function _totalPixels() {
    var total = 0;
    _tracked.forEach(function (entry) {
      if (!entry.released) {
        try { total += (entry.canvas.width || 0) * (entry.canvas.height || 0); } catch (_) {}
      }
    });
    return total;
  }

  // ── Sweep: find and GC stale / huge canvases ─────────────────────────────────
  function sweep() {
    var now     = Date.now();
    var cleaned = 0;
    var largeCount = 0;

    // First pass: count large canvases to enforce max pooled
    _tracked.forEach(function (entry) {
      if (!entry.released) {
        try {
          var px = (entry.canvas.width || 0) * (entry.canvas.height || 0);
          if (px > LARGE_CANVAS_PX) largeCount++;
        } catch (_) {}
      }
    });

    _tracked.forEach(function (entry, id) {
      if (entry.released) { _tracked.delete(id); return; }

      var age = now - entry.ts;
      var px;
      try { px = (entry.canvas.width || 0) * (entry.canvas.height || 0); } catch (_) { px = 0; }

      var shouldGC = false;
      var reason   = '';

      // Huge canvas — always force-zero
      if (px > HUGE_CANVAS_PX) {
        shouldGC = true; reason = 'huge:' + Math.round(px / 1e6) + 'MP';
      }
      // Old large canvas
      else if (px > LARGE_CANVAS_PX && age > CANVAS_MAX_AGE_MS) {
        shouldGC = true; reason = 'stale-large:' + Math.round(age / 1000) + 's';
      }
      // Too many large canvases — trim oldest
      else if (px > LARGE_CANVAS_PX && largeCount > MAX_POOLED_LARGE) {
        shouldGC = true; reason = 'pool-overflow:' + largeCount;
        largeCount--;
      }
      // Any canvas that's been around for max age (detached)
      else if (age > CANVAS_MAX_AGE_MS * 2) {
        shouldGC = true; reason = 'max-age:' + Math.round(age / 1000) + 's';
      }

      if (shouldGC) {
        _tracked.delete(id);
        entry.released = true;
        _releaseCanvas(entry.canvas, reason);
        _stats.gcReleased++;
        cleaned++;
        console.debug(LOG, 'GC', entry.label, '—', reason, '(' + Math.round(px / 1000) + 'K px)');
      }
    });

    if (cleaned > 0) {
      console.info(LOG, 'sweep GC\'d', cleaned, 'canvases, remaining tracked:', _tracked.size);
      try {
        if (window.RuntimeEventBus) window.RuntimeEventBus.emit('canvas:gc', { count: cleaned });
      } catch (_) {}
    }

    // Also flush CanvasPool large bucket under pressure
    _gcCanvasPoolPressure();

    return cleaned;
  }

  // ── Flush CanvasPool under memory pressure ────────────────────────────────────
  function _gcCanvasPoolPressure() {
    try {
      var CP = window.CanvasPool;
      if (!CP) return;
      var s = CP.stats();
      // If pooled count is high, flush
      if (s.pooled > 4) {
        CP.flushPool();
        console.debug(LOG, 'flushed CanvasPool (' + s.pooled + ' pooled canvases)');
      }
    } catch (_) {}
  }

  // ── Document-level canvas census ─────────────────────────────────────────────
  // Scans all canvas elements in the DOM and reports large ones.
  function census() {
    var result = { total: 0, large: 0, huge: 0, totalMp: 0 };
    try {
      var canvases = document.querySelectorAll('canvas');
      result.total = canvases.length;
      canvases.forEach(function (c) {
        var px = (c.width || 0) * (c.height || 0);
        result.totalMp += px / 1e6;
        if (px > LARGE_CANVAS_PX) result.large++;
        if (px > HUGE_CANVAS_PX)  result.huge++;
      });
      result.totalMp = Math.round(result.totalMp * 10) / 10;
    } catch (_) {}
    return result;
  }

  // ── Nuke all (panic / soft reset) ────────────────────────────────────────────
  function nukeAll(reason) {
    var count = 0;
    _tracked.forEach(function (entry) {
      if (!entry.released) {
        _releaseCanvas(entry.canvas, 'nukeAll:' + (reason || 'reset'));
        count++;
      }
    });
    _tracked.clear();
    // Also flush CanvasPool
    try { if (window.CanvasPool) window.CanvasPool.flushPool(); } catch (_) {}
    console.info(LOG, 'nukeAll:', count, 'canvases zeroed. Reason:', reason);
    return count;
  }

  function getStats() {
    var c = census();
    return Object.assign({}, _stats, {
      tracked:     _tracked.size,
      totalPixels: _totalPixels(),
      domCensus:   c,
      version:     VERSION,
    });
  }

  // ── Sweep loop (every 60s) ────────────────────────────────────────────────────
  var _sweepTimer = setInterval(function () {
    try { sweep(); } catch (_) {}
  }, 60000);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimeCanvasGC', _sweepTimer);

  window.addEventListener('pagehide', function () {
    try { nukeAll('pagehide'); } catch (_) {}
  }, { passive: true });

  window.RuntimeCanvasGC = {
    track:    track,
    sweep:    sweep,
    census:   census,
    nukeAll:  nukeAll,
    getStats: getStats,
    VERSION:  VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded');
}());

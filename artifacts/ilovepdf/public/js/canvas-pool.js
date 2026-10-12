// Canvas Pool — reusable canvas elements to reduce GPU memory fragmentation.
// Canvases are bucketed by pixel area (small / medium / large). acquireCanvas()
// returns a canvas sized to the requested dimensions; releaseCanvas() returns it
// to the pool or destroys it if the pool bucket is full.
//
// Integration:
//   • MemPressure: flushes large/medium pools under memory stress.
//   • LifecycleManager: flushes all pools on tab hide / pagehide.
//   • TimerRegistry: MemPressure hook deferred-retry interval is registered.
//
// API (window.CanvasPool):
//   acquireCanvas(w, h) → HTMLCanvasElement
//   releaseCanvas(canvas)
//   destroyCanvas(canvas)
//   flushPool() → number destroyed
//   stats() → { created, acquired, released, destroyed, pooled, hits, misses, hitRate }
(function () {
  'use strict';

  var _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // Bucket pixel-area thresholds
  var SMALL  =  262144;  // ≤ 512 × 512
  var MEDIUM = 1048576;  // ≤ 1024 × 1024
  // LARGE: everything above

  // Canvases retained per bucket — lower on mobile to conserve GPU memory
  var MAX_PER_BUCKET = _isMobile ? 2 : 4;

  // Pool buckets: each entry is { canvas, w, h } (w/h at time of release)
  var _pools = { small: [], medium: [], large: [] };
  var _s     = { created: 0, acquired: 0, released: 0, destroyed: 0, hits: 0, misses: 0 };

  function _bucket(w, h) {
    var px = (w || 1) * (h || 1);
    if (px <= SMALL)  return 'small';
    if (px <= MEDIUM) return 'medium';
    return 'large';
  }

  // Acquire a canvas. The returned canvas is sized exactly to (w, h).
  // Resizing an existing canvas clears its content — safe to reuse immediately.
  function acquireCanvas(w, h) {
    w = Math.max(1, Math.round(w || 1));
    h = Math.max(1, Math.round(h || 1));

    var bkt  = _bucket(w, h);
    var pool = _pools[bkt];
    var best = -1, bestScore = Infinity;

    for (var i = 0; i < pool.length; i++) {
      var entry = pool[i];
      // Accept if stored size is within ½× – 2× of requested in each axis.
      // Avoids reusing a 1024-wide canvas for a 10-wide request (waste / distortion).
      var wr = entry.w / w, hr = entry.h / h;
      if (wr >= 0.5 && wr <= 2.0 && hr >= 0.5 && hr <= 2.0) {
        var score = Math.abs(entry.w - w) + Math.abs(entry.h - h);
        if (score < bestScore) { bestScore = score; best = i; }
      }
    }

    var canvas;
    if (best >= 0) {
      canvas        = pool.splice(best, 1)[0].canvas;
      canvas.width  = w; // resize clears content
      canvas.height = h;
      _s.hits++;
    } else {
      canvas        = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      _s.created++;
      _s.misses++;
    }

    _s.acquired++;
    canvas._cpBucket = bkt;
    canvas._cpInPool = false;
    return canvas;
  }

  // Return canvas to the pool. Safe to call multiple times on the same canvas.
  function releaseCanvas(canvas) {
    if (!canvas || canvas._cpInPool) return;
    canvas._cpInPool = true;

    var bkt  = canvas._cpBucket || _bucket(canvas.width, canvas.height);
    var pool = _pools[bkt];

    if (pool.length < MAX_PER_BUCKET && canvas.width > 0 && canvas.height > 0) {
      pool.push({ canvas: canvas, w: canvas.width, h: canvas.height });
      _s.released++;
    } else {
      _rawDestroy(canvas);
    }
  }

  // Destroy a canvas immediately (zero dimensions → GPU texture released).
  function destroyCanvas(canvas) {
    if (!canvas) return;
    canvas._cpInPool = true;
    _rawDestroy(canvas);
  }

  function _rawDestroy(canvas) {
    try { canvas.width = 0; canvas.height = 0; } catch (_) {}
    _s.destroyed++;
  }

  // Flush all pooled canvases. Returns count destroyed.
  function flushPool() {
    var total = 0;
    ['small', 'medium', 'large'].forEach(function (bkt) {
      var pool = _pools[bkt];
      while (pool.length > 0) {
        var e = pool.pop();
        try { e.canvas.width = 0; e.canvas.height = 0; } catch (_) {}
        _s.destroyed++;
        total++;
      }
    });
    return total;
  }

  function stats() {
    return {
      created:  _s.created,
      acquired: _s.acquired,
      released: _s.released,
      destroyed: _s.destroyed,
      hits:     _s.hits,
      misses:   _s.misses,
      pooled:   _pools.small.length + _pools.medium.length + _pools.large.length,
      hitRate:  _s.acquired > 0 ? (_s.hits / _s.acquired * 100).toFixed(1) + '%' : '0%',
    };
  }

  // ── MemPressure integration ───────────────────────────────────────────────
  function _onMemPressure() {
    var mp = window.MemPressure;
    if (!mp) return;
    var t = mp.tier();
    if (t === 'critical' || t === 'abort') {
      flushPool();
    } else if (t === 'low') {
      // Flush large bucket entirely; trim medium to 1
      while (_pools.large.length > 0) _rawDestroy(_pools.large.pop().canvas);
      while (_pools.medium.length > 1) _rawDestroy(_pools.medium.pop().canvas);
    }
  }

  // Deferred hook: MemPressure loads shortly after CanvasPool
  (function () {
    function tryHook() {
      if (window.MemPressure && typeof window.MemPressure.onPressure === 'function') {
        window.MemPressure.onPressure(_onMemPressure);
        return true;
      }
      return false;
    }
    if (!tryHook()) {
      var tries = 0;
      var iv = setInterval(function () {
        if (tryHook() || ++tries > 30) clearInterval(iv);
      }, 250);
      if (window.TimerRegistry) window.TimerRegistry.registerInterval('CanvasPool', iv);
    }
  }());

  window.CanvasPool = { acquireCanvas, releaseCanvas, destroyCanvas, flushPool, stats };
}());

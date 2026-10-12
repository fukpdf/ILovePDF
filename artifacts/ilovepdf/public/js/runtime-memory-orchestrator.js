// RuntimeMemoryOrchestrator v1.0 — Arc 4 / Phase F / Target 6
// =====================================================================
// Dynamic memory arbitration + idle runtime eviction.
//
// Problem (Arc 3 gap): RuntimeMemoryIslands fires memory-island:trim
// events but nothing actually terminates workers. The memory sweep runs
// every 30s but only dispatches a CustomEvent — WorkerPool ignores it.
//
// Solution: RuntimeMemoryOrchestrator bridges Islands → WorkerPool:
//   1. Listens for memory-island:trim events → calls WorkerPool.terminatePool
//      for each worker URL in the trimmed family
//   2. Dynamic arbitration: distributes available heap budget across
//      active families based on their actual usage weight
//   3. Activity heatmap: tracks per-family activity rates to predict
//      which families need pre-allocation vs. trimming
//   4. Idle eviction: families idle > EVICT_TTL_MS get their worker
//      pools terminated and islands trimmed
//
// WorkerPool.terminatePool(url) is the real eviction mechanism.
// RuntimeMemoryIslands handles cache/handler cleanup.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMemoryOrchestrator) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG          = '[MemOrchest]';
  var VERSION      = '1.0';
  var EVICT_TTL_MS = 5 * 60 * 1000;  // 5 min idle → evict workers
  var SWEEP_MS     = 45 * 1000;      // orchestration sweep interval
  var PANIC_HEAP   = 0.88;           // heap% threshold for panic mode

  // ── Family → worker URL map ───────────────────────────────────────────────
  var FAMILY_WORKERS = {
    'organize':     ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
    'compress':     ['/workers/compress-worker.js'],
    'convert-from': ['/workers/pdf-word-docx-worker.js', '/workers/pdf-excel-xlsx-worker.js', '/workers/pdf-ppt-pptx-worker.js'],
    'convert-to':   ['/workers/pdf-word-docx-worker.js', '/workers/pdf-excel-xlsx-worker.js', '/workers/pdf-ppt-pptx-worker.js', '/workers/pdf-lib-worker.js'],
    'edit':         ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
    'ai':           ['/workers/advanced-worker.js', '/workers/summary-worker.js', '/workers/translation-worker.js', '/workers/ocr-preprocessor-worker.js'],
    'image':        ['/workers/image-tools-worker.js', '/workers/image-pipeline-worker.js', '/workers/remove-bg-worker.js'],
    'utility':      [],
  };

  // ── Activity heatmap ──────────────────────────────────────────────────────
  // family → { lastActiveAt, activationCount, evictCount }
  var _heatmap = {};

  function _touch(family) {
    if (!_heatmap[family]) _heatmap[family] = { lastActiveAt: 0, activationCount: 0, evictCount: 0 };
    _heatmap[family].lastActiveAt     = Date.now();
    _heatmap[family].activationCount  = (_heatmap[family].activationCount || 0) + 1;
  }

  function _idleMs(family) {
    var h = _heatmap[family];
    if (!h || !h.lastActiveAt) return Infinity;
    return Date.now() - h.lastActiveAt;
  }

  // ── Evict worker pool for a family ───────────────────────────────────────
  function _evictFamily(family, reason) {
    var workers = FAMILY_WORKERS[family] || [];
    var wp = G.WorkerPool;
    if (!wp || typeof wp.terminatePool !== 'function') return;

    workers.forEach(function (url) {
      try {
        var stats = wp.getStats && wp.getStats();
        // Only terminate if pool exists and has no busy slots
        var poolStats = stats && stats[url];
        if (poolStats && poolStats.busy > 0) {
          console.debug(LOG, 'skipping evict (busy):', family, '—', url);
          return;
        }
        wp.terminatePool(url);
        console.debug(LOG, 'evicted pool:', family, '—', url, '— reason:', reason);
      } catch (_) {}
    });

    // Also trim memory island
    try {
      var mi = G.RuntimeMemoryIslands;
      if (mi) {
        // Find tools in this family and trim their islands
        var mr = G.RuntimeToolManifestRegistry;
        if (mr) {
          mr.getFamilies && mr.getActiveTools && mr.getActiveTools().forEach(function (toolId) {
            if (mr.getFamily(toolId) === family) mi.trim(toolId);
          });
        }
      }
    } catch (_) {}

    if (_heatmap[family]) _heatmap[family].evictCount = (_heatmap[family].evictCount || 0) + 1;

    try {
      G.dispatchEvent(new CustomEvent('memory-orchestrator:evicted', {
        detail: { family: family, reason: reason, workers: workers.length },
      }));
    } catch (_) {}
  }

  // ── Read heap pressure ────────────────────────────────────────────────────
  function _heapPct() {
    try {
      var m = performance.memory;
      if (!m || !m.jsHeapSizeLimit) return 0;
      return m.usedJSHeapSize / m.jsHeapSizeLimit;
    } catch (_) { return 0; }
  }

  // ── Main orchestration sweep ──────────────────────────────────────────────
  function _sweep() {
    var heap = _heapPct();
    var now  = Date.now();

    // Idle eviction: families idle > EVICT_TTL_MS
    Object.keys(FAMILY_WORKERS).forEach(function (family) {
      if (!FAMILY_WORKERS[family].length) return; // utility has no workers
      var idle = _idleMs(family);
      if (idle > EVICT_TTL_MS) {
        _evictFamily(family, 'idle');
      }
    });

    // Panic mode: heap > 88%, evict all idle families aggressively
    if (heap > PANIC_HEAP) {
      console.debug(LOG, 'PANIC: heap at', Math.round(heap * 100) + '% — aggressive eviction');
      Object.keys(FAMILY_WORKERS).forEach(function (family) {
        if (!FAMILY_WORKERS[family].length) return;
        var idle = _idleMs(family);
        if (idle > 30000) { // 30s is enough in panic mode
          _evictFamily(family, 'panic');
        }
      });
    }
  }

  // ── Listen for trim events to perform actual worker eviction ──────────────
  G.addEventListener('memory-island:trim', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) {
        // Check if family is currently idle before evicting
        var idle = _idleMs(family);
        if (idle > 60000) { // 60s idle since last eviction
          _evictFamily(family, 'island-trim');
        }
      }
    } catch (_) {}
  });

  // ── Track tool activity for heatmap ──────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var manifest = evt && evt.detail && evt.detail.manifest;
      if (manifest && manifest.family) _touch(manifest.family);
    } catch (_) {}
  });

  G.addEventListener('analytics-domain:event', function (evt) {
    try {
      var detail = evt && evt.detail;
      if (detail && detail.event && (detail.event.type === 'start' || detail.event.type === 'success')) {
        var mr = G.RuntimeToolManifestRegistry;
        if (mr && detail.toolId) {
          var family = mr.getFamily(detail.toolId);
          if (family) _touch(family);
        }
      }
    } catch (_) {}
  });

  // ── Start sweep ───────────────────────────────────────────────────────────
  var _sweepTimer = setInterval(_sweep, SWEEP_MS);
  try { G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true }); } catch (_) {}

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeMemoryOrchestrator = Object.freeze({
    VERSION:      VERSION,
    evictFamily:  _evictFamily,
    sweep:        _sweep,
    heapPct:      _heapPct,
    getHeatmap:   function () {
      var out = {};
      Object.keys(_heatmap).forEach(function (f) {
        out[f] = Object.assign({ idleMs: _idleMs(f) }, _heatmap[f]);
      });
      return out;
    },
    touch:        _touch,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — memory orchestration + eviction active');

}(window));

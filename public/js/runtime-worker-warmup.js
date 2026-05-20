// RuntimeWorkerWarmup v1.0 — Performance Layer
// =====================================================================
// Pre-spawns high-frequency workers during browser idle time to
// eliminate cold-start latency on first tool use. Workers are
// initialized (WASM parsed + JIT-compiled), held for 45 s, then
// terminated if not claimed by the actual tool runtime.
//
// Strategy:
//   • Only warms workers on mid/high-tier devices (no extra pressure
//     on weak/low-memory devices).
//   • Uses requestIdleCallback so startup cost is zero for page load.
//   • Sends a {type:'warmup'} probe; workers that ignore it are still
//     loaded into the browser's module cache — no error on either side.
//   • If RuntimeTelemetry is present, latencies are recorded.
//
// Workers warmed (ordered by global usage frequency):
//   1. pdf-worker.js          — PDF processing (merge/split/compress…)
//   2. compress-worker.js     — Compression (images + PDFs)
//   3. image-pipeline-worker.js — Image tools (resize/crop/filters)
//
// Exposed as: window.RuntimeWorkerWarmup
//   .status()     — { workers: [{url, state, warmMs}] }
//   .release(url) — force-release a warmup worker back to pool
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerWarmup) return;

  var LOG           = '[RWW]';
  var WARMUP_TTL_MS = 45000;  // keep warm workers alive 45 s
  var WARMUP_DELAY  = 3500;   // start after 3.5 s (page settled)

  // Workers to warm, in priority order
  var WARMUP_TARGETS = [
    { url: '/workers/pdf-worker.js',            key: 'pdf'   },
    { url: '/workers/compress-worker.js',       key: 'comp'  },
    { url: '/workers/image-pipeline-worker.js', key: 'img'   },
  ];

  // Registry: key → { worker, state, url, startTs, warmMs, ttlId }
  var _pool = {};
  var _booted = false;

  // ── Device tier check ────────────────────────────────────────────────────
  function _shouldWarm() {
    try {
      // Skip on low-memory devices entirely
      var mem = navigator.deviceMemory || 4;
      if (mem < 2) return false;

      // Use RuntimeAdaptivePipeline device tier if available
      if (G.RuntimeAdaptivePipeline) {
        var prof = G.RuntimeAdaptivePipeline.getProfile();
        if (prof.deviceTier === 'low') return false;
      }
      // Use RuntimeAIScheduler score if available
      if (G.RuntimeAIScheduler) {
        var dp = G.RuntimeAIScheduler.getDeviceProfile();
        if ((dp.score || 50) < 35) return false;
      }
      return true;
    } catch (_) { return false; }
  }

  // ── Spawn one warmup worker ───────────────────────────────────────────────
  function _warmWorker(target) {
    var key = target.key;
    if (_pool[key] && _pool[key].state !== 'terminated') return;

    var startTs = Date.now();
    var entry = { url: target.url, key: key, state: 'spawning', worker: null, startTs: startTs, warmMs: -1, ttlId: null };
    _pool[key] = entry;

    try {
      var w = new Worker(target.url);
      entry.worker = w;

      w.onmessage = function () {
        if (entry.state === 'spawning') {
          entry.state  = 'warm';
          entry.warmMs = Date.now() - startTs;
          console.debug(LOG, 'warm:', key, entry.warmMs + 'ms');
          if (G.RuntimeTelemetry) {
            try { G.RuntimeTelemetry.record('worker:warmup', { key: key, warmMs: entry.warmMs }); } catch (_) {}
          }
        }
      };

      w.onerror = function () {
        entry.state = 'error';
        _clearTtl(entry);
      };

      // Send warmup probe — workers that handle it reply; others just load
      try { w.postMessage({ type: 'warmup', ts: startTs }); } catch (_) {}

      // Mark warm after 2 s even without a reply (JS+WASM parsed by then)
      setTimeout(function () {
        if (entry.state === 'spawning') {
          entry.state  = 'warm';
          entry.warmMs = Date.now() - startTs;
          console.debug(LOG, 'warm (passive):', key, entry.warmMs + 'ms');
        }
      }, 2000);

      // TTL: terminate after WARMUP_TTL_MS if not claimed
      entry.ttlId = setTimeout(function () {
        _terminateEntry(entry, 'ttl');
      }, WARMUP_TTL_MS);

    } catch (err) {
      entry.state = 'error';
      console.debug(LOG, 'warmup failed:', key, err.message);
    }
  }

  function _clearTtl(entry) {
    if (entry.ttlId) { clearTimeout(entry.ttlId); entry.ttlId = null; }
  }

  function _terminateEntry(entry, reason) {
    _clearTtl(entry);
    if (entry.worker && entry.state !== 'terminated') {
      try { entry.worker.terminate(); } catch (_) {}
      entry.state = 'terminated';
      console.debug(LOG, 'released:', entry.key, '(' + reason + ')');
    }
  }

  // ── Boot (idle-scheduled) ────────────────────────────────────────────────
  function _boot() {
    if (_booted) return;
    _booted = true;

    if (!_shouldWarm()) {
      console.debug(LOG, 'skipped — low-end device');
      return;
    }

    var startAll = function () {
      WARMUP_TARGETS.forEach(function (t, i) {
        setTimeout(function () { _warmWorker(t); }, i * 400);
      });
      console.debug(LOG, 'warmup started for', WARMUP_TARGETS.length, 'workers');
    };

    if ('requestIdleCallback' in G) {
      requestIdleCallback(startAll, { timeout: 6000 });
    } else {
      setTimeout(startAll, WARMUP_DELAY);
    }
  }

  // ── Cleanup on navigation ────────────────────────────────────────────────
  G.addEventListener('pagehide', function () {
    Object.keys(_pool).forEach(function (k) { _terminateEntry(_pool[k], 'pagehide'); });
  }, { passive: true });

  // ── Public API ───────────────────────────────────────────────────────────
  G.RuntimeWorkerWarmup = {
    status: function () {
      return {
        workers: Object.keys(_pool).map(function (k) {
          var e = _pool[k];
          return { url: e.url, key: e.key, state: e.state, warmMs: e.warmMs };
        }),
      };
    },
    release: function (key) {
      if (_pool[key]) _terminateEntry(_pool[key], 'manual-release');
    },
  };

  // ── Init ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, WARMUP_DELAY); }, { once: true });
  } else {
    setTimeout(_boot, WARMUP_DELAY);
  }

  console.debug(LOG, 'RuntimeWorkerWarmup v1.0 loaded');

}(window));

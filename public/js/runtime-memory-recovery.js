// runtime-memory-recovery.js — Phase 9 memory pressure recovery
// Responds to memory pressure events (device memory, heap thresholds) by
// evicting IDB/OPFS caches, dropping blob URLs, and signalling the advanced
// engine to reduce concurrency. Registers on window.RuntimeMemoryRecovery.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeMemoryRecovery) return;

  var _recoveries = 0;
  var _lastRecovery = 0;
  var _COOLDOWN_MS = 15000; // minimum 15 s between recovery runs

  // ── Tracked blob URLs ─────────────────────────────────────────────────────
  var _blobs = new Set();
  function trackBlob(url) { _blobs.add(url); }
  function releaseBlobs() {
    var released = 0;
    _blobs.forEach(function (url) {
      try { URL.revokeObjectURL(url); released++; } catch (_) {}
    });
    _blobs.clear();
    return released;
  }

  // ── IDB cache eviction ────────────────────────────────────────────────────
  function evictIdbCache() {
    try {
      if (G.IDBCache && typeof G.IDBCache.clear === 'function') {
        G.IDBCache.clear().catch(function () {});
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ── OPFS cleanup ──────────────────────────────────────────────────────────
  function evictOpfsStaging() {
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        navigator.storage.getDirectory().then(function (root) {
          var iter = root.values ? root.values() : null;
          if (!iter) return;
          (function next() {
            iter.next().then(function (r) {
              if (r.done) return;
              var h = r.value;
              if (h && /^ae_stage_/.test(h.name)) root.removeEntry(h.name).catch(function () {});
              next();
            }).catch(function () {});
          }());
        }).catch(function () {});
      }
    } catch (_) {}
  }

  // ── Reduce advanced-engine concurrency ───────────────────────────────────
  function throttleEngines() {
    try {
      if (G.WorkerPool && typeof G.WorkerPool.setMaxPerUrl === 'function') {
        G.WorkerPool.setMaxPerUrl(1);
      }
    } catch (_) {}
  }

  // ── Emit telemetry ────────────────────────────────────────────────────────
  function _emit(level, detail) {
    try {
      var st = G.SecurityTelemetry;
      if (st && typeof st.record === 'function') {
        st.record('memory-recovery', { level: level, detail: detail, recoveries: _recoveries });
      }
    } catch (_) {}
  }

  // ── Core recovery routine ─────────────────────────────────────────────────
  function recover(reason) {
    var now = Date.now();
    if (now - _lastRecovery < _COOLDOWN_MS) return false;
    _lastRecovery = now;
    _recoveries++;

    var released = releaseBlobs();
    var evictedIdb = evictIdbCache();
    evictOpfsStaging();
    throttleEngines();

    _emit('warn', { reason: reason, blobsReleased: released, idbEvicted: evictedIdb });
    console.info('[RuntimeMemoryRecovery] recovery #' + _recoveries +
      ' reason=' + reason + ' blobs=' + released + ' idb=' + evictedIdb);
    return true;
  }

  // ── Device memory pressure listener (Chrome 75+) ─────────────────────────
  function _startPressureObserver() {
    try {
      if (G.MemoryMeasurement || !('requestStorageAccess' in document)) return;
      if (typeof G.performance !== 'undefined' && G.performance.memory) {
        setInterval(function () {
          var m = G.performance.memory;
          if (!m) return;
          var ratio = m.usedJSHeapSize / (m.jsHeapSizeLimit || 1);
          if (ratio > 0.80) recover('heap-pressure-' + Math.round(ratio * 100) + 'pct');
        }, 10000);
      }
    } catch (_) {}
  }

  // ── Memory pressure event (iOS Safari 15+ / Chrome) ──────────────────────
  if (typeof window.addEventListener === 'function') {
    try {
      window.addEventListener('memorypressure', function (e) {
        var level = (e && e.level) || 'critical';
        recover('os-' + level);
      });
    } catch (_) {}
  }

  _startPressureObserver();

  G.RuntimeMemoryRecovery = Object.freeze({
    recover:     recover,
    trackBlob:   trackBlob,
    releaseBlobs:releaseBlobs,
    getStats: function () {
      return { recoveries: _recoveries, trackedBlobs: _blobs.size, lastRecovery: _lastRecovery };
    },
  });
}());

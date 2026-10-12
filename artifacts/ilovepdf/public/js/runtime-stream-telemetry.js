// RuntimeStreamTelemetry v1.0 — Arc 7 / Phase F
// =====================================================================
// Streaming metrics engine. Distinct from RuntimeTelemetry (event-based
// counters) and RuntimeTelemetryEnterprise (security telemetry) — this
// manages TIME-SERIES data with live histograms and ring buffers.
//
//   - Streaming metrics: ring-buffer time series (last N samples)
//   - Live worker throughput: bytes/sec, pages/sec per worker family
//   - Execution FPS: rAF-based render rate monitor
//   - Hydration timing graph: P0/P1/P2 activation latency tracking
//   - Chunk execution analytics: per-chunk timing histograms
//   - Latency histograms: p50/p90/p99 percentile computation
//   - window.getStreamTelemetry() for console/dashboard access
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStreamTelemetry) return;

  var LOG     = '[StreamTelemetry]';
  var VERSION = '1.0';

  // ── Ring-buffer factory ───────────────────────────────────────────
  function RingBuffer(size) {
    var buf = [];
    return {
      push: function (v) { buf.push(v); if (buf.length > size) buf.shift(); },
      toArray: function () { return buf.slice(); },
      last: function (n) { return buf.slice(-n); },
      length: function () { return buf.length; },
      clear: function () { buf = []; },
    };
  }

  // ── Percentile computation ────────────────────────────────────────
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var idx    = Math.max(0, Math.ceil(sorted.length * p / 100) - 1);
    return sorted[idx];
  }

  function histStats(arr) {
    if (!arr.length) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0, count: 0 };
    var sum = arr.reduce(function (a, b) { return a + b; }, 0);
    return {
      count: arr.length,
      min:   Math.min.apply(null, arr),
      max:   Math.max.apply(null, arr),
      avg:   Math.round(sum / arr.length),
      p50:   percentile(arr, 50),
      p90:   percentile(arr, 90),
      p99:   percentile(arr, 99),
    };
  }

  // ── Metric stores ─────────────────────────────────────────────────
  var RING_SIZE = 120;  // ~2 min of per-second samples
  var _series   = {};   // name → RingBuffer
  var _hist     = {};   // name → RingBuffer (for latency histograms)
  var _counters = {};   // name → number
  var _families = {};   // family → { bytesTotal, pagesTotal, lastSampleAt, throughputBps, throughputPps }

  function _getSeries(name) {
    if (!_series[name]) _series[name] = RingBuffer(RING_SIZE);
    return _series[name];
  }

  function _getHist(name) {
    if (!_hist[name]) _hist[name] = RingBuffer(RING_SIZE);
    return _hist[name];
  }

  // ── Record a measurement ──────────────────────────────────────────
  function record(name, value) {
    _getSeries(name).push({ ts: Date.now(), v: value });
  }

  function increment(name, delta) {
    _counters[name] = (_counters[name] || 0) + (delta || 1);
  }

  function recordLatency(name, ms) {
    _getHist(name).push(ms);
  }

  function recordBytes(family, bytes, pages) {
    if (!_families[family]) _families[family] = { bytesTotal: 0, pagesTotal: 0,
      lastSampleAt: 0, throughputBps: 0, throughputPps: 0, _bytesWindow: RingBuffer(30) };
    var f = _families[family];
    f.bytesTotal += (bytes || 0);
    f.pagesTotal += (pages || 0);
    var now = Date.now();
    var gap = now - (f.lastSampleAt || now);
    if (gap > 0) {
      f.throughputBps = Math.round((bytes || 0) / (gap / 1000));
      f.throughputPps = pages ? Math.round((pages || 0) / (gap / 1000)) : 0;
    }
    f.lastSampleAt = now;
    f._bytesWindow.push({ ts: now, bytes: bytes || 0 });
  }

  // ── Hydration timing graph ────────────────────────────────────────
  var _hydrationGraph = {
    P0: RingBuffer(50), P1: RingBuffer(50), P2: RingBuffer(50),
  };

  function recordHydration(tier, durationMs) {
    var buf = _hydrationGraph[tier];
    if (buf) buf.push({ ts: Date.now(), ms: durationMs });
    recordLatency('hydration:' + tier, durationMs);
  }

  // ── Execution FPS monitor ─────────────────────────────────────────
  var _fps       = 0;
  var _fpsFrames = 0;
  var _fpsSeries = RingBuffer(60);
  var _lastFpsT  = 0;
  var _rafRunning = false;

  function _rafLoop(ts) {
    if (!_rafRunning) return;
    _fpsFrames++;
    if (!_lastFpsT) { _lastFpsT = ts; }
    var elapsed = ts - _lastFpsT;
    if (elapsed >= 1000) {
      _fps = Math.round(_fpsFrames * 1000 / elapsed);
      _fpsSeries.push({ ts: Date.now(), fps: _fps });
      _fpsFrames = 0;
      _lastFpsT  = ts;
    }
    G.requestAnimationFrame(_rafLoop);
  }

  function startFpsMonitor() {
    if (_rafRunning) return;
    _rafRunning = true;
    G.requestAnimationFrame(_rafLoop);
  }

  function stopFpsMonitor() {
    _rafRunning = false;
  }

  // ── Hook into Arc 7 events ────────────────────────────────────────
  G.addEventListener('streaming-hydration:viewport', function (evt) {
    try { increment('hydration:viewport', 1); } catch (_) {}
  });

  G.addEventListener('processor-hydration:activated', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d) recordHydration(d.tier || 'P2', d.durationMs || 0);
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d) record('stream-workers:pct', d.pct);
    } catch (_) {}
  });

  G.addEventListener('predictive-loader:preload', function (evt) {
    try { increment('predictive:preloads', 1); } catch (_) {}
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    try { increment('memory:panics', 1); } catch (_) {}
  });

  G.addEventListener('processor-workers:isolated', function (evt) {
    try { increment('workers:isolated', 1); } catch (_) {}
  });

  // ── Aggregated telemetry snapshot ─────────────────────────────────
  function getSnapshot() {
    var hydStats = {};
    ['P0', 'P1', 'P2'].forEach(function (tier) {
      hydStats[tier] = histStats(_hydrationGraph[tier].toArray().map(function (e) { return e.ms; }));
    });

    var histSnap = {};
    Object.keys(_hist).forEach(function (name) {
      histSnap[name] = histStats(_hist[name].toArray());
    });

    var familySnap = {};
    Object.keys(_families).forEach(function (f) {
      var fam = _families[f];
      familySnap[f] = {
        bytesTotal:   fam.bytesTotal,
        pagesTotal:   fam.pagesTotal,
        throughputBps: fam.throughputBps,
        throughputPps: fam.throughputPps,
      };
    });

    return {
      ts:          Date.now(),
      fps:         _fps,
      fpsSeries:   _fpsSeries.last(10),
      counters:    Object.assign({}, _counters),
      hydration:   hydStats,
      histograms:  histSnap,
      families:    familySnap,
    };
  }

  // Expose for console/dashboard
  G.getStreamTelemetry = function () { return getSnapshot(); };

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    startFpsMonitor();
    console.debug(LOG, 'v' + VERSION + ' ready — FPS monitor active | window.getStreamTelemetry() available');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeStreamTelemetry = Object.freeze({
    VERSION:         VERSION,
    record:          record,
    increment:       increment,
    recordLatency:   recordLatency,
    recordBytes:     recordBytes,
    recordHydration: recordHydration,
    startFpsMonitor: startFpsMonitor,
    stopFpsMonitor:  stopFpsMonitor,
    getSnapshot:     getSnapshot,
    getFps:          function () { return _fps; },
    getHist:         function (name) { return histStats((_hist[name] || RingBuffer(1)).toArray()); },
    getSeries:       function (name) { return (_series[name] || { toArray: function() { return []; } }).toArray(); },
    getCounters:     function () { return Object.assign({}, _counters); },
  });

}(window));

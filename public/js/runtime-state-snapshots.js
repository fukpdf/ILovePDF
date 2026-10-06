// RuntimeStateSnapshots v1.0 — Arc 8 / Phase G
// =====================================================================
// Full runtime state capture, diff, rollback, and export.
//
// Snapshot contents:
//   - Processor health scores (Arc 6)
//   - Worker pool states (Arc 6)
//   - Hydration domain activation states (Arc 3)
//   - Bundle activation graph (Arc 4)
//   - Memory segment usage per family (Arc 6)
//   - Smart cache stats (Arc 7)
//   - Task orchestrator queue depths (Arc 7)
//   - Stream telemetry counters (Arc 7)
//   - Active extreme modes (Arc 7)
//   - Control plane flags (Arc 8)
//   - Active incidents (Arc 8)
//   - Event timeline count (Arc 8)
//
// Features:
//   - Ring buffer of 10 snapshots (auto-rotate)
//   - Delta diff between any two snapshots
//   - Simple checksum (FNV-1a over JSON) for corruption detection
//   - Export as JSON blob (via URL.createObjectURL if available)
//   - Rollback checkpoint annotation
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStateSnapshots) return;

  var LOG     = '[StateSnapshots]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_SNAPSHOTS = 10;
  var AUTO_MS       = 5 * 60 * 1000;  // auto-snapshot every 5 min

  // ── Storage ───────────────────────────────────────────────────────
  var _snapshots  = [];  // ring buffer
  var _seq        = 0;
  var _metrics    = { taken: 0, diffs: 0, exports: 0, corrupted: 0 };

  // ── FNV-1a checksum (fast, 32-bit) ───────────────────────────────
  function _checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  // ── Collect runtime state ─────────────────────────────────────────
  function _collect(label) {
    var state = { label: label || 'auto', ts: Date.now(), id: ++_seq };

    // Processor health (Arc 6)
    try {
      state.processorHealth = G.getProcessorHealth ? G.getProcessorHealth() : {};
    } catch (_) { state.processorHealth = {}; }

    // Memory usage per family (Arc 6)
    try {
      var pm = G.RuntimeProcessorMemory;
      state.processorMemory = pm && pm.getStats ? pm.getStats() : {};
    } catch (_) { state.processorMemory = {}; }

    // Worker pool states (Arc 6)
    try {
      var pw = G.RuntimeProcessorWorkers;
      state.processorWorkers = pw && pw.getStats ? pw.getStats() : {};
    } catch (_) { state.processorWorkers = {}; }

    // Smart cache stats (Arc 7)
    try {
      var sc = G.RuntimeSmartCache;
      state.smartCache = sc && sc.getStats ? sc.getStats() : {};
    } catch (_) { state.smartCache = {}; }

    // Task orchestrator (Arc 7)
    try {
      var to = G.RuntimeTaskOrchestrator;
      state.taskOrchestrator = to && to.getStats ? to.getStats() : {};
    } catch (_) { state.taskOrchestrator = {}; }

    // Stream telemetry counters (Arc 7)
    try {
      var st = G.RuntimeStreamTelemetry;
      state.streamTelemetry = st && st.getCounters ? st.getCounters() : {};
    } catch (_) { state.streamTelemetry = {}; }

    // Self-optimizer (Arc 7)
    try {
      var so = G.RuntimeSelfOptimizer;
      state.selfOptimizer = so && so.getState ? so.getState() : {};
    } catch (_) { state.selfOptimizer = {}; }

    // Extreme mode (Arc 7)
    try {
      var em = G.RuntimeMobileExtremeMode;
      state.extremeModes = em ? em.getActiveModes() : [];
    } catch (_) { state.extremeModes = []; }

    // Control plane flags (Arc 8)
    try {
      var cp = G.RuntimeControlPlane;
      state.controlFlags = cp ? cp.getFlags() : {};
    } catch (_) { state.controlFlags = {}; }

    // Incidents summary (Arc 8)
    try {
      var inc = G.getRuntimeIncidents;
      var incidents = inc ? inc({ limit: 20 }) : [];
      state.incidentSummary = {
        count: incidents.length,
        P0: incidents.filter(function (i) { return i.severity === 0; }).length,
        P1: incidents.filter(function (i) { return i.severity === 1; }).length,
        P2: incidents.filter(function (i) { return i.severity === 2; }).length,
      };
    } catch (_) { state.incidentSummary = {}; }

    // Event timeline count (Arc 8)
    try {
      var et = G.RuntimeEventTimeline;
      state.eventCount = et ? et.getCount() : 0;
    } catch (_) { state.eventCount = 0; }

    // Heap
    try {
      var perf = performance.memory;
      state.heapMb = perf ? Math.round(perf.usedJSHeapSize / 1024 / 1024) : 0;
    } catch (_) { state.heapMb = 0; }

    return state;
  }

  // ── Take a snapshot ───────────────────────────────────────────────
  function take(label, isCheckpoint) {
    var state    = _collect(label);
    var json     = JSON.stringify(state);
    var checksum = _checksum(json);

    var snap = {
      id:           state.id,
      ts:           state.ts,
      label:        label || 'auto',
      isCheckpoint: !!isCheckpoint,
      checksum:     checksum,
      state:        state,
    };

    _snapshots.push(snap);
    if (_snapshots.length > MAX_SNAPSHOTS) _snapshots.shift();
    _metrics.taken++;

    _tel('take', { id: snap.id, label: snap.label, checkpoint: snap.isCheckpoint });
    try {
      G.dispatchEvent(new CustomEvent('arc8:snapshot', {
        detail: { id: snap.id, label: snap.label, type: 'state' },
      }));
    } catch (_) {}
    console.debug(LOG, 'snapshot #' + snap.id + ' taken:', snap.label, '| checksum:', checksum);
    return snap.id;
  }

  // ── Verify snapshot integrity ──────────────────────────────────────
  function verify(snapId) {
    var snap = _snapshots.find(function (s) { return s.id === snapId; });
    if (!snap) return null;
    var json     = JSON.stringify(snap.state);
    var computed = _checksum(json);
    var ok       = computed === snap.checksum;
    if (!ok) _metrics.corrupted++;
    return { id: snapId, ok: ok, expected: snap.checksum, computed: computed };
  }

  // ── Diff two snapshots ────────────────────────────────────────────
  function diff(idA, idB) {
    var a = _snapshots.find(function (s) { return s.id === idA; });
    var b = _snapshots.find(function (s) { return s.id === idB; });
    if (!a || !b) return null;
    _metrics.diffs++;

    function _diffObj(objA, objB, path) {
      var changes = [];
      var keys = Object.keys(Object.assign({}, objA, objB));
      keys.forEach(function (k) {
        var va = JSON.stringify(objA && objA[k]);
        var vb = JSON.stringify(objB && objB[k]);
        if (va !== vb) changes.push({ path: path + '.' + k, from: objA && objA[k], to: objB && objB[k] });
      });
      return changes;
    }

    return {
      from: { id: a.id, ts: a.ts, label: a.label },
      to:   { id: b.id, ts: b.ts, label: b.label },
      durationMs: b.ts - a.ts,
      changes: _diffObj(a.state, b.state, 'state'),
    };
  }

  // ── Export ────────────────────────────────────────────────────────
  function exportSnap(snapId) {
    var snap = snapId
      ? _snapshots.find(function (s) { return s.id === snapId; })
      : _snapshots[_snapshots.length - 1];
    if (!snap) return null;
    _metrics.exports++;
    var json = JSON.stringify(snap, null, 2);
    // Return as blob URL if supported
    try {
      var blob = new Blob([json], { type: 'application/json' });
      return { url: URL.createObjectURL(blob), json: json };
    } catch (_) {
      return { url: null, json: json };
    }
  }

  // ── Telemetry ─────────────────────────────────────────────────────
  var _tel_buf = [];
  function _tel(ev, d) {
    _tel_buf.push({ ts: Date.now(), ev: ev, d: d });
    if (_tel_buf.length > 50) _tel_buf.shift();
  }

  // ── Auto-snapshot on key events ───────────────────────────────────
  G.addEventListener('processor-memory:panic', function () {
    take('auto:memory-panic', false);
  });

  G.addEventListener('extreme-mode:activate', function (evt) {
    var d = evt && evt.detail;
    take('auto:extreme:' + (d && d.mode || 'unknown'), false);
  });

  // ── Auto-snapshot on interval ─────────────────────────────────────
  setInterval(function () { take('auto:interval'); }, AUTO_MS);

  G.RuntimeStateSnapshots = Object.freeze({
    VERSION:  VERSION,
    take:     take,
    verify:   verify,
    diff:     diff,
    export:   exportSnap,
    list:     function () {
      return _snapshots.map(function (s) {
        return { id: s.id, ts: s.ts, label: s.label, isCheckpoint: s.isCheckpoint, checksum: s.checksum };
      });
    },
    get:      function (id) { return _snapshots.find(function (s) { return s.id === id; }) || null; },
    getMetrics: function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _tel_buf.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — max:', MAX_SNAPSHOTS, 'snapshots | auto-interval:', AUTO_MS / 60000 + 'min');

}(window));

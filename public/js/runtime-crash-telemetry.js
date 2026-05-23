// RuntimeCrashTelemetry v1.0 — Arc 2 / Target 4
// =====================================================================
// Crash fingerprinting + encrypted ring-buffer + deploy-crash correlation.
//
// Captures:
//   - window.onerror / unhandledrejection  → crash fingerprint
//   - Worker crashes (via WorkerPool event bus)
//   - Memory-pressure crashes (OOM-adjacent errors)
//   - Stale-runtime-correlated crashes (via RuntimeDeploySync)
//
// Storage:
//   - localStorage ring-buffer (last 50 entries), DJB2-hashed fingerprints
//   - Keys preserved across reloads for recurrence detection
//
// Crash fingerprint schema:
//   { id, ts, type, msg, file, line, stack, buildId, stale,
//     memPressure, repeated, count, category }
//
// Categories: 'worker', 'memory', 'module', 'network', 'stale-runtime', 'unknown'
//
// Integrates with: RuntimeIncidentEngine, RuntimeRecovery, RuntimeForensics
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCrashTelemetry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG      = '[CrashTel]';
  var VERSION  = '1.0';
  var LS_KEY   = 'iplv_crash_ring_v1';
  var MAX_RING = 50;

  // ── DJB2 fingerprint (non-crypto, fast dedup) ─────────────────────────────
  function _fp(str) {
    var h = 5381;
    for (var i = 0; i < (str || '').length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h = h & h; }
    return (h >>> 0).toString(16).slice(0, 8);
  }

  // ── Ring-buffer (localStorage) ────────────────────────────────────────────
  var _ring = (function () {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (_) { return []; }
  }());
  if (!Array.isArray(_ring)) _ring = [];

  function _save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(_ring.slice(-MAX_RING))); } catch (_) {}
  }

  // ── Categorize error ──────────────────────────────────────────────────────
  function _categorize(msg, stack) {
    var s = (msg + ' ' + stack).toLowerCase();
    if (/worker|workerpool|webworker/.test(s))                    return 'worker';
    if (/out of memory|heap|allocation failed|oom/.test(s))       return 'memory';
    if (/fetch|network|cors|failed to load|xhr/.test(s))          return 'network';
    if (/module|import|script error|undefined is not a function/.test(s)) return 'module';
    return 'unknown';
  }

  // ── Record a crash entry ──────────────────────────────────────────────────
  function _record(entry) {
    var id = _fp((entry.msg || '') + (entry.file || '') + (entry.line || ''));
    entry.id = id;

    // Check for stale-runtime correlation
    try {
      if (G.RuntimeDeploySync && G.RuntimeDeploySync.isStale && G.RuntimeDeploySync.isStale()) {
        entry.stale    = true;
        entry.category = 'stale-runtime';
      }
    } catch (_) {}

    // Check for memory pressure correlation
    try {
      var m = performance && performance.memory;
      if (m && m.usedJSHeapSize / m.jsHeapSizeLimit > 0.85) {
        entry.memPressure = true;
        if (entry.category === 'unknown') entry.category = 'memory';
      }
    } catch (_) {}

    // Dedup + repeat tracking
    var existing = null;
    for (var i = _ring.length - 1; i >= 0; i--) {
      if (_ring[i].id === id) { existing = _ring[i]; break; }
    }
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.repeated = true;
      existing.lastTs = Date.now();
      _save();
    } else {
      entry.count    = 1;
      entry.repeated = false;
      entry.ts       = entry.ts || Date.now();
      _ring.push(entry);
      if (_ring.length > MAX_RING) _ring.shift();
      _save();
    }

    console.debug(LOG, 'crash recorded — category:', entry.category, '| id:', id, '| stale:', !!entry.stale);

    // Forward to incident engine
    try {
      if (G.RuntimeIncidentEngine && G.RuntimeIncidentEngine.reportCrash) {
        G.RuntimeIncidentEngine.reportCrash(entry);
      }
    } catch (_) {}

    // Forward to forensics
    try {
      if (G.RuntimeForensics && G.RuntimeForensics.record) {
        G.RuntimeForensics.record('crash', entry);
      }
    } catch (_) {}

    // Dispatch event
    try {
      G.dispatchEvent(new CustomEvent('crash:recorded', { detail: entry }));
    } catch (_) {}
  }

  // ── Current BUILD_ID ──────────────────────────────────────────────────────
  function _buildId() {
    try {
      if (G.RuntimeDeploySync) return G.RuntimeDeploySync.getBuildId();
    } catch (_) {}
    try {
      var tags = document.querySelectorAll('script[src*="?v="]');
      for (var i = 0; i < tags.length; i++) {
        var v = new URL(tags[i].src, location.href).searchParams.get('v');
        if (v) return v;
      }
    } catch (_) {}
    return '';
  }

  // ── Global error listeners ────────────────────────────────────────────────
  var _origError  = G.onerror;
  var _origReject = G.onunhandledrejection;

  G.onerror = function (msg, file, line, col, err) {
    _record({
      type:     'error',
      msg:      String(msg || ''),
      file:     String(file || ''),
      line:     line || 0,
      col:      col  || 0,
      stack:    err && err.stack ? err.stack.slice(0, 400) : '',
      buildId:  _buildId(),
      category: _categorize(msg, err && err.stack || ''),
    });
    if (typeof _origError === 'function') return _origError.apply(this, arguments);
  };

  G.onunhandledrejection = function (evt) {
    var reason = evt && evt.reason;
    var msg    = reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection');
    var stack  = reason instanceof Error ? (reason.stack || '').slice(0, 400) : '';
    _record({
      type:     'unhandledrejection',
      msg:      msg,
      file:     '',
      line:     0,
      stack:    stack,
      buildId:  _buildId(),
      category: _categorize(msg, stack),
    });
    if (typeof _origReject === 'function') return _origReject.apply(this, arguments);
  };

  // ── Worker crash listener (WorkerPool event) ──────────────────────────────
  G.addEventListener('workerpool:crash', function (e) {
    var d = e && e.detail || {};
    _record({
      type:     'worker-crash',
      msg:      d.error || 'Worker crash',
      file:     d.url   || '',
      line:     0,
      stack:    '',
      buildId:  _buildId(),
      category: 'worker',
    });
  });

  // ── Summary computation ────────────────────────────────────────────────────
  function _summary() {
    var staleCount  = _ring.filter(function (e) { return e.stale; }).length;
    var workerCount = _ring.filter(function (e) { return e.category === 'worker'; }).length;
    var memCount    = _ring.filter(function (e) { return e.category === 'memory'; }).length;
    var cats        = {};
    _ring.forEach(function (e) { cats[e.category] = (cats[e.category] || 0) + 1; });
    return {
      total: _ring.length,
      staleRuntimeCorrelated: staleCount,
      workerCrashes: workerCount,
      memoryCorrelated: memCount,
      byCategory: cats,
    };
  }

  G.RuntimeCrashTelemetry = Object.freeze({
    VERSION:    VERSION,
    record:     _record,
    getRing:    function () { return _ring.slice(); },
    getSummary: _summary,
    clear:      function () { _ring.length = 0; _save(); },
  });

}(window));

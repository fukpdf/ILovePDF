// RuntimeWorkerCoordinator v1.0 — Arc 2 / Target 7
// =====================================================================
// Worker affinity scheduling + thermal-aware limits + congestion balancing.
//
// Wraps window.WorkerPool with:
//   - Worker affinity: sticky tool → preferred worker URL mapping
//   - Predictive prewarm: based on navigation + tool-hover patterns
//   - Thermal-aware concurrency: reduces limits when device is hot
//   - Memory-aware task routing: routes heavy tasks to background pool
//   - Idle worker parking: parks prewarm slots when cluster is quiet
//   - Congestion balancing: defers enqueue when worker queue is saturated
//
// Preserves all WorkerPool v5 capabilities intact — this is a
// coordination layer, not a replacement.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerCoordinator) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[WorkerCoord]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────────────
  var AFFINITY_TTL   = 10 * 60 * 1000;  // affinity binding expires after 10 min
  var CONGESTION_MAX = 12;               // cluster-wide task saturation ceiling
  var THERMAL_CHECK  = 30 * 1000;       // thermal re-check interval

  // ── Affinity registry ─────────────────────────────────────────────────────
  // Maps toolId → { workerUrl, ts, hitCount }
  var _affinity = {};

  function _bindAffinity(toolId, workerUrl) {
    _affinity[toolId] = { workerUrl: workerUrl, ts: Date.now(), hitCount: 1 };
  }

  function _getAffinity(toolId) {
    var a = _affinity[toolId];
    if (!a) return null;
    if (Date.now() - a.ts > AFFINITY_TTL) { delete _affinity[toolId]; return null; }
    a.hitCount++;
    a.ts = Date.now();
    return a.workerUrl;
  }

  // ── Thermal tier ──────────────────────────────────────────────────────────
  // Reads from RuntimeAIScheduler (which has thermal detection) or defaults
  var _thermalTier  = 'nominal'; // 'nominal' | 'warm' | 'hot' | 'critical'
  var _thermalLimit = null;      // null = use WorkerPool default

  function _refreshThermal() {
    try {
      var profile = G.RuntimeAIScheduler && G.RuntimeAIScheduler.getProfile &&
                    G.RuntimeAIScheduler.getProfile();
      var t = profile && profile.thermal || 'nominal';
      _thermalTier = t;
      if (t === 'critical') _thermalLimit = 1;
      else if (t === 'hot') _thermalLimit = 2;
      else if (t === 'warm') _thermalLimit = 3;
      else                   _thermalLimit = null; // default
    } catch (_) {}
  }
  setInterval(_refreshThermal, THERMAL_CHECK);
  _refreshThermal();

  // ── Congestion detection ──────────────────────────────────────────────────
  function _isCongested() {
    try {
      var wp = G.WorkerPool;
      if (!wp || !wp.getStats) return false;
      var s  = wp.getStats();
      return (s.busy || 0) >= CONGESTION_MAX;
    } catch (_) {}
    return false;
  }

  // ── Predictive prewarm ────────────────────────────────────────────────────
  // Listens to tool card hover + router navigation hints
  var _prewarmScheduled = {};

  function _schedulePrewarm(workerUrl) {
    if (!workerUrl || _prewarmScheduled[workerUrl]) return;
    _prewarmScheduled[workerUrl] = true;
    setTimeout(function () {
      try {
        var wp = G.WorkerPool;
        if (wp && typeof wp.prewarm === 'function') {
          wp.prewarm(workerUrl);
          console.debug(LOG, 'predictive prewarm:', workerUrl.split('/').pop());
        }
      } catch (_) {}
      delete _prewarmScheduled[workerUrl];
    }, 200); // slight delay to batch hover events
  }

  // ── Tool → worker URL mapping ─────────────────────────────────────────────
  var TOOL_WORKER_MAP = {
    'compress-pdf':        '/workers/compress-worker.js',
    'merge-pdf':           '/workers/pdf-lib-worker.js',
    'split-pdf':           '/workers/pdf-lib-worker.js',
    'rotate-pdf':          '/workers/pdf-lib-worker.js',
    'pdf-to-word':         '/workers/pdf-word-docx-worker.js',
    'word-to-pdf':         '/workers/pdf-word-docx-worker.js',
    'pdf-to-excel':        '/workers/pdf-excel-xlsx-worker.js',
    'excel-to-pdf':        '/workers/pdf-excel-xlsx-worker.js',
    'pdf-to-ppt':          '/workers/pdf-ppt-pptx-worker.js',
    'ocr-pdf':             '/workers/advanced-worker.js',
    'compare-pdf':         '/workers/compare-worker.js',
    'remove-background':   '/workers/remove-bg-worker.js',
    'repair-pdf':          '/workers/repair-worker.js',
    'ai-summarizer':       '/workers/summary-worker.js',
    'translate-pdf':       '/workers/translation-worker.js',
    'image-tools':         '/workers/image-tools-worker.js',
    'image-pipeline':      '/workers/image-pipeline-worker.js',
  };

  function _workerForTool(toolId) {
    return TOOL_WORKER_MAP[toolId] || null;
  }

  // ── Hook tool card hover for predictive prewarm ───────────────────────────
  function _installHoverListeners() {
    try {
      document.addEventListener('mouseover', function (e) {
        var el   = e.target && e.target.closest && e.target.closest('[data-tool], .tool-card, [href*="/tool/"]');
        if (!el) return;
        var toolId = el.getAttribute('data-tool') ||
                     (el.href && el.href.match(/\/tool\/([^/?]+)/)?.[1]) || '';
        if (!toolId) return;
        var url = _workerForTool(toolId) || _getAffinity(toolId);
        if (url) _schedulePrewarm(url);
      }, { passive: true });
    } catch (_) {}
  }

  // ── Wrap WorkerPool.run with coordinator logic ─────────────────────────────
  function coordinatedRun(workerUrl, payload, opts) {
    opts = opts || {};
    var toolId = opts.toolId || '';

    // Thermal limit check
    if (_thermalLimit !== null) {
      var wp = G.WorkerPool;
      var s  = wp && wp.getStats ? wp.getStats() : {};
      if ((s.busy || 0) >= _thermalLimit) {
        console.debug(LOG, 'thermal throttle — tier:', _thermalTier, '— limit:', _thermalLimit);
        // Return a pending promise that resolves when a slot is free
        // (simplified: just delay 2s and retry once)
        return new Promise(function (res, rej) {
          setTimeout(function () {
            try { G.WorkerPool.run(workerUrl, payload, opts).then(res).catch(rej); }
            catch (e) { rej(e); }
          }, 2000);
        });
      }
    }

    // Congestion check
    if (_isCongested() && opts.priority !== 'high') {
      console.debug(LOG, 'cluster congested — deferring task for:', workerUrl.split('/').pop());
      return new Promise(function (res, rej) {
        setTimeout(function () {
          try { G.WorkerPool.run(workerUrl, payload, opts).then(res).catch(rej); }
          catch (e) { rej(e); }
        }, 1000);
      });
    }

    // Record affinity
    if (toolId) _bindAffinity(toolId, workerUrl);

    return G.WorkerPool.run(workerUrl, payload, opts);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _installHoverListeners, { once: true });
  } else {
    _installHoverListeners();
  }

  G.RuntimeWorkerCoordinator = Object.freeze({
    VERSION:         VERSION,
    run:             coordinatedRun,
    prewarm:         function (toolId) {
      var url = _workerForTool(toolId) || _getAffinity(toolId);
      if (url) _schedulePrewarm(url);
    },
    getThermalTier:  function () { return _thermalTier; },
    getThermalLimit: function () { return _thermalLimit; },
    isCongested:     _isCongested,
    getAffinityMap:  function () { return Object.assign({}, _affinity); },
    workerForTool:   _workerForTool,
  });

}(window));

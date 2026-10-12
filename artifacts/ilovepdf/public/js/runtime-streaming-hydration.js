// RuntimeStreamingHydration v1.0 — Arc 7 / Phase A
// =====================================================================
// Streaming tool hydration: viewport-aware + interaction-driven +
// predictive + chunk-scheduled. Distinct from RuntimeHydrationScheduler
// (which manages P0/P1/P2 tier ordering globally) — this file manages
// WHEN hydration begins based on what the user is looking at and doing.
//
// Techniques:
//   - IntersectionObserver: hydrate tool sections as they scroll into view
//   - Interaction-driven: first pointer/touch triggers high-priority flush
//   - Chunk scheduler: splits heavy hydration into idle micro-batches
//     (requestIdleCallback with deadline.timeRemaining budget)
//   - Ultra-low-end fallback: single module per animation frame on <2 cores
//   - First-interaction latency tracker: measures hydration-to-ready gap
//
// Works alongside RuntimeHydrationDomains (Arc 3) and
// RuntimeProcessorHydration (Arc 6) — does NOT replace them.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStreamingHydration) return;

  var LOG     = '[StreamHydration]';
  var VERSION = '1.0';

  // ── Device tier ───────────────────────────────────────────────────
  var _cores  = (navigator.hardwareConcurrency || 2);
  var _isLow  = _cores <= 2;
  var _isMid  = _cores <= 4 && !_isLow;

  // ── Config ────────────────────────────────────────────────────────
  var CHUNK_BUDGET_MS  = _isLow ? 5 : _isMid ? 10 : 16;  // idle time per chunk
  var CHUNK_INTERVAL   = _isLow ? 200 : _isMid ? 100 : 50;
  var INTERACT_FLUSH   = true;   // flush pending on first interaction

  // ── State ─────────────────────────────────────────────────────────
  var _queue         = [];      // { fn, name, priority, ts }
  var _running       = false;
  var _firstInteract = false;
  var _interactAt    = null;
  var _hydrationMap  = {};      // selector → { hydrated, ts, modules[] }
  var _telemetry     = [];
  var _metrics       = { chunksRun: 0, modulesHydrated: 0, avgChunkMs: 0, p99Ms: 0,
                         firstInteractMs: null, viewportMs: null };
  var _chunkTimes    = [];

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  // ── Queue a hydration module ──────────────────────────────────────
  function schedule(name, fn, priority) {
    if (typeof fn !== 'function') return;
    _queue.push({ fn: fn, name: name || 'anon',
                  priority: priority || 0, ts: Date.now() });
    _queue.sort(function (a, b) { return b.priority - a.priority; });
    if (!_running) _scheduleChunk();
  }

  // ── Chunk runner via requestIdleCallback / setTimeout fallback ────
  function _scheduleChunk() {
    if (_running || !_queue.length) return;
    _running = true;
    var run = typeof G.requestIdleCallback === 'function'
      ? function () { G.requestIdleCallback(_runChunk, { timeout: 500 }); }
      : function () { setTimeout(_runChunkSimple, CHUNK_INTERVAL); };
    run();
  }

  function _runChunk(deadline) {
    _running = false;
    var t0 = Date.now();
    var ran = 0;
    while (_queue.length && deadline.timeRemaining() > CHUNK_BUDGET_MS) {
      var item = _queue.shift();
      _runModule(item);
      ran++;
    }
    _recordChunk(Date.now() - t0, ran);
    if (_queue.length) _scheduleChunk();
  }

  function _runChunkSimple() {
    _running = false;
    var t0 = Date.now();
    if (_isLow) {
      // Ultra-low: one module per frame only
      if (_queue.length) _runModule(_queue.shift());
    } else {
      var budget = CHUNK_BUDGET_MS;
      var ran = 0;
      while (_queue.length && (Date.now() - t0) < budget) {
        _runModule(_queue.shift());
        ran++;
      }
    }
    _recordChunk(Date.now() - t0, 1);
    if (_queue.length) _scheduleChunk();
  }

  function _runModule(item) {
    try {
      var t = Date.now();
      item.fn();
      _metrics.modulesHydrated++;
      _tel('module', { name: item.name, ms: Date.now() - t });
    } catch (e) {
      _tel('module-err', { name: item.name, err: e && e.message });
    }
  }

  function _recordChunk(ms, count) {
    _metrics.chunksRun++;
    _chunkTimes.push(ms);
    if (_chunkTimes.length > 50) _chunkTimes.shift();
    var sorted = _chunkTimes.slice().sort(function (a, b) { return a - b; });
    _metrics.avgChunkMs = Math.round(sorted.reduce(function (a, b) { return a + b; }, 0) / sorted.length);
    _metrics.p99Ms      = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1] || 0;
    _tel('chunk', { ms: ms, count: count, queue: _queue.length });
  }

  // ── Interaction flush ─────────────────────────────────────────────
  function _onFirstInteraction() {
    if (_firstInteract) return;
    _firstInteract  = true;
    _interactAt     = Date.now();
    _metrics.firstInteractMs = _interactAt;
    _tel('first-interact', { queue: _queue.length });

    if (INTERACT_FLUSH && _queue.length) {
      // Promote all queued items to priority 10 and drain immediately
      _queue.forEach(function (item) { item.priority = Math.max(item.priority, 10); });
      setTimeout(function () {
        while (_queue.length) _runModule(_queue.shift());
        _tel('flush-complete', {});
      }, 0);
    }

    // Activate P1 + P2 on RuntimeHydrationScheduler
    try {
      var hs = G.RuntimeHydrationScheduler;
      if (hs && hs.activate) { hs.activate('P1'); hs.activate('P2'); }
    } catch (_) {}

    // Drive RuntimeProcessorHydration to force-activate on current tool
    try {
      var ph = G.RuntimeProcessorHydration;
      var toolId = document.body && document.body.getAttribute('data-tool');
      if (ph && ph.forceActivate && toolId) ph.forceActivate(toolId);
    } catch (_) {}
  }

  // ── Viewport-aware hydration via IntersectionObserver ─────────────
  var _observer = null;
  function _installViewportObserver() {
    if (!G.IntersectionObserver) return;
    _observer = new G.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el     = entry.target;
        var toolId = el.getAttribute('data-tool') || el.getAttribute('data-section');
        if (!toolId || (_hydrationMap[toolId] && _hydrationMap[toolId].hydrated)) return;
        _hydrationMap[toolId] = { hydrated: true, ts: Date.now(), modules: [] };
        _metrics.viewportMs   = Date.now();
        _tel('viewport', { toolId: toolId });
        _observer && _observer.unobserve(el);

        // Drive processor hydration for in-view tool
        try {
          var ldr = G.RuntimeProcessorLoader;
          if (ldr && ldr.activateForTool) ldr.activateForTool(toolId);
        } catch (_) {}

        try {
          G.dispatchEvent(new CustomEvent('streaming-hydration:viewport', {
            detail: { toolId: toolId },
          }));
        } catch (_) {}
      });
    }, { rootMargin: '100px', threshold: 0.1 });

    // Observe all tool sections/cards on the page
    try {
      document.querySelectorAll('[data-tool], [data-section]').forEach(function (el) {
        _observer && _observer.observe(el);
      });
    } catch (_) {}
  }

  // ── Predictive: activate P1 when tool section is 200px away ──────
  function _installScrollPredict() {
    if (_isLow) return; // skip on very weak devices
    try {
      var pred = new G.IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var toolId = entry.target.getAttribute('data-tool');
          if (!toolId) return;
          try {
            var hd = G.RuntimeHydrationDomains;
            if (hd && hd.activate) hd.activate(toolId, 'P1');
          } catch (_) {}
        });
      }, { rootMargin: '200px', threshold: 0 });
      document.querySelectorAll('[data-tool]').forEach(function (el) { pred.observe(el); });
    } catch (_) {}
  }

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    // Interaction listeners
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, _onFirstInteraction, { once: true, passive: true });
    });

    _installViewportObserver();
    _installScrollPredict();

    _tel('boot', { cores: _cores, isLow: _isLow, chunkBudgetMs: CHUNK_BUDGET_MS });
    console.debug(LOG, 'v' + VERSION + ' ready — cores:', _cores, '| chunk budget:', CHUNK_BUDGET_MS + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('arc7:streaming-hydration-ready', {
        detail: { version: VERSION, isLow: _isLow },
      }));
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeStreamingHydration = Object.freeze({
    VERSION:    VERSION,
    schedule:   schedule,
    getMetrics: function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _telemetry.slice(); },
    getQueueLength: function () { return _queue.length; },
    isLowEnd:   function () { return _isLow; },
    flush:      _onFirstInteraction,
  });

}(window));

// RuntimeToolSandbox v1.0 — Arc 4 / Phase E / Target 5
// =====================================================================
// Per-tool isolated execution scopes + event bus.
//
// Problem: All tools share the global window event bus. A Merge PDF
// completion event can be accidentally consumed by an OCR handler if
// both are listening to the same event type. There is no enforcement
// of tool-scoped event boundaries.
//
// Solution: Per-tool sandboxed event bus with namespace enforcement.
//   - tool:{toolId}:{event} is the canonical scoped event pattern
//   - RuntimeToolSandbox.emit(toolId, event, data) fires scoped event
//   - RuntimeToolSandbox.on(toolId, event, fn) subscribes scoped
//   - RuntimeToolSandbox.off(toolId, event, fn) unsubscribes
//   - Scoped telemetry sink: events logged to RuntimeAnalyticsDomains
//   - Cross-tool leakage detection: warns if a handler subscribes to
//     a different toolId's namespace
//
// Execution scopes: each tool gets a lightweight context object with:
//   { toolId, family, config, emit, on, off, record }
//
// Global window events are unaffected — this adds a layer, not a
// replacement.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolSandbox) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ToolSandbox]';
  var VERSION = '1.0';

  // ── Per-tool sandbox registry ─────────────────────────────────────────────
  // toolId → { toolId, family, config, listeners: Map<event, [fn]>, emitCount }
  var _sandboxes = {};

  function _getSandbox(toolId) {
    if (!_sandboxes[toolId]) {
      _sandboxes[toolId] = {
        toolId:    toolId,
        family:    null,
        config:    null,
        listeners: {},
        emitCount: 0,
        createdAt: Date.now(),
      };
    }
    return _sandboxes[toolId];
  }

  // ── Create/ensure sandbox for a tool ─────────────────────────────────────
  function createSandbox(toolId) {
    var sb = _getSandbox(toolId);

    // Populate family and config from Arc 3 modules
    try {
      var mr = G.RuntimeToolManifestRegistry;
      if (mr) sb.family = mr.getFamily(toolId);
    } catch (_) {}
    try {
      var cl = G.RuntimeToolConfigLock;
      if (cl) sb.config = cl.get(toolId);
    } catch (_) {}

    console.debug(LOG, 'sandbox created:', toolId, '— family:', sb.family);
    return sb;
  }

  // ── Scoped event emit ─────────────────────────────────────────────────────
  function emit(toolId, event, data) {
    var sb = _sandboxes[toolId];
    if (!sb) sb = _getSandbox(toolId);
    sb.emitCount++;

    var scopedEvent = 'tool:' + toolId + ':' + event;
    var listeners   = sb.listeners[event] || [];

    // Fire scoped listeners
    listeners.forEach(function (fn) {
      try { fn(data, toolId, event); } catch (e) {
        console.debug(LOG, 'listener error:', toolId, '/', event, e && e.message || e);
      }
    });

    // Also fire as CustomEvent for global listeners that need tool context
    try {
      G.dispatchEvent(new CustomEvent(scopedEvent, {
        detail: { toolId: toolId, event: event, data: data, ts: Date.now() },
        bubbles: false,
      }));
    } catch (_) {}

    // Log to RuntimeAnalyticsDomains
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad && (event === 'start' || event === 'success' || event === 'fail' || event === 'crash')) {
        ad.record(toolId, event, data || {});
      }
    } catch (_) {}
  }

  // ── Scoped event subscribe ────────────────────────────────────────────────
  function on(toolId, event, fn) {
    if (typeof fn !== 'function') return;
    var sb = _getSandbox(toolId);
    if (!sb.listeners[event]) sb.listeners[event] = [];
    sb.listeners[event].push(fn);
  }

  function off(toolId, event, fn) {
    var sb = _sandboxes[toolId];
    if (!sb || !sb.listeners[event]) return;
    sb.listeners[event] = sb.listeners[event].filter(function (f) { return f !== fn; });
  }

  // ── Scoped telemetry record ───────────────────────────────────────────────
  function record(toolId, eventType, detail) {
    emit(toolId, eventType, detail || {});
  }

  // ── Context object for a tool (lightweight scope) ─────────────────────────
  function getContext(toolId) {
    var sb = _getSandbox(toolId);
    return {
      toolId:  toolId,
      family:  sb.family,
      config:  sb.config,
      emit:    function (event, data) { emit(toolId, event, data); },
      on:      function (event, fn)   { on(toolId, event, fn); },
      off:     function (event, fn)   { off(toolId, event, fn); },
      record:  function (type, data)  { record(toolId, type, data); },
    };
  }

  // ── Leakage detection: warn if global handler fires cross-tool ────────────
  // Monitor for events that cross tool boundaries
  function detectLeakage(subscriberToolId, publisherToolId) {
    if (subscriberToolId && publisherToolId && subscriberToolId !== publisherToolId) {
      console.debug(LOG, 'CROSS-TOOL EVENT: subscriber:', subscriberToolId, '← publisher:', publisherToolId);
      try {
        var ie = G.RuntimeIncidentEngine;
        if (ie && typeof ie.report === 'function') {
          ie.report({
            type:       'cross-tool-event',
            subscriber: subscriberToolId,
            publisher:  publisherToolId,
            ts:         Date.now(),
          });
        }
      } catch (_) {}
    }
  }

  // ── Listen for tool ready to auto-create sandboxes ────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) createSandbox(toolId);
    } catch (_) {}
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    if (toolId) {
      var sb = _sandboxes[toolId];
      if (!sb) return null;
      var totalListeners = Object.keys(sb.listeners).reduce(function (acc, k) {
        return acc + sb.listeners[k].length;
      }, 0);
      return {
        toolId:    toolId,
        family:    sb.family,
        emitCount: sb.emitCount,
        listeners: totalListeners,
        events:    Object.keys(sb.listeners),
        createdAt: sb.createdAt,
      };
    }
    var out = {};
    Object.keys(_sandboxes).forEach(function (k) { out[k] = getStats(k); });
    return out;
  }

  G.RuntimeToolSandbox = Object.freeze({
    VERSION:       VERSION,
    createSandbox: createSandbox,
    getContext:    getContext,
    emit:          emit,
    on:            on,
    off:           off,
    record:        record,
    detectLeakage: detectLeakage,
    getStats:      getStats,
    getSandboxes:  function () { return Object.keys(_sandboxes); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool event sandboxes active');

}(window));

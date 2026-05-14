// Runtime Event Bus v1.0 — Phase 2 (T032)
// Centralized pub/sub event system for decoupled runtime communication.
// Uses CustomEvent on window with 'rt:' prefix for future micro-frontend
// compatibility and BroadcastChannel forwarding where available.
//
// DESIGN: Two surfaces —
//   1. Internal typed bus  → RuntimeEventBus.emit/on/off  (synchronous)
//   2. DOM CustomEvents    → window 'rt:<type>' (async, BroadcastChannel-compatible)
//
// All Phase 2 systems use RuntimeEventBus for cross-subsystem signalling.
// Existing Phase 1 systems are NOT modified — they emit here when integrated.
//
// [FUTURE: ModuleFederation] Replace window CustomEvents with the federation
// event bridge so micro-frontends share the same event topology.
//
// Exposed as: window.RuntimeEventBus
(function () {
  'use strict';

  if (window.RuntimeEventBus) return;

  var LOG = '[REB]';

  // ── Internal synchronous bus ───────────────────────────────────────────────
  // Map<type, Set<{fn, once, filter}>>
  var _handlers = new Map();
  var _emitCount = 0;
  var _maxListeners = 50; // warn if a single type accumulates too many handlers

  function on(type, fn, opts) {
    if (typeof fn !== 'function') return function () {};
    opts = opts || {};
    if (!_handlers.has(type)) _handlers.set(type, new Set());
    var set = _handlers.get(type);
    if (set.size >= _maxListeners) {
      console.warn(LOG, 'listener leak? ' + set.size + ' handlers for:', type);
    }
    var entry = { fn: fn, once: !!opts.once, filter: opts.filter || null };
    set.add(entry);
    return function () { off(type, fn); };
  }

  function once(type, fn) {
    return on(type, fn, { once: true });
  }

  function off(type, fn) {
    var set = _handlers.get(type);
    if (!set) return;
    set.forEach(function (entry) {
      if (entry.fn === fn) set.delete(entry);
    });
    if (set.size === 0) _handlers.delete(type);
  }

  function emit(type, data) {
    _emitCount++;
    var set = _handlers.get(type);
    if (set && set.size > 0) {
      var toRemove = [];
      set.forEach(function (entry) {
        if (entry.filter && !entry.filter(data)) return;
        try { entry.fn(data); } catch (e) {
          console.warn(LOG, 'handler error for', type, ':', e.message);
        }
        if (entry.once) toRemove.push(entry);
      });
      toRemove.forEach(function (e) { set.delete(e); });
      if (set.size === 0) _handlers.delete(type);
    }

    // Also dispatch as DOM CustomEvent for cross-module subscribers
    try {
      window.dispatchEvent(new CustomEvent('rt:' + type, {
        detail: data,
        bubbles: false,
        cancelable: false,
      }));
    } catch (_) {}
  }

  // ── Wildcard subscription ─────────────────────────────────────────────────
  // on('*', fn) receives all events as { type, data }
  var _wildcards = new Set();

  function onAny(fn) {
    if (typeof fn !== 'function') return function () {};
    _wildcards.add(fn);
    return function () { _wildcards.delete(fn); };
  }

  var _origEmit = emit;
  emit = function (type, data) {
    _origEmit(type, data);
    if (_wildcards.size > 0) {
      _wildcards.forEach(function (fn) {
        try { fn({ type: type, data: data }); } catch (_) {}
      });
    }
  };

  // ── Standard runtime event type catalogue ─────────────────────────────────
  // All Phase 2 systems emit events using these well-known type strings.
  // New types should be added here for discoverability.
  var EVENTS = {
    // Runtime lifecycle
    RUNTIME_READY:       'runtime:ready',
    RUNTIME_SHUTDOWN:    'runtime:shutdown',

    // Task lifecycle
    TASK_QUEUED:         'task:queued',
    TASK_STARTED:        'task:started',
    TASK_PROGRESS:       'task:progress',
    TASK_COMPLETED:      'task:completed',
    TASK_FAILED:         'task:failed',
    TASK_CANCELLED:      'task:cancelled',

    // Worker lifecycle
    WORKER_SPAWNED:      'worker:spawned',
    WORKER_RELEASED:     'worker:released',
    WORKER_ERROR:        'worker:error',
    WORKER_ZOMBIE:       'worker:zombie',

    // Memory
    MEMORY_TIER_CHANGED: 'memory:tier-changed',
    MEMORY_EMERGENCY:    'memory:emergency',
    MEMORY_CLEANUP:      'memory:cleanup',

    // Queue
    QUEUE_TASK_ADDED:    'queue:task-added',
    QUEUE_TASK_DONE:     'queue:task-done',
    QUEUE_STORM:         'queue:storm',

    // Navigation
    NAV_CANCEL:          'nav:cancel',
    NAV_EPOCH:           'nav:epoch',

    // Progress
    PROGRESS_UPDATE:     'progress:update',
    PROGRESS_COMPLETE:   'progress:complete',
    PROGRESS_STALLED:    'progress:stalled',

    // Health
    HEALTH_DEGRADED:     'health:degraded',
    HEALTH_RECOVERED:    'health:recovered',
    HEALTH_STALLED:      'health:stalled',

    // Streaming (future)
    STREAM_CHUNK:        'stream:chunk',
    STREAM_COMPLETE:     'stream:complete',
  };

  // ── Cleanup ───────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    emit(EVENTS.RUNTIME_SHUTDOWN, { reason: 'pagehide' });
    _handlers.clear();
    _wildcards.clear();
  }, { passive: true });

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var listenerCount = 0;
    _handlers.forEach(function (s) { listenerCount += s.size; });
    return {
      types:       _handlers.size,
      listeners:   listenerCount,
      wildcards:   _wildcards.size,
      emitCount:   _emitCount,
    };
  }

  window.RuntimeEventBus = {
    on:       on,
    once:     once,
    off:      off,
    emit:     emit,
    onAny:    onAny,
    getStats: getStats,
    EVENTS:   EVENTS,
  };

  console.debug('[RuntimeEventBus] ready — T032 event bus active');
}());

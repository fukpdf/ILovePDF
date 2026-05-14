// Runtime State Manager v1.0 — Phase 2 (T030)
// Centralized reactive state store for all runtime subsystems.
// Single source of truth for: active tasks, workers, memory tier,
// queue depth, retries, degradation state, runtime mode, emergency state.
//
// Pattern: get(key) / set(key, value) / subscribe(key, fn) / snapshot()
//
// All Phase 2 systems READ from RuntimeState and WRITE to it.
// External code should observe via subscribe() — never poll.
//
// [FUTURE: IndexedDB] RuntimeState.snapshot() will be persisted to IDB
// for crash-recovery and cross-tab state sync.
//
// Exposed as: window.RuntimeState
(function () {
  'use strict';

  if (window.RuntimeState) return;

  // ── Initial state ─────────────────────────────────────────────────────────
  var _state = {
    // Runtime
    runtimeReady:      false,
    runtimeMode:       'normal',      // 'normal' | 'degraded' | 'emergency' | 'shutdown'
    startTs:           Date.now(),

    // Tasks
    activeTasks:       0,
    totalTasksRun:     0,
    totalTasksFailed:  0,
    totalTasksCancelled: 0,

    // Workers
    activeWorkers:     0,
    totalWorkersSpawned: 0,
    zombieWorkers:     0,

    // Memory
    memoryTier:        'ok',          // 'ok' | 'reduce' | 'low' | 'critical' | 'abort'
    memoryPct:         0,

    // Queue
    queueDepth:        0,
    queuedTaskCount:   0,

    // Retries
    totalRetries:      0,
    retryStormActive:  false,

    // Degradation
    degradationTier:   'ok',
    degradedSince:     0,

    // Emergency
    emergencyActive:   false,
    lastEmergencyTs:   0,

    // Cancellation
    navEpoch:          0,

    // Health
    healthScore:       100,           // 0–100
    lastHealthCheck:   0,
  };

  // ── Subscriber registry ───────────────────────────────────────────────────
  // Map<key, Set<fn>>  ('*' = subscribe to all changes)
  var _subs = new Map();

  function _notify(key, newVal, oldVal) {
    // Key-specific subscribers
    var set = _subs.get(key);
    if (set) {
      set.forEach(function (fn) {
        try { fn(newVal, oldVal, key); } catch (e) {
          console.warn('[RS] subscriber error for', key, e.message);
        }
      });
    }
    // Wildcard subscribers
    var any = _subs.get('*');
    if (any) {
      any.forEach(function (fn) {
        try { fn(newVal, oldVal, key); } catch (_) {}
      });
    }
    // Forward to RuntimeEventBus if available
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('state:changed', { key: key, value: newVal, prev: oldVal }); } catch (_) {}
    }
  }

  // ── Core API ──────────────────────────────────────────────────────────────
  function get(key) {
    return _state[key];
  }

  function set(key, value) {
    var old = _state[key];
    if (old === value) return; // no-op if unchanged
    _state[key] = value;
    _notify(key, value, old);
  }

  // Increment a numeric counter
  function inc(key, delta) {
    delta = delta || 1;
    var v = (_state[key] || 0) + delta;
    set(key, v);
    return v;
  }

  function dec(key, delta) {
    delta = delta || 1;
    var v = Math.max(0, (_state[key] || 0) - delta);
    set(key, v);
    return v;
  }

  // subscribe(key, fn) → unsubscribe fn
  // key = specific state key OR '*' for all changes
  function subscribe(key, fn) {
    if (typeof fn !== 'function') return function () {};
    if (!_subs.has(key)) _subs.set(key, new Set());
    _subs.get(key).add(fn);
    return function () {
      var s = _subs.get(key);
      if (s) { s.delete(fn); if (s.size === 0) _subs.delete(key); }
    };
  }

  // Full snapshot (returns a shallow copy — safe for JSON.stringify)
  function snapshot() {
    return Object.assign({}, _state);
  }

  // Reset volatile fields (call after tool completion)
  function resetTaskState() {
    set('activeTasks', 0);
    set('queueDepth', 0);
    set('retryStormActive', false);
  }

  // ── Computed derivations ──────────────────────────────────────────────────
  function isEmergency() {
    return _state.runtimeMode === 'emergency' || _state.emergencyActive;
  }

  function isDegraded() {
    return _state.runtimeMode !== 'normal';
  }

  function sessionAgeMs() {
    return Date.now() - _state.startTs;
  }

  // ── Pagehide: snapshot pre-shutdown ──────────────────────────────────────
  window.addEventListener('pagehide', function () {
    set('runtimeMode', 'shutdown');
    _subs.clear();
  }, { passive: true });

  window.RuntimeState = {
    get:            get,
    set:            set,
    inc:            inc,
    dec:            dec,
    subscribe:      subscribe,
    snapshot:       snapshot,
    resetTaskState: resetTaskState,
    isEmergency:    isEmergency,
    isDegraded:     isDegraded,
    sessionAgeMs:   sessionAgeMs,
  };

  console.debug('[RuntimeState] ready — T030 runtime state manager active');
}());

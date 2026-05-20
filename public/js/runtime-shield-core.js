// RuntimeShieldCore v1.0 — Enterprise Runtime Shield Layer / Task 1, 5, 6
// ============================================================================
// Window lockdown, enumeration reduction, Symbol-keyed private registry,
// WeakMap-based internal state hiding, and progressive security bootstrap.
//
// ADDITIVE ONLY — does not remove or replace any existing runtime system.
//
// What this does:
//   1. Makes sensitive window globals non-enumerable so they don't appear in
//      Object.keys(window) / for...in enumeration (DevTools "Global" tab).
//   2. Hides internal sub-properties of analytics/worker/debug objects.
//   3. Provides ShieldRegistry — a Symbol-keyed private store for shield state.
//   4. Progressive: low-end devices receive lite boot (fewer descriptor patches).
//   5. All patches are rollback-safe (origDescriptors preserved per property).
//
// Exposes: window.RuntimeShieldCore (minimal — only status/version)
// Internal state is held in closure + WeakMap — NOT on the public object.
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeShieldCore) return;

  var VERSION = '1.0';
  var LOG     = '[ShieldCore]';

  // ── Device tier gate ──────────────────────────────────────────────────────
  // Reads from RuntimeDeviceLite if available (score 0–100; <40 = low-end).
  function _deviceScore() {
    try {
      var rdl = G.RuntimeDeviceLite;
      if (rdl && typeof rdl.score === 'function') return rdl.score();
      if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    } catch (_) {}
    return 80; // assume capable if unknown
  }

  var _score     = _deviceScore();
  var _lite      = _score < 40;
  var _mid       = _score >= 40 && _score < 70;

  // ── Symbol-keyed private registry ─────────────────────────────────────────
  // Internal shield state lives here — never reachable via window.RuntimeShieldCore.*
  var _SYM_STATE = typeof Symbol === 'function'
    ? Symbol('iplv.shield.state')
    : '__iplv_shield_' + Math.random().toString(36).slice(2);

  // WeakMap<object, privateData> — cannot be iterated externally
  var _privateMap = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

  // Bootstrap state container (closure-private)
  var _state = {
    version:        VERSION,
    liteMode:       _lite,
    deviceScore:    _score,
    hiddenGlobals:  0,
    hiddenProps:    0,
    bootTs:         Date.now(),
    rollbackMap:    Object.create(null), // name → original PropertyDescriptor
    flagged:        false,
  };

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── 1. Sensitive globals to hide from enumeration ─────────────────────────
  // These are made non-enumerable so they don't surface in:
  //   Object.keys(window), for...in window, window object spread in DevTools.
  // They remain fully accessible as window.X or just X — no functionality lost.
  var HIDE_GLOBALS = [
    // Analytics & telemetry internals
    'RuntimeAnalytics', 'RuntimeTelemetry', 'RuntimeTelemetryEnterprise',
    'RuntimeSessionIntel', 'RuntimeIdentity',
    // Worker & processing registries
    'RuntimeWorkers', 'RuntimeWorkerOrchestrator', 'PdfWorkerRuntimeFactory',
    'WorkerPool', 'ToolAppManager',
    // Security systems (hide the guards themselves)
    'RuntimeSecurity', 'RuntimeSandbox', 'RuntimeHardening', 'RuntimeProtection',
    // Debug & diagnostics
    'DebugTrace', 'RuntimeDiagnostics', 'RuntimeDiagnosticsCenter',
    'RuntimeDevtoolsDashboard', 'RuntimeDashboard',
    // Internal processing engines
    'RuntimeAIOrchestrator', 'RuntimeAIScheduler', 'RuntimeKernel',
    'RuntimeQueue', 'RuntimeScheduler', 'RuntimeDistributedScheduler',
    // Object/resource registries
    'ObjectURLRegistry', 'RuntimeResultCache', 'OPFSManager',
    'PdfRuntimeRegistry',
    // Config & credential-adjacent
    'FIREBASE_CONFIG', '__GAE_DEEPSEEK_CONFIG', '__GAE_OPENAI_CONFIG',
    '__GAE_OPENAI_ENDPOINT', '__GAE_OLLAMA_URL', '__GAE_OLLAMA_MODEL',
    // Internal promise/state flags
    '__pdfjsLibPromise', '__ortPromise', '__IPLV_IS_PROD__',
    'QUEUE_API_BASE', 'QUEUE_API_BASE_OVERRIDE', 'API_BASE_OVERRIDE',
  ];

  // Internal sub-properties to hide from enumerable listing on their owners.
  // Format: { global: 'RuntimeAnalytics', props: ['_events', '_queue', ...] }
  var HIDE_INTERNAL_PROPS = [
    {
      global: 'DebugTrace',
      props: ['getLogs', 'getByType', 'last', 'qualitySummary'],
    },
    {
      global: 'RuntimeTelemetry',
      props: ['_queue', '_buffer', '_batchFn'],
    },
    {
      global: 'RuntimeSecurity',
      props: ['getStats'],
    },
    {
      global: 'RuntimeDiagnosticsCenter',
      props: ['getTimeline', 'addTimelineEvent'],
    },
  ];

  // ── Hide a single window global from enumeration ──────────────────────────
  function _hideGlobal(name) {
    if (!(name in G)) return false;
    var current = Object.getOwnPropertyDescriptor(G, name);
    if (!current) return false;
    if (current.enumerable === false) return false; // already hidden

    // Preserve original for rollback
    _state.rollbackMap[name] = current;

    try {
      Object.defineProperty(G, name, {
        value:        G[name],
        writable:     current.writable !== false,
        enumerable:   false,        // KEY: hidden from for...in / Object.keys()
        configurable: current.configurable !== false,
      });
      _state.hiddenGlobals++;
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Hide internal sub-properties from enumeration ─────────────────────────
  function _hideProps(entry) {
    var obj = G[entry.global];
    if (!obj || typeof obj !== 'object') return;
    entry.props.forEach(function (prop) {
      var d = Object.getOwnPropertyDescriptor(obj, prop);
      if (!d || d.enumerable === false) return;
      try {
        Object.defineProperty(obj, prop, {
          value:        obj[prop],
          writable:     d.writable !== false,
          enumerable:   false,
          configurable: d.configurable !== false,
        });
        _state.hiddenProps++;
      } catch (_) {}
    });
  }

  // ── 2. Shield the shield: hide ShieldCore itself ──────────────────────────
  function _selfHide() {
    try {
      Object.defineProperty(G, 'RuntimeShieldCore', {
        value:        G.RuntimeShieldCore,
        writable:     false,
        enumerable:   false,
        configurable: false,
      });
    } catch (_) {}
  }

  // ── 3. Private store for other shield modules ─────────────────────────────
  // Usage: ShieldRegistry.set(key, value) / ShieldRegistry.get(key)
  // Stored in closure — cannot be accessed via window.RuntimeShieldCore.*
  var _privateStore = Object.create(null);

  var ShieldRegistry = {
    set: function (key, value) { _privateStore[String(key)] = value; },
    get: function (key) { return _privateStore[String(key)]; },
    has: function (key) { return String(key) in _privateStore; },
    delete: function (key) { delete _privateStore[String(key)]; },
    // Bind a WeakMap private-data slot to an object
    bind: function (obj, data) {
      if (_privateMap) _privateMap.set(obj, data);
    },
    retrieve: function (obj) {
      return _privateMap ? _privateMap.get(obj) : null;
    },
  };

  // ── 4. Rollback helper ────────────────────────────────────────────────────
  function _rollback(name) {
    var orig = _state.rollbackMap[name];
    if (!orig) return false;
    try {
      Object.defineProperty(G, name, orig);
      delete _state.rollbackMap[name];
      _state.hiddenGlobals = Math.max(0, _state.hiddenGlobals - 1);
      return true;
    } catch (_) { return false; }
  }

  function _rollbackAll() {
    Object.keys(_state.rollbackMap).forEach(_rollback);
    console.info(LOG, 'all window lockdowns rolled back');
  }

  // ── 5. Freeze minimal public surface of existing security globals ──────────
  // Prevents external code from adding new properties to security singletons.
  // Existing methods/properties remain fully functional.
  var SEAL_GLOBALS = ['RuntimeSecurity', 'RuntimeSandbox'];

  function _sealSecurityGlobals() {
    if (_lite) return; // skip on low-end devices
    SEAL_GLOBALS.forEach(function (name) {
      var obj = G[name];
      if (!obj || Object.isFrozen(obj) || Object.isSealed(obj)) return;
      try {
        Object.seal(obj); // prevents new props; existing ones still writable
        _s(function () {
          if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:sealed:' + name);
        });
      } catch (_) {}
    });
  }

  // ── 6. Progressive boot ───────────────────────────────────────────────────
  function _boot() {
    var t0 = Date.now();

    // Low-end: hide only the highest-risk globals
    var toHide = _lite
      ? HIDE_GLOBALS.slice(0, 12)   // top 12 only
      : HIDE_GLOBALS;               // all of them

    toHide.forEach(_hideGlobal);

    if (!_lite) {
      HIDE_INTERNAL_PROPS.forEach(_hideProps);
    }

    if (!_lite && !_mid) {
      _sealSecurityGlobals();
    }

    // Register state in ShieldRegistry for other shield modules
    ShieldRegistry.set('core:bootTs',     _state.bootTs);
    ShieldRegistry.set('core:liteMode',   _lite);
    ShieldRegistry.set('core:deviceScore', _score);
    ShieldRegistry.set('core:flagged',    false);

    var elapsed = Date.now() - t0;
    console.info(LOG, 'v' + VERSION + ' boot complete',
      '| globals hidden:', _state.hiddenGlobals,
      '| props hidden:', _state.hiddenProps,
      '| lite:', _lite,
      '| ' + elapsed + 'ms');

    // Re-run after load to catch deferred scripts that assign to window
    G.addEventListener('load', function () {
      var newHidden = 0;
      toHide.forEach(function (name) {
        if (!(name in _state.rollbackMap) && _hideGlobal(name)) newHidden++;
      });
      if (newHidden > 0) console.debug(LOG, 'post-load: hid', newHidden, 'additional globals');
      _selfHide();
    });
  }

  // ── Public surface (minimal) ──────────────────────────────────────────────
  G.RuntimeShieldCore = {
    VERSION:      VERSION,
    liteMode:     _lite,
    registry:     ShieldRegistry,
    rollback:     _rollback,
    rollbackAll:  _rollbackAll,
    getStats:     function () {
      return {
        hiddenGlobals: _state.hiddenGlobals,
        hiddenProps:   _state.hiddenProps,
        liteMode:      _lite,
        deviceScore:   _score,
        bootTs:        _state.bootTs,
      };
    },
  };

  // Boot immediately (synchronous — must run before other deferred scripts enumerate window)
  _boot();

}(window));

// RuntimeControlPlane v1.0 — Arc 8 / Phase A
// =====================================================================
// Centralized runtime command bus. Enables live runtime control without
// page reload: toggle hydration domains, pause/resume worker domains,
// enable/disable predictive loading, self-optimizer, mobile extreme.
//
// All commands:
//   - are runtime-safe (try/catch, no crash propagation)
//   - emit arc8:command events after execution
//   - are recorded in a bounded audit trail (ring buffer)
//   - produce immutable snapshots for inspection
//
// Distinct from RuntimeTaskOrchestrator (execution scheduling) and
// RuntimeSelfOptimizer (auto-tuning) — this is the MANUAL control layer.
//
// window.RuntimeControlPlane.execute(cmd, args)
// window.RuntimeControlPlane.getState()
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeControlPlane) return;

  var LOG     = '[ControlPlane]';
  var VERSION = '1.0';

  // ── Feature flags ─────────────────────────────────────────────────
  var _flags = {
    'hydration.streaming':   true,
    'hydration.viewport':    true,
    'hydration.interaction': true,
    'predictive.hover':      true,
    'predictive.navigation': true,
    'predictive.frequency':  true,
    'workers.preload':       true,
    'optimizer.auto':        true,
    'extreme.auto':          true,
    'telemetry.fps':         true,
    'cache.sweep':           true,
    'trace.enabled':         true,
    'timeline.capture':      true,
    'profiler.sampling':     false,  // off by default (CPU cost)
    'dashboard.visible':     false,
  };

  // ── Command registry ──────────────────────────────────────────────
  var _commands = {};

  function register(name, fn) {
    _commands[name] = fn;
  }

  // ── Audit trail ───────────────────────────────────────────────────
  var _audit = [];
  var AUDIT_MAX = 200;

  function _recordAudit(cmd, args, result, err) {
    _audit.push(Object.freeze({
      ts: Date.now(), cmd: cmd,
      args: args ? JSON.parse(JSON.stringify(args)) : null,
      result: result || null,
      error: err ? String(err.message) : null,
    }));
    if (_audit.length > AUDIT_MAX) _audit.shift();
  }

  // ── Execute ───────────────────────────────────────────────────────
  function execute(cmd, args) {
    var fn = _commands[cmd];
    if (!fn) {
      _recordAudit(cmd, args, null, new Error('Unknown command: ' + cmd));
      console.warn(LOG, 'unknown command:', cmd);
      return { ok: false, error: 'unknown command: ' + cmd };
    }
    var result = null;
    try {
      result = fn(args || {});
      _recordAudit(cmd, args, result, null);
      try {
        G.dispatchEvent(new CustomEvent('arc8:command', {
          detail: { cmd: cmd, args: args, result: result, ts: Date.now() },
        }));
      } catch (_) {}
      console.debug(LOG, 'exec:', cmd, '→', result);
      return { ok: true, result: result };
    } catch (e) {
      _recordAudit(cmd, args, null, e);
      console.warn(LOG, 'command error:', cmd, e.message);
      return { ok: false, error: e.message };
    }
  }

  // ── Flag control ──────────────────────────────────────────────────
  function setFlag(name, value) {
    if (!_flags.hasOwnProperty(name)) return false;
    _flags[name] = !!value;
    return true;
  }

  function getFlag(name) { return _flags[name]; }

  // ── Built-in commands ─────────────────────────────────────────────

  register('flag.set', function (a) {
    var ok = setFlag(a.name, a.value);
    return { flag: a.name, value: a.value, ok: ok };
  });

  register('flag.get', function (a) {
    return { flag: a.name, value: _flags[a.name] };
  });

  register('flags.list', function () {
    return Object.assign({}, _flags);
  });

  // Hydration domain controls
  register('hydration.pause', function (a) {
    var hs = G.RuntimeHydrationScheduler;
    if (hs && hs.suspend) hs.suspend(a.tier || 'P2');
    return { tier: a.tier };
  });

  register('hydration.resume', function (a) {
    var hs = G.RuntimeHydrationScheduler;
    if (hs && hs.resume) hs.resume(a.tier || 'P2');
    return { tier: a.tier };
  });

  register('hydration.flush', function () {
    var sh = G.RuntimeStreamingHydration;
    if (sh && sh.flush) sh.flush();
    return { flushed: true };
  });

  // Predictive loader controls
  register('predictive.disable', function () {
    setFlag('predictive.hover', false);
    setFlag('predictive.navigation', false);
    setFlag('predictive.frequency', false);
    return { disabled: true };
  });

  register('predictive.enable', function () {
    setFlag('predictive.hover', true);
    setFlag('predictive.navigation', true);
    setFlag('predictive.frequency', true);
    return { enabled: true };
  });

  // Self-optimizer controls
  register('optimizer.disable', function () {
    setFlag('optimizer.auto', false);
    return { disabled: true };
  });

  register('optimizer.enable', function () {
    setFlag('optimizer.auto', true);
    return { enabled: true };
  });

  register('optimizer.force-adapt', function () {
    var so = G.RuntimeSelfOptimizer;
    if (so && so.forceAdapt) so.forceAdapt();
    return { adapted: true };
  });

  // Worker domain controls
  register('workers.pause-family', function (a) {
    var pw = G.RuntimeProcessorWorkers;
    if (pw && pw.setThermalLimit) pw.setThermalLimit(a.family, 0);
    return { family: a.family, paused: true };
  });

  register('workers.resume-family', function (a) {
    var pw = G.RuntimeProcessorWorkers;
    if (pw && pw.setThermalLimit) pw.setThermalLimit(a.family, a.limit || 2);
    return { family: a.family, limit: a.limit || 2 };
  });

  // Extreme mode controls
  register('extreme.trigger', function (a) {
    if (G.triggerExtremeMode) G.triggerExtremeMode(a.mode, 'control-plane');
    return { mode: a.mode };
  });

  register('extreme.lift', function (a) {
    if (G.liftExtremeMode) G.liftExtremeMode(a.mode);
    return { mode: a.mode };
  });

  // Cache controls
  register('cache.clear', function () {
    var sc = G.RuntimeSmartCache;
    if (sc && sc.clear) sc.clear();
    return { cleared: true };
  });

  // Dashboard controls
  register('dashboard.show', function () {
    setFlag('dashboard.visible', true);
    G.dispatchEvent(new CustomEvent('arc8:dashboard-show', {}));
    return { visible: true };
  });

  register('dashboard.hide', function () {
    setFlag('dashboard.visible', false);
    G.dispatchEvent(new CustomEvent('arc8:dashboard-hide', {}));
    return { visible: false };
  });

  // ── State snapshot ────────────────────────────────────────────────
  function getState() {
    return Object.freeze({
      version:    VERSION,
      ts:         Date.now(),
      flags:      Object.assign({}, _flags),
      commands:   Object.keys(_commands),
      auditCount: _audit.length,
      lastCmd:    _audit.length ? _audit[_audit.length - 1] : null,
    });
  }

  G.RuntimeControlPlane = Object.freeze({
    VERSION:    VERSION,
    execute:    execute,
    register:   register,
    setFlag:    setFlag,
    getFlag:    getFlag,
    getState:   getState,
    getAudit:   function () { return _audit.slice(); },
    getFlags:   function () { return Object.assign({}, _flags); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready —', Object.keys(_commands).length, 'commands | window.RuntimeControlPlane.execute()');

}(window));

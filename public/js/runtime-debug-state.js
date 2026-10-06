(function (G) {
  'use strict';
  if (G.RuntimeDebugState) return;

  var VERSION = '10.0.0';
  var LOG = '[DebugState]';

  // ── Panel registry ────────────────────────────────────────────────────────────
  var _panels  = {};   // id → { id, label, active, element, refresh, destroy }
  var _active  = {};   // id → bool

  function registerPanel(id, spec) {
    _panels[id] = Object.assign({ id: id, active: false }, spec);
  }

  function activatePanel(id) {
    if (_panels[id]) { _panels[id].active = true; _active[id] = true; }
  }

  function deactivatePanel(id) {
    if (_panels[id]) { _panels[id].active = false; _active[id] = false; }
  }

  function getPanel(id)       { return _panels[id] || null; }
  function getPanels()        { return Object.assign({}, _panels); }
  function getActivePanels()  { return Object.keys(_active).filter(function (id) { return _active[id]; }); }

  // ── Global debug state (shared across panels) ─────────────────────────────────
  var _state = {
    tabHidden:   false,
    mobileLow:   false,
    refreshMs:   500,
    version:     VERSION,
    buildId:     (typeof window.__BUILD_ID__ !== 'undefined') ? window.__BUILD_ID__ : '—',
    startTs:     Date.now(),
  };

  function get(key)        { return _state[key]; }
  function set(key, val)   { _state[key] = val; }
  function getAll()        { return Object.assign({}, _state); }

  // ── Cross-panel event bus ─────────────────────────────────────────────────────
  var _bus = {};

  function on(event, fn) {
    if (!_bus[event]) _bus[event] = [];
    _bus[event].push(fn);
  }

  function off(event, fn) {
    if (!_bus[event]) return;
    _bus[event] = _bus[event].filter(function (f) { return f !== fn; });
  }

  function emit(event, data) {
    if (!_bus[event]) return;
    _bus[event].forEach(function (fn) {
      try { fn(data); } catch (_) {}
    });
  }

  G.RuntimeDebugState = Object.freeze({
    VERSION:         VERSION,
    registerPanel:   registerPanel,
    activatePanel:   activatePanel,
    deactivatePanel: deactivatePanel,
    getPanel:        getPanel,
    getPanels:       getPanels,
    getActivePanels: getActivePanels,
    get:             get,
    set:             set,
    getAll:          getAll,
    on:              on,
    off:             off,
    emit:            emit,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — panel registry + event bus active');

}(window));

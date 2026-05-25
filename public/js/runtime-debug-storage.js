(function (G) {
  'use strict';
  if (G.RuntimeDebugStorage) return;

  var VERSION  = '10.0.0';
  var LOG      = '[DebugStorage]';
  var MAX_KEYS = 50;
  var PREFIX   = 'ilpdf_debug_';

  // ── In-memory ring store (panel state, history) ───────────────────────────────
  var _store   = {};   // key → { value, ts }
  var _keys    = [];   // ordered insertion keys

  function _evict() {
    while (_keys.length > MAX_KEYS) {
      var oldest = _keys.shift();
      delete _store[oldest];
    }
  }

  function put(key, value) {
    if (!_store[key]) _keys.push(key);
    _store[key] = { value: value, ts: Date.now() };
    _evict();
  }

  function fetch(key) {
    return _store[key] ? _store[key].value : undefined;
  }

  function remove(key) {
    delete _store[key];
    _keys = _keys.filter(function (k) { return k !== key; });
  }

  function clear() {
    _store = {};
    _keys  = [];
  }

  // ── sessionStorage helpers (graceful) ─────────────────────────────────────────
  function persist(key, value) {
    try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (_) {}
  }

  function load(key) {
    try {
      var raw = sessionStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : undefined;
    } catch (_) { return undefined; }
  }

  function forget(key) {
    try { sessionStorage.removeItem(PREFIX + key); } catch (_) {}
  }

  // ── 20 MB soft cap estimation ─────────────────────────────────────────────────
  function estimateBytes() {
    var total = 0;
    Object.keys(_store).forEach(function (k) {
      try { total += JSON.stringify(_store[k]).length * 2; } catch (_) {}
    });
    return total;
  }

  function isOverCap() { return estimateBytes() > 20 * 1024 * 1024; }

  function trimToFit() {
    while (isOverCap() && _keys.length > 0) {
      var oldest = _keys.shift();
      delete _store[oldest];
    }
  }

  G.RuntimeDebugStorage = Object.freeze({
    VERSION:       VERSION,
    put:           put,
    fetch:         fetch,
    remove:        remove,
    clear:         clear,
    persist:       persist,
    load:          load,
    forget:        forget,
    estimateBytes: estimateBytes,
    isOverCap:     isOverCap,
    trimToFit:     trimToFit,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — in-memory ring store active');

}(window));

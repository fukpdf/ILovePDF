// runtime-lazy-engine-loader.js — Phase 9 lazy engine loading coordinator
// Coordinates deferred loading of heavy engines (pdf-lib, pdfjs, tesseract,
// xlsx, mammoth) based on idle time, tool activation, and network state.
// Prevents redundant loads by acting as a singleton registry with promise
// deduplication. Exposes window.RuntimeLazyEngineLoader.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeLazyEngineLoader) return;

  // ── Engine registry ───────────────────────────────────────────────────────
  var _engines = {};  // name → { promise: Promise|null, loaded: bool, ms: number|null }
  var _queue   = [];  // scheduled prewarm { name, priority, fn }
  var _idle    = false;

  function _getOrCreate(name) {
    if (!_engines[name]) _engines[name] = { promise: null, loaded: false, ms: null };
    return _engines[name];
  }

  // ── Register + load an engine ─────────────────────────────────────────────
  // loaderFn must return a Promise that resolves when the engine is ready.
  function register(name, loaderFn) {
    var e = _getOrCreate(name);
    if (e.loaded) return Promise.resolve(true);
    if (e.promise) return e.promise;
    var t0 = Date.now();
    e.promise = Promise.resolve().then(loaderFn).then(function () {
      e.loaded = true;
      e.ms     = Date.now() - t0;
      e.promise = null;
      console.debug('[LazyEngineLoader] loaded:', name, 'in', e.ms, 'ms');
      _drainQueue();
      return true;
    }).catch(function (err) {
      e.promise = null;
      console.warn('[LazyEngineLoader] failed to load engine:', name, err && err.message);
      throw err;
    });
    return e.promise;
  }

  // ── Prewarm scheduling (runs during idle) ─────────────────────────────────
  function schedulePrewarm(name, priority, loaderFn) {
    _queue.push({ name: name, priority: priority || 5, fn: loaderFn });
    _queue.sort(function (a, b) { return a.priority - b.priority; });
    _maybeDrainOnIdle();
  }

  function _drainQueue() {
    var item = _queue.shift();
    if (!item) return;
    var e = _getOrCreate(item.name);
    if (e.loaded || e.promise) { _drainQueue(); return; }
    register(item.name, item.fn).then(_drainQueue).catch(_drainQueue);
  }

  function _maybeDrainOnIdle() {
    if (_idle) { _drainQueue(); return; }
    try {
      if (G.requestIdleCallback) {
        G.requestIdleCallback(function (deadline) {
          _idle = true;
          if (deadline.timeRemaining() > 20) _drainQueue();
        }, { timeout: 5000 });
      } else {
        setTimeout(function () { _idle = true; _drainQueue(); }, 3000);
      }
    } catch (_) {}
  }

  // ── BrowserTools bridge ───────────────────────────────────────────────────
  // Hook into BrowserTools loads if available so we track what's already loaded.
  function _markLoaded(name) {
    var e = _getOrCreate(name);
    if (!e.loaded) { e.loaded = true; e.ms = 0; }
  }

  // Try to detect already-loaded engines on next tick (after BrowserTools init)
  setTimeout(function () {
    try {
      if (G.PDFLib)     _markLoaded('pdf-lib');
      if (G.pdfjsLib)   _markLoaded('pdfjs');
      if (G.JSZip)      _markLoaded('jszip');
      if (G.mammoth)    _markLoaded('mammoth');
      if (G.XLSX)       _markLoaded('xlsx');
      if (G.Tesseract)  _markLoaded('tesseract');
      if (G.PptxGenJS)  _markLoaded('pptxgenjs');
    } catch (_) {}
  }, 500);

  G.RuntimeLazyEngineLoader = Object.freeze({
    register:         register,
    schedulePrewarm:  schedulePrewarm,
    isLoaded: function (name) {
      var e = _engines[name]; return !!(e && e.loaded);
    },
    getStats: function () {
      var out = {};
      Object.keys(_engines).forEach(function (k) {
        var e = _engines[k];
        out[k] = { loaded: e.loaded, ms: e.ms, pending: !!e.promise };
      });
      return out;
    },
  });
}());

// RuntimeBundleRegistry v1.0 — Arc 2 / Target 5
// =====================================================================
// Dynamic bundle activation + dependency-aware loading.
//
// Maintains a registry of known bundles (name, url, deps, loaded state).
// Bundles are loaded by appending a <script> tag. Loading is idempotent
// (re-request of an already-loaded bundle is a no-op).
//
// Built-in bundle groups (mirroring build-runtime-bundles.js):
//   core        — runtime-phase6-core.bundle.js
//   security    — runtime-phase6-deferred.bundle.js
//   zero-trust  — runtime-phase7.bundle.js
//   hardening   — runtime-phase8-deferred.bundle.js
//   infra       — runtime-phase9-infra.bundle.js
//   arc2        — runtime-arc2.bundle.js (this arc)
//
// Usage:
//   RuntimeBundleRegistry.load('arc2').then(() => { ... })
//   RuntimeBundleRegistry.status()
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBundleRegistry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[BundleReg]';
  var VERSION = '1.0';
  var BASE    = '/js/bundles/';

  // ── Bundle manifest ───────────────────────────────────────────────────────
  var _bundles = {
    'core':       { file: 'runtime-phase6-core.bundle.js',       deps: [] },
    'security':   { file: 'runtime-phase6-deferred.bundle.js',   deps: ['core'] },
    'zero-trust': { file: 'runtime-phase7.bundle.js',            deps: ['security'] },
    'hardening':  { file: 'runtime-phase8-deferred.bundle.js',   deps: ['zero-trust'] },
    'infra':      { file: 'runtime-phase9-infra.bundle.js',       deps: ['hardening'] },
    'arc2':       { file: 'runtime-arc2.bundle.js',               deps: ['infra'] },
  };

  // Track load state per bundle
  Object.keys(_bundles).forEach(function (k) {
    _bundles[k].loaded    = false;
    _bundles[k].loading   = false;
    _bundles[k].callbacks = [];
  });

  // ── Inject script tag ─────────────────────────────────────────────────────
  function _injectScript(url) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src   = url;
      el.defer = true;
      el.onload  = function () { resolve(); };
      el.onerror = function (e) { reject(new Error('Bundle load failed: ' + url)); };
      document.head.appendChild(el);
    });
  }

  // ── Resolve deps then load ─────────────────────────────────────────────────
  function _load(name) {
    var b = _bundles[name];
    if (!b) return Promise.reject(new Error('Unknown bundle: ' + name));
    if (b.loaded) return Promise.resolve();
    if (b.loading) {
      return new Promise(function (res, rej) {
        b.callbacks.push({ res: res, rej: rej });
      });
    }

    b.loading = true;

    // Resolve deps first (sequentially to preserve order)
    var depChain = Promise.resolve();
    b.deps.forEach(function (dep) {
      depChain = depChain.then(function () { return _load(dep); });
    });

    return depChain.then(function () {
      return _injectScript(BASE + b.file);
    }).then(function () {
      b.loaded  = true;
      b.loading = false;
      console.debug(LOG, 'loaded:', name, '—', b.file);
      b.callbacks.forEach(function (cb) { cb.res(); });
      b.callbacks = [];
    }).catch(function (err) {
      b.loading = false;
      b.callbacks.forEach(function (cb) { cb.rej(err); });
      b.callbacks = [];
      throw err;
    });
  }

  // ── Status summary ─────────────────────────────────────────────────────────
  function _status() {
    var out = {};
    Object.keys(_bundles).forEach(function (k) {
      out[k] = { loaded: _bundles[k].loaded, loading: _bundles[k].loading, file: _bundles[k].file };
    });
    return out;
  }

  G.RuntimeBundleRegistry = Object.freeze({
    VERSION:  VERSION,
    load:     _load,
    status:   _status,
    register: function (name, file, deps) {
      if (_bundles[name]) return;
      _bundles[name] = { file: file, deps: deps || [], loaded: false, loading: false, callbacks: [] };
    },
  });

}(window));

// RuntimeShadowRuntime v1.0 — Phase 6 / Task 4 (Shadow Runtime)
// =============================================================================
// A protected mirror of critical runtime APIs that survives tampering.
// When the primary runtime is compromised (globals overwritten, prototype
// pollution detected), the ShadowRuntime provides a clean fallback surface.
//
// Architecture:
//   • Clones critical API references at boot (before any user scripts run)
//   • Stores clones in a closure-private scope (not on window)
//   • Provides a "get original" interface for trusted callers
//   • Detects API replacement and emits tamper alerts
//   • Periodic drift check: compares live globals to stored originals
//
// Protected APIs:
//   fetch, XMLHttpRequest, Worker, WebAssembly, crypto, JSON,
//   Array, Object, Function, Promise, Map, Set, WeakMap, WeakSet
//
// window.RuntimeShadowRuntime
//   .getOriginal(name)              → original API reference
//   .isTampered(name)               → boolean
//   .auditDrift()                   → DriftReport
//   .callOriginal(name, args[])     → any
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeShadowRuntime) return;

  var VERSION = '1.0';
  var LOG     = '[ShadowRuntime]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Capture originals at load time (before any mutation) ──────────────────
  // This IIFE runs synchronously — no deferred boot for the shadow store.
  var _originals = (function () {
    var store = Object.create(null);

    var CAPTURE_LIST = [
      // Network
      ['fetch',           G.fetch],
      ['XMLHttpRequest',  G.XMLHttpRequest],
      // Workers + WASM
      ['Worker',          G.Worker],
      ['WebAssembly',     G.WebAssembly],
      ['SharedArrayBuffer', G.SharedArrayBuffer],
      // Crypto
      ['crypto',          G.crypto],
      ['SubtleCrypto',    G.crypto && G.crypto.subtle],
      // Core JS
      ['JSON',            G.JSON],
      ['Array',           G.Array],
      ['Object',          G.Object],
      ['Function',        G.Function],
      ['Promise',         G.Promise],
      ['Map',             G.Map],
      ['Set',             G.Set],
      ['WeakMap',         G.WeakMap],
      ['WeakSet',         G.WeakSet],
      ['Proxy',           G.Proxy],
      ['Reflect',         G.Reflect],
      ['Symbol',          G.Symbol],
      // DOM
      ['EventTarget',     G.EventTarget],
      ['MutationObserver', G.MutationObserver],
      ['IntersectionObserver', G.IntersectionObserver],
      // Storage
      ['localStorage',    G.localStorage],
      ['sessionStorage',  G.sessionStorage],
      ['indexedDB',       G.indexedDB],
      ['caches',          G.caches],
      // Performance
      ['performance',     G.performance],
      // Console (for anti-DevTools)
      ['console',         G.console],
    ];

    for (var i = 0; i < CAPTURE_LIST.length; i++) {
      var entry = CAPTURE_LIST[i];
      if (entry[1] !== undefined && entry[1] !== null) {
        store[entry[0]] = entry[1];
      }
    }

    return store;
  }());

  // ── Device tier (lazy — shadow itself is always active) ───────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Drift tracking ────────────────────────────────────────────────────────
  var _driftLog   = [];
  var MAX_LOG     = 100;
  var _tamperSeen = Object.create(null);

  // ── getOriginal ───────────────────────────────────────────────────────────
  function getOriginal(name) {
    return _originals[name] !== undefined ? _originals[name] : null;
  }

  // ── isTampered ────────────────────────────────────────────────────────────
  function isTampered(name) {
    var original = _originals[name];
    if (original === undefined) return false;
    try {
      return G[name] !== original;
    } catch (_) {
      return false;
    }
  }

  // ── callOriginal ──────────────────────────────────────────────────────────
  function callOriginal(name, args) {
    var orig = _originals[name];
    if (!orig || typeof orig !== 'function') return undefined;
    try {
      return orig.apply(G, args || []);
    } catch (e) {
      console.warn(LOG, 'callOriginal failed for:', name, e.message);
      return undefined;
    }
  }

  // ── auditDrift ────────────────────────────────────────────────────────────
  function auditDrift() {
    var tampered = [];
    var ok       = [];

    for (var name in _originals) {
      if (isTampered(name)) {
        tampered.push(name);
        if (!_tamperSeen[name]) {
          _tamperSeen[name] = Date.now();
          _driftLog.push({ name: name, ts: Date.now() });
          if (_driftLog.length > MAX_LOG) _driftLog.shift();

          console.error(LOG, 'TAMPER DETECTED — API replaced:', name);
          _s(function () {
            if (G.SecurityTelemetry) {
              G.SecurityTelemetry.record('proto-pollution', {
                target: name, reason: 'api-replaced',
              });
            }
            if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
              G.RuntimeEventBus.emit('shield:tamper-response', {
                source: 'shadow-runtime', target: name,
              });
            }
          });
        }
      } else {
        ok.push(name);
      }
    }

    return {
      tampered:     tampered,
      ok:           ok,
      tamperCount:  tampered.length,
      totalChecked: tampered.length + ok.length,
      ts:           Date.now(),
    };
  }

  // ── Protected fetch wrapper ────────────────────────────────────────────────
  // Provides a fetch that always uses the original (pre-tamper) reference.
  function safeFetch(url, options) {
    var orig = _originals['fetch'];
    if (!orig) return G.fetch(url, options);
    return orig.call(G, url, options);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    // Periodic drift sweep
    if (_tier !== 'LOW') {
      setInterval(function () {
        _s(function () { auditDrift(); });
      }, 30_000);
    }

    // Initial drift check
    setTimeout(function () {
      var report = auditDrift();
      if (report.tamperCount > 0) {
        console.warn(LOG, 'initial audit found', report.tamperCount, 'tampered APIs:', report.tampered.join(','));
      } else {
        console.debug(LOG, 'initial audit clean | checked:', report.totalChecked);
      }
    }, 3_000);

    console.info(LOG, 'v' + VERSION + ' ready | originals:', Object.keys(_originals).length,
      '| tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 500); }, { once: true });
  } else {
    setTimeout(_boot, 500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeShadowRuntime = Object.freeze({
    VERSION:      VERSION,
    getOriginal:  getOriginal,
    isTampered:   isTampered,
    auditDrift:   auditDrift,
    callOriginal: callOriginal,
    safeFetch:    safeFetch,
    status: function () {
      return {
        version:        VERSION,
        tier:           _tier,
        originalsCount: Object.keys(_originals).length,
        tamperCount:    Object.keys(_tamperSeen).length,
        driftLog:       _driftLog.slice(-20),
        tampered:       Object.keys(_tamperSeen),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | originals captured:', Object.keys(_originals).length);

}(window));

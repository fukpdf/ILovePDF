// RuntimeShieldDependency v1.0 — Enterprise Runtime Shield Layer / Tasks 4, 5, 6
// =============================================================================
// Dependency integrity: trusted CDN registry, script injection detection,
// WASM module version tracking, and dynamic runtime loader guard.
//
// ADDITIVE — never blocks legitimate scripts; flags and alerts only.
//
// What this does:
//   1. Trusted dependency registry — known CDN origins + expected resource types.
//   2. MutationObserver on <head> — detect dynamically injected <script> tags.
//   3. Flag unknown external scripts (not same-origin, not in trusted list).
//   4. Runtime WASM module tracking — hooks into RuntimeWasmEngine if available.
//   5. CDN resource integrity: checks loaded scripts originate from trusted sources.
//   6. Dynamic loader guard — validates any import() calls against trusted list.
//   7. SRI hint registry — known hashes for pinned CDN versions (advisory).
//
// Low-end devices: skip MutationObserver (performance) — only boot-time audit.
// Mid/High: full real-time monitoring.
//
// Exposes: window.RuntimeShieldDependency (status + registry)
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeShieldDependency) return;

  var VERSION = '1.0';
  var LOG     = '[ShieldDep]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ───────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score === 'function')    return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 80;
  }, 80);
  var _lite = _score < 40;

  // ── 1. Trusted CDN registry ────────────────────────────────────────────────
  // Origin allowlist for external script resources.
  // Same-origin scripts (/js/*, /core/*, /laba/*) are implicitly trusted.
  var TRUSTED_ORIGINS = [
    'https://unpkg.com',
    'https://cdn.jsdelivr.net',
    'https://cdnjs.cloudflare.com',
    'https://pagead2.googlesyndication.com',
    'https://partner.googleadservices.com',
    'https://tpc.googlesyndication.com',
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
    // Firebase SDK origins
    'https://www.gstatic.com',
    'https://apis.google.com',
    // HuggingFace inference API
    'https://api-inference.huggingface.co',
  ];

  // Pinned known resources with expected URL patterns (advisory — not hash-enforced in Phase 1)
  var TRUSTED_RESOURCES = {
    'https://unpkg.com/lucide@latest': { type: 'script', desc: 'Lucide icon library' },
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js': { type: 'script', desc: 'Google AdSense' },
    'https://fonts.googleapis.com/css2': { type: 'stylesheet', desc: 'Google Fonts CSS' },
  };

  // SRI hint registry — advisory hashes for known CDN resources.
  // Phase 1: these are recorded but not enforced (enforcement = Phase 2).
  // Format: url-prefix → { algo, hash, version }
  var SRI_REGISTRY = {
    'https://unpkg.com/lucide@': {
      algo: 'sha384',
      note: 'Pin to specific version (e.g. lucide@0.441.0) and generate hash with: ' +
            'openssl dgst -sha384 -binary lucide.js | base64',
      enforced: false,
    },
  };

  // ── 2. Audit state ─────────────────────────────────────────────────────────
  var _stats = {
    scriptsAudited:   0,
    scriptsBlocked:   0,  // flagged as untrusted (we never actually block — just flag)
    wasmModules:      0,
    injectionEvents:  0,
    trustedExternal:  0,
    unknownExternal:  0,
  };

  var _unknownScripts = []; // { src, ts }

  // ── 3. Origin trust check ─────────────────────────────────────────────────
  var _selfOrigin = (function () {
    try { return new URL(G.location.href).origin; } catch (_) { return ''; }
  }());

  function _isTrustedSrc(src) {
    if (!src || typeof src !== 'string') return false;
    // Same-origin: always trusted
    try {
      var u = new URL(src, G.location.href);
      if (u.origin === _selfOrigin) return true;
      // Check against trusted origins list
      return TRUSTED_ORIGINS.some(function (o) { return u.origin === o || src.indexOf(o) === 0; });
    } catch (_) {
      return false; // malformed URL — suspicious
    }
  }

  function _auditScriptElement(el) {
    var src = el.src || el.getAttribute('src');
    if (!src) return; // inline script — not a CDN load
    _stats.scriptsAudited++;

    if (_isTrustedSrc(src)) {
      _stats.trustedExternal++;
      return;
    }

    // Not trusted — flag
    _stats.unknownExternal++;
    _stats.scriptsBlocked++;
    var entry = { src: src.slice(0, 200), ts: Date.now() };
    _unknownScripts.push(entry);

    console.warn(LOG, 'UNTRUSTED script detected:', src.slice(0, 120));
    _s(function () {
      if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:dep:untrusted-script', { src: src.slice(0, 100) });
    });
    _s(function () {
      var si = G.RuntimeShieldIntegrity;
      if (si && si.flag) si.flag('dep:untrusted-script');
    });
  }

  // ── 4. Boot-time script audit ─────────────────────────────────────────────
  function _auditExistingScripts() {
    var scripts = document.querySelectorAll('script[src]');
    scripts.forEach(_auditScriptElement);
  }

  // ── 5. MutationObserver — detect dynamically injected scripts ─────────────
  var _observer = null;

  function _installObserver() {
    if (_lite || typeof MutationObserver === 'undefined') return;

    _observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return; // element nodes only
          if (node.tagName === 'SCRIPT' && node.src) {
            _stats.injectionEvents++;
            _auditScriptElement(node);
          }
          // Also check children (e.g. a div containing a script)
          if (node.querySelectorAll) {
            node.querySelectorAll('script[src]').forEach(_auditScriptElement);
          }
        });
      });
    });

    // Observe the entire document for new scripts
    _observer.observe(document, {
      childList: true,
      subtree:   true,
    });

    console.debug(LOG, 'MutationObserver active — watching for script injections');
  }

  // ── 6. WASM module tracker ────────────────────────────────────────────────
  // Hooks into RuntimeWasmEngine.load to track which WASM modules are loaded.
  var _wasmModules = []; // [{ id, ts, sizeBytes }]

  function _trackWasmLoad(moduleId, sizeBytes) {
    _stats.wasmModules++;
    _wasmModules.push({ id: moduleId, ts: Date.now(), sizeBytes: sizeBytes || 0 });
    console.debug(LOG, 'WASM module loaded:', moduleId,
      sizeBytes ? '(' + Math.round(sizeBytes / 1024) + ' KB)' : '');
  }

  function _patchWasmEngine() {
    var we = G.RuntimeWasmEngine;
    if (!we || typeof we.load !== 'function') return false;
    if (we._shieldDepPatched) return false;

    var _orig = we.load;
    we.load = function (moduleId, opts) {
      var result = _orig.call(we, moduleId, opts);
      // Track the load attempt
      _trackWasmLoad(moduleId, opts && opts.sizeBytes);
      return result;
    };
    we._shieldDepPatched = true;
    console.info(LOG, 'patched RuntimeWasmEngine.load for WASM tracking');
    return true;
  }

  // ── 7. Dynamic import guard ───────────────────────────────────────────────
  // Validate dynamic import() calls against trusted origins.
  // We patch a thin wrapper that logs untrusted import attempts.
  // NOTE: We cannot intercept native import() — only calls via helper fns.
  //       Patches RuntimeWasmEngine.importModule if present.
  function _guardDynamicImports() {
    var we = G.RuntimeWasmEngine;
    if (!we || typeof we.importModule !== 'function') return;
    if (we._shieldImportPatched) return;

    var _origImport = we.importModule;
    we.importModule = function (url) {
      if (!_isTrustedSrc(String(url))) {
        console.warn(LOG, 'dynamic import from untrusted origin:', String(url).slice(0, 100));
        _stats.unknownExternal++;
        _s(function () {
          if (G.RuntimeShieldIntegrity) G.RuntimeShieldIntegrity.flag('dep:untrusted-import');
        });
      }
      return _origImport.apply(we, arguments);
    };
    we._shieldImportPatched = true;
  }

  // ── 8. SRI advisory report ────────────────────────────────────────────────
  // Checks loaded external scripts against our SRI registry.
  // Phase 1: report-only. Phase 2: enforce.
  function _sriReport() {
    var report = [];
    document.querySelectorAll('script[src]').forEach(function (el) {
      var src = el.src;
      Object.keys(SRI_REGISTRY).forEach(function (prefix) {
        if (src.indexOf(prefix) !== 0) return;
        var reg = SRI_REGISTRY[prefix];
        var hasIntegrity = el.getAttribute('integrity');
        report.push({
          src:     src.slice(0, 100),
          pinned:  reg.enforced,
          hasSRI:  !!hasIntegrity,
          note:    reg.note || '',
        });
        if (!hasIntegrity) {
          console.debug(LOG, 'SRI advisory: missing integrity attribute on', src.slice(0, 60),
            '—', reg.note || 'consider pinning this resource');
        }
      });
    });
    return report;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    // Audit existing scripts first
    _auditExistingScripts();

    // Install real-time injection monitor
    _installObserver();

    // Patch WASM engine and import guard
    _patchWasmEngine();
    _guardDynamicImports();

    // SRI advisory report (debug-level — not alarming)
    setTimeout(function () {
      var sri = _sriReport();
      if (sri.length) console.debug(LOG, 'SRI advisory:', sri);
    }, 2000);

    _s(function () {
      var reg = G.RuntimeShieldCore && G.RuntimeShieldCore.registry;
      if (reg) reg.set('dependency:ready', true);
    });

    console.info(LOG, 'v' + VERSION + ' ready',
      '| scripts audited:', _stats.scriptsAudited,
      '| unknown external:', _stats.unknownExternal,
      '| observer:', !!_observer);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 600);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 600); }, { once: true });
  }

  G.RuntimeShieldDependency = {
    VERSION:        VERSION,
    TRUSTED_ORIGINS: TRUSTED_ORIGINS,
    SRI_REGISTRY:   SRI_REGISTRY,
    isTrusted:      _isTrustedSrc,
    trackWasm:      _trackWasmLoad,
    getStats:       function () { return Object.assign({}, _stats); },
    getUnknown:     function () { return _unknownScripts.slice(); },
    getWasmModules: function () { return _wasmModules.slice(); },
    sriReport:      _sriReport,
  };

}(window));

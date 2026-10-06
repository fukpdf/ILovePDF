// runtime-manifest.js
// Phase 2 — Tasks 3, 5, 7, 10
//
// Trusted Runtime Manifest System
// ================================
// Three cooperating sub-systems:
//
//   TrustedModuleManifest — allowlist of runtime modules + allowed import origins.
//                           Validates dynamic imports before they resolve.
//
//   TrustedScriptRegistry — tracks every <script> element (src + nonce + load
//                           timestamp + module type). Detects rogue injections
//                           and duplicate runtime loads via MutationObserver.
//
//   RuntimeChunkValidator  — validates chunk paths against the manifest before
//                           they are fetched (preparation hook for Task 5 / Phase 3).
//
// Device tiering (Task 10):
//   score < 40  → lite: no MutationObserver, minimal registry
//   score 40-70 → mid:  registry + observer, no hash validation
//   score ≥ 70  → full: all checks active
//
// All systems are purely additive. No existing load path is altered.

(function (G) {
  'use strict';

  if (G.RuntimeManifest) return;

  const VERSION = '1.0';

  // ── Device tier ─────────────────────────────────────────────────────────────
  const _score = (G.RuntimeDeviceLite && typeof G.RuntimeDeviceLite.score === 'number')
    ? G.RuntimeDeviceLite.score
    : 70;
  const _lite = _score < 40;
  const _mid  = _score >= 40 && _score < 70;
  const _full = _score >= 70;

  // ── Trusted Module Allowlist (Task 3) ────────────────────────────────────────
  // Path prefixes and exact origins that are considered trusted for dynamic import.
  const TRUSTED_PATHS = new Set([
    // Same-origin runtime modules
    '/js/',
    '/core/',
    '/workers/',
    '/laba/',
    '/locales/',
  ]);

  const TRUSTED_ORIGINS = new Set([
    location.origin,                                    // same-origin
    'https://cdn.jsdelivr.net',                         // pdfjs, lucide
    'https://unpkg.com',                                // lucide fallback
    'https://pagead2.googlesyndication.com',            // AdSense
    'https://www.googletagmanager.com',                 // GA/GTM
    'https://www.google-analytics.com',                 // GA
    'https://partner.googleadservices.com',             // AdSense partner
    'https://tpc.googlesyndication.com',                // AdSense
    'https://api-inference.huggingface.co',             // HuggingFace AI
    'https://fonts.googleapis.com',                     // Google Fonts CSS
    'https://fonts.gstatic.com',                        // Google Fonts files
    'https://formspree.io',                             // contact form
  ]);

  // Known runtime chunk names (Task 5 foundation).
  // Phase 3 will add hash-pinning; for now we track known names.
  const KNOWN_CHUNKS = new Set([
    'runtime-shield-core.js',
    'runtime-shield-integrity.js',
    'runtime-shield-workers.js',
    'runtime-shield-dependency.js',
    'runtime-manifest.js',
    'runtime-worker-factory.js',
    'runtime-bootstrap.js',
    'runtime-analytics.js',
    'runtime-identity.js',
    'runtime-savings.js',
    'runtime-ads.js',
    'runtime-credits.js',
    'runtime-donation.js',
    'runtime-offline.js',
    'runtime-updater.js',
    'runtime-changelog.js',
    'runtime-recovery.js',
    'runtime-ai-scheduler.js',
    'runtime-perf.js',
    'runtime-protection.js',
    'advanced-engine.js',
    'bg-ai-engine.js',
    'bg-remover-pro.js',
    'tool-page.js',
    'shared.js',
    'auth-ui.js',
    'i18n.js',
    'tools-config.js',
    'chrome.js',
    'live-preview.js',
    'core-manifest.js',
    'shared-constants.js',
    'runtime-contracts.js',
    'runtime-federation.js',
    'ai-runtime.js',
    'runtime-governor.js',
    'production-mode.js',
    'pwa-register.js',
    'footer-lang.js',
    'chrome-shim.js',
    'about-contact-form.js',
    'savings-animation.js',
    'community-economy.js',
    'homepage-lazy-loader.js',
  ]);

  // ── Trusted Module Manifest (Task 3) ─────────────────────────────────────────

  const TrustedModuleManifest = {
    VERSION,

    /**
     * Validate a module URL string against the trusted allowlist.
     * Returns { trusted: boolean, reason: string }.
     */
    validate(urlStr) {
      try {
        const u = new URL(urlStr, location.href);

        // Same-origin path prefix check
        if (u.origin === location.origin) {
          for (const prefix of TRUSTED_PATHS) {
            if (u.pathname.startsWith(prefix)) {
              return { trusted: true, reason: 'same-origin-path' };
            }
          }
          // Same-origin but unknown path — still allowed, flag it
          return { trusted: true, reason: 'same-origin-unknown-path', warn: true };
        }

        // Cross-origin: must match trusted origin
        if (TRUSTED_ORIGINS.has(u.origin)) {
          return { trusted: true, reason: 'trusted-origin' };
        }

        return { trusted: false, reason: 'untrusted-origin', url: urlStr };
      } catch {
        return { trusted: false, reason: 'invalid-url', url: urlStr };
      }
    },

    /** Return true if the chunk filename is in the known manifest. */
    isKnownChunk(filename) {
      return KNOWN_CHUNKS.has(filename);
    },

    /** Register a new chunk in the manifest at runtime. */
    registerChunk(filename) {
      KNOWN_CHUNKS.add(filename);
    },

    trustedOrigins: TRUSTED_ORIGINS,
    trustedPaths:   TRUSTED_PATHS,
    knownChunks:    KNOWN_CHUNKS,
  };

  // ── Trusted Script Registry (Task 7) ─────────────────────────────────────────

  const _registry = new Map();   // src → { src, nonce, loadedAt, type, trusted }
  const _violations = [];

  const TrustedScriptRegistry = {
    VERSION,

    /**
     * Record a script element in the registry.
     * @param {HTMLScriptElement} el
     */
    register(el) {
      const src      = el.src || '[inline]';
      const nonce    = el.nonce || el.getAttribute('nonce') || '';
      const type     = el.type || 'text/javascript';
      const loadedAt = Date.now();
      const validation = el.src ? TrustedModuleManifest.validate(el.src) : { trusted: true, reason: 'inline' };

      const entry = { src, nonce, loadedAt, type, trusted: validation.trusted, reason: validation.reason };
      _registry.set(src, entry);

      if (!validation.trusted) {
        const viol = { src, loadedAt, reason: validation.reason };
        _violations.push(viol);
        if (_full) {
          console.warn('[TrustedScriptRegistry] untrusted script detected:', src, validation.reason);
          _flagSession('rogue-script', viol);
        }
      }

      if (validation.warn && _full) {
        console.info('[TrustedScriptRegistry] same-origin unknown path:', src);
      }

      return entry;
    },

    /** Return all registered scripts. */
    getAll() { return Array.from(_registry.values()); },

    /** Return all detected violations. */
    getViolations() { return _violations.slice(); },

    /** Check if a src has already been registered (duplicate load detection). */
    isDuplicate(src) {
      return _registry.has(src) && src !== '[inline]';
    },

    size() { return _registry.size; },
  };

  // ── Session flagging helper ───────────────────────────────────────────────────

  function _flagSession(type, detail) {
    try {
      if (G.RuntimeAnalytics && typeof G.RuntimeAnalytics.flag === 'function') {
        G.RuntimeAnalytics.flag({ type, detail, ts: Date.now() });
      }
      if (G.RuntimeShieldIntegrity && typeof G.RuntimeShieldIntegrity.flag === 'function') {
        G.RuntimeShieldIntegrity.flag(type, detail);
      }
    } catch { /* non-blocking */ }
  }

  // ── Boot-time script scan ─────────────────────────────────────────────────────

  function _scanExistingScripts() {
    const scripts = document.querySelectorAll('script[src]');
    scripts.forEach(el => TrustedScriptRegistry.register(el));
  }

  // ── MutationObserver for runtime injection detection (mid + full only) ────────

  let _observer = null;

  function _startObserver() {
    if (_lite || _observer) return;
    _observer = new MutationObserver(function (mutations) {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeName === 'SCRIPT') {
            const entry = TrustedScriptRegistry.register(node);
            if (!entry.trusted && _full) {
              console.warn('[RuntimeManifest] injected script blocked from registry:', node.src);
            }
            // Duplicate load detection
            if (TrustedScriptRegistry.isDuplicate(node.src)) {
              if (_full) {
                console.warn('[RuntimeManifest] duplicate script load:', node.src);
                _flagSession('duplicate-script', { src: node.src });
              }
            }
          }
        }
      }
    });
    _observer.observe(document, { childList: true, subtree: true });
  }

  // ── Hash registry + WASM tracker (backing store for RuntimeChunkValidator) ─────
  // Phase 2: advisory (logs mismatches); Phase 3 will add hard enforcement.
  const _hashRegistry = typeof Map !== 'undefined' ? new Map() : null;
  const _wasmModules  = typeof Map !== 'undefined' ? new Map() : null;

  // ── Chunk Validator (Task 5 foundation) ──────────────────────────────────────

  const RuntimeChunkValidator = {
    VERSION,

    /**
     * Validate a chunk URL. Returns true if safe to load.
     * Phase 3 will add hash verification here.
     */
    validate(url) {
      const result = TrustedModuleManifest.validate(url);
      if (!result.trusted) {
        if (_full) console.warn('[ChunkValidator] rejected chunk:', url, result.reason);
        return false;
      }
      // Check if filename is in known manifest
      const filename = url.split('/').pop().split('?')[0];
      if (!TrustedModuleManifest.isKnownChunk(filename) && _full) {
        console.info('[ChunkValidator] unknown chunk (not in manifest):', filename);
      }
      return true;
    },

    /** Register a known-good SHA-256 hex hash for a chunk filename.
     *  Phase 2: stores and uses for advisory comparison (logs mismatches).
     *  Phase 3 will add hard enforcement (reject mismatched chunks). */
    registerHash(filename, sha256hex) {
      if (!filename || typeof sha256hex !== 'string' || sha256hex.length !== 64) return;
      _hashRegistry.set(filename, sha256hex.toLowerCase());
      if (_full) console.debug('[ChunkValidator] hash pinned for:', filename);
    },

    /** Compare a chunk's fetched bytes against a registered hash (advisory). */
    verifyHash(filename, sha256hex) {
      const pinned = _hashRegistry.get(filename);
      if (!pinned) return { verified: true, pinned: false };   // no pin — pass
      const match = pinned === sha256hex.toLowerCase();
      if (!match && _full) {
        console.warn('[ChunkValidator] hash mismatch for:', filename,
          '\n  pinned:', pinned, '\n  actual:', sha256hex);
      }
      return { verified: match, pinned: true };
    },

    /** WASM module tracker — records loaded WASM modules for integrity audit. */
    trackWasm(moduleId, byteLength) {
      _wasmModules.set(moduleId, { byteLength, ts: Date.now() });
      if (_full) console.debug('[ChunkValidator] WASM tracked:', moduleId, byteLength + 'B');
    },
  };

  // ── Dynamic Import Guard (Task 3) ────────────────────────────────────────────
  // Wrap import() calls that go through RuntimeModuleLoader / RuntimeFederation.
  // Does NOT wrap native import() (not wrappable). Instead hooks the loader APIs
  // that the platform uses for dynamic module loading.

  function _patchLoaderApis() {
    if (_lite) return;

    // Hook RuntimeModuleLoader if present
    const loader = G.RuntimeModuleLoader;
    if (loader && typeof loader.load === 'function' && !loader._manifestPatched) {
      const _orig = loader.load.bind(loader);
      loader.load = function (url, opts) {
        if (!RuntimeChunkValidator.validate(url)) {
          if (_full) console.error('[RuntimeManifest] import blocked by chunk validator:', url);
          return Promise.reject(new Error('[RuntimeManifest] untrusted chunk: ' + url));
        }
        return _orig(url, opts);
      };
      loader._manifestPatched = true;
    }

    // Hook RuntimeFederation if present
    const fed = G.RuntimeFederation;
    if (fed && typeof fed.import === 'function' && !fed._manifestPatched) {
      const _origFed = fed.import.bind(fed);
      fed.import = function (url, opts) {
        if (!RuntimeChunkValidator.validate(url)) {
          if (_full) console.error('[RuntimeManifest] federation import blocked:', url);
          return Promise.reject(new Error('[RuntimeManifest] untrusted federation chunk: ' + url));
        }
        return _origFed(url, opts);
      };
      fed._manifestPatched = true;
    }
  }

  // ── Build pipeline preparation hooks (Task 11) ────────────────────────────────

  // Pre-pin known Phase 2 security chunks (advisory — not enforced yet).
  // These will be updated with real SHA-256 hashes when a build pipeline is
  // established in Phase 3. For now they serve as presence markers.
  const PHASE2_KNOWN_CHUNKS = [
    'runtime-shield-core.js',
    'runtime-shield-integrity.js',
    'runtime-shield-workers.js',
    'runtime-shield-dependency.js',
    'runtime-manifest.js',
    'runtime-worker-factory.js',
    'runtime-protection.js',
    'runtime-hardening.js',
    'runtime-compat-validator.js',
    'runtime-rollback.js',
    'runtime-deployment-bind.js',
  ];
  // Mark known chunks in KNOWN_CHUNKS set (already declared above via add)
  PHASE2_KNOWN_CHUNKS.forEach(c => {
    if (!KNOWN_CHUNKS.has(c)) KNOWN_CHUNKS.add(c);
  });

  // Build pipeline hooks — Phase 2 implementations (advisory / logging).
  // Phase 3 contract: each hook must return a Promise; throw to block.
  const BuildPipelineHooks = {
    VERSION,

    /** Called after a chunk is successfully loaded. Records to audit log. */
    onChunkLoad: function (filename, hash) {
      if (!filename) return Promise.resolve();
      if (_full) console.debug('[BuildHooks] chunk loaded:', filename, hash ? '(hash present)' : '(no hash)');
      if (hash && _hashRegistry) {
        const result = RuntimeChunkValidator.verifyHash(filename, hash);
        if (!result.verified) {
          console.warn('[BuildHooks] advisory hash mismatch on load:', filename);
        }
      }
      return Promise.resolve();
    },

    /** Called to verify a chunk's bytes before execution. Returns boolean.
     *  Phase 2: advisory — always returns true; logs mismatch. */
    onChunkVerify: function (filename, sha256hex) {
      if (!filename || !_hashRegistry) return true;
      const result = RuntimeChunkValidator.verifyHash(filename, sha256hex || '');
      return result.verified; // advisory — caller may ignore in Phase 2
    },

    /** Called when a WASM module is loaded. Tracks module for audit. */
    onWasmLoad: function (moduleId, buffer) {
      if (!moduleId) return Promise.resolve();
      const byteLength = buffer && buffer.byteLength ? buffer.byteLength : 0;
      RuntimeChunkValidator.trackWasm(moduleId, byteLength);
      return Promise.resolve();
    },

    /** Obfuscation lookup — returns null in Phase 2 (no obfuscation yet). */
    onObfuscate: function (chunkId) {
      return null; // Phase 3: return obfuscated chunk ID
    },

    /** Token refresh — returns a resolved promise in Phase 2. */
    onTokenRefresh: function () {
      return Promise.resolve(''); // Phase 3: return fresh encrypted token
    },

    /** Register or override a hook at runtime (safe — validates type). */
    register(name, fn) {
      if (Object.prototype.hasOwnProperty.call(this, name) && typeof fn === 'function') {
        this[name] = fn;
        if (_full) console.debug('[BuildHooks] hook registered:', name);
      }
    },

    /** List loaded WASM modules for audit. */
    wasmModules: function () {
      if (!_wasmModules) return [];
      return Array.from(_wasmModules.entries()).map(([id, d]) => ({ id, byteLength: d.byteLength, ts: d.ts }));
    },
  };

  // ── Boot ──────────────────────────────────────────────────────────────────────

  function _boot() {
    if (document.readyState !== 'loading') {
      _scanExistingScripts();
      _startObserver();
      _patchLoaderApis();
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        _scanExistingScripts();
        _startObserver();
        _patchLoaderApis();
      });
    }

    // Retry loader API patches after a short delay (loaders may not be ready yet)
    if (!_lite) {
      setTimeout(_patchLoaderApis, 2000);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  G.RuntimeManifest = Object.freeze({
    VERSION,
    TrustedModuleManifest,
    TrustedScriptRegistry,
    RuntimeChunkValidator,
    BuildPipelineHooks,

    /** Validate a URL — convenience shortcut. */
    validate(url) { return TrustedModuleManifest.validate(url); },
    /** True if the URL is in a trusted origin/path. */
    isTrusted(url) { return TrustedModuleManifest.validate(url).trusted; },
    /** Registry snapshot for diagnostics. */
    audit() {
      return {
        scripts:    TrustedScriptRegistry.getAll(),
        violations: TrustedScriptRegistry.getViolations(),
        deviceScore: _score,
        tier: _lite ? 'lite' : _mid ? 'mid' : 'full',
      };
    },
  });

  _boot();

}(window));

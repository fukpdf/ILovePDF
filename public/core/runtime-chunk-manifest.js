// core/runtime-chunk-manifest.js
// Phase 2 — Task 5 (Chunk Manifest) + Task 11 (Build Pipeline Preparation)
//
// RuntimeChunkManifest
// =====================
// Central registry for all runtime chunks loaded by this platform.
// Phase 2 role: track chunks, version-pin them, support integrity validation.
// Phase 3 role (hooks prepared): hash-based verification, encrypted chunk keys,
//                                WASM pre-validation, polymorphic build tokens.
//
// Architecture:
//   Each chunk entry carries: { id, path, version, hash?, critical, lazy }
//   "hash" is undefined in Phase 2 and will be populated by the build pipeline
//   in Phase 3 when content-addressable serving is enabled.
//
// Device tiering (Task 10):
//   score < 40 → lite: manifest loaded but validation skipped
//   score ≥ 40 → validation active

(function (G) {
  'use strict';

  if (G.RuntimeChunkManifest) return;

  const VERSION      = '1.0';
  const MANIFEST_VER = '2.0.0';  // platform version — bump when chunks change

  // ── Device tier ─────────────────────────────────────────────────────────────
  const _score = (G.RuntimeDeviceLite && typeof G.RuntimeDeviceLite.score === 'number')
    ? G.RuntimeDeviceLite.score
    : 70;
  const _lite = _score < 40;

  // ── Chunk catalogue ──────────────────────────────────────────────────────────
  // critical: must load for the tool to function
  // lazy:     deferred / idle-loaded
  // hash:     null in Phase 2 — will be set by build pipeline in Phase 3

  const _chunks = [
    // ── Phase 1 Shield Layer ─────────────────────────────────────────────────
    { id: 'shield-core',         path: '/js/runtime-shield-core.js',         version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'shield-integrity',    path: '/js/runtime-shield-integrity.js',    version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'shield-workers',      path: '/js/runtime-shield-workers.js',      version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'shield-dependency',   path: '/js/runtime-shield-dependency.js',   version: '1.0', critical: true,  lazy: false, hash: null },

    // ── Phase 2 Runtime Manifest + Workers ───────────────────────────────────
    { id: 'runtime-manifest',    path: '/js/runtime-manifest.js',            version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'worker-factory',      path: '/js/runtime-worker-factory.js',      version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'chunk-manifest',      path: '/core/runtime-chunk-manifest.js',    version: '1.0', critical: true,  lazy: false, hash: null },

    // ── Bootstrap / utility ──────────────────────────────────────────────────
    { id: 'pwa-register',        path: '/js/pwa-register.js',                version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'footer-lang',         path: '/js/footer-lang.js',                 version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'chrome-shim',         path: '/js/chrome-shim.js',                 version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'about-contact-form',  path: '/js/about-contact-form.js',          version: '1.0', critical: false, lazy: true,  hash: null },

    // ── Tool shell ───────────────────────────────────────────────────────────
    { id: 'runtime-protection',  path: '/js/runtime-protection.js',          version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'chrome',              path: '/js/chrome.js',                      version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'tools-config',        path: '/js/tools-config.js',                version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'tool-page',           path: '/js/tool-page.js',                   version: '23',  critical: true,  lazy: false, hash: null },
    { id: 'shared',              path: '/js/shared.js',                      version: '23',  critical: true,  lazy: false, hash: null },
    { id: 'auth-ui',             path: '/js/auth-ui.js',                     version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'i18n',                path: '/js/i18n.js',                        version: '23',  critical: true,  lazy: false, hash: null },
    { id: 'live-preview',        path: '/js/live-preview.js',                version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'advanced-engine',     path: '/js/advanced-engine.js',             version: '1.0', critical: true,  lazy: false, hash: null },

    // ── Core runtime phases ───────────────────────────────────────────────────
    { id: 'core-manifest',       path: '/core/core-manifest.js',             version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'shared-constants',    path: '/core/shared-constants.js',          version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'runtime-contracts',   path: '/core/runtime-contracts.js',         version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'runtime-federation',  path: '/core/runtime-federation.js',        version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'ai-runtime',          path: '/core/ai-runtime.js',                version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-governor',    path: '/core/runtime-governor.js',          version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'production-mode',     path: '/core/production-mode.js',           version: '1.0', critical: true,  lazy: false, hash: null },

    // ── Analytics / economy (lazy) ────────────────────────────────────────────
    { id: 'runtime-analytics',   path: '/js/runtime-analytics.js',           version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-identity',    path: '/js/runtime-identity.js',            version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-savings',     path: '/js/runtime-savings.js',             version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-ads',         path: '/js/runtime-ads.js',                 version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-credits',     path: '/js/runtime-credits.js',             version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-donation',    path: '/js/runtime-donation.js',            version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-offline',     path: '/js/runtime-offline.js',             version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-updater',     path: '/js/runtime-updater.js',             version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'runtime-perf',        path: '/js/runtime-perf.js',                version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'savings-animation',   path: '/js/savings-animation.js',           version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'community-economy',   path: '/js/community-economy.js',           version: '1.0', critical: false, lazy: true,  hash: null },

    // ── AI/Laba (lazy) ────────────────────────────────────────────────────────
    { id: 'bg-ai-engine',        path: '/js/bg-ai-engine.js',                version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'bg-remover-pro',      path: '/js/bg-remover-pro.js',              version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'laba-widget',         path: '/laba/laba-widget.js',               version: '1.0', critical: false, lazy: true,  hash: null },

    // ── Workers (spawned on demand, not preloaded) ────────────────────────────
    { id: 'w-compress',          path: '/workers/compress-worker.js',        version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-pdf-lib',           path: '/workers/pdf-lib-worker.js',         version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-docx',              path: '/workers/pdf-word-docx-worker.js',   version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-xlsx',              path: '/workers/pdf-xlsx-worker.js',        version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-pptx',              path: '/workers/pdf-pptx-worker.js',        version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-image',             path: '/workers/image-worker.js',           version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-repair',            path: '/workers/repair-worker.js',          version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-remove-bg',         path: '/workers/remove-bg-worker.js',       version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-ai-summary',        path: '/workers/ai-summary-worker.js',      version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-compare',           path: '/workers/compare-worker.js',         version: '1.0', critical: false, lazy: true,  hash: null },
    { id: 'w-pipeline',          path: '/workers/pipeline-worker.js',        version: '1.0', critical: false, lazy: true,  hash: null },

    // ── Phase 3 Security Layer ────────────────────────────────────────────────
    { id: 'p3-security-tiers',   path: '/js/runtime-security-tiers.js',      version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'p3-sec-telemetry',    path: '/js/runtime-security-telemetry.js',  version: '1.0', critical: true,  lazy: false, hash: null },
    { id: 'p3-sri-engine',       path: '/js/runtime-sri-engine.js',          version: '1.0', critical: false, lazy: false, hash: null },
    { id: 'p3-worker-bootstrap', path: '/js/runtime-worker-bootstrap.js',    version: '1.0', critical: false, lazy: false, hash: null },
    { id: 'p3-wasm-registry',    path: '/js/runtime-wasm-registry.js',       version: '1.0', critical: false, lazy: false, hash: null },
    { id: 'p3-perf-safety',      path: '/js/runtime-perf-safety.js',         version: '1.0', critical: false, lazy: false, hash: null },
    { id: 'p3-foreign-deploy',   path: '/js/runtime-foreign-deploy.js',      version: '1.0', critical: false, lazy: false, hash: null },
  ];

  // ── Internal map for O(1) lookup ──────────────────────────────────────────────
  const _byId   = new Map(_chunks.map(c => [c.id, c]));
  const _byPath = new Map(_chunks.map(c => [c.path, c]));

  // ── Loaded set (populated by RuntimeChunkManifest.markLoaded) ───────────────
  const _loaded = new Set();

  // ── Build pipeline preparation hooks (Task 11) ────────────────────────────────
  // Empty in Phase 2. Phase 3 will wire these into the server-side build step.
  const _pipelineHooks = {
    // fn(chunkId, uint8Array) → Promise<boolean>  — verify chunk hash before exec
    verifyChunk:    null,
    // fn(chunkId) → Promise<string>               — fetch decryption key for encrypted chunk
    fetchChunkKey:  null,
    // fn(chunkId, token) → string                 — apply polymorphic token to chunk src
    applyToken:     null,
    // fn(chunkId) → { wasm: ArrayBuffer }         — load WASM module from manifest
    loadWasm:       null,
    // fn() → string                               — refresh build-time obfuscation token
    refreshToken:   null,
  };

  // ── Integrity enforcement state ───────────────────────────────────────────────
  // Phase 2: advisory only. Phase 3: set _enforce = true to block unknown chunks.
  let _enforce = false;

  // ── Violation log ─────────────────────────────────────────────────────────────
  const _violations = [];

  function _reportViolation(type, chunk) {
    const v = { type, chunk, ts: Date.now() };
    _violations.push(v);
    console.warn('[RuntimeChunkManifest]', type, chunk);
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  G.RuntimeChunkManifest = Object.freeze({
    VERSION,
    MANIFEST_VER,

    /** Return the chunk entry for a given id (or undefined). */
    get(id) { return _byId.get(id); },

    /** Return the chunk entry for a given path (or undefined). */
    getByPath(path) { return _byPath.get(path); },

    /** True if the chunk id is in the manifest. */
    has(id) { return _byId.has(id); },

    /** True if the path is in the manifest. */
    hasPath(path) { return _byPath.has(path); },

    /** Mark a chunk as loaded (called by the loader / chunk validator). */
    markLoaded(id) { _loaded.add(id); },

    /** Return all loaded chunk IDs. */
    getLoaded() { return Array.from(_loaded); },

    /** Return all critical chunks (for preload hinting). */
    getCritical() { return _chunks.filter(c => c.critical); },

    /** Return all lazy chunks. */
    getLazy() { return _chunks.filter(c => c.lazy); },

    /**
     * Validate a chunk path. Returns true if the path is in the manifest.
     * Phase 2: advisory — unknown chunks generate a warning, not a block.
     * Phase 3: set _enforce=true to cause unknown chunks to be blocked.
     */
    validatePath(path) {
      if (_lite) return true;
      const chunk = _byPath.get(path);
      if (!chunk) {
        if (_enforce) {
          _reportViolation('unknown-chunk-blocked', path);
          return false;
        }
        // Advisory: log but allow
        console.info('[RuntimeChunkManifest] unknown chunk path (advisory):', path);
        return true;
      }
      return true;
    },

    /**
     * Register a hash for a chunk (Phase 3 build pipeline hook).
     * Stores the hash in the manifest entry for future verification.
     */
    registerHash(id, sha256hex) {
      const chunk = _byId.get(id);
      if (chunk) chunk.hash = sha256hex;
    },

    /** Register a Phase-3 pipeline hook. */
    registerHook(name, fn) {
      if (name in _pipelineHooks && typeof fn === 'function') {
        _pipelineHooks[name] = fn;
      }
    },

    /** Enable enforcement mode (Phase 3 — blocks unknown chunks). */
    enableEnforcement() { _enforce = true; },

    /** Diagnostic dump. */
    audit() {
      return {
        manifestVersion: MANIFEST_VER,
        totalChunks:     _chunks.length,
        loadedChunks:    Array.from(_loaded),
        violations:      _violations.slice(),
        enforce:         _enforce,
        deviceScore:     _score,
        tier:            _lite ? 'lite' : 'full',
      };
    },

    /** All chunks (read-only copy). */
    all() { return _chunks.map(c => Object.assign({}, c)); },
  });

}(window));

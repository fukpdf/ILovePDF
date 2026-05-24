// ── Arc 3 Tool Runtime Isolation — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-24T14:32:06.374Z  BUILD_ID: mpjvm4kv
// Files: 9

// ── SOURCE: public/js/runtime-tool-manifest-registry.js ──
// RuntimeToolManifestRegistry v1.0 — Arc 3 / Phase A / Target 1
// =====================================================================
// Source-of-truth for per-tool runtime manifests.
//
// Each manifest defines:
//   toolId          — canonical tool identifier
//   family          — functional family name
//   workers[]       — worker script URLs this tool may use
//   hydrationTier   — P0 / P1 / P2 (when to initialise this tool's runtime)
//   memoryBudgetMb  — soft per-tool memory ceiling (MB)
//   recoveryPolicy  — 'isolate' | 'restart' | 'reload'
//   analyticsScope  — grouping namespace for health/analytics reporting
//   bundleGroups[]  — RuntimeBundleRegistry group names to activate
//   offlineCapable  — true if tool can process without network
//   thermalPolicy   — 'throttle' | 'pause' | 'normal'
//
// Tools that share a family inherit the family manifest unless overridden.
//
// Usage:
//   RuntimeToolManifestRegistry.get('ocr')      → manifest object | null
//   RuntimeToolManifestRegistry.activate('ocr') → marks tool as active
//   RuntimeToolManifestRegistry.isActive('ocr') → bool
//   RuntimeToolManifestRegistry.register(toolId, overrides) → custom override
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolManifestRegistry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ManifestReg]';
  var VERSION = '1.0';

  // ── Family base manifests ─────────────────────────────────────────────────
  var FAMILIES = {
    'organize': {
      family:         'organize',
      workers:        ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
      hydrationTier:  'P1',
      memoryBudgetMb: 128,
      recoveryPolicy: 'isolate',
      analyticsScope: 'pdf-organize',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'normal',
    },
    'compress': {
      family:         'compress',
      workers:        ['/workers/compress-worker.js'],
      hydrationTier:  'P1',
      memoryBudgetMb: 192,
      recoveryPolicy: 'isolate',
      analyticsScope: 'pdf-compress',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'throttle',
    },
    'convert-from': {
      family:         'convert-from',
      workers:        [
        '/workers/pdf-word-docx-worker.js',
        '/workers/pdf-excel-xlsx-worker.js',
        '/workers/pdf-ppt-pptx-worker.js',
      ],
      hydrationTier:  'P1',
      memoryBudgetMb: 256,
      recoveryPolicy: 'isolate',
      analyticsScope: 'pdf-convert-from',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'throttle',
    },
    'convert-to': {
      family:         'convert-to',
      workers:        [
        '/workers/pdf-word-docx-worker.js',
        '/workers/pdf-excel-xlsx-worker.js',
        '/workers/pdf-ppt-pptx-worker.js',
        '/workers/pdf-lib-worker.js',
      ],
      hydrationTier:  'P1',
      memoryBudgetMb: 192,
      recoveryPolicy: 'isolate',
      analyticsScope: 'pdf-convert-to',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'throttle',
    },
    'edit': {
      family:         'edit',
      workers:        ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
      hydrationTier:  'P1',
      memoryBudgetMb: 128,
      recoveryPolicy: 'isolate',
      analyticsScope: 'pdf-edit',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'normal',
    },
    'ai': {
      family:         'ai',
      workers:        [
        '/workers/advanced-worker.js',
        '/workers/summary-worker.js',
        '/workers/translation-worker.js',
        '/workers/ocr-preprocessor-worker.js',
      ],
      hydrationTier:  'P2',
      memoryBudgetMb: 512,
      recoveryPolicy: 'restart',
      analyticsScope: 'ai-tools',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'throttle',
    },
    'image': {
      family:         'image',
      workers:        [
        '/workers/image-tools-worker.js',
        '/workers/image-pipeline-worker.js',
        '/workers/remove-bg-worker.js',
      ],
      hydrationTier:  'P1',
      memoryBudgetMb: 256,
      recoveryPolicy: 'isolate',
      analyticsScope: 'image-tools',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'throttle',
    },
    'utility': {
      family:         'utility',
      workers:        [],
      hydrationTier:  'P0',
      memoryBudgetMb: 32,
      recoveryPolicy: 'isolate',
      analyticsScope: 'utility-tools',
      bundleGroups:   [],
      offlineCapable: true,
      thermalPolicy:  'normal',
    },
  };

  // ── Tool → family mapping ─────────────────────────────────────────────────
  var TOOL_FAMILY = {
    // Organize family
    'merge':           'organize',
    'split':           'organize',
    'rotate':          'organize',
    'crop':            'organize',
    'organize':        'organize',
    'page-numbers':    'organize',
    'redact':          'organize',
    // Compress
    'compress':        'compress',
    // Convert-from PDF
    'pdf-to-word':     'convert-from',
    'pdf-to-excel':    'convert-from',
    'pdf-to-powerpoint':'convert-from',
    'pdf-to-jpg':      'convert-from',
    // Convert-to PDF
    'word-to-pdf':     'convert-to',
    'excel-to-pdf':    'convert-to',
    'powerpoint-to-pdf':'convert-to',
    'jpg-to-pdf':      'convert-to',
    'html-to-pdf':     'convert-to',
    'scan-to-pdf':     'convert-to',
    'word-to-excel':   'convert-to',
    // Edit
    'edit':            'edit',
    'watermark':       'edit',
    'sign':            'edit',
    'protect':         'edit',
    'unlock':          'edit',
    'repair':          'edit',
    'compare':         'edit',
    // AI
    'ocr':             'ai',
    'ai-summarize':    'ai',
    'translate':       'ai',
    'workflow':        'ai',
    // Image
    'background-remover': 'image',
    'crop-image':      'image',
    'resize-image':    'image',
    'image-filters':   'image',
    'image-compressor':'image',
    'image-converter': 'image',
    'qr-code-generator':'image',
    'barcode-generator':'image',
    'zip-builder':     'image',
    // Utility
    'numbers-to-words':'utility',
    'currency-converter':'utility',
  };

  // ── Per-tool overrides ─────────────────────────────────────────────────────
  var _overrides = {};

  // ── Active tools registry ─────────────────────────────────────────────────
  var _active = {};

  // ── Build manifest for a toolId ───────────────────────────────────────────
  function _build(toolId) {
    var family = TOOL_FAMILY[toolId];
    if (!family) return null;
    var base   = FAMILIES[family] || {};
    var over   = _overrides[toolId] || {};
    var m = Object.assign({}, base, over, { toolId: toolId, family: family });
    return Object.freeze(m);
  }

  function _get(toolId) {
    return _build(toolId);
  }

  function _activate(toolId) {
    var m = _build(toolId);
    if (!m) { console.debug(LOG, 'unknown toolId:', toolId); return; }
    _active[toolId] = true;
    try {
      G.dispatchEvent(new CustomEvent('tool:manifest-activated', {
        detail: { toolId: toolId, family: m.family },
      }));
    } catch (_) {}
    console.debug(LOG, 'activated:', toolId, '— family:', m.family);
  }

  function _register(toolId, overrides) {
    if (!overrides || typeof overrides !== 'object') return;
    _overrides[toolId] = Object.assign({}, _overrides[toolId] || {}, overrides);
  }

  G.RuntimeToolManifestRegistry = Object.freeze({
    VERSION:    VERSION,
    get:        _get,
    activate:   _activate,
    isActive:   function (toolId) { return !!_active[toolId]; },
    register:   _register,
    getFamily:  function (toolId) { return TOOL_FAMILY[toolId] || null; },
    getFamilies: function () { return Object.keys(FAMILIES); },
    getActiveTools: function () { return Object.keys(_active).filter(function (k) { return _active[k]; }); },
  });

}(window));

// ── SOURCE: public/js/runtime-tool-loader.js ──
// RuntimeToolLoader v1.0 — Arc 3 / Phase A / Target 2
// =====================================================================
// Tool-aware boot sequencer.
//
// At DOMContentLoaded:
//   1. Resolves current toolId from URL (via window.resolveToolIdFromUrl)
//   2. Looks up manifest in RuntimeToolManifestRegistry
//   3. Activates the tool's hydration domain
//   4. Registers the tool's worker domain
//   5. Locks the tool's runtime config
//   6. Activates memory island for the tool
//   7. Opens analytics domain for the tool
//   8. Emits 'tool:runtime-ready' event
//
// If no toolId (e.g. homepage), boots in 'platform' mode (all P0 only).
// If tool is unknown, logs a debug warning and boots in 'generic' mode.
//
// The loader is a lightweight coordinator — it calls into other Arc 3
// modules that have already been loaded via deferred script tags.
//
// Boot is idempotent: repeated calls for the same toolId are no-ops.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolLoader) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ToolLoader]';
  var VERSION = '1.0';

  var _toolId  = null;
  var _manifest = null;
  var _booted  = false;

  // ── Safe caller ───────────────────────────────────────────────────────────
  function _safeCall(label, fn) {
    try { fn(); } catch (e) { console.debug(LOG, label, 'error:', e && e.message || e); }
  }

  // ── Resolve current tool ──────────────────────────────────────────────────
  function _resolveToolId() {
    try {
      if (typeof G.resolveToolIdFromUrl === 'function') {
        return G.resolveToolIdFromUrl() || null;
      }
    } catch (_) {}
    // Fallback: read from injected global
    try { if (G.__TOOL_ID) return G.__TOOL_ID; } catch (_) {}
    return null;
  }

  // ── Activate hydration domain ─────────────────────────────────────────────
  function _activateHydration(toolId, manifest) {
    _safeCall('hydration-domain', function () {
      var hd = G.RuntimeHydrationDomains;
      if (!hd) return;
      hd.createDomain(toolId, manifest ? manifest.hydrationTier : 'P2');
    });
  }

  // ── Register worker domain ────────────────────────────────────────────────
  function _activateWorkerDomain(toolId, manifest) {
    _safeCall('worker-domain', function () {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (!wd) return;
      var family = manifest ? manifest.family : null;
      if (family) wd.ensureDomain(family);
      wd.setActiveTool(toolId);
    });
  }

  // ── Lock tool config ──────────────────────────────────────────────────────
  function _lockConfig(toolId, manifest) {
    _safeCall('config-lock', function () {
      var cl = G.RuntimeToolConfigLock;
      if (!cl || !manifest) return;
      cl.lock(toolId, {
        family:         manifest.family,
        hydrationTier:  manifest.hydrationTier,
        memoryBudgetMb: manifest.memoryBudgetMb,
        recoveryPolicy: manifest.recoveryPolicy,
        thermalPolicy:  manifest.thermalPolicy,
        offlineCapable: manifest.offlineCapable,
      });
    });
  }

  // ── Activate memory island ────────────────────────────────────────────────
  function _activateMemoryIsland(toolId, manifest) {
    _safeCall('memory-island', function () {
      var mi = G.RuntimeMemoryIslands;
      if (!mi || !manifest) return;
      mi.allocate(toolId, manifest.memoryBudgetMb || 128);
    });
  }

  // ── Open analytics domain ─────────────────────────────────────────────────
  function _openAnalyticsDomain(toolId, manifest) {
    _safeCall('analytics-domain', function () {
      var ad = G.RuntimeAnalyticsDomains;
      if (!ad || !manifest) return;
      ad.open(toolId, manifest.analyticsScope || 'unknown');
    });
  }

  // ── Activate bundle segments ──────────────────────────────────────────────
  function _activateBundleSegments(toolId, manifest) {
    _safeCall('bundle-segments', function () {
      var bs = G.RuntimeToolBundleSegments;
      if (!bs || !manifest) return;
      bs.activateForTool(toolId, manifest.family);
    });
  }

  // ── Open recovery domain ──────────────────────────────────────────────────
  function _openRecoveryDomain(toolId, manifest) {
    _safeCall('recovery-domain', function () {
      var rd = G.RuntimeRecoveryDomains;
      if (!rd || !manifest) return;
      rd.ensureDomain(toolId, manifest.recoveryPolicy || 'isolate');
    });
  }

  // ── Main boot ─────────────────────────────────────────────────────────────
  function _boot() {
    if (_booted) return;
    _booted = true;

    _toolId   = _resolveToolId();
    _manifest = null;

    if (_toolId) {
      _safeCall('manifest-lookup', function () {
        var mr = G.RuntimeToolManifestRegistry;
        if (mr) {
          _manifest = mr.get(_toolId);
          mr.activate(_toolId);
        }
      });
    }

    console.debug(LOG, 'boot — toolId:', _toolId || '(none)', '— family:', _manifest ? _manifest.family : 'n/a');

    // Always activate regardless of whether manifest was found
    _activateHydration(_toolId, _manifest);
    _activateWorkerDomain(_toolId, _manifest);
    _lockConfig(_toolId, _manifest);
    _activateMemoryIsland(_toolId, _manifest);
    _openAnalyticsDomain(_toolId, _manifest);
    _activateBundleSegments(_toolId, _manifest);
    _openRecoveryDomain(_toolId, _manifest);

    _safeCall('dispatch-ready', function () {
      G.dispatchEvent(new CustomEvent('tool:runtime-ready', {
        detail: {
          toolId:   _toolId,
          family:   _manifest ? _manifest.family : null,
          manifest: _manifest,
        },
        bubbles: false,
      }));
    });

    console.debug(LOG, 'tool runtime ready — toolId:', _toolId);
  }

  // ── Deferred boot (after all Arc 3 files have loaded) ────────────────────
  function _deferredBoot() {
    // Use a brief timeout so all deferred scripts have executed first
    setTimeout(_boot, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _deferredBoot, { once: true });
  } else {
    _deferredBoot();
  }

  G.RuntimeToolLoader = Object.freeze({
    VERSION:     VERSION,
    getToolId:   function () { return _toolId; },
    getManifest: function () { return _manifest; },
    isBooted:    function () { return _booted; },
    boot:        _boot, // allow manual re-trigger for SPAs
  });

}(window));

// ── SOURCE: public/js/runtime-hydration-domains.js ──
// RuntimeHydrationDomains v1.0 — Arc 3 / Phase B / Target 3
// =====================================================================
// Per-tool isolated hydration queues.
//
// Problem: RuntimeHydrationScheduler is globally shared. Activating P2 for
// OCR triggers all globally-registered P2 modules (including those for
// Merge PDF, Compress, etc.) — wasting cycles and causing cross-tool
// interference.
//
// Solution: Each tool gets its own hydration domain with independent
// P0/P1/P2 queues and activation flags. Modules register with a toolId
// instead of (or in addition to) the global scheduler.
//
// Domain lifecycle:
//   createDomain(toolId, defaultTier) → domain object
//   register(toolId, name, fn, tier)  → enqueue module
//   activate(toolId, tier)            → flush that tier's queue
//   activateAll(toolId)               → flush all tiers
//
// Domains are automatically flushed by RuntimeToolLoader after manifest
// activation.
//
// The global RuntimeHydrationScheduler is preserved and continues to run
// for modules that don't use tool-scoped registration.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHydrationDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HydDomains]';
  var VERSION = '1.0';

  // ── Domain registry ───────────────────────────────────────────────────────
  var _domains = {};

  function _now() { return Date.now(); }

  function _newDomain(toolId, defaultTier) {
    return {
      toolId:    toolId,
      defaultTier: defaultTier || 'P2',
      registry:  [],
      activated: { P0: false, P1: false, P2: false },
      metrics:   { P0: null, P1: null, P2: null },
    };
  }

  function createDomain(toolId, defaultTier) {
    if (_domains[toolId]) return _domains[toolId];
    _domains[toolId] = _newDomain(toolId, defaultTier);
    console.debug(LOG, 'domain created:', toolId, '— defaultTier:', defaultTier || 'P2');
    return _domains[toolId];
  }

  // ── Run one tier within a domain ──────────────────────────────────────────
  function _runTier(domain, tier) {
    if (domain.activated[tier]) return;
    domain.activated[tier] = true;
    var start   = _now();
    var modules = domain.registry.filter(function (m) { return m.tier === tier && !m.activated; });

    modules.forEach(function (m) {
      try {
        var t0 = _now();
        m.fn();
        m.activated  = true;
        m.durationMs = _now() - t0;
      } catch (e) {
        console.debug(LOG, 'module error:', domain.toolId, '/', m.name, e && e.message || e);
      }
    });

    var dur = _now() - start;
    domain.metrics[tier] = { startTs: start, durationMs: dur, count: modules.length };
    console.debug(LOG, domain.toolId, tier, 'activated —', modules.length, 'modules in', dur + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('hydration-domain:activated', {
        detail: { toolId: domain.toolId, tier: tier, durationMs: dur },
      }));
    } catch (_) {}
  }

  // ── Schedule a tier with appropriate timing ───────────────────────────────
  function _scheduleTier(domain, tier) {
    if (tier === 'P0') {
      _runTier(domain, 'P0');
      return;
    }
    if (tier === 'P1') {
      if (G.requestIdleCallback) {
        G.requestIdleCallback(function () { _runTier(domain, 'P1'); }, { timeout: 1000 });
      } else {
        setTimeout(function () { _runTier(domain, 'P1'); }, 500);
      }
      return;
    }
    if (tier === 'P2') {
      // First interaction or 5s timeout
      var triggered = false;
      var handlers  = ['click', 'touchstart', 'keydown', 'scroll'];
      var timer     = null;
      function trigger() {
        if (triggered) return;
        triggered = true;
        clearTimeout(timer);
        handlers.forEach(function (ev) {
          document.removeEventListener(ev, trigger, true);
        });
        _runTier(domain, 'P2');
      }
      handlers.forEach(function (ev) {
        document.addEventListener(ev, trigger, { passive: true, capture: true, once: true });
      });
      timer = setTimeout(trigger, 5000);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function register(toolId, name, fn, tier) {
    if (typeof fn !== 'function') return;
    var domain = _domains[toolId];
    if (!domain) domain = createDomain(toolId);

    var t = (tier === 'P0' || tier === 'P1' || tier === 'P2') ? tier : (domain.defaultTier || 'P2');
    domain.registry.push({ name: name, fn: fn, tier: t, activated: false, durationMs: null });

    // Late-register: if tier already active, run immediately
    if (domain.activated[t]) {
      try {
        var t0 = _now();
        fn();
        domain.registry[domain.registry.length - 1].activated  = true;
        domain.registry[domain.registry.length - 1].durationMs = _now() - t0;
      } catch (e) { console.debug(LOG, 'late-register error:', toolId, '/', name, e); }
    }
  }

  function activate(toolId, tier) {
    var domain = _domains[toolId];
    if (!domain) domain = createDomain(toolId);
    _runTier(domain, tier);
  }

  function activateAll(toolId) {
    var domain = _domains[toolId];
    if (!domain) domain = createDomain(toolId);
    _runTier(domain, 'P0');
    _scheduleTier(domain, 'P1');
    _scheduleTier(domain, 'P2');
  }

  function getMetrics(toolId) {
    var domain = _domains[toolId];
    if (!domain) return null;
    return {
      toolId:    toolId,
      activated: Object.assign({}, domain.activated),
      metrics:   Object.assign({}, domain.metrics),
      modules:   domain.registry.map(function (m) {
        return { name: m.name, tier: m.tier, activated: m.activated, durationMs: m.durationMs };
      }),
    };
  }

  G.RuntimeHydrationDomains = Object.freeze({
    VERSION:     VERSION,
    createDomain: createDomain,
    register:    register,
    activate:    activate,
    activateAll: activateAll,
    getMetrics:  getMetrics,
    getDomains:  function () { return Object.keys(_domains); },
  });

}(window));

// ── SOURCE: public/js/runtime-worker-domain-registry.js ──
// RuntimeWorkerDomainRegistry v1.0 — Arc 3 / Phase C / Target 4
// =====================================================================
// Per-family worker domain isolation.
//
// Problem: RuntimeWorkerCoordinator applies a single global thermal limit
// and congestion ceiling. OCR memory pressure throttles the Merge PDF
// tool — unrelated and unnecessary.
//
// Solution: Group tools into 7 worker families. Each family has its own
// pressure state, crash counter, and active-slot tracking. Memory
// pressure or crashes in one family do not affect other families.
//
// Families:
//   organize    — merge, split, rotate, crop, organize, page-numbers, redact
//   compress    — compress
//   convert-from — pdf-to-word, pdf-to-excel, pdf-to-powerpoint, pdf-to-jpg
//   convert-to  — word-to-pdf, excel-to-pdf, powerpoint-to-pdf, etc.
//   edit        — edit, watermark, sign, protect, unlock, repair, compare
//   ai          — ocr, ai-summarize, translate, workflow
//   image       — background-remover, crop-image, resize-image, etc.
//   utility     — numbers-to-words, currency-converter
//
// WorkerPool itself remains untouched — this registry tracks domain-level
// metadata and provides domain-scoped stats for RuntimeHealthAnalytics.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerDomainRegistry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[WorkerDomReg]';
  var VERSION = '1.0';

  // ── Family → worker URL mapping ───────────────────────────────────────────
  var FAMILY_WORKERS = {
    'organize':     ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
    'compress':     ['/workers/compress-worker.js'],
    'convert-from': ['/workers/pdf-word-docx-worker.js', '/workers/pdf-excel-xlsx-worker.js', '/workers/pdf-ppt-pptx-worker.js'],
    'convert-to':   ['/workers/pdf-word-docx-worker.js', '/workers/pdf-excel-xlsx-worker.js', '/workers/pdf-ppt-pptx-worker.js', '/workers/pdf-lib-worker.js'],
    'edit':         ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
    'ai':           ['/workers/advanced-worker.js', '/workers/summary-worker.js', '/workers/translation-worker.js', '/workers/ocr-preprocessor-worker.js'],
    'image':        ['/workers/image-tools-worker.js', '/workers/image-pipeline-worker.js', '/workers/remove-bg-worker.js'],
    'utility':      [],
  };

  // ── Tool → family ─────────────────────────────────────────────────────────
  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to','word-to-excel':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ai-summarize':'ai','translate':'ai','workflow':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'qr-code-generator':'image','barcode-generator':'image','zip-builder':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Domain state ──────────────────────────────────────────────────────────
  // family → { workers[], activeCount, crashCount, pressured, pressuredAt }
  var _domains = {};

  function _newDomain(family) {
    return {
      family:      family,
      workers:     (FAMILY_WORKERS[family] || []).slice(),
      activeCount: 0,
      crashCount:  0,
      pressured:   false,
      pressuredAt: 0,
    };
  }

  function ensureDomain(family) {
    if (!_domains[family]) {
      _domains[family] = _newDomain(family);
      console.debug(LOG, 'domain created:', family);
    }
    return _domains[family];
  }

  // ── Active tool tracking ──────────────────────────────────────────────────
  var _activeTool   = null;
  var _activeFamily = null;

  function setActiveTool(toolId) {
    _activeTool   = toolId;
    _activeFamily = TOOL_FAMILY[toolId] || null;
    if (_activeFamily) ensureDomain(_activeFamily);
    console.debug(LOG, 'active tool:', toolId, '→ family:', _activeFamily);
  }

  // ── Domain pressure ───────────────────────────────────────────────────────
  function setPressure(family, pressured) {
    var domain = ensureDomain(family);
    domain.pressured   = pressured;
    domain.pressuredAt = pressured ? Date.now() : 0;
    console.debug(LOG, 'pressure:', family, pressured);
  }

  function isPressured(family) {
    var domain = _domains[family];
    if (!domain) return false;
    // Auto-clear pressure after 60s
    if (domain.pressured && (Date.now() - domain.pressuredAt) > 60000) {
      domain.pressured = false;
    }
    return domain.pressured;
  }

  // ── Domain crash tracking ─────────────────────────────────────────────────
  function recordCrash(toolId) {
    var family = TOOL_FAMILY[toolId] || _activeFamily;
    if (!family) return;
    var domain = ensureDomain(family);
    domain.crashCount++;
    if (domain.crashCount >= 3) {
      setPressure(family, true);
    }
    try {
      G.dispatchEvent(new CustomEvent('worker-domain:crash', {
        detail: { family: family, toolId: toolId, crashCount: domain.crashCount },
      }));
    } catch (_) {}
    console.debug(LOG, 'crash recorded:', family, '— total:', domain.crashCount);
  }

  // ── Stats for RuntimeHealthAnalytics ─────────────────────────────────────
  function getStats(family) {
    var domain = _domains[family];
    if (!domain) return null;
    return {
      family:      domain.family,
      workers:     domain.workers.length,
      activeCount: domain.activeCount,
      crashCount:  domain.crashCount,
      pressured:   domain.pressured,
    };
  }

  function getAllStats() {
    var out = {};
    Object.keys(_domains).forEach(function (f) { out[f] = getStats(f); });
    return out;
  }

  // ── Listen for WorkerPool crash events ───────────────────────────────────
  G.addEventListener('workerpool:crash', function (evt) {
    try {
      var detail = evt && evt.detail;
      var toolId = detail && (detail.toolId || _activeTool);
      if (toolId) recordCrash(toolId);
    } catch (_) {}
  });

  G.RuntimeWorkerDomainRegistry = Object.freeze({
    VERSION:       VERSION,
    ensureDomain:  ensureDomain,
    setActiveTool: setActiveTool,
    getActiveTool: function () { return _activeTool; },
    getFamily:     function (toolId) { return TOOL_FAMILY[toolId] || null; },
    isPressured:   isPressured,
    setPressure:   setPressure,
    recordCrash:   recordCrash,
    getStats:      getStats,
    getAllStats:    getAllStats,
  });

}(window));

// ── SOURCE: public/js/runtime-memory-islands.js ──
// RuntimeMemoryIslands v1.0 — Arc 3 / Phase D / Target 5
// =====================================================================
// Per-tool memory budgets + isolated cleanup.
//
// Problem: OCR memory spikes silently exhaust heap shared by all tools.
// RuntimeWorkerCoordinator applies a global memory throttle that mutes
// the Compress tool when an unrelated AI job is running.
//
// Solution: Each active tool gets a soft memory budget (from manifest).
// Periodic sweeps compare heap usage against per-tool allocation.
// When a tool's allocation is exceeded, ONLY that tool's caches and
// idle workers are trimmed — other tool domains are untouched.
//
// Budget model (soft, advisory):
//   Total heap limit distributed across active tools by weight.
//   A tool that has been idle > IDLE_TTL_MS auto-trims itself.
//   Inactive tools release their budget slot.
//
// Integrates with:
//   RuntimeWorkerDomainRegistry — for idle-worker termination signals
//   RuntimeHealthAnalytics      — per-tool memory score
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMemoryIslands) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG          = '[MemIslands]';
  var VERSION      = '1.0';
  var IDLE_TTL_MS  = 90 * 1000;   // 90s idle → auto-trim
  var SWEEP_MS     = 30 * 1000;   // budget sweep interval
  var DEFAULT_MB   = 128;         // default budget if no manifest

  // ── Island registry ───────────────────────────────────────────────────────
  // toolId → { budgetMb, lastActivityAt, caches: Map, trimHandlers[] }
  var _islands = {};

  function _newIsland(toolId, budgetMb) {
    return {
      toolId:         toolId,
      budgetMb:       budgetMb || DEFAULT_MB,
      allocatedAt:    Date.now(),
      lastActivityAt: Date.now(),
      caches:         {},     // name → { size, trimFn }
      trimHandlers:   [],
      trimCount:      0,
    };
  }

  // ── Allocate a memory island for a tool ───────────────────────────────────
  function allocate(toolId, budgetMb) {
    if (_islands[toolId]) {
      _islands[toolId].budgetMb       = budgetMb || DEFAULT_MB;
      _islands[toolId].lastActivityAt = Date.now();
      return _islands[toolId];
    }
    _islands[toolId] = _newIsland(toolId, budgetMb);
    console.debug(LOG, 'allocated:', toolId, '—', budgetMb, 'MB');
    return _islands[toolId];
  }

  // ── Register a trim handler for a tool ───────────────────────────────────
  function registerTrimHandler(toolId, name, fn) {
    var island = _islands[toolId];
    if (!island) island = allocate(toolId);
    island.trimHandlers.push({ name: name, fn: fn });
  }

  // ── Register a named cache entry ──────────────────────────────────────────
  function registerCache(toolId, name, trimFn, estimatedSizeMb) {
    var island = _islands[toolId];
    if (!island) island = allocate(toolId);
    island.caches[name] = {
      name:            name,
      estimatedSizeMb: estimatedSizeMb || 0,
      trimFn:          trimFn,
      lastTrimAt:      0,
    };
  }

  // ── Touch activity timestamp ──────────────────────────────────────────────
  function touch(toolId) {
    var island = _islands[toolId];
    if (island) island.lastActivityAt = Date.now();
  }

  // ── Trim a single tool island ─────────────────────────────────────────────
  function trim(toolId) {
    var island = _islands[toolId];
    if (!island) return;

    var now = Date.now();
    island.trimCount++;

    // Run registered caches trim
    Object.keys(island.caches).forEach(function (name) {
      var c = island.caches[name];
      try {
        if (typeof c.trimFn === 'function') { c.trimFn(); c.lastTrimAt = now; }
      } catch (_) {}
    });

    // Run registered trim handlers
    island.trimHandlers.forEach(function (h) {
      try { h.fn(); } catch (_) {}
    });

    // Signal worker domain to terminate idle workers in this family
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      var family = wd && wd.getFamily(toolId);
      if (family) {
        G.dispatchEvent(new CustomEvent('memory-island:trim', {
          detail: { toolId: toolId, family: family, trimCount: island.trimCount },
        }));
      }
    } catch (_) {}

    console.debug(LOG, 'trim:', toolId, '— count:', island.trimCount);
  }

  // ── Get current heap usage percentage ────────────────────────────────────
  function _heapPct() {
    try {
      var m = performance.memory;
      if (!m || !m.jsHeapSizeLimit) return 0;
      return m.usedJSHeapSize / m.jsHeapSizeLimit;
    } catch (_) { return 0; }
  }

  // ── Periodic sweep ────────────────────────────────────────────────────────
  function _sweep() {
    var now     = Date.now();
    var heapPct = _heapPct();

    Object.keys(_islands).forEach(function (toolId) {
      var island = _islands[toolId];
      var idleSince = now - island.lastActivityAt;

      // Auto-trim idle tools
      if (idleSince > IDLE_TTL_MS) {
        console.debug(LOG, 'idle auto-trim:', toolId, '— idle:', Math.round(idleSince / 1000) + 's');
        trim(toolId);
        return;
      }

      // Heap pressure: trim tools over their proportional share
      if (heapPct > 0.80) {
        var activeCount = Object.keys(_islands).length || 1;
        var heapLimit   = (performance.memory && performance.memory.jsHeapSizeLimit) ? performance.memory.jsHeapSizeLimit / 1048576 : 1024;
        var share       = heapLimit / activeCount;
        if (island.budgetMb > share * 1.5) {
          console.debug(LOG, 'heap-pressure trim:', toolId);
          trim(toolId);
        }
      }
    });
  }

  var _sweepTimer = setInterval(_sweep, SWEEP_MS);

  // Clean up sweep on unload
  try {
    G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true });
  } catch (_) {}

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    var island = _islands[toolId];
    if (!island) return null;
    return {
      toolId:         island.toolId,
      budgetMb:       island.budgetMb,
      caches:         Object.keys(island.caches).length,
      trimHandlers:   island.trimHandlers.length,
      trimCount:      island.trimCount,
      idleSinceMs:    Date.now() - island.lastActivityAt,
    };
  }

  G.RuntimeMemoryIslands = Object.freeze({
    VERSION:             VERSION,
    allocate:            allocate,
    trim:                trim,
    touch:               touch,
    registerTrimHandler: registerTrimHandler,
    registerCache:       registerCache,
    getStats:            getStats,
    getAllStats: function () {
      var out = {};
      Object.keys(_islands).forEach(function (k) { out[k] = getStats(k); });
      return out;
    },
  });

}(window));

// ── SOURCE: public/js/runtime-analytics-domains.js ──
// RuntimeAnalyticsDomains v1.0 — Arc 3 / Phase E / Target 6
// =====================================================================
// Per-tool analytics namespaces + per-tool health scoring.
//
// Problem: RuntimeHealthAnalytics produces a single global score.
// A crashing OCR job deflates the score for Merge PDF, Compress, etc.
// There is no way to know which tool is actually responsible.
//
// Solution: Each tool has its own analytics domain tracking:
//   - Tool start/success/failure events
//   - Per-tool health score (0–100)
//   - Per-tool crash telemetry (lightweight, not replacing CrashTelemetry)
//   - Per-tool startup duration
//   - Scope tag for grouping related tools (from manifest.analyticsScope)
//
// RuntimeHealthAnalytics is extended (non-destructively) to expose:
//   window.RuntimeHealthAnalytics.getToolScore(toolId)
//   window.RuntimeHealthAnalytics.getToolDashboard(toolId)
//
// This extension is injected after boot since RuntimeHealthAnalytics is
// frozen — we patch via RuntimeAnalyticsDomains.enhanceHealthAnalytics().
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeAnalyticsDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[AnalyticsDom]';
  var VERSION = '1.0';

  // ── Domain registry ───────────────────────────────────────────────────────
  // toolId → { scope, score, events[], crashes, startMs, successCount, failCount }
  var _domains = {};

  function _newDomain(toolId, scope) {
    return {
      toolId:       toolId,
      scope:        scope || toolId,
      score:        100,
      events:       [],
      crashes:      0,
      startMs:      null,
      successCount: 0,
      failCount:    0,
      openedAt:     Date.now(),
    };
  }

  // ── Open domain ───────────────────────────────────────────────────────────
  function open(toolId, scope) {
    if (!_domains[toolId]) {
      _domains[toolId] = _newDomain(toolId, scope);
      console.debug(LOG, 'opened:', toolId, '— scope:', scope || toolId);
    }
    return _domains[toolId];
  }

  // ── Record event ──────────────────────────────────────────────────────────
  function record(toolId, type, detail) {
    var domain = _domains[toolId];
    if (!domain) domain = open(toolId);

    var event = { type: type, ts: Date.now(), detail: detail || {} };
    domain.events.push(event);
    // Keep ring bounded at 100 events per tool
    if (domain.events.length > 100) domain.events.shift();

    // Update score based on event type
    if (type === 'start')   { domain.startMs = Date.now(); }
    if (type === 'success') { domain.successCount++; _adjustScore(domain, +5); }
    if (type === 'fail')    { domain.failCount++;    _adjustScore(domain, -10); }
    if (type === 'crash')   { domain.crashes++;      _adjustScore(domain, -15); }
    if (type === 'timeout') {                        _adjustScore(domain, -8); }
    if (type === 'recover') {                        _adjustScore(domain, +3); }

    try {
      G.dispatchEvent(new CustomEvent('analytics-domain:event', {
        detail: { toolId: toolId, event: event },
      }));
    } catch (_) {}
  }

  function _adjustScore(domain, delta) {
    domain.score = Math.max(0, Math.min(100, domain.score + delta));
  }

  // ── Per-tool health score ─────────────────────────────────────────────────
  function getScore(toolId) {
    var domain = _domains[toolId];
    return domain ? domain.score : 100;
  }

  function getLabel(score) {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 55) return 'fair';
    if (score >= 35) return 'poor';
    return 'critical';
  }

  // ── Per-tool dashboard ────────────────────────────────────────────────────
  function getDashboard(toolId) {
    var domain = _domains[toolId];
    if (!domain) return { toolId: toolId, score: 100, label: 'excellent', events: 0 };
    var successRate = (domain.successCount + domain.failCount) > 0
      ? Math.round(domain.successCount / (domain.successCount + domain.failCount) * 100)
      : null;
    return {
      toolId:       toolId,
      scope:        domain.scope,
      score:        domain.score,
      label:        getLabel(domain.score),
      crashes:      domain.crashes,
      successCount: domain.successCount,
      failCount:    domain.failCount,
      successRate:  successRate,
      eventCount:   domain.events.length,
      openedAt:     domain.openedAt,
      recentEvents: domain.events.slice(-5),
    };
  }

  // ── Scope-level aggregation ───────────────────────────────────────────────
  function getScopeScore(scope) {
    var toolIds = Object.keys(_domains).filter(function (k) { return _domains[k].scope === scope; });
    if (!toolIds.length) return 100;
    var sum = toolIds.reduce(function (acc, k) { return acc + _domains[k].score; }, 0);
    return Math.round(sum / toolIds.length);
  }

  // ── Extend RuntimeHealthAnalytics (non-destructive) ──────────────────────
  // Since RuntimeHealthAnalytics is frozen, we cannot patch it directly.
  // Instead, RuntimeAnalyticsDomains provides the equivalent methods and
  // tool authors can call either module. We also attach helpers to window
  // so existing auditors can call G.getToolScore(toolId).
  function _installExtensions() {
    try {
      G.getToolScore     = getScore;
      G.getToolDashboard = getDashboard;
      console.debug(LOG, 'extensions installed: window.getToolScore, window.getToolDashboard');
    } catch (_) {}
  }
  setTimeout(_installExtensions, 500);

  G.RuntimeAnalyticsDomains = Object.freeze({
    VERSION:         VERSION,
    open:            open,
    record:          record,
    getScore:        getScore,
    getLabel:        getLabel,
    getDashboard:    getDashboard,
    getScopeScore:   getScopeScore,
    getDomains:      function () { return Object.keys(_domains); },
    getAllDashboards: function () {
      var out = {};
      Object.keys(_domains).forEach(function (k) { out[k] = getDashboard(k); });
      return out;
    },
  });

}(window));

// ── SOURCE: public/js/runtime-recovery-domains.js ──
// RuntimeRecoveryDomains v1.0 — Arc 3 / Phase F / Target 7
// =====================================================================
// Per-tool circuit breakers + isolated recovery escalation.
//
// Problem: Global recovery logic (RuntimeRecovery) can reload the
// entire runtime when a single tool fails. OCR recovery must never
// reload the Merge PDF runtime. Recovery overlays must be scoped to
// the failing tool's UI, not the whole page.
//
// Solution: Each tool gets an independent circuit breaker with:
//   - CLOSED  → tool is healthy, processing allowed
//   - OPEN    → tool has exceeded failure threshold, blocked for OPEN_TTL_MS
//   - HALF    → trial re-entry allowed (after OPEN_TTL_MS expires)
//
// Recovery policies (from manifest):
//   'isolate' — open circuit, show in-tool warning, do NOT reload page
//   'restart' — open circuit + signal worker domain to restart affected workers
//   'reload'  — open circuit + dispatch 'recovery:page-reload' (caller decides)
//
// Overlay scoping: recovery overlays are emitted as CustomEvents with
// the toolId as context. The UI layer (tool.html/AdvancedEngine) scopes
// them to the active tool's container, not the global page.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeRecoveryDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG          = '[RecoveryDoms]';
  var VERSION      = '1.0';
  var OPEN_TTL_MS  = 30 * 1000;   // circuit stays open 30s before half-open trial
  var FAIL_THRESH  = 3;           // failures before circuit opens

  // ── Circuit states ────────────────────────────────────────────────────────
  var STATE_CLOSED = 'closed';
  var STATE_OPEN   = 'open';
  var STATE_HALF   = 'half-open';

  // ── Domain registry ───────────────────────────────────────────────────────
  // toolId → { state, policy, failCount, lastFailAt, openedAt, tripCount }
  var _circuits = {};

  function _newCircuit(toolId, policy) {
    return {
      toolId:     toolId,
      policy:     policy || 'isolate',
      state:      STATE_CLOSED,
      failCount:  0,
      lastFailAt: 0,
      openedAt:   0,
      tripCount:  0,
    };
  }

  function ensureDomain(toolId, policy) {
    if (!_circuits[toolId]) {
      _circuits[toolId] = _newCircuit(toolId, policy);
      console.debug(LOG, 'circuit created:', toolId, '— policy:', policy || 'isolate');
    }
    return _circuits[toolId];
  }

  // ── Check circuit state ───────────────────────────────────────────────────
  function isOpen(toolId) {
    var c = _circuits[toolId];
    if (!c) return false;
    // Check if OPEN → transition to HALF after TTL
    if (c.state === STATE_OPEN && (Date.now() - c.openedAt) >= OPEN_TTL_MS) {
      c.state = STATE_HALF;
      console.debug(LOG, 'circuit half-open:', toolId);
      try {
        G.dispatchEvent(new CustomEvent('recovery:circuit-half-open', { detail: { toolId: toolId } }));
      } catch (_) {}
    }
    return c.state === STATE_OPEN;
  }

  function getState(toolId) {
    var c = _circuits[toolId];
    if (!c) return STATE_CLOSED;
    // Apply TTL check
    isOpen(toolId);
    return c.state;
  }

  // ── Record failure ────────────────────────────────────────────────────────
  function recordFailure(toolId) {
    var c = ensureDomain(toolId);
    c.failCount++;
    c.lastFailAt = Date.now();

    // If in half-open, a failure re-opens immediately
    if (c.state === STATE_HALF) {
      _open(c);
      return;
    }

    // Trip circuit after threshold
    if (c.state === STATE_CLOSED && c.failCount >= FAIL_THRESH) {
      _open(c);
    }
  }

  function _open(circuit) {
    circuit.state    = STATE_OPEN;
    circuit.openedAt = Date.now();
    circuit.tripCount++;
    console.debug(LOG, 'circuit OPEN:', circuit.toolId, '— trips:', circuit.tripCount, '— policy:', circuit.policy);

    _escalate(circuit);
  }

  // ── Escalate based on policy ──────────────────────────────────────────────
  function _escalate(circuit) {
    var toolId = circuit.toolId;
    var policy = circuit.policy;

    // Always: emit scoped recovery event
    try {
      G.dispatchEvent(new CustomEvent('recovery:circuit-open', {
        detail: { toolId: toolId, policy: policy, tripCount: circuit.tripCount },
        bubbles: true,
      }));
    } catch (_) {}

    // Log to RuntimeIncidentEngine if available
    try {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie.report === 'function') {
        ie.report({
          type:    'circuit-open',
          toolId:  toolId,
          policy:  policy,
          trips:   circuit.tripCount,
          ts:      Date.now(),
        });
      }
    } catch (_) {}

    // Log to RuntimeAnalyticsDomains
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) ad.record(toolId, 'circuit-open', { policy: policy, tripCount: circuit.tripCount });
    } catch (_) {}

    if (policy === 'restart') {
      // Signal worker domain to restart this tool's workers
      try {
        var wd = G.RuntimeWorkerDomainRegistry;
        if (wd) {
          var family = wd.getFamily(toolId);
          if (family) {
            G.dispatchEvent(new CustomEvent('recovery:worker-restart', {
              detail: { toolId: toolId, family: family },
            }));
          }
        }
      } catch (_) {}
    }

    if (policy === 'reload') {
      // Signal page reload — let caller decide whether to act
      try {
        G.dispatchEvent(new CustomEvent('recovery:page-reload', {
          detail: { toolId: toolId, reason: 'circuit-open' },
        }));
      } catch (_) {}
    }
  }

  // ── Close/reset circuit ───────────────────────────────────────────────────
  function closeCircuit(toolId) {
    var c = _circuits[toolId];
    if (!c) return;
    c.state     = STATE_CLOSED;
    c.failCount = 0;
    console.debug(LOG, 'circuit CLOSED:', toolId);
    try {
      G.dispatchEvent(new CustomEvent('recovery:circuit-closed', { detail: { toolId: toolId } }));
    } catch (_) {}
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) ad.record(toolId, 'recover', { manual: true });
    } catch (_) {}
  }

  function openCircuit(toolId) {
    var c = ensureDomain(toolId);
    c.failCount = FAIL_THRESH; // force trip
    _open(c);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    var c = _circuits[toolId];
    if (!c) return null;
    return {
      toolId:    c.toolId,
      state:     getState(toolId),
      policy:    c.policy,
      failCount: c.failCount,
      tripCount: c.tripCount,
      lastFailAt: c.lastFailAt,
    };
  }

  G.RuntimeRecoveryDomains = Object.freeze({
    VERSION:       VERSION,
    ensureDomain:  ensureDomain,
    isOpen:        isOpen,
    getState:      getState,
    recordFailure: recordFailure,
    closeCircuit:  closeCircuit,
    openCircuit:   openCircuit,
    getStats:      getStats,
    getAllStats: function () {
      var out = {};
      Object.keys(_circuits).forEach(function (k) { out[k] = getStats(k); });
      return out;
    },
  });

}(window));

// ── SOURCE: public/js/runtime-tool-bundle-segments.js ──
// RuntimeToolBundleSegments v1.0 — Arc 3 / Phase G / Target 8
// =====================================================================
// Tool-aware bundle segment activation.
//
// Problem: RuntimeBundleRegistry loads bundles globally on demand.
// There is no concept of "this bundle is only needed for AI tools"
// or "don't load OCR runtime when the user is on Merge PDF."
//
// Solution: Define per-family bundle segments. When a tool activates,
// only the segments needed for that tool's family are loaded. Other
// families' bundle segments remain dormant.
//
// Segment map (family → bundle group names in RuntimeBundleRegistry):
//   All families need at minimum: core, security, zero-trust, hardening, infra, arc2
//   AI family additionally needs: (future: ai-specific bundle)
//   No family activates segments for other families proactively
//
// Activation is idempotent — loading the same bundle twice is a no-op
// in RuntimeBundleRegistry (already handled).
//
// Observable: RuntimeBundleRegistry.status() will show which bundles
// have been activated and by which tool family.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolBundleSegments) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ToolBundleSeg]';
  var VERSION = '1.0';

  // ── Segment map: family → ordered list of RuntimeBundleRegistry group names ──
  // All tools share the base security stack.
  // Family-specific extensions listed after the base.
  var BASE_BUNDLES = ['core', 'security', 'zero-trust', 'hardening', 'infra', 'arc2'];

  var FAMILY_SEGMENTS = {
    'organize':     BASE_BUNDLES.slice(),
    'compress':     BASE_BUNDLES.slice(),
    'convert-from': BASE_BUNDLES.slice(),
    'convert-to':   BASE_BUNDLES.slice(),
    'edit':         BASE_BUNDLES.slice(),
    'ai':           BASE_BUNDLES.concat([]),  // placeholder for future ai-bundle
    'image':        BASE_BUNDLES.slice(),
    'utility':      BASE_BUNDLES.slice(),
  };

  // ── Activation tracking ───────────────────────────────────────────────────
  var _activated = {}; // family → true when segments activated
  var _loadLog   = []; // activation history: { family, toolId, ts, bundles[] }

  // ── Activate segments for a tool ─────────────────────────────────────────
  function activateForTool(toolId, family) {
    if (!family) return;
    if (_activated[family]) {
      console.debug(LOG, 'segments already active for family:', family);
      return;
    }

    var segments = FAMILY_SEGMENTS[family] || BASE_BUNDLES;
    _activated[family] = true;
    _loadLog.push({ family: family, toolId: toolId, ts: Date.now(), bundles: segments.slice() });

    console.debug(LOG, 'activating segments for', family, '/', toolId, '—', segments.join(', '));

    // Load each segment in dependency order
    var reg = G.RuntimeBundleRegistry;
    if (!reg) {
      console.debug(LOG, 'RuntimeBundleRegistry not available — segments queued');
      // Queue for later: retry after 2 seconds
      setTimeout(function () {
        var r = G.RuntimeBundleRegistry;
        if (r) {
          segments.forEach(function (seg) {
            r.load(seg).catch(function (e) {
              console.debug(LOG, 'segment load error:', seg, e && e.message || e);
            });
          });
        }
      }, 2000);
      return;
    }

    // Load sequentially to preserve dependency order
    segments.reduce(function (chain, seg) {
      return chain.then(function () {
        return reg.load(seg).catch(function (e) {
          // Non-fatal: segment may already be loaded via script tags
          console.debug(LOG, 'segment load note:', seg, e && e.message || e);
        });
      });
    }, Promise.resolve());
  }

  // ── Status ────────────────────────────────────────────────────────────────
  function status() {
    var reg = G.RuntimeBundleRegistry;
    var bundleStatus = reg ? reg.status() : {};
    return {
      activatedFamilies: Object.keys(_activated),
      bundleStatus:      bundleStatus,
      loadLog:           _loadLog.slice(),
    };
  }

  // ── Register a new family segment ─────────────────────────────────────────
  function registerFamilySegment(family, bundles) {
    if (!Array.isArray(bundles)) return;
    FAMILY_SEGMENTS[family] = bundles;
  }

  G.RuntimeToolBundleSegments = Object.freeze({
    VERSION:               VERSION,
    activateForTool:       activateForTool,
    status:                status,
    registerFamilySegment: registerFamilySegment,
    isActivated:           function (family) { return !!_activated[family]; },
  });

}(window));

// ── SOURCE: public/js/runtime-tool-config-lock.js ──
// RuntimeToolConfigLock v1.0 — Arc 3 / Phase H / Target 9
// =====================================================================
// Immutable per-tool runtime configuration with checksum validation.
//
// Problem: Tool runtime configurations are mutable globals. A bug in
// Tool A could corrupt the config for Tool B. Configs lack integrity
// guarantees — there is no way to detect tampering at runtime.
//
// Solution:
//   1. Each tool gets a frozen config store after first activation
//   2. Configs are checksummed (DJB2) on lock + validated on read
//   3. Mutation attempts after lock → logged to RuntimeIncidentEngine
//   4. Cross-tool config reads are audited (toolId mismatch warning)
//   5. Config version included for forward-compat migration
//
// Config schema (fields from RuntimeToolManifestRegistry manifest):
//   { family, hydrationTier, memoryBudgetMb, recoveryPolicy,
//     thermalPolicy, offlineCapable, lockedAt, version, checksum }
//
// Usage:
//   RuntimeToolConfigLock.lock('ocr', { family: 'ai', memoryBudgetMb: 512 })
//   RuntimeToolConfigLock.get('ocr')            → frozen config | null
//   RuntimeToolConfigLock.isLocked('ocr')       → bool
//   RuntimeToolConfigLock.validate('ocr')       → { ok, reason }
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolConfigLock) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ConfigLock]';
  var VERSION = '1.0';
  var CONFIG_VERSION = 1;

  // ── DJB2 checksum (non-crypto, fast integrity check) ──────────────────────
  function _checksum(obj) {
    var str = JSON.stringify(obj) || '';
    var h = 5381;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h = h & h; }
    return (h >>> 0).toString(16);
  }

  // ── Config store ──────────────────────────────────────────────────────────
  var _configs   = {}; // toolId → frozen config
  var _checksums = {}; // toolId → expected checksum
  var _lockLog   = []; // audit trail: { toolId, ts, action, detail }

  function _audit(toolId, action, detail) {
    _lockLog.push({ toolId: toolId, ts: Date.now(), action: action, detail: detail || {} });
    if (_lockLog.length > 200) _lockLog.shift();
  }

  // ── Lock a tool config ────────────────────────────────────────────────────
  function lock(toolId, config) {
    if (!toolId || typeof config !== 'object') return;

    if (_configs[toolId]) {
      // Already locked — log mutation attempt
      console.debug(LOG, 'mutation attempt blocked:', toolId);
      _audit(toolId, 'mutation-blocked', { attempted: config });

      try {
        var ie = G.RuntimeIncidentEngine;
        if (ie && typeof ie.report === 'function') {
          ie.report({
            type:   'config-mutation-attempt',
            toolId: toolId,
            ts:     Date.now(),
          });
        }
      } catch (_) {}
      return;
    }

    // Build the locked config
    var lockedConfig = {
      toolId:         toolId,
      family:         config.family         || 'unknown',
      hydrationTier:  config.hydrationTier  || 'P2',
      memoryBudgetMb: config.memoryBudgetMb || 128,
      recoveryPolicy: config.recoveryPolicy || 'isolate',
      thermalPolicy:  config.thermalPolicy  || 'normal',
      offlineCapable: !!config.offlineCapable,
      version:        CONFIG_VERSION,
      lockedAt:       Date.now(),
    };

    var cs = _checksum(lockedConfig);
    lockedConfig.checksum = cs;

    _configs[toolId]   = Object.freeze(lockedConfig);
    _checksums[toolId] = cs;

    _audit(toolId, 'locked', { family: lockedConfig.family });
    console.debug(LOG, 'locked:', toolId, '— family:', lockedConfig.family, '— cs:', cs.slice(0, 6));
  }

  // ── Get config ────────────────────────────────────────────────────────────
  function get(toolId) {
    var c = _configs[toolId];
    if (!c) return null;
    // Validate checksum on read
    var expected = _checksums[toolId];
    var actual   = _checksum(c);
    if (expected && expected !== actual) {
      console.debug(LOG, 'CHECKSUM MISMATCH for:', toolId, '— expected:', expected, 'actual:', actual);
      _audit(toolId, 'checksum-fail', { expected: expected, actual: actual });
    }
    return c;
  }

  // ── Validate config ───────────────────────────────────────────────────────
  function validate(toolId) {
    var c = _configs[toolId];
    if (!c) return { ok: false, reason: 'not-locked' };
    var expected = _checksums[toolId];
    var actual   = _checksum(c);
    if (expected !== actual) return { ok: false, reason: 'checksum-mismatch', expected: expected, actual: actual };
    return { ok: true };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeToolConfigLock = Object.freeze({
    VERSION:  VERSION,
    lock:     lock,
    get:      get,
    validate: validate,
    isLocked: function (toolId) { return !!_configs[toolId]; },
    getAuditLog: function () { return _lockLog.slice(); },
    getAll:   function () {
      var out = {};
      Object.keys(_configs).forEach(function (k) { out[k] = _configs[k]; });
      return out;
    },
  });

}(window));


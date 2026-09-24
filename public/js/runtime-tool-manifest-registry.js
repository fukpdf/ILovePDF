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
  // Word-to-Excel currently executes through the browser processor on the main
  // thread; do not advertise the family-level PDF worker set for this tool.
  var _active = {};
  _overrides['word-to-excel'] = {
    workers: [],
    recoveryPolicy: 'isolate',
    offlineCapable: true,
  };

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

  // ── Phase 4 Unit 9: canonical Tool Registry contract ─────────────────────
  // The Phase 4 JSON registry owns tool identity. This runtime manifest keeps
  // its richer family/runtime policy data, but every registered tool must have
  // exactly one manifest entry and every manifest entry must exist in the
  // canonical registry. This prevents silent runtime drift as tools evolve.
  var _registryContract = {
    checked: false,
    ok: false,
    missing: [],
    extra: [],
    registryCount: 0,
    manifestCount: Object.keys(TOOL_FAMILY).length,
  };

  function validateAgainstToolRegistry() {
    var tr = G.ToolRegistry;
    if (!tr || typeof tr.list !== 'function' || typeof tr.isReady !== 'function' || !tr.isReady()) {
      return Object.assign({}, _registryContract, { checked: false, ok: false, reason: 'TOOL_REGISTRY_NOT_READY' });
    }
    var registryIds = tr.list().map(function (entry) { return entry && entry.id; }).filter(Boolean);
    var manifestIds = Object.keys(TOOL_FAMILY);
    var registrySet = new Set(registryIds);
    var manifestSet = new Set(manifestIds);
    var missing = manifestIds.filter(function (id) { return !registrySet.has(id); });
    var extra = registryIds.filter(function (id) { return !manifestSet.has(id); });
    _registryContract = {
      checked: true,
      ok: missing.length === 0 && extra.length === 0,
      missing: missing,
      extra: extra,
      registryCount: registryIds.length,
      manifestCount: manifestIds.length,
    };
    if (!_registryContract.ok) {
      console.error(LOG, 'Tool Registry contract mismatch', _registryContract);
    }
    return Object.assign({}, _registryContract, {
      missing: missing.slice(),
      extra: extra.slice(),
    });
  }

  function registryContractStatus() {
    return Object.assign({}, _registryContract, {
      missing: _registryContract.missing.slice(),
      extra: _registryContract.extra.slice(),
    });
  }

  function _bindRegistryContract() {
    if (G.ToolRegistryReady && typeof G.ToolRegistryReady.then === 'function') {
      G.ToolRegistryReady.then(function () { validateAgainstToolRegistry(); }).catch(function () {});
    }
    try {
      G.addEventListener('ilovepdf:tool-registry-ready', validateAgainstToolRegistry, { once: true });
    } catch (_) {}
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
    validateAgainstToolRegistry: validateAgainstToolRegistry,
    registryContractStatus: registryContractStatus,
  });

  _bindRegistryContract();

}(window));

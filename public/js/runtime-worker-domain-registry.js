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

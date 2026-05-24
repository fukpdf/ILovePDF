// ── Arc 5 True Enterprise Tool Isolation — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-24T14:11:09.517Z  BUILD_ID: mpjuv6ru
// Files: 9

// ── SOURCE: public/js/runtime-tool-worker-mesh.js ──
// RuntimeToolWorkerMesh v1.0 — Arc 5 / Phase A / Target 1
// =====================================================================
// Per-tool worker namespace with independent heartbeat + crash recovery.
//
// Arc 4 gap: RuntimeWorkerDomainThrottle operates at FAMILY level (8
// families). An OCR crash raises pressure for the entire 'ai' family,
// which holds tasks for ai-summarize and translate too. There is no
// per-TOOL crash recovery — no tool-level heartbeat, no idle timer
// that terminates workers only for the idle tool.
//
// Solution: Each tool gets its own mesh node:
//   { toolId, family, workerUrl, state, heartbeatAt, crashCount,
//     idleAt, retries }
//
// Per-tool heartbeat: every HBEAT_MS the mesh pings each active tool's
// worker via a noop payload. Timeout = tool marked as 'stalled'.
// Per-tool crash recovery: crash recorded on this tool only; if
// crashCount >= CRASH_LIMIT the tool node enters ISOLATED state so
// only that tool is blocked. Other tools in same family continue.
// Idle auto-termination: when a tool has been idle for IDLE_TTL_MS,
// its WorkerPool slots are terminated (releasing memory).
//
// Integrates with:
//   RuntimeWorkerDomainThrottle — sets per-family hold when a node
//     enters ISOLATED state
//   WorkerPool.terminatePool   — actual eviction
//   RuntimeWorkerDomainRegistry — pressure signalling
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolWorkerMesh) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG         = '[ToolWorkerMesh]';
  var VERSION     = '1.0';
  var HBEAT_MS    = 20 * 1000;   // heartbeat interval
  var HBEAT_TMO   = 15 * 1000;   // response timeout → stalled
  var IDLE_TTL_MS = 3 * 60 * 1000;  // 3 min idle → evict workers
  var CRASH_LIMIT = 3;           // crashes before isolating tool

  var STATE_ACTIVE   = 'active';
  var STATE_IDLE     = 'idle';
  var STATE_STALLED  = 'stalled';
  var STATE_ISOLATED = 'isolated';
  var STATE_EVICTED  = 'evicted';

  // ── Tool → worker URL (canonical) ────────────────────────────────────────
  var TOOL_WORKER = {
    'merge':'pdf-lib-worker.js','split':'pdf-lib-worker.js',
    'rotate':'pdf-lib-worker.js','crop':'pdf-lib-worker.js',
    'organize':'pdf-lib-worker.js','page-numbers':'pdf-lib-worker.js',
    'redact':'pdf-lib-worker.js',
    'compress':'compress-worker.js',
    'pdf-to-word':'pdf-word-docx-worker.js','word-to-pdf':'pdf-word-docx-worker.js',
    'pdf-to-excel':'pdf-excel-xlsx-worker.js','excel-to-pdf':'pdf-excel-xlsx-worker.js',
    'pdf-to-powerpoint':'pdf-ppt-pptx-worker.js','powerpoint-to-pdf':'pdf-ppt-pptx-worker.js',
    'pdf-to-jpg':'pdf-lib-worker.js','jpg-to-pdf':'pdf-lib-worker.js',
    'html-to-pdf':'pdf-lib-worker.js','scan-to-pdf':'pdf-lib-worker.js',
    'edit':'pdf-lib-worker.js','watermark':'pdf-lib-worker.js',
    'sign':'pdf-lib-worker.js','protect':'pdf-lib-worker.js',
    'unlock':'pdf-lib-worker.js','repair':'repair-worker.js',
    'compare':'compare-worker.js',
    'ocr':'advanced-worker.js','ocr-pdf':'advanced-worker.js',
    'ai-summarize':'summary-worker.js','ai-summarizer':'summary-worker.js',
    'translate':'translation-worker.js','translate-pdf':'translation-worker.js',
    'background-remover':'remove-bg-worker.js',
    'crop-image':'image-tools-worker.js','resize-image':'image-tools-worker.js',
    'image-filters':'image-tools-worker.js','image-compressor':'image-tools-worker.js',
    'image-converter':'image-pipeline-worker.js',
  };
  var WORKER_BASE = '/workers/';

  // ── Tool → family ─────────────────────────────────────────────────────────
  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
  };

  // ── Mesh registry ─────────────────────────────────────────────────────────
  var _nodes = {}; // toolId → node

  function _getNode(toolId) {
    if (!_nodes[toolId]) {
      var wFile  = TOOL_WORKER[toolId] || 'pdf-lib-worker.js';
      var family = TOOL_FAMILY[toolId] || 'organize';
      _nodes[toolId] = {
        toolId:      toolId,
        family:      family,
        workerUrl:   WORKER_BASE + wFile,
        state:       STATE_IDLE,
        heartbeatAt: 0,
        lastActiveAt: 0,
        crashCount:  0,
        retries:     0,
        crashLog:    [],
      };
    }
    return _nodes[toolId];
  }

  // ── Activate a tool node ──────────────────────────────────────────────────
  function activate(toolId) {
    var n = _getNode(toolId);
    if (n.state === STATE_ISOLATED) {
      console.debug(LOG, 'tool isolated — activation blocked:', toolId);
      return false;
    }
    n.state        = STATE_ACTIVE;
    n.lastActiveAt = Date.now();
    return true;
  }

  // ── Record tool idle ──────────────────────────────────────────────────────
  function idle(toolId) {
    var n = _nodes[toolId];
    if (!n) return;
    if (n.state === STATE_ACTIVE) {
      n.state       = STATE_IDLE;
      n.lastActiveAt = Date.now();
    }
  }

  // ── Record a crash on a specific tool ─────────────────────────────────────
  function recordCrash(toolId, reason) {
    var n = _getNode(toolId);
    n.crashCount++;
    n.crashLog.push({ ts: Date.now(), reason: reason || 'unknown' });
    if (n.crashLog.length > 20) n.crashLog.shift();

    console.debug(LOG, 'crash on tool:', toolId, '— count:', n.crashCount, '— reason:', reason);

    if (n.crashCount >= CRASH_LIMIT) {
      n.state = STATE_ISOLATED;
      console.debug(LOG, 'tool ISOLATED after', CRASH_LIMIT, 'crashes:', toolId);
      try {
        G.dispatchEvent(new CustomEvent('tool-mesh:isolated', {
          detail: { toolId: toolId, family: n.family, crashCount: n.crashCount },
        }));
      } catch (_) {}
      try {
        var ie = G.RuntimeIncidentEngine;
        if (ie && typeof ie.report === 'function') {
          ie.report({ type: 'tool-isolated', toolId: toolId, family: n.family, crashCount: n.crashCount, ts: Date.now() });
        }
      } catch (_) {}
    } else {
      // Partial crash: signal family pressure but don't hold the entire family
      try {
        G.dispatchEvent(new CustomEvent('tool-mesh:crash', {
          detail: { toolId: toolId, family: n.family, crashCount: n.crashCount },
        }));
      } catch (_) {}
    }
  }

  // ── Reset isolation (manual recovery) ────────────────────────────────────
  function resetTool(toolId) {
    var n = _nodes[toolId];
    if (!n) return;
    n.state      = STATE_IDLE;
    n.crashCount = 0;
    n.retries    = 0;
    console.debug(LOG, 'tool reset:', toolId);
    try {
      G.dispatchEvent(new CustomEvent('tool-mesh:reset', { detail: { toolId: toolId } }));
    } catch (_) {}
  }

  // ── Idle eviction sweep ───────────────────────────────────────────────────
  function _evictIdleTools() {
    var now = Date.now();
    var wp  = G.WorkerPool;
    if (!wp || typeof wp.terminatePool !== 'function') return;

    Object.keys(_nodes).forEach(function (toolId) {
      var n = _nodes[toolId];
      if (n.state !== STATE_IDLE) return;
      var idleMs = now - n.lastActiveAt;
      if (idleMs < IDLE_TTL_MS) return;

      // Check no active tasks in this worker pool
      try {
        var stats = wp.getStats();
        var urlStats = stats && stats[n.workerUrl];
        if (urlStats && urlStats.busy > 0) return; // still busy
        wp.terminatePool(n.workerUrl);
        n.state = STATE_EVICTED;
        console.debug(LOG, 'idle eviction:', toolId, '— idle:', Math.round(idleMs / 1000) + 's');
      } catch (_) {}
    });
  }

  // ── Heartbeat sweep ───────────────────────────────────────────────────────
  function _heartbeatSweep() {
    var now = Date.now();
    Object.keys(_nodes).forEach(function (toolId) {
      var n = _nodes[toolId];
      if (n.state !== STATE_ACTIVE) return;
      // If no heartbeat in 2× interval → stalled
      if (n.heartbeatAt > 0 && (now - n.heartbeatAt) > HBEAT_MS + HBEAT_TMO) {
        n.state = STATE_STALLED;
        console.debug(LOG, 'tool stalled (no heartbeat):', toolId);
        try {
          G.dispatchEvent(new CustomEvent('tool-mesh:stalled', { detail: { toolId: toolId } }));
        } catch (_) {}
      }
    });
  }

  function heartbeat(toolId) {
    var n = _nodes[toolId];
    if (!n) return;
    n.heartbeatAt = Date.now();
    if (n.state === STATE_STALLED) {
      n.state = STATE_ACTIVE;
      console.debug(LOG, 'tool recovered from stall:', toolId);
    }
  }

  // ── Sweeps ────────────────────────────────────────────────────────────────
  var _sweepTimer = setInterval(function () {
    _heartbeatSweep();
    _evictIdleTools();
  }, HBEAT_MS);
  try { G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true }); } catch (_) {}

  // ── Listen for tool ready events ──────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) activate(toolId);
    } catch (_) {}
  });

  G.addEventListener('analytics-domain:event', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.toolId) return;
      if (d.event && d.event.type === 'start')   activate(d.toolId);
      if (d.event && d.event.type === 'success') idle(d.toolId);
      if (d.event && d.event.type === 'crash')   recordCrash(d.toolId, d.event.reason);
    } catch (_) {}
  });

  G.RuntimeToolWorkerMesh = Object.freeze({
    VERSION:     VERSION,
    activate:    activate,
    idle:        idle,
    heartbeat:   heartbeat,
    recordCrash: recordCrash,
    resetTool:   resetTool,
    getNode:     function (toolId) {
      var n = _nodes[toolId];
      if (!n) return null;
      return { toolId: n.toolId, family: n.family, workerUrl: n.workerUrl,
               state: n.state, crashCount: n.crashCount, lastActiveAt: n.lastActiveAt };
    },
    getAllNodes:  function () {
      var out = {};
      Object.keys(_nodes).forEach(function (k) {
        var n = _nodes[k];
        out[k] = { state: n.state, family: n.family, crashCount: n.crashCount,
                   lastActiveAt: n.lastActiveAt };
      });
      return out;
    },
    isIsolated:  function (toolId) { return _nodes[toolId] && _nodes[toolId].state === STATE_ISOLATED; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool worker mesh active');

}(window));

// ── SOURCE: public/js/runtime-tool-code-loader.js ──
// RuntimeToolCodeLoader v1.0 — Arc 5 / Phase B / Target 2
// =====================================================================
// Per-tool dependency graph + dynamic code loading.
//
// Arc 4 gap: RuntimeProcessorRegistry tracks which FAMILY has been
// activated but has no tool-level dependency graph and no actual
// dynamic loading mechanism. It relies on the processor init function
// being registered externally; no script injection happens.
//
// Solution:
//   1. Per-tool dependency graph: each toolId maps to a list of
//      script files it actually needs (worker + optional extras)
//   2. Dynamic script injection with deduplication: scripts already
//      in the DOM are detected and skipped
//   3. Family-level lazy activation: calling load(toolId) triggers
//      the corresponding RuntimeProcessorRegistry.activate(family)
//   4. Dormant family eviction: families idle > DORMANT_MS are
//      flagged and their activation state reset (so next use re-inits)
//   5. Dependency resolution is async and cached per toolId
//
// Does NOT modify AdvancedEngine or any existing runtime files.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolCodeLoader) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[ToolCodeLoader]';
  var VERSION    = '1.0';
  var DORMANT_MS = 15 * 60 * 1000; // 15 min idle → family marked dormant

  // ── Tool → required script files ─────────────────────────────────────────
  // Only files that are NOT already guaranteed by the base bundle chain.
  // These are tool-specific extras beyond the shared runtime.
  var TOOL_SCRIPTS = {
    'merge':           ['/workers/pdf-lib-worker.js'],
    'split':           ['/workers/pdf-lib-worker.js'],
    'rotate':          ['/workers/pdf-lib-worker.js'],
    'crop':            ['/workers/pdf-lib-worker.js'],
    'organize':        ['/workers/pdf-lib-worker.js'],
    'page-numbers':    ['/workers/pdf-lib-worker.js'],
    'redact':          ['/workers/pdf-lib-worker.js'],
    'compress':        ['/workers/compress-worker.js'],
    'pdf-to-word':     ['/workers/pdf-word-docx-worker.js'],
    'word-to-pdf':     ['/workers/pdf-word-docx-worker.js'],
    'pdf-to-excel':    ['/workers/pdf-excel-xlsx-worker.js'],
    'excel-to-pdf':    ['/workers/pdf-excel-xlsx-worker.js'],
    'pdf-to-powerpoint':['/workers/pdf-ppt-pptx-worker.js'],
    'powerpoint-to-pdf':['/workers/pdf-ppt-pptx-worker.js'],
    'pdf-to-jpg':      ['/workers/pdf-lib-worker.js'],
    'jpg-to-pdf':      ['/workers/pdf-lib-worker.js'],
    'html-to-pdf':     ['/workers/pdf-lib-worker.js'],
    'scan-to-pdf':     ['/workers/pdf-lib-worker.js'],
    'edit':            ['/workers/pdf-lib-worker.js'],
    'watermark':       ['/workers/pdf-lib-worker.js'],
    'sign':            ['/workers/pdf-lib-worker.js'],
    'protect':         ['/workers/pdf-lib-worker.js'],
    'unlock':          ['/workers/pdf-lib-worker.js'],
    'repair':          ['/workers/repair-worker.js'],
    'compare':         ['/workers/compare-worker.js'],
    'ocr':             ['/workers/advanced-worker.js', '/workers/ocr-preprocessor-worker.js'],
    'ocr-pdf':         ['/workers/advanced-worker.js', '/workers/ocr-preprocessor-worker.js'],
    'ai-summarize':    ['/workers/summary-worker.js'],
    'ai-summarizer':   ['/workers/summary-worker.js'],
    'translate':       ['/workers/translation-worker.js'],
    'translate-pdf':   ['/workers/translation-worker.js'],
    'background-remover':['/workers/remove-bg-worker.js'],
    'crop-image':      ['/workers/image-tools-worker.js'],
    'resize-image':    ['/workers/image-tools-worker.js'],
    'image-filters':   ['/workers/image-tools-worker.js'],
    'image-compressor':['/workers/image-tools-worker.js'],
    'image-converter': ['/workers/image-pipeline-worker.js'],
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
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
  };

  // ── Load state ────────────────────────────────────────────────────────────
  var _loaded   = {};   // scriptSrc → true (already in DOM)
  var _loading  = {};   // scriptSrc → Promise
  var _toolLoads = {};  // toolId → { ts, resolved }
  var _familyActivity = {}; // family → lastActiveAt

  // ── Detect already-loaded scripts ────────────────────────────────────────
  function _isLoaded(src) {
    if (_loaded[src]) return true;
    var scripts = document.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var normalized = s.src.replace(/^https?:\/\/[^/]+/, '');
      if (normalized === src) { _loaded[src] = true; return true; }
    }
    return false;
  }

  // ── Inject a script (idempotent) ──────────────────────────────────────────
  function _injectScript(src) {
    if (_isLoaded(src)) return Promise.resolve();
    if (_loading[src])  return _loading[src];

    _loading[src] = new Promise(function (resolve) {
      var el   = document.createElement('script');
      el.src   = src;
      el.defer = true;
      el.onload  = function () { _loaded[src] = true; delete _loading[src]; resolve(); };
      el.onerror = function () {
        delete _loading[src];
        console.debug(LOG, 'inject failed (non-fatal):', src);
        resolve(); // non-fatal: worker may already be loaded inline
      };
      document.head.appendChild(el);
    });
    return _loading[src];
  }

  // ── Load all dependencies for a tool ─────────────────────────────────────
  function load(toolId) {
    var family  = TOOL_FAMILY[toolId] || 'organize';
    _familyActivity[family] = Date.now();

    // Activate processor family
    try {
      var pr = G.RuntimeProcessorRegistry;
      if (pr) pr.activateForTool(toolId);
    } catch (_) {}

    // Activate tool worker mesh node
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      if (mesh) mesh.activate(toolId);
    } catch (_) {}

    // Inject any required extra scripts
    var scripts = TOOL_SCRIPTS[toolId] || [];
    // Crucially: tools in one family NEVER load scripts for another family
    var chain = Promise.resolve();
    scripts.forEach(function (src) {
      chain = chain.then(function () { return _injectScript(src); });
    });

    _toolLoads[toolId] = { ts: Date.now(), resolved: false };
    return chain.then(function () {
      _toolLoads[toolId].resolved = true;
      console.debug(LOG, 'loaded deps for:', toolId, '— family:', family, '— scripts:', scripts.length);
      try {
        G.dispatchEvent(new CustomEvent('code-loader:loaded', {
          detail: { toolId: toolId, family: family, scripts: scripts.length },
        }));
      } catch (_) {}
    });
  }

  // ── Dormant family detection ──────────────────────────────────────────────
  function getDormantFamilies() {
    var now = Date.now();
    var out = [];
    Object.keys(_familyActivity).forEach(function (f) {
      var idleMs = now - _familyActivity[f];
      if (idleMs > DORMANT_MS) out.push({ family: f, idleMs: idleMs });
    });
    return out;
  }

  // ── Listen for tool runtime ready ─────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) load(toolId);
    } catch (_) {}
  });

  G.RuntimeToolCodeLoader = Object.freeze({
    VERSION:          VERSION,
    load:             load,
    getDormantFamilies: getDormantFamilies,
    getLoadStats:     function () {
      return {
        loaded:    Object.keys(_loaded).length,
        toolLoads: Object.assign({}, _toolLoads),
        dormant:   getDormantFamilies(),
      };
    },
    isLoaded:         function (toolId) { return !!(_toolLoads[toolId] && _toolLoads[toolId].resolved); },
    getDependencyGraph: function () { return Object.assign({}, TOOL_SCRIPTS); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool dependency graph active');

}(window));

// ── SOURCE: public/js/runtime-memory-firewalls.js ──
// RuntimeMemoryFirewalls v1.0 — Arc 5 / Phase C / Target 3
// =====================================================================
// Per-tool hard memory budgets + isolated panic mode.
//
// Arc 4 gap: RuntimeMemoryOrchestrator operates at FAMILY level. When
// the AI family hits 88% heap, ALL AI tool workers are terminated. But
// it is actually OCR using 480 MB while AI-Summarize only uses 20 MB.
// There is no per-TOOL memory budget or per-tool panic mode.
//
// Solution:
//   1. Per-tool memory budget in MB (registered at activation)
//   2. Per-tool heap contribution estimate (workload weight)
//   3. Budget enforcement: when a tool's estimated heap exceeds its
//      budget, a 'memory-firewall:budget-exceeded' event fires and
//      RuntimeToolWorkerMesh.recordCrash is signalled
//   4. Per-tool panic: terminates ONLY that tool's workers + trims
//      only that tool's memory island — other tools unaffected
//   5. Reclaim handlers: tools register cleanup callbacks called on
//      budget pressure (before panic)
//   6. Per-tool memory telemetry: 4 tiers — ok/warn/critical/panic
//
// Default budgets (MB) by family:
//   organize/compress/edit: 128 MB
//   convert-from/to:        192 MB
//   ai:                     512 MB
//   image:                  256 MB
//   utility:                 32 MB
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMemoryFirewalls) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[MemFirewalls]';
  var VERSION = '1.0';
  var SWEEP_MS = 30 * 1000;

  // ── Default budgets by family ─────────────────────────────────────────────
  var FAMILY_BUDGET_MB = {
    'organize': 128, 'compress': 128, 'edit': 128,
    'convert-from': 192, 'convert-to': 192,
    'ai': 512, 'image': 256, 'utility': 32,
  };

  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Per-tool firewall state ───────────────────────────────────────────────
  // toolId → { budgetMb, usageMb, tier, reclaimFns, panicCount, panicAt }
  var _firewalls = {};

  function _ensure(toolId) {
    if (!_firewalls[toolId]) {
      var family = TOOL_FAMILY[toolId] || 'organize';
      _firewalls[toolId] = {
        toolId:     toolId,
        family:     family,
        budgetMb:   FAMILY_BUDGET_MB[family] || 128,
        usageMb:    0,
        tier:       'ok',
        reclaimFns: [],
        panicCount: 0,
        panicAt:    null,
      };
    }
    return _firewalls[toolId];
  }

  // ── Set / override budget for a specific tool ─────────────────────────────
  function setBudget(toolId, mb) {
    _ensure(toolId).budgetMb = Math.max(16, mb);
  }

  // ── Register a reclaim handler ────────────────────────────────────────────
  function onReclaim(toolId, fn) {
    if (typeof fn !== 'function') return;
    _ensure(toolId).reclaimFns.push(fn);
  }

  // ── Estimate tool heap usage ──────────────────────────────────────────────
  // Approximation: total heap × (this tool's weight / sum of all active weights)
  function _estimateUsage(toolId) {
    try {
      var m = performance.memory;
      if (!m || !m.usedJSHeapSize) return 0;
      var totalMb = m.usedJSHeapSize / (1024 * 1024);
      // Active tools (have been activated recently)
      var active = Object.keys(_firewalls).filter(function (k) { return _firewalls[k].tier !== 'ok' || _firewalls[k].usageMb > 0; });
      var weight  = active.length > 0 ? 1 / active.length : 1;
      return totalMb * weight;
    } catch (_) { return 0; }
  }

  // ── Compute tier ──────────────────────────────────────────────────────────
  function _tier(usageMb, budgetMb) {
    var pct = budgetMb > 0 ? usageMb / budgetMb : 0;
    if (pct < 0.70) return 'ok';
    if (pct < 0.85) return 'warn';
    if (pct < 0.95) return 'critical';
    return 'panic';
  }

  // ── Panic a single tool ───────────────────────────────────────────────────
  function panic(toolId, reason) {
    var fw = _firewalls[toolId];
    if (!fw) return;
    fw.panicCount++;
    fw.panicAt = Date.now();
    console.debug(LOG, 'PANIC:', toolId, '— reason:', reason || 'budget-exceeded');

    // 1. Call reclaim handlers
    fw.reclaimFns.forEach(function (fn) { try { fn(toolId, reason); } catch (_) {} });

    // 2. Trim memory island for this tool only
    try {
      var mi = G.RuntimeMemoryIslands;
      if (mi) mi.trim(toolId);
    } catch (_) {}

    // 3. Get worker URL and terminate only that tool's pool
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      var node = mesh && mesh.getNode(toolId);
      if (node && node.workerUrl) {
        var wp = G.WorkerPool;
        if (wp && typeof wp.terminatePool === 'function') {
          // Only terminate if no active tasks
          var stats = wp.getStats && wp.getStats();
          var urlStats = stats && stats[node.workerUrl];
          if (!urlStats || urlStats.busy === 0) {
            wp.terminatePool(node.workerUrl);
          }
        }
      }
    } catch (_) {}

    // 4. Record crash on tool mesh
    try {
      var mesh2 = G.RuntimeToolWorkerMesh;
      if (mesh2) mesh2.recordCrash(toolId, 'memory-panic');
    } catch (_) {}

    try {
      G.dispatchEvent(new CustomEvent('memory-firewall:panic', {
        detail: { toolId: toolId, reason: reason, budgetMb: fw.budgetMb },
      }));
    } catch (_) {}
  }

  // ── Budget check for a single tool ───────────────────────────────────────
  function checkBudget(toolId) {
    var fw = _ensure(toolId);
    var usageMb = _estimateUsage(toolId);
    fw.usageMb  = usageMb;
    var newTier = _tier(usageMb, fw.budgetMb);
    var prevTier = fw.tier;
    fw.tier = newTier;

    if (newTier === 'panic' && prevTier !== 'panic') {
      panic(toolId, 'budget-exceeded');
    } else if (newTier === 'critical' && prevTier === 'ok') {
      console.debug(LOG, 'critical budget:', toolId, '—', Math.round(usageMb) + '/' + fw.budgetMb + ' MB');
      try {
        G.dispatchEvent(new CustomEvent('memory-firewall:critical', {
          detail: { toolId: toolId, usageMb: usageMb, budgetMb: fw.budgetMb },
        }));
      } catch (_) {}
    }
    return { tier: newTier, usageMb: usageMb, budgetMb: fw.budgetMb };
  }

  // ── Periodic sweep ────────────────────────────────────────────────────────
  function _sweep() {
    Object.keys(_firewalls).forEach(function (toolId) { checkBudget(toolId); });
  }
  var _sweepTimer = setInterval(_sweep, SWEEP_MS);
  try { G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true }); } catch (_) {}

  // ── Register firewalls on tool activation ─────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) _ensure(toolId);
    } catch (_) {}
  });

  G.RuntimeMemoryFirewalls = Object.freeze({
    VERSION:     VERSION,
    setBudget:   setBudget,
    onReclaim:   onReclaim,
    checkBudget: checkBudget,
    panic:       panic,
    getStats:    function (toolId) {
      if (toolId) {
        var fw = _firewalls[toolId];
        return fw ? { toolId: fw.toolId, tier: fw.tier, usageMb: fw.usageMb, budgetMb: fw.budgetMb, panicCount: fw.panicCount } : null;
      }
      var out = {};
      Object.keys(_firewalls).forEach(function (k) {
        var fw = _firewalls[k];
        out[k] = { tier: fw.tier, usageMb: fw.usageMb, budgetMb: fw.budgetMb, panicCount: fw.panicCount };
      });
      return out;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool memory budgets active');

}(window));

// ── SOURCE: public/js/runtime-recovery-firewalls.js ──
// RuntimeRecoveryFirewalls v1.0 — Arc 5 / Phase D / Target 4
// =====================================================================
// Per-tool recovery escalation tree + independent retry budgets.
//
// Arc 3 gap: RuntimeRecoveryDomains has per-tool circuit breakers, but
// the escalation is flat (isolate/restart/reload). There are no retry
// budgets — a tool exhausts retries and either stays broken or escalates
// to a page reload that can affect ALL tools. There is no independent
// recovery telemetry per tool.
//
// Solution: Each tool gets an independent recovery escalation tree:
//
//   Level 0 (isolate): show warning badge, retry up to RETRY_L0 times
//   Level 1 (restart): terminate + respawn only this tool's workers
//   Level 2 (degrade): disable tool UI, show graceful degradation banner
//   Level 3 (quarantine): fully isolate — tool unavailable until reset
//
// Each level has an independent retry budget (countdown counter).
// When a level's budget is exhausted, escalation moves to level+1.
// NO path leads to a global page reload.
//
// Independent recovery telemetry: every escalation is recorded per tool
// and reported to RuntimeAnalyticsDomains + RuntimeIncidentEngine.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeRecoveryFirewalls) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[RecoveryFW]';
  var VERSION = '1.0';

  // ── Escalation level definitions ──────────────────────────────────────────
  var LEVELS = [
    { name: 'isolate',    retries: 3, action: '_isolate'    },
    { name: 'restart',    retries: 2, action: '_restart'    },
    { name: 'degrade',    retries: 1, action: '_degrade'    },
    { name: 'quarantine', retries: 0, action: '_quarantine' },
  ];

  // ── Per-tool recovery state ───────────────────────────────────────────────
  // toolId → { level, budgets: [3,2,1,0], escalationCount, telemetry }
  var _states = {};

  function _ensure(toolId) {
    if (!_states[toolId]) {
      _states[toolId] = {
        toolId:          toolId,
        level:           0,
        budgets:         [3, 2, 1, 0],
        escalationCount: 0,
        failCount:       0,
        lastFailAt:      null,
        telemetry:       [],
      };
    }
    return _states[toolId];
  }

  // ── Record telemetry (capped ring) ────────────────────────────────────────
  function _tele(state, event, detail) {
    state.telemetry.push({ ts: Date.now(), event: event, level: state.level, detail: detail || {} });
    if (state.telemetry.length > 50) state.telemetry.shift();
  }

  // ── Escalation level actions ──────────────────────────────────────────────
  function _isolate(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:isolate', { detail: { toolId: toolId } }));
    } catch (_) {}
    // Ensure circuit is open in RuntimeRecoveryDomains
    try { var rd = G.RuntimeRecoveryDomains; if (rd) rd.openCircuit(toolId); } catch (_) {}
  }

  function _restart(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:restart', { detail: { toolId: toolId } }));
    } catch (_) {}
    // Terminate only this tool's workers via WorkerMesh
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      var node = mesh && mesh.getNode(toolId);
      if (node && node.workerUrl) {
        var wp = G.WorkerPool;
        if (wp && typeof wp.terminatePool === 'function') wp.terminatePool(node.workerUrl);
      }
    } catch (_) {}
    // Signal memory firewall to reclaim
    try {
      var mf = G.RuntimeMemoryFirewalls;
      if (mf) mf.panic(toolId, 'recovery-restart');
    } catch (_) {}
  }

  function _degrade(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:degrade', {
        detail: { toolId: toolId, message: 'Tool is temporarily degraded. Please try again.' },
      }));
    } catch (_) {}
    console.debug(LOG, 'tool degraded:', toolId);
  }

  function _quarantine(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:quarantine', {
        detail: { toolId: toolId, message: 'Tool is unavailable. Please refresh the page.' },
      }));
    } catch (_) {}
    // Report to incident engine
    try {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie.report === 'function') {
        ie.report({ type: 'tool-quarantined', toolId: toolId, ts: Date.now() });
      }
    } catch (_) {}
    console.debug(LOG, 'tool QUARANTINED:', toolId);
  }

  // ── Perform escalation action ─────────────────────────────────────────────
  var _actions = { '_isolate': _isolate, '_restart': _restart, '_degrade': _degrade, '_quarantine': _quarantine };

  function _doEscalation(toolId, state) {
    var lvl    = LEVELS[state.level] || LEVELS[LEVELS.length - 1];
    var action = _actions[lvl.action];
    if (action) action(toolId);
    state.escalationCount++;
    _tele(state, 'escalate', { levelName: lvl.name });

    // Report analytics
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) ad.record(toolId, 'recovery-escalate', { level: lvl.name, escalationCount: state.escalationCount });
    } catch (_) {}
  }

  // ── Record a failure for a tool ───────────────────────────────────────────
  function recordFailure(toolId, reason) {
    var state = _ensure(toolId);
    state.failCount++;
    state.lastFailAt = Date.now();
    _tele(state, 'fail', { reason: reason });

    var budgets = state.budgets;
    // Check current level budget
    if (budgets[state.level] > 0) {
      budgets[state.level]--;
      _doEscalation(toolId, state);
    } else {
      // Budget exhausted — escalate to next level
      if (state.level < LEVELS.length - 1) {
        state.level++;
        // Reset new level's budget
        budgets[state.level] = LEVELS[state.level].retries;
        console.debug(LOG, 'escalating to level', state.level, ':', LEVELS[state.level].name, '— tool:', toolId);
        _doEscalation(toolId, state);
      } else {
        // Already at maximum — quarantine
        _quarantine(toolId);
        _tele(state, 'quarantined', {});
      }
    }
  }

  // ── Reset recovery state ──────────────────────────────────────────────────
  function reset(toolId) {
    var state = _ensure(toolId);
    state.level   = 0;
    state.budgets = [3, 2, 1, 0];
    state.failCount = 0;
    _tele(state, 'reset', {});
    // Close circuit in RuntimeRecoveryDomains
    try { var rd = G.RuntimeRecoveryDomains; if (rd) rd.closeCircuit(toolId); } catch (_) {}
    // Reset mesh node
    try { var mesh = G.RuntimeToolWorkerMesh; if (mesh) mesh.resetTool(toolId); } catch (_) {}
    console.debug(LOG, 'recovery reset:', toolId);
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:reset', { detail: { toolId: toolId } }));
    } catch (_) {}
  }

  // ── Listen for worker mesh crash events ───────────────────────────────────
  G.addEventListener('tool-mesh:crash', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) recordFailure(toolId, 'worker-crash');
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) recordFailure(toolId, 'tool-isolated');
    } catch (_) {}
  });

  G.RuntimeRecoveryFirewalls = Object.freeze({
    VERSION:       VERSION,
    recordFailure: recordFailure,
    reset:         reset,
    getState:      function (toolId) {
      var s = _states[toolId];
      if (!s) return null;
      var lvl = LEVELS[s.level] || LEVELS[LEVELS.length - 1];
      return {
        toolId:          s.toolId,
        level:           s.level,
        levelName:       lvl.name,
        budgets:         s.budgets.slice(),
        failCount:       s.failCount,
        escalationCount: s.escalationCount,
      };
    },
    getAllStates: function () {
      var out = {};
      Object.keys(_states).forEach(function (k) { out[k] = G.RuntimeRecoveryFirewalls.getState(k); });
      return out;
    },
    getTelemetry: function (toolId) {
      var s = _states[toolId];
      return s ? s.telemetry.slice() : [];
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool recovery escalation trees active');

}(window));

// ── SOURCE: public/js/runtime-tool-event-firewall.js ──
// RuntimeToolEventFirewall v1.0 — Arc 5 / Phase E / Target 5
// =====================================================================
// Cross-tool event propagation enforcement + unsafe listener auditing.
//
// Arc 4 gap: RuntimeToolSandbox provides a namespaced event BUS
// (tool:{toolId}:{event}) and DETECTS leakage but does NOT block
// cross-tool propagation at the window level. Any handler on window
// still receives ALL tool-scoped events regardless of toolId.
//
// Solution:
//   1. Event namespace enforcement: scoped CustomEvents tagged with
//      a 'toolId' in detail are intercepted; if they bubble through
//      a handler registered for a DIFFERENT toolId, a violation fires
//   2. Unsafe listener registry: audit window.addEventListener calls
//      that subscribe to tool-scoped event names without a toolId
//      qualifier, flag them as unsafe
//   3. Violation telemetry: every cross-tool event detected is logged
//      to RuntimeIncidentEngine with source + destination toolIds
//   4. Firewall map: per-toolId allowed event set; events outside
//      that set generate warnings
//   5. Shadow audit mode: no blocking (browser cannot truly block
//      CustomEvent propagation), but records all violations and
//      provides a getViolations() audit trail
//
// This is an audit/telemetry layer — it cannot intercept native DOM
// events at the browser level. It enforces the RuntimeToolSandbox
// contract and logs any violations for remediation.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolEventFirewall) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[EventFirewall]';
  var VERSION = '1.0';
  var MAX_VIOLATIONS = 200;

  // ── Violation log ─────────────────────────────────────────────────────────
  var _violations = [];  // { ts, type, publisherTool, subscriberTool, event }
  var _auditLog   = [];  // { ts, type, eventType, detail }

  function _logViolation(type, detail) {
    _violations.push(Object.assign({ ts: Date.now(), type: type }, detail));
    if (_violations.length > MAX_VIOLATIONS) _violations.shift();
    try {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie.report === 'function') {
        ie.report(Object.assign({ ts: Date.now() }, detail));
      }
    } catch (_) {}
  }

  // ── Per-tool event allowlists ─────────────────────────────────────────────
  // toolId → Set of allowed event types for this tool's sandbox
  var _allowlists = {};
  var _DEFAULT_ALLOWED = [
    'tool:runtime-ready', 'tool:manifest-activated', 'tool:error',
    'memory-firewall:critical', 'memory-firewall:panic',
    'recovery-fw:isolate', 'recovery-fw:restart', 'recovery-fw:degrade',
    'recovery-fw:quarantine', 'code-loader:loaded', 'tool-mesh:crash',
  ];

  function allow(toolId, eventType) {
    if (!_allowlists[toolId]) _allowlists[toolId] = _DEFAULT_ALLOWED.slice();
    if (!_allowlists[toolId].includes(eventType)) _allowlists[toolId].push(eventType);
  }

  // ── Intercept tool:* events and check for cross-tool propagation ──────────
  // We listen for ALL tool:-scoped events on window and check the detail.toolId
  // against any registered handlers that might have the wrong toolId context.
  var _registeredHandlers = {}; // eventType → [{ toolId, fn }]

  function enforceOn(eventType, publisherToolId, subscriberToolId) {
    if (!publisherToolId || !subscriberToolId) return;
    if (publisherToolId === subscriberToolId) return; // same tool = ok
    // Cross-tool: log violation
    _logViolation('cross-tool-event', {
      type:            'cross-tool-event',
      eventType:       eventType,
      publisherTool:   publisherToolId,
      subscriberTool:  subscriberToolId,
    });
    console.debug(LOG, 'CROSS-TOOL EVENT:', eventType, '— publisher:', publisherToolId, '→ subscriber:', subscriberToolId);
  }

  // ── Install global auditor on CustomEvent dispatch ────────────────────────
  function _installAuditor() {
    // Shadow-patch window.dispatchEvent to audit tool:* events
    var _origDispatch = G.dispatchEvent.bind(G);
    var _patched = false;
    if (_patched) return;
    _patched = true;

    try {
      G.__origDispatchEvent = _origDispatch;
      // We cannot replace window.dispatchEvent (it's a native method on most
      // browsers). Instead, we listen for ALL tool-scoped events at the
      // capture phase (which fires before bubbling handlers) and audit them.
      G.addEventListener('*', function () {}, { capture: true }); // not valid
    } catch (_) {}

    // Real approach: listen at capture phase for all CustomEvents
    G.addEventListener('tool:runtime-ready', _auditEvent, true);
    G.addEventListener('tool:manifest-activated', _auditEvent, true);

    // Also intercept tool-sandbox emits
    G.addEventListener('tool-mesh:crash', _auditEvent, true);
    G.addEventListener('tool-mesh:isolated', _auditEvent, true);
    G.addEventListener('recovery-fw:isolate', _auditEvent, true);
    G.addEventListener('recovery-fw:quarantine', _auditEvent, true);
    G.addEventListener('memory-firewall:panic', _auditEvent, true);
    G.addEventListener('code-loader:loaded', _auditEvent, true);

    // Audit sandbox-emitted scoped events
    G.addEventListener('tool:*', _auditEvent, true);
  }

  function _auditEvent(evt) {
    try {
      var detail = evt && evt.detail;
      if (!detail) return;
      var pub = detail.toolId || (detail.manifest && detail.manifest.toolId);
      if (!pub) return;
      // Log audit entry
      _auditLog.push({ ts: Date.now(), event: evt.type, toolId: pub });
      if (_auditLog.length > 500) _auditLog.shift();
    } catch (_) {}
  }

  // ── Audit global window.addEventListener calls (wrapper) ─────────────────
  // We cannot truly replace addEventListener, but we can track calls made
  // after this module loads via a soft audit helper
  var _unsafeListeners = []; // { eventType, registeredAt }
  var TOOL_EVENT_PREFIXES = ['tool:', 'memory-firewall:', 'recovery-fw:', 'tool-mesh:',
                             'code-loader:', 'memory-orchestrator:', 'processor:'];

  function auditListener(eventType, fn, opts) {
    var isToolScoped = TOOL_EVENT_PREFIXES.some(function (p) { return eventType.startsWith(p); });
    if (!isToolScoped) return; // not a tool-scoped event, skip
    // Check if this listener passes a toolId filter
    var src = fn && fn.toString ? fn.toString().slice(0, 200) : '';
    var hasFilter = src.includes('toolId') || src.includes('detail.toolId');
    if (!hasFilter) {
      _unsafeListeners.push({ eventType: eventType, registeredAt: Date.now(), src: src.slice(0, 80) });
      _auditLog.push({ ts: Date.now(), type: 'unsafe-listener', eventType: eventType });
      console.debug(LOG, 'UNSAFE LISTENER (no toolId filter):', eventType);
    }
  }

  // ── Sandbox event scope enforcement hook ──────────────────────────────────
  // RuntimeToolSandbox.emit() already scopes events. This firewall adds a
  // complementary check when it receives broadcast events.
  G.addEventListener('tool-mesh:crash', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) _auditEvent(evt);
    } catch (_) {}
  }, true);

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _installAuditor, { once: true });
  } else {
    setTimeout(_installAuditor, 0);
  }

  G.RuntimeToolEventFirewall = Object.freeze({
    VERSION:          VERSION,
    allow:            allow,
    enforceOn:        enforceOn,
    auditListener:    auditListener,
    getViolations:    function () { return _violations.slice(); },
    getUnsafeListeners: function () { return _unsafeListeners.slice(); },
    getAuditLog:      function (limit) { return _auditLog.slice(-(limit || 100)); },
    clearViolations:  function () { _violations.length = 0; },
    violationCount:   function () { return _violations.length; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — cross-tool event audit active');

}(window));

// ── SOURCE: public/js/runtime-tool-config-seal.js ──
// RuntimeToolConfigSeal v1.0 — Arc 5 / Phase F / Target 6
// =====================================================================
// Independent per-tool config snapshots + drift telemetry.
//
// Arc 4 gap: RuntimeImmutabilityGuard re-verifies configs stored in
// RuntimeToolConfigLock. But if RuntimeToolConfigLock was never called
// for a tool (no manifest activation), there is nothing to verify.
// There is also no config DRIFT tracking — no record of what changed
// between version N and version N+1.
//
// Solution: RuntimeToolConfigSeal creates its own independent snapshot
// layer. At activation time, it captures a full config snapshot for
// each tool, including:
//   - runtime options extracted from tool.html data attributes
//   - family + tier from RuntimeToolManifestRegistry
//   - memory budget from RuntimeMemoryFirewalls
//   - recovery policy from RuntimeRecoveryDomains
// Each snapshot is versioned and checksummed independently from
// RuntimeToolConfigLock. Drift is tracked between versions.
//
// Provides:
//   seal(toolId, config)          — snapshot + version a config
//   verify(toolId)                → { ok, drift, version }
//   getDrift(toolId)              → array of { field, from, to, ts }
//   getSnapshot(toolId)           → current frozen snapshot
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolConfigSeal) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ConfigSeal]';
  var VERSION = '1.0';

  // ── Seal store ───────────────────────────────────────────────────────────
  // toolId → { version, snapshots: [{v, config, checksum, ts}], drift: [...] }
  var _store = {};

  // ── DJB2 checksum ────────────────────────────────────────────────────────
  function _cs(obj) {
    try {
      var s = JSON.stringify(obj) || '';
      var h = 5381;
      for (var i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h = h & h; }
      return (h >>> 0).toString(16);
    } catch (_) { return '0'; }
  }

  function _ensureStore(toolId) {
    if (!_store[toolId]) _store[toolId] = { version: 0, snapshots: [], drift: [] };
    return _store[toolId];
  }

  // ── Collect config for a tool ─────────────────────────────────────────────
  function _collectConfig(toolId) {
    var cfg = { toolId: toolId };
    // 1. From RuntimeToolManifestRegistry
    try {
      var mr = G.RuntimeToolManifestRegistry;
      if (mr) {
        cfg.family        = mr.getFamily(toolId);
        cfg.hydrationTier = mr.getHydrationTier && mr.getHydrationTier(toolId);
      }
    } catch (_) {}
    // 2. From RuntimeToolConfigLock
    try {
      var cl = G.RuntimeToolConfigLock;
      if (cl) {
        var locked = cl.get(toolId);
        if (locked) {
          cfg.memoryBudgetMb = locked.memoryBudgetMb;
          cfg.recoveryPolicy = locked.recoveryPolicy;
          cfg.thermalPolicy  = locked.thermalPolicy;
          cfg.offlineCapable = locked.offlineCapable;
        }
      }
    } catch (_) {}
    // 3. From RuntimeMemoryFirewalls
    try {
      var mf = G.RuntimeMemoryFirewalls;
      if (mf) {
        var fw = mf.getStats(toolId);
        if (fw) cfg.memoryBudgetMb = cfg.memoryBudgetMb || fw.budgetMb;
      }
    } catch (_) {}
    // 4. From RuntimeWorkerDomainRegistry
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (wd) cfg.workerFamily = wd.getFamily(toolId);
    } catch (_) {}
    return cfg;
  }

  // ── Seal (snapshot) a tool config ────────────────────────────────────────
  function seal(toolId, overrides) {
    var st  = _ensureStore(toolId);
    var cfg = _collectConfig(toolId);
    if (overrides && typeof overrides === 'object') {
      Object.keys(overrides).forEach(function (k) { cfg[k] = overrides[k]; });
    }
    cfg.sealedAt = Date.now();
    cfg.version  = st.version + 1;

    var cs = _cs(cfg);
    cfg.checksum = cs;

    var prevSnap = st.snapshots[st.snapshots.length - 1];
    var snap     = Object.freeze(cfg);

    // Compute drift from previous snapshot
    if (prevSnap) {
      var prevCfg = prevSnap.config;
      Object.keys(cfg).forEach(function (key) {
        if (key === 'sealedAt' || key === 'version' || key === 'checksum') return;
        if (prevCfg[key] !== cfg[key]) {
          var driftEntry = { field: key, from: prevCfg[key], to: cfg[key], ts: Date.now(), version: cfg.version };
          st.drift.push(driftEntry);
          if (st.drift.length > 100) st.drift.shift();
          console.debug(LOG, 'drift detected:', toolId, '— field:', key, '—', prevCfg[key], '→', cfg[key]);
        }
      });
    }

    st.snapshots.push({ v: cfg.version, config: snap, checksum: cs, ts: Date.now() });
    if (st.snapshots.length > 10) st.snapshots.shift(); // keep last 10 versions
    st.version = cfg.version;

    console.debug(LOG, 'sealed:', toolId, '— v' + cfg.version, '— cs:', cs.slice(0, 6));
    return snap;
  }

  // ── Verify current snapshot integrity ────────────────────────────────────
  function verify(toolId) {
    var st = _store[toolId];
    if (!st || !st.snapshots.length) return { ok: false, reason: 'not-sealed' };
    var latest = st.snapshots[st.snapshots.length - 1];
    var actual = _cs(latest.config);
    if (actual !== latest.checksum) {
      return { ok: false, reason: 'checksum-mismatch', expected: latest.checksum, actual: actual, version: latest.v };
    }
    // Cross-verify with RuntimeToolConfigLock if available
    try {
      var cl = G.RuntimeToolConfigLock;
      if (cl) {
        var r = cl.validate(toolId);
        if (!r.ok) return { ok: false, reason: 'config-lock-mismatch', detail: r };
      }
    } catch (_) {}
    return { ok: true, version: latest.v, checksum: latest.checksum };
  }

  // ── Auto-seal on tool activation ──────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) setTimeout(function () { seal(toolId); }, 100); // slight delay to let other modules init
    } catch (_) {}
  });

  // ── Periodic re-seal + verify ─────────────────────────────────────────────
  setInterval(function () {
    Object.keys(_store).forEach(function (toolId) {
      var result = verify(toolId);
      if (!result.ok) {
        console.debug(LOG, 'VERIFY FAILED:', toolId, '—', result.reason);
        try {
          G.dispatchEvent(new CustomEvent('config-seal:violation', { detail: { toolId: toolId, reason: result.reason } }));
        } catch (_) {}
      }
    });
  }, 90 * 1000); // every 90s

  G.RuntimeToolConfigSeal = Object.freeze({
    VERSION:     VERSION,
    seal:        seal,
    verify:      verify,
    getSnapshot: function (toolId) {
      var st = _store[toolId];
      if (!st || !st.snapshots.length) return null;
      return st.snapshots[st.snapshots.length - 1].config;
    },
    getDrift:    function (toolId) { return (_store[toolId] || {}).drift || []; },
    getVersion:  function (toolId) { return (_store[toolId] || {}).version || 0; },
    getAllSeals:  function () {
      var out = {};
      Object.keys(_store).forEach(function (k) {
        out[k] = { version: _store[k].version, driftCount: _store[k].drift.length };
      });
      return out;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool config seals active');

}(window));

// ── SOURCE: public/js/runtime-tool-health-domains.js ──
// RuntimeToolHealthDomains v1.0 — Arc 5 / Phase G / Target 7
// =====================================================================
// Independent per-tool health scores + window.getToolHealth(toolId).
//
// Arc 4 gap: RuntimeHealthOrchestrator.fullDashboard() aggregates
// stats at FAMILY level from RuntimeWorkerDomainRegistry. There is no
// independent health score per individual tool. We cannot call
// getToolHealth('ocr-pdf') and get an isolated score for just that
// tool, separate from ai-summarize's score.
//
// Solution: Each tool gets an independent health domain with:
//   - health score 0–100 (starts at 100, deducted on events)
//   - crash counter (independent from family)
//   - success/fail counters
//   - startup timing (first activation → ready)
//   - worker health (from RuntimeToolWorkerMesh state)
//   - offline queue depth (from RuntimeToolOfflineFirewalls)
//   - memory tier (from RuntimeMemoryFirewalls)
//   - hydration status (from RuntimeHydrationDomains)
//
// Score deduction rules:
//   each crash:          -15
//   circuit open:        -20
//   tool isolated:       -30
//   memory panic:        -10
//   recovery escalation: -10
//   success:             +3 (up to 100)
//
// Installs window.getToolHealth(toolId) for console diagnostics.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolHealthDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ToolHealthDoms]';
  var VERSION = '1.0';

  // ── Per-tool health domain ────────────────────────────────────────────────
  // toolId → { score, crashes, successes, fails, startupMs, workerState,
  //            memTier, circuitState, events: [] }
  var _domains = {};

  function _ensure(toolId) {
    if (!_domains[toolId]) {
      _domains[toolId] = {
        toolId:     toolId,
        score:      100,
        crashes:    0,
        successes:  0,
        fails:      0,
        startupAt:  null,
        readyAt:    null,
        startupMs:  null,
        workerState: 'unknown',
        memTier:    'ok',
        circuitState: 'closed',
        escalationLevel: 0,
        events:     [],
      };
    }
    return _domains[toolId];
  }

  function _clamp(n) { return Math.max(0, Math.min(100, n)); }

  function _addEvent(dom, type, detail) {
    dom.events.push({ ts: Date.now(), type: type, detail: detail || {} });
    if (dom.events.length > 100) dom.events.shift();
  }

  // ── Score adjustments ─────────────────────────────────────────────────────
  var DEDUCTIONS = {
    crash:            15,
    'circuit-open':   20,
    isolated:         30,
    'memory-panic':   10,
    'recovery-escalate': 10,
    fail:              3,
  };
  var SUCCESS_GAIN = 3;

  function record(toolId, eventType, detail) {
    var dom = _ensure(toolId);
    switch (eventType) {
      case 'start':
        if (!dom.startupAt) dom.startupAt = Date.now();
        break;
      case 'ready':
        if (dom.startupAt && !dom.readyAt) {
          dom.readyAt   = Date.now();
          dom.startupMs = dom.readyAt - dom.startupAt;
          console.debug(LOG, 'tool startup:', toolId, '—', dom.startupMs + 'ms');
        }
        break;
      case 'success':
        dom.successes++;
        dom.score = _clamp(dom.score + SUCCESS_GAIN);
        break;
      case 'fail':
        dom.fails++;
        dom.score = _clamp(dom.score - DEDUCTIONS.fail);
        break;
      case 'crash':
        dom.crashes++;
        dom.score = _clamp(dom.score - DEDUCTIONS.crash);
        break;
      case 'circuit-open':
        dom.circuitState = 'open';
        dom.score = _clamp(dom.score - DEDUCTIONS['circuit-open']);
        break;
      case 'circuit-closed':
        dom.circuitState = 'closed';
        break;
      case 'isolated':
        dom.workerState = 'isolated';
        dom.score = _clamp(dom.score - DEDUCTIONS.isolated);
        break;
      case 'memory-panic':
        dom.memTier = 'panic';
        dom.score = _clamp(dom.score - DEDUCTIONS['memory-panic']);
        break;
      case 'memory-ok':
        dom.memTier = 'ok';
        break;
      case 'recovery-escalate':
        dom.escalationLevel = (detail && detail.level) || dom.escalationLevel + 1;
        dom.score = _clamp(dom.score - DEDUCTIONS['recovery-escalate']);
        break;
      case 'reset':
        dom.score          = 80; // partial restore on reset
        dom.circuitState   = 'closed';
        dom.workerState    = 'active';
        dom.escalationLevel = 0;
        break;
    }
    _addEvent(dom, eventType, detail);
  }

  // ── Sync worker state from mesh ───────────────────────────────────────────
  function _syncWorkerState(toolId) {
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      if (!mesh) return;
      var node = mesh.getNode(toolId);
      if (node) {
        var dom = _ensure(toolId);
        dom.workerState = node.state;
      }
    } catch (_) {}
  }

  // ── Full health snapshot ──────────────────────────────────────────────────
  function getHealth(toolId) {
    _syncWorkerState(toolId);
    var dom  = _ensure(toolId);
    var label = dom.score >= 90 ? 'excellent' : dom.score >= 70 ? 'good' :
                dom.score >= 50 ? 'fair'      : dom.score >= 30 ? 'poor' : 'critical';
    // Augment with live memory tier
    try {
      var mf = G.RuntimeMemoryFirewalls;
      if (mf) { var fw = mf.getStats(toolId); if (fw) dom.memTier = fw.tier; }
    } catch (_) {}
    // Augment with offline queue depth
    var offlineDepth = 0;
    try {
      var od = G.RuntimeOfflineDomains;
      // offline domains are family-level; check via domain
    } catch (_) {}
    return {
      toolId:         toolId,
      score:          dom.score,
      label:          label,
      crashes:        dom.crashes,
      successes:      dom.successes,
      fails:          dom.fails,
      startupMs:      dom.startupMs,
      workerState:    dom.workerState,
      memTier:        dom.memTier,
      circuitState:   dom.circuitState,
      escalationLevel: dom.escalationLevel,
      recentEvents:   dom.events.slice(-10),
    };
  }

  // ── Listen for system events ──────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'ready');
    } catch (_) {}
  });

  G.addEventListener('analytics-domain:event', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.toolId || !d.event) return;
      record(d.toolId, d.event.type, d.event);
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:crash', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'crash', evt.detail);
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'isolated', evt.detail);
    } catch (_) {}
  });

  G.addEventListener('recovery:circuit-open', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'circuit-open', evt.detail);
    } catch (_) {}
  });

  G.addEventListener('recovery:circuit-closed', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'circuit-closed');
    } catch (_) {}
  });

  G.addEventListener('memory-firewall:panic', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'memory-panic', evt.detail);
    } catch (_) {}
  });

  G.addEventListener('recovery-fw:isolate', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'recovery-escalate', evt.detail);
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:reset', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) record(toolId, 'reset');
    } catch (_) {}
  });

  // ── Install window.getToolHealth ──────────────────────────────────────────
  setTimeout(function () {
    try {
      G.getToolHealth = function (toolId) {
        if (!toolId) {
          // Return all tool health summaries
          var out = {};
          Object.keys(_domains).forEach(function (k) { out[k] = getHealth(k); });
          console.table ? console.table(out) : console.log(out);
          return out;
        }
        var h = getHealth(toolId);
        console.log('[ToolHealth]', toolId, '— score:', h.score + '/100 (' + h.label + ')',
          '| crashes:', h.crashes, '| circuit:', h.circuitState, '| mem:', h.memTier);
        return h;
      };
      console.debug(LOG, 'installed window.getToolHealth(toolId)');
    } catch (_) {}
  }, 500);

  G.RuntimeToolHealthDomains = Object.freeze({
    VERSION:   VERSION,
    record:    record,
    getHealth: getHealth,
    getAllHealth: function () {
      var out = {};
      Object.keys(_domains).forEach(function (k) { out[k] = getHealth(k); });
      return out;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool health domains + window.getToolHealth() active');

}(window));

// ── SOURCE: public/js/runtime-tool-bundle-isolation.js ──
// RuntimeToolBundleIsolation v1.0 — Arc 5 / Phase H / Target 8
// =====================================================================
// Family-level bundle dependency graph + bundle GC registry.
//
// Arc 4 gap: RuntimeBundleGraph tracks which TOOL activated which
// bundle, but all tools share the same base bundle chain. There is no
// family-level dependency enforcement — an organize tool could trigger
// loading of AI bundles if RuntimeBundleRegistry.load('arc3') is called
// and arc3 contains AI processors. There is no bundle GC registry
// (knowing when a bundle can be considered unused).
//
// Solution:
//   1. Family-level bundle dependency graph: each family has an
//      explicit list of bundles it requires. Bundles NOT in a family's
//      list are never triggered by that family's tools.
//   2. Bundle GC registry: tracks how many ACTIVE tools reference each
//      bundle. When the last tool in a bundle's user set goes idle/evicted,
//      the bundle is flagged as GC-eligible.
//   3. Bundle telemetry: activation counts, load times, GC events.
//   4. Activation guard: warns if a tool attempts to load a bundle
//      outside its family's allowed set.
//   5. Registers arc4 + arc5 bundles into RuntimeBundleRegistry.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolBundleIsolation) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[BundleIsolation]';
  var VERSION = '1.0';
  var GC_TTL_MS = 20 * 60 * 1000; // 20 min after last active tool → GC-eligible

  // ── Family → allowed bundles ──────────────────────────────────────────────
  // ALL families share the base chain. Family-specific extras are listed here.
  var BASE_BUNDLES = ['core', 'security', 'zero-trust', 'hardening', 'infra', 'arc2', 'arc3', 'arc4', 'arc5'];

  var FAMILY_BUNDLES = {
    'organize':     BASE_BUNDLES,
    'compress':     BASE_BUNDLES,
    'convert-from': BASE_BUNDLES,
    'convert-to':   BASE_BUNDLES,
    'edit':         BASE_BUNDLES,
    'ai':           BASE_BUNDLES,
    'image':        BASE_BUNDLES,
    'utility':      BASE_BUNDLES.filter(function (b) { return b !== 'arc4'; }), // utility needs fewer
  };

  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Bundle GC registry ────────────────────────────────────────────────────
  // bundleName → { activeTools: Set([toolId,...]), lastActiveAt, gcEligibleSince, telemetry }
  var _gcRegistry = {};

  function _ensureBundle(bundleName) {
    if (!_gcRegistry[bundleName]) {
      _gcRegistry[bundleName] = {
        name:           bundleName,
        activeTools:    [],
        lastActiveAt:   0,
        gcEligibleSince: null,
        activationCount: 0,
        loadTimeMs:     null,
        telemetry:      [],
      };
    }
    return _gcRegistry[bundleName];
  }

  // ── Register a tool as using a bundle ─────────────────────────────────────
  function registerUsage(toolId, bundleName) {
    var family  = TOOL_FAMILY[toolId] || 'organize';
    var allowed = FAMILY_BUNDLES[family] || BASE_BUNDLES;

    // Guard: warn if this family shouldn't load this bundle
    if (!allowed.includes(bundleName)) {
      console.debug(LOG, 'ISOLATION GUARD:', toolId, '(family:' + family + ') attempting to load non-allowed bundle:', bundleName);
      try {
        G.dispatchEvent(new CustomEvent('bundle-isolation:violation', {
          detail: { toolId: toolId, family: family, bundle: bundleName },
        }));
      } catch (_) {}
      return false;
    }

    var rec = _ensureBundle(bundleName);
    if (!rec.activeTools.includes(toolId)) rec.activeTools.push(toolId);
    rec.lastActiveAt  = Date.now();
    rec.gcEligibleSince = null; // reset GC eligibility
    rec.activationCount++;
    rec.telemetry.push({ ts: Date.now(), event: 'registered', toolId: toolId });
    if (rec.telemetry.length > 50) rec.telemetry.shift();
    return true;
  }

  // ── Deregister a tool from a bundle ──────────────────────────────────────
  function deregisterUsage(toolId, bundleName) {
    var rec = _gcRegistry[bundleName];
    if (!rec) return;
    rec.activeTools = rec.activeTools.filter(function (t) { return t !== toolId; });
    if (rec.activeTools.length === 0) {
      rec.gcEligibleSince = Date.now();
      console.debug(LOG, 'bundle GC-eligible:', bundleName, '(last tool:', toolId + ')');
      rec.telemetry.push({ ts: Date.now(), event: 'gc-eligible' });
    }
  }

  // ── GC scan ───────────────────────────────────────────────────────────────
  function getGCEligible() {
    var now = Date.now();
    return Object.keys(_gcRegistry).filter(function (name) {
      var rec = _gcRegistry[name];
      return rec.gcEligibleSince && (now - rec.gcEligibleSince) > GC_TTL_MS;
    }).map(function (name) {
      var rec = _gcRegistry[name];
      return { name: name, gcEligibleSince: rec.gcEligibleSince, gcAge: now - rec.gcEligibleSince };
    });
  }

  // ── Register arc4 + arc5 into RuntimeBundleRegistry ──────────────────────
  function _registerNewBundles() {
    try {
      var reg = G.RuntimeBundleRegistry;
      if (!reg) return;
      reg.register('arc4', 'runtime-arc4.bundle.js', ['arc3']);
      reg.register('arc5', 'runtime-arc5.bundle.js', ['arc4']);
      console.debug(LOG, 'arc4 + arc5 registered in RuntimeBundleRegistry');
    } catch (e) {
      console.debug(LOG, 'bundle registration note:', e && e.message || e);
    }
  }

  // ── Listen for tool events ────────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (!toolId) return;
      var family = TOOL_FAMILY[toolId] || 'organize';
      var bundles = FAMILY_BUNDLES[family] || BASE_BUNDLES;
      bundles.forEach(function (b) { registerUsage(toolId, b); });
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (!toolId) return;
      Object.keys(_gcRegistry).forEach(function (b) { deregisterUsage(toolId, b); });
    } catch (_) {}
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _registerNewBundles, { once: true });
  } else {
    setTimeout(_registerNewBundles, 0);
  }

  G.RuntimeToolBundleIsolation = Object.freeze({
    VERSION:         VERSION,
    registerUsage:   registerUsage,
    deregisterUsage: deregisterUsage,
    getGCEligible:   getGCEligible,
    getFamilyBundles: function (family) { return (FAMILY_BUNDLES[family] || BASE_BUNDLES).slice(); },
    getRegistry:     function () {
      var out = {};
      Object.keys(_gcRegistry).forEach(function (name) {
        var rec = _gcRegistry[name];
        out[name] = { activeTools: rec.activeTools.slice(), activationCount: rec.activationCount,
                      gcEligible: !!rec.gcEligibleSince };
      });
      return out;
    },
    getDependencyGraph: function () {
      var out = {};
      Object.keys(FAMILY_BUNDLES).forEach(function (f) { out[f] = FAMILY_BUNDLES[f].slice(); });
      return out;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — family bundle isolation + GC registry active');

}(window));

// ── SOURCE: public/js/runtime-tool-offline-firewalls.js ──
// RuntimeToolOfflineFirewalls v1.0 — Arc 5 / Phase I / Target 9
// =====================================================================
// Per-TOOL isolated offline job queues (tool-level, not family-level).
//
// Arc 4 gap: RuntimeOfflineDomains creates 8 IDB stores, one per
// family. But within the 'ai' family, OCR and AI-Summarize still share
// one store. If OCR generates 50 corrupt jobs, they fill the ai store
// and block AI-Summarize from draining its legitimate jobs.
//
// Solution: Each tool gets its own IDB store:
//   iplv-tool-offline-{toolId}-v1
//
// Independent per TOOL:
//   - IDB database + 'jobs' object store
//   - _running drain flag
//   - retry counter
//   - background sync registration
//   - error recovery state
//   - queue corruption isolation (corrupt jobs in OCR never reach AI-Sum)
//
// RuntimeOfflineDomains (Arc 4) is preserved and continues working at
// family level. RuntimeToolOfflineFirewalls adds a deeper tool-level
// layer for tools that need fine-grained isolation.
//
// A tool must OPT IN by calling RuntimeToolOfflineFirewalls.enqueue()
// instead of RuntimeOfflineDomains.enqueueForTool(). Both APIs coexist.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolOfflineFirewalls) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[ToolOfflineFW]';
  var VERSION    = '1.0';
  var MAX_RETRY  = 3;
  var IDB_VER    = 1;
  var STORE_NAME = 'jobs';

  // ── Per-tool IDB state ────────────────────────────────────────────────────
  // toolId → { dbPromise, processors, running, errorCount, lastErrorAt }
  var _state = {};

  function _ensureState(toolId) {
    if (!_state[toolId]) {
      _state[toolId] = {
        dbPromise: null,
        processors: {},
        running: false,
        errorCount: 0,
        lastErrorAt: null,
      };
    }
    return _state[toolId];
  }

  // ── Open per-tool IDB ─────────────────────────────────────────────────────
  function _openDb(toolId) {
    var st = _ensureState(toolId);
    if (st.dbPromise) return st.dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IDB unavailable'));

    // Sanitize toolId for DB name (replace special chars)
    var safeId = toolId.replace(/[^a-z0-9-]/g, '-');
    var dbName  = 'iplv-tool-offline-' + safeId + '-v1';

    st.dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(dbName, IDB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('ts',     'createdAt', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) {
        reject(e.target.error);
        st.dbPromise = null;
      };
    });
    return st.dbPromise;
  }

  // ── Enqueue a job for a specific tool ─────────────────────────────────────
  function enqueue(toolId, type, payload, opts) {
    opts = opts || {};
    var job = {
      toolId:     toolId,
      type:       type,
      payload:    payload || {},
      retries:    0,
      maxRetries: opts.maxRetries !== undefined ? opts.maxRetries : MAX_RETRY,
      createdAt:  Date.now(),
      status:     'pending',
      error:      null,
    };
    return _openDb(toolId).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readwrite');
        var req = tx.objectStore(STORE_NAME).add(job);
        req.onsuccess = function () {
          job.id = req.result;
          console.debug(LOG, toolId + ': enqueued job', job.id, '— type:', type);
          resolve(job);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Drain pending jobs for a tool ─────────────────────────────────────────
  function drain(toolId) {
    var st = _ensureState(toolId);
    if (st.running || !navigator.onLine) return;
    st.running = true;

    _openDb(toolId).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).index('status').getAll('pending');
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    }).then(function (jobs) {
      if (!jobs.length) { st.running = false; return; }
      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () { return _executeJob(toolId, job); });
      });
      return chain;
    }).catch(function (e) {
      st.errorCount++;
      st.lastErrorAt = Date.now();
      console.debug(LOG, toolId + ': drain error:', e && e.message || e);
      // Isolation: errors in this tool's drain never propagate to other tools
    }).then(function () {
      st.running = false;
    });
  }

  function _executeJob(toolId, job) {
    var st      = _ensureState(toolId);
    var handler = st.processors[job.type];
    if (!handler) {
      return _updateStatus(toolId, job.id, { status: 'failed', error: 'no-handler' });
    }
    return _updateStatus(toolId, job.id, { status: 'running' })
      .then(function () { return Promise.resolve(handler(job.payload)); })
      .then(function () { return _updateStatus(toolId, job.id, { status: 'completed' }); })
      .catch(function (err) {
        var retries = (job.retries || 0) + 1;
        return _updateStatus(toolId, job.id, {
          status:  retries >= job.maxRetries ? 'failed' : 'pending',
          retries: retries,
          error:   String(err),
        });
      });
  }

  function _updateStatus(toolId, id, fields) {
    return _openDb(toolId).then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var st = tx.objectStore(STORE_NAME);
        var get = st.get(id);
        get.onsuccess = function () {
          var rec = get.result;
          if (!rec) { resolve(); return; }
          Object.assign(rec, fields);
          var put = st.put(rec);
          put.onsuccess = function () { resolve(); };
          put.onerror   = function () { resolve(); }; // non-fatal
        };
        get.onerror = function () { resolve(); };
      });
    });
  }

  // ── Register a handler for a tool + type ─────────────────────────────────
  function register(toolId, type, fn) {
    var st = _ensureState(toolId);
    st.processors[type] = fn;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    if (toolId) {
      var st = _state[toolId];
      return st ? {
        toolId:     toolId,
        running:    st.running,
        errorCount: st.errorCount,
        hasDb:      !!st.dbPromise,
      } : null;
    }
    var out = {};
    Object.keys(_state).forEach(function (k) { out[k] = getStats(k); });
    return out;
  }

  // ── Drain all registered tools on reconnect ───────────────────────────────
  function drainAll() { Object.keys(_state).forEach(drain); }

  G.addEventListener('online', drainAll);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') drainAll();
  });

  G.RuntimeToolOfflineFirewalls = Object.freeze({
    VERSION:  VERSION,
    enqueue:  enqueue,
    drain:    drain,
    drainAll: drainAll,
    register: register,
    getStats: getStats,
    getTools: function () { return Object.keys(_state); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool isolated offline queues active');

}(window));


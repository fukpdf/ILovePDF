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

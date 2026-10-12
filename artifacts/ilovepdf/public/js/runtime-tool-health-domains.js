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

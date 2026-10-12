// RuntimeToolRegistry v1.0 — Arc 12 / Phase A / Enterprise Tool Intelligence Layer
// Unified registry: every tool is a self-aware runtime entity with full metrics tracking.
// Integrates: RuntimeEventTimeline, RuntimeBlackbox (optional telemetry)
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolRegistry) return;

  var LOG = '[ToolRegistry]';

  // ── Schema ────────────────────────────────────────────────────────────────────
  // tool record shape:
  // {
  //   id, category, bundle, processorFamily,
  //   startupMs, avgExecutionMs, avgMemoryMb,
  //   launches, successes, failures, crashCount,
  //   healthScore,              // 0-100, managed by RuntimeToolHealth
  //   lastUsed,                 // timestamp
  //   registered                // timestamp
  // }

  var _tools   = {};   // id → record
  var _metrics = { registered: 0, updated: 0, lookups: 0 };

  // ── Default record ────────────────────────────────────────────────────────────
  function _defaults(spec) {
    return {
      id:              spec.id              || 'unknown',
      category:        spec.category        || 'pdf',
      bundle:          spec.bundle          || null,
      processorFamily: spec.processorFamily || null,
      startupMs:       spec.startupMs       || 0,
      avgExecutionMs:  spec.avgExecutionMs  || 0,
      avgMemoryMb:     spec.avgMemoryMb     || 0,
      launches:        spec.launches        || 0,
      successes:       spec.successes       || 0,
      failures:        spec.failures        || 0,
      crashCount:      spec.crashCount      || 0,
      healthScore:     spec.healthScore     || 100,
      lastUsed:        spec.lastUsed        || null,
      registered:      Date.now(),
    };
  }

  // ── Register ──────────────────────────────────────────────────────────────────
  function registerTool(spec) {
    if (!spec || !spec.id) {
      console.warn(LOG, 'registerTool: missing id');
      return null;
    }
    if (_tools[spec.id]) {
      // Merge — preserve existing metrics
      var existing = _tools[spec.id];
      _tools[spec.id] = Object.assign({}, existing, {
        category:        spec.category        || existing.category,
        bundle:          spec.bundle          !== undefined ? spec.bundle          : existing.bundle,
        processorFamily: spec.processorFamily !== undefined ? spec.processorFamily : existing.processorFamily,
      });
      return _tools[spec.id];
    }
    _tools[spec.id] = _defaults(spec);
    _metrics.registered++;
    _tel('register', { id: spec.id, category: _tools[spec.id].category });
    return _tools[spec.id];
  }

  // ── Get ───────────────────────────────────────────────────────────────────────
  function getTool(id) {
    _metrics.lookups++;
    return _tools[id] ? Object.assign({}, _tools[id]) : null;
  }

  function getAllTools() {
    return Object.keys(_tools).map(function (id) {
      return Object.assign({}, _tools[id]);
    });
  }

  // ── Update metrics ────────────────────────────────────────────────────────────
  // delta shape: { startupMs?, executionMs?, memoryMb?, success?, failure?, crash? }
  function updateMetrics(id, delta) {
    if (!delta) return;
    var t = _tools[id];
    if (!t) {
      // Auto-register on first update
      t = _defaults({ id: id });
      _tools[id] = t;
      _metrics.registered++;
    }

    t.lastUsed = Date.now();

    if (delta.startupMs !== undefined) {
      t.startupMs = t.launches === 0
        ? delta.startupMs
        : Math.round((t.startupMs * 0.8) + (delta.startupMs * 0.2));  // EMA
    }
    if (delta.executionMs !== undefined) {
      t.avgExecutionMs = t.launches === 0
        ? delta.executionMs
        : Math.round((t.avgExecutionMs * 0.8) + (delta.executionMs * 0.2));
    }
    if (delta.memoryMb !== undefined) {
      t.avgMemoryMb = t.launches === 0
        ? delta.memoryMb
        : parseFloat(((t.avgMemoryMb * 0.8) + (delta.memoryMb * 0.2)).toFixed(2));
    }

    if (delta.launch)   { t.launches++; }
    if (delta.success)  { t.successes++; }
    if (delta.failure)  { t.failures++;  }
    if (delta.crash)    { t.crashCount++; t.failures++; }

    _metrics.updated++;
    _tel('update', { id: id, delta: Object.keys(delta) });

    // Broadcast so RuntimeToolHealth can refresh
    try {
      G.dispatchEvent(new CustomEvent('arc12:metrics-updated', {
        detail: { toolId: id, delta: delta }
      }));
    } catch (_) {}
  }

  // ── Bulk seed from tools-config.js ───────────────────────────────────────────
  function seedFromConfig() {
    var cfg = G.TOOL_DEFINITIONS || G.ToolsConfig || G.TOOLS_CONFIG;
    if (!cfg) return 0;
    var list = Array.isArray(cfg) ? cfg : Object.values(cfg);
    var count = 0;
    list.forEach(function (t) {
      if (t && t.id) { registerTool({ id: t.id, category: t.category || 'pdf' }); count++; }
    });
    console.debug(LOG, 'seeded', count, 'tools from config');
    return count;
  }

  // ── Internal telemetry ────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:registry:' + event, data, ['arc12', 'registry']);
    } catch (_) {}
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────
  function getMetrics() {
    return Object.assign({}, _metrics, { totalTools: Object.keys(_tools).length });
  }

  // ── Listen for tool use events ────────────────────────────────────────────────
  try {
    G.addEventListener('arc9:tool-recorded', function (e) {
      var id = e && e.detail && e.detail.toolId;
      if (id) updateMetrics(id, { launch: true });
    });
  } catch (_) {}

  // Auto-seed after a short delay (TOOL_DEFINITIONS may not be defined yet)
  setTimeout(function () { seedFromConfig(); }, 500);

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolRegistry = Object.freeze({
    registerTool:   registerTool,
    getTool:        getTool,
    getAllTools:     getAllTools,
    updateMetrics:  updateMetrics,
    seedFromConfig: seedFromConfig,
    getMetrics:     getMetrics,
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));

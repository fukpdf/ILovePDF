// RuntimeToolDependencies v1.0 — Arc 12 / Phase C / Enterprise Tool Intelligence Layer
// Dependency graph: tracks upstream/downstream relationships between tools.
// Allows understanding which tools depend on which processors/bundles/tools.
// Integrates: RuntimeToolRegistry, RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolDependencies) return;

  var LOG = '[ToolDependencies]';

  // ── Graph storage ─────────────────────────────────────────────────────────────
  // _deps[toolId]  = Set of IDs that toolId depends ON  (upstream)
  // _deps_of[toolId] = Set of IDs that depend ON toolId (downstream)
  var _deps    = {};   // toolId → [dependsOn, ...]
  var _depsOf  = {};   // toolId → [dependentId, ...]
  var _meta    = {};   // edge key (a→b) → { type, addedAt }
  var _metrics = { edges: 0, lookups: 0, removals: 0 };

  function _ensureNode(id) {
    if (!_deps[id])   _deps[id]   = [];
    if (!_depsOf[id]) _depsOf[id] = [];
  }

  // ── Add dependency ────────────────────────────────────────────────────────────
  // toolId depends on dependsOn (toolId is downstream, dependsOn is upstream)
  function addDependency(toolId, dependsOn, type) {
    if (!toolId || !dependsOn || toolId === dependsOn) return;
    _ensureNode(toolId);
    _ensureNode(dependsOn);

    var key = toolId + '→' + dependsOn;
    if (_meta[key]) return;   // already exists

    _deps[toolId].push(dependsOn);
    _depsOf[dependsOn].push(toolId);
    _meta[key] = { type: type || 'generic', addedAt: Date.now() };
    _metrics.edges++;

    _tel('add', { toolId: toolId, dependsOn: dependsOn, type: type });

    try {
      G.dispatchEvent(new CustomEvent('arc12:dependency-added', {
        detail: { toolId: toolId, dependsOn: dependsOn }
      }));
    } catch (_) {}
  }

  // ── Remove dependency ─────────────────────────────────────────────────────────
  function removeDependency(toolId, dependsOn) {
    var key = toolId + '→' + dependsOn;
    if (!_meta[key]) return;
    delete _meta[key];
    _deps[toolId]    = (_deps[toolId]    || []).filter(function (d) { return d !== dependsOn; });
    _depsOf[dependsOn] = (_depsOf[dependsOn] || []).filter(function (d) { return d !== toolId;  });
    _metrics.removals++;
  }

  // ── Query ─────────────────────────────────────────────────────────────────────
  // Returns IDs that toolId depends on (upstream)
  function getDependencies(toolId) {
    _metrics.lookups++;
    return (_deps[toolId] || []).slice();
  }

  // Returns IDs that depend ON toolId (downstream)
  function getDependents(toolId) {
    _metrics.lookups++;
    return (_depsOf[toolId] || []).slice();
  }

  function getDependencyCount(toolId) {
    return (_deps[toolId] || []).length;
  }

  function getDependentCount(toolId) {
    return (_depsOf[toolId] || []).length;
  }

  // ── Full graph export ─────────────────────────────────────────────────────────
  function getGraph() {
    var nodes = Object.keys(_deps).concat(Object.keys(_depsOf))
      .filter(function (v, i, a) { return a.indexOf(v) === i; });  // unique

    return {
      nodes: nodes.map(function (id) {
        return {
          id: id,
          upstreamCount:   getDependencyCount(id),
          downstreamCount: getDependentCount(id),
        };
      }),
      edges: Object.keys(_meta).map(function (key) {
        var parts = key.split('→');
        return {
          from: parts[0],
          to:   parts[1],
          type: _meta[key].type,
          addedAt: _meta[key].addedAt,
        };
      }),
      metrics: Object.assign({}, _metrics),
    };
  }

  // ── Seed common tool dependency patterns ──────────────────────────────────────
  function seedDefaults() {
    var PATTERNS = [
      // OCR enables translation
      ['ai-translate', 'ocr-pdf',        'processor'],
      // Merge often needs compress downstream
      ['compress-pdf', 'merge-pdf',      'workflow'],
      // Split → merge common loop
      ['merge-pdf',    'split-pdf',      'workflow'],
      // PDF to Word → Word to PDF round-trip
      ['word-to-pdf',  'pdf-to-word',    'conversion'],
      // AI Summarizer depends on OCR for scanned docs
      ['ai-summarizer', 'ocr-pdf',       'processor'],
      // Protect depends on base PDF
      ['protect-pdf',  'merge-pdf',      'workflow'],
      // Watermark similar
      ['watermark-pdf', 'merge-pdf',     'workflow'],
    ];
    PATTERNS.forEach(function (p) { addDependency(p[0], p[1], p[2]); });
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:deps:' + event, data, ['arc12', 'deps']);
    } catch (_) {}
  }

  // Seed after short delay
  setTimeout(seedDefaults, 800);

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolDependencies = Object.freeze({
    addDependency:      addDependency,
    removeDependency:   removeDependency,
    getDependencies:    getDependencies,
    getDependents:      getDependents,
    getDependencyCount: getDependencyCount,
    getDependentCount:  getDependentCount,
    getGraph:           getGraph,
    seedDefaults:       seedDefaults,
    getMetrics:         function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));

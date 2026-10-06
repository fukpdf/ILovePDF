// RuntimeToolExport v1.0 — Arc 12 / Phase J / Enterprise Tool Intelligence Layer
// Export layer: health reports, dependency graphs, tool statistics, prediction models.
// Formats: JSON and CSV.
// Integrates: RuntimeToolRegistry, RuntimeToolHealth, RuntimeToolDependencies,
//             RuntimeToolProfiler, RuntimeToolPredictor, RuntimeToolRecovery,
//             RuntimeToolOptimizer.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolExport) return;

  var LOG = '[ToolExport]';

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function _get(global) { return G[global] || null; }

  function _csvRow(values) {
    return values.map(function (v) {
      var s = (v === null || v === undefined) ? '' : String(v);
      return s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(',');
  }

  function _toCsv(rows, headers) {
    var lines = [headers.join(',')];
    rows.forEach(function (r) {
      lines.push(_csvRow(headers.map(function (h) { return r[h]; })));
    });
    return lines.join('\n');
  }

  // ── Health report ─────────────────────────────────────────────────────────────
  function exportHealth(format) {
    var reg    = _get('RuntimeToolRegistry');
    var health = _get('RuntimeToolHealth');
    if (!reg) return null;

    var tools  = reg.getAllTools();
    var levels = health ? health.getAllHealthLevels() : {};

    var rows = tools.map(function (t) {
      var h = levels[t.id] || {};
      return {
        id:          t.id,
        category:    t.category,
        healthScore: h.score  !== undefined ? h.score  : 100,
        healthLevel: h.level  || 'GOOD',
        launches:    t.launches,
        successes:   t.successes,
        failures:    t.failures,
        crashCount:  t.crashCount,
        startupMs:   t.startupMs,
        avgExecMs:   t.avgExecutionMs,
        avgMemMb:    t.avgMemoryMb,
        lastUsed:    t.lastUsed ? new Date(t.lastUsed).toISOString() : '',
      };
    });

    var result = {
      type:      'health-report',
      exportedAt: new Date().toISOString(),
      toolCount:  rows.length,
      data:       rows,
    };

    if (format === 'csv') {
      return _toCsv(rows, ['id','category','healthScore','healthLevel','launches',
                           'successes','failures','crashCount','startupMs','avgExecMs','avgMemMb','lastUsed']);
    }
    return JSON.stringify(result, null, 2);
  }

  // ── Dependency graph ──────────────────────────────────────────────────────────
  function exportDependencies(format) {
    var dep = _get('RuntimeToolDependencies');
    if (!dep) return null;

    var graph = dep.getGraph();

    if (format === 'csv') {
      var edgeRows = graph.edges.map(function (e) {
        return { from: e.from, to: e.to, type: e.type, addedAt: new Date(e.addedAt).toISOString() };
      });
      return _toCsv(edgeRows, ['from','to','type','addedAt']);
    }

    return JSON.stringify({
      type:       'dependency-graph',
      exportedAt: new Date().toISOString(),
      nodeCount:  graph.nodes.length,
      edgeCount:  graph.edges.length,
      graph:      graph,
    }, null, 2);
  }

  // ── Tool statistics ───────────────────────────────────────────────────────────
  function exportStats(format) {
    var prof = _get('RuntimeToolProfiler');
    if (!prof) return null;

    var stats = prof.getAllStats();

    if (format === 'csv') {
      var rows = stats.map(function (s) {
        return {
          toolId:      s.toolId,
          sessions:    s.sessions,
          startupP50:  s.startupMs.p50,
          startupP99:  s.startupMs.p99,
          execP50:     s.executionMs.p50,
          execP90:     s.executionMs.p90,
          execP99:     s.executionMs.p99,
          memP50:      s.memoryMb.p50,
          memP99:      s.memoryMb.p99,
        };
      });
      return _toCsv(rows, ['toolId','sessions','startupP50','startupP99',
                            'execP50','execP90','execP99','memP50','memP99']);
    }

    return JSON.stringify({
      type:       'tool-statistics',
      exportedAt: new Date().toISOString(),
      toolCount:  stats.length,
      data:       stats,
    }, null, 2);
  }

  // ── Prediction models ─────────────────────────────────────────────────────────
  function exportPredictions(format) {
    var pred = _get('RuntimeToolPredictor');
    if (!pred) return null;

    var sequences = pred.getTopSequences(50);
    var model     = pred.getModel();

    if (format === 'csv') {
      return _toCsv(sequences, ['from','to','count']);
    }

    return JSON.stringify({
      type:       'prediction-model',
      exportedAt: new Date().toISOString(),
      sequences:  sequences,
      model:      model,
    }, null, 2);
  }

  // ── Recovery history ──────────────────────────────────────────────────────────
  function exportRecovery(format) {
    var rec = _get('RuntimeToolRecovery');
    if (!rec) return null;

    var all = rec.getAllHistory();
    var rows = [];
    Object.keys(all).forEach(function (toolId) {
      all[toolId].forEach(function (entry) {
        rows.push({
          toolId:       toolId,
          failureType:  entry.failureType,
          recoveryUsed: entry.recoveryUsed,
          success:      entry.success,
          durationMs:   entry.durationMs,
          ts:           new Date(entry.ts).toISOString(),
        });
      });
    });

    if (format === 'csv') {
      return _toCsv(rows, ['toolId','failureType','recoveryUsed','success','durationMs','ts']);
    }

    return JSON.stringify({
      type:       'recovery-history',
      exportedAt: new Date().toISOString(),
      entryCount: rows.length,
      data:       rows,
    }, null, 2);
  }

  // ── Full export bundle ────────────────────────────────────────────────────────
  function exportAll(format) {
    var bundle = {
      type:       'arc12-full-export',
      exportedAt: new Date().toISOString(),
      health:     null,
      deps:       null,
      stats:      null,
      predictions: null,
      recovery:   null,
    };

    if (format === 'csv') {
      // CSV: return health as primary export for the bundle mode
      return exportHealth('csv');
    }

    try { bundle.health      = JSON.parse(exportHealth()      || 'null'); } catch (_) {}
    try { bundle.deps        = JSON.parse(exportDependencies() || 'null'); } catch (_) {}
    try { bundle.stats       = JSON.parse(exportStats()       || 'null'); } catch (_) {}
    try { bundle.predictions = JSON.parse(exportPredictions() || 'null'); } catch (_) {}
    try { bundle.recovery    = JSON.parse(exportRecovery()    || 'null'); } catch (_) {}

    return JSON.stringify(bundle, null, 2);
  }

  // ── Trigger browser download ──────────────────────────────────────────────────
  function download(data, filename, mime) {
    if (!data || typeof document === 'undefined') return;
    try {
      var blob = new Blob([data], { type: mime || 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href     = url;
      a.download = filename || 'arc12-export.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
    } catch (e) { console.warn(LOG, 'download failed:', e.message); }
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolExport = Object.freeze({
    exportHealth:       exportHealth,
    exportDependencies: exportDependencies,
    exportStats:        exportStats,
    exportPredictions:  exportPredictions,
    exportRecovery:     exportRecovery,
    exportAll:          exportAll,
    download:           download,
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));

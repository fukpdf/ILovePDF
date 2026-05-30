(function (G) {
  'use strict';
  if (G.RuntimeCommandCenter) return;

  var LOG = '[Arc14:CommandCenter]';

  // Subsystem registry — all known Arc 8–13 globals + their health probes
  var SUBSYSTEMS = [
    // Arc 8
    { id: 'governance',          arc: 8,  global: 'RuntimeGovernance',         label: 'Governance'           },
    { id: 'recovery',            arc: 8,  global: 'RuntimeRecoveryOrchestrator',label: 'Recovery Orchestrator'},
    { id: 'perf-profiler',       arc: 8,  global: 'RuntimePerformanceProfiler', label: 'Perf Profiler'        },
    { id: 'incident-correlation',arc: 8,  global: 'RuntimeIncidentCorrelation', label: 'Incident Correlation' },
    // Arc 9
    { id: 'adaptive-ai',         arc: 9,  global: 'RuntimeAdaptiveAI',          label: 'Adaptive AI'          },
    { id: 'adaptive-bundles',    arc: 9,  global: 'RuntimeAdaptiveBundles',     label: 'Adaptive Bundles'     },
    { id: 'recovery-memory',     arc: 9,  global: 'RuntimeRecoveryMemory',      label: 'Recovery Memory'      },
    // Arc 11
    { id: 'tab-mesh',            arc: 11, global: 'RuntimeTabMesh',             label: 'Tab Mesh'             },
    { id: 'crash-survival',      arc: 11, global: 'RuntimeCrashSurvival',       label: 'Crash Survival'       },
    { id: 'deploy-resilience',   arc: 11, global: 'RuntimeDeployResilience',    label: 'Deploy Resilience'    },
    // Arc 12
    { id: 'tool-registry',       arc: 12, global: 'RuntimeToolRegistry',        label: 'Tool Registry'        },
    { id: 'tool-health',         arc: 12, global: 'RuntimeToolHealth',          label: 'Tool Health'          },
    { id: 'tool-predictor',      arc: 12, global: 'RuntimeToolPredictor',       label: 'Tool Predictor'       },
    { id: 'tool-profiler',       arc: 12, global: 'RuntimeToolProfiler',        label: 'Tool Profiler'        },
    { id: 'tool-isolation',      arc: 12, global: 'RuntimeToolIsolation',       label: 'Tool Isolation'       },
    // Arc 13
    { id: 'tool-persistence',    arc: 13, global: 'RuntimeToolPersistence',     label: 'Tool Persistence'     },
    { id: 'circuit-breaker',     arc: 13, global: 'RuntimeToolCircuitBreaker',  label: 'Circuit Breaker'      },
    { id: 'tool-sla',            arc: 13, global: 'RuntimeToolSLA',             label: 'Tool SLA'             },
    { id: 'tool-discovery',      arc: 13, global: 'RuntimeToolDiscovery',       label: 'Tool Discovery'       },
    { id: 'tool-ranking',        arc: 13, global: 'RuntimeToolRanking',         label: 'Tool Ranking'         },
    { id: 'tool-anomaly',        arc: 13, global: 'RuntimeToolAnomaly',         label: 'Tool Anomaly'         },
    { id: 'tool-lifecycle',      arc: 13, global: 'RuntimeToolLifecycle',       label: 'Tool Lifecycle'       },
    { id: 'tool-insights',       arc: 13, global: 'RuntimeToolInsights',        label: 'Tool Insights'        },
  ];

  var _health   = {};   // subsystemId → { present, healthy, message }
  var _metrics  = { commands: 0, errors: 0, lastRefreshTs: 0 };
  var REFRESH_MS = 30 * 1000;

  // ── Subsystem discovery ──────────────────────────────────────────────────────
  function _probe(sub) {
    var glob = G[sub.global];
    if (!glob) {
      _health[sub.id] = { present: false, healthy: false, message: 'not loaded', arc: sub.arc, label: sub.label };
      return;
    }
    // Try getMetrics() or similar health probe
    var ok  = true;
    var msg = 'ok';
    try {
      if (glob.getMetrics) glob.getMetrics();
      else if (glob.getHealthSummary) glob.getHealthSummary();
      else if (glob.getAllTools) glob.getAllTools();
    } catch (e) { ok = false; msg = e.message || 'probe failed'; }
    _health[sub.id] = { present: true, healthy: ok, message: msg, arc: sub.arc, label: sub.label, global: sub.global };
  }

  function _refreshAll() {
    SUBSYSTEMS.forEach(_probe);
    _metrics.lastRefreshTs = Date.now();
    try {
      G.dispatchEvent(new CustomEvent('arc14:health-refreshed', {
        detail: { ts: _metrics.lastRefreshTs, count: SUBSYSTEMS.length },
      }));
    } catch (_) {}
  }

  // ── Health aggregation ───────────────────────────────────────────────────────
  function getSystemHealth() {
    var present = 0, healthy = 0, total = SUBSYSTEMS.length;
    Object.values(_health).forEach(function (h) {
      if (h.present) present++;
      if (h.healthy) healthy++;
    });
    var score = total > 0 ? Math.round((healthy / total) * 100) : 0;
    var level = score >= 90 ? 'EXCELLENT' : score >= 70 ? 'GOOD' : score >= 50 ? 'DEGRADED' : 'CRITICAL';
    return { score: score, level: level, present: present, healthy: healthy, total: total };
  }

  // ── Topology ─────────────────────────────────────────────────────────────────
  function getTopology() {
    var nodes = SUBSYSTEMS.map(function (s) {
      var h = _health[s.id] || {};
      return { id: s.id, label: s.label, arc: s.arc, global: s.global,
               present: !!h.present, healthy: !!h.healthy };
    });
    var edges = [
      { from: 'governance',      to: 'tool-isolation',   type: 'governs'  },
      { from: 'governance',      to: 'circuit-breaker',  type: 'governs'  },
      { from: 'recovery',        to: 'recovery-memory',  type: 'uses'     },
      { from: 'adaptive-ai',     to: 'tool-predictor',   type: 'feeds'    },
      { from: 'tool-registry',   to: 'tool-health',      type: 'feeds'    },
      { from: 'tool-health',     to: 'circuit-breaker',  type: 'triggers' },
      { from: 'tool-profiler',   to: 'tool-sla',         type: 'feeds'    },
      { from: 'tool-sla',        to: 'circuit-breaker',  type: 'triggers' },
      { from: 'tool-anomaly',    to: 'circuit-breaker',  type: 'triggers' },
      { from: 'tool-discovery',  to: 'tool-predictor',   type: 'feeds'    },
      { from: 'tool-insights',   to: 'tool-persistence', type: 'reads'    },
      { from: 'tool-ranking',    to: 'adaptive-bundles', type: 'feeds'    },
      { from: 'incident-correlation', to: 'recovery',   type: 'triggers' },
      { from: 'perf-profiler',   to: 'tool-anomaly',    type: 'feeds'    },
      { from: 'tab-mesh',        to: 'tool-registry',   type: 'reports'  },
      { from: 'crash-survival',  to: 'recovery',        type: 'triggers' },
      { from: 'deploy-resilience', to: 'recovery',      type: 'triggers' },
    ];
    return { nodes: nodes, edges: edges };
  }

  // ── Subsystem list ───────────────────────────────────────────────────────────
  function getSubsystems() {
    return SUBSYSTEMS.map(function (s) {
      return Object.assign({}, s, _health[s.id] || { present: false, healthy: false });
    });
  }

  // ── Command routing ──────────────────────────────────────────────────────────
  function executeCommand(cmd, args) {
    _metrics.commands++;
    args = args || {};
    try {
      if (cmd === 'force-save') {
        var p = G.RuntimeToolPersistence;
        if (p && p.save) return p.save();
      } else if (cmd === 'force-restore') {
        var p2 = G.RuntimeToolPersistence;
        if (p2 && p2.restore) return p2.restore();
      } else if (cmd === 'generate-insights') {
        var ins = G.RuntimeToolInsights;
        if (ins && ins.generateInsights) { ins.generateInsights(); return { ok: true }; }
      } else if (cmd === 'check-sla') {
        var sla = G.RuntimeToolSLA;
        if (sla && sla.checkAll) { sla.checkAll(); return { ok: true }; }
      } else if (cmd === 'force-rank') {
        var rank = G.RuntimeToolRanking;
        if (rank && rank.forceRefresh) { rank.forceRefresh(); return { ok: true }; }
      } else if (cmd === 'quarantine') {
        var gov = G.RuntimeGovernance;
        if (gov && gov.quarantine && args.subsystem) {
          gov.quarantine(args.subsystem, args.reason || 'arc14:command');
          return { ok: true };
        }
      } else if (cmd === 'lift-quarantine') {
        var gov2 = G.RuntimeGovernance;
        if (gov2 && gov2.liftQuarantine && args.subsystem) {
          gov2.liftQuarantine(args.subsystem);
          return { ok: true };
        }
      } else if (cmd === 'refresh-health') {
        _refreshAll();
        return { ok: true };
      }
    } catch (e) {
      _metrics.errors++;
      console.warn(LOG, 'command error:', cmd, e.message || e);
      return { ok: false, error: e.message || String(e) };
    }
    return { ok: false, error: 'unknown command: ' + cmd };
  }

  function getMetrics() { return Object.assign({}, _metrics, { subsystems: SUBSYSTEMS.length }); }

  // ── Boot ────────────────────────────────────────────────────────────────────
  _refreshAll();
  setInterval(_refreshAll, REFRESH_MS);

  G.RuntimeCommandCenter = Object.freeze({
    getTopology:    getTopology,
    getSubsystems:  getSubsystems,
    getSystemHealth: getSystemHealth,
    executeCommand: executeCommand,
    getMetrics:     getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeTopology) return;

  var LOG = '[Arc14:Topology]';

  // ── Arc clusters ─────────────────────────────────────────────────────────────
  var CLUSTERS = [
    { id: 'arc8',  label: 'Arc 8 — Observability',           color: '#3498db' },
    { id: 'arc9',  label: 'Arc 9 — Autonomous Runtime',      color: '#9b59b6' },
    { id: 'arc10', label: 'Arc 10 — Debug Platform',         color: '#1abc9c' },
    { id: 'arc11', label: 'Arc 11 — Distributed Runtime',    color: '#e67e22' },
    { id: 'arc12', label: 'Arc 12 — Tool Intelligence',      color: '#e74c3c' },
    { id: 'arc13', label: 'Arc 13 — Persistent Intelligence',color: '#f39c12' },
    { id: 'arc14', label: 'Arc 14 — Command Center',         color: '#2ecc71' },
  ];

  // Node definitions with cluster membership
  var NODE_DEFS = [
    // Arc 8
    { id: 'RuntimeGovernance',          cluster: 'arc8',  label: 'Governance'            },
    { id: 'RuntimeRecoveryOrchestrator',cluster: 'arc8',  label: 'Recovery Orchestrator' },
    { id: 'RuntimePerformanceProfiler', cluster: 'arc8',  label: 'Perf Profiler'         },
    { id: 'RuntimeIncidentCorrelation', cluster: 'arc8',  label: 'Incident Correlation'  },
    // Arc 9
    { id: 'RuntimeAdaptiveAI',          cluster: 'arc9',  label: 'Adaptive AI'           },
    { id: 'RuntimeAdaptiveBundles',     cluster: 'arc9',  label: 'Adaptive Bundles'      },
    { id: 'RuntimeRecoveryMemory',      cluster: 'arc9',  label: 'Recovery Memory'       },
    // Arc 11
    { id: 'RuntimeTabMesh',             cluster: 'arc11', label: 'Tab Mesh'              },
    { id: 'RuntimeCrashSurvival',       cluster: 'arc11', label: 'Crash Survival'        },
    { id: 'RuntimeDeployResilience',    cluster: 'arc11', label: 'Deploy Resilience'     },
    // Arc 12
    { id: 'RuntimeToolRegistry',        cluster: 'arc12', label: 'Tool Registry'         },
    { id: 'RuntimeToolHealth',          cluster: 'arc12', label: 'Tool Health'           },
    { id: 'RuntimeToolPredictor',       cluster: 'arc12', label: 'Tool Predictor'        },
    { id: 'RuntimeToolProfiler',        cluster: 'arc12', label: 'Tool Profiler'         },
    { id: 'RuntimeToolIsolation',       cluster: 'arc12', label: 'Tool Isolation'        },
    { id: 'RuntimeToolDependencies',    cluster: 'arc12', label: 'Tool Dependencies'     },
    { id: 'RuntimeToolRecovery',        cluster: 'arc12', label: 'Tool Recovery'         },
    { id: 'RuntimeToolOptimizer',       cluster: 'arc12', label: 'Tool Optimizer'        },
    // Arc 13
    { id: 'RuntimeToolPersistence',     cluster: 'arc13', label: 'Tool Persistence'      },
    { id: 'RuntimeToolCircuitBreaker',  cluster: 'arc13', label: 'Circuit Breaker'       },
    { id: 'RuntimeToolSLA',             cluster: 'arc13', label: 'Tool SLA'              },
    { id: 'RuntimeToolDiscovery',       cluster: 'arc13', label: 'Tool Discovery'        },
    { id: 'RuntimeToolRanking',         cluster: 'arc13', label: 'Tool Ranking'          },
    { id: 'RuntimeToolAnomaly',         cluster: 'arc13', label: 'Tool Anomaly'          },
    { id: 'RuntimeToolLifecycle',       cluster: 'arc13', label: 'Tool Lifecycle'        },
    { id: 'RuntimeToolInsights',        cluster: 'arc13', label: 'Tool Insights'         },
    // Arc 14
    { id: 'RuntimeCommandCenter',       cluster: 'arc14', label: 'Command Center'        },
    { id: 'RuntimeTopology',            cluster: 'arc14', label: 'Topology'              },
    { id: 'RuntimeHeatmaps',            cluster: 'arc14', label: 'Heatmaps'             },
    { id: 'RuntimeAnalytics',           cluster: 'arc14', label: 'Analytics'            },
    { id: 'RuntimeAlerts',              cluster: 'arc14', label: 'Alerts'               },
    { id: 'RuntimeFleetManager',        cluster: 'arc14', label: 'Fleet Manager'        },
    { id: 'RuntimeForecast',            cluster: 'arc14', label: 'Forecast'             },
    { id: 'RuntimeReports',             cluster: 'arc14', label: 'Reports'              },
  ];

  // Edge definitions (from → to, type)
  var EDGE_DEFS = [
    // Dependency edges
    { from: 'RuntimeGovernance',         to: 'RuntimeToolIsolation',       type: 'governs'   },
    { from: 'RuntimeGovernance',         to: 'RuntimeToolCircuitBreaker',  type: 'governs'   },
    { from: 'RuntimeRecoveryOrchestrator', to: 'RuntimeRecoveryMemory',    type: 'uses'      },
    { from: 'RuntimeAdaptiveAI',         to: 'RuntimeToolPredictor',       type: 'feeds'     },
    { from: 'RuntimeToolRegistry',       to: 'RuntimeToolHealth',          type: 'feeds'     },
    { from: 'RuntimeToolRegistry',       to: 'RuntimeToolLifecycle',       type: 'feeds'     },
    { from: 'RuntimeToolHealth',         to: 'RuntimeToolCircuitBreaker',  type: 'triggers'  },
    { from: 'RuntimeToolProfiler',       to: 'RuntimeToolSLA',             type: 'feeds'     },
    { from: 'RuntimeToolProfiler',       to: 'RuntimeToolAnomaly',         type: 'feeds'     },
    { from: 'RuntimeToolSLA',            to: 'RuntimeToolCircuitBreaker',  type: 'triggers'  },
    { from: 'RuntimeToolAnomaly',        to: 'RuntimeToolCircuitBreaker',  type: 'triggers'  },
    { from: 'RuntimeToolDiscovery',      to: 'RuntimeToolDependencies',    type: 'promotes'  },
    { from: 'RuntimeToolDiscovery',      to: 'RuntimeToolPredictor',       type: 'feeds'     },
    { from: 'RuntimeToolRanking',        to: 'RuntimeAdaptiveBundles',     type: 'feeds'     },
    { from: 'RuntimeIncidentCorrelation', to: 'RuntimeRecoveryOrchestrator', type: 'triggers'},
    { from: 'RuntimeCrashSurvival',      to: 'RuntimeRecoveryOrchestrator', type: 'triggers' },
    { from: 'RuntimeDeployResilience',   to: 'RuntimeRecoveryOrchestrator', type: 'triggers' },
    // Recovery chain
    { from: 'RuntimeToolRecovery',       to: 'RuntimeRecoveryMemory',      type: 'reads'     },
    { from: 'RuntimeToolOptimizer',      to: 'RuntimeAdaptiveBundles',     type: 'uses'      },
    { from: 'RuntimeToolPersistence',    to: 'RuntimeToolRegistry',        type: 'seeds'     },
    // Arc 14 reads from everything
    { from: 'RuntimeCommandCenter',      to: 'RuntimeGovernance',          type: 'commands'  },
    { from: 'RuntimeCommandCenter',      to: 'RuntimeToolPersistence',     type: 'commands'  },
    { from: 'RuntimeHeatmaps',           to: 'RuntimePerformanceProfiler', type: 'reads'     },
    { from: 'RuntimeHeatmaps',           to: 'RuntimeToolProfiler',        type: 'reads'     },
    { from: 'RuntimeAlerts',             to: 'RuntimeToolCircuitBreaker',  type: 'monitors'  },
    { from: 'RuntimeAlerts',             to: 'RuntimeToolSLA',             type: 'monitors'  },
    { from: 'RuntimeFleetManager',       to: 'RuntimeGovernance',          type: 'uses'      },
    { from: 'RuntimeForecast',           to: 'RuntimeAdaptiveAI',          type: 'reads'     },
    { from: 'RuntimeForecast',           to: 'RuntimeToolInsights',        type: 'reads'     },
    { from: 'RuntimeReports',            to: 'RuntimeToolRanking',         type: 'reads'     },
    { from: 'RuntimeReports',            to: 'RuntimeToolInsights',        type: 'reads'     },
  ];

  var _metrics = { refreshes: 0, lastTs: 0 };

  function _buildNodes() {
    return NODE_DEFS.map(function (n) {
      return {
        id:      n.id,
        label:   n.label,
        cluster: n.cluster,
        present: !!G[n.id],
      };
    });
  }

  function _buildEdges() {
    return EDGE_DEFS.map(function (e) {
      return {
        from:     e.from,
        to:       e.to,
        type:     e.type,
        active:   !!(G[e.from] && G[e.to]),
      };
    });
  }

  function getGraph() {
    _metrics.refreshes++;
    _metrics.lastTs = Date.now();
    return {
      nodes:    _buildNodes(),
      edges:    _buildEdges(),
      clusters: CLUSTERS.slice(),
      ts:       _metrics.lastTs,
    };
  }

  function getClusters() { return CLUSTERS.slice(); }

  function getClusterHealth() {
    var result = {};
    CLUSTERS.forEach(function (c) {
      var clusterNodes = NODE_DEFS.filter(function (n) { return n.cluster === c.id; });
      var present = clusterNodes.filter(function (n) { return !!G[n.id]; }).length;
      result[c.id] = {
        id:      c.id,
        label:   c.label,
        total:   clusterNodes.length,
        present: present,
        pct:     clusterNodes.length > 0 ? Math.round((present / clusterNodes.length) * 100) : 0,
      };
    });
    return result;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimeTopology = Object.freeze({
    getGraph:         getGraph,
    getClusters:      getClusters,
    getClusterHealth: getClusterHealth,
    getMetrics:       getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeHeatmaps) return;

  var LOG = '[Arc14:Heatmaps]';

  var LEVEL_GREEN  = 'GREEN';
  var LEVEL_YELLOW = 'YELLOW';
  var LEVEL_ORANGE = 'ORANGE';
  var LEVEL_RED    = 'RED';

  var REFRESH_MS = 15 * 1000;
  var _snapshots = [];   // ring buffer, cap 60
  var MAX_SNAPS  = 60;
  var _metrics   = { refreshes: 0, redEvents: 0 };

  function _level(val, warn, crit, fatal) {
    if (val >= fatal)  return LEVEL_RED;
    if (val >= crit)   return LEVEL_ORANGE;
    if (val >= warn)   return LEVEL_YELLOW;
    return LEVEL_GREEN;
  }

  // ── Collectors ───────────────────────────────────────────────────────────────
  function _collectMemory() {
    try {
      var perf = G.performance;
      if (perf && perf.memory) {
        var mb   = perf.memory.usedJSHeapSize / 1048576;
        var limMb = perf.memory.jsHeapSizeLimit / 1048576;
        var pct  = limMb > 0 ? (mb / limMb) * 100 : 0;
        return { valueMb: Math.round(mb), pct: Math.round(pct),
                 level: _level(pct, 40, 60, 80) };
      }
    } catch (_) {}
    return { valueMb: 0, pct: 0, level: LEVEL_GREEN };
  }

  function _collectWorkers() {
    try {
      var prof = G.RuntimePerformanceProfiler;
      if (prof && prof.getProfile) {
        var p = prof.getProfile();
        var cnt = (p && p.workers && p.workers.active) || 0;
        return { active: cnt, level: _level(cnt, 4, 8, 12) };
      }
    } catch (_) {}
    return { active: 0, level: LEVEL_GREEN };
  }

  function _collectThermal() {
    try {
      var profiler = G.RuntimeToolProfiler;
      if (profiler && profiler.getProfile) {
        var tools = G.RuntimeToolRegistry && G.RuntimeToolRegistry.getAllTools ? G.RuntimeToolRegistry.getAllTools() : [];
        var maxThermal = 0;
        tools.forEach(function (t) {
          var p = profiler.getProfile(t.id);
          if (p && p.thermal && p.thermal.p90) maxThermal = Math.max(maxThermal, p.thermal.p90);
        });
        return { maxScore: Math.round(maxThermal), level: _level(maxThermal, 30, 60, 80) };
      }
    } catch (_) {}
    return { maxScore: 0, level: LEVEL_GREEN };
  }

  function _collectFailures() {
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.getAllTools) {
        var tools  = reg.getAllTools();
        var total  = 0, failures = 0;
        tools.forEach(function (t) {
          total    += (t.successes || 0) + (t.failures || 0);
          failures += (t.failures || 0);
        });
        var pct = total > 0 ? (failures / total) * 100 : 0;
        return { failures: failures, pct: Math.round(pct), level: _level(pct, 5, 15, 30) };
      }
    } catch (_) {}
    return { failures: 0, pct: 0, level: LEVEL_GREEN };
  }

  function _collectIncidents() {
    try {
      var ic = G.RuntimeIncidentCorrelation;
      if (ic && ic.getMetrics) {
        var m = ic.getMetrics();
        var active = m.active || m.raised || 0;
        return { active: active, level: _level(active, 1, 3, 6) };
      }
    } catch (_) {}
    return { active: 0, level: LEVEL_GREEN };
  }

  function _collectSLA() {
    try {
      var sla = G.RuntimeToolSLA;
      if (sla && sla.getViolations) {
        var recent = sla.getViolations().filter(function (v) { return Date.now() - v.ts < 300000; });
        var critical = recent.filter(function (v) { return v.critical; }).length;
        return { violations: recent.length, critical: critical, level: _level(critical, 1, 3, 6) };
      }
    } catch (_) {}
    return { violations: 0, critical: 0, level: LEVEL_GREEN };
  }

  function _collectCircuitBreakers() {
    try {
      var cb = G.RuntimeToolCircuitBreaker;
      if (cb && cb.getAll) {
        var all  = cb.getAll();
        var open = Object.keys(all).filter(function (id) { return all[id].state === 'OPEN'; }).length;
        return { open: open, total: Object.keys(all).length, level: _level(open, 1, 3, 5) };
      }
    } catch (_) {}
    return { open: 0, total: 0, level: LEVEL_GREEN };
  }

  function _collectTools() {
    var cells = [];
    try {
      var reg = G.RuntimeToolRegistry;
      var hlth = G.RuntimeToolHealth;
      if (reg && reg.getAllTools) {
        reg.getAllTools().forEach(function (t) {
          var h = hlth && hlth.getHealth ? hlth.getHealth(t.id) : null;
          var level = h ? (h.level === 'EXCELLENT' ? LEVEL_GREEN : h.level === 'GOOD' ? LEVEL_YELLOW : h.level === 'DEGRADED' ? LEVEL_ORANGE : LEVEL_RED) : LEVEL_GREEN;
          cells.push({ toolId: t.id, score: h ? h.score : 100, level: level });
        });
      }
    } catch (_) {}
    return cells;
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────────
  function refresh() {
    var snap = {
      ts:             Date.now(),
      memory:         _collectMemory(),
      workers:        _collectWorkers(),
      thermal:        _collectThermal(),
      failures:       _collectFailures(),
      incidents:      _collectIncidents(),
      sla:            _collectSLA(),
      circuitBreakers: _collectCircuitBreakers(),
    };
    _snapshots.push(snap);
    if (_snapshots.length > MAX_SNAPS) _snapshots.shift();
    _metrics.refreshes++;
    var hasRed = [snap.memory, snap.workers, snap.thermal, snap.failures, snap.incidents].some(function (s) { return s.level === LEVEL_RED; });
    if (hasRed) _metrics.redEvents++;
    try {
      G.dispatchEvent(new CustomEvent('arc14:heatmap-updated', { detail: { ts: snap.ts } }));
    } catch (_) {}
    return snap;
  }

  function getCurrent() {
    if (!_snapshots.length) return refresh();
    return _snapshots[_snapshots.length - 1];
  }

  function getHistory(limit) {
    var n = Math.min(limit || 20, _snapshots.length);
    return _snapshots.slice(-n);
  }

  function getToolHeatmap() { return _collectTools(); }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-refresh
  setInterval(refresh, REFRESH_MS);
  refresh();

  G.RuntimeHeatmaps = Object.freeze({
    refresh:         refresh,
    getCurrent:      getCurrent,
    getHistory:      getHistory,
    getToolHeatmap:  getToolHeatmap,
    getMetrics:      getMetrics,
    LEVELS: Object.freeze({ GREEN: LEVEL_GREEN, YELLOW: LEVEL_YELLOW, ORANGE: LEVEL_ORANGE, RED: LEVEL_RED }),
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeCommandAnalytics) return;

  var LOG = '[Arc14:CommandAnalytics]';

  var WINDOWS = [
    { id: '5m',  label: '5 min',  ms: 5  * 60 * 1000 },
    { id: '15m', label: '15 min', ms: 15 * 60 * 1000 },
    { id: '1h',  label: '1 hr',   ms: 60 * 60 * 1000 },
    { id: '6h',  label: '6 hr',   ms: 6  * 60 * 60 * 1000 },
    { id: '24h', label: '24 hr',  ms: 24 * 60 * 60 * 1000 },
  ];

  var _samples  = [];
  var MAX_SAMP  = 1000;
  var _metrics  = { samples: 0, trendsComputed: 0 };
  var SAMPLE_MS = 60 * 1000;

  function _sample() {
    var hm   = G.RuntimeHeatmaps;
    var curr = hm && hm.getCurrent ? hm.getCurrent() : null;
    if (!curr) return;
    _samples.push({
      ts:               curr.ts,
      memory_pct:       curr.memory ? curr.memory.pct : 0,
      workers_active:   curr.workers ? curr.workers.active : 0,
      failures_pct:     curr.failures ? curr.failures.pct : 0,
      incidents_active: curr.incidents ? curr.incidents.active : 0,
      sla_violations:   curr.sla ? curr.sla.violations : 0,
      cb_open:          curr.circuitBreakers ? curr.circuitBreakers.open : 0,
    });
    if (_samples.length > MAX_SAMP) _samples.shift();
    _metrics.samples++;
  }

  function _window(windowId) {
    var w    = WINDOWS.find(function (x) { return x.id === windowId; }) || WINDOWS[1];
    var from = Date.now() - w.ms;
    return _samples.filter(function (s) { return s.ts >= from; });
  }

  function _trend(series, key) {
    if (series.length < 2) return 0;
    var n = series.length, sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    var t0 = series[0].ts;
    series.forEach(function (s) {
      var x = (s.ts - t0) / 60000;
      var y = s[key] || 0;
      sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
    });
    var denom = n * sumX2 - sumX * sumX;
    if (!denom) return 0;
    _metrics.trendsComputed++;
    return (n * sumXY - sumX * sumY) / denom;
  }

  function _growth(series, key) {
    if (series.length < 2) return 0;
    var first = series[0][key] || 0;
    var last  = series[series.length - 1][key] || 0;
    return first > 0 ? Math.round(((last - first) / first) * 100) : 0;
  }

  function _avg(series, key) {
    if (!series.length) return 0;
    return series.reduce(function (sum, s) { return sum + (s[key] || 0); }, 0) / series.length;
  }

  function getTrends(windowId) {
    var series = _window(windowId || '15m');
    return {
      windowId:      windowId || '15m',
      sampleCount:   series.length,
      memory:        { trend: _trend(series, 'memory_pct'),       avg: _avg(series, 'memory_pct'),       growth: _growth(series, 'memory_pct') },
      workers:       { trend: _trend(series, 'workers_active'),   avg: _avg(series, 'workers_active'),   growth: _growth(series, 'workers_active') },
      failures:      { trend: _trend(series, 'failures_pct'),     avg: _avg(series, 'failures_pct'),     growth: _growth(series, 'failures_pct') },
      incidents:     { trend: _trend(series, 'incidents_active'), avg: _avg(series, 'incidents_active'), growth: _growth(series, 'incidents_active') },
      slaViolations: { trend: _trend(series, 'sla_violations'),   avg: _avg(series, 'sla_violations'),   growth: _growth(series, 'sla_violations') },
      cbOpen:        { trend: _trend(series, 'cb_open'),          avg: _avg(series, 'cb_open'),          growth: _growth(series, 'cb_open') },
    };
  }

  function getGrowthRates(windowId) {
    var t = getTrends(windowId || '1h');
    return { memory: t.memory.growth, workers: t.workers.growth, failures: t.failures.growth,
             incidents: t.incidents.growth, slaViolations: t.slaViolations.growth };
  }

  function getSamples(windowId, limit) {
    var series = _window(windowId || '15m');
    if (limit) series = series.slice(-limit);
    return series;
  }

  function getToolUsageTrend() {
    var reg  = G.RuntimeToolRegistry;
    var rank = G.RuntimeToolRanking;
    if (!reg || !reg.getAllTools) return [];
    return reg.getAllTools().map(function (t) {
      var r = rank && rank.getScore ? rank.getScore(t.id) : null;
      return { toolId: t.id, launches: t.launches || 0,
               successRate: (t.successes + t.failures) > 0 ? Math.round((t.successes / (t.successes + t.failures)) * 100) : null,
               score: r ? r.score : null, rank: r ? r.rank : null };
    }).sort(function (a, b) { return b.launches - a.launches; });
  }

  function getWindows() { return WINDOWS.slice(); }
  function getMetrics() { return Object.assign({}, _metrics); }

  setInterval(_sample, SAMPLE_MS);
  G.addEventListener('arc14:heatmap-updated', function () { _sample(); });

  G.RuntimeCommandAnalytics = Object.freeze({
    getTrends:         getTrends,
    getGrowthRates:    getGrowthRates,
    getSamples:        getSamples,
    getToolUsageTrend: getToolUsageTrend,
    getWindows:        getWindows,
    getMetrics:        getMetrics,
    WINDOWS:           WINDOWS.slice(),
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeAlerts) return;

  var LOG = '[Arc14:Alerts]';

  var LVL_INFO = 'INFO';
  var LVL_WARN = 'WARN';
  var LVL_P2   = 'P2';
  var LVL_P1   = 'P1';
  var LVL_P0   = 'P0';

  var _alerts  = [];
  var _seq     = 0;
  var MAX_ALTS = 300;
  var _metrics = { raised: 0, acknowledged: 0, byLevel: { INFO:0, WARN:0, P2:0, P1:0, P0:0 } };
  var DEDUP_MS = 60 * 1000;   // suppress duplicate alert from same source within 60s

  var _lastBySource = {};   // sourceKey → ts

  function _dedup(sourceKey) {
    var last = _lastBySource[sourceKey] || 0;
    if (Date.now() - last < DEDUP_MS) return true;
    _lastBySource[sourceKey] = Date.now();
    return false;
  }

  function raise(opts) {
    opts = opts || {};
    var level  = opts.level  || LVL_INFO;
    var source = opts.source || 'unknown';
    var msg    = opts.message || '';
    var toolId = opts.toolId || null;

    var key = source + ':' + (toolId || '') + ':' + msg.slice(0, 40);
    if (_dedup(key)) return null;

    var alert = {
      id:           'alt-' + (++_seq),
      level:        level,
      source:       source,
      message:      msg,
      toolId:       toolId,
      ts:           Date.now(),
      acknowledged: false,
    };
    _alerts.unshift(alert);
    if (_alerts.length > MAX_ALTS) _alerts.pop();
    _metrics.raised++;
    if (_metrics.byLevel[level] != null) _metrics.byLevel[level]++;

    try {
      G.dispatchEvent(new CustomEvent('arc14:alert-raised', { detail: alert }));
    } catch (_) {}

    if (level === LVL_P0 || level === LVL_P1) {
      console.warn(LOG, '[' + level + ']', source, '—', msg);
    }
    return alert;
  }

  function acknowledge(alertId) {
    var a = _alerts.find(function (x) { return x.id === alertId; });
    if (a && !a.acknowledged) { a.acknowledged = true; _metrics.acknowledged++; }
  }

  function acknowledgeAll() {
    _alerts.forEach(function (a) { if (!a.acknowledged) { a.acknowledged = true; _metrics.acknowledged++; } });
  }

  function getAlerts(opts) {
    opts = opts || {};
    var result = _alerts.slice();
    if (opts.level)        result = result.filter(function (a) { return a.level === opts.level; });
    if (opts.source)       result = result.filter(function (a) { return a.source === opts.source; });
    if (opts.unacknowledged) result = result.filter(function (a) { return !a.acknowledged; });
    if (opts.toolId)       result = result.filter(function (a) { return a.toolId === opts.toolId; });
    if (opts.limit)        result = result.slice(0, opts.limit);
    return result;
  }

  function getMetrics() { return JSON.parse(JSON.stringify(_metrics)); }

  // ── Arc 13 listeners → raise alerts ─────────────────────────────────────────
  G.addEventListener('arc13:circuit-opened', function (e) {
    var d = e && e.detail;
    if (!d) return;
    raise({ level: LVL_P1, source: 'circuit-breaker', toolId: d.toolId,
      message: 'Circuit breaker OPEN: ' + d.toolId + ' — ' + (d.reason || '') });
  });

  G.addEventListener('arc13:sla-violated', function (e) {
    var d = e && e.detail;
    if (!d) return;
    raise({ level: d.critical ? LVL_P1 : LVL_P2, source: 'sla', toolId: d.toolId,
      message: d.toolId + ' SLA violated: ' + d.metric + ' p' + d.percentile + ' = ' + (d.actual || 0).toFixed(0) });
  });

  G.addEventListener('arc13:anomaly-detected', function (e) {
    var d = e && e.detail;
    if (!d) return;
    raise({ level: d.severity === 'P1' ? LVL_P1 : LVL_P2, source: 'anomaly', toolId: d.toolId,
      message: d.toolId + ' ' + d.type + ' anomaly: ' + (d.actual || 0).toFixed(0) + ' (baseline ' + (d.baseline || 0).toFixed(0) + ')' });
  });

  G.addEventListener('arc12:health-refreshed', function (e) {
    var scores = e && e.detail && e.detail.scores;
    if (!scores) return;
    Object.keys(scores).forEach(function (id) {
      if (scores[id].level === 'CRITICAL') {
        raise({ level: LVL_P1, source: 'tool-health', toolId: id, message: id + ' health is CRITICAL' });
      }
    });
  });

  G.addEventListener('arc14:heatmap-updated', function () {
    var hm = G.RuntimeHeatmaps;
    if (!hm) return;
    var curr = hm.getCurrent();
    if (!curr) return;
    if (curr.memory && curr.memory.level === 'RED')
      raise({ level: LVL_P2, source: 'heatmap', message: 'Memory pressure RED: ' + curr.memory.pct + '% of heap limit' });
    if (curr.incidents && curr.incidents.level === 'RED')
      raise({ level: LVL_P1, source: 'heatmap', message: 'High incident count: ' + curr.incidents.active + ' active incidents' });
    if (curr.circuitBreakers && curr.circuitBreakers.open > 0)
      raise({ level: LVL_P2, source: 'circuit-breaker', message: curr.circuitBreakers.open + ' circuit breaker(s) OPEN' });
  });

  G.RuntimeAlerts = Object.freeze({
    raise:         raise,
    acknowledge:   acknowledge,
    acknowledgeAll: acknowledgeAll,
    getAlerts:     getAlerts,
    getMetrics:    getMetrics,
    LEVELS: Object.freeze({ INFO:LVL_INFO, WARN:LVL_WARN, P2:LVL_P2, P1:LVL_P1, P0:LVL_P0 }),
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeFleetManager) return;

  var LOG = '[Arc14:FleetManager]';

  // Known controllable subsystem IDs (maps to RuntimeCommandCenter subsystem ids)
  var _state   = {};   // subsystemId → { paused, isolated, lastAction, lastActionTs }
  var _metrics = { paused: 0, resumed: 0, restarted: 0, isolated: 0, quarantined: 0 };

  function _entry(id) {
    if (!_state[id]) _state[id] = { paused: false, isolated: false, lastAction: null, lastActionTs: 0 };
    return _state[id];
  }

  function _log(id, action, detail) {
    var s = _entry(id);
    s.lastAction   = action;
    s.lastActionTs = Date.now();
    console.debug(LOG, action + ':', id, detail || '');
    try {
      G.dispatchEvent(new CustomEvent('arc14:fleet-action', {
        detail: { subsystem: id, action: action, detail: detail, ts: s.lastActionTs },
      }));
    } catch (_) {}
  }

  // ── Pause ────────────────────────────────────────────────────────────────────
  function pause(subsystemId, reason) {
    var s = _entry(subsystemId);
    if (s.paused) return { ok: false, reason: 'already paused' };
    s.paused = true;
    _metrics.paused++;
    _log(subsystemId, 'pause', reason || '');
    // If it's a circuit-breaker target, open the breaker
    var cb = G.RuntimeToolCircuitBreaker;
    if (cb && cb.recordFailure) {
      try { cb.recordFailure(subsystemId, { crash: false }); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Resume ───────────────────────────────────────────────────────────────────
  function resume(subsystemId) {
    var s = _entry(subsystemId);
    s.paused = false;
    _metrics.resumed++;
    _log(subsystemId, 'resume');
    return { ok: true };
  }

  // ── Restart ──────────────────────────────────────────────────────────────────
  function restart(subsystemId) {
    var s = _entry(subsystemId);
    s.paused   = false;
    s.isolated = false;
    _metrics.restarted++;
    _log(subsystemId, 'restart');
    // For tool isolation: attempt restore
    var iso = G.RuntimeToolIsolation;
    if (iso && iso.restoreTool) {
      try { iso.restoreTool(subsystemId); } catch (_) {}
    }
    // For circuit-breaker: can't force-close, but record a success probe
    var cb = G.RuntimeToolCircuitBreaker;
    if (cb && cb.recordSuccess) {
      try { cb.recordSuccess(subsystemId); cb.recordSuccess(subsystemId); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Isolate ──────────────────────────────────────────────────────────────────
  function isolate(subsystemId, reason) {
    var s = _entry(subsystemId);
    s.isolated = true;
    _metrics.isolated++;
    _log(subsystemId, 'isolate', reason || '');
    var iso = G.RuntimeToolIsolation;
    if (iso && iso.isolateTool) {
      try { iso.isolateTool(subsystemId, reason || 'arc14:fleet-isolate'); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Quarantine ───────────────────────────────────────────────────────────────
  function quarantine(subsystemId, reason) {
    var s = _entry(subsystemId);
    s.paused   = true;
    s.isolated = true;
    _metrics.quarantined++;
    _log(subsystemId, 'quarantine', reason || '');
    var gov = G.RuntimeGovernance;
    if (gov && gov.quarantine) {
      try { gov.quarantine(subsystemId, reason || 'arc14:fleet-quarantine'); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Status ───────────────────────────────────────────────────────────────────
  function getStatus(subsystemId) {
    var s = _entry(subsystemId);
    var glob = subsystemId.split('-').map(function (p, i) {
      return i === 0 ? 'Runtime' + p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1);
    }).join('');
    return {
      subsystem:   subsystemId,
      paused:      s.paused,
      isolated:    s.isolated,
      present:     !!G[glob],
      lastAction:  s.lastAction,
      lastActionTs: s.lastActionTs,
    };
  }

  function getFleetStatus() {
    var cc  = G.RuntimeCommandCenter;
    var subs = cc && cc.getSubsystems ? cc.getSubsystems() : [];
    return subs.map(function (sub) {
      var s = _entry(sub.id);
      return Object.assign({}, sub, {
        paused:      s.paused,
        isolated:    s.isolated,
        lastAction:  s.lastAction,
        lastActionTs: s.lastActionTs,
      });
    });
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimeFleetManager = Object.freeze({
    pause:          pause,
    resume:         resume,
    restart:        restart,
    isolate:        isolate,
    quarantine:     quarantine,
    getStatus:      getStatus,
    getFleetStatus: getFleetStatus,
    getMetrics:     getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeForecast) return;

  var LOG = '[Arc14:Forecast]';

  var HORIZON_MS = 30 * 60 * 1000;   // 30-minute forecast horizon
  var _forecasts = [];
  var _metrics   = { generated: 0, accurate: 0 };
  var MAX_F      = 50;
  var GEN_MS     = 5 * 60 * 1000;   // generate every 5 min

  function _id() { return 'fcast-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }

  function _add(type, message, confidence, horizon, severity) {
    var f = {
      id:         _id(),
      type:       type,
      message:    message,
      confidence: confidence,   // 0–100
      horizonMs:  horizon || HORIZON_MS,
      expectedAt: Date.now() + (horizon || HORIZON_MS),
      severity:   severity || 'info',
      ts:         Date.now(),
    };
    _forecasts.unshift(f);
    if (_forecasts.length > MAX_F) _forecasts.pop();
    _metrics.generated++;
    try {
      G.dispatchEvent(new CustomEvent('arc14:forecast-generated', { detail: f }));
    } catch (_) {}
    return f;
  }

  // ── Forecast generators ──────────────────────────────────────────────────────

  function _forecastIncidents() {
    var analy = G.RuntimeCommandAnalytics;
    if (!analy) return;
    var t = analy.getTrends('15m');
    if (!t || !t.incidents) return;
    var slope = t.incidents.trend;  // per minute
    var avg   = t.incidents.avg;
    if (slope > 0.1 && avg > 0) {
      var est = avg + slope * 30;  // +30 min
      var conf = Math.min(85, Math.round(slope * 100));
      _add('incidents', 'Incident count trending up (' + slope.toFixed(2) + '/min) — expect ~' + est.toFixed(0) + ' incidents in 30 min.', conf, HORIZON_MS, 'warning');
    }
  }

  function _forecastMemoryPressure() {
    var analy = G.RuntimeCommandAnalytics;
    if (!analy) return;
    var t = analy.getTrends('15m');
    if (!t || !t.memory) return;
    var slope = t.memory.trend;
    var avg   = t.memory.avg;
    if (slope > 0.5 && avg > 30) {
      var timeToWarn = (60 - avg) / slope;  // minutes to reach 60% threshold
      if (timeToWarn < 60 && timeToWarn > 0) {
        _add('memory', 'Memory at ' + avg.toFixed(0) + '% with slope ' + slope.toFixed(2) + '%/min — may reach warning level in ~' + timeToWarn.toFixed(0) + ' min.', 70, timeToWarn * 60000, 'warning');
      }
    }
  }

  function _forecastThermalSpikes() {
    var hm = G.RuntimeHeatmaps;
    if (!hm) return;
    var curr = hm.getCurrent();
    if (!curr || !curr.thermal) return;
    if (curr.thermal.level === 'ORANGE') {
      _add('thermal', 'Thermal score in ORANGE (' + curr.thermal.maxScore + '). Sustained heavy workloads may cause RED spike soon.', 60, HORIZON_MS, 'warning');
    }
  }

  function _forecastSLABreaches() {
    var analy = G.RuntimeCommandAnalytics;
    if (!analy) return;
    var t = analy.getTrends('1h');
    if (!t || !t.slaViolations) return;
    if (t.slaViolations.trend > 0.05) {
      _add('sla', 'SLA violations trending up — current average: ' + t.slaViolations.avg.toFixed(1) + '/sample. Monitor critical tool performance.', 65, HORIZON_MS, 'warning');
    }
  }

  function _forecastCircuitOpenings() {
    var cb  = G.RuntimeToolCircuitBreaker;
    var reg = G.RuntimeToolRegistry;
    if (!cb || !reg) return;
    var all   = cb.getAll();
    var tools = reg.getAllTools ? reg.getAllTools() : [];
    var risk  = tools.filter(function (t) {
      var b = all[t.id];
      if (!b) return false;
      var total = (t.successes || 0) + (t.failures || 0);
      var rate  = total > 5 ? (t.failures / total) : 0;
      return rate > 0.10 && b.state === 'CLOSED';
    });
    if (risk.length > 0) {
      _add('circuit-breaker', risk.length + ' tool(s) have >10% failure rate and CLOSED breakers (' + risk.map(function (t) { return t.id; }).slice(0, 3).join(', ') + ') — may trip soon.', 75, HORIZON_MS, 'critical');
    }
  }

  function _forecastToolDegradation() {
    var ins = G.RuntimeToolInsights;
    if (!ins) return;
    var critical = ins.getInsights({ severity: 'critical' });
    if (critical.length > 3) {
      _add('tool-degradation', critical.length + ' critical tool insights active — system degradation likely if unaddressed.', 80, HORIZON_MS, 'critical');
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function generateForecasts() {
    _forecastIncidents();
    _forecastMemoryPressure();
    _forecastThermalSpikes();
    _forecastSLABreaches();
    _forecastCircuitOpenings();
    _forecastToolDegradation();
  }

  function getForecasts(opts) {
    opts = opts || {};
    var result = _forecasts.slice();
    if (opts.type)     result = result.filter(function (f) { return f.type === opts.type; });
    if (opts.severity) result = result.filter(function (f) { return f.severity === opts.severity; });
    if (opts.limit)    result = result.slice(0, opts.limit);
    return result;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-generate
  setTimeout(function _tick() {
    generateForecasts();
    setTimeout(_tick, GEN_MS);
  }, GEN_MS);

  G.RuntimeForecast = Object.freeze({
    generateForecasts: generateForecasts,
    getForecasts:      getForecasts,
    getMetrics:        getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeReports) return;

  var LOG = '[Arc14:Reports]';

  var _generated = [];   // report index (id, type, ts)
  var _seq       = 0;
  var MAX_REP    = 20;
  var _metrics   = { generated: 0 };

  function _ts() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

  function _id(type) { return 'rep-' + type + '-' + (++_seq); }

  function _register(type) {
    var entry = { id: _id(type), type: type, ts: Date.now() };
    _generated.unshift(entry);
    if (_generated.length > MAX_REP) _generated.pop();
    _metrics.generated++;
    return entry.id;
  }

  // ── Section builders ─────────────────────────────────────────────────────────
  function _sysHealth() {
    var cc = G.RuntimeCommandCenter;
    return cc && cc.getSystemHealth ? cc.getSystemHealth() : null;
  }

  function _incidentSection() {
    var ic = G.RuntimeIncidentCorrelation;
    return ic && ic.getMetrics ? ic.getMetrics() : null;
  }

  function _toolSection() {
    var reg  = G.RuntimeToolRegistry;
    var rank = G.RuntimeToolRanking;
    if (!reg || !reg.getAllTools) return null;
    var tools = reg.getAllTools();
    var top5  = rank && rank.getTopN ? rank.getTopN(5) : [];
    var total = tools.length;
    var active = tools.filter(function (t) { return t.launches > 0; }).length;
    return { total: total, active: active, top5: top5 };
  }

  function _slaSection() {
    var sla = G.RuntimeToolSLA;
    if (!sla) return null;
    var viols    = sla.getViolations();
    var critical = viols.filter(function (v) { return v.critical; }).length;
    return { totalViolations: viols.length, critical: critical, metrics: sla.getMetrics() };
  }

  function _cbSection() {
    var cb = G.RuntimeToolCircuitBreaker;
    if (!cb) return null;
    var all  = cb.getAll();
    var open = Object.keys(all).filter(function (id) { return all[id].state === 'OPEN'; });
    var ho   = Object.keys(all).filter(function (id) { return all[id].state === 'HALF_OPEN'; });
    return { open: open.length, halfOpen: ho.length, total: Object.keys(all).length, metrics: cb.getMetrics() };
  }

  function _anomalySection() {
    var anm = G.RuntimeToolAnomaly;
    if (!anm) return null;
    var all = anm.getAnomalies();
    return { total: all.length, critical: all.filter(function (a) { return a.severity === 'P1'; }).length, metrics: anm.getMetrics() };
  }

  function _insightSection() {
    var ins = G.RuntimeToolInsights;
    if (!ins) return null;
    return { items: ins.getInsights({ limit: 20 }), metrics: ins.getMetrics() };
  }

  function _recoverySection() {
    var rm = G.RuntimeRecoveryMemory;
    if (!rm || !rm.getMetrics) return null;
    return rm.getMetrics();
  }

  function _analyticsSection(windowId) {
    var analy = G.RuntimeCommandAnalytics;
    return analy && analy.getTrends ? analy.getTrends(windowId || '1h') : null;
  }

  function _heatmapSection() {
    var hm = G.RuntimeHeatmaps;
    return hm && hm.getCurrent ? hm.getCurrent() : null;
  }

  // ── Report generators ────────────────────────────────────────────────────────
  function generateHealthReport() {
    _register('health');
    return {
      type: 'health', generatedAt: new Date().toISOString(),
      systemHealth:   _sysHealth(),
      heatmap:        _heatmapSection(),
      tools:          _toolSection(),
      incidents:      _incidentSection(),
      recovery:       _recoverySection(),
    };
  }

  function generateIncidentReport() {
    _register('incidents');
    return {
      type: 'incidents', generatedAt: new Date().toISOString(),
      incidents:   _incidentSection(),
      anomalies:   _anomalySection(),
      circuitBreakers: _cbSection(),
      alerts: G.RuntimeAlerts ? G.RuntimeAlerts.getMetrics() : null,
    };
  }

  function generateSLAReport() {
    _register('sla');
    return {
      type: 'sla', generatedAt: new Date().toISOString(),
      sla:            _slaSection(),
      tools:          _toolSection(),
      analytics:      _analyticsSection('6h'),
    };
  }

  function generateToolReport() {
    _register('tools');
    var lc   = G.RuntimeToolLifecycle;
    var disc = G.RuntimeToolDiscovery;
    return {
      type: 'tools', generatedAt: new Date().toISOString(),
      tools:       _toolSection(),
      lifecycle:   lc && lc.getAllStates ? lc.getAllStates() : null,
      discovery:   disc ? { sequences: disc.getSequences().length, discovered: disc.getDiscovered().length } : null,
      insights:    _insightSection(),
    };
  }

  function generateRecoveryReport() {
    _register('recovery');
    return {
      type: 'recovery', generatedAt: new Date().toISOString(),
      recovery:    _recoverySection(),
      circuitBreakers: _cbSection(),
      insights:    _insightSection(),
    };
  }

  function generateDailyReport() {
    _register('daily');
    return {
      type: 'daily', generatedAt: new Date().toISOString(),
      systemHealth:    _sysHealth(),
      heatmap:         _heatmapSection(),
      tools:           _toolSection(),
      sla:             _slaSection(),
      incidents:       _incidentSection(),
      anomalies:       _anomalySection(),
      circuitBreakers: _cbSection(),
      insights:        _insightSection(),
      recovery:        _recoverySection(),
      analytics:       _analyticsSection('24h'),
    };
  }

  function generateWeeklyReport() {
    _register('weekly');
    return Object.assign(generateDailyReport(), {
      type: 'weekly',
      forecasts: G.RuntimeForecast ? G.RuntimeForecast.getForecasts() : [],
    });
  }

  // ── Export helpers ───────────────────────────────────────────────────────────
  function exportJSON(report) {
    try {
      var json = JSON.stringify(report, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href     = url;
      a.download = 'arc14-report-' + (report.type || 'unknown') + '-' + _ts() + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { console.warn(LOG, 'export error:', e.message); }
  }

  function getHistory() { return _generated.slice(); }
  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimeReports = Object.freeze({
    generateHealthReport:   generateHealthReport,
    generateIncidentReport: generateIncidentReport,
    generateSLAReport:      generateSLAReport,
    generateToolReport:     generateToolReport,
    generateRecoveryReport: generateRecoveryReport,
    generateDailyReport:    generateDailyReport,
    generateWeeklyReport:   generateWeeklyReport,
    exportJSON:             exportJSON,
    getHistory:             getHistory,
    getMetrics:             getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.RuntimeCommandExport) return;

  var LOG = '[Arc14:CommandExport]';

  function _ts() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  }

  function _download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { console.warn(LOG, 'download failed:', e.message); }
  }

  function _csvRow(cells) {
    return cells.map(function (c) {
      var s = String(c == null ? '' : c);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }

  // ── Topology export ──────────────────────────────────────────────────────────
  function exportTopology() {
    var topo = G.RuntimeTopology;
    if (!topo) { console.warn(LOG, 'RuntimeTopology not loaded'); return ''; }
    var graph = topo.getGraph();
    var json  = JSON.stringify({ arc: 14, type: 'topology', exportedAt: new Date().toISOString(), graph: graph }, null, 2);
    _download('arc14-topology-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Heatmap export ───────────────────────────────────────────────────────────
  function exportHeatmaps(limit) {
    var hm = G.RuntimeHeatmaps;
    if (!hm) { console.warn(LOG, 'RuntimeHeatmaps not loaded'); return ''; }
    var history = hm.getHistory(limit || 20);
    var json = JSON.stringify({ arc: 14, type: 'heatmaps', exportedAt: new Date().toISOString(), snapshots: history }, null, 2);
    _download('arc14-heatmaps-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Heatmap CSV ──────────────────────────────────────────────────────────────
  function exportHeatmapsCSV(limit) {
    var hm = G.RuntimeHeatmaps;
    if (!hm) return '';
    var history = hm.getHistory(limit || 20);
    var header  = _csvRow(['ts', 'memory_pct', 'memory_level', 'workers_active', 'thermal_score', 'thermal_level', 'failures_pct', 'incidents_active', 'sla_violations', 'cb_open']);
    var rows = history.map(function (s) {
      return _csvRow([
        new Date(s.ts).toISOString(),
        s.memory ? s.memory.pct : '',
        s.memory ? s.memory.level : '',
        s.workers ? s.workers.active : '',
        s.thermal ? s.thermal.maxScore : '',
        s.thermal ? s.thermal.level : '',
        s.failures ? s.failures.pct : '',
        s.incidents ? s.incidents.active : '',
        s.sla ? s.sla.violations : '',
        s.circuitBreakers ? s.circuitBreakers.open : '',
      ]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc14-heatmaps-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Alerts export ────────────────────────────────────────────────────────────
  function exportAlerts() {
    var alt = G.RuntimeAlerts;
    if (!alt) { console.warn(LOG, 'RuntimeAlerts not loaded'); return ''; }
    var alerts = alt.getAlerts();
    var json   = JSON.stringify({ arc: 14, type: 'alerts', exportedAt: new Date().toISOString(), alerts: alerts, metrics: alt.getMetrics() }, null, 2);
    _download('arc14-alerts-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  function exportAlertsCSV() {
    var alt = G.RuntimeAlerts;
    if (!alt) return '';
    var alerts = alt.getAlerts();
    var header = _csvRow(['id', 'level', 'source', 'toolId', 'message', 'acknowledged', 'ts']);
    var rows   = alerts.map(function (a) {
      return _csvRow([a.id, a.level, a.source, a.toolId || '', a.message, a.acknowledged, new Date(a.ts).toISOString()]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc14-alerts-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Reports export ───────────────────────────────────────────────────────────
  function exportDailyReport() {
    var rep  = G.RuntimeReports;
    if (!rep) { console.warn(LOG, 'RuntimeReports not loaded'); return ''; }
    var report = rep.generateDailyReport();
    var json   = JSON.stringify(report, null, 2);
    _download('arc14-daily-report-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  function exportWeeklyReport() {
    var rep = G.RuntimeReports;
    if (!rep) return '';
    var json = JSON.stringify(rep.generateWeeklyReport(), null, 2);
    _download('arc14-weekly-report-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Forecasts export ─────────────────────────────────────────────────────────
  function exportForecasts() {
    var fc  = G.RuntimeForecast;
    if (!fc) { console.warn(LOG, 'RuntimeForecast not loaded'); return ''; }
    var json = JSON.stringify({ arc: 14, type: 'forecasts', exportedAt: new Date().toISOString(),
      forecasts: fc.getForecasts(), metrics: fc.getMetrics() }, null, 2);
    _download('arc14-forecasts-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Fleet state export ───────────────────────────────────────────────────────
  function exportFleetState() {
    var fm  = G.RuntimeFleetManager;
    var cc  = G.RuntimeCommandCenter;
    if (!fm) { console.warn(LOG, 'RuntimeFleetManager not loaded'); return ''; }
    var json = JSON.stringify({
      arc: 14, type: 'fleet-state', exportedAt: new Date().toISOString(),
      fleet:       fm.getFleetStatus(),
      systemHealth: cc && cc.getSystemHealth ? cc.getSystemHealth() : null,
      metrics:     fm.getMetrics(),
    }, null, 2);
    _download('arc14-fleet-state-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  // ── Full system snapshot ─────────────────────────────────────────────────────
  function exportFullSnapshot() {
    var cc   = G.RuntimeCommandCenter;
    var topo = G.RuntimeTopology;
    var hm   = G.RuntimeHeatmaps;
    var alt  = G.RuntimeAlerts;
    var fc   = G.RuntimeForecast;
    var rep  = G.RuntimeReports;
    var fm   = G.RuntimeFleetManager;
    var payload = {
      arc: 14, type: 'full-snapshot', exportedAt: new Date().toISOString(),
      systemHealth:  cc  && cc.getSystemHealth   ? cc.getSystemHealth()    : null,
      topology:      topo && topo.getGraph        ? topo.getGraph()         : null,
      clusterHealth: topo && topo.getClusterHealth ? topo.getClusterHealth() : null,
      heatmapCurrent: hm && hm.getCurrent        ? hm.getCurrent()         : null,
      alerts:        alt  && alt.getAlerts        ? alt.getAlerts({ limit: 50 }) : null,
      forecasts:     fc   && fc.getForecasts      ? fc.getForecasts()       : null,
      fleetState:    fm   && fm.getFleetStatus    ? fm.getFleetStatus()     : null,
      dailyReport:   rep  && rep.generateDailyReport ? rep.generateDailyReport() : null,
    };
    var json = JSON.stringify(payload, null, 2);
    _download('arc14-full-snapshot-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  G.RuntimeCommandExport = Object.freeze({
    exportTopology:    exportTopology,
    exportHeatmaps:    exportHeatmaps,
    exportHeatmapsCSV: exportHeatmapsCSV,
    exportAlerts:      exportAlerts,
    exportAlertsCSV:   exportAlertsCSV,
    exportDailyReport: exportDailyReport,
    exportWeeklyReport: exportWeeklyReport,
    exportForecasts:   exportForecasts,
    exportFleetState:  exportFleetState,
    exportFullSnapshot: exportFullSnapshot,
  });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.PanelCommandCenter) return;

  var _el = null;

  function render(container) {
    _el = container;
    refresh();
  }

  function refresh() {
    if (!_el) return;
    var cc  = G.RuntimeCommandCenter;
    var alt = G.RuntimeAlerts;
    var fc  = G.RuntimeForecast;
    if (!cc) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeCommandCenter not loaded</p>'; return; }

    var health = cc.getSystemHealth();
    var subs   = cc.getSubsystems();
    var metrics= cc.getMetrics();

    var scoreColor = health.score >= 90 ? '#2ecc71' : health.score >= 70 ? '#f39c12' : '#e74c3c';
    var unacked    = alt && alt.getAlerts ? alt.getAlerts({ unacknowledged: true }).length : 0;
    var forecasts  = fc  && fc.getForecasts ? fc.getForecasts({ severity: 'critical' }).length : 0;

    var arcGroups = {};
    subs.forEach(function (s) {
      var k = 'arc' + s.arc;
      if (!arcGroups[k]) arcGroups[k] = [];
      arcGroups[k].push(s);
    });

    var groupHtml = Object.keys(arcGroups).sort().map(function (k) {
      var list = arcGroups[k].map(function (s) {
        var dot = s.present ? (s.healthy ? '🟢' : '🟡') : '🔴';
        return '<tr><td style="padding:2px 6px">' + dot + '</td><td style="padding:2px 8px">' + s.label + '</td>' +
          '<td style="padding:2px 6px;color:#aaa;font-size:11px">' + s.global + '</td></tr>';
      }).join('');
      return '<details style="margin:4px 0"><summary style="cursor:pointer;font-weight:bold">' + k.toUpperCase() +
        ' (' + arcGroups[k].filter(function (s) { return s.present; }).length + '/' + arcGroups[k].length + ')</summary>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' + list + '</table></details>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Health Score', health.score + '%', scoreColor) +
        _kpi('Level', health.level, scoreColor) +
        _kpi('Subsystems', health.present + '/' + health.total, '#3498db') +
        _kpi('Commands Run', metrics.commands, '#9b59b6') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Unacked Alerts', unacked, unacked > 0 ? '#e74c3c' : '#2ecc71') +
        _kpi('Critical Forecasts', forecasts, forecasts > 0 ? '#e74c3c' : '#2ecc71') +
        _kpi('Command Errors', metrics.errors, metrics.errors > 0 ? '#e74c3c' : '#2ecc71') +
      '</div>' +
      '<div>' + groupHtml + '</div>' +
      '<div style="margin-top:8px">' +
        '<button onclick="G&&G.RuntimeCommandCenter&&G.RuntimeCommandCenter.executeCommand(\'refresh-health\')" style="margin-right:6px;padding:4px 10px;cursor:pointer">🔄 Refresh</button>' +
        '<button onclick="G&&G.RuntimeCommandCenter&&G.RuntimeCommandCenter.executeCommand(\'generate-insights\')" style="margin-right:6px;padding:4px 10px;cursor:pointer">💡 Insights</button>' +
        '<button onclick="G&&G.RuntimeCommandCenter&&G.RuntimeCommandCenter.executeCommand(\'check-sla\')" style="padding:4px 10px;cursor:pointer">📏 Check SLA</button>' +
      '</div>' +
      '</div>';
  }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:8px;text-align:center">' +
      '<div style="font-size:11px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:20px;font-weight:bold;color:' + color + '">' + value + '</div></div>';
  }

  G.PanelCommandCenter = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.PanelTopology) return;

  var _el = null;

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var topo = G.RuntimeTopology;
    if (!topo) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeTopology not loaded</p>'; return; }

    var graph  = topo.getGraph();
    var health = topo.getClusterHealth();
    var nodes  = graph.nodes;
    var edges  = graph.edges;

    var clusterHtml = graph.clusters.map(function (c) {
      var h = health[c.id] || {};
      var pct = h.pct || 0;
      var bar = '<div style="height:6px;background:#333;border-radius:3px;margin-top:4px">' +
        '<div style="height:100%;width:' + pct + '%;background:' + c.color + ';border-radius:3px"></div></div>';
      return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:8px;margin:4px 0">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px">' +
          '<span style="color:' + c.color + ';font-weight:bold">' + c.label + '</span>' +
          '<span style="color:#aaa">' + (h.present || 0) + '/' + (h.total || 0) + ' loaded</span>' +
        '</div>' + bar + '</div>';
    }).join('');

    var activeEdges = edges.filter(function (e) { return e.active; }).length;
    var nodesByCluster = {};
    nodes.forEach(function (n) {
      if (!nodesByCluster[n.cluster]) nodesByCluster[n.cluster] = [];
      nodesByCluster[n.cluster].push(n);
    });

    var nodeTable = '<table style="width:100%;border-collapse:collapse;font-size:11px">' +
      '<tr style="color:#aaa"><th style="text-align:left;padding:2px 4px">Node</th>' +
      '<th style="padding:2px 4px">Arc</th><th style="padding:2px 4px">Status</th></tr>' +
      nodes.map(function (n) {
        var dot = n.present ? '🟢' : '⚫';
        return '<tr><td style="padding:2px 4px">' + dot + ' ' + n.label + '</td>' +
          '<td style="padding:2px 4px;text-align:center;color:#aaa">' + n.cluster + '</td>' +
          '<td style="padding:2px 4px;text-align:center;font-size:10px;color:' + (n.present ? '#2ecc71' : '#666') + '">' +
          (n.present ? 'loaded' : 'absent') + '</td></tr>';
      }).join('') + '</table>';

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px">' +
        _kpi('Total Nodes', nodes.length, '#3498db') +
        _kpi('Active Edges', activeEdges + '/' + edges.length, '#2ecc71') +
        _kpi('Clusters', graph.clusters.length, '#9b59b6') +
      '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin-bottom:6px">Cluster Health</summary>' + clusterHtml + '</details>' +
      '<details><summary style="cursor:pointer;font-weight:bold;margin:6px 0">All Nodes (' + nodes.length + ')</summary>' + nodeTable + '</details>' +
      '</div>';
  }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:8px;text-align:center">' +
      '<div style="font-size:11px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:20px;font-weight:bold;color:' + color + '">' + value + '</div></div>';
  }

  G.PanelTopology = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.PanelHeatmaps) return;

  var _el = null;

  var LEVEL_COLORS = { GREEN: '#2ecc71', YELLOW: '#f1c40f', ORANGE: '#e67e22', RED: '#e74c3c' };
  var LEVEL_BG     = { GREEN: '#1a3a2a', YELLOW: '#3a3010', ORANGE: '#3a2010', RED: '#3a1020' };

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var hm = G.RuntimeHeatmaps;
    if (!hm) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeHeatmaps not loaded</p>'; return; }

    var curr  = hm.getCurrent();
    var tools = hm.getToolHeatmap();

    function cell(label, data, subLabel) {
      var d = data || { level: 'GREEN', pct: null, active: null, maxScore: null };
      var color = LEVEL_COLORS[d.level] || '#aaa';
      var bg    = LEVEL_BG[d.level]    || '#111';
      var val   = d.pct != null ? d.pct + '%' : d.active != null ? d.active : d.maxScore != null ? d.maxScore : d.violations != null ? d.violations : d.open != null ? d.open : '—';
      return '<div style="background:' + bg + ';border:1px solid ' + color + ';border-radius:6px;padding:10px;text-align:center">' +
        '<div style="font-size:11px;color:#aaa">' + label + '</div>' +
        '<div style="font-size:24px;font-weight:bold;color:' + color + '">' + val + '</div>' +
        (subLabel ? '<div style="font-size:10px;color:' + color + '">' + d.level + '</div>' : '') +
        '</div>';
    }

    var systemCells = curr ? [
      cell('Memory', curr.memory, true),
      cell('Workers', curr.workers, true),
      cell('Thermal', curr.thermal, true),
      cell('Failures', curr.failures, true),
      cell('Incidents', curr.incidents, true),
      cell('SLA Viols', curr.sla, true),
      cell('CB Open', curr.circuitBreakers, true),
    ].join('') : '<p style="color:#aaa">No data yet</p>';

    var toolCells = tools.slice(0, 30).map(function (t) {
      var color = LEVEL_COLORS[t.level] || '#aaa';
      return '<div style="background:#1a1a2e;border:1px solid ' + color + ';border-radius:3px;padding:4px;text-align:center;font-size:10px" title="' + t.toolId + '">' +
        '<div style="color:' + color + ';font-weight:bold">' + t.score + '</div>' +
        '<div style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px">' +
        t.toolId.replace(/^rt-/, '').slice(0, 8) + '</div></div>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px">' + systemCells + '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin-bottom:6px">Tool Health Heatmap (' + tools.length + ' tools)</summary>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:4px">' + (toolCells || '<span style="color:#aaa;font-size:11px">No tools registered</span>') + '</div></details>' +
      '<div style="margin-top:8px">' +
        '<button onclick="G&&G.RuntimeHeatmaps&&G.RuntimeHeatmaps.refresh()" style="padding:4px 10px;cursor:pointer">🔄 Refresh Heatmap</button>' +
      '</div>' +
      '</div>';
  }

  G.PanelHeatmaps = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.PanelAlerts) return;

  var _el     = null;
  var _filter = 'ALL';

  var LEVEL_COLOR = { INFO: '#3498db', WARN: '#f1c40f', P2: '#e67e22', P1: '#e74c3c', P0: '#8e44ad' };
  var LEVELS      = ['ALL', 'P0', 'P1', 'P2', 'WARN', 'INFO'];

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var alt = G.RuntimeAlerts;
    if (!alt) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeAlerts not loaded</p>'; return; }

    var metrics = alt.getMetrics();
    var opts    = _filter === 'ALL' ? {} : { level: _filter };
    var alerts  = alt.getAlerts(Object.assign({ limit: 100 }, opts));

    var levelBtns = LEVELS.map(function (l) {
      var active = l === _filter;
      var color  = LEVEL_COLOR[l] || '#aaa';
      var cnt    = l === 'ALL' ? metrics.raised : (metrics.byLevel[l] || 0);
      return '<button onclick="G&&G.PanelAlerts&&G.PanelAlerts._setFilter(\'' + l + '\')" ' +
        'style="margin:0 3px;padding:3px 8px;cursor:pointer;background:' + (active ? color : '#222') + ';' +
        'color:' + (active ? '#000' : color) + ';border:1px solid ' + color + ';border-radius:3px">' +
        l + (cnt ? ' (' + cnt + ')' : '') + '</button>';
    }).join('');

    var rows = alerts.map(function (a) {
      var color = LEVEL_COLOR[a.level] || '#aaa';
      var ack   = a.acknowledged ? '✓' : '';
      var t     = new Date(a.ts).toTimeString().slice(0, 8);
      return '<tr style="opacity:' + (a.acknowledged ? '0.5' : '1') + '">' +
        '<td style="padding:3px 6px;color:' + color + ';font-weight:bold">' + a.level + '</td>' +
        '<td style="padding:3px 6px;color:#aaa;font-size:11px">' + a.source + '</td>' +
        '<td style="padding:3px 6px">' + a.message + '</td>' +
        '<td style="padding:3px 6px;color:#aaa;font-size:11px">' + (a.toolId || '') + '</td>' +
        '<td style="padding:3px 6px;color:#aaa;font-size:11px">' + t + '</td>' +
        '<td style="padding:3px 6px">' +
          (!a.acknowledged ? '<button onclick="G&&G.RuntimeAlerts&&G.RuntimeAlerts.acknowledge(\'' + a.id + '\');G&&G.PanelAlerts&&G.PanelAlerts.refresh()" ' +
            'style="font-size:10px;padding:2px 5px;cursor:pointer">Ack</button>' : ack) +
        '</td></tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:12px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px">' +
        _kpi('Raised', metrics.raised, '#3498db') +
        _kpi('P0', metrics.byLevel.P0, '#8e44ad') +
        _kpi('P1', metrics.byLevel.P1, '#e74c3c') +
        _kpi('P2', metrics.byLevel.P2, '#e67e22') +
        _kpi('Acked', metrics.acknowledged, '#2ecc71') +
      '</div>' +
      '<div style="margin-bottom:8px">' + levelBtns + '</div>' +
      '<div style="margin-bottom:6px">' +
        '<button onclick="G&&G.RuntimeAlerts&&G.RuntimeAlerts.acknowledgeAll();G&&G.PanelAlerts&&G.PanelAlerts.refresh()" style="padding:3px 8px;cursor:pointer">✓ Ack All</button>' +
      '</div>' +
      (alerts.length ? '<div style="overflow-y:auto;max-height:300px"><table style="width:100%;border-collapse:collapse">' +
        '<tr style="color:#aaa;font-size:11px;border-bottom:1px solid #333">' +
          '<th style="padding:3px 6px;text-align:left">Level</th>' +
          '<th style="padding:3px 6px;text-align:left">Source</th>' +
          '<th style="padding:3px 6px;text-align:left">Message</th>' +
          '<th style="padding:3px 6px;text-align:left">Tool</th>' +
          '<th style="padding:3px 6px;text-align:left">Time</th>' +
          '<th></th></tr>' + rows + '</table></div>' :
        '<p style="color:#aaa;text-align:center;padding:20px">No alerts' + (_filter !== 'ALL' ? ' for ' + _filter : '') + '</p>') +
      '</div>';
  }

  function _setFilter(level) { _filter = level; refresh(); }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:6px;text-align:center">' +
      '<div style="font-size:10px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:bold;color:' + color + '">' + (value || 0) + '</div></div>';
  }

  var _pub = Object.freeze({ render: render, refresh: refresh, _setFilter: _setFilter });
  G.PanelAlerts = _pub;

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.PanelAnalytics) return;

  var _el     = null;
  var _window = '15m';

  var WINDOWS = ['5m', '15m', '1h', '6h', '24h'];

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var analy = G.RuntimeCommandAnalytics;
    var fc    = G.RuntimeForecast;

    if (!analy) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeCommandAnalytics not loaded</p>'; return; }

    var trends  = analy.getTrends(_window);
    var growth  = analy.getGrowthRates(_window);
    var usage   = analy.getToolUsageTrend().slice(0, 10);
    var forecasts = fc && fc.getForecasts ? fc.getForecasts({ limit: 5 }) : [];

    var winBtns = WINDOWS.map(function (w) {
      var active = w === _window;
      return '<button onclick="G&&G.PanelAnalytics&&G.PanelAnalytics._setWindow(\'' + w + '\')" ' +
        'style="margin:0 2px;padding:3px 8px;cursor:pointer;background:' + (active ? '#3498db' : '#222') + ';' +
        'color:' + (active ? '#fff' : '#3498db') + ';border:1px solid #3498db;border-radius:3px">' + w + '</button>';
    }).join('');

    function trendRow(label, key, unit) {
      var d = trends[key] || {};
      var t = d.trend || 0;
      var arrow = t > 0.01 ? '↑' : t < -0.01 ? '↓' : '→';
      var color = key === 'memory' || key === 'failures' || key === 'incidents' || key === 'slaViolations'
        ? (t > 0.1 ? '#e74c3c' : t > 0 ? '#f1c40f' : '#2ecc71')
        : (t > 0 ? '#2ecc71' : '#aaa');
      return '<tr>' +
        '<td style="padding:3px 8px">' + label + '</td>' +
        '<td style="padding:3px 8px;text-align:right;color:#aaa">' + (d.avg || 0).toFixed(1) + (unit || '') + '</td>' +
        '<td style="padding:3px 8px;text-align:right;color:' + color + '">' + arrow + ' ' + Math.abs(t).toFixed(3) + '/min</td>' +
        '<td style="padding:3px 8px;text-align:right;color:' + (growth[key] > 0 ? '#e74c3c' : '#2ecc71') + '">' + (growth[key] || 0) + '%</td>' +
        '</tr>';
    }

    var usageRows = usage.map(function (t) {
      return '<tr><td style="padding:2px 6px">' + t.toolId + '</td>' +
        '<td style="padding:2px 6px;text-align:right;color:#3498db">' + (t.launches || 0) + '</td>' +
        '<td style="padding:2px 6px;text-align:right;color:' + (t.successRate >= 90 ? '#2ecc71' : t.successRate >= 70 ? '#f1c40f' : '#e74c3c') + '">' +
        (t.successRate != null ? t.successRate + '%' : '—') + '</td>' +
        '<td style="padding:2px 6px;text-align:right;color:#f39c12">' + (t.score != null ? t.score.toFixed(1) : '—') + '</td>' +
        '</tr>';
    }).join('');

    var SCOLORS = { info: '#3498db', warning: '#f1c40f', critical: '#e74c3c' };
    var fcastHtml = forecasts.length ? forecasts.map(function (f) {
      var col = SCOLORS[f.severity] || '#aaa';
      return '<div style="border-left:3px solid ' + col + ';padding:4px 8px;margin:4px 0;background:#1a1a2e">' +
        '<span style="color:' + col + ';font-size:11px;font-weight:bold">' + f.type.toUpperCase() + ' ' + f.confidence + '%</span><br>' +
        '<span style="font-size:11px">' + f.message + '</span></div>';
    }).join('') : '<p style="color:#aaa;font-size:11px">No forecasts yet — generates every 5 min</p>';

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:12px;padding:8px">' +
      '<div style="margin-bottom:8px">' + winBtns + '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin-bottom:6px">Trends (' + trends.sampleCount + ' samples in window)</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<tr style="color:#aaa;font-size:11px;border-bottom:1px solid #333">' +
          '<th style="text-align:left;padding:3px 8px">Metric</th>' +
          '<th style="text-align:right;padding:3px 8px">Avg</th>' +
          '<th style="text-align:right;padding:3px 8px">Trend</th>' +
          '<th style="text-align:right;padding:3px 8px">Growth</th></tr>' +
        trendRow('Memory', 'memory', '%') +
        trendRow('Workers', 'workers', '') +
        trendRow('Failures', 'failures', '%') +
        trendRow('Incidents', 'incidents', '') +
        trendRow('SLA Violations', 'slaViolations', '') +
        trendRow('CB Open', 'cbOpen', '') +
      '</table></details>' +
      (usage.length ? '<details><summary style="cursor:pointer;font-weight:bold;margin:6px 0">Top Tools by Usage</summary>' +
        '<table style="width:100%;border-collapse:collapse">' +
          '<tr style="color:#aaa;font-size:11px"><th style="text-align:left;padding:2px 6px">Tool</th>' +
            '<th style="text-align:right;padding:2px 6px">Launches</th>' +
            '<th style="text-align:right;padding:2px 6px">Success</th>' +
            '<th style="text-align:right;padding:2px 6px">Score</th></tr>' +
          usageRows + '</table></details>' : '') +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin:6px 0">Forecasts</summary>' +
        fcastHtml +
        '<button onclick="G&&G.RuntimeForecast&&G.RuntimeForecast.generateForecasts();G&&G.PanelAnalytics&&G.PanelAnalytics.refresh()" style="margin-top:6px;padding:3px 8px;cursor:pointer">🔮 Generate Now</button>' +
      '</details>' +
      '</div>';
  }

  function _setWindow(w) { _window = w; refresh(); }

  var _pub = Object.freeze({ render: render, refresh: refresh, _setWindow: _setWindow });
  G.PanelAnalytics = _pub;

}(typeof window !== 'undefined' ? window : this));
(function (G) {
  'use strict';
  if (G.PanelFleet) return;

  var _el = null;

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var fm = G.RuntimeFleetManager;
    var cc = G.RuntimeCommandCenter;
    if (!fm) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeFleetManager not loaded</p>'; return; }

    var fleet   = fm.getFleetStatus();
    var metrics = fm.getMetrics();

    var rows = fleet.map(function (s) {
      var stateColor = !s.present ? '#555' : s.paused ? '#e74c3c' : s.isolated ? '#e67e22' : '#2ecc71';
      var stateLabel = !s.present ? 'absent' : s.paused ? 'paused' : s.isolated ? 'isolated' : 'active';
      var id = s.id;
      var esc = id.replace(/'/g, "\\'");
      return '<tr>' +
        '<td style="padding:4px 8px"><span style="color:' + stateColor + '">●</span> ' + s.label + '</td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:11px">arc' + s.arc + '</td>' +
        '<td style="padding:4px 8px;color:' + stateColor + ';font-weight:bold;font-size:11px">' + stateLabel.toUpperCase() + '</td>' +
        '<td style="padding:4px 8px">' +
          (s.present ? (
            (!s.paused ?
              '<button onclick="G.RuntimeFleetManager.pause(\'' + esc + '\',\'manual\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">⏸ Pause</button>' :
              '<button onclick="G.RuntimeFleetManager.resume(\'' + esc + '\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">▶ Resume</button>'
            ) +
            '<button onclick="G.RuntimeFleetManager.restart(\'' + esc + '\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">🔄 Restart</button>' +
            '<button onclick="G.RuntimeFleetManager.isolate(\'' + esc + '\',\'manual\')" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer">🔒 Isolate</button>' +
            '<button onclick="G.RuntimeFleetManager.quarantine(\'' + esc + '\',\'manual\');G.PanelFleet.refresh()" style="font-size:10px;padding:2px 5px;margin:1px;cursor:pointer;background:#3a1020;color:#e74c3c;border:1px solid #e74c3c">⛔ Quarantine</button>'
          ) : '<span style="color:#555;font-size:11px">not loaded</span>') +
        '</td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:10px">' + (s.lastAction || '—') + '</td>' +
        '</tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:12px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px">' +
        _kpi('Paused', metrics.paused, '#e74c3c') +
        _kpi('Resumed', metrics.resumed, '#2ecc71') +
        _kpi('Restarted', metrics.restarted, '#3498db') +
        _kpi('Isolated', metrics.isolated, '#e67e22') +
        _kpi('Quarantined', metrics.quarantined, '#8e44ad') +
      '</div>' +
      '<div style="overflow-y:auto;max-height:400px">' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<tr style="color:#aaa;font-size:11px;border-bottom:1px solid #333">' +
          '<th style="text-align:left;padding:4px 8px">Subsystem</th>' +
          '<th style="text-align:left;padding:4px 8px">Arc</th>' +
          '<th style="text-align:left;padding:4px 8px">State</th>' +
          '<th style="text-align:left;padding:4px 8px">Actions</th>' +
          '<th style="text-align:left;padding:4px 8px">Last Action</th></tr>' +
        rows +
      '</table></div>' +
      '<div style="margin-top:8px">' +
        '<button onclick="G&&G.PanelFleet&&G.PanelFleet.refresh()" style="padding:4px 10px;cursor:pointer">🔄 Refresh Fleet</button>' +
      '</div>' +
      '</div>';
  }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:6px;text-align:center">' +
      '<div style="font-size:10px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:bold;color:' + color + '">' + (value || 0) + '</div></div>';
  }

  G.PanelFleet = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));

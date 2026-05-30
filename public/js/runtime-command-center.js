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

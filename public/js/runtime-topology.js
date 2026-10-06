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

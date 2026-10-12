(function (G) {
  'use strict';
  if (G.RuntimeDebugShell) return;

  var VERSION = '10.0.0';
  var LOG     = '[DebugShell]';

  // ── Dependency check ──────────────────────────────────────────────────────────
  var DEPS = [
    'RuntimeDebugSecurity', 'RuntimeDebugState', 'RuntimeDebugStorage',
    'RuntimeDebugRenderer',  'RuntimeDebugMobile', 'RuntimeDebugExport',
  ];

  var _missing = DEPS.filter(function (d) { return !G[d]; });
  if (_missing.length) {
    console.warn(LOG, 'missing deps:', _missing.join(', '));
    return;
  }

  var Sec  = G.RuntimeDebugSecurity;
  var St   = G.RuntimeDebugState;
  var Sto  = G.RuntimeDebugStorage;
  var Ren  = G.RuntimeDebugRenderer;
  var Mob  = G.RuntimeDebugMobile;

  // ── Production gate ───────────────────────────────────────────────────────────
  if (!Sec.isAllowed()) {
    console.warn(LOG, 'access denied — redirect');
    if (window.location.pathname.indexOf('debug') !== -1) {
      window.location.href = '/';
    }
    return;
  }

  // ── Panel definitions (lazy-loaded) ──────────────────────────────────────────
  var PANEL_DEFS = [
    { id: 'incidents',          label: 'Incidents',            icon: '🚨', ctor: 'PanelIncidents'        },
    { id: 'timeline',           label: 'Event Timeline',        icon: '📊', ctor: 'PanelTimeline'         },
    { id: 'blackbox',           label: 'Blackbox',              icon: '⚫', ctor: 'PanelBlackbox'         },
    { id: 'recovery',           label: 'Recovery & Healing',    icon: '🔄', ctor: 'PanelRecovery'         },
    { id: 'performance',        label: 'Performance',           icon: '⚡', ctor: 'PanelPerformance'      },
    { id: 'control',            label: 'Control Plane',         icon: '🎛️', ctor: 'PanelControl'          },
    { id: 'traces',             label: 'Traces & Snapshots',    icon: '🔍', ctor: 'PanelTraces'           },
    // Arc 11 panels (lazy-loaded)
    { id: 'tab-mesh',           label: 'Tab Mesh',              icon: '🕸', ctor: 'PanelTabMesh'          },
    { id: 'persistent-storage', label: 'Persistent Storage',    icon: '💾', ctor: 'PanelPersistentStorage'},
    { id: 'recovery-memory',    label: 'Recovery Memory',       icon: '🧠', ctor: 'PanelRecoveryMemory'   },
    { id: 'deploy-resilience',  label: 'Deploy Resilience',     icon: '🚀', ctor: 'PanelDeployResilience' },
    { id: 'crash-survival',     label: 'Crash Survival',        icon: '💥', ctor: 'PanelCrashSurvival'    },
    // Arc 12 panels (lazy-loaded)
    { id: 'tool-registry',      label: 'Tool Registry',         icon: '📋', ctor: 'PanelToolRegistry'     },
    { id: 'tool-health',        label: 'Tool Health',           icon: '❤️', ctor: 'PanelToolHealth'        },
    { id: 'tool-predictor',     label: 'Tool Predictor',        icon: '🔮', ctor: 'PanelToolPredictor'    },
    { id: 'tool-recovery',      label: 'Tool Recovery',         icon: '🔧', ctor: 'PanelToolRecovery'     },
    { id: 'tool-optimizer',     label: 'Tool Optimizer',        icon: '⚡', ctor: 'PanelToolOptimizer'    },
    // Arc 13 panels (lazy-loaded)
    { id: 'tool-persistence',   label: 'Tool Persistence',      icon: '💿', ctor: 'PanelToolPersistence'  },
    { id: 'tool-circuit-breaker', label: 'Circuit Breaker',     icon: '⚡', ctor: 'PanelToolCircuitBreaker'},
    { id: 'tool-sla',           label: 'Tool SLA',              icon: '📊', ctor: 'PanelToolSLA'          },
    { id: 'tool-discovery',     label: 'Tool Discovery',        icon: '🔭', ctor: 'PanelToolDiscovery'    },
    { id: 'tool-insights',      label: 'Tool Insights',         icon: '💡', ctor: 'PanelToolInsights'     },
    // Arc 14 panels (Command Center)
    { id: 'command-center',     label: 'Command Center',        icon: '🖥️', ctor: 'PanelCommandCenter'    },
    { id: 'topology',           label: 'Topology',              icon: '🗺️', ctor: 'PanelTopology'         },
    { id: 'heatmaps',           label: 'Heatmaps',              icon: '🔥', ctor: 'PanelHeatmaps'         },
    { id: 'alerts',             label: 'Alerts',                icon: '🚨', ctor: 'PanelAlerts'           },
    { id: 'analytics',          label: 'Analytics',             icon: '📈', ctor: 'PanelAnalytics'        },
    { id: 'fleet',              label: 'Fleet Manager',         icon: '🚀', ctor: 'PanelFleet'            },
    // Arc 15 panels (ERAPO — Automation & Policy Orchestration)
    { id: 'policy-engine',      label: 'Policy Engine',         icon: '📋', ctor: 'PanelPolicyEngine'     },
    { id: 'automation-engine',  label: 'Automation Engine',     icon: '⚙️', ctor: 'PanelAutomationEngine' },
    { id: 'workflow-engine',    label: 'Workflow Engine',       icon: '🔀', ctor: 'PanelWorkflowEngine'   },
    { id: 'autonomous-ops',     label: 'Autonomous Ops',        icon: '🤖', ctor: 'PanelAutonomousOps'    },
    { id: 'policy-analytics',   label: 'Policy Analytics',      icon: '📊', ctor: 'PanelPolicyAnalytics'  },
    { id: 'decision-engine',    label: 'Decision Engine',       icon: '🧠', ctor: 'PanelDecisionEngine'   },
  ];

  // ── DOM root ──────────────────────────────────────────────────────────────────
  var _root   = null;
  var _nav    = null;
  var _body   = null;
  var _panels = {};         // id → { instance, el }
  var _active = null;       // currently visible panel id
  var _timers = {};         // panel id → interval id
  var _paused = false;

  // ── Polling scheduler ─────────────────────────────────────────────────────────
  var _refreshMs = Mob.getRefreshMs();

  function _startPoller(id) {
    _stopPoller(id);
    var spec = _panels[id];
    if (!spec || !spec.instance || typeof spec.instance.refresh !== 'function') return;
    _timers[id] = setInterval(function () {
      if (_paused || St.get('tabHidden')) return;
      if (Sto.isOverCap()) { Sto.trimToFit(); }
      try { spec.instance.refresh(); } catch (e) { console.warn(LOG, 'panel refresh error:', e.message); }
    }, _refreshMs);
  }

  function _stopPoller(id) {
    if (_timers[id]) { clearInterval(_timers[id]); delete _timers[id]; }
  }

  // ── Page visibility ───────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    var hidden = document.hidden;
    St.set('tabHidden', hidden);
    _paused = hidden;
    if (!hidden && _active) {
      var spec = _panels[_active];
      if (spec && spec.instance && typeof spec.instance.refresh === 'function') {
        try { spec.instance.refresh(); } catch (_) {}
      }
    }
  });

  // ── Panel activation ─────────────────────────────────────────────────────────
  function _activatePanel(id) {
    if (_active === id) return;

    // Deactivate current
    if (_active && _panels[_active]) {
      _panels[_active].el.style.display = 'none';
      _stopPoller(_active);
      St.deactivatePanel(_active);
    }

    _active = id;
    var spec = _panels[id];
    if (!spec) return;
    spec.el.style.display = '';
    St.activatePanel(id);

    // Initialize if first time
    if (!spec.instance) {
      var Ctor = G[PANEL_DEFS.find(function (p) { return p.id === id; }).ctor];
      if (Ctor && typeof Ctor === 'function') {
        try {
          spec.instance = new Ctor(spec.el);
          if (typeof spec.instance.init === 'function') spec.instance.init();
        } catch (e) { console.warn(LOG, 'panel init error', id, e.message); }
      }
    }

    if (spec.instance && typeof spec.instance.refresh === 'function') {
      try { spec.instance.refresh(); } catch (_) {}
    }

    _startPoller(id);
    _updateNav(id);

    // Persist active tab
    Sto.persist('activePanel', id);
  }

  // ── Nav render ────────────────────────────────────────────────────────────────
  function _updateNav(activeId) {
    if (!_nav) return;
    _nav.querySelectorAll('.dbg-nav-tab').forEach(function (tab) {
      var isActive = tab.dataset.panel === activeId;
      tab.classList.toggle('dbg-nav-active', isActive);
    });
  }

  // ── Shell layout ──────────────────────────────────────────────────────────────
  function _buildLayout() {
    _root = document.getElementById('dbg-root');
    if (!_root) {
      _root = Ren.el('div', { id: 'dbg-root', cls: 'dbg-root' });
      document.body.appendChild(_root);
    }

    Mob.applyLayout(_root);

    // Header
    var buildId = (typeof window.__BUILD_ID__ !== 'undefined') ? window.__BUILD_ID__ : '—';
    var header  = Ren.el('div', { cls: 'dbg-header' }, [
      Ren.el('span', { cls: 'dbg-logo', text: '🛠 ILovePDF Debug Console' }),
      Ren.el('span', { cls: 'dbg-build', text: 'build: ' + buildId }),
      Ren.el('span', { cls: 'dbg-arc',   text: 'Arc 8–9 coverage: 14 systems' }),
      Ren.el('button', { cls: 'dbg-btn dbg-export-all', text: 'Export Snapshot' }),
    ]);

    header.querySelector('.dbg-export-all').addEventListener('click', function () {
      if (G.RuntimeDebugExport) G.RuntimeDebugExport.exportDashboardSnapshot();
    });

    // Nav tabs
    _nav = Ren.el('nav', { cls: 'dbg-nav' });
    PANEL_DEFS.forEach(function (def) {
      var tab = Ren.el('button', {
        cls:          'dbg-nav-tab',
        text:         def.icon + ' ' + def.label,
        'data-panel': def.id,
      });
      tab.addEventListener('click', function () { _activatePanel(def.id); });
      _nav.appendChild(tab);
    });

    // Panel body
    _body = Ren.el('div', { cls: 'dbg-body' });

    PANEL_DEFS.forEach(function (def) {
      var pane = Ren.el('div', { cls: 'dbg-panel', id: 'panel-' + def.id, style: 'display:none' });
      _body.appendChild(pane);
      _panels[def.id] = { el: pane, instance: null };
      St.registerPanel(def.id, { label: def.label });
    });

    _root.appendChild(header);
    _root.appendChild(_nav);
    _root.appendChild(_body);

    Mob.stackPanels(_body);
    Mob.onLayoutChange(function () {
      Mob.applyLayout(_root);
      Mob.stackPanels(_body);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    _buildLayout();

    // Restore last active panel or default to incidents
    var last = Sto.load('activePanel') || 'incidents';
    _activatePanel(last);

    // Runtime health summary in console
    var systems = [
      'RuntimeIncidentCenter', 'RuntimeEventTimeline', 'RuntimeBlackbox',
      'RuntimeRecoveryOrchestrator', 'RuntimeAutonomousHealing', 'RuntimeGovernance',
      'RuntimePerformanceProfiler', 'RuntimeWorkloadIntelligence', 'RuntimeSessionStability',
    ];
    var loaded = systems.filter(function (s) { return !!G[s]; });
    console.debug(LOG, 'runtime coverage:', loaded.length + '/' + systems.length, 'Arc8–9 systems available');

    St.emit('shell:ready', { panels: PANEL_DEFS.length });
  }

  // ── Pause/resume for external callers ─────────────────────────────────────────
  function pause()  { _paused = true;  Object.keys(_timers).forEach(_stopPoller); }
  function resume() { _paused = false; if (_active) _startPoller(_active); }

  G.RuntimeDebugShell = Object.freeze({
    VERSION:       VERSION,
    init:          init,
    activatePanel: _activatePanel,
    pause:         pause,
    resume:        resume,
    getActive:     function () { return _active; },
    getPanelDefs:  function () { return PANEL_DEFS.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — gated dashboard shell (Arc 11 panels: 5)');

}(window));

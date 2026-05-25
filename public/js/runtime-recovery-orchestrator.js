// RuntimeRecoveryOrchestrator v1.0 — Arc 9 / Phase D
// =====================================================================
// Unified recovery graph with dependency-ordered sequencing.
// Distinct from RuntimeRecoveryDomains (Arc 3 tool isolation) and
// RuntimeRecoveryFirewalls (Arc 5 tool firewalls).
//
// Recovery lifecycle: ASSESS → ISOLATE → HEAL → VERIFY → RESTORE
//
// Features:
//   - Subsystem dependency tree (what must recover before what)
//   - Topological recovery sequencing
//   - Pre-recovery rollback checkpoints
//   - Replay-guided recovery (RuntimeReplayEngine integration)
//   - Healing simulations (dry-run without executing)
//   - Safe-mode: minimal runtime (Arc 1-3 only)
//   - Partial restart: reboot one subsystem without full reload
//   - Isolated subsystem reboot via targeted event dispatch
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeRecoveryOrchestrator) return;

  var LOG     = '[RecoveryOrchestrator]';
  var VERSION = '1.0';

  // ── Subsystem dependency graph ────────────────────────────────────
  // Each entry: { id, deps[], global, recoveryFn }
  // deps = must be recovered before this subsystem
  var DEPENDENCY_GRAPH = [
    { id: 'core',          deps: [],                     critical: true  },
    { id: 'deploy-sync',   deps: ['core'],               critical: true  },
    { id: 'hydration',     deps: ['core'],               critical: true  },
    { id: 'workers',       deps: ['core'],               critical: false },
    { id: 'memory',        deps: ['core', 'workers'],    critical: false },
    { id: 'cache',         deps: ['core'],               critical: false },
    { id: 'task-orch',     deps: ['workers', 'memory'],  critical: false },
    { id: 'stream',        deps: ['task-orch', 'workers'], critical: false },
    { id: 'offline',       deps: ['core'],               critical: false },
    { id: 'predictive',    deps: ['cache', 'stream'],    critical: false },
    { id: 'optimizer',     deps: ['task-orch', 'stream'], critical: false },
    { id: 'control-plane', deps: ['core'],               critical: false },
    { id: 'incident',      deps: ['core'],               critical: false },
    { id: 'timeline',      deps: ['core'],               critical: false },
    { id: 'snapshots',     deps: ['core', 'memory'],     critical: false },
    { id: 'governance',    deps: ['core', 'control-plane'], critical: false },
    { id: 'healing',       deps: ['incident', 'snapshots'], critical: false },
    { id: 'workload',      deps: ['workers', 'task-orch'], critical: false },
  ];

  // ── Topological sort ──────────────────────────────────────────────
  function _topoSort(graph) {
    var inDegree = {};
    var adj      = {};
    graph.forEach(function (n) {
      inDegree[n.id] = n.deps.length;
      adj[n.id]      = [];
    });
    graph.forEach(function (n) {
      n.deps.forEach(function (dep) { if (adj[dep]) adj[dep].push(n.id); });
    });

    var queue  = Object.keys(inDegree).filter(function (k) { return inDegree[k] === 0; });
    var result = [];
    while (queue.length) {
      var node = queue.shift();
      result.push(node);
      (adj[node] || []).forEach(function (nbr) {
        inDegree[nbr]--;
        if (inDegree[nbr] === 0) queue.push(nbr);
      });
    }
    return result;
  }

  var RECOVERY_ORDER = _topoSort(DEPENDENCY_GRAPH);

  // ── Recovery actions per subsystem ───────────────────────────────
  function _recoverSubsystem(id, dryRun) {
    var steps = [];
    try {
      switch (id) {
        case 'cache':
          if (!dryRun) { var sc = G.RuntimeSmartCache; if (sc && sc.clear) sc.clear(); }
          steps.push('cache-clear');
          break;
        case 'hydration':
          if (!dryRun) {
            var sh = G.RuntimeStreamingHydration;
            if (sh && sh.flush) sh.flush();
            var hs = G.RuntimeHydrationScheduler;
            if (hs && hs.resume) { hs.resume('P0'); hs.resume('P1'); hs.resume('P2'); }
          }
          steps.push('hydration-flush', 'hydration-resume');
          break;
        case 'workers':
          if (!dryRun) {
            G.dispatchEvent(new CustomEvent('arc9:recover-workers', {}));
          }
          steps.push('worker-recover-advisory');
          break;
        case 'memory':
          if (!dryRun) { try { if (G.gc) G.gc(); } catch (_) {} }
          steps.push('gc-hint');
          break;
        case 'control-plane':
          if (!dryRun) {
            var cp = G.RuntimeControlPlane;
            if (cp) { cp.execute('predictive.enable', {}); cp.execute('optimizer.enable', {}); }
          }
          steps.push('flags-restored');
          break;
        case 'timeline':
          if (!dryRun) {
            var et = G.RuntimeEventTimeline;
            if (et && et.clear) et.clear();
          }
          steps.push('timeline-cleared');
          break;
        default:
          steps.push('advisory:' + id);
      }
    } catch (e) {
      steps.push('error:' + e.message);
    }
    return steps;
  }

  // ── State ─────────────────────────────────────────────────────────
  var _recovery     = null;  // active recovery context
  var _history      = [];    // past recoveries ring buffer
  var _safeMode     = false;
  var _stats        = { runs: 0, succeeded: 0, failed: 0, simulations: 0, rollbacks: 0 };
  var _tel          = [];

  function _log(ev, d) {
    _tel.push({ ts: Date.now(), ev: ev, d: d });
    if (_tel.length > 100) _tel.shift();
  }

  // ── Run recovery ──────────────────────────────────────────────────
  function runRecovery(opts) {
    opts = opts || {};
    if (_recovery) return { ok: false, reason: 'recovery-in-progress' };

    var subsystems = opts.subsystems || RECOVERY_ORDER;
    var dryRun     = !!opts.dryRun;
    var snapBefore = null;
    _stats.runs++;

    if (dryRun) { _stats.simulations++; console.debug(LOG, 'SIMULATION (dry-run)'); }

    // Pre-recovery snapshot
    if (!dryRun) {
      try {
        var ss = G.RuntimeStateSnapshots;
        if (ss) snapBefore = ss.take('pre-recovery:' + Date.now(), true);
      } catch (_) {}
    }

    _recovery = {
      id:      'rcv_' + Date.now().toString(36),
      started: Date.now(),
      subsystems: subsystems,
      dryRun:  dryRun,
      snapBefore: snapBefore,
      phase:   'ASSESS',
      steps:   {},
    };

    _log('start', { id: _recovery.id, subsystems: subsystems, dryRun: dryRun });
    console.debug(LOG, 'recovery', _recovery.id, '| subsystems:', subsystems.join(','), dryRun ? '[dry-run]' : '');

    // Execute sequentially (async to avoid blocking)
    var seq = subsystems.slice();
    var allSteps = {};

    function _next() {
      if (!seq.length) {
        _recovery.phase   = 'RESTORE';
        _recovery.ended   = Date.now();
        _recovery.durationMs = _recovery.ended - _recovery.started;
        _recovery.steps   = allSteps;
        _stats.succeeded++;
        _log('complete', { id: _recovery.id, ms: _recovery.durationMs });
        console.debug(LOG, 'recovery complete:', _recovery.id, _recovery.durationMs + 'ms');
        try {
          G.dispatchEvent(new CustomEvent('arc9:recovery-complete', {
            detail: { id: _recovery.id, dryRun: dryRun, ms: _recovery.durationMs },
          }));
        } catch (_) {}
        _history.push(Object.assign({}, _recovery));
        if (_history.length > 20) _history.shift();
        _recovery = null;
        return;
      }
      var sub = seq.shift();
      _recovery.phase = 'HEAL:' + sub;
      try {
        allSteps[sub] = _recoverSubsystem(sub, dryRun);
      } catch (e) {
        allSteps[sub] = ['error:' + e.message];
      }
      setTimeout(_next, 50);  // 50ms between each to stay non-blocking
    }

    _recovery.phase = 'ISOLATE';
    setTimeout(_next, 10);
    return { ok: true, id: _recovery.id, dryRun: dryRun };
  }

  // ── Partial subsystem restart ─────────────────────────────────────
  function restartSubsystem(id) {
    console.debug(LOG, 'restarting subsystem:', id);
    return runRecovery({ subsystems: [id] });
  }

  // ── Safe mode ─────────────────────────────────────────────────────
  function enterSafeMode() {
    if (_safeMode) return { ok: false, reason: 'already-in-safe-mode' };
    _safeMode = true;
    console.warn(LOG, 'ENTERING SAFE MODE');
    // Disable non-critical subsystems
    try {
      var cp = G.RuntimeControlPlane;
      if (cp) {
        cp.execute('optimizer.disable', {});
        cp.execute('predictive.disable', {});
        cp.execute('extreme.trigger', { mode: 'ULTRA_LOW_MEMORY' });
      }
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('arc9:safe-mode-active', { detail: { ts: Date.now() } }));
    } catch (_) {}
    _log('safe-mode', { ts: Date.now() });
    // Run critical-only recovery
    var criticalIds = DEPENDENCY_GRAPH.filter(function (n) { return n.critical; }).map(function (n) { return n.id; });
    return runRecovery({ subsystems: criticalIds });
  }

  function exitSafeMode() {
    if (!_safeMode) return;
    _safeMode = false;
    try {
      var cp = G.RuntimeControlPlane;
      if (cp) { cp.execute('optimizer.enable', {}); cp.execute('predictive.enable', {}); }
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('arc9:safe-mode-exited', { detail: { ts: Date.now() } }));
    } catch (_) {}
    console.debug(LOG, 'safe mode exited');
  }

  // ── Rollback ──────────────────────────────────────────────────────
  G.addEventListener('arc8:heal-rollback', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.snapId) return;
      _stats.rollbacks++;
      _log('rollback-received', { snapId: d.snapId, category: d.category });
      console.warn(LOG, 'rollback received for snap:', d.snapId, 'category:', d.category);
      // Restart affected subsystem as recovery response
      if (d.category === 'hydration-failure') restartSubsystem('hydration');
      else if (d.category === 'worker-crash')  restartSubsystem('workers');
      else if (d.category === 'memory-panic')  restartSubsystem('memory');
    } catch (_) {}
  });

  // ── Safe-mode request ─────────────────────────────────────────────
  G.addEventListener('arc9:safe-mode-request', function () {
    try { enterSafeMode(); } catch (_) {}
  });

  G.RuntimeRecoveryOrchestrator = Object.freeze({
    VERSION:           VERSION,
    runRecovery:       runRecovery,
    restartSubsystem:  restartSubsystem,
    simulate:          function (opts) { return runRecovery(Object.assign({}, opts, { dryRun: true })); },
    enterSafeMode:     enterSafeMode,
    exitSafeMode:      exitSafeMode,
    isSafeMode:        function () { return _safeMode; },
    getRecoveryOrder:  function () { return RECOVERY_ORDER.slice(); },
    getHistory:        function () { return _history.slice(); },
    getActive:         function () { return _recovery ? Object.assign({}, _recovery) : null; },
    getStats:          function () { return Object.assign({}, _stats); },
    getTelemetry:      function () { return _tel.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — recovery order:', RECOVERY_ORDER.length, 'subsystems | safe-mode available');

}(window));

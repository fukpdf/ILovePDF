// ── Arc 13 Persistent Tool Intelligence + Circuit Breaker System — Phase 9 build bundle ──────────────────────────
// Generated: 2026-06-03T02:46:36.866Z  BUILD_ID: mpxgtdiz
// Files: 14

// ── SOURCE: public/js/runtime-tool-persistence.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolPersistence) return;

  var LOG = '[Arc13:Persistence]';
  var DB_NAME    = 'tool-intelligence-v1';
  var DB_VERSION = 1;
  var STORES     = ['registry', 'predictor', 'recovery', 'optimizer'];
  var AUTO_SAVE_MS = 60 * 1000;

  var _db       = null;
  var _dbReady  = false;
  var _metrics  = { saves: 0, restores: 0, errors: 0, lastSaveTs: 0, lastRestoreTs: 0 };
  var _localTransitions = {};   // built by observing arc9:tool-recorded events
  var _lastFrom         = null; // previous tool for transition tracking

  // ── IndexedDB open ──────────────────────────────────────────────────────────
  function _openDB() {
    return new Promise(function (resolve, reject) {
      if (!G.indexedDB) { reject(new Error('IndexedDB not available')); return; }
      var req = G.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) {
            db.createObjectStore(s, { keyPath: 'id', autoIncrement: false });
          }
        });
      };
      req.onsuccess = function (e) { _db = e.target.result; _dbReady = true; resolve(_db); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  function _ready() {
    if (_dbReady && _db) return Promise.resolve(_db);
    return _openDB();
  }

  // ── IDB helpers ─────────────────────────────────────────────────────────────
  function _put(storeName, key, value) {
    return _ready().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([storeName], 'readwrite');
        var os  = tx.objectStore(storeName);
        var req = os.put({ id: key, value: value, ts: Date.now() });
        req.onsuccess = function () { resolve(); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  function _get(storeName, key) {
    return _ready().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([storeName], 'readonly');
        var req = tx.objectStore(storeName).get(key);
        req.onsuccess = function (e) { resolve(e.target.result ? e.target.result.value : null); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  function _clearStore(storeName) {
    return _ready().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([storeName], 'readwrite');
        var req = tx.objectStore(storeName).clear();
        req.onsuccess = function () { resolve(); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  // ── Collect Registry snapshot ────────────────────────────────────────────────
  function _collectRegistry() {
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.getAllTools) return reg.getAllTools();
    } catch (_) {}
    return [];
  }

  // ── Collect Predictor transitions (observed locally) ─────────────────────────
  function _collectPredictor() {
    return Object.assign({}, _localTransitions);
  }

  // ── Collect Recovery history ─────────────────────────────────────────────────
  function _collectRecovery() {
    try {
      var rec = G.RuntimeToolRecovery;
      if (rec && rec.getAllHistory) return rec.getAllHistory();
    } catch (_) {}
    return {};
  }

  // ── Collect Optimizer metrics ────────────────────────────────────────────────
  function _collectOptimizer() {
    try {
      var opt = G.RuntimeToolOptimizer;
      if (opt && opt.getMetrics) return opt.getMetrics();
    } catch (_) {}
    return {};
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  function save() {
    var snap = {
      registry:   _collectRegistry(),
      predictor:  _collectPredictor(),
      recovery:   _collectRecovery(),
      optimizer:  _collectOptimizer(),
    };
    return Promise.all([
      _put('registry',  'snapshot', snap.registry),
      _put('predictor', 'transitions', snap.predictor),
      _put('recovery',  'history', snap.recovery),
      _put('optimizer', 'metrics', snap.optimizer),
    ]).then(function () {
      _metrics.saves++;
      _metrics.lastSaveTs = Date.now();
      console.debug(LOG, 'saved — registry:', snap.registry.length,
        'transitions:', Object.keys(snap.predictor).length, 'tools');
      G.dispatchEvent(new CustomEvent('arc13:persistence-saved', { detail: { ts: _metrics.lastSaveTs } }));
    }).catch(function (e) {
      _metrics.errors++;
      console.warn(LOG, 'save error:', e.message || e);
    });
  }

  // ── Restore ─────────────────────────────────────────────────────────────────
  function restore() {
    return Promise.all([
      _get('registry',  'snapshot'),
      _get('predictor', 'transitions'),
      _get('recovery',  'history'),
      _get('optimizer', 'metrics'),
    ]).then(function (results) {
      var regSnap    = results[0];
      var predSnap   = results[1];
      var recSnap    = results[2];

      // Restore registry
      if (regSnap && Array.isArray(regSnap)) {
        var reg = G.RuntimeToolRegistry;
        if (reg && reg.registerTool) {
          regSnap.forEach(function (t) {
            try { reg.registerTool(t); } catch (_) {}
          });
        }
        console.debug(LOG, 'restored registry:', regSnap.length, 'tools');
      }

      // Restore predictor transitions (local copy only — feeds future saves)
      if (predSnap && typeof predSnap === 'object') {
        _localTransitions = predSnap;
        console.debug(LOG, 'restored predictor transitions:',
          Object.keys(_localTransitions).length, 'source tools');
      }

      // Restore recovery history (rebuild by emitting synthetic events is not
      // safe — store locally for inspection by export layer only)
      if (recSnap && typeof recSnap === 'object') {
        console.debug(LOG, 'restored recovery history:',
          Object.keys(recSnap).length, 'tools');
      }

      _metrics.restores++;
      _metrics.lastRestoreTs = Date.now();
      G.dispatchEvent(new CustomEvent('arc13:persistence-restored', {
        detail: {
          registryTools: regSnap ? regSnap.length : 0,
          predictorKeys: predSnap ? Object.keys(predSnap).length : 0,
          ts: _metrics.lastRestoreTs,
        },
      }));
    }).catch(function (e) {
      _metrics.errors++;
      console.warn(LOG, 'restore error:', e.message || e);
    });
  }

  // ── Clear all stores ─────────────────────────────────────────────────────────
  function clear() {
    return Promise.all(STORES.map(function (s) { return _clearStore(s); })).then(function () {
      _localTransitions = {};
      _lastFrom         = null;
      console.debug(LOG, 'all stores cleared');
    });
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // ── Boot ────────────────────────────────────────────────────────────────────
  _openDB().then(function () {
    // Restore persisted state on boot
    return restore();
  }).then(function () {
    // Auto-save every 60s
    setInterval(function () { save(); }, AUTO_SAVE_MS);
  }).catch(function (e) {
    console.warn(LOG, 'boot error:', e.message || e);
  });

  // Observe arc9:tool-recorded to build local transition table for persistence
  G.addEventListener('arc9:tool-recorded', function (e) {
    var toolId = e && e.detail && e.detail.toolId;
    if (!toolId) return;
    if (_lastFrom && _lastFrom !== toolId) {
      if (!_localTransitions[_lastFrom]) _localTransitions[_lastFrom] = {};
      _localTransitions[_lastFrom][toolId] = (_localTransitions[_lastFrom][toolId] || 0) + 1;
    }
    _lastFrom = toolId;
  });

  G.RuntimeToolPersistence = Object.freeze({
    save:       save,
    restore:    restore,
    clear:      clear,
    getMetrics: getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-circuit-breaker.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolCircuitBreaker) return;

  var LOG = '[Arc13:CircuitBreaker]';

  var STATE_CLOSED    = 'CLOSED';
  var STATE_OPEN      = 'OPEN';
  var STATE_HALF_OPEN = 'HALF_OPEN';

  // Per-tool breaker state
  // _breakers[toolId] = { state, openedAt, halfOpenAt, testRequest, windowFailures, windowTs }
  var _breakers = {};
  var _metrics  = { opened: 0, closed: 0, halfOpened: 0, denied: 0 };

  var FAILURE_RATE_THRESH  = 0.20;   // 20% failure rate triggers OPEN
  var CRASH_COUNT_THRESH   = 5;      // 5 crashes in window triggers OPEN
  var CRASH_WINDOW_MS      = 10 * 60 * 1000; // 10 minutes
  var HALF_OPEN_DELAY_MS   = 30 * 1000;      // 30s before half-open probe
  var SUCCESS_TO_CLOSE     = 2;              // consecutive successes to re-close

  function _breaker(toolId) {
    if (!_breakers[toolId]) {
      _breakers[toolId] = {
        state:         STATE_CLOSED,
        openedAt:      0,
        halfOpenAt:    0,
        consecutiveOk: 0,
        windowFailures: 0,
        windowTs:      Date.now(),
        crashWindow:   [],   // timestamps of crashes in window
      };
    }
    return _breakers[toolId];
  }

  function _dispatch(event, detail) {
    try { G.dispatchEvent(new CustomEvent(event, { detail: detail })); } catch (_) {}
  }

  function _open(toolId, reason) {
    var b = _breaker(toolId);
    if (b.state === STATE_OPEN) return;
    b.state         = STATE_OPEN;
    b.openedAt      = Date.now();
    b.consecutiveOk = 0;
    _metrics.opened++;
    console.warn(LOG, 'OPEN:', toolId, '—', reason);
    _dispatch('arc13:circuit-opened', { toolId: toolId, reason: reason, ts: b.openedAt });
    // Schedule half-open probe
    setTimeout(function () { _halfOpen(toolId); }, HALF_OPEN_DELAY_MS);
  }

  function _halfOpen(toolId) {
    var b = _breaker(toolId);
    if (b.state !== STATE_OPEN) return;
    b.state      = STATE_HALF_OPEN;
    b.halfOpenAt = Date.now();
    _metrics.halfOpened++;
    console.debug(LOG, 'HALF_OPEN:', toolId);
    _dispatch('arc13:circuit-half-open', { toolId: toolId, ts: b.halfOpenAt });
  }

  function _close(toolId) {
    var b = _breaker(toolId);
    if (b.state === STATE_CLOSED) return;
    b.state         = STATE_CLOSED;
    b.consecutiveOk = 0;
    b.windowFailures = 0;
    b.crashWindow    = [];
    _metrics.closed++;
    console.debug(LOG, 'CLOSED:', toolId);
    _dispatch('arc13:circuit-closed', { toolId: toolId, ts: Date.now() });
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getState(toolId) {
    return _breaker(toolId).state;
  }

  function canExecute(toolId) {
    var b = _breaker(toolId);
    if (b.state === STATE_CLOSED) return true;
    if (b.state === STATE_HALF_OPEN) {
      // Allow exactly one test request
      if (!b.testPending) {
        b.testPending = true;
        return true;
      }
      _metrics.denied++;
      return false;
    }
    // STATE_OPEN — check if half-open delay has elapsed
    if (Date.now() - b.openedAt >= HALF_OPEN_DELAY_MS) {
      _halfOpen(toolId);
      b.testPending = true;
      return true;
    }
    _metrics.denied++;
    return false;
  }

  function recordSuccess(toolId) {
    var b = _breaker(toolId);
    b.testPending   = false;
    b.consecutiveOk++;
    if (b.state === STATE_HALF_OPEN && b.consecutiveOk >= SUCCESS_TO_CLOSE) {
      _close(toolId);
    } else if (b.state === STATE_CLOSED) {
      b.windowFailures = Math.max(0, b.windowFailures - 1);
    }
  }

  function recordFailure(toolId, opts) {
    var b   = _breaker(toolId);
    var now = Date.now();
    opts    = opts || {};
    b.testPending    = false;
    b.consecutiveOk  = 0;

    // Slide crash window
    b.crashWindow = b.crashWindow.filter(function (t) { return now - t < CRASH_WINDOW_MS; });
    if (opts.crash) b.crashWindow.push(now);

    // Count failures in rate window (reset every 60s)
    if (now - b.windowTs > 60000) { b.windowFailures = 0; b.windowTs = now; }
    b.windowFailures++;

    if (b.state === STATE_HALF_OPEN) {
      _open(toolId, 'half-open test failed');
      return;
    }
    if (b.state === STATE_OPEN) return;

    // Evaluate triggers
    var tool = G.RuntimeToolRegistry && G.RuntimeToolRegistry.getTool
      ? G.RuntimeToolRegistry.getTool(toolId) : null;
    var total    = tool ? (tool.successes + tool.failures) : 0;
    var failRate = total > 10 ? (tool.failures / total) : 0;
    var health   = G.RuntimeToolHealth && G.RuntimeToolHealth.getHealth
      ? G.RuntimeToolHealth.getHealth(toolId) : null;
    var isCritical = health && health.level === 'CRITICAL';

    if (b.crashWindow.length >= CRASH_COUNT_THRESH)         { _open(toolId, 'crash threshold'); return; }
    if (failRate > FAILURE_RATE_THRESH && total > 10)        { _open(toolId, 'failure rate ' + Math.round(failRate * 100) + '%'); return; }
    if (isCritical)                                          { _open(toolId, 'health CRITICAL'); return; }
  }

  function getAll() {
    var result = {};
    Object.keys(_breakers).forEach(function (id) {
      var b = _breakers[id];
      result[id] = {
        state:          b.state,
        openedAt:       b.openedAt,
        consecutiveOk:  b.consecutiveOk,
        crashesInWindow: b.crashWindow.length,
      };
    });
    return result;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // ── Listen to Arc 12 events ─────────────────────────────────────────────────
  G.addEventListener('arc12:metrics-updated', function (e) {
    var d = e && e.detail;
    if (!d || !d.toolId) return;
    var t = G.RuntimeToolRegistry && G.RuntimeToolRegistry.getTool
      ? G.RuntimeToolRegistry.getTool(d.toolId) : null;
    if (!t) return;
    if (d.crash || (t.crashCount > 0 && d.failure)) {
      recordFailure(d.toolId, { crash: !!d.crash });
    } else if (d.success) {
      recordSuccess(d.toolId);
    }
  });

  G.addEventListener('arc12:health-refreshed', function (e) {
    var scores = e && e.detail && e.detail.scores;
    if (!scores) return;
    Object.keys(scores).forEach(function (id) {
      if (scores[id].level === 'CRITICAL') {
        recordFailure(id, {});
      }
    });
  });

  G.RuntimeToolCircuitBreaker = Object.freeze({
    getState:      getState,
    canExecute:    canExecute,
    recordSuccess: recordSuccess,
    recordFailure: recordFailure,
    getAll:        getAll,
    getMetrics:    getMetrics,
    STATES: Object.freeze({ CLOSED: STATE_CLOSED, OPEN: STATE_OPEN, HALF_OPEN: STATE_HALF_OPEN }),
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-sla.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolSLA) return;

  var LOG = '[Arc13:SLA]';

  // Default SLA targets (ms / mb / score)
  var DEFAULTS = {
    startupMs:   { p50: 500,  p90: 1500,  p99: 3000  },
    executionMs: { p50: 2000, p90: 6000,  p99: 15000 },
    memoryMb:    { p50: 50,   p90: 150,   p99: 300   },
    thermal:     { p50: 30,   p90: 60,    p99: 80    },
  };

  var _slas       = {};   // toolId → { startupMs, executionMs, memoryMb, thermal } (override targets)
  var _violations = [];   // { toolId, metric, percentile, actual, target, ts }
  var _metrics    = { checked: 0, violated: 0, critical: 0 };
  var MAX_VIOL    = 200;
  var CHECK_MS    = 45 * 1000;   // check every 45s

  function _getSLA(toolId) {
    return _slas[toolId] || DEFAULTS;
  }

  function setSLA(toolId, sla) {
    _slas[toolId] = Object.assign({}, DEFAULTS, sla);
    console.debug(LOG, 'SLA configured:', toolId, _slas[toolId]);
  }

  function getSLA(toolId) {
    return Object.assign({}, _getSLA(toolId));
  }

  function _record(toolId, metric, percentile, actual, target) {
    var critical = actual > target * 2;
    _violations.push({ toolId: toolId, metric: metric, percentile: percentile,
      actual: actual, target: target, critical: critical, ts: Date.now() });
    if (_violations.length > MAX_VIOL) _violations.shift();
    _metrics.violated++;
    if (critical) _metrics.critical++;

    // Fire event
    try {
      G.dispatchEvent(new CustomEvent('arc13:sla-violated', {
        detail: { toolId: toolId, metric: metric, percentile: percentile,
                  actual: actual, target: target, critical: critical },
      }));
    } catch (_) {}

    // Raise incident for critical SLA breaches
    if (critical) {
      var ic = G.RuntimeIncidentCorrelation;
      if (ic && ic.raise) {
        try {
          ic.raise({ severity: 'P2', source: 'arc13:sla',
            message: toolId + ' SLA critical breach: ' + metric + ' p' + percentile + ' = ' + actual.toFixed(0) });
        } catch (_) {}
      }
      // Trigger circuit breaker on critical breach
      var cb = G.RuntimeToolCircuitBreaker;
      if (cb && cb.recordFailure) {
        try { cb.recordFailure(toolId, {}); } catch (_) {}
      }
    }
    console.warn(LOG, toolId, metric, 'p' + percentile, 'violated:', actual.toFixed(0), '>', target, critical ? '(CRITICAL)' : '');
  }

  // ── Check one tool ───────────────────────────────────────────────────────────
  function checkTool(toolId) {
    _metrics.checked++;
    var profiler = G.RuntimeToolProfiler;
    if (!profiler || !profiler.getProfile) return;
    var profile = profiler.getProfile(toolId);
    if (!profile) return;
    var sla = _getSLA(toolId);

    var checks = [
      { metric: 'startupMs',   data: profile.startupMs   },
      { metric: 'executionMs', data: profile.executionMs  },
      { metric: 'memoryMb',    data: profile.memoryMb     },
      { metric: 'thermal',     data: profile.thermal      },
    ];

    checks.forEach(function (c) {
      if (!c.data || !sla[c.metric]) return;
      var t = sla[c.metric];
      if (c.data.p50 != null && t.p50 != null && c.data.p50 > t.p50) _record(toolId, c.metric, 50, c.data.p50, t.p50);
      if (c.data.p90 != null && t.p90 != null && c.data.p90 > t.p90) _record(toolId, c.metric, 90, c.data.p90, t.p90);
      if (c.data.p99 != null && t.p99 != null && c.data.p99 > t.p99) _record(toolId, c.metric, 99, c.data.p99, t.p99);
    });
  }

  function checkAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg || !reg.getAllTools) return;
    reg.getAllTools().forEach(function (t) { checkTool(t.id); });
  }

  function getViolations(toolId) {
    if (toolId) return _violations.filter(function (v) { return v.toolId === toolId; });
    return _violations.slice();
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-check every 45s
  setTimeout(function _tick() {
    checkAll();
    setTimeout(_tick, CHECK_MS);
  }, CHECK_MS);

  G.RuntimeToolSLA = Object.freeze({
    setSLA:       setSLA,
    getSLA:       getSLA,
    checkTool:    checkTool,
    checkAll:     checkAll,
    getViolations: getViolations,
    getMetrics:   getMetrics,
    DEFAULTS:     Object.freeze(JSON.parse(JSON.stringify(DEFAULTS))),
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-discovery.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolDiscovery) return;

  var LOG = '[Arc13:Discovery]';

  // Sequence observation
  // _counts[fromTool][toTool] = { occurrences, total, confidence }
  var _counts     = {};   // co-occurrence counts
  var _totals     = {};   // total transitions from each tool
  var _discovered = [];   // { fromTool, toTool, confidence, addedAt }
  var _lastTool   = null;
  var _metrics    = { observed: 0, discovered: 0, promoted: 0 };

  var CONFIDENCE_THRESH = 0.80;   // 80% confidence to add dependency
  var MIN_OBSERVATIONS  = 5;      // need at least 5 transitions to evaluate

  function _observe(toTool) {
    if (!_lastTool || _lastTool === toTool) { _lastTool = toTool; return; }
    var from = _lastTool;
    _lastTool = toTool;
    _metrics.observed++;

    if (!_counts[from])      _counts[from]       = {};
    if (!_counts[from][toTool]) _counts[from][toTool] = 0;
    if (!_totals[from])      _totals[from]        = 0;

    _counts[from][toTool]++;
    _totals[from]++;

    // Evaluate confidence
    var occ   = _counts[from][toTool];
    var total = _totals[from];
    if (total < MIN_OBSERVATIONS) return;
    var conf  = occ / total;

    if (conf >= CONFIDENCE_THRESH) {
      _promote(from, toTool, conf);
    }
  }

  function _promote(fromTool, toTool, confidence) {
    // Already promoted?
    var exists = _discovered.some(function (d) {
      return d.fromTool === fromTool && d.toTool === toTool;
    });
    if (exists) {
      // Update confidence
      _discovered.forEach(function (d) {
        if (d.fromTool === fromTool && d.toTool === toTool) {
          d.confidence = confidence;
          d.updatedAt  = Date.now();
        }
      });
      return;
    }

    var entry = { fromTool: fromTool, toTool: toTool, confidence: confidence, addedAt: Date.now() };
    _discovered.push(entry);
    _metrics.discovered++;
    console.debug(LOG, 'discovered dependency:', fromTool, '→', toTool,
      '(' + Math.round(confidence * 100) + '% confidence)');

    // Add to RuntimeToolDependencies
    var dep = G.RuntimeToolDependencies;
    if (dep && dep.addDependency) {
      try {
        dep.addDependency(fromTool, toTool);
        _metrics.promoted++;
        G.dispatchEvent(new CustomEvent('arc13:dependency-discovered', {
          detail: { fromTool: fromTool, toTool: toTool, confidence: confidence },
        }));
      } catch (_) {}
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getSequences() {
    var result = [];
    Object.keys(_counts).forEach(function (from) {
      Object.keys(_counts[from]).forEach(function (to) {
        var occ  = _counts[from][to];
        var total = _totals[from] || 1;
        result.push({
          fromTool:     from,
          toTool:       to,
          occurrences:  occ,
          total:        total,
          confidence:   occ / total,
        });
      });
    });
    return result.sort(function (a, b) { return b.confidence - a.confidence; });
  }

  function getConfidence(fromTool, toTool) {
    var occ   = (_counts[fromTool] && _counts[fromTool][toTool]) || 0;
    var total = _totals[fromTool] || 0;
    return total > 0 ? occ / total : 0;
  }

  function getDiscovered() { return _discovered.slice(); }

  function getMetrics() { return Object.assign({}, _metrics); }

  // ── Listen to arc9:tool-recorded ─────────────────────────────────────────────
  G.addEventListener('arc9:tool-recorded', function (e) {
    var toolId = e && e.detail && e.detail.toolId;
    if (toolId) _observe(toolId);
  });

  G.RuntimeToolDiscovery = Object.freeze({
    getSequences:    getSequences,
    getConfidence:   getConfidence,
    getDiscovered:   getDiscovered,
    getMetrics:      getMetrics,
    CONFIDENCE_THRESH: CONFIDENCE_THRESH,
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-ranking.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolRanking) return;

  var LOG = '[Arc13:Ranking]';

  // Weighted score formula (sums to 1.0)
  var W_USAGE    = 0.40;
  var W_SUCCESS  = 0.30;
  var W_LATENCY  = 0.20;
  var W_RECOVERY = 0.10;

  var _scores   = {};   // toolId → { score, usage, success, latency, recovery, rank }
  var _metrics  = { computed: 0, lastComputedTs: 0 };
  var REFRESH_MS = 90 * 1000;   // recompute every 90s

  // ── Score computation ────────────────────────────────────────────────────────
  function _computeAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg || !reg.getAllTools) return;
    var tools = reg.getAllTools();
    if (!tools.length) return;

    // Gather raw values
    var rawLaunches = tools.map(function (t) { return t.launches || 0; });
    var maxLaunches = Math.max.apply(null, rawLaunches) || 1;
    var rawLatency  = tools.map(function (t) { return t.avgExecutionMs || 0; });
    var maxLatency  = Math.max.apply(null, rawLatency) || 1;

    var scored = tools.map(function (t) {
      var launches  = t.launches || 0;
      var successes = t.successes || 0;
      var failures  = t.failures  || 0;
      var total     = successes + failures;
      var crashCnt  = t.crashCount || 0;

      // Usage score 0-100: normalized launches
      var usageScore = (launches / maxLaunches) * 100;

      // Success rate score 0-100
      var successScore = total > 0 ? (successes / total) * 100 : 50;

      // Latency score 0-100: lower latency = higher score
      var lat = t.avgExecutionMs || 0;
      var latencyScore = lat > 0 ? Math.max(0, 100 - (lat / maxLatency) * 100) : 50;

      // Recovery score 0-100: fewer crashes = higher score
      var recScore = Math.max(0, 100 - crashCnt * 10);

      // Weighted composite
      var composite = usageScore  * W_USAGE
                    + successScore * W_SUCCESS
                    + latencyScore * W_LATENCY
                    + recScore     * W_RECOVERY;

      return {
        id:            t.id,
        score:         Math.round(composite * 10) / 10,
        usageScore:    Math.round(usageScore),
        successScore:  Math.round(successScore),
        latencyScore:  Math.round(latencyScore),
        recoveryScore: Math.round(recScore),
        launches:      launches,
        successRate:   total > 0 ? Math.round((successes / total) * 100) : null,
        avgExecutionMs: lat,
      };
    });

    // Assign global rank by composite score
    scored.sort(function (a, b) { return b.score - a.score; });
    scored.forEach(function (s, i) { s.rank = i + 1; });

    _scores = {};
    scored.forEach(function (s) { _scores[s.id] = s; });
    _metrics.computed++;
    _metrics.lastComputedTs = Date.now();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getScore(toolId) {
    if (!_scores[toolId]) _computeAll();
    return _scores[toolId] ? Object.assign({}, _scores[toolId]) : null;
  }

  function getRankings() {
    if (!Object.keys(_scores).length) _computeAll();
    return Object.keys(_scores).map(function (id) { return Object.assign({}, _scores[id]); })
      .sort(function (a, b) { return a.rank - b.rank; });
  }

  function getTopN(n) {
    return getRankings().slice(0, n || 10);
  }

  function getMostReliable(n) {
    return getRankings().sort(function (a, b) {
      return (b.successRate || 0) - (a.successRate || 0);
    }).slice(0, n || 10);
  }

  function getFastest(n) {
    return getRankings().filter(function (t) { return t.avgExecutionMs > 0; })
      .sort(function (a, b) { return a.avgExecutionMs - b.avgExecutionMs; })
      .slice(0, n || 10);
  }

  function forceRefresh() { _computeAll(); }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-refresh
  setTimeout(function _tick() {
    _computeAll();
    setTimeout(_tick, REFRESH_MS);
  }, REFRESH_MS);

  // Recompute on registry updates
  G.addEventListener('arc12:metrics-updated', function () {
    // Debounced — only recompute if last compute > 5s ago
    if (Date.now() - _metrics.lastComputedTs > 5000) _computeAll();
  });

  G.RuntimeToolRanking = Object.freeze({
    getScore:       getScore,
    getRankings:    getRankings,
    getTopN:        getTopN,
    getMostReliable: getMostReliable,
    getFastest:     getFastest,
    forceRefresh:   forceRefresh,
    getMetrics:     getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-anomaly.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolAnomaly) return;

  var LOG = '[Arc13:Anomaly]';

  // Multiplier thresholds
  var ANOMALY_MULT       = 2.0;   // 2× baseline = anomaly
  var CRITICAL_MULT      = 3.0;   // 3× baseline = critical anomaly
  var FAILURE_SPIKE_MULT = 3.0;   // failure rate 3× normal = spike
  var CHECK_MS           = 60 * 1000;   // check every 60s

  // Per-tool baselines built from first N samples
  var _baselines = {};   // toolId → { startupMs, memoryMb, thermal, failureRate }
  var _anomalies = [];   // active/recent anomalies (capped at 100)
  var _metrics   = { detected: 0, critical: 0, cleared: 0 };
  var MAX_ANOMS  = 100;

  function _baseline(toolId) {
    if (!_baselines[toolId]) _baselines[toolId] = { startupMs: 0, memoryMb: 0, thermal: 0, failureRate: 0, samples: 0 };
    return _baselines[toolId];
  }

  function _dispatch(event, detail) {
    try { G.dispatchEvent(new CustomEvent(event, { detail: detail })); } catch (_) {}
  }

  function _raiseIncident(severity, toolId, message) {
    try {
      var ic = G.RuntimeIncidentCorrelation;
      if (ic && ic.raise) ic.raise({ severity: severity, source: 'arc13:anomaly', message: message });
    } catch (_) {}
  }

  function _record(toolId, type, metric, actual, baseline, severity) {
    var anom = {
      toolId:   toolId,
      type:     type,       // 'startup' | 'memory' | 'thermal' | 'failure-spike'
      metric:   metric,
      actual:   actual,
      baseline: baseline,
      ratio:    baseline > 0 ? actual / baseline : 0,
      severity: severity,   // 'P1' | 'P2'
      ts:       Date.now(),
    };
    _anomalies.push(anom);
    if (_anomalies.length > MAX_ANOMS) _anomalies.shift();
    _metrics.detected++;
    if (severity === 'P1') _metrics.critical++;
    console.warn(LOG, severity, toolId, type, ':', actual.toFixed(0), 'vs baseline', baseline.toFixed(0));
    _dispatch('arc13:anomaly-detected', anom);
    _raiseIncident(severity, toolId, toolId + ' anomaly — ' + type + ': ' + actual.toFixed(0) + ' (baseline ' + baseline.toFixed(0) + ')');
  }

  // ── Check one tool ────────────────────────────────────────────────────────────
  function checkTool(toolId) {
    var profiler = G.RuntimeToolProfiler;
    var reg      = G.RuntimeToolRegistry;
    if (!profiler || !reg) return;

    var profile = profiler.getProfile && profiler.getProfile(toolId);
    var tool    = reg.getTool && reg.getTool(toolId);
    if (!profile || !tool) return;

    var b = _baseline(toolId);

    // Build/update baseline on first few samples (warm-up: 3 cycles)
    if (b.samples < 3) {
      if (profile.startupMs  && profile.startupMs.p50)   b.startupMs   = profile.startupMs.p50;
      if (profile.memoryMb   && profile.memoryMb.p50)    b.memoryMb    = profile.memoryMb.p50;
      if (profile.thermal    && profile.thermal.p50)      b.thermal     = profile.thermal.p50;
      var total = (tool.successes || 0) + (tool.failures || 0);
      b.failureRate = total > 0 ? (tool.failures / total) : 0;
      b.samples++;
      return;
    }

    // Startup anomaly
    if (b.startupMs > 0 && profile.startupMs && profile.startupMs.p90) {
      var ratio = profile.startupMs.p90 / b.startupMs;
      if (ratio >= CRITICAL_MULT) _record(toolId, 'startup', 'startupMs', profile.startupMs.p90, b.startupMs, 'P1');
      else if (ratio >= ANOMALY_MULT) _record(toolId, 'startup', 'startupMs', profile.startupMs.p90, b.startupMs, 'P2');
    }

    // Memory anomaly
    if (b.memoryMb > 0 && profile.memoryMb && profile.memoryMb.p90) {
      var mRatio = profile.memoryMb.p90 / b.memoryMb;
      if (mRatio >= CRITICAL_MULT) _record(toolId, 'memory', 'memoryMb', profile.memoryMb.p90, b.memoryMb, 'P1');
      else if (mRatio >= ANOMALY_MULT) _record(toolId, 'memory', 'memoryMb', profile.memoryMb.p90, b.memoryMb, 'P2');
    }

    // Thermal anomaly
    if (b.thermal > 0 && profile.thermal && profile.thermal.p90) {
      var tRatio = profile.thermal.p90 / b.thermal;
      if (tRatio >= CRITICAL_MULT) _record(toolId, 'thermal', 'thermal', profile.thermal.p90, b.thermal, 'P1');
      else if (tRatio >= ANOMALY_MULT) _record(toolId, 'thermal', 'thermal', profile.thermal.p90, b.thermal, 'P2');
    }

    // Failure spike
    var totalNow  = (tool.successes || 0) + (tool.failures || 0);
    var failNow   = totalNow > 0 ? (tool.failures / totalNow) : 0;
    if (b.failureRate > 0 && failNow / b.failureRate >= FAILURE_SPIKE_MULT && totalNow > 10) {
      _record(toolId, 'failure-spike', 'failureRate',
        Math.round(failNow * 100), Math.round(b.failureRate * 100), 'P1');
    }
  }

  function checkAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg || !reg.getAllTools) return;
    reg.getAllTools().forEach(function (t) { checkTool(t.id); });
  }

  function getAnomalies(toolId) {
    if (toolId) return _anomalies.filter(function (a) { return a.toolId === toolId; });
    return _anomalies.slice();
  }

  function clearAnomalies(toolId) {
    var before = _anomalies.length;
    if (toolId) {
      for (var i = _anomalies.length - 1; i >= 0; i--) {
        if (_anomalies[i].toolId === toolId) _anomalies.splice(i, 1);
      }
    } else {
      _anomalies.length = 0;
    }
    _metrics.cleared += before - _anomalies.length;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-check
  setTimeout(function _tick() {
    checkAll();
    setTimeout(_tick, CHECK_MS);
  }, CHECK_MS);

  G.RuntimeToolAnomaly = Object.freeze({
    checkTool:    checkTool,
    checkAll:     checkAll,
    getAnomalies: getAnomalies,
    clearAnomalies: clearAnomalies,
    getMetrics:   getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-lifecycle.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolLifecycle) return;

  var LOG = '[Arc13:Lifecycle]';

  var STATE_NEW     = 'NEW';
  var STATE_ACTIVE  = 'ACTIVE';
  var STATE_HOT     = 'HOT';
  var STATE_WARM    = 'WARM';
  var STATE_COLD    = 'COLD';
  var STATE_DORMANT = 'DORMANT';
  var STATE_RETIRED = 'RETIRED';

  // Thresholds
  var HOT_LAUNCHES    = 20;           // ≥20 launches → HOT
  var WARM_LAUNCHES   = 5;            // ≥5 launches → WARM
  var COLD_LAUNCHES   = 1;            // ≥1 launch  → COLD  (else NEW)
  var DORMANT_DAYS    = 14;           // no use for 14 days → DORMANT
  var RETIRED_DAYS    = 90;           // no use for 90 days → RETIRED
  var EVAL_MS         = 5 * 60 * 1000;  // re-evaluate every 5 min
  var MS_PER_DAY      = 86400000;

  var _states  = {};   // toolId → { state, enteredAt, previousState, transitions }
  var _metrics = { transitions: 0, retired: 0, activated: 0 };

  function _state(toolId) {
    if (!_states[toolId]) {
      _states[toolId] = { state: STATE_NEW, enteredAt: Date.now(), previousState: null, transitions: [] };
    }
    return _states[toolId];
  }

  function _dispatch(toolId, from, to) {
    try {
      G.dispatchEvent(new CustomEvent('arc13:lifecycle-transition', {
        detail: { toolId: toolId, from: from, to: to, ts: Date.now() },
      }));
    } catch (_) {}
  }

  function transition(toolId, newState) {
    var s = _state(toolId);
    if (s.state === newState) return;
    var prev = s.state;
    s.previousState = prev;
    s.state         = newState;
    s.enteredAt     = Date.now();
    s.transitions.push({ from: prev, to: newState, ts: Date.now() });
    if (s.transitions.length > 20) s.transitions.shift();
    _metrics.transitions++;
    if (newState === STATE_RETIRED) _metrics.retired++;
    if (newState === STATE_ACTIVE || newState === STATE_HOT) _metrics.activated++;
    console.debug(LOG, toolId + ':', prev, '→', newState);
    _dispatch(toolId, prev, newState);
  }

  // ── Evaluate one tool ────────────────────────────────────────────────────────
  function _evaluate(tool) {
    var id       = tool.id;
    var launches = tool.launches || 0;
    var lastUse  = tool.lastUsedAt || 0;   // ms timestamp (may be 0 if never)
    var daysSince = lastUse > 0 ? (Date.now() - lastUse) / MS_PER_DAY : Infinity;

    var target;
    if (daysSince >= RETIRED_DAYS)     { target = STATE_RETIRED; }
    else if (daysSince >= DORMANT_DAYS){ target = STATE_DORMANT; }
    else if (launches === 0)           { target = STATE_NEW; }
    else if (launches >= HOT_LAUNCHES) { target = STATE_HOT; }
    else if (launches >= WARM_LAUNCHES){ target = STATE_WARM; }
    else if (launches >= COLD_LAUNCHES){ target = STATE_COLD; }
    else                               { target = STATE_ACTIVE; }

    transition(id, target);
  }

  function evaluateAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg || !reg.getAllTools) return;
    reg.getAllTools().forEach(_evaluate);
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getState(toolId) {
    var s = _state(toolId);
    return Object.assign({}, s);
  }

  function getAllStates() {
    var result = {};
    Object.keys(_states).forEach(function (id) { result[id] = Object.assign({}, _states[id]); });
    return result;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-evaluate
  setTimeout(function _tick() {
    evaluateAll();
    setTimeout(_tick, EVAL_MS);
  }, EVAL_MS);

  // React to registry updates
  G.addEventListener('arc12:metrics-updated', function (e) {
    var toolId = e && e.detail && e.detail.toolId;
    if (!toolId) return;
    var reg  = G.RuntimeToolRegistry;
    var tool = reg && reg.getTool ? reg.getTool(toolId) : null;
    if (tool) _evaluate(tool);
  });

  G.RuntimeToolLifecycle = Object.freeze({
    transition:   transition,
    getState:     getState,
    getAllStates:  getAllStates,
    evaluateAll:  evaluateAll,
    getMetrics:   getMetrics,
    STATES: Object.freeze({
      NEW: STATE_NEW, ACTIVE: STATE_ACTIVE, HOT: STATE_HOT, WARM: STATE_WARM,
      COLD: STATE_COLD, DORMANT: STATE_DORMANT, RETIRED: STATE_RETIRED,
    }),
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-insights.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolInsights) return;

  var LOG = '[Arc13:Insights]';

  var _insights   = [];   // { id, toolId, type, message, severity, ts }
  var _metrics    = { generated: 0, cleared: 0 };
  var _idSeq      = 0;
  var MAX_INSIGHTS = 50;
  var REFRESH_MS  = 2 * 60 * 1000;   // generate every 2 min

  // Baselines for trend detection
  var _prevStartup = {};   // toolId → prev p90 startupMs

  function _id() { return 'ins-' + (++_idSeq); }

  function _add(toolId, type, message, severity) {
    severity = severity || 'info';
    var ins = { id: _id(), toolId: toolId || null, type: type, message: message, severity: severity, ts: Date.now() };
    _insights.unshift(ins);
    if (_insights.length > MAX_INSIGHTS) _insights.pop();
    _metrics.generated++;
    console.debug(LOG, '[' + severity + ']', message);
    try {
      G.dispatchEvent(new CustomEvent('arc13:insight-generated', { detail: ins }));
    } catch (_) {}
    return ins;
  }

  // ── Generators ────────────────────────────────────────────────────────────────

  function _insightsFromAnomalies() {
    var anm = G.RuntimeToolAnomaly;
    if (!anm || !anm.getAnomalies) return;
    var recent = anm.getAnomalies().filter(function (a) { return Date.now() - a.ts < REFRESH_MS * 2; });
    var seen   = {};
    recent.forEach(function (a) {
      var key = a.toolId + ':' + a.type;
      if (seen[key]) return;
      seen[key] = true;
      var pct  = a.baseline > 0 ? Math.round((a.actual / a.baseline - 1) * 100) : 0;
      var msg;
      if (a.type === 'startup')       msg = a.toolId + ' startup time increased ' + pct + '% above baseline.';
      else if (a.type === 'memory')   msg = a.toolId + ' memory usage spiked ' + pct + '% above normal.';
      else if (a.type === 'thermal')  msg = a.toolId + ' thermal score elevated ' + pct + '% — consider cooling interval.';
      else if (a.type === 'failure-spike') msg = a.toolId + ' failure rate spiked ' + pct + '% — check bundle health.';
      else msg = a.toolId + ' anomaly detected: ' + a.type + '.';
      _add(a.toolId, 'anomaly', msg, a.severity === 'P1' ? 'critical' : 'warning');
    });
  }

  function _insightsFromCircuitBreakers() {
    var cb = G.RuntimeToolCircuitBreaker;
    if (!cb || !cb.getAll) return;
    var all = cb.getAll();
    Object.keys(all).forEach(function (id) {
      var b = all[id];
      if (b.state === 'OPEN') {
        _add(id, 'circuit-breaker', id + ' circuit breaker is OPEN — executions are being blocked.', 'critical');
      } else if (b.state === 'HALF_OPEN') {
        _add(id, 'circuit-breaker', id + ' circuit breaker is in HALF_OPEN state — monitoring recovery.', 'warning');
      }
    });
  }

  function _insightsFromSLA() {
    var sla = G.RuntimeToolSLA;
    if (!sla || !sla.getViolations) return;
    var recent = sla.getViolations().filter(function (v) { return Date.now() - v.ts < REFRESH_MS * 2 && v.critical; });
    var seen   = {};
    recent.forEach(function (v) {
      var key = v.toolId + ':' + v.metric;
      if (seen[key]) return;
      seen[key] = true;
      _add(v.toolId, 'sla', v.toolId + ' critically breached ' + v.metric + ' SLA: ' +
        v.actual.toFixed(0) + ' vs target ' + v.target + '.', 'critical');
    });
  }

  function _insightsFromLifecycle() {
    var lc = G.RuntimeToolLifecycle;
    if (!lc || !lc.getAllStates) return;
    var states = lc.getAllStates();
    Object.keys(states).forEach(function (id) {
      var s = states[id];
      if (s.state === 'DORMANT' && s.transitions.length > 0) {
        var last = s.transitions[s.transitions.length - 1];
        if (last && last.to === 'DORMANT' && Date.now() - last.ts < REFRESH_MS * 2) {
          _add(id, 'lifecycle', id + ' tool is becoming dormant — consider advisory unload or deprecation.', 'info');
        }
      }
      if (s.state === 'RETIRED') {
        _add(id, 'lifecycle', id + ' tool is RETIRED (no use in 90+ days) — may be removed safely.', 'warning');
      }
    });
  }

  function _insightsFromRanking() {
    var rank = G.RuntimeToolRanking;
    if (!rank || !rank.getTopN) return;
    var top = rank.getTopN(3);
    if (!top.length) return;
    var names = top.map(function (t) { return t.id; }).join(', ');
    _add(null, 'ranking', 'Top tools by enterprise score: ' + names + '. Consider ensuring these bundles are preloaded.', 'info');
  }

  function _insightsFromOptimizer() {
    var opt = G.RuntimeToolOptimizer;
    if (!opt || !opt.getMetrics) return;
    var m = opt.getMetrics();
    if (m.savingsMs > 5000) {
      _add(null, 'optimizer', 'Preloading hot tools has saved ~' + Math.round(m.savingsMs / 1000) + 's of startup latency this session.', 'info');
    }
    if (m.dormantAdvisories > 0) {
      _add(null, 'optimizer', m.dormantAdvisories + ' tools are candidates for advisory unload to free memory.', 'info');
    }
  }

  function _insightsFromProfiler() {
    var profiler = G.RuntimeToolProfiler;
    var reg      = G.RuntimeToolRegistry;
    if (!profiler || !reg) return;
    reg.getAllTools().forEach(function (t) {
      var p = profiler.getProfile && profiler.getProfile(t.id);
      if (!p || !p.startupMs) return;
      var prev = _prevStartup[t.id];
      if (prev && p.startupMs.p90 > 0 && prev > 0) {
        var pct = Math.round((p.startupMs.p90 / prev - 1) * 100);
        if (pct >= 40) {
          _add(t.id, 'startup-trend',
            t.id + ' startup time increased ' + pct + '% since last check — bundle may need preloading.', 'warning');
        }
      }
      if (p.startupMs.p90 > 0) _prevStartup[t.id] = p.startupMs.p90;
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function generateInsights() {
    _insightsFromAnomalies();
    _insightsFromCircuitBreakers();
    _insightsFromSLA();
    _insightsFromLifecycle();
    _insightsFromRanking();
    _insightsFromOptimizer();
    _insightsFromProfiler();
  }

  function getInsights(opts) {
    opts = opts || {};
    var result = _insights.slice();
    if (opts.toolId)   result = result.filter(function (i) { return i.toolId === opts.toolId; });
    if (opts.severity) result = result.filter(function (i) { return i.severity === opts.severity; });
    if (opts.type)     result = result.filter(function (i) { return i.type === opts.type; });
    return result;
  }

  function clearInsights(toolId) {
    var before = _insights.length;
    if (toolId) {
      for (var i = _insights.length - 1; i >= 0; i--) {
        if (_insights[i].toolId === toolId) { _insights.splice(i, 1); }
      }
    } else {
      _insights.length = 0;
    }
    _metrics.cleared += before - _insights.length;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // Auto-generate
  setTimeout(function _tick() {
    generateInsights();
    setTimeout(_tick, REFRESH_MS);
  }, REFRESH_MS);

  G.RuntimeToolInsights = Object.freeze({
    generateInsights: generateInsights,
    getInsights:      getInsights,
    clearInsights:    clearInsights,
    getMetrics:       getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/runtime-tool-export-extended.js ──
(function (G) {
  'use strict';
  if (G.RuntimeToolExportExtended) return;

  var LOG = '[Arc13:ExportExtended]';

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function _download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn(LOG, 'download failed:', e.message || e);
    }
  }

  function _csvRow(cells) {
    return cells.map(function (c) {
      var s = String(c == null ? '' : c);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }

  function _ts() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  }

  // ── Section collectors ───────────────────────────────────────────────────────
  function _collectSLA() {
    var sla = G.RuntimeToolSLA;
    return sla ? { violations: sla.getViolations(), metrics: sla.getMetrics(), defaults: sla.DEFAULTS } : null;
  }

  function _collectCircuitBreakers() {
    var cb = G.RuntimeToolCircuitBreaker;
    return cb ? { breakers: cb.getAll(), metrics: cb.getMetrics() } : null;
  }

  function _collectInsights() {
    var ins = G.RuntimeToolInsights;
    return ins ? { insights: ins.getInsights(), metrics: ins.getMetrics() } : null;
  }

  function _collectRankings() {
    var rank = G.RuntimeToolRanking;
    return rank ? { rankings: rank.getRankings(), metrics: rank.getMetrics() } : null;
  }

  function _collectPredictorHistory() {
    var pred = G.RuntimeToolPredictor;
    return pred && pred.getHistory ? { history: pred.getHistory() } : null;
  }

  function _collectDiscovery() {
    var disc = G.RuntimeToolDiscovery;
    return disc ? { sequences: disc.getSequences(), discovered: disc.getDiscovered(), metrics: disc.getMetrics() } : null;
  }

  function _collectAnomaly() {
    var anm = G.RuntimeToolAnomaly;
    return anm ? { anomalies: anm.getAnomalies(), metrics: anm.getMetrics() } : null;
  }

  function _collectLifecycle() {
    var lc = G.RuntimeToolLifecycle;
    return lc ? { states: lc.getAllStates(), metrics: lc.getMetrics() } : null;
  }

  function _collectPersistence() {
    var p = G.RuntimeToolPersistence;
    return p ? { metrics: p.getMetrics() } : null;
  }

  // ── Full JSON export ─────────────────────────────────────────────────────────
  function exportJSON(opts) {
    opts = opts || {};
    var payload = {
      exportedAt:      new Date().toISOString(),
      arc:             13,
      version:         '1.0',
      sla:             _collectSLA(),
      circuitBreakers: _collectCircuitBreakers(),
      insights:        _collectInsights(),
      rankings:        _collectRankings(),
      predictorHistory: _collectPredictorHistory(),
      discovery:       _collectDiscovery(),
      anomaly:         _collectAnomaly(),
      lifecycle:       _collectLifecycle(),
      persistence:     _collectPersistence(),
    };
    var json = JSON.stringify(payload, null, 2);
    if (!opts.noDownload) {
      _download('arc13-tool-intelligence-' + _ts() + '.json', json, 'application/json');
    }
    return json;
  }

  // ── SLA violations CSV ───────────────────────────────────────────────────────
  function exportSLACSV() {
    var sla = G.RuntimeToolSLA;
    if (!sla) { console.warn(LOG, 'RuntimeToolSLA not loaded'); return ''; }
    var viols = sla.getViolations();
    var header = _csvRow(['toolId', 'metric', 'percentile', 'actual', 'target', 'critical', 'ts']);
    var rows   = viols.map(function (v) {
      return _csvRow([v.toolId, v.metric, 'p' + v.percentile, v.actual, v.target, v.critical, new Date(v.ts).toISOString()]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc13-sla-violations-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Rankings CSV ─────────────────────────────────────────────────────────────
  function exportRankingsCSV() {
    var rank = G.RuntimeToolRanking;
    if (!rank) { console.warn(LOG, 'RuntimeToolRanking not loaded'); return ''; }
    var rankings = rank.getRankings();
    var header   = _csvRow(['rank', 'toolId', 'score', 'usageScore', 'successScore', 'latencyScore', 'recoveryScore', 'successRate', 'launches', 'avgExecutionMs']);
    var rows     = rankings.map(function (r) {
      return _csvRow([r.rank, r.id, r.score, r.usageScore, r.successScore, r.latencyScore, r.recoveryScore, r.successRate, r.launches, r.avgExecutionMs]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc13-tool-rankings-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Insights CSV ─────────────────────────────────────────────────────────────
  function exportInsightsCSV() {
    var ins = G.RuntimeToolInsights;
    if (!ins) { console.warn(LOG, 'RuntimeToolInsights not loaded'); return ''; }
    var insights = ins.getInsights();
    var header   = _csvRow(['id', 'toolId', 'type', 'severity', 'message', 'ts']);
    var rows     = insights.map(function (i) {
      return _csvRow([i.id, i.toolId || '', i.type, i.severity, i.message, new Date(i.ts).toISOString()]);
    });
    var csv = [header].concat(rows).join('\n');
    _download('arc13-tool-insights-' + _ts() + '.csv', csv, 'text/csv');
    return csv;
  }

  // ── Historical report (aggregated summary) ───────────────────────────────────
  function exportHistoricalReport() {
    var reg   = G.RuntimeToolRegistry;
    var rank  = G.RuntimeToolRanking;
    var sla   = G.RuntimeToolSLA;
    var cb    = G.RuntimeToolCircuitBreaker;
    var anm   = G.RuntimeToolAnomaly;
    var disc  = G.RuntimeToolDiscovery;
    var lc    = G.RuntimeToolLifecycle;

    var report = {
      generatedAt:  new Date().toISOString(),
      arc:          13,
      reportType:   'historical-summary',
      toolCount:    reg && reg.getAllTools ? reg.getAllTools().length : 0,
      topTools:     rank && rank.getTopN ? rank.getTopN(5) : [],
      slaMetrics:   sla && sla.getMetrics ? sla.getMetrics() : {},
      cbMetrics:    cb  && cb.getMetrics  ? cb.getMetrics()  : {},
      anomalyMetrics: anm && anm.getMetrics ? anm.getMetrics() : {},
      discoveredDeps: disc && disc.getDiscovered ? disc.getDiscovered().length : 0,
      lifecycleSummary: lc && lc.getAllStates ? (function () {
        var states = lc.getAllStates();
        var counts = {};
        Object.keys(states).forEach(function (id) {
          var s = states[id].state;
          counts[s] = (counts[s] || 0) + 1;
        });
        return counts;
      }()) : {},
    };

    var json = JSON.stringify(report, null, 2);
    _download('arc13-historical-report-' + _ts() + '.json', json, 'application/json');
    return json;
  }

  G.RuntimeToolExportExtended = Object.freeze({
    exportJSON:             exportJSON,
    exportSLACSV:           exportSLACSV,
    exportRankingsCSV:      exportRankingsCSV,
    exportInsightsCSV:      exportInsightsCSV,
    exportHistoricalReport: exportHistoricalReport,
  });

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/debug-panels/panel-tool-persistence.js ──
(function (G) {
  'use strict';
  if (G.PanelToolPersistence) return;

  function PanelToolPersistence(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
  }

  PanelToolPersistence.prototype.render = function (container) {
    this._el = container;
    container.innerHTML = '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<button id="p13per-save" style="padding:4px 10px;cursor:pointer">💾 Save Now</button>' +
      '<button id="p13per-restore" style="padding:4px 10px;cursor:pointer">📂 Restore</button>' +
      '<button id="p13per-clear" style="padding:4px 10px;cursor:pointer;color:red">🗑 Clear</button>' +
      '</div>' +
      '<div id="p13per-body"></div></div>';
    container.querySelector('#p13per-save').onclick    = function () {
      if (G.RuntimeToolPersistence) G.RuntimeToolPersistence.save();
    };
    container.querySelector('#p13per-restore').onclick = function () {
      if (G.RuntimeToolPersistence) G.RuntimeToolPersistence.restore();
    };
    container.querySelector('#p13per-clear').onclick   = function () {
      if (G.RuntimeToolPersistence) G.RuntimeToolPersistence.clear();
    };
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 5000);
  };

  PanelToolPersistence.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13per-body');
    if (!el) return;
    var p   = G.RuntimeToolPersistence;
    var reg = G.RuntimeToolRegistry;
    if (!p) { el.innerHTML = '<em>RuntimeToolPersistence not loaded</em>'; return; }
    var m   = p.getMetrics();
    var regCount = reg && reg.getAllTools ? reg.getAllTools().length : '?';
    var rows = [
      ['Database', 'tool-intelligence-v1 (IndexedDB)'],
      ['Stores', 'registry · predictor · recovery · optimizer'],
      ['Auto-save interval', '60 seconds'],
      ['Saves completed', m.saves],
      ['Restores completed', m.restores],
      ['Errors', m.errors],
      ['Last save', m.lastSaveTs ? new Date(m.lastSaveTs).toLocaleTimeString() : '—'],
      ['Last restore', m.lastRestoreTs ? new Date(m.lastRestoreTs).toLocaleTimeString() : '—'],
      ['Registry tools loaded', regCount],
    ];
    el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      rows.map(function (r) {
        return '<tr><td style="padding:3px 8px;color:#aaa;white-space:nowrap">' + r[0] + '</td>' +
               '<td style="padding:3px 8px;color:#eee">' + r[1] + '</td></tr>';
      }).join('') + '</table>';
  };

  PanelToolPersistence.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolPersistence = PanelToolPersistence;

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/debug-panels/panel-tool-circuit-breaker.js ──
(function (G) {
  'use strict';
  if (G.PanelToolCircuitBreaker) return;

  var STATE_COLOR = { CLOSED: '#2ecc71', OPEN: '#e74c3c', HALF_OPEN: '#f39c12' };

  function PanelToolCircuitBreaker(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._filter   = 'ALL';
  }

  PanelToolCircuitBreaker.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">' +
        '<span style="font-size:12px;color:#aaa">Filter:</span>' +
        ['ALL', 'CLOSED', 'OPEN', 'HALF_OPEN'].map(function (s) {
          return '<button data-state="' + s + '" style="padding:3px 8px;font-size:11px;cursor:pointer">' + s + '</button>';
        }).join('') +
      '</div>' +
      '<div id="p13cb-body"></div></div>';
    container.querySelectorAll('button[data-state]').forEach(function (btn) {
      btn.onclick = function () { self._filter = btn.dataset.state; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 3000);
  };

  PanelToolCircuitBreaker.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13cb-body');
    if (!el) return;
    var cb = G.RuntimeToolCircuitBreaker;
    if (!cb) { el.innerHTML = '<em>RuntimeToolCircuitBreaker not loaded</em>'; return; }
    var all     = cb.getAll();
    var m       = cb.getMetrics();
    var ids     = Object.keys(all).filter(function (id) {
      return this._filter === 'ALL' || all[id].state === this._filter;
    }, this);
    var summary = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">' +
      'Opened: <b style="color:#e74c3c">' + m.opened + '</b>  ' +
      'Closed: <b style="color:#2ecc71">' + m.closed + '</b>  ' +
      'Denied: <b style="color:#f39c12">' + m.denied + '</b></div>';
    if (!ids.length) { el.innerHTML = summary + '<em style="color:#888">No breakers in ' + this._filter + ' state</em>'; return; }
    var rows = ids.map(function (id) {
      var b   = all[id];
      var col = STATE_COLOR[b.state] || '#aaa';
      return '<tr>' +
        '<td style="padding:4px 8px;color:#eee">' + id + '</td>' +
        '<td style="padding:4px 8px"><span style="background:' + col + ';color:#000;padding:1px 6px;border-radius:3px;font-size:11px">' + b.state + '</span></td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:11px">' + (b.openedAt ? new Date(b.openedAt).toLocaleTimeString() : '—') + '</td>' +
        '<td style="padding:4px 8px;color:#aaa;font-size:11px">' + b.crashesInWindow + ' crashes/10m</td>' +
        '</tr>';
    }).join('');
    el.innerHTML = summary +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<tr style="color:#888;font-size:11px"><th align="left" style="padding:3px 8px">Tool</th>' +
      '<th align="left" style="padding:3px 8px">State</th>' +
      '<th align="left" style="padding:3px 8px">Opened At</th>' +
      '<th align="left" style="padding:3px 8px">Crashes (window)</th></tr>' +
      rows + '</table>';
  };

  PanelToolCircuitBreaker.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolCircuitBreaker = PanelToolCircuitBreaker;

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/debug-panels/panel-tool-sla.js ──
(function (G) {
  'use strict';
  if (G.PanelToolSLA) return;

  function PanelToolSLA(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._tab      = 'violations';
  }

  PanelToolSLA.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<button data-tab="violations" style="padding:3px 10px;cursor:pointer">Violations</button>' +
        '<button data-tab="targets" style="padding:3px 10px;cursor:pointer">Targets</button>' +
        '<button data-tab="metrics" style="padding:3px 10px;cursor:pointer">Metrics</button>' +
      '</div>' +
      '<div id="p13sla-body"></div></div>';
    container.querySelectorAll('button[data-tab]').forEach(function (btn) {
      btn.onclick = function () { self._tab = btn.dataset.tab; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 5000);
  };

  PanelToolSLA.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13sla-body');
    if (!el) return;
    var sla = G.RuntimeToolSLA;
    if (!sla) { el.innerHTML = '<em>RuntimeToolSLA not loaded</em>'; return; }

    if (this._tab === 'violations') {
      var viols = sla.getViolations();
      if (!viols.length) { el.innerHTML = '<em style="color:#888">No SLA violations recorded</em>'; return; }
      var rows  = viols.slice(-30).reverse().map(function (v) {
        var style = v.critical ? 'color:#e74c3c' : 'color:#f39c12';
        return '<tr>' +
          '<td style="padding:3px 8px;color:#eee">' + v.toolId + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + v.metric + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">p' + v.percentile + '</td>' +
          '<td style="padding:3px 8px;' + style + '">' + (v.actual || 0).toFixed(0) + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + v.target + '</td>' +
          '<td style="padding:3px 8px;color:#aaa;font-size:10px">' + new Date(v.ts).toLocaleTimeString() + '</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<tr style="color:#888;font-size:11px">' +
        '<th align="left" style="padding:3px 8px">Tool</th><th align="left" style="padding:3px 8px">Metric</th>' +
        '<th align="left" style="padding:3px 8px">Pct</th><th align="left" style="padding:3px 8px">Actual</th>' +
        '<th align="left" style="padding:3px 8px">Target</th><th align="left" style="padding:3px 8px">Time</th></tr>' +
        rows + '</table>';
    } else if (this._tab === 'targets') {
      var def = sla.DEFAULTS;
      var html = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">Default SLA targets (configurable per tool via setSLA)</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
      html += '<tr style="color:#888"><th align="left" style="padding:3px 8px">Metric</th>' +
        '<th align="left" style="padding:3px 8px">p50</th><th align="left" style="padding:3px 8px">p90</th>' +
        '<th align="left" style="padding:3px 8px">p99</th></tr>';
      Object.keys(def).forEach(function (k) {
        var t = def[k];
        html += '<tr><td style="padding:3px 8px;color:#eee">' + k + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + t.p50 + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + t.p90 + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + t.p99 + '</td></tr>';
      });
      html += '</table>';
      el.innerHTML = html;
    } else {
      var m = sla.getMetrics();
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        [['Checks run', m.checked], ['Violations', m.violated], ['Critical breaches', m.critical]]
        .map(function (r) {
          return '<tr><td style="padding:3px 8px;color:#aaa">' + r[0] + '</td>' +
            '<td style="padding:3px 8px;color:#eee">' + r[1] + '</td></tr>';
        }).join('') + '</table>';
    }
  };

  PanelToolSLA.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolSLA = PanelToolSLA;

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/debug-panels/panel-tool-discovery.js ──
(function (G) {
  'use strict';
  if (G.PanelToolDiscovery) return;

  function PanelToolDiscovery(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._tab      = 'discovered';
  }

  PanelToolDiscovery.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<button data-tab="discovered" style="padding:3px 10px;cursor:pointer">Auto-Discovered</button>' +
        '<button data-tab="sequences" style="padding:3px 10px;cursor:pointer">All Sequences</button>' +
        '<button data-tab="metrics" style="padding:3px 10px;cursor:pointer">Metrics</button>' +
      '</div>' +
      '<div id="p13disc-body"></div></div>';
    container.querySelectorAll('button[data-tab]').forEach(function (btn) {
      btn.onclick = function () { self._tab = btn.dataset.tab; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 4000);
  };

  PanelToolDiscovery.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13disc-body');
    if (!el) return;
    var disc = G.RuntimeToolDiscovery;
    if (!disc) { el.innerHTML = '<em>RuntimeToolDiscovery not loaded</em>'; return; }

    if (this._tab === 'discovered') {
      var found = disc.getDiscovered();
      var thresh = (disc.CONFIDENCE_THRESH * 100).toFixed(0) + '%';
      var header = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">' +
        found.length + ' dependencies auto-discovered (confidence ≥ ' + thresh + ')</div>';
      if (!found.length) { el.innerHTML = header + '<em style="color:#888">No dependencies discovered yet — keep using tools to build sequences</em>'; return; }
      var rows = found.map(function (d) {
        var conf = Math.round(d.confidence * 100);
        var col  = conf >= 90 ? '#2ecc71' : conf >= 80 ? '#f39c12' : '#e74c3c';
        return '<tr>' +
          '<td style="padding:3px 8px;color:#eee">' + d.fromTool + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">→</td>' +
          '<td style="padding:3px 8px;color:#eee">' + d.toTool + '</td>' +
          '<td style="padding:3px 8px"><span style="color:' + col + '">' + conf + '%</span></td>' +
          '<td style="padding:3px 8px;color:#aaa;font-size:10px">' + new Date(d.addedAt).toLocaleTimeString() + '</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = header + '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<tr style="color:#888;font-size:11px"><th align="left" style="padding:3px 8px">From</th>' +
        '<th></th><th align="left" style="padding:3px 8px">To</th>' +
        '<th align="left" style="padding:3px 8px">Confidence</th>' +
        '<th align="left" style="padding:3px 8px">Added</th></tr>' + rows + '</table>';
    } else if (this._tab === 'sequences') {
      var seqs = disc.getSequences();
      if (!seqs.length) { el.innerHTML = '<em style="color:#888">No sequences observed yet</em>'; return; }
      var rows2 = seqs.slice(0, 40).map(function (s) {
        var conf = Math.round(s.confidence * 100);
        return '<tr>' +
          '<td style="padding:3px 8px;color:#eee">' + s.fromTool + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">→</td>' +
          '<td style="padding:3px 8px;color:#eee">' + s.toTool + '</td>' +
          '<td style="padding:3px 8px;color:#aaa">' + s.occurrences + ' / ' + s.total + '</td>' +
          '<td style="padding:3px 8px;color:' + (conf >= 80 ? '#2ecc71' : '#aaa') + '">' + conf + '%</td>' +
          '</tr>';
      }).join('');
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<tr style="color:#888;font-size:11px"><th align="left" style="padding:3px 8px">From</th>' +
        '<th></th><th align="left" style="padding:3px 8px">To</th>' +
        '<th align="left" style="padding:3px 8px">Obs/Total</th>' +
        '<th align="left" style="padding:3px 8px">Confidence</th></tr>' + rows2 + '</table>';
    } else {
      var m = disc.getMetrics();
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        [['Transitions observed', m.observed],
         ['Dependencies discovered', m.discovered],
         ['Promoted to dependency graph', m.promoted],
         ['Confidence threshold', (disc.CONFIDENCE_THRESH * 100) + '%']]
        .map(function (r) {
          return '<tr><td style="padding:3px 8px;color:#aaa">' + r[0] + '</td>' +
            '<td style="padding:3px 8px;color:#eee">' + r[1] + '</td></tr>';
        }).join('') + '</table>';
    }
  };

  PanelToolDiscovery.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolDiscovery = PanelToolDiscovery;

}(typeof window !== 'undefined' ? window : this));

// ── SOURCE: public/js/debug-panels/panel-tool-insights.js ──
(function (G) {
  'use strict';
  if (G.PanelToolInsights) return;

  var SEV_COLOR = { critical: '#e74c3c', warning: '#f39c12', info: '#3498db' };
  var SEV_ICON  = { critical: '🔴', warning: '🟡', info: '🔵' };

  function PanelToolInsights(shell) {
    this._shell    = shell;
    this._el       = null;
    this._interval = null;
    this._filter   = 'all';
  }

  PanelToolInsights.prototype.render = function (container) {
    this._el = container;
    var self = this;
    container.innerHTML =
      '<div style="font-family:monospace;padding:8px">' +
      '<div style="display:flex;gap:6px;margin-bottom:10px;align-items:center">' +
        '<button id="p13ins-gen" style="padding:4px 10px;cursor:pointer">🔄 Generate Now</button>' +
        '<button id="p13ins-clear" style="padding:4px 10px;cursor:pointer;color:#e74c3c">🗑 Clear</button>' +
        '<span style="color:#aaa;font-size:11px;margin-left:8px">Filter:</span>' +
        ['all', 'critical', 'warning', 'info'].map(function (s) {
          return '<button data-sev="' + s + '" style="padding:2px 8px;font-size:11px;cursor:pointer">' + s + '</button>';
        }).join('') +
      '</div>' +
      '<div id="p13ins-body"></div></div>';
    container.querySelector('#p13ins-gen').onclick = function () {
      if (G.RuntimeToolInsights) { G.RuntimeToolInsights.generateInsights(); self._refresh(); }
    };
    container.querySelector('#p13ins-clear').onclick = function () {
      if (G.RuntimeToolInsights) { G.RuntimeToolInsights.clearInsights(); self._refresh(); }
    };
    container.querySelectorAll('button[data-sev]').forEach(function (btn) {
      btn.onclick = function () { self._filter = btn.dataset.sev; self._refresh(); };
    });
    this._refresh();
    this._interval = setInterval(this._refresh.bind(this), 6000);
  };

  PanelToolInsights.prototype._refresh = function () {
    var el = this._el && this._el.querySelector('#p13ins-body');
    if (!el) return;
    var ins = G.RuntimeToolInsights;
    if (!ins) { el.innerHTML = '<em>RuntimeToolInsights not loaded</em>'; return; }
    var opts   = this._filter !== 'all' ? { severity: this._filter } : {};
    var items  = ins.getInsights(opts);
    var m      = ins.getMetrics();
    var header = '<div style="font-size:11px;color:#aaa;margin-bottom:6px">' +
      'Total generated: ' + m.generated + '  Cleared: ' + m.cleared + '</div>';
    if (!items.length) {
      el.innerHTML = header + '<em style="color:#888">No insights yet — click "Generate Now" or wait for auto-generation</em>';
      return;
    }
    var cards = items.slice(0, 20).map(function (i) {
      var col  = SEV_COLOR[i.severity] || '#aaa';
      var icon = SEV_ICON[i.severity]  || '⚪';
      return '<div style="border-left:3px solid ' + col + ';padding:6px 10px;margin-bottom:6px;background:rgba(255,255,255,0.03);border-radius:0 4px 4px 0">' +
        '<div style="font-size:11px;color:#aaa;margin-bottom:2px">' +
          icon + ' <span style="color:' + col + '">' + i.severity.toUpperCase() + '</span>' +
          (i.toolId ? '  <span style="color:#7f8c8d">' + i.toolId + '</span>' : '') +
          '  <span style="color:#636e72">' + new Date(i.ts).toLocaleTimeString() + '</span>' +
        '</div>' +
        '<div style="color:#ecf0f1;font-size:12px">' + _esc(i.message) + '</div>' +
        '</div>';
    }).join('');
    el.innerHTML = header + cards;
  };

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  PanelToolInsights.prototype.destroy = function () {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };

  G.PanelToolInsights = PanelToolInsights;

}(typeof window !== 'undefined' ? window : this));


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

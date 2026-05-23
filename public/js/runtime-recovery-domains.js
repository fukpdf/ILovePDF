// RuntimeRecoveryDomains v1.0 — Arc 3 / Phase F / Target 7
// =====================================================================
// Per-tool circuit breakers + isolated recovery escalation.
//
// Problem: Global recovery logic (RuntimeRecovery) can reload the
// entire runtime when a single tool fails. OCR recovery must never
// reload the Merge PDF runtime. Recovery overlays must be scoped to
// the failing tool's UI, not the whole page.
//
// Solution: Each tool gets an independent circuit breaker with:
//   - CLOSED  → tool is healthy, processing allowed
//   - OPEN    → tool has exceeded failure threshold, blocked for OPEN_TTL_MS
//   - HALF    → trial re-entry allowed (after OPEN_TTL_MS expires)
//
// Recovery policies (from manifest):
//   'isolate' — open circuit, show in-tool warning, do NOT reload page
//   'restart' — open circuit + signal worker domain to restart affected workers
//   'reload'  — open circuit + dispatch 'recovery:page-reload' (caller decides)
//
// Overlay scoping: recovery overlays are emitted as CustomEvents with
// the toolId as context. The UI layer (tool.html/AdvancedEngine) scopes
// them to the active tool's container, not the global page.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeRecoveryDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG          = '[RecoveryDoms]';
  var VERSION      = '1.0';
  var OPEN_TTL_MS  = 30 * 1000;   // circuit stays open 30s before half-open trial
  var FAIL_THRESH  = 3;           // failures before circuit opens

  // ── Circuit states ────────────────────────────────────────────────────────
  var STATE_CLOSED = 'closed';
  var STATE_OPEN   = 'open';
  var STATE_HALF   = 'half-open';

  // ── Domain registry ───────────────────────────────────────────────────────
  // toolId → { state, policy, failCount, lastFailAt, openedAt, tripCount }
  var _circuits = {};

  function _newCircuit(toolId, policy) {
    return {
      toolId:     toolId,
      policy:     policy || 'isolate',
      state:      STATE_CLOSED,
      failCount:  0,
      lastFailAt: 0,
      openedAt:   0,
      tripCount:  0,
    };
  }

  function ensureDomain(toolId, policy) {
    if (!_circuits[toolId]) {
      _circuits[toolId] = _newCircuit(toolId, policy);
      console.debug(LOG, 'circuit created:', toolId, '— policy:', policy || 'isolate');
    }
    return _circuits[toolId];
  }

  // ── Check circuit state ───────────────────────────────────────────────────
  function isOpen(toolId) {
    var c = _circuits[toolId];
    if (!c) return false;
    // Check if OPEN → transition to HALF after TTL
    if (c.state === STATE_OPEN && (Date.now() - c.openedAt) >= OPEN_TTL_MS) {
      c.state = STATE_HALF;
      console.debug(LOG, 'circuit half-open:', toolId);
      try {
        G.dispatchEvent(new CustomEvent('recovery:circuit-half-open', { detail: { toolId: toolId } }));
      } catch (_) {}
    }
    return c.state === STATE_OPEN;
  }

  function getState(toolId) {
    var c = _circuits[toolId];
    if (!c) return STATE_CLOSED;
    // Apply TTL check
    isOpen(toolId);
    return c.state;
  }

  // ── Record failure ────────────────────────────────────────────────────────
  function recordFailure(toolId) {
    var c = ensureDomain(toolId);
    c.failCount++;
    c.lastFailAt = Date.now();

    // If in half-open, a failure re-opens immediately
    if (c.state === STATE_HALF) {
      _open(c);
      return;
    }

    // Trip circuit after threshold
    if (c.state === STATE_CLOSED && c.failCount >= FAIL_THRESH) {
      _open(c);
    }
  }

  function _open(circuit) {
    circuit.state    = STATE_OPEN;
    circuit.openedAt = Date.now();
    circuit.tripCount++;
    console.debug(LOG, 'circuit OPEN:', circuit.toolId, '— trips:', circuit.tripCount, '— policy:', circuit.policy);

    _escalate(circuit);
  }

  // ── Escalate based on policy ──────────────────────────────────────────────
  function _escalate(circuit) {
    var toolId = circuit.toolId;
    var policy = circuit.policy;

    // Always: emit scoped recovery event
    try {
      G.dispatchEvent(new CustomEvent('recovery:circuit-open', {
        detail: { toolId: toolId, policy: policy, tripCount: circuit.tripCount },
        bubbles: true,
      }));
    } catch (_) {}

    // Log to RuntimeIncidentEngine if available
    try {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie.report === 'function') {
        ie.report({
          type:    'circuit-open',
          toolId:  toolId,
          policy:  policy,
          trips:   circuit.tripCount,
          ts:      Date.now(),
        });
      }
    } catch (_) {}

    // Log to RuntimeAnalyticsDomains
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) ad.record(toolId, 'circuit-open', { policy: policy, tripCount: circuit.tripCount });
    } catch (_) {}

    if (policy === 'restart') {
      // Signal worker domain to restart this tool's workers
      try {
        var wd = G.RuntimeWorkerDomainRegistry;
        if (wd) {
          var family = wd.getFamily(toolId);
          if (family) {
            G.dispatchEvent(new CustomEvent('recovery:worker-restart', {
              detail: { toolId: toolId, family: family },
            }));
          }
        }
      } catch (_) {}
    }

    if (policy === 'reload') {
      // Signal page reload — let caller decide whether to act
      try {
        G.dispatchEvent(new CustomEvent('recovery:page-reload', {
          detail: { toolId: toolId, reason: 'circuit-open' },
        }));
      } catch (_) {}
    }
  }

  // ── Close/reset circuit ───────────────────────────────────────────────────
  function closeCircuit(toolId) {
    var c = _circuits[toolId];
    if (!c) return;
    c.state     = STATE_CLOSED;
    c.failCount = 0;
    console.debug(LOG, 'circuit CLOSED:', toolId);
    try {
      G.dispatchEvent(new CustomEvent('recovery:circuit-closed', { detail: { toolId: toolId } }));
    } catch (_) {}
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) ad.record(toolId, 'recover', { manual: true });
    } catch (_) {}
  }

  function openCircuit(toolId) {
    var c = ensureDomain(toolId);
    c.failCount = FAIL_THRESH; // force trip
    _open(c);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    var c = _circuits[toolId];
    if (!c) return null;
    return {
      toolId:    c.toolId,
      state:     getState(toolId),
      policy:    c.policy,
      failCount: c.failCount,
      tripCount: c.tripCount,
      lastFailAt: c.lastFailAt,
    };
  }

  G.RuntimeRecoveryDomains = Object.freeze({
    VERSION:       VERSION,
    ensureDomain:  ensureDomain,
    isOpen:        isOpen,
    getState:      getState,
    recordFailure: recordFailure,
    closeCircuit:  closeCircuit,
    openCircuit:   openCircuit,
    getStats:      getStats,
    getAllStats: function () {
      var out = {};
      Object.keys(_circuits).forEach(function (k) { out[k] = getStats(k); });
      return out;
    },
  });

}(window));

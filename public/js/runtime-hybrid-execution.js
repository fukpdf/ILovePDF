// RuntimeHybridExecution v1.0 — Phase 6 / Task 1 (Hybrid Execution Layer)
// =============================================================================
// Moves critical authorization logic partially server-side while preserving
// browser-side processing speed.
//
// How it works:
//   1. On first need, request a signed execution ticket from the server
//   2. Ticket is held in memory only (no localStorage / IDB)
//   3. Before sensitive operations, gate checks ticket validity + ops list
//   4. Expired/missing tickets trigger a silent re-fetch
//   5. Replay protection: each ticket nonce is tracked
//   6. Request fingerprinting: tie tickets to browser identity
//   7. Tier gating: LOW devices skip ticket checks (lite mode)
//
// Integrates with:
//   RuntimeSecurityTiers, RuntimeIdentity, RuntimeEventBus,
//   SecurityTelemetry, RuntimeForeignDeploy
//
// window.RuntimeHybridExecution
//   .requestTicket(ops[])              → Promise<Ticket|null>
//   .gate(op)                          → Promise<boolean>
//   .getActiveTicket()                 → Ticket|null
//   .invalidate()                      → void
//   .status()                          → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHybridExecution) return;

  var VERSION   = '1.0';
  var LOG       = '[HybridExec]';
  var ENDPOINT  = '/api/execution-ticket';
  var TICKET_TTL_BUFFER_MS = 10_000;  // renew 10s before expiry
  var MAX_INFLIGHT = 1;               // coalesce concurrent requests
  var RETRY_DELAY  = 3_000;
  var MAX_RETRIES  = 2;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ──────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;   // disabled on LOW-tier (lite) devices

  // ── State ─────────────────────────────────────────────────────────────────────
  var _activeTicket   = null;   // { ticket, sig, fetchedAt }
  var _inflight       = null;   // Promise when a fetch is in progress
  var _usedNonces     = [];     // [string] — replay protection (in-memory)
  var _maxNoncePool   = 50;
  var _totalIssued    = 0;
  var _totalRejected  = 0;
  var _lastError      = null;
  var _sessionId      = null;
  var _foreignMode    = false;

  // ── Session ID ────────────────────────────────────────────────────────────────
  function _getSessionId() {
    if (_sessionId) return _sessionId;
    _sessionId = _s(function () {
      var ri = G.RuntimeIdentity;
      if (ri && typeof ri.getUser === 'function') return ri.getUser().id;
      return null;
    }, null) || ('ses_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7));
    return _sessionId;
  }

  // ── Browser fingerprint (non-invasive) ────────────────────────────────────────
  function _getFingerprint() {
    return _s(function () {
      var ri = G.RuntimeIdentity;
      if (ri && typeof ri.getFingerprint === 'function') {
        var fp = ri.getFingerprint();
        return { hash: fp.hash, tier: _tier, score: _score };
      }
      return { tier: _tier, score: _score };
    }, { tier: _tier, score: _score });
  }

  // ── Nonce replay guard ────────────────────────────────────────────────────────
  function _isNonceUsed(nonce) {
    return _usedNonces.indexOf(nonce) !== -1;
  }
  function _trackNonce(nonce) {
    if (_usedNonces.length >= _maxNoncePool) _usedNonces.shift();
    _usedNonces.push(nonce);
  }

  // ── Ticket validity check ─────────────────────────────────────────────────────
  function _isTicketValid(entry) {
    if (!entry || !entry.ticket || !entry.sig) return false;
    var t = entry.ticket;
    if (!t.exp || !t.nonce) return false;
    if (Date.now() >= t.exp - TICKET_TTL_BUFFER_MS) return false;
    if (_isNonceUsed(t.nonce)) return false;
    return true;
  }

  // ── Fetch ticket from server ──────────────────────────────────────────────────
  function _fetchTicket(ops, retries) {
    if (retries === undefined) retries = 0;
    var sessionId   = _getSessionId();
    var fingerprint = _getFingerprint();

    return fetch(ENDPOINT, {
      method:      'POST',
      credentials: 'same-origin',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ sessionId: sessionId, fingerprint: fingerprint, ops: ops }),
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data.ok || !data.ticket || !data.sig) throw new Error('invalid ticket response');
      var entry = { ticket: data.ticket, sig: data.sig, fetchedAt: Date.now() };
      if (!_isTicketValid(entry)) throw new Error('received invalid/expired ticket');
      _activeTicket = entry;
      _trackNonce(data.ticket.nonce);
      _totalIssued++;
      _lastError = null;
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('wasm-event', {
            event: 'ticket-issued', sessionId: sessionId.slice(0, 8),
            ops: (ops || []).join(','), tier: _tier,
          });
        }
      });
      console.debug(LOG, 'ticket issued | ops:', (ops || []).join(','),
        '| exp:', new Date(data.ticket.exp).toISOString());
      return entry;
    })
    .catch(function (err) {
      _lastError = err.message;
      _totalRejected++;
      console.warn(LOG, 'ticket fetch failed:', err.message);
      _s(function () {
        if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
          G.RuntimeEventBus.emit('hybrid-exec:ticket-fail', { reason: err.message, retries: retries });
        }
      });
      if (retries < MAX_RETRIES) {
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            _fetchTicket(ops, retries + 1).then(resolve).catch(reject);
          }, RETRY_DELAY * (retries + 1));
        });
      }
      return null;
    });
  }

  // ── requestTicket (public) ────────────────────────────────────────────────────
  function requestTicket(ops) {
    if (!_enabled) return Promise.resolve(null);
    ops = Array.isArray(ops) ? ops : ['premium-exec'];

    // Foreign deploy — degrade gracefully
    _foreignMode = _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
    if (_foreignMode) {
      console.debug(LOG, 'foreign mode — skipping server ticket');
      return Promise.resolve(null);
    }

    // Re-use valid existing ticket if ops are covered
    if (_activeTicket && _isTicketValid(_activeTicket)) {
      var existingOps = (_activeTicket.ticket.ops || []);
      var covered = ops.every(function (op) { return existingOps.indexOf(op) !== -1; });
      if (covered) return Promise.resolve(_activeTicket);
    }

    // Coalesce concurrent requests
    if (_inflight) return _inflight;

    _inflight = _fetchTicket(ops).then(function (entry) {
      _inflight = null;
      return entry;
    }).catch(function (err) {
      _inflight = null;
      throw err;
    });

    return _inflight;
  }

  // ── gate (public) — check op permission ──────────────────────────────────────
  function gate(op) {
    if (!_enabled) return Promise.resolve(true);
    if (_foreignMode) return Promise.resolve(false);

    // Tier-based check
    var st = _s(function () {
      var tiers = G.RuntimeSecurityTiers;
      if (!tiers || typeof tiers.allows !== 'function') return null;
      return tiers;
    }, null);

    if (st) {
      var tierOk = _s(function () { return st.allows('hybridExec'); }, true);
      if (!tierOk) {
        console.debug(LOG, 'gate denied by security tier for op:', op);
        return Promise.resolve(false);
      }
    }

    return requestTicket([op]).then(function (entry) {
      if (!entry) return false;
      var ops = (entry.ticket && entry.ticket.ops) || [];
      var allowed = ops.indexOf(op) !== -1 || ops.indexOf('premium-exec') !== -1;
      if (!allowed) {
        _totalRejected++;
        console.debug(LOG, 'gate denied for op:', op, '— not in ticket ops:', ops.join(','));
      }
      return allowed;
    }).catch(function () { return false; });
  }

  // ── invalidate (public) ───────────────────────────────────────────────────────
  function invalidate() {
    _activeTicket = null;
    _inflight     = null;
    console.debug(LOG, 'ticket invalidated');
  }

  // ── Pre-warm ticket on boot (HIGH tier only) ──────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    // Pre-warm: request a generic ticket so the first real op is instant
    if (_tier === 'HIGH') {
      setTimeout(function () {
        requestTicket(['premium-exec', 'wasm-load', 'worker-spawn']).catch(function () {});
      }, 8_000);  // 8s — after critical scripts settle
    }

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| endpoint:', ENDPOINT);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  G.RuntimeHybridExecution = Object.freeze({
    VERSION:         VERSION,
    requestTicket:   requestTicket,
    gate:            gate,
    invalidate:      invalidate,
    getActiveTicket: function () { return _activeTicket ? Object.assign({}, _activeTicket) : null; },
    status: function () {
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        score:         _score,
        hasTicket:     _isTicketValid(_activeTicket),
        ticketExp:     _activeTicket && _activeTicket.ticket ? _activeTicket.ticket.exp : null,
        ticketOps:     _activeTicket && _activeTicket.ticket ? (_activeTicket.ticket.ops || []) : [],
        totalIssued:   _totalIssued,
        totalRejected: _totalRejected,
        noncePoolSize: _usedNonces.length,
        lastError:     _lastError,
        foreignMode:   _foreignMode,
        inflight:      !!_inflight,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | tier:', _tier);

}(window));

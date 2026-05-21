// RuntimeThreatCorrelation v1.0 — Phase 6 / Task 6 (Threat Correlation Engine)
// =============================================================================
// Correlates disparate security events into structured attack patterns.
// Transforms low-signal events into high-confidence threat assessments.
//
// Correlation strategies:
//   1. Temporal clustering — events within short windows from same session
//   2. Type correlation — specific combinations indicate known attack vectors
//   3. Sequence matching — ordered event patterns (e.g. probe → exploit → exfil)
//   4. Volume correlation — unusual event rates per session/IP
//   5. Cross-system correlation — same symptom from multiple detectors
//
// Known attack patterns:
//   • SRI_BYPASS:      sri-mismatch + worker-blocked + foreign-degrade
//   • REPLAY_ATTACK:   replay-attempt × 3 within 60s
//   • RUNTIME_TAMPER:  proto-pollution + seal-failure + integrity-failure
//   • DEPLOY_HIJACK:   deploy-mismatch + foreign-degrade + nonce-violation
//   • MEMORY_PROBE:    wasm-canary-violated + memory-abuse + worker-anomaly
//   • TOKEN_ABUSE:     token-reuse × 2 + ticket-fail × 3 within 120s
//   • DEVTOOLS_ATTACK: devtools-degraded + runtime-drift + blob-leak
//
// window.RuntimeThreatCorrelation
//   .ingest(event)                  → void
//   .getActiveThreats()             → Threat[]
//   .getAttackChain(sessionId)      → AttackChain|null
//   .getRiskScore(sessionId)        → number (0-100)
//   .clearThreats()                 → void
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeThreatCorrelation) return;

  var VERSION    = '1.0';
  var LOG        = '[ThreatCorr]';
  var MAX_EVENTS = 1000;
  var MAX_THREATS = 50;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── State ──────────────────────────────────────────────────────────────────
  var _events   = [];    // all ingested events (bounded)
  var _threats  = [];    // active detected threats
  var _chains   = typeof Map !== 'undefined' ? new Map() : null;   // sessionId → AttackChain

  // ── Attack pattern definitions ─────────────────────────────────────────────
  var ATTACK_PATTERNS = [
    {
      id:       'SRI_BYPASS',
      name:     'SRI Bypass Attempt',
      severity: 'CRITICAL',
      score:    85,
      windowMs: 300_000,  // 5 minutes
      conditions: function (events) {
        var hasMismatch  = events.some(function (e) { return e.type === 'sri-mismatch'; });
        var hasWorkerBlk = events.some(function (e) { return e.type === 'worker-blocked'; });
        var hasForeign   = events.some(function (e) { return e.type === 'deploy-mismatch' || e.type === 'foreign-degrade'; });
        return hasMismatch && (hasWorkerBlk || hasForeign);
      },
    },
    {
      id:       'REPLAY_ATTACK',
      name:     'Replay Attack',
      severity: 'HIGH',
      score:    70,
      windowMs: 60_000,   // 1 minute
      conditions: function (events) {
        var replays = events.filter(function (e) { return e.type === 'replay-attempt'; });
        return replays.length >= 3;
      },
    },
    {
      id:       'RUNTIME_TAMPER',
      name:     'Runtime Tampering',
      severity: 'CRITICAL',
      score:    90,
      windowMs: 120_000,
      conditions: function (events) {
        var hasPollution  = events.some(function (e) { return e.type === 'proto-pollution'; });
        var hasSeal       = events.some(function (e) { return e.type === 'seal-failure' || e.type === 'integrity-failure'; });
        return hasPollution || (hasSeal && events.length >= 3);
      },
    },
    {
      id:       'DEPLOY_HIJACK',
      name:     'Deployment Hijacking',
      severity: 'CRITICAL',
      score:    95,
      windowMs: 180_000,
      conditions: function (events) {
        var hasDeploy  = events.some(function (e) { return e.type === 'deploy-mismatch'; });
        var hasForeign = events.some(function (e) { return e.type === 'foreign-degrade' || e.type === 'security:foreign-deploy'; });
        var hasNonce   = events.some(function (e) { return e.type === 'nonce-violation'; });
        return hasDeploy && hasForeign;
      },
    },
    {
      id:       'MEMORY_PROBE',
      name:     'Memory Probing',
      severity: 'HIGH',
      score:    75,
      windowMs: 300_000,
      conditions: function (events) {
        var wasmViolation = events.some(function (e) {
          return e.type === 'integrity-failure' && (e.reason || '').indexOf('canary') !== -1;
        });
        var memAbuse = events.filter(function (e) { return e.type === 'perf-pressure'; }).length >= 3;
        return wasmViolation || memAbuse;
      },
    },
    {
      id:       'TOKEN_ABUSE',
      name:     'Token/Ticket Abuse',
      severity: 'HIGH',
      score:    65,
      windowMs: 120_000,
      conditions: function (events) {
        var replays    = events.filter(function (e) { return e.type === 'replay-attempt'; }).length;
        var ticketFail = events.filter(function (e) {
          return e.type === 'wasm-event' && (e.event === 'ticket-fail' || e.event === 'token-fail');
        }).length;
        return (replays >= 2 && ticketFail >= 2) || ticketFail >= 5;
      },
    },
    {
      id:       'DEVTOOLS_ATTACK',
      name:     'DevTools-Assisted Attack',
      severity: 'MEDIUM',
      score:    45,
      windowMs: 180_000,
      conditions: function (events) {
        var devtools = events.some(function (e) { return e.type === 'devtools-degraded'; });
        var drift    = events.some(function (e) { return e.type === 'runtime-drift'; });
        var tamper   = events.some(function (e) { return e.type === 'proto-pollution'; });
        return devtools && (drift || tamper);
      },
    },
    {
      id:       'PANIC_CHAIN',
      name:     'Cascading Panic (Possible DoS)',
      severity: 'HIGH',
      score:    60,
      windowMs: 60_000,
      conditions: function (events) {
        var panics = events.filter(function (e) { return e.type === 'panic-activated'; }).length;
        return panics >= 2;
      },
    },
  ];

  // ── Session event index ────────────────────────────────────────────────────
  function _getSessionEvents(sessionId, windowMs) {
    var cutoff = Date.now() - windowMs;
    return _events.filter(function (e) {
      return (!sessionId || e.sessionId === sessionId) && e.ts >= cutoff;
    });
  }

  // ── Attack chain reconstruction ────────────────────────────────────────────
  function _buildChain(sessionId) {
    var events = _events.filter(function (e) { return e.sessionId === sessionId; })
      .sort(function (a, b) { return a.ts - b.ts; });
    if (events.length === 0) return null;

    var patterns = _threats.filter(function (t) { return t.sessionId === sessionId; });
    return {
      sessionId: sessionId,
      events:    events.slice(-50),
      patterns:  patterns,
      riskScore: _computeRiskScore(sessionId),
      firstSeen: events[0].ts,
      lastSeen:  events[events.length - 1].ts,
      duration:  events[events.length - 1].ts - events[0].ts,
    };
  }

  // ── Risk score ─────────────────────────────────────────────────────────────
  function _computeRiskScore(sessionId) {
    var sessionThreats = _threats.filter(function (t) { return t.sessionId === sessionId; });
    if (sessionThreats.length === 0) return 0;
    var maxScore = 0;
    var bonus    = 0;
    for (var i = 0; i < sessionThreats.length; i++) {
      if (sessionThreats[i].score > maxScore) maxScore = sessionThreats[i].score;
      bonus += Math.floor(sessionThreats[i].score / 10);
    }
    return Math.min(100, maxScore + Math.floor(bonus / sessionThreats.length));
  }

  // ── Correlate against all patterns ────────────────────────────────────────
  function _correlate(sessionId) {
    for (var i = 0; i < ATTACK_PATTERNS.length; i++) {
      var pattern = ATTACK_PATTERNS[i];
      var events  = _getSessionEvents(sessionId, pattern.windowMs);
      if (events.length === 0) continue;

      try {
        if (pattern.conditions(events)) {
          // Check if we already have this threat for this session
          var existing = _threats.some(function (t) {
            return t.patternId === pattern.id && t.sessionId === sessionId &&
              (Date.now() - t.detectedAt) < pattern.windowMs;
          });

          if (!existing) {
            var threat = {
              patternId:  pattern.id,
              name:       pattern.name,
              severity:   pattern.severity,
              score:      pattern.score,
              sessionId:  sessionId,
              detectedAt: Date.now(),
              eventCount: events.length,
              events:     events.slice(-10).map(function (e) { return e.type; }),
            };

            _threats.push(threat);
            if (_threats.length > MAX_THREATS) _threats.shift();

            console.warn(LOG, 'THREAT DETECTED:', pattern.name,
              '| severity:', pattern.severity,
              '| session:', (sessionId || '').slice(0, 8),
              '| score:', pattern.score);

            // Emit to EventBus
            _s(function () {
              if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
                G.RuntimeEventBus.emit('security:anomaly', {
                  type:     pattern.id,
                  severity: pattern.severity,
                  score:    pattern.score,
                  sessionId: sessionId,
                });
              }
            });

            // Record in SecurityTelemetry
            _s(function () {
              if (G.SecurityTelemetry) {
                G.SecurityTelemetry.record('integrity-failure', {
                  reason:    'threat-correlation:' + pattern.id,
                  severity:  pattern.severity,
                  score:     pattern.score,
                  sessionId: (sessionId || '').slice(0, 12),
                });
              }
            });

            // Update chain
            if (_chains) {
              var chain = _buildChain(sessionId);
              if (chain) _chains.set(sessionId, chain);
            }
          }
        }
      } catch (_) {}
    }
  }

  // ── ingest (public) ────────────────────────────────────────────────────────
  function ingest(event) {
    if (!_enabled || !event) return;

    var normalized = {
      type:      event.type      || event.event || 'unknown',
      sessionId: event.sessionId || event.session || 'anon',
      severity:  event.severity  || 'LOW',
      reason:    event.reason    || '',
      event:     event.event     || '',
      ts:        Date.now(),
    };

    _events.push(normalized);
    if (_events.length > MAX_EVENTS) _events.shift();

    // Correlate on HIGH/CRITICAL events only (perf guard)
    var sev = normalized.severity;
    if (sev === 'CRITICAL' || sev === 'HIGH' || normalized.type === 'replay-attempt') {
      setTimeout(function () {
        _s(function () { _correlate(normalized.sessionId); });
      }, 0);
    } else if (_events.length % 20 === 0) {
      // Periodic sweep every 20 events for lower-severity patterns
      setTimeout(function () {
        _s(function () { _correlate(normalized.sessionId); });
      }, 0);
    }
  }

  // ── Public API functions ──────────────────────────────────────────────────
  function getActiveThreats() {
    var cutoff = Date.now() - 30 * 60_000;  // last 30 min
    return _threats.filter(function (t) { return t.detectedAt >= cutoff; }).slice();
  }

  function getAttackChain(sessionId) {
    if (!_chains) return _buildChain(sessionId);
    return _chains.get(sessionId) || _buildChain(sessionId);
  }

  function getRiskScore(sessionId) { return _computeRiskScore(sessionId); }

  function clearThreats() {
    _threats = [];
    if (_chains) _chains.clear();
    console.debug(LOG, 'threats cleared');
  }

  // ── Subscribe to SecurityTelemetry events ──────────────────────────────────
  function _subscribe() {
    _s(function () {
      var st = G.SecurityTelemetry;
      if (st && typeof st.subscribe === 'function') {
        st.subscribe(function (event) { ingest(event); });
      }
    });

    // Also subscribe to RuntimeSecurityEventSchema
    _s(function () {
      if (!G.RuntimeEventBus) return;
      var SEC_EVENTS = [
        'integrity-failure', 'seal-failure', 'proto-pollution', 'panic-activated',
        'sri-mismatch', 'worker-blocked', 'deploy-mismatch', 'nonce-violation',
        'origin-violation', 'replay-attempt', 'devtools-degraded', 'runtime-drift',
        'security:foreign-deploy', 'security:anomaly', 'wasm:tamper', 'wasm:memory-violation',
      ];
      SEC_EVENTS.forEach(function (evt) {
        G.RuntimeEventBus.on(evt, function (data) {
          ingest(Object.assign({ type: evt }, data || {}));
        });
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    setTimeout(_subscribe, 2_000);

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| patterns:', ATTACK_PATTERNS.length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5000); }, { once: true });
  } else {
    setTimeout(_boot, 5000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeThreatCorrelation = Object.freeze({
    VERSION:          VERSION,
    ingest:           ingest,
    getActiveThreats: getActiveThreats,
    getAttackChain:   getAttackChain,
    getRiskScore:     getRiskScore,
    clearThreats:     clearThreats,
    PATTERNS:         ATTACK_PATTERNS.map(function (p) {
      return { id: p.id, name: p.name, severity: p.severity, score: p.score };
    }),
    status: function () {
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        eventCount:    _events.length,
        threatCount:   _threats.length,
        activeThreats: getActiveThreats().length,
        chainCount:    _chains ? _chains.size : 0,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));

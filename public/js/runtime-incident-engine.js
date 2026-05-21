// RuntimeIncidentEngine v1.0 — Phase 7 / Section 8 (Incident Response Engine)
// =============================================================================
// Incident grouping, classification, and automated response coordination.
// Elevates from raw anomaly detection to structured incident management.
//
// Incident lifecycle:
//   DETECTED → OPEN → INVESTIGATING → RESOLVED | ESCALATED
//
// Incident sources:
//   • RuntimeThreatCorrelation (attack patterns)
//   • RuntimeAnomalyEngine (session/deploy/worker anomalies)
//   • SecurityTelemetry (raw event stream)
//   • RuntimeBehaviorAnalysis (behavioral anomalies)
//   • RuntimeWorkerMesh (worker health events)
//
// Automated responses (proportional):
//   LOW     → log + telemetry
//   MEDIUM  → throttle + telemetry
//   HIGH    → capability revoke + session flag + telemetry
//   CRITICAL → session rotation + full capability revoke + telemetry
//
// window.RuntimeIncidentEngine
//   .getOpenIncidents()              → Incident[]
//   .getIncident(id)                 → Incident|null
//   .resolve(id, reason)             → void
//   .escalate(id, reason)            → void
//   .getSummary()                    → IncidentSummary
//   .exportIncident(id)              → ExportedIncident (GDPR-safe)
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeIncidentEngine) return;

  var VERSION  = '1.0';
  var LOG      = '[IncidentEngine]';
  var MAX_INC  = 200;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Incident store ────────────────────────────────────────────────────────
  var _incidents  = typeof Map !== 'undefined' ? new Map() : null;
  var _incCount   = 0;
  var _responses  = 0;

  // ── Severity thresholds ───────────────────────────────────────────────────
  var SEV_SCORE = { CRITICAL: 80, HIGH: 50, MEDIUM: 25, LOW: 0 };

  function _classifySeverity(score) {
    if (score >= SEV_SCORE.CRITICAL) return 'CRITICAL';
    if (score >= SEV_SCORE.HIGH)     return 'HIGH';
    if (score >= SEV_SCORE.MEDIUM)   return 'MEDIUM';
    return 'LOW';
  }

  // ── Create incident ───────────────────────────────────────────────────────
  function _create(type, score, source, data) {
    if (!_incidents) return null;

    var id       = 'inc_' + Date.now().toString(36) + '_' + (++_incCount).toString(36);
    var severity = _classifySeverity(score);

    var incident = {
      id:         id,
      type:       type,
      severity:   severity,
      score:      score,
      source:     source,
      state:      'OPEN',
      createdAt:  Date.now(),
      updatedAt:  Date.now(),
      resolvedAt: null,
      data:       data || {},
      timeline:   [{ event: 'created', ts: Date.now(), detail: 'incident opened' }],
      responses:  [],
    };

    _incidents.set(id, incident);
    if (_incidents.size > MAX_INC) {
      // Evict oldest resolved
      var oldest = null;
      _incidents.forEach(function (inc, iid) {
        if (inc.state === 'RESOLVED' && (!oldest || inc.updatedAt < _incidents.get(oldest).updatedAt)) {
          oldest = iid;
        }
      });
      if (oldest) _incidents.delete(oldest);
    }

    console.warn(LOG, 'incident created:', id, '| type:', type,
      '| severity:', severity, '| score:', score);

    _respond(incident);
    return incident;
  }

  // ── Automated response ────────────────────────────────────────────────────
  function _respond(incident) {
    var sev = incident.severity;
    _responses++;

    _s(function () {
      // Always: telemetry
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('integrity-failure', {
          reason: 'incident:' + incident.type + ':' + sev,
          score:  incident.score,
        });
      }
    });

    if (sev === 'LOW') return;

    _s(function () {
      // MEDIUM+: EventBus notification
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('security:anomaly', {
          type:     incident.type,
          severity: sev,
          score:    incident.score,
          id:       incident.id,
        });
      }
    });

    if (sev === 'MEDIUM') return;

    _s(function () {
      // HIGH+: revoke non-critical capabilities
      var cm = G.RuntimeCapabilityManager;
      if (cm && typeof cm.revoke === 'function') {
        cm.revoke('fetch:ai');
        cm.revoke('telemetry:write');
      }
    });

    if (sev === 'HIGH') {
      incident.responses.push({ action: 'capability-throttle', ts: Date.now() });
      return;
    }

    // CRITICAL: full response
    _s(function () {
      var cm = G.RuntimeCapabilityManager;
      if (cm && typeof cm.revoke === 'function') {
        cm.revoke('exec-ticket:premium');
        cm.revoke('wasm:simd');
        cm.revoke('worker:shared');
        cm.revoke('session:rotate');
      }
    });

    _s(function () {
      var ss = G.RuntimeSecureSession;
      if (ss && typeof ss.rotate === 'function') {
        ss.rotate('critical-incident:' + incident.type);
      }
    });

    incident.responses.push({ action: 'full-response', ts: Date.now() });
    console.error(LOG, 'CRITICAL incident response activated | id:', incident.id);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function getOpenIncidents() {
    if (!_incidents) return [];
    var result = [];
    _incidents.forEach(function (inc) {
      if (inc.state === 'OPEN' || inc.state === 'INVESTIGATING') {
        result.push(Object.assign({}, inc, { data: undefined, timeline: inc.timeline.slice(-5) }));
      }
    });
    return result;
  }

  function getIncident(id) {
    if (!_incidents) return null;
    var inc = _incidents.get(id);
    return inc ? Object.assign({}, inc) : null;
  }

  function resolve(id, reason) {
    if (!_incidents || !_incidents.has(id)) return;
    var inc = _incidents.get(id);
    inc.state      = 'RESOLVED';
    inc.resolvedAt = Date.now();
    inc.updatedAt  = Date.now();
    inc.timeline.push({ event: 'resolved', ts: Date.now(), detail: reason || 'manual' });
    console.info(LOG, 'incident resolved:', id, '| reason:', reason);
  }

  function escalate(id, reason) {
    if (!_incidents || !_incidents.has(id)) return;
    var inc = _incidents.get(id);
    inc.state     = 'ESCALATED';
    inc.updatedAt = Date.now();
    inc.timeline.push({ event: 'escalated', ts: Date.now(), detail: reason || 'manual' });
    console.warn(LOG, 'incident escalated:', id, '| reason:', reason);
  }

  function exportIncident(id) {
    if (!_incidents || !_incidents.has(id)) return null;
    var inc = _incidents.get(id);
    // Privacy-safe export: strip PII-adjacent fields
    return {
      id:         inc.id,
      type:       inc.type,
      severity:   inc.severity,
      score:      inc.score,
      source:     inc.source,
      state:      inc.state,
      createdAt:  inc.createdAt,
      resolvedAt: inc.resolvedAt,
      timeline:   inc.timeline,
      responses:  inc.responses,
    };
  }

  function getSummary() {
    if (!_incidents) return { total: 0, open: 0, critical: 0 };
    var total = 0, open = 0, critical = 0;
    var bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    var now = Date.now();
    _incidents.forEach(function (inc) {
      total++;
      if (inc.state === 'OPEN' || inc.state === 'INVESTIGATING') open++;
      if (inc.severity === 'CRITICAL') critical++;
      if ((now - inc.createdAt) < 3600_000) bySev[inc.severity]++;
    });
    return { total: total, open: open, critical: critical, last1h: bySev };
  }

  // ── Subscribe to security event sources ───────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('security:anomaly', function (data) {
        if (!data) return;
        var score = data.score || (data.severity === 'CRITICAL' ? 85 : data.severity === 'HIGH' ? 60 : 30);
        _create(data.type || 'anomaly', score, 'threat-correlation', data);
      });

      eb.on('seal:failure', function (data) {
        _create('seal-failure', 90, 'deploy-seal', data);
      });

      eb.on('mesh:worker-quarantined', function (data) {
        _create('worker-quarantined', 55, 'worker-mesh', data);
      });

      eb.on('panic-activated', function (data) {
        _create('panic-cascade', 75, 'panic-manager', data);
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    setTimeout(_subscribe, 4000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5000); }, { once: true });
  } else {
    setTimeout(_boot, 5000);
  }

  G.RuntimeIncidentEngine = Object.freeze({
    VERSION:          VERSION,
    getOpenIncidents: getOpenIncidents,
    getIncident:      getIncident,
    resolve:          resolve,
    escalate:         escalate,
    exportIncident:   exportIncident,
    getSummary:       getSummary,
    _create:          _create, // internal use by other systems
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, summary: getSummary(), responses: _responses };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

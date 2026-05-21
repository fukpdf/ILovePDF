// RuntimeSecurityDashboard v1.0 — Phase 7 / Section 1 (Dashboard Controller)
// =============================================================================
// Controller for the enterprise security dashboard.
// Coordinates data collection, stream subscription, and visualization updates.
// Injected on admin/security-dashboard.html only.
//
// Dashboard panels:
//   1. Risk overview (gauge, level, trend)
//   2. Live threat feed (scrolling event list)
//   3. Worker health grid (mesh health)
//   4. Deployment integrity (seal + channel status)
//   5. Incident summary (open/resolved counts)
//   6. Anomaly timeline (rolling chart)
//   7. Behavioral health (human vs automation score)
//   8. WASM module monitor (attestation status)
//   9. Execution ticket activity
//  10. Session + capabilities overview
//
// window.RuntimeSecurityDashboard
//   .init(rootEl)          → void
//   .refresh()             → void
//   .status()              → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecurityDashboard) return;

  var VERSION = '1.0';
  var LOG     = '[SecDashboard]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _root   = null;
  var _unsub  = null;
  var _rafId  = null;
  var _dirty  = true;
  var _liveEvents = [];

  // ── Collect snapshot of all security systems ──────────────────────────────
  function _collectData() {
    return {
      ts: Date.now(),

      risk: _s(function () {
        var ba = G.RuntimeBehaviorAnalysis;
        var tc = G.RuntimeThreatCorrelation;
        var score  = ba && typeof ba.getHealthScore === 'function' ? 100 - ba.getHealthScore() : 0;
        var active = tc && typeof tc.getActiveThreats === 'function' ? tc.getActiveThreats().length : 0;
        return { score: score, level: ba ? ba.getRiskLevel() : 'NORMAL', activeThreats: active };
      }, { score: 0, level: 'NORMAL', activeThreats: 0 }),

      incidents: _s(function () {
        var ie = G.RuntimeIncidentEngine;
        return ie && typeof ie.getSummary === 'function' ? ie.getSummary() : { open: 0, total: 0 };
      }, { open: 0, total: 0 }),

      deployment: _s(function () {
        var dr = G.RuntimeDeploymentRegistry;
        if (!dr) return null;
        return {
          channel:  dr.status().channel,
          score:    dr.getIntegrityScore(),
          trusted:  dr.isTrustedChannel(),
        };
      }, null),

      workers: _s(function () {
        var wm = G.RuntimeWorkerMesh;
        if (!wm) return null;
        return wm.getMeshHealth();
      }, null),

      wasmMesh: _s(function () {
        var wa = G.RuntimeWasmAttestation;
        if (!wa) return null;
        return wa.status();
      }, null),

      session: _s(function () {
        var ss = G.RuntimeSecureSession;
        return ss && typeof ss.status === 'function' ? ss.status() : null;
      }, null),

      capabilities: _s(function () {
        var cm = G.RuntimeCapabilityManager;
        return cm && typeof cm.listActive === 'function' ? cm.listActive().length : 0;
      }, 0),

      automation: _s(function () {
        var ad = G.RuntimeAutomationDetection;
        return ad && typeof ad.getScore === 'function' ? ad.getScore() : 0;
      }, 0),

      humanEntropy: _s(function () {
        var hs = G.RuntimeHumanSignals;
        return hs && typeof hs.getEntropyScore === 'function' ? hs.getEntropyScore() : 50;
      }, 50),

      proofChain: _s(function () {
        var ep = G.RuntimeEdgeProof;
        if (!ep) return null;
        return { latest: ep.getLatest(), riskSignal: ep.getRiskSignal() };
      }, null),
    };
  }

  // ── Render the dashboard ──────────────────────────────────────────────────
  function _render() {
    if (!_root || !_dirty) return;
    _dirty = false;

    var data = _collectData();

    // Risk panel
    var riskGauge = _root.querySelector('#dash-risk-gauge');
    if (riskGauge) {
      var viz = G.RuntimeSecurityVisualizer;
      if (viz && typeof viz.drawGauge === 'function') {
        viz.drawGauge(riskGauge, data.risk.score, data.risk.level);
      }
    }

    // Risk level indicator
    var riskLevel = _root.querySelector('#dash-risk-level');
    if (riskLevel) {
      riskLevel.textContent = data.risk.level;
      riskLevel.className   = 'dash-badge dash-' + data.risk.level.toLowerCase();
    }

    // Active threats
    var threatCount = _root.querySelector('#dash-threat-count');
    if (threatCount) threatCount.textContent = data.risk.activeThreats;

    // Open incidents
    var incCount = _root.querySelector('#dash-incident-count');
    if (incCount) incCount.textContent = data.incidents.open;

    // Deployment integrity
    var deployScore = _root.querySelector('#dash-deploy-score');
    if (deployScore && data.deployment) {
      deployScore.textContent = data.deployment.score + '%';
    }
    var channelBadge = _root.querySelector('#dash-channel');
    if (channelBadge && data.deployment) {
      channelBadge.textContent = data.deployment.channel;
    }

    // Worker health
    var workerStatus = _root.querySelector('#dash-worker-status');
    if (workerStatus && data.workers) {
      workerStatus.textContent = data.workers.healthy + '/' + data.workers.total;
    }
    var workerGrid = _root.querySelector('#dash-worker-grid');
    if (workerGrid && data.workers) {
      var viz2 = G.RuntimeSecurityVisualizer;
      if (viz2 && typeof viz2.drawWorkerGrid === 'function') {
        var workerList = G.RuntimeWorkerMesh
          ? G.RuntimeWorkerMesh.getWorkersInState('VERIFIED')
              .concat(G.RuntimeWorkerMesh.getWorkersInState('TRUSTED'))
              .concat(G.RuntimeWorkerMesh.getWorkersInState('NEW'))
              .concat(G.RuntimeWorkerMesh.getWorkersInState('QUARANTINED'))
          : [];
        viz2.drawWorkerGrid(workerGrid, workerList);
      }
    }

    // Capabilities
    var capCount = _root.querySelector('#dash-cap-count');
    if (capCount) capCount.textContent = data.capabilities;

    // Automation / human
    var autoScore = _root.querySelector('#dash-auto-score');
    if (autoScore) autoScore.textContent = data.automation;
    var humanScore = _root.querySelector('#dash-human-score');
    if (humanScore) humanScore.textContent = data.humanEntropy;

    // Live event list
    var eventList = _root.querySelector('#dash-event-list');
    if (eventList && _liveEvents.length > 0) {
      var frag = document.createDocumentFragment();
      var recent = _liveEvents.slice(-50).reverse();
      eventList.innerHTML = '';
      recent.forEach(function (evt) {
        var li = document.createElement('li');
        li.className  = 'dash-event dash-' + (evt.severity || 'info').toLowerCase();
        var time = new Date(evt.ts).toLocaleTimeString();
        li.innerHTML  = '<span class="dash-time">' + time + '</span>' +
          '<span class="dash-sev">' + (evt.severity || 'INFO') + '</span>' +
          '<span class="dash-msg">' + (evt.summary || evt.type || '') + '</span>';
        frag.appendChild(li);
      });
      eventList.appendChild(frag);
    }

    // WASM status
    var wasmStatus = _root.querySelector('#dash-wasm-status');
    if (wasmStatus && data.wasmMesh) {
      wasmStatus.textContent = data.wasmMesh.attested + '/' + data.wasmMesh.total + ' attested';
    }
  }

  // ── RAF loop ──────────────────────────────────────────────────────────────
  function _scheduleRender() {
    if (_rafId) return;
    _rafId = requestAnimationFrame(function () {
      _rafId = null;
      _render();
      setTimeout(function () {
        _dirty = true;
        _scheduleRender();
      }, 2000); // refresh every 2s
    });
  }

  // ── init (public) ─────────────────────────────────────────────────────────
  function init(rootEl) {
    _root = rootEl || document.getElementById('security-dashboard');
    if (!_root) {
      console.warn(LOG, 'root element not found');
      return;
    }

    // Subscribe to stream
    var stream = _s(function () { return G.RuntimeSecurityStream; }, null);
    if (stream && typeof stream.subscribe === 'function') {
      _unsub = stream.subscribe(function (evt) {
        _liveEvents.push(evt);
        if (_liveEvents.length > 500) _liveEvents.shift();
        _dirty = true;
      }, { sendBuffer: true, bufferLimit: 100 });
    }

    _dirty = true;
    _scheduleRender();
    console.info(LOG, 'dashboard initialized');
  }

  function refresh() {
    _dirty = true;
  }

  G.RuntimeSecurityDashboard = Object.freeze({
    VERSION: VERSION,
    init:    init,
    refresh: refresh,
    status: function () {
      return { version: VERSION, active: !!_root, events: _liveEvents.length };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

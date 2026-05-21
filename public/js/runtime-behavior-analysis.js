// RuntimeBehaviorAnalysis v1.0 — Phase 7 / Section 4 (Behavioral Analysis)
// =============================================================================
// Session-level behavioral anomaly scoring. Combines human signals and
// automation detection into a composite behavioral health score.
//
// Behavioral dimensions:
//   1. Interaction entropy     — from RuntimeHumanSignals
//   2. Automation probability  — from RuntimeAutomationDetection
//   3. Session consistency     — action sequences match expected UX flows
//   4. Timing anomalies        — suspicious precision in multi-step flows
//   5. Replay/abuse patterns   — from ThreatCorrelation
//   6. Worker abuse signals    — from AnomalyEngine worker scoring
//
// Outputs:
//   • Behavioral health score (0-100, 100=perfectly normal)
//   • Risk level: NORMAL / ELEVATED / HIGH / CRITICAL
//   • Behavior flags: string array of specific anomalies
//   • Recommended action: none / throttle / challenge / block
//
// Effects (proportional, never absolute blocks):
//   LOW risk:      no effect
//   MEDIUM risk:   telemetry + mild throttle
//   HIGH risk:     capability reduction + telemetry
//   CRITICAL risk: session flag + capability revocation
//
// window.RuntimeBehaviorAnalysis
//   .getHealthScore()            → number (0-100)
//   .getRiskLevel()              → 'NORMAL'|'ELEVATED'|'HIGH'|'CRITICAL'
//   .getRecommendedAction()      → 'none'|'throttle'|'challenge'|'restrict'
//   .getReport()                 → BehaviorReport
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBehaviorAnalysis) return;

  var VERSION = '1.0';
  var LOG     = '[BehaviorAnalysis]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _deviceScore = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _deviceScore >= 70 ? 'HIGH' : (_deviceScore >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _deviceScore >= 40;

  // ── State ──────────────────────────────────────────────────────────────────
  var _lastReport     = null;
  var _reportCount    = 0;
  var _actionHistory  = [];   // recent recommended actions
  var MAX_HIST        = 20;

  // ── Action sequence tracking ───────────────────────────────────────────────
  // Track what actions the user has taken — used for consistency scoring.
  var _actionLog      = [];   // [{type, ts}]
  var MAX_ACTIONS     = 50;

  function _recordAction(type) {
    _actionLog.push({ type: type, ts: Date.now() });
    if (_actionLog.length > MAX_ACTIONS) _actionLog.shift();
  }

  // ── Timing anomaly scorer ──────────────────────────────────────────────────
  // Measures: are critical multi-step actions suspiciously instantaneous?
  function _timingAnomalyScore() {
    if (_actionLog.length < 3) return 0;

    var suspiciouslyFast = 0;
    for (var i = 1; i < _actionLog.length; i++) {
      var gap = _actionLog[i].ts - _actionLog[i - 1].ts;
      // Two distinctly different actions within 50ms is suspicious
      if (gap < 50 && _actionLog[i].type !== _actionLog[i - 1].type) {
        suspiciouslyFast++;
      }
    }
    return Math.min(40, suspiciouslyFast * 8);
  }

  // ── Session consistency scorer ────────────────────────────────────────────
  // Some action sequences are impossible for real users (e.g. downloading
  // before uploading any file).
  function _consistencyScore() {
    var uploadSeen    = _actionLog.some(function (a) { return a.type === 'upload'; });
    var downloadSeen  = _actionLog.some(function (a) { return a.type === 'download'; });
    var processSeen   = _actionLog.some(function (a) { return a.type === 'process'; });

    var score = 0;

    // Download without upload or process is suspicious
    if (downloadSeen && !uploadSeen && !processSeen) {
      score += 15;
    }

    // Very rapid complete flow (upload→process→download in <500ms)
    var uploadTs = _s(function () {
      var u = _actionLog.filter(function (a) { return a.type === 'upload'; });
      return u.length > 0 ? u[0].ts : 0;
    }, 0);
    var downloadTs = _s(function () {
      var d = _actionLog.filter(function (a) { return a.type === 'download'; });
      return d.length > 0 ? d[d.length - 1].ts : 0;
    }, 0);

    if (uploadTs > 0 && downloadTs > 0 && (downloadTs - uploadTs) < 500) {
      score += 25;
    }

    return Math.min(40, score);
  }

  // ── Compute composite health score ────────────────────────────────────────
  function _computeHealth() {
    var deductions = 0;
    var flags = [];

    // 1. Automation detection (0-40 points deducted)
    var autoScore = _s(function () {
      var ad = G.RuntimeAutomationDetection;
      return ad && typeof ad.getScore === 'function' ? ad.getScore() : 0;
    }, 0);
    if (autoScore > 0) {
      var autoDed = Math.round(autoScore * 0.4);
      deductions += autoDed;
      if (autoScore >= 50) flags.push('automation:' + autoScore);
    }

    // 2. Human entropy cross-check (0-20 points deducted)
    var humanScore = _s(function () {
      var hs = G.RuntimeHumanSignals;
      return hs && typeof hs.getEntropyScore === 'function' ? hs.getEntropyScore() : 50;
    }, 50);
    if (humanScore < 25) {
      deductions += 20;
      flags.push('low-entropy:' + humanScore);
    } else if (humanScore < 40) {
      deductions += 10;
      flags.push('reduced-entropy:' + humanScore);
    }

    // 3. Timing anomalies (0-40 points deducted)
    var timingDed = _timingAnomalyScore();
    deductions += timingDed;
    if (timingDed > 0) flags.push('timing-anomaly:' + timingDed);

    // 4. Session consistency (0-40 points deducted)
    var consDed = _consistencyScore();
    deductions += consDed;
    if (consDed > 0) flags.push('consistency:' + consDed);

    // 5. Anomaly engine session score (0-20 points deducted)
    var anomalyScore = _s(function () {
      var ae = G.RuntimeAnomalyEngine;
      if (!ae || typeof ae.score !== 'function') return 0;
      var sessionId = _s(function () {
        var ss = G.RuntimeSecureSession;
        return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
      }, 'anon');
      var report = ae.score(sessionId);
      return report ? report.score : 0;
    }, 0);
    if (anomalyScore > 50) {
      deductions += Math.round(anomalyScore * 0.2);
      flags.push('anomaly-engine:' + anomalyScore);
    }

    var health = Math.max(0, 100 - Math.min(100, deductions));
    return { health: health, flags: flags };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function getHealthScore() {
    var r = _computeHealth();
    return r.health;
  }

  function getRiskLevel() {
    var h = getHealthScore();
    if (h >= 80) return 'NORMAL';
    if (h >= 55) return 'ELEVATED';
    if (h >= 30) return 'HIGH';
    return 'CRITICAL';
  }

  function getRecommendedAction() {
    var level = getRiskLevel();
    if (level === 'NORMAL')   return 'none';
    if (level === 'ELEVATED') return 'throttle';
    if (level === 'HIGH')     return 'challenge';
    return 'restrict';
  }

  function getReport() {
    var r = _computeHealth();
    _lastReport = {
      health:            r.health,
      riskLevel:         getRiskLevel(),
      recommendedAction: getRecommendedAction(),
      flags:             r.flags,
      autoScore:         _s(function () {
        var ad = G.RuntimeAutomationDetection;
        return ad && typeof ad.getScore === 'function' ? ad.getScore() : 0;
      }, 0),
      humanScore:        _s(function () {
        var hs = G.RuntimeHumanSignals;
        return hs && typeof hs.getEntropyScore === 'function' ? hs.getEntropyScore() : 50;
      }, 50),
      actionCount:       _actionLog.length,
      ts:                Date.now(),
    };
    _reportCount++;
    return _lastReport;
  }

  // ── Periodic enforcement ──────────────────────────────────────────────────
  function _enforce() {
    var report = getReport();
    var action = report.recommendedAction;

    _actionHistory.push({ action: action, ts: Date.now() });
    if (_actionHistory.length > MAX_HIST) _actionHistory.shift();

    if (action === 'none') return;

    console.debug(LOG, 'behavioral action:', action,
      '| health:', report.health, '| flags:', report.flags.join(','));

    if (action === 'throttle' || action === 'challenge') {
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('integrity-failure', {
            reason: 'behavior-' + action + ':' + report.health,
          });
        }
      });
    }

    if (action === 'restrict') {
      _s(function () {
        var cm = G.RuntimeCapabilityManager;
        if (cm && typeof cm.revoke === 'function') {
          cm.revoke('fetch:ai');
          cm.revoke('exec-ticket:premium');
        }
      });
      _s(function () {
        var tc = G.RuntimeThreatCorrelation;
        if (tc && typeof tc.ingest === 'function') {
          var sessionId = _s(function () {
            var ss = G.RuntimeSecureSession;
            return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
          }, 'anon');
          tc.ingest({
            type:      'automation-detected',
            severity:  'HIGH',
            sessionId: sessionId,
            score:     100 - report.health,
          });
        }
      });
    }
  }

  // ── Subscribe to user action events ────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;
      eb.on('tool:upload-start',   function () { _recordAction('upload'); });
      eb.on('tool:process-start',  function () { _recordAction('process'); });
      eb.on('tool:download-start', function () { _recordAction('download'); });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    setTimeout(_enforce, 5_000);
    setInterval(_enforce, 120_000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3500); }, { once: true });
  } else {
    setTimeout(_boot, 3500);
  }

  G.RuntimeBehaviorAnalysis = Object.freeze({
    VERSION:              VERSION,
    getHealthScore:       getHealthScore,
    getRiskLevel:         getRiskLevel,
    getRecommendedAction: getRecommendedAction,
    getReport:            getReport,
    status: function () {
      return {
        version:           VERSION,
        enabled:           _enabled,
        tier:              _tier,
        healthScore:       getHealthScore(),
        riskLevel:         getRiskLevel(),
        recommendedAction: getRecommendedAction(),
        reportCount:       _reportCount,
        actionCount:       _actionLog.length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

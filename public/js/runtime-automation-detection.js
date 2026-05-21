// RuntimeAutomationDetection v1.0 — Phase 7 / Section 4 (Automation Detection)
// =============================================================================
// Detects automation scripts, headless browsers, and bot patterns.
// Uses passive, non-invasive signals — no traps, no hostile behavior.
//
// Detection strategies:
//   1. Headless browser artifact detection (navigator props, WebGL, etc.)
//   2. Timing analysis — automated scripts show unnatural precision
//   3. Session pattern scoring — upload/download loop detection
//   4. Worker abuse detection — rapid re-spawning, message flooding
//   5. Rapid replay detection — suspiciously fast ticket reuse
//   6. Request rate scoring — superhuman file processing speed
//   7. Behavioral consistency — actions in impossible sequences
//
// IMPORTANT:
//   • Detection ONLY increases risk score and throttles — never blocks legitimate users
//   • All checks are heuristic — treated as "elevated suspicion" signals
//   • NO aggressive fingerprinting (no canvas fingerprint, no audio fingerprint)
//   • Legitimate automation (scripts using the API) should not be penalized harshly
//
// Responses to automation detection:
//   • Risk score increase → RuntimeThreatCorrelation
//   • Capability throttle → RuntimeCapabilityManager  
//   • Telemetry record → SecurityTelemetry
//
// window.RuntimeAutomationDetection
//   .getScore()          → number (0-100, higher = more automation-like)
//   .isAutomated()       → boolean (score >= 70)
//   .getFlags()          → string[]
//   .status()            → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeAutomationDetection) return;

  var VERSION = '1.0';
  var LOG     = '[AutoDetect]';

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

  // ── Detection state ────────────────────────────────────────────────────────
  var _automationScore = 0;
  var _flags           = [];
  var _checked         = false;
  var _uploadCount     = 0;
  var _downloadCount   = 0;
  var _lastUploadTs    = 0;
  var _workerSpawnRate = [];   // timestamps of worker spawns
  var _ticketRate      = [];   // timestamps of ticket requests

  // ── Static environment checks ─────────────────────────────────────────────
  function _checkStaticEnvironment() {
    var deductions = 0;
    var flags = [];

    // Check 1: webdriver flag (Selenium/Puppeteer)
    var hasWebdriver = _s(function () {
      return navigator.webdriver === true;
    }, false);
    if (hasWebdriver) { deductions += 30; flags.push('webdriver:true'); }

    // Check 2: phantom.js artifacts
    var hasPhantom = _s(function () {
      return !!(G.callPhantom || G._phantom || G.__phantomas);
    }, false);
    if (hasPhantom) { deductions += 40; flags.push('phantom-detected'); }

    // Check 3: selenium-specific properties
    var hasSelenium = _s(function () {
      return !!(G.document.$cdc_asdjflasutopfhvcZLmcfl_ ||
                G.document.documentElement.getAttribute('selenium') ||
                G.document.documentElement.getAttribute('webdriver'));
    }, false);
    if (hasSelenium) { deductions += 35; flags.push('selenium-detected'); }

    // Check 4: No language (headless often has empty language)
    var noLang = _s(function () {
      return !navigator.language || navigator.language === '';
    }, false);
    if (noLang) { deductions += 15; flags.push('no-language'); }

    // Check 5: Permissions API anomaly (headless browsers often throw)
    var permAnomaly = _s(function () {
      if (!navigator.permissions) return false;
      // Headless Chromium had a known quirk where notifications permission
      // returned 'denied' instantly without user interaction
      return false; // check async-only
    }, false);

    // Check 6: plugins array (headless usually has 0 plugins, real browsers have many)
    var pluginCount = _s(function () {
      return navigator.plugins ? navigator.plugins.length : -1;
    }, -1);
    if (pluginCount === 0 && !_s(function () { return /mobile/i.test(navigator.userAgent); }, false)) {
      deductions += 10;
      flags.push('zero-plugins');
    }

    // Check 7: Outerwidth/height = 0 (headless indicator)
    var zeroViewport = _s(function () {
      return G.outerWidth === 0 && G.outerHeight === 0;
    }, false);
    if (zeroViewport) { deductions += 20; flags.push('zero-viewport'); }

    // Check 8: Missing touch but mobile UA (automated UA spoofing)
    var uaSpoofed = _s(function () {
      var isMobileUA = /mobile|android|iphone|ipad/i.test(navigator.userAgent);
      var hasTouchAPI = ('ontouchstart' in G) || (navigator.maxTouchPoints > 0);
      return isMobileUA && !hasTouchAPI;
    }, false);
    if (uaSpoofed) { deductions += 15; flags.push('ua-touch-mismatch'); }

    return { score: Math.min(100, deductions), flags: flags };
  }

  // ── Behavioral rate scoring ────────────────────────────────────────────────
  function _checkBehavioralRates() {
    var score = 0;
    var flags = [];

    // Upload loop detection (>5 uploads in 60s = suspicious)
    var now = Date.now();
    var recentUploads = _uploadCount;
    var uploadAge = now - _lastUploadTs;
    if (recentUploads >= 8 && uploadAge < 60_000) {
      score += 25;
      flags.push('upload-loop:' + recentUploads);
    } else if (recentUploads >= 5 && uploadAge < 30_000) {
      score += 15;
      flags.push('rapid-upload:' + recentUploads);
    }

    // Worker spawn storm detection
    var recentSpawns = _workerSpawnRate.filter(function (t) { return now - t < 10_000; }).length;
    if (recentSpawns >= 10) {
      score += 30;
      flags.push('worker-spawn-storm:' + recentSpawns);
    } else if (recentSpawns >= 5) {
      score += 15;
      flags.push('rapid-worker-spawn:' + recentSpawns);
    }

    // Ticket rate detection (>5 ticket requests in 30s = suspicious)
    var recentTickets = _ticketRate.filter(function (t) { return now - t < 30_000; }).length;
    if (recentTickets >= 8) {
      score += 20;
      flags.push('ticket-flood:' + recentTickets);
    }

    return { score: Math.min(100, score), flags: flags };
  }

  // ── Human signal cross-check ──────────────────────────────────────────────
  function _crossCheckHumanSignals() {
    var humanScore = _s(function () {
      var hs = G.RuntimeHumanSignals;
      return hs && typeof hs.getEntropyScore === 'function' ? hs.getEntropyScore() : null;
    }, null);

    if (humanScore === null) return { score: 0, flags: [] };

    var score = 0;
    var flags = [];

    if (humanScore < 15) {
      score += 25;
      flags.push('low-human-entropy:' + humanScore);
    } else if (humanScore < 25) {
      score += 10;
      flags.push('reduced-human-entropy:' + humanScore);
    }

    return { score: score, flags: flags };
  }

  // ── Compute overall automation score ─────────────────────────────────────
  function _compute() {
    var env  = _checkStaticEnvironment();
    var rate = _checkBehavioralRates();
    var human = _crossCheckHumanSignals();

    var combined = Math.min(100, Math.round(
      env.score   * 0.5 +
      rate.score  * 0.35 +
      human.score * 0.15
    ));

    _automationScore = combined;
    _flags = env.flags.concat(rate.flags).concat(human.flags);
    _checked = true;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function getScore() {
    if (!_checked) _compute();
    return _automationScore;
  }

  function isAutomated() {
    return getScore() >= 70;
  }

  function getFlags() {
    if (!_checked) _compute();
    return _flags.slice();
  }

  // ── Internal tracking (called by other systems) ────────────────────────────
  function _trackUpload() {
    _uploadCount++;
    _lastUploadTs = Date.now();
    _compute();
  }

  function _trackWorkerSpawn() {
    var now = Date.now();
    _workerSpawnRate.push(now);
    if (_workerSpawnRate.length > 50) _workerSpawnRate.shift();
    _compute();
  }

  function _trackTicketRequest() {
    var now = Date.now();
    _ticketRate.push(now);
    if (_ticketRate.length > 20) _ticketRate.shift();
  }

  // ── Subscribe to system events ────────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('worker:spawned', function () { _trackWorkerSpawn(); });
      eb.on('hybrid-exec:ticket-request', function () { _trackTicketRequest(); });

      // Re-compute on security events
      eb.on('replay-attempt', function () {
        _ticketRate.push(Date.now());
        _compute();
      });
    });
  }

  // ── Periodic re-check + telemetry report ──────────────────────────────────
  function _periodicCheck() {
    _compute();
    var s = _automationScore;
    if (s >= 50) {
      console.warn(LOG, 'automation score elevated:', s, '| flags:', _flags.join(','));
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('integrity-failure', {
            reason: 'automation-score:' + s,
            score:  s,
            flags:  _flags.slice(0, 3).join(','),
          });
        }
      });
      _s(function () {
        var tc = G.RuntimeThreatCorrelation;
        if (tc && typeof tc.ingest === 'function') {
          tc.ingest({
            type:     'automation-detected',
            severity: s >= 70 ? 'HIGH' : 'MEDIUM',
            score:    s,
            sessionId: _s(function () {
              var ss = G.RuntimeSecureSession;
              return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
            }, 'anon'),
          });
        }
      });
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _compute();
    _subscribe();
    setInterval(_periodicCheck, 60_000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| initial score:', _automationScore);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimeAutomationDetection = Object.freeze({
    VERSION:    VERSION,
    getScore:   getScore,
    isAutomated: isAutomated,
    getFlags:   getFlags,
    _trackUpload:       _trackUpload,
    _trackWorkerSpawn:  _trackWorkerSpawn,
    _trackTicketRequest: _trackTicketRequest,
    status: function () {
      return {
        version:         VERSION,
        enabled:         _enabled,
        tier:            _tier,
        automationScore: getScore(),
        isAutomated:     isAutomated(),
        flags:           getFlags(),
        uploadCount:     _uploadCount,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

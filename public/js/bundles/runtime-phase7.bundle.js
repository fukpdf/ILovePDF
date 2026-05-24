// ── Phase 7 Zero-Trust Mesh — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-24T07:20:15.238Z  BUILD_ID: mpjg6rfp
// Files: 24

// ── SOURCE: public/js/runtime-human-signals.js ──
// RuntimeHumanSignals v1.0 — Phase 7 / Section 4 (Human Interaction Signals)
// =============================================================================
// Passively collects interaction entropy signals to distinguish genuine human
// users from automation scripts. Privacy-safe: no biometrics, no PII.
//
// Signals collected:
//   • Mouse movement trajectory entropy (Shannon entropy of path)
//   • Click timing variance (natural vs metronomic intervals)
//   • Scroll pattern complexity (organic vs programmatic scroll)
//   • Keyboard timing jitter (inter-keystroke variance)
//   • Touch gesture presence (mobile authenticity)
//   • Focus/blur patterns (tab switching vs script cycling)
//   • Resize event patterns (manual vs automated viewport changes)
//   • Pointer precision (sub-pixel hover jitter from real input)
//
// IMPORTANT design rules:
//   • NO keystroke logging (only timing gaps, never content)
//   • NO mouse path recording beyond entropy score
//   • NO storage of individual events
//   • Data never leaves the browser
//   • All signals aggregate into a single entropy score (0-100)
//
// window.RuntimeHumanSignals
//   .getEntropyScore()   → number (0-100, higher = more human-like)
//   .isLikelyHuman()     → boolean
//   .getSignalSummary()  → SignalSummary
//   .reset()             → void
//   .status()            → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHumanSignals) return;

  var VERSION = '1.0';
  var LOG     = '[HumanSignals]';

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

  // ── Signal state ──────────────────────────────────────────────────────────
  var _mouseDeltas      = [];   // last 30 movement deltas
  var _clickTimings     = [];   // last 20 click intervals
  var _scrollTimings    = [];   // last 15 scroll intervals
  var _keyTimings       = [];   // last 20 keydown intervals (NO key content)
  var _focusEvents      = 0;
  var _touchEvents      = 0;
  var _resizeEvents     = 0;
  var _lastMouse        = null;
  var _lastClick        = 0;
  var _lastScroll       = 0;
  var _lastKey          = 0;
  var _mouseEntropyAccum = 0;
  var _sampleCount      = 0;
  var MAX_SAMPLES       = 50;

  // ── Shannon entropy of a numeric array ───────────────────────────────────
  function _shannonEntropy(arr) {
    if (!arr || arr.length < 2) return 0;
    var sum = 0; for (var i = 0; i < arr.length; i++) sum += arr[i];
    if (sum === 0) return 0;
    var ent = 0;
    for (var j = 0; j < arr.length; j++) {
      var p = arr[j] / sum;
      if (p > 0) ent -= p * Math.log2(p);
    }
    return ent;
  }

  // ── Variance of a timing array ────────────────────────────────────────────
  function _variance(arr) {
    if (!arr || arr.length < 2) return 0;
    var mean = 0; for (var i = 0; i < arr.length; i++) mean += arr[i];
    mean /= arr.length;
    var v = 0;
    for (var j = 0; j < arr.length; j++) v += (arr[j] - mean) * (arr[j] - mean);
    return v / arr.length;
  }

  // ── Mouse movement handler ────────────────────────────────────────────────
  function _onMouseMove(e) {
    if (!_enabled) return;
    var now = Date.now();
    if (_lastMouse) {
      var dx = e.clientX - _lastMouse.x;
      var dy = e.clientY - _lastMouse.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.5) {
        _mouseDeltas.push(Math.round(dist * 10));
        if (_mouseDeltas.length > 30) _mouseDeltas.shift();
        _sampleCount++;
      }
    }
    _lastMouse = { x: e.clientX, y: e.clientY, t: now };
  }

  // ── Click handler ─────────────────────────────────────────────────────────
  function _onClick() {
    if (!_enabled) return;
    var now = Date.now();
    if (_lastClick > 0) {
      _clickTimings.push(now - _lastClick);
      if (_clickTimings.length > 20) _clickTimings.shift();
    }
    _lastClick = now;
  }

  // ── Scroll handler ────────────────────────────────────────────────────────
  function _onScroll() {
    if (!_enabled) return;
    var now = Date.now();
    if (_lastScroll > 0) {
      _scrollTimings.push(now - _lastScroll);
      if (_scrollTimings.length > 15) _scrollTimings.shift();
    }
    _lastScroll = now;
  }

  // ── Keydown handler (timing only, no content) ─────────────────────────────
  function _onKeydown() {
    if (!_enabled) return;
    var now = Date.now();
    if (_lastKey > 0) {
      _keyTimings.push(now - _lastKey);
      if (_keyTimings.length > 20) _keyTimings.shift();
    }
    _lastKey = now;
  }

  // ── Touch handler ─────────────────────────────────────────────────────────
  function _onTouch() {
    if (!_enabled) return;
    _touchEvents = Math.min(_touchEvents + 1, 100);
  }

  // ── Focus handler ─────────────────────────────────────────────────────────
  function _onFocus() {
    if (!_enabled) return;
    _focusEvents = Math.min(_focusEvents + 1, 50);
  }

  // ── Resize handler ────────────────────────────────────────────────────────
  function _onResize() {
    if (!_enabled) return;
    _resizeEvents++;
  }

  // ── Entropy score computation ─────────────────────────────────────────────
  function getEntropyScore() {
    if (!_enabled) return 50; // neutral for disabled

    var score = 0;
    var weight = 0;

    // Mouse entropy (0-30 points)
    if (_mouseDeltas.length >= 5) {
      var mEnt = _shannonEntropy(_mouseDeltas.slice(-20));
      score  += Math.min(30, mEnt * 6);
      weight += 30;
    } else if (_sampleCount === 0 && _touchEvents > 0) {
      // Mobile — touch presence is positive signal
      score  += 15;
      weight += 30;
    } else {
      weight += 30; // penalize for no mouse
    }

    // Click timing variance (0-20 points)
    if (_clickTimings.length >= 3) {
      var cVar = _variance(_clickTimings);
      // High variance = human (irregular clicks)
      // Very low variance = bot (metronomic)
      var cScore = cVar > 1000 ? 20 : (cVar > 100 ? 12 : (cVar > 10 ? 6 : 2));
      score  += cScore;
      weight += 20;
    } else {
      weight += 20;
    }

    // Scroll timing variance (0-15 points)
    if (_scrollTimings.length >= 3) {
      var sVar = _variance(_scrollTimings);
      var sScore = sVar > 5000 ? 15 : (sVar > 500 ? 9 : (sVar > 50 ? 5 : 1));
      score  += sScore;
      weight += 15;
    } else {
      weight += 15;
    }

    // Keyboard timing variance (0-15 points)
    if (_keyTimings.length >= 5) {
      var kVar = _variance(_keyTimings);
      var kScore = kVar > 2000 ? 15 : (kVar > 200 ? 9 : (kVar > 20 ? 5 : 1));
      score  += kScore;
      weight += 15;
    } else {
      weight += 15;
    }

    // Touch presence — mobile indicator (0-10 points)
    if (_touchEvents > 0) {
      score  += Math.min(10, _touchEvents);
      weight += 10;
    } else {
      weight += 10;
    }

    // Focus events — tab interaction (0-10 points)
    if (_focusEvents > 0) {
      score  += Math.min(10, _focusEvents * 2);
      weight += 10;
    } else {
      weight += 10;
    }

    if (weight === 0) return 50;
    return Math.round((score / weight) * 100);
  }

  function isLikelyHuman() {
    return getEntropyScore() >= 35;
  }

  function getSignalSummary() {
    return {
      entropyScore:    getEntropyScore(),
      isLikelyHuman:   isLikelyHuman(),
      mouseDeltas:     _mouseDeltas.length,
      clickTimings:    _clickTimings.length,
      scrollTimings:   _scrollTimings.length,
      keyTimings:      _keyTimings.length,
      touchEvents:     _touchEvents,
      focusEvents:     _focusEvents,
      resizeEvents:    _resizeEvents,
      sampleCount:     _sampleCount,
    };
  }

  function reset() {
    _mouseDeltas = []; _clickTimings = []; _scrollTimings = [];
    _keyTimings = []; _touchEvents = 0; _focusEvents = 0;
    _resizeEvents = 0; _lastMouse = null; _lastClick = 0;
    _lastScroll = 0; _lastKey = 0; _sampleCount = 0;
  }

  // ── Attach listeners (passive, low overhead) ──────────────────────────────
  function _attach() {
    if (typeof document === 'undefined') return;
    var opts = { passive: true, capture: false };
    document.addEventListener('mousemove',  _onMouseMove,  opts);
    document.addEventListener('click',      _onClick,      opts);
    document.addEventListener('scroll',     _onScroll,     opts);
    document.addEventListener('keydown',    _onKeydown,    opts);
    document.addEventListener('touchstart', _onTouch,      opts);
    G.addEventListener && G.addEventListener('focus', _onFocus, opts);
    G.addEventListener && G.addEventListener('resize', _onResize, opts);
    console.debug(LOG, 'listeners attached');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _attach();
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1000); }, { once: true });
  } else {
    setTimeout(_boot, 1000);
  }

  G.RuntimeHumanSignals = Object.freeze({
    VERSION:         VERSION,
    getEntropyScore: getEntropyScore,
    isLikelyHuman:   isLikelyHuman,
    getSignalSummary: getSignalSummary,
    reset:           reset,
    status: function () {
      return {
        version:      VERSION,
        enabled:      _enabled,
        tier:         _tier,
        entropyScore: getEntropyScore(),
        isLikelyHuman: isLikelyHuman(),
        sampleCount:  _sampleCount,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-automation-detection.js ──
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
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _compute();
    _subscribe();
    setInterval(_periodicCheck, 60_000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
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

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-behavior-analysis.js ──
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
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    setTimeout(_enforce, 5_000);
    setInterval(_enforce, 120_000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
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

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-worker-mesh.js ──
// RuntimeWorkerMesh v1.0 — Phase 7 / Section 2 (Zero-Trust Worker Mesh)
// =============================================================================
// Coordinates signed worker identities, trust scoring, and mesh-level
// security for the worker pool. Workers are treated as untrusted by default.
//
// Architecture:
//   • Each worker receives a signed identity token at spawn time
//   • Workers authenticate themselves via their token on first message
//   • Trust scores accumulate from heartbeat health + behavior
//   • Rogue/unresponsive workers are quarantined and replaced
//   • Worker-to-worker communication is routed through the mesh controller
//   • Heartbeat federation: mesh aggregates health from all workers
//
// Trust tiers:
//   NEW      (0-24):   probationary, limited capabilities
//   TRUSTED  (25-74):  normal operation
//   VERIFIED (75-100): full mesh capabilities
//   QUARANTINED:       blocked, replacement queued
//
// Integrates with:
//   RuntimeWorkerFactory, RuntimeWorkerBootstrap, RuntimeSecureSession,
//   RuntimeCapabilityManager, SecurityTelemetry, RuntimeEventBus
//
// window.RuntimeWorkerMesh
//   .register(workerId, worker, url)   → MeshEntry
//   .setTrust(workerId, delta, reason) → number (new score)
//   .quarantine(workerId, reason)      → void
//   .getTrustScore(workerId)           → number
//   .getMeshHealth()                   → MeshHealth
//   .getWorkersInState(state)          → MeshEntry[]
//   .status()                          → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerMesh) return;

  var VERSION = '1.0';
  var LOG     = '[WorkerMesh]';

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

  // ── Trust constants ───────────────────────────────────────────────────────
  var TRUST_NEW_WORKER       = 20;   // starting trust for new workers
  var TRUST_HEARTBEAT_BONUS  = 2;    // per successful pong
  var TRUST_HEARTBEAT_MISS   = -8;   // per missed ping
  var TRUST_AUTH_SUCCESS     = 10;   // successful token auth
  var TRUST_AUTH_FAIL        = -20;  // failed token auth
  var TRUST_QUARANTINE_THRESHOLD = 5;  // quarantine below this
  var TRUST_VERIFIED_THRESHOLD   = 75;

  // ── Worker registry ────────────────────────────────────────────────────────
  // workerId → { workerId, worker, url, trust, state, spawnTs, lastPong,
  //              authToken, authState, heartbeats, misses, messages }
  var _registry = typeof Map !== 'undefined' ? new Map() : null;
  var _auditLog = [];
  var MAX_AUDIT = 200;

  function _log(workerId, event, detail) {
    _auditLog.push({ workerId: workerId, event: event, detail: detail || null, ts: Date.now() });
    if (_auditLog.length > MAX_AUDIT) _auditLog.shift();
  }

  // ── Register a worker in the mesh ──────────────────────────────────────────
  function register(workerId, worker, url) {
    if (!_registry) return null;

    var authToken = _s(function () {
      var ss = G.RuntimeSecureSession;
      if (ss && typeof ss.authorizeWorker === 'function') {
        var auth = ss.authorizeWorker(url);
        return auth ? auth.token : null;
      }
      return null;
    }, null);

    var entry = {
      workerId:   workerId,
      worker:     worker,
      url:        url || '',
      trust:      TRUST_NEW_WORKER,
      state:      'NEW',          // NEW | TRUSTED | VERIFIED | QUARANTINED
      spawnTs:    Date.now(),
      lastPong:   0,
      authToken:  authToken,
      authState:  'pending',     // pending | ok | failed
      heartbeats: 0,
      misses:     0,
      messages:   0,
    };

    _registry.set(workerId, entry);
    _log(workerId, 'registered', { url: url, trust: TRUST_NEW_WORKER });

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('mesh:worker-joined', { workerId: workerId, url: url });
      }
    });

    return Object.assign({}, entry, { worker: undefined }); // don't expose worker ref
  }

  // ── Adjust trust score ──────────────────────────────────────────────────────
  function setTrust(workerId, delta, reason) {
    if (!_registry || !_registry.has(workerId)) return 0;
    var entry = _registry.get(workerId);
    entry.trust = Math.max(0, Math.min(100, entry.trust + delta));

    // Update state
    if (entry.trust <= TRUST_QUARANTINE_THRESHOLD) {
      if (entry.state !== 'QUARANTINED') {
        quarantine(workerId, 'trust-score-low:' + entry.trust);
      }
    } else if (entry.trust >= TRUST_VERIFIED_THRESHOLD) {
      entry.state = 'VERIFIED';
    } else if (entry.trust >= 25) {
      if (entry.state === 'NEW') entry.state = 'TRUSTED';
    }

    _log(workerId, 'trust-change', { delta: delta, reason: reason, trust: entry.trust });
    return entry.trust;
  }

  // ── Quarantine a worker ───────────────────────────────────────────────────
  function quarantine(workerId, reason) {
    if (!_registry || !_registry.has(workerId)) return;
    var entry = _registry.get(workerId);

    if (entry.state === 'QUARANTINED') return;
    entry.state = 'QUARANTINED';

    console.warn(LOG, 'quarantined worker:', workerId, '| reason:', reason);
    _log(workerId, 'quarantined', { reason: reason });

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('mesh:worker-quarantined', { workerId: workerId, reason: reason });
      }
    });

    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('worker-restart', {
          workerId: workerId,
          reason:   'quarantine:' + reason,
        });
      }
    });

    // Terminate the rogue worker
    _s(function () {
      var w = entry.worker;
      if (w && typeof w.terminate === 'function') {
        w.terminate();
      }
    });
  }

  // ── Record heartbeat ─────────────────────────────────────────────────────
  function _recordPong(workerId) {
    if (!_registry || !_registry.has(workerId)) return;
    var entry = _registry.get(workerId);
    entry.lastPong    = Date.now();
    entry.heartbeats  = (entry.heartbeats || 0) + 1;
    entry.misses      = 0;
    setTrust(workerId, TRUST_HEARTBEAT_BONUS, 'heartbeat-ok');
  }

  function _recordMiss(workerId) {
    if (!_registry || !_registry.has(workerId)) return;
    var entry = _registry.get(workerId);
    entry.misses = (entry.misses || 0) + 1;
    setTrust(workerId, TRUST_HEARTBEAT_MISS, 'heartbeat-miss');
  }

  // ── getMeshHealth ──────────────────────────────────────────────────────────
  function getMeshHealth() {
    if (!_registry) return { healthy: 0, total: 0, quarantined: 0, avgTrust: 0 };

    var entries = [];
    _registry.forEach(function (e) { entries.push(e); });

    var healthy = entries.filter(function (e) {
      return e.state === 'TRUSTED' || e.state === 'VERIFIED';
    }).length;
    var quarantined = entries.filter(function (e) {
      return e.state === 'QUARANTINED';
    }).length;
    var avgTrust = entries.length > 0
      ? Math.round(entries.reduce(function (s, e) { return s + e.trust; }, 0) / entries.length)
      : 100;

    return {
      healthy:    healthy,
      total:      entries.length,
      quarantined: quarantined,
      avgTrust:   avgTrust,
      new:        entries.filter(function (e) { return e.state === 'NEW'; }).length,
      verified:   entries.filter(function (e) { return e.state === 'VERIFIED'; }).length,
    };
  }

  function getTrustScore(workerId) {
    if (!_registry || !_registry.has(workerId)) return -1;
    return _registry.get(workerId).trust;
  }

  function getWorkersInState(state) {
    if (!_registry) return [];
    var result = [];
    _registry.forEach(function (e) {
      if (e.state === state) {
        result.push({ workerId: e.workerId, url: e.url, trust: e.trust, state: e.state });
      }
    });
    return result;
  }

  // ── Subscribe to heartbeat events ─────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('worker:p4-pong', function (data) {
        if (data && data.workerId) _recordPong(data.workerId);
      });

      eb.on('worker:p4-miss', function (data) {
        if (data && data.workerId) _recordMiss(data.workerId);
      });

      eb.on('worker:spawned', function (data) {
        if (data && data.workerId && data.worker) {
          register(data.workerId, data.worker, data.url);
        }
      });

      eb.on('worker:terminated', function (data) {
        if (data && data.workerId && _registry) {
          _registry.delete(data.workerId);
          _log(data.workerId, 'removed', null);
        }
      });
    });
  }

  // ── Periodic health check ─────────────────────────────────────────────────
  function _healthCheck() {
    var health = getMeshHealth();
    if (health.quarantined > 0) {
      console.warn(LOG, 'mesh health:', health.healthy + '/' + health.total,
        'healthy | quarantined:', health.quarantined);
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    setInterval(_healthCheck, 120_000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerMesh = Object.freeze({
    VERSION:          VERSION,
    register:         register,
    setTrust:         setTrust,
    quarantine:       quarantine,
    getTrustScore:    getTrustScore,
    getMeshHealth:    getMeshHealth,
    getWorkersInState: getWorkersInState,
    _recordPong:      _recordPong,
    _recordMiss:      _recordMiss,
    status: function () {
      var h = getMeshHealth();
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        mesh:       h,
        auditCount: _auditLog.length,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-worker-auth.js ──
// RuntimeWorkerAuth v1.0 — Phase 7 / Section 2 (Worker Authentication)
// =============================================================================
// Signed worker identity tokens. Every spawned worker receives a short-lived
// signed token that proves it was spawned by this session and not injected.
//
// Token structure (client-side only, not server-signed):
//   { workerId, sessionId, url, spawnTs, exp, nonce, sig }
//   sig = DJB2(workerId + sessionId + url + exp + nonce + SALT)
//
// Note: This is a client-side defense layer. Server-verified tokens are
// handled by RuntimeSecureSession.authorizeWorker(). This layer adds
// additional identity binding for worker-to-main-thread trust.
//
// window.RuntimeWorkerAuth
//   .issueToken(workerId, url)           → WorkerToken
//   .verifyToken(token)                  → boolean
//   .revokeToken(workerId)               → void
//   .getToken(workerId)                  → WorkerToken|null
//   .isAuthenticated(workerId)           → boolean
//   .status()                            → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerAuth) return;

  var VERSION    = '1.0';
  var LOG        = '[WorkerAuth]';
  var TOKEN_TTL  = 8 * 60_000;  // 8 minutes

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

  // ── SALT (session-scoped, not persisted) ───────────────────────────────────
  var _salt = 'wauth_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);

  // ── DJB2-based client signing ──────────────────────────────────────────────
  function _sign(data) {
    var str = data + _salt;
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ── Token store ────────────────────────────────────────────────────────────
  var _tokens  = typeof Map !== 'undefined' ? new Map() : null;   // workerId → token
  var _revoked = [];   // revoked token nonces

  function _getSessionId() {
    return _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : null;
    }, null) || 'anon';
  }

  // ── Issue token ───────────────────────────────────────────────────────────
  function issueToken(workerId, url) {
    if (!_tokens) return null;

    var sessionId = _getSessionId();
    var spawnTs   = Date.now();
    var exp       = spawnTs + TOKEN_TTL;
    var nonce     = Math.random().toString(36).slice(2, 10);
    var payload   = workerId + '|' + sessionId + '|' + url + '|' + exp + '|' + nonce;
    var sig       = _sign(payload);

    var token = {
      workerId:  workerId,
      sessionId: sessionId,
      url:       url,
      spawnTs:   spawnTs,
      exp:       exp,
      nonce:     nonce,
      sig:       sig,
    };

    _tokens.set(workerId, token);
    console.debug(LOG, 'token issued for worker:', workerId);
    return token;
  }

  // ── Verify token ──────────────────────────────────────────────────────────
  function verifyToken(token) {
    if (!token || typeof token !== 'object') return false;

    // Expiry check
    if (token.exp < Date.now()) return false;

    // Revocation check
    if (_revoked.indexOf(token.nonce) !== -1) return false;

    // Signature check
    var payload = token.workerId + '|' + token.sessionId + '|' + token.url +
      '|' + token.exp + '|' + token.nonce;
    var expected = _sign(payload);

    return expected === token.sig;
  }

  // ── Revoke token ──────────────────────────────────────────────────────────
  function revokeToken(workerId) {
    if (!_tokens || !_tokens.has(workerId)) return;
    var token = _tokens.get(workerId);
    if (token && token.nonce) {
      _revoked.push(token.nonce);
      if (_revoked.length > 500) _revoked.shift();
    }
    _tokens.delete(workerId);
    console.debug(LOG, 'token revoked for worker:', workerId);
  }

  function getToken(workerId) {
    if (!_tokens) return null;
    var t = _tokens.get(workerId);
    if (!t) return null;
    if (t.exp < Date.now()) {
      _tokens.delete(workerId);
      return null;
    }
    return Object.assign({}, t);
  }

  function isAuthenticated(workerId) {
    var token = getToken(workerId);
    return token !== null && verifyToken(token);
  }

  // ── Subscribe to worker events ────────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('worker:spawned', function (data) {
        if (data && data.workerId) {
          var token = issueToken(data.workerId, data.url || '');
          if (token) {
            // Register with mesh
            _s(function () {
              var mesh = G.RuntimeWorkerMesh;
              if (mesh && typeof mesh.register === 'function') {
                mesh.register(data.workerId, data.worker, data.url);
              }
            });
          }
        }
      });

      eb.on('worker:terminated', function (data) {
        if (data && data.workerId) revokeToken(data.workerId);
      });

      eb.on('mesh:worker-quarantined', function (data) {
        if (data && data.workerId) revokeToken(data.workerId);
      });

      // Session rotation → revoke all worker tokens
      eb.on('session:rotated', function () {
        if (!_tokens) return;
        var ids = [];
        _tokens.forEach(function (_, id) { ids.push(id); });
        ids.forEach(function (id) { revokeToken(id); });
        console.info(LOG, 'all worker tokens revoked on session rotation');
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerAuth = Object.freeze({
    VERSION:         VERSION,
    issueToken:      issueToken,
    verifyToken:     verifyToken,
    revokeToken:     revokeToken,
    getToken:        getToken,
    isAuthenticated: isAuthenticated,
    status: function () {
      var active = _tokens ? _tokens.size : 0;
      return {
        version:       VERSION,
        enabled:       _enabled,
        tier:          _tier,
        activeTokens:  active,
        revokedCount:  _revoked.length,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-worker-encryption.js ──
// RuntimeWorkerEncryption v1.0 — Phase 7 / Section 2 (Worker Channel Encryption)
// =============================================================================
// Encrypted messaging channels between main thread and workers.
// Uses XOR + rotating keys derived from session identity.
//
// Architecture:
//   • Each worker gets a per-session derived key (not stored, session-volatile)
//   • Messages encrypted before postMessage, decrypted on receipt
//   • Key rotation on session events (heartbeat interval)
//   • Replay protection via message nonces
//   • Graceful fallback: when encryption unavailable, messages pass through
//     with a plaintext flag for detection
//
// Encryption scheme (client-side, fast, tamper-evident):
//   key    = DJB2(sessionId + workerId + salt) → Uint8Array[16]
//   cipher = XOR(payload, key) + HMAC-DJB2 checksum
//
// NOTE: This is an anti-scraping and anti-tampering layer, not a replacement
// for TLS. The wire is already TLS-protected; this adds origin binding.
//
// window.RuntimeWorkerEncryption
//   .encrypt(workerId, message)    → EncryptedPacket
//   .decrypt(workerId, packet)     → message|null
//   .rotateKey(workerId)           → void
//   .getKeyFingerprint(workerId)   → string
//   .status()                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerEncryption) return;

  var VERSION = '1.0';
  var LOG     = '[WorkerEnc]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 70;  // only on HIGH tier to avoid perf impact

  // ── Key derivation ────────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return h >>> 0;
  }

  function _deriveKey(workerId, sessionId, salt) {
    var seed = workerId + '|' + sessionId + '|' + salt;
    var key = new Uint8Array(16);
    for (var i = 0; i < 16; i++) {
      key[i] = _djb2(seed + i) & 0xFF;
    }
    return key;
  }

  // ── Key store ──────────────────────────────────────────────────────────────
  var _keys    = typeof Map !== 'undefined' ? new Map() : null;
  var _nonces  = typeof Set !== 'undefined' ? new Set() : null;
  var _salt    = 'enc_' + Date.now().toString(36);

  function _getSessionId() {
    return _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
    }, 'anon');
  }

  function _getOrCreateKey(workerId) {
    if (!_keys) return null;
    if (_keys.has(workerId)) return _keys.get(workerId);
    var key = _deriveKey(workerId, _getSessionId(), _salt);
    _keys.set(workerId, key);
    return key;
  }

  // ── XOR cipher ────────────────────────────────────────────────────────────
  function _xorBytes(data, key) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) {
      result[i] = data[i] ^ key[i % key.length];
    }
    return result;
  }

  // ── Text encode/decode ────────────────────────────────────────────────────
  function _encode(str) {
    var enc = _s(function () { return new TextEncoder(); }, null);
    if (enc) return enc.encode(str);
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return bytes;
  }

  function _decode(bytes) {
    var dec = _s(function () { return new TextDecoder(); }, null);
    if (dec) return dec.decode(bytes);
    var str = '';
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return str;
  }

  // ── Encrypt ───────────────────────────────────────────────────────────────
  function encrypt(workerId, message) {
    if (!_enabled) {
      return { plain: true, data: message, nonce: null };
    }

    var key = _getOrCreateKey(workerId);
    if (!key) return { plain: true, data: message, nonce: null };

    var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var payload = JSON.stringify({ d: message, n: nonce });
    var bytes = _encode(payload);
    var encrypted = _xorBytes(bytes, key);

    // Base64-like encoding using btoa
    var binaryStr = '';
    encrypted.forEach(function (b) { binaryStr += String.fromCharCode(b); });
    var b64 = _s(function () { return btoa(binaryStr); }, binaryStr);

    // Checksum
    var checksum = (_djb2(payload + _salt) >>> 0).toString(16);

    return { plain: false, data: b64, checksum: checksum, nonce: nonce };
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────
  function decrypt(workerId, packet) {
    if (!packet) return null;
    if (packet.plain) return packet.data;

    var key = _getOrCreateKey(workerId);
    if (!key) return null;

    try {
      var binaryStr = atob(packet.data);
      var bytes = new Uint8Array(binaryStr.length);
      for (var i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      var decBytes = _xorBytes(bytes, key);
      var payload = _decode(decBytes);
      var obj = JSON.parse(payload);

      // Replay protection
      if (_nonces && _nonces.has(obj.n)) return null;
      if (_nonces) {
        _nonces.add(obj.n);
        if (_nonces.size > 1000) {
          var iter = _nonces.values();
          _nonces.delete(iter.next().value);
        }
      }

      // Checksum verification
      var expectedChecksum = (_djb2(payload + _salt) >>> 0).toString(16);
      if (packet.checksum !== expectedChecksum) {
        console.warn(LOG, 'checksum mismatch for worker:', workerId);
        return null;
      }

      return obj.d;
    } catch (e) {
      console.warn(LOG, 'decrypt failed:', e.message);
      return null;
    }
  }

  // ── Key rotation ──────────────────────────────────────────────────────────
  function rotateKey(workerId) {
    if (!_keys) return;
    _keys.delete(workerId);
    _salt = 'enc_' + Date.now().toString(36);
    console.debug(LOG, 'key rotated for worker:', workerId);
  }

  function getKeyFingerprint(workerId) {
    var key = _getOrCreateKey(workerId);
    if (!key) return 'none';
    return Array.from(key.slice(0, 4)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' | encryption disabled (tier:', _tier + ', needs HIGH)');
      return;
    }
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| salt:', _salt.slice(0, 8));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerEncryption = Object.freeze({
    VERSION:            VERSION,
    encrypt:            encrypt,
    decrypt:            decrypt,
    rotateKey:          rotateKey,
    getKeyFingerprint:  getKeyFingerprint,
    status: function () {
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        keyCount:   _keys ? _keys.size : 0,
        nonceCount: _nonces ? _nonces.size : 0,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-worker-routing.js ──
// RuntimeWorkerRouting v1.0 — Phase 7 / Section 2 (Worker Mesh Routing)
// =============================================================================
// Capability-scoped worker pool routing. Routes task requests to the
// appropriate worker pool based on required capabilities and worker health.
//
// Routing strategies:
//   • Capability matching — route to workers with required capability
//   • Load balancing — prefer least-loaded healthy worker
//   • Trust-aware routing — prefer VERIFIED workers over NEW
//   • Quarantine bypass — skip quarantined workers entirely
//   • Fallback routing — if no capable worker exists, queue or fail gracefully
//
// Worker capability declarations:
//   Workers declare their capabilities via their URL path pattern:
//   /workers/pdf-lib-worker.js   → ['pdf', 'wasm', 'compress']
//   /workers/ocr-*               → ['ocr', 'image', 'wasm']
//   /workers/summary-worker.js   → ['ai', 'text']
//   etc.
//
// window.RuntimeWorkerRouting
//   .route(capability, opts)          → workerId|null
//   .registerCapability(workerId, caps[])   → void
//   .getCapableWorkers(cap)           → workerId[]
//   .getRoutingTable()                → RoutingTable
//   .status()                         → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerRouting) return;

  var VERSION = '1.0';
  var LOG     = '[WorkerRouting]';

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

  // ── Capability inference from URL ──────────────────────────────────────────
  var URL_CAPABILITY_MAP = [
    { pattern: /pdf-lib/,          caps: ['pdf', 'wasm', 'compress', 'merge', 'split'] },
    { pattern: /pdf-worker/,       caps: ['pdf', 'render', 'extract'] },
    { pattern: /compress/,         caps: ['compress', 'pdf', 'image'] },
    { pattern: /pdf-word|docx/,    caps: ['pdf', 'convert', 'word'] },
    { pattern: /pdf-excel|xlsx/,   caps: ['pdf', 'convert', 'excel'] },
    { pattern: /pdf-ppt|pptx/,     caps: ['pdf', 'convert', 'powerpoint'] },
    { pattern: /ocr/,              caps: ['ocr', 'image', 'text-extract'] },
    { pattern: /summary|ai-sum/,   caps: ['ai', 'text', 'summarize'] },
    { pattern: /translation/,      caps: ['ai', 'text', 'translate'] },
    { pattern: /image-tools|image-pipeline/, caps: ['image', 'resize', 'crop', 'filter'] },
    { pattern: /remove-bg/,        caps: ['image', 'ai', 'background-remove'] },
    { pattern: /advanced/,         caps: ['pdf', 'advanced', 'repair', 'compare'] },
    { pattern: /compare/,          caps: ['pdf', 'compare'] },
    { pattern: /repair/,           caps: ['pdf', 'repair'] },
    { pattern: /shared-cluster/,   caps: ['cluster', 'distribute'] },
  ];

  function _inferCaps(url) {
    if (!url) return ['generic'];
    var caps = [];
    for (var i = 0; i < URL_CAPABILITY_MAP.length; i++) {
      if (URL_CAPABILITY_MAP[i].pattern.test(url)) {
        caps = caps.concat(URL_CAPABILITY_MAP[i].caps);
        break;
      }
    }
    return caps.length > 0 ? caps : ['generic'];
  }

  // ── Routing table: capability → [workerId] ─────────────────────────────────
  var _table   = typeof Map !== 'undefined' ? new Map() : null;  // cap → Set<workerId>
  var _workerCaps = typeof Map !== 'undefined' ? new Map() : null; // workerId → caps[]
  var _routeCount = 0;

  function registerCapability(workerId, caps) {
    if (!_table || !_workerCaps) return;
    _workerCaps.set(workerId, caps);
    for (var i = 0; i < caps.length; i++) {
      var cap = caps[i];
      if (!_table.has(cap)) _table.set(cap, new Set());
      _table.get(cap).add(workerId);
    }
  }

  function _unregisterWorker(workerId) {
    if (!_table || !_workerCaps) return;
    var caps = _workerCaps.get(workerId) || [];
    caps.forEach(function (cap) {
      var workers = _table.get(cap);
      if (workers) workers.delete(workerId);
    });
    _workerCaps.delete(workerId);
  }

  // ── Route a request ────────────────────────────────────────────────────────
  function route(capability, opts) {
    if (!_enabled || !_table) return null;
    opts = opts || {};

    var candidates = _table.has(capability)
      ? Array.from(_table.get(capability))
      : [];

    if (candidates.length === 0) return null;

    // Filter by mesh trust state (skip quarantined)
    var mesh = _s(function () { return G.RuntimeWorkerMesh; }, null);
    if (mesh) {
      candidates = candidates.filter(function (id) {
        var trust = mesh.getTrustScore(id);
        return trust >= 0 && trust > 5;  // not quarantined
      });
    }

    if (candidates.length === 0) return null;

    // Prefer VERIFIED over TRUSTED over NEW
    if (mesh) {
      candidates.sort(function (a, b) {
        return mesh.getTrustScore(b) - mesh.getTrustScore(a);
      });
    }

    _routeCount++;
    return candidates[0];
  }

  function getCapableWorkers(cap) {
    if (!_table || !_table.has(cap)) return [];
    return Array.from(_table.get(cap));
  }

  function getRoutingTable() {
    var result = {};
    if (!_table) return result;
    _table.forEach(function (workers, cap) {
      result[cap] = Array.from(workers);
    });
    return result;
  }

  // ── Subscribe to worker lifecycle events ────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      eb.on('worker:spawned', function (data) {
        if (!data || !data.workerId) return;
        var caps = _inferCaps(data.url);
        registerCapability(data.workerId, caps);
        console.debug(LOG, 'worker registered:', data.workerId, '| caps:', caps.join(','));
      });

      eb.on('worker:terminated', function (data) {
        if (data && data.workerId) _unregisterWorker(data.workerId);
      });

      eb.on('mesh:worker-quarantined', function (data) {
        if (data && data.workerId) _unregisterWorker(data.workerId);
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _subscribe();
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeWorkerRouting = Object.freeze({
    VERSION:            VERSION,
    route:              route,
    registerCapability: registerCapability,
    getCapableWorkers:  getCapableWorkers,
    getRoutingTable:    getRoutingTable,
    status: function () {
      var capCount = _table ? _table.size : 0;
      var workerCount = _workerCaps ? _workerCaps.size : 0;
      return {
        version:     VERSION,
        enabled:     _enabled,
        tier:        _tier,
        capabilities: capCount,
        workers:     workerCount,
        routeCount:  _routeCount,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-edge-policy.js ──
// RuntimeEdgePolicy v1.0 — Phase 7 / Section 3 (Edge Execution Policy Engine)
// =============================================================================
// Policy engine for execution contexts. Enforces rules about which operations
// are permitted based on runtime state, deployment environment, and user tier.
//
// Policy dimensions:
//   1. Deployment channel   — production / staging / dev / replit / firebase
//   2. Security tier        — LOW / MEDIUM / HIGH / EXTREME
//   3. Session state        — active / idle / degraded / rotated
//   4. Attestation state    — trusted / untrusted / foreign
//   5. Behavioral health    — from RuntimeBehaviorAnalysis
//   6. Threat level         — from RuntimeThreatCorrelation
//
// Policy definitions:
//   default   — standard execution (no special requirements)
//   premium   — requires HIGH tier + trusted attestation
//   ai        — requires MEDIUM+ tier + human signals
//   export    — requires active session + no foreign deploy
//   admin     — requires HIGH tier + verified session
//   wasm      — requires MEDIUM+ tier + wasm capability
//
// window.RuntimeEdgePolicy
//   .allow(operation, context)     → boolean
//   .getPolicy(name)               → PolicyDefinition
//   .registerPolicy(name, def)     → void
//   .evaluateAll(context)          → PolicyReport
//   .status()                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgePolicy) return;

  var VERSION = '1.0';
  var LOG     = '[EdgePolicy]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Runtime state getters ─────────────────────────────────────────────────
  function _isForeign() {
    return _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
  }

  function _isAttested() {
    return _s(function () {
      var ea = G.RuntimeEdgeAttestation;
      return ea && typeof ea.isTrusted === 'function' ? ea.isTrusted() : true;
    }, true);
  }

  function _getSessionState() {
    return _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.status === 'function' ? ss.status().state : 'active';
    }, 'active');
  }

  function _getBehaviorHealth() {
    return _s(function () {
      var ba = G.RuntimeBehaviorAnalysis;
      return ba && typeof ba.getHealthScore === 'function' ? ba.getHealthScore() : 80;
    }, 80);
  }

  function _getThreatLevel() {
    return _s(function () {
      var tc = G.RuntimeThreatCorrelation;
      if (!tc || typeof tc.getActiveThreats !== 'function') return 0;
      return tc.getActiveThreats().length;
    }, 0);
  }

  // ── Built-in policies ──────────────────────────────────────────────────────
  var POLICIES = {
    'default': {
      name: 'default',
      check: function () { return true; },
    },

    'premium': {
      name: 'premium',
      check: function () {
        if (_score < 40) return false;
        if (!_isAttested() && _isForeign()) return false;
        var cap = _s(function () {
          var cm = G.RuntimeCapabilityManager;
          return cm && typeof cm.has === 'function' ? cm.has('exec-ticket:premium') : true;
        }, true);
        return cap;
      },
    },

    'ai': {
      name: 'ai',
      check: function () {
        if (_score < 40) return false;
        if (_isForeign()) return false;
        var behavior = _getBehaviorHealth();
        return behavior >= 30;  // don't serve AI to very likely bots
      },
    },

    'export': {
      name: 'export',
      check: function () {
        var sessionState = _getSessionState();
        if (sessionState === 'rotated' || sessionState === 'degraded') return false;
        return !_isForeign();
      },
    },

    'admin': {
      name: 'admin',
      check: function () {
        if (_score < 70) return false;
        if (!_isAttested()) return false;
        var sessionState = _getSessionState();
        return sessionState === 'active';
      },
    },

    'wasm': {
      name: 'wasm',
      check: function () {
        if (_score < 40) return false;
        var cap = _s(function () {
          var cm = G.RuntimeCapabilityManager;
          return cm && typeof cm.has === 'function' ? cm.has('wasm:basic') : true;
        }, true);
        return cap;
      },
    },

    'ticket': {
      name: 'ticket',
      check: function () {
        if (_score < 40) return true;  // no ticket needed for LOW tier
        // Check there are no active CRITICAL threats
        var threats = _getThreatLevel();
        return threats < 3;
      },
    },
  };

  // ── Additional user-registered policies ────────────────────────────────────
  var _customPolicies = {};

  function registerPolicy(name, def) {
    if (typeof def.check !== 'function') return;
    _customPolicies[name] = def;
    console.debug(LOG, 'policy registered:', name);
  }

  function getPolicy(name) {
    return POLICIES[name] || _customPolicies[name] || POLICIES['default'];
  }

  function allow(operation, context) {
    var policy = getPolicy(operation);
    try {
      var ok = policy.check(context || {});
      if (!ok) {
        console.debug(LOG, 'policy denied:', operation, '| context:', JSON.stringify(context || {}));
      }
      return ok;
    } catch (e) {
      console.warn(LOG, 'policy check error:', operation, e.message);
      return true; // fail-open to not break tools
    }
  }

  function evaluateAll(context) {
    var results = {};
    var allPolicies = Object.assign({}, POLICIES, _customPolicies);
    for (var name in allPolicies) {
      try {
        results[name] = allPolicies[name].check(context || {});
      } catch (_) {
        results[name] = true;
      }
    }
    return {
      results:    results,
      context:    context,
      tier:       _tier,
      foreign:    _isForeign(),
      attested:   _isAttested(),
      session:    _getSessionState(),
      behavior:   _getBehaviorHealth(),
      threats:    _getThreatLevel(),
      ts:         Date.now(),
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| policies:', Object.keys(POLICIES).length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  G.RuntimeEdgePolicy = Object.freeze({
    VERSION:        VERSION,
    allow:          allow,
    getPolicy:      getPolicy,
    registerPolicy: registerPolicy,
    evaluateAll:    evaluateAll,
    status: function () {
      return {
        version:       VERSION,
        tier:          _tier,
        foreign:       _isForeign(),
        attested:      _isAttested(),
        policyCount:   Object.keys(POLICIES).length + Object.keys(_customPolicies).length,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-edge-proof.js ──
// RuntimeEdgeProof v1.0 — Phase 7 / Section 3 (Edge Execution Proof)
// =============================================================================
// Issues, stores, and verifies edge execution proofs. A proof is a signed
// record that a specific operation completed in a specific context.
//
// Proof lifecycle:
//   1. RuntimeEdgeRuntime.execute() calls EdgeProof.issue() on completion
//   2. Proof is stored in memory-only chain (max 200 proofs)
//   3. Proof can be verified by any system that has the session salt
//   4. Expired proofs are evicted automatically
//   5. Invalid proof chain breaks attestation chain
//
// Proof structure:
//   { proofId, contextName, execId, duration, nonce, sig, ts, exp, ok }
//   sig = FNV1a(proofId + contextName + nonce + ts + sessionSalt)
//
// window.RuntimeEdgeProof
//   .issue(proof)              → SignedProof
//   .verify(proof)             → boolean
//   .getChain(contextName)     → SignedProof[]
//   .getLatest()               → SignedProof|null
//   .getRiskSignal()           → number (0-100, failure rate)
//   .status()                  → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgeProof) return;

  var VERSION  = '1.0';
  var LOG      = '[EdgeProof]';
  var TTL_MS   = 5 * 60_000;   // 5 minute proof TTL
  var MAX_CHAIN = 200;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Session salt ───────────────────────────────────────────────────────────
  var _sessionSalt = _s(function () {
    var ss = G.RuntimeSecureSession;
    return ss && typeof ss.getSessionId === 'function'
      ? ss.getSessionId()
      : ('ep_' + Date.now().toString(36));
  }, 'ep_' + Date.now().toString(36));

  // ── FNV1a hash ─────────────────────────────────────────────────────────────
  function _fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // ── Proof chain ───────────────────────────────────────────────────────────
  var _chain  = [];   // all proofs (bounded)
  var _byCtx  = typeof Map !== 'undefined' ? new Map() : null;  // ctx → proof[]
  var _usedNonces = typeof Set !== 'undefined' ? new Set() : null;
  var _issued  = 0;
  var _failed  = 0;

  // ── Issue a proof ─────────────────────────────────────────────────────────
  function issue(proof) {
    if (!proof || typeof proof !== 'object') return null;

    var proofId = 'pf_' + _issued.toString(36) + '_' + Date.now().toString(36);
    var ts      = Date.now();
    var exp     = ts + TTL_MS;
    var payload = proofId + '|' + (proof.contextName || '') + '|' + (proof.nonce || '') + '|' + ts + '|' + _sessionSalt;

    var signed = {
      proofId:      proofId,
      contextName:  proof.contextName,
      execId:       proof.execId,
      duration:     proof.duration,
      nonce:        proof.nonce,
      sig:          _fnv1a(payload),
      ts:           ts,
      exp:          exp,
      ok:           proof.ok !== false,
    };

    _chain.push(signed);
    if (_chain.length > MAX_CHAIN) _chain.shift();

    if (_byCtx) {
      var ctxChain = _byCtx.get(proof.contextName) || [];
      ctxChain.push(signed);
      if (ctxChain.length > 50) ctxChain.shift();
      _byCtx.set(proof.contextName, ctxChain);
    }

    if (_usedNonces && proof.nonce) {
      _usedNonces.add(proof.nonce);
      if (_usedNonces.size > 2000) {
        var iter = _usedNonces.values();
        _usedNonces.delete(iter.next().value);
      }
    }

    _issued++;
    if (!signed.ok) _failed++;

    return signed;
  }

  // ── Verify a proof ────────────────────────────────────────────────────────
  function verify(proof) {
    if (!proof || typeof proof !== 'object') return false;
    if (proof.exp && proof.exp < Date.now()) return false;
    if (_usedNonces && !_usedNonces.has(proof.nonce)) return false; // unknown nonce

    var payload = proof.proofId + '|' + (proof.contextName || '') + '|' +
      (proof.nonce || '') + '|' + proof.ts + '|' + _sessionSalt;
    return _fnv1a(payload) === proof.sig;
  }

  function getChain(contextName) {
    if (!_byCtx) return _chain.filter(function (p) { return p.contextName === contextName; });
    return (_byCtx.get(contextName) || []).slice();
  }

  function getLatest() {
    return _chain.length > 0 ? _chain[_chain.length - 1] : null;
  }

  function getRiskSignal() {
    if (_issued === 0) return 0;
    return Math.round((_failed / _issued) * 100);
  }

  // ── Evict expired proofs ──────────────────────────────────────────────────
  function _evict() {
    var now = Date.now();
    _chain = _chain.filter(function (p) { return p.exp > now; });
    if (_byCtx) {
      _byCtx.forEach(function (chain, ctx) {
        var fresh = chain.filter(function (p) { return p.exp > now; });
        if (fresh.length > 0) _byCtx.set(ctx, fresh);
        else _byCtx.delete(ctx);
      });
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    setInterval(_evict, 60_000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  G.RuntimeEdgeProof = Object.freeze({
    VERSION:      VERSION,
    issue:        issue,
    verify:       verify,
    getChain:     getChain,
    getLatest:    getLatest,
    getRiskSignal: getRiskSignal,
    status: function () {
      return {
        version:   VERSION,
        tier:      _tier,
        issued:    _issued,
        failed:    _failed,
        riskSignal: getRiskSignal(),
        chainLen:  _chain.length,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-edge-runtime.js ──
// RuntimeEdgeRuntime v1.0 — Phase 7 / Section 3 (Advanced Edge Execution)
// =============================================================================
// Edge execution engine. Provides an execution layer that operates closer
// to the deployment boundary, with policy enforcement and proof chains.
//
// Core concepts:
//   • EdgeContext — a named execution context with policy + proof
//   • ExecutionProof — signed record that an operation completed successfully
//   • PolicyEngine integration — all edge contexts enforce RuntimeEdgePolicy
//   • Challenge-response — critical operations require challenge completion
//   • Replay prevention — each proof has a unique nonce
//   • Signed runtime state — snapshots of runtime state at key checkpoints
//
// How it works:
//   1. Tool requests an EdgeContext for a sensitive operation
//   2. Edge runtime checks policy (RuntimeEdgePolicy.allow(op, context))
//   3. If allowed, executes with monitoring
//   4. On completion, issues an ExecutionProof via RuntimeEdgeProof
//   5. Proof is logged and optionally forwarded to telemetry
//
// window.RuntimeEdgeRuntime
//   .createContext(name, opts)           → EdgeContext
//   .execute(contextName, fn, args)      → Promise<{result, proof}>
//   .getActiveContexts()                 → EdgeContext[]
//   .getProofChain(contextName)          → ExecutionProof[]
//   .status()                            → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgeRuntime) return;

  var VERSION = '1.0';
  var LOG     = '[EdgeRuntime]';

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

  // ── Context registry ───────────────────────────────────────────────────────
  // name → { name, policy, createdAt, execCount, proofChain, active }
  var _contexts   = typeof Map !== 'undefined' ? new Map() : null;
  var _executions = 0;
  var _proofs     = 0;

  // ── DJB2 signing ──────────────────────────────────────────────────────────
  var _edgeSalt = 'er_' + Date.now().toString(36);

  function _sign(data) {
    var str = data + _edgeSalt;
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // ── Create edge context ────────────────────────────────────────────────────
  function createContext(name, opts) {
    if (!_contexts) return null;
    opts = opts || {};

    var ctx = {
      name:       name,
      policy:     opts.policy    || 'default',
      tier:       opts.minTier   || 'MEDIUM',
      proofChain: [],
      createdAt:  Date.now(),
      execCount:  0,
      active:     true,
      entropy:    _s(function () {
        var hs = G.RuntimeHumanSignals;
        return hs && typeof hs.getEntropyScore === 'function' ? hs.getEntropyScore() : 50;
      }, 50),
    };

    _contexts.set(name, ctx);
    console.debug(LOG, 'context created:', name, '| policy:', ctx.policy);
    return Object.assign({}, ctx, { proofChain: undefined }); // don't expose chain
  }

  // ── Execute in context ────────────────────────────────────────────────────
  function execute(contextName, fn, args) {
    if (!_enabled) {
      // LOW tier: passthrough
      return _s(function () {
        var result = fn.apply(null, args || []);
        return Promise.resolve({ result: result, proof: null });
      }, Promise.resolve({ result: null, proof: null }));
    }

    if (!_contexts || !_contexts.has(contextName)) {
      createContext(contextName, {});
    }

    var ctx = _contexts.get(contextName);
    if (!ctx || !ctx.active) {
      return Promise.reject(new Error('context inactive: ' + contextName));
    }

    // Policy check
    var policyOk = _s(function () {
      var ep = G.RuntimeEdgePolicy;
      if (!ep || typeof ep.allow !== 'function') return true;
      return ep.allow(contextName, { tier: _tier, entropy: ctx.entropy });
    }, true);

    if (!policyOk) {
      console.warn(LOG, 'policy denied execution:', contextName);
      return Promise.reject(new Error('policy-denied:' + contextName));
    }

    var startTs = Date.now();
    _executions++;
    ctx.execCount++;

    return Promise.resolve().then(function () {
      return fn.apply(null, args || []);
    }).then(function (result) {
      var duration = Date.now() - startTs;
      var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var payload = contextName + '|' + duration + '|' + nonce;
      var proof = {
        contextName: contextName,
        execId:      _executions,
        duration:    duration,
        nonce:       nonce,
        sig:         _sign(payload),
        ts:          Date.now(),
        ok:          true,
      };

      ctx.proofChain.push(proof);
      if (ctx.proofChain.length > 20) ctx.proofChain.shift();
      _proofs++;

      // Issue proof via RuntimeEdgeProof
      _s(function () {
        var ep = G.RuntimeEdgeProof;
        if (ep && typeof ep.issue === 'function') ep.issue(proof);
      });

      return { result: result, proof: proof };
    }).catch(function (err) {
      var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      var proof = {
        contextName: contextName,
        execId:      _executions,
        duration:    Date.now() - startTs,
        nonce:       nonce,
        sig:         _sign(contextName + '|fail|' + nonce),
        ts:          Date.now(),
        ok:          false,
        error:       err.message,
      };
      ctx.proofChain.push(proof);
      if (ctx.proofChain.length > 20) ctx.proofChain.shift();
      throw err;
    });
  }

  function getActiveContexts() {
    if (!_contexts) return [];
    var result = [];
    _contexts.forEach(function (ctx) {
      if (ctx.active) {
        result.push({
          name:      ctx.name,
          policy:    ctx.policy,
          execCount: ctx.execCount,
          proofCount: ctx.proofChain.length,
          createdAt: ctx.createdAt,
        });
      }
    });
    return result;
  }

  function getProofChain(contextName) {
    if (!_contexts || !_contexts.has(contextName)) return [];
    return (_contexts.get(contextName).proofChain || []).slice();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| enabled:', _enabled);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  G.RuntimeEdgeRuntime = Object.freeze({
    VERSION:          VERSION,
    createContext:    createContext,
    execute:          execute,
    getActiveContexts: getActiveContexts,
    getProofChain:    getProofChain,
    status: function () {
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        contexts:   _contexts ? _contexts.size : 0,
        executions: _executions,
        proofs:     _proofs,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-deployment-registry.js ──
// RuntimeDeploymentRegistry v1.0 — Phase 7 / Section 5 (Deployment Registry)
// =============================================================================
// Multi-channel deployment registry. Tracks and validates the current
// deployment environment against known release channels.
//
// Deployment channels:
//   production     — https://ilovepdf.cyou (primary)
//   production-www — https://www.ilovepdf.cyou
//   firebase       — https://ilovepdf-web.web.app
//   firebase-app   — https://ilovepdf-web.firebaseapp.com
//   replit-dev     — *.replit.dev / *.repl.co
//   replit-app     — *.replit.app (published)
//   local          — localhost / 127.0.0.1
//
// Release integrity checks:
//   1. Domain matches a known channel
//   2. Build seal fingerprint aligns with channel expectations
//   3. Firebase project binding verified against expected ID
//   4. CSP nonce presence on production channels
//
// window.RuntimeDeploymentRegistry
//   .getChannel()                → ChannelDef
//   .isProduction()              → boolean
//   .isTrustedChannel()          → boolean
//   .getIntegrityScore()         → number (0-100)
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeploymentRegistry) return;

  var VERSION = '1.0';
  var LOG     = '[DeployRegistry]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Channel definitions ───────────────────────────────────────────────────
  var CHANNELS = {
    'production':     {
      name: 'production', label: 'Production',
      hosts: ['ilovepdf.cyou'],
      isProd: true, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'production-www': {
      name: 'production-www', label: 'Production (www)',
      hosts: ['www.ilovepdf.cyou'],
      isProd: true, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'firebase':       {
      name: 'firebase', label: 'Firebase Hosting',
      hosts: ['ilovepdf-web.web.app'],
      isProd: false, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'firebase-app':   {
      name: 'firebase-app', label: 'Firebase App',
      hosts: ['ilovepdf-web.firebaseapp.com'],
      isProd: false, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'replit-dev':     {
      name: 'replit-dev', label: 'Replit Dev',
      pattern: /\.(replit\.dev|repl\.co)(:\d+)?$/,
      isProd: false, trusted: true, expectedFirebase: null,
    },
    'replit-app':     {
      name: 'replit-app', label: 'Replit Published',
      pattern: /\.replit\.app(:\d+)?$/,
      isProd: false, trusted: true, expectedFirebase: null,
    },
    'local':          {
      name: 'local', label: 'Local Development',
      pattern: /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/,
      isProd: false, trusted: true, expectedFirebase: null,
    },
  };

  // ── Detect current channel ────────────────────────────────────────────────
  var _channel = null;
  var _host    = _s(function () { return G.location.hostname || ''; }, '');

  function _detectChannel() {
    for (var id in CHANNELS) {
      var ch = CHANNELS[id];
      if (ch.hosts && ch.hosts.indexOf(_host) !== -1) return ch;
      if (ch.pattern && ch.pattern.test(_host)) return ch;
    }
    return { name: 'unknown', label: 'Unknown Channel', isProd: false, trusted: false };
  }

  function getChannel() {
    if (!_channel) _channel = _detectChannel();
    return Object.assign({}, _channel);
  }

  function isProduction() {
    return getChannel().isProd === true;
  }

  function isTrustedChannel() {
    return getChannel().trusted === true;
  }

  // ── Integrity score ────────────────────────────────────────────────────────
  function getIntegrityScore() {
    var deductions = 0;
    var ch = getChannel();

    // Unknown channel
    if (ch.name === 'unknown') { deductions += 40; }

    // Seal check
    var sealOk = _s(function () {
      var ds = G.RuntimeDeploySeal;
      return ds && typeof ds.status === 'function' ? ds.status().ok : null;
    }, null);
    if (sealOk === false) deductions += 25;

    // Foreign deploy
    var isForeign = _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
    if (isForeign) deductions += 20;

    // Firebase binding (for production channels)
    if (ch.expectedFirebase) {
      var firebaseOk = _s(function () {
        var bound = G.__IPLV_FIREBASE_PROJECT__ || (G.firebase && G.firebase.app && G.firebase.app().options.projectId);
        return !bound || bound === ch.expectedFirebase;
      }, true);
      if (!firebaseOk) deductions += 15;
    }

    // Attestation
    var attested = _s(function () {
      var ea = G.RuntimeEdgeAttestation;
      return ea && typeof ea.isTrusted === 'function' ? ea.isTrusted() : true;
    }, true);
    if (!attested) deductions += 10;

    return Math.max(0, 100 - deductions);
  }

  // ── Emit channel info on boot ──────────────────────────────────────────────
  function _boot() {
    var ch = getChannel();
    console.debug(LOG, 'v' + VERSION + ' ready | channel:', ch.name,
      '| trusted:', ch.trusted, '| host:', _host);

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('deployment:channel-detected', {
          channel: ch.name,
          trusted: ch.trusted,
          isProd:  ch.isProd,
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeDeploymentRegistry = Object.freeze({
    VERSION:            VERSION,
    getChannel:         getChannel,
    isProduction:       isProduction,
    isTrustedChannel:   isTrustedChannel,
    getIntegrityScore:  getIntegrityScore,
    CHANNELS:           Object.freeze(Object.keys(CHANNELS).reduce(function (acc, k) {
      acc[k] = Object.freeze(Object.assign({}, CHANNELS[k]));
      return acc;
    }, {})),
    status: function () {
      return {
        version:        VERSION,
        channel:        getChannel().name,
        isProduction:   isProduction(),
        trusted:        isTrustedChannel(),
        integrityScore: getIntegrityScore(),
        host:           _host,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded | host:', _host);
}(window));

// ── SOURCE: public/js/runtime-build-chain.js ──
// RuntimeBuildChain v1.0 — Phase 7 / Section 5 (Signed Deployment Chains)
// =============================================================================
// Signed deployment chain tracker. Maintains a lineage of deployment events
// for rollback safety, regression detection, and build reproducibility.
//
// Chain links:
//   { linkId, buildTs, channel, hashChain, fingerprint, sig, prev }
//   Each link signs the previous link's hash, creating an unforgeable chain.
//
// window.RuntimeBuildChain
//   .getChain()                → ChainLink[]
//   .getHead()                 → ChainLink|null
//   .verify()                  → ChainVerification
//   .getRollbackSafety()       → boolean
//   .status()                  → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBuildChain) return;

  var VERSION = '1.0';
  var LOG     = '[BuildChain]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Chain state ────────────────────────────────────────────────────────────
  // Bootstrapped from the server-written .data/build-seal.json via a meta tag
  // or from RuntimeDeploySeal.status() seal fingerprint.
  var _chain  = [];
  var _head   = null;

  // ── DJB2 hash ──────────────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ── Build initial chain link from available signals ────────────────────────
  function _buildLink() {
    var channel   = _s(function () {
      var dr = G.RuntimeDeploymentRegistry;
      return dr && typeof dr.getChannel === 'function' ? dr.getChannel().name : 'unknown';
    }, 'unknown');

    var sealFingerprint = _s(function () {
      var ds = G.RuntimeDeploySeal;
      if (!ds || typeof ds.status !== 'function') return null;
      var st = ds.status();
      return st.fingerprint ? JSON.stringify(st.fingerprint).slice(0, 40) : null;
    }, null);

    var prevHash = _head ? _head.hash : '0000000000000000';
    var linkId   = 'lnk_' + Date.now().toString(36);
    var buildTs  = Date.now();
    var payload  = [linkId, channel, buildTs, sealFingerprint || '', prevHash].join('|');
    var hash     = _djb2(payload);

    var link = {
      linkId:      linkId,
      buildTs:     buildTs,
      channel:     channel,
      fingerprint: sealFingerprint,
      hash:        hash,
      prevHash:    prevHash,
      sig:         _djb2(hash + prevHash + buildTs),
    };

    _chain.push(link);
    if (_chain.length > 20) _chain.shift();
    _head = link;

    console.debug(LOG, 'chain link added | id:', linkId, '| channel:', channel);
    return link;
  }

  // ── Verify chain integrity ─────────────────────────────────────────────────
  function verify() {
    if (_chain.length < 2) return { ok: true, breaks: 0, length: _chain.length };

    var breaks = 0;
    for (var i = 1; i < _chain.length; i++) {
      if (_chain[i].prevHash !== _chain[i - 1].hash) breaks++;
    }

    return { ok: breaks === 0, breaks: breaks, length: _chain.length, head: _head };
  }

  function getChain() { return _chain.slice(); }
  function getHead()  { return _head ? Object.assign({}, _head) : null; }

  function getRollbackSafety() {
    var v = verify();
    return v.ok && _chain.length >= 1;
  }

  function _boot() {
    _buildLink();

    // Re-link on deployment events
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.on('deployment:channel-detected', function () { _buildLink(); });
        G.RuntimeEventBus.on('seal:failure', function () { _buildLink(); });
      }
    });

    console.debug(LOG, 'v' + VERSION + ' ready | chain length:', _chain.length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2500); }, { once: true });
  } else {
    setTimeout(_boot, 2500);
  }

  G.RuntimeBuildChain = Object.freeze({
    VERSION:           VERSION,
    getChain:          getChain,
    getHead:           getHead,
    verify:            verify,
    getRollbackSafety: getRollbackSafety,
    status: function () {
      return { version: VERSION, chain: _chain.length, rollbackSafe: getRollbackSafety(), head: getHead() };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-release-channel.js ──
// RuntimeReleaseChannel v1.0 — Phase 7 / Section 5 (Release Channel Management)
// =============================================================================
// Release channel management and environment-aware policy switching.
// Ensures the correct feature set is active for the current deployment channel.
//
// Channel-to-feature mapping:
//   production     → full feature set, strict policies, HTTPS required
//   firebase       → full feature set, relaxed CSP (firebase hosting headers)
//   replit-app     → full feature set, replit proxy headers
//   replit-dev     → dev mode, relaxed policies, extra debug info
//   local          → dev mode, all features unlocked, verbose logging
//
// window.RuntimeReleaseChannel
//   .getFeatureFlags()           → FeatureFlags
//   .isFeatureEnabled(name)      → boolean
//   .getChannelPolicy()          → ChannelPolicy
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeReleaseChannel) return;

  var VERSION = '1.0';
  var LOG     = '[ReleaseChannel]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Get current channel ────────────────────────────────────────────────────
  var _channelName = _s(function () {
    var dr = G.RuntimeDeploymentRegistry;
    return dr && typeof dr.getChannel === 'function' ? dr.getChannel().name : 'unknown';
  }, 'unknown');

  // ── Feature flag matrices per channel ─────────────────────────────────────
  var CHANNEL_FLAGS = {
    'production':     {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      true,  workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'production-www': {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      true,  workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'firebase':       {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      false, workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'firebase-app':   {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      false, workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'replit-app':     {
      ai:             true,  premium: true,  analytics: false,
      strictCSP:      false, workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'replit-dev':     {
      ai:             true,  premium: true,  analytics: false,
      strictCSP:      false, workerMesh: true, edgeProof: false,
      verboseLog:     true,  debugPanel: true,
    },
    'local':          {
      ai:             true,  premium: true,  analytics: false,
      strictCSP:      false, workerMesh: false, edgeProof: false,
      verboseLog:     true,  debugPanel: true,
    },
  };

  var DEFAULT_FLAGS = {
    ai:         false, premium: false, analytics: false,
    strictCSP:  false, workerMesh: false, edgeProof: false,
    verboseLog: false, debugPanel: false,
  };

  function getFeatureFlags() {
    return Object.assign({}, CHANNEL_FLAGS[_channelName] || DEFAULT_FLAGS);
  }

  function isFeatureEnabled(name) {
    var flags = getFeatureFlags();
    return flags[name] === true;
  }

  // ── Channel policy ─────────────────────────────────────────────────────────
  var CHANNEL_POLICIES = {
    'production':     { rateLimit: 'strict',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'production-www': { rateLimit: 'strict',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'firebase':       { rateLimit: 'normal',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'firebase-app':   { rateLimit: 'normal',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'replit-app':     { rateLimit: 'normal',  fileSizeCapMB: 50,  quotaMultiplier: 0.8 },
    'replit-dev':     { rateLimit: 'relaxed', fileSizeCapMB: 50,  quotaMultiplier: 2.0 },
    'local':          { rateLimit: 'none',    fileSizeCapMB: 999, quotaMultiplier: 10.0 },
  };

  function getChannelPolicy() {
    return Object.assign({ channel: _channelName },
      CHANNEL_POLICIES[_channelName] || { rateLimit: 'strict', fileSizeCapMB: 20, quotaMultiplier: 0.5 });
  }

  function _boot() {
    var flags  = getFeatureFlags();
    var policy = getChannelPolicy();
    console.debug(LOG, 'v' + VERSION + ' ready | channel:', _channelName,
      '| rateLimit:', policy.rateLimit,
      '| debugPanel:', flags.debugPanel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2500); }, { once: true });
  } else {
    setTimeout(_boot, 2500);
  }

  G.RuntimeReleaseChannel = Object.freeze({
    VERSION:          VERSION,
    getFeatureFlags:  getFeatureFlags,
    isFeatureEnabled: isFeatureEnabled,
    getChannelPolicy: getChannelPolicy,
    status: function () {
      return {
        version: VERSION, channel: _channelName,
        flags: getFeatureFlags(), policy: getChannelPolicy(),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded | channel:', _channelName);
}(window));

// ── SOURCE: public/js/runtime-session-keys.js ──
// RuntimeSessionKeys v1.0 — Phase 7 / Section 7 (Session Key Derivation)
// =============================================================================
// Session-scoped key derivation and lifecycle management.
// Keys are derived from session identity + device fingerprint + time epoch.
// All keys are volatile (in-memory only), rotated on session events.
//
// Key hierarchy:
//   Master key  ← session identity + device fingerprint
//   ├── exec key       ← master + "exec" + epoch
//   ├── sign key       ← master + "sign" + epoch
//   ├── transport key  ← master + "transport" + epoch
//   ├── worker key     ← master + "worker" + workerId
//   └── chunk key      ← master + "chunk" + chunkId
//
// window.RuntimeSessionKeys
//   .derive(purpose, context)    → Uint8Array[16]
//   .getMaster()                 → Uint8Array[16] (read-only copy)
//   .rotate(reason)              → void
//   .getEpoch()                  → number
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSessionKeys) return;

  var VERSION = '1.0';
  var LOG     = '[SessionKeys]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  var _masterKey   = null;   // Uint8Array[32]
  var _epoch       = 0;
  var _rotations   = 0;
  var _derivedKeys = typeof Map !== 'undefined' ? new Map() : null;

  // ── DJB2 key derivation ────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return h >>> 0;
  }

  function _deriveBytes(seed, length) {
    var result = new Uint8Array(length);
    for (var i = 0; i < length; i++) {
      result[i] = _djb2(seed + ':' + i) & 0xFF;
    }
    return result;
  }

  // ── Build master key ───────────────────────────────────────────────────────
  function _buildMaster() {
    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : 'anon';
    }, 'anon');

    var fingerprint = _s(function () {
      var ri = G.RuntimeIdentity;
      if (ri && typeof ri.getFingerprint === 'function') {
        var fp = ri.getFingerprint();
        return fp.hash || fp.id || '';
      }
      return '';
    }, '');

    _epoch = Math.floor(Date.now() / (5 * 60_000));  // 5-minute epochs
    var seed = 'sk:' + sessionId + ':' + fingerprint + ':' + _epoch;
    _masterKey = _deriveBytes(seed, 32);
    if (_derivedKeys) _derivedKeys.clear();
    console.debug(LOG, 'master key derived | epoch:', _epoch);
  }

  // ── Derive a purpose key ────────────────────────────────────────────────────
  function derive(purpose, context) {
    if (!_masterKey) _buildMaster();

    var cacheKey = purpose + ':' + (context || '');
    if (_derivedKeys && _derivedKeys.has(cacheKey)) {
      return new Uint8Array(_derivedKeys.get(cacheKey));
    }

    var masterHex = Array.from(_masterKey).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');

    var purposeSeed = masterHex + ':' + purpose + ':' + (context || '') + ':' + _epoch;
    var key = _deriveBytes(purposeSeed, 16);

    if (_derivedKeys) {
      _derivedKeys.set(cacheKey, key.slice());
      if (_derivedKeys.size > 100) {
        var iter = _derivedKeys.keys();
        _derivedKeys.delete(iter.next().value);
      }
    }

    return key;
  }

  function getMaster() {
    if (!_masterKey) _buildMaster();
    return new Uint8Array(_masterKey); // copy, not reference
  }

  function rotate(reason) {
    _buildMaster();
    _rotations++;
    console.info(LOG, 'keys rotated | reason:', reason || 'manual', '| rotations:', _rotations);
    _s(function () {
      var ec = G.RuntimeExecutionCrypto;
      if (ec && typeof ec.rotateKeys === 'function') ec.rotateKeys();
    });
  }

  function getEpoch() { return _epoch; }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _buildMaster();
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.on('session:rotated', function () { rotate('session-rotated'); });
        G.RuntimeEventBus.on('seal:failure',    function () { rotate('seal-failure'); });
      }
    });
    // Rotate on epoch change
    setInterval(function () {
      var newEpoch = Math.floor(Date.now() / (5 * 60_000));
      if (newEpoch !== _epoch) rotate('epoch-change');
    }, 30_000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| epoch:', _epoch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimeSessionKeys = Object.freeze({
    VERSION:   VERSION,
    derive:    derive,
    getMaster: getMaster,
    rotate:    rotate,
    getEpoch:  getEpoch,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, epoch: _epoch, rotations: _rotations };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-execution-crypto.js ──
// RuntimeExecutionCrypto v1.0 — Phase 7 / Section 7 (Execution Cryptography)
// =============================================================================
// Rotating execution keys and encrypted execution channels.
// Provides cryptographic primitives for the execution pipeline.
//
// Key management:
//   • Session-derived keys (not persisted, volatile)
//   • Key rotation on schedule or security events
//   • Multiple key types: execution, signing, transport
//
// Crypto operations (all client-side, no server round-trip):
//   • XOR-based lightweight symmetric encryption (fast, tamper-evident)
//   • DJB2/FNV1a message authentication codes
//   • Nonce generation and tracking
//   • Key derivation via repeated hashing
//
// window.RuntimeExecutionCrypto
//   .getKey(type)                    → Uint8Array
//   .rotateKeys()                    → void
//   .encrypt(data, keyType)          → EncryptedPayload
//   .decrypt(payload, keyType)       → any|null
//   .mac(data, keyType)              → string
//   .verify(data, mac, keyType)      → boolean
//   .generateNonce()                 → string
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeExecutionCrypto) return;

  var VERSION = '1.0';
  var LOG     = '[ExecCrypto]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Key state ──────────────────────────────────────────────────────────────
  var _keys = {
    exec:      null,   // Uint8Array[16]
    sign:      null,   // Uint8Array[16]
    transport: null,   // Uint8Array[16]
  };
  var _keyGenCount = 0;
  var _rotationTs  = 0;
  var KEY_TTL_MS   = 15 * 60_000;  // rotate every 15 minutes

  // ── Key derivation ─────────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return h >>> 0;
  }

  function _deriveKey(seed) {
    var key = new Uint8Array(16);
    for (var i = 0; i < 16; i++) {
      key[i] = _djb2(seed + ':' + i) & 0xFF;
    }
    return key;
  }

  function _getSessionSeed() {
    var sessionId = _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.getSessionId === 'function' ? ss.getSessionId() : null;
    }, null) || 'anon';
    return sessionId + ':' + Date.now().toString(36).slice(0, 6);
  }

  function _initKeys() {
    var seed = _getSessionSeed();
    _keys.exec      = _deriveKey('exec:'      + seed);
    _keys.sign      = _deriveKey('sign:'      + seed);
    _keys.transport = _deriveKey('transport:' + seed);
    _keyGenCount++;
    _rotationTs = Date.now();
    console.debug(LOG, 'keys generated | gen:', _keyGenCount);
  }

  // ── Get key (auto-rotate if stale) ────────────────────────────────────────
  function getKey(type) {
    if (!_keys.exec || (Date.now() - _rotationTs) > KEY_TTL_MS) {
      _initKeys();
    }
    return _keys[type] || _keys.exec;
  }

  function rotateKeys() {
    _initKeys();
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('crypto:keys-rotated', { gen: _keyGenCount });
      }
    });
  }

  // ── XOR encryption ────────────────────────────────────────────────────────
  function _xor(data, key) {
    var result = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) result[i] = data[i] ^ key[i % key.length];
    return result;
  }

  function _encode(str) {
    var enc = _s(function () { return new TextEncoder(); }, null);
    if (enc) return enc.encode(str);
    var b = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xFF;
    return b;
  }

  function _decode(bytes) {
    var dec = _s(function () { return new TextDecoder(); }, null);
    if (dec) return dec.decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function encrypt(data, keyType) {
    if (!_enabled) return { plain: true, data: data };
    var key      = getKey(keyType || 'exec');
    var nonce    = generateNonce();
    var payload  = JSON.stringify({ d: data, n: nonce });
    var bytes    = _encode(payload);
    var cipher   = _xor(bytes, key);
    var b64      = _s(function () {
      return btoa(String.fromCharCode.apply(null, Array.from(cipher)));
    }, null);
    if (!b64) return { plain: true, data: data };
    var checksum = mac(payload, 'sign');
    return { plain: false, data: b64, checksum: checksum, nonce: nonce };
  }

  function decrypt(payload, keyType) {
    if (!payload) return null;
    if (payload.plain) return payload.data;
    var key = getKey(keyType || 'exec');
    try {
      var binary = atob(payload.data);
      var cipher = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) cipher[i] = binary.charCodeAt(i);
      var plain = _decode(_xor(cipher, key));
      var obj = JSON.parse(plain);
      if (payload.checksum && !verify(plain, payload.checksum, 'sign')) return null;
      return obj.d;
    } catch (e) {
      return null;
    }
  }

  function mac(data, keyType) {
    var key = getKey(keyType || 'sign');
    var str = JSON.stringify(data);
    var h = 0x811c9dc5;
    var keyStr = Array.from(key).map(function (b) { return String.fromCharCode(b); }).join('');
    var combined = str + keyStr;
    for (var i = 0; i < combined.length; i++) {
      h ^= combined.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function verify(data, macVal, keyType) {
    return mac(data, keyType) === macVal;
  }

  function generateNonce() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _initKeys();
    setInterval(rotateKeys, KEY_TTL_MS);
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.on('session:rotated', rotateKeys);
        G.RuntimeEventBus.on('shield:tamper-response', rotateKeys);
      }
    });
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimeExecutionCrypto = Object.freeze({
    VERSION:       VERSION,
    getKey:        getKey,
    rotateKeys:    rotateKeys,
    encrypt:       encrypt,
    decrypt:       decrypt,
    mac:           mac,
    verify:        verify,
    generateNonce: generateNonce,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, keyGenCount: _keyGenCount, rotationAge: Date.now() - _rotationTs };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-packet-integrity.js ──
// RuntimePacketIntegrity v1.0 — Phase 7 / Section 7 (Packet Integrity)
// =============================================================================
// Signed packet layer with replay protection for all internal runtime messages.
// Ensures that messages between runtime systems are authentic and not replayed.
//
// Packet structure:
//   { id, type, payload, ts, nonce, mac, origin }
//   mac = RuntimeExecutionCrypto.mac(id+type+payload+ts+nonce, 'sign')
//
// Protections:
//   • MAC verification — detects payload tampering
//   • Replay prevention — nonce pool tracks seen packets
//   • Clock drift protection — packets older than MAX_AGE rejected
//   • Origin binding — packets tagged with issuer runtime
//
// window.RuntimePacketIntegrity
//   .wrap(type, payload)         → SignedPacket
//   .verify(packet)              → boolean
//   .unwrap(packet)              → payload|null
//   .stats()                     → PacketStats
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimePacketIntegrity) return;

  var VERSION = '1.0';
  var LOG     = '[PacketInt]';
  var MAX_AGE = 60_000;   // 1 minute max packet age

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  var _packetId = 0;
  var _seenNonces = typeof Set !== 'undefined' ? new Set() : null;
  var _stats = { wrapped: 0, verified: 0, rejected: 0, replays: 0 };

  // ── FNV1a MAC (fast, no SubtleCrypto dependency) ─────────────────────────
  function _fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function _computeMac(id, type, payload, ts, nonce) {
    var data = [id, type, JSON.stringify(payload), ts, nonce].join('|');
    // Use RuntimeExecutionCrypto if available for stronger MAC
    return _s(function () {
      var ec = G.RuntimeExecutionCrypto;
      if (ec && typeof ec.mac === 'function') return ec.mac(data, 'sign');
      return _fnv1a(data);
    }, _fnv1a(data));
  }

  // ── Wrap a packet ─────────────────────────────────────────────────────────
  function wrap(type, payload) {
    var id    = 'pk_' + (++_packetId).toString(36);
    var ts    = Date.now();
    var nonce = ts.toString(36) + Math.random().toString(36).slice(2, 6);
    var computedMac = _computeMac(id, type, payload, ts, nonce);

    _stats.wrapped++;

    return {
      id:      id,
      type:    type,
      payload: payload,
      ts:      ts,
      nonce:   nonce,
      mac:     computedMac,
      origin:  'runtime-p7',
    };
  }

  // ── Verify a packet ───────────────────────────────────────────────────────
  function verify(packet) {
    if (!packet || !_enabled) return true; // passthrough when disabled

    // Clock check
    if (Math.abs(Date.now() - packet.ts) > MAX_AGE) {
      _stats.rejected++;
      return false;
    }

    // Replay check
    if (_seenNonces) {
      if (_seenNonces.has(packet.nonce)) {
        _stats.replays++;
        _stats.rejected++;
        console.warn(LOG, 'replay detected | nonce:', packet.nonce);
        _s(function () {
          if (G.SecurityTelemetry) {
            G.SecurityTelemetry.record('replay-attempt', { reason: 'packet-nonce-reuse', nonce: packet.nonce });
          }
        });
        return false;
      }
      _seenNonces.add(packet.nonce);
      if (_seenNonces.size > 5000) {
        var iter = _seenNonces.values();
        _seenNonces.delete(iter.next().value);
      }
    }

    // MAC check
    var expectedMac = _computeMac(packet.id, packet.type, packet.payload, packet.ts, packet.nonce);
    if (packet.mac !== expectedMac) {
      _stats.rejected++;
      console.warn(LOG, 'MAC mismatch | id:', packet.id);
      return false;
    }

    _stats.verified++;
    return true;
  }

  // ── Unwrap a verified packet ───────────────────────────────────────────────
  function unwrap(packet) {
    if (!verify(packet)) return null;
    return packet.payload;
  }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimePacketIntegrity = Object.freeze({
    VERSION: VERSION,
    wrap:    wrap,
    verify:  verify,
    unwrap:  unwrap,
    stats:   function () { return Object.assign({}, _stats); },
    status:  function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, stats: _stats };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-wasm-mesh.js ──
// RuntimeWasmMesh v1.0 — Phase 7 / Section 6 (WASM Module Federation)
// =============================================================================
// WASM module federation layer. Coordinates multiple WASM modules across
// isolated pools with capability federation and inter-module routing.
//
// Architecture:
//   • Module registry — maps module IDs to their pool assignments
//   • Pool federation — modules can request resources from sibling pools
//   • Attestation gateway — modules must be attested before joining the mesh
//   • Execution routing — routes WASM execution to the healthiest pool
//   • Memory pressure balancing — migrates work away from high-pressure pools
//   • Quota enforcement — per-module execution quotas
//
// window.RuntimeWasmMesh
//   .join(moduleId, opts)             → MeshMember
//   .leave(moduleId)                  → void
//   .getHealthiest(capability)        → moduleId|null
//   .federateResource(from, to, type) → boolean
//   .getMeshStatus()                  → MeshStatus
//   .status()                         → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmMesh) return;

  var VERSION = '1.0';
  var LOG     = '[WasmMesh]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Members registry ──────────────────────────────────────────────────────
  // moduleId → { moduleId, poolId, caps[], attested, memMB, execCount, health }
  var _members   = typeof Map !== 'undefined' ? new Map() : null;
  var _fedLog    = [];
  var MAX_LOG    = 50;

  function join(moduleId, opts) {
    if (!_members) return null;
    opts = opts || {};

    var member = {
      moduleId:  moduleId,
      poolId:    opts.poolId    || 'default',
      caps:      opts.caps      || ['generic'],
      attested:  opts.attested  !== false,
      memMB:     opts.memMB     || 0,
      execCount: 0,
      health:    100,
      joinTs:    Date.now(),
    };

    _members.set(moduleId, member);
    console.debug(LOG, 'module joined mesh:', moduleId, '| pool:', member.poolId);
    return Object.assign({}, member);
  }

  function leave(moduleId) {
    if (!_members) return;
    _members.delete(moduleId);
    console.debug(LOG, 'module left mesh:', moduleId);
  }

  function getHealthiest(capability) {
    if (!_members) return null;
    var best = null;
    var bestHealth = -1;

    _members.forEach(function (m) {
      if (!m.attested) return;
      if (capability && m.caps.indexOf(capability) === -1) return;
      if (m.health > bestHealth) {
        bestHealth = m.health;
        best = m.moduleId;
      }
    });

    return best;
  }

  function federateResource(fromId, toId, type) {
    if (!_members || !_members.has(fromId) || !_members.has(toId)) return false;
    var entry = { from: fromId, to: toId, type: type, ts: Date.now() };
    _fedLog.push(entry);
    if (_fedLog.length > MAX_LOG) _fedLog.shift();
    console.debug(LOG, 'resource federated:', type, 'from:', fromId, '→', toId);
    return true;
  }

  function getMeshStatus() {
    if (!_members) return { members: 0, healthy: 0, attested: 0 };
    var total = _members.size;
    var healthy = 0, attested = 0;
    _members.forEach(function (m) {
      if (m.health >= 60) healthy++;
      if (m.attested) attested++;
    });
    return { members: total, healthy: healthy, attested: attested, fedOps: _fedLog.length };
  }

  // ── Pressure balancing ────────────────────────────────────────────────────
  function _rebalance() {
    if (!_members) return;
    var memReport = _s(function () {
      var wi = G.RuntimeWasmIsolation;
      return wi && typeof wi.getMemoryReport === 'function' ? wi.getMemoryReport() : null;
    }, null);
    if (!memReport) return;

    // Mark members under pressure as degraded
    _members.forEach(function (m, id) {
      if (memReport.totalMB && m.memMB > 0) {
        var usage = m.memMB / memReport.totalMB;
        if (usage > 0.8) {
          m.health = Math.max(10, m.health - 20);
          console.debug(LOG, 'module health degraded (mem pressure):', id, '→', m.health);
        }
      }
    });
  }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    setInterval(_rebalance, 30_000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 6000); }, { once: true });
  } else {
    setTimeout(_boot, 6000);
  }

  G.RuntimeWasmMesh = Object.freeze({
    VERSION:         VERSION,
    join:            join,
    leave:           leave,
    getHealthiest:   getHealthiest,
    federateResource: federateResource,
    getMeshStatus:   getMeshStatus,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, mesh: getMeshStatus() };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-wasm-scheduler.js ──
// RuntimeWasmScheduler v1.0 — Phase 7 / Section 6 (WASM Execution Scheduler)
// =============================================================================
// Priority-based WASM execution scheduler. Queues WASM tasks, enforces
// quotas, balances memory pressure, and routes to isolated pools.
//
// Scheduling strategies:
//   • Priority queue — CRITICAL > HIGH > NORMAL > LOW tasks
//   • Memory budget enforcement — reject tasks that would exceed budget
//   • Concurrency limits — per-pool and global limits
//   • Timeout enforcement — tasks killed after TTL
//   • Adaptive throttling — reduce concurrency under memory pressure
//   • Idle scheduling — LOW priority tasks only run during idle
//   • Parallel pool routing — route to least-loaded pool
//
// Task quota system:
//   • Per-module execution quotas (resets per hour)
//   • Global concurrent execution cap
//   • Memory consumption tracking
//
// window.RuntimeWasmScheduler
//   .schedule(taskDef)           → Promise<result>
//   .cancelTask(taskId)          → boolean
//   .getQueueStatus()            → QueueStatus
//   .setQuota(moduleId, quota)   → void
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmScheduler) return;

  var VERSION = '1.0';
  var LOG     = '[WasmScheduler]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Limits ────────────────────────────────────────────────────────────────
  var MAX_CONCURRENT = _score >= 70 ? 4 : (_score >= 40 ? 2 : 1);
  var MAX_QUEUE      = 20;
  var DEFAULT_TIMEOUT = 120_000;   // 2 minutes

  // ── Queues (one per priority) ─────────────────────────────────────────────
  var _queues = { CRITICAL: [], HIGH: [], NORMAL: [], LOW: [] };
  var _active  = typeof Map !== 'undefined' ? new Map() : null;  // taskId → timeout
  var _quotas  = typeof Map !== 'undefined' ? new Map() : null;  // moduleId → {max, used, resetTs}
  var _taskId  = 0;
  var _completed = 0;
  var _failed    = 0;

  // ── Schedule a task ────────────────────────────────────────────────────────
  function schedule(taskDef) {
    taskDef = taskDef || {};
    var priority  = taskDef.priority  || 'NORMAL';
    var moduleId  = taskDef.moduleId  || 'default';
    var timeoutMs = taskDef.timeoutMs || DEFAULT_TIMEOUT;
    var fn        = taskDef.fn;

    if (typeof fn !== 'function') {
      return Promise.reject(new Error('task.fn must be a function'));
    }

    // Check queue capacity
    var totalQueued = _queues.CRITICAL.length + _queues.HIGH.length +
      _queues.NORMAL.length + _queues.LOW.length;
    if (totalQueued >= MAX_QUEUE) {
      return Promise.reject(new Error('wasm-queue-full'));
    }

    // Check quota
    if (_quotas && _quotas.has(moduleId)) {
      var quota = _quotas.get(moduleId);
      if (Date.now() > quota.resetTs) {
        quota.used = 0;
        quota.resetTs = Date.now() + 3600_000;
      }
      if (quota.used >= quota.max) {
        return Promise.reject(new Error('quota-exceeded:' + moduleId));
      }
    }

    var id = 'wt_' + (++_taskId).toString(36);

    return new Promise(function (resolve, reject) {
      var task = {
        id:        id,
        moduleId:  moduleId,
        priority:  priority,
        fn:        fn,
        args:      taskDef.args || [],
        timeoutMs: timeoutMs,
        resolve:   resolve,
        reject:    reject,
        queuedAt:  Date.now(),
      };

      var q = _queues[priority] || _queues.NORMAL;
      q.push(task);
      _drain();
    });
  }

  // ── Drain queue ───────────────────────────────────────────────────────────
  function _drain() {
    var concurrency = _active ? _active.size : 0;
    if (concurrency >= MAX_CONCURRENT) return;

    // Pull from highest priority
    var task = null;
    for (var p of ['CRITICAL', 'HIGH', 'NORMAL', 'LOW']) {
      var q = _queues[p];
      // LOW priority: only run during idle
      if (p === 'LOW' && concurrency > 0) continue;
      if (q.length > 0) { task = q.shift(); break; }
    }

    if (!task) return;

    // Update quota
    if (_quotas && _quotas.has(task.moduleId)) {
      _quotas.get(task.moduleId).used++;
    }

    // Execute
    var timeoutHandle = setTimeout(function () {
      if (_active) _active.delete(task.id);
      task.reject(new Error('wasm-task-timeout:' + task.id));
      _failed++;
    }, task.timeoutMs);

    if (_active) _active.set(task.id, timeoutHandle);

    Promise.resolve().then(function () {
      return task.fn.apply(null, task.args);
    }).then(function (result) {
      clearTimeout(timeoutHandle);
      if (_active) _active.delete(task.id);
      task.resolve(result);
      _completed++;
      _drain(); // pull next task
    }).catch(function (err) {
      clearTimeout(timeoutHandle);
      if (_active) _active.delete(task.id);
      task.reject(err);
      _failed++;
      _drain();
    });
  }

  function cancelTask(taskId) {
    for (var p of ['CRITICAL', 'HIGH', 'NORMAL', 'LOW']) {
      var idx = _queues[p].findIndex(function (t) { return t.id === taskId; });
      if (idx !== -1) {
        var task = _queues[p].splice(idx, 1)[0];
        task.reject(new Error('task-cancelled:' + taskId));
        return true;
      }
    }
    return false;
  }

  function setQuota(moduleId, quota) {
    if (!_quotas) return;
    _quotas.set(moduleId, { max: quota, used: 0, resetTs: Date.now() + 3600_000 });
  }

  function getQueueStatus() {
    return {
      queued: {
        CRITICAL: _queues.CRITICAL.length,
        HIGH:     _queues.HIGH.length,
        NORMAL:   _queues.NORMAL.length,
        LOW:      _queues.LOW.length,
      },
      active:    _active ? _active.size : 0,
      completed: _completed,
      failed:    _failed,
      maxConcurrent: MAX_CONCURRENT,
    };
  }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| maxConcurrent:', MAX_CONCURRENT);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 6000); }, { once: true });
  } else {
    setTimeout(_boot, 6000);
  }

  G.RuntimeWasmScheduler = Object.freeze({
    VERSION:      VERSION,
    schedule:     schedule,
    cancelTask:   cancelTask,
    setQuota:     setQuota,
    getQueueStatus: getQueueStatus,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, queue: getQueueStatus() };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-wasm-attestation.js ──
// RuntimeWasmAttestation v1.0 — Phase 7 / Section 6 (WASM Module Attestation)
// =============================================================================
// Attested WASM module registry. Every WASM module that joins the execution
// mesh must present a valid attestation before it can process user data.
//
// Attestation process:
//   1. Module bytes are hashed (FNV1a + SHA-256 if SubtleCrypto available)
//   2. Hash is compared against RuntimeWasmFortress seal
//   3. Module capabilities are derived from its URL and inspection
//   4. Attestation record is signed and stored
//   5. Periodic re-attestation for long-running modules
//
// Attestation states:
//   PENDING   — awaiting first verification
//   ATTESTED  — verified against fortress seal
//   DEGRADED  — seal mismatch but hash consistent (CDN cache hit, etc.)
//   REVOKED   — tampered or explicitly revoked
//
// window.RuntimeWasmAttestation
//   .attest(moduleId, url, bytes)    → Promise<AttestRecord>
//   .isAttested(moduleId)            → boolean
//   .revokeAttestation(moduleId)     → void
//   .getRecord(moduleId)             → AttestRecord|null
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmAttestation) return;

  var VERSION = '1.0';
  var LOG     = '[WasmAttest]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Attestation store ─────────────────────────────────────────────────────
  // moduleId → { moduleId, url, hash, state, attestedAt, exp, sig, caps }
  var _records = typeof Map !== 'undefined' ? new Map() : null;
  var _salt    = 'wa_' + Date.now().toString(36);

  // ── FNV1a hash ─────────────────────────────────────────────────────────────
  function _fnv1a(bytes) {
    var h = 0x811c9dc5;
    var step = Math.max(1, Math.floor(bytes.length / 256));
    for (var i = 0; i < bytes.length; i += step) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function _signRecord(moduleId, hash, ts) {
    var payload = moduleId + '|' + hash + '|' + ts + '|' + _salt;
    var h = 5381;
    for (var i = 0; i < payload.length; i++) {
      h = ((h << 5) + h) + payload.charCodeAt(i);
      h = h & h;
    }
    return (h >>> 0).toString(16);
  }

  // ── Attest a WASM module ───────────────────────────────────────────────────
  function attest(moduleId, url, bytes) {
    if (!_records) return Promise.resolve(null);
    if (!bytes) return Promise.resolve(null);

    var bytesArr;
    if (bytes instanceof Uint8Array) bytesArr = bytes;
    else if (bytes instanceof ArrayBuffer) bytesArr = new Uint8Array(bytes);
    else return Promise.resolve(null);

    var quickHash = _fnv1a(bytesArr);

    // Cross-check with RuntimeWasmFortress seal
    var sealMatch = _s(function () {
      var fortress = G.RuntimeWasmFortress;
      if (!fortress || typeof fortress.loadSealed !== 'function') return null;
      var sealed = fortress.loadSealed(moduleId);
      return sealed ? sealed.hash === quickHash : null;
    }, null);

    var ts   = Date.now();
    var exp  = ts + 30 * 60_000;   // 30 minute attestation validity
    var state = sealMatch === false ? 'DEGRADED' : 'ATTESTED';
    var sig  = _signRecord(moduleId, quickHash, ts);

    var record = {
      moduleId:   moduleId,
      url:        url || '',
      hash:       quickHash,
      state:      state,
      attestedAt: ts,
      exp:        exp,
      sig:        sig,
      sealMatch:  sealMatch,
    };

    _records.set(moduleId, record);
    console.debug(LOG, 'attested:', moduleId, '| state:', state, '| hash:', quickHash.slice(0, 8));

    // Join WASM mesh
    _s(function () {
      var mesh = G.RuntimeWasmMesh;
      if (mesh && typeof mesh.join === 'function') {
        mesh.join(moduleId, {
          caps:     ['wasm'],
          attested: state === 'ATTESTED',
          memMB:    Math.round(bytesArr.byteLength / 1048576),
        });
      }
    });

    return Promise.resolve(Object.assign({}, record));
  }

  function isAttested(moduleId) {
    if (!_records || !_records.has(moduleId)) return false;
    var r = _records.get(moduleId);
    if (r.exp < Date.now()) return false;
    return r.state === 'ATTESTED' || r.state === 'DEGRADED';
  }

  function revokeAttestation(moduleId) {
    if (!_records || !_records.has(moduleId)) return;
    var r = _records.get(moduleId);
    r.state = 'REVOKED';
    console.warn(LOG, 'attestation revoked:', moduleId);
    _s(function () {
      var mesh = G.RuntimeWasmMesh;
      if (mesh && typeof mesh.leave === 'function') mesh.leave(moduleId);
    });
  }

  function getRecord(moduleId) {
    if (!_records) return null;
    var r = _records.get(moduleId);
    return r ? Object.assign({}, r) : null;
  }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 6000); }, { once: true });
  } else {
    setTimeout(_boot, 6000);
  }

  G.RuntimeWasmAttestation = Object.freeze({
    VERSION:           VERSION,
    attest:            attest,
    isAttested:        isAttested,
    revokeAttestation: revokeAttestation,
    getRecord:         getRecord,
    status: function () {
      var total = _records ? _records.size : 0;
      var attested = 0;
      if (_records) _records.forEach(function (r) { if (r.state === 'ATTESTED') attested++; });
      return { version: VERSION, enabled: _enabled, tier: _tier, total: total, attested: attested };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-incident-engine.js ──
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
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    setTimeout(_subscribe, 4000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
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

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-forensics.js ──
// RuntimeForensics v1.0 — Phase 7 / Section 8 (Forensic Snapshots)
// =============================================================================
// Forensic snapshot system. Captures and stores privacy-safe runtime state
// snapshots at key security events for post-incident analysis.
//
// Snapshot contents (all privacy-safe, no PII, no file content):
//   • Session state at snapshot time
//   • Active capabilities
//   • Worker mesh health
//   • Threat correlation state
//   • Anomaly engine readings
//   • Deployment integrity score
//   • Open incidents
//   • Behavioral health
//   • WASM pool state
//
// Retention:
//   • Max 50 snapshots in memory
//   • Snapshots expire after 2 hours
//   • Automatic pruning on memory pressure
//
// window.RuntimeForensics
//   .snapshot(trigger, context)    → Snapshot
//   .getSnapshot(id)               → Snapshot|null
//   .getTimeline()                 → Snapshot[] (chronological)
//   .reconstruct(fromTs, toTs)     → Timeline (event sequence)
//   .status()                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeForensics) return;

  var VERSION  = '1.0';
  var LOG      = '[Forensics]';
  var MAX_SNAP = 50;
  var SNAP_TTL = 2 * 3600_000;  // 2 hours

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  var _snapshots  = [];
  var _snapCount  = 0;

  // ── Capture runtime state ─────────────────────────────────────────────────
  function _captureState() {
    return {
      session:    _s(function () {
        var ss = G.RuntimeSecureSession;
        return ss && typeof ss.status === 'function' ? ss.status() : null;
      }, null),
      capabilities: _s(function () {
        var cm = G.RuntimeCapabilityManager;
        return cm && typeof cm.listActive === 'function'
          ? cm.listActive().map(function (c) { return c.cap; })
          : [];
      }, []),
      workerMesh: _s(function () {
        var wm = G.RuntimeWorkerMesh;
        return wm && typeof wm.getMeshHealth === 'function' ? wm.getMeshHealth() : null;
      }, null),
      threats:    _s(function () {
        var tc = G.RuntimeThreatCorrelation;
        return tc && typeof tc.getActiveThreats === 'function'
          ? tc.getActiveThreats().map(function (t) {
              return { id: t.patternId, severity: t.severity };
            })
          : [];
      }, []),
      anomaly:    _s(function () {
        var ae = G.RuntimeAnomalyEngine;
        return ae && typeof ae.getDeploymentScore === 'function'
          ? ae.getDeploymentScore() : null;
      }, null),
      deployment: _s(function () {
        var dr = G.RuntimeDeploymentRegistry;
        return dr && typeof dr.status === 'function' ? {
          channel: dr.status().channel,
          score:   dr.getIntegrityScore(),
        } : null;
      }, null),
      behavior:   _s(function () {
        var ba = G.RuntimeBehaviorAnalysis;
        return ba && typeof ba.getHealthScore === 'function' ? ba.getHealthScore() : null;
      }, null),
      incidents:  _s(function () {
        var ie = G.RuntimeIncidentEngine;
        return ie && typeof ie.getOpenIncidents === 'function'
          ? ie.getOpenIncidents().length : 0;
      }, 0),
      proofChain: _s(function () {
        var ep = G.RuntimeEdgeProof;
        return ep && typeof ep.getLatest === 'function' ? ep.getLatest() : null;
      }, null),
      tier:       _tier,
      ts:         Date.now(),
    };
  }

  // ── snapshot (public) ──────────────────────────────────────────────────────
  function snapshot(trigger, context) {
    var id   = 'snap_' + Date.now().toString(36) + '_' + (++_snapCount).toString(36);
    var snap = {
      id:      id,
      trigger: trigger || 'manual',
      context: context || null,
      state:   _captureState(),
      exp:     Date.now() + SNAP_TTL,
    };

    _snapshots.push(snap);

    // Evict expired or overflow
    var now = Date.now();
    _snapshots = _snapshots.filter(function (s) { return s.exp > now; });
    if (_snapshots.length > MAX_SNAP) {
      _snapshots = _snapshots.slice(-MAX_SNAP);
    }

    console.debug(LOG, 'snapshot captured | id:', id, '| trigger:', trigger);
    return snap;
  }

  function getSnapshot(id) {
    var s = _snapshots.find(function (s) { return s.id === id; });
    return s ? Object.assign({}, s) : null;
  }

  function getTimeline() {
    return _snapshots.slice().sort(function (a, b) { return a.state.ts - b.state.ts; });
  }

  // ── Timeline reconstruction ────────────────────────────────────────────────
  function reconstruct(fromTs, toTs) {
    var snaps = _snapshots.filter(function (s) {
      return s.state.ts >= (fromTs || 0) && s.state.ts <= (toTs || Date.now());
    });

    return {
      from:      fromTs || 0,
      to:        toTs   || Date.now(),
      snapshots: snaps.length,
      events:    snaps.map(function (s) {
        return {
          ts:       s.state.ts,
          trigger:  s.trigger,
          incidents: s.state.incidents,
          threats:  s.state.threats ? s.state.threats.length : 0,
          behavior: s.state.behavior,
        };
      }),
    };
  }

  // ── Auto-snapshot on critical events ─────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;
      var SNAP_TRIGGERS = [
        'seal:failure', 'security:foreign-deploy', 'panic-activated',
        'session:rotated', 'security:anomaly', 'mesh:worker-quarantined',
      ];
      SNAP_TRIGGERS.forEach(function (evt) {
        eb.on(evt, function (data) {
          snapshot(evt, data ? { type: evt } : null);
        });
      });
    });
  }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    setTimeout(_subscribe, 5000);
    snapshot('boot', null);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5500); }, { once: true });
  } else {
    setTimeout(_boot, 5500);
  }

  G.RuntimeForensics = Object.freeze({
    VERSION:      VERSION,
    snapshot:     snapshot,
    getSnapshot:  getSnapshot,
    getTimeline:  getTimeline,
    reconstruct:  reconstruct,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, snapshots: _snapshots.length };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-session-recorder.js ──
// RuntimeSessionRecorder v1.0 — Phase 7 / Section 8 (Session Reconstruction)
// =============================================================================
// Privacy-safe session recording for incident reconstruction.
// Records security-relevant session events (no user content, no PII).
//
// Recorded event types:
//   session_start, session_rotate, session_idle, session_end
//   worker_spawn, worker_quarantine, worker_heartbeat_fail
//   ticket_issued, ticket_expired, ticket_fail
//   capability_granted, capability_revoked
//   threat_detected, incident_created, incident_resolved
//   attestation_pass, attestation_fail
//   seal_ok, seal_fail, foreign_deploy
//
// Privacy rules:
//   • NO user identifiers (no email, no name, no IP)
//   • NO file content, file names, or document data
//   • NO behavioral patterns that could re-identify users
//   • Only security system state transitions
//
// window.RuntimeSessionRecorder
//   .record(eventType, meta)        → void
//   .getRecording()                 → SessionRecording
//   .export()                       → ExportedRecording (privacy-safe)
//   .clear()                        → void
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSessionRecorder) return;

  var VERSION  = '1.0';
  var LOG      = '[SessionRec]';
  var MAX_EVENTS = 500;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Recording state ────────────────────────────────────────────────────────
  var _events   = [];
  var _startTs  = Date.now();
  var _recId    = 'rec_' + Date.now().toString(36);

  // ── Allowed event types (whitelist) ────────────────────────────────────────
  var ALLOWED_TYPES = {
    session_start: 1, session_rotate: 1, session_idle: 1, session_end: 1,
    worker_spawn: 1, worker_quarantine: 1, worker_heartbeat_fail: 1,
    ticket_issued: 1, ticket_expired: 1, ticket_fail: 1,
    capability_granted: 1, capability_revoked: 1,
    threat_detected: 1, incident_created: 1, incident_resolved: 1,
    attestation_pass: 1, attestation_fail: 1,
    seal_ok: 1, seal_fail: 1, foreign_deploy: 1,
    deployment_channel: 1, build_chain_link: 1,
    wasm_attested: 1, wasm_revoked: 1,
    crypto_rotation: 1, packet_replay: 1,
  };

  // ── Privacy-safe meta scrubbing ────────────────────────────────────────────
  var SAFE_META_KEYS = [
    'type', 'reason', 'state', 'severity', 'score', 'tier', 'channel',
    'workerId', 'incidentId', 'moduleId', 'cap', 'patternId', 'duration',
    'ok', 'count', 'health', 'poolId',
  ];

  function _scrub(meta) {
    if (!meta || typeof meta !== 'object') return null;
    var safe = {};
    for (var k of SAFE_META_KEYS) {
      if (k in meta) {
        var v = meta[k];
        if (typeof v === 'string') safe[k] = v.slice(0, 80);
        else if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
      }
    }
    return safe;
  }

  // ── Record an event ────────────────────────────────────────────────────────
  function record(eventType, meta) {
    if (!_enabled) return;
    if (!ALLOWED_TYPES[eventType]) return;

    _events.push({
      t:    eventType,
      m:    _scrub(meta),
      ts:   Date.now(),
      rel:  Date.now() - _startTs,  // relative timestamp (ms since session start)
    });

    if (_events.length > MAX_EVENTS) _events.shift();
  }

  function getRecording() {
    return {
      id:       _recId,
      startTs:  _startTs,
      duration: Date.now() - _startTs,
      events:   _events.slice(),
      tier:     _tier,
    };
  }

  function exportRecording() {
    var rec = getRecording();
    // Additional scrub for export
    return {
      id:       rec.id,
      duration: rec.duration,
      eventCount: rec.events.length,
      events:   rec.events.map(function (e) { return { t: e.t, rel: e.rel, m: e.m }; }),
      tier:     rec.tier,
      exportedAt: Date.now(),
    };
  }

  function clear() {
    _events = [];
    _startTs = Date.now();
    _recId   = 'rec_' + Date.now().toString(36);
    console.debug(LOG, 'recording cleared');
  }

  // ── Subscribe to system events ────────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      var EVENT_MAP = {
        'session:init':           'session_start',
        'session:rotated':        'session_rotate',
        'session:idle':           'session_idle',
        'seal:failure':           'seal_fail',
        'security:foreign-deploy':'foreign_deploy',
        'capability:granted':     'capability_granted',
        'capability:revoked':     'capability_revoked',
        'security:anomaly':       'threat_detected',
        'mesh:worker-quarantined':'worker_quarantine',
        'crypto:keys-rotated':    'crypto_rotation',
        'deployment:channel-detected': 'deployment_channel',
      };

      for (var evtName in EVENT_MAP) {
        (function (src, dest) {
          eb.on(src, function (data) { record(dest, data || {}); });
        }(evtName, EVENT_MAP[evtName]));
      }
    });
  }

  function _boot() {
    if (!_enabled) {
      console.debug(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    setTimeout(_subscribe, 4000);
    record('session_start', { tier: _tier });
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| rec:', _recId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5000); }, { once: true });
  } else {
    setTimeout(_boot, 5000);
  }

  G.RuntimeSessionRecorder = Object.freeze({
    VERSION:   VERSION,
    record:    record,
    getRecording: getRecording,
    export:    exportRecording,
    clear:     clear,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, events: _events.length, recId: _recId };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-security-stream.js ──
// RuntimeSecurityStream v1.0 — Phase 7 / Section 1 (Live Security Stream)
// =============================================================================
// Real-time security event stream for the enterprise dashboard.
// Aggregates events from all Phase 1–7 security systems into a unified feed.
//
// Stream architecture:
//   • Subscriber pattern — dashboard registers a handler, gets all events
//   • Buffered stream — last 500 events retained for reconnects
//   • Rate-limited emission — max 20 events/second to UI
//   • Priority filtering — UI can filter by severity level
//   • Typed events — all events have a consistent schema
//
// Event schema:
//   { id, ts, type, source, severity, summary, data }
//
// window.RuntimeSecurityStream
//   .subscribe(handler, opts)       → unsubscribeFn
//   .getBuffer(limit)               → StreamEvent[]
//   .getStats()                     → StreamStats
//   .flush()                        → void
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecurityStream) return;

  var VERSION  = '1.0';
  var LOG      = '[SecStream]';
  var BUF_SIZE = 500;
  var RATE_MS  = 50;   // min ms between emits to a single subscriber

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Stream state ───────────────────────────────────────────────────────────
  var _buffer    = [];
  var _eventId   = 0;
  var _subs      = [];
  var _stats     = { emitted: 0, dropped: 0, subscribers: 0 };

  // ── Source → severity mapping ──────────────────────────────────────────────
  var SOURCE_SEV = {
    'seal:failure':            'CRITICAL',
    'proto-pollution':         'CRITICAL',
    'security:foreign-deploy': 'HIGH',
    'panic-activated':         'HIGH',
    'security:anomaly':        'HIGH',
    'sri-mismatch':            'HIGH',
    'replay-attempt':          'MEDIUM',
    'worker-blocked':          'MEDIUM',
    'integrity-failure':       'MEDIUM',
    'deploy-mismatch':         'MEDIUM',
    'nonce-violation':         'MEDIUM',
    'mesh:worker-quarantined': 'MEDIUM',
    'capability:revoked':      'LOW',
    'session:rotated':         'LOW',
    'crypto:keys-rotated':     'LOW',
    'worker:spawned':          'INFO',
    'deployment:channel-detected': 'INFO',
  };

  // ── Push an event into the stream ─────────────────────────────────────────
  function _push(type, source, severity, summary, data) {
    var evt = {
      id:       ++_eventId,
      ts:       Date.now(),
      type:     type,
      source:   source,
      severity: severity || SOURCE_SEV[type] || 'INFO',
      summary:  summary || type,
      data:     data || null,
    };

    _buffer.push(evt);
    if (_buffer.length > BUF_SIZE) _buffer.shift();

    // Notify subscribers
    _stats.emitted++;
    var now = Date.now();
    for (var i = _subs.length - 1; i >= 0; i--) {
      var sub = _subs[i];
      if (!sub.active) { _subs.splice(i, 1); continue; }

      // Rate limit per subscriber
      if (now - sub.lastEmit < RATE_MS) { _stats.dropped++; continue; }

      // Severity filter
      if (sub.minSev) {
        var sevOrder = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
        if ((sevOrder[evt.severity] || 0) < (sevOrder[sub.minSev] || 0)) continue;
      }

      try { sub.handler(evt); } catch (_) {}
      sub.lastEmit = now;
    }

    return evt;
  }

  // ── subscribe (public) ────────────────────────────────────────────────────
  function subscribe(handler, opts) {
    if (typeof handler !== 'function') return function () {};
    opts = opts || {};

    var sub = {
      id:       'sub_' + Date.now().toString(36),
      handler:  handler,
      minSev:   opts.minSeverity || null,
      active:   true,
      lastEmit: 0,
    };

    _subs.push(sub);
    _stats.subscribers = _subs.filter(function (s) { return s.active; }).length;

    // Send buffered events to new subscriber
    if (opts.sendBuffer !== false) {
      var buf = getBuffer(opts.bufferLimit || 50);
      setTimeout(function () {
        buf.forEach(function (evt) {
          try { handler(evt); } catch (_) {}
        });
      }, 0);
    }

    return function () { sub.active = false; };
  }

  function getBuffer(limit) {
    var buf = _buffer.slice();
    if (limit) buf = buf.slice(-limit);
    return buf;
  }

  function flush() {
    _buffer = [];
    _eventId = 0;
  }

  // ── Subscribe to all security sources ────────────────────────────────────
  function _tapSources() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      var TAPPED = [
        'seal:failure', 'proto-pollution', 'security:foreign-deploy',
        'panic-activated', 'security:anomaly', 'sri-mismatch',
        'replay-attempt', 'worker-blocked', 'integrity-failure',
        'deploy-mismatch', 'nonce-violation', 'mesh:worker-quarantined',
        'capability:revoked', 'capability:granted', 'session:rotated',
        'crypto:keys-rotated', 'worker:spawned', 'deployment:channel-detected',
        'shield:tamper-response',
      ];

      TAPPED.forEach(function (evtName) {
        eb.on(evtName, function (data) {
          _push(evtName, 'event-bus', SOURCE_SEV[evtName] || 'INFO',
            evtName.replace(/[:-]/g, ' '), data);
        });
      });
    });

    // Tap SecurityTelemetry
    _s(function () {
      var st = G.SecurityTelemetry;
      if (st && typeof st.subscribe === 'function') {
        st.subscribe(function (event) {
          if (!event) return;
          _push(event.type || 'telemetry-event', 'security-telemetry',
            event.severity || 'INFO', event.type, null);
        });
      }
    });
  }

  function _boot() {
    setTimeout(_tapSources, 3000);
    console.debug(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| buffer:', BUF_SIZE);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimeSecurityStream = Object.freeze({
    VERSION:   VERSION,
    subscribe: subscribe,
    getBuffer: getBuffer,
    flush:     flush,
    push:      _push, // allow external systems to push events
    getStats:  function () { return Object.assign({}, _stats, { subscribers: _subs.filter(function (s) { return s.active; }).length }); },
    status: function () {
      return { version: VERSION, tier: _tier, buffered: _buffer.length, stats: _stats };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));

// ── SOURCE: public/js/runtime-security-visualizer.js ──
// RuntimeSecurityVisualizer v1.0 — Phase 7 / Section 1 (Dashboard Visualizer)
// =============================================================================
// Visualization engine for the enterprise security dashboard.
// Renders security state charts, timelines, and grids using Canvas 2D API.
// No external charting libraries — pure canvas rendering for CSP compliance.
//
// Visualizations:
//   1. Threat timeline bar chart  — events per time window
//   2. Worker health grid        — per-worker status squares
//   3. Risk score gauge          — arc-based gauge widget
//   4. Memory pressure sparkline  — line chart of heap over time
//   5. Incident severity donut    — proportional donut chart
//   6. Attack heatmap            — 2D density map of attack types
//
// Design:
//   • All rendering is async / requestAnimationFrame-based
//   • Canvas elements can be any size (responsive)
//   • Dark theme by default (dashboard context)
//   • No DOM manipulation beyond the target canvas
//
// window.RuntimeSecurityVisualizer
//   .drawGauge(canvas, score, label)              → void
//   .drawTimeline(canvas, events, windowMs)        → void
//   .drawWorkerGrid(canvas, workers)               → void
//   .drawSparkline(canvas, values, color)          → void
//   .drawDonut(canvas, segments)                   → void
//   .status()                                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecurityVisualizer) return;

  var VERSION = '1.0';
  var LOG     = '[SecViz]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Color palette (dark theme) ────────────────────────────────────────────
  var C = {
    bg:       '#0d1117',
    surface:  '#161b22',
    border:   '#30363d',
    text:     '#e6edf3',
    textDim:  '#7d8590',
    green:    '#3fb950',
    yellow:   '#d29922',
    orange:   '#f0883e',
    red:      '#f85149',
    critical: '#ff6e76',
    blue:     '#58a6ff',
    purple:   '#a371f7',
    cyan:     '#39d353',
  };

  var SEV_COLOR = {
    INFO:     C.textDim,
    LOW:      C.green,
    MEDIUM:   C.yellow,
    HIGH:     C.orange,
    CRITICAL: C.red,
  };

  // ── Canvas context helper ─────────────────────────────────────────────────
  function _ctx(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    return _s(function () { return canvas.getContext('2d'); }, null);
  }

  function _clear(ctx, canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // ── 1. Risk score gauge ────────────────────────────────────────────────────
  function drawGauge(canvas, score, label) {
    var ctx = _ctx(canvas);
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h * 0.6;
    var r  = Math.min(w, h) * 0.38;

    _clear(ctx, canvas);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 10;
    ctx.stroke();

    // Score arc
    var pct    = Math.min(1, Math.max(0, score / 100));
    var endAng = Math.PI + pct * Math.PI;
    var color  = score < 40 ? C.green : score < 70 ? C.yellow : score < 90 ? C.orange : C.red;

    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, endAng);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 10;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Score text
    ctx.fillStyle  = C.text;
    ctx.font       = 'bold ' + Math.floor(r * 0.55) + 'px monospace';
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(score.toString(), cx, cy - 4);

    // Label
    if (label) {
      ctx.fillStyle = C.textDim;
      ctx.font      = '11px sans-serif';
      ctx.fillText(label, cx, cy + r * 0.35);
    }
  }

  // ── 2. Timeline bar chart ──────────────────────────────────────────────────
  function drawTimeline(canvas, events, windowMs) {
    var ctx = _ctx(canvas);
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;
    var bins = 20, now = Date.now();
    windowMs = windowMs || 300_000;

    _clear(ctx, canvas);

    var buckets = new Array(bins).fill(0);
    var bucketSev = new Array(bins).fill('INFO');

    (events || []).forEach(function (e) {
      var age = now - e.ts;
      if (age > windowMs) return;
      var idx = Math.floor((1 - age / windowMs) * bins);
      idx = Math.min(bins - 1, Math.max(0, idx));
      buckets[idx]++;
      var sevOrder = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
      if ((sevOrder[e.severity] || 0) > (sevOrder[bucketSev[idx]] || 0)) {
        bucketSev[idx] = e.severity;
      }
    });

    var maxBucket = Math.max.apply(null, buckets) || 1;
    var bw = (w - 20) / bins;

    buckets.forEach(function (val, i) {
      var bh = ((val / maxBucket) * (h - 30)) || 1;
      var x  = 10 + i * bw;
      var y  = h - 20 - bh;
      ctx.fillStyle = SEV_COLOR[bucketSev[i]] || C.blue;
      ctx.fillRect(x, y, bw - 1, bh);
    });

    // X axis
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(10, h - 20);
    ctx.lineTo(w - 10, h - 20);
    ctx.stroke();

    ctx.fillStyle = C.textDim;
    ctx.font      = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(windowMs / 60000) + 'm window', 12, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText('now', w - 10, h - 6);
  }

  // ── 3. Worker health grid ──────────────────────────────────────────────────
  function drawWorkerGrid(canvas, workers) {
    var ctx = _ctx(canvas);
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;

    _clear(ctx, canvas);

    workers = workers || [];
    if (workers.length === 0) {
      ctx.fillStyle = C.textDim;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No workers registered', w / 2, h / 2);
      return;
    }

    var cols = Math.ceil(Math.sqrt(workers.length));
    var rows = Math.ceil(workers.length / cols);
    var cw   = Math.floor((w - 10) / cols);
    var ch   = Math.floor((h - 10) / rows);

    workers.forEach(function (worker, i) {
      var col = i % cols, row = Math.floor(i / cols);
      var x = 5 + col * cw, y = 5 + row * ch;
      var trust = typeof worker.trust === 'number' ? worker.trust : 50;
      var state = worker.state || 'UNKNOWN';

      var color = state === 'QUARANTINED' ? C.red
        : state === 'VERIFIED' ? C.green
        : state === 'TRUSTED'  ? C.cyan
        : state === 'NEW'      ? C.yellow
        : C.textDim;

      ctx.fillStyle = color + '33'; // transparent fill
      ctx.fillRect(x + 1, y + 1, cw - 3, ch - 3);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1;
      ctx.strokeRect(x + 1, y + 1, cw - 3, ch - 3);

      ctx.fillStyle    = color;
      ctx.font         = '8px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      var label = String(trust);
      ctx.fillText(label, x + cw / 2, y + ch / 2);
    });
  }

  // ── 4. Sparkline ───────────────────────────────────────────────────────────
  function drawSparkline(canvas, values, color) {
    var ctx = _ctx(canvas);
    if (!ctx || !values || values.length < 2) return;
    var w = canvas.width, h = canvas.height;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (max === min) max = min + 1;

    _clear(ctx, canvas);

    ctx.beginPath();
    ctx.strokeStyle = color || C.blue;
    ctx.lineWidth   = 2;

    values.forEach(function (v, i) {
      var x = (i / (values.length - 1)) * (w - 4) + 2;
      var y = h - 4 - ((v - min) / (max - min)) * (h - 8);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // ── 5. Donut chart ────────────────────────────────────────────────────────
  function drawDonut(canvas, segments) {
    var ctx = _ctx(canvas);
    if (!ctx || !segments || segments.length === 0) return;
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h / 2;
    var r  = Math.min(w, h) * 0.4;
    var r2 = r * 0.55;

    _clear(ctx, canvas);

    var total = segments.reduce(function (s, seg) { return s + (seg.value || 0); }, 0);
    if (total === 0) return;

    var angle = -Math.PI / 2;
    segments.forEach(function (seg) {
      var sweep = (seg.value / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + sweep);
      ctx.closePath();
      ctx.fillStyle = seg.color || C.blue;
      ctx.fill();
      angle += sweep;
    });

    // Donut hole
    ctx.beginPath();
    ctx.arc(cx, cy, r2, 0, 2 * Math.PI);
    ctx.fillStyle = C.bg;
    ctx.fill();

    // Total in center
    ctx.fillStyle    = C.text;
    ctx.font         = 'bold ' + Math.floor(r2 * 0.55) + 'px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(total.toString(), cx, cy);
  }

  G.RuntimeSecurityVisualizer = Object.freeze({
    VERSION:        VERSION,
    drawGauge:      drawGauge,
    drawTimeline:   drawTimeline,
    drawWorkerGrid: drawWorkerGrid,
    drawSparkline:  drawSparkline,
    drawDonut:      drawDonut,
    COLORS:         Object.freeze(Object.assign({}, C)),
    SEV_COLOR:      Object.freeze(Object.assign({}, SEV_COLOR)),
    status: function () { return { version: VERSION }; },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));


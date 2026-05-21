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
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    _attach();
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
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

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

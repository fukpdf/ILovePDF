// RuntimeDeviceLite v1.0 — Hardware-Profile-Based Lite Mode Activator
// =====================================================================
// Scores the device at boot using hardware signals (RAM, CPU cores,
// connection type, GPU tier from RuntimeAIScheduler) and activates
// AdaptiveDegradation to the appropriate profile when weak hardware
// is detected.
//
// This complements adaptive-degradation.js (which reacts to memory
// PRESSURE at runtime). RuntimeDeviceLite sets the INITIAL profile
// based on hardware CAPABILITY — preventing issues before they happen.
//
// Lite mode effects (via AdaptiveDegradation profiles):
//   low RAM or 2-core CPU → 'low' profile
//   very weak (1 core, 2G, <1GB RAM) → 'critical' profile
//   good hardware → keep 'ok' (no change)
//
// Also:
//   - Adds class 'iplv-lite' to <body> for CSS animation suppression
//   - Dispatches 'device:lite-mode' CustomEvent
//   - Stores detection result in localStorage for next session
//   - Exposes window.RuntimeDeviceLite for auditability
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeviceLite) return;

  var LOG    = '[RDL]';
  var LS_KEY = 'iplv_device_lite_v1';

  // ── Hardware scoring ──────────────────────────────────────────────────────
  // Returns a 0-100 score. Lower = weaker device.
  function _score() {
    var score = 100;

    // RAM score (0–30 pts)
    var ram = _safe(function () { return navigator.deviceMemory || 0; }, 0);
    if      (ram === 0)                   score -= 10; // unknown — conservative penalty
    else if (ram < 1)                     score -= 30;
    else if (ram < 2)                     score -= 20;
    else if (ram < 4)                     score -= 10;

    // CPU cores score (0–30 pts)
    var cores = _safe(function () { return navigator.hardwareConcurrency || 0; }, 0);
    if      (cores === 0)                 score -= 10;
    else if (cores <= 1)                  score -= 30;
    else if (cores <= 2)                  score -= 20;
    else if (cores <= 4)                  score -= 10;

    // Connection type score (0–25 pts)
    var conn = _safe(function () {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      return c && c.effectiveType || '';
    }, '');
    if      (conn === 'slow-2g')          score -= 25;
    else if (conn === '2g')               score -= 20;
    else if (conn === '3g')               score -= 10;
    else if (conn === '4g' || conn === '') score -= 0;

    // GPU tier score (0–15 pts) — read from RuntimeAIScheduler if available
    var gpuTier = _safe(function () {
      return (G.RuntimeAIScheduler && G.RuntimeAIScheduler.getProfile &&
              G.RuntimeAIScheduler.getProfile().gpuTier) || '';
    }, '');
    if      (gpuTier === 'cpu')           score -= 15;
    else if (gpuTier === 'webgl-low')     score -= 10;
    else if (gpuTier === 'webgl')         score -= 5;

    return Math.max(0, score);
  }

  function _safe(fn, def) { try { return fn(); } catch (_) { return def; } }

  // ── Profile mapping ───────────────────────────────────────────────────────
  function _profileFor(score) {
    if (score < 20) return 'critical';
    if (score < 45) return 'low';
    if (score < 65) return 'reduce';
    return 'ok';
  }

  // ── Apply profile via AdaptiveDegradation ─────────────────────────────────
  function _applyProfile(profile) {
    if (profile === 'ok') return;

    _safe(function () {
      if (G.AdaptiveDegradation && G.AdaptiveDegradation.setProfile) {
        G.AdaptiveDegradation.setProfile(profile);
      } else if (G.AdaptiveDegradation && G.AdaptiveDegradation.forceTier) {
        G.AdaptiveDegradation.forceTier(profile);
      }
    });

    // Add body class for CSS hooks
    if (profile === 'low' || profile === 'critical') {
      try { document.body.classList.add('iplv-lite'); } catch (_) {}
    }

    // Emit event for other systems
    _safe(function () {
      G.dispatchEvent(new CustomEvent('device:lite-mode', {
        detail: { profile: profile },
      }));
    });

    if (G.RuntimeAnalytics) {
      _safe(function () {
        G.RuntimeAnalytics.track('device:lite_mode_activated', {
          extra: { profile: profile },
        });
      });
    }

    console.info(LOG, 'lite mode activated — profile:', profile);
  }

  // ── Main detection ────────────────────────────────────────────────────────
  function _detect() {
    // Check cached result from previous session (avoid re-scoring every page)
    var cached = _safe(function () {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (!raw || !raw.ts || Date.now() - raw.ts > 24 * 3600 * 1000) return null;
      return raw;
    }, null);

    var score, profile;

    if (cached) {
      score   = cached.score;
      profile = cached.profile;
    } else {
      score   = _score();
      profile = _profileFor(score);
      _safe(function () {
        localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), score: score, profile: profile }));
      });
    }

    _applyProfile(profile);

    G.RuntimeDeviceLite = {
      getScore:   function () { return score; },
      getProfile: function () { return profile; },
      isLite:     function () { return profile !== 'ok'; },
      redetect:   function () {
        _safe(function () { localStorage.removeItem(LS_KEY); });
        _detect();
      },
    };

    console.debug(LOG, 'score=' + score + ' profile=' + profile);
  }

  // Run after DOMContentLoaded so body exists for classList.add
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _detect, { once: true });
  } else {
    _detect();
  }

}(window));

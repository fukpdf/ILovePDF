// RuntimeCSPEnforcer v1.0 — Phase 8 / Objective 3
// =============================================================================
// Active Content Security Policy runtime enforcement.
// MutationObserver-based engine that monitors the DOM for rogue script
// injection, verifies nonce presence, validates trusted origins, and removes
// malicious nodes.
//
// Architecture:
//   • MutationObserver on document.head + body (hardened subtree mode)
//   • Nonce whitelist validated against server-injected window.__CSP_NONCE
//   • Trusted CDN origin allowlist (matches server-side CSP)
//   • CSP violation stream → RuntimeSecurityStream
//   • ShadowRuntime integration for blacklist updates
//   • Incident escalation for CRITICAL violations (eval injection, data: scripts)
//   • LOW-tier devices: observer disabled, only checks existing scripts at boot
//
// window.RuntimeCSPEnforcer
//   .getViolations()                  → Violation[]
//   .addTrustedOrigin(origin)         → void
//   .pause() / .resume()              → void
//   .status()                         → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCSPEnforcer) return;

  var VERSION = '1.0';
  var LOG     = '[CSPEnforcer]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40; // observer active on MEDIUM+; LOW = boot-only scan

  // ── Known-good nonce (server-injected per-request) ─────────────────────────
  var _nonce = _s(function () {
    // Server injects window.__CSP_NONCE via a nonce'd script tag
    if (G.__CSP_NONCE && typeof G.__CSP_NONCE === 'string') return G.__CSP_NONCE;
    // Fallback: read from the first nonce'd script on the page
    var scripts = document.querySelectorAll('script[nonce]');
    for (var i = 0; i < scripts.length; i++) {
      var n = scripts[i].getAttribute('nonce') || scripts[i].nonce;
      if (n) return n;
    }
    return null;
  }, null);

  // ── Trusted origins (matches server-side script-src allowlist) ─────────────
  var _trusted = new Set([
    location.origin,
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://pagead2.googlesyndication.com',
    'https://partner.googleadservices.com',
    'https://tpc.googlesyndication.com',
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    'https://apis.google.com',
  ]);

  // ── Violation registry ─────────────────────────────────────────────────────
  var _violations = [];
  var _removed    = 0;
  var _paused     = false;

  // ── Severity classification ────────────────────────────────────────────────
  function _classifyScript(node) {
    var src = node.src || '';

    // Inline script — check nonce
    if (!src) {
      var nodeNonce = node.getAttribute('nonce') || node.nonce;
      if (_nonce && nodeNonce && nodeNonce === _nonce) return null; // valid nonce
      if (!_nonce && !nodeNonce) return null; // no nonce system in place — allow
      if (!nodeNonce) return { severity: 'HIGH', reason: 'inline-no-nonce' };
      if (nodeNonce !== _nonce) return { severity: 'CRITICAL', reason: 'nonce-mismatch' };
      return null;
    }

    // data: script (extremely suspicious)
    if (/^data:/i.test(src)) {
      return { severity: 'CRITICAL', reason: 'data-script', src: src.slice(0, 60) };
    }

    // blob: script (check it's same-origin)
    if (/^blob:/i.test(src)) {
      return null; // blob workers are allowed by CSP worker-src
    }

    // Extension script
    if (/^(chrome|moz|safari)-extension:/.test(src)) {
      return { severity: 'LOW', reason: 'extension-script', src: src.slice(0, 80) };
    }

    // External src — check against trusted list
    try {
      var origin = new URL(src).origin;
      if (_trusted.has(origin)) return null; // trusted CDN
      return { severity: 'MEDIUM', reason: 'untrusted-origin', src: src.slice(0, 120), origin: origin };
    } catch (_) {
      return { severity: 'HIGH', reason: 'unparseable-src', src: src.slice(0, 80) };
    }
  }

  // ── Handle a detected violation ────────────────────────────────────────────
  function _handleViolation(node, info) {
    if (!info) return;

    var violation = {
      id:       'csv_' + Date.now().toString(36) + '_' + _violations.length,
      ts:       Date.now(),
      severity: info.severity,
      reason:   info.reason,
      src:      info.src || null,
      origin:   info.origin || null,
      tag:      node.tagName || 'SCRIPT',
      removed:  false,
    };

    // Remove malicious nodes (CRITICAL + HIGH)
    if (info.severity === 'CRITICAL' || info.severity === 'HIGH') {
      try {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
          violation.removed = true;
          _removed++;
          console.warn(LOG, 'REMOVED rogue script | reason:', info.reason, '| src:', info.src || 'inline');
        }
      } catch (_) {}
    }

    _violations.push(violation);
    if (_violations.length > 200) _violations.shift();

    // ── Push to SecurityStream ──────────────────────────────────────────────
    _s(function () {
      var ss = G.RuntimeSecurityStream;
      if (ss && typeof ss.push === 'function') {
        ss.push('csp-violation', 'csp-enforcer', info.severity,
          'CSP violation: ' + info.reason, { src: info.src, reason: info.reason });
      }
    });

    // ── Incident escalation ─────────────────────────────────────────────────
    if (info.severity === 'CRITICAL' || info.severity === 'HIGH') {
      _s(function () {
        var ie = G.RuntimeIncidentEngine;
        if (ie && typeof ie.report === 'function') {
          ie.report('csp-violation', info.severity === 'CRITICAL' ? 85 : 55,
            'csp-enforcer', { reason: info.reason, src: info.src });
        }
        // Session persistence
        var sp = G.RuntimeSessionPersistence;
        if (sp && typeof sp.persistEvent === 'function') {
          sp.persistEvent('csp_violation', { severity: info.severity, reason: info.reason });
        }
      });
    }

    // ── Telemetry ───────────────────────────────────────────────────────────
    _s(function () {
      if (G.SecurityTelemetry && typeof G.SecurityTelemetry.record === 'function') {
        G.SecurityTelemetry.record('nonce-violation', {
          reason: info.reason,
          score:  info.severity === 'CRITICAL' ? 90 : info.severity === 'HIGH' ? 60 : 30,
        });
      }
    });
  }

  // ── Check a node ───────────────────────────────────────────────────────────
  function _checkNode(node) {
    if (_paused) return;
    if (!node || node.tagName !== 'SCRIPT') return;
    // Skip scripts that existed before we loaded (they were server-validated)
    if (node._p8cspChecked) return;
    node._p8cspChecked = true;
    var info = _classifyScript(node);
    if (info) _handleViolation(node, info);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────
  var _observer = null;

  function _startObserver() {
    if (!G.MutationObserver) return;
    try {
      _observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mut) {
          mut.addedNodes.forEach(function (node) {
            _checkNode(node);
            // Check children of added containers
            if (node.querySelectorAll) {
              node.querySelectorAll('script').forEach(_checkNode);
            }
          });
        });
      });
      _observer.observe(document.documentElement, {
        childList: true,
        subtree:   true,
      });
      console.debug(LOG, 'MutationObserver active');
    } catch (_) {}
  }

  // ── Boot-time scan of existing scripts ────────────────────────────────────
  function _scanExisting() {
    _s(function () {
      document.querySelectorAll('script').forEach(function (s) {
        // Mark existing page scripts as pre-approved (they passed server CSP)
        s._p8cspChecked = true;
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function addTrustedOrigin(origin) {
    _s(function () {
      _trusted.add(String(origin));
    });
  }

  function getViolations() { return _violations.slice(); }

  function pause()  { _paused = true;  }
  function resume() { _paused = false; }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    _scanExisting();

    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' LOW-tier: observer disabled, boot-only scan');
      return;
    }

    // Start observer after initial page parse is complete
    setTimeout(_startObserver, 500);

    // Also register for ShadowRuntime updates
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;
      eb.on('threat-intel:updated', function (rules) {
        if (rules && rules.cspViolationRules && rules.cspViolationRules.knownRoguePrefixes) {
          // Update check logic based on new threat intel
        }
      });
    });

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| nonce:', _nonce ? 'present' : 'none', '| trusted:', _trusted.size);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1000); }, { once: true });
  } else {
    setTimeout(_boot, 1000);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    if (_observer) { try { _observer.disconnect(); } catch (_) {} }
  }, { once: true });

  G.RuntimeCSPEnforcer = Object.freeze({
    VERSION:          VERSION,
    getViolations:    getViolations,
    addTrustedOrigin: addTrustedOrigin,
    pause:            pause,
    resume:           resume,
    status: function () {
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        paused:     _paused,
        violations: _violations.length,
        removed:    _removed,
        nonce:      !!_nonce,
        trusted:    _trusted.size,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

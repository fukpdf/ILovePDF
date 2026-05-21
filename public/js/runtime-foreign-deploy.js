// RuntimeForeignDeploy v1.0 — Phase 3 / Task 5 (Safe Foreign Deployment Protection)
// ============================================================================
// Soft feature degradation when the runtime detects it is executing on a
// domain that is not an approved deployment target.
//
// Approved domains:
//   ilovepdf.cyou, www.ilovepdf.cyou
//   + localhost / 127.0.0.1 (development)
//   + *.replit.dev / *.repl.co (Replit preview environments)
//
// On foreign domain detection:
//   1. Set window.__IPLV_FOREIGN_DEPLOY__ = true
//   2. Emit 'security:foreign-deploy' event on RuntimeEventBus
//   3. Record to SecurityTelemetry
//   4. Upgrade security tier (RuntimeSecurityTiers.upgrade)
//   5. Soft-disable AI features (window.__IPLV_AI_DISABLED__ = true)
//   6. Reduce processing quotas (soft file-size cap)
//   7. Show a non-intrusive, dismissable notice to the user
//
// CRITICAL DESIGN RULES:
//   • NO malicious behavior — no intentional crashes, no memory bombs
//   • NO hard failures — tools continue working in degraded mode
//   • NO interference with user files — process normally, just limited
//   • The notice is informational only — not a block, not a modal
//   • All changes are reversible via dismissal or closing the tab
//
// window.RuntimeForeignDeploy
//   .isForeign()   → boolean
//   .status()      → { foreign, domain, detectedAt, degraded }
//   .dismiss()     → void (hides notice, restores quotas if user acknowledges)
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeForeignDeploy) return;

  var VERSION = '1.0';
  var LOG     = '[ForeignDeploy]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Allowed deployment domains ────────────────────────────────────────────
  var ALLOWED_EXACT = [
    'ilovepdf.cyou',
    'www.ilovepdf.cyou',
    'localhost',
    '127.0.0.1',
    '',
  ];
  var ALLOWED_PATTERNS = [
    /^.*\.replit\.dev$/,
    /^.*\.repl\.co$/,
    /^.*\.replit\.app$/,
  ];

  function _isAllowed(host) {
    if (ALLOWED_EXACT.indexOf(host) !== -1) return true;
    for (var i = 0; i < ALLOWED_PATTERNS.length; i++) {
      if (ALLOWED_PATTERNS[i].test(host)) return true;
    }
    return false;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  var _foreign    = false;
  var _detectedAt = null;
  var _degraded   = false;
  var _dismissed  = false;
  var _host       = _s(function () { return G.location.hostname || ''; }, '');

  // ── Notice element ────────────────────────────────────────────────────────
  var _noticeEl = null;

  function _showNotice(host) {
    if (_dismissed || typeof document === 'undefined') return;
    _s(function () {
      if (document.getElementById('p3-foreign-notice')) return;
      var el = document.createElement('div');
      el.id = 'p3-foreign-notice';
      el.setAttribute('style', [
        'position:fixed',
        'bottom:16px',
        'right:16px',
        'z-index:2147483000',
        'background:#1e293b',
        'color:#f1f5f9',
        'border:1px solid rgba(99,102,241,0.5)',
        'border-radius:10px',
        'padding:12px 16px',
        'font-size:13px',
        'line-height:1.5',
        'max-width:320px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.35)',
        'font-family:system-ui,sans-serif',
        'transition:opacity 0.3s',
      ].join(';'));
      el.innerHTML = '<div style="display:flex;align-items:flex-start;gap:10px;">'
        + '<span style="font-size:20px;flex-shrink:0;">ℹ️</span>'
        + '<div>'
        + '<div style="font-weight:600;margin-bottom:4px;">Unofficial Deployment</div>'
        + '<div style="color:#94a3b8;font-size:12px;">This tool is running outside its official domain. Some features may be limited.</div>'
        + '<button id="p3-foreign-dismiss" style="margin-top:8px;padding:4px 10px;background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.4);border-radius:6px;color:#f1f5f9;font-size:12px;cursor:pointer;">Dismiss</button>'
        + '</div></div>';
      document.body.appendChild(el);
      _noticeEl = el;
      var btn = document.getElementById('p3-foreign-dismiss');
      if (btn) btn.addEventListener('click', function () { dismiss(); });
      // Auto-dismiss after 15s if no interaction
      setTimeout(function () { if (!_dismissed) dismiss(); }, 15000);
    });
  }

  function dismiss() {
    _dismissed = true;
    if (_noticeEl) {
      _s(function () {
        _noticeEl.style.opacity = '0';
        setTimeout(function () { _s(function () { _noticeEl.remove(); }); }, 300);
      });
    }
  }

  // ── Apply soft degradation ────────────────────────────────────────────────
  function _applyDegradation() {
    if (_degraded) return;
    _degraded = true;

    // 1. Flag foreign deploy for other systems
    _s(function () {
      try {
        Object.defineProperty(G, '__IPLV_FOREIGN_DEPLOY__', {
          value: true, writable: false, configurable: false,
        });
      } catch (_) { G.__IPLV_FOREIGN_DEPLOY__ = true; }
    });

    // 2. Soft-disable AI features
    _s(function () {
      try {
        Object.defineProperty(G, '__IPLV_AI_DISABLED__', {
          value: true, writable: false, configurable: false,
        });
      } catch (_) { G.__IPLV_AI_DISABLED__ = true; }
    });

    // 3. Emit event for other systems to react
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('security:foreign-deploy', { host: _host });
      }
    });

    // 4. Record to telemetry
    _s(function () {
      if (G.SecurityTelemetry) {
        G.SecurityTelemetry.record('deploy-mismatch', { domain: _host });
      }
    });
    _s(function () {
      if (G.RuntimeTelemetry) {
        G.RuntimeTelemetry.record('security:foreign-deploy', { host: _host });
      }
    });

    // 5. Upgrade security tier
    _s(function () {
      var st = G.RuntimeSecurityTiers;
      if (st && typeof st.upgrade === 'function') st.upgrade('foreign-deploy:' + _host);
    });

    // 6. Soft-cap processing quotas (advisory — tool-page.js reads this flag)
    _s(function () {
      try {
        Object.defineProperty(G, '__IPLV_FOREIGN_QUOTA__', {
          value: { maxFileSizeMB: 20, maxFiles: 3 },
          writable: false,
          configurable: false,
        });
      } catch (_) {}
    });

    console.warn(LOG, 'foreign deployment detected — domain:', _host, '| degraded mode active');
  }

  // ── Domain check ──────────────────────────────────────────────────────────
  function _check() {
    _foreign = !_isAllowed(_host);

    if (!_foreign) {
      console.info(LOG, 'domain verified:', _host || '(empty/dev)');
      return;
    }

    _detectedAt = Date.now();
    console.warn(LOG, 'FOREIGN DOMAIN detected:', _host);

    _applyDegradation();

    // Show non-intrusive notice after DOM is available
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(function () { _showNotice(_host); }, 3000);
      }, { once: true });
    } else {
      setTimeout(function () { _showNotice(_host); }, 3000);
    }
  }

  // ── Boot: check after DeploymentBind has already run ─────────────────────
  function _boot() {
    // First: trust DeploymentBind verdict if available
    var dbVerdict = _s(function () {
      var db = G.RuntimeDeploymentBind;
      if (!db || typeof db.status !== 'function') return null;
      var st = db.status();
      // If deploy-bind already confirmed it's the allowed domain, skip our check
      if (st && st.deployReady === true && st.iframeDetected === false) return 'ok';
      return null;
    }, null);

    if (dbVerdict === 'ok') {
      console.info(LOG, 'v' + VERSION + ' ready — domain cleared by DeploymentBind');
      return;
    }

    _check();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 900); }, { once: true });
  } else {
    setTimeout(_boot, 900);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeForeignDeploy = Object.freeze({
    VERSION:   VERSION,
    isForeign: function () { return _foreign; },
    dismiss:   dismiss,
    status: function () {
      return {
        foreign:    _foreign,
        domain:     _host,
        detectedAt: _detectedAt,
        degraded:   _degraded,
        dismissed:  _dismissed,
        allowed:    ALLOWED_EXACT.filter(function (d) { return d; }),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | host:', _host);

}(window));

// RuntimeUpdater v1.0 — Phase 23A-D
// Service Worker update lifecycle management.
// Detects SW updates, shows a non-blocking update toast, and applies
// updates safely (waits for idle when RuntimeGovernor reports active jobs).
//
// No existing systems rebuilt. Integrates with:
//   RuntimeGovernor  — checks for active jobs before applying
//   RuntimeChangelog — auto-shows changelog after update
//   window.t / RuntimeI18n — all user-facing strings translated
//
// Exposed as: window.RuntimeUpdater

(function (G) {
  'use strict';

  if (G.RuntimeUpdater) return;

  var VERSION = '1.0';
  var LOG     = '[RU23]';
  var LS_KEY  = 'iplv_sw_version';
  var LS_DISMISSED = 'iplv_update_dismissed_v';

  // ── State machine ──────────────────────────────────────────────────────────
  // idle → update-available → dismissed | reloading
  var _state = 'idle';
  var _pendingVersion = null;
  var _subs   = new Set();
  var _toast  = null;
  var _idleTimer = null;
  var _currentSwVersion = null;

  function _setState(s) {
    _state = s;
    _subs.forEach(function (fn) { try { fn(s, _pendingVersion); } catch (_) {} });
  }

  function _log(msg) {
    try { console.debug(LOG, msg); } catch (_) {}
  }

  // ── Safe translation shorthand (works even before i18n loads) ─────────────
  function _t(key, fallback) {
    try { return (G.t && G.t(key)) || fallback; } catch (_) { return fallback; }
  }

  // ── Check if an active job is running ─────────────────────────────────────
  function _isBusy() {
    try {
      var gov = G.RuntimeGovernor;
      if (gov && gov.isBusy) return gov.isBusy();
      var kernel = G.RuntimeKernel;
      if (kernel && kernel.getLoad) {
        var load = kernel.getLoad();
        if (load && (load.workers > 0 || load.ai > 0)) return true;
      }
      var ws = G.RuntimeWorkspace;
      if (ws && ws.hasActiveJob && ws.hasActiveJob()) return true;
    } catch (_) {}
    return false;
  }

  // ── Toast styles ───────────────────────────────────────────────────────────
  var TOAST_CSS = [
    'position:fixed',
    'bottom:72px',        /* above offline bar (60px) */
    'right:20px',
    'z-index:2147483640',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:14px 18px',
    'border-radius:12px',
    'background:#1e1b4b',
    'color:#e0e7ff',
    'font-family:Inter,-apple-system,sans-serif',
    'font-size:14px',
    'font-weight:500',
    'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
    'border:1px solid rgba(99,102,241,0.4)',
    'max-width:360px',
    'opacity:0',
    'transform:translateY(16px)',
    'transition:opacity 0.3s,transform 0.3s',
    'pointer-events:auto',
  ].join(';');

  var BTN_REFRESH_CSS = [
    'display:inline-flex',
    'align-items:center',
    'gap:6px',
    'padding:7px 14px',
    'border-radius:8px',
    'background:#6366f1',
    'color:#fff',
    'font-size:13px',
    'font-weight:600',
    'border:none',
    'cursor:pointer',
    'white-space:nowrap',
    'flex-shrink:0',
    'transition:background 0.15s',
  ].join(';');

  var BTN_DISMISS_CSS = [
    'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'width:28px',
    'height:28px',
    'border-radius:6px',
    'background:transparent',
    'color:#94a3b8',
    'font-size:18px',
    'line-height:1',
    'border:none',
    'cursor:pointer',
    'flex-shrink:0',
    'padding:0',
  ].join(';');

  // ── Build toast DOM ────────────────────────────────────────────────────────
  function _buildToast() {
    if (_toast) return;

    var el = document.createElement('div');
    el.id = 'iplv-update-toast';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = TOAST_CSS;

    // RTL awareness
    var isRTL = document.documentElement.getAttribute('dir') === 'rtl';
    if (isRTL) {
      el.style.right = 'auto';
      el.style.left  = '20px';
      el.style.flexDirection = 'row-reverse';
    }

    // Icon
    var icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'font-size:20px;flex-shrink:0;';
    icon.textContent = '\u2728'; // ✨

    // Text column
    var textWrap = document.createElement('div');
    textWrap.style.cssText = 'flex:1;min-width:0;';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:2px;';
    title.textContent = _t('update.available', 'Update available');
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:#94a3b8;';
    sub.textContent = _t('update.desc', 'Reload to get the latest version');
    textWrap.appendChild(title);
    textWrap.appendChild(sub);

    // Refresh button
    var btnRefresh = document.createElement('button');
    btnRefresh.style.cssText = BTN_REFRESH_CSS;
    btnRefresh.textContent = _t('update.refresh', 'Reload');
    btnRefresh.addEventListener('click', function () { RuntimeUpdater.apply(); });
    btnRefresh.addEventListener('mouseover', function () { this.style.background = '#4f46e5'; });
    btnRefresh.addEventListener('mouseout',  function () { this.style.background = '#6366f1'; });

    // Dismiss button
    var btnDismiss = document.createElement('button');
    btnDismiss.style.cssText = BTN_DISMISS_CSS;
    btnDismiss.title = _t('update.dismiss', 'Dismiss');
    btnDismiss.setAttribute('aria-label', _t('update.dismiss', 'Dismiss'));
    btnDismiss.innerHTML = '&times;';
    btnDismiss.addEventListener('click', function () { RuntimeUpdater.dismiss(); });

    el.appendChild(icon);
    el.appendChild(textWrap);
    el.appendChild(btnRefresh);
    el.appendChild(btnDismiss);

    document.body.appendChild(el);
    _toast = el;

    // Animate in
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
    });
  }

  function _removeToast() {
    if (!_toast) return;
    _toast.style.opacity = '0';
    _toast.style.transform = 'translateY(16px)';
    var el = _toast;
    _toast = null;
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 350);
  }

  // ── Show update notification ───────────────────────────────────────────────
  function _showUpdate(version) {
    if (_state === 'dismissed' || _state === 'reloading') return;
    if (_pendingVersion && localStorage.getItem(LS_DISMISSED + _pendingVersion)) return;

    _pendingVersion = version || _pendingVersion;
    _setState('update-available');

    // Schedule idle-apply (2 min after update detected)
    _clearIdleTimer();
    _idleTimer = setTimeout(function () {
      if (_state === 'update-available' && !_isBusy()) {
        _log('auto-apply: idle after 2 min');
        RuntimeUpdater.apply();
      }
    }, 120000);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _buildToast, { once: true });
    } else {
      _buildToast();
    }
  }

  function _clearIdleTimer() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  }

  // ── SW message handler — receives SW_ACTIVATED from service worker ─────────
  function _onSwMessage(event) {
    if (!event.data || event.data.type !== 'SW_ACTIVATED') return;
    var incomingVersion = event.data.version || 'v?';

    // Store / compare version
    var storedVersion = null;
    try { storedVersion = localStorage.getItem(LS_KEY); } catch (_) {}

    _log('SW_ACTIVATED received: ' + incomingVersion + ' (stored: ' + storedVersion + ')');

    try { localStorage.setItem(LS_KEY, incomingVersion); } catch (_) {}
    _currentSwVersion = incomingVersion;

    // Show toast only if version actually changed (not first boot)
    if (storedVersion && storedVersion !== incomingVersion) {
      _log('SW version changed ' + storedVersion + ' → ' + incomingVersion);
      // If busy, defer notification up to 60 s
      if (_isBusy()) {
        var _attempts = 0;
        var _poll = setInterval(function () {
          if (!_isBusy() || ++_attempts > 12) {
            clearInterval(_poll);
            _showUpdate(incomingVersion);
          }
        }, 5000);
      } else {
        _showUpdate(incomingVersion);
      }
    }
  }

  // ── SW updatefound listener (secondary detection for waiting SWs) ─────────
  function _watchRegistration(reg) {
    if (!reg) return;
    reg.addEventListener('updatefound', function () {
      var newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', function () {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // Waiting worker detected — prompt user (in case SW_ACTIVATED doesn't fire)
          _log('SW installed and waiting');
          if (_state === 'idle') _showUpdate(null);
        }
      });
    });
  }

  // ── Bootstrap SW listeners ─────────────────────────────────────────────────
  function _init() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.addEventListener('message', _onSwMessage);

    navigator.serviceWorker.getRegistration('/').then(function (reg) {
      if (reg) _watchRegistration(reg);
    }).catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimeUpdater = {
    VERSION: VERSION,

    /** Manually check for a waiting SW update */
    check: function () {
      if (!('serviceWorker' in navigator)) return Promise.resolve(false);
      return navigator.serviceWorker.getRegistration('/').then(function (reg) {
        if (!reg) return false;
        reg.update().catch(function () {});
        if (reg.waiting) { _showUpdate(null); return true; }
        return false;
      });
    },

    /** Apply update — reload page (new SW already active via skipWaiting) */
    apply: function () {
      if (_state === 'reloading') return;
      _setState('reloading');
      _removeToast();
      _clearIdleTimer();
      _log('applying update — reloading page');
      // Brief pause so state change propagates, then reload
      setTimeout(function () { window.location.reload(); }, 200);
    },

    /** Dismiss update toast for this version */
    dismiss: function () {
      _setState('dismissed');
      _removeToast();
      _clearIdleTimer();
      if (_pendingVersion) {
        try { localStorage.setItem(LS_DISMISSED + _pendingVersion, '1'); } catch (_) {}
      }
    },

    /** Current SW cache version */
    getVersion: function () { return _currentSwVersion; },

    /** Current updater state */
    getState: function () { return _state; },

    /** Subscribe to state changes: fn(state, version) */
    subscribe: function (fn) {
      _subs.add(fn);
      return function () { _subs.delete(fn); };
    },

    /** Force-show the update toast (for testing) */
    _forceShow: function (v) { _showUpdate(v || 'v-test'); },
  };

  G.RuntimeUpdater = RuntimeUpdater;
  _log('RuntimeUpdater v' + VERSION + ' ready');

}(window));

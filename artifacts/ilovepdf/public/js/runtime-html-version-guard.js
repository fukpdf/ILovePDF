// RuntimeHtmlVersionGuard v1.0 — Arc 2 / Target 2
// =====================================================================
// Stale HTML shell detection + silent revalidation.
//
// Approach:
//   - Reads current BUILD_ID from page script URLs (?v= param)
//   - Listens to RuntimeDeploySync for stale-build notifications
//   - When stale detected AND no active processing:
//       → silent navigation reload (location.reload()) after a short grace
//   - When stale detected AND processing is active:
//       → shows a subtle "New version available" snackbar
//   - Exports status API for dashboard / AdvancedEngine.audit()
//
// Never force-reloads immediately. Never destroys active sessions.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHtmlVersionGuard) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG           = '[HVG]';
  var VERSION       = '1.0';
  var GRACE_DELAY   = 30 * 1000;   // 30 s grace before silent reload
  var BANNER_ID     = 'iplv-version-banner';

  // ── State ─────────────────────────────────────────────────────────────────
  var _currentBuildId = (function () {
    try {
      var tags = document.querySelectorAll('script[src*="?v="]');
      for (var i = 0; i < tags.length; i++) {
        var v = new URL(tags[i].src, location.href).searchParams.get('v');
        if (v) return v;
      }
    } catch (_) {}
    return '';
  }());

  var _stale         = false;
  var _newBuildId    = '';
  var _reloadPending = false;
  var _graceTimer    = null;

  // ── Active-processing detection ───────────────────────────────────────────
  function _hasActiveProcessing() {
    try {
      var wp = G.WorkerPool;
      if (wp && wp.getStats) {
        var s = wp.getStats();
        if (s && s.busy > 0) return true;
      }
    } catch (_) {}
    try {
      // Check for any visible progress spinner as fallback
      var spinner = document.querySelector('.processing-spinner, [data-processing], .tool-processing');
      if (spinner) return true;
    } catch (_) {}
    return false;
  }

  // ── Snackbar banner ────────────────────────────────────────────────────────
  function _showBanner() {
    try {
      if (document.getElementById(BANNER_ID)) return;
      var bar = document.createElement('div');
      bar.id = BANNER_ID;
      bar.style.cssText = [
        'position:fixed;bottom:12px;left:50%;transform:translateX(-50%)',
        'background:#1e293b;color:#f1f5f9;padding:10px 18px;border-radius:8px',
        'font-size:13px;z-index:99999;display:flex;align-items:center;gap:10px',
        'box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:all',
      ].join(';');
      var txt = document.createElement('span');
      txt.textContent = 'New version available';
      var btn = document.createElement('button');
      btn.textContent = 'Reload';
      btn.style.cssText = 'background:#6366f1;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px';
      btn.onclick = function () { location.reload(); };
      var close = document.createElement('button');
      close.textContent = '✕';
      close.style.cssText = 'background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:14px;padding:0 2px';
      close.onclick = function () { bar.remove(); };
      bar.appendChild(txt);
      bar.appendChild(btn);
      bar.appendChild(close);
      document.body.appendChild(bar);
    } catch (_) {}
  }

  // ── Reload orchestration ──────────────────────────────────────────────────
  function _scheduleReload() {
    if (_reloadPending) return;
    _reloadPending = true;

    function _attempt() {
      if (!_hasActiveProcessing()) {
        console.debug(LOG, 'silent reload — stale shell replaced by build:', _newBuildId);
        try { location.reload(); } catch (_) {}
      } else {
        // Still processing — show banner for manual action instead
        _showBanner();
        _reloadPending = false;
      }
    }

    _graceTimer = setTimeout(_attempt, GRACE_DELAY);
  }

  // ── Handle stale detection ────────────────────────────────────────────────
  function _onStale(newBuildId) {
    if (_stale) return;
    _stale      = true;
    _newBuildId = newBuildId || '';
    console.debug(LOG, 'stale shell detected — current:', _currentBuildId, 'server:', _newBuildId);

    if (_hasActiveProcessing()) {
      _showBanner();
    } else {
      _scheduleReload();
    }
  }

  // ── Wire to RuntimeDeploySync ─────────────────────────────────────────────
  function _wire() {
    // If RuntimeDeploySync already registered stale, handle immediately
    if (G.RuntimeDeploySync && G.RuntimeDeploySync.isStale && G.RuntimeDeploySync.isStale()) {
      _onStale(G.RuntimeDeploySync.getServerBuild ? G.RuntimeDeploySync.getServerBuild() : '');
      return;
    }
    // Listen for future stale events
    G.addEventListener('deploy:stale', function (e) {
      _onStale(e.detail && e.detail.buildId || '');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire, { once: true });
  } else {
    _wire();
  }

  G.RuntimeHtmlVersionGuard = Object.freeze({
    VERSION:      VERSION,
    getBuildId:   function () { return _currentBuildId; },
    isStale:      function () { return _stale; },
    showBanner:   _showBanner,
  });

}(window));

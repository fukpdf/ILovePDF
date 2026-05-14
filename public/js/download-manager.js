// Download Manager v1.0 — Phase 1C Stabilization (T007)
// Centralizes all download lifecycle management: duplicate prevention,
// revoke timing, mobile/Safari/Android behavior, cancellation, cleanup.
//
// DESIGN PRINCIPLE: additive wrapper over existing triggerDownload() +
// createStatusUrl() patterns. Existing code continues to work. New code
// gets a safer, dedup-aware, platform-adaptive surface.
//
// Integrates with: ObjectURLRegistry, TimerRegistry, LifecycleManager,
//                  StabilityMetrics, MemPressure
//
// Exposed as: window.DownloadManager
//
// [FUTURE: DownloadOrchestrator] Replace individual download calls with
// DownloadManager.trigger(). Full streaming download support, progress
// events, and background-fetch integration can then be wired here.
(function () {
  'use strict';

  if (window.DownloadManager) return;

  var LOG = '[DM]';

  // ── Platform detection ────────────────────────────────────────────────────
  var _ua = navigator.userAgent || '';
  var IS_IOS     = /iPhone|iPad|iPod/i.test(_ua);
  var IS_SAFARI  = /^((?!chrome|android).)*safari/i.test(_ua);
  var IS_ANDROID = /Android/i.test(_ua);
  var IS_MOBILE  = IS_IOS || IS_ANDROID || /Mobile|Tablet/i.test(_ua);

  // Revoke delay:
  // iOS/Safari: Safari releases the blob URL asynchronously — revoke too
  // quickly and the download never fires. Use a 60 s window.
  // Android: Chrome on Android is fine with 30 s.
  // Desktop: 30 s is ample.
  var REVOKE_DELAY_MS = IS_IOS || IS_SAFARI ? 60000 : 30000;

  // Status URL lifetime (shown in result card download button).
  // Longer on mobile since users may switch apps and come back.
  var STATUS_URL_TTL_MS = IS_MOBILE ? 10 * 60 * 1000 : 5 * 60 * 1000;

  // ── Duplicate / spam prevention ───────────────────────────────────────────
  // Track the last download time per filename to prevent click-spam.
  // Two downloads for the same file within DEDUP_MS are suppressed.
  var DEDUP_MS = 1500;
  var _lastDownload = {}; // filename → timestamp

  function _isDuplicate(filename) {
    var now = Date.now();
    var last = _lastDownload[filename] || 0;
    if (now - last < DEDUP_MS) return true;
    _lastDownload[filename] = now;
    return false;
  }

  // ── Pending blob registry ─────────────────────────────────────────────────
  // Tracks all object URLs scheduled for future revocation so pagehide
  // can revoke them immediately (preventing memory leaks in bfcache).
  // Map<url, { owner, timerId }>
  var _pending = new Map();

  function _scheduleRevoke(url, owner, delayMs) {
    var reg = window.ObjectURLRegistry;
    var timerId = setTimeout(function () {
      _pending.delete(url);
      try {
        if (reg) reg.revoke(url);
        else URL.revokeObjectURL(url);
      } catch (_) {}
    }, delayMs);
    if (window.TimerRegistry) {
      window.TimerRegistry.registerTimeout('dm-revoke-' + Date.now(), timerId);
    }
    _pending.set(url, { owner: owner, timerId: timerId });
    return timerId;
  }

  function _revokeNow(url) {
    var entry = _pending.get(url);
    if (entry) {
      clearTimeout(entry.timerId);
      _pending.delete(url);
    }
    try {
      var reg = window.ObjectURLRegistry;
      if (reg) reg.revoke(url);
      else URL.revokeObjectURL(url);
    } catch (_) {}
  }

  function _revokeAllPending() {
    _pending.forEach(function (entry, url) {
      clearTimeout(entry.timerId);
      try {
        var reg = window.ObjectURLRegistry;
        if (reg) reg.revoke(url);
        else URL.revokeObjectURL(url);
      } catch (_) {}
    });
    _pending.clear();
  }

  // ── Core trigger ──────────────────────────────────────────────────────────
  // Replaces the raw anchor-click pattern with a managed, dedup-safe version.
  //
  // opts:
  //   owner?    — ObjectURLRegistry owner tag (default 'dm-trigger')
  //   noDedup?  — skip duplicate check (default false)
  //   onDone?   — callback fired after click (for analytics, UI reset, etc.)
  //
  // [FUTURE: DownloadOrchestrator] Replace blob URL with a background-fetch
  // or OPFS stream so large downloads don't spike the heap.
  function trigger(blob, filename, opts) {
    opts = opts || {};
    if (!blob || !filename) {
      console.warn(LOG, 'trigger() called with empty blob or filename');
      return false;
    }

    // Dedup check
    if (!opts.noDedup && _isDuplicate(filename)) {
      console.debug(LOG, 'duplicate download suppressed:', filename);
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordEvent('dm-dedup-suppressed'); } catch (_) {}
      }
      return false;
    }

    var owner = opts.owner || 'dm-trigger';
    var reg   = window.ObjectURLRegistry;
    var url   = reg ? reg.create(blob, owner) : URL.createObjectURL(blob);

    // Platform-specific download strategy
    if (IS_IOS || IS_SAFARI) {
      _triggerSafari(url, filename);
    } else {
      _triggerStandard(url, filename);
    }

    // Schedule revocation (not immediate — download must start first)
    _scheduleRevoke(url, owner, REVOKE_DELAY_MS);

    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('dm-trigger:' + (IS_MOBILE ? 'mobile' : 'desktop')); } catch (_) {}
    }

    if (typeof opts.onDone === 'function') {
      setTimeout(opts.onDone, 300);
    }
    return true;
  }

  // Standard anchor-click download (Chrome, Firefox, Edge)
  function _triggerStandard(url, filename) {
    var a = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    try { a.click(); } catch (_) {}
    // Small delay before DOM removal to ensure the click fires in all browsers
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (_) {}
    }, 200);
  }

  // Safari / iOS: opening in a new tab is the most reliable mechanism.
  // Safari's download attribute on anchor elements is not always honoured
  // for blob: URLs without a forced navigation.
  function _triggerSafari(url, filename) {
    // iOS Safari: open in new tab — user can long-press to save
    var a = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.target   = '_blank';
    a.rel      = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    try { a.click(); } catch (_) {}
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (_) {}
    }, 200);
  }

  // ── Status URL factory ────────────────────────────────────────────────────
  // Creates a blob URL for use in the result card download button.
  // Routes through ObjectURLRegistry + schedules auto-revocation.
  // Mobile gets a longer TTL since users may switch apps mid-session.
  //
  // [FUTURE: StreamEngine] Replace blob URL with a pre-signed OPFS handle
  // so the result card never holds the full output in JS heap.
  function createStatusUrl(blob, owner) {
    owner = owner || 'dm-status';
    var reg = window.ObjectURLRegistry;
    var url = reg ? reg.create(blob, owner) : URL.createObjectURL(blob);
    _scheduleRevoke(url, owner, STATUS_URL_TTL_MS);
    return url;
  }

  // ── Queue result URL factory ───────────────────────────────────────────────
  // Same as createStatusUrl but tagged 'dm-queue' for traceability.
  function createQueueUrl(blob) {
    return createStatusUrl(blob, 'dm-queue');
  }

  // ── Abandon / cancel a pending download URL ───────────────────────────────
  // Call if the user cancels or resets before the blob has been revoked.
  function cancel(url) {
    if (!url) return;
    _revokeNow(url);
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('dm-cancelled'); } catch (_) {}
    }
  }

  // ── Pagehide: immediately revoke all pending blobs ────────────────────────
  window.addEventListener('pagehide', function () {
    _revokeAllPending();
  }, { passive: true });

  // ── MemPressure: revoke pending blobs on critical tier ────────────────────
  if (window.MemPressure && window.MemPressure.onPressure) {
    window.MemPressure.onPressure(function () {
      if (window.MemPressure.isCritical && window.MemPressure.isCritical()) {
        _revokeAllPending();
        if (window.StabilityMetrics) {
          try { window.StabilityMetrics.recordEvent('dm-pressure-revoke-all'); } catch (_) {}
        }
      }
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      platform:      { ios: IS_IOS, safari: IS_SAFARI, android: IS_ANDROID, mobile: IS_MOBILE },
      revokeDelayMs: REVOKE_DELAY_MS,
      statusTtlMs:   STATUS_URL_TTL_MS,
      pendingUrls:   _pending.size,
    };
  }

  window.DownloadManager = {
    trigger:         trigger,
    createStatusUrl: createStatusUrl,
    createQueueUrl:  createQueueUrl,
    cancel:          cancel,
    revokeAllPending: _revokeAllPending,
    getStats:        getStats,

    // Expose platform flags for callers that need to adapt UI
    platform: {
      isIos:     IS_IOS,
      isSafari:  IS_SAFARI,
      isAndroid: IS_ANDROID,
      isMobile:  IS_MOBILE,
    },
  };

  console.debug('[DownloadManager] ready — T007 download orchestration active');
}());

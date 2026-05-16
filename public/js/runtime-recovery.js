// RuntimeRecovery v1.0 — Phase 24A-E
// Unified runtime recovery facade. Does NOT replace existing systems:
//   CrashRecoveryUI    — session restore banner (Phase 7G)
//   SelfHealingRecovery— trigger/heal loop (Phase 40M)
//   DeadlockMonitor    — worker heartbeat watchdog (Phase 40B)
//   DistributedRecovery— cluster/tab recovery (Phase 40H)
//
// This module coordinates them + adds:
//   - recoverModule / recoverWorker / recoverFederation / recoverAI / recoverStreams
//   - 45-second watchdog loop integrating RuntimeHealth + RuntimeGovernor
//   - Threshold-gated runtime error overlay (translated, RTL safe)
//
// Exposed as: window.RuntimeRecovery

(function (G) {
  'use strict';

  if (G.RuntimeRecovery) return;

  var VERSION  = '1.0';
  var LOG      = '[RR24]';

  // ── Safe helper ────────────────────────────────────────────────────────────
  function _s(fn) { try { return fn(); } catch (_) { return null; } }
  function _t(key, fallback) { try { return (G.t && G.t(key)) || fallback; } catch (_) { return fallback; } }
  function _log(msg, d) { console.debug(LOG, msg, d !== undefined ? d : ''); }

  // ── Recovery event log (ring buffer) ──────────────────────────────────────
  var _log_buf = [];
  var MAX_LOG  = 60;
  function _record(type, detail) {
    _log_buf.unshift({ ts: Date.now(), type: type, detail: detail || null });
    if (_log_buf.length > MAX_LOG) _log_buf.length = MAX_LOG;
    _s(function () {
      if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('recovery.' + type, detail);
    });
    _s(function () {
      if (G.RuntimeEventBus) G.RuntimeEventBus.emit('recovery:' + type, detail);
    });
  }

  // ── Module recovery ────────────────────────────────────────────────────────
  // Attempts to re-initialize a named runtime module if it has an init() method.
  function recoverModule(name) {
    _log('recoverModule', name);
    var mod = G[name];
    if (!mod) { _record('module-missing', { name: name }); return Promise.resolve(false); }
    if (typeof mod.init === 'function') {
      return _s(function () {
        var r = mod.init();
        _record('module-reinit', { name: name });
        return r ? r.then ? r.then(function () { return true; }) : Promise.resolve(true) : Promise.resolve(true);
      }) || Promise.resolve(false);
    }
    if (typeof mod.reset === 'function') {
      _s(function () { mod.reset(); });
      _record('module-reset', { name: name });
      return Promise.resolve(true);
    }
    _record('module-no-recovery', { name: name });
    return Promise.resolve(false);
  }

  // ── Worker recovery ────────────────────────────────────────────────────────
  // Delegates to DeadlockMonitor or RuntimeWorkerOrchestrator.
  function recoverWorker(workerId) {
    _log('recoverWorker', workerId);
    return new Promise(function (resolve) {
      var success = false;
      // 1. DeadlockMonitor — terminate frozen worker
      _s(function () {
        var dm = G.DeadlockMonitor;
        if (dm && dm.DeadlockResolver && dm.DeadlockResolver.resolve) {
          dm.DeadlockResolver.resolve(workerId, {});
          success = true;
        }
      });
      // 2. RuntimeWorkerOrchestrator — recycle worker
      _s(function () {
        var wo = G.RuntimeWorkerOrchestrator;
        if (wo && wo.recycleWorker) { wo.recycleWorker(workerId); success = true; }
      });
      // 3. WorkerPool — terminate and re-add
      _s(function () {
        var wp = G.WorkerPool;
        if (wp && wp.terminate) { wp.terminate(workerId); success = true; }
      });
      _record('worker-recover', { id: workerId, success: success });
      resolve(success);
    });
  }

  // ── Federation recovery ────────────────────────────────────────────────────
  // Retries a failed lazy import with exponential back-off.
  function recoverFederation(chunkId, importUrl) {
    _log('recoverFederation', chunkId);
    if (!importUrl) {
      _record('federation-no-url', { chunkId: chunkId });
      return Promise.resolve(false);
    }
    var attempts = 0;
    var MAX_ATTEMPTS = 3;
    function _try() {
      attempts++;
      return import(importUrl).then(function (mod) {
        _record('federation-recovered', { chunkId: chunkId, attempt: attempts });
        return mod;
      }).catch(function (err) {
        if (attempts < MAX_ATTEMPTS) {
          var delay = 500 * Math.pow(2, attempts);
          return new Promise(function (resolve) { setTimeout(resolve, delay); }).then(_try);
        }
        _record('federation-failed', { chunkId: chunkId, error: String(err).slice(0, 100) });
        return false;
      });
    }
    return _try();
  }

  // ── AI recovery ────────────────────────────────────────────────────────────
  // Resets stuck AI task queues across all AI systems.
  function recoverAI() {
    _log('recoverAI');
    var recovered = 0;
    _s(function () {
      var sched = G.RuntimeAIScheduler;
      if (sched && sched.reset) { sched.reset(); recovered++; }
    });
    _s(function () {
      var orch = G.RuntimeAIOrchestrator;
      if (orch && orch.reset) { orch.reset(); recovered++; }
    });
    _s(function () {
      var ai = G.AIRuntime;
      if (ai && ai.reset) { ai.reset(); recovered++; }
    });
    _s(function () {
      var lba = G.LabaAiChat;
      if (lba && lba.clearQueue) { lba.clearQueue(); recovered++; }
    });
    _record('ai-recovered', { systems: recovered });
    return Promise.resolve(recovered > 0);
  }

  // ── Stream recovery ────────────────────────────────────────────────────────
  // Closes stale streams that have been idle too long.
  function recoverStreams() {
    _log('recoverStreams');
    var closed = 0;
    _s(function () {
      var sb = G.RuntimeStreamBridge;
      if (sb && sb.closeStale) { closed += sb.closeStale() || 0; }
    });
    _s(function () {
      var zc = G.RuntimeZeroCopy;
      if (zc && zc.cleanup) { zc.cleanup(); closed++; }
    });
    _record('streams-recovered', { closed: closed });
    return Promise.resolve(true);
  }

  // ── Full recovery sweep ────────────────────────────────────────────────────
  var _recovering = false;
  function recoverAll() {
    if (_recovering) return Promise.resolve(false);
    _recovering = true;
    _log('recoverAll — starting full sweep');
    _record('recover-all-start', null);

    return Promise.all([
      recoverAI(),
      recoverStreams(),
      _s(function () {
        var shr = G.SelfHealingRecovery;
        if (shr && shr.HealingOrchestrator && shr.HealingOrchestrator.runAll) {
          shr.HealingOrchestrator.runAll();
        }
      }),
    ]).then(function () {
      _s(function () {
        if (G.EvictionManager && G.EvictionManager.selectivePressureFlush) {
          G.EvictionManager.selectivePressureFlush();
        }
      });
      _record('recover-all-done', null);
      _recovering = false;
      return true;
    }).catch(function (err) {
      _record('recover-all-error', { err: String(err).slice(0, 100) });
      _recovering = false;
      return false;
    });
  }

  // ── Watchdog loop ──────────────────────────────────────────────────────────
  var WATCHDOG_INTERVAL_MS = 45000;
  var _watchdogTimer = null;
  var _lastRecovery   = 0;
  var RECOVERY_COOLDOWN_MS = 90000; // don't run recoverAll twice within 90 s

  function _watchdogTick() {
    // 1. RuntimeHealth score
    var score = _s(function () {
      var rh = G.RuntimeHealth;
      return rh && rh.getScore ? rh.getScore() : 100;
    }) || 100;

    if (score < 40 && Date.now() - _lastRecovery > RECOVERY_COOLDOWN_MS) {
      _log('watchdog: health score ' + score + ' < 40 — triggering recoverAll');
      _lastRecovery = Date.now();
      recoverAll();
      return;
    }

    // 2. DeadlockMonitor — check for frozen workers
    _s(function () {
      var dm = G.DeadlockMonitor;
      if (dm && dm.HeartbeatValidator && dm.HeartbeatValidator.checkAll) {
        dm.HeartbeatValidator.checkAll();
      }
    });

    // 3. Memory pressure emergency
    var memTier = _s(function () {
      return G.RuntimeMemory ? G.RuntimeMemory.getTier() : 'NORMAL';
    }) || 'NORMAL';

    if (memTier === 'EMERGENCY') {
      _log('watchdog: EMERGENCY memory tier — flushing');
      _s(function () {
        if (G.EvictionManager) G.EvictionManager.emergencyPressureFlush();
      });
    }

    // 4. Stale stream check
    _s(function () {
      var sb = G.RuntimeStreamBridge;
      if (sb && sb.getStats) {
        var st = sb.getStats();
        if (st && st.active > 20) recoverStreams();
      }
    });
  }

  function _startWatchdog() {
    if (_watchdogTimer) return;
    _watchdogTimer = setInterval(_watchdogTick, WATCHDOG_INTERVAL_MS);
    _log('watchdog started (interval: ' + WATCHDOG_INTERVAL_MS / 1000 + 's)');
  }

  // ── Error overlay ──────────────────────────────────────────────────────────
  var _errorCount  = 0;
  var _errorWindow = 0;
  var _overlay     = null;
  var ERROR_THRESHOLD = 3;    // 3 unhandled errors in 30 s
  var ERROR_WINDOW_MS = 30000;
  var OVERLAY_IGNORED = [
    'ResizeObserver loop',
    'Script error.',
    'Non-Error promise rejection',
  ];

  function _shouldIgnoreError(msg) {
    if (!msg) return false;
    for (var i = 0; i < OVERLAY_IGNORED.length; i++) {
      if (String(msg).indexOf(OVERLAY_IGNORED[i]) !== -1) return true;
    }
    return false;
  }

  function _onUnhandledError(msg) {
    if (_shouldIgnoreError(msg)) return;
    var now = Date.now();
    if (now - _errorWindow > ERROR_WINDOW_MS) { _errorCount = 0; _errorWindow = now; }
    _errorCount++;
    _record('unhandled-error', { msg: String(msg).slice(0, 100), count: _errorCount });
    if (_errorCount >= ERROR_THRESHOLD && !_overlay) _showErrorOverlay(msg);
  }

  var OVERLAY_CSS = [
    'position:fixed',
    'inset:0',
    'z-index:2147483641',
    'background:rgba(0,0,0,0.75)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:16px',
    'opacity:0',
    'transition:opacity 0.25s',
  ].join(';');

  function _showErrorOverlay(errMsg) {
    if (_overlay) return;
    if (!document.body) return;

    var isRTL = document.documentElement.getAttribute('dir') === 'rtl';

    var backdrop = document.createElement('div');
    backdrop.style.cssText = OVERLAY_CSS;

    var card = document.createElement('div');
    card.style.cssText = [
      'background:#0d1117',
      'border:1px solid rgba(248,81,73,0.4)',
      'border-radius:16px',
      'padding:28px 32px',
      'max-width:440px',
      'width:100%',
      'text-align:' + (isRTL ? 'right' : 'center'),
      'direction:' + (isRTL ? 'rtl' : 'ltr'),
      'font-family:Inter,-apple-system,sans-serif',
      'box-shadow:0 24px 64px rgba(0,0,0,0.6)',
    ].join(';');

    var iconEl = document.createElement('div');
    iconEl.style.cssText = 'font-size:40px;margin-bottom:16px;';
    iconEl.textContent = '\u26a0\ufe0f';

    var titleEl = document.createElement('h3');
    titleEl.style.cssText = 'font-size:18px;font-weight:700;color:#f0f6fc;margin:0 0 8px;';
    titleEl.textContent = _t('recovery.crashed', 'Something went wrong');

    var subEl = document.createElement('p');
    subEl.style.cssText = 'font-size:13px;color:#8b949e;margin:0 0 24px;line-height:1.6;';
    subEl.textContent = _t('recovery.desc',
      'The runtime encountered an unexpected error. Click Recover to attempt automatic healing.');

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';

    var btnRecover = document.createElement('button');
    btnRecover.style.cssText = [
      'padding:10px 20px',
      'border-radius:8px',
      'background:#7c3aed',
      'color:#fff',
      'font-size:14px',
      'font-weight:600',
      'border:none',
      'cursor:pointer',
    ].join(';');
    btnRecover.textContent = _t('recovery.retry', 'Recover');
    btnRecover.addEventListener('click', function () {
      titleEl.textContent = _t('recovery.recovering', 'Recovering\u2026');
      btnRecover.disabled = true;
      recoverAll().then(function () {
        RuntimeRecovery.dismissOverlay();
        _errorCount = 0;
      });
    });

    var btnDismiss = document.createElement('button');
    btnDismiss.style.cssText = [
      'padding:10px 20px',
      'border-radius:8px',
      'background:#21262d',
      'color:#c9d1d9',
      'font-size:14px',
      'font-weight:600',
      'border:none',
      'cursor:pointer',
    ].join(';');
    btnDismiss.textContent = _t('recovery.dismiss_overlay', 'Continue Anyway');
    btnDismiss.addEventListener('click', function () { RuntimeRecovery.dismissOverlay(); });

    var btnReport = document.createElement('button');
    btnReport.style.cssText = [
      'padding:10px 20px',
      'border-radius:8px',
      'background:transparent',
      'color:#8b949e',
      'font-size:14px',
      'font-weight:600',
      'border:1px solid rgba(255,255,255,0.1)',
      'cursor:pointer',
    ].join(';');
    btnReport.textContent = _t('recovery.report', 'Report');
    btnReport.addEventListener('click', function () {
      // Copy diagnostic info to clipboard
      var info = 'ILovePDF Runtime Error\n' +
        'Time: ' + new Date().toISOString() + '\n' +
        'Error: ' + String(errMsg).slice(0, 200) + '\n' +
        'Health: ' + (_s(function () { return G.RuntimeHealth && G.RuntimeHealth.getScore(); }) || '?') + '\n' +
        'Memory: ' + (_s(function () { return G.RuntimeMemory && G.RuntimeMemory.getTier(); }) || '?');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(info).catch(function () {});
        btnReport.textContent = _t('recovery.copied', 'Copied!');
      }
    });

    btnRow.appendChild(btnRecover);
    btnRow.appendChild(btnDismiss);
    btnRow.appendChild(btnReport);
    card.appendChild(iconEl);
    card.appendChild(titleEl);
    card.appendChild(subEl);
    card.appendChild(btnRow);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    _overlay = backdrop;

    requestAnimationFrame(function () { backdrop.style.opacity = '1'; });
    _record('overlay-shown', { errMsg: String(errMsg).slice(0, 100) });
  }

  // ── Wire up global error listeners ────────────────────────────────────────
  window.addEventListener('error', function (e) {
    _onUnhandledError(e.message || e.type);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = (e.reason && (e.reason.message || String(e.reason))) || 'unhandled rejection';
    _onUnhandledError(reason);
  });

  // ── Start watchdog after DOM ready ─────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startWatchdog, { once: true });
  } else {
    setTimeout(_startWatchdog, 2000); // brief delay so other systems boot first
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimeRecovery = {
    VERSION: VERSION,

    recoverModule:     recoverModule,
    recoverWorker:     recoverWorker,
    recoverFederation: recoverFederation,
    recoverAI:         recoverAI,
    recoverStreams:     recoverStreams,
    recoverAll:        recoverAll,

    dismissOverlay: function () {
      if (!_overlay) return;
      _overlay.style.opacity = '0';
      var el = _overlay;
      _overlay = null;
      setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 300);
    },

    getLog: function () { return _log_buf.slice(); },

    getStats: function () {
      return {
        version:      VERSION,
        recovering:   _recovering,
        errorCount:   _errorCount,
        logLength:    _log_buf.length,
        lastRecovery: _lastRecovery,
        watchdog:     !!_watchdogTimer,
        subsystems: {
          CrashRecoveryUI:    !!G.CrashRecoveryUI,
          SelfHealingRecovery:!!G.SelfHealingRecovery,
          DeadlockMonitor:    !!G.DeadlockMonitor,
          DistributedRecovery:!!G.DistributedRecovery,
          EnterpriseRecoveryV2:!!G.EnterpriseRecoveryV2,
        },
      };
    },

    audit: function () {
      var s = this.getStats();
      console.group(LOG + ' RuntimeRecovery v' + VERSION + ' audit');
      console.log('Stats:', s);
      console.log('Recent log:', _log_buf.slice(0, 10));
      console.groupEnd();
      return s;
    },
  };

  G.RuntimeRecovery = RuntimeRecovery;
  _log('RuntimeRecovery v' + VERSION + ' ready');

}(window));

// CrashRecoveryUI v1.0 — Phase 7G
// =====================================================================
// Crash Recovery UI — detects interrupted tool sessions and presents
// a non-intrusive banner letting the user resume or discard their work.
//
// Detection flow:
//   1. On tool page load: query RuntimeIDB for checkpoint(toolId)
//   2. If checkpoint exists and is < MAX_CHECKPOINT_AGE_MS old:
//      → inject banner "Your previous session was interrupted. Resume?"
//   3. On "Resume": invoke hydrateFlowState() + restore callback
//   4. On "Discard": delete checkpoint, clear sessionStorage, dismiss
//   5. Auto-dismiss: banner auto-hides after BANNER_TTL_MS (60 s) with
//      no interaction (non-disruptive to normal flow)
//
// Checkpoint age gates:
//   < 4 h  → show full resume banner
//   4–24 h → show muted notice only (user may not remember the session)
//   > 24 h → auto-purge (RuntimeIDB.sweepOrphans handles this)
//
// Integration:
//   CrashRecoveryUI.check(toolId, slug, opts) → Promise<'resumed'|'discarded'|'none'>
//   opts.onResume(checkpoint)  — called when user clicks Resume
//   opts.onDiscard()           — called when user clicks Discard
//
// CSS classes injected: .crash-recovery-banner (styled inline, overridable)
// =====================================================================
(function (global) {
  'use strict';

  if (global.CrashRecoveryUI) return;

  var LOG = '[CRU]';

  // Age gates
  var MAX_AGE_FULL_MS   = 4  * 60 * 60 * 1000; // 4 h  — full resume banner
  var MAX_AGE_MUTED_MS  = 24 * 60 * 60 * 1000; // 24 h — muted notice only
  var BANNER_TTL_MS     = 60 * 1000;            // 60 s — auto-dismiss

  // ── Banner styles ─────────────────────────────────────────────────────────
  var BANNER_STYLES = [
    'position:fixed',
    'bottom:20px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:99999',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:14px 20px',
    'border-radius:10px',
    'box-shadow:0 4px 24px rgba(0,0,0,0.18)',
    'font-family:inherit',
    'font-size:14px',
    'line-height:1.4',
    'max-width:92vw',
    'background:#1a1a2e',
    'color:#f0f0f5',
    'border:1px solid rgba(255,255,255,0.12)',
    'transition:opacity 0.3s,transform 0.3s',
  ].join(';');

  var BTN_BASE = [
    'border:none',
    'border-radius:6px',
    'padding:7px 16px',
    'font-size:13px',
    'font-weight:600',
    'cursor:pointer',
    'white-space:nowrap',
    'transition:opacity 0.15s',
  ].join(';');

  var BTN_RESUME  = BTN_BASE + ';background:#4f8ef7;color:#fff;';
  var BTN_DISCARD = BTN_BASE + ';background:transparent;color:#a0a0bb;border:1px solid rgba(255,255,255,0.18);';
  var BTN_CLOSE   = [
    'background:none',
    'border:none',
    'color:#a0a0bb',
    'font-size:18px',
    'cursor:pointer',
    'padding:0 4px',
    'line-height:1',
    'margin-left:4px',
  ].join(';');

  // ── Lookup checkpoint from RuntimeIDB ─────────────────────────────────────
  function _getCheckpoint(toolId) {
    if (!global.RuntimeIDB || !global.RuntimeIDB.getCheckpoint) {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(global.RuntimeIDB.getCheckpoint(toolId)).catch(function () { return null; });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function _deleteCheckpoint(toolId) {
    if (!global.RuntimeIDB || !global.RuntimeIDB.deleteCheckpoint) return;
    try { global.RuntimeIDB.deleteCheckpoint(toolId).catch(function () {}); } catch (_) {}
  }

  // ── Build banner element ──────────────────────────────────────────────────
  function _buildBanner(checkpoint, muted) {
    var age     = Date.now() - (checkpoint.ts || 0);
    var ageMin  = Math.round(age / 60000);
    var ageStr  = ageMin < 60
      ? ageMin + ' min ago'
      : Math.round(ageMin / 60) + ' h ago';

    var icon     = muted ? '⚠️' : '🔄';
    var headline = muted
      ? 'A session from ' + ageStr + ' was interrupted.'
      : 'Session interrupted ' + ageStr + '. Resume where you left off?';

    var wrapper = document.createElement('div');
    wrapper.className   = 'crash-recovery-banner';
    wrapper.setAttribute('role', 'alertdialog');
    wrapper.setAttribute('aria-label', 'Resume interrupted session');
    wrapper.style.cssText = BANNER_STYLES;

    var iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    iconSpan.style.cssText = 'font-size:20px;flex-shrink:0';

    var text = document.createElement('span');
    text.textContent = headline;
    text.style.cssText = 'flex:1;min-width:0';

    var resumeBtn  = document.createElement('button');
    resumeBtn.textContent  = 'Resume';
    resumeBtn.style.cssText = BTN_RESUME;
    resumeBtn.setAttribute('type', 'button');

    var discardBtn  = document.createElement('button');
    discardBtn.textContent  = 'Discard';
    discardBtn.style.cssText = BTN_DISCARD;
    discardBtn.setAttribute('type', 'button');

    var closeBtn  = document.createElement('button');
    closeBtn.innerHTML     = '&times;';
    closeBtn.style.cssText = BTN_CLOSE;
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('aria-label', 'Dismiss');

    wrapper.appendChild(iconSpan);
    wrapper.appendChild(text);
    if (!muted) wrapper.appendChild(resumeBtn);
    wrapper.appendChild(discardBtn);
    wrapper.appendChild(closeBtn);

    return { wrapper: wrapper, resumeBtn: resumeBtn, discardBtn: discardBtn, closeBtn: closeBtn };
  }

  // ── Animate in / out ──────────────────────────────────────────────────────
  function _animateIn(el) {
    el.style.opacity   = '0';
    el.style.transform = 'translateX(-50%) translateY(20px)';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.opacity   = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
      });
    });
  }

  function _animateOut(el, cb) {
    el.style.opacity   = '0';
    el.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (cb) cb();
    }, 320);
  }

  // ── PUBLIC: check ─────────────────────────────────────────────────────────
  // toolId: tool identifier (matches RuntimeIDB checkpoint key)
  // slug:   URL slug (for ToolState clearing)
  // opts:
  //   onResume(checkpoint) — called when user clicks Resume
  //   onDiscard()          — called when user clicks Discard
  // Returns Promise<'resumed'|'discarded'|'none'>
  function check(toolId, slug, opts) {
    opts = opts || {};

    return _getCheckpoint(toolId).then(function (checkpoint) {
      if (!checkpoint || !checkpoint.ts) return 'none';

      var age = Date.now() - checkpoint.ts;
      if (age > MAX_AGE_MUTED_MS) {
        // Too old — auto-purge
        _deleteCheckpoint(toolId);
        if (global.RuntimeTelemetry) {
          try { global.RuntimeTelemetry.record('crash-recovery:auto-purged', { toolId: toolId, age: age }); } catch (_) {}
        }
        return 'none';
      }

      var muted = age > MAX_AGE_FULL_MS;

      if (global.RuntimeTelemetry) {
        try { global.RuntimeTelemetry.record('crash-recovery:detected', { toolId: toolId, age: age, muted: muted }); } catch (_) {}
      }

      return new Promise(function (resolve) {
        var ui      = _buildBanner(checkpoint, muted);
        var banner  = ui.wrapper;
        var settled = false;

        // Auto-dismiss timer
        var autoTimer = setTimeout(function () {
          if (settled) return;
          settled = true;
          _animateOut(banner, function () { resolve('none'); });
        }, BANNER_TTL_MS);

        function _dismiss(outcome, fn) {
          if (settled) return;
          settled = true;
          clearTimeout(autoTimer);
          _animateOut(banner, function () {
            if (fn) fn();
            resolve(outcome);
          });
        }

        ui.resumeBtn && ui.resumeBtn.addEventListener('click', function () {
          _dismiss('resumed', function () {
            if (global.RuntimeTelemetry) {
              try { global.RuntimeTelemetry.record('crash-recovery:resumed', { toolId: toolId }); } catch (_) {}
            }
            if (opts.onResume) {
              try { opts.onResume(checkpoint); } catch (e) { console.warn(LOG, 'onResume error:', e); }
            }
          });
        });

        ui.discardBtn.addEventListener('click', function () {
          _dismiss('discarded', function () {
            _deleteCheckpoint(toolId);
            if (global.ToolState && slug) {
              try { global.ToolState.clear(slug); } catch (_) {}
            }
            if (global.RuntimeTelemetry) {
              try { global.RuntimeTelemetry.record('crash-recovery:discarded', { toolId: toolId }); } catch (_) {}
            }
            if (opts.onDiscard) {
              try { opts.onDiscard(); } catch (_) {}
            }
          });
        });

        ui.closeBtn.addEventListener('click', function () {
          _dismiss('none', null);
        });

        document.body.appendChild(banner);
        _animateIn(banner);
      });
    }).catch(function (err) {
      console.warn(LOG, 'check() failed:', err.message);
      return 'none';
    });
  }

  // ── PUBLIC: saveCheckpoint ────────────────────────────────────────────────
  // Convenience: save a crash checkpoint through RuntimeIDBCoalescer (critical).
  function saveCheckpoint(toolId, data) {
    var record = Object.assign({ toolId: toolId, ts: Date.now() }, data);
    if (global.RuntimeIDBCoalescer) {
      global.RuntimeIDBCoalescer.schedule('checkpoints', record, {
        importance: 'critical',
        key:        toolId,
      });
    } else if (global.RuntimeIDB && global.RuntimeIDB.saveCheckpoint) {
      try { global.RuntimeIDB.saveCheckpoint(record); } catch (_) {}
    }
  }

  // ── PUBLIC: clearCheckpoint ───────────────────────────────────────────────
  function clearCheckpoint(toolId) {
    _deleteCheckpoint(toolId);
    if (global.RuntimeIDBCoalescer) {
      // Remove any pending write for this checkpoint from the coalescer queue
      try { global.RuntimeIDBCoalescer.schedule('checkpoints', { toolId: toolId, _deleted: true }, {
        importance: 'critical', key: toolId,
      }); } catch (_) {}
    }
  }

  global.CrashRecoveryUI = {
    check:           check,
    saveCheckpoint:  saveCheckpoint,
    clearCheckpoint: clearCheckpoint,
  };

  console.info(LOG, 'CrashRecoveryUI v1.0 ready — max age for banner: 4 h / auto-purge: 24 h');
}(window));

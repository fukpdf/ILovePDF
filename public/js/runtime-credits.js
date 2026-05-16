// RuntimeCredits v1.0 — Phase 24A/B/C
// =====================================================================
// Usage Economy: Daily Quota + Reward System.
// NO paid subscriptions. NO SaaS model.
//
// Model:
//   - 15 operations/day (free, anonymous)
//   - +5 credits unlocked by watching a short rewarded ad
//   - Tracked via localStorage + signed cookie + server validation
//   - Anti-abuse: cooldowns, fingerprint trust, daily resets at midnight
//
// Exposes: window.RuntimeCredits
//   .getCredits()    → { remaining, used, dailyLimit, resetAt }
//   .consume(op)     → Promise<{ ok, remaining, reason }>
//   .reward()        → Promise<{ ok, added, newTotal }>
//   .resetDaily()    → (internal — called at midnight)
//   .getHistory()    → last 50 operations
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeCredits) return;

  var LOG = '[RuntimeCredits]';
  var LS_CREDITS = 'ilpdf_credits';
  var LS_HISTORY = 'ilpdf_history';
  var DAILY_LIMIT = 15;
  var REWARD_AMOUNT = 5;
  var REWARD_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between rewards
  var MAX_REWARDS_PER_DAY = 4;
  var VALIDATE_ENDPOINT = '/api/credits/validate';

  // ── Safe localStorage ────────────────────────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  // ── Credit State ─────────────────────────────────────────────────────
  function getMidnightTs() {
    var d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  function loadState() {
    var raw = lsGet(LS_CREDITS);
    if (raw) {
      try {
        var s = JSON.parse(raw);
        // Reset if past midnight
        if (Date.now() > (s.resetAt || 0)) {
          return freshState();
        }
        return s;
      } catch (_) {}
    }
    return freshState();
  }

  function freshState() {
    return {
      remaining: DAILY_LIMIT,
      used: 0,
      dailyLimit: DAILY_LIMIT,
      resetAt: getMidnightTs(),
      rewardsToday: 0,
      lastRewardAt: 0,
      bonusCredits: 0
    };
  }

  function saveState(s) {
    lsSet(LS_CREDITS, JSON.stringify(s));
  }

  // ── History ──────────────────────────────────────────────────────────
  function loadHistory() {
    try { return JSON.parse(lsGet(LS_HISTORY) || '[]'); } catch (_) { return []; }
  }
  function pushHistory(entry) {
    var h = loadHistory();
    h.unshift(Object.assign({ ts: Date.now() }, entry));
    if (h.length > 50) h = h.slice(0, 50);
    lsSet(LS_HISTORY, JSON.stringify(h));
  }

  // ── Server Validation ─────────────────────────────────────────────────
  function serverValidate(op, uid, fpHash) {
    return fetch(VALIDATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ op: op, uid: uid, fp: fpHash })
    })
    .then(function (r) { return r.ok ? r.json() : { ok: true }; })
    .catch(function () { return { ok: true }; }); // Offline: allow operation
  }

  // ── Midnight Reset Timer ─────────────────────────────────────────────
  function scheduleReset() {
    var state = loadState();
    var delay = Math.max(1000, state.resetAt - Date.now());
    setTimeout(function () {
      var s = freshState();
      saveState(s);
      console.info(LOG, 'daily credits reset — new balance:', s.remaining);
      document.dispatchEvent(new CustomEvent('credits:reset', { detail: s }));
      scheduleReset();
    }, delay);
  }

  // ── Quota Exceeded Modal ─────────────────────────────────────────────
  function showQuotaModal(onReward) {
    var existing = document.getElementById('ilpdf-quota-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'ilpdf-quota-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Daily limit reached');
    modal.innerHTML = [
      '<div class="quota-modal-backdrop"></div>',
      '<div class="quota-modal-card">',
      '  <div class="quota-modal-icon">⚡</div>',
      '  <h2 class="quota-modal-title">Daily limit reached</h2>',
      '  <p class="quota-modal-body">You\'ve used all <strong>' + DAILY_LIMIT + '</strong> free operations today.',
      '     Watch a short ad to unlock <strong>+' + REWARD_AMOUNT + '</strong> more — or come back tomorrow.</p>',
      '  <div class="quota-modal-actions">',
      '    <button class="quota-btn-reward" id="ilpdf-watch-ad">Watch Ad (+' + REWARD_AMOUNT + ' credits)</button>',
      '    <button class="quota-btn-dismiss" id="ilpdf-quota-dismiss">Maybe later</button>',
      '  </div>',
      '  <p class="quota-modal-reset">Resets at midnight · <a href="/donate" target="_blank">Support us instead</a></p>',
      '</div>'
    ].join('');
    document.body.appendChild(modal);

    function close() { modal.remove(); }

    modal.querySelector('#ilpdf-quota-dismiss').addEventListener('click', close);
    modal.querySelector('.quota-modal-backdrop').addEventListener('click', close);
    modal.querySelector('#ilpdf-watch-ad').addEventListener('click', function () {
      close();
      if (typeof onReward === 'function') onReward();
    });

    // Trap focus
    setTimeout(function () {
      var btn = modal.querySelector('#ilpdf-watch-ad');
      if (btn) btn.focus();
    }, 50);
  }

  // ── Initialize ───────────────────────────────────────────────────────
  var _state = loadState();
  saveState(_state);
  scheduleReset();
  console.info(LOG, 'credits ready — remaining:', _state.remaining, '/', DAILY_LIMIT);

  // ── Public API ───────────────────────────────────────────────────────
  global.RuntimeCredits = {
    getCredits: function () {
      _state = loadState();
      return {
        remaining: _state.remaining,
        used: _state.used,
        dailyLimit: _state.dailyLimit + (_state.bonusCredits || 0),
        resetAt: _state.resetAt,
        rewardsToday: _state.rewardsToday
      };
    },

    consume: function (op) {
      _state = loadState();
      op = op || 'generic';

      if (_state.remaining <= 0) {
        // Show reward modal
        return new Promise(function (resolve) {
          showQuotaModal(function () {
            global.RuntimeCredits.reward().then(function (r) {
              if (r.ok) {
                // After reward, retry consume
                resolve(global.RuntimeCredits.consume(op));
              } else {
                resolve({ ok: false, remaining: 0, reason: 'quota_exhausted' });
              }
            });
          });
          // Immediately resolve as blocked (modal shown)
          resolve({ ok: false, remaining: 0, reason: 'quota_exceeded', modalShown: true });
        });
      }

      // Get identity for server validation
      var identity = global.RuntimeIdentity || null;
      var uid = identity ? identity.getUser().id : 'anon';
      var fp = identity ? identity.getFingerprint().hash : '';

      return serverValidate(op, uid, fp).then(function (serverRes) {
        if (serverRes && serverRes.blocked) {
          return { ok: false, remaining: _state.remaining, reason: serverRes.reason || 'server_blocked' };
        }
        // Deduct credit
        _state.remaining = Math.max(0, _state.remaining - 1);
        _state.used = (_state.used || 0) + 1;
        saveState(_state);
        pushHistory({ type: 'consume', op: op, remaining: _state.remaining });
        document.dispatchEvent(new CustomEvent('credits:consumed', { detail: { op: op, remaining: _state.remaining } }));
        return { ok: true, remaining: _state.remaining, used: _state.used };
      });
    },

    reward: function () {
      _state = loadState();
      var now = Date.now();

      // Cooldown check
      if (now - (_state.lastRewardAt || 0) < REWARD_COOLDOWN_MS) {
        var waitMin = Math.ceil((REWARD_COOLDOWN_MS - (now - _state.lastRewardAt)) / 60000);
        return Promise.resolve({ ok: false, reason: 'cooldown', waitMinutes: waitMin });
      }

      // Daily reward cap
      if ((_state.rewardsToday || 0) >= MAX_REWARDS_PER_DAY) {
        return Promise.resolve({ ok: false, reason: 'daily_reward_cap' });
      }

      // Trigger Ad via RuntimeAds
      return new Promise(function (resolve) {
        var ads = global.RuntimeAds;
        var adPromise = (ads && typeof ads.showRewarded === 'function')
          ? ads.showRewarded()
          : Promise.resolve({ completed: true, source: 'placeholder' });

        adPromise.then(function (adResult) {
          if (!adResult || !adResult.completed) {
            resolve({ ok: false, reason: 'ad_skipped' });
            return;
          }
          // Grant reward
          _state = loadState();
          _state.remaining = _state.remaining + REWARD_AMOUNT;
          _state.bonusCredits = (_state.bonusCredits || 0) + REWARD_AMOUNT;
          _state.rewardsToday = (_state.rewardsToday || 0) + 1;
          _state.lastRewardAt = Date.now();
          saveState(_state);
          pushHistory({ type: 'reward', added: REWARD_AMOUNT, source: adResult.source });

          // Track in identity for abuse detection
          if (global.RuntimeIdentity && global.RuntimeIdentity._trackReward) {
            global.RuntimeIdentity._trackReward();
          }

          document.dispatchEvent(new CustomEvent('credits:rewarded', {
            detail: { added: REWARD_AMOUNT, newTotal: _state.remaining }
          }));
          resolve({ ok: true, added: REWARD_AMOUNT, newTotal: _state.remaining });
        });
      });
    },

    resetDaily: function () {
      var s = freshState();
      saveState(s);
      _state = s;
      return s;
    },

    getHistory: function () {
      return loadHistory();
    },

    showQuotaModal: showQuotaModal,

    // Used by tools before processing
    requireCredit: function (op) {
      return global.RuntimeCredits.consume(op || 'tool');
    }
  };

  // Expose state change events to other modules
  document.addEventListener('credits:reset', function (e) {
    _state = e.detail;
  });

  // Integrate with RuntimeKernel
  if (global.RT && global.RT.register) {
    try { global.RT.register('credits', global.RuntimeCredits); } catch (_) {}
  }

}(typeof window !== 'undefined' ? window : this));

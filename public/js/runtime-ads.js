// RuntimeAds v1.0 — Phase 26
// =====================================================================
// Ad Adapter Architecture — pluggable provider abstraction.
// Supports: AdSense rewarded, Monetag, PropellerAds, Adsterra (future).
// Never hardcoded to one network.
//
// Usage:
//   RuntimeAds.showRewarded() → Promise<{ completed, source }>
//   RuntimeAds.registerProvider(name, adapter)
//   RuntimeAds.setProvider(name)
//   RuntimeAds.status()
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeAds) return;

  var LOG = '[RuntimeAds]';
  var _providers = {};
  var _activeProvider = null;
  var _showCount = 0;
  var _lastShownAt = 0;
  var GLOBAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between ads globally

  // ── Provider: AdSense Rewarded ────────────────────────────────────────
  // AdSense rewarded interstitials require Google's API which needs approval.
  // This is a real shell ready to activate when account is approved.
  _providers['adsense'] = {
    name: 'AdSense',
    isReady: function () {
      return !!(global.adsbygoogle && global.__adsenseRewardedReady);
    },
    showRewarded: function () {
      return new Promise(function (resolve) {
        // AdSense rewarded interstitial API
        // Activates once ca-pub-3242156405919556 is approved for rewarded ads
        if (global.adsbygoogle && global.__adsenseRewardedUnit) {
          try {
            var adUnit = new global.google.ads.rewardedinterstitial.RewardedInterstitialAd(
              global.__adsenseRewardedUnit
            );
            adUnit.addEventListener('close', function () {
              resolve({ completed: false, source: 'adsense' });
            });
            adUnit.addEventListener('granted_reward', function () {
              resolve({ completed: true, source: 'adsense' });
            });
            adUnit.show();
          } catch (e) {
            console.warn(LOG, 'AdSense rewarded error:', e.message);
            resolve({ completed: false, source: 'adsense', error: e.message });
          }
        } else {
          // Not yet approved — fallback
          resolve(null);
        }
      });
    }
  };

  // ── Provider: Monetag ─────────────────────────────────────────────────
  _providers['monetag'] = {
    name: 'Monetag',
    isReady: function () {
      return !!(global.Monetag && typeof global.Monetag.show === 'function');
    },
    showRewarded: function () {
      return new Promise(function (resolve) {
        if (!global.Monetag) { resolve(null); return; }
        try {
          global.Monetag.show({
            type: 'reward',
            onComplete: function () { resolve({ completed: true, source: 'monetag' }); },
            onClose: function () { resolve({ completed: false, source: 'monetag' }); },
            onError: function (e) { resolve({ completed: false, source: 'monetag', error: e }); }
          });
        } catch (e) {
          resolve(null);
        }
      });
    }
  };

  // ── Provider: PropellerAds ────────────────────────────────────────────
  _providers['propellerads'] = {
    name: 'PropellerAds',
    isReady: function () {
      return !!(global.PropellerAds && typeof global.PropellerAds.trigger === 'function');
    },
    showRewarded: function () {
      return new Promise(function (resolve) {
        if (!global.PropellerAds) { resolve(null); return; }
        try {
          global.PropellerAds.trigger('reward', {
            onSuccess: function () { resolve({ completed: true, source: 'propellerads' }); },
            onCancel: function () { resolve({ completed: false, source: 'propellerads' }); }
          });
        } catch (e) {
          resolve(null);
        }
      });
    }
  };

  // ── Provider: Adsterra ───────────────────────────────────────────────
  _providers['adsterra'] = {
    name: 'Adsterra',
    isReady: function () {
      return !!(global.Adsterra && global.Adsterra.rewarded);
    },
    showRewarded: function () {
      return new Promise(function (resolve) {
        if (!global.Adsterra || !global.Adsterra.rewarded) { resolve(null); return; }
        try {
          global.Adsterra.rewarded.show({
            onGranted: function () { resolve({ completed: true, source: 'adsterra' }); },
            onDismissed: function () { resolve({ completed: false, source: 'adsterra' }); }
          });
        } catch (e) {
          resolve(null);
        }
      });
    }
  };

  // ── Fallback: Simulated reward (development / no network approval yet) ─
  // This shows a real interstitial-style waiting screen so UX is real.
  // Replace with actual ad network when approved.
  _providers['fallback'] = {
    name: 'Fallback',
    isReady: function () { return true; },
    showRewarded: function () {
      return new Promise(function (resolve) {
        var existing = document.getElementById('ilpdf-ad-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'ilpdf-ad-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Earn extra credits');

        var WAIT_SECONDS = 5;
        overlay.innerHTML = [
          '<div class="ad-overlay-backdrop"></div>',
          '<div class="ad-overlay-card">',
          '  <div class="ad-overlay-header">',
          '    <span class="ad-overlay-label">Advertisement</span>',
          '    <span class="ad-overlay-countdown" id="ilpdf-ad-timer">' + WAIT_SECONDS + 's</span>',
          '  </div>',
          '  <div class="ad-overlay-content">',
          '    <div class="ad-overlay-icon">⚡</div>',
          '    <h3>Unlocking your extra credits…</h3>',
          '    <p>Thank you for supporting ILovePDF! Your <strong>+5 free operations</strong> will be added in a moment.</p>',
          '    <div class="ad-overlay-progress"><div class="ad-overlay-bar" id="ilpdf-ad-bar"></div></div>',
          '  </div>',
          '  <div class="ad-overlay-footer">',
          '    <a href="/donate" target="_blank" class="ad-overlay-support">Skip ads forever — donate instead 💙</a>',
          '    <button class="ad-overlay-close ad-overlay-close--disabled" id="ilpdf-ad-close" disabled>Wait…</button>',
          '  </div>',
          '</div>'
        ].join('');

        document.body.appendChild(overlay);

        var timer = overlay.querySelector('#ilpdf-ad-timer');
        var bar = overlay.querySelector('#ilpdf-ad-bar');
        var closeBtn = overlay.querySelector('#ilpdf-ad-close');
        var remaining = WAIT_SECONDS;
        var start = Date.now();

        var interval = setInterval(function () {
          var elapsed = (Date.now() - start) / 1000;
          var pct = Math.min(100, (elapsed / WAIT_SECONDS) * 100);
          remaining = Math.max(0, WAIT_SECONDS - Math.floor(elapsed));
          if (timer) timer.textContent = remaining + 's';
          if (bar) bar.style.width = pct + '%';

          if (elapsed >= WAIT_SECONDS) {
            clearInterval(interval);
            if (closeBtn) {
              closeBtn.disabled = false;
              closeBtn.textContent = 'Collect +5 Credits ✓';
              closeBtn.classList.remove('ad-overlay-close--disabled');
              closeBtn.classList.add('ad-overlay-close--ready');
              closeBtn.focus();
            }
            if (timer) timer.textContent = '✓';
          }
        }, 100);

        closeBtn.addEventListener('click', function () {
          if (closeBtn.disabled) return;
          clearInterval(interval);
          overlay.remove();
          resolve({ completed: true, source: 'fallback' });
        });
      });
    }
  };

  // ── Provider Selection ───────────────────────────────────────────────
  function pickProvider() {
    var priority = ['adsense', 'monetag', 'propellerads', 'adsterra', 'fallback'];
    for (var i = 0; i < priority.length; i++) {
      var p = _providers[priority[i]];
      if (p && p.isReady()) return priority[i];
    }
    return 'fallback';
  }

  // ── Public API ───────────────────────────────────────────────────────
  global.RuntimeAds = {
    registerProvider: function (name, adapter) {
      if (typeof adapter.isReady !== 'function' || typeof adapter.showRewarded !== 'function') {
        console.error(LOG, 'provider must implement isReady() and showRewarded()');
        return false;
      }
      _providers[name] = adapter;
      console.info(LOG, 'provider registered:', name);
      return true;
    },

    setProvider: function (name) {
      if (!_providers[name]) {
        console.error(LOG, 'provider not registered:', name);
        return false;
      }
      _activeProvider = name;
      return true;
    },

    showRewarded: function () {
      var now = Date.now();

      // Global cooldown check (prevent rapid-fire)
      if (now - _lastShownAt < GLOBAL_COOLDOWN_MS && _showCount > 0) {
        var wait = Math.ceil((GLOBAL_COOLDOWN_MS - (now - _lastShownAt)) / 60000);
        return Promise.resolve({ completed: false, reason: 'global_cooldown', waitMinutes: wait });
      }

      var providerName = _activeProvider || pickProvider();
      var provider = _providers[providerName];

      if (!provider) {
        return Promise.resolve({ completed: false, reason: 'no_provider' });
      }

      _lastShownAt = now;
      _showCount++;

      console.info(LOG, 'showing rewarded ad via:', providerName);
      return provider.showRewarded().then(function (result) {
        if (!result) {
          // Provider failed, try fallback
          if (providerName !== 'fallback') {
            console.warn(LOG, providerName, 'failed, falling back');
            return _providers['fallback'].showRewarded();
          }
          return { completed: false, source: 'none' };
        }
        return result;
      });
    },

    status: function () {
      var readyProviders = Object.keys(_providers).filter(function (n) {
        return _providers[n].isReady();
      });
      return {
        activeProvider: _activeProvider || pickProvider(),
        readyProviders: readyProviders,
        showCount: _showCount,
        lastShownAt: _lastShownAt,
        globalCooldownMs: GLOBAL_COOLDOWN_MS
      };
    },

    getProviders: function () {
      return Object.keys(_providers).map(function (n) {
        return { name: n, ready: _providers[n].isReady() };
      });
    }
  };

  // Integrate with RuntimeKernel
  if (global.RT && global.RT.register) {
    try { global.RT.register('ads', global.RuntimeAds); } catch (_) {}
  }

  console.info(LOG, 'ad adapter ready — provider:', pickProvider());

}(typeof window !== 'undefined' ? window : this));

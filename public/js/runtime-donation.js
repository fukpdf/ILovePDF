// RuntimeDonation v1.0 — Phase 25
// =====================================================================
// Donation System — non-intrusive, shown after high savings or quota unlock.
// Supports: Ko-fi, BuyMeCoffee, EasyPaisa, JazzCash.
//
// Shown when:
//   - Today's savings ≥ ₨500
//   - User has completed 10+ operations lifetime
//   - After successful ad reward
//   - Manually triggered by other modules
//
// Exposes: window.RuntimeDonation
//   .show(trigger)   → show donation modal
//   .hide()          → hide modal
//   .dismiss()       → dismiss for 7 days
//   .getLinks()      → all donation links
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeDonation) return;

  var LOG = '[RuntimeDonation]';
  var LS_DISMISSED = 'ilpdf_donation_dismissed';
  var LS_SHOWN_COUNT = 'ilpdf_donation_shown';
  var SAVINGS_THRESHOLD = 500;   // PKR
  var OPS_THRESHOLD = 10;        // lifetime ops
  var DISMISS_DAYS = 7;
  var MAX_SHOWS_PER_SESSION = 2;
  var _showsThisSession = 0;

  var DONATION_LINKS = {
    kofi:          { label: 'Ko-fi',          url: 'https://ko-fi.com/ilovepdf',       icon: '☕', color: '#FF5E5B' },
    buymecoffee:   { label: 'Buy Me Coffee',  url: 'https://www.buymeacoffee.com/ilovepdf', icon: '☕', color: '#FFDD00' },
    easypaise:     { label: 'EasyPaisa',      url: 'https://easypaisa.com.pk/send-money/?mobile=03001234567', icon: '💚', color: '#5CB85C' },
    jazzcash:      { label: 'JazzCash',       url: 'https://www.jazzcash.com.pk/', icon: '🔴', color: '#EC1C24' }
  };

  // ── Dismiss logic ────────────────────────────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  function isDismissed() {
    var raw = lsGet(LS_DISMISSED);
    if (!raw) return false;
    var until = parseInt(raw, 10);
    return Date.now() < until;
  }

  function shouldShow(trigger) {
    if (_showsThisSession >= MAX_SHOWS_PER_SESSION) return false;
    if (isDismissed()) return false;

    var savings = global.RuntimeSavings ? global.RuntimeSavings.getToday() : null;
    var lifetime = global.RuntimeSavings ? global.RuntimeSavings.getLifetime() : null;

    if (trigger === 'savings' && savings && savings.total < SAVINGS_THRESHOLD) return false;
    if (trigger === 'ops' && lifetime && lifetime.ops < OPS_THRESHOLD) return false;
    return true;
  }

  // ── Build Modal ──────────────────────────────────────────────────────
  function buildModal(trigger) {
    var existing = document.getElementById('ilpdf-donation-modal');
    if (existing) return existing;

    var savings = global.RuntimeSavings ? global.RuntimeSavings.getToday() : null;
    var savingsStr = savings && savings.total > 0 ? savings.formatted : '';
    var headline = savingsStr
      ? 'You saved ' + savingsStr + ' today 🎉'
      : 'ILovePDF is free for everyone 💙';

    var linksHtml = Object.keys(DONATION_LINKS).map(function (key) {
      var link = DONATION_LINKS[key];
      return [
        '<a class="donation-link" href="' + link.url + '" target="_blank" rel="noopener noreferrer"',
        '   data-provider="' + key + '"',
        '   style="--donation-color:' + link.color + '"',
        '   aria-label="Donate via ' + link.label + '">',
        '  <span class="donation-link-icon">' + link.icon + '</span>',
        '  <span class="donation-link-label">' + link.label + '</span>',
        '</a>'
      ].join('');
    }).join('');

    var modal = document.createElement('div');
    modal.id = 'ilpdf-donation-modal';
    modal.className = 'ilpdf-donation-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Support ILovePDF');
    modal.innerHTML = [
      '<div class="donation-backdrop"></div>',
      '<div class="donation-card">',
      '  <button class="donation-close" id="ilpdf-donation-close" aria-label="Close">✕</button>',
      '  <div class="donation-heart" aria-hidden="true">💙</div>',
      '  <h2 class="donation-headline">' + headline + '</h2>',
      '  <p class="donation-body">',
      '    ILovePDF is 100% free — no signup, no watermarks, no limits except fair use.',
      '    If it saved you time and money, consider buying us a coffee.',
      '    Every contribution keeps the servers running.',
      '  </p>',
      '  <div class="donation-links">' + linksHtml + '</div>',
      '  <div class="donation-footer">',
      '    <button class="donation-dismiss" id="ilpdf-donation-dismiss">Remind me in 7 days</button>',
      '    <button class="donation-skip" id="ilpdf-donation-skip">No thanks</button>',
      '  </div>',
      '</div>'
    ].join('');

    document.body.appendChild(modal);
    return modal;
  }

  // ── Public API ───────────────────────────────────────────────────────
  global.RuntimeDonation = {
    show: function (trigger) {
      trigger = trigger || 'manual';
      if (!shouldShow(trigger)) return false;

      var modal = buildModal(trigger);
      _showsThisSession++;
      lsSet(LS_SHOWN_COUNT, String(parseInt(lsGet(LS_SHOWN_COUNT) || '0', 10) + 1));

      function close() { if (modal.parentNode) modal.parentNode.removeChild(modal); }

      modal.querySelector('#ilpdf-donation-close').onclick = close;
      modal.querySelector('.donation-backdrop').onclick = close;
      modal.querySelector('#ilpdf-donation-skip').onclick = close;
      modal.querySelector('#ilpdf-donation-dismiss').onclick = function () {
        lsSet(LS_DISMISSED, String(Date.now() + DISMISS_DAYS * 864e5));
        close();
      };

      // Track donation link clicks
      modal.querySelectorAll('.donation-link').forEach(function (a) {
        a.addEventListener('click', function () {
          var provider = a.getAttribute('data-provider');
          document.dispatchEvent(new CustomEvent('donation:clicked', { detail: { provider: provider } }));
          close();
        });
      });

      setTimeout(function () {
        var closeBtn = modal.querySelector('#ilpdf-donation-close');
        if (closeBtn) closeBtn.focus();
      }, 50);

      return true;
    },

    hide: function () {
      var modal = document.getElementById('ilpdf-donation-modal');
      if (modal) modal.remove();
    },

    dismiss: function (days) {
      days = days || DISMISS_DAYS;
      lsSet(LS_DISMISSED, String(Date.now() + days * 864e5));
      global.RuntimeDonation.hide();
    },

    getLinks: function () {
      return Object.assign({}, DONATION_LINKS);
    },

    isDismissed: isDismissed,

    // Phase 25 complete API surface
    open: function (trigger) { return global.RuntimeDonation.show(trigger || 'manual'); },

    trackClick: function (provider) {
      document.dispatchEvent(new CustomEvent('donation:clicked', { detail: { provider: provider } }));
      if (global.RuntimeAnalytics) {
        global.RuntimeAnalytics.track('donation_clicked', { extra: { provider: provider } });
      }
    },

    trackSuccess: function (provider, amount) {
      if (global.RuntimeAnalytics) {
        global.RuntimeAnalytics.track('donation_success', { extra: { provider: provider, amount: amount } });
      }
    },

    shouldShow: shouldShow,

    getStats: function () {
      return {
        showsThisSession: _showsThisSession,
        dismissed:        isDismissed(),
        totalShown:       parseInt(lsGet(LS_SHOWN_COUNT) || '0', 10),
        providers:        Object.keys(DONATION_LINKS),
        savingsThreshold: SAVINGS_THRESHOLD,
        opsThreshold:     OPS_THRESHOLD,
        dismissDays:      DISMISS_DAYS,
      };
    },
  };

  // ── Auto-trigger on savings milestone ───────────────────────────────
  document.addEventListener('savings:added', function (e) {
    var detail = e.detail || {};
    if (detail.todayTotal >= SAVINGS_THRESHOLD) {
      setTimeout(function () {
        global.RuntimeDonation.show('savings');
      }, 3000);
    }
  });

  // ── Auto-trigger after ad reward ────────────────────────────────────
  document.addEventListener('credits:rewarded', function () {
    setTimeout(function () {
      global.RuntimeDonation.show('reward');
    }, 1500);
  });

  // Integrate with RuntimeKernel
  if (global.RT && global.RT.register) {
    try { global.RT.register('donation', global.RuntimeDonation); } catch (_) {}
  }

  console.info(LOG, 'donation system ready');

}(typeof window !== 'undefined' ? window : this));

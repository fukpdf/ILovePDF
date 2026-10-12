// SavingsAnimation — Phase Community
// Adds enhanced coin-drop-to-bucket animation layer on top of the
// existing RuntimeSavings.showCoinBurst(). Listens for 'savings:added'
// custom event and triggers:
//   1. Coins fall from download area toward the header savings widget
//   2. Bucket fill progression
//   3. Floating "+ PKR X" text near the widget
//
// This is entirely additive — RuntimeSavings.showCoinBurst() still runs.
// =========================================================================
(function (G) {
  'use strict';

  if (G.SavingsAnimation) return;

  // ── Motion preference ────────────────────────────────────────────────────
  var _reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Bucket system ─────────────────────────────────────────────────────────
  // Savings tiers → fill percentage + color + label
  var BUCKET_TIERS = [
    { min: 0,    fill: 0,   color: '#94a3b8', label: 'Empty'   },
    { min: 200,  fill: 25,  color: '#10b981', label: 'Growing' },
    { min: 500,  fill: 50,  color: '#3b82f6', label: 'Half Full' },
    { min: 1500, fill: 75,  color: '#8b5cf6', label: 'Almost Full' },
    { min: 5000, fill: 100, color: '#f59e0b', label: 'Golden'   },
  ];

  function getTier(savings) {
    var tier = BUCKET_TIERS[0];
    for (var i = 0; i < BUCKET_TIERS.length; i++) {
      if (savings >= BUCKET_TIERS[i].min) tier = BUCKET_TIERS[i];
    }
    return tier;
  }

  function updateBucket(savings) {
    var el = document.querySelector('.ce-bucket-wrap');
    if (!el) return;
    var tier = getTier(savings);
    var fill = el.querySelector('.ce-bucket-fill');
    var outer = el.querySelector('.ce-bucket');
    if (fill) fill.style.height = tier.fill + '%';
    if (outer) outer.style.color = tier.color;
    el.title = 'Savings bucket — ' + tier.label;
  }

  // ── Coin drop ─────────────────────────────────────────────────────────────
  function dropCoins(fromEl, amount) {
    if (_reduced) return;
    var container = document.querySelector('.ce-coin-drop-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'ce-coin-drop-container';
      container.setAttribute('aria-hidden', 'true');
      document.body.appendChild(container);
    }

    // Target: desktop savings widget or mobile savings pill
    var targetEl = document.querySelector('.ce-widget-desktop') || document.querySelector('.ce-widget-mobile');
    var targetRect = targetEl ? targetEl.getBoundingClientRect() : null;
    var fromRect   = fromEl  ? fromEl.getBoundingClientRect()   : null;

    var startX = fromRect  ? fromRect.left  + fromRect.width  / 2 : window.innerWidth  / 2;
    var startY = fromRect  ? fromRect.top   + fromRect.height / 2 : window.innerHeight / 2;
    var endX   = targetRect ? targetRect.left + targetRect.width / 2 : startX;
    var endY   = targetRect ? targetRect.top  + targetRect.height / 2 : 60;

    var count = Math.min(8, Math.max(3, Math.floor(amount / 40)));
    var EMOJIS = ['🪙', '💰', '🪙'];

    for (var i = 0; i < count; i++) {
      (function (idx) {
        var delay = idx * 0.08;
        var coin  = document.createElement('span');
        coin.className = 'ce-coin';
        coin.textContent = EMOJIS[idx % EMOJIS.length];
        // Start position with jitter
        var sx = startX + (Math.random() - 0.5) * 60;
        var sy = startY;
        coin.style.cssText = [
          'left:' + sx + 'px',
          'top:'  + sy + 'px',
          '--from-y:0px',
          '--to-y:'   + (endY - sy) + 'px',
          '--drift:'  + ((endX - sx) * 0.85 + (Math.random() - 0.5) * 30) + 'px',
          '--delay:'  + delay + 's',
          '--dur:'    + (0.65 + Math.random() * 0.25) + 's',
        ].join(';');
        container.appendChild(coin);
        setTimeout(function () {
          if (coin.parentNode) coin.parentNode.removeChild(coin);
          // Trigger bucket fill on last coin
          if (idx === count - 1) updateBucketOnArrival();
        }, (delay + 1.1) * 1000);
      }(i));
    }
  }

  function updateBucketOnArrival() {
    var sav = G.RuntimeSavings ? G.RuntimeSavings.getLifetime().total : 0;
    updateBucket(sav);
    // Flash the widget
    var widget = document.querySelector('.ce-widget-desktop') || document.querySelector('.ce-widget-mobile');
    if (widget && !_reduced) {
      widget.style.transition = 'box-shadow .15s, transform .15s';
      widget.style.transform  = 'scale(1.06)';
      widget.style.boxShadow  = '0 0 0 3px rgba(245,158,11,.4)';
      setTimeout(function () {
        widget.style.transform  = '';
        widget.style.boxShadow  = '';
      }, 300);
    }
  }

  // ── Floating amount text ──────────────────────────────────────────────────
  function showFloatingAmt(amount) {
    if (_reduced) return;
    var targetEl = document.querySelector('.ce-widget-desktop .ce-stat-val') ||
                   document.querySelector('.ce-pill-savings .ce-pill-val');
    if (!targetEl) return;
    var rect = targetEl.getBoundingClientRect();
    var el   = document.createElement('span');
    el.className   = 'ce-savings-float';
    el.textContent = '+₨' + Math.round(amount);
    el.style.cssText = 'left:' + (rect.left + rect.width / 2) + 'px;top:' + (rect.top - 8) + 'px;transform:translateX(-50%)';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1200);
  }

  // ── Tab-visibility pause ─────────────────────────────────────────────────
  var _paused = false;
  document.addEventListener('visibilitychange', function () {
    _paused = document.hidden;
  });

  // ── Listen for savings events ─────────────────────────────────────────────
  document.addEventListener('savings:added', function (e) {
    if (_paused) return;
    var amount = e.detail && e.detail.amount || 0;
    var lifetime = G.RuntimeSavings ? G.RuntimeSavings.getLifetime().total : amount;

    // Find a good anchor element near the download button
    var anchor = document.querySelector('.dl-burst-trigger') ||
                 document.querySelector('[data-download]')   ||
                 document.querySelector('.download-btn')     ||
                 document.querySelector('.result-section');

    // Small delay so existing coin burst fires first
    setTimeout(function () {
      dropCoins(anchor, amount);
      showFloatingAmt(amount);
    }, 150);

    // Update bucket
    setTimeout(function () { updateBucket(lifetime); }, 1000);
  });

  // ── Init bucket on load ────────────────────────────────────────────────────
  setTimeout(function () {
    var sav = G.RuntimeSavings ? G.RuntimeSavings.getLifetime().total : 0;
    updateBucket(sav);
  }, 1500);

  G.SavingsAnimation = { updateBucket: updateBucket };

}(typeof window !== 'undefined' ? window : this));

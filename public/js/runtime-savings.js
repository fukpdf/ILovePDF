// RuntimeSavings v1.0 — Phase 24D/E/F
// =====================================================================
// Savings Engine: shows users the real-world value saved vs paid services.
// Values are conservative estimates in PKR (Pakistani Rupee).
// Shows animated coin UI after each tool completes.
// Drives the header widget + homepage community counter.
//
// Exposes: window.RuntimeSavings
//   .add(slug)         → record savings for a tool use
//   .getToday()        → { total, ops, currency }
//   .getLifetime()     → { total, ops, currency }
//   .getCommunity()    → fetch server aggregate
//   .reset()           → clear local savings
//   .showCoinBurst(el) → animate coin burst near element
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeSavings) return;

  var LOG = '[RuntimeSavings]';
  var LS_TODAY = 'ilpdf_savings_today';
  var LS_LIFETIME = 'ilpdf_savings_lifetime';
  var LS_TODAY_TS = 'ilpdf_savings_today_ts';
  var COMMUNITY_ENDPOINT = '/api/community/savings';
  var COMMUNITY_REPORT_ENDPOINT = '/api/community/savings/add';

  // Per-tool estimated savings in PKR (based on freelancer market rates)
  var SAVINGS_TABLE = {
    'merge':              120,
    'split':               80,
    'compress':            90,
    'rotate':              40,
    'crop':                50,
    'organize':            75,
    'pdf-to-word':        180,
    'pdf-to-powerpoint':  200,
    'pdf-to-excel':       200,
    'pdf-to-jpg':          60,
    'word-to-pdf':        100,
    'powerpoint-to-pdf':  100,
    'excel-to-pdf':       100,
    'word-to-excel':      180,
    'jpg-to-pdf':          60,
    'html-to-pdf':        150,
    'edit':                90,
    'watermark':           70,
    'sign':               130,
    'page-numbers':        45,
    'redact':             160,
    'protect':             80,
    'unlock':              80,
    'repair':             200,
    'scan-to-pdf':        100,
    'ocr':                250,
    'compare':            220,
    'ai-summarize':       350,
    'translate':          400,
    'workflow':           300,
    'numbers-to-words':    20,
    'currency-converter':  15,
    'background-remover': 280,
    'crop-image':          45,
    'resize-image':        35,
    'image-filters':       60,
    '_default':            80
  };

  // ── Safe localStorage ────────────────────────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  // ── Today state reset check ──────────────────────────────────────────
  function getTodayState() {
    var ts = parseInt(lsGet(LS_TODAY_TS) || '0', 10);
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    var todayStart = d.getTime();
    if (ts < todayStart) {
      lsSet(LS_TODAY, JSON.stringify({ total: 0, ops: 0 }));
      lsSet(LS_TODAY_TS, String(Date.now()));
    }
    try { return JSON.parse(lsGet(LS_TODAY) || '{"total":0,"ops":0}'); } catch (_) { return { total: 0, ops: 0 }; }
  }

  function getLifetimeState() {
    try { return JSON.parse(lsGet(LS_LIFETIME) || '{"total":0,"ops":0}'); } catch (_) { return { total: 0, ops: 0 }; }
  }

  function saveTodayState(s) { lsSet(LS_TODAY, JSON.stringify(s)); }
  function saveLifetimeState(s) { lsSet(LS_LIFETIME, JSON.stringify(s)); }

  // ── Format PKR ───────────────────────────────────────────────────────
  function formatPKR(amount) {
    if (amount >= 1000) return '₨' + (amount / 1000).toFixed(1) + 'K';
    return '₨' + Math.round(amount);
  }

  // ── Coin Burst Animation ─────────────────────────────────────────────
  function showCoinBurst(anchorEl, amount) {
    var container = document.createElement('div');
    container.className = 'ilpdf-coin-burst';
    container.setAttribute('aria-hidden', 'true');

    var rect = anchorEl ? anchorEl.getBoundingClientRect() : { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 0, height: 0 };
    var originX = rect.left + rect.width / 2 + global.scrollX;
    var originY = rect.top + rect.height / 2 + global.scrollY;

    container.style.cssText = 'position:absolute;left:' + originX + 'px;top:' + originY + 'px;pointer-events:none;z-index:9999;';

    var coinCount = Math.min(12, Math.max(5, Math.floor(amount / 30)));
    var coins = '';
    for (var i = 0; i < coinCount; i++) {
      var angle = (360 / coinCount) * i + Math.random() * 20 - 10;
      var dist = 40 + Math.random() * 60;
      var delay = Math.random() * 0.3;
      var size = 14 + Math.random() * 10;
      coins += '<span class="ilpdf-coin" style="--angle:' + angle + 'deg;--dist:' + dist + 'px;--delay:' + delay.toFixed(2) + 's;--size:' + size + 'px">🪙</span>';
    }

    // Savings popup
    coins += '<div class="ilpdf-savings-popup">You saved ' + formatPKR(amount) + '!</div>';
    container.innerHTML = coins;
    document.body.appendChild(container);

    // Clean up
    setTimeout(function () { if (container.parentNode) container.parentNode.removeChild(container); }, 2200);
  }

  // ── Download Success Panel ───────────────────────────────────────────
  function showDownloadSuccessPanel(slug, amount) {
    var existing = document.getElementById('ilpdf-success-panel');
    if (existing) existing.remove();

    var today = getTodayState();
    var lifetime = getLifetimeState();
    var quotes = [
      'Every rupee saved is a rupee earned!',
      'Smart tools for smart people.',
      'Professional results, zero cost.',
      'Your files, your control, no fees.',
      'Keep your hard-earned money!'
    ];
    var quote = quotes[Math.floor(Math.random() * quotes.length)];

    var panel = document.createElement('div');
    panel.id = 'ilpdf-success-panel';
    panel.className = 'ilpdf-success-panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = [
      '<button class="ilpdf-success-close" id="ilpdf-success-close" aria-label="Close">✕</button>',
      '<div class="ilpdf-success-coins" id="ilpdf-success-coins" aria-hidden="true">',
      '  <span class="ilpdf-coin-pile">🪙</span>',
      '  <span class="ilpdf-coin-pile ilpdf-coin-pile--2">🪙</span>',
      '  <span class="ilpdf-coin-pile ilpdf-coin-pile--3">🪙</span>',
      '</div>',
      '<div class="ilpdf-success-content">',
      '  <p class="ilpdf-success-saved">You just saved <strong class="ilpdf-saved-amount">' + formatPKR(amount) + '</strong></p>',
      '  <p class="ilpdf-success-today">Today\'s savings: <strong>' + formatPKR(today.total) + '</strong> · All time: <strong>' + formatPKR(lifetime.total) + '</strong></p>',
      '  <p class="ilpdf-success-quote"><em>"' + quote + '"</em></p>',
      '  <div class="ilpdf-success-actions">',
      '    <a href="/donate" class="ilpdf-btn-support" target="_blank">Support us 💙</a>',
      '    <button class="ilpdf-btn-share" id="ilpdf-share-savings">Share this</button>',
      '  </div>',
      '</div>'
    ].join('');

    document.body.appendChild(panel);

    panel.querySelector('#ilpdf-success-close').addEventListener('click', function () { panel.remove(); });

    var shareBtn = panel.querySelector('#ilpdf-share-savings');
    if (shareBtn) {
      shareBtn.addEventListener('click', function () {
        var text = 'I just saved ' + formatPKR(amount) + ' using ILovePDF free tools! 🎉 ilovepdf.cyou';
        if (navigator.share) {
          navigator.share({ text: text, url: 'https://ilovepdf.cyou' }).catch(function () {});
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            shareBtn.textContent = 'Copied! ✓';
          });
        }
      });
    }

    // Coin burst
    setTimeout(function () {
      var coinsEl = panel.querySelector('#ilpdf-success-coins');
      if (coinsEl) showCoinBurst(coinsEl, amount);
    }, 300);

    // Auto-hide after 10s
    setTimeout(function () { if (panel.parentNode) panel.remove(); }, 10000);
  }

  // ── Header Widget ────────────────────────────────────────────────────
  function updateHeaderWidget(todayTotal) {
    var widget = document.getElementById('ilpdf-savings-widget');
    if (!widget) {
      // Create it
      var header = document.querySelector('.header-inner');
      if (!header) return;
      widget = document.createElement('div');
      widget.id = 'ilpdf-savings-widget';
      widget.className = 'ilpdf-savings-widget';
      widget.setAttribute('title', 'Total money saved today using ILovePDF');
      header.appendChild(widget);
    }
    widget.innerHTML = '💰 <span class="ilpdf-savings-widget-val">' + formatPKR(todayTotal) + '</span> saved today';
  }

  // ── Community Savings ────────────────────────────────────────────────
  var _communityCache = null;
  var _communityFetchedAt = 0;

  function getCommunity() {
    var now = Date.now();
    if (_communityCache && now - _communityFetchedAt < 60000) {
      return Promise.resolve(_communityCache);
    }
    return fetch(COMMUNITY_ENDPOINT, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) {
          _communityCache = data;
          _communityFetchedAt = Date.now();
          // Update any community widgets
          var el = document.getElementById('ilpdf-community-savings');
          if (el && data.total) el.textContent = formatPKR(data.total);
        }
        return data;
      })
      .catch(function () { return _communityCache; });
  }

  function reportToCommunity(amount) {
    var identity = global.RuntimeIdentity;
    var uid = identity ? identity.getUser().id : 'anon';
    fetch(COMMUNITY_REPORT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ uid: uid, amount: amount })
    }).catch(function () {});
  }

  // ── Initialize ───────────────────────────────────────────────────────
  var todayState = getTodayState();
  if (todayState.total > 0) {
    setTimeout(function () { updateHeaderWidget(todayState.total); }, 1000);
  }

  // Fetch community counter on load
  setTimeout(function () { getCommunity(); }, 3000);

  // ── Public API ───────────────────────────────────────────────────────
  global.RuntimeSavings = {
    add: function (slug, customAmount) {
      var amount = customAmount || SAVINGS_TABLE[slug] || SAVINGS_TABLE['_default'];
      var today = getTodayState();
      var lifetime = getLifetimeState();

      today.total += amount;
      today.ops += 1;
      lifetime.total += amount;
      lifetime.ops += 1;

      saveTodayState(today);
      saveLifetimeState(lifetime);
      lsSet(LS_TODAY_TS, String(Date.now()));

      updateHeaderWidget(today.total);
      reportToCommunity(amount);

      // Show success panel after a short delay
      setTimeout(function () {
        var anchor = document.querySelector('.download-btn') ||
                     document.querySelector('[data-download]') ||
                     document.querySelector('.result-section') || null;
        showDownloadSuccessPanel(slug, amount);
        if (anchor) showCoinBurst(anchor, amount);
      }, 600);

      document.dispatchEvent(new CustomEvent('savings:added', {
        detail: { slug: slug, amount: amount, todayTotal: today.total }
      }));

      return { amount: amount, todayTotal: today.total, lifetimeTotal: lifetime.total };
    },

    getToday: function () {
      var s = getTodayState();
      return { total: s.total, ops: s.ops, currency: 'PKR', formatted: formatPKR(s.total) };
    },

    getLifetime: function () {
      var s = getLifetimeState();
      return { total: s.total, ops: s.ops, currency: 'PKR', formatted: formatPKR(s.total) };
    },

    getCommunity: getCommunity,

    reset: function () {
      lsSet(LS_TODAY, JSON.stringify({ total: 0, ops: 0 }));
      lsSet(LS_TODAY_TS, '0');
      lsSet(LS_LIFETIME, JSON.stringify({ total: 0, ops: 0 }));
      updateHeaderWidget(0);
      return true;
    },

    showCoinBurst: showCoinBurst,
    showDownloadSuccessPanel: showDownloadSuccessPanel,
    formatPKR: formatPKR,
    getSavingsForTool: function (slug) {
      return SAVINGS_TABLE[slug] || SAVINGS_TABLE['_default'];
    }
  };

  // Integrate with RuntimeKernel
  if (global.RT && global.RT.register) {
    try { global.RT.register('savings', global.RuntimeSavings); } catch (_) {}
  }

  console.info(LOG, 'savings engine ready — today:', formatPKR(todayState.total));

}(typeof window !== 'undefined' ? window : this));

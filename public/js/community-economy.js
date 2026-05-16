// CommunityEconomy — Phase Community
// =====================================================================
// Orchestrates all community-facing UI:
//   - Mobile header pill widget (credits + savings)
//   - Desktop header widget (credits + today savings + lifetime savings)
//   - Desktop dashboard modal (full stats popup)
//   - Homepage community impact section live updates
//   - Live activity ticker
//   - Streak + achievement tracking
//   - Real-time polling (10s interval, paused when tab hidden)
//
// All data comes from:
//   - /api/community/stats  — server aggregate stats
//   - /api/community/user/:uid — per-user stats + achievements
//   - window.RuntimeSavings — local savings state
//   - window.RuntimeCredits — credit balance
//
// Architecture: additive, zero breaking changes, all guards via _s()
// =====================================================================
(function (G) {
  'use strict';

  if (G.CommunityEconomy) return;

  var LOG = '[CE]';

  // ── Safe accessor ────────────────────────────────────────────────────────
  function _s(fn, def) { try { return fn(); } catch (_) { return def; } }

  // ── Format PKR ───────────────────────────────────────────────────────────
  function fmtPKR(n) {
    n = Math.round(n || 0);
    if (n >= 1000000) return '₨' + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return '₨' + (n / 1000).toFixed(1) + 'K';
    return '₨' + n;
  }

  // ── Smooth count-up animation ─────────────────────────────────────────────
  // el: DOM element, target: number, duration: ms, formatter: fn
  function countUp(el, target, duration, fmt) {
    if (!el) return;
    fmt = fmt || String;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { el.textContent = fmt(target); return; }
    var start    = _s(function () { return parseFloat(el.dataset.ceVal) || 0; }, 0);
    var startTs  = null;
    var dur      = duration || 800;
    function step(ts) {
      if (!startTs) startTs = ts;
      var p = Math.min((ts - startTs) / dur, 1);
      // ease-out cubic
      var e = 1 - Math.pow(1 - p, 3);
      var cur = Math.round(start + (target - start) * e);
      el.textContent = fmt(cur);
      if (p < 1) requestAnimationFrame(step);
      else { el.textContent = fmt(target); el.dataset.ceVal = target; }
    }
    el.dataset.ceVal = start;
    requestAnimationFrame(step);
  }

  // ── Levels ────────────────────────────────────────────────────────────────
  var LEVELS = [
    { name: 'Bronze Saver',   min: 0,    max: 200,  icon: '🥉', color: '#cd7f32' },
    { name: 'Silver Saver',   min: 200,  max: 500,  icon: '🥈', color: '#94a3b8' },
    { name: 'Gold Saver',     min: 500,  max: 1500, icon: '🥇', color: '#f59e0b' },
    { name: 'Power User',     min: 1500, max: 5000, icon: '⚡',  color: '#8b5cf6' },
    { name: 'Community Hero', min: 5000, max: null, icon: '🏆', color: '#ec4899' },
  ];

  function getLevel(savings) {
    var lvl = LEVELS[0];
    for (var i = 0; i < LEVELS.length; i++) {
      if (savings >= LEVELS[i].min) lvl = LEVELS[i];
    }
    return lvl;
  }

  function levelProgress(savings) {
    var lvl = getLevel(savings);
    if (!lvl.max) return 100;
    return Math.min(100, Math.round((savings - lvl.min) / (lvl.max - lvl.min) * 100));
  }

  // ── Tool display names ─────────────────────────────────────────────────────
  var TOOL_NAMES = {
    'merge': 'Merge PDF', 'split': 'Split PDF', 'compress': 'Compress PDF',
    'rotate': 'Rotate PDF', 'organize': 'Organize PDF', 'pdf-to-word': 'PDF to Word',
    'word-to-pdf': 'Word to PDF', 'pdf-to-jpg': 'PDF to JPG', 'jpg-to-pdf': 'JPG to PDF',
    'edit': 'Edit PDF', 'watermark': 'Watermark PDF', 'sign': 'Sign PDF',
    'page-numbers': 'Add Page Numbers', 'redact': 'Redact PDF', 'protect': 'Protect PDF',
    'unlock': 'Unlock PDF', 'repair': 'Repair PDF', 'ocr': 'OCR PDF',
    'ai-summarize': 'AI Summarize', 'translate': 'Translate PDF',
    'compare': 'Compare PDF', 'background-remover': 'Remove Background',
    'workflow': 'Workflow', 'crop': 'Crop PDF', 'html-to-pdf': 'HTML to PDF',
  };

  function toolName(slug) {
    return TOOL_NAMES[slug] || (slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : 'Tool');
  }

  // ── Activity feed message generator ──────────────────────────────────────
  var CITIES = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar'];
  function feedMsg(item) {
    var name  = toolName(item.tool);
    var city  = CITIES[Math.floor(Math.random() * CITIES.length)];
    var icons = { 'ocr': '🔍', 'compress': '📦', 'merge': '📎', 'sign': '✍️',
                  'translate': '🌐', 'watermark': '💧', 'protect': '🔒',
                  'ai-summarize': '🤖', 'background-remover': '🎨', '_default': '📄' };
    var icon  = icons[item.tool] || icons['_default'];
    return { icon: icon, text: name + ' completed — saved ' + fmtPKR(item.savings) + ' (User from ' + city + ')', savings: item.savings };
  }

  // Fallback ticker messages used when DB has no data yet
  var FALLBACK_MSGS = [
    { icon: '📎', text: 'Merge PDF completed — saved ₨120', savings: 120 },
    { icon: '📦', text: 'Compress PDF completed — saved ₨90', savings: 90 },
    { icon: '🔍', text: 'OCR PDF completed — saved ₨250', savings: 250 },
    { icon: '📄', text: 'PDF to Word completed — saved ₨180', savings: 180 },
    { icon: '🔒', text: 'Protect PDF completed — saved ₨80', savings: 80 },
    { icon: '🌐', text: 'Translate PDF completed — saved ₨400', savings: 400 },
    { icon: '✍️', text: 'Sign PDF completed — saved ₨130', savings: 130 },
    { icon: '🤖', text: 'AI Summarize completed — saved ₨350', savings: 350 },
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  var _stats     = null;   // last fetched community stats
  var _userStats = null;   // last fetched user stats
  var _tickerIdx = 0;
  var _tickerMsgs= [];
  var _polling   = false;
  var _tabHidden = false;
  var _uid       = null;

  // ── Fetch community stats ─────────────────────────────────────────────────
  function fetchStats() {
    return fetch('/api/community/stats', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        _stats = d;
        updateAllWidgets();
        updateHomepageSection();
        if (d.items || (d.topTools && d.topTools.length)) buildTickerMsgs(d);
      })
      .catch(function () {});
  }

  function fetchActivity() {
    return fetch('/api/community/activity', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.items) return;
        var msgs = d.items.filter(function (i) { return i.savings > 0; }).map(feedMsg);
        if (msgs.length > 0) _tickerMsgs = msgs;
      })
      .catch(function () {});
  }

  function buildTickerMsgs(stats) {
    if (stats.topTools && stats.topTools.length) {
      _tickerMsgs = stats.topTools.slice(0, 8).map(function (t) {
        return {
          icon: '📄',
          text: toolName(t.tool_id) + ' — ' + t.uses + ' uses, saved ' + fmtPKR(t.total_savings),
          savings: t.total_savings,
        };
      });
    }
  }

  function fetchUserStats() {
    if (!_uid) return;
    fetch('/api/community/user/' + encodeURIComponent(_uid), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { _userStats = d; updateModalUserSection(); } })
      .catch(function () {});
  }

  // ── Local data ─────────────────────────────────────────────────────────────
  function getCredits()  { return _s(function () { return G.RuntimeCredits ? G.RuntimeCredits.getBalance() : 15; }, 15); }
  function getSavedToday() { return _s(function () { return G.RuntimeSavings ? G.RuntimeSavings.getToday().total : 0; }, 0); }
  function getSavedLifetime() { return _s(function () { return G.RuntimeSavings ? G.RuntimeSavings.getLifetime().total : 0; }, 0); }

  // ── Mobile header widget ──────────────────────────────────────────────────
  function mountMobileWidget() {
    if (document.getElementById('ce-widget-mobile')) return;
    var headerInner = document.querySelector('.header-inner');
    if (!headerInner) return;

    // Only show on mobile (CSS handles the breakpoint)
    var widget = document.createElement('div');
    widget.id        = 'ce-widget-mobile';
    widget.className = 'ce-widget-mobile';
    widget.setAttribute('aria-label', 'Your credits and savings');

    widget.innerHTML = [
      '<span class="ce-pill ce-pill-credits" aria-label="Credits remaining">',
      '  <span class="ce-pill-icon">⚡</span>',
      '  <span class="ce-pill-val" id="ce-mob-credits">' + getCredits() + '</span>',
      '</span>',
      '<span class="ce-pill ce-pill-savings" aria-label="Money saved today">',
      '  <span class="ce-pill-icon">💰</span>',
      '  <span class="ce-pill-val" id="ce-mob-savings">' + fmtPKR(getSavedToday()) + '</span>',
      '</span>',
    ].join('');

    // Insert before the nav so it sits between brand and nav
    var nav = headerInner.querySelector('#nav');
    if (nav) { headerInner.insertBefore(widget, nav); }
    else { headerInner.appendChild(widget); }
  }

  function updateMobileWidget() {
    var cEl = document.getElementById('ce-mob-credits');
    var sEl = document.getElementById('ce-mob-savings');
    if (cEl) cEl.textContent = getCredits();
    if (sEl) sEl.textContent = fmtPKR(getSavedToday());
  }

  // ── Desktop header widget ─────────────────────────────────────────────────
  function mountDesktopWidget() {
    if (document.getElementById('ce-widget-desktop')) return;
    var nav = document.querySelector('.header-inner');
    if (!nav) return;

    var widget = document.createElement('div');
    widget.id            = 'ce-widget-desktop';
    widget.className     = 'ce-widget-desktop';
    widget.role          = 'button';
    widget.tabIndex      = 0;
    widget.setAttribute('aria-label', 'Open savings dashboard');
    widget.setAttribute('aria-haspopup', 'dialog');

    var todaySav    = getSavedToday();
    var lifetimeSav = getSavedLifetime();
    var credits     = getCredits();

    widget.innerHTML = [
      '<span class="ce-widget-icon">📊</span>',
      '<span class="ce-stat">',
      '  <span class="ce-stat-label">Credits</span>',
      '  <span class="ce-stat-val" id="ce-dsk-credits">' + credits + '</span>',
      '</span>',
      '<span class="ce-stat">',
      '  <span class="ce-stat-label">Saved Today</span>',
      '  <span class="ce-stat-val" id="ce-dsk-today">' + fmtPKR(todaySav) + '</span>',
      '</span>',
      '<span class="ce-stat">',
      '  <span class="ce-stat-label">Total Saved</span>',
      '  <span class="ce-stat-val" id="ce-dsk-total">' + fmtPKR(lifetimeSav) + '</span>',
      '</span>',
      '<span class="ce-widget-caret">▾</span>',
    ].join('');

    widget.addEventListener('click', openDashboard);
    widget.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDashboard(); }
    });

    nav.appendChild(widget);
  }

  function updateDesktopWidget() {
    var cEl = document.getElementById('ce-dsk-credits');
    var tEl = document.getElementById('ce-dsk-today');
    var lEl = document.getElementById('ce-dsk-total');
    if (cEl) cEl.textContent = getCredits();
    if (tEl) tEl.textContent = fmtPKR(getSavedToday());
    if (lEl) lEl.textContent = fmtPKR(getSavedLifetime());
  }

  // ── Dashboard modal ───────────────────────────────────────────────────────
  var _modalOpen = false;
  var _modalEl   = null;

  function openDashboard() {
    if (_modalOpen) return;
    _modalOpen = true;

    var backdrop = document.createElement('div');
    backdrop.className = 'ce-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', 'Savings dashboard');
    _modalEl = backdrop;

    var todaySav    = getSavedToday();
    var lifetimeSav = getSavedLifetime();
    var credits     = getCredits();
    var streak      = _userStats && _userStats.stats ? _userStats.stats.current_streak : 0;
    var lvl         = getLevel(lifetimeSav);
    var pct         = levelProgress(lifetimeSav);

    var communityToday  = _stats ? _stats.today    : { files: 0, savings: 0, users: 0, live: 1 };
    var communityAll    = _stats ? _stats.allTime  : { files: 0, savings: 0, users: 0, aiOps: 0 };

    backdrop.innerHTML = [
      '<div class="ce-modal" role="document">',
      '  <div class="ce-modal-head">',
      '    <h2 class="ce-modal-title">📊 Your Dashboard</h2>',
      '    <button class="ce-modal-close" id="ce-modal-close" aria-label="Close dashboard">✕</button>',
      '  </div>',
      '  <div class="ce-modal-body">',

      // Top cards
      '    <div class="ce-modal-cards">',
      '      <div class="ce-mcard"><div class="ce-mcard-val" id="ce-m-credits">' + credits + '</div><div class="ce-mcard-label">Credits</div></div>',
      '      <div class="ce-mcard"><div class="ce-mcard-val" id="ce-m-today">' + fmtPKR(todaySav) + '</div><div class="ce-mcard-label">Saved Today</div></div>',
      '      <div class="ce-mcard"><div class="ce-mcard-val" id="ce-m-total">' + fmtPKR(lifetimeSav) + '</div><div class="ce-mcard-label">Total Saved</div></div>',
      '      <div class="ce-mcard"><div class="ce-mcard-val" id="ce-m-live">' + communityToday.live + '</div><div class="ce-mcard-label">Online Now</div></div>',
      '      <div class="ce-mcard"><div class="ce-mcard-val" id="ce-m-streak">' + (streak || '—') + '</div><div class="ce-mcard-label">Day Streak</div></div>',
      '      <div class="ce-mcard"><div class="ce-mcard-val">' + lvl.icon + '</div><div class="ce-mcard-label">' + lvl.name + '</div></div>',
      '    </div>',

      // Level progress
      '    <div class="ce-modal-section">',
      '      <div class="ce-level-bar-wrap">',
      '        <span class="ce-level-icon">' + lvl.icon + '</span>',
      '        <div class="ce-level-info">',
      '          <div class="ce-level-name">' + lvl.name + '</div>',
      '          <div class="ce-level-track"><div class="ce-level-fill" id="ce-level-fill" style="width:' + pct + '%"></div></div>',
      '          <div class="ce-level-next" id="ce-level-next">',
      (lvl.max ? (fmtPKR(lifetimeSav) + ' of ' + fmtPKR(lvl.max) + ' to next level') : 'Maximum level reached! 🏆'),
      '          </div>',
      '        </div>',
      '      </div>',
      '    </div>',

      // Today live stats
      '    <div class="ce-modal-section">',
      '      <p class="ce-modal-section-title">Today Live Stats</p>',
      '      <div class="ce-live-grid">',
      '        <div class="ce-live-card"><span class="ce-live-ico">📄</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-tfiles">' + communityToday.files + '</div><div class="ce-live-label">Files Processed</div></div></div>',
      '        <div class="ce-live-card"><span class="ce-live-ico">👥</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-tusers">' + communityToday.users + '</div><div class="ce-live-label">Active Users</div></div></div>',
      '        <div class="ce-live-card"><span class="ce-live-ico">💰</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-tsavings">' + fmtPKR(communityToday.savings) + '</div><div class="ce-live-label">Saved Today</div></div></div>',
      '        <div class="ce-live-card"><span class="ce-live-dot"></span><span class="ce-live-ico">🟢</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-tlive">' + communityToday.live + '</div><div class="ce-live-label">Online Now</div></div></div>',
      '      </div>',
      '    </div>',

      // All-time stats
      '    <div class="ce-modal-section">',
      '      <p class="ce-modal-section-title">All-Time Impact</p>',
      '      <div class="ce-live-grid">',
      '        <div class="ce-live-card"><span class="ce-live-ico">📦</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-afiles">' + communityAll.files + '</div><div class="ce-live-label">Files Processed</div></div></div>',
      '        <div class="ce-live-card"><span class="ce-live-ico">🌍</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-ausers">' + communityAll.users + '</div><div class="ce-live-label">Users Served</div></div></div>',
      '        <div class="ce-live-card"><span class="ce-live-ico">💎</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-asavings">' + fmtPKR(communityAll.savings) + '</div><div class="ce-live-label">Total Saved</div></div></div>',
      '        <div class="ce-live-card"><span class="ce-live-ico">🤖</span><div class="ce-live-info"><div class="ce-live-val" id="ce-m-aai">' + communityAll.aiOps + '</div><div class="ce-live-label">AI Operations</div></div></div>',
      '      </div>',
      '    </div>',

      // Achievements
      '    <div class="ce-modal-section" id="ce-m-achievements">',
      '      <p class="ce-modal-section-title">Achievements</p>',
      '      <div class="ce-achievements" id="ce-m-badges">',
      '        <span class="ce-badge ce-badge-locked">🎯 First Tool</span>',
      '        <span class="ce-badge ce-badge-locked">💰 Saved ₨100</span>',
      '        <span class="ce-badge ce-badge-locked">⚡ 10 Tools</span>',
      '        <span class="ce-badge ce-badge-locked">🔥 3-Day Streak</span>',
      '      </div>',
      '    </div>',

      // Recent activity
      '    <div class="ce-modal-section">',
      '      <p class="ce-modal-section-title">Community Activity</p>',
      '      <div class="ce-feed" id="ce-m-feed">',
      '        <div class="ce-feed-item"><span class="ce-feed-icon">📎</span><span class="ce-feed-text">Merge PDF completed</span><span class="ce-feed-amt">₨120</span></div>',
      '        <div class="ce-feed-item"><span class="ce-feed-icon">🔍</span><span class="ce-feed-text">OCR PDF completed</span><span class="ce-feed-amt">₨250</span></div>',
      '        <div class="ce-feed-item"><span class="ce-feed-icon">📦</span><span class="ce-feed-text">Compress PDF completed</span><span class="ce-feed-amt">₨90</span></div>',
      '      </div>',
      '    </div>',

      '  </div>', // .ce-modal-body
      '</div>',   // .ce-modal
    ].join('');

    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeDashboard();
    });
    backdrop.querySelector('#ce-modal-close').addEventListener('click', closeDashboard);

    document.addEventListener('keydown', _onEsc);
    document.body.appendChild(backdrop);

    // Defer loading user-specific data
    setTimeout(fetchUserStats, 100);
    setTimeout(updateModalFeed, 200);

    // Trap focus
    var firstFocusable = backdrop.querySelector('button');
    if (firstFocusable) firstFocusable.focus();
  }

  function closeDashboard() {
    if (!_modalEl || !_modalOpen) return;
    _modalEl.classList.add('ce-closing');
    var el = _modalEl;
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
    document.removeEventListener('keydown', _onEsc);
    _modalOpen = false;
    _modalEl   = null;
  }

  function _onEsc(e) { if (e.key === 'Escape') closeDashboard(); }

  function updateModalUserSection() {
    if (!_modalEl || !_userStats) return;
    var achs = _userStats.achievements || [];
    var badgesEl = _modalEl.querySelector('#ce-m-badges');
    if (badgesEl) {
      badgesEl.innerHTML = achs.map(function (a) {
        return '<span class="ce-badge ' + (a.unlocked ? 'ce-badge-unlocked' : 'ce-badge-locked') + '" title="' + a.name + '">' + a.icon + ' ' + a.name + '</span>';
      }).join('');
    }
    var stats = _userStats.stats;
    if (stats) {
      var strEl = _modalEl.querySelector('#ce-m-streak');
      if (strEl) strEl.textContent = stats.current_streak || '0';
    }
  }

  function updateModalFeed() {
    if (!_modalEl) return;
    var feed = _modalEl.querySelector('#ce-m-feed');
    if (!feed) return;
    var msgs = _tickerMsgs.length ? _tickerMsgs : FALLBACK_MSGS;
    feed.innerHTML = msgs.slice(0, 6).map(function (m) {
      return [
        '<div class="ce-feed-item">',
        '<span class="ce-feed-icon">' + m.icon + '</span>',
        '<span class="ce-feed-text">' + m.text + '</span>',
        '<span class="ce-feed-amt">' + fmtPKR(m.savings) + '</span>',
        '</div>',
      ].join('');
    }).join('');
  }

  // ── Update all widgets on new data ────────────────────────────────────────
  function updateAllWidgets() {
    updateMobileWidget();
    updateDesktopWidget();
    if (_modalOpen && _modalEl) updateModalStats();
  }

  function updateModalStats() {
    if (!_stats || !_modalEl) return;
    var td = _stats.today, at = _stats.allTime;
    function setText(id, val) { var el = _modalEl.querySelector('#' + id); if (el) el.textContent = val; }
    setText('ce-m-live',     td.live);
    setText('ce-m-tfiles',   td.files);
    setText('ce-m-tusers',   td.users);
    setText('ce-m-tsavings', fmtPKR(td.savings));
    setText('ce-m-tlive',    td.live);
    setText('ce-m-afiles',   at.files);
    setText('ce-m-ausers',   at.users);
    setText('ce-m-asavings', fmtPKR(at.savings));
    setText('ce-m-aai',      at.aiOps);
    setText('ce-m-today',    fmtPKR(getSavedToday()));
    setText('ce-m-total',    fmtPKR(getSavedLifetime()));
    setText('ce-m-credits',  getCredits());
  }

  // ── Homepage community section live updates ───────────────────────────────
  function updateHomepageSection() {
    if (!_stats) return;
    var td = _stats.today, at = _stats.allTime;

    function setCount(id, val, fmt) {
      var el = document.getElementById(id);
      if (!el) return;
      countUp(el, val, 900, fmt);
    }

    setCount('ce-today-files',   td.files,    String);
    setCount('ce-today-users',   td.users,    String);
    setCount('ce-today-savings', td.savings,  fmtPKR);
    setCount('ce-today-live',    td.live,     String);
    setCount('ce-all-files',     at.files,    String);
    setCount('ce-all-users',     at.users,    String);
    setCount('ce-all-savings',   at.savings,  fmtPKR);
    setCount('ce-all-ai',        at.aiOps,    String);
  }

  // ── Activity ticker ───────────────────────────────────────────────────────
  var _tickerTimer = null;
  var _tickerActive = null;

  function startTicker() {
    var stage = document.getElementById('ce-ticker-stage');
    if (!stage || _tickerTimer) return;

    function show(idx) {
      var msgs = _tickerMsgs.length ? _tickerMsgs : FALLBACK_MSGS;
      if (!msgs.length) return;
      idx = idx % msgs.length;

      // Fade out existing
      if (_tickerActive) {
        _tickerActive.classList.add('ce-exiting');
        var old = _tickerActive;
        setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 450);
      }

      var msg  = msgs[idx];
      var item = document.createElement('div');
      item.className = 'ce-ticker-item';
      item.innerHTML = [
        '<span class="ce-ticker-item-icon">' + msg.icon + '</span>',
        '<span>' + msg.text + '</span>',
        '<span class="ce-ticker-item-amt">' + fmtPKR(msg.savings) + '</span>',
      ].join('');
      stage.appendChild(item);
      _tickerActive = item;

      requestAnimationFrame(function () {
        requestAnimationFrame(function () { item.classList.add('ce-active'); });
      });
    }

    show(_tickerIdx);
    _tickerTimer = setInterval(function () {
      if (_tabHidden) return;
      _tickerIdx = (_tickerIdx + 1) % Math.max(1, (_tickerMsgs.length || FALLBACK_MSGS.length));
      show(_tickerIdx);
    }, 4000);
  }

  // ── Polling loop ──────────────────────────────────────────────────────────
  var _pollTimer = null;

  function startPolling() {
    if (_polling) return;
    _polling = true;

    // Immediate fetch
    fetchStats().then(fetchActivity).then(startTicker);

    _pollTimer = setInterval(function () {
      if (_tabHidden) return;
      fetchStats();
    }, 10000);

    // Refresh activity every 30s
    setInterval(function () {
      if (_tabHidden) return;
      fetchActivity();
    }, 30000);
  }

  document.addEventListener('visibilitychange', function () {
    _tabHidden = document.hidden;
    if (!_tabHidden) fetchStats(); // refetch when tab becomes visible
  });

  // ── UID resolution ─────────────────────────────────────────────────────────
  function resolveUid() {
    _uid = _s(function () {
      return G.RuntimeIdentity ? G.RuntimeIdentity.getUser().id : null;
    }, null) || _s(function () {
      return localStorage.getItem('ilpdf_uid');
    }, null);
  }

  // ── Listen for savings:added event to refresh widgets ────────────────────
  document.addEventListener('savings:added', function () {
    setTimeout(function () {
      updateMobileWidget();
      updateDesktopWidget();
      if (_modalOpen && _modalEl) updateModalStats();
    }, 100);
  });

  // ── Listen for credits:consumed to update credit display ────────────────
  document.addEventListener('credits:consumed', function () {
    setTimeout(function () { updateMobileWidget(); updateDesktopWidget(); }, 50);
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    resolveUid();
    mountMobileWidget();
    mountDesktopWidget();
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.CommunityEconomy = {
    openDashboard:       openDashboard,
    closeDashboard:      closeDashboard,
    fetchStats:          fetchStats,
    fmtPKR:              fmtPKR,
    getLevel:            getLevel,
    updateHomepageSection: updateHomepageSection,
  };

  console.info(LOG, 'community economy runtime ready');

}(typeof window !== 'undefined' ? window : this));

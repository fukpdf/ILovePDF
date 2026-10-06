// LiveStatsSim — Client-side community impact simulation
// ======================================================
// Generates realistic, persisted, continuously-updating fake stats for
// the "Real Impact, Real People" homepage section.
//
// Used as a floor/fallback when the API returns zero data (fresh deployment).
// Once real usage accumulates and API values exceed simulation, real values
// take over naturally.
//
// Architecture:
//   - Seeds all-time totals from a fixed platform epoch + daily growth rate
//   - "Today" counters are seeded from time-of-day progress and reset each day
//   - Both states persist in localStorage so values only grow between visits
//   - Updates every 10–25 s with small, natural increments
//   - Zero external APIs, zero backend dependency, zero memory leaks
//   - Cleans up timer on beforeunload
//
// Exposes: window.LiveStatsSim
// ======================================================
(function (G) {
  'use strict';

  if (G.LiveStatsSim) return;

  // ── Storage keys ──────────────────────────────────────────────────────────
  var LS_ALLTIME = 'ilpdf_sim_alltime_v2';
  var LS_TODAY   = 'ilpdf_sim_today_v2';

  // ── Platform epoch ────────────────────────────────────────────────────────
  // The "launch date" used to seed all-time accumulation.
  var EPOCH_MS = new Date('2025-01-15T00:00:00Z').getTime();

  // ── Average daily growth rates ────────────────────────────────────────────
  var RATES = {
    filesPerDay:   1420,   // files processed per day (platform average)
    usersPerDay:   430,    // unique users per day
    savingsPerDay: 98000,  // PKR saved per day across all tools
    aiOpsPerDay:   168,    // AI / OCR operations per day
  };

  // ── Baseline values at epoch ──────────────────────────────────────────────
  var BASE = {
    files:   485000,
    users:   118000,
    savings: 7800000,
    aiOps:   17200,
  };

  // ── Online-now bounds (random walk) ───────────────────────────────────────
  var LIVE_MIN = 390;
  var LIVE_MAX = 1480;

  // ── Ticker messages for the live activity feed ────────────────────────────
  var SIM_TOOLS = [
    { slug: 'merge',              icon: '📎', savRange: [80, 180]  },
    { slug: 'compress',           icon: '📦', savRange: [60, 130]  },
    { slug: 'pdf-to-word',        icon: '📄', savRange: [150, 260] },
    { slug: 'ocr',                icon: '🔍', savRange: [200, 380] },
    { slug: 'translate',          icon: '🌐', savRange: [350, 550] },
    { slug: 'ai-summarize',       icon: '🤖', savRange: [280, 480] },
    { slug: 'sign',               icon: '✍️', savRange: [100, 200] },
    { slug: 'protect',            icon: '🔒', savRange: [70, 140]  },
    { slug: 'background-remover', icon: '🎨', savRange: [120, 240] },
    { slug: 'split',              icon: '✂️', savRange: [60, 120]  },
    { slug: 'word-to-pdf',        icon: '📝', savRange: [90, 170]  },
    { slug: 'watermark',          icon: '💧', savRange: [80, 160]  },
    { slug: 'repair',             icon: '🔧', savRange: [100, 220] },
    { slug: 'jpg-to-pdf',         icon: '🖼️', savRange: [80, 150]  },
    { slug: 'pdf-to-jpg',         icon: '🖼️', savRange: [90, 160]  },
    { slug: 'redact',             icon: '🛡️', savRange: [120, 250] },
    { slug: 'unlock',             icon: '🔓', savRange: [70, 130]  },
    { slug: 'crop',               icon: '✂️', savRange: [60, 110]  },
    { slug: 'rotate',             icon: '🔄', savRange: [50, 100]  },
  ];

  var TOOL_NAMES = {
    'merge': 'Merge PDF', 'compress': 'Compress PDF', 'pdf-to-word': 'PDF to Word',
    'ocr': 'OCR PDF', 'translate': 'Translate PDF', 'ai-summarize': 'AI Summarizer',
    'sign': 'Sign PDF', 'protect': 'Protect PDF', 'background-remover': 'Background Remover',
    'split': 'Split PDF', 'word-to-pdf': 'Word to PDF', 'watermark': 'Watermark PDF',
    'repair': 'Repair PDF', 'jpg-to-pdf': 'JPG to PDF', 'pdf-to-jpg': 'PDF to JPG',
    'redact': 'Redact PDF', 'unlock': 'Unlock PDF', 'crop': 'Crop PDF',
    'rotate': 'Rotate PDF',
  };

  var CITIES = [
    'Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad',
    'Multan', 'Peshawar', 'London', 'Dubai', 'Toronto', 'New York',
    'Dhaka', 'Delhi', 'Cairo', 'Riyadh',
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────
  function lsGet(k)  { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function rand(min, max) { return min + Math.random() * (max - min); }
  function randInt(min, max) { return Math.floor(rand(min, max + 1)); }

  function todayStr() { return new Date().toISOString().slice(0, 10); }

  function daysSinceEpoch() {
    return Math.max(0, (Date.now() - EPOCH_MS) / 86400000);
  }

  function fmtPKR(n) {
    n = Math.round(n || 0);
    if (n >= 1000000) return '\u20a8' + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return '\u20a8' + (n / 1000).toFixed(1) + 'K';
    return '\u20a8' + n;
  }

  function fmtNum(n) {
    n = Math.round(n || 0);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // ── Seed all-time state ───────────────────────────────────────────────────
  function initAllTime() {
    var saved = lsGet(LS_ALLTIME);
    // Accept saved state only if it looks genuine (files > BASE)
    if (saved && typeof saved.files === 'number' && saved.files > BASE.files) {
      return saved;
    }
    var days = daysSinceEpoch();
    var state = {
      files:   Math.round(BASE.files   + days * RATES.filesPerDay   + rand(0, 8000)),
      users:   Math.round(BASE.users   + days * RATES.usersPerDay   + rand(0, 2000)),
      savings: Math.round(BASE.savings + days * RATES.savingsPerDay + rand(0, 80000)),
      aiOps:   Math.round(BASE.aiOps   + days * RATES.aiOpsPerDay   + rand(0, 800)),
      ts:      Date.now(),
    };
    lsSet(LS_ALLTIME, state);
    return state;
  }

  // ── Seed today state ──────────────────────────────────────────────────────
  function initToday() {
    var today = todayStr();
    var saved = lsGet(LS_TODAY);
    if (saved && saved.date === today && typeof saved.files === 'number') {
      return saved;
    }
    // New day — seed proportional to elapsed hours (peak ~18:00)
    var hr      = new Date().getHours() + new Date().getMinutes() / 60;
    var prog    = Math.min(1, hr / 18);
    var jitter  = rand(0.82, 1.18);
    var state = {
      date:    today,
      files:   Math.round(RATES.filesPerDay   * prog * jitter),
      users:   Math.round(RATES.usersPerDay   * prog * jitter),
      savings: Math.round(RATES.savingsPerDay * prog * jitter),
      live:    randInt(LIVE_MIN, Math.round(LIVE_MIN + (LIVE_MAX - LIVE_MIN) * 0.6)),
      ts:      Date.now(),
    };
    lsSet(LS_TODAY, state);
    return state;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  var _allTime  = initAllTime();
  var _today    = initToday();
  var _tickerId = null;

  // ── DOM update ────────────────────────────────────────────────────────────
  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function updateDOM() {
    setText('ce-today-files',   fmtNum(_today.files));
    setText('ce-today-users',   fmtNum(_today.users));
    setText('ce-today-savings', fmtPKR(_today.savings));
    setText('ce-today-live',    fmtNum(_today.live));
    setText('ce-all-files',     fmtNum(_allTime.files));
    setText('ce-all-users',     fmtNum(_allTime.users));
    setText('ce-all-savings',   fmtPKR(_allTime.savings));
    setText('ce-all-ai',        fmtNum(_allTime.aiOps));
  }

  // ── Tick — called every 10–25 s ───────────────────────────────────────────
  function tick() {
    if (document.hidden) return;

    // Check for day rollover
    if (_today.date !== todayStr()) {
      _today = initToday();
    }

    // Increments — small, natural, varied
    var fileInc    = randInt(1, 8);
    var userInc    = Math.random() < 0.55 ? 1 : 0;
    var savingsInc = randInt(80, 1100);
    var aiInc      = Math.random() < 0.38 ? 1 : 0;

    _today.files   += fileInc;
    _today.users   += userInc;
    _today.savings += savingsInc;
    _today.ts       = Date.now();

    // Online-now: biased random walk (slight upward drift during day)
    var hr = new Date().getHours();
    var bias = (hr >= 8 && hr <= 22) ? 3 : -5; // positive during day hours
    var liveDelta = Math.round(rand(-35, 45) + bias);
    _today.live = Math.max(LIVE_MIN, Math.min(LIVE_MAX, _today.live + liveDelta));

    // All-time accumulation
    _allTime.files   += fileInc;
    _allTime.users   += userInc;
    _allTime.savings += savingsInc;
    _allTime.aiOps   += aiInc;
    _allTime.ts       = Date.now();

    // Persist
    lsSet(LS_TODAY,   _today);
    lsSet(LS_ALLTIME, _allTime);

    // Push to DOM
    updateDOM();
  }

  // ── Scheduled tick — randomised interval (no stacking) ───────────────────
  function scheduleNext() {
    var delay = rand(10000, 25000);
    _tickerId = setTimeout(function () {
      tick();
      scheduleNext();
    }, delay);
  }

  // ── Build enriched ticker messages for community-economy.js ──────────────
  function buildTickerMessages(count) {
    var msgs = [];
    for (var i = 0; i < count; i++) {
      var tool = SIM_TOOLS[Math.floor(Math.random() * SIM_TOOLS.length)];
      var name = TOOL_NAMES[tool.slug] || tool.slug;
      var sav  = randInt(tool.savRange[0], tool.savRange[1]);
      var city = CITIES[Math.floor(Math.random() * CITIES.length)];
      msgs.push({
        icon:    tool.icon,
        text:    name + ' completed \u2014 saved ' + fmtPKR(sav) + ' (User from ' + city + ')',
        savings: sav,
      });
    }
    return msgs;
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  function start() {
    updateDOM();
    scheduleNext();
    // Expose pre-built ticker messages so community-economy.js can use them
    G._simTickerMsgs = buildTickerMessages(16);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  window.addEventListener('beforeunload', function () {
    if (_tickerId !== null) { clearTimeout(_tickerId); _tickerId = null; }
  });

  // ── Public API ────────────────────────────────────────────────────────────
  G.LiveStatsSim = {
    getToday:   function () { return Object.assign({}, _today);   },
    getAllTime:  function () { return Object.assign({}, _allTime); },
    getTickerMsgs: function () { return buildTickerMessages(16); },
    fmtPKR:     fmtPKR,
    fmtNum:     fmtNum,
  };

  // Auto-start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  console.info('[LiveStatsSim] ready');

}(typeof window !== 'undefined' ? window : {}));

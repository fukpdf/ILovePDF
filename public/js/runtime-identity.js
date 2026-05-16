// RuntimeIdentity v1.0 — Phase 23
// =====================================================================
// Anonymous persistent identity system.
// NO Firebase, NO Clerk, NO Auth0.
// Pure browser-first: localStorage + cookie fallback + signed server cookie.
//
// Exposes: window.RuntimeIdentity
//   .getUser()        → { id, created, visits }
//   .getFingerprint() → { hash, components }
//   .getTrust()       → { score, flags }
//   .refresh()        → re-fingerprint + sync server cookie
//   .reset()          → clear identity (new anonymous user)
//   .export()         → full identity snapshot
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeIdentity) return;

  var LOG = '[RuntimeIdentity]';
  var LS_KEY = 'ilpdf_uid';
  var LS_META = 'ilpdf_uid_meta';
  var LS_FP = 'ilpdf_fp';
  var LS_TRUST = 'ilpdf_trust';
  var COOKIE_KEY = 'ilpdf_sid';
  var SERVER_ENDPOINT = '/api/identity/register';

  // ── UUID Generator ───────────────────────────────────────────────────
  function generateUUID() {
    var s = 'usr_';
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    if (global.crypto && global.crypto.randomUUID) {
      s += global.crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    } else {
      for (var i = 0; i < 20; i++) {
        s += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    return s;
  }

  // ── Safe localStorage access ─────────────────────────────────────────
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); return true; } catch (_) { return false; }
  }
  function lsDel(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  // ── Cookie helpers ───────────────────────────────────────────────────
  function getCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m[2]) : null;
  }
  function setCookie(name, value, days) {
    var exp = new Date(Date.now() + days * 864e5).toUTCString();
    var secure = location.protocol === 'https:' ? '; Secure; SameSite=Strict' : '';
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + exp + '; path=/' + secure;
  }

  // ── Browser Fingerprint ──────────────────────────────────────────────
  function collectComponents() {
    var c = {};
    try {
      c.screen = (screen.width || 0) + 'x' + (screen.height || 0) + 'x' + (screen.colorDepth || 0);
      c.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      c.lang = navigator.language || '';
      c.langs = (navigator.languages || []).join(',');
      c.mem = navigator.deviceMemory || 0;
      c.cores = navigator.hardwareConcurrency || 0;
      c.touch = navigator.maxTouchPoints || 0;
      c.platform = navigator.platform || '';
      c.vendor = navigator.vendor || '';
      c.pixelRatio = global.devicePixelRatio || 1;
      // WebGL vendor
      try {
        var canvas = document.createElement('canvas');
        var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
          var dbg = gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) {
            c.gpuVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '';
            c.gpuRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
          }
        }
      } catch (_) {}
      // Canvas fingerprint (non-invasive)
      try {
        var cv = document.createElement('canvas');
        cv.width = 200; cv.height = 50;
        var ctx = cv.getContext('2d');
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069'; ctx.font = '14px Arial';
        ctx.fillText('ILovePDF.cyou \uD83D\uDCC4', 2, 15);
        ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.font = '11px Arial';
        ctx.fillText('canvas fp', 4, 35);
        c.canvas = cv.toDataURL().slice(-50);
      } catch (_) {}
    } catch (_) {}
    return c;
  }

  function hashComponents(c) {
    var str = JSON.stringify(c);
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return 'fp_' + (h >>> 0).toString(16);
  }

  function getFingerprint() {
    var cached = lsGet(LS_FP);
    if (cached) {
      try { return JSON.parse(cached); } catch (_) {}
    }
    var components = collectComponents();
    var hash = hashComponents(components);
    var fp = { hash: hash, components: components, created: Date.now() };
    lsSet(LS_FP, JSON.stringify(fp));
    return fp;
  }

  // ── Trust Scoring ────────────────────────────────────────────────────
  function computeTrust(meta, fp) {
    var score = 100;
    var flags = [];
    var now = Date.now();
    var age = now - (meta.created || now);
    var DAY = 86400000;

    // Reduce score for very new identities
    if (age < DAY) { score -= 10; }

    // Fingerprint instability (changed > 3 times)
    if ((meta.fpChanges || 0) > 3) {
      score -= 25;
      flags.push('fp_unstable');
    }

    // Suspicious quota reset patterns
    if ((meta.resetCount || 0) > 2) {
      score -= 30;
      flags.push('quota_abuse');
    }

    // Incognito detection heuristic (localStorage available but short lifetime)
    if (meta.incognitoHint) {
      score -= 15;
      flags.push('incognito_hint');
    }

    // Reward abuse
    if ((meta.rewardCount || 0) > 20) {
      score -= 20;
      flags.push('reward_farming');
    }

    score = Math.max(0, Math.min(100, score));
    return { score: score, flags: flags };
  }

  // ── Identity Persistence ─────────────────────────────────────────────
  function loadMeta() {
    try { return JSON.parse(lsGet(LS_META) || '{}'); } catch (_) { return {}; }
  }
  function saveMeta(meta) {
    lsSet(LS_META, JSON.stringify(meta));
  }

  function getOrCreateUser() {
    var uid = lsGet(LS_KEY) || getCookie(COOKIE_KEY);
    var meta = loadMeta();
    var isNew = !uid;

    if (!uid) {
      uid = generateUUID();
      meta.created = Date.now();
      meta.visits = 0;
      meta.fpChanges = 0;
      meta.resetCount = 0;
      meta.rewardCount = 0;
    }

    meta.visits = (meta.visits || 0) + 1;
    meta.lastSeen = Date.now();

    // Detect fingerprint change
    var fp = getFingerprint();
    var lastFpHash = meta.lastFpHash;
    if (lastFpHash && lastFpHash !== fp.hash) {
      meta.fpChanges = (meta.fpChanges || 0) + 1;
    }
    meta.lastFpHash = fp.hash;

    // Detect incognito hint (sessionStorage accessible but localStorage just came back empty)
    if (isNew) {
      try {
        var testKey = '_ilpdf_test_' + Date.now();
        sessionStorage.setItem(testKey, '1');
        if (sessionStorage.getItem(testKey) === '1' && !lsGet(LS_KEY)) {
          meta.incognitoHint = true;
        }
        sessionStorage.removeItem(testKey);
      } catch (_) {}
    }

    lsSet(LS_KEY, uid);
    setCookie(COOKIE_KEY, uid, 365);
    saveMeta(meta);

    return { id: uid, created: meta.created, visits: meta.visits, isNew: isNew };
  }

  // ── Server Cookie Registration ───────────────────────────────────────
  var _serverSyncPending = false;
  var _serverSynced = false;

  function syncWithServer(user, fp) {
    if (_serverSynced || _serverSyncPending) return;
    _serverSyncPending = true;

    fetch(SERVER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        uid: user.id,
        fp: fp.hash,
        isNew: user.isNew,
        visits: user.visits
      })
    })
    .then(function (r) {
      if (r.ok) {
        _serverSynced = true;
        console.info(LOG, 'server cookie issued');
      }
    })
    .catch(function (err) {
      console.warn(LOG, 'server sync failed (offline?):', err.message);
    })
    .finally(function () {
      _serverSyncPending = false;
    });
  }

  // ── Initialize ───────────────────────────────────────────────────────
  var _user = null;
  var _fp = null;
  var _trust = null;

  function init() {
    _user = getOrCreateUser();
    _fp = getFingerprint();
    _trust = computeTrust(loadMeta(), _fp);
    lsSet(LS_TRUST, JSON.stringify(_trust));

    // Sync with server after short delay (non-blocking)
    setTimeout(function () { syncWithServer(_user, _fp); }, 2000);

    console.info(LOG, 'identity ready —', _user.id, '| trust:', _trust.score);
    if (_trust.flags.length) console.warn(LOG, 'trust flags:', _trust.flags);
  }

  // ── Public API ───────────────────────────────────────────────────────
  global.RuntimeIdentity = {
    getUser: function () {
      return Object.assign({}, _user);
    },
    getFingerprint: function () {
      return { hash: _fp.hash, components: Object.assign({}, _fp.components) };
    },
    getTrust: function () {
      return Object.assign({}, _trust);
    },
    refresh: function () {
      lsDel(LS_FP);
      _fp = getFingerprint();
      _trust = computeTrust(loadMeta(), _fp);
      lsSet(LS_TRUST, JSON.stringify(_trust));
      _serverSynced = false;
      syncWithServer(_user, _fp);
      return { user: _user, fp: _fp, trust: _trust };
    },
    reset: function () {
      var meta = loadMeta();
      meta.resetCount = (meta.resetCount || 0) + 1;
      saveMeta(meta);
      lsDel(LS_KEY);
      lsDel(LS_FP);
      lsDel(LS_TRUST);
      // keep meta for abuse tracking
      _serverSynced = false;
      _user = getOrCreateUser();
      _fp = getFingerprint();
      _trust = computeTrust(loadMeta(), _fp);
      console.info(LOG, 'identity reset — new id:', _user.id);
      return _user;
    },
    export: function () {
      return {
        user: Object.assign({}, _user),
        fingerprint: { hash: _fp.hash },
        trust: Object.assign({}, _trust),
        meta: loadMeta()
      };
    },
    _trackReward: function () {
      var meta = loadMeta();
      meta.rewardCount = (meta.rewardCount || 0) + 1;
      saveMeta(meta);
      _trust = computeTrust(meta, _fp);
    }
  };

  // Auto-init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Integrate with RuntimeKernel if present
  if (global.RT && global.RT.register) {
    try { global.RT.register('identity', global.RuntimeIdentity); } catch (_) {}
  }

}(typeof window !== 'undefined' ? window : this));

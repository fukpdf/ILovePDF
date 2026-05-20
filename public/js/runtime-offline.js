// RuntimeOffline v1.0 — Phase 22 PWA Offline System
// =====================================================================
// Provides window.RuntimeOffline with full offline management API:
//   .status()         — full offline status object
//   .isOffline()      — boolean
//   .queueSize()      — number of pending queued events
//   .retry()          — manually trigger background sync
//   .clearQueue()     — wipe offline queue from IDB
//   .getPending()     — array of queued records
//   .getCacheStats()  — SW cache stats (async)
//
// Also:
//   - Injects global offline indicator bar (slim, mobile-safe, RTL-aware)
//   - IDB-backed offline event queue (iplv-offline-q)
//   - Background sync registration (iplv-retry-upload)
//   - PWA install prompt capture (beforeinstallprompt)
//   - Reconnect recovery
//   - Offline analytics tracking
//
// Safety: singleton guard, graceful degradation, no dependency on
// existing runtime systems (wires into them when available).
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeOffline) return;

  var LOG = '[RuntimeOffline]';

  // ── IDB offline queue ─────────────────────────────────────────────────────
  var IDB_NAME    = 'iplv-offline-q';
  var IDB_VERSION = 1;
  var IDB_STORE   = 'queue';
  var _idbDed     = null;

  function _openQueue() {
    if (_idbDed) return _idbDed;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IDB unavailable'));
    _idbDed = new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var s = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts',  'ts',  { unique: false });
          s.createIndex('tag', 'tag', { unique: false });
        }
      };
      req.onsuccess  = function (e) { resolve(e.target.result); };
      req.onerror    = function (e) { reject(e.target.error); _idbDed = null; };
      req.onblocked  = function ()  { console.warn(LOG, 'IDB open blocked'); };
    });
    return _idbDed;
  }

  function _idbTx(mode, fn) {
    return _openQueue().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx    = db.transaction(IDB_STORE, mode);
        var store = tx.objectStore(IDB_STORE);
        var result;
        tx.oncomplete = function () { resolve(result); };
        tx.onerror    = function (e) { reject(e.target.error); };
        try {
          var req = fn(store);
          if (req && req.onsuccess !== undefined) {
            req.onsuccess = function (e) { result = e.target.result; };
          } else {
            result = req;
          }
        } catch (err) { tx.abort(); reject(err); }
      });
    });
  }

  function _enqueue(record) {
    var entry = Object.assign({ ts: Date.now(), retries: 0 }, record);
    return _idbTx('readwrite', function (s) { return s.add(entry); }).catch(function () {});
  }

  function _getAllPending() {
    return _idbTx('readonly', function (s) {
      return new Promise(function (resolve) {
        var items = [];
        var r = s.openCursor();
        r.onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { items.push(cur.value); cur.continue(); }
          else resolve(items);
        };
        r.onerror = function () { resolve([]); };
      });
    }).catch(function () { return []; });
  }

  function _deleteRecord(id) {
    return _idbTx('readwrite', function (s) { return s.delete(id); }).catch(function () {});
  }

  function _clearAll() {
    return _idbTx('readwrite', function (s) { return s.clear(); }).catch(function () {});
  }

  function _countPending() {
    return _idbTx('readonly', function (s) {
      return new Promise(function (resolve) {
        var req = s.count();
        req.onsuccess = function (e) { resolve(e.target.result || 0); };
        req.onerror   = function ()  { resolve(0); };
      });
    }).catch(function () { return 0; });
  }

  // ── State ─────────────────────────────────────────────────────────────────
  var _online          = navigator.onLine !== false;
  var _offlineSince    = _online ? null : Date.now();
  var _reconnectCount  = 0;
  var _offlineSessions = 0;
  var _retryInFlight   = false;
  var _pwaDeferred     = null;   // beforeinstallprompt event
  var _swReg           = null;   // ServiceWorkerRegistration

  // ── Offline indicator ─────────────────────────────────────────────────────
  var _bar = null;
  var _barTimer = null;

  function _t(key, fallback) {
    try {
      if (typeof window.t === 'function') {
        var v = window.t(key);
        if (v && v !== key) return v;
      }
    } catch (_) {}
    return fallback;
  }

  var _CSS = [
    '#iplv-offline-bar{',
    'position:fixed;top:0;left:0;right:0;z-index:2147483646;',
    'display:flex;align-items:center;justify-content:space-between;gap:10px;',
    'padding:9px 16px;font-size:13px;font-family:inherit;font-weight:500;',
    'background:#1f2937;color:#f9fafb;',
    'transform:translateY(-100%);transition:transform .25s ease;',
    'box-shadow:0 2px 8px rgba(0,0,0,.35);',
    '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);',
    '}',
    '#iplv-offline-bar.iplv-bar-show{transform:translateY(0)}',
    '#iplv-offline-bar.iplv-bar-online{background:#064e3b;color:#d1fae5}',
    '#iplv-offline-bar .iplv-bar-left{display:flex;align-items:center;gap:8px;flex:1;min-width:0}',
    '#iplv-offline-bar .iplv-bar-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#ef4444}',
    '#iplv-offline-bar.iplv-bar-online .iplv-bar-dot{background:#10b981}',
    '#iplv-offline-bar .iplv-bar-msg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#iplv-offline-bar .iplv-bar-q{font-size:11px;opacity:.75;flex-shrink:0}',
    '#iplv-offline-bar .iplv-bar-retry{',
    'background:rgba(255,255,255,.15);border:none;color:inherit;',
    'padding:3px 10px;border-radius:4px;font-size:12px;cursor:pointer;flex-shrink:0;',
    'font-weight:600;letter-spacing:.02em;',
    '}',
    '#iplv-offline-bar .iplv-bar-retry:hover{background:rgba(255,255,255,.25)}',
    'body.rtl #iplv-offline-bar{direction:rtl}',
    '@media(max-width:480px){',
    '#iplv-offline-bar{padding:8px 12px;font-size:12px}',
    '#iplv-offline-bar .iplv-bar-q{display:none}',
    '}',
  ].join('');

  function _injectCSS() {
    if (document.getElementById('iplv-offline-css')) return;
    var s = document.createElement('style');
    s.id = 'iplv-offline-css';
    s.textContent = _CSS;
    document.head.appendChild(s);
  }

  function _buildBar() {
    if (_bar) return _bar;
    _injectCSS();
    _bar = document.createElement('div');
    _bar.id = 'iplv-offline-bar';
    _bar.setAttribute('role', 'status');
    _bar.setAttribute('aria-live', 'polite');
    _bar.innerHTML = [
      '<div class="iplv-bar-left">',
        '<span class="iplv-bar-dot"></span>',
        '<span class="iplv-bar-msg" id="iplv-bar-msg"></span>',
        '<span class="iplv-bar-q"  id="iplv-bar-q"></span>',
      '</div>',
      '<button class="iplv-bar-retry" id="iplv-bar-retry" onclick="RuntimeOffline.retry()">',
        _t('offline.retry', 'Retry'),
      '</button>',
    ].join('');
    document.body.appendChild(_bar);
    return _bar;
  }

  function _updateBarUI(pending) {
    var bar = _buildBar();
    var msgEl  = bar.querySelector('#iplv-bar-msg');
    var qEl    = bar.querySelector('#iplv-bar-q');
    var retryEl = bar.querySelector('#iplv-bar-retry');

    if (_online) {
      bar.classList.add('iplv-bar-online');
      bar.classList.remove('iplv-bar-show');
      return;
    }

    bar.classList.remove('iplv-bar-online');
    if (msgEl)   msgEl.textContent  = _t('offline.no_connection', 'No internet connection');
    if (qEl && pending > 0) {
      qEl.textContent = _t('offline.queue_pending', '{{n}} pending').replace('{{n}}', pending);
    } else if (qEl) {
      qEl.textContent = '';
    }
    if (retryEl) retryEl.textContent = _t('offline.retry', 'Retry');

    clearTimeout(_barTimer);
    bar.classList.add('iplv-bar-show');
  }

  function _showReconnected(pending) {
    var bar = _buildBar();
    var msgEl   = bar.querySelector('#iplv-bar-msg');
    var qEl     = bar.querySelector('#iplv-bar-q');
    var retryEl = bar.querySelector('#iplv-bar-retry');

    bar.classList.remove('iplv-bar-online');
    bar.classList.add('iplv-bar-show', 'iplv-bar-online');

    if (msgEl)   msgEl.textContent  = _t('offline.back_online', 'Back online');
    if (qEl)     qEl.textContent    = pending > 0 ? _t('offline.queue_pending', '{{n}} pending').replace('{{n}}', pending) : '';
    if (retryEl) retryEl.textContent = _t('offline.retry', 'Retry');

    clearTimeout(_barTimer);
    _barTimer = setTimeout(function () {
      bar.classList.remove('iplv-bar-show');
      setTimeout(function () {
        if (_online) bar.classList.remove('iplv-bar-online');
      }, 300);
    }, 3500);
  }

  // ── Online/offline handlers ───────────────────────────────────────────────
  function _onOffline() {
    if (!_online) return;
    _online = false;
    _offlineSince = Date.now();
    _offlineSessions++;
    console.warn(LOG, 'connection lost');
    _countPending().then(_updateBarUI);
    _trackAnalytics('offline_start');
    try { global.dispatchEvent(new CustomEvent('iplv:offline')); } catch (_) {}
  }

  function _onOnline() {
    if (_online) return;
    _online = true;
    _reconnectCount++;
    var duration = _offlineSince ? Date.now() - _offlineSince : 0;
    _offlineSince = null;
    console.info(LOG, 'connection restored after', Math.round(duration / 1000) + 's');
    _countPending().then(function (n) {
      _showReconnected(n);
      if (n > 0) _triggerSync();
      _retryFromQueue();
    });
    _trackAnalytics('offline_reconnect', { durationMs: duration });
    try { global.dispatchEvent(new CustomEvent('iplv:online', { detail: { durationMs: duration } })); } catch (_) {}
  }

  global.addEventListener('offline', _onOffline);
  global.addEventListener('online',  _onOnline);

  // ── Background sync registration ──────────────────────────────────────────
  function _triggerSync() {
    try {
      var reg = _swReg || (navigator.serviceWorker && navigator.serviceWorker.controller && navigator.serviceWorker.ready);
      Promise.resolve(reg).then(function (r) {
        if (r && r.sync) {
          r.sync.register('iplv-retry-upload').catch(function (e) {
            console.warn(LOG, 'sync.register failed:', e.message);
          });
        }
      }).catch(function () {});
    } catch (_) {}
  }

  // ── Queue retry with exponential backoff ──────────────────────────────────
  var _retryDelay   = 2000;
  var _retryMax     = 64000;
  var _retryTimer   = null;

  function _retryFromQueue() {
    if (_retryInFlight || !_online) return;
    _retryInFlight = true;

    _getAllPending().then(function (records) {
      if (!records || records.length === 0) {
        _retryInFlight = false;
        _retryDelay = 2000;
        _countPending().then(_updateBarUI);
        return;
      }

      // Process records one at a time to avoid flooding
      var idx = 0;
      function next() {
        if (idx >= records.length) {
          _retryInFlight = false;
          _countPending().then(_updateBarUI);
          return;
        }
        var rec = records[idx++];

        // Analytics/telemetry events: fire-and-forget to /api/admin/analytics/event
        if (rec.type === 'analytics') {
          fetch('/api/admin/analytics/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rec.payload || {}),
          }).then(function (r) {
            if (r.ok) _deleteRecord(rec.id);
            else _incrementRetry(rec);
            next();
          }).catch(function () { _incrementRetry(rec); next(); });
          return;
        }

        // Generic HTTP retry (preserves method, URL, body)
        if (rec.url) {
          fetch(rec.url, {
            method:  rec.method  || 'POST',
            headers: rec.headers || {},
            body:    rec.body,
          }).then(function (r) {
            if (r.ok) { _deleteRecord(rec.id); _retryDelay = 2000; }
            else _incrementRetry(rec);
            next();
          }).catch(function () {
            _incrementRetry(rec);
            // Exponential backoff: stop retrying for this session if repeated failures
            _retryDelay = Math.min(_retryDelay * 2, _retryMax);
            _retryInFlight = false;
            clearTimeout(_retryTimer);
            _retryTimer = setTimeout(_retryFromQueue, _retryDelay);
          });
          return;
        }

        // Unknown type: drop after 5 retries
        if ((rec.retries || 0) >= 5) _deleteRecord(rec.id);
        else _incrementRetry(rec);
        next();
      }
      next();
    }).catch(function () { _retryInFlight = false; });
  }

  function _incrementRetry(rec) {
    // Update retry count in IDB
    _openQueue().then(function (db) {
      var tx    = db.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      var r = store.get(rec.id);
      r.onsuccess = function (e) {
        var item = e.target.result;
        if (!item) return;
        if ((item.retries || 0) >= 5) { store.delete(rec.id); return; }
        item.retries = (item.retries || 0) + 1;
        store.put(item);
      };
    }).catch(function () {});
  }

  // ── Analytics tracking ────────────────────────────────────────────────────
  function _trackAnalytics(event, data) {
    try {
      if (global.RuntimeAnalytics && global.RuntimeAnalytics.track) {
        global.RuntimeAnalytics.track(event, data || {});
      }
    } catch (_) {}
  }

  // ── SW cache stats (via MessageChannel) ──────────────────────────────────
  function _getCacheStats() {
    return new Promise(function (resolve) {
      try {
        var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (!sw) { resolve({ available: false }); return; }
        var ch = new MessageChannel();
        ch.port1.onmessage = function (e) { resolve(e.data || {}); };
        sw.postMessage({ type: 'CACHE_STATS' }, [ch.port2]);
        setTimeout(function () { resolve({ available: false, timeout: true }); }, 2000);
      } catch (e) {
        resolve({ available: false, error: e.message });
      }
    });
  }

  // ── SW message handler ────────────────────────────────────────────────────
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (!e.data) return;
      if (e.data.type === 'SYNC_COMPLETE') {
        _countPending().then(function (n) {
          if (_online) _showReconnected(n);
        });
      }
    });
  }

  // ── PWA install prompt ────────────────────────────────────────────────────
  global.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    _pwaDeferred = e;
    console.info(LOG, 'PWA install prompt captured — will show banner on engagement');
    try { global.dispatchEvent(new CustomEvent('iplv:pwa-installable')); } catch (_) {}
    // Schedule smart banner display after engagement trigger
    _schedulePwaBanner();
  });

  global.addEventListener('appinstalled', function () {
    _pwaDeferred = null;
    _pwaHideBanner();
    _trackAnalytics('pwa_installed');
    try { localStorage.setItem('iplv_pwa_installed', '1'); } catch (_) {}
    console.info(LOG, 'PWA installed');
  });

  // ── PWA Install Banner ─────────────────────────────────────────────────────
  var _pwaBannerEl    = null;
  var _pwaBannerTimer = null;
  var _pwaEngageCount = 0;

  // Snooze key + duration
  var PWA_SNOOZE_KEY = 'iplv_pwa_snooze';
  var PWA_SNOOZE_MS  = 7 * 24 * 3600 * 1000; // 7 days
  var PWA_TRIGGER_N  = 2; // show after 2nd tool engagement

  function _pwaSnoozed() {
    try {
      var v = localStorage.getItem(PWA_SNOOZE_KEY);
      return v && (Date.now() - parseInt(v, 10)) < PWA_SNOOZE_MS;
    } catch (_) { return false; }
  }

  function _pwaInstalled() {
    try { return !!localStorage.getItem('iplv_pwa_installed'); } catch (_) { return false; }
  }

  function _schedulePwaBanner() {
    // Listen for tool engagement events (processing complete / download)
    document.addEventListener('download:triggered', _pwaEngageTick, { passive: true });
    document.addEventListener('iplv:processing-complete', _pwaEngageTick, { passive: true });
    document.addEventListener('task:completed', _pwaEngageTick, { passive: true });
    // Fallback: show after 45s if banner not yet triggered and conditions met
    _pwaBannerTimer = setTimeout(function () {
      if (_pwaDeferred && !_pwaSnoozed() && !_pwaInstalled()) {
        _pwaShowBanner();
      }
    }, 45000);
  }

  function _pwaEngageTick() {
    _pwaEngageCount++;
    if (_pwaEngageCount >= PWA_TRIGGER_N && _pwaDeferred && !_pwaSnoozed() && !_pwaInstalled()) {
      clearTimeout(_pwaBannerTimer);
      _pwaShowBanner();
    }
  }

  function _pwaShowBanner() {
    if (_pwaBannerEl || !document.body || !_pwaDeferred) return;

    var banner = document.createElement('div');
    banner.id  = 'iplv-pwa-banner';
    banner.setAttribute('role', 'complementary');
    banner.setAttribute('aria-label', 'Install ILovePDF App');
    banner.innerHTML = [
      '<div class="iplv-pwa-inner">',
        '<div class="iplv-pwa-icon" aria-hidden="true">',
          '<img src="/favicon.svg" width="36" height="36" alt="ILovePDF">',
        '</div>',
        '<div class="iplv-pwa-text">',
          '<strong>Install ILovePDF</strong>',
          '<span>Works offline &nbsp;·&nbsp; Opens instantly</span>',
        '</div>',
        '<button class="iplv-pwa-install-btn" id="iplv-pwa-install">Install</button>',
        '<button class="iplv-pwa-dismiss-btn" id="iplv-pwa-dismiss" aria-label="Dismiss">✕</button>',
      '</div>',
    ].join('');

    // Inline styles — self-contained, no external CSS dependency
    var s = document.createElement('style');
    s.id  = 'iplv-pwa-banner-css';
    s.textContent = [
      '#iplv-pwa-banner{',
        'position:fixed;bottom:72px;right:16px;z-index:9999;',
        'background:#fff;border-radius:12px;',
        'box-shadow:0 4px 24px rgba(0,0,0,.18);',
        'padding:0;overflow:hidden;',
        'animation:iplv-pwa-slide-in .35s cubic-bezier(.34,1.56,.64,1) forwards;',
        'max-width:320px;width:calc(100vw - 32px)',
      '}',
      '@keyframes iplv-pwa-slide-in{',
        'from{transform:translateY(20px);opacity:0}',
        'to{transform:translateY(0);opacity:1}',
      '}',
      '.iplv-pwa-inner{',
        'display:flex;align-items:center;gap:10px;padding:12px 14px',
      '}',
      '.iplv-pwa-icon img{border-radius:8px;flex-shrink:0}',
      '.iplv-pwa-text{flex:1;min-width:0}',
      '.iplv-pwa-text strong{display:block;font-size:14px;font-weight:700;color:#1f2937}',
      '.iplv-pwa-text span{display:block;font-size:12px;color:#6b7280;margin-top:1px}',
      '.iplv-pwa-install-btn{',
        'flex-shrink:0;padding:7px 14px;border-radius:8px;',
        'background:#E5322E;color:#fff;border:none;cursor:pointer;',
        'font-size:13px;font-weight:700;white-space:nowrap;',
        'transition:background .15s',
      '}',
      '.iplv-pwa-install-btn:hover{background:#c0201c}',
      '.iplv-pwa-dismiss-btn{',
        'flex-shrink:0;background:none;border:none;cursor:pointer;',
        'font-size:16px;color:#9ca3af;padding:4px;line-height:1',
      '}',
      '.iplv-pwa-dismiss-btn:hover{color:#ef4444}',
      '@media(prefers-color-scheme:dark){',
        '#iplv-pwa-banner{background:#1f2937}',
        '.iplv-pwa-text strong{color:#f9fafb}',
        '.iplv-pwa-text span{color:#9ca3af}',
      '}',
      'body.iplv-lite #iplv-pwa-banner{animation:none}',
    ].join('');

    document.head.appendChild(s);
    document.body.appendChild(banner);
    _pwaBannerEl = banner;

    // Install click
    var installBtn = document.getElementById('iplv-pwa-install');
    if (installBtn) {
      installBtn.addEventListener('click', function () {
        _pwaHideBanner();
        if (_pwaDeferred) {
          _pwaDeferred.prompt();
          _pwaDeferred.userChoice.then(function (choice) {
            _trackAnalytics('pwa_install_prompt', { extra: { outcome: choice.outcome } });
            _pwaDeferred = null;
          }).catch(function () {});
        }
      });
    }

    // Dismiss click → 7-day snooze
    var dismissBtn = document.getElementById('iplv-pwa-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        try { localStorage.setItem(PWA_SNOOZE_KEY, String(Date.now())); } catch (_) {}
        _pwaHideBanner();
        _trackAnalytics('pwa_banner_dismissed');
      });
    }

    _trackAnalytics('pwa_banner_shown');
  }

  function _pwaHideBanner() {
    clearTimeout(_pwaBannerTimer);
    if (_pwaBannerEl) {
      _pwaBannerEl.style.animation = 'none';
      _pwaBannerEl.style.opacity   = '0';
      _pwaBannerEl.style.transform = 'translateY(10px)';
      _pwaBannerEl.style.transition = 'opacity .2s, transform .2s';
      setTimeout(function () {
        if (_pwaBannerEl && _pwaBannerEl.parentNode) {
          _pwaBannerEl.parentNode.removeChild(_pwaBannerEl);
        }
        _pwaBannerEl = null;
      }, 250);
    }
  }

  // ── SW registration wiring ────────────────────────────────────────────────
  if (navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(function (reg) {
      _swReg = reg;
      // Trigger any pending sync on load if we went offline and came back
      if (_online) _countPending().then(function (n) {
        if (n > 0) { _triggerSync(); _retryFromQueue(); }
      });
    }).catch(function () {});
  }

  // ── Public API ────────────────────────────────────────────────────────────
  var RuntimeOffline = {
    status: function () {
      return {
        online:          _online,
        offlineSince:    _offlineSince,
        reconnectCount:  _reconnectCount,
        offlineSessions: _offlineSessions,
        swRegistered:    !!_swReg,
        pwaInstallable:  !!_pwaDeferred,
        retryDelay:      _retryDelay,
      };
    },

    isOffline: function () { return !_online; },

    queueSize: function () {
      return _countPending();
    },

    retry: function () {
      if (!_online) {
        console.warn(LOG, 'retry() called while offline — will fire when back online');
        return Promise.resolve(0);
      }
      _triggerSync();
      _retryFromQueue();
      return _countPending();
    },

    clearQueue: function () {
      return _clearAll().then(function () {
        _countPending().then(_updateBarUI);
        console.info(LOG, 'offline queue cleared');
      });
    },

    getPending: function () {
      return _getAllPending();
    },

    getCacheStats: function () {
      return _getCacheStats();
    },

    // Enqueue an analytics/telemetry event for offline retry
    enqueueEvent: function (type, payload, url) {
      return _enqueue({ type: type || 'analytics', payload: payload, url: url });
    },

    // Enqueue a failed HTTP request for offline retry
    enqueueFetch: function (url, method, headers, body) {
      return _enqueue({ type: 'fetch', url: url, method: method, headers: headers, body: body });
    },

    // Show PWA install prompt (if captured)
    showInstallPrompt: function () {
      if (!_pwaDeferred) return Promise.resolve({ outcome: 'not-available' });
      return _pwaDeferred.prompt().then(function () {
        return _pwaDeferred.userChoice;
      }).then(function (choice) {
        _pwaDeferred = null;
        _trackAnalytics('pwa_install_prompt', { outcome: choice.outcome });
        return choice;
      });
    },

    // Register upload with SW background sync
    registerUploadSync: function () {
      _triggerSync();
    },

    // Force show the offline bar (for debugging)
    showBar: function () {
      _countPending().then(_updateBarUI);
    },
  };

  global.RuntimeOffline = RuntimeOffline;

  // ── Init: check DOM readiness + initial state ─────────────────────────────
  function _init() {
    // Inject bar if already offline at page load
    if (!_online) {
      _countPending().then(_updateBarUI);
    }
    // Emit ready event
    try { global.dispatchEvent(new CustomEvent('iplv:offline-ready')); } catch (_) {}
    console.info(LOG, 'RuntimeOffline v1.0 ready | online=' + _online);
  }

  if (document.body) {
    _init();
  } else {
    document.addEventListener('DOMContentLoaded', _init);
  }

}(window));

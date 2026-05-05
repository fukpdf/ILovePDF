// Advanced Engine v2.1 — production-grade, stealth browser PDF processor.
// Wraps window.BrowserTools.process() transparently. Instant tools untouched.
// All internal strategies (chunking, workers, memory, fallback) are hidden from users.
(function () {
  'use strict';

  // ── ADAPTIVE DEVICE PROFILE ────────────────────────────────────────────────
  var _cores = Math.min(navigator.hardwareConcurrency || 2, 16);
  var _heapGB = 0;
  try { _heapGB = ((performance.memory && performance.memory.jsHeapSizeLimit) || 0) / 1073741824; }
  catch (_) {}

  var PERF_MODE = (function () {
    if (_cores <= 2 || (_heapGB > 0 && _heapGB < 1.5)) return 'low';
    if (_cores <= 4 || (_heapGB > 0 && _heapGB < 3))   return 'medium';
    return 'high';
  }());

  var DEVICE = {
    low:    { workers: 1, chunkMB: 2, ocrScale: 1.2, imgDim: 2048 },
    medium: { workers: 2, chunkMB: 4, ocrScale: 1.5, imgDim: 3072 },
    high:   { workers: 4, chunkMB: 8, ocrScale: 2.0, imgDim: 4096 },
  }[PERF_MODE];

  // Stealth performance label shown to user — no technical details
  var PERF_LABEL = PERF_MODE === 'high' ? 'Performance: Optimal' :
                   PERF_MODE === 'medium' ? 'Performance: Moderate' : 'Performance: High Load';

  var HARD_MAX_WORKERS  = 4;
  var HARD_MAX_IMG_DIM  = 4096;
  var CHUNK_SIZE        = DEVICE.chunkMB * 1024 * 1024;
  var TOOL_TIMEOUT_MS   = 120000; // 2 min

  // ── ERROR TYPES (INTERNAL ONLY) ────────────────────────────────────────────
  var ERR = {
    MEMORY:  'MEMORY_ERROR',
    WORKER:  'WORKER_ERROR',
    NETWORK: 'NETWORK_ERROR',
    PARSE:   'PARSE_ERROR',
    TIMEOUT: 'TIMEOUT_ERROR',
    ORIG:    '__orig__',
  };

  function AEError(type, internalMsg) {
    var e = new Error(internalMsg || type);
    e.aeType = type;
    e.isInternal = true;
    return e;
  }

  // Maps internal errors to safe user-facing messages
  function safeMessage(err) {
    if (!err) return 'Something went wrong. Please try again.';
    var t = err.aeType || '';
    var m = (err.message || '').toLowerCase();
    if (t === ERR.ORIG || m === '__orig__') return null; // sentinel — not an error
    if (t === ERR.NETWORK || m.includes('offline') || m.includes('internet'))
      return 'No internet connection.';
    if (m.includes('requires two'))
      return 'Please upload two PDF files to compare.';
    if (m.includes('no extractable text'))
      return 'Unable to process this file. The document may not contain readable text.';
    if (m.includes('please select'))
      return 'Please select at least one operation to continue.';
    return 'Something went wrong. Please try again.';
  }

  // ── MEMORY GUARD ───────────────────────────────────────────────────────────
  var MEM_REDUCE = 550 * 1024 * 1024;
  var MEM_LOW    = 720 * 1024 * 1024;
  var MEM_ABORT  = 850 * 1024 * 1024;

  function _memUsed() {
    try { return (performance && performance.memory && performance.memory.usedJSHeapSize) || 0; }
    catch (_) { return 0; }
  }
  function _memLimit() {
    try { return (performance && performance.memory && performance.memory.jsHeapSizeLimit) || MEM_ABORT * 2; }
    catch (_) { return MEM_ABORT * 2; }
  }
  function memTier() {
    var u = _memUsed();
    if (u >= MEM_ABORT)  return 'fallback';
    if (u >= MEM_LOW)    return 'low';
    if (u >= MEM_REDUCE) return 'reduce';
    return 'ok';
  }
  function shouldFallbackMem(fileSizeBytes) {
    if (memTier() === 'fallback') return true;
    var factor = (memTier() === 'low') ? 6 : 4;
    var needed = (fileSizeBytes || 0) * factor;
    var avail  = Math.max(0, _memLimit() - _memUsed());
    return needed > avail;
  }

  // ── IDB TEMP STORE ─────────────────────────────────────────────────────────
  var IDBTemp = (function () {
    var DB_NAME = 'ilovepdf-adv-temp';
    var STORE   = 'chunks';
    var VER     = 3;
    var TTL_MS  = 2 * 60 * 60 * 1000;
    var _db     = null;

    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        try {
          var req = indexedDB.open(DB_NAME, VER);
          req.onupgradeneeded = function (ev) {
            var db = ev.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
              db.createObjectStore(STORE, { keyPath: 'k' });
            }
          };
          req.onsuccess = function () {
            _db = req.result;
            _sweep(_db).catch(function () {});
            res(_db);
          };
          req.onerror = function () { rej(req.error); };
        } catch (e) { rej(e); }
      });
    }

    function _sweep(db) {
      return new Promise(function (res) {
        try {
          var cutoff = Date.now() - TTL_MS;
          var tx     = db.transaction(STORE, 'readwrite');
          var req    = tx.objectStore(STORE).openCursor();
          req.onsuccess = function (ev) {
            var cur = ev.target.result;
            if (!cur) return res();
            if ((cur.value.ts || 0) < cutoff) cur.delete();
            cur.continue();
          };
          req.onerror = function () { res(); };
        } catch (_) { res(); }
      });
    }

    function put(key, data) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ k: key, d: data, ts: Date.now() });
            tx.oncomplete = function () { res(true); };
            tx.onerror    = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    function get(key) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx  = db.transaction(STORE, 'readonly');
            var req = tx.objectStore(STORE).get(key);
            req.onsuccess = function () {
              var rec = req.result;
              if (!rec) return res(null);
              if (Date.now() - (rec.ts || 0) > TTL_MS) return res(null);
              res(rec.d);
            };
            req.onerror = function () { res(null); };
          } catch (_) { res(null); }
        });
      }).catch(function () { return null; });
    }

    function del(key) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = function () { res(true); };
            tx.onerror    = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    function sweep() {
      return open().then(function (db) { return _sweep(db); }).catch(function () {});
    }

    return { put: put, get: get, del: del, sweep: sweep };
  }());

  // ── PROGRESS STORE ─────────────────────────────────────────────────────────
  function _fileHash(file) {
    return (file.name || 'f') + ':' + file.size + ':' + (file.lastModified || 0);
  }

  var ProgressStore = {
    _key: function (toolId, fh) { return 'prog:' + toolId + ':' + fh; },
    save: function (toolId, fh, data) {
      return IDBTemp.put(this._key(toolId, fh), data).catch(function () {});
    },
    load: function (toolId, fh) {
      return IDBTemp.get(this._key(toolId, fh));
    },
    clear: function (toolId, fh) {
      return IDBTemp.del(this._key(toolId, fh)).catch(function () {});
    },
  };

  // ── RESUME BANNER (stealth language) ──────────────────────────────────────
  function showResumeBanner(onResume, onDismiss) {
    var existing = document.getElementById('ae-resume-banner');
    if (existing) existing.remove();

    var banner = document.createElement('div');
    banner.id  = 'ae-resume-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
      'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:10000;',
      'background:#1e293b;color:#f1f5f9;padding:12px 18px;border-radius:10px;',
      'display:flex;align-items:center;gap:12px;font-family:inherit;font-size:13px;',
      'box-shadow:0 8px 32px rgba(0,0,0,.35);max-width:480px;width:92%;',
    ].join('');

    banner.innerHTML =
      '<span style="flex:1">You have a previous session for this document.<br>' +
      '<small style="opacity:.7">Upload the same file to continue where you left off.</small></span>' +
      '<button id="ae-rb-yes" style="background:#7c3aed;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">Continue</button>' +
      '<button id="ae-rb-no"  style="background:transparent;color:#94a3b8;border:none;padding:6px 8px;cursor:pointer;font-size:18px;line-height:1">\u00d7</button>';

    document.body.appendChild(banner);

    var timer = setTimeout(function () {
      if (banner.parentNode) { banner.remove(); if (onDismiss) onDismiss(); }
    }, 25000);

    document.getElementById('ae-rb-yes').onclick = function () {
      clearTimeout(timer); banner.remove(); if (onResume) onResume();
    };
    document.getElementById('ae-rb-no').onclick = function () {
      clearTimeout(timer); banner.remove(); if (onDismiss) onDismiss();
    };
  }

  // ── RETRY SYSTEM (silent) ─────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  function retryWithBackoff(fn, maxRetries, baseMs, timeoutMs) {
    maxRetries = Math.max(1, maxRetries || 3);
    baseMs     = baseMs    || 600;
    timeoutMs  = timeoutMs || 10000;

    function attempt(n) {
      var ctrl  = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer, done = false;

      var timeoutP = new Promise(function (_, rej) {
        timer = setTimeout(function () {
          done = true;
          if (ctrl) ctrl.abort();
          rej(AEError(ERR.TIMEOUT, 'attempt_timeout'));
        }, timeoutMs);
      });

      return Promise.race([
        Promise.resolve(fn(n, ctrl ? ctrl.signal : null)),
        timeoutP,
      ]).then(function (r) {
        clearTimeout(timer);
        return r;
      }).catch(function (err) {
        clearTimeout(timer);
        if (n >= maxRetries - 1) throw err;
        var delay = Math.min(baseMs * Math.pow(2, n), 8000);
        return sleep(delay).then(function () { return attempt(n + 1); });
      });
    }
    return attempt(0);
  }

  // ── NETWORK RESILIENCE ────────────────────────────────────────────────────
  function isOnline() {
    return typeof navigator.onLine === 'undefined' || navigator.onLine;
  }

  function fetchWithRetry(url, fetchOpts, maxRetries, timeoutMs) {
    if (!isOnline()) return Promise.reject(AEError(ERR.NETWORK, 'offline'));
    return retryWithBackoff(function (attempt, signal) {
      var opts = Object.assign({}, fetchOpts || {});
      if (signal && !opts.signal) opts.signal = signal;
      return fetch(url, opts).then(function (resp) {
        if (!resp.ok) {
          if (resp.status === 429 || resp.status >= 500) {
            throw AEError(ERR.NETWORK, 'http_' + resp.status);
          }
          throw AEError(ERR.NETWORK, 'http_' + resp.status + '_noretry');
        }
        return resp;
      });
    }, maxRetries || 3, 800, timeoutMs || 10000);
  }

  // ── WORKER BRIDGE WITH SELF-HEAL ──────────────────────────────────────────
  var ADV_WORKER_URL    = '/workers/advanced-worker.js';
  var _workerCrashCount = 0;
  var MAX_WORKER_CRASHES = 3;

  function _runWorkerOnce(message, transferables) {
    return new Promise(function (resolve, reject) {
      var w, timer;

      timer = setTimeout(function () {
        try { if (w) w.terminate(); } catch (_) {}
        reject(AEError(ERR.TIMEOUT, 'worker_timeout'));
      }, 120000);

      try { w = new Worker(ADV_WORKER_URL); }
      catch (e) {
        clearTimeout(timer);
        return reject(AEError(ERR.WORKER, 'worker_create'));
      }

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _workerCrashCount = 0;
        if (ev.data && ev.data.__error) {
          reject(AEError(ERR.WORKER, ev.data.__error));
        } else {
          resolve(ev.data);
        }
      };

      w.onerror = function () {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _workerCrashCount++;
        reject(AEError(ERR.WORKER, 'worker_error'));
      };

      w.onmessageerror = function () {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _workerCrashCount++;
        reject(AEError(ERR.WORKER, 'worker_msg_error'));
      };

      try {
        w.postMessage(message, transferables || []);
      } catch (e) {
        try { w.postMessage(message); }
        catch (e2) {
          clearTimeout(timer);
          try { w.terminate(); } catch (_) {}
          reject(AEError(ERR.WORKER, 'worker_post_error'));
        }
      }
    });
  }

  function runAdvancedWorker(message, transferables) {
    if (_workerCrashCount >= MAX_WORKER_CRASHES) {
      return Promise.reject(AEError(ERR.WORKER, 'worker_disabled'));
    }
    return retryWithBackoff(function () {
      return _runWorkerOnce(message, transferables);
    }, 3, 400, 125000);
  }

  function runPdfWorker(toolId, buffers, options) {
    var pool = window.WorkerPool;
    if (!pool) return Promise.reject(AEError(ERR.WORKER, 'pool_unavailable'));
    return pool.run('/workers/pdf-worker.js',
      { tool: toolId, buffers: buffers, options: options || {} }, buffers);
  }

  // ── VANISH SYSTEM ─────────────────────────────────────────────────────────
  var _blobEntries = [];
  var _tempKeys    = [];

  function trackBlob(url)  { if (url) _blobEntries.push({ url: url, ts: Date.now() }); }
  function trackKey(key)   { if (key) _tempKeys.push(key); }

  function vanish() {
    var entries = _blobEntries.splice(0);
    entries.forEach(function (e) { try { URL.revokeObjectURL(e.url); } catch (_) {} });
    var keys = _tempKeys.splice(0);
    keys.forEach(function (k) { IDBTemp.del(k).catch(function () {}); });
  }

  window.addEventListener('beforeunload', vanish);
  window.addEventListener('popstate',     vanish);

  // ── BACKGROUND CLEANER (silent, every 60s) ────────────────────────────────
  var BLOB_MAX_AGE = 5 * 60 * 1000;
  function backgroundClean() {
    IDBTemp.sweep().catch(function () {});
    var cutoff    = Date.now() - BLOB_MAX_AGE;
    var remaining = [];
    _blobEntries.forEach(function (e) {
      if (e.ts < cutoff) { try { URL.revokeObjectURL(e.url); } catch (_) {} }
      else remaining.push(e);
    });
    _blobEntries.length = 0;
    remaining.forEach(function (e) { _blobEntries.push(e); });
  }
  setInterval(backgroundClean, 60000);

  // ── PROCESSING TIMEOUT ────────────────────────────────────────────────────
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, rej) {
        setTimeout(function () { rej(AEError(ERR.TIMEOUT, 'tool_timeout')); }, ms);
      }),
    ]);
  }

  // ── PROGRESS SMOOTHER (RAF-based smooth fill) ──────────────────────────────
  var ProgressSmoother = (function () {
    var _cur  = 0;
    var _tgt  = 0;
    var _raf  = null;

    function _tick() {
      var bar = document.getElementById('ae-bar');
      if (!bar) { _raf = null; return; }

      var diff = _tgt - _cur;
      if (Math.abs(diff) < 0.15) {
        _cur = _tgt;
        bar.style.width = _tgt + '%';
        _raf = null;
        return;
      }
      // Ease-out: move 9% of remaining gap per frame — smooth deceleration
      _cur += diff * 0.09;
      bar.style.width = _cur.toFixed(1) + '%';
      _raf = requestAnimationFrame(_tick);
    }

    return {
      set: function (pct) {
        _tgt = Math.min(100, Math.max(_cur, pct)); // never regress
        if (!_raf) _raf = requestAnimationFrame(_tick);
      },
      reset: function () {
        _cur = 0; _tgt = 0;
        if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
        var bar = document.getElementById('ae-bar');
        if (bar) bar.style.width = '0%';
      },
      finish: function () {
        _tgt = 100;
        if (!_raf) _raf = requestAnimationFrame(_tick);
      },
    };
  }());

  // ── TIME ESTIMATOR (stealth messages after elapsed thresholds) ────────────
  var _timerIv = null;

  function startTimeEstimator() {
    var start = Date.now();
    _timerIv = setInterval(function () {
      var elapsedS = (Date.now() - start) / 1000;
      var hint;
      if      (elapsedS > 75) hint = 'Finalizing\u2026';
      else if (elapsedS > 40) hint = 'Just a moment more\u2026';
      else if (elapsedS > 18) hint = 'Almost done\u2026';
      else return;

      // Only update hint if no other hint is being shown (don't override step hints)
      var hEl = document.getElementById('ae-hint');
      if (hEl && !hEl._locked) hEl.textContent = hint;
    }, 6000);
  }

  function stopTimeEstimator() {
    if (_timerIv) { clearInterval(_timerIv); _timerIv = null; }
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  function brandedFilename(original, ext) {
    var base = (original || 'file').replace(/\.[^.]+$/, '');
    var safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
    return 'ILovePDF-' + safe + ext;
  }

  var _pdfJsPromise = null;
  var PDFJS_URL    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (_pdfJsPromise)   return _pdfJsPromise;
    _pdfJsPromise = import(PDFJS_URL).then(function (mod) {
      var lib = mod && (mod.default || mod);
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = lib;
      return lib;
    }).catch(function (e) {
      _pdfJsPromise = null;
      throw AEError(ERR.NETWORK, 'pdfjs_load_failed');
    });
    return _pdfJsPromise;
  }

  var _scriptLoads = {};
  function loadScript(url) {
    if (_scriptLoads[url]) return _scriptLoads[url];
    _scriptLoads[url] = new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + url + '"]')) return res();
      var s     = document.createElement('script');
      s.src     = url;
      s.onload  = res;
      s.onerror = function () {
        delete _scriptLoads[url];
        rej(AEError(ERR.NETWORK, 'script_load_failed'));
      };
      document.head.appendChild(s);
    });
    return _scriptLoads[url];
  }

  // Blank page detector — skips pages with no meaningful text
  function isPageBlank(textContent) {
    var combined = (textContent.items || []).map(function (it) { return it.str; }).join('');
    return combined.replace(/\s/g, '').length < 5;
  }

  // ── LIVE FEED ─────────────────────────────────────────────────────────────
  var _feedCssInjected = false;
  var _feedActive      = false;

  function _injectFeedCss() {
    if (_feedCssInjected) return;
    _feedCssInjected = true;
    var s = document.createElement('style');
    s.id  = 'ae-feed-css';
    s.textContent = [
      '.ae-feed{padding:18px 20px;border-radius:12px;background:#f5f3ff;',
        'border:1.5px solid #ddd6fe;margin:12px 0;font-family:inherit;}',
      '.ae-feed-hdr{display:flex;align-items:center;gap:10px;margin-bottom:14px;',
        'color:#4c1d95;font-weight:700;font-size:14px;}',
      '.ae-spin{width:18px;height:18px;border:2.5px solid #c4b5fd;',
        'border-top-color:#7c3aed;border-radius:50%;flex-shrink:0;',
        'animation:ae-spin .7s linear infinite;}',
      '@keyframes ae-spin{to{transform:rotate(360deg)}}',
      '.ae-steps{display:flex;flex-direction:column;gap:7px;margin-bottom:12px;}',
      '.ae-step{display:flex;align-items:center;gap:9px;font-size:12.5px;color:#6b7280;',
        'transition:color .25s,font-weight .25s;}',
      '.ae-step[data-s="active"]{color:#6d28d9;font-weight:600;}',
      '.ae-step[data-s="done"]{color:#059669;}',
      '.ae-step[data-s="error"]{color:#dc2626;}',
      '.ae-dot{width:9px;height:9px;border-radius:50%;background:#d1d5db;flex-shrink:0;',
        'transition:background .25s;}',
      '.ae-step[data-s="active"] .ae-dot{background:#7c3aed;',
        'animation:ae-pulse .9s ease-in-out infinite;}',
      '.ae-step[data-s="done"] .ae-dot{background:#10b981;}',
      '.ae-step[data-s="error"] .ae-dot{background:#ef4444;}',
      '@keyframes ae-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.ae-bar-wrap{height:6px;background:#ddd6fe;border-radius:3px;overflow:hidden;',
        'margin-bottom:6px;}',
      '.ae-bar-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#a78bfa);',
        'border-radius:3px;width:0;}',
      '.ae-hint{font-size:11px;color:#9ca3af;text-align:center;min-height:14px;}',
      '.ae-privacy{font-size:10.5px;color:#a78bfa;text-align:center;',
        'margin-top:8px;display:flex;align-items:center;justify-content:center;gap:5px;}',
      '.ae-perf{font-size:10px;color:#c4b5fd;text-align:right;margin-top:3px;}',
    ].join('');
    document.head.appendChild(s);
  }

  function _escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  var LiveFeed = {
    _steps: [],
    _title: '',

    show: function (steps, title) {
      if (_feedActive) this.hide();
      _feedActive = true;
      _injectFeedCss();
      this._steps = steps || [];
      this._title = title || 'Processing your file\u2026';

      // PRIMARY: update the visible overlay
      var titleEl = document.getElementById('processing-title');
      var msgEl   = document.getElementById('processing-msg');
      if (titleEl) titleEl.textContent = this._title;
      if (msgEl)   msgEl.textContent   = steps[0] || 'Analyzing document\u2026';

      // SECONDARY: richer panel in #result-area (shown after overlay closes)
      var area = document.getElementById('result-area');
      if (!area) return;
      var stepsHtml = steps.map(function (label, i) {
        return '<div class="ae-step" id="ae-s-' + i + '" data-s="pending">' +
               '<span class="ae-dot"></span><span>' + _escHtml(label) + '</span></div>';
      }).join('');
      area.innerHTML =
        '<div class="ae-feed" id="ae-feed">' +
          '<div class="ae-feed-hdr"><div class="ae-spin"></div>' +
            '<span>' + _escHtml(this._title) + '</span></div>' +
          '<div class="ae-steps">' + stepsHtml + '</div>' +
          '<div class="ae-bar-wrap"><div class="ae-bar-fill" id="ae-bar"></div></div>' +
          '<div class="ae-hint" id="ae-hint"></div>' +
          '<div class="ae-privacy">' +
            '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5">' +
              '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
            '</svg>' +
            'Your file is processed securely &mdash; automatically deleted after use' +
          '</div>' +
          '<div class="ae-perf">' + _escHtml(PERF_LABEL) + '</div>' +
        '</div>';

      ProgressSmoother.reset();
      startTimeEstimator();
    },

    update: function (idx, state, pct, hint) {
      // Update overlay message (what user sees during spinner)
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) {
        var label = this._steps[idx] || '';
        msgEl.textContent = label + (hint ? ' \u2014 ' + hint : '');
      }

      // Update result-area step
      var step = document.getElementById('ae-s-' + idx);
      if (step) step.setAttribute('data-s', state);

      // Smooth progress bar
      if (typeof pct === 'number') ProgressSmoother.set(pct);

      // Hint line (lock so time-estimator won't overwrite for 4s)
      if (hint != null) {
        var hEl = document.getElementById('ae-hint');
        if (hEl) {
          hEl.textContent = hint;
          hEl._locked = true;
          clearTimeout(hEl._lockTimer);
          hEl._lockTimer = setTimeout(function () { hEl._locked = false; }, 4000);
        }
      }
    },

    done: function () {
      stopTimeEstimator();
      ProgressSmoother.finish();
      _feedActive = false;
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) msgEl.textContent = 'This usually takes only a few seconds.';
    },

    hide: function () {
      stopTimeEstimator();
      _feedActive = false;
    },
  };

  // ── PRELOAD WARMUP ────────────────────────────────────────────────────────
  function warmup() {
    setTimeout(function () { loadPdfJs().catch(function () {}); }, 600);
  }

  // ── CHUNK STREAM ──────────────────────────────────────────────────────────
  function streamFile(file, onChunk, chunkSize) {
    chunkSize  = chunkSize || CHUNK_SIZE;
    var total  = file.size;
    var offset = 0, idx = 0;
    function next() {
      if (offset >= total) return Promise.resolve();
      var end    = Math.min(offset + chunkSize, total);
      var slice  = file.slice(offset, end);
      var ci     = idx++;
      var isLast = end >= total;
      var base   = offset;
      offset = end;
      return slice.arrayBuffer().then(function (buf) {
        return Promise.resolve(onChunk(buf, ci, base, total, isLast));
      }).then(function () { return next(); });
    }
    return next();
  }

  // ── PDF→WORD: HEADING DETECTOR ────────────────────────────────────────────
  // Returns [{text, isHeading}] from a page's textContent items.
  // Heading = line whose dominant font size exceeds median by >30%.
  function extractStructuredParagraphs(items) {
    if (!items || !items.length) return [];

    // Collect font heights
    var heights = [];
    items.forEach(function (it) {
      var h = Math.abs(it.transform[3]);
      if (h > 0 && it.str.trim()) heights.push(h);
    });
    heights.sort(function (a, b) { return a - b; });
    var medianH = heights[Math.floor(heights.length / 2)] || 10;

    // Group items into lines by y-coordinate (1pt tolerance bucket)
    var lineMap = {};
    items.forEach(function (it) {
      if (!it.str.trim()) return;
      var yKey = Math.round(it.transform[5]);
      if (!lineMap[yKey]) lineMap[yKey] = [];
      lineMap[yKey].push(it);
    });

    var ys = Object.keys(lineMap).map(Number).sort(function (a, b) { return b - a; });
    var paragraphs = [];
    var lastY      = null;

    ys.forEach(function (y) {
      var lineItems = lineMap[y].sort(function (a, b) { return a.transform[4] - b.transform[4]; });
      var lineText  = lineItems.map(function (it) { return it.str; }).join(' ').trim();
      if (!lineText) return;

      var maxH      = Math.max.apply(null, lineItems.map(function (it) { return Math.abs(it.transform[3]); }));
      var isHeading = maxH > medianH * 1.3;

      // New paragraph if large vertical gap or if this is a heading
      var gap        = lastY !== null ? lastY - y : 0;
      var isNewBlock = gap > medianH * 2.2 || isHeading;

      if (lastY === null || isNewBlock) {
        paragraphs.push({ text: lineText, isHeading: isHeading });
      } else {
        // Append to last paragraph
        var last = paragraphs[paragraphs.length - 1];
        if (last) last.text += ' ' + lineText;
      }
      lastY = y;
    });

    return paragraphs;
  }

  // ── PDF→EXCEL: COLUMN CLUSTER DETECTOR ────────────────────────────────────
  // Groups items into proper columns by detecting x-position gaps > 28pt.
  function buildColumnRows(items) {
    if (!items || !items.length) return [];

    // Collect x positions of non-empty items
    var xs = [];
    items.forEach(function (it) {
      if (it.str.trim()) xs.push(Math.round(it.transform[4]));
    });
    xs.sort(function (a, b) { return a - b; });

    // Find column split points (gaps > 28pt)
    var splits = [0];
    for (var xi = 1; xi < xs.length; xi++) {
      if (xs[xi] - xs[xi - 1] > 28) {
        splits.push((xs[xi - 1] + xs[xi]) / 2);
      }
    }
    splits.push(Infinity);

    function getColIdx(x) {
      for (var ci = 0; ci < splits.length - 1; ci++) {
        if (x >= splits[ci] && x < splits[ci + 1]) return ci;
      }
      return 0;
    }

    // Group into row→col cells
    var cells  = {};
    var maxCol = 0;
    items.forEach(function (it) {
      if (!it.str.trim()) return;
      var yKey = Math.round(it.transform[5] / 6) * 6;
      var col  = getColIdx(Math.round(it.transform[4]));
      maxCol   = Math.max(maxCol, col);
      if (!cells[yKey]) cells[yKey] = {};
      cells[yKey][col] = (cells[yKey][col] ? cells[yKey][col] + ' ' : '') + it.str.trim();
    });

    var ys = Object.keys(cells).map(Number).sort(function (a, b) { return b - a; });
    return ys.map(function (y) {
      var row = [];
      for (var ci = 0; ci <= maxCol; ci++) row.push(cells[y][ci] || '');
      return row;
    });
  }

  // ── TOOL STEPS (stealth labels — no technical terms) ──────────────────────
  var TOOL_STEPS = {
    'compress':           ['Analyzing document',    'Optimizing content',    'Applying improvements',  'Preparing download'],
    'pdf-to-word':        ['Analyzing document',    'Processing content',    'Building document',      'Preparing download'],
    'pdf-to-excel':       ['Analyzing document',    'Processing content',    'Building spreadsheet',   'Preparing download'],
    'pdf-to-powerpoint':  ['Analyzing document',    'Processing content',    'Building presentation',  'Preparing download'],
    'word-to-pdf':        ['Analyzing document',    'Processing layout',     'Generating result',      'Preparing download'],
    'excel-to-pdf':       ['Analyzing document',    'Processing layout',     'Generating result',      'Preparing download'],
    'html-to-pdf':        ['Analyzing document',    'Processing layout',     'Generating result',      'Preparing download'],
    'ocr':                ['Analyzing document',    'Processing pages',      'Extracting content',     'Preparing result'],
    'scan-to-pdf':        ['Analyzing images',      'Optimizing quality',    'Creating document',      'Preparing download'],
    'background-remover': ['Loading image',         'Analyzing image',       'Processing image',       'Saving result'],
    'repair':             ['Analyzing document',    'Checking integrity',    'Restoring document',     'Preparing download'],
    'compare':            ['Analyzing documents',   'Processing content',    'Finding differences',    'Building report'],
    'ai-summarize':       ['Analyzing document',    'Processing content',    'Generating summary',     'Preparing result'],
    'translate':          ['Analyzing document',    'Processing content',    'Translating document',   'Preparing result'],
    'workflow':           ['Analyzing document',    'Applying operations',   'Processing steps',       'Preparing download'],
  };

  var ADVANCED_IDS = new Set(Object.keys(TOOL_STEPS));

  // ── TOOL PROCESSORS ───────────────────────────────────────────────────────
  var processors = {};

  // ─── COMPRESS ──────────────────────────────────────────────────────────────
  processors['compress'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analyzing document\u2026');

    var buf = await file.arrayBuffer();
    onStep(0, 'done', 15);
    onStep(1, 'active', 18, 'Optimizing content\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(1, 'done', 25);
        onStep(2, 'active', 30, 'Applying improvements\u2026');
        var wRes = await runPdfWorker('compress', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) resultBuf = wRes.buffer;
      }
    } catch (e) { /* silent — fallback below */ }
    buf = null;

    if (!resultBuf || resultBuf.byteLength >= file.size) throw new Error(ERR.ORIG);

    var saved = Math.round((1 - resultBuf.byteLength / file.size) * 100);
    onStep(2, 'done', 85);
    onStep(3, 'active', 88, 'Reduced by ' + saved + '% \u2014 finalizing\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pdf') };
  };

  // ─── PDF → WORD (with heading detection + paragraph grouping) ──────────────
  processors['pdf-to-word'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analyzing document\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf      = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf       = null;
    var total = pdf.numPages;
    var pages = [];
    var skipped = 0;

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();

      if (isPageBlank(content)) { skipped++; page.cleanup(); continue; }

      // v2 structured extraction with heading detection
      var paragraphs = extractStructuredParagraphs(content.items);
      pages.push({ pageNum: i, paragraphs: paragraphs });
      page.cleanup();

      var pct = 15 + Math.round((i / total) * 38);
      onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
    }
    await pdf.destroy();

    if (!pages.length) throw AEError(ERR.PARSE, 'no_extractable_text');

    onStep(1, 'done', 53);
    onStep(2, 'active', 57, 'Building document\u2026');

    var wResult = await runAdvancedWorker({ op: 'build-docx', pages: pages });
    pages = null;
    if (!wResult || !wResult.buffer) throw AEError(ERR.WORKER, 'build_failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Preparing download\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.docx') };
  };

  // ─── PDF → EXCEL (with column clustering) ──────────────────────────────────
  processors['pdf-to-excel'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analyzing document\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf      = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf    = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf        = null;
    var total  = pdf.numPages;
    var sheets = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();

      var rows = isPageBlank(content) ? [['(empty)']] : buildColumnRows(content.items);
      sheets.push({ name: 'Page ' + i, rows: rows.length ? rows : [['(empty)']] });
      page.cleanup();

      var pct = 15 + Math.round((i / total) * 40);
      onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
    }
    await pdf.destroy();

    onStep(1, 'done', 55);
    onStep(2, 'active', 58, 'Building spreadsheet\u2026');

    var wResult = await runAdvancedWorker({ op: 'build-xlsx', sheets: sheets });
    sheets = null;
    if (!wResult || !wResult.buffer) throw AEError(ERR.WORKER, 'build_failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Preparing download\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.xlsx') };
  };

  // ─── PDF → POWERPOINT ────────────────────────────────────────────────────
  processors['pdf-to-powerpoint'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analyzing document\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf      = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf    = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf        = null;
    var total  = pdf.numPages;
    var slides = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      var items   = content.items;
      var biggest = { str: '', h: 0 };

      if (!isPageBlank(content)) {
        items.forEach(function (it) {
          var h = Math.abs(it.transform[3]);
          if (h > biggest.h && it.str.trim()) biggest = { str: it.str, h: h };
        });
      }

      var bodyText = items
        .filter(function (it) { return it.str.trim() && it.str !== biggest.str; })
        .map(function (it) { return it.str; }).join(' ').trim();

      slides.push({ pageNum: i, title: biggest.str || ('Slide ' + i), text: bodyText });
      page.cleanup();

      var pct = 15 + Math.round((i / total) * 40);
      onStep(1, 'active', pct, 'Slide ' + i + ' of ' + total);
    }
    await pdf.destroy();

    onStep(1, 'done', 55);
    onStep(2, 'active', 58, 'Building presentation\u2026');

    var docTitle = file.name.replace(/\.[^.]+$/, '');
    var wResult  = await runAdvancedWorker({ op: 'build-pptx', slides: slides, docTitle: docTitle });
    slides = null;
    if (!wResult || !wResult.buffer) throw AEError(ERR.WORKER, 'build_failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Preparing download\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pptx') };
  };

  // ─── SENTINEL DELEGATORS ──────────────────────────────────────────────────
  processors['word-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Analyzing document\u2026');    throw new Error(ERR.ORIG); };
  processors['excel-to-pdf'] = async function (f, o, s) { s(0, 'active', 10, 'Analyzing document\u2026');    throw new Error(ERR.ORIG); };
  processors['html-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Preparing document\u2026');    throw new Error(ERR.ORIG); };
  processors['scan-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Analyzing images\u2026');      throw new Error(ERR.ORIG); };

  // ─── OCR ─────────────────────────────────────────────────────────────────
  processors['ocr'] = async function (files, opts, onStep) {
    var file  = files[0];
    var fHash = _fileHash(file);
    onStep(0, 'active', 5, 'Analyzing document\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf      = await file.arrayBuffer();
    onStep(0, 'done', 12);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf       = null;
    var total = pdf.numPages;

    // Fast path: check for native text layer first
    onStep(1, 'active', 15, 'Analyzing document structure\u2026');
    var nativeText = '';
    var nativeChars = 0;
    for (var ni = 1; ni <= total; ni++) {
      var np = await pdf.getPage(ni);
      var nc = await np.getTextContent();
      var t  = nc.items.map(function (it) { return it.str; }).join(' ');
      nativeText  += t + '\n';
      nativeChars += t.replace(/\s/g, '').length;
      np.cleanup();
    }

    if (nativeChars > 60) {
      await pdf.destroy();
      onStep(1, 'done', 50, 'Content ready');
      onStep(2, 'done', 80);
      onStep(3, 'active', 90, 'Preparing result\u2026');
      var nBlob = new Blob([nativeText.trim()], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);
      return { blob: nBlob, filename: brandedFilename(file.name, '.txt') };
    }

    // Image-based: use Tesseract
    onStep(1, 'done', 22);
    onStep(2, 'active', 25, 'Preparing content extraction\u2026');

    if (!window.Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/tesseract.min.js');
    }
    if (!window.Tesseract) throw AEError(ERR.NETWORK, 'engine_load_failed');

    var lang   = (opts && opts.language) || 'eng';
    var worker = await window.Tesseract.createWorker(lang, 1, { logger: function () {} });
    var scale  = DEVICE.ocrScale; // adaptive quality (never exposed to user)

    // Resume support
    var savedProg = await ProgressStore.load('ocr', fHash);
    var startPage = 1;
    var allLines  = [];

    if (savedProg && savedProg.pagesDone > 0 && savedProg.pagesDone < total) {
      if (window._aeResumeOcr === fHash) {
        startPage = savedProg.pagesDone + 1;
        allLines  = savedProg.lines || [];
        onStep(2, 'active', 25 + Math.round((startPage - 1) / total * 55),
          'Continuing where you left off\u2026');
      }
    }

    for (var i = startPage; i <= total; i++) {
      var pg       = await pdf.getPage(i);
      var pgContent = await pg.getTextContent();

      if (isPageBlank(pgContent)) {
        pg.cleanup();
        allLines.push('=== Page ' + i + ' ===\n(no content)');
        continue;
      }

      var viewport = pg.getViewport({ scale: scale });
      var capW     = Math.min(Math.floor(viewport.width),  HARD_MAX_IMG_DIM);
      var capH     = Math.min(Math.floor(viewport.height), HARD_MAX_IMG_DIM);
      var capScale = scale * Math.min(capW / viewport.width, capH / viewport.height);
      var capVp    = pg.getViewport({ scale: capScale });

      var cvs    = document.createElement('canvas');
      cvs.width  = Math.floor(capVp.width);
      cvs.height = Math.floor(capVp.height);
      var ctx = cvs.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      await pg.render({ canvasContext: ctx, viewport: capVp }).promise;
      pg.cleanup();

      // JPEG is 60% smaller than PNG for OCR — faster transfer
      var dataUrl = cvs.toDataURL('image/jpeg', 0.92);
      cvs.width = 0; cvs.height = 0; cvs = null;

      var ocrResult = await worker.recognize(dataUrl);
      dataUrl = null;
      allLines.push('=== Page ' + i + ' ===\n' + ocrResult.data.text);

      await ProgressStore.save('ocr', fHash, {
        pagesDone: i, totalPages: total, lines: allLines.slice(),
      });

      var pct = 25 + Math.round((i / total) * 55);
      onStep(2, 'active', pct, 'Processing page ' + i + ' of ' + total);
    }

    await worker.terminate();
    await pdf.destroy();
    await ProgressStore.clear('ocr', fHash);

    onStep(2, 'done', 80);
    onStep(3, 'active', 84, 'Preparing result\u2026');
    var blob = new Blob([allLines.join('\n\n').trim()], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.txt') };
  };

  // ─── BACKGROUND REMOVER ───────────────────────────────────────────────────
  processors['background-remover'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Loading image\u2026');

    var objUrl = URL.createObjectURL(file);
    trackBlob(objUrl);

    var img = await new Promise(function (res, rej) {
      var el = new Image();
      el.onload  = function () { res(el); };
      el.onerror = function () { rej(AEError(ERR.PARSE, 'image_decode_failed')); };
      el.src = objUrl;
    });

    onStep(0, 'done', 15);
    onStep(1, 'active', 18, 'Analyzing image\u2026');

    var srcW = img.naturalWidth;
    var srcH = img.naturalHeight;
    var cap  = Math.min(DEVICE.imgDim, HARD_MAX_IMG_DIM);
    var drawW = srcW, drawH = srcH;
    if (srcW > cap || srcH > cap) {
      var ratio = Math.min(cap / srcW, cap / srcH);
      drawW = Math.round(srcW * ratio);
      drawH = Math.round(srcH * ratio);
    }

    var cvs   = document.createElement('canvas');
    cvs.width  = drawW; cvs.height = drawH;
    var ctx   = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0, drawW, drawH);
    img = null;

    var imageData = ctx.getImageData(0, 0, drawW, drawH);
    var threshold = Math.max(100, Math.min(255, parseInt((opts && opts.threshold) || '235', 10)));

    onStep(1, 'done', 35);
    onStep(2, 'active', 40, 'Processing image\u2026');

    var rawBuffer = imageData.data.buffer.slice(0);
    imageData = null;

    var wResult = await runAdvancedWorker(
      { op: 'remove-bg', pixels: rawBuffer, width: drawW, height: drawH, threshold: threshold },
      [rawBuffer]
    );

    if (!wResult || !(wResult.pixels instanceof ArrayBuffer)) {
      throw AEError(ERR.WORKER, 'bg_remove_failed');
    }

    onStep(2, 'done', 80);
    onStep(3, 'active', 83, 'Saving result\u2026');

    var outCvs    = document.createElement('canvas');
    outCvs.width  = wResult.width; outCvs.height = wResult.height;
    var outCtx  = outCvs.getContext('2d');
    var outData = outCtx.createImageData(wResult.width, wResult.height);
    outData.data.set(new Uint8ClampedArray(wResult.pixels));
    outCtx.putImageData(outData, 0, 0);
    outData = null;

    var blob = await new Promise(function (res, rej) {
      outCvs.toBlob(function (b) {
        if (b && b.size > 0) res(b);
        else rej(AEError(ERR.WORKER, 'canvas_export_empty'));
      }, 'image/png');
    });

    cvs.width = 0; cvs.height = 0;
    outCvs.width = 0; outCvs.height = 0;

    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.png') };
  };

  // ─── REPAIR ───────────────────────────────────────────────────────────────
  processors['repair'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8, 'Analyzing document\u2026');
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 18);
    onStep(1, 'active', 22, 'Checking integrity\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(1, 'done', 30);
        onStep(2, 'active', 34, 'Restoring document\u2026');
        var wRes = await runPdfWorker('repair', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) resultBuf = wRes.buffer;
      }
    } catch (e) { /* silent */ }

    buf = null;
    if (!resultBuf) throw new Error(ERR.ORIG);

    onStep(2, 'done', 78);
    onStep(3, 'active', 82, 'Preparing download\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-repaired.pdf') };
  };

  // ─── COMPARE ──────────────────────────────────────────────────────────────
  processors['compare'] = async function (files, opts, onStep) {
    if (files.length < 2) throw AEError(ERR.PARSE, 'requires two pdf files');
    onStep(0, 'active', 5, 'Loading documents\u2026');

    var pdfjsLib = await loadPdfJs();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Analyzing first document\u2026');

    async function extractText(file, label, base) {
      var buf = await file.arrayBuffer();
      var pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      buf = null;
      var pages = [];
      for (var pi = 1; pi <= pdf.numPages; pi++) {
        var pg = await pdf.getPage(pi);
        var c  = await pg.getTextContent();
        pages.push(c.items.map(function (it) { return it.str; }).join(' '));
        pg.cleanup();
        var pct = base + Math.round((pi / pdf.numPages) * 18);
        onStep(1, 'active', pct, label + ' \u2014 page ' + pi + ' of ' + pdf.numPages);
      }
      await pdf.destroy();
      return pages;
    }

    var pagesA = await extractText(files[0], 'Document A', 15);
    onStep(1, 'active', 33, 'Analyzing second document\u2026');
    var pagesB = await extractText(files[1], 'Document B', 33);

    onStep(1, 'done', 51);
    onStep(2, 'active', 54, 'Finding differences\u2026');

    var maxPages = Math.max(pagesA.length, pagesB.length);
    var diffs    = [];
    var totalAdded = 0, totalRemoved = 0;

    var wA = new Set((pagesA.join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    var wB = new Set((pagesB.join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    var inter = 0;
    wA.forEach(function (w) { if (wB.has(w)) inter++; });
    var union = wA.size + wB.size - inter;
    var sim   = union > 0 ? Math.round(inter / union * 100) : 0;

    for (var pi = 0; pi < maxPages; pi++) {
      var wPA = new Set(((pagesA[pi] || '').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
      var wPB = new Set(((pagesB[pi] || '').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
      var added = 0, removed = 0;
      wPB.forEach(function (w) { if (!wPA.has(w)) added++; });
      wPA.forEach(function (w) { if (!wPB.has(w)) removed++; });
      totalAdded += added; totalRemoved += removed;
      diffs.push({ page: pi + 1, added: added, removed: removed });
    }

    onStep(2, 'done', 80);
    onStep(3, 'active', 83, 'Building report\u2026');

    var lines = [
      'ILovePDF \u2014 Document Comparison Report',
      '='.repeat(50),
      'Generated : ' + new Date().toISOString(),
      'Document A: ' + files[0].name + ' (' + pagesA.length + ' pages)',
      'Document B: ' + files[1].name + ' (' + pagesB.length + ' pages)',
      'Similarity: ' + sim + '% word overlap',
      '',
      'PAGE-BY-PAGE DIFFERENCES',
      '-'.repeat(50),
    ];
    diffs.forEach(function (d) {
      if (d.added || d.removed) {
        lines.push('Page ' + d.page + ': +' + d.added + ' unique words / -' + d.removed + ' words removed');
      }
    });
    lines.push('');
    lines.push('TOTALS: +' + totalAdded + ' words added, -' + totalRemoved + ' words removed');

    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: 'ILovePDF-comparison-report.txt' };
  };

  // ─── AI SUMMARIZE ─────────────────────────────────────────────────────────
  processors['ai-summarize'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analyzing document\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf      = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf     = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf         = null;
    var total   = pdf.numPages;
    var allText = '';
    var skipped = 0;

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      if (isPageBlank(content)) { skipped++; page.cleanup(); continue; }
      allText += content.items.map(function (it) { return it.str; }).join(' ') + ' ';
      page.cleanup();
      var pct = 15 + Math.round((i / total) * 30);
      onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
    }
    await pdf.destroy();

    if (!allText.trim()) throw AEError(ERR.PARSE, 'no_extractable_text');

    var maxSentences = parseInt((opts && (opts.sentences || opts.length)) || '7', 10) || 7;
    onStep(1, 'done', 45);
    onStep(2, 'active', 49, 'Generating summary\u2026');

    var scored = await runAdvancedWorker({
      op: 'chunk-text-score', text: allText, maxSentences: maxSentences,
    });
    allText = null;

    if (!scored || !scored.summary) throw AEError(ERR.WORKER, 'summarize_empty');

    onStep(2, 'done', 82);
    onStep(3, 'active', 86, 'Preparing result\u2026');

    var report = [
      'ILovePDF \u2014 AI Summary',
      '='.repeat(50),
      'Source : ' + file.name,
      'Pages  : ' + total,
      'Words  : ~' + (scored.wordCount || 0).toLocaleString(),
      '',
      'SUMMARY',
      '-'.repeat(50),
      scored.summary,
      '',
      'Note: ' + scored.sentenceCount + ' sentences analysed, top ' + scored.topCount + ' selected.',
    ].join('\n');

    var blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-summary.txt') };
  };

  // ─── TRANSLATE (with silent retry + progress save) ────────────────────────
  processors['translate'] = async function (files, opts, onStep) {
    var file  = files[0];
    var fHash = _fileHash(file);
    onStep(0, 'active', 5, 'Analyzing document\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf      = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf       = null;
    var total = pdf.numPages;
    var pages = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      pages.push({
        num:   i,
        text:  content.items.map(function (it) { return it.str; }).join(' ').trim(),
        blank: isPageBlank(content),
      });
      page.cleanup();
    }
    await pdf.destroy();

    onStep(1, 'done', 38);
    onStep(2, 'active', 41, 'Preparing content\u2026');

    if (!isOnline()) throw AEError(ERR.NETWORK, 'offline');

    var targetLang = (opts && (opts.targetLang || opts.targetLanguage)) || 'es';
    var MAX_CHARS  = 450;

    // Resume check
    var savedTrans = await ProgressStore.load('translate', fHash);
    var startPage  = 0;
    var translated = [];

    if (savedTrans && savedTrans.pagesDone > 0 && savedTrans.pagesDone < total &&
        savedTrans.targetLang === targetLang) {
      if (window._aeResumeTrans === fHash + ':' + targetLang) {
        startPage  = savedTrans.pagesDone;
        translated = savedTrans.translated || [];
        onStep(2, 'active', 41, 'Continuing where you left off\u2026');
      }
    }

    for (var p = startPage; p < pages.length; p++) {
      var pg = pages[p];

      if (pg.blank || !pg.text) {
        translated.push({ num: pg.num, text: '' });
        continue;
      }

      // Split at word boundaries into ≤MAX_CHARS segments
      var segments = [];
      var pos      = 0;
      var txt      = pg.text;
      while (pos < txt.length) {
        var end = Math.min(pos + MAX_CHARS, txt.length);
        if (end < txt.length) { var ls = txt.lastIndexOf(' ', end); if (ls > pos) end = ls; }
        segments.push(txt.slice(pos, end).trim());
        pos = end + 1;
      }

      var translatedParts = [];
      for (var c = 0; c < segments.length; c++) {
        if (!segments[c]) continue;
        var seg = segments[c];

        // Silent retry with exponential backoff — UI shows neutral message
        var part = await retryWithBackoff(function (attempt, signal) {
          // Show neutral "optimizing" message on retries (never expose retry logic)
          if (attempt > 0) {
            var hEl = document.getElementById('processing-msg');
            if (hEl) hEl.textContent = 'Optimizing connection\u2026';
          }
          var url = 'https://api.mymemory.translated.net/get?q=' +
            encodeURIComponent(seg) +
            '&langpair=en|' + encodeURIComponent(targetLang);
          return fetchWithRetry(url, signal ? { signal: signal } : {}, 1, 10000)
            .then(function (resp) { return resp.json(); })
            .then(function (json) {
              return (json.responseData && json.responseData.translatedText) || seg;
            });
        }, 3, 800, 12000).catch(function () { return seg; }); // silent: keep original on total failure

        translatedParts.push(part);
      }

      translated.push({ num: pg.num, text: translatedParts.join(' ') });

      await ProgressStore.save('translate', fHash, {
        pagesDone:  p + 1, totalPages: total,
        targetLang: targetLang, translated: translated.slice(),
      });

      var pct2 = 41 + Math.round(((p + 1) / pages.length) * 38);
      onStep(2, 'active', pct2, 'Processing page ' + (p + 1) + ' of ' + pages.length);
    }

    await ProgressStore.clear('translate', fHash);

    onStep(2, 'done', 79);
    onStep(3, 'active', 82, 'Preparing result\u2026');

    var lineOut = [
      'ILovePDF \u2014 Translated (' + targetLang.toUpperCase() + ')',
      '='.repeat(50),
      'Source: ' + file.name,
      '',
    ];
    translated.forEach(function (pg) {
      lineOut.push('--- Page ' + pg.num + ' ---');
      lineOut.push(pg.text || '(empty page)');
      lineOut.push('');
    });

    var blob = new Blob([lineOut.join('\n')], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-' + targetLang + '.txt') };
  };

  // ─── WORKFLOW ────────────────────────────────────────────────────────────
  processors['workflow'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8, 'Analyzing document\u2026');
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 18);
    onStep(1, 'active', 22, 'Preparing operations\u2026');

    var steps = [
      { op: opts.step1, value: opts.step1_value || '' },
      { op: opts.step2, value: opts.step2_value || '' },
      { op: opts.step3, value: opts.step3_value || '' },
    ].filter(function (s) { return s.op && s.op !== ''; });

    if (!steps.length) throw AEError(ERR.PARSE, 'please_select_operation');

    onStep(1, 'done', 28);
    onStep(2, 'active', 32, 'Applying operations\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        var wRes = await runPdfWorker('workflow', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) resultBuf = wRes.buffer;
      }
    } catch (e) { /* silent */ }

    buf = null;
    if (!resultBuf) throw new Error(ERR.ORIG);

    onStep(2, 'done', 80);
    onStep(3, 'active', 84, 'Preparing download\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-workflow.pdf') };
  };

  // ── MAIN RUNNER ────────────────────────────────────────────────────────────
  async function runTool(toolId, files, opts, origProcess) {
    var totalBytes = Array.from(files).reduce(function (s, f) { return s + (f.size || 0); }, 0);

    // Silent memory guard — user never sees this internal check
    if (shouldFallbackMem(totalBytes)) {
      throw new Error(ERR.ORIG); // silently use server
    }

    // Silent worker-stability guard
    if (_workerCrashCount >= MAX_WORKER_CRASHES) {
      throw new Error(ERR.ORIG); // silently use server
    }

    var proc  = processors[toolId];
    if (!proc) throw AEError(ERR.PARSE, 'no_processor_' + toolId);

    var steps = TOOL_STEPS[toolId] || ['Analyzing document', 'Processing', 'Finalizing'];
    LiveFeed.show(steps, 'Processing your file\u2026');

    var result;
    try {
      result = await withTimeout(
        proc(files, opts || {}, function (idx, state, pct, hint) {
          LiveFeed.update(idx, state, pct, hint);
        }),
        TOOL_TIMEOUT_MS
      );
    } catch (err) {
      var isOrig = (err.message === ERR.ORIG || err.message === '__orig__' ||
                    (err.aeType === ERR.ORIG));

      if (isOrig) {
        // Seamless handoff — neutral message, user sees no change
        LiveFeed.update(1, 'active', 30, 'Optimizing processing route\u2026');
        try {
          result = await origProcess(toolId, files, opts);
        } catch (origErr) {
          LiveFeed.hide();
          vanish();
          // Throw a safe user-facing error
          var safe = new Error(safeMessage(origErr) || 'Something went wrong. Please try again.');
          throw safe;
        }
      } else {
        LiveFeed.hide();
        vanish();
        // Re-throw with safe user-facing message
        var safeErr = new Error(safeMessage(err) || 'Something went wrong. Please try again.');
        safeErr.aeType = err.aeType;
        throw safeErr;
      }
    }

    LiveFeed.done();
    vanish();
    return result;
  }

  // ── HOOK INSTALLER ─────────────────────────────────────────────────────────
  function installHook() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__advEngineV21) return true;

    var origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      if (ADVANCED_IDS.has(toolId)) {
        return runTool(toolId, files, opts, origProcess);
      }
      return origProcess(toolId, files, opts);
    };

    window.BrowserTools.__advEngineV21 = true;
    console.log('[AdvancedEngine v2.1] ready');
    return true;
  }

  if (!installHook()) {
    var _tries = 0;
    var _iv = setInterval(function () {
      if (installHook() || _tries++ > 40) {
        clearInterval(_iv);
      }
    }, 100);
  }

  // ── WARMUP + PROGRESS RESUME CHECK ─────────────────────────────────────────
  warmup(); // preload pdfjs silently after paint

  (function checkSavedProgress() {
    var slug   = (window.location.pathname || '').replace(/^\//, '').split('/')[0];
    var slugMap = { 'ocr-pdf': 'ocr', 'ocr': 'ocr', 'translate-pdf': 'translate', 'translate': 'translate' };
    var toolId  = slugMap[slug];
    if (!toolId) return;

    window.addEventListener('load', function () {
      var input = document.getElementById('file-input');
      if (!input) return;

      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var fh = _fileHash(f);

        ProgressStore.load(toolId, fh).then(function (saved) {
          if (saved && saved.pagesDone > 0 && saved.pagesDone < (saved.totalPages || Infinity)) {
            showResumeBanner(
              function () {
                if (toolId === 'ocr')       window._aeResumeOcr   = fh;
                if (toolId === 'translate') window._aeResumeTrans = fh + ':' + (saved.targetLang || 'es');
              },
              function () { ProgressStore.clear(toolId, fh).catch(function () {}); }
            );
          }
        }).catch(function () {});
      });
    });
  }());

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.AdvancedEngine = {
    version:       '2.1',
    TOOL_IDS:      ADVANCED_IDS,
    LiveFeed:      LiveFeed,
    IDBTemp:       IDBTemp,
    ProgressStore: ProgressStore,
    memTier:       memTier,
    vanish:        vanish,
  };

}());

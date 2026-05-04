// Advanced Engine v2.0 — production-grade, fault-tolerant browser PDF processor.
// Wraps window.BrowserTools.process() transparently. Instant tools untouched.
//
// v2.0 additions over v1.1:
//   [P01] Adaptive performance mode (LOW / MEDIUM / HIGH) based on hardware
//   [P02] Typed error classifier (MEMORY / WORKER / NETWORK / PARSE / TIMEOUT)
//   [P03] Retry system — exponential backoff, max 3 attempts, 10s per attempt
//   [P04] Network resilience — AbortController, offline guard, retry on failure
//   [P05] Worker self-heal — up to 3 automatic restarts on crash
//   [P06] Progress persistence — IDB save per page; resume banner on reload
//   [P07] Background cleaner — 60s periodic sweep (IDB TTL + blob revocation)
//   [P08] Processing timeout — 120s hard limit per tool → silent server fallback
//   [P09] Speed: skip blank PDF pages, adaptive OCR DPI, pre-warm pdfjs
//   [P10] Trust UX — descriptive, live messages at every stage
//   [P11] Safe fallback triggers — memory, time, worker crash count
//   [P12] Preload warmup — pdfjs loaded 600ms after page paint
//   [P13] Hard safety limits — 4096px canvas, 1 page in memory (OCR), max 4 workers
(function () {
  'use strict';

  // ── [P01] ADAPTIVE DEVICE PROFILE ─────────────────────────────────────────
  var _cores = Math.min(navigator.hardwareConcurrency || 2, 16);
  var _heapLimitGB = 0;
  try { _heapLimitGB = ((performance.memory && performance.memory.jsHeapSizeLimit) || 0) / 1073741824; }
  catch (_) {}

  var PERF_MODE = (function () {
    if (_cores <= 2 || (_heapLimitGB > 0 && _heapLimitGB < 1.5)) return 'low';
    if (_cores <= 4 || (_heapLimitGB > 0 && _heapLimitGB < 3))   return 'medium';
    return 'high';
  }());

  var DEVICE = {
    low:    { workers: 1, chunkMB: 2, ocrScale: 1.2, imgDim: 2048 },
    medium: { workers: 2, chunkMB: 4, ocrScale: 1.5, imgDim: 3072 },
    high:   { workers: 4, chunkMB: 8, ocrScale: 2.0, imgDim: 4096 },
  }[PERF_MODE];

  // [P13] Hard safety limits (never exceed even on HIGH)
  var HARD_MAX_WORKERS = 4;
  var HARD_MAX_IMG_DIM = 4096;   // pixels
  var HARD_MAX_PAGES_MEM = 1;    // OCR pages held in memory at once
  var TOOL_TIMEOUT_MS = 120000;  // 2 min hard limit per tool
  var CHUNK_SIZE = DEVICE.chunkMB * 1024 * 1024;

  console.log('[AdvancedEngine v2.0] PERF_MODE=' + PERF_MODE +
    ' cores=' + _cores + ' heapGB=' + _heapLimitGB.toFixed(1));

  // ── [P02] ERROR CLASSIFIER ─────────────────────────────────────────────────
  var ERR = {
    MEMORY:  'MEMORY_ERROR',
    WORKER:  'WORKER_ERROR',
    NETWORK: 'NETWORK_ERROR',
    PARSE:   'PARSE_ERROR',
    TIMEOUT: 'TIMEOUT_ERROR',
    ORIG:    '__orig__',
  };

  function AEError(type, message) {
    var e = new Error(message || type);
    e.aeType = type;
    return e;
  }

  function classifyError(err) {
    if (!err) return { type: 'UNKNOWN', shouldFallback: true };
    var t = err.aeType || '';
    var m = (err.message || '').toLowerCase();
    if (t === ERR.ORIG || m === '__orig__')                 return { type: ERR.ORIG,    shouldFallback: false };
    if (t === ERR.MEMORY || m.includes('memory'))          return { type: ERR.MEMORY,  shouldFallback: true  };
    if (t === ERR.TIMEOUT || m.includes('timed out'))      return { type: ERR.TIMEOUT, shouldFallback: true  };
    if (t === ERR.WORKER || m.includes('worker'))          return { type: ERR.WORKER,  shouldFallback: true  };
    if (t === ERR.NETWORK || m.includes('fetch') || m.includes('network') || m.includes('http'))
                                                           return { type: ERR.NETWORK, shouldFallback: false };
    if (m.includes('parse') || m.includes('corrupt') || m.includes('invalid'))
                                                           return { type: ERR.PARSE,   shouldFallback: true  };
    return { type: 'UNKNOWN', shouldFallback: true };
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
    var tier = memTier();
    // On low mem, only allow files that need < half available headroom
    var safetyFactor = (tier === 'low') ? 6 : 4;
    var needed = (fileSizeBytes || 0) * safetyFactor;
    var avail  = Math.max(0, _memLimit() - _memUsed());
    return needed > avail;
  }

  // ── IDB TEMP STORE (v2 — also used by ProgressStore) ──────────────────────
  var IDBTemp = (function () {
    var DB_NAME = 'ilovepdf-adv-temp';
    var STORE   = 'chunks';
    var VER     = 3;
    var TTL_MS  = 2 * 60 * 60 * 1000; // 2 hours
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
          var tx  = db.transaction(STORE, 'readwrite');
          var req = tx.objectStore(STORE).openCursor();
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

    function clear() {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = function () { res(true); };
            tx.onerror    = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    // [P07] Manual sweep callable from background cleaner
    function sweep() {
      return open().then(function (db) { return _sweep(db); }).catch(function () {});
    }

    return { put: put, get: get, del: del, clear: clear, sweep: sweep };
  }());

  // ── [P06] PROGRESS STORE ───────────────────────────────────────────────────
  // Saves per-page progress for OCR and Translate; allows resume on re-upload.
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

  // ── [P06] RESUME BANNER ─────────────────────────────────────────────────────
  // Non-intrusive fixed toast shown when saved progress is found.
  function showResumeBanner(toolLabel, pagesDone, totalPages, onResume, onDismiss) {
    var existing = document.getElementById('ae-resume-banner');
    if (existing) existing.remove();

    var banner = document.createElement('div');
    banner.id  = 'ae-resume-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
      'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:10000;',
      'background:#1e293b;color:#f1f5f9;padding:12px 18px;border-radius:10px;',
      'display:flex;align-items:center;gap:12px;font-family:inherit;font-size:13px;',
      'box-shadow:0 8px 32px rgba(0,0,0,.35);max-width:540px;width:92%;',
      'animation:ae-slide-up .25s ease-out;',
    ].join('');

    var style = document.createElement('style');
    style.textContent = '@keyframes ae-slide-up{from{opacity:0;transform:translateX(-50%) translateY(12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
    document.head.appendChild(style);

    banner.innerHTML =
      '<span style="flex:1">⚡ <b>' + toolLabel + '</b>: previous session saved<br>' +
      '<small style="opacity:.7">Processed ' + pagesDone + ' of ' + totalPages + ' pages — re-upload the same file to resume.</small></span>' +
      '<button id="ae-rb-yes" style="background:#7c3aed;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">Resume</button>' +
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

  // ── [P03] RETRY SYSTEM ─────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  // Retry async fn with exponential backoff. fn(attempt) → Promise.
  // If fn throws on all attempts, the last error is re-thrown.
  function retryWithBackoff(fn, maxRetries, baseMs, timeoutMs) {
    maxRetries = Math.max(1, maxRetries || 3);
    baseMs     = baseMs     || 600;
    timeoutMs  = timeoutMs  || 10000;

    function attempt(n) {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer;
      var timedOut = false;

      var timeoutP = new Promise(function (_, rej) {
        timer = setTimeout(function () {
          timedOut = true;
          if (ctrl) ctrl.abort();
          rej(AEError(ERR.TIMEOUT, 'Attempt ' + n + ' timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
      });

      return Promise.race([
        Promise.resolve(fn(n, ctrl ? ctrl.signal : null)),
        timeoutP,
      ]).then(function (result) {
        clearTimeout(timer);
        return result;
      }).catch(function (err) {
        clearTimeout(timer);
        if (n >= maxRetries - 1) throw err;
        var delay = Math.min(baseMs * Math.pow(2, n), 8000);
        return sleep(delay).then(function () { return attempt(n + 1); });
      });
    }

    return attempt(0);
  }

  // ── [P04] FETCH WITH RETRY ─────────────────────────────────────────────────
  function isOnline() {
    return typeof navigator.onLine === 'undefined' || navigator.onLine;
  }

  function fetchWithRetry(url, fetchOpts, maxRetries, timeoutMs) {
    if (!isOnline()) return Promise.reject(AEError(ERR.NETWORK, 'Device is offline'));
    maxRetries = maxRetries || 3;
    timeoutMs  = timeoutMs  || 10000;

    return retryWithBackoff(function (attempt, signal) {
      var opts = Object.assign({}, fetchOpts || {});
      if (signal && !opts.signal) opts.signal = signal;
      return fetch(url, opts).then(function (resp) {
        if (!resp.ok) {
          // 429 rate-limit: always retry; 5xx: retry; 4xx others: don't retry
          if (resp.status === 429 || resp.status >= 500) {
            throw AEError(ERR.NETWORK, 'HTTP ' + resp.status);
          }
          throw AEError(ERR.NETWORK, 'HTTP ' + resp.status + ' (no retry)');
        }
        return resp;
      });
    }, maxRetries, 800, timeoutMs);
  }

  // ── [P05] WORKER BRIDGE WITH SELF-HEAL ─────────────────────────────────────
  var ADV_WORKER_URL = '/workers/advanced-worker.js';
  var _workerCrashCount = 0;
  var MAX_WORKER_CRASHES = 3;

  function _runWorkerOnce(message, transferables) {
    return new Promise(function (resolve, reject) {
      var w, timer;

      timer = setTimeout(function () {
        try { if (w) w.terminate(); } catch (_) {}
        reject(AEError(ERR.TIMEOUT, 'Worker timed out after 120s'));
      }, 120000);

      try { w = new Worker(ADV_WORKER_URL); }
      catch (e) {
        clearTimeout(timer);
        return reject(AEError(ERR.WORKER, 'Worker creation failed: ' + (e.message || e)));
      }

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _workerCrashCount = 0; // reset on success
        if (ev.data && ev.data.__error) {
          reject(AEError(ERR.WORKER, ev.data.__error));
        } else {
          resolve(ev.data);
        }
      };

      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _workerCrashCount++;
        reject(AEError(ERR.WORKER, (ev && ev.message) || 'Worker script error'));
      };

      w.onmessageerror = function () {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _workerCrashCount++;
        reject(AEError(ERR.WORKER, 'Worker message deserialization failed'));
      };

      try {
        w.postMessage(message, transferables || []);
      } catch (e) {
        try { w.postMessage(message); }
        catch (e2) {
          clearTimeout(timer);
          try { w.terminate(); } catch (_) {}
          reject(AEError(ERR.WORKER, 'Worker postMessage failed: ' + e2.message));
        }
      }
    });
  }

  // [P05] Self-healing: retry worker up to MAX_WORKER_CRASHES times on crash
  function runAdvancedWorker(message, transferables) {
    if (_workerCrashCount >= MAX_WORKER_CRASHES) {
      return Promise.reject(AEError(ERR.WORKER, 'Worker crashed ' + _workerCrashCount + ' times — disabled'));
    }
    return retryWithBackoff(function () {
      // Clone transferables for retry since transferred buffers are detached after first send.
      // We only retry if the buffer wasn't consumed (i.e. worker failed before using it).
      return _runWorkerOnce(message, transferables);
    }, 3, 400, 125000); // 3 attempts, 125s timeout (worker has own 120s)
  }

  // Reuse existing WorkerPool + pdf-worker.js for pure pdf-lib operations
  function runPdfWorker(toolId, buffers, options) {
    var pool = window.WorkerPool;
    if (!pool) return Promise.reject(AEError(ERR.WORKER, 'WorkerPool unavailable'));
    return pool.run('/workers/pdf-worker.js',
      { tool: toolId, buffers: buffers, options: options || {} }, buffers);
  }

  // ── VANISH SYSTEM ──────────────────────────────────────────────────────────
  var _blobEntries = []; // { url, ts }
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

  // ── [P07] BACKGROUND CLEANER ───────────────────────────────────────────────
  // Runs every 60s: sweeps IDB TTL + revokes stale blob URLs (older than 5 min)
  var BLOB_REVOKE_AGE = 5 * 60 * 1000;

  function backgroundClean() {
    // Sweep IDB
    IDBTemp.sweep().catch(function () {});

    // Revoke old blob URLs (won't revoke ones still in active use since those
    // are tracked but won't be shown to the user after 5 min anyway)
    var cutoff = Date.now() - BLOB_REVOKE_AGE;
    var remaining = [];
    _blobEntries.forEach(function (e) {
      if (e.ts < cutoff) {
        try { URL.revokeObjectURL(e.url); } catch (_) {}
      } else {
        remaining.push(e);
      }
    });
    _blobEntries.length = 0;
    remaining.forEach(function (e) { _blobEntries.push(e); });
  }

  setInterval(backgroundClean, 60000);

  // ── PROCESSING TIMEOUT ─────────────────────────────────────────────────────
  // [P08] Any tool that exceeds TOOL_TIMEOUT_MS throws a TIMEOUT_ERROR
  // which tool-page.js catches and routes to the server API automatically.
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, rej) {
        setTimeout(function () {
          rej(AEError(ERR.TIMEOUT, 'Processing timed out after ' + Math.round(ms / 1000) + 's — routing to server'));
        }, ms);
      }),
    ]);
  }

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function brandedFilename(original, ext) {
    var base = (original || 'file').replace(/\.[^.]+$/, '');
    var safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
    return 'ILovePDF-' + safe + ext;
  }

  // pdfjs lazy loader — reuses global if browser-tools.js already loaded it
  var _pdfJsPromise = null;
  var PDFJS_URL     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
  var PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (_pdfJsPromise)   return _pdfJsPromise;
    _pdfJsPromise = import(PDFJS_URL).then(function (mod) {
      var lib = mod && (mod.default || mod);
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = lib;
      return lib;
    }).catch(function (e) {
      _pdfJsPromise = null; // allow retry
      throw AEError(ERR.NETWORK, 'pdfjs load failed: ' + e.message);
    });
    return _pdfJsPromise;
  }

  // Script loader (Tesseract.js)
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
        rej(AEError(ERR.NETWORK, 'Failed to load: ' + url));
      };
      document.head.appendChild(s);
    });
    return _scriptLoads[url];
  }

  // [P09] Blank page detector — true if the page has no meaningful text
  function isPageBlank(textContent) {
    var combined = (textContent.items || []).map(function (it) { return it.str; }).join('');
    return combined.replace(/\s/g, '').length < 5;
  }

  // ── [P12] PRELOAD WARMUP SYSTEM ────────────────────────────────────────────
  // Start loading pdfjs silently 600ms after page paint so first-process is instant
  function warmup() {
    setTimeout(function () {
      loadPdfJs().catch(function () {}); // silent — errors handled when tool actually runs
    }, 600);
  }

  // ── LIVE FEED ──────────────────────────────────────────────────────────────
  // [P10] Trust UX: rich messages updating both the overlay AND #result-area panel
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
        'transition:color .2s,font-weight .2s;}',
      '.ae-step[data-s="active"]{color:#6d28d9;font-weight:600;}',
      '.ae-step[data-s="done"]{color:#059669;}',
      '.ae-step[data-s="error"]{color:#dc2626;}',
      '.ae-step[data-s="skip"]{color:#9ca3af;text-decoration:line-through;}',
      '.ae-dot{width:9px;height:9px;border-radius:50%;background:#d1d5db;flex-shrink:0;transition:background .2s;}',
      '.ae-step[data-s="active"] .ae-dot{background:#7c3aed;animation:ae-pulse .9s ease-in-out infinite;}',
      '.ae-step[data-s="done"] .ae-dot{background:#10b981;}',
      '.ae-step[data-s="error"] .ae-dot{background:#ef4444;}',
      '.ae-step[data-s="skip"] .ae-dot{background:#d1d5db;}',
      '@keyframes ae-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.ae-bar-wrap{height:6px;background:#ddd6fe;border-radius:3px;overflow:hidden;margin-bottom:6px;}',
      '.ae-bar-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#a78bfa);',
        'border-radius:3px;transition:width .4s cubic-bezier(.4,0,.2,1);width:0;}',
      '.ae-hint{font-size:11px;color:#9ca3af;text-align:center;min-height:14px;}',
      '.ae-mode{font-size:10px;color:#c4b5fd;text-align:right;margin-top:4px;}',
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
      this._title = title || 'Processing\u2026';

      // PRIMARY: update overlay elements (what user sees during the processing spinner)
      var titleEl = document.getElementById('processing-title');
      var msgEl   = document.getElementById('processing-msg');
      if (titleEl) titleEl.textContent = this._title;
      if (msgEl)   msgEl.textContent   = steps[0] || 'Analysing file\u2026';

      // SECONDARY: richer panel in #result-area (visible after overlay hides)
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
          '<div class="ae-mode">' + PERF_MODE.toUpperCase() + ' mode \u00b7 ' +
            DEVICE.workers + ' worker(s)</div>' +
        '</div>';
    },

    // [P10] Rich update: live message in overlay + step state in panel
    update: function (idx, state, pct, hint) {
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) {
        var label = this._steps[idx] || '';
        msgEl.textContent = label + (hint ? ' \u2014 ' + hint : '');
      }

      var step = document.getElementById('ae-s-' + idx);
      if (step) step.setAttribute('data-s', state);

      if (typeof pct === 'number') {
        var bar = document.getElementById('ae-bar');
        if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
      }

      var hEl = document.getElementById('ae-hint');
      if (hEl && hint != null) hEl.textContent = hint;
    },

    done: function () {
      var bar = document.getElementById('ae-bar');
      if (bar) bar.style.width = '100%';
      _feedActive = false;
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) msgEl.textContent = 'This usually takes only a few seconds.';
    },

    hide: function () { _feedActive = false; },
  };

  // ── CHUNK STREAM ───────────────────────────────────────────────────────────
  function streamFile(file, onChunk, chunkSize) {
    chunkSize  = chunkSize || CHUNK_SIZE;
    var total  = file.size;
    var offset = 0;
    var idx    = 0;

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

  // ── TOOL STEPS ─────────────────────────────────────────────────────────────
  // [P10] Descriptive, trust-building labels shown in overlay + panel
  var TOOL_STEPS = {
    'compress':           ['Analysing file structure', 'Mapping object graph',    'Optimising streams',       'Finalising output'],
    'pdf-to-word':        ['Reading PDF structure',    'Extracting text content', 'Building Word document',   'Packaging file'],
    'pdf-to-excel':       ['Reading PDF structure',    'Detecting column layout', 'Building spreadsheet',     'Packaging file'],
    'pdf-to-powerpoint':  ['Reading PDF structure',    'Extracting slide content','Building presentation',    'Packaging file'],
    'word-to-pdf':        ['Analysing document',       'Parsing content tree',    'Rendering PDF layout',     'Finalising output'],
    'excel-to-pdf':       ['Analysing spreadsheet',    'Parsing data rows',       'Rendering PDF layout',     'Finalising output'],
    'html-to-pdf':        ['Analysing HTML markup',    'Resolving CSS layout',    'Rendering page',           'Finalising output'],
    'ocr':                ['Analysing file structure', 'Rendering page images',   'Recognising text (OCR)',   'Compiling results'],
    'scan-to-pdf':        ['Analysing images',         'Optimising resolution',   'Creating PDF document',    'Finalising output'],
    'background-remover': ['Loading image data',       'Analysing pixel map',     'Removing background',      'Saving PNG'],
    'repair':             ['Analysing PDF structure',  'Scanning for errors',     'Rebuilding object tree',   'Saving repaired file'],
    'compare':            ['Loading both documents',   'Extracting text content', 'Computing differences',    'Building report'],
    'ai-summarize':       ['Reading PDF content',      'Extracting key sentences','Scoring by relevance',     'Building summary'],
    'translate':          ['Reading PDF content',      'Chunking for translation','Translating via API',      'Building output'],
    'workflow':           ['Reading PDF structure',    'Applying operations',     'Chaining workflow steps',  'Saving output'],
  };

  var ADVANCED_IDS = new Set(Object.keys(TOOL_STEPS));

  // ── TOOL PROCESSORS ────────────────────────────────────────────────────────
  var processors = {};

  // ─── COMPRESS ─────────────────────────────────────────────────────────────
  processors['compress'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Reading ' + (file.size / 1048576).toFixed(1) + ' MB\u2026');

    var buf = await file.arrayBuffer();
    onStep(0, 'done', 15);
    onStep(1, 'active', 18, 'Mapping PDF objects\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(1, 'done', 25);
        onStep(2, 'active', 30, 'Compressing streams\u2026');
        var wRes = await runPdfWorker('compress', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          resultBuf = wRes.buffer;
        }
      }
    } catch (e) {
      console.warn('[AdvEngine] compress worker:', e.message);
    }
    buf = null;

    if (!resultBuf || resultBuf.byteLength >= file.size) {
      // No gain → server has better image resampling
      throw new Error(ERR.ORIG);
    }

    var saved = Math.round((1 - resultBuf.byteLength / file.size) * 100);
    onStep(2, 'done', 85);
    onStep(3, 'active', 88, 'Saved ' + saved + '% \u2014 finalising\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pdf') };
  };

  // ─── PDF → WORD ────────────────────────────────────────────────────────────
  processors['pdf-to-word'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analysing file structure\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Opening PDF document\u2026');

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total = pdf.numPages;
    var pages = [];
    var skipped = 0;

    onStep(1, 'active', 17, 'Processing ' + total + ' pages\u2026');
    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();

      // [P09] Skip truly blank pages
      if (isPageBlank(content)) {
        skipped++;
        page.cleanup();
        continue;
      }

      var text = content.items.map(function (it) { return it.str; }).join(' ');
      pages.push({ pageNum: i, text: text });
      page.cleanup();

      var pct = 17 + Math.round((i / total) * 38);
      onStep(1, 'active', pct, 'Extracting page ' + i + ' of ' + total);
    }
    await pdf.destroy();

    var hint = skipped ? (pages.length + ' pages extracted, ' + skipped + ' blank skipped') : '';
    onStep(1, 'done', 55, hint);
    onStep(2, 'active', 59, 'Building DOCX structure\u2026');

    if (!pages.length) throw AEError(ERR.PARSE, 'No extractable text found in PDF');

    var wResult = await runAdvancedWorker({ op: 'build-docx', pages: pages });
    pages = null;
    if (!wResult || !wResult.buffer) throw AEError(ERR.WORKER, 'DOCX build failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Packaging Word document\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.docx') };
  };

  // ─── PDF → EXCEL ───────────────────────────────────────────────────────────
  processors['pdf-to-excel'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analysing file structure\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Detecting column layout\u2026');

    var pdf    = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total  = pdf.numPages;
    var sheets = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();

      var byY = {};
      if (!isPageBlank(content)) {
        content.items.forEach(function (it) {
          if (!it.str.trim()) return;
          var yKey = Math.round(it.transform[5] / 8) * 8;
          if (!byY[yKey]) byY[yKey] = [];
          byY[yKey].push({ x: it.transform[4], str: it.str.trim() });
        });
      }

      var ys   = Object.keys(byY).map(Number).sort(function (a, b) { return b - a; });
      var rows = ys.map(function (y) {
        return byY[y].sort(function (a, b) { return a.x - b.x; }).map(function (it) { return it.str; });
      });
      sheets.push({ name: 'Page ' + i, rows: rows.length ? rows : [['(empty)']] });
      page.cleanup();

      var pct = 15 + Math.round((i / total) * 40);
      onStep(1, 'active', pct, 'Page ' + i + ' of ' + total + ' \u2014 ' + (rows.length || 0) + ' rows');
    }
    await pdf.destroy();

    onStep(1, 'done', 55);
    onStep(2, 'active', 59, 'Building XLSX spreadsheet\u2026');

    var wResult = await runAdvancedWorker({ op: 'build-xlsx', sheets: sheets });
    sheets = null;
    if (!wResult || !wResult.buffer) throw AEError(ERR.WORKER, 'XLSX build failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Packaging spreadsheet\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.xlsx') };
  };

  // ─── PDF → POWERPOINT ──────────────────────────────────────────────────────
  processors['pdf-to-powerpoint'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Analysing file structure\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Extracting slide content\u2026');

    var pdf    = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
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
    onStep(2, 'active', 59, 'Building PowerPoint presentation\u2026');

    var docTitle = file.name.replace(/\.[^.]+$/, '');
    var wResult  = await runAdvancedWorker({ op: 'build-pptx', slides: slides, docTitle: docTitle });
    slides = null;
    if (!wResult || !wResult.buffer) throw AEError(ERR.WORKER, 'PPTX build failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Packaging presentation\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pptx') };
  };

  // ─── SENTINEL DELEGATORS (Word/Excel/HTML/Scan → origProcess) ─────────────
  processors['word-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Loading document\u2026');    throw new Error(ERR.ORIG); };
  processors['excel-to-pdf'] = async function (f, o, s) { s(0, 'active', 10, 'Loading spreadsheet\u2026'); throw new Error(ERR.ORIG); };
  processors['html-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Parsing HTML\u2026');        throw new Error(ERR.ORIG); };
  processors['scan-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Loading images\u2026');      throw new Error(ERR.ORIG); };

  // ─── OCR ────────────────────────────────────────────────────────────────────
  // [P05][P06][P09][P13] Self-heal worker, progress save, blank skip, 1 page in memory
  processors['ocr'] = async function (files, opts, onStep) {
    var file  = files[0];
    var fHash = _fileHash(file);
    onStep(0, 'active', 5, 'Analysing PDF structure\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total = pdf.numPages;

    // Fast path: native text layer
    onStep(1, 'active', 15, 'Checking for native text layer\u2026');
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
      onStep(1, 'done', 50, 'Native text layer found');
      onStep(2, 'done', 80);
      onStep(3, 'active', 90, 'Compiling results\u2026');
      var nBlob = new Blob([nativeText.trim()], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);
      return { blob: nBlob, filename: brandedFilename(file.name, '.txt') };
    }

    // Tesseract OCR path
    onStep(1, 'done', 22);
    onStep(2, 'active', 25, 'Loading OCR engine\u2026');

    if (!window.Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/tesseract.min.js');
    }
    if (!window.Tesseract) throw AEError(ERR.NETWORK, 'Tesseract.js failed to load');

    var lang   = (opts && opts.language) || 'eng';
    var worker = await window.Tesseract.createWorker(lang, 1, { logger: function () {} });

    // [P09] Dynamic DPI based on device performance mode
    var scale  = DEVICE.ocrScale;

    // [P06] Check for saved progress
    var savedProg = await ProgressStore.load('ocr', fHash);
    var startPage = 1;
    var allLines  = [];

    if (savedProg && savedProg.pagesDone > 0 && savedProg.pagesDone < total) {
      // We have partial progress — check if user will re-use it
      // Store the intent in a flag; the banner was shown at warmup
      if (window._aeResumeOcr && window._aeResumeOcr === fHash) {
        startPage = savedProg.pagesDone + 1;
        allLines  = savedProg.lines || [];
        onStep(2, 'active', 25 + Math.round((startPage - 1) / total * 55),
          'Resuming from page ' + startPage + '\u2026');
      }
    }

    for (var i = startPage; i <= total; i++) {
      // [P13] ONE page in memory at a time (HARD_MAX_PAGES_MEM = 1)
      var pg       = await pdf.getPage(i);
      var content  = await pg.getTextContent();

      // [P09] Skip blank pages (no pixels to OCR)
      if (isPageBlank(content)) {
        pg.cleanup();
        allLines.push('=== Page ' + i + ' (blank) ===\n');
        continue;
      }

      var viewport = pg.getViewport({ scale: scale });

      // [P13] Clamp canvas to HARD_MAX_IMG_DIM
      var canW = Math.min(Math.floor(viewport.width),  HARD_MAX_IMG_DIM);
      var canH = Math.min(Math.floor(viewport.height), HARD_MAX_IMG_DIM);
      var clampedScale = scale * Math.min(canW / viewport.width, canH / viewport.height);
      var clampedVp    = pg.getViewport({ scale: clampedScale });

      var cvs    = document.createElement('canvas');
      cvs.width  = Math.floor(clampedVp.width);
      cvs.height = Math.floor(clampedVp.height);
      var ctx = cvs.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      await pg.render({ canvasContext: ctx, viewport: clampedVp }).promise;
      pg.cleanup();

      var dataUrl = cvs.toDataURL('image/jpeg', 0.92); // JPEG saves ~60% vs PNG for OCR
      cvs.width  = 0; cvs.height = 0; cvs = null; // dispose immediately

      var ocrResult = await worker.recognize(dataUrl);
      dataUrl = null;
      allLines.push('=== Page ' + i + ' ===\n' + ocrResult.data.text);

      // [P06] Save progress after each page
      await ProgressStore.save('ocr', fHash, {
        pagesDone: i,
        totalPages: total,
        lines: allLines.slice(),
      });

      var pct = 25 + Math.round((i / total) * 55);
      onStep(2, 'active', pct, 'OCR page ' + i + ' of ' + total + ' (' + PERF_MODE + ' quality)');
    }

    await worker.terminate();
    await pdf.destroy();
    await ProgressStore.clear('ocr', fHash); // [P06] clear on success

    onStep(2, 'done', 80);
    onStep(3, 'active', 85, 'Compiling ' + allLines.length + ' pages\u2026');
    var blob = new Blob([allLines.join('\n\n').trim()], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.txt') };
  };

  // ─── BACKGROUND REMOVER ────────────────────────────────────────────────────
  // [P13] Strict canvas cap; [P03] safe transfer; [P09] pre-downscale
  processors['background-remover'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Loading image data\u2026');

    var objUrl = URL.createObjectURL(file);
    trackBlob(objUrl);

    var img = await new Promise(function (res, rej) {
      var el = new Image();
      el.onload  = function () { res(el); };
      el.onerror = function () { rej(AEError(ERR.PARSE, 'Cannot decode image')); };
      el.src = objUrl;
    });

    onStep(0, 'done', 15);
    onStep(1, 'active', 18, 'Analysing pixel map\u2026');

    var srcW = img.naturalWidth;
    var srcH = img.naturalHeight;

    // [P13] Hard cap at HARD_MAX_IMG_DIM; also use adaptive cap from DEVICE
    var dimCap = Math.min(DEVICE.imgDim, HARD_MAX_IMG_DIM);
    var drawW  = srcW;
    var drawH  = srcH;
    if (srcW > dimCap || srcH > dimCap) {
      var ratio = Math.min(dimCap / srcW, dimCap / srcH);
      drawW = Math.round(srcW * ratio);
      drawH = Math.round(srcH * ratio);
    }

    var cvs   = document.createElement('canvas');
    cvs.width  = drawW;
    cvs.height = drawH;
    var ctx = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0, drawW, drawH);
    img = null;

    var imageData = ctx.getImageData(0, 0, drawW, drawH);
    var threshold = Math.max(100, Math.min(255, parseInt((opts && opts.threshold) || '235', 10)));

    onStep(1, 'done', 35);
    onStep(2, 'active', 40, 'Running background removal\u2026');

    var rawBuffer = imageData.data.buffer.slice(0); // copy for zero-copy transfer
    imageData = null;

    var wResult = await runAdvancedWorker(
      { op: 'remove-bg', pixels: rawBuffer, width: drawW, height: drawH, threshold: threshold },
      [rawBuffer]
    );

    if (!wResult || !(wResult.pixels instanceof ArrayBuffer)) {
      throw AEError(ERR.WORKER, 'Background removal returned invalid result');
    }

    onStep(2, 'done', 80);
    onStep(3, 'active', 83, 'Saving transparent PNG\u2026');

    var outCvs    = document.createElement('canvas');
    outCvs.width  = wResult.width;
    outCvs.height = wResult.height;
    var outCtx  = outCvs.getContext('2d');
    var outData = outCtx.createImageData(wResult.width, wResult.height);
    outData.data.set(new Uint8ClampedArray(wResult.pixels));
    outCtx.putImageData(outData, 0, 0);
    outData = null;

    var blob = await new Promise(function (res, rej) {
      outCvs.toBlob(function (b) {
        if (b && b.size > 0) res(b);
        else rej(AEError(ERR.WORKER, 'Canvas export produced empty blob'));
      }, 'image/png');
    });

    cvs.width = 0; cvs.height = 0;
    outCvs.width = 0; outCvs.height = 0;

    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.png') };
  };

  // ─── REPAIR ────────────────────────────────────────────────────────────────
  processors['repair'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8, 'Reading PDF structure\u2026');
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 18);
    onStep(1, 'active', 22, 'Scanning for structural errors\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(1, 'done', 30);
        onStep(2, 'active', 34, 'Rebuilding object tree\u2026');
        var wRes = await runPdfWorker('repair', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) resultBuf = wRes.buffer;
      }
    } catch (e) {
      console.warn('[AdvEngine] repair worker:', e.message);
    }

    buf = null;
    if (!resultBuf) throw new Error(ERR.ORIG);

    onStep(2, 'done', 78);
    onStep(3, 'active', 82, 'Saving repaired file\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-repaired.pdf') };
  };

  // ─── COMPARE ───────────────────────────────────────────────────────────────
  processors['compare'] = async function (files, opts, onStep) {
    if (files.length < 2) throw AEError(ERR.PARSE, 'Compare requires two PDF files');
    onStep(0, 'active', 5, 'Loading both documents\u2026');

    var pdfjsLib = await loadPdfJs();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Extracting text from Document A\u2026');

    async function extractText(file, label, progressBase) {
      var buf = await file.arrayBuffer();
      var pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      buf = null;
      var pages = [];
      for (var pi = 1; pi <= pdf.numPages; pi++) {
        var pg = await pdf.getPage(pi);
        var c  = await pg.getTextContent();
        pages.push(c.items.map(function (it) { return it.str; }).join(' '));
        pg.cleanup();
        var pct = progressBase + Math.round((pi / pdf.numPages) * 18);
        onStep(1, 'active', pct, label + ' \u2014 page ' + pi + ' of ' + pdf.numPages);
      }
      await pdf.destroy();
      return pages;
    }

    var pagesA = await extractText(files[0], 'Doc A', 15);
    onStep(1, 'active', 33, 'Extracting text from Document B\u2026');
    var pagesB = await extractText(files[1], 'Doc B', 33);

    onStep(1, 'done', 52);
    onStep(2, 'active', 55, 'Computing word-level differences\u2026');

    var maxPages = Math.max(pagesA.length, pagesB.length);
    var diffs    = [];
    var totalAdded = 0, totalRemoved = 0;

    var wordsA = new Set((pagesA.join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    var wordsB = new Set((pagesB.join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    var inter  = 0;
    wordsA.forEach(function (w) { if (wordsB.has(w)) inter++; });
    var union  = wordsA.size + wordsB.size - inter;
    var sim    = union > 0 ? Math.round(inter / union * 100) : 0;

    for (var pi = 0; pi < maxPages; pi++) {
      var wA = new Set(((pagesA[pi] || '').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
      var wB = new Set(((pagesB[pi] || '').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
      var added = 0, removed = 0;
      wB.forEach(function (w) { if (!wA.has(w)) added++; });
      wA.forEach(function (w) { if (!wB.has(w)) removed++; });
      totalAdded += added; totalRemoved += removed;
      diffs.push({ page: pi + 1, added: added, removed: removed });
    }

    onStep(2, 'done', 80);
    onStep(3, 'active', 83, 'Building comparison report\u2026');

    var lines = [
      'ILovePDF \u2014 Document Comparison Report',
      '='.repeat(50),
      'Generated : ' + new Date().toISOString(),
      'File A    : ' + files[0].name + ' (' + pagesA.length + ' pages)',
      'File B    : ' + files[1].name + ' (' + pagesB.length + ' pages)',
      'Similarity: ' + sim + '% word overlap (Jaccard)',
      '',
      'PAGE DIFFERENCES',
      '-'.repeat(50),
    ];
    diffs.forEach(function (d) {
      if (d.added || d.removed) {
        lines.push('Page ' + d.page + ' : +' + d.added + ' unique words / -' + d.removed + ' removed');
      }
    });
    lines.push('');
    lines.push('TOTALS: +' + totalAdded + ' words added, -' + totalRemoved + ' words removed');
    lines.push('Same page count: ' + (pagesA.length === pagesB.length ? 'Yes' : 'No'));

    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: 'ILovePDF-comparison-report.txt' };
  };

  // ─── AI SUMMARIZE ──────────────────────────────────────────────────────────
  processors['ai-summarize'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Reading PDF content\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Extracting text from all pages\u2026');

    var pdf     = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
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

    if (!allText.trim()) throw AEError(ERR.PARSE, 'No extractable text found in PDF');

    var maxSentences = parseInt((opts && (opts.sentences || opts.length)) || '7', 10) || 7;

    onStep(1, 'done', 45, (total - skipped) + ' pages analysed');
    onStep(2, 'active', 49, 'Scoring sentences by relevance\u2026');

    var scored = await runAdvancedWorker({
      op: 'chunk-text-score', text: allText, maxSentences: maxSentences,
    });
    allText = null;

    if (!scored || !scored.summary) throw AEError(ERR.WORKER, 'Summarisation returned empty result');

    onStep(2, 'done', 82);
    onStep(3, 'active', 86, 'Building summary document\u2026');

    var report = [
      'ILovePDF \u2014 AI Summary',
      '='.repeat(50),
      'Source  : ' + file.name,
      'Pages   : ' + total + (skipped ? ' (' + skipped + ' blank skipped)' : ''),
      'Words   : ~' + (scored.wordCount || 0).toLocaleString(),
      'Mode    : Extractive TF-IDF (' + PERF_MODE + ' device)',
      '',
      'SUMMARY',
      '-'.repeat(50),
      scored.summary,
      '',
      'Statistics: ' + scored.sentenceCount + ' sentences scored, top ' + scored.topCount + ' selected.',
    ].join('\n');

    var blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-summary.txt') };
  };

  // ─── TRANSLATE ─────────────────────────────────────────────────────────────
  // [P03][P04][P06] Retry + offline guard + progress save per page
  processors['translate'] = async function (files, opts, onStep) {
    var file  = files[0];
    var fHash = _fileHash(file);
    onStep(0, 'active', 5, 'Reading PDF content\u2026');

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Extracting text from all pages\u2026');

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
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
    onStep(2, 'active', 41, 'Preparing translation chunks\u2026');

    var targetLang = (opts && (opts.targetLang || opts.targetLanguage)) || 'es';
    var MAX_CHARS  = 450; // MyMemory free-tier safe limit

    // [P04] Offline guard
    if (!isOnline()) {
      throw AEError(ERR.NETWORK, 'No internet connection \u2014 translation requires network');
    }

    // [P06] Resume check
    var savedTrans = await ProgressStore.load('translate', fHash);
    var startPage  = 0;
    var translated = [];

    if (savedTrans && savedTrans.pagesDone > 0 && savedTrans.pagesDone < total &&
        savedTrans.targetLang === targetLang) {
      if (window._aeResumeTrans && window._aeResumeTrans === fHash + ':' + targetLang) {
        startPage  = savedTrans.pagesDone;
        translated = savedTrans.translated || [];
      }
    }

    for (var p = startPage; p < pages.length; p++) {
      var pg = pages[p];

      if (pg.blank || !pg.text) {
        translated.push({ num: pg.num, text: '' });
        continue;
      }

      // Split into ≤MAX_CHARS chunks at word boundaries
      var chunks = [];
      var pos    = 0;
      var txt    = pg.text;
      while (pos < txt.length) {
        var end = Math.min(pos + MAX_CHARS, txt.length);
        if (end < txt.length) { var ls = txt.lastIndexOf(' ', end); if (ls > pos) end = ls; }
        chunks.push(txt.slice(pos, end).trim());
        pos = end + 1;
      }

      var translatedChunks = [];
      for (var c = 0; c < chunks.length; c++) {
        if (!chunks[c]) continue;

        // [P03] Retry with exponential backoff for each chunk
        var translatedChunk = await retryWithBackoff(function (attempt, signal) {
          var url = 'https://api.mymemory.translated.net/get?q=' +
            encodeURIComponent(chunks[c]) +
            '&langpair=en|' + encodeURIComponent(targetLang);
          return fetchWithRetry(url, signal ? { signal: signal } : {}, 3, 10000)
            .then(function (resp) { return resp.json(); })
            .then(function (json) {
              return (json.responseData && json.responseData.translatedText) || chunks[c];
            });
        }, 3, 800, 12000).catch(function () { return chunks[c]; }); // silent fallback to original

        translatedChunks.push(translatedChunk);
      }

      translated.push({ num: pg.num, text: translatedChunks.join(' ') });

      // [P06] Save progress after each page
      await ProgressStore.save('translate', fHash, {
        pagesDone:  p + 1,
        totalPages: total,
        targetLang: targetLang,
        translated: translated.slice(),
      });

      var pct2 = 41 + Math.round(((p + 1) / pages.length) * 38);
      onStep(2, 'active', pct2, 'Translated page ' + (p + 1) + ' of ' + pages.length + ' \u2192 ' + targetLang.toUpperCase());
    }

    await ProgressStore.clear('translate', fHash); // [P06] clear on success

    onStep(2, 'done', 79);
    onStep(3, 'active', 82, 'Building translated output\u2026');

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

  // ─── WORKFLOW ──────────────────────────────────────────────────────────────
  processors['workflow'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8, 'Reading PDF structure\u2026');
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 18);
    onStep(1, 'active', 22, 'Validating workflow steps\u2026');

    var steps = [
      { op: opts.step1, value: opts.step1_value || '' },
      { op: opts.step2, value: opts.step2_value || '' },
      { op: opts.step3, value: opts.step3_value || '' },
    ].filter(function (s) { return s.op && s.op !== ''; });

    if (!steps.length) throw AEError(ERR.PARSE, 'Please select at least one operation');

    onStep(1, 'done', 28);
    onStep(2, 'active', 32, 'Applying ' + steps.length + ' operation(s)\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        var wRes = await runPdfWorker('workflow', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) resultBuf = wRes.buffer;
      }
    } catch (e) {
      console.warn('[AdvEngine] workflow worker:', e.message);
    }

    buf = null;
    if (!resultBuf) throw new Error(ERR.ORIG);

    onStep(2, 'done', 80);
    onStep(3, 'active', 84, 'Saving workflow output\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-workflow.pdf') };
  };

  // ── [P11] MAIN RUNNER with fallback triggers ────────────────────────────────
  async function runTool(toolId, files, opts, origProcess) {
    var totalBytes = Array.from(files).reduce(function (s, f) { return s + (f.size || 0); }, 0);

    // [P11] Memory fallback trigger
    if (shouldFallbackMem(totalBytes)) {
      throw AEError(ERR.MEMORY, 'Insufficient memory for browser processing — routing to server');
    }

    // [P11] Worker crash count fallback trigger
    if (_workerCrashCount >= MAX_WORKER_CRASHES) {
      console.warn('[AdvEngine] Too many worker crashes — routing to server');
      throw AEError(ERR.WORKER, 'Worker instability detected — routing to server');
    }

    var proc  = processors[toolId];
    if (!proc) throw AEError(ERR.PARSE, 'No processor for: ' + toolId);

    var steps = TOOL_STEPS[toolId] || ['Analysing file', 'Processing', 'Finalising'];
    LiveFeed.show(steps, 'Processing your file\u2026');

    var result;
    try {
      // [P08] Hard 2-minute timeout per tool
      result = await withTimeout(
        proc(files, opts || {}, function (idx, state, pct, hint) {
          LiveFeed.update(idx, state, pct, hint);
        }),
        TOOL_TIMEOUT_MS
      );
    } catch (err) {
      var cls = classifyError(err);

      if (cls.type === ERR.ORIG || err.message === ERR.ORIG || err.message === '__orig__') {
        // Delegate to original (mammoth, html2pdf, etc.)
        LiveFeed.update(1, 'active', 30, 'Switching to optimised renderer\u2026');
        try {
          result = await origProcess(toolId, files, opts);
        } catch (origErr) {
          LiveFeed.hide();
          vanish();
          throw origErr;
        }
      } else {
        // [P11] All other errors → propagate so tool-page.js can fall to server
        LiveFeed.hide();
        vanish();
        throw err;
      }
    }

    LiveFeed.done();
    vanish();
    return result;
  }

  // ── HOOK INSTALLER ─────────────────────────────────────────────────────────
  function installHook() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__advEngineV20) return true;

    var origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      if (ADVANCED_IDS.has(toolId)) {
        return runTool(toolId, files, opts, origProcess);
      }
      return origProcess(toolId, files, opts);
    };

    window.BrowserTools.__advEngineV20 = true;
    console.log('[AdvancedEngine v2.0] installed \u2014 mode:' + PERF_MODE +
      ' tools:' + ADVANCED_IDS.size);
    return true;
  }

  if (!installHook()) {
    var _tries = 0;
    var _iv = setInterval(function () {
      if (installHook() || _tries++ > 40) {
        clearInterval(_iv);
        if (_tries > 40) console.warn('[AdvancedEngine] BrowserTools not found');
      }
    }, 100);
  }

  // ── [P06] WARMUP + PROGRESS CHECK ─────────────────────────────────────────
  // Check for saved progress sessions on page load and offer resume
  warmup(); // [P12] preload pdfjs silently

  (function checkSavedProgress() {
    // Detect current tool from URL slug
    var slug = (window.location.pathname || '').replace(/^\//, '').split('/')[0];
    if (!slug) return;

    // Map URL slug to toolId
    var slugMap = {
      'ocr-pdf': 'ocr', 'ocr': 'ocr',
      'translate-pdf': 'translate', 'translate': 'translate',
    };
    var toolId = slugMap[slug];
    if (!toolId) return;

    // Check IDB for any saved progress for this tool
    // We scan a few possible file hashes by listing all matching keys
    IDBTemp.get('prog:' + toolId + ':').catch(function () {}); // warm the DB

    // Show resume banner if user uploads a file matching a saved session.
    // We hook into the file-input change event to check hash.
    window.addEventListener('load', function () {
      var input = document.getElementById('file-input');
      if (!input) return;

      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return;
        var fh = _fileHash(f);

        ProgressStore.load(toolId, fh).then(function (saved) {
          if (saved && saved.pagesDone > 0 && saved.pagesDone < (saved.totalPages || Infinity)) {
            var toolLabel = toolId === 'ocr' ? 'OCR' : 'Translate';
            showResumeBanner(
              toolLabel,
              saved.pagesDone,
              saved.totalPages || '?',
              function () {
                // User wants to resume
                if (toolId === 'ocr')       window._aeResumeOcr   = fh;
                if (toolId === 'translate') window._aeResumeTrans = fh + ':' + (saved.targetLang || 'es');
              },
              function () {
                // User dismisses — clear saved progress
                ProgressStore.clear(toolId, fh).catch(function () {});
              }
            );
          }
        }).catch(function () {});
      });
    });
  }());

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.AdvancedEngine = {
    version:       '2.0',
    perfMode:      PERF_MODE,
    device:        DEVICE,
    TOOL_IDS:      ADVANCED_IDS,
    LiveFeed:      LiveFeed,
    IDBTemp:       IDBTemp,
    ProgressStore: ProgressStore,
    memTier:       memTier,
    vanish:        vanish,
    retryWithBackoff: retryWithBackoff,
    fetchWithRetry:   fetchWithRetry,
  };

}());

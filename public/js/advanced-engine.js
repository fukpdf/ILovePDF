// Advanced Engine v3.0 — production-grade, stealth browser PDF processor.
// Phases: 1-Worker Pool | 2-Stream | 3-Compression | 4-SAB | 5-WebGPU (worker)
//         6-MultiTab | 7-Pipeline | 8-LivePreview | 9-Estimator | 10-500MB
//         11-UX | 12-Performance
// Wraps window.BrowserTools.process() transparently. Instant tools untouched.
(function () {
  'use strict';

  // ── ADAPTIVE DEVICE PROFILE ────────────────────────────────────────────────
  var _cores  = Math.min(navigator.hardwareConcurrency || 2, 16);
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

  var PERF_LABEL = PERF_MODE === 'high'   ? 'Performance: Optimal'   :
                   PERF_MODE === 'medium' ? 'Performance: Moderate'  : 'Performance: High Load';

  var HARD_MAX_WORKERS = 4;
  var HARD_MAX_IMG_DIM = 4096;
  var CHUNK_SIZE       = DEVICE.chunkMB * 1024 * 1024;
  var TOOL_TIMEOUT_MS  = 180000; // 3 min (up from 2 min for large files)

  // Phase 10: Tiered size thresholds (500MB capable)
  var OPFS_THRESHOLD        = 200 * 1024 * 1024; // 200 MB → OPFS staging
  var OPFS_STREAM_THRESHOLD = 400 * 1024 * 1024; // 400 MB → streaming strict mode
  var MAX_BROWSER_BYTES     = 500 * 1024 * 1024; // 500 MB → absolute max

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
    e.aeType = type; e.isInternal = true;
    return e;
  }

  function safeMessage(err) {
    if (!err) return 'Something went wrong. Please try again.';
    var t = err.aeType || '';
    var m = (err.message || '').toLowerCase();
    var raw = err.message || '';

    if (t === ERR.ORIG || m === '__orig__') return null;

    if (t === ERR.NETWORK || m.includes('offline') || m.includes('no internet'))
      return 'No internet connection. Please check your connection and try again.';

    if (m.includes('requires two') || m.includes('please upload two'))
      return 'Please upload two PDF files to compare.';

    // Scanned / no-text documents — guide user to OCR
    if (m.includes('no extractable text') || m.includes('no_extractable_text') ||
        m.includes('image-based') || m.includes('scanned document') ||
        m.includes('no selectable text')) {
      // Forward helpful messages as-is if they're short and user-friendly
      if (raw.length > 10 && raw.length < 250 && !raw.includes('__') &&
          !raw.toLowerCase().includes('wasm') && !raw.toLowerCase().includes('worker'))
        return raw.charAt(0).toUpperCase() + raw.slice(1);
      return 'No selectable text found. For scanned documents, use the OCR tool to extract content.';
    }

    if (m.includes('please select'))
      return 'Please select at least one operation to continue.';

    if (m.includes('file_too_large') || m.includes('too large to process'))
      return 'This file is too large to process. Please use a smaller file.';

    if (t === ERR.TIMEOUT || m.includes('tool_timeout') || m.includes('timeout'))
      return 'Processing is taking too long. Please try with a shorter document.';

    if (m.includes('engine_load') || m.includes('pdfjs_load') || m.includes('failed to load'))
      return 'A required component could not be loaded. Please check your connection and try again.';

    if (m.includes('memory_pressure') || (m.includes('memory') && !m.includes('my')))
      return 'Your device is running low on memory. Please close other tabs and try again.';

    if (m.includes('empty') && (m.includes('output') || m.includes('result') || m.includes('appear')))
      return 'The result appears empty. Please try again with a different file.';

    if (m.includes('build_failed') || m.includes('build failed'))
      return 'The document could not be assembled. Please try again.';

    if (m.includes('canvas encode') || m.includes('image_decode'))
      return 'Image processing failed. Please try a different file.';

    if (m.includes('image processing') || m.includes('decode failed'))
      return 'This image format is not supported. Please try a JPG or PNG file.';

    // Pass through short, user-readable messages that don't contain internal terms
    if (raw.length > 3 && raw.length < 220 &&
        !raw.includes('Worker') && !raw.includes('wasm') && !raw.includes('OPFS') &&
        !raw.includes('chunk') && !raw.includes('ArrayBuffer') && !raw.includes('byteLength') &&
        !raw.includes('__') && !raw.toLowerCase().includes('undefined') &&
        !raw.toLowerCase().includes('null')) {
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }

    return 'Something went wrong. Please try again.';
  }

  // ── CAPABILITIES ──────────────────────────────────────────────────────────
  // Phase 4: Real SharedArrayBuffer detection (requires COOP+COEP headers)
  var HAS_SAB = (function () {
    try { return typeof SharedArrayBuffer !== 'undefined' && !!new SharedArrayBuffer(1); }
    catch (_) { return false; }
  }());

  // Phase 5: WebGPU detection (processing happens in advanced-worker.js)
  var HAS_WEBGPU = (function () {
    try { return typeof navigator !== 'undefined' && !!navigator.gpu; }
    catch (_) { return false; }
  }());

  // Phase 6: BroadcastChannel for multi-tab coordination
  var HAS_BC = (function () {
    try { return typeof BroadcastChannel !== 'undefined'; }
    catch (_) { return false; }
  }());

  // ── OPFS STORE ────────────────────────────────────────────────────────────
  var OPFSStore = (function () {
    var AVAIL = (function () {
      try {
        return typeof navigator !== 'undefined' &&
               typeof navigator.storage !== 'undefined' &&
               typeof navigator.storage.getDirectory === 'function';
      } catch (_) { return false; }
    }());
    var _root = null;

    function getRoot() {
      if (_root) return Promise.resolve(_root);
      return navigator.storage.getDirectory().then(function (r) { _root = r; return r; });
    }

    function write(name, buffer) {
      if (!AVAIL) return Promise.reject(new Error('opfs_unavail'));
      return getRoot()
        .then(function (root) { return root.getFileHandle(name, { create: true }); })
        .then(function (fh)   { return fh.createWritable(); })
        .then(function (wr)   { return wr.write(buffer).then(function () { return wr.close(); }); });
    }

    function getFile(name) {
      if (!AVAIL) return Promise.reject(new Error('opfs_unavail'));
      return getRoot()
        .then(function (root) { return root.getFileHandle(name); })
        .then(function (fh)   { return fh.getFile(); });
    }

    function del(name) {
      if (!AVAIL) return Promise.resolve();
      return getRoot()
        .then(function (root) { return root.removeEntry(name); })
        .catch(function () {});
    }

    function available() { return AVAIL; }
    return { available: available, write: write, getFile: getFile, del: del };
  }());

  // Stage a File to OPFS and return { url, cleanup }
  async function stageToOPFS(file) {
    var key = 'ae_stage_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    var buf = await file.arrayBuffer();
    await OPFSStore.write(key, buf);
    buf = null;
    var opfsFile = await OPFSStore.getFile(key);
    var url = URL.createObjectURL(opfsFile);
    trackBlob(url);
    return {
      url: url,
      cleanup: function () {
        try { URL.revokeObjectURL(url); } catch (_) {}
        OPFSStore.del(key);
      }
    };
  }

  // ── MEMORY GUARD ──────────────────────────────────────────────────────────
  var MEM_REDUCE = 550 * 1024 * 1024;
  var MEM_LOW    = 720 * 1024 * 1024;
  var MEM_ABORT  = 900 * 1024 * 1024;

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
    // Phase 10: 500MB files always use OPFS + streaming — no RAM fallback
    if (fileSizeBytes >= MAX_BROWSER_BYTES) return true;
    if (memTier() === 'fallback') return true;
    var factor = (memTier() === 'low') ? 6 : 4;
    var needed = (fileSizeBytes || 0) * factor;
    var avail  = Math.max(0, _memLimit() - _memUsed());
    // With OPFS streaming, large files need much less RAM — but still honour fallback tier
    if (fileSizeBytes >= OPFS_STREAM_THRESHOLD && OPFSStore.available() && memTier() !== 'fallback') return false;
    return needed > avail;
  }

  // ── IDB TEMP STORE ────────────────────────────────────────────────────────
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

  // ── PROGRESS STORE ────────────────────────────────────────────────────────
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

  // ── RESUME BANNER ─────────────────────────────────────────────────────────
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
      '<button id="ae-rb-no" style="background:transparent;color:#94a3b8;border:none;padding:6px 8px;cursor:pointer;font-size:18px;line-height:1">\u00d7</button>';
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

  // ── RETRY SYSTEM ──────────────────────────────────────────────────────────
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
        clearTimeout(timer); return r;
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
          if (resp.status === 429 || resp.status >= 500) throw AEError(ERR.NETWORK, 'http_' + resp.status);
          throw AEError(ERR.NETWORK, 'http_' + resp.status + '_noretry');
        }
        return resp;
      });
    }, maxRetries || 3, 800, timeoutMs || 10000);
  }

  // ── WORKER BRIDGE (Phase 1: uses persistent pool for BOTH workers) ────────
  // Phase 1: advanced-worker now runs via persistent pool — importScripts
  // runs once per slot, libraries cached in worker memory across tasks.
  function runAdvancedWorker(message, transferables) {
    var pool = window.WorkerPool;
    if (!pool) return Promise.reject(AEError(ERR.WORKER, 'pool_unavailable'));
    return pool.run('/workers/advanced-worker.js', message, transferables || []);
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
    ProgressSmoother.reset(); // Cancel any pending RAF to avoid post-navigation animation
    var entries = _blobEntries.splice(0);
    entries.forEach(function (e) { try { URL.revokeObjectURL(e.url); } catch (_) {} });
    var keys = _tempKeys.splice(0);
    keys.forEach(function (k) { IDBTemp.del(k).catch(function () {}); });
  }

  window.addEventListener('beforeunload', vanish);
  window.addEventListener('popstate',     vanish);

  var BLOB_MAX_AGE = 5 * 60 * 1000;
  function backgroundClean() {
    IDBTemp.sweep().catch(function () {});
    var cutoff = Date.now() - BLOB_MAX_AGE;
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
    var _cur = 0, _tgt = 0, _raf = null;

    function _tick() {
      var bar = document.getElementById('ae-bar');
      if (!bar) { _raf = null; return; }
      var diff = _tgt - _cur;
      if (Math.abs(diff) < 0.15) {
        _cur = _tgt; bar.style.width = _tgt + '%'; _raf = null; return;
      }
      _cur += diff * 0.09;
      bar.style.width = _cur.toFixed(1) + '%';
      _raf = requestAnimationFrame(_tick);
    }

    return {
      set: function (pct) {
        _tgt = Math.min(100, Math.max(_cur, pct));
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

  // ── TIME ESTIMATOR ────────────────────────────────────────────────────────
  var _timerIv = null;
  function startTimeEstimator() {
    var start = Date.now();
    _timerIv = setInterval(function () {
      var elapsed = (Date.now() - start) / 1000;
      var hint;
      if      (elapsed > 90) hint = 'Finalizing\u2026';
      else if (elapsed > 50) hint = 'Just a moment more\u2026';
      else if (elapsed > 22) hint = 'Almost done\u2026';
      else return;
      var hEl = document.getElementById('ae-hint');
      if (hEl && !hEl._locked) hEl.textContent = hint;
    }, 5000);
  }
  function stopTimeEstimator() {
    if (_timerIv) { clearInterval(_timerIv); _timerIv = null; }
  }

  // ── PHASE 9: OUTPUT SIZE ESTIMATOR ────────────────────────────────────────
  // Shows estimated output size + processing time BEFORE the job starts.
  // Formulas are heuristic; shown stealth-style — no technical details.
  var OutputEstimator = (function () {
    var TABLE = {
      'compress':          { sizeRatio: 0.45, secondsPer10MB: 3  },
      'pdf-to-word':       { sizeRatio: 0.20, secondsPer10MB: 5  },
      'pdf-to-excel':      { sizeRatio: 0.15, secondsPer10MB: 5  },
      'pdf-to-powerpoint': { sizeRatio: 0.18, secondsPer10MB: 6  },
      'ocr':               { sizeRatio: 0.05, secondsPer10MB: 40 },
      'background-remover':{ sizeRatio: 1.20, secondsPer10MB: 4  },
      'repair':            { sizeRatio: 1.00, secondsPer10MB: 4  },
      'compare':           { sizeRatio: 0.02, secondsPer10MB: 6  },
      'ai-summarize':      { sizeRatio: 0.01, secondsPer10MB: 5  },
      'translate':         { sizeRatio: 0.05, secondsPer10MB: 15 },
      'workflow':          { sizeRatio: 0.90, secondsPer10MB: 5  },
    };

    function fmtSize(bytes) {
      if (bytes < 1024)          return bytes + ' B';
      if (bytes < 1024 * 1024)   return Math.round(bytes / 1024) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function fmtTime(seconds) {
      if (seconds < 5)   return 'a few seconds';
      if (seconds < 60)  return 'about ' + Math.round(seconds) + 's';
      if (seconds < 120) return 'about a minute';
      return 'about ' + Math.round(seconds / 60) + ' minutes';
    }

    function estimate(toolId, totalBytes) {
      var entry = TABLE[toolId];
      if (!entry || !totalBytes) return null;
      var estSize = Math.round(totalBytes * entry.sizeRatio);
      var estSecs = Math.max(2, Math.round((totalBytes / (10 * 1024 * 1024)) * entry.secondsPer10MB));
      return {
        sizeLabel: fmtSize(estSize),
        timeLabel: fmtTime(estSecs),
        estSecs:   estSecs,
      };
    }

    function show(toolId, totalBytes) {
      var est = estimate(toolId, totalBytes);
      if (!est) return;
      var hint  = document.getElementById('ae-hint');
      var exist = document.getElementById('ae-estimator');
      if (exist) exist.remove();
      var el = document.createElement('div');
      el.id = 'ae-estimator';
      el.style.cssText = 'font-size:11px;color:#7c3aed;text-align:center;padding:4px 0 2px;opacity:.85;';
      el.textContent = 'Estimated output: ~' + est.sizeLabel + ' \u2022 Processing time: ~' + est.timeLabel;
      if (hint && hint.parentNode) hint.parentNode.insertBefore(el, hint);
    }

    function hide() {
      var el = document.getElementById('ae-estimator');
      if (el) el.remove();
    }

    return { show: show, hide: hide, estimate: estimate };
  }());

  // ── PHASE 8: LIVE PREVIEW THUMBNAIL ───────────────────────────────────────
  // Renders the first page of a PDF to a tiny thumbnail shown during processing.
  var LivePreview = (function () {
    var _shown = false;

    function show(pdfDoc, pdfjsLib) {
      if (_shown) return;
      _shown = true;
      // Non-blocking: render in next microtask
      Promise.resolve().then(async function () {
        try {
          var page     = await pdfDoc.getPage(1);
          var viewport = page.getViewport({ scale: 0.15 });
          var cvs      = document.createElement('canvas');
          cvs.width    = Math.floor(viewport.width);
          cvs.height   = Math.floor(viewport.height);
          var ctx      = cvs.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, cvs.width, cvs.height);
          await page.render({ canvasContext: ctx, viewport: viewport }).promise;
          page.cleanup();

          var previewEl = document.getElementById('ae-preview');
          if (!previewEl) {
            previewEl    = document.createElement('div');
            previewEl.id = 'ae-preview';
            previewEl.style.cssText = [
              'text-align:center;margin:8px 0 4px;opacity:.8;',
              'display:flex;align-items:center;justify-content:center;gap:8px;',
            ].join('');
            var feed = document.getElementById('ae-feed');
            if (feed) {
              var hint = document.getElementById('ae-hint');
              hint ? feed.insertBefore(previewEl, hint) : feed.appendChild(previewEl);
            }
          }

          cvs.style.cssText = 'border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.2);max-width:60px;height:auto;';
          var label = document.createElement('span');
          label.style.cssText = 'font-size:10px;color:#9ca3af;';
          label.textContent = 'Preview';
          previewEl.innerHTML = '';
          previewEl.appendChild(cvs);
          previewEl.appendChild(label);
        } catch (_) { /* silent — preview is non-critical */ }
      });
    }

    function hide() {
      _shown = false;
      var el = document.getElementById('ae-preview');
      if (el) el.remove();
    }

    function reset() { hide(); }

    return { show: show, hide: hide, reset: reset };
  }());

  // ── PHASE 6: MULTI-TAB COORDINATOR (BroadcastChannel) ────────────────────
  // Responds to peer pings so other tabs can detect this tab.
  // Work-splitting is not implemented — dispatcher always returns false
  // to avoid adding 600ms discovery delay to every tool invocation.
  var TabCoordinator = (function () {
    var CHANNEL  = 'ilovepdf-work-v3';
    var _myTabId = Math.random().toString(36).slice(2);
    var _bc      = null;

    function init() {
      if (!HAS_BC) return;
      try {
        _bc = new BroadcastChannel(CHANNEL);
        _bc.onmessage = function (e) {
          var msg = e.data || {};
          // Respond to pings so other tabs count us as a peer
          if (msg.type === 'ping' && msg.tabId !== _myTabId) {
            _bc.postMessage({ type: 'pong', tabId: _myTabId });
          }
        };
      } catch (_) {}
    }

    // canSplit is disabled — returns false immediately without 600ms wait
    function canSplit() { return Promise.resolve(false); }

    init();
    return { canSplit: canSplit };
  }());

  // ── PHASE 7: PAGE PREFETCH PIPELINE ───────────────────────────────────────
  // For sequential page tools: preloads page N+1 while processing page N,
  // eliminating the idle gap between page loads.
  function makePrefetcher(pdf) {
    var _prefetchCache = {};

    function prefetch(pageNum) {
      if (_prefetchCache[pageNum]) return;
      _prefetchCache[pageNum] = pdf.getPage(pageNum)
        .then(function (pg) {
          return pg.getTextContent().then(function (c) {
            return { page: pg, content: c };
          });
        })
        .catch(function () { delete _prefetchCache[pageNum]; });
    }

    function getPage(pageNum, nextPageNum) {
      // Trigger prefetch of next page immediately
      if (nextPageNum) prefetch(nextPageNum);

      // Return current page (may be cached from previous prefetch)
      if (_prefetchCache[pageNum]) {
        var p = _prefetchCache[pageNum];
        delete _prefetchCache[pageNum];
        return p;
      }
      return pdf.getPage(pageNum).then(function (pg) {
        return pg.getTextContent().then(function (c) {
          return { page: pg, content: c };
        });
      });
    }

    // Dispose any pre-fetched but unconsumed pages to avoid leaking PDF resources
    function dispose() {
      var keys = Object.keys(_prefetchCache);
      for (var i = 0; i < keys.length; i++) {
        var p = _prefetchCache[keys[i]];
        delete _prefetchCache[keys[i]];
        if (p && typeof p.then === 'function') {
          p.then(function (data) {
            if (data && data.page && typeof data.page.cleanup === 'function') {
              try { data.page.cleanup(); } catch (_) {}
            }
          }).catch(function () {});
        }
      }
    }

    return { getPage: getPage, prefetch: prefetch, dispose: dispose };
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
    }).catch(function () {
      _pdfJsPromise = null;
      throw AEError(ERR.NETWORK, 'pdfjs_load_failed');
    });
    return _pdfJsPromise;
  }

  // Phase 10: Enhanced PDF source loader — three tiers based on file size
  // <200MB  → in-RAM ArrayBuffer (fastest for small files)
  // 200-400MB → OPFS staging (halves peak RAM via streaming URL)
  // 400-500MB → OPFS + streaming strict mode (process 1 page at a time)
  async function loadPdfSource(file) {
    var size = file.size || 0;

    if (size >= OPFS_THRESHOLD && OPFSStore.available()) {
      try {
        var staged = await stageToOPFS(file);
        var strictMode = size >= OPFS_STREAM_THRESHOLD;
        return {
          src: { url: staged.url, isEvalSupported: false },
          cleanup: staged.cleanup,
          strictStreaming: strictMode, // Phase 10: single-page mode flag
        };
      } catch (_) {
        // OPFS write failed — fall through to in-RAM
      }
    }

    var buf = await file.arrayBuffer();
    return {
      src: { data: buf, isEvalSupported: false },
      cleanup: function () { buf = null; },
      strictStreaming: false,
    };
  }

  var _scriptLoads = {};
  function loadScript(url) {
    if (_scriptLoads[url]) return _scriptLoads[url];
    _scriptLoads[url] = new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + url + '"]')) return res();
      var s = document.createElement('script');
      s.src = url;
      s.onload  = res;
      s.onerror = function () { delete _scriptLoads[url]; rej(AEError(ERR.NETWORK, 'script_load_failed')); };
      document.head.appendChild(s);
    });
    return _scriptLoads[url];
  }

  function isPageBlank(textContent) {
    var combined = (textContent.items || []).map(function (it) { return it.str; }).join('');
    return combined.replace(/\s/g, '').length < 5;
  }

  // ── LIVE FEED (UI panel) ───────────────────────────────────────────────────
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
      '.ae-step[data-s="active"] .ae-dot{background:#7c3aed;animation:ae-pulse .9s ease-in-out infinite;}',
      '.ae-step[data-s="done"] .ae-dot{background:#10b981;}',
      '.ae-step[data-s="error"] .ae-dot{background:#ef4444;}',
      '@keyframes ae-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.ae-bar-wrap{height:6px;background:#ddd6fe;border-radius:3px;overflow:hidden;margin-bottom:6px;}',
      '.ae-bar-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#a78bfa);',
        'border-radius:3px;width:0;transition:width .1s;}',
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

      var titleEl = document.getElementById('processing-title');
      var msgEl   = document.getElementById('processing-msg');
      if (titleEl) titleEl.textContent = this._title;
      if (msgEl)   msgEl.textContent   = 'Preparing your file\u2026';

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
            'Your file is processed securely \u2014 automatically deleted after use' +
          '</div>' +
          '<div class="ae-perf">' + _escHtml(PERF_LABEL) + '</div>' +
        '</div>';

      ProgressSmoother.reset();
      LivePreview.reset();
      startTimeEstimator();
    },

    update: function (idx, state, pct, hint) {
      // Phase 11: update overlay with human-friendly messages
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) {
        var label = this._steps[idx] || '';
        if (state === 'active' && hint) {
          msgEl.textContent = label + ' \u2014 ' + hint;
        } else if (state === 'active') {
          msgEl.textContent = label + '\u2026';
        } else if (state === 'done' && idx === this._steps.length - 1) {
          msgEl.textContent = 'Finalizing output\u2026';
        }
      }

      var step = document.getElementById('ae-s-' + idx);
      if (step) step.setAttribute('data-s', state);

      if (typeof pct === 'number') ProgressSmoother.set(pct);

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
      LivePreview.hide();
      OutputEstimator.hide();
      _feedActive = false;
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) msgEl.textContent = 'This usually takes only a few seconds.';
    },

    hide: function () {
      stopTimeEstimator();
      LivePreview.hide();
      OutputEstimator.hide();
      _feedActive = false;
    },
  };

  // ── PRELOAD WARMUP ────────────────────────────────────────────────────────
  function warmup() {
    setTimeout(function () {
      loadPdfJs().catch(function () {});
      // Phase 1: pre-warm worker slots so first task is faster
      if (window.WorkerPool) {
        window.WorkerPool.prewarm && window.WorkerPool.prewarm('/workers/pdf-worker.js');
        window.WorkerPool.prewarm && window.WorkerPool.prewarm('/workers/advanced-worker.js');
      }
    }, 800);
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

  // ── PDF→WORD: HEADING + PARAGRAPH EXTRACTOR ───────────────────────────────
  function extractStructuredParagraphs(items) {
    if (!items || !items.length) return [];
    var heights = [];
    items.forEach(function (it) {
      var h = Math.abs(it.transform[3]);
      if (h > 0 && it.str.trim()) heights.push(h);
    });
    heights.sort(function (a, b) { return a - b; });
    var medianH = heights[Math.floor(heights.length / 2)] || 10;

    var lineMap = {};
    items.forEach(function (it) {
      if (!it.str.trim()) return;
      var yKey = Math.round(it.transform[5]);
      if (!lineMap[yKey]) lineMap[yKey] = [];
      lineMap[yKey].push(it);
    });

    var ys = Object.keys(lineMap).map(Number).sort(function (a, b) { return b - a; });
    var paragraphs = [];
    var lastY = null;

    ys.forEach(function (y) {
      var lineItems = lineMap[y].sort(function (a, b) { return a.transform[4] - b.transform[4]; });
      var lineText  = lineItems.map(function (it) { return it.str; }).join(' ').trim();
      if (!lineText) return;
      var maxH      = Math.max.apply(null, lineItems.map(function (it) { return Math.abs(it.transform[3]); }));
      var isHeading = maxH > medianH * 1.3;
      var gap        = lastY !== null ? lastY - y : 0;
      var isNewBlock = gap > medianH * 2.2 || isHeading;
      if (lastY === null || isNewBlock) {
        paragraphs.push({ text: lineText, isHeading: isHeading });
      } else {
        var last = paragraphs[paragraphs.length - 1];
        if (last) last.text += ' ' + lineText;
      }
      lastY = y;
    });
    return paragraphs;
  }

  // ── PDF→EXCEL: COLUMN CLUSTER DETECTOR ────────────────────────────────────
  function buildColumnRows(items) {
    if (!items || !items.length) return [];
    var xs = [];
    items.forEach(function (it) {
      if (it.str.trim()) xs.push(Math.round(it.transform[4]));
    });
    xs.sort(function (a, b) { return a - b; });
    var splits = [0];
    for (var xi = 1; xi < xs.length; xi++) {
      if (xs[xi] - xs[xi - 1] > 28) splits.push((xs[xi - 1] + xs[xi]) / 2);
    }
    splits.push(Infinity);

    function getColIdx(x) {
      for (var ci = 0; ci < splits.length - 1; ci++) {
        if (x >= splits[ci] && x < splits[ci + 1]) return ci;
      }
      return 0;
    }

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

  // ── TOOL STEPS (stealth labels — Phase 11 enhanced) ───────────────────────
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

  // ─── COMPRESS (Phase 3: enhanced multi-pass) ───────────────────────────────
  processors['compress'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    var buf = await file.arrayBuffer();
    onStep(0, 'done', 15);
    onStep(1, 'active', 18, 'Optimizing content\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(1, 'done', 25);
        onStep(2, 'active', 30, 'Applying improvements\u2026');
        var wRes = await runPdfWorker('compress', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          resultBuf = wRes.buffer;
        }
      }
    } catch (e) { /* silent — fallback below */ }
    buf = null;

    if (!resultBuf || resultBuf.byteLength >= file.size) {
      // PDF is already well-optimised — return the original with a clear message.
      onStep(2, 'done', 85);
      onStep(3, 'active', 90, 'File is already well\u2011optimised\u2026');
      var origBufFallback = await file.arrayBuffer();
      var origBlob = new Blob([origBufFallback], { type: 'application/pdf' });
      origBufFallback = null;
      onStep(3, 'done', 100);
      return {
        blob: origBlob,
        filename: brandedFilename(file.name, '.pdf'),
        alreadyOptimized: true,
      };
    }

    var saved = Math.round((1 - resultBuf.byteLength / file.size) * 100);
    onStep(2, 'done', 85);
    onStep(3, 'active', 88, 'Saved ' + saved + '% \u2014 finalizing\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pdf') };
  };

  // ─── PDF → WORD (Phase 7: prefetch pipeline + Phase 8: live preview) ──────
  processors['pdf-to-word'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    var pdfjsLib  = await loadPdfJs();
    var pdfSource = await loadPdfSource(file);
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf       = await pdfjsLib.getDocument(pdfSource.src).promise;
    var total     = pdf.numPages;
    var pages     = [];
    var prefetcher = makePrefetcher(pdf); // Phase 7: pipeline

    // Phase 8: live preview — render first page thumbnail
    LivePreview.show(pdf, pdfjsLib);

    try {
      for (var i = 1; i <= total; i++) {
        // Phase 7: get current page (may be pre-fetched) + trigger next prefetch
        var pageData = await prefetcher.getPage(i, i + 1);
        var content  = pageData.content;

        if (isPageBlank(content)) { pageData.page.cleanup(); continue; }

        var paragraphs = extractStructuredParagraphs(content.items);
        pages.push({ pageNum: i, paragraphs: paragraphs });
        pageData.page.cleanup(); // Phase 2: release immediately after use

        var pct = 15 + Math.round((i / total) * 38);
        onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
      }
    } finally {
      prefetcher.dispose(); // Clean up any unconsumed prefetched pages
      await pdf.destroy();  // Phase 2: full destroy — do this before revoking source URL
      pdfSource.cleanup();  // Revoke OPFS blob URL only after PDF is fully done
    }

    if (!pages.length) {
      // All pages appear image-based — guide the user to the OCR tool.
      throw new Error('This document appears to be image-based with no selectable text. Please use the OCR tool to extract content from scanned PDFs.');
    }

    // Even if some pages exist, check that we actually got meaningful content.
    var _totalWordChars = pages.reduce(function (s, p) {
      return s + p.paragraphs.reduce(function (ps, para) { return ps + (para.text || '').length; }, 0);
    }, 0);
    if (_totalWordChars < Math.max(8, total * 2)) {
      throw new Error('No selectable text was found. This PDF may contain scanned images — use the OCR tool to extract content.');
    }

    onStep(1, 'done', 53);
    onStep(2, 'active', 57, 'Building document\u2026');

    var wResult;
    try {
      wResult = await runAdvancedWorker({ op: 'build-docx', pages: pages });
    } catch (_) {}
    pages = null;
    // If worker failed for any reason, fall back to browser-tools.js pdfToWord
    if (!wResult || !wResult.buffer) throw new Error(ERR.ORIG);

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Finalizing output\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.docx') };
  };

  // ─── PDF → EXCEL (Phase 7: prefetch) ──────────────────────────────────────
  processors['pdf-to-excel'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    var pdfjsLib  = await loadPdfJs();
    var pdfSource = await loadPdfSource(file);
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf        = await pdfjsLib.getDocument(pdfSource.src).promise;
    var total      = pdf.numPages;
    var sheets     = [];
    var prefetcher = makePrefetcher(pdf); // Phase 7

    LivePreview.show(pdf, pdfjsLib); // Phase 8

    try {
      for (var i = 1; i <= total; i++) {
        var pageData = await prefetcher.getPage(i, i + 1);
        var content  = pageData.content;
        var rows     = isPageBlank(content) ? [['(empty)']] : buildColumnRows(content.items);
        sheets.push({ name: 'Page ' + i, rows: rows.length ? rows : [['(empty)']] });
        pageData.page.cleanup(); // Phase 2

        var pct = 15 + Math.round((i / total) * 40);
        onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
      }
    } finally {
      prefetcher.dispose();
      await pdf.destroy();
      pdfSource.cleanup();
    }

    // If every sheet is empty the PDF contains no extractable table data.
    var _allSheetsEmpty = sheets.every(function (s) {
      return s.rows.length === 0 ||
        (s.rows.length === 1 && s.rows[0].length === 1 && s.rows[0][0] === '(empty)');
    });
    if (_allSheetsEmpty) {
      throw new Error('No data could be extracted from this PDF. For scanned documents, try the OCR tool first to make the content selectable.');
    }

    onStep(1, 'done', 55);
    onStep(2, 'active', 58, 'Building spreadsheet\u2026');

    var wResult;
    try {
      wResult = await runAdvancedWorker({ op: 'build-xlsx', sheets: sheets });
    } catch (_) {}
    sheets = null;
    if (!wResult || !wResult.buffer) throw new Error(ERR.ORIG);

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Finalizing output\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.xlsx') };
  };

  // ─── PDF → POWERPOINT (Phase 7: prefetch) ─────────────────────────────────
  processors['pdf-to-powerpoint'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    var pdfjsLib  = await loadPdfJs();
    var pdfSource = await loadPdfSource(file);
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf        = await pdfjsLib.getDocument(pdfSource.src).promise;
    var total      = pdf.numPages;
    var slides     = [];
    var prefetcher = makePrefetcher(pdf); // Phase 7

    LivePreview.show(pdf, pdfjsLib); // Phase 8

    try {
      for (var i = 1; i <= total; i++) {
        var pageData = await prefetcher.getPage(i, i + 1);
        var content  = pageData.content;
        var items    = content.items;
        var biggest  = { str: '', h: 0 };

        if (!isPageBlank(content)) {
          items.forEach(function (it) {
            var h = Math.abs(it.transform[3]);
            if (h > biggest.h && it.str.trim()) biggest = { str: it.str, h: h };
          });
        }

        var bodyText = items
          .filter(function (it) { return it.str.trim() && it.str !== biggest.str; })
          .map(function (it)    { return it.str; }).join(' ').trim();

        slides.push({ pageNum: i, title: biggest.str || ('Slide ' + i), text: bodyText });
        pageData.page.cleanup(); // Phase 2

        var pct = 15 + Math.round((i / total) * 40);
        onStep(1, 'active', pct, 'Slide ' + i + ' of ' + total);
      }
    } finally {
      prefetcher.dispose();
      await pdf.destroy();
      pdfSource.cleanup();
    }

    onStep(1, 'done', 55);
    onStep(2, 'active', 58, 'Building presentation\u2026');

    var docTitle = file.name.replace(/\.[^.]+$/, '');
    var wResult;
    try {
      wResult = await runAdvancedWorker({ op: 'build-pptx', slides: slides, docTitle: docTitle });
    } catch (_) {}
    slides = null;
    if (!wResult || !wResult.buffer) throw new Error(ERR.ORIG);

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Finalizing output\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pptx') };
  };

  // ─── SENTINEL DELEGATORS ──────────────────────────────────────────────────
  processors['word-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Preparing your file\u2026'); throw new Error(ERR.ORIG); };
  processors['excel-to-pdf'] = async function (f, o, s) { s(0, 'active', 10, 'Preparing your file\u2026'); throw new Error(ERR.ORIG); };
  processors['html-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Preparing your document\u2026'); throw new Error(ERR.ORIG); };
  processors['scan-to-pdf']  = async function (f, o, s) { s(0, 'active', 10, 'Analyzing images\u2026'); throw new Error(ERR.ORIG); };

  // ─── OCR (Phase 7: pipeline + Phase 10: streaming strict for 400MB+) ──────
  processors['ocr'] = async function (files, opts, onStep) {
    var file  = files[0];
    var fHash = _fileHash(file);
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    var pdfjsLib  = await loadPdfJs();
    var pdfSource = await loadPdfSource(file);
    onStep(0, 'done', 12);

    var pdf   = await pdfjsLib.getDocument(pdfSource.src).promise;
    var total = pdf.numPages;

    // Phase 8: live preview for OCR
    LivePreview.show(pdf, pdfjsLib);

    // Fast path: check for native text layer
    onStep(1, 'active', 15, 'Analyzing document structure\u2026');
    var nativeText  = '';
    var nativeChars = 0;

    for (var ni = 1; ni <= total; ni++) {
      var np = await pdf.getPage(ni);
      var nc = await np.getTextContent();
      var t  = nc.items.map(function (it) { return it.str; }).join(' ');
      nativeText  += t + '\n';
      nativeChars += t.replace(/\s/g, '').length;
      np.cleanup(); // Phase 2
    }

    if (nativeChars > 60) {
      await pdf.destroy();
      pdfSource.cleanup(); // Safe to revoke now — PDF is fully done
      onStep(1, 'done', 50, 'Content ready');
      onStep(2, 'active', 60, 'Building document\u2026');

      // Build structured paragraphs from native text, one per page
      var nativePageTexts = nativeText.split('\n');
      var nativeParas = nativePageTexts.filter(function (l) { return l.trim(); }).map(function (l) {
        return { text: l.trim(), isHeading: false };
      });
      var nativeDocPages = [{ pageNum: 1, paragraphs: nativeParas.length ? nativeParas : [{ text: nativeText.trim(), isHeading: false }] }];

      try {
        var nWResult = await runAdvancedWorker({ op: 'build-docx', pages: nativeDocPages });
        if (nWResult && nWResult.buffer) {
          var nBlob = new Blob([nWResult.buffer], {
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          });
          onStep(2, 'done', 90);
          onStep(3, 'active', 93, 'Preparing result\u2026');
          onStep(3, 'done', 100);
          return { blob: nBlob, filename: brandedFilename(file.name, '.docx') };
        }
      } catch (_) {}

      // Fallback: return plain text
      onStep(2, 'done', 90);
      onStep(3, 'active', 93, 'Preparing result\u2026');
      var nTxtBlob = new Blob([nativeText.trim()], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);
      return { blob: nTxtBlob, filename: brandedFilename(file.name, '.txt') };
    }

    // Image-based: Tesseract OCR
    onStep(1, 'done', 22);
    onStep(2, 'active', 25, 'Processing content\u2026');

    if (!window.Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    }
    if (!window.Tesseract) throw AEError(ERR.NETWORK, 'engine_load_failed');

    var lang   = (opts && opts.language) || 'eng';
    var worker = await window.Tesseract.createWorker(lang, 1, { logger: function () {} });
    var scale  = DEVICE.ocrScale;

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

    // Phase 10: streaming strict mode for large files
    var strictStream = pdfSource.strictStreaming;

    try {
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
        var ctx    = cvs.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cvs.width, cvs.height);
        await pg.render({ canvasContext: ctx, viewport: capVp }).promise;
        pg.cleanup(); // Phase 2: release page immediately

        var dataUrl = cvs.toDataURL('image/jpeg', 0.92);
        cvs.width = 0; cvs.height = 0; cvs = null;

        var ocrResult = await worker.recognize(dataUrl);
        dataUrl = null;
        allLines.push('=== Page ' + i + ' ===\n' + ocrResult.data.text);

        await ProgressStore.save('ocr', fHash, {
          pagesDone: i, totalPages: total, lines: allLines.slice(),
        });

        var pct = 25 + Math.round((i / total) * 55);
        onStep(2, 'active', pct, 'Page ' + i + ' of ' + total);

        // Phase 10: in strict streaming mode, GC hint after each page
        if (strictStream && typeof gc === 'function') { try { gc(); } catch (_) {} }
      }
    } finally {
      // Always clean up — even if recognition throws or user navigates away
      try { await worker.terminate(); } catch (_) {}
      await pdf.destroy(); // Phase 2: full destroy before revoking source URL
      pdfSource.cleanup(); // Safe to revoke OPFS blob URL now
      await ProgressStore.clear('ocr', fHash);
    }

    onStep(2, 'done', 80);
    onStep(3, 'active', 84, 'Building document\u2026');

    // Build pages structure for DOCX output
    var ocrPages = allLines.map(function (lineStr, idx) {
      var text = lineStr.replace(/^=== Page \d+ ===\n?/, '').trim();
      var paragraphs = text.split('\n').filter(Boolean).map(function (t) {
        return { text: t.trim(), isHeading: false };
      });
      if (!paragraphs.length) paragraphs = [{ text: '(no content)', isHeading: false }];
      return { pageNum: idx + 1, paragraphs: paragraphs };
    });

    try {
      var ocrWResult = await runAdvancedWorker({ op: 'build-docx', pages: ocrPages });
      if (ocrWResult && ocrWResult.buffer) {
        var ocrBlob = new Blob([ocrWResult.buffer], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        onStep(3, 'done', 100);
        return { blob: ocrBlob, filename: brandedFilename(file.name, '.docx') };
      }
    } catch (_) {}

    // Fallback: plain text
    var ocrTxtBlob = new Blob([allLines.join('\n\n').trim()], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: ocrTxtBlob, filename: brandedFilename(file.name, '.txt') };
  };

  // ─── BACKGROUND REMOVER (Phase 5: WebGPU in worker) ──────────────────────
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
    // Phase 5: WebGPU hint in message (worker will try GPU first)
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

    var outCvs   = document.createElement('canvas');
    outCvs.width  = wResult.width; outCvs.height = wResult.height;
    var outCtx   = outCvs.getContext('2d');
    var outData  = outCtx.createImageData(wResult.width, wResult.height);
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
    onStep(0, 'active', 8, 'Preparing your file\u2026');
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
    // Fall back to browser-tools.js repairPdf when worker is unavailable
    if (!resultBuf) throw new Error(ERR.ORIG);

    onStep(2, 'done', 78);
    onStep(3, 'active', 82, 'Finalizing output\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-repaired.pdf') };
  };

  // ─── COMPARE ──────────────────────────────────────────────────────────────
  processors['compare'] = async function (files, opts, onStep) {
    if (files.length < 2) throw AEError(ERR.PARSE, 'requires two pdf files');
    onStep(0, 'active', 5, 'Preparing your files\u2026');

    var pdfjsLib = await loadPdfJs();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Analyzing first document\u2026');

    async function extractText(file, label, base) {
      var pdfSource = await loadPdfSource(file);
      var pdf = await pdfjsLib.getDocument(pdfSource.src).promise;
      var pages = [];
      try {
        for (var pi = 1; pi <= pdf.numPages; pi++) {
          var pg = await pdf.getPage(pi);
          var c  = await pg.getTextContent();
          pages.push(c.items.map(function (it) { return it.str; }).join(' '));
          pg.cleanup(); // Phase 2
          var pct = base + Math.round((pi / pdf.numPages) * 18);
          onStep(1, 'active', pct, label + ' \u2014 page ' + pi + ' of ' + pdf.numPages);
        }
      } finally {
        await pdf.destroy();
        pdfSource.cleanup(); // Revoke OPFS blob URL only after PDF is fully done
      }
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

  // ─── AI SUMMARIZE (Phase 7: prefetch pipeline) ────────────────────────────
  processors['ai-summarize'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    var pdfjsLib  = await loadPdfJs();
    var pdfSource = await loadPdfSource(file);
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf        = await pdfjsLib.getDocument(pdfSource.src).promise;
    var total      = pdf.numPages;
    var allText    = '';
    var skipped    = 0;
    var prefetcher = makePrefetcher(pdf); // Phase 7

    LivePreview.show(pdf, pdfjsLib); // Phase 8

    try {
      for (var i = 1; i <= total; i++) {
        var pageData = await prefetcher.getPage(i, i + 1);
        var content  = pageData.content;
        if (isPageBlank(content)) { skipped++; pageData.page.cleanup(); continue; }
        allText += content.items.map(function (it) { return it.str; }).join(' ') + ' ';
        pageData.page.cleanup(); // Phase 2
        var pct = 15 + Math.round((i / total) * 30);
        onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
      }
    } finally {
      prefetcher.dispose();
      await pdf.destroy();
      pdfSource.cleanup(); // Revoke OPFS blob URL only after PDF is fully done
    }

    if (!allText.trim()) throw AEError(ERR.PARSE, 'no_extractable_text');

    var maxSentences = parseInt((opts && (opts.sentences || opts.length)) || '7', 10) || 7;
    onStep(1, 'done', 45);
    onStep(2, 'active', 49, 'Generating summary\u2026');

    var _allTextForScore = allText;
    var scored;
    try {
      scored = await runAdvancedWorker({
        op: 'chunk-text-score', text: _allTextForScore, maxSentences: maxSentences,
      });
    } catch (_) {}
    allText = null;

    // Inline TF-IDF fallback when worker is unavailable
    if (!scored || !scored.summary) {
      var _sentences = (_allTextForScore.match(/[^.!?\n]{10,}[.!?]/g) || [])
        .map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 15; });
      if (!_sentences.length) _sentences = _allTextForScore.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
      var _words = _allTextForScore.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      var _freq = {};
      _words.forEach(function (w) { _freq[w] = (_freq[w] || 0) + 1; });
      var _top = _sentences.slice()
        .map(function (s) {
          var sw = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
          return { s: s, score: sw.reduce(function (n, w) { return n + (_freq[w] || 0); }, 0) / (sw.length || 1) };
        })
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, maxSentences)
        .map(function (x) { return x.s; });
      scored = { summary: _top.join(' '), wordCount: _words.length, sentenceCount: _sentences.length, topCount: _top.length };
    }
    _allTextForScore = null;

    if (!scored || !scored.summary) throw AEError(ERR.WORKER, 'summarize_empty');

    onStep(2, 'done', 82);
    onStep(3, 'active', 86, 'Finalizing output\u2026');

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

  // ─── TRANSLATE (Phase 7: prefetch) ────────────────────────────────────────
  processors['translate'] = async function (files, opts, onStep) {
    var file  = files[0];
    var fHash = _fileHash(file);
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    var pdfjsLib  = await loadPdfJs();
    var pdfSource = await loadPdfSource(file);
    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Processing content\u2026');

    var pdf        = await pdfjsLib.getDocument(pdfSource.src).promise;
    var total      = pdf.numPages;
    var pages      = [];
    var prefetcher = makePrefetcher(pdf); // Phase 7

    try {
      for (var i = 1; i <= total; i++) {
        var pageData = await prefetcher.getPage(i, i + 1);
        var content  = pageData.content;
        pages.push({
          num:   i,
          text:  content.items.map(function (it) { return it.str; }).join(' ').trim(),
          blank: isPageBlank(content),
        });
        pageData.page.cleanup(); // Phase 2
      }
    } finally {
      prefetcher.dispose();
      await pdf.destroy();
      pdfSource.cleanup(); // Revoke OPFS blob URL only after PDF is fully done
    }

    onStep(1, 'done', 38);
    onStep(2, 'active', 41, 'Preparing content\u2026');

    if (!isOnline()) throw AEError(ERR.NETWORK, 'offline');

    var targetLang = (opts && (opts.targetLang || opts.targetLanguage)) || 'es';
    var srcLang    = (opts && (opts.sourceLang || opts.sourceLanguage)) || 'en';
    var MAX_CHARS  = 450;

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
      if (pg.blank || !pg.text) { translated.push({ num: pg.num, text: '' }); continue; }

      // Sentence-boundary–aware chunking: prefer splitting at ". ", "? ", "! "
      // so translation preserves meaning across API calls.
      var segments = (function splitSentences(txt, max) {
        var out   = [];
        var parts = txt.match(/[^.!?]+[.!?]+["'\u2019]?[\s]*|[^.!?]+$/g) || [txt];
        var cur   = '';
        for (var si = 0; si < parts.length; si++) {
          var s = parts[si];
          if (cur.length + s.length > max && cur) {
            out.push(cur.trim());
            cur = s;
          } else {
            cur = cur ? cur + ' ' + s : s;
          }
        }
        if (cur.trim()) out.push(cur.trim());
        // Safety: if a single sentence exceeds max, hard-split it.
        var final = [];
        for (var oi = 0; oi < out.length; oi++) {
          var seg = out[oi];
          if (seg.length <= max) { final.push(seg); continue; }
          var pos2 = 0;
          while (pos2 < seg.length) {
            var end2 = Math.min(pos2 + max, seg.length);
            if (end2 < seg.length) { var ls2 = seg.lastIndexOf(' ', end2); if (ls2 > pos2) end2 = ls2; }
            final.push(seg.slice(pos2, end2).trim());
            pos2 = end2 + 1;
          }
        }
        return final.length ? final : [txt.slice(0, max)];
      }(pg.text, MAX_CHARS));

      var translatedParts = [];
      for (var c = 0; c < segments.length; c++) {
        if (!segments[c]) continue;
        var seg = segments[c];
        var part = await retryWithBackoff(function (attempt, signal) {
          if (attempt > 0) {
            var hEl = document.getElementById('processing-msg');
            if (hEl) hEl.textContent = 'Optimizing connection\u2026';
          }
          var url = 'https://api.mymemory.translated.net/get?q=' +
            encodeURIComponent(seg) + '&langpair=' + encodeURIComponent(srcLang) + '|' + encodeURIComponent(targetLang);
          return fetchWithRetry(url, signal ? { signal: signal } : {}, 1, 10000)
            .then(function (resp) { return resp.json(); })
            .then(function (json) {
              return (json.responseData && json.responseData.translatedText) || seg;
            });
        }, 3, 800, 12000).catch(function () { return seg; });
        translatedParts.push(part);
      }

      translated.push({ num: pg.num, text: translatedParts.join(' ') });

      await ProgressStore.save('translate', fHash, {
        pagesDone:  p + 1, totalPages: total,
        targetLang: targetLang, translated: translated.slice(),
      });

      var pct2 = 41 + Math.round(((p + 1) / pages.length) * 38);
      onStep(2, 'active', pct2, 'Page ' + (p + 1) + ' of ' + pages.length);
    }

    await ProgressStore.clear('translate', fHash);

    onStep(2, 'done', 79);
    onStep(3, 'active', 82, 'Finalizing output\u2026');

    // Check if any pages actually have content
    var _hasContent = translated.some(function (pg) { return pg.text && pg.text.trim().length > 0; });
    if (!_hasContent) {
      throw new Error('No translatable text was found in this PDF. The document may contain only images or scanned content. Use the OCR tool first to extract text.');
    }

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

  // ─── WORKFLOW ─────────────────────────────────────────────────────────────
  processors['workflow'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8, 'Preparing your file\u2026');
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
    if (!resultBuf) throw new Error('The workflow could not be applied. Please check your selected operations and try again.');

    onStep(2, 'done', 80);
    onStep(3, 'active', 84, 'Finalizing output\u2026');
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-workflow.pdf') };
  };

  // ── MAIN RUNNER ────────────────────────────────────────────────────────────
  async function runTool(toolId, files, opts, origProcess) {
    var totalBytes = Array.from(files).reduce(function (s, f) { return s + (f.size || 0); }, 0);

    // 500 MB absolute limit — too large to process in the browser.
    if (totalBytes > MAX_BROWSER_BYTES) {
      throw new Error('file_too_large_for_browser');
    }

    // Memory guard — abort early before we OOM the tab.
    if (shouldFallbackMem(totalBytes)) {
      throw new Error('memory_pressure');
    }

    var proc = processors[toolId];
    if (!proc) throw AEError(ERR.PARSE, 'no_processor_' + toolId);

    var steps = TOOL_STEPS[toolId] || ['Analyzing document', 'Processing', 'Finalizing'];
    LiveFeed.show(steps, 'Processing your file\u2026');

    // Phase 9: show estimator after feed renders
    setTimeout(function () { OutputEstimator.show(toolId, totalBytes); }, 300);

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
                    err.aeType === ERR.ORIG);

      if (isOrig) {
        // Phase 11: seamless handoff with neutral message
        LiveFeed.update(1, 'active', 30, 'Preparing content\u2026');
        try {
          result = await origProcess(toolId, files, opts);
        } catch (origErr) {
          LiveFeed.hide();
          vanish();
          var safe = new Error(safeMessage(origErr) || 'Something went wrong. Please try again.');
          throw safe;
        }
      } else {
        LiveFeed.hide();
        vanish();
        var safeErr = new Error(safeMessage(err) || 'Something went wrong. Please try again.');
        safeErr.aeType = err.aeType;
        throw safeErr;
      }
    }

    // ── Output Validation Layer ────────────────────────────────────────────
    // Reject obviously empty / corrupted results before they reach the UI.
    if (result) {
      var _rb = (result && result.blob) ? result.blob : result;
      if (_rb instanceof Blob) {
        var _TEXT_TOOLS = ['compare', 'ai-summarize', 'translate'];
        var _minOut = _TEXT_TOOLS.indexOf(toolId) !== -1 ? 1 : 50;
        if (_rb.size < _minOut) {
          LiveFeed.hide();
          vanish();
          throw new Error('The result appears empty. Please try again with a different file.');
        }
      }
    }

    LiveFeed.done();
    vanish();
    return result;
  }

  // ── HOOK INSTALLER ─────────────────────────────────────────────────────────
  function installHook() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__advEngineV30) return true;

    var origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      if (ADVANCED_IDS.has(toolId)) {
        return runTool(toolId, files, opts, origProcess);
      }
      return origProcess(toolId, files, opts);
    };

    window.BrowserTools.__advEngineV30 = true;
    return true;
  }

  if (!installHook()) {
    var _tries = 0;
    var _iv = setInterval(function () {
      if (installHook() || _tries++ > 40) clearInterval(_iv);
    }, 100);
  }

  // ── WARMUP + PROGRESS RESUME CHECK ─────────────────────────────────────────
  warmup();

  (function checkSavedProgress() {
    var slug    = (window.location.pathname || '').replace(/^\//, '').split('/')[0];
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

  // ── PUBLIC API ──────────────────────────────────────────────────────────────
  window.AdvancedEngine = {
    version:          '3.0',
    TOOL_IDS:         ADVANCED_IDS,
    LiveFeed:         LiveFeed,
    LivePreview:      LivePreview,
    OutputEstimator:  OutputEstimator,
    TabCoordinator:   TabCoordinator,
    IDBTemp:          IDBTemp,
    ProgressStore:    ProgressStore,
    memTier:          memTier,
    vanish:           vanish,
  };

}());

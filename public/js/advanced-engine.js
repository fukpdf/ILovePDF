// Advanced Engine v1.1 — production-hardened browser processor for 15 advanced tools.
// Wraps window.BrowserTools.process() transparently; instant tools are NEVER touched.
//
// Bug-fixes in v1.1:
//   [BUG-01] LiveFeed was invisible — now updates #processing-title/#processing-msg
//            (inside the overlay the user actually sees) AND #result-area as fallback.
//   [BUG-02] OCR memory spike — now processes one page at a time (render→OCR→dispose).
//   [BUG-03] Background remover buffer transfer — sender now passes raw ArrayBuffer;
//            worker wraps it with Uint8ClampedArray after transfer (not before).
//   [BUG-04] Large-image crash — dimensions capped at MAX_IMG_DIM before canvas ops.
//   [BUG-05] Missing pdf.destroy() — all pdfjs documents freed after extraction.
//   [BUG-06] word-to-pdf streamed file then threw sentinel (double read) — removed.
//   [BUG-07] Option name mismatches — targetLang (not targetLanguage), sentences (not length).
//   [BUG-08] No onmessageerror handler on worker bridge — added.
//   [BUG-09] IDBTemp grew unboundedly — TTL cleanup on open (entries older than 2h deleted).
//   [BUG-10] Compare used convoluted nested Promise chain — replaced with async/await.
(function () {
  'use strict';

  // ── DEVICE PROFILE ─────────────────────────────────────────────────────────
  var _cores    = Math.min(navigator.hardwareConcurrency || 2, 8);
  var _isHighEnd = _cores >= 4;
  var CHUNK_SIZE = _isHighEnd ? 8 * 1024 * 1024 : 2 * 1024 * 1024;
  var MAX_WORKERS = _isHighEnd ? 4 : 2;
  var MAX_IMG_DIM  = 4096; // [BUG-04] max canvas dimension for background remover

  // ── MEMORY GUARD ───────────────────────────────────────────────────────────
  var MEM_REDUCE   = 600 * 1024 * 1024;
  var MEM_LOW      = 750 * 1024 * 1024;
  var MEM_ABORT    = 850 * 1024 * 1024;

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
    var needed = (fileSizeBytes || 0) * 4;
    var avail  = Math.max(0, _memLimit() - _memUsed());
    return needed > avail;
  }
  function workerCap() {
    var t = memTier();
    if (t === 'low')    return 1;
    if (t === 'reduce') return Math.min(2, MAX_WORKERS);
    return MAX_WORKERS;
  }

  // ── IDB TEMP STORE ─────────────────────────────────────────────────────────
  // [BUG-09] TTL: entries older than TTL_MS are purged on open.
  var IDBTemp = (function () {
    var DB_NAME = 'ilovepdf-adv-temp';
    var STORE   = 'chunks';
    var VER     = 2;        // bumped so onupgradeneeded adds ts index
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
            // Async TTL sweep — non-blocking
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
            var cursor = ev.target.result;
            if (!cursor) return res();
            if ((cursor.value.ts || 0) < cutoff) {
              cursor.delete();
            }
            cursor.continue();
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
              if (Date.now() - (rec.ts || 0) > TTL_MS) return res(null); // expired
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

    return { put: put, get: get, del: del, clear: clear };
  }());

  // ── LIVE FEED ──────────────────────────────────────────────────────────────
  // [BUG-01] Primary update target: #processing-title and #processing-msg
  //          (visible inside the overlay). #result-area is a secondary fallback
  //          shown after the overlay closes (e.g. in the download step).
  var _feedCssInjected = false;
  var _feedActive      = false; // guard against duplicate feeds

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
      '.ae-dot{width:9px;height:9px;border-radius:50%;background:#d1d5db;flex-shrink:0;transition:background .2s;}',
      '.ae-step[data-s="active"] .ae-dot{background:#7c3aed;animation:ae-pulse .9s ease-in-out infinite;}',
      '.ae-step[data-s="done"] .ae-dot{background:#10b981;}',
      '.ae-step[data-s="error"] .ae-dot{background:#ef4444;}',
      '.ae-step[data-s="done"] .ae-dot::after{content:"✓";font-size:8px;line-height:9px;',
        'color:#fff;display:flex;align-items:center;justify-content:center;}',
      '@keyframes ae-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.ae-bar-wrap{height:6px;background:#ddd6fe;border-radius:3px;overflow:hidden;margin-bottom:6px;}',
      '.ae-bar-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#a78bfa);',
        'border-radius:3px;transition:width .4s cubic-bezier(.4,0,.2,1);width:0;}',
      '.ae-hint{font-size:11px;color:#9ca3af;text-align:center;min-height:14px;}',
    ].join('');
    document.head.appendChild(s);
  }

  function _escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var LiveFeed = {
    _steps: [],
    _title: '',

    show: function (steps, title) {
      if (_feedActive) this.hide(); // [guard] never show two feeds
      _feedActive = true;
      _injectFeedCss();
      this._steps = steps || [];
      this._title = title || 'Processing\u2026';

      // [BUG-01] PRIMARY: update overlay elements (what user sees through the spinner)
      var titleEl = document.getElementById('processing-title');
      var msgEl   = document.getElementById('processing-msg');
      if (titleEl) titleEl.textContent = this._title;
      if (msgEl)   msgEl.textContent   = steps[0] || 'Starting\u2026';

      // SECONDARY: also inject a richer panel into #result-area (visible after overlay closes)
      var area = document.getElementById('result-area');
      if (!area) return;
      var stepsHtml = steps.map(function (label, i) {
        return '<div class="ae-step" id="ae-s-' + i + '" data-s="pending">' +
               '<span class="ae-dot"></span>' +
               '<span>' + _escHtml(label) + '</span></div>';
      }).join('');
      area.innerHTML =
        '<div class="ae-feed" id="ae-feed">' +
          '<div class="ae-feed-hdr"><div class="ae-spin"></div>' +
          '<span>' + _escHtml(this._title) + '</span></div>' +
          '<div class="ae-steps">' + stepsHtml + '</div>' +
          '<div class="ae-bar-wrap"><div class="ae-bar-fill" id="ae-bar"></div></div>' +
          '<div class="ae-hint" id="ae-hint"></div>' +
        '</div>';
    },

    update: function (idx, state, pct, hint) {
      // [BUG-01] Update overlay msg with current step label + hint
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) {
        var label = (this._steps[idx] || '');
        msgEl.textContent = label + (hint ? ' \u2014 ' + hint : '');
      }

      // Update #result-area feed panel
      var step = document.getElementById('ae-s-' + idx);
      if (step) step.setAttribute('data-s', state);

      if (typeof pct === 'number') {
        var bar = document.getElementById('ae-bar');
        if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
      }
      if (hint != null) {
        var h = document.getElementById('ae-hint');
        if (h) h.textContent = hint;
      }
    },

    done: function () {
      var bar = document.getElementById('ae-bar');
      if (bar) bar.style.width = '100%';
      _feedActive = false;
      // Reset overlay msg back to default so it looks clean on next open
      var msgEl = document.getElementById('processing-msg');
      if (msgEl) msgEl.textContent = 'This usually takes only a few seconds.';
    },

    hide: function () {
      _feedActive = false;
    },
  };

  // ── CHUNK STREAM ───────────────────────────────────────────────────────────
  // Reads File in adaptive-sized slices; onChunk(buf, idx, offset, total, isLast)
  function streamFile(file, onChunk, chunkSize) {
    chunkSize = chunkSize || CHUNK_SIZE;
    var total  = file.size;
    var offset = 0;
    var idx    = 0;

    function next() {
      if (offset >= total) return Promise.resolve();
      var end    = Math.min(offset + chunkSize, total);
      var slice  = file.slice(offset, end);
      var ci     = idx++;
      var isLast = end >= total;
      var byteOffset = offset;
      offset = end;

      return slice.arrayBuffer().then(function (buf) {
        return Promise.resolve(onChunk(buf, ci, byteOffset, total, isLast));
      }).then(function () { return next(); });
    }

    return next();
  }

  // ── WORKER BRIDGE ──────────────────────────────────────────────────────────
  var ADV_WORKER_URL = '/workers/advanced-worker.js';

  function runAdvancedWorker(message, transferables) {
    return new Promise(function (resolve, reject) {
      var w, timer;

      timer = setTimeout(function () {
        try { if (w) w.terminate(); } catch (_) {}
        reject(new Error('Advanced worker timed out after 120s'));
      }, 120000);

      try {
        w = new Worker(ADV_WORKER_URL);
      } catch (e) {
        clearTimeout(timer);
        return reject(new Error('Worker creation failed: ' + (e.message || e)));
      }

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        if (ev.data && ev.data.__error) {
          reject(new Error(ev.data.__error));
        } else {
          resolve(ev.data);
        }
      };

      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        reject(new Error((ev && ev.message) || 'Worker script error'));
      };

      // [BUG-08] Handle message deserialization errors
      w.onmessageerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        reject(new Error('Worker message deserialization error'));
      };

      try {
        w.postMessage(message, transferables || []);
      } catch (e) {
        // Fallback: structured clone (no zero-copy) if transferables list is invalid
        try { w.postMessage(message); }
        catch (e2) {
          clearTimeout(timer);
          try { w.terminate(); } catch (_) {}
          reject(new Error('Worker postMessage failed: ' + e2.message));
        }
      }
    });
  }

  // Reuse existing WorkerPool + pdf-worker.js for pure pdf-lib operations
  function runPdfWorker(toolId, buffers, options) {
    var pool = window.WorkerPool;
    if (!pool) return Promise.reject(new Error('WorkerPool unavailable'));
    return pool.run(
      '/workers/pdf-worker.js',
      { tool: toolId, buffers: buffers, options: options || {} },
      buffers
    );
  }

  // ── VANISH SYSTEM ──────────────────────────────────────────────────────────
  var _blobUrls = [];
  var _tempKeys = [];

  function trackBlob(url)  { if (url) _blobUrls.push(url); }
  function trackKey(key)   { if (key) _tempKeys.push(key); }

  function vanish() {
    var urls = _blobUrls.splice(0);
    urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });

    var keys = _tempKeys.splice(0);
    keys.forEach(function (k) { IDBTemp.del(k).catch(function () {}); });
  }

  window.addEventListener('beforeunload', vanish);
  window.addEventListener('popstate',     vanish);

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function brandedFilename(original, ext) {
    var base = (original || 'file').replace(/\.[^.]+$/, '');
    var safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
    return 'ILovePDF-' + safe + ext;
  }

  // pdfjs lazy loader — reuses global if browser-tools.js already loaded it
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
      _pdfJsPromise = null; // allow retry
      throw e;
    });
    return _pdfJsPromise;
  }

  // Script tag loader (for Tesseract which doesn't have an ESM bundle)
  var _scriptLoads = {};
  function loadScript(url) {
    if (_scriptLoads[url]) return _scriptLoads[url];
    _scriptLoads[url] = new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + url + '"]')) return res();
      var s    = document.createElement('script');
      s.src    = url;
      s.onload  = res;
      s.onerror = function () { delete _scriptLoads[url]; rej(new Error('Failed to load: ' + url)); };
      document.head.appendChild(s);
    });
    return _scriptLoads[url];
  }

  // ── TOOL STEPS ─────────────────────────────────────────────────────────────
  var TOOL_STEPS = {
    'compress':           ['Reading file',        'Analysing structure',   'Optimising',          'Saving'],
    'pdf-to-word':        ['Reading PDF',          'Extracting text',       'Building document',   'Packaging'],
    'pdf-to-excel':       ['Reading PDF',          'Detecting columns',     'Building spreadsheet','Packaging'],
    'pdf-to-powerpoint':  ['Reading PDF',          'Extracting content',    'Building slides',     'Packaging'],
    'word-to-pdf':        ['Reading document',     'Parsing structure',     'Rendering PDF',       'Saving'],
    'excel-to-pdf':       ['Reading spreadsheet',  'Parsing data',          'Rendering PDF',       'Saving'],
    'html-to-pdf':        ['Reading HTML',         'Rendering layout',      'Exporting PDF',       'Saving'],
    'ocr':                ['Reading PDF',          'Rendering pages',       'Recognising text',    'Compiling'],
    'scan-to-pdf':        ['Reading images',       'Optimising quality',    'Creating PDF',        'Saving'],
    'background-remover': ['Loading image',        'Analysing pixels',      'Removing background', 'Saving PNG'],
    'repair':             ['Reading PDF',          'Scanning for errors',   'Rebuilding structure','Saving'],
    'compare':            ['Reading documents',    'Extracting text',       'Analysing diff',      'Building report'],
    'ai-summarize':       ['Reading PDF',          'Extracting text',       'Scoring sentences',   'Building summary'],
    'translate':          ['Reading PDF',          'Extracting content',    'Translating',         'Building output'],
    'workflow':           ['Reading PDF',          'Applying operations',   'Chaining steps',      'Saving'],
  };

  var ADVANCED_IDS = new Set(Object.keys(TOOL_STEPS));

  // ── TOOL PROCESSORS ────────────────────────────────────────────────────────
  var processors = {};

  // ─── COMPRESS ─────────────────────────────────────────────────────────────
  processors['compress'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var buf = await file.arrayBuffer();
    onStep(0, 'done', 15);
    onStep(1, 'active', 18);

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(1, 'done', 25);
        onStep(2, 'active', 30);
        var wRes = await runPdfWorker('compress', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          resultBuf = wRes.buffer;
        }
      }
    } catch (e) {
      console.warn('[AdvancedEngine] compress worker error:', e.message);
    }

    buf = null; // release input reference

    if (!resultBuf) {
      // No worker result → throw sentinel so origProcess handles it
      throw new Error('__orig__');
    }

    // If compressed ≥ original, server has better algorithms (image resampling etc.)
    if (resultBuf.byteLength >= file.size) {
      throw new Error('__orig__');
    }

    onStep(2, 'done', 85);
    onStep(3, 'active', 88);
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pdf') };
  };

  // ─── PDF → WORD ────────────────────────────────────────────────────────────
  processors['pdf-to-word'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null; // [BUG-05] release input buffer once pdfjs has loaded it
    var total = pdf.numPages;
    var pages = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      var text    = content.items.map(function (it) { return it.str; }).join(' ');
      pages.push({ pageNum: i, text: text });
      page.cleanup(); // release page resources
      var pct = 15 + Math.round((i / total) * 43);
      onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
    }
    await pdf.destroy(); // [BUG-05]

    onStep(1, 'done', 58);
    onStep(2, 'active', 62, 'Building Word document\u2026');

    var wResult = await runAdvancedWorker({ op: 'build-docx', pages: pages });
    pages = null;
    if (!wResult || !wResult.buffer) throw new Error('DOCX build failed in worker');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93);
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.docx') };
  };

  // ─── PDF → EXCEL ───────────────────────────────────────────────────────────
  processors['pdf-to-excel'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf    = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total  = pdf.numPages;
    var sheets = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();

      // Group items into rows by quantised Y position
      var byY = {};
      content.items.forEach(function (it) {
        if (!it.str.trim()) return;
        var yKey = Math.round(it.transform[5] / 8) * 8;
        if (!byY[yKey]) byY[yKey] = [];
        byY[yKey].push({ x: it.transform[4], str: it.str.trim() });
      });

      var ys   = Object.keys(byY).map(Number).sort(function (a, b) { return b - a; });
      var rows = ys.map(function (y) {
        return byY[y].sort(function (a, b) { return a.x - b.x; }).map(function (it) { return it.str; });
      });

      sheets.push({ name: 'Page ' + i, rows: rows.length ? rows : [['(empty)']] });
      page.cleanup();
      var pct = 15 + Math.round((i / total) * 43);
      onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
    }
    await pdf.destroy();

    onStep(1, 'done', 58);
    onStep(2, 'active', 62, 'Building spreadsheet\u2026');

    var wResult = await runAdvancedWorker({ op: 'build-xlsx', sheets: sheets });
    sheets = null;
    if (!wResult || !wResult.buffer) throw new Error('XLSX build failed in worker');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93);
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.xlsx') };
  };

  // ─── PDF → POWERPOINT ──────────────────────────────────────────────────────
  processors['pdf-to-powerpoint'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf    = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total  = pdf.numPages;
    var slides = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      var items   = content.items;

      // Heuristic: largest-font item → slide title
      var biggest = { str: '', h: 0 };
      items.forEach(function (it) {
        var h = Math.abs(it.transform[3]);
        if (h > biggest.h && it.str.trim()) biggest = { str: it.str, h: h };
      });

      var bodyText = items
        .filter(function (it) { return it.str.trim() && it.str !== biggest.str; })
        .map(function (it) { return it.str; })
        .join(' ')
        .trim();

      slides.push({
        pageNum: i,
        title:   biggest.str || ('Page ' + i),
        text:    bodyText,
      });
      page.cleanup();
      var pct = 15 + Math.round((i / total) * 43);
      onStep(1, 'active', pct, 'Slide ' + i + ' of ' + total);
    }
    await pdf.destroy();

    onStep(1, 'done', 58);
    onStep(2, 'active', 62, 'Building PPTX\u2026');

    var docTitle = file.name.replace(/\.[^.]+$/, '');
    var wResult  = await runAdvancedWorker({ op: 'build-pptx', slides: slides, docTitle: docTitle });
    slides = null;
    if (!wResult || !wResult.buffer) throw new Error('PPTX build failed in worker');

    onStep(2, 'done', 90);
    onStep(3, 'active', 93);
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pptx') };
  };

  // ─── WORD / EXCEL / HTML / SCAN → delegate to origProcess immediately ──────
  // [BUG-06] No wasteful file read — throw sentinel right away.
  // LiveFeed step-1 is updated mid-way through origProcess via the overlay msg.
  processors['word-to-pdf'] = async function (files, opts, onStep) {
    onStep(0, 'active', 10);
    throw new Error('__orig__');
  };
  processors['excel-to-pdf'] = async function (files, opts, onStep) {
    onStep(0, 'active', 10);
    throw new Error('__orig__');
  };
  processors['html-to-pdf'] = async function (files, opts, onStep) {
    onStep(0, 'active', 10);
    throw new Error('__orig__');
  };
  processors['scan-to-pdf'] = async function (files, opts, onStep) {
    onStep(0, 'active', 10);
    throw new Error('__orig__');
  };

  // ─── OCR ────────────────────────────────────────────────────────────────────
  // [BUG-02] Process one page at a time: render → OCR → dispose canvas → next.
  //          No more large canvas array held in memory.
  processors['ocr'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total = pdf.numPages;

    // Try native text extraction first (fast, no Tesseract needed)
    onStep(1, 'active', 15, 'Trying native text extraction\u2026');
    var nativeText = '';
    for (var ni = 1; ni <= total; ni++) {
      var np      = await pdf.getPage(ni);
      var nc      = await np.getTextContent();
      nativeText += nc.items.map(function (it) { return it.str; }).join(' ') + '\n';
      np.cleanup();
    }

    if (nativeText.replace(/\s/g, '').length > 60) {
      // PDF already has a text layer — no OCR needed
      await pdf.destroy();
      onStep(1, 'done', 50);
      onStep(2, 'done', 80);
      onStep(3, 'active', 90);
      var nBlob = new Blob([nativeText.trim()], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);
      return { blob: nBlob, filename: brandedFilename(file.name, '.txt') };
    }

    // Image-based PDF → Tesseract OCR
    onStep(1, 'done', 25);
    onStep(2, 'active', 28, 'Loading OCR engine\u2026');

    // Load Tesseract.js v4 (simpler API, more stable worker paths)
    if (!window.Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/tesseract.min.js');
    }
    var Tesseract = window.Tesseract;
    if (!Tesseract) throw new Error('Tesseract.js could not be loaded');

    var lang   = (opts && opts.language) || 'eng';
    var worker = await Tesseract.createWorker(lang, 1, { logger: function () {} });

    var allText = '';
    var scale   = _isHighEnd ? 2.0 : 1.5;

    for (var i = 1; i <= total; i++) {
      // [BUG-02] Render one page, OCR it, then immediately dispose the canvas
      var pg       = await pdf.getPage(i);
      var viewport = pg.getViewport({ scale: scale });
      var cvs      = document.createElement('canvas');
      cvs.width    = Math.floor(viewport.width);
      cvs.height   = Math.floor(viewport.height);
      var ctx = cvs.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      await pg.render({ canvasContext: ctx, viewport: viewport }).promise;
      pg.cleanup();

      // Capture as data-URL before destroying canvas
      var dataUrl = cvs.toDataURL('image/png');
      // Release canvas memory
      cvs.width  = 0;
      cvs.height = 0;
      cvs = null;

      var ocrResult = await worker.recognize(dataUrl);
      allText += '=== Page ' + i + ' ===\n' + ocrResult.data.text + '\n\n';
      dataUrl = null; // release string

      var pct = 28 + Math.round((i / total) * 55);
      onStep(2, 'active', pct, 'OCR page ' + i + ' of ' + total);
    }

    await worker.terminate();
    await pdf.destroy();

    onStep(2, 'done', 83);
    onStep(3, 'active', 87);
    var blob = new Blob([allText.trim()], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.txt') };
  };

  // ─── BACKGROUND REMOVER ────────────────────────────────────────────────────
  // [BUG-03] Send raw ArrayBuffer to worker; never wrap with typed-array view before transfer.
  // [BUG-04] Cap image dimensions at MAX_IMG_DIM to prevent memory crash.
  processors['background-remover'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var objUrl = URL.createObjectURL(file);
    trackBlob(objUrl);

    var img = await new Promise(function (res, rej) {
      var el    = new Image();
      el.onload  = function () { res(el); };
      el.onerror = function () { rej(new Error('Failed to load image')); };
      el.src = objUrl;
    });

    onStep(0, 'done', 18);
    onStep(1, 'active', 20);

    var srcW = img.naturalWidth;
    var srcH = img.naturalHeight;

    // [BUG-04] Scale down if either dimension exceeds MAX_IMG_DIM
    var drawW = srcW;
    var drawH = srcH;
    if (srcW > MAX_IMG_DIM || srcH > MAX_IMG_DIM) {
      var ratio = Math.min(MAX_IMG_DIM / srcW, MAX_IMG_DIM / srcH);
      drawW = Math.round(srcW * ratio);
      drawH = Math.round(srcH * ratio);
    }

    var cvs    = document.createElement('canvas');
    cvs.width  = drawW;
    cvs.height = drawH;
    var ctx = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0, drawW, drawH);
    img = null; // release image element

    var imageData  = ctx.getImageData(0, 0, drawW, drawH);
    var threshold  = Math.max(100, Math.min(255, parseInt((opts && opts.threshold) || '235', 10)));

    onStep(1, 'done', 38);
    onStep(2, 'active', 42, 'Removing background\u2026');

    // [BUG-03] Transfer the raw ArrayBuffer — DO NOT create a typed-array view here.
    // The worker wraps it with Uint8ClampedArray after the transfer.
    var rawBuffer = imageData.data.buffer.slice(0); // copy so original stays intact
    imageData = null;

    var wResult = await runAdvancedWorker(
      { op: 'remove-bg', pixels: rawBuffer, width: drawW, height: drawH, threshold: threshold },
      [rawBuffer] // transferred zero-copy
    );

    if (!wResult || !(wResult.pixels instanceof ArrayBuffer)) {
      throw new Error('Background removal produced invalid result');
    }

    onStep(2, 'done', 82);
    onStep(3, 'active', 85, 'Saving PNG\u2026');

    // Reconstruct canvas from returned pixel buffer
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
        else rej(new Error('Canvas export produced empty blob'));
      }, 'image/png');
    });

    // Release canvases
    cvs.width = 0; cvs.height = 0;
    outCvs.width = 0; outCvs.height = 0;

    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.png') };
  };

  // ─── REPAIR ────────────────────────────────────────────────────────────────
  processors['repair'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8);
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 18);
    onStep(1, 'active', 22);

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(2, 'active', 35);
        var wRes = await runPdfWorker('repair', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          resultBuf = wRes.buffer;
        }
      }
    } catch (e) {
      console.warn('[AdvancedEngine] repair worker error:', e.message);
    }

    buf = null;
    if (!resultBuf) throw new Error('__orig__');

    onStep(1, 'done', 60);
    onStep(2, 'done', 78);
    onStep(3, 'active', 82);
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-repaired.pdf') };
  };

  // ─── COMPARE ───────────────────────────────────────────────────────────────
  // [BUG-10] Replaced convoluted nested Promise chain with clean async/await loops.
  processors['compare'] = async function (files, opts, onStep) {
    if (files.length < 2) throw new Error('Compare requires two PDF files');
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    // Extract text from one PDF — returns array of per-page text strings
    async function extractPages(file, label) {
      var buf  = await file.arrayBuffer();
      var pdf  = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      buf = null;
      var pages = [];
      for (var pi = 1; pi <= pdf.numPages; pi++) {
        var pg = await pdf.getPage(pi);
        var c  = await pg.getTextContent();
        pages.push(c.items.map(function (it) { return it.str; }).join(' '));
        pg.cleanup();
        onStep(1, 'active', 15 + Math.round((pi / pdf.numPages) * 20), label + ' p' + pi);
      }
      await pdf.destroy(); // [BUG-05]
      return pages;
    }

    // Run sequentially to avoid double pdfjs worker contention
    var pagesA = await extractPages(files[0], 'Doc A');
    var pagesB = await extractPages(files[1], 'Doc B');

    onStep(1, 'done', 55);
    onStep(2, 'active', 58, 'Analysing differences\u2026');

    var maxPages = Math.max(pagesA.length, pagesB.length);
    var diffs    = [];
    var totalAdded = 0, totalRemoved = 0;

    // Whole-document Jaccard similarity
    var wordsA = new Set((pagesA.join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    var wordsB = new Set((pagesB.join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    var inter  = 0;
    wordsA.forEach(function (w) { if (wordsB.has(w)) inter++; });
    var union  = wordsA.size + wordsB.size - inter;
    var sim    = union > 0 ? Math.round(inter / union * 100) : 0;

    for (var pi = 0; pi < maxPages; pi++) {
      var ta = (pagesA[pi] || '').trim();
      var tb = (pagesB[pi] || '').trim();
      var wA = new Set((ta.toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
      var wB = new Set((tb.toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
      var added = 0, removed = 0;
      wB.forEach(function (w) { if (!wA.has(w)) added++; });
      wA.forEach(function (w) { if (!wB.has(w)) removed++; });
      totalAdded   += added;
      totalRemoved += removed;
      diffs.push({ page: pi + 1, added: added, removed: removed });
    }

    onStep(2, 'done', 82);
    onStep(3, 'active', 85);

    var lines = [
      'ILovePDF \u2014 Document Comparison Report',
      '='.repeat(50),
      'File A : ' + files[0].name + ' (' + pagesA.length + ' pages)',
      'File B : ' + files[1].name + ' (' + pagesB.length + ' pages)',
      'Similarity : ' + sim + '% word overlap',
      'Pages compared : ' + maxPages,
      '',
      'PAGE DIFF SUMMARY',
      '-'.repeat(50),
    ];
    diffs.forEach(function (d) {
      if (d.added || d.removed) {
        lines.push('Page ' + d.page + ' : +' + d.added + ' words added / -' + d.removed + ' removed');
      }
    });
    lines.push('');
    lines.push('TOTALS: +' + totalAdded + ' words added / -' + totalRemoved + ' words removed');

    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: 'ILovePDF-comparison-report.txt' };
  };

  // ─── AI SUMMARIZE ──────────────────────────────────────────────────────────
  processors['ai-summarize'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf     = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total   = pdf.numPages;
    var allText = '';

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      allText    += content.items.map(function (it) { return it.str; }).join(' ') + ' ';
      page.cleanup();
      var pct = 15 + Math.round((i / total) * 33);
      onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
    }
    await pdf.destroy();

    if (!allText.trim()) throw new Error('No extractable text found in PDF');

    onStep(1, 'done', 48);
    onStep(2, 'active', 52, 'Scoring sentences\u2026');

    // [BUG-07] Use 'sentences' key (consistent with original browser-tools.js)
    var maxSentences = parseInt((opts && (opts.sentences || opts.length)) || '7', 10) || 7;

    var scored = await runAdvancedWorker({
      op:           'chunk-text-score',
      text:         allText,
      maxSentences: maxSentences,
    });
    allText = null;

    if (!scored || !scored.summary) throw new Error('Summarisation worker returned empty result');

    onStep(2, 'done', 85);
    onStep(3, 'active', 88);

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
      'Stats: ' + (scored.sentenceCount || '?') + ' sentences analysed, ' +
        scored.topCount + ' selected.',
    ].join('\n');

    var blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-summary.txt') };
  };

  // ─── TRANSLATE ─────────────────────────────────────────────────────────────
  processors['translate'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    buf = null;
    var total = pdf.numPages;
    var pages = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      pages.push({
        num:  i,
        text: content.items.map(function (it) { return it.str; }).join(' ').trim(),
      });
      page.cleanup();
    }
    await pdf.destroy();

    onStep(1, 'done', 40);
    onStep(2, 'active', 43);

    // [BUG-07] Read 'targetLang' (matching original browser-tools.js field name)
    var targetLang = (opts && (opts.targetLang || opts.targetLanguage)) || 'es';
    var MAX_CHARS  = 450; // MyMemory free-tier safe limit
    var translated = [];

    for (var p = 0; p < pages.length; p++) {
      var pg   = pages[p];
      var text = pg.text;

      if (!text) {
        translated.push({ num: pg.num, text: '' });
        continue;
      }

      // Split into ≤MAX_CHARS chunks at word boundaries
      var chunks = [];
      var pos    = 0;
      while (pos < text.length) {
        var end = Math.min(pos + MAX_CHARS, text.length);
        if (end < text.length) {
          var ls = text.lastIndexOf(' ', end);
          if (ls > pos) end = ls;
        }
        chunks.push(text.slice(pos, end).trim());
        pos = end + 1;
      }

      var translatedChunks = [];
      for (var c = 0; c < chunks.length; c++) {
        if (!chunks[c]) continue;
        try {
          var resp = await fetch(
            'https://api.mymemory.translated.net/get?q=' +
            encodeURIComponent(chunks[c]) +
            '&langpair=en|' + encodeURIComponent(targetLang),
            { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined }
          );
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          var json = await resp.json();
          translatedChunks.push(
            (json.responseData && json.responseData.translatedText) || chunks[c]
          );
        } catch (_) {
          translatedChunks.push(chunks[c]); // keep original on error
        }
      }
      translated.push({ num: pg.num, text: translatedChunks.join(' ') });

      var pct2 = 43 + Math.round(((p + 1) / pages.length) * 38);
      onStep(2, 'active', pct2, 'Page ' + (p + 1) + ' of ' + pages.length);
    }

    onStep(2, 'done', 81);
    onStep(3, 'active', 84);

    var lineOut = [
      'ILovePDF \u2014 Translated (' + targetLang.toUpperCase() + ')',
      '='.repeat(50),
      'Source: ' + file.name,
      '',
    ];
    translated.forEach(function (pg) {
      lineOut.push('--- Page ' + pg.num + ' ---');
      lineOut.push(pg.text || '(empty)');
      lineOut.push('');
    });

    var blob = new Blob([lineOut.join('\n')], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-' + targetLang + '.txt') };
  };

  // ─── WORKFLOW ──────────────────────────────────────────────────────────────
  processors['workflow'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8);
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 18);
    onStep(1, 'active', 22);

    var steps = [
      { op: opts.step1, value: opts.step1_value || '' },
      { op: opts.step2, value: opts.step2_value || '' },
      { op: opts.step3, value: opts.step3_value || '' },
    ].filter(function (s) { return s.op && s.op !== ''; });

    if (!steps.length) throw new Error('Please select at least one operation');

    onStep(1, 'done', 30);
    onStep(2, 'active', 35, steps.length + ' operation(s)\u2026');

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        var wRes = await runPdfWorker('workflow', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          resultBuf = wRes.buffer;
        }
      }
    } catch (e) {
      console.warn('[AdvancedEngine] workflow worker error:', e.message);
    }

    buf = null;
    if (!resultBuf) throw new Error('__orig__');

    onStep(2, 'done', 82);
    onStep(3, 'active', 86);
    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    resultBuf = null;
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-workflow.pdf') };
  };

  // ── MAIN RUNNER ────────────────────────────────────────────────────────────
  async function runTool(toolId, files, opts, origProcess) {
    var totalBytes = Array.from(files).reduce(function (s, f) { return s + (f.size || 0); }, 0);

    if (shouldFallbackMem(totalBytes)) {
      throw new Error('memory_pressure');
    }

    var proc  = processors[toolId];
    if (!proc) throw new Error('No advanced processor: ' + toolId);

    var steps = TOOL_STEPS[toolId] || ['Preparing', 'Processing', 'Finishing'];
    LiveFeed.show(steps, 'Processing\u2026');

    var result;
    try {
      result = await proc(files, opts || {}, function (idx, state, pct, hint) {
        LiveFeed.update(idx, state, pct, hint);
      });
    } catch (err) {
      if (err.message === '__orig__') {
        // Sentinel: delegate to original handler with live overlay still showing
        LiveFeed.update(1, 'active', 30, 'Processing\u2026');
        try {
          result = await origProcess(toolId, files, opts);
        } catch (origErr) {
          LiveFeed.hide();
          vanish();
          throw origErr;
        }
      } else {
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
    if (window.BrowserTools.__advEngineV11) return true;

    var origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      if (ADVANCED_IDS.has(toolId)) {
        return runTool(toolId, files, opts, origProcess);
      }
      return origProcess(toolId, files, opts);
    };

    window.BrowserTools.__advEngineV11 = true;
    console.log('[AdvancedEngine v1.1] installed for:', Array.from(ADVANCED_IDS).join(', '));
    return true;
  }

  if (!installHook()) {
    var _tries = 0;
    var _iv    = setInterval(function () {
      if (installHook() || _tries++ > 40) {
        clearInterval(_iv);
        if (_tries > 40) console.warn('[AdvancedEngine] BrowserTools not found — engine inactive');
      }
    }, 100);
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.AdvancedEngine = {
    version:   '1.1',
    TOOL_IDS:  ADVANCED_IDS,
    LiveFeed:  LiveFeed,
    IDBTemp:   IDBTemp,
    memTier:   memTier,
    workerCap: workerCap,
    vanish:    vanish,
  };

}());

// Advanced Engine — high-performance browser processing for 15 advanced tools.
// Wraps window.BrowserTools.process() transparently; instant tools are untouched.
//
// Architecture:
//   MemoryGuard      — tiered thresholds (600/750/850 MB); throws to trigger server fallback
//   LiveFeed         — injects real-time step UI into #result-area during processing
//   ChunkStream      — reads large files in 2–8 MB chunks (adaptive to device tier)
//   WorkerChain      — routes CPU work to advanced-worker.js (DOCX/XLSX/PPTX/pixels)
//   IDBTempStore     — persists large intermediate buffers across async boundaries
//   VanishSystem     — cleans up blob URLs, temp IDB keys, worker refs on navigate/unload
//
// IMPORTANT: This file must be loaded AFTER browser-tools.js so the hook can wrap
// window.BrowserTools.process() which is defined at the bottom of that file.
(function () {
  'use strict';

  // ── DEVICE PROFILE ─────────────────────────────────────────────────────────
  var _cores = Math.min(navigator.hardwareConcurrency || 2, 8);
  var _isHighEnd = _cores >= 4;
  var CHUNK_SIZE = _isHighEnd ? 8 * 1024 * 1024 : 2 * 1024 * 1024; // 8 MB / 2 MB
  var MAX_WORKERS = _isHighEnd ? 4 : 2;

  // ── MEMORY GUARD ───────────────────────────────────────────────────────────
  var MEM_REDUCE   = 600 * 1024 * 1024;
  var MEM_LOW      = 750 * 1024 * 1024;
  var MEM_FALLBACK = 850 * 1024 * 1024;

  function memUsed() {
    try { return (performance && performance.memory && performance.memory.usedJSHeapSize) || 0; }
    catch (_) { return 0; }
  }

  function memLimit() {
    try { return (performance && performance.memory && performance.memory.jsHeapSizeLimit) || MEM_FALLBACK * 2; }
    catch (_) { return MEM_FALLBACK * 2; }
  }

  function memTier() {
    var u = memUsed();
    if (u >= MEM_FALLBACK) return 'fallback';
    if (u >= MEM_LOW)      return 'low';
    if (u >= MEM_REDUCE)   return 'reduce';
    return 'ok';
  }

  function shouldFallbackMem(fileSizeBytes) {
    var tier = memTier();
    if (tier === 'fallback') return true;
    // Estimate: 4× safety factor for PDF ops
    var needed = (fileSizeBytes || 0) * 4;
    var avail  = Math.max(0, memLimit() - memUsed());
    return needed > avail;
  }

  function workerCap() {
    var tier = memTier();
    if (tier === 'low')    return 1;
    if (tier === 'reduce') return Math.min(2, MAX_WORKERS);
    return MAX_WORKERS;
  }

  // ── IDB TEMP STORE ─────────────────────────────────────────────────────────
  // Separate from IDBCache (CDN scripts) and ToolState (user blobs).
  // Used for large intermediate processing buffers.
  var IDBTemp = (function () {
    var DB_NAME = 'ilovepdf-adv-temp';
    var STORE   = 'chunks';
    var VER     = 1;
    var _db     = null;

    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        try {
          var req = indexedDB.open(DB_NAME, VER);
          req.onupgradeneeded = function () {
            if (!req.result.objectStoreNames.contains(STORE)) {
              req.result.createObjectStore(STORE);
            }
          };
          req.onsuccess = function () { _db = req.result; res(_db); };
          req.onerror   = function () { rej(req.error); };
        } catch (e) { rej(e); }
      });
    }

    function put(key, data) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(data, key);
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
            req.onsuccess = function () { res(req.result || null); };
            req.onerror   = function () { res(null); };
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

  // ── LIVE FEED CSS (injected once) ─────────────────────────────────────────
  var _cssInjected = false;

  function injectFeedCss() {
    if (_cssInjected) return;
    _cssInjected = true;
    var style = document.createElement('style');
    style.id  = 'adv-engine-css';
    style.textContent = [
      '.ae-feed{padding:20px 22px;border-radius:14px;background:#f8faff;border:1.5px solid #e0e7ff;margin:18px 0;font-family:inherit;}',
      '.ae-feed-header{display:flex;align-items:center;gap:11px;margin-bottom:18px;color:#312e81;font-weight:700;font-size:14.5px;letter-spacing:-.01em;}',
      '.ae-spin{width:20px;height:20px;border:2.5px solid #c7d2fe;border-top-color:#6366f1;border-radius:50%;flex-shrink:0;',
        'animation:ae-spin .75s linear infinite;}',
      '@keyframes ae-spin{to{transform:rotate(360deg)}}',
      '.ae-steps{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}',
      '.ae-step{display:flex;align-items:center;gap:10px;font-size:13px;color:#6b7280;',
        'transition:color .2s,font-weight .2s;}',
      '.ae-step[data-s="active"]{color:#4f46e5;font-weight:600;}',
      '.ae-step[data-s="done"]{color:#059669;}',
      '.ae-step[data-s="error"]{color:#dc2626;}',
      '.ae-dot{width:10px;height:10px;border-radius:50%;background:#d1d5db;flex-shrink:0;transition:background .2s;}',
      '.ae-step[data-s="active"] .ae-dot{background:#6366f1;animation:ae-pulse .9s ease-in-out infinite;}',
      '.ae-step[data-s="done"] .ae-dot{background:#10b981;}',
      '.ae-step[data-s="error"] .ae-dot{background:#ef4444;}',
      '@keyframes ae-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '.ae-check{display:none;width:12px;height:12px;color:#10b981;}',
      '.ae-step[data-s="done"] .ae-check{display:inline-block;}',
      '.ae-step[data-s="done"] .ae-dot{display:none;}',
      '.ae-bar-wrap{height:7px;background:#e0e7ff;border-radius:4px;overflow:hidden;margin-bottom:8px;}',
      '.ae-bar-fill{height:100%;background:linear-gradient(90deg,#6366f1 0%,#818cf8 100%);',
        'border-radius:4px;transition:width .45s cubic-bezier(.4,0,.2,1);width:0%;}',
      '.ae-hint{font-size:11.5px;color:#9ca3af;text-align:center;min-height:16px;transition:opacity .2s;}',
    ].join('');
    document.head.appendChild(style);
  }

  // ── LIVE FEED ──────────────────────────────────────────────────────────────
  var LiveFeed = {
    _steps: [],

    show: function (steps, title) {
      injectFeedCss();
      this._steps = steps;
      var area = document.getElementById('result-area');
      if (!area) return;

      var stepsHtml = steps.map(function (label, i) {
        return '<div class="ae-step" id="ae-s-' + i + '" data-s="pending">' +
               '<span class="ae-dot"></span>' +
               '<svg class="ae-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">' +
               '<polyline points="2,6 5,9 10,3"/></svg>' +
               '<span>' + escHtml(label) + '</span></div>';
      }).join('');

      area.innerHTML =
        '<div class="ae-feed">' +
          '<div class="ae-feed-header">' +
            '<div class="ae-spin"></div>' +
            '<span>' + escHtml(title || 'Processing\u2026') + '</span>' +
          '</div>' +
          '<div class="ae-steps">' + stepsHtml + '</div>' +
          '<div class="ae-bar-wrap"><div class="ae-bar-fill" id="ae-bar"></div></div>' +
          '<div class="ae-hint" id="ae-hint"></div>' +
        '</div>';
    },

    update: function (idx, state, pct, hint) {
      var step = document.getElementById('ae-s-' + idx);
      if (step) step.setAttribute('data-s', state);
      if (typeof pct === 'number') {
        var bar = document.getElementById('ae-bar');
        if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
      }
      if (typeof hint === 'string') {
        var h = document.getElementById('ae-hint');
        if (h) h.textContent = hint;
      }
    },

    done: function () {
      var bar = document.getElementById('ae-bar');
      if (bar) bar.style.width = '100%';
    },
  };

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── CHUNK STREAM ───────────────────────────────────────────────────────────
  // Reads a File in adaptive-sized chunks; invokes onChunk for each.
  // onChunk(buf, chunkIndex, byteOffset, totalBytes, isLast) → Promise | void
  function streamFile(file, onChunk, chunkSize) {
    chunkSize = chunkSize || CHUNK_SIZE;
    var total  = file.size;
    var offset = 0;
    var idx    = 0;

    function next() {
      if (offset >= total) return Promise.resolve();
      var end   = Math.min(offset + chunkSize, total);
      var slice = file.slice(offset, end);
      offset   += chunkSize;
      var ci    = idx++;
      var isLast = offset >= total;

      return slice.arrayBuffer().then(function (buf) {
        return Promise.resolve(onChunk(buf, ci, end - chunkSize, total, isLast));
      }).then(function () {
        return next();
      });
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
        return reject(new Error('Worker creation failed: ' + e.message));
      }

      w.onmessage = function (e) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        if (e.data && e.data.__error) {
          reject(new Error(e.data.__error));
        } else {
          resolve(e.data);
        }
      };

      w.onerror = function (e) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        reject(new Error((e && e.message) || 'Worker script error'));
      };

      try {
        w.postMessage(message, transferables || []);
      } catch (e) {
        w.postMessage(message);
      }
    });
  }

  // Reuse existing WorkerPool + pdf-worker.js for pure pdf-lib operations
  function runPdfWorker(toolId, buffers, options) {
    var pool = window.WorkerPool;
    if (!pool) return Promise.reject(new Error('WorkerPool not available'));
    return pool.run(
      '/workers/pdf-worker.js',
      { tool: toolId, buffers: buffers, options: options || {} },
      buffers
    );
  }

  // ── VANISH SYSTEM ──────────────────────────────────────────────────────────
  var _blobUrls = [];
  var _tempKeys = [];

  function trackBlob(url)  { _blobUrls.push(url); }
  function trackKey(key)   { _tempKeys.push(key); }

  function vanish() {
    _blobUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (_) {} });
    _blobUrls.length = 0;

    var keys = _tempKeys.slice();
    _tempKeys.length = 0;
    keys.forEach(function (k) { IDBTemp.del(k).catch(function () {}); });
  }

  window.addEventListener('beforeunload', vanish);
  window.addEventListener('popstate',     vanish);
  // Hash-based SPA navigation
  window.addEventListener('hashchange',   function () {
    // Only vanish if leaving the tool entirely (going to upload step from download)
    // Keep blobs alive within the same tool session
  });

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function brandedFilename(originalName, newExt) {
    var base = (originalName || 'file').replace(/\.[^.]+$/, '');
    var safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
    return 'ILovePDF-' + safe + newExt;
  }

  // Load pdf.js lazily (reuse global if already loaded by browser-tools.js)
  var _pdfJsPromise = null;
  var PDFJS_URL    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (_pdfJsPromise)   return _pdfJsPromise;
    _pdfJsPromise = import(PDFJS_URL).then(function (mod) {
      var lib = (mod && (mod.default || mod));
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = lib;
      return lib;
    });
    return _pdfJsPromise;
  }

  // Extract text from a pdf.js page; returns { lines, text }
  function extractPageText(pdfPage) {
    return pdfPage.getTextContent().then(function (content) {
      var text = content.items.map(function (it) { return it.str; }).join(' ');
      return { text: text, lines: text.split(/\s+/).filter(Boolean) };
    });
  }

  // ── TOOL STEPS DEFINITIONS ─────────────────────────────────────────────────
  var TOOL_STEPS = {
    'compress':           ['Reading file',       'Analysing PDF structure', 'Optimising',           'Saving output'],
    'pdf-to-word':        ['Reading PDF',        'Extracting text & layout','Building Word document','Packaging output'],
    'pdf-to-excel':       ['Reading PDF',        'Detecting table structure','Building spreadsheet', 'Packaging output'],
    'pdf-to-powerpoint':  ['Reading PDF',        'Extracting page content', 'Building slides',      'Packaging output'],
    'word-to-pdf':        ['Reading document',   'Parsing Word structure',  'Rendering to PDF',     'Saving output'],
    'excel-to-pdf':       ['Reading spreadsheet','Parsing sheet data',      'Rendering to PDF',     'Saving output'],
    'html-to-pdf':        ['Reading HTML',       'Rendering page layout',   'Exporting to PDF',     'Saving output'],
    'ocr':                ['Reading PDF',        'Rendering pages',         'Recognising text',     'Compiling result'],
    'scan-to-pdf':        ['Reading images',     'Optimising quality',      'Creating PDF',         'Saving output'],
    'background-remover': ['Loading image',      'Analysing pixels',        'Removing background',  'Saving PNG'],
    'repair':             ['Reading PDF',        'Scanning for errors',     'Rebuilding structure', 'Saving output'],
    'compare':            ['Reading documents',  'Extracting text',         'Analysing differences','Building report'],
    'ai-summarize':       ['Reading PDF',        'Extracting text',         'Scoring sentences',    'Building summary'],
    'translate':          ['Reading PDF',        'Extracting content',      'Translating text',     'Building output'],
    'workflow':           ['Reading PDF',        'Applying operations',     'Chaining steps',       'Saving result'],
  };

  var ADVANCED_IDS = new Set(Object.keys(TOOL_STEPS));

  // ── TOOL PROCESSORS ────────────────────────────────────────────────────────
  // Each processor: async (files, opts, onStep) → { blob, filename }
  // onStep(stepIdx, state, pct, hint)  state = 'active' | 'done' | 'error'

  var processors = {};

  // ─── COMPRESS ───────────────────────────────────────────────────────────────
  processors['compress'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var buf = await file.arrayBuffer();
    onStep(0, 'done', 15);
    onStep(1, 'active', 20);

    var resultBuf = null;

    // Try worker path first
    try {
      if (window.WorkerPool) {
        onStep(2, 'active', 30);
        var wRes = await runPdfWorker('compress', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          resultBuf = wRes.buffer;
        }
      }
    } catch (e) {
      console.warn('[AdvancedEngine] compress worker failed, falling to main-thread:', e.message);
    }

    onStep(1, 'done', 50);
    onStep(2, 'active', 55);

    if (!resultBuf) {
      // Main-thread fallback using the existing BrowserTools handler
      throw new Error('compress_use_orig');
    }

    var savings = Math.max(0, file.size - resultBuf.byteLength);
    onStep(2, 'done', 80);
    onStep(3, 'active', 85);

    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    onStep(3, 'done', 100);
    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.pdf'),
      meta:     { original: file.size, compressed: resultBuf.byteLength, saved: savings },
    };
  };

  // ─── PDF TO WORD ─────────────────────────────────────────────────────────────
  processors['pdf-to-word'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var total = pdf.numPages;
    var pages = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      var text    = content.items.map(function (it) { return it.str; }).join(' ');
      pages.push({ pageNum: i, text: text });

      var pct = 15 + Math.round((i / total) * 45);
      onStep(1, 'active', pct, 'Extracting page ' + i + ' of ' + total + '\u2026');
    }

    onStep(1, 'done', 60);
    onStep(2, 'active', 65, 'Building Word document\u2026');

    var workerResult = await runAdvancedWorker({ op: 'build-docx', pages: pages, filename: file.name });
    if (!workerResult || !workerResult.buffer) throw new Error('DOCX build failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 92);

    var blob = new Blob(
      [workerResult.buffer],
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    );
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.docx') };
  };

  // ─── PDF TO EXCEL ────────────────────────────────────────────────────────────
  processors['pdf-to-excel'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var total = pdf.numPages;
    var allRows = [['Page', 'Content']]; // header row

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();

      // Try to detect columns by x-position
      var byLine = {};
      content.items.forEach(function (it) {
        var y = Math.round(it.transform[5] / 10) * 10; // quantise Y
        if (!byLine[y]) byLine[y] = [];
        byLine[y].push({ x: it.transform[4], str: it.str });
      });

      var ys = Object.keys(byLine).map(Number).sort(function (a, b) { return b - a; });
      ys.forEach(function (y) {
        var items = byLine[y].sort(function (a, b) { return a.x - b.x; });
        var row   = items.map(function (it) { return it.str.trim(); }).filter(Boolean);
        if (row.length) allRows.push([i].concat(row));
      });

      var pct = 15 + Math.round((i / total) * 45);
      onStep(1, 'active', pct, 'Processing page ' + i + ' of ' + total + '\u2026');
    }

    onStep(1, 'done', 60);
    onStep(2, 'active', 65, 'Building spreadsheet\u2026');

    var workerResult = await runAdvancedWorker({
      op:     'build-xlsx',
      sheets: [{ name: 'PDF Content', rows: allRows }],
    });
    if (!workerResult || !workerResult.buffer) throw new Error('XLSX build failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 92);

    var blob = new Blob(
      [workerResult.buffer],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    );
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.xlsx') };
  };

  // ─── PDF TO POWERPOINT ──────────────────────────────────────────────────────
  processors['pdf-to-powerpoint'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf    = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var total  = pdf.numPages;
    var slides = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      var items   = content.items;

      // Use the largest font-size text on the page as the slide title
      var biggest = { str: '', h: 0 };
      items.forEach(function (it) {
        var h = Math.abs(it.transform[3]);
        if (h > biggest.h) { biggest = { str: it.str, h: h }; }
      });

      var bodyText = items
        .filter(function (it) { return it.str !== biggest.str; })
        .map(function (it) { return it.str; })
        .join(' ')
        .trim();

      slides.push({
        pageNum: i,
        title:   biggest.str || ('Page ' + i),
        text:    bodyText,
      });

      var pct = 15 + Math.round((i / total) * 45);
      onStep(1, 'active', pct, 'Extracting slide ' + i + ' of ' + total + '\u2026');
    }

    onStep(1, 'done', 60);
    onStep(2, 'active', 65, 'Building PPTX\u2026');

    var docTitle = file.name.replace(/\.[^.]+$/, '');
    var workerResult = await runAdvancedWorker({
      op:       'build-pptx',
      slides:   slides,
      docTitle: docTitle,
    });
    if (!workerResult || !workerResult.buffer) throw new Error('PPTX build failed');

    onStep(2, 'done', 90);
    onStep(3, 'active', 92);

    var blob = new Blob(
      [workerResult.buffer],
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.pptx') };
  };

  // ─── WORD TO PDF (streaming + worker) ────────────────────────────────────────
  // Strategy: mammoth converts DOCX to HTML in chunks; html2pdf renders to PDF.
  // For large files, we read the DOCX in a memory-safe streaming fashion.
  processors['word-to-pdf'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    // Read file in chunks via stream, but pass full buffer to mammoth
    var chunks = [];
    await streamFile(file, function (buf, idx, off, total, isLast) {
      chunks.push(buf);
      var pct = 5 + Math.round(((off + buf.byteLength) / total) * 15);
      onStep(0, 'active', pct, 'Reading\u2026 ' + Math.round(((off + buf.byteLength) / total) * 100) + '%');
    });

    // Concatenate chunks into one buffer
    var totalLen = chunks.reduce(function (s, c) { return s + c.byteLength; }, 0);
    var combined = new Uint8Array(totalLen);
    var offset   = 0;
    chunks.forEach(function (c) { combined.set(new Uint8Array(c), offset); offset += c.byteLength; });
    chunks = null; // free

    onStep(0, 'done', 20);
    onStep(1, 'active', 22, 'Parsing Word structure\u2026');

    // Use the existing BrowserTools word-to-pdf implementation which uses mammoth
    // (we just add the streaming read and live progress around it)
    throw new Error('word-to-pdf_use_orig');
  };

  // ─── EXCEL TO PDF ─────────────────────────────────────────────────────────
  processors['excel-to-pdf'] = async function (files, opts, onStep) {
    onStep(0, 'active', 5);
    // Delegate to original with progress wrapping
    throw new Error('excel-to-pdf_use_orig');
  };

  // ─── HTML TO PDF ──────────────────────────────────────────────────────────
  processors['html-to-pdf'] = async function (files, opts, onStep) {
    onStep(0, 'active', 5);
    throw new Error('html-to-pdf_use_orig');
  };

  // ─── OCR PDF ──────────────────────────────────────────────────────────────
  // Strategy: render each page to a canvas at 150 DPI → Tesseract OCR →
  //           collect text → build plain-text blob
  processors['ocr'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var total = pdf.numPages;
    var scale = _isHighEnd ? 2.0 : 1.5; // DPI: 144/108

    // Render all pages to ImageData — one at a time for memory safety
    var pageImages = [];

    for (var i = 1; i <= total; i++) {
      var pg  = await pdf.getPage(i);
      var vp  = pg.getViewport({ scale: scale });
      var cvs = document.createElement('canvas');
      cvs.width  = Math.round(vp.width);
      cvs.height = Math.round(vp.height);
      var ctx = cvs.getContext('2d');
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      pageImages.push({ canvas: cvs, pageNum: i });

      var pct = 15 + Math.round((i / total) * 30);
      onStep(1, 'active', pct, 'Rendering page ' + i + ' of ' + total);
    }

    onStep(1, 'done', 45);
    onStep(2, 'active', 47, 'Starting text recognition\u2026');

    // Load Tesseract via existing loadScriptCached or plain script tag
    var Tesseract = window.Tesseract;
    if (!Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js');
      Tesseract = window.Tesseract;
    }
    if (!Tesseract) throw new Error('Tesseract.js failed to load');

    var lang   = (opts && opts.language) || 'eng';
    var worker = await Tesseract.createWorker(lang, 1, {
      workerPath:     'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/worker.min.js',
      corePath:       'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js',
      langPath:       'https://tessdata.projectnaptha.com/4.0.0',
    });

    var allText = '';
    for (var j = 0; j < pageImages.length; j++) {
      var imgItem = pageImages[j];
      var result  = await worker.recognize(imgItem.canvas);
      allText += '=== Page ' + imgItem.pageNum + ' ===\n' + result.data.text + '\n\n';

      var pct2 = 47 + Math.round(((j + 1) / pageImages.length) * 40);
      onStep(2, 'active', pct2, 'OCR: page ' + (j + 1) + ' of ' + pageImages.length);

      // Release canvas after recognition
      imgItem.canvas.width = 0;
      imgItem.canvas.height = 0;
    }

    await worker.terminate();

    onStep(2, 'done', 87);
    onStep(3, 'active', 90, 'Compiling result\u2026');

    var blob = new Blob([allText], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.txt') };
  };

  // ─── SCAN TO PDF ───────────────────────────────────────────────────────────
  processors['scan-to-pdf'] = async function (files, opts, onStep) {
    onStep(0, 'active', 5);
    // Use the existing imagesToPdf handler — just wrap with progress
    throw new Error('scan-to-pdf_use_orig');
  };

  // ─── BACKGROUND REMOVER ───────────────────────────────────────────────────
  // Strategy: read image → OffscreenCanvas (or regular canvas) → get ImageData →
  //           send pixels to advanced-worker (no DOM) → get back masked pixels →
  //           draw to canvas → export PNG
  processors['background-remover'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    // Load image via blob URL
    var objUrl = URL.createObjectURL(file);
    trackBlob(objUrl);

    var img = await new Promise(function (res, rej) {
      var i  = new Image();
      i.onload  = function () { res(i); };
      i.onerror = function () { rej(new Error('Failed to load image')); };
      i.src = objUrl;
    });

    onStep(0, 'done', 15);
    onStep(1, 'active', 18, 'Reading pixel data\u2026');

    var cvs = document.createElement('canvas');
    cvs.width  = img.naturalWidth;
    cvs.height = img.naturalHeight;
    var ctx = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var imageData = ctx.getImageData(0, 0, cvs.width, cvs.height);

    onStep(1, 'done', 35);
    onStep(2, 'active', 38, 'Removing background\u2026');

    // Transfer pixel data to worker for processing
    var threshold = parseInt((opts && opts.threshold) || '235', 10);
    var pixelBuf  = imageData.data.buffer.slice(0); // copy so we can transfer

    var result = await runAdvancedWorker(
      { op: 'remove-bg', pixels: new Uint8ClampedArray(pixelBuf), width: cvs.width, height: cvs.height, threshold: threshold },
      [pixelBuf]
    );

    if (!result || !result.pixels) throw new Error('Background removal failed in worker');

    onStep(2, 'done', 80);
    onStep(3, 'active', 82, 'Saving PNG\u2026');

    // Put processed pixels back to canvas and export PNG
    var outCvs = document.createElement('canvas');
    outCvs.width  = cvs.width;
    outCvs.height = cvs.height;
    var outCtx = outCvs.getContext('2d');
    var outData = outCtx.createImageData(cvs.width, cvs.height);
    outData.data.set(result.pixels);
    outCtx.putImageData(outData, 0, 0);

    var blob = await new Promise(function (res) {
      outCvs.toBlob(function (b) { res(b); }, 'image/png');
    });

    if (!blob || blob.size === 0) throw new Error('Canvas export produced empty blob');

    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '.png') };
  };

  // ─── REPAIR PDF ────────────────────────────────────────────────────────────
  processors['repair'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var buf = await file.arrayBuffer();
    onStep(0, 'done', 15);
    onStep(1, 'active', 20, 'Scanning for structural issues\u2026');

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
      console.warn('[AdvancedEngine] repair worker failed:', e.message);
    }

    if (!resultBuf) throw new Error('repair_use_orig');

    onStep(1, 'done', 60);
    onStep(2, 'done', 75);
    onStep(3, 'active', 80);

    var blob = new Blob([resultBuf], { type: 'application/pdf' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-repaired.pdf') };
  };

  // ─── COMPARE PDF ───────────────────────────────────────────────────────────
  processors['compare'] = async function (files, opts, onStep) {
    if (files.length < 2) throw new Error('Compare requires two PDF files');

    onStep(0, 'active', 5);
    var pdfjsLib = await loadPdfJs();

    // Read both files concurrently (memory-safe: only two small buffers)
    var bufs = await Promise.all([files[0].arrayBuffer(), files[1].arrayBuffer()]);
    onStep(0, 'done', 15);
    onStep(1, 'active', 18);

    // Extract text from both PDFs concurrently
    var results = await Promise.all(bufs.map(function (buf) {
      return pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise
        .then(function (pdf) {
          var pages = [];
          var chain = Promise.resolve();
          for (var i = 1; i <= pdf.numPages; i++) {
            (function (pageNum) {
              chain = chain.then(function () {
                return pdf.getPage(pageNum).then(function (pg) {
                  return pg.getTextContent();
                }).then(function (c) {
                  pages.push(c.items.map(function (it) { return it.str; }).join(' '));
                });
              });
            }(i));
          }
          return chain.then(function () { return pages; });
        });
    }));

    onStep(1, 'done', 50);
    onStep(2, 'active', 55, 'Analysing differences\u2026');

    // Send text chunks to advanced worker for scoring
    var pagesA = results[0];
    var pagesB = results[1];

    // Line-level diff (word count comparison)
    var maxPages = Math.max(pagesA.length, pagesB.length);
    var diffs = [];

    for (var p = 0; p < maxPages; p++) {
      var a = (pagesA[p] || '').trim();
      var b = (pagesB[p] || '').trim();

      if (!a && !b) continue;

      var wordsA = a.split(/\s+/).filter(Boolean);
      var wordsB = b.split(/\s+/).filter(Boolean);
      var setA   = new Set(wordsA);
      var setB   = new Set(wordsB);

      var added   = wordsB.filter(function (w) { return !setA.has(w); });
      var removed = wordsA.filter(function (w) { return !setB.has(w); });

      diffs.push({
        page:        p + 1,
        addedWords:  added.length,
        removedWords:removed.length,
        preview:     a.substring(0, 120) + (a.length > 120 ? '\u2026' : ''),
      });
    }

    onStep(2, 'done', 80);
    onStep(3, 'active', 83, 'Building report\u2026');

    // Build plain-text comparison report
    var nameA = files[0].name;
    var nameB = files[1].name;
    var lines = [
      'ILovePDF \u2014 Document Comparison Report',
      '='.repeat(50),
      'Document A: ' + nameA + ' (' + pagesA.length + ' pages)',
      'Document B: ' + nameB + ' (' + pagesB.length + ' pages)',
      '',
      'PAGE-BY-PAGE DIFFERENCES',
      '-'.repeat(50),
    ];

    var totalAdded = 0, totalRemoved = 0;
    diffs.forEach(function (d) {
      totalAdded   += d.addedWords;
      totalRemoved += d.removedWords;
      lines.push(
        'Page ' + d.page + ': ' +
        '+' + d.addedWords + ' words added, ' +
        '-' + d.removedWords + ' words removed'
      );
      if (d.preview) lines.push('  Preview: ' + d.preview);
    });

    lines.push('');
    lines.push('SUMMARY');
    lines.push('-'.repeat(50));
    lines.push('Total words added:   ' + totalAdded);
    lines.push('Total words removed: ' + totalRemoved);
    lines.push('Pages compared:      ' + maxPages);

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

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var total = pdf.numPages;
    var allText = '';

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      allText    += content.items.map(function (it) { return it.str; }).join(' ') + ' ';
      var pct = 15 + Math.round((i / total) * 35);
      onStep(1, 'active', pct, 'Reading page ' + i + ' of ' + total + '\u2026');
    }

    onStep(1, 'done', 50);
    onStep(2, 'active', 55, 'Scoring sentences\u2026');

    var maxSentences = parseInt((opts && opts.length) || '7', 10) || 7;

    // Offload scoring to worker
    var scored = await runAdvancedWorker({
      op:           'chunk-text-score',
      text:         allText,
      maxSentences: maxSentences,
    });

    if (!scored) throw new Error('Summarization worker failed');

    onStep(2, 'done', 85);
    onStep(3, 'active', 88, 'Building summary\u2026');

    var report = [
      'ILovePDF \u2014 AI Summary',
      '='.repeat(50),
      'Source: ' + file.name,
      'Pages:  ' + total,
      'Words:  ' + scored.wordCount,
      '',
      'SUMMARY',
      '-'.repeat(50),
      scored.summary,
      '',
      'Statistics: ' + scored.sentenceCount + ' sentences analysed, ' +
        maxSentences + ' selected.',
    ].join('\n');

    var blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-summary.txt') };
  };

  // ─── TRANSLATE PDF ──────────────────────────────────────────────────────────
  // Strategy: extract text per page, group into chunks ≤4000 chars,
  //           translate via MyMemory free API, rebuild into annotated text file.
  processors['translate'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var pdfjsLib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 12);
    onStep(1, 'active', 15);

    var pdf   = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var total = pdf.numPages;
    var pages = [];

    for (var i = 1; i <= total; i++) {
      var page    = await pdf.getPage(i);
      var content = await page.getTextContent();
      var text    = content.items.map(function (it) { return it.str; }).join(' ').trim();
      pages.push({ num: i, text: text });
      var pct = 15 + Math.round((i / total) * 30);
      onStep(1, 'active', pct, 'Reading page ' + i + ' of ' + total);
    }

    onStep(1, 'done', 45);
    onStep(2, 'active', 48);

    var targetLang = (opts && opts.targetLanguage) || 'es';
    var translated = [];
    var MAX_CHARS  = 500; // MyMemory free tier limit per request

    for (var p = 0; p < pages.length; p++) {
      var pg = pages[p];
      var text = pg.text;

      if (!text) {
        translated.push({ num: pg.num, text: '' });
        continue;
      }

      // Chunk text for translation
      var chunks = [];
      var pos    = 0;
      while (pos < text.length) {
        chunks.push(text.slice(pos, pos + MAX_CHARS));
        pos += MAX_CHARS;
      }

      var translatedChunks = [];
      for (var c = 0; c < chunks.length; c++) {
        try {
          var resp = await fetch(
            'https://api.mymemory.translated.net/get?q=' +
            encodeURIComponent(chunks[c]) +
            '&langpair=en|' + encodeURIComponent(targetLang)
          );
          var json = await resp.json();
          translatedChunks.push(
            (json.responseData && json.responseData.translatedText) || chunks[c]
          );
        } catch (_) {
          translatedChunks.push(chunks[c]); // keep original on error
        }
      }

      translated.push({ num: pg.num, text: translatedChunks.join(' ') });
      var pct2 = 48 + Math.round(((p + 1) / pages.length) * 35);
      onStep(2, 'active', pct2, 'Translating page ' + (p + 1) + ' of ' + pages.length);
    }

    onStep(2, 'done', 83);
    onStep(3, 'active', 86, 'Building output\u2026');

    var lang = targetLang.toUpperCase();
    var lines = [
      'ILovePDF \u2014 Translated Document (' + lang + ')',
      '='.repeat(50),
      'Source: ' + file.name,
      '',
    ];
    translated.forEach(function (pg) {
      lines.push('--- Page ' + pg.num + ' ---');
      lines.push(pg.text || '(empty page)');
      lines.push('');
    });

    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: blob, filename: brandedFilename(file.name, '-translated-' + targetLang + '.txt') };
  };

  // ─── WORKFLOW ──────────────────────────────────────────────────────────────
  processors['workflow'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 5);

    var buf = await file.arrayBuffer();
    onStep(0, 'done', 15);
    onStep(1, 'active', 20);

    var steps = [
      { op: opts.step1, value: opts.step1_value || '' },
      { op: opts.step2, value: opts.step2_value || '' },
      { op: opts.step3, value: opts.step3_value || '' },
    ].filter(function (s) { return s.op && s.op !== ''; });

    if (steps.length === 0) throw new Error('Please select at least one operation');

    onStep(1, 'done', 30);
    onStep(2, 'active', 35, 'Applying ' + steps.length + ' operation(s)\u2026');

    try {
      if (window.WorkerPool) {
        var wRes = await runPdfWorker('workflow', [buf], opts);
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          onStep(2, 'done', 85);
          onStep(3, 'active', 88);
          var blob = new Blob([wRes.buffer], { type: 'application/pdf' });
          onStep(3, 'done', 100);
          return { blob: blob, filename: brandedFilename(file.name, '-workflow.pdf') };
        }
      }
    } catch (e) {
      console.warn('[AdvancedEngine] workflow worker failed:', e.message);
    }

    throw new Error('workflow_use_orig');
  };

  // ── TOOLS THAT DELEGATE BACK TO ORIGINAL ──────────────────────────────────
  // These get live feed wrapping but the actual transformation uses the
  // highly-optimised existing handler (mammoth, html2pdf, etc.)
  var ORIG_DELEGATE = new Set([
    'word-to-pdf', 'excel-to-pdf', 'html-to-pdf', 'scan-to-pdf',
    'compress_use_orig', 'repair_use_orig', 'workflow_use_orig',
  ]);

  // ── SCRIPT LOADER HELPER ──────────────────────────────────────────────────
  function loadScript(url) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + url + '"]')) return res();
      var s   = document.createElement('script');
      s.src   = url;
      s.onload  = res;
      s.onerror = function () { rej(new Error('Failed to load: ' + url)); };
      document.head.appendChild(s);
    });
  }

  // ── MAIN PROCESS FUNCTION ─────────────────────────────────────────────────
  async function runTool(toolId, files, opts, origProcess) {
    var totalBytes = Array.from(files).reduce(function (s, f) { return s + (f.size || 0); }, 0);

    if (shouldFallbackMem(totalBytes)) {
      throw new Error('memory_pressure');
    }

    var proc  = processors[toolId];
    var steps = TOOL_STEPS[toolId] || ['Preparing', 'Processing', 'Finishing'];
    LiveFeed.show(steps, 'Processing\u2026');

    try {
      var result = await proc(files, opts || {}, function (idx, state, pct, hint) {
        LiveFeed.update(idx, state, pct, hint);
      });
      LiveFeed.done();
      vanish();
      return result;
    } catch (err) {
      // Special sentinel codes → delegate to original handler
      var code = err.message || '';
      if (
        code === 'compress_use_orig' ||
        code === 'repair_use_orig'   ||
        code === 'workflow_use_orig' ||
        code === 'word-to-pdf_use_orig'  ||
        code === 'excel-to-pdf_use_orig' ||
        code === 'html-to-pdf_use_orig'  ||
        code === 'scan-to-pdf_use_orig'
      ) {
        // Update live feed to show we're in the processing phase
        LiveFeed.update(1, 'active', 30, 'Processing\u2026');
        try {
          var origResult = await origProcess(toolId, files, opts);
          LiveFeed.done();
          vanish();
          return origResult;
        } catch (origErr) {
          vanish();
          throw origErr;
        }
      }
      vanish();
      throw err;
    }
  }

  // ── INSTALL HOOK ──────────────────────────────────────────────────────────
  // Wraps window.BrowserTools.process() after it is defined by browser-tools.js
  function installHook() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__advancedEngineInstalled) return true;

    var origProcess = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      if (ADVANCED_IDS.has(toolId)) {
        try {
          return await runTool(toolId, files, opts, origProcess);
        } catch (err) {
          // Propagate so tool-page.js can fall through to server API
          throw err;
        }
      }
      // Instant tools: untouched
      return origProcess(toolId, files, opts);
    };

    window.BrowserTools.__advancedEngineInstalled = true;
    console.log('[AdvancedEngine] v1.0 installed \u2014 advanced tools: ' + Array.from(ADVANCED_IDS).join(', '));
    return true;
  }

  // BrowserTools is loaded synchronously before this file (per tool.html script order)
  // but use a small retry loop to be safe against script load races
  if (!installHook()) {
    var _tries   = 0;
    var _interval = setInterval(function () {
      if (installHook() || _tries++ > 30) {
        clearInterval(_interval);
        if (_tries > 30) console.warn('[AdvancedEngine] BrowserTools not found — advanced engine inactive');
      }
    }, 100);
  }

  // Expose for debugging / testing
  window.AdvancedEngine = {
    TOOL_IDS:   ADVANCED_IDS,
    LiveFeed:   LiveFeed,
    IDBTemp:    IDBTemp,
    memTier:    memTier,
    workerCap:  workerCap,
    vanish:     vanish,
  };
}());

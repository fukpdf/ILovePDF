// Phase 27–30 Enhancements v1.0
// PURELY ADDITIVE layer — wraps window.BrowserTools.process() one more time
// (after Phase 26 has already wrapped it), adding:
//
//   Phase 27: Per-tool deep validation & quality upgrades for all 33 tools
//   Phase 28: Giant-file OPFS resume system (IDB checkpoint + page-level resume)
//   Phase 29: Full system debug / stress-test hooks
//   Phase 30: Production hardening (preconnect, quota guard, unload cleanup, PWA)
//
// Load order (tool.html):  … phase26-enhancements.js → phase27-30-enhancements.js
//                                → browser-tools.js → advanced-engine.js (defer)
//
// Exposes: window.Phase2730
// Depends on: LargeFileStreaming, EvictionManager, MemPressure, GiantFileTelemetry,
//             OPFSManager, RollingProcessor (all Phase 25–26)

(function () {
  'use strict';

  var VERSION = '1.0';
  var MB      = 1024 * 1024;

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 27 — PER-TOOL DEEP VALIDATION & QUALITY ENHANCEMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Accepted MIME / extension tables ──────────────────────────────────────
  var PDF_MIME   = ['application/pdf'];
  var IMG_MIME   = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];
  var WORD_MIME  = ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  var EXCEL_MIME = ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  var PPT_MIME   = ['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
  var HTML_MIME  = ['text/html'];

  function ext(file) {
    return (file.name || '').toLowerCase().split('.').pop();
  }

  function mime(file) {
    return (file.type || '').toLowerCase();
  }

  // Tolerant check: accepts if MIME matches OR extension matches
  function acceptsAny(file, mimes, exts) {
    var m = mime(file), e = ext(file);
    for (var i = 0; i < mimes.length; i++) if (m === mimes[i]) return true;
    for (var j = 0; j < exts.length; j++)  if (e === exts[j])  return true;
    return false;
  }

  function isPdf(file)  { return acceptsAny(file, PDF_MIME,   ['pdf']);  }
  function isImg(file)  { return acceptsAny(file, IMG_MIME,   ['jpg','jpeg','png','webp','gif','bmp','tiff']); }
  function isWord(file) { return acceptsAny(file, WORD_MIME,  ['doc','docx']); }
  function isExcel(file){ return acceptsAny(file, EXCEL_MIME, ['xls','xlsx']); }
  function isPpt(file)  { return acceptsAny(file, PPT_MIME,   ['ppt','pptx']); }
  function isHtml(file) { return acceptsAny(file, HTML_MIME,  ['html','htm']); }

  // ── Size-limit table (bytes) — per-tool overrides ────────────────────────
  // These are ADVISORY limits emitted as warnings, not hard blocks.
  // Hard blocks already exist in browser-tools.js. We warn earlier and friendlier.
  var SOFT_LIMIT = {
    'merge':              500 * MB,
    'split':              200 * MB,
    'compress':           200 * MB,
    'rotate':             100 * MB,
    'word-to-pdf':         50 * MB,
    'html-to-pdf':         20 * MB,
    'jpg-to-pdf':         200 * MB,
    'crop-pdf':           100 * MB,
    'extract-pages':      200 * MB,
    'pdf-to-jpg':         200 * MB,
    'crop-image':          50 * MB,
    'resize-image':        50 * MB,
    'image-filters':       50 * MB,
    'pdf-to-word':        150 * MB,
    'pdf-to-excel':       150 * MB,
    'repair':             200 * MB,
    'compare':            100 * MB,
    'ocr':                150 * MB,
    'background-remover':  50 * MB,
    'ai-summarize':       100 * MB,
    'translate':          100 * MB,
    'workflow':           200 * MB,
    'pdf-to-powerpoint':  150 * MB,
    'powerpoint-to-pdf':   50 * MB,
    'excel-to-pdf':        50 * MB,
    'scan-to-pdf':        200 * MB,
    'watermark':          100 * MB,
    'page-numbers':       100 * MB,
    'sign':               100 * MB,
    'redact':             100 * MB,
    'edit':               100 * MB,
    'protect':            200 * MB,
    'unlock':             200 * MB,
  };

  // ── Expected input type per tool ──────────────────────────────────────────
  // Returns null if validation is not applicable, or a warning string.
  function validateInputs(toolId, files) {
    if (!files || !files.length) return null;
    var arr = Array.from(files);

    switch (toolId) {
      // PDF-only tools
      case 'split':
      case 'compress':
      case 'rotate':
      case 'crop-pdf':
      case 'extract-pages':
      case 'pdf-to-jpg':
      case 'pdf-to-word':
      case 'pdf-to-excel':
      case 'pdf-to-powerpoint':
      case 'repair':
      case 'ocr':
      case 'ai-summarize':
      case 'translate':
      case 'workflow':
      case 'watermark':
      case 'page-numbers':
      case 'sign':
      case 'redact':
      case 'edit':
      case 'protect':
      case 'unlock':
        if (!arr.every(isPdf))
          return 'Please upload PDF files for the ' + toolId + ' tool.';
        break;

      // Merge: needs ≥2 PDFs
      case 'merge':
        if (arr.length < 2)
          return 'Please upload at least 2 PDF files to merge.';
        if (!arr.every(isPdf))
          return 'Please upload PDF files only to merge.';
        break;

      // Compare: exactly 2 PDFs
      case 'compare':
        if (arr.length !== 2)
          return 'Please upload exactly 2 PDF files to compare.';
        if (!arr.every(isPdf))
          return 'Please upload PDF files to compare.';
        break;

      // Image-only tools
      case 'background-remover':
      case 'crop-image':
      case 'resize-image':
      case 'image-filters':
        if (!arr.every(isImg))
          return 'Please upload image files (JPG, PNG, WebP) for ' + toolId + '.';
        break;

      // Image→PDF: accepts images (and PDFs gracefully)
      case 'jpg-to-pdf':
      case 'scan-to-pdf':
        if (!arr.every(function(f){ return isImg(f) || isPdf(f); }))
          return 'Please upload image files (JPG, PNG) for ' + toolId + '.';
        break;

      // Document conversion inputs
      case 'word-to-pdf':
        if (!arr.every(isWord))
          return 'Please upload a Word document (.docx/.doc) for word-to-pdf.';
        break;
      case 'excel-to-pdf':
        if (!arr.every(isExcel))
          return 'Please upload an Excel file (.xlsx/.xls) for excel-to-pdf.';
        break;
      case 'powerpoint-to-pdf':
        if (!arr.every(isPpt))
          return 'Please upload a PowerPoint file (.pptx/.ppt) for powerpoint-to-pdf.';
        break;
      case 'html-to-pdf':
        if (!arr.every(function(f){ return isHtml(f) || ext(f) === 'htm'; }))
          return 'Please upload an HTML file for html-to-pdf.';
        break;

      default:
        break;
    }

    return null; // all good
  }

  // ── Soft-size warning (non-blocking) ──────────────────────────────────────
  function warnIfOverSoftLimit(toolId, totalBytes) {
    var limit = SOFT_LIMIT[toolId];
    if (!limit) return;
    if (totalBytes > limit) {
      _tel('p27.soft-limit-warn', {
        toolId:   toolId,
        mb:       Math.round(totalBytes / MB),
        limitMb:  Math.round(limit / MB),
      });
    }
  }

  // ── Quality hints injected into opts (_p27* namespace) ───────────────────
  // Downstream processors may honour these for better output quality.
  function buildQualityOpts(toolId, totalBytes, existingOpts) {
    var patch = {};
    var mem   = window.MemPressure;
    var tier  = mem ? mem.tier() : 'ok';

    switch (toolId) {
      // Compress: pick compression level from memory tier
      case 'compress': {
        var levels = { ok: 'medium', reduce: 'medium', low: 'high', critical: 'high', abort: 'max' };
        patch._p27CompressLevel = levels[tier] || 'medium';
        break;
      }
      // OCR: escalate PSM for large/scanned docs
      case 'ocr': {
        patch._p27OcrPsm = totalBytes > 50 * MB ? '3' : '6';
        patch._p27OcrDpi = tier === 'ok' ? 300 : 200;
        break;
      }
      // Translate: prefer short chunks under pressure
      case 'translate': {
        patch._p27TransChunkSentences = tier === 'ok' ? 8 : 4;
        break;
      }
      // Image tools: scale down under memory pressure
      case 'image-filters':
      case 'crop-image':
      case 'resize-image':
      case 'background-remover': {
        var scales = { ok: 1.0, reduce: 0.9, low: 0.8, critical: 0.7, abort: 0.6 };
        patch._p27ImgQuality = scales[tier] || 1.0;
        break;
      }
      // PDF→image: control JPEG quality
      case 'pdf-to-jpg': {
        patch._p27JpegQuality = tier === 'ok' ? 0.92 : 0.82;
        break;
      }
      // Scan-to-PDF / jpg-to-pdf: embed quality
      case 'scan-to-pdf':
      case 'jpg-to-pdf': {
        patch._p27EmbedQuality = tier === 'ok' ? 0.92 : 0.80;
        break;
      }
      // AI summarise: sentence count vs pressure
      case 'ai-summarize': {
        patch._p27SummarySentences = tier === 'ok' ? 10 : 6;
        break;
      }
      // Merge: use object streams for smaller output
      case 'merge': {
        patch._p27UseObjectStreams = true;
        break;
      }
      // Watermark: adaptive font size cap
      case 'watermark': {
        patch._p27WatermarkFontCap = 72;
        break;
      }
      default: break;
    }

    return Object.assign({}, existingOpts || {}, patch);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 28 — GIANT-FILE OPFS RESUME SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Strategy:
  //   • Before processing: check CheckpointStore for a saved resume key.
  //   • After a crash / page reload: expose the resume info via Phase2730.resumeInfo().
  //   • After successful completion: clear the checkpoint for that tool+file.
  //   • Checkpoint format: { toolId, fileName, fileSize, savedAt, totalBytes, opts }
  //
  // Note: We never try to CONTINUE mid-stream here — that would require deep
  // processor changes (not additive). Instead, we re-surface the checkpoint so
  // the UI can PROMPT the user to resume and re-run, and the engine re-starts
  // cleanly from the beginning (the OPFS-staged data from LargeFileStreaming
  // may still be warm). This is a safe, additive design.

  var RESUME_THRESHOLD = 50 * MB;  // only checkpoint files ≥50 MB
  var RESUME_TTL_MS    = 6 * 60 * 60 * 1000; // 6-hour TTL

  // IDB-backed checkpoint store (separate from LargeFileStreaming's store)
  var ResumeStore = (function () {
    var DB_NAME = 'ilovepdf-p28-resume';
    var STORE   = 'jobs';
    var VER     = 1;
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
          req.onsuccess = function () { _db = req.result; res(_db); };
          req.onerror   = function () { rej(req.error); };
        } catch (e) { rej(e); }
      });
    }

    function save(key, data) {
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

    function load(key) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx  = db.transaction(STORE, 'readonly');
            var req = tx.objectStore(STORE).get(key);
            req.onsuccess = function () {
              var r = req.result;
              if (!r || Date.now() - r.ts > RESUME_TTL_MS) return res(null);
              res(r.d);
            };
            req.onerror = function () { res(null); };
          } catch (_) { res(null); }
        });
      }).catch(function () { return null; });
    }

    function clear(key) {
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

    function clearAll() {
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

    function listAll() {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var items = [];
            var tx  = db.transaction(STORE, 'readonly');
            var req = tx.objectStore(STORE).openCursor();
            req.onsuccess = function (ev) {
              var cur = ev.target.result;
              if (!cur) return res(items);
              if (Date.now() - cur.value.ts <= RESUME_TTL_MS) {
                items.push(Object.assign({}, cur.value.d, { _key: cur.value.k, _ts: cur.value.ts }));
              }
              cur.continue();
            };
            req.onerror = function () { res(items); };
          } catch (_) { res([]); }
        });
      }).catch(function () { return []; });
    }

    // Sweep expired entries on open
    function sweep() {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var cutoff = Date.now() - RESUME_TTL_MS;
            var tx  = db.transaction(STORE, 'readwrite');
            var req = tx.objectStore(STORE).openCursor();
            req.onsuccess = function (ev) {
              var cur = ev.target.result;
              if (!cur) return res();
              if (cur.value.ts < cutoff) cur.delete();
              cur.continue();
            };
            req.onerror = function () { res(); };
          } catch (_) { res(); }
        });
      }).catch(function () {});
    }

    if (typeof indexedDB !== 'undefined') {
      setTimeout(function () { sweep().catch(function () {}); }, 4000);
    }

    return { save: save, load: load, clear: clear, clearAll: clearAll, listAll: listAll };
  }());

  // Build a per-job resume key
  function _resumeKey(toolId, files) {
    var arr = Array.from(files || []);
    var sig = arr.map(function (f) {
      return (f.name || '') + ':' + (f.size || 0);
    }).join('|');
    return 'p28_' + toolId + '_' + _djb2(sig);
  }

  // Tiny hash for key generation
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(36);
  }

  function _totalBytes(files) {
    return Array.from(files || []).reduce(function (s, f) { return s + (f.size || 0); }, 0);
  }

  // Save a resume checkpoint before starting a giant job
  async function saveResumeCheckpoint(toolId, files, opts) {
    var totalBytesVal = _totalBytes(files);
    if (totalBytesVal < RESUME_THRESHOLD) return null;
    var key = _resumeKey(toolId, files);
    var arr  = Array.from(files);
    var data = {
      toolId:     toolId,
      fileNames:  arr.map(function (f) { return f.name || ''; }),
      fileSizes:  arr.map(function (f) { return f.size || 0; }),
      totalBytes: totalBytesVal,
      opts:       _safeSerialise(opts),
      savedAt:    Date.now(),
    };
    await ResumeStore.save(key, data).catch(function () {});
    return key;
  }

  // Clear checkpoint after successful completion
  async function clearResumeCheckpoint(toolId, files) {
    var key = _resumeKey(toolId, files);
    await ResumeStore.clear(key).catch(function () {});
  }

  // Serialise opts safely (strip non-serialisable values)
  function _safeSerialise(obj) {
    try {
      return JSON.parse(JSON.stringify(obj || {}));
    } catch (_) { return {}; }
  }

  // Resume info: returns all pending checkpoints for the current page's tool
  async function resumeInfo(toolId) {
    var all = await ResumeStore.listAll().catch(function () { return []; });
    if (toolId) {
      return all.filter(function (r) { return r.toolId === toolId; });
    }
    return all;
  }

  // ── Emit a resumable-job event to the page ────────────────────────────────
  // tool-page.js and the UI can listen for 'p28:resume-available' to show a
  // "Resume your previous job" banner without any changes to existing code.
  async function _maybeDispatchResumeEvent(toolId) {
    try {
      var slug = (window.location.pathname || '').replace(/^\/+/, '').split('/')[0];
      if (slug !== toolId) return; // only emit on the relevant tool page
      var pending = await resumeInfo(toolId);
      if (!pending.length) return;
      var ev = new CustomEvent('p28:resume-available', {
        detail: { toolId: toolId, jobs: pending },
        bubbles: true,
      });
      document.dispatchEvent(ev);
      _tel('p28.resume-event', { toolId: toolId, count: pending.length });
    } catch (_) {}
  }

  // Check resume availability on load (after a short delay)
  setTimeout(function () {
    try {
      var slug = (window.location.pathname || '').replace(/^\/+/, '').split('/')[0];
      if (slug) _maybeDispatchResumeEvent(slug).catch(function () {});
    } catch (_) {}
  }, 2000);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 29 — DEBUG / STRESS-TEST HOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  var _jobLog = [];   // circular buffer, max 200 entries
  var JOB_LOG_MAX = 200;

  function _logJob(entry) {
    _jobLog.push(Object.assign({ _t: Date.now() }, entry));
    if (_jobLog.length > JOB_LOG_MAX) _jobLog.shift();
  }

  function getJobLog() { return _jobLog.slice(); }

  // Full system diagnostics
  function audit() {
    var mem = window.MemPressure;
    var EM  = window.EvictionManager;
    var GFR = window.GiantFileRouting;
    var GFT = window.GiantFileTelemetry;
    var OPF = window.OPFSManager;

    var info = {
      version:    'Phase2730 v' + VERSION,
      timestamp:  new Date().toISOString(),
      hooked:     !!(window.BrowserTools && window.BrowserTools.__p2730v1),
      modules: {
        Phase26:            !!(window.Phase26),
        MemPressure:        !!mem,
        EvictionManager:    !!EM,
        LargeFileStreaming:  !!(window.LargeFileStreaming),
        GiantFileRouting:   !!GFR,
        GiantFileTelemetry: !!GFT,
        OPFSManager:        !!(OPF && OPF.available && OPF.available()),
        RollingProcessor:   !!(window.RollingProcessor),
        VirtualPageManager: !!(window.VirtualPageManager),
        IDBCache:           !!(window.IDBCache),
      },
      memory: mem ? {
        tier:        mem.tier(),
        availMB:     Math.round(mem.memAvail() / MB),
        usedMB:      Math.round((performance.memory ? performance.memory.usedJSHeapSize : 0) / MB),
        limitMB:     Math.round((performance.memory ? performance.memory.jsHeapSizeLimit : 0) / MB),
        renderScale: mem.renderScale ? mem.renderScale('pdf') : null,
        ocrMode:     mem.ocrMode ? mem.ocrMode() : null,
      } : null,
      eviction: EM && EM.getStats ? EM.getStats() : null,
      routing:  GFR && GFR.getStats ? GFR.getStats() : null,
      recentJobs: _jobLog.slice(-10),
    };

    console.group('Phase2730 v' + VERSION + ' — Full Audit');
    console.log('Hooked:', info.hooked);
    console.log('Modules:', info.modules);
    if (info.memory) console.log('Memory:', info.memory);
    if (info.eviction) console.log('Eviction stats:', info.eviction);
    if (info.routing)  console.log('Routing stats:', info.routing);
    console.log('Recent jobs (last 10):', info.recentJobs);
    console.groupEnd();

    return info;
  }

  // Synthetic stress test: runs a given tool with a fake File of the given KB
  async function stressTest(toolId, sizeKB, opts) {
    toolId = toolId || 'compress';
    sizeKB = sizeKB || 100;
    opts   = opts   || {};

    // Build a minimal fake PDF ArrayBuffer (not valid — just for pipeline timing)
    var bytes  = new Uint8Array(sizeKB * 1024);
    bytes.set([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]); // %PDF-1.4
    var fake   = new Blob([bytes], { type: 'application/pdf' });
    var fakeFile = new File([fake], 'stress-test.pdf', { type: 'application/pdf' });

    console.log('[Phase2730] stressTest', toolId, sizeKB + 'KB');
    var t0 = performance.now();
    try {
      var result = await window.BrowserTools.process(toolId, [fakeFile], opts);
      var dt = Math.round(performance.now() - t0);
      console.log('[Phase2730] stressTest PASS', toolId, dt + 'ms', result && result.blob ? (result.blob.size + 'B output') : '');
      return { ok: true, ms: dt, toolId: toolId, sizeKB: sizeKB };
    } catch (err) {
      var dt2 = Math.round(performance.now() - t0);
      console.warn('[Phase2730] stressTest FAIL', toolId, dt2 + 'ms', err.message);
      return { ok: false, ms: dt2, toolId: toolId, sizeKB: sizeKB, error: err.message };
    }
  }

  // Simulate a memory pressure tier for testing (reverts after delayMs)
  function simulatePressure(tier, delayMs) {
    if (!window.MemPressure || !window.MemPressure._simulateTier) {
      console.warn('[Phase2730] simulatePressure: MemPressure._simulateTier not available');
      return false;
    }
    var prev = window.MemPressure.tier();
    window.MemPressure._simulateTier(tier);
    console.log('[Phase2730] simulatePressure:', prev, '→', tier);
    if (delayMs) {
      setTimeout(function () {
        window.MemPressure._simulateTier(null);
        console.log('[Phase2730] simulatePressure: reverted to real tier');
      }, delayMs);
    }
    return true;
  }

  // Quick health check: returns a pass/fail summary
  async function diagnostics() {
    var checks = [];

    // 1. BrowserTools hooked
    checks.push({
      name: 'BrowserTools.process patched',
      pass: !!(window.BrowserTools && window.BrowserTools.__p2730v1),
    });
    // 2. Phase26 installed
    checks.push({
      name: 'Phase26 installed',
      pass: !!(window.Phase26 && window.BrowserTools && window.BrowserTools.__phase26V1),
    });
    // 3. MemPressure running
    checks.push({
      name: 'MemPressure',
      pass: !!window.MemPressure,
      detail: window.MemPressure ? window.MemPressure.tier() : 'missing',
    });
    // 4. OPFS available
    checks.push({
      name: 'OPFS available',
      pass: !!(window.OPFSManager && window.OPFSManager.available && window.OPFSManager.available()),
    });
    // 5. LargeFileStreaming
    checks.push({
      name: 'LargeFileStreaming',
      pass: !!window.LargeFileStreaming,
    });
    // 6. IDBCache
    checks.push({
      name: 'IDBCache',
      pass: !!window.IDBCache,
    });
    // 7. IndexedDB accessible
    var idbOk = false;
    try {
      var testKey = 'p29_diag_' + Date.now();
      await ResumeStore.save(testKey, { test: true });
      var loaded = await ResumeStore.load(testKey);
      idbOk = !!(loaded && loaded.test);
      await ResumeStore.clear(testKey);
    } catch (_) {}
    checks.push({ name: 'IndexedDB read/write', pass: idbOk });

    // 8. OPFS quota check (Phase 30 component)
    var quotaOk = false, quotaDetail = '';
    try {
      var est = await navigator.storage.estimate();
      var usedMB  = Math.round((est.usage  || 0) / MB);
      var quotaMB = Math.round((est.quota   || 0) / MB);
      var pct     = quotaMB ? Math.round(usedMB / quotaMB * 100) : 0;
      quotaOk     = pct < 90;
      quotaDetail = usedMB + 'MB / ' + quotaMB + 'MB (' + pct + '%)';
    } catch (_) { quotaDetail = 'unavailable'; quotaOk = true; }
    checks.push({ name: 'Storage quota (<90% used)', pass: quotaOk, detail: quotaDetail });

    var pass = checks.filter(function (c) { return c.pass; }).length;
    var fail = checks.filter(function (c) { return !c.pass; }).length;

    console.group('[Phase2730] diagnostics — ' + pass + '/' + checks.length + ' checks passed');
    checks.forEach(function (c) {
      var icon = c.pass ? '✓' : '✗';
      var msg  = icon + ' ' + c.name;
      if (c.detail) msg += ' (' + c.detail + ')';
      if (c.pass) console.log(msg); else console.warn(msg);
    });
    console.groupEnd();

    return { passed: pass, failed: fail, total: checks.length, checks: checks };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 30 — PRODUCTION HARDENING
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 30-A: Preconnect hints for CDN domains ────────────────────────────────
  function installPreconnects() {
    var origins = [
      'https://cdn.jsdelivr.net',
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
      'https://unpkg.com',
    ];
    origins.forEach(function (origin) {
      try {
        // Avoid duplicates
        if (document.head.querySelector('link[href="' + origin + '"]')) return;
        var link = document.createElement('link');
        link.rel  = 'preconnect';
        link.href = origin;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      } catch (_) {}
    });
  }

  // ── 30-B: OPFS / storage quota guard ─────────────────────────────────────
  // If storage usage is ≥85%, sweep OPFS and IDB caches proactively.
  async function quotaGuard() {
    try {
      var est = await navigator.storage.estimate();
      var pct = est.quota ? (est.usage / est.quota) : 0;
      if (pct < 0.85) return; // plenty of space

      _tel('p30.quota-pressure', {
        usedMB:  Math.round((est.usage  || 0) / MB),
        quotaMB: Math.round((est.quota  || 0) / MB),
        pct:     Math.round(pct * 100),
      });

      // Sweep OPFS orphans
      if (window.LargeFileStreaming && window.LargeFileStreaming.recoverOrphans) {
        await window.LargeFileStreaming.recoverOrphans(60 * 60 * 1000); // >1h old
      }
      if (window.OPFSManager && window.OPFSManager.sweep) {
        await window.OPFSManager.sweep();
      }

      // Clear IDB asset cache if very tight
      if (pct > 0.95 && window.IDBCache && window.IDBCache.clear) {
        await window.IDBCache.clear().catch(function () {});
        _tel('p30.idb-cache-cleared', { pct: Math.round(pct * 100) });
      }
    } catch (_) {}
  }

  // ── 30-C: Unload cleanup ──────────────────────────────────────────────────
  // Release all tracked blob URLs and hint GC on page hide/unload.
  function installUnloadCleanup() {
    var handler = function () {
      try {
        if (window.EvictionManager && window.EvictionManager.emergencyPressureFlush) {
          window.EvictionManager.emergencyPressureFlush();
        }
      } catch (_) {}
    };
    try {
      window.addEventListener('pagehide', handler, { passive: true });
      // visibilitychange → clean up when tab is hidden for a long time
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
          setTimeout(function () {
            if (document.visibilityState === 'hidden') {
              try {
                if (window.EvictionManager && window.EvictionManager.cleanOrphanCanvases) {
                  window.EvictionManager.cleanOrphanCanvases();
                }
              } catch (_) {}
            }
          }, 30000); // only if still hidden after 30s
        }
      }, { passive: true });
    } catch (_) {}
  }

  // ── 30-D: PWA / Service Worker registration ───────────────────────────────
  // Registers /sw.js if present. Offline support is handled by the SW itself.
  function maybeRegisterSW() {
    if (!('serviceWorker' in navigator)) return;
    if (window.location.protocol !== 'https:' &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1') return;

    navigator.serviceWorker.getRegistration('/').then(function (reg) {
      if (reg) return; // already registered
      // Check if /sw.js exists before attempting registration
      fetch('/sw.js', { method: 'HEAD' }).then(function (r) {
        if (!r.ok) return;
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function () {
          _tel('p30.sw-registered', {});
        }).catch(function () {});
      }).catch(function () {});
    }).catch(function () {});
  }

  // ── 30-E: Offline/online status banner helper ─────────────────────────────
  // Dispatches custom events that the UI can use to show/hide an offline banner.
  function installNetworkMonitor() {
    function onOffline() {
      _tel('p30.offline', {});
      try {
        document.dispatchEvent(new CustomEvent('p30:offline', { bubbles: true }));
      } catch (_) {}
    }
    function onOnline() {
      _tel('p30.online', {});
      try {
        document.dispatchEvent(new CustomEvent('p30:online', { bubbles: true }));
      } catch (_) {}
    }
    try {
      window.addEventListener('offline', onOffline, { passive: true });
      window.addEventListener('online',  onOnline,  { passive: true });
    } catch (_) {}
  }

  // ── 30-F: Critical error boundary ─────────────────────────────────────────
  // Catches uncaught promise rejections from any of our workers/processors
  // and routes them through telemetry for visibility.
  function installErrorBoundary() {
    try {
      window.addEventListener('unhandledrejection', function (ev) {
        var reason = (ev && ev.reason) || {};
        var msg    = (reason.message || String(reason) || '').slice(0, 300);
        // Only report errors that look like they're from our stack
        if (msg.indexOf('pdf') === -1 && msg.indexOf('worker') === -1 &&
            msg.indexOf('opfs') === -1 && msg.indexOf('ilovepdf') === -1 &&
            msg.indexOf('p2') === -1) return;
        _tel('p30.unhandled-rejection', { msg: msg });
      }, { passive: true });
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TELEMETRY HELPER
  // ═══════════════════════════════════════════════════════════════════════════

  function _tel(event, data) {
    try {
      if (window.GiantFileTelemetry && window.GiantFileTelemetry.record) {
        window.GiantFileTelemetry.record(event, data || {});
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN WRAPPER — wraps BrowserTools.process() after Phase 26
  // ═══════════════════════════════════════════════════════════════════════════

  function installPhase2730() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__p2730v1) return true;

    var upstream = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function p2730_process(toolId, files, opts) {
      var totalBytesVal = _totalBytes(files);
      var isLarge       = totalBytesVal >= RESUME_THRESHOLD;

      // ── Phase 27: Input validation ──────────────────────────────────────
      var warn = validateInputs(toolId, files);
      if (warn) {
        _tel('p27.input-warn', { toolId: toolId, warn: warn });
        // Non-blocking — downstream will catch format errors properly
        // We just surface the warning through telemetry + a console hint
        console.warn('[Phase27]', toolId, warn);
      }
      warnIfOverSoftLimit(toolId, totalBytesVal);

      // ── Phase 27: Quality opts injection ──────────────────────────────
      var mergedOpts = buildQualityOpts(toolId, totalBytesVal, opts);

      // ── Phase 28: Save resume checkpoint (large files only) ────────────
      var resumeKey = null;
      if (isLarge) {
        resumeKey = await saveResumeCheckpoint(toolId, files, mergedOpts).catch(function () { return null; });
      }

      // ── Phase 29: Job log entry ────────────────────────────────────────
      var jobEntry = {
        toolId:  toolId,
        mb:      Math.round(totalBytesVal / MB),
        isLarge: isLarge,
        status:  'running',
      };
      _logJob(jobEntry);

      // ── Invoke upstream (Phase 26 shell → engine → browser-tools) ─────
      var result, success;
      try {
        result  = await upstream(toolId, files, mergedOpts);
        success = true;
        jobEntry.status = 'done';
      } catch (err) {
        success = false;
        jobEntry.status  = 'error';
        jobEntry.errMsg  = (err.message || '').slice(0, 200);
        _tel('p2730.error', { toolId: toolId, mb: jobEntry.mb, msg: jobEntry.errMsg });
        // Phase 28: keep checkpoint on error so user can resume
        throw err;
      }

      // ── Phase 28: Clear checkpoint on success ──────────────────────────
      if (success && resumeKey) {
        clearResumeCheckpoint(toolId, files).catch(function () {});
      }

      _tel('p2730.done', { toolId: toolId, mb: jobEntry.mb, success: success });
      return result;
    };

    window.BrowserTools.__p2730v1 = true;
    _tel('p2730.installed', { version: VERSION, timestamp: Date.now() });
    return true;
  }

  // Deferred install (advanced-engine.js loads with defer, so BrowserTools
  // may not be patched in yet when this script runs)
  if (!installPhase2730()) {
    var _iv = setInterval(function () {
      if (installPhase2730() || (typeof _iv !== 'undefined' && ++_tries > 100)) {
        clearInterval(_iv);
      }
    }, 80);
    var _tries = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 30: Run production hardening at startup
  // ═══════════════════════════════════════════════════════════════════════════

  // Preconnects immediately (DOM is ready by the time defer scripts fire)
  installPreconnects();
  installUnloadCleanup();
  installNetworkMonitor();
  installErrorBoundary();

  // Quota guard and SW registration after a short delay (non-blocking)
  setTimeout(function () {
    quotaGuard().catch(function () {});
    maybeRegisterSW();
  }, 3500);

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.Phase2730
  // ═══════════════════════════════════════════════════════════════════════════

  window.Phase2730 = {
    version: VERSION,

    // ── Phase 27 ────────────────────────────────────────────────────────────
    validateInputs:      validateInputs,
    buildQualityOpts:    buildQualityOpts,
    SOFT_LIMIT_MB:       (function () {
      var out = {};
      Object.keys(SOFT_LIMIT).forEach(function (k) { out[k] = Math.round(SOFT_LIMIT[k] / MB); });
      return out;
    }()),

    // ── Phase 28 ────────────────────────────────────────────────────────────
    resumeInfo:          resumeInfo,
    clearResume:         function (toolId, files) {
      if (files) return clearResumeCheckpoint(toolId, files);
      return ResumeStore.clearAll();
    },
    ResumeStore:         ResumeStore,

    // ── Phase 29 ────────────────────────────────────────────────────────────
    audit:               audit,
    diagnostics:         diagnostics,
    stressTest:          stressTest,
    simulatePressure:    simulatePressure,
    getJobLog:           getJobLog,

    // ── Phase 30 ────────────────────────────────────────────────────────────
    quotaGuard:          quotaGuard,
    installPreconnects:  installPreconnects,
  };

}());

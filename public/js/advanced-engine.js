// Advanced Engine v5.4 — production-grade, stealth browser PDF processor.
// Phases: 1-Worker Pool | 2-Stream | 3-Compression | 4-SAB | 5-WebGPU (worker)
//         6-MultiTab | 7-Pipeline | 8-LivePreview | 9-Estimator | 10-500MB
//         11-UX | 12-Performance
// v5.4: Input Intelligence Engine | OCR v2 Multi-Pass | AI Document Parser v5
//        Table Intelligence System | Result Meaningfulness Engine | Honest Compress
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

    if (m.includes('invalid_output') || m.includes('invalid output'))
      return 'The output could not be generated. Please try with a different file.';

    if (m.includes('no readable text') || m.includes('no text could be found'))
      return raw.charAt(0).toUpperCase() + raw.slice(1);

    if (m.includes('low_quality_output') || (m.includes('low') && m.includes('quality')))
      return 'The output quality was too low to be useful. Please try with a clearer or higher-quality document.';

    if (m.includes('empty_input') || (m.includes('empty') && m.includes('input')))
      return 'The document appears to be empty. Please check the file and try again.';

    if (m.includes('empty') && (m.includes('output') || m.includes('result') || m.includes('appear')))
      return 'The result appears empty. Please try again with a different file.';

    if (m.includes('build_failed') || m.includes('build failed'))
      return 'The document could not be assembled. Please try again.';

    if (m.includes('canvas encode') || m.includes('image_decode') || m.includes('canvas_export'))
      return 'Image processing failed. Please try a different file.';

    if (m.includes('image processing') || m.includes('decode failed'))
      return 'This image format is not supported. Please try a JPG or PNG file.';

    // Background remover — user-friendly specifics
    if (m.includes('bg_remove_failed') || m.includes('background_removal'))
      return 'Background removal failed. Please try with an image that has a solid background.';

    if (m.includes('no background detected') || m.includes('solid') && m.includes('background'))
      return raw.charAt(0).toUpperCase() + raw.slice(1);

    // Repair — pass through user-friendly repair messages
    if (m.includes('too severely damaged') || m.includes('could not be fully repaired'))
      return raw.charAt(0).toUpperCase() + raw.slice(1);

    // Generic "not available" for missing processors or pool errors
    if (m.includes('pool_unavail') || m.includes('no_processor') || m.includes('engine_unavail'))
      return 'This tool is not available right now. Please refresh the page and try again.';

    // Translation API failure
    if (m.includes('translation could not') || m.includes('temporarily unavailable'))
      return raw.charAt(0).toUpperCase() + raw.slice(1);

    // Pass through short, user-readable messages that don't contain any internal term
    if (raw.length > 3 && raw.length < 220 &&
        !raw.includes('Worker') && !raw.includes('worker') &&
        !raw.includes('wasm')   && !raw.includes('OPFS')   &&
        !raw.includes('chunk')  && !raw.includes('ArrayBuffer') &&
        !raw.includes('byteLength') && !raw.includes('gpu') &&
        !raw.includes('thread') && !raw.includes('SharedArray') &&
        !raw.includes('__')     && !raw.toLowerCase().includes('undefined') &&
        !raw.toLowerCase().includes('null')) {
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }

    return 'Something went wrong. Please try again.';
  }

  // ── INPUT INTELLIGENCE ENGINE (v5.4) ──────────────────────────────────────
  // Pre-flight validation + routing that runs BEFORE any processor.
  // Detects: file type via magic bytes, text/image ratio, scanned vs digital,
  // multi-language hints, corrupted structure, empty docs.
  // Routing: force OCR, hybrid extraction, correct tool routing, early reject.
  var InputAnalyzer = (function () {
    var EMPTY_THRESHOLD = 150;

    var PDF_INPUT_TOOLS = new Set([
      'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint', 'compress', 'ocr',
      'translate', 'ai-summarize', 'compare', 'repair', 'workflow', 'split',
      'merge', 'rotate', 'organize', 'page-numbers', 'watermark', 'crop',
      'protect', 'unlock',
    ]);

    // Magic byte signatures for file type detection (ignore extension/MIME)
    var MAGIC = [
      { sig: [0x25,0x50,0x44,0x46],          type: 'pdf',  name: 'PDF'   },
      { sig: [0x89,0x50,0x4E,0x47],          type: 'png',  name: 'PNG'   },
      { sig: [0xFF,0xD8,0xFF],               type: 'jpeg', name: 'JPEG'  },
      { sig: [0x47,0x49,0x46,0x38],          type: 'gif',  name: 'GIF'   },
      { sig: [0x42,0x4D],                    type: 'bmp',  name: 'BMP'   },
      { sig: [0x52,0x49,0x46,0x46],          type: 'webp', name: 'WebP'  },
      { sig: [0x50,0x4B,0x03,0x04],          type: 'zip',  name: 'ZIP/Office' },
      { sig: [0xD0,0xCF,0x11,0xE0],          type: 'ole',  name: 'Legacy Office' },
    ];

    async function detectMagicType(file) {
      try {
        var hdr = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        for (var mi = 0; mi < MAGIC.length; mi++) {
          var m = MAGIC[mi];
          var match = m.sig.every(function(b, i) { return hdr[i] === b; });
          if (match) return { type: m.type, name: m.name };
        }
      } catch (_) {}
      return { type: 'unknown', name: 'Unknown' };
    }

    // Analyze text vs image ratio from pdfjs text content items
    function analyzeTextImageRatio(items) {
      var textItems = (items || []).filter(function(it) { return it.str && it.str.trim(); });
      var totalItems = (items || []).length;
      var textCount = textItems.length;
      var textChars = textItems.reduce(function(s,it) { return s + it.str.length; }, 0);
      var ratio = totalItems > 0 ? textCount / totalItems : 0;
      return {
        textItems: textCount,
        totalItems: totalItems,
        textChars: textChars,
        ratio: ratio,
        isImageHeavy: textChars < 20 && totalItems > 0,
        isEmpty: totalItems === 0 || textChars < 5,
      };
    }

    // Detect if PDF is scanned (image-based) vs digital (has text layer)
    async function detectScannedVsDigital(file) {
      try {
        var lib = await loadPdfJsSafe();
        if (!lib) return { isScanned: false, confidence: 0 };
        var buf = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer();
        var pdf = await lib.getDocument({ data: buf, isEvalSupported: false }).promise;
        var pagesToCheck = Math.min(pdf.numPages, 3);
        var totalChars = 0, totalItems = 0;
        for (var i = 1; i <= pagesToCheck; i++) {
          var pg = await pdf.getPage(i);
          var tc = await pg.getTextContent();
          var ratio = analyzeTextImageRatio(tc.items);
          totalChars += ratio.textChars;
          totalItems += ratio.totalItems;
          pg.cleanup();
        }
        await pdf.destroy();
        var avgChars = totalChars / pagesToCheck;
        var isScanned = avgChars < 30;
        return { isScanned: isScanned, avgCharsPerPage: avgChars, confidence: isScanned ? 0.9 : 0.1 };
      } catch (_) {
        return { isScanned: false, confidence: 0 };
      }
    }

    function loadPdfJsSafe() {
      try { return loadPdfJs(); } catch(_) { return Promise.resolve(null); }
    }

    // Detect multi-language hints from text sample
    function detectMultiLanguageHints(textSample) {
      if (!textSample || textSample.length < 10) return { primary: 'unknown', hints: [] };
      var s = textSample.slice(0, 1000);
      var cjk    = (s.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
      var arabic = (s.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/g) || []).length;
      var cyril  = (s.match(/[\u0400-\u04ff]/g) || []).length;
      var korean = (s.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
      var latin  = (s.match(/[a-zA-Z]/g) || []).length;
      var total  = cjk + arabic + cyril + korean + latin || 1;
      var hints  = [];
      if (cjk / total > 0.1)    hints.push('chinese');
      if (arabic / total > 0.1) hints.push('arabic');
      if (cyril / total > 0.1)  hints.push('russian');
      if (korean / total > 0.1) hints.push('korean');
      if (latin / total > 0.1)  hints.push('latin');
      var primary = cjk > arabic && cjk > cyril && cjk > korean ? 'chi_sim'
                  : arabic > cyril && arabic > korean ? 'ara'
                  : cyril > korean ? 'rus'
                  : korean > latin ? 'kor' : 'eng';
      return { primary: primary, hints: hints, mixed: hints.length > 1 };
    }

    // Routing decision based on detected file properties
    function routeByDetection(toolId, magicType, scannedInfo, langHints) {
      var routing = { action: 'normal', forceOcr: false, hybridMode: false, langHint: null };

      // Misnamed file correction
      if (PDF_INPUT_TOOLS.has(toolId) && magicType.type !== 'pdf' && magicType.type !== 'unknown') {
        if (magicType.type === 'jpeg' || magicType.type === 'png' || magicType.type === 'webp') {
          routing.action = 'image_as_pdf';
          routing.forceOcr = true;
        }
      }

      // Image-heavy PDF → force OCR
      if (scannedInfo && scannedInfo.isScanned && PDF_INPUT_TOOLS.has(toolId)) {
        if (['pdf-to-word','pdf-to-excel','pdf-to-powerpoint','translate','ai-summarize'].includes(toolId)) {
          routing.forceOcr = true;
          routing.action = routing.action === 'normal' ? 'force_ocr' : routing.action;
        }
      }

      // Language hint for OCR
      if (langHints && langHints.primary && langHints.primary !== 'eng') {
        routing.langHint = langHints.primary;
      }

      return routing;
    }

    async function check(toolId, files) {
      if (!files || !files.length) {
        return { ok: false, reason: 'no_file',
          message: 'No file provided. Please upload a file and try again.' };
      }
      var file = files[0];

      // Empty / near-empty file gate — immediate reject
      if (file.size < EMPTY_THRESHOLD) {
        DT().error('input-intelligence', { reason: 'empty_file', size: file.size, tool: toolId });
        return {
          ok: false, reason: 'empty_file',
          message: 'The file appears to be empty or too small to process. Please try with a different file.',
        };
      }

      // Magic byte detection — ignores extension/MIME lies
      var magicType = await detectMagicType(file);
      DT().log('input-intelligence-magic', { tool: toolId, detected: magicType.type, name: magicType.name, size: file.size });

      // PDF header validation for PDF-input tools
      if (PDF_INPUT_TOOLS.has(toolId)) {
        var looksLikePdf = (file.type === 'application/pdf') || /\.pdf$/i.test(file.name || '');
        if (looksLikePdf && magicType.type !== 'pdf') {
          DT().error('input-intelligence', { reason: 'invalid_pdf_header', detected: magicType.type, tool: toolId });
          return {
            ok: false, reason: 'invalid_pdf_header',
            message: 'This file does not appear to be a valid PDF. If it\'s damaged, try the Repair PDF tool first.',
          };
        }
        if (!looksLikePdf && magicType.type === 'pdf') {
          // Correctly detected as PDF despite wrong extension — allow
          DT().log('input-intelligence', { note: 'misnamed_as_pdf', actual: magicType.type });
        }
      }

      // Scanned vs digital detection (fast, only for heavy processors)
      var scannedInfo = null;
      if (['pdf-to-word','pdf-to-excel','pdf-to-powerpoint','translate','ai-summarize'].includes(toolId)
          && magicType.type === 'pdf') {
        scannedInfo = await detectScannedVsDigital(file);
        DT().log('input-intelligence-scan', { toolId: toolId, isScanned: scannedInfo.isScanned,
          avgChars: (scannedInfo.avgCharsPerPage || 0).toFixed(0) });
      }

      // Build routing decision
      var routing = routeByDetection(toolId, magicType, scannedInfo);

      DT().log('input-intelligence', {
        tool: toolId, size: file.size, magicType: magicType.type,
        isScanned: scannedInfo ? scannedInfo.isScanned : null,
        routing: routing.action, forceOcr: routing.forceOcr, ok: true,
      });

      return { ok: true, routing: routing, magicType: magicType, scannedInfo: scannedInfo };
    }

    return { check: check, analyzeTextImageRatio: analyzeTextImageRatio, detectMultiLanguageHints: detectMultiLanguageHints };
  }());

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

  // v5.4: OCR language detection — upgraded with Unicode ranges, character
  // frequency analysis, word pattern matching, and multi-language support.
  // Falls back to 'eng' when the sample is too small or ambiguous.
  function _detectOcrLanguage(textSample) {
    if (!textSample || textSample.replace(/\s/g, '').length < 12) return 'eng';
    var s = textSample.slice(0, 1000); // v5.4: doubled sample size

    // Unicode range frequency analysis
    var cjk    = (s.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u31f0-\u31ff]/g) || []).length;
    var arabic = (s.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g) || []).length;
    var cyril  = (s.match(/[\u0400-\u04ff\u0500-\u052f]/g) || []).length;
    var korean = (s.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\ua960-\ua97f]/g) || []).length;
    var thai   = (s.match(/[\u0e00-\u0e7f]/g) || []).length;
    var latin  = (s.match(/[a-zA-Z]/g) || []).length;
    var total  = cjk + arabic + cyril + korean + thai + latin || 1;

    // Word pattern analysis for disambiguation
    var words = (s.match(/\b[a-zA-Z]{3,}\b/g) || []);
    var commonEnglish = /\b(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|day|get|has|him|his|how|man|new|now|old|see|two|way|who|its|let|put|say|she|too|use)\b/i;
    var hasEnglishWords = words.filter(function(w) { return commonEnglish.test(w); }).length;

    var lang;
    // Strict thresholds: needs clear dominance to choose non-Latin
    if      (cjk    / total > 0.20) lang = 'chi_sim';
    else if (arabic / total > 0.15) lang = 'ara';
    else if (cyril  / total > 0.20) lang = 'rus';
    else if (korean / total > 0.20) lang = 'kor';
    else if (thai   / total > 0.15) lang = 'tha';
    else                             lang = 'eng';

    // Mixed language: append +eng for better coverage if non-English dominant
    if (lang !== 'eng' && (latin / total > 0.15 || hasEnglishWords > 2)) {
      lang = lang + '+eng';
    }

    DT().log('ocr-lang-detect-v54', {
      sample: s.length, cjk: cjk, arabic: arabic, cyril: cyril,
      korean: korean, thai: thai, latin: latin, englishWords: hasEnglishWords, lang: lang,
    });
    return lang;
  }

  // Lightweight accessor — falls back to no-op stubs when debug-trace.js is absent.
  function DT() {
    return window.DebugTrace || {
      log:      function () {},
      error:    function () {},
      result:   function () {},
      validate: function () {},
    };
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

  // ── AI DOCUMENT PARSER v5 (v5.4 MAJOR UPGRADE) ───────────────────────────
  // Detects: headings (font+caps+spacing), paragraph blocks, lists (bullets/numbers),
  // tables (grid+alignment), sections, page breaks.
  // NEW: layout reconstruction engine, intelligent broken-line merging,
  // reading order fix (multi-column), related block grouping.
  var _LIST_RE = /^(\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb]|\s*\d+[.)]\s|\s*[a-zA-Z][.)]\s|\s*[ivxlcdmIVXLCDM]+[.)]\s)/;
  var _NUMBLIST_RE = /^\s*(\d+|[a-zA-Z])[.)]\s+\S/;
  var _SECTION_RE  = /^(chapter|section|part|article|appendix)\s+[\d\w]/i;

  function extractStructuredParagraphs(items) {
    if (!items || !items.length) return [];

    // 1. Font-size statistics for heading detection
    var heights = [];
    items.forEach(function (it) {
      var h = Math.abs(it.transform[3]);
      if (h > 0 && it.str.trim()) heights.push(h);
    });
    heights.sort(function (a, b) { return a - b; });
    var medianH = heights[Math.floor(heights.length / 2)] || 10;
    var maxH    = heights[heights.length - 1] || 10;

    // 2. Multi-column detection — look for 2-3 distinct x-clusters
    var validItems = items.filter(function (it) { return it.str.trim(); });
    if (validItems.length > 6) {
      var xs = validItems.map(function (it) { return it.transform[4]; });
      xs.sort(function (a, b) { return a - b; });
      var xRange = xs[xs.length - 1] - xs[0];

      // Detect column breaks via gap analysis
      var colBoundaries = [];
      for (var ci = 1; ci < xs.length; ci++) {
        if (xs[ci] - xs[ci - 1] > xRange * 0.28) {
          colBoundaries.push((xs[ci - 1] + xs[ci]) / 2);
        }
      }

      if (colBoundaries.length >= 1 && xRange > 60) {
        // Multi-column: sort each column top-to-bottom independently, then concat
        var cols = [[]];
        for (var ki = 0; ki < colBoundaries.length; ki++) cols.push([]);
        validItems.forEach(function (it) {
          var x = it.transform[4];
          var col = 0;
          for (var bi = 0; bi < colBoundaries.length; bi++) {
            if (x > colBoundaries[bi]) col = bi + 1;
          }
          cols[col].push(it);
        });

        // Validate column balance (each column has ≥20% of items)
        var balanced = cols.every(function(c) { return c.length > 0; }) &&
          cols.filter(function(c) { return c.length / validItems.length > 0.15; }).length >= 2;

        if (balanced) {
          var allParas = [];
          cols.forEach(function(colItems) {
            if (colItems.length) allParas = allParas.concat(_buildParaLines(colItems, medianH, maxH));
          });
          DT().log('doc-parser-v5-multicol', { cols: cols.length, items: validItems.length });
          return allParas;
        }
      }
    }

    return _buildParaLines(items, medianH, maxH);
  }

  function _buildParaLines(items, medianH, maxH) {
    maxH = maxH || medianH * 2;

    // Group items into lines by y-coordinate (2px tolerance)
    var lineMap = {};
    items.forEach(function (it) {
      if (!it.str.trim()) return;
      var yKey = Math.round(it.transform[5] / 2) * 2; // 2px bucket
      if (!lineMap[yKey]) lineMap[yKey] = [];
      lineMap[yKey].push(it);
    });

    var ys = Object.keys(lineMap).map(Number).sort(function (a, b) { return b - a; });
    var paragraphs = [];
    var lastY      = null;
    var lastText   = '';
    var lastH      = medianH;

    ys.forEach(function (y) {
      var lineItems = lineMap[y].sort(function (a, b) { return a.transform[4] - b.transform[4]; });

      // Reconstruct line text: handle spacing between items intelligently
      var lineText = _reconstructLineText(lineItems);
      if (!lineText) return;

      var lineMaxH = Math.max.apply(null, lineItems.map(function (it) { return Math.abs(it.transform[3]); }));
      var lineBold = lineItems.some(function(it) { return it.fontName && /bold/i.test(it.fontName); });

      // Classify line — v5.4: richer detection
      var isList    = _LIST_RE.test(lineText);
      var isNumList = _NUMBLIST_RE.test(lineText);
      var isSection = _SECTION_RE.test(lineText.trim());

      var isHeading = !isList && (
        lineMaxH > medianH * 1.3 ||               // larger font
        lineBold && lineMaxH >= medianH ||          // bold + normal size
        isSection ||                                // section keyword
        (lineText.length >= 2 && lineText.length < 90 &&
         lineText.trim() === lineText.trim().toUpperCase() &&
         /[A-Z\u0400-\u04ff\u0600-\u06ff]/.test(lineText))  // ALL CAPS (any script)
      );

      // Page break detection: large gap > 3x line height
      var gap       = lastY !== null ? lastY - y : 0;
      var isPageBreak = gap > medianH * 5;
      var isNewBlock  = gap > medianH * 2.0 || isHeading || isSection || isPageBreak;

      // Intelligent broken-line merging v5.4:
      // Merge if: previous line didn't end with sentence punctuation AND
      //           gap is small AND same approximate font size AND
      //           not starting a list item AND same x-origin (not a new para indent)
      var prevHasSentenceEnd = lastText ? /[.!?:;)\]"'\u2019\u201d\u060c\u061b\u061f]$/.test(lastText.trim()) : true;
      var isSmallGap         = gap > 0 && gap < medianH * 1.8;
      var sameSize           = Math.abs(lineMaxH - lastH) < medianH * 0.3;
      var shouldMerge        = !isNewBlock && !prevHasSentenceEnd && isSmallGap && sameSize && lastY !== null;

      if (shouldMerge) {
        var last = paragraphs[paragraphs.length - 1];
        if (last && !last.isHeading) {
          // Smart join: add space or not based on whether last char is hyphen
          var lastChar = last.text.trim().slice(-1);
          if (lastChar === '-') {
            last.text = last.text.trim().slice(0, -1) + lineText; // de-hyphenate
          } else {
            last.text += ' ' + lineText;
          }
          last.isList = last.isList || isList;
        } else {
          paragraphs.push({ text: lineText, isHeading: isHeading, isList: isList, isNumList: isNumList });
        }
      } else {
        // Group related blocks: if a list item follows a heading, tag them
        paragraphs.push({
          text: lineText,
          isHeading: isHeading,
          isList: isList,
          isNumList: isNumList,
          isSection: isSection,
          level: isHeading ? _headingLevel(lineMaxH, medianH, maxH) : 0,
        });
      }

      lastY    = y;
      lastText = lineText;
      lastH    = lineMaxH;
    });

    // Post-process: remove consecutive duplicate lines (scanning artifacts)
    return paragraphs.filter(function(p, i) {
      if (i === 0) return true;
      return p.text.trim().toLowerCase() !== paragraphs[i-1].text.trim().toLowerCase();
    });
  }

  // Reconstruct line text with intelligent spacing
  function _reconstructLineText(lineItems) {
    if (!lineItems.length) return '';
    var parts = [];
    var prevEnd = null;
    lineItems.forEach(function(it) {
      if (!it.str) return;
      var x = it.transform[4];
      if (prevEnd !== null && x - prevEnd > 3) {
        // Gap between items: add space if missing
        var lastPart = parts[parts.length - 1] || '';
        if (lastPart && !lastPart.endsWith(' ')) parts.push(' ');
      }
      parts.push(it.str);
      prevEnd = x + (it.width || it.str.length * Math.abs(it.transform[3]) * 0.5);
    });
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  // Determine heading level from font size ratio
  function _headingLevel(h, medianH, maxH) {
    var ratio = h / (maxH || medianH);
    if (ratio > 0.85) return 1; // H1
    if (ratio > 0.65) return 2; // H2
    if (ratio > 0.50) return 3; // H3
    return 4;                   // H4+
  }

  // ── TABLE INTELLIGENCE SYSTEM (v5.4) ─────────────────────────────────────
  // Smart table detection via alignment + spacing consistency.
  // Rebuilds into structured rows with consistent columns.
  // Rejects: single-column results, no numeric/text pattern (not real tables).

  // detectTableGridByAlignment: smart grid detection
  function detectTableGridByAlignment(items) {
    if (!items || items.length < 6) return false;
    var filtered = items.filter(function (it) { return it.str.trim(); });
    if (filtered.length < 4) return false;

    var xs = filtered.map(function (it) { return Math.round(it.transform[4] / 6) * 6; });
    var xFreq = {};
    xs.forEach(function (x) { xFreq[x] = (xFreq[x] || 0) + 1; });
    var alignedCols = Object.keys(xFreq).filter(function (x) { return xFreq[x] >= 2; });
    if (alignedCols.length < 2) return false;

    // Spacing consistency: check that x-gaps are regular (table-like)
    var colXs = alignedCols.map(Number).sort(function(a,b) { return a - b; });
    if (colXs.length >= 2) {
      var gaps = [];
      for (var gi = 1; gi < colXs.length; gi++) gaps.push(colXs[gi] - colXs[gi-1]);
      var avgGap = gaps.reduce(function(s,g){return s+g;},0) / gaps.length;
      var gapVariance = gaps.reduce(function(s,g){return s+Math.pow(g-avgGap,2);},0) / gaps.length;
      // High variance means irregular spacing — likely not a proper table
      if (avgGap > 5 && Math.sqrt(gapVariance) / avgGap > 1.5) return false;
    }

    var ys = filtered.map(function (it) { return Math.round(it.transform[5] / 6) * 6; });
    var yFreq = {};
    ys.forEach(function (y) { yFreq[y] = (yFreq[y] || 0) + 1; });
    var alignedRows = Object.keys(yFreq).filter(function (y) { return yFreq[y] >= 2; });
    return alignedRows.length >= 2;
  }

  // clusterCellsByXandY: precision cell clustering with consistent column enforcement
  function clusterCellsByXandY(items) {
    if (!items || !items.length) return [];

    var filtered = items.filter(function (it) { return it.str.trim(); });
    var xs = filtered.map(function (it) { return Math.round(it.transform[4]); });
    xs.sort(function (a, b) { return a - b; });

    // Find x boundaries using gap analysis (minimum gap of 15px)
    var xBoundaries = [];
    for (var xi = 1; xi < xs.length; xi++) {
      if (xs[xi] - xs[xi - 1] > 15) {
        xBoundaries.push((xs[xi - 1] + xs[xi]) / 2);
      }
    }
    // Deduplicate boundaries that are too close together
    xBoundaries = xBoundaries.filter(function(b, i) {
      return i === 0 || b - xBoundaries[i-1] > 10;
    });

    function getCol(x) {
      for (var bi = 0; bi < xBoundaries.length; bi++) {
        if (x < xBoundaries[bi]) return bi;
      }
      return xBoundaries.length;
    }

    var cells  = {};
    var maxCol = 0;
    filtered.forEach(function (it) {
      var yKey = Math.round(it.transform[5] / 6) * 6;
      var col  = getCol(Math.round(it.transform[4]));
      maxCol   = Math.max(maxCol, col);
      if (!cells[yKey]) cells[yKey] = {};
      cells[yKey][col] = (cells[yKey][col] ? cells[yKey][col] + ' ' : '') + it.str.trim();
    });

    var ys = Object.keys(cells).map(Number).sort(function (a, b) { return b - a; });
    var rows = ys.map(function (y) {
      var row = [];
      for (var ci = 0; ci <= maxCol; ci++) row.push(cells[y][ci] || '');
      return row;
    });

    // v5.4 RULE: Reject if only 1 column — not tabular data
    if (maxCol === 0) return [];

    // v5.4 RULE: Validate that at least one column has numeric/mixed content (real table)
    var hasNumericCol = false;
    for (var ci2 = 0; ci2 <= maxCol; ci2++) {
      var colVals = rows.map(function(r) { return r[ci2] || ''; }).filter(Boolean);
      var numericCount = colVals.filter(function(v) { return /\d/.test(v); }).length;
      if (numericCount / colVals.length > 0.25) { hasNumericCol = true; break; }
    }
    // If no column has numbers, check for consistent text patterns (headers etc.)
    if (!hasNumericCol) {
      var allSingleWord = rows.every(function(r) {
        return r.filter(Boolean).every(function(c) { return c.split(/\s+/).length <= 2; });
      });
      if (!allSingleWord && rows.length < 3) return []; // Not enough structure
    }

    return rows;
  }

  // buildColumnRows: main entry point for PDF→Excel row extraction
  function buildColumnRows(items) {
    if (!items || !items.length) return [];

    if (detectTableGridByAlignment(items)) {
      var smartRows = clusterCellsByXandY(items);
      if (smartRows.length > 0) {
        DT().log('table-intelligence-v54', { method: 'smart-grid', rows: smartRows.length,
          cols: smartRows[0] ? smartRows[0].length : 0 });
        return smartRows;
      }
    }

    // Fallback: adaptive gap-based splitting
    var xs = items.filter(function (it) { return it.str.trim(); }).map(function (it) {
      return Math.round(it.transform[4]);
    });
    xs.sort(function (a, b) { return a - b; });

    // Adaptive gap threshold based on document width
    var xRange   = xs.length > 1 ? xs[xs.length - 1] - xs[0] : 100;
    var minGap   = Math.max(20, xRange * 0.06); // 6% of doc width
    var splits   = [0];
    for (var xi = 1; xi < xs.length; xi++) {
      if (xs[xi] - xs[xi - 1] > minGap) splits.push((xs[xi - 1] + xs[xi]) / 2);
    }
    splits.push(Infinity);

    // v5.4 RULE: reject single-column result
    if (splits.length <= 2) {
      DT().log('table-intelligence-v54', { method: 'fallback', rejected: 'single_column' });
      return [];
    }

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

    if (maxCol === 0) return []; // single column — not table data

    var ys = Object.keys(cells).map(Number).sort(function (a, b) { return b - a; });
    var result = ys.map(function (y) {
      var row = [];
      for (var ci = 0; ci <= maxCol; ci++) row.push(cells[y][ci] || '');
      return row;
    });
    DT().log('table-intelligence-v54', { method: 'fallback-gap', rows: result.length, cols: maxCol + 1 });
    return result;
  }

  // ── PHASE 2 (v5): THREE-TIER VALIDATION SYSTEM ───────────────────────────
  // Tier 1: validateBlob  — minimum blob size (first gate, catches empty files)
  // Tier 2: validateContent — content-quality check on parsed data (per processor)
  // Tier 3: analyzeResultQuality — post-output quality score (DebugTrace)
  var _VALIDATE_MINS = {
    'pdf-to-word':        1000,
    'pdf-to-excel':       1000,
    'pdf-to-powerpoint':  1000,
    'ocr':                200,
    'background-remover': 200,
    'repair':             200,
    'compress':           200,
    'compare':            20,
    'ai-summarize':       20,
    'translate':          20,
    'workflow':           200,
  };

  // Tier 1: size gate on final Blob — catches truly empty/corrupt outputs
  function validateBlob(toolId, blob) {
    var minSize = _VALIDATE_MINS[toolId] !== undefined ? _VALIDATE_MINS[toolId] : 50;
    if (!blob || blob.size < minSize) {
      DT().error('validate-blob', { toolId: toolId, size: blob ? blob.size : 0, min: minSize });
      throw new Error('invalid_output');
    }
    DT().result('validate-blob', { toolId: toolId, size: blob.size, ok: true });
  }

  // Tier 2: content-level quality check — called from processors on PARSED DATA
  // data keys depend on toolId:
  //   pdf-to-word:        { paragraphs: count, chars: count }
  //   pdf-to-excel:       { rows: count, cols: maxCols }
  //   ocr:                { text: string }
  //   translate:          { inputText: string, outputText: string }
  //   ai-summarize:       { summary: string, origLen: number }
  //   background-remover: { hasTransparent: bool }
  function validateContent(toolId, data) {
    data = data || {};
    var issues  = [];
    var softLog = []; // warnings that log but do NOT block download

    if (toolId === 'pdf-to-word') {
      var paras = data.paragraphs !== undefined ? data.paragraphs : 0;
      var chars  = data.chars     !== undefined ? data.chars     : 0;
      if (paras < 2)  issues.push('too_few_paragraphs:' + paras);
      if (chars < 50) issues.push('too_few_chars:' + chars);
    }
    else if (toolId === 'pdf-to-excel') {
      var rows = data.rows !== undefined ? data.rows : 0;
      var cols = data.cols !== undefined ? data.cols : 0;
      if (rows < 1) issues.push('no_data_rows');
      // v5.2: soft warning if only a single column — may be OCR text, not tabular data
      if (rows >= 1 && cols === 1) softLog.push('single_column_result');
    }
    else if (toolId === 'ocr') {
      var ocrText = data.text || '';
      var wordCnt = (ocrText.match(/\b[a-z]{2,}\b/gi) || []).length;
      if (ocrText.length < 30) issues.push('too_few_chars:' + ocrText.length);
      if (wordCnt < 3)         issues.push('no_recognizable_words:' + wordCnt);
      // v5.2: garbage text detection — repeating single character or extreme symbol noise
      if (ocrText.length > 20 && /(.)\1{6,}/.test(ocrText)) {
        issues.push('garbage_text_repeating_chars');
      }
      var _nonAlpha = (ocrText.replace(/\s/g, '').match(/[^a-z0-9.,;:!?'"()\-]/gi) || []).length;
      var _totalNS  = ocrText.replace(/\s/g, '').length;
      if (_totalNS > 40 && _nonAlpha / _totalNS > 0.70) {
        issues.push('high_symbol_noise_ratio:' + (_nonAlpha / _totalNS).toFixed(2));
      }
    }
    else if (toolId === 'translate') {
      var inTxt  = data.inputText  || '';
      var outTxt = data.outputText || '';
      if (outTxt.length < 20) issues.push('output_too_short:' + outTxt.length);
      if (outTxt === inTxt)   issues.push('output_identical_to_input');
      // v5.2: output must be at least 30% as long as the input — catches truncated API returns
      if (inTxt.length > 50 && outTxt.length < inTxt.length * 0.30) {
        issues.push('output_too_short_ratio:' + (outTxt.length / inTxt.length).toFixed(2));
      }
    }
    else if (toolId === 'ai-summarize') {
      var summary = data.summary || '';
      var sentCnt = (summary.match(/[.!?]/g) || []).length;
      if (sentCnt < 2)
        issues.push('too_few_sentences:' + sentCnt);
      if (data.origLen > 0 && summary.length >= data.origLen * 0.9)
        issues.push('not_compressed_enough');
      // v5.2: duplicate sentence detection — catches broken extractive pass
      var _rawSents  = summary.match(/[^.!?]+[.!?]+/g) || [];
      var _sentNorms = _rawSents.map(function (s) { return s.trim().toLowerCase(); });
      var _sentSet   = new Set(_sentNorms);
      if (_rawSents.length > 3 && _sentSet.size < _rawSents.length * 0.60) {
        softLog.push('high_duplicate_sentences:' + _rawSents.length + '_unique:' + _sentSet.size);
      }
    }
    else if (toolId === 'background-remover') {
      if (data.hasTransparent === false) issues.push('no_transparent_pixels');
    }

    if (softLog.length) {
      DT().log('content-check-soft', { toolId: toolId, warnings: softLog });
    }
    DT().validate('content-check', { toolId: toolId, issues: issues });
    if (issues.length) {
      DT().error('content-check-fail', { toolId: toolId, issues: issues });
      throw new Error('low_quality_output');
    }
  }

  // Tier 3: post-output quality scoring with enforced gate for binary tools.
  // Score tiers:
  //   ≥ 0.70 → success (no action)
  //   0.40–0.69 → warning (logs only, download allowed)
  //   < 0.40 → FAIL — binary tools throw 'low_quality_output'; text tools just log
  var _BINARY_TOOLS = new Set([
    'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint',
    'background-remover', 'repair', 'compress',
  ]);

  function analyzeResultQuality(toolId, result, meta) {
    meta = meta || {};
    var blob = (result && result.blob) ? result.blob : result;
    var quality = {
      toolId:     toolId,
      ok:         true,
      outputSize: (blob instanceof Blob) ? blob.size : 0,
      ocrUsed:    meta.ocrUsed  || false,
      retries:    meta.retries  || 0,
      chars:      meta.chars    || 0,
      pages:      meta.pages    || 0,
      language:   meta.language || 'auto',
      score:      0,
      tier:       'unknown',
    };
    var minS = _VALIDATE_MINS[toolId] || 100;
    // v5.2: Hybrid scoring — 65% output-size ratio + 35% structural metadata.
    // Prevents false-fail on small-but-valid text outputs (e.g. short DOCX/XLSX).
    var _sizeScore   = Math.min(1.0, quality.outputSize / (minS * 5));
    var _structScore = 0;
    if (meta.chars  && meta.chars  > 0) _structScore += Math.min(0.50, meta.chars  / 500);
    if (meta.paras  && meta.paras  >= 2) _structScore += 0.15;
    if (meta.rows   && meta.rows   >= 1) _structScore += 0.10;
    if (meta.pages  && meta.pages  >= 1) _structScore += 0.05;
    if (meta.ocrUsed)                    _structScore += 0.05; // OCR ran and produced output
    var _hasStructData = !!(meta.chars || meta.paras || meta.rows);
    quality.score = Math.round(
      Math.min(1.0, _hasStructData
        ? _sizeScore * 0.65 + Math.min(1.0, _structScore) * 0.35
        : _sizeScore
      ) * 100
    ) / 100;

    quality.tier = quality.score >= 0.70 ? 'success' :
                   quality.score >= 0.40 ? 'warning' : 'fail';
    quality.ok   = quality.tier !== 'fail';

    DT().validate('result-quality', quality);

    if (quality.tier === 'fail' && _BINARY_TOOLS.has(toolId)) {
      DT().error('quality-gate-fail', { toolId: toolId, score: quality.score, size: quality.outputSize, min: minS });
      throw new Error('low_quality_output');
    }
    if (quality.tier === 'warning') {
      DT().log('quality-gate-warning', { toolId: toolId, score: quality.score });
    }
    return quality;
  }

  // ── RESULT MEANINGFULNESS ENGINE (v5.4) ─────────────────────────────────
  // Tier 4: Post-output semantic analysis. Checks actual content quality —
  // not just size or structure counts. Blocks meaningless / garbage output.
  // Scores: word diversity (unique/total), repetition ratio, sentence coherence.
  var _MEANINGFULNESS_TOOLS = new Set(['pdf-to-word', 'ocr', 'ai-summarize', 'translate']);

  function validateMeaningfulness(toolId, textContent) {
    if (!_MEANINGFULNESS_TOOLS.has(toolId)) return; // only for text-output tools
    var text = (textContent || '').trim();
    if (text.length < 80) return; // too short to score meaningfully

    var issues = [];
    var score  = 1.0;

    // 1. Word diversity: ratio of unique words to total words
    var words       = (text.toLowerCase().match(/\b[a-z\u00c0-\u024f\u0400-\u04ff]{2,}\b/g) || []);
    var totalWords  = words.length;
    var uniqueWords = (new Set(words)).size;
    var diversityR  = totalWords > 0 ? uniqueWords / totalWords : 0;
    if (totalWords > 20 && diversityR < 0.12) {
      issues.push('low_word_diversity:' + diversityR.toFixed(2));
      score -= 0.35;
    }

    // 2. Repetition ratio: repeated consecutive 3-word sequences
    var trigrams    = [];
    for (var wi = 0; wi < words.length - 2; wi++) {
      trigrams.push(words[wi] + ' ' + words[wi+1] + ' ' + words[wi+2]);
    }
    var uniqueTrig  = (new Set(trigrams)).size;
    var repetitionR = trigrams.length > 0 ? 1 - (uniqueTrig / trigrams.length) : 0;
    if (trigrams.length > 10 && repetitionR > 0.55) {
      issues.push('high_repetition_ratio:' + repetitionR.toFixed(2));
      score -= 0.30;
    }

    // 3. Sentence coherence: minimum average words per sentence
    var sentences   = text.match(/[^.!?\n]{8,}[.!?]/g) || text.split(/\n+/).filter(function(l){ return l.trim().length > 10; });
    var avgWPS      = sentences.length > 0 ? totalWords / sentences.length : 0;
    if (totalWords > 30 && sentences.length > 2 && avgWPS < 2.5) {
      issues.push('low_coherence:avg_wps=' + avgWPS.toFixed(1));
      score -= 0.20;
    }

    // 4. Symbol noise: ratio of non-alphabetic chars to total chars (OCR garbage)
    var nonAlpha = (text.replace(/\s/g, '').match(/[^a-z0-9.,;:!?'"()\-\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff]/gi) || []).length;
    var totalNS  = text.replace(/\s/g, '').length;
    if (totalNS > 60 && nonAlpha / totalNS > 0.65) {
      issues.push('high_symbol_noise:' + (nonAlpha / totalNS).toFixed(2));
      score -= 0.25;
    }

    score = Math.max(0, Math.min(1, score));
    DT().validate('meaningfulness', {
      toolId: toolId, score: score.toFixed(2), diversity: diversityR.toFixed(2),
      repetition: repetitionR.toFixed(2), avgWPS: avgWPS.toFixed(1),
      totalWords: totalWords, uniqueWords: uniqueWords, issues: issues,
    });

    if (score < 0.35) {
      DT().error('meaningfulness-fail', { toolId: toolId, score: score, issues: issues });
      throw new Error('low_quality_output');
    }
    if (score < 0.55) {
      DT().log('meaningfulness-warning', { toolId: toolId, score: score, issues: issues });
    }
    return score;
  }

  // Backwards compat alias — runTool still calls validateOutput()
  function validateOutput(toolId, blob) { return validateBlob(toolId, blob); }

  // ── PHASE 5: BACKGROUND-REMOVER CPU FALLBACK (main-thread pixel path) ────
  // Mirrors the removeBg() logic in advanced-worker.js for when the worker fails.
  function removeBgInline(pixelsBuf, width, height, threshold) {
    var t  = Math.max(60, Math.min(255, threshold || 240));
    var d  = new Uint8ClampedArray(pixelsBuf);

    var borderSum = 0, borderCount = 0;
    var bStep = Math.max(1, Math.floor((width * 2 + height * 2) / 200));
    for (var bx = 0; bx < width; bx += bStep) {
      var bi0 = bx * 4;
      borderSum += (d[bi0] + d[bi0+1] + d[bi0+2]) / 3; borderCount++;
      var bi1 = ((height - 1) * width + bx) * 4;
      borderSum += (d[bi1] + d[bi1+1] + d[bi1+2]) / 3; borderCount++;
    }
    for (var by = 0; by < height; by += bStep) {
      var bi2 = by * width * 4;
      borderSum += (d[bi2] + d[bi2+1] + d[bi2+2]) / 3; borderCount++;
      var bi3 = (by * width + width - 1) * 4;
      borderSum += (d[bi3] + d[bi3+1] + d[bi3+2]) / 3; borderCount++;
    }
    var avgBorder  = borderCount > 0 ? borderSum / borderCount : 200;
    var isDark     = avgBorder < 80;
    var feather    = 50;

    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i+1], b = d[i+2];
      var lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (!isDark) {
        if (r >= t && g >= t && b >= t) {
          d[i+3] = 0;
        } else if (lum >= t - feather) {
          var pct = (lum - (t - feather)) / feather;
          var alpha = Math.round(255 * (1 - Math.pow(pct, 0.7)));
          if (alpha < d[i+3]) d[i+3] = Math.max(0, Math.min(255, alpha));
        }
      } else {
        var tDk = 255 - t;
        if (r <= tDk && g <= tDk && b <= tDk) {
          d[i+3] = 0;
        } else if (lum <= tDk + feather) {
          var pct2 = (tDk + feather - lum) / feather;
          var alpha2 = Math.round(255 * (1 - Math.pow(pct2, 0.7)));
          if (alpha2 < d[i+3]) d[i+3] = Math.max(0, Math.min(255, alpha2));
        }
      }
    }
    return { pixels: d.buffer, width: width, height: height };
  }

  // ── OCR v2 MULTI-PASS ENGINE (v5.4 MAJOR UPGRADE) ────────────────────────
  // Three-pass strategy: native extraction → OCR → hybrid merge.
  //   Pass 1: Native text layer extraction (fast, structure-aware)
  //   Pass 2: Tesseract OCR with adaptive DPI (for scanned/image-only pages)
  //   Pass 3: Hybrid merge — prefer native text for pages with good coverage,
  //           fall back to OCR for sparse/empty pages.
  // Language detection: filename hints → Unicode range analysis → Tesseract lang.
  // Returns array of { pageNum, text, confidence, source:'native'|'ocr'|'hybrid' }.
  async function autoOcrFallback(file, onStep, stepBase, stepIdx, langHint) {
    stepBase = stepBase || 35;
    stepIdx  = stepIdx  || 1;

    // Language selection: explicit hint → filename analysis → Unicode sample
    var ocrLang = langHint || 'eng';
    if (!langHint) {
      var fn = (file.name || '').toLowerCase();
      if      (fn.includes('chi') || fn.includes('zh'))  ocrLang = 'chi_sim+eng';
      else if (fn.includes('ara') || fn.includes('ar_')) ocrLang = 'ara+eng';
      else if (fn.includes('rus') || fn.includes('ru_')) ocrLang = 'rus+eng';
      else if (fn.includes('deu') || fn.includes('ger')) ocrLang = 'deu+eng';
      else if (fn.includes('fra') || fn.includes('fr_')) ocrLang = 'fra+eng';
      else if (fn.includes('spa') || fn.includes('es_')) ocrLang = 'spa+eng';
      else if (fn.includes('jpn') || fn.includes('ja_')) ocrLang = 'jpn+eng';
      else if (fn.includes('kor') || fn.includes('ko_')) ocrLang = 'kor+eng';
      else if (fn.includes('por') || fn.includes('pt_')) ocrLang = 'por+eng';
    }

    DT().log('ocr-v2-start', { file: file.name, size: file.size, lang: ocrLang });
    onStep(stepIdx, 'active', stepBase, 'Scanning pages for text\u2026');

    // ── Pass 1: Native text layer (fast pre-pass) ──────────────────────────
    var nativePageTexts = {};
    try {
      var pdfjsNative = await loadPdfJs();
      var pdfNativeSrc = await loadPdfSource(file);
      var pdfNative = await pdfjsNative.getDocument(pdfNativeSrc.src).promise;
      var nativeTotal = pdfNative.numPages;
      for (var ni = 1; ni <= nativeTotal; ni++) {
        var np = await pdfNative.getPage(ni);
        var nc = await np.getTextContent();
        var nativeText = nc.items.map(function(it){ return it.str; }).join(' ').trim();
        nativePageTexts[ni] = {
          text: nativeText,
          chars: nativeText.replace(/\s/g, '').length,
          items: nc.items.length,
        };
        np.cleanup();
      }
      await pdfNative.destroy();
      pdfNativeSrc.cleanup();
      DT().log('ocr-v2-native-pass', { pages: nativeTotal,
        totalChars: Object.values(nativePageTexts).reduce(function(s,p){return s+p.chars;},0) });
    } catch (nativeErr) {
      DT().log('ocr-v2-native-fail', { err: String(nativeErr).slice(0,80) });
    }

    // Check if we even need OCR (all pages have good native text)
    var nativeKeys = Object.keys(nativePageTexts);
    var allNativeGood = nativeKeys.length > 0 && nativeKeys.every(function(k) {
      return nativePageTexts[k].chars >= 30;
    });
    if (allNativeGood) {
      // All pages have good native text — build result without Tesseract
      var nativeResults = nativeKeys.sort(function(a,b){return +a-+b;}).map(function(k) {
        return { pageNum: +k, text: nativePageTexts[k].text, confidence: 99, source: 'native' };
      });
      DT().result('ocr-v2-done', { method: 'native-only', pages: nativeResults.length });
      return nativeResults;
    }

    // ── Pass 2: Tesseract OCR ──────────────────────────────────────────────
    if (!window.Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    }
    if (!window.Tesseract) throw AEError(ERR.NETWORK, 'engine_load_failed');

    // Refine language from native text sample if no explicit hint
    if (!langHint && Object.keys(nativePageTexts).length > 0) {
      var sampleText = Object.values(nativePageTexts)
        .map(function(p){ return p.text; }).join(' ').slice(0, 500);
      if (sampleText.replace(/\s/g,'').length >= 12) {
        var detectedLang = _detectOcrLanguage(sampleText);
        if (detectedLang && detectedLang !== 'eng') {
          ocrLang = detectedLang;
          DT().log('ocr-v2-lang-refined', { lang: ocrLang });
        }
      }
    }

    var pdfjsLib2 = await loadPdfJs();
    var pdfSrc2   = await loadPdfSource(file);
    var pdf2      = await pdfjsLib2.getDocument(pdfSrc2.src).promise;
    var total2    = pdf2.numPages;
    var worker2   = await window.Tesseract.createWorker(ocrLang, 1, { logger: function () {} });
    var ocrResults = {};

    try {
      for (var oi = 1; oi <= total2; oi++) {
        // Skip OCR on pages that already have strong native text (≥80 chars)
        var nativePg = nativePageTexts[oi];
        if (nativePg && nativePg.chars >= 80) {
          ocrResults[oi] = { text: nativePg.text, confidence: 99, source: 'native', skippedOcr: true };
          var pctSkip = stepBase + Math.round((oi / total2) * (78 - stepBase));
          onStep(stepIdx, 'active', pctSkip, 'Page ' + oi + ' of ' + total2);
          continue;
        }

        var pg2 = await pdf2.getPage(oi);

        // Adaptive DPI: measure real page area, scale accordingly
        var vp1x     = pg2.getViewport({ scale: 1.0 });
        var pageArea = vp1x.width * vp1x.height;
        var adaptScale = pageArea > 500000 ? DEVICE.ocrScale * 0.75 :
                         pageArea <  80000 ? DEVICE.ocrScale * 1.6  :
                         DEVICE.ocrScale;

        var viewport2 = pg2.getViewport({ scale: adaptScale });
        var capW2     = Math.min(Math.floor(viewport2.width),  HARD_MAX_IMG_DIM);
        var capH2     = Math.min(Math.floor(viewport2.height), HARD_MAX_IMG_DIM);
        var capScale2 = adaptScale * Math.min(capW2 / viewport2.width, capH2 / viewport2.height);
        var capVp2    = pg2.getViewport({ scale: capScale2 });

        var cvs2    = document.createElement('canvas');
        cvs2.width  = Math.floor(capVp2.width);
        cvs2.height = Math.floor(capVp2.height);
        var ctx2    = cvs2.getContext('2d');
        ctx2.fillStyle = '#ffffff';
        ctx2.fillRect(0, 0, cvs2.width, cvs2.height);
        await pg2.render({ canvasContext: ctx2, viewport: capVp2 }).promise;
        pg2.cleanup();

        var dataUrl2 = cvs2.toDataURL('image/jpeg', 0.92);
        cvs2.width = 0; cvs2.height = 0; cvs2 = null;

        var ocrRes2    = await worker2.recognize(dataUrl2);
        dataUrl2       = null;
        var pageText   = (ocrRes2.data.text || '').trim();
        var confidence = typeof ocrRes2.data.confidence === 'number' ? ocrRes2.data.confidence : 0;

        // ── Pass 3: Hybrid merge ─────────────────────────────────────────
        // If native text exists but is sparse, pick best of native vs OCR
        var finalText   = pageText;
        var finalSource = 'ocr';
        if (nativePg && nativePg.chars > 0) {
          // Prefer OCR if confidence is high; prefer native if OCR confidence is low
          if (confidence > 65 && pageText.length > nativePg.text.length * 0.8) {
            finalText   = pageText;
            finalSource = 'hybrid-ocr-preferred';
          } else if (nativePg.chars >= 20) {
            finalText   = nativePg.text;
            finalSource = 'hybrid-native-preferred';
          }
        }

        ocrResults[oi] = { text: finalText, confidence: confidence, source: finalSource };
        DT().log('ocr-v2-page', { page: oi, chars: finalText.length, conf: confidence.toFixed(0),
          src: finalSource, scale: capScale2.toFixed(2) });

        var pct2 = stepBase + Math.round((oi / total2) * (78 - stepBase));
        onStep(stepIdx, 'active', pct2, 'Page ' + oi + ' of ' + total2);
      }
    } finally {
      try { await worker2.terminate(); } catch (_) {}
      await pdf2.destroy();
      pdfSrc2.cleanup();
    }

    var results = Object.keys(ocrResults).sort(function(a,b){return +a-+b;}).map(function(k) {
      return Object.assign({ pageNum: +k }, ocrResults[k]);
    });

    var totalChars  = results.reduce(function (s, p) { return s + p.text.length; }, 0);
    var avgConf     = results.length
      ? results.reduce(function (s, p) { return s + (p.confidence || 0); }, 0) / results.length : 0;
    var ocrPageCnt  = results.filter(function(p){ return p.source !== 'native'; }).length;
    DT().result('ocr-v2-done', { pages: results.length, ocrPages: ocrPageCnt,
      totalChars: totalChars, avgConf: avgConf.toFixed(1), lang: ocrLang });
    return results;
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

    var _totalWordChars = pages.reduce(function (s, p) {
      return s + p.paragraphs.reduce(function (ps, para) { return ps + (para.text || '').length; }, 0);
    }, 0);
    DT().log('pdf-to-word-extract', { pages: pages.length, chars: _totalWordChars, totalPdfPages: total });

    // Phase 3: Auto-OCR trigger — when the PDF has no/sparse selectable text
    // (scanned document), automatically run Tesseract instead of throwing.
    if (!pages.length || _totalWordChars < Math.max(8, total * 2)) {
      DT().log('pdf-to-word-ocr-trigger', { reason: 'sparse_text', chars: _totalWordChars });
      var ocrWPages = await autoOcrFallback(file, onStep, 35, 1);
      var ocrWChars = ocrWPages.reduce(function (s, p) { return s + p.text.length; }, 0);
      DT().log('pdf-to-word-ocr-result', { chars: ocrWChars });
      if (ocrWChars < 10) {
        throw new Error('No readable text could be found. This may be a scanned document with unclear content.');
      }
      pages = ocrWPages.map(function (p) {
        var paras = p.text.split('\n').filter(function (l) { return l.trim(); }).map(function (l) {
          return { text: l.trim(), isHeading: false };
        });
        if (!paras.length) paras = [{ text: '(no content)', isHeading: false }];
        return { pageNum: p.pageNum, paragraphs: paras };
      });
    }

    // Phase 2 (v5): content-level validation — ≥2 paragraphs + ≥50 characters
    var _wTotalParas = pages.reduce(function (s, p) { return s + p.paragraphs.length; }, 0);
    var _wTotalChars = pages.reduce(function (s, p) {
      return s + p.paragraphs.reduce(function (ps, para) { return ps + (para.text || '').length; }, 0);
    }, 0);
    DT().validate('pdf-to-word-content', { paras: _wTotalParas, chars: _wTotalChars });
    if (_wTotalParas < 2 || _wTotalChars < 50) {
      throw new Error('The document does not contain enough readable text to convert. Please try a different file.');
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
    DT().log('pdf-to-excel-extract', { sheets: sheets.length, allEmpty: _allSheetsEmpty });

    // Phase 3: Auto-OCR trigger — extract text via Tesseract and use as rows
    if (_allSheetsEmpty) {
      DT().log('pdf-to-excel-ocr-trigger', { reason: 'all_empty' });
      var ocrEPages = await autoOcrFallback(file, onStep, 35, 1);
      var ocrEChars = ocrEPages.reduce(function (s, p) { return s + p.text.length; }, 0);
      DT().log('pdf-to-excel-ocr-result', { chars: ocrEChars });
      if (ocrEChars < 5) {
        throw new Error('No data could be extracted from this PDF. For scanned documents, try the OCR tool first.');
      }
      sheets = ocrEPages.map(function (p) {
        var rows = p.text.split('\n')
          .map(function (l) { return l.trim(); })
          .filter(Boolean)
          .map(function (l) { return [l]; });
        return { name: 'Page ' + p.pageNum, rows: rows.length ? rows : [['(empty)']] };
      });
    }

    // Phase 2 (v5): content-level validation — ensure real data rows exist
    var _xRealRows = sheets.reduce(function (s, sh) {
      return s + sh.rows.filter(function (r) {
        return r.some(function (c) { return c && c !== '(empty)' && c.trim(); });
      }).length;
    }, 0);
    var _xMaxCols = sheets.reduce(function (s, sh) {
      return Math.max(s, sh.rows.reduce(function (rs, r) { return Math.max(rs, r.length); }, 0));
    }, 0);
    DT().validate('pdf-to-excel-content', { realRows: _xRealRows, maxCols: _xMaxCols });

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

  // ─── PDF → POWERPOINT (v5: heading-based titles + auto-OCR trigger) ────────
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

        if (!isPageBlank(content)) {
          // v5: Use structured paragraph extraction for accurate heading-based titles
          var paras   = extractStructuredParagraphs(items);
          var heading = null;
          for (var ph = 0; ph < paras.length; ph++) {
            if (paras[ph].isHeading) { heading = paras[ph]; break; }
          }

          var title;
          if (heading) {
            title = heading.text;
          } else {
            var biggest = { str: '', h: 0 };
            items.forEach(function (it) {
              var h = Math.abs(it.transform[3]);
              if (h > biggest.h && it.str.trim()) biggest = { str: it.str, h: h };
            });
            title = biggest.str || ('Slide ' + i);
          }

          var bodyParas = paras.filter(function (p) { return !p.isHeading; });
          var bodyText  = bodyParas.map(function (p) { return p.text; }).join('\n').trim();
          if (!bodyText) {
            bodyText = items
              .filter(function (it) { return it.str.trim() && it.str !== title; })
              .map(function (it) { return it.str; }).join(' ').trim();
          }
          slides.push({ pageNum: i, title: title.slice(0, 120), text: bodyText });
        } else {
          slides.push({ pageNum: i, title: 'Slide ' + i, text: '' });
        }

        pageData.page.cleanup(); // Phase 2
        var pct = 15 + Math.round((i / total) * 40);
        onStep(1, 'active', pct, 'Slide ' + i + ' of ' + total);
      }
    } finally {
      prefetcher.dispose();
      await pdf.destroy();
      pdfSource.cleanup();
    }

    // v5: Auto-OCR trigger — run Tesseract when all slides are blank
    var _allSlidesEmpty = slides.every(function (s) { return !s.text && /^Slide \d+$/.test(s.title); });
    DT().log('pdf-to-pptx-extract', { slides: slides.length, allEmpty: _allSlidesEmpty });

    if (_allSlidesEmpty) {
      DT().log('pdf-to-pptx-ocr-trigger', { reason: 'all_empty' });
      var ocrPPages = await autoOcrFallback(file, onStep, 35, 1);
      var ocrPChars = ocrPPages.reduce(function (s, p) { return s + p.text.length; }, 0);
      DT().log('pdf-to-pptx-ocr-result', { chars: ocrPChars });
      if (ocrPChars < 10) {
        throw new Error('No content could be extracted from this PDF. Please check the file and try again.');
      }
      slides = ocrPPages.map(function (p) {
        var lines = p.text.split('\n').filter(function (l) { return l.trim(); });
        return { pageNum: p.pageNum, title: (lines[0] || 'Slide ' + p.pageNum).slice(0, 120), text: lines.slice(1).join('\n') };
      });
    }

    // v5.3: Filter individually blank slides — slides with no body text AND a
    // generic "Slide N" auto-title. Always keep at least 1 slide.
    if (slides.length > 1) {
      var _slidesBeforeFilter = slides.length;
      var _contentSlides = slides.filter(function (s) {
        var hasText  = s.text && s.text.trim().length > 0;
        var hasTitle = !/^Slide \d+$/.test((s.title || '').trim());
        return hasText || hasTitle;
      });
      if (_contentSlides.length > 0) {
        if (_contentSlides.length < _slidesBeforeFilter) {
          DT().log('pdf-to-pptx-blank-filter', {
            before: _slidesBeforeFilter, after: _contentSlides.length,
            removed: _slidesBeforeFilter - _contentSlides.length,
          });
        }
        slides = _contentSlides;
      }
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
  // v5: word-to-pdf pre-checks for empty files before handing off
  processors['word-to-pdf'] = async function (f, o, s) {
    s(0, 'active', 10, 'Preparing your file\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    throw new Error(ERR.ORIG);
  };
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

    // v5.3: auto-detect language from native text sample (even if sparse);
    // falls back to 'eng'. Allows override via opts.language if user specified.
    var lang   = (opts && opts.language) || _detectOcrLanguage(nativeText);
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

    DT().log('bg-remover-start', { width: drawW, height: drawH, threshold: threshold });

    // v5.1: Helper — sample alpha channel of a pixel buffer (RGBA)
    function _sampleHasAlpha(pixelsBuf) {
      var samp = new Uint8ClampedArray(pixelsBuf, 0, Math.min(pixelsBuf.byteLength, 40000));
      var step = Math.max(1, Math.floor(samp.length / (4 * 500)));
      for (var ai = 3; ai < samp.length; ai += 4 * step) {
        if (samp[ai] < 200) return true;
      }
      return false;
    }

    // v5.1: Retry chain — Worker → CPU inline → relaxed threshold → hard fail
    var wResult   = null;
    var _hasAlpha = false;

    // Pass 1: worker path (transfers rawBuffer — detaches it in main thread)
    try {
      wResult = await runAdvancedWorker(
        { op: 'remove-bg', pixels: rawBuffer, width: drawW, height: drawH, threshold: threshold },
        [rawBuffer]
      );
    } catch (bgWorkerErr) {
      DT().error('bg-remover-worker', bgWorkerErr);
      onStep(2, 'active', 45, 'Processing image\u2026');
      // rawBuffer may be detached after transfer attempt — re-read from canvas
      var fbBuf = cvs.getContext('2d').getImageData(0, 0, drawW, drawH).data.buffer.slice(0);
      wResult = removeBgInline(fbBuf, drawW, drawH, threshold);
      fbBuf   = null;
    }
    rawBuffer = null;

    if (wResult && wResult.pixels instanceof ArrayBuffer) {
      _hasAlpha = _sampleHasAlpha(wResult.pixels);
      DT().validate('bg-remover-alpha', { attempt: 1, hasTransparent: _hasAlpha, threshold: threshold });
    }

    // Pass 2: relax threshold by 25 if no transparent pixels found
    if (!_hasAlpha) {
      DT().log('bg-remover-retry', { reason: 'no_alpha', pass: 2 });
      onStep(2, 'active', 58, 'Adjusting settings\u2026');
      var relaxThresh  = Math.max(100, threshold - 25);
      var retryBuf     = cvs.getContext('2d').getImageData(0, 0, drawW, drawH).data.buffer.slice(0);
      var retryResult  = removeBgInline(retryBuf, drawW, drawH, relaxThresh);
      retryBuf = null;
      if (retryResult && retryResult.pixels instanceof ArrayBuffer) {
        _hasAlpha = _sampleHasAlpha(retryResult.pixels);
        DT().validate('bg-remover-alpha', { attempt: 2, hasTransparent: _hasAlpha, threshold: relaxThresh });
        if (_hasAlpha) {
          wResult = retryResult;
          DT().log('bg-remover-retry-ok', { threshold: relaxThresh });
        }
      }
    }

    if (!wResult || !(wResult.pixels instanceof ArrayBuffer)) {
      DT().error('bg-remover-result', 'no pixels in output after all attempts');
      throw AEError(ERR.WORKER, 'bg_remove_failed');
    }

    // v5.1 RULE 1: Hard fail if no background was actually removed
    if (!_hasAlpha) {
      DT().error('bg-remover-no-alpha', { attempts: 2 });
      throw new Error('No background detected. Please try with an image that has a solid or uniform background.');
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

  // ─── REPAIR (v5: multi-pass repair) ──────────────────────────────────────
  processors['repair'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8, 'Preparing your file\u2026');
    var buf = await file.arrayBuffer();
    onStep(0, 'done', 18);
    onStep(1, 'active', 22, 'Checking integrity\u2026');

    var resultBuf  = null;
    var repairPass = 0;

    // v5: Multi-pass repair — try progressively deeper passes (up to 2)
    while (!resultBuf && repairPass < 2) {
      repairPass++;
      try {
        if (window.WorkerPool) {
          if (repairPass === 1) {
            onStep(1, 'done', 30);
            onStep(2, 'active', 34, 'Restoring document\u2026');
          } else {
            onStep(2, 'active', 52, 'Trying deeper repair\u2026');
          }
          var passOpts = Object.assign({}, opts || {}, { repairPass: repairPass });
          var wRes = await runPdfWorker('repair', [buf.slice(0)], passOpts);
          if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
            resultBuf = wRes.buffer;
            DT().log('repair-pass-ok', { pass: repairPass, size: resultBuf.byteLength });
          }
        }
      } catch (repairErr) {
        DT().error('repair-pass-' + repairPass, repairErr);
      }
    }

    buf = null;
    // Fall back to browser-tools.js repairPdf when all passes failed
    if (!resultBuf) throw new Error(ERR.ORIG);

    // v5.1: Integrity verification — confirm the repaired PDF can actually be opened
    onStep(2, 'done', 75);
    onStep(3, 'active', 78, 'Verifying document\u2026');
    try {
      var verifyLib = await loadPdfJs();
      var verifyDoc = await verifyLib.getDocument({ data: resultBuf.slice(0) }).promise;
      var repPages  = verifyDoc.numPages;
      await verifyDoc.destroy();
      DT().log('repair-integrity-ok', { pages: repPages });
      if (repPages < 1) throw new Error('repaired_pdf_empty');
    } catch (intErr) {
      DT().error('repair-integrity-fail', intErr);
      throw new Error('The document could not be fully repaired. It may be too severely damaged to recover. Please try re-downloading the original file.');
    }

    onStep(3, 'active', 92, 'Finalizing output\u2026');
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

  // ─── AI SUMMARIZE (v5.4: heading-aware extraction + dedup + meaningfulness) ─
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
    var allParas   = []; // v5.4: heading-aware paragraph collection
    var skipped    = 0;
    var prefetcher = makePrefetcher(pdf);

    LivePreview.show(pdf, pdfjsLib);

    try {
      for (var i = 1; i <= total; i++) {
        var pageData = await prefetcher.getPage(i, i + 1);
        var content  = pageData.content;
        if (isPageBlank(content)) { skipped++; pageData.page.cleanup(); continue; }

        // v5.4: extract structured paragraphs for heading-aware scoring
        var paras = extractStructuredParagraphs(content.items);
        paras.forEach(function(p) { allParas.push(p); });
        allText += content.items.map(function (it) { return it.str; }).join(' ') + ' ';
        pageData.page.cleanup();
        var pct = 15 + Math.round((i / total) * 30);
        onStep(1, 'active', pct, 'Page ' + i + ' of ' + total);
      }
    } finally {
      prefetcher.dispose();
      await pdf.destroy();
      pdfSource.cleanup();
    }

    DT().log('ai-summarize-extract-v54', { chars: allText.trim().length, pages: total,
      skipped: skipped, paras: allParas.length,
      headings: allParas.filter(function(p){return p.isHeading;}).length });

    // Phase 3: Auto-OCR for scanned PDFs
    if (!allText.trim()) {
      DT().log('ai-summarize-ocr-trigger', { reason: 'no_text' });
      onStep(1, 'active', 38, 'Scanning pages for content\u2026');
      var ocrSPages = await autoOcrFallback(file, onStep, 38, 1);
      allText = ocrSPages.map(function (p) { return p.text; }).join(' ');
      allParas = allText.split(/\n+/).filter(function(l){ return l.trim().length > 5; })
        .map(function(l){ return { text: l.trim(), isHeading: false }; });
      DT().log('ai-summarize-ocr-result', { chars: allText.length });
      if (!allText.trim()) throw AEError(ERR.PARSE, 'no_extractable_text');
    }

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

    // v5.4: Inline TF-IDF fallback — heading-aware + duplicate removal
    if (!scored || !scored.summary) {
      var _sentences = (_allTextForScore.match(/[^.!?\n]{10,}[.!?]/g) || [])
        .map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 15; });
      if (!_sentences.length) {
        _sentences = _allTextForScore.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
      }

      var _words = _allTextForScore.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      var _freq  = {};
      _words.forEach(function (w) { _freq[w] = (_freq[w] || 0) + 1; });

      // v5.4: Boost heading sentences — they get double weight
      var _headingTexts = new Set(allParas.filter(function(p){ return p.isHeading; })
        .map(function(p){ return p.text.trim().toLowerCase(); }));

      var _scored = _sentences.slice().map(function (s) {
        var sw = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
        var baseScore = sw.reduce(function (n, w) { return n + (_freq[w] || 0); }, 0) / (sw.length || 1);
        var headingBoost = _headingTexts.has(s.trim().toLowerCase()) ? 2.0 : 1.0;
        return { s: s, score: baseScore * headingBoost };
      }).sort(function (a, b) { return b.score - a.score; });

      // v5.4: Remove near-duplicate sentences before selecting top N
      var _seen    = [];
      var _deduped = [];
      for (var di = 0; di < _scored.length && _deduped.length < maxSentences; di++) {
        var candidate = _scored[di].s.trim().toLowerCase();
        var isDup = _seen.some(function(prev) {
          // Jaccard similarity > 0.6 → duplicate
          var a = new Set(prev.split(/\s+/)), b = new Set(candidate.split(/\s+/));
          var inter = 0;
          b.forEach(function(w){ if (a.has(w)) inter++; });
          var union = a.size + b.size - inter;
          return union > 0 && inter / union > 0.60;
        });
        if (!isDup) { _deduped.push(_scored[di].s); _seen.push(candidate); }
      }

      scored = {
        summary:       _deduped.join(' '),
        wordCount:     _words.length,
        sentenceCount: _sentences.length,
        topCount:      _deduped.length,
      };
    }
    _allTextForScore = null;

    if (!scored || !scored.summary) throw AEError(ERR.WORKER, 'summarize_empty');

    // v5.4: Meaningfulness gate on summary text
    try { validateMeaningfulness('ai-summarize', scored.summary); } catch (_) {
      throw new Error('The summary could not be generated from this document. The content may be too fragmented or unclear.');
    }

    var _summaryLen = (scored.summary || '').length;
    var _sentCount  = (scored.summary.match(/[.!?]/g) || []).length;
    var _origEstLen = (scored.wordCount || 0) * 5;
    DT().validate('summarize-quality-v54', {
      sentences: _sentCount, summaryLen: _summaryLen,
      origEstLen: _origEstLen, compressed: _origEstLen === 0 || _summaryLen < _origEstLen * 0.85,
      sentOk: _sentCount >= 2,
    });

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
    return {
      blob: blob,
      filename: brandedFilename(file.name, '-summary.txt'),
      _quality: { chars: _summaryLen, paras: _sentCount, pages: total, ocrUsed: false },
    };
  };

  // ─── TRANSLATE (v5.4: paragraph-preserving + context continuity + meaningfulness) ─
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
    var prefetcher = makePrefetcher(pdf);

    try {
      for (var i = 1; i <= total; i++) {
        var pageData = await prefetcher.getPage(i, i + 1);
        var content  = pageData.content;
        // v5.4: extract structured paragraphs to preserve paragraph structure
        var paras    = isPageBlank(content) ? [] : extractStructuredParagraphs(content.items);
        var flatText = paras.map(function(p){ return p.text; }).join('\n\n');
        pages.push({
          num:   i,
          text:  flatText || content.items.map(function (it) { return it.str; }).join(' ').trim(),
          paras: paras,
          blank: isPageBlank(content),
        });
        pageData.page.cleanup();
      }
    } finally {
      prefetcher.dispose();
      await pdf.destroy();
      pdfSource.cleanup();
    }

    onStep(1, 'done', 38);
    onStep(2, 'active', 41, 'Preparing content\u2026');

    if (!isOnline()) throw AEError(ERR.NETWORK, 'offline');

    // Phase 3: Auto-OCR trigger
    var _translateTextTotal = pages.reduce(function (s, p) { return s + (p.text || '').length; }, 0);
    DT().log('translate-extract-v54', { chars: _translateTextTotal, pages: pages.length });
    if (_translateTextTotal < 20) {
      DT().log('translate-ocr-trigger', { reason: 'sparse_text' });
      onStep(1, 'active', 38, 'Scanning pages for content\u2026');
      var ocrTPages = await autoOcrFallback(file, onStep, 38, 1);
      var ocrTChars = ocrTPages.reduce(function (s, p) { return s + (p.text || '').length; }, 0);
      DT().log('translate-ocr-result', { chars: ocrTChars });
      if (ocrTChars < 10) {
        throw new Error('No text could be found in this document. For scanned documents, run the OCR tool first to extract text.');
      }
      pages = ocrTPages.map(function (p) {
        return { num: p.pageNum, text: p.text, paras: [], blank: !p.text.trim() };
      });
    }

    var targetLang = (opts && (opts.targetLang || opts.targetLanguage)) || 'es';
    var srcLang    = (opts && (opts.sourceLang || opts.sourceLanguage)) || 'en';
    // v5.4: Smaller chunks (380 chars) for better context continuity per API call
    var MAX_CHARS  = (opts && opts._retrySmallChunks) ? (opts._chunkSize || 150) : 380;

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

    // v5.4: paragraph-aware chunk splitter — preserves paragraph boundaries
    function _splitPreservingParagraphs(txt, max) {
      var paragraphs = txt.split(/\n{2,}/);
      var out = [];
      var cur = '';
      for (var pi = 0; pi < paragraphs.length; pi++) {
        var para = paragraphs[pi].trim();
        if (!para) continue;
        // If single paragraph exceeds max, sentence-split it
        if (para.length > max) {
          if (cur) { out.push(cur.trim()); cur = ''; }
          var parts = para.match(/[^.!?]+[.!?]+["'\u2019]?[\s]*|[^.!?]+$/g) || [para];
          var sentCur = '';
          for (var si = 0; si < parts.length; si++) {
            var s = parts[si];
            if (sentCur.length + s.length > max && sentCur) {
              out.push(sentCur.trim()); sentCur = s;
            } else {
              sentCur = sentCur ? sentCur + ' ' + s : s;
            }
          }
          if (sentCur.trim()) out.push(sentCur.trim());
        } else if (cur.length + para.length + 2 > max && cur) {
          out.push(cur.trim());
          cur = para;
        } else {
          cur = cur ? cur + '\n\n' + para : para;
        }
      }
      if (cur.trim()) out.push(cur.trim());
      return out.length ? out : [txt.slice(0, max)];
    }

    // v5.4: Previous segment context — pass last translated sentence as context hint
    var _prevTranslated = '';

    for (var p = startPage; p < pages.length; p++) {
      var pg = pages[p];
      if (pg.blank || !pg.text) { translated.push({ num: pg.num, text: '' }); continue; }

      var segments = _splitPreservingParagraphs(pg.text, MAX_CHARS);
      var translatedParts = [];
      for (var c = 0; c < segments.length; c++) {
        if (!segments[c]) continue;
        var seg = segments[c];

        // v5.4: Context continuity — prepend last sentence from previous translation
        // as a "context" prefix to keep the API oriented, then strip it from result.
        var contextPrefix = '';
        if (_prevTranslated && _prevTranslated.length > 0 && c === 0) {
          var prevSentences = _prevTranslated.match(/[^.!?]{5,}[.!?]/g) || [];
          if (prevSentences.length > 0) {
            contextPrefix = prevSentences[prevSentences.length - 1].trim() + ' ';
          }
        }

        var queryText = contextPrefix + seg;
        var part = await retryWithBackoff(function (attempt, signal) {
          if (attempt > 0) {
            var hEl = document.getElementById('processing-msg');
            if (hEl) hEl.textContent = 'Optimizing connection\u2026';
          }
          var url = 'https://api.mymemory.translated.net/get?q=' +
            encodeURIComponent(queryText) + '&langpair=' +
            encodeURIComponent(srcLang) + '|' + encodeURIComponent(targetLang);
          return fetchWithRetry(url, signal ? { signal: signal } : {}, 1, 10000)
            .then(function (resp) { return resp.json(); })
            .then(function (json) {
              var raw = (json.responseData && json.responseData.translatedText) || seg;
              // Strip the context prefix from result if present
              if (contextPrefix && raw.startsWith(contextPrefix.trim())) {
                raw = raw.slice(contextPrefix.trim().length).trim();
              }
              return raw;
            });
        }, 3, 800, 12000).catch(function () { return seg; });

        translatedParts.push(part);
      }

      var pageTranslated = translatedParts.join('\n\n');
      _prevTranslated = pageTranslated;
      translated.push({ num: pg.num, text: pageTranslated });

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

    var _hasContent = translated.some(function (pg) { return pg.text && pg.text.trim().length > 0; });
    if (!_hasContent) {
      throw new Error('No translatable text was found in this PDF. The document may contain only images or scanned content. Use the OCR tool first to extract text.');
    }

    // Validate output ≠ input
    var _transInJoined  = pages.map(function (p) { return p.text || ''; }).join(' ').slice(0, 600);
    var _transOutJoined = translated.map(function (p) { return p.text || ''; }).join(' ').slice(0, 600);
    var _transIdentical = _transInJoined.length > 10 && _transOutJoined === _transInJoined;
    DT().validate('translate-quality-v54', {
      inputChars: _transInJoined.length, outputChars: _transOutJoined.length,
      identical: _transIdentical, chunkSize: MAX_CHARS,
    });
    if (_transIdentical) {
      DT().error('translate-quality', 'output identical to input');
      throw new Error('Translation could not be completed. The service may be temporarily unavailable. Please try again.');
    }

    // v5.4: Meaningfulness gate on full translated text
    var _fullOutput = translated.map(function(p){ return p.text || ''; }).join(' ');
    try { validateMeaningfulness('translate', _fullOutput); } catch (_) {
      // Only block on meaningless output, not short translations
      if (_fullOutput.length > 200) throw new Error('The translated output did not meet quality requirements. Please try again.');
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
    return {
      blob: blob,
      filename: brandedFilename(file.name, '-' + targetLang + '.txt'),
      _quality: { chars: _transOutJoined.length, paras: translated.length, pages: total },
    };
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

  // ── MAIN RUNNER (v5.4: Input Intelligence + OCR v2 + Meaningfulness Gate) ──
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

    // v5.4: Input Intelligence Engine pre-flight — detects magic bytes, scanned
    // vs digital, multi-language, empty/corrupt files, and builds routing advice.
    var _precheck = await InputAnalyzer.check(toolId, files);
    if (!_precheck.ok) {
      DT().error('runTool-precheck-fail', { toolId: toolId, reason: _precheck.reason });
      throw new Error(_precheck.message);
    }

    // Extract routing hints for downstream processors
    var _routing   = (_precheck.routing)   || {};
    var _langHint  = (_routing.langHint)   || null;
    var _forceOcr  = (_routing.forceOcr)   || false;
    if (_forceOcr || _langHint) {
      opts = Object.assign({}, opts || {}, {
        _forceOcr: _forceOcr,
        _langHint: _langHint,
      });
      DT().log('runTool-routing', { toolId: toolId, forceOcr: _forceOcr, langHint: _langHint });
    }

    var proc = processors[toolId];
    if (!proc) throw AEError(ERR.PARSE, 'no_processor_' + toolId);

    var steps = TOOL_STEPS[toolId] || ['Analyzing document', 'Processing', 'Finalizing'];
    LiveFeed.show(steps, 'Processing your file\u2026');

    // Phase 9: show estimator after feed renders
    setTimeout(function () { OutputEstimator.show(toolId, totalBytes); }, 300);

    // v5.4: Smart Retry Engine (enhanced)
    // Re-runs with upgraded options on: low_quality_output, invalid_output.
    // New retry strategies: OCR hybrid boost, structure rebuild, micro-chunks.
    var _SMART_RETRY_OPTS = {
      'ocr':                { _retryDpiBoost: true, _retryHybrid: true },
      'translate':          { _retrySmallChunks: true, _chunkSize: 150 },
      'pdf-to-word':        { _retryForceOcr: true },
      'pdf-to-excel':       { _retryForceOcr: true },
      'pdf-to-powerpoint':  { _retryForceOcr: true },
      'ai-summarize':       { sentences: 14, _retryBoost: true },
      'background-remover': { threshold: 200 },
      'compress':           { _retryDeep: true },
    };
    var _canRetry    = !!_SMART_RETRY_OPTS[toolId];
    var _maxAttempts = _canRetry ? 2 : 1;
    var result       = null;

    var _onStep = function (idx, state, pct, hint) { LiveFeed.update(idx, state, pct, hint); };

    for (var _attempt = 1; _attempt <= _maxAttempts; _attempt++) {
      var _curOpts = (_attempt === 1)
        ? (opts || {})
        : Object.assign({}, opts || {}, _SMART_RETRY_OPTS[toolId] || {});

      if (_attempt > 1) {
        DT().log('smart-retry-v54', { toolId: toolId, attempt: _attempt, opts: Object.keys(_SMART_RETRY_OPTS[toolId] || {}) });
        // Neutral UX message — Stealth Mode (never expose internals)
        LiveFeed.update(1, 'active', 38,
          _attempt === 2 ? 'Improving result\u2026' : 'Optimizing output\u2026');
      }

      var _procErr = null;

      try {
        result = await withTimeout(proc(files, _curOpts, _onStep), TOOL_TIMEOUT_MS);
      } catch (err) {
        _procErr = err;
      }

      if (_procErr) {
        var _isOrig = (_procErr.message === ERR.ORIG || _procErr.message === '__orig__' ||
                       _procErr.aeType === ERR.ORIG);

        if (_isOrig) {
          // Seamless handoff to browser-tools.js fallback — no retry
          LiveFeed.update(1, 'active', 30, 'Preparing content\u2026');
          try {
            result = await origProcess(toolId, files, opts);
          } catch (origErr) {
            LiveFeed.hide(); vanish();
            throw new Error(safeMessage(origErr) || 'Something went wrong. Please try again.');
          }
          break;
        }

        // Low-quality or invalid output → retry with enhanced opts if available
        var _isLowQ = (_procErr.message === 'low_quality_output' ||
                       _procErr.message === 'invalid_output');
        if (_isLowQ && _attempt < _maxAttempts) {
          result = null;
          continue;
        }

        // Terminal error — sanitize and surface
        LiveFeed.hide(); vanish();
        var _safeErr = new Error(safeMessage(_procErr) || 'Something went wrong. Please try again.');
        _safeErr.aeType = _procErr.aeType;
        throw _safeErr;
      }

      // ── v5.4 Validation Pipeline (4-Tier) ───────────────────────────────
      // Tier 1: validateBlob  — hard size gate
      // Tier 2: analyzeResultQuality — hybrid quality score (size + structure)
      // Tier 3: validateMeaningfulness — semantic content quality
      // RULE: NO FAKE SUCCESS — block download on any failure.
      var _valFailed = false;
      var _valReason = '';

      if (result) {
        var _rb = (result && result.blob) ? result.blob : result;
        if (_rb instanceof Blob) {
          try {
            validateBlob(toolId, _rb);
          } catch (_blobErr) {
            _valFailed = true; _valReason = 'blob';
          }
        }
        if (!_valFailed) {
          try {
            analyzeResultQuality(toolId, result, result && result._quality ? result._quality : {});
          } catch (_qualErr) {
            _valFailed = true; _valReason = 'quality';
          }
        }
        // Tier 3: validateMeaningfulness — only for text-output results
        if (!_valFailed && result && result._textContent) {
          try {
            validateMeaningfulness(toolId, result._textContent);
          } catch (_meaningErr) {
            _valFailed = true; _valReason = 'meaningfulness';
          }
        }
      }

      if (_valFailed) {
        DT().log('validation-fail', { toolId: toolId, attempt: _attempt, reason: _valReason });
        if (_attempt < _maxAttempts && _canRetry) {
          DT().log('smart-retry-quality', { toolId: toolId, attempt: _attempt, reason: _valReason });
          LiveFeed.update(1, 'active', 40, 'Optimizing output\u2026');
          result = null;
          continue;
        }
        LiveFeed.hide(); vanish();
        throw new Error('The output quality was too low to be useful. Please try with a clearer or higher-quality file.');
      }

      break; // success — exit retry loop
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
    version:              '5.4',
    InputAnalyzer:        InputAnalyzer,
    TOOL_IDS:             ADVANCED_IDS,
    LiveFeed:             LiveFeed,
    LivePreview:          LivePreview,
    OutputEstimator:      OutputEstimator,
    TabCoordinator:       TabCoordinator,
    IDBTemp:              IDBTemp,
    ProgressStore:        ProgressStore,
    memTier:              memTier,
    vanish:               vanish,
    // Validation (v5 three-tier)
    validateOutput:           validateOutput,       // compat alias → validateBlob
    validateBlob:             validateBlob,
    validateContent:          validateContent,
    analyzeResultQuality:     analyzeResultQuality,
    validateMeaningfulness:   validateMeaningfulness,   // v5.4 Tier 4
    autoOcrFallback:          autoOcrFallback,
    extractStructuredParagraphs: extractStructuredParagraphs,
    buildColumnRows:          buildColumnRows,
    // Audit helper — call AdvancedEngine.audit() in DevTools for a full report
    audit: function () {
      var dt     = window.DebugTrace;
      var tools  = Array.from(ADVANCED_IDS);
      var entries   = dt ? dt.getLogs()   : [];
      var errors    = entries.filter(function (e) { return e.type === 'error'; });
      var results   = entries.filter(function (e) { return e.type === 'result'; });
      var validates = entries.filter(function (e) { return e.type === 'validate'; });
      var qs = dt ? dt.qualitySummary() : null;

      console.group('AdvancedEngine v5.4 — Audit Report');
      console.log('Version: 5.4');
      console.log('Tools registered:', tools.length, tools);
      console.log('DebugTrace entries:', entries.length,
        '| errors:', errors.length, '| results:', results.length, '| validates:', validates.length);

      // v5.4: Input Intelligence Engine tracking
      var inputIntelChecks = entries.filter(function (e) {
        return e.key === 'input-intelligence' || e.key === 'input-intelligence-magic' || e.key === 'input-intelligence-scan';
      });
      console.log('Input Intelligence checks:', inputIntelChecks.length);
      var magicChecks = entries.filter(function (e) { return e.key === 'input-intelligence-magic'; });
      var magicTypes = magicChecks.map(function(e) { return (e.data || {}).detected; }).filter(Boolean);
      if (magicTypes.length) console.log('File types detected:', magicTypes.join(', '));

      // v5.4: OCR v2 tracking
      var ocrV2Starts = entries.filter(function (e) { return e.key === 'ocr-v2-start'; });
      var ocrV2Done   = entries.filter(function (e) { return e.key === 'ocr-v2-done'; });
      var ocrNative   = ocrV2Done.filter(function(e) { return (e.data||{}).method === 'native-only'; });
      console.log('OCR v2 runs:', ocrV2Starts.length,
        '| native-only:', ocrNative.length, '| full OCR:', ocrV2Done.length - ocrNative.length);

      // v5.4: Meaningfulness Engine tracking
      var meaningChecks  = validates.filter(function (e) { return e.key === 'meaningfulness'; });
      var meaningFails   = errors.filter(function (e) { return e.key === 'meaningfulness-fail'; });
      var meaningWarns   = entries.filter(function (e) { return e.key === 'meaningfulness-warning'; });
      console.log('Meaningfulness checks:', meaningChecks.length,
        '| failures:', meaningFails.length, '| warnings:', meaningWarns.length);
      if (meaningChecks.length) {
        var scores = meaningChecks.map(function(e) { return parseFloat((e.data||{}).score || '0'); });
        var avgScore = scores.reduce(function(s,v){return s+v;},0) / scores.length;
        console.log('  avg score:', avgScore.toFixed(2),
          '| min:', Math.min.apply(null,scores).toFixed(2),
          '| max:', Math.max.apply(null,scores).toFixed(2));
      }

      // v5.4: AI Document Parser v5 tracking
      var docParserV5 = entries.filter(function (e) { return e.key === 'doc-parser-v5-multicol'; });
      console.log('AI Document Parser v5 multi-column detections:', docParserV5.length);

      // v5.4: Table Intelligence System tracking
      var tableIntel = entries.filter(function (e) { return e.key === 'table-intelligence-v54'; });
      var tableRejected = tableIntel.filter(function(e){ return (e.data||{}).rejected; });
      console.log('Table Intelligence decisions:', tableIntel.length, '| rejected:', tableRejected.length);

      // v5.4: Smart Retry tracking
      var retries = entries.filter(function (e) {
        return e.key === 'smart-retry-v54' || e.key === 'smart-retry-quality';
      });
      console.log('Smart retries v5.4:', retries.length);
      if (retries.length) {
        var byTool = {};
        retries.forEach(function(e) { var t=(e.data||{}).toolId||'?'; byTool[t]=(byTool[t]||0)+1; });
        console.log('  by tool:', byTool);
      }

      if (qs) {
        console.group('Quality Summary');
        console.log('Score:', qs.qualityScore);
        console.log('OCR used:', qs.ocrUsed);
        if (qs.issues && qs.issues.length) console.warn('Issues:', qs.issues);
        console.groupEnd();
      }
      if (errors.length)    console.warn('Errors:',    errors);
      if (results.length)   console.info('Results:',   results);
      if (validates.length) console.info('Validates:', validates);
      if (dt) dt.dump();

      console.log('WorkerPool:', window.WorkerPool ? window.WorkerPool.getStats() : 'not loaded');
      console.log('MemoryTier:', memTier());
      console.groupEnd();
      return qs;
    },
  };

}());

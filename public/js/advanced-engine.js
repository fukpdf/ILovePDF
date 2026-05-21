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
      'protect', 'unlock', 'pdf-to-jpg', 'edit', 'sign', 'redact',
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
  //
  // Phase 24: Priority routing.
  // _currentWorkerPriority is set by runTool() before invoking each processor
  // and reset to 'normal' in the finally block.  All WorkerPool.run() calls
  // in this file read this variable so every worker dispatch automatically
  // inherits the correct tier without touching individual processor code.
  //
  // Tier table (_TOOL_PRIORITY):
  //   high       — ocr, compare, repair, scan-to-pdf  (user-blocking, time-critical)
  //   normal     — all PDF/image conversion tools      (standard interactive ops)
  //   low        — restructure/annotate/security tools (lighter, background-tolerant)
  //   background — ai-summarize, translate             (heavy batch / async chunks)
  var _TOOL_PRIORITY = {
    // HIGH — interactive, user-blocking
    'ocr':               'high',
    'compare':           'high',
    'repair':            'high',
    'scan-to-pdf':       'high',
    // NORMAL — standard conversion pipeline
    'pdf-to-word':       'normal',
    'pdf-to-excel':      'normal',
    'pdf-to-powerpoint': 'normal',
    'pdf-to-jpg':        'normal',
    'jpg-to-pdf':        'normal',
    'word-to-pdf':       'normal',
    'excel-to-pdf':      'normal',
    'html-to-pdf':       'normal',
    'powerpoint-to-pdf': 'normal',
    'word-to-excel':     'normal',
    // LOW — restructure / annotate / security (less time-critical)
    'compress':          'low',
    'merge':             'low',
    'split':             'low',
    'rotate':            'low',
    'organize':          'low',
    'page-numbers':      'low',
    'watermark':         'low',
    'crop':              'low',
    'protect':           'low',
    'unlock':            'low',
    'edit':              'low',
    'sign':              'low',
    'redact':            'low',
    'workflow':          'low',
    'background-remover':'low',
    'crop-image':        'low',
    'resize-image':      'low',
    'image-filters':     'low',
    // BACKGROUND — async/batch AI operations
    'ai-summarize':      'background',
    'translate':         'background',
  };

  // Module-level current priority — set by runTool(), read by worker bridges.
  var _currentWorkerPriority = 'normal';

  function runAdvancedWorker(message, transferables) {
    var pool = window.WorkerPool;
    if (!pool) return Promise.reject(AEError(ERR.WORKER, 'pool_unavailable'));
    return pool.run('/workers/advanced-worker.js', message, transferables || [],
      { priority: _currentWorkerPriority });
  }

  function runPdfWorker(toolId, buffers, options) {
    var pool = window.WorkerPool;
    if (!pool) return Promise.reject(AEError(ERR.WORKER, 'pool_unavailable'));
    return pool.run('/workers/pdf-worker.js',
      { tool: toolId, buffers: buffers, options: options || {} }, buffers,
      { priority: _currentWorkerPriority });
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
  var _bgCleanIv = setInterval(backgroundClean, 60000);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('ae-bg-clean', _bgCleanIv);

  // ── PHASE 20F: GLOBAL MEMORY SAFETY HELPERS ──────────────────────────────
  // Reusable cleanup utilities following OCR engine patterns (Phase 19B).
  // All helpers are intentionally silent on error — never propagate cleanup failures.
  function safeCanvasCleanup(cvs) {
    try { if (cvs) { cvs.width = 0; cvs.height = 0; } } catch (_) {}
  }
  function safeBitmapClose(bmp) {
    try { if (bmp && typeof bmp.close === 'function') bmp.close(); } catch (_) {}
  }
  function safeObjectUrl(url) {
    try { if (url) URL.revokeObjectURL(url); } catch (_) {}
  }
  async function safeWorkerTerminate(w) {
    if (!w) return;
    try { await w.terminate(); } catch (_) {}
  }
  function safeArrayNull(arr) {
    if (!arr) return;
    try { for (var i = 0; i < arr.length; i++) arr[i] = null; arr.length = 0; } catch (_) {}
  }
  // Async yield — lets the browser paint/handle events between heavy iterations.
  function yieldToMain(ms) {
    return new Promise(function (r) { setTimeout(r, ms || 0); });
  }

  // ── PHASE 20B: TEXT QUALITY SCORER ───────────────────────────────────────
  // Detects garbled text extraction: broken fonts, missing cmap, private-use
  // character floods, replacement chars, extreme symbol noise.
  // Called by pdf-to-word/excel/pptx before committing to native extraction.
  //
  // Returns: { score: 0-1, issues: string[], needsOcr: bool }
  //   score >= 0.60 → text is usable
  //   score <  0.40 → text is garbled, OCR should be attempted automatically
  function _scoreTextQuality(text) {
    if (!text || text.length < 10) return { score: 0, issues: ['too_short'], needsOcr: true };
    var issues     = [];
    var score      = 1.0;
    var totalChars = Math.max(1, text.replace(/\s/g, '').length);

    // 1. Replacement character ratio (U+FFFD = broken font encoding)
    var replacements = (text.match(/\ufffd/g) || []).length;
    var replRatio    = replacements / totalChars;
    if (replRatio > 0.05) {
      issues.push('replacement_chars:' + (replRatio * 100).toFixed(0) + '%');
      score -= 0.40;
    }

    // 2. Private Use Area characters (PUA — garbled glyph mapping)
    var privateUse = (text.match(/[\ue000-\uf8ff]/g) || []).length;
    var privRatio  = privateUse / totalChars;
    if (privRatio > 0.08) {
      issues.push('private_use_chars:' + (privRatio * 100).toFixed(0) + '%');
      score -= 0.30;
    }

    // 3. Readable word ratio — words >=2 letters vs. total whitespace-delimited tokens
    var words     = (text.match(/\b[a-z\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff]{2,}\b/gi) || []);
    var tokens    = text.split(/\s+/).filter(function (t) { return t.trim().length > 0; });
    var readRatio = tokens.length > 0 ? words.length / tokens.length : 0;
    if (tokens.length > 8 && readRatio < 0.25) {
      issues.push('low_word_ratio:' + readRatio.toFixed(2));
      score -= 0.30;
    }

    // 4. Symbol noise ratio (extreme non-alphanumeric density)
    var nonAlpha  = (text.replace(/\s/g, '').match(/[^a-z0-9.,;:!?'"()\-\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff]/gi) || []).length;
    var noisRatio = nonAlpha / totalChars;
    if (totalChars > 40 && noisRatio > 0.55) {
      issues.push('high_symbol_noise:' + noisRatio.toFixed(2));
      score -= 0.20;
    }

    score = Math.max(0, Math.min(1, score));
    return { score: score, issues: issues, needsOcr: score < 0.40 };
  }

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
  var PDFJS_URL    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    // Share the global import promise with pdf-preview.js / live-preview.js to
    // guarantee exactly one import() call and one consistent worker version.
    if (window.__pdfjsLibPromise) return window.__pdfjsLibPromise;
    if (_pdfJsPromise) return _pdfJsPromise;
    _pdfJsPromise = window.__pdfjsLibPromise = import(PDFJS_URL).then(function (mod) {
      var lib = mod && (mod.default || mod);
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = lib;
      return lib;
    }).catch(function (err) {
      _pdfJsPromise = null;
      window.__pdfjsLibPromise = null;
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
      } catch (opfsErr) {
        // OPFS write failed — log the failure (important for large files that may OOM)
        // then fall through to in-RAM path.
        DT().error('opfs-stage-failed', { sizeMB: (size / 1048576).toFixed(1), err: String(opfsErr).slice(0, 100) });
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

    // Urdu/Persian disambiguation from Arabic script:
    // Urdu uses exclusive chars like ں ے ط ظ ۓ ﮯ  (U+06BA, U+06D2, U+06D3)
    // Persian uses chars like گ پ چ ژ (U+06AF, U+067E, U+0686, U+0698)
    var urdu    = (s.match(/[\u06BA\u06D2\u06D3\u06BE\u06C1\u06C3\u06D4]/g) || []).length;
    var persian = (s.match(/[\u06AF\u067E\u0686\u0698\u06CC]/g) || []).length;

    var lang;
    // Strict thresholds: needs clear dominance to choose non-Latin
    if      (cjk    / total > 0.20) lang = 'chi_sim';
    else if (arabic / total > 0.15) {
      // Disambiguate: Urdu vs Persian vs Arabic
      if (urdu > persian && urdu > 0)         lang = 'urd';
      else if (persian > urdu && persian > 0)  lang = 'fas';
      else                                     lang = 'ara';
    }
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
      /* Translate step keys using window.t() if available. */
      var _tStep = function (k) {
        if (typeof window.t === 'function') {
          var v = window.t(k);
          if (v && v !== k) return v;
        }
        /* Graceful fallback: convert key suffix to readable text */
        return k.replace(/^steps\./, '').replace(/_/g, ' ');
      };
      var translatedSteps = (steps || []).map(_tStep);
      this._steps = translatedSteps;
      this._title = title ||
        (typeof window.t === 'function' ? window.t('steps.processing_file') : 'Processing your file\u2026');

      var titleEl = document.getElementById('processing-title');
      var msgEl   = document.getElementById('processing-msg');
      if (titleEl) titleEl.textContent = this._title;
      if (msgEl)   msgEl.textContent   = (typeof window.t === 'function')
        ? window.t('steps.preparing_file') : 'Preparing your file\u2026';

      var area = document.getElementById('result-area');
      if (!area) return;
      var stepsHtml = translatedSteps.map(function (label, i) {
        return '<div class="ae-step" id="ae-s-' + i + '" data-s="pending">' +
               '<span class="ae-dot"></span><span>' + _escHtml(label) + '</span></div>';
      }).join('');
      var _privacyText = (typeof window.t === 'function')
        ? window.t('steps.privacy_notice')
        : 'Your file is processed securely \u2014 automatically deleted after use';
      var _perfKey = PERF_MODE === 'high' ? 'steps.perf_optimal'
                  : PERF_MODE === 'medium' ? 'steps.perf_moderate' : 'steps.perf_high_load';
      var _perfText = (typeof window.t === 'function') ? window.t(_perfKey) : PERF_LABEL;
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
            _escHtml(_privacyText) +
          '</div>' +
          '<div class="ae-perf">' + _escHtml(_perfText) + '</div>' +
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
          msgEl.textContent = (typeof window.t === 'function')
            ? window.t('steps.finalizing') : 'Finalizing output\u2026';
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
      if (msgEl) msgEl.textContent = (typeof window.t === 'function')
        ? window.t('steps.usual_time') : 'This usually takes only a few seconds.';
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
        window.WorkerPool.prewarm && window.WorkerPool.prewarm('/workers/ocr-preprocessor-worker.js');
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
  var _LIST_RE = /^(\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb\u2610\u2611\u2612\u2714\u2718]|\s*\d+[.)]\s|\s*[a-zA-Z][.)]\s|\s*[ivxlcdmIVXLCDM]+[.)]\s)/;

  // ── SYMBOL NORMALIZATION (checkbox/radio glyphs → ASCII equivalents) ──────
  function _normalizeSymbols(text) {
    return (text || '')
      .replace(/[☑✓✔☒✗✘\u2611\u2612\u2714\u2718]/g, '[x]')
      .replace(/[☐□\u2610]/g, '[ ]');
  }

  // ── SIGNATURE LINE DETECTION ──────────────────────────────────────────────
  function _isSignatureLine(text) {
    var t = (text || '').trim();
    return /^[_]{6,}$/.test(t) ||
           /^[-]{8,}$/.test(t) ||
           /^[=]{8,}$/.test(t) ||
           /^\.{8,}$/.test(t)  ||
           /^_{3,}\s*(Date|Sign|Name|Title|Signature|Witness|Authorized|Representative)[:\s]*_{0,}$/i.test(t);
  }

  // ── FORM / LABEL-VALUE LINE DETECTION ────────────────────────────────────
  // Detects "Label: Value", "Field Name ........... Value", etc.
  function _isFormLine(text) {
    return /^[A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF\s]{1,38}:\s*\S/.test(text) ||
           /^[A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF\s]{1,38}[.]{5,}\s*\S/.test(text);
  }

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

    var validItems = items.filter(function (it) { return it.str.trim(); });

    // ── TABLE DETECTION (v4.0 ENTERPRISE) ────────────────────────────────────
    // Before building paragraphs, check whether this page is a table.
    // Strategy: run the existing detectTableGridByAlignment + clusterCellsByXandY.
    // If a real multi-column table is found, emit it as a single isTable paragraph
    // so buildDocx() can render a real <w:tbl> element.
    //
    // We also try to separate header lines (above the table y-range) from table rows
    // so that headings above the table are still preserved as heading paragraphs.
    if (validItems.length >= 6 && detectTableGridByAlignment(items)) {
      // Fix B3/B8: Compute heading band FIRST from all valid items, then pass
      // only non-heading items to clusterCellsByXandY to eliminate duplicates.
      // In PDF.js coordinates y=0 is at the BOTTOM; higher y = higher on page.
      var allYs = validItems.map(function(it) { return Math.round(it.transform[5] / 6) * 6; });
      var yMin  = Math.min.apply(null, allYs);
      var yMax  = Math.max.apply(null, allYs);
      var yBand = (yMax - yMin) || 1;

      // Items in the top 12% of y-range (highest y values) are headings/captions.
      var headingYThreshold = yMax - yBand * 0.12;
      var headingItems  = validItems.filter(function(it) {
        return Math.round(it.transform[5] / 6) * 6 > headingYThreshold;
      });
      // Non-heading items go to the table clusterer — no overlap with headings
      var tableItems = (headingItems.length > 0 && headingItems.length < validItems.length * 0.25)
        ? validItems.filter(function(it) {
            return Math.round(it.transform[5] / 6) * 6 <= headingYThreshold;
          })
        : validItems;

      var tableRows = clusterCellsByXandY(tableItems.length >= 4 ? tableItems : validItems);
      if (tableRows && tableRows.length >= 2 && tableRows[0] && tableRows[0].length >= 2) {
        var result = [];

        // Emit headings/captions that sit above the table band (deduplicated)
        if (headingItems.length > 0 && headingItems.length < validItems.length * 0.25) {
          var headerParas = _buildParaLines(headingItems, medianH, maxH);
          headerParas.forEach(function(hp) { result.push(hp); });
        }

        // Fix B4/B7: propagate proportional column widths to the worker
        result.push({
          isTable:   true,
          rows:      tableRows,
          colCount:  tableRows[0].length,
          colWidths: tableRows._colWidths || null,
          text:      '',
        });

        DT().log('doc-parser-v4-table', {
          rows: tableRows.length,
          cols: tableRows[0] ? tableRows[0].length : 0,
          items: validItems.length,
          headingsSplit: headingItems.length,
        });
        return result;
      }
    }

    // ── MULTI-COLUMN DETECTION ────────────────────────────────────────────────
    if (validItems.length > 6) {
      var xs = validItems.map(function (it) { return it.transform[4]; });
      xs.sort(function (a, b) { return a - b; });
      var xRange = xs[xs.length - 1] - xs[0];

      // Use 22% threshold (was 28%) for more reliable 2-column detection
      var colBoundaries = [];
      for (var ci = 1; ci < xs.length; ci++) {
        if (xs[ci] - xs[ci - 1] > xRange * 0.22) {
          colBoundaries.push((xs[ci - 1] + xs[ci]) / 2);
        }
      }

      if (colBoundaries.length >= 1 && xRange > 60) {
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

        // Validate column balance (each column has ≥15% of items)
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

    // v4.0: Dynamic y-bucket — based on median font height so lines are never
    // accidentally merged due to a fixed 2px tolerance on dense/small-font PDFs.
    // Minimum bucket = 2px, max = 8px (avoids over-grouping large-font docs).
    var _yBucket = Math.max(2, Math.min(8, Math.round(medianH * 0.35)));

    // Group items into lines by y-coordinate (dynamic tolerance)
    var lineMap = {};
    items.forEach(function (it) {
      if (!it.str.trim()) return;
      var yKey = Math.round(it.transform[5] / _yBucket) * _yBucket;
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

      var lineMaxH   = Math.max.apply(null, lineItems.map(function (it) { return Math.abs(it.transform[3]); }));
      var lineBold   = lineItems.some(function(it) { return it.fontName && /bold/i.test(it.fontName); });
      // Fix B5: detect italic runs so buildDocx can apply <w:i/> markup
      var lineItalic = lineItems.some(function(it) { return it.fontName && /italic|oblique/i.test(it.fontName); });

      // Normalize checkbox/symbol glyphs in extracted text
      lineText = _normalizeSymbols(lineText);

      // Signature line: emit directly, no further classification
      if (_isSignatureLine(lineText)) {
        paragraphs.push({
          text: lineText, isHeading: false, isList: false, isNumList: false,
          isSignature: true, bold: false, italic: false, level: 0,
          fontSize: lineMaxH,
        });
        lastY = y; lastText = lineText; lastH = lineMaxH;
        return; // continue forEach
      }

      // Classify line — v5.4: richer detection
      var isList    = _LIST_RE.test(lineText);
      var isNumList = _NUMBLIST_RE.test(lineText);
      var isSection = _SECTION_RE.test(lineText.trim());
      var isForm    = !isList && !isNumList && _isFormLine(lineText);

      var isHeading = !isList && !isForm && (
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
      var isNewBlock  = gap > medianH * 2.0 || isHeading || isSection || isPageBreak || isForm;

      // Intelligent broken-line merging v5.4:
      // Merge if: previous line didn't end with sentence punctuation AND
      //           gap is small AND same approximate font size AND
      //           not starting a list item / form line
      var prevHasSentenceEnd = lastText ? /[.!?:;)\]"'\u2019\u201d\u060c\u061b\u061f]$/.test(lastText.trim()) : true;
      var isSmallGap         = gap > 0 && gap < medianH * 1.8;
      var sameSize           = Math.abs(lineMaxH - lastH) < medianH * 0.3;
      var shouldMerge        = !isNewBlock && !prevHasSentenceEnd && isSmallGap && sameSize && lastY !== null && !isForm;

      if (shouldMerge) {
        var last = paragraphs[paragraphs.length - 1];
        if (last && !last.isHeading && !last.isSignature && !last.isForm) {
          // Smart join: add space or not based on whether last char is hyphen
          var lastChar = last.text.trim().slice(-1);
          if (lastChar === '-') {
            last.text = last.text.trim().slice(0, -1) + lineText; // de-hyphenate
          } else {
            last.text += ' ' + lineText;
          }
          last.isList  = last.isList  || isList;
          last.bold    = last.bold    || lineBold;
          last.italic  = last.italic  || lineItalic;
        } else {
          paragraphs.push({ text: lineText, isHeading: isHeading, isList: isList, isNumList: isNumList,
            isForm: isForm, bold: lineBold, italic: lineItalic, fontSize: lineMaxH });
        }
      } else {
        // v5.0: store bold/italic/fontSize/xPositions for buildDocx run-level markup
        // PDF.js text items use transform[4] for x coordinate
        var xPosData = lineItems
          .map(function(it) { return it.transform ? it.transform[4] : (it.x || 0); })
          .filter(function(x){ return x > 0; });
        paragraphs.push({
          text:       lineText,
          isHeading:  isHeading,
          isList:     isList,
          isNumList:  isNumList,
          isSection:  isSection,
          isForm:     isForm,
          level:      isHeading ? _headingLevel(lineMaxH, medianH, maxH) : 0,
          bold:       lineBold,
          italic:     lineItalic,
          fontSize:   lineMaxH,
          xPositions: xPosData.length > 1 ? xPosData : undefined,
          pageWidth:  612,
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
  // Fix B2: Stitch fragmented placeholder tokens (e.g. "D D - M M - Y Y Y Y")
  // When consecutive items are short (≤2 chars) and the gap is tiny relative to
  // font size, join without inserting a space — they are one logical token.
  function _reconstructLineText(lineItems) {
    if (!lineItems.length) return '';
    var parts = [];
    var prevEnd  = null;
    var prevItem = null;
    lineItems.forEach(function(it) {
      if (!it.str) return;
      var x    = it.transform[4];
      var gap  = prevEnd !== null ? x - prevEnd : 0;
      var fontH = Math.abs(it.transform[3]) || 10;

      if (prevEnd !== null && gap > 3) {
        // Placeholder-stitching heuristic: if both this and the previous item
        // are short (≤2 chars) and the gap is less than 1 character width,
        // they are part of a fragmented placeholder — join without space.
        var prevStr    = prevItem ? prevItem.str : '';
        var isShortSeq = it.str.length <= 2 && prevStr.length <= 2;
        var isNarrowGap = gap < fontH * 0.9; // less than ~0.9 char-widths
        if (!(isShortSeq && isNarrowGap)) {
          var lastPart = parts[parts.length - 1] || '';
          if (lastPart && !lastPart.endsWith(' ')) parts.push(' ');
        }
      }
      parts.push(it.str);
      prevEnd  = x + (it.width || it.str.length * fontH * 0.5);
      prevItem = it;
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
  // Fix B1/B6: Relax variance gate — only reject high-variance when 3+ column
  // gaps exist. 2-column (label+value) forms have exactly 1 gap and are never
  // rejected by variance. 3-column grids are still validated for regularity.
  function detectTableGridByAlignment(items) {
    if (!items || items.length < 6) return false;
    var filtered = items.filter(function (it) { return it.str.trim(); });
    if (filtered.length < 4) return false;

    var xs = filtered.map(function (it) { return Math.round(it.transform[4] / 6) * 6; });
    var xFreq = {};
    xs.forEach(function (x) { xFreq[x] = (xFreq[x] || 0) + 1; });
    var alignedCols = Object.keys(xFreq).filter(function (x) { return xFreq[x] >= 2; });
    if (alignedCols.length < 2) return false;

    // Spacing consistency: check that x-gaps are regular (table-like).
    // Fix B6: Only apply variance rejection when there are 3+ columns (2+ gaps).
    // For 2-column documents (1 gap) variance is always 0 — skip check entirely.
    // For sparse label-value forms with irregular column spacing the CV threshold
    // is raised from 1.5 → 2.2 to accept proportionally wider value columns.
    var colXs = alignedCols.map(Number).sort(function(a,b) { return a - b; });
    if (colXs.length >= 3) {
      var gaps = [];
      for (var gi = 1; gi < colXs.length; gi++) gaps.push(colXs[gi] - colXs[gi-1]);
      var avgGap = gaps.reduce(function(s,g){return s+g;},0) / gaps.length;
      var gapVariance = gaps.reduce(function(s,g){return s+Math.pow(g-avgGap,2);},0) / gaps.length;
      // Raised CV threshold (1.5 → 2.2) to accept real tables with uneven cols
      if (avgGap > 5 && Math.sqrt(gapVariance) / avgGap > 2.2) return false;
    }

    var ys = filtered.map(function (it) { return Math.round(it.transform[5] / 6) * 6; });
    var yFreq = {};
    ys.forEach(function (y) { yFreq[y] = (yFreq[y] || 0) + 1; });
    var alignedRows = Object.keys(yFreq).filter(function (y) { return yFreq[y] >= 2; });
    return alignedRows.length >= 2;
  }

  // clusterCellsByXandY: precision cell clustering with consistent column enforcement
  // Fix B4/B7: Compute per-column x-span proportions and attach as _colWidths[]
  // so buildTableXml can produce proportional (non-equal) column widths.
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

    var nc = xBoundaries.length + 1; // total number of columns

    function getCol(x) {
      for (var bi = 0; bi < xBoundaries.length; bi++) {
        if (x < xBoundaries[bi]) return bi;
      }
      return xBoundaries.length;
    }

    var cells  = {};
    var maxCol = 0;
    // Track min and max x seen per column for width estimation
    var colXMin = {};
    var colXMax = {};
    filtered.forEach(function (it) {
      var rawX = Math.round(it.transform[4]);
      var yKey = Math.round(it.transform[5] / 6) * 6;
      var col  = getCol(rawX);
      maxCol   = Math.max(maxCol, col);
      if (!cells[yKey]) cells[yKey] = {};
      cells[yKey][col] = (cells[yKey][col] ? cells[yKey][col] + ' ' : '') + it.str.trim();
      // Accumulate x-extent per column for proportional width calc
      if (colXMin[col] === undefined || rawX < colXMin[col]) colXMin[col] = rawX;
      var itemW = it.width || it.str.length * (Math.abs(it.transform[3]) || 10) * 0.55;
      var rawXEnd = rawX + itemW;
      if (colXMax[col] === undefined || rawXEnd > colXMax[col]) colXMax[col] = rawXEnd;
    });

    var ys = Object.keys(cells).map(Number).sort(function (a, b) { return b - a; });
    var rows = ys.map(function (y) {
      var row = [];
      for (var ci = 0; ci <= maxCol; ci++) row.push(cells[y][ci] || '');
      return row;
    });

    // v5.4 RULE: Reject if only 1 column — not tabular data
    if (maxCol === 0) return [];

    // v5.0: Relaxed validation — accept text-only tables (HR tables, legal tables,
    // government forms, schedules) which have no numeric data but are still real tables.
    // Only reject if: single-row result AND no numeric content (true garbage).
    var hasNumericCol = false;
    for (var ci2 = 0; ci2 <= maxCol; ci2++) {
      var colVals = rows.map(function(r) { return r[ci2] || ''; }).filter(Boolean);
      var numericCount = colVals.filter(function(v) { return /\d/.test(v); }).length;
      if (numericCount / colVals.length > 0.20) { hasNumericCol = true; break; }
    }
    // Accept text-only tables as long as they have 2+ rows (multi-row = real table)
    // Only reject single-row text-only results to avoid false positives
    if (!hasNumericCol && rows.length < 2) return [];

    // Fix B4/B7: Compute proportional column widths from actual x-extents.
    // For each column, span = max(xEnd) - min(xStart), with a floor of 30px.
    // Attach as _colWidths[] property on the rows array so callers can pass it
    // to buildTableXml for proper proportional rendering.
    var colSpans = [];
    for (var cj = 0; cj <= maxCol; cj++) {
      var lo  = colXMin[cj] !== undefined ? colXMin[cj] : 0;
      var hi  = colXMax[cj] !== undefined ? colXMax[cj] : lo + 60;
      colSpans.push(Math.max(30, hi - lo));
    }
    rows._colWidths = colSpans;

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
    'word-to-pdf':        500,
    'excel-to-pdf':       500,
    'powerpoint-to-pdf':  500,
    'ocr':                200,
    'background-remover': 200,
    'repair':             200,
    'compress':           200,
    'compare':            20,
    'ai-summarize':       20,
    'translate':          20,
    'workflow':           200,
    'word-to-excel':      1000,
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
    else if (toolId === 'pdf-to-powerpoint') {
      // Gate: at least 1 slide with real content (title or body text)
      var pptxSlides = data.slides !== undefined ? data.slides : 0;
      var pptxChars  = data.chars  !== undefined ? data.chars  : 0;
      if (pptxSlides < 1) issues.push('no_slides_generated');
      if (pptxChars  < 5) issues.push('no_extractable_text:' + pptxChars);
    }
    else if (toolId === 'word-to-pdf') {
      var wpdfParas = data.paragraphs !== undefined ? data.paragraphs : 0;
      var wpdfChars = data.chars      !== undefined ? data.chars      : 0;
      if (wpdfParas === 0 && wpdfChars < 10) issues.push('no_content_extracted');
    }
    else if (toolId === 'word-to-excel') {
      var w2xRows   = data.rows   !== undefined ? data.rows   : 0;
      var w2xSheets = data.sheets !== undefined ? data.sheets : 0;
      if (w2xRows < 1)   issues.push('no_data_rows');
      if (w2xSheets < 1) issues.push('no_sheets_generated');
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
    'word-to-excel',
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
      else if (fn.includes('urd') || fn.includes('ur_') || fn.includes('_ur')) ocrLang = 'urd+eng';
      else if (fn.includes('ara') || fn.includes('ar_') || fn.includes('_ar')) ocrLang = 'ara+eng';
      else if (fn.includes('fas') || fn.includes('per') || fn.includes('far') || fn.includes('_fa')) ocrLang = 'fas+eng';
      else if (fn.includes('pus') || fn.includes('pash'))ocrLang = 'pus+eng';
      else if (fn.includes('heb') || fn.includes('_he')) ocrLang = 'heb+eng';
      else if (fn.includes('rus') || fn.includes('ru_')) ocrLang = 'rus+eng';
      else if (fn.includes('deu') || fn.includes('ger')) ocrLang = 'deu+eng';
      else if (fn.includes('fra') || fn.includes('fr_')) ocrLang = 'fra+eng';
      else if (fn.includes('spa') || fn.includes('es_')) ocrLang = 'spa+eng';
      else if (fn.includes('jpn') || fn.includes('ja_')) ocrLang = 'jpn+eng';
      else if (fn.includes('kor') || fn.includes('ko_')) ocrLang = 'kor+eng';
      else if (fn.includes('por') || fn.includes('pt_')) ocrLang = 'por+eng';
      else if (fn.includes('hin') || fn.includes('_hi')) ocrLang = 'hin+eng';
      else if (fn.includes('ben') || fn.includes('_bn')) ocrLang = 'ben+eng';
      else if (fn.includes('tur') || fn.includes('_tr')) ocrLang = 'tur+eng';
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
        var dataUrl2;
        try {
          // Phase 20F: render inside try/finally so canvas is freed even if
          // pg2.render() or toDataURL() throws (prevents silent canvas leak).
          ctx2.fillStyle = '#ffffff';
          ctx2.fillRect(0, 0, cvs2.width, cvs2.height);
          await pg2.render({ canvasContext: ctx2, viewport: capVp2 }).promise;
          pg2.cleanup();
          dataUrl2 = cvs2.toDataURL('image/jpeg', 0.92);
        } finally {
          safeCanvasCleanup(cvs2); cvs2 = null;
        }

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
    'compress':           ['steps.analyzing_doc',   'steps.optimizing_content',   'steps.applying_improvements', 'steps.preparing_download'],
    'pdf-to-word':        ['steps.analyzing_doc',   'steps.processing_content',   'steps.building_doc',          'steps.preparing_download'],
    'pdf-to-excel':       ['steps.analyzing_doc',   'steps.processing_content',   'steps.building_sheet',        'steps.preparing_download'],
    'pdf-to-powerpoint':  ['steps.analyzing_doc',   'steps.processing_content',   'steps.building_presentation', 'steps.preparing_download'],
    'word-to-pdf':        ['steps.analyzing_doc',   'steps.processing_layout',    'steps.generating_result',     'steps.preparing_download'],
    'excel-to-pdf':       ['steps.analyzing_doc',   'steps.processing_layout',    'steps.generating_result',     'steps.preparing_download'],
    'html-to-pdf':        ['steps.analyzing_doc',   'steps.processing_layout',    'steps.generating_result',     'steps.preparing_download'],
    'ocr':                ['steps.analyzing_doc',   'steps.processing_pages',     'steps.extracting_content',    'steps.preparing_result'],
    'scan-to-pdf':        ['steps.analyzing_images','steps.optimizing_quality',   'steps.creating_doc',          'steps.preparing_download'],
    'background-remover': ['steps.loading_image',   'steps.analyzing_image',      'steps.processing_image',      'steps.saving_result'],
    'repair':             ['steps.analyzing_doc',   'steps.checking_integrity',   'steps.restoring_doc',         'steps.preparing_download'],
    'compare':            ['steps.analyzing_docs',  'steps.processing_content',   'steps.finding_diffs',         'steps.building_report'],
    'ai-summarize':       ['steps.analyzing_doc',   'steps.processing_content',   'steps.generating_summary',    'steps.preparing_result'],
    'translate':          ['steps.analyzing_doc',   'steps.processing_content',   'steps.translating_doc',       'steps.preparing_result'],
    'workflow':           ['steps.analyzing_doc',   'steps.applying_ops',         'steps.processing_steps_tool', 'steps.preparing_download'],
    'merge':              ['steps.loading_docs',    'steps.combining_pages',      'steps.building_result',       'steps.preparing_download'],
    'split':              ['steps.analyzing_doc',   'steps.selecting_pages',      'steps.building_result',       'steps.preparing_download'],
    'rotate':             ['steps.analyzing_doc',   'steps.rotating_pages',       'steps.saving_changes',        'steps.preparing_download'],
    'organize':           ['steps.analyzing_doc',   'steps.reordering_pages',     'steps.building_result',       'steps.preparing_download'],
    'page-numbers':       ['steps.analyzing_doc',   'steps.preparing_layout',     'steps.adding_page_nums',      'steps.preparing_download'],
    'watermark':          ['steps.analyzing_doc',   'steps.preparing_layout',     'steps.applying_watermark',    'steps.preparing_download'],
    'crop':               ['steps.analyzing_doc',   'steps.calculating_crop',     'steps.applying_crop',         'steps.preparing_download'],
    'jpg-to-pdf':         ['steps.loading_images',  'steps.embedding_content',    'steps.building_pdf',          'steps.preparing_download'],
    'protect':            ['steps.analyzing_doc',   'steps.applying_encryption',  'steps.securing_doc',          'steps.preparing_download'],
    'unlock':             ['steps.analyzing_doc',   'steps.removing_protection',  'steps.saving_changes',        'steps.preparing_download'],
    'pdf-to-jpg':         ['steps.analyzing_doc',   'steps.rendering_pages',      'steps.processing_images',     'steps.preparing_download'],
    'crop-image':         ['steps.loading_image',   'steps.analyzing_dims',       'steps.applying_crop',         'steps.preparing_download'],
    'resize-image':       ['steps.loading_image',   'steps.analyzing_dims',       'steps.applying_resize',       'steps.preparing_download'],
    'image-filters':      ['steps.loading_image',   'steps.analyzing_image',      'steps.applying_filters',      'steps.preparing_download'],
    'edit':               ['steps.analyzing_doc',   'steps.processing_layout',    'steps.applying_edits',        'steps.preparing_download'],
    'sign':               ['steps.analyzing_doc',   'steps.processing_sig',       'steps.applying_sig',          'steps.preparing_download'],
    'redact':             ['steps.analyzing_doc',   'steps.locating_content',     'steps.applying_redaction',    'steps.preparing_download'],
    'powerpoint-to-pdf':  ['steps.analyzing_doc',   'steps.processing_slides',    'steps.generating_result',     'steps.preparing_download'],
    'word-to-excel':      ['steps.analyzing_doc',   'steps.extracting_content',   'steps.building_sheet',        'steps.preparing_download'],
  };

  var ADVANCED_IDS = new Set(Object.keys(TOOL_STEPS));

  // ── TOOL PROCESSORS ───────────────────────────────────────────────────────
  var processors = {};

  // ─── COMPRESS (Phase 20D: adaptive quality + large-file defence) ──────────
  processors['compress'] = async function (files, opts, onStep) {
    var file   = files[0];
    var fileMB = file.size / 1048576;
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    // Phase 20D: adaptive compression quality based on file size.
    // Larger files get more aggressive image down-scaling to stay within
    // worker memory limits and to maximise byte savings.
    var compressOpts = Object.assign({}, opts || {});
    if (fileMB > 200) {
      compressOpts._qualityTier = 'aggressive';
      compressOpts._imgScale    = 0.65;
    } else if (fileMB > 80) {
      compressOpts._qualityTier = 'moderate';
      compressOpts._imgScale    = 0.80;
    } else {
      compressOpts._qualityTier = 'standard';
      compressOpts._imgScale    = 1.0;
    }
    DT().log('compress-start', { sizeMB: fileMB.toFixed(1), tier: compressOpts._qualityTier });

    var buf = null;
    try {
      buf = await file.arrayBuffer();
    } catch (memErr) {
      DT().error('compress-load', memErr);
      throw new Error('The file is too large to load into memory. Please try with a smaller file.');
    }
    onStep(0, 'done', 15);
    onStep(1, 'active', 18, 'Optimizing content\u2026');

    // Phase 20F: yield before dispatching to worker so the UI stays responsive
    await yieldToMain(5);

    var resultBuf = null;
    try {
      if (window.WorkerPool) {
        onStep(1, 'done', 25);
        onStep(2, 'active', 30, 'Applying improvements\u2026');
        var wRes = await runPdfWorker('compress', [buf], compressOpts);
        buf = null; // Phase 20F: null immediately (ArrayBuffer may have been transferred)
        if (wRes && wRes.buffer && wRes.buffer.byteLength > 0) {
          resultBuf = wRes.buffer;
        }
      }
    } catch (e) {
      DT().error('compress-worker', e);
    } finally {
      buf = null; // Phase 20F: guaranteed release even if worker threw
    }

    if (!resultBuf || resultBuf.byteLength >= file.size) {
      // PDF is already well-optimised — return the original with a clear message.
      onStep(2, 'done', 85);
      onStep(3, 'active', 90, 'File is already well\u2011optimised\u2026');
      var origBuf = await file.arrayBuffer();
      var origBlob = new Blob([origBuf], { type: 'application/pdf' });
      origBuf = null;
      onStep(3, 'done', 100);
      return { blob: origBlob, filename: brandedFilename(file.name, '.pdf'), alreadyOptimized: true };
    }

    var saved = Math.round((1 - resultBuf.byteLength / file.size) * 100);
    DT().result('compress-done', { savedPct: saved, sizeMB: (resultBuf.byteLength / 1048576).toFixed(1) });
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
    // _forceOcr: set by InputAnalyzer when PDF is detected as scanned.
    // _retryForceOcr: set by smart-retry engine on attempt 2.
    var _shouldForceOcr = !!(opts && (opts._forceOcr || opts._retryForceOcr));
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

    // Phase 20B: Text quality scoring — detect garbled unicode even when char
    // count looks sufficient (broken fonts, PUA encoding, replacement chars).
    var _wSampleText = pages.slice(0, 3).map(function (p) {
      return p.paragraphs.map(function (para) {
        if (para.isTable && para.rows) {
          // Flatten table rows so quality scorer sees actual cell content
          return para.rows.map(function (r) { return r.join(' '); }).join(' ');
        }
        return para.text || '';
      }).join(' ');
    }).join(' ');
    var _wQuality = _scoreTextQuality(_wSampleText.length > 0 ? _wSampleText : '');
    DT().log('pdf-to-word-quality', {
      score: _wQuality.score, issues: _wQuality.issues, needsOcr: _wQuality.needsOcr,
    });

    // Phase 3 + 20B: Auto-OCR trigger — sparse text OR garbled/unreadable content.
    // Also fires when InputAnalyzer flagged scanned PDF (_shouldForceOcr) or when
    // the smart-retry engine requests OCR on attempt 2 (_retryForceOcr).
    if (_shouldForceOcr || !pages.length || _totalWordChars < Math.max(8, total * 2) || _wQuality.needsOcr) {
      DT().log('pdf-to-word-ocr-trigger', { reason: 'sparse_text', chars: _totalWordChars });
      var ocrWPages = await autoOcrFallback(file, onStep, 35, 1);
      var ocrWChars = ocrWPages.reduce(function (s, p) { return s + p.text.length; }, 0);
      DT().log('pdf-to-word-ocr-result', { chars: ocrWChars });
      if (ocrWChars < 10) {
        throw new Error('No readable text could be found. This may be a scanned document with unclear content.');
      }
      // v4.0: OCR path table reconstruction.
      // Instead of naive \n-split (which destroys all tabular structure), we:
      //   (1) Split by newline to get individual text lines.
      //   (2) Try whitespace-column detection (2+ spaces between tokens).
      //       If 2+ columns found, emit as isTable paragraph.
      //   (3) Otherwise apply heading/list detection on the line as before.
      //
      // This mirrors the proven pdf-to-excel OCR path (2+-space whitespace split).
      pages = ocrWPages.map(function (p) {
        var rawLines = p.text.split('\n')
          .map(function (l) { return l.trim(); })
          .filter(Boolean);

        // Table detection pass: group consecutive multi-column lines into table blocks
        var paras = [];
        var tableAccum = [];

        function flushTable() {
          if (tableAccum.length >= 2) {
            paras.push({
              isTable: true,
              isOcrTable: true,
              rows: tableAccum.slice(),
              colCount: tableAccum.reduce(function(m,r){return Math.max(m,r.length);}, 1),
              text: '',
            });
          } else if (tableAccum.length === 1) {
            // Only one row — not a table, emit as normal paragraph
            paras.push({ text: tableAccum[0].join('  '), isHeading: false, isList: false, isNumList: false, level: 0 });
          }
          tableAccum = [];
        }

        rawLines.forEach(function(t) {
          // Normalize checkbox/symbol glyphs
          t = _normalizeSymbols(t);

          // Signature line detection
          if (_isSignatureLine(t)) {
            flushTable();
            paras.push({ text: t, isSignature: true, isHeading: false, isList: false, isNumList: false, level: 0 });
            return;
          }

          // Check for multi-column whitespace split
          var cols = t.split(/\s{2,}/).map(function(c){ return c.trim(); }).filter(Boolean);
          if (cols.length >= 2) {
            tableAccum.push(cols);
          } else {
            flushTable();
            // Single-column line — classify it
            var isFormOcr = _isFormLine(t);
            var isHeading = !isFormOcr && ((t.length >= 3 && t.length <= 90 &&
                             t === t.toUpperCase() && /[A-Z]/.test(t)) ||
                            /^(CHAPTER|SECTION|PART|ARTICLE|APPENDIX)\s+[\d\w]/i.test(t));
            var isNumList = !isHeading && !isFormOcr && /^\s*(?:\d+|[a-zA-Z])[.)]\s+\S/.test(t);
            var isList    = !isHeading && !isNumList && !isFormOcr &&
                            /^\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb]\s/.test(t);
            paras.push({ text: t, isHeading: isHeading, isList: isList, isNumList: isNumList, isForm: isFormOcr, level: isHeading ? 1 : 0 });
          }
        });
        flushTable();

        if (!paras.length) paras = [{ text: '(no content)', isHeading: false }];
        return { pageNum: p.pageNum, paragraphs: paras };
      });
      ocrWPages = null; // release OCR result array — can be large for multi-page docs
    }

    // Phase 2 (v5): content-level validation — ≥2 paragraphs + ≥50 characters
    // v4.0 fix: isTable paragraphs have text:'' — count their cell content too so
    // table-heavy docs (chars=0 from text fields) don't false-fail the chars gate.
    var _wTotalParas = pages.reduce(function (s, p) { return s + p.paragraphs.length; }, 0);
    var _wTotalChars = pages.reduce(function (s, p) {
      return s + p.paragraphs.reduce(function (ps, para) {
        if (para.isTable && para.rows) {
          var tblChars = para.rows.reduce(function (rs, row) {
            return rs + row.reduce(function (cs, cell) { return cs + (cell || '').length; }, 0);
          }, 0);
          return ps + tblChars;
        }
        return ps + (para.text || '').length;
      }, 0);
    }, 0);
    DT().validate('pdf-to-word-content', { paras: _wTotalParas, chars: _wTotalChars });
    // v4.0: Call the proper Tier-2 content gate (was only calling DT().validate before)
    validateContent('pdf-to-word', { paragraphs: _wTotalParas, chars: _wTotalChars });

    onStep(1, 'done', 53);
    onStep(2, 'active', 57, 'Building document\u2026');

    var wResult;
    try {
      wResult = await runAdvancedWorker({ op: 'build-docx', pages: pages });
    } catch (_) {}
    pages = null;
    // If worker failed for any reason, fall back to browser-tools.js pdfToWord
    if (!wResult || !wResult.buffer) throw new Error(ERR.ORIG);

    // Phase 25A: Confidence-based post-DOCX quality gate.
    // Checks content density (chars/page, paras/page) after the document is built.
    // If critically sparse AND OCR was not yet attempted, signals smart-retry engine
    // to re-run with _retryForceOcr=true (attempt 2).
    var _charsPerPage = total > 0 ? _wTotalChars / total : 0;
    var _parasPerPage = total > 0 ? _wTotalParas / total : 0;
    var _postQuality  = 0;
    if (_charsPerPage >= 200) _postQuality += 0.50;
    else if (_charsPerPage >= 60) _postQuality += 0.25;
    else if (_charsPerPage >= 20) _postQuality += 0.10;
    if (_parasPerPage >= 3) _postQuality += 0.30;
    else if (_parasPerPage >= 1) _postQuality += 0.15;
    if (_wQuality && _wQuality.score >= 0.60) _postQuality += 0.20;
    DT().log('pdf-to-word-post-quality', {
      postScore: _postQuality.toFixed(2),
      charsPerPage: Math.round(_charsPerPage),
      parasPerPage: _parasPerPage.toFixed(1),
      ocrUsed: _shouldForceOcr,
    });
    if (_postQuality < 0.20 && !_shouldForceOcr) {
      DT().log('pdf-to-word-retry-signal', { reason: 'low_density', score: _postQuality.toFixed(2) });
      throw new Error('low_quality_output');
    }

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Finalizing output\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    onStep(3, 'done', 100);
    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.docx'),
      _quality: {
        chars:   _wTotalChars,
        paras:   _wTotalParas,
        pages:   total,
        ocrUsed: _shouldForceOcr,
        postScore: _postQuality,
      },
    };
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
        ocrEPages = null;
        throw new Error('No data could be extracted from this PDF. For scanned documents, try the OCR tool first.');
      }
      sheets = ocrEPages.map(function (p) {
        // Bug fix: use 2+-space whitespace split to reconstruct table columns from OCR text.
        // Plain \n→[l] single-column mapping destroys all tabular structure (invoices, statements).
        var rows = p.text.split('\n')
          .map(function (l) { return l.trim(); })
          .filter(Boolean)
          .map(function (l) {
            var cols = l.split(/\s{2,}/).map(function (c) { return c.trim(); }).filter(Boolean);
            return cols.length >= 2 ? cols : [l];
          });
        return { name: 'Page ' + p.pageNum, rows: rows.length ? rows : [['(empty)']] };
      });
      ocrEPages = null; // release OCR result array — can be large for multi-page docs
    }

    // Phase 21: Garbled-font quality check — trigger OCR if extracted text is garbled
    if (!_allSheetsEmpty) {
      var _excelRawText = sheets.map(function (s) {
        return s.rows.map(function (r) { return r.join(' '); }).join(' ');
      }).join(' ');
      var _excelScore = (typeof _scoreTextQuality === 'function') ? _scoreTextQuality(_excelRawText) : 1;
      DT().log('pdf-to-excel-quality', { score: _excelScore, chars: _excelRawText.length });
      if (_excelScore < 0.35 && _excelRawText.length > 10) {
        DT().log('pdf-to-excel-ocr-trigger', { reason: 'garbled_text', score: _excelScore });
        var ocrEGPages = await autoOcrFallback(file, onStep, 35, 1);
        var ocrEGChars = ocrEGPages.reduce(function (s, p) { return s + p.text.length; }, 0);
        DT().log('pdf-to-excel-garbled-ocr', { chars: ocrEGChars });
        if (ocrEGChars >= 5) {
          sheets = ocrEGPages.map(function (p) {
            // Bug fix: same whitespace-split column reconstruction as the all-empty OCR path.
            var rows = p.text.split('\n')
              .map(function (l) { return l.trim(); })
              .filter(Boolean)
              .map(function (l) {
                var cols = l.split(/\s{2,}/).map(function (c) { return c.trim(); }).filter(Boolean);
                return cols.length >= 2 ? cols : [l];
              });
            return { name: 'Page ' + p.pageNum, rows: rows.length ? rows : [['(empty)']] };
          });
        }
        ocrEGPages = null; // release OCR result array
      }
      _excelRawText = null;
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
    // Bug fix: validateContent() was never called — only DT().validate() (a log) ran, bypassing the gate.
    validateContent('pdf-to-excel', { rows: _xRealRows, cols: _xMaxCols });

    onStep(1, 'done', 55);
    onStep(2, 'active', 58, 'Building spreadsheet\u2026');

    var wResult;
    try {
      wResult = await runAdvancedWorker({ op: 'build-xlsx', sheets: sheets });
    } catch (xlsxWorkerErr) {
      // Bug fix: log the worker failure for DebugTrace visibility before falling through to ERR.ORIG
      DT().error('build-xlsx-worker-fail', { err: String(xlsxWorkerErr).slice(0, 120) });
    }
    sheets = null;
    if (!wResult || !wResult.buffer) throw new Error(ERR.ORIG);

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Finalizing output\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    onStep(3, 'done', 100);
    // Bug fix: attach _quality metadata so analyzeResultQuality (dispatch loop) has structural data
    // to produce a meaningful hybrid score — not just blob-size-only scoring.
    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.xlsx'),
      _quality: { rows: _xRealRows, chars: _xRealRows * 10, pages: total },
    };
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
        ocrPPages = null;
        throw new Error('No content could be extracted from this PDF. Please check the file and try again.');
      }
      slides = ocrPPages.map(function (p) {
        var lines = p.text.split('\n').filter(function (l) { return l.trim(); });
        return { pageNum: p.pageNum, title: (lines[0] || 'Slide ' + p.pageNum).slice(0, 120), text: lines.slice(1).join('\n') };
      });
      ocrPPages = null; // release OCR result array — can be large for multi-page docs
    }

    // Phase 21: Garbled-font quality check — trigger OCR if extracted slide text is garbled
    if (!_allSlidesEmpty) {
      var _pptxRawText = slides.map(function (s) {
        return (s.title || '') + ' ' + (s.text || '');
      }).join(' ');
      var _pptxScore = (typeof _scoreTextQuality === 'function') ? _scoreTextQuality(_pptxRawText) : 1;
      DT().log('pdf-to-pptx-quality', { score: _pptxScore, chars: _pptxRawText.length });
      if (_pptxScore < 0.35 && _pptxRawText.length > 10) {
        DT().log('pdf-to-pptx-ocr-trigger', { reason: 'garbled_text', score: _pptxScore });
        var ocrPGPages = await autoOcrFallback(file, onStep, 35, 1);
        var ocrPGChars = ocrPGPages.reduce(function (s, p) { return s + p.text.length; }, 0);
        DT().log('pdf-to-pptx-garbled-ocr', { chars: ocrPGChars });
        if (ocrPGChars >= 10) {
          slides = ocrPGPages.map(function (p) {
            var lines = p.text.split('\n').filter(function (l) { return l.trim(); });
            return {
              pageNum: p.pageNum,
              title:   (lines[0] || 'Slide ' + p.pageNum).slice(0, 120),
              text:    lines.slice(1).join('\n'),
            };
          });
        }
        ocrPGPages = null; // release OCR result array
      }
      _pptxRawText = null;
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

    // Content-level validation gate — ensures we have at least 1 real slide with text.
    // validateContent has a pdf-to-powerpoint branch; this call activates it.
    var _pptxTotalChars = slides.reduce(function (s, sl) {
      return s + (sl.title || '').length + (sl.text || '').length;
    }, 0);
    DT().validate('pdf-to-pptx-content', { slides: slides.length, chars: _pptxTotalChars });
    validateContent('pdf-to-powerpoint', { slides: slides.length, chars: _pptxTotalChars });

    onStep(1, 'done', 55);
    onStep(2, 'active', 58, 'Building presentation\u2026');

    var docTitle      = file.name.replace(/\.[^.]+$/, '');
    var _pptxSlideCount = slides.length; // capture before slides=null
    var wResult;
    try {
      wResult = await runAdvancedWorker({ op: 'build-pptx', slides: slides, docTitle: docTitle });
    } catch (pptxWorkerErr) {
      // Bug fix: log worker failure for DebugTrace visibility before falling through to ERR.ORIG
      DT().error('build-pptx-worker-fail', { err: String(pptxWorkerErr).slice(0, 120) });
    }
    slides = null;
    if (!wResult || !wResult.buffer) throw new Error(ERR.ORIG);

    onStep(2, 'done', 90);
    onStep(3, 'active', 93, 'Finalizing output\u2026');
    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    onStep(3, 'done', 100);
    // Bug fix: attach _quality so analyzeResultQuality has structural data (slides + chars),
    // not just blob size for scoring. _pptxSlideCount captured before slides=null.
    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.pptx'),
      _quality: { chars: _pptxTotalChars, paras: _pptxSlideCount, pages: total },
    };
  };

  // ─── WORD TO PDF — Real Enterprise Pipeline v1.0 ──────────────────────────
  //
  // Architecture:
  //   Phase 0  (5-15%)  : Load mammoth.js + pdf-lib (IDB-cached CDN)
  //                        ArrayBuffer allocated → mammoth parses → ab null'd immediately
  //   Phase 1  (15-35%) : DOMParser walks mammoth HTML → flat typed element list extracted
  //                        Handles: h1-h6, p, ul, ol, table, blockquote, hr, pre, img
  //                        DOM tree released after extraction
  //   Phase 2  (35-85%) : pdf-lib direct rendering — NO html2canvas, NO jsPDF
  //                        Elements rendered in PERF_MODE-adaptive ELEMENT_CHUNK batches
  //                        yieldToMain() every chunk; memTier() abort guard per chunk
  //                        Inline bold/italic via segment extractor + word-layout engine
  //                        Text wrapping via font.widthOfTextAtSize() per-word measurement
  //                        Tables: auto-sizing grid; Images: base64 embed with 2MB cap
  //   Phase 3  (85-100%): doc.save() → blob; validateContent; DT() result
  //
  // Improvements over BrowserTools wordToPdf() fallback:
  //   • No html2canvas — eliminates per-document giant canvas OOM
  //   • No jsPDF — pdf-lib renders directly (consistent with rest of pipeline)
  //   • ArrayBuffer null'd immediately after mammoth.convertToHtml()
  //   • DOM released after element-list extraction (element objects null'd after render)
  //   • ELEMENT_CHUNK batches + yieldToMain() — browser stays responsive
  //   • memTier() abort per chunk → partial PDF returned (partial > crash)
  //   • Full DT() DebugTrace throughout all phases
  //   • _quality: {chars, paras, pages, images, tables} for analyzeResultQuality
  //   • validateContent('word-to-pdf') branch now active
  //   • 50MB BrowserTools size ceiling bypassed (AdvancedEngine handles up to 500MB)
  //   • Inline bold/italic/boldItalic preserved via recursive childNode walker
  //   • BrowserTools fallback PRESERVED — fires only on library load failure
  //
  processors['word-to-pdf'] = async function (f, o, s) {
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');

    var fileSizeMB = (file.size / 1048576).toFixed(1);
    DT().log('word-to-pdf-start', { sizeMB: fileSizeMB });

    // ── Phase 0: load libraries ──────────────────────────────────────────────
    s(0, 'active', 5, 'Loading engine\u2026');

    await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js');
    if (!window.mammoth) throw new Error('Document parser unavailable. Check your connection and try again.');

    await loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
    if (!window.PDFLib) throw new Error('PDF engine unavailable. Check your connection and try again.');

    DT().log('word-to-pdf-libs-ready', {});

    // ── Phase 0b: DOCX → HTML via mammoth ───────────────────────────────────
    s(0, 'active', 10, 'Parsing document\u2026');

    var ab = await file.arrayBuffer();
    var mammothResult;
    try {
      mammothResult = await window.mammoth.convertToHtml({ arrayBuffer: ab });
    } finally {
      ab = null; // release ArrayBuffer immediately — mammoth holds internal copy
    }

    var htmlContent = (mammothResult && mammothResult.value) || '';
    mammothResult = null;

    if (!htmlContent.trim()) {
      throw new Error('Could not extract content from this Word document. The file may be empty or in an unsupported format.');
    }

    DT().log('word-to-pdf-html-ready', { htmlLen: htmlContent.length });

    // ── Phase 1: HTML → typed element list ──────────────────────────────────
    s(1, 'active', 15, 'Analyzing document structure\u2026');

    var parser  = new DOMParser();
    var htmlDoc = parser.parseFromString('<div id="wr">' + htmlContent + '</div>', 'text/html');
    htmlContent = null;

    var rootEl   = htmlDoc.getElementById('wr') || htmlDoc.body;
    var children = rootEl ? Array.from(rootEl.children) : [];

    // Recursive inline-style segment extractor
    // Returns [{text, bold, italic}] from mixed HTML (strong/b/em/i)
    function _segs(el) {
      var out = [];
      function _walk(node, b, it) {
        if (node.nodeType === 3) {
          var t = node.textContent || '';
          if (t) out.push({ text: t, bold: b, italic: it });
        } else if (node.nodeType === 1) {
          var tag = (node.tagName || '').toLowerCase();
          var nb  = b  || tag === 'strong' || tag === 'b';
          var ni  = it || tag === 'em'     || tag === 'i';
          var ch  = node.childNodes;
          for (var ci = 0; ci < ch.length; ci++) _walk(ch[ci], nb, ni);
        }
      }
      var ch2 = el.childNodes;
      for (var i2 = 0; i2 < ch2.length; i2++) _walk(ch2[i2], false, false);
      return out;
    }

    // Extract a table node → {type, rows, maxCols}
    function _tableEl(node) {
      var rows    = [];
      var maxCols = 0;
      var trs     = node.querySelectorAll('tr');
      for (var r = 0; r < trs.length; r++) {
        var tds = trs[r].querySelectorAll('th, td');
        var row = [];
        for (var d = 0; d < tds.length; d++) {
          row.push({
            text:   (tds[d].textContent || '').trim().slice(0, 500),
            isHead: (tds[d].tagName || '').toLowerCase() === 'th',
          });
        }
        if (row.length > maxCols) maxCols = row.length;
        rows.push(row);
      }
      return { type: 'table', rows: rows, maxCols: maxCols };
    }

    var elements = [];
    for (var ei = 0; ei < children.length; ei++) {
      var ch = children[ei];
      var tag = (ch.tagName || '').toLowerCase();

      if (/^h[1-6]$/.test(tag)) {
        var lvl = parseInt(tag[1], 10);
        elements.push({ type: 'heading', level: lvl, segments: _segs(ch), text: (ch.textContent || '').trim() });

      } else if (tag === 'p') {
        var pText = (ch.textContent || '').trim();
        if (pText) elements.push({ type: 'para', segments: _segs(ch), text: pText });

      } else if (tag === 'ul') {
        var ulis = ch.querySelectorAll('li');
        for (var uli = 0; uli < ulis.length; uli++) {
          var liText = (ulis[uli].textContent || '').trim();
          if (liText) elements.push({ type: 'listitem', listType: 'ul', index: uli + 1, text: liText });
        }

      } else if (tag === 'ol') {
        var olis = ch.querySelectorAll('li');
        for (var oli = 0; oli < olis.length; oli++) {
          var oliText = (olis[oli].textContent || '').trim();
          if (oliText) elements.push({ type: 'listitem', listType: 'ol', index: oli + 1, text: oliText });
        }

      } else if (tag === 'table') {
        elements.push(_tableEl(ch));

      } else if (tag === 'blockquote') {
        var bqText = (ch.textContent || '').trim();
        if (bqText) elements.push({ type: 'blockquote', text: bqText });

      } else if (tag === 'hr') {
        elements.push({ type: 'hr' });

      } else if (tag === 'pre') {
        var preText = (ch.textContent || '').trim();
        if (preText) elements.push({ type: 'pre', text: preText });

      } else if (tag === 'img') {
        var imgSrc = ch.getAttribute('src') || '';
        if (imgSrc && imgSrc.startsWith('data:image')) elements.push({ type: 'image', src: imgSrc });

      } else {
        var gText = (ch.textContent || '').trim();
        if (gText) elements.push({ type: 'para', segments: [{ text: gText, bold: false, italic: false }], text: gText });
      }
    }

    // Release DOM and children array
    rootEl = null; children = null; htmlDoc = null;

    var totalElements = elements.length;
    DT().log('word-to-pdf-elements', { count: totalElements });

    if (totalElements === 0) {
      throw new Error('No content could be extracted from this document.');
    }

    s(1, 'done', 35);

    // ── Phase 2: pdf-lib direct rendering ───────────────────────────────────
    s(2, 'active', 37, 'Building PDF\u2026');

    // Page geometry
    var pageSizeKey  = String((o && o.pageSize) || 'A4');
    var marginKey    = String((o && o.margins)   || 'normal');
    var PAGE_SIZES   = { A4: [595, 842], Letter: [612, 792], A3: [842, 1191] };
    var MARGIN_SIZES = { none: 20, narrow: 30, normal: 40, wide: 55 };
    var psSrc        = PAGE_SIZES[pageSizeKey]  || PAGE_SIZES.A4;
    var marginPt     = MARGIN_SIZES[marginKey]  || MARGIN_SIZES.normal;
    var PW           = psSrc[0];
    var PH           = psSrc[1];
    var usableW      = PW - marginPt * 2;

    var PDFLib         = window.PDFLib;
    var _PDFDocument   = PDFLib.PDFDocument;
    var _StandardFonts = PDFLib.StandardFonts;
    var _rgb           = PDFLib.rgb;

    var doc       = await _PDFDocument.create();
    var fontReg   = await doc.embedFont(_StandardFonts.Helvetica);
    var fontBold  = await doc.embedFont(_StandardFonts.HelveticaBold);
    var fontItal  = await doc.embedFont(_StandardFonts.HelveticaOblique);
    var fontBoldI = await doc.embedFont(_StandardFonts.HelveticaBoldOblique);

    // Typography constants
    var BODY_FS      = 11;
    var CODE_FS      = 9;
    var LINE_HF      = 1.55;
    var PARA_GAP     = 6;
    var HEAD_PRE     = 10;
    var HEAD_POST    = 5;
    var INDENT       = 18;
    var MAX_IMG_B64  = 2 * 1024 * 1024; // 2MB base64 limit; larger → placeholder
    var IMG_MAX_H    = 300;
    var HEADING_FS   = [null, 22, 17, 14, 12, 11, 11]; // h1-h6

    // PERF_MODE-adaptive chunk size — same pattern as excel-to-pdf
    var ELEMENT_CHUNK = (PERF_MODE === 'high') ? 80 : (PERF_MODE === 'medium') ? 40 : 15;

    // Quality counters
    var pagesDone  = 0;
    var charTotal  = 0;
    var paraCount  = 0;
    var imgCount   = 0;
    var tableCount = 0;

    // ── Text layout engine ───────────────────────────────────────────────────
    // Lay out segments into lines; each line = [{text, bold, italic, w}]
    function _layoutSegs(segments, fontSize, maxW) {
      var words  = [];
      var SPAW   = fontReg.widthOfTextAtSize(' ', fontSize);
      for (var si = 0; si < segments.length; si++) {
        var sg   = segments[si];
        var parts = (sg.text || '').replace(/\s+/g, ' ').split(' ');
        for (var pi = 0; pi < parts.length; pi++) {
          if (parts[pi]) words.push({ text: parts[pi], bold: sg.bold, italic: sg.italic });
        }
      }
      if (!words.length) return [];
      var lines   = [];
      var curLine = [];
      var lineW   = 0;
      for (var wi = 0; wi < words.length; wi++) {
        var wd = words[wi];
        var fnt = wd.bold ? (wd.italic ? fontBoldI : fontBold) : (wd.italic ? fontItal : fontReg);
        var wW; try { wW = fnt.widthOfTextAtSize(wd.text, fontSize); } catch (_) { wW = wd.text.length * fontSize * 0.55; }
        var gap = curLine.length > 0 ? SPAW : 0;
        if (lineW + gap + wW > maxW && curLine.length > 0) {
          lines.push(curLine);
          curLine = [{ text: wd.text, bold: wd.bold, italic: wd.italic, w: wW }];
          lineW   = wW;
        } else {
          if (curLine.length > 0) lineW += SPAW;
          curLine.push({ text: wd.text, bold: wd.bold, italic: wd.italic, w: wW });
          lineW += wW;
        }
      }
      if (curLine.length) lines.push(curLine);
      return lines;
    }

    // Wrap plain text (no inline styles) into string-array lines
    function _wrapText(text, fnt, fontSize, maxW) {
      var ws  = (text || '').replace(/\s+/g, ' ').trim().split(' ');
      if (!ws.length || !ws[0]) return [];
      var lines = []; var cur = '';
      for (var i = 0; i < ws.length; i++) {
        var tryStr = cur ? cur + ' ' + ws[i] : ws[i];
        var w; try { w = fnt.widthOfTextAtSize(tryStr, fontSize); } catch (_) { w = tryStr.length * fontSize * 0.55; }
        if (w > maxW && cur) { lines.push(cur); cur = ws[i]; }
        else cur = tryStr;
      }
      if (cur) lines.push(cur);
      return lines;
    }

    // Draw one laid-out segment line at (x0, y)
    function _drawSegLine(pg, line, x0, y, fontSize, clr) {
      var x    = x0;
      var SPAW = fontReg.widthOfTextAtSize(' ', fontSize);
      for (var i = 0; i < line.length; i++) {
        if (i > 0) x += SPAW;
        var item = line[i];
        var fnt  = item.bold ? (item.italic ? fontBoldI : fontBold) : (item.italic ? fontItal : fontReg);
        try { pg.drawText(item.text, { x: x, y: y, size: fontSize, font: fnt, color: clr }); } catch (_) {}
        x += item.w || 0;
      }
    }

    // ── Page management ──────────────────────────────────────────────────────
    var page = doc.addPage([PW, PH]);
    pagesDone++;
    var y = PH - marginPt;

    function _ensureSpace(needed) {
      if (y - needed < marginPt) {
        page = doc.addPage([PW, PH]);
        pagesDone++;
        y = PH - marginPt;
      }
    }

    // ── Element renderer ─────────────────────────────────────────────────────
    async function _renderElement(el) {
      if (!el) return;

      // ── HEADING ────────────────────────────────────────────────────────────
      if (el.type === 'heading') {
        var hFS   = HEADING_FS[el.level] || BODY_FS;
        var hLH   = hFS * LINE_HF;
        var hSegs = (el.segments && el.segments.length) ? el.segments : [{ text: el.text, bold: true, italic: false }];
        var hLines = _layoutSegs(hSegs, hFS, usableW);
        if (!hLines.length) return;
        _ensureSpace(hLH * hLines.length + HEAD_PRE + HEAD_POST + 4);
        y -= HEAD_PRE;
        var hClr = el.level <= 2 ? _rgb(0.10, 0.12, 0.42)
                 : el.level === 3 ? _rgb(0.18, 0.20, 0.36)
                 : _rgb(0.20, 0.20, 0.22);
        for (var hl = 0; hl < hLines.length; hl++) {
          _ensureSpace(hLH + HEAD_POST);
          _drawSegLine(page, hLines[hl], marginPt, y - hLH + 3, hFS, hClr);
          y -= hLH;
        }
        // Decorative rule under h1/h2
        if (el.level <= 2) {
          try {
            page.drawLine({
              start: { x: marginPt, y: y - 2 },
              end:   { x: marginPt + usableW, y: y - 2 },
              thickness: el.level === 1 ? 1.5 : 0.8,
              color: _rgb(0.72, 0.76, 0.90),
            });
          } catch (_) {}
          y -= 4;
        }
        y -= HEAD_POST;
        paraCount++;
        charTotal += el.text.length;

      // ── PARAGRAPH ──────────────────────────────────────────────────────────
      } else if (el.type === 'para') {
        var pFS    = BODY_FS;
        var pLH    = pFS * LINE_HF;
        var pLines = _layoutSegs(el.segments || [{ text: el.text, bold: false, italic: false }], pFS, usableW);
        for (var pl = 0; pl < pLines.length; pl++) {
          _ensureSpace(pLH);
          _drawSegLine(page, pLines[pl], marginPt, y - pLH + 3, pFS, _rgb(0.02, 0.02, 0.02));
          y -= pLH;
        }
        y -= PARA_GAP;
        paraCount++;
        charTotal += el.text.length;

      // ── LIST ITEM ──────────────────────────────────────────────────────────
      } else if (el.type === 'listitem') {
        var lFS   = BODY_FS;
        var lLH   = lFS * LINE_HF;
        var pfx   = el.listType === 'ol' ? (el.index + '.') : '\u2022';
        var lLines = _wrapText(el.text, fontReg, lFS, usableW - INDENT);
        if (!lLines.length) return;
        for (var ll = 0; ll < lLines.length; ll++) {
          _ensureSpace(lLH);
          if (ll === 0) {
            try { page.drawText(pfx, { x: marginPt, y: y - lLH + 3, size: lFS, font: fontBold, color: _rgb(0.28, 0.30, 0.62) }); } catch (_) {}
          }
          try { page.drawText(lLines[ll], { x: marginPt + INDENT, y: y - lLH + 3, size: lFS, font: fontReg, color: _rgb(0.02, 0.02, 0.02) }); } catch (_) {}
          y -= lLH;
        }
        y -= 2;
        charTotal += el.text.length;

      // ── TABLE ──────────────────────────────────────────────────────────────
      } else if (el.type === 'table') {
        if (!el.rows || !el.rows.length) return;
        tableCount++;
        var tCols = Math.max(1, el.maxCols);
        var tFS   = Math.max(7, Math.min(10, Math.floor(usableW / tCols / 8)));
        var tLH   = tFS * LINE_HF + 5;
        var colW  = usableW / tCols;
        _ensureSpace(tLH + 6);
        y -= 4;
        for (var tr = 0; tr < el.rows.length; tr++) {
          _ensureSpace(tLH);
          var row   = el.rows[tr];
          var isHdr = tr === 0 || !!(row[0] && row[0].isHead);
          if (isHdr) {
            try { page.drawRectangle({ x: marginPt, y: y - tLH + 1, width: usableW, height: tLH, color: _rgb(0.91, 0.93, 0.97) }); } catch (_) {}
          }
          var cx = marginPt;
          for (var td = 0; td < tCols; td++) {
            var cell  = row[td] || { text: '', isHead: false };
            var cFont = (isHdr || cell.isHead) ? fontBold : fontReg;
            var maxC  = Math.max(1, Math.floor(colW / (tFS * 0.62)));
            var disp  = cell.text.length > maxC ? cell.text.slice(0, maxC - 1) + '\u2026' : cell.text;
            if (disp) {
              try { page.drawText(disp, { x: cx + 3, y: y - tLH + 6, size: tFS, font: cFont, color: _rgb(0.02, 0.02, 0.02) }); } catch (_) {}
            }
            try { page.drawRectangle({ x: cx, y: y - tLH + 1, width: colW, height: tLH, borderColor: _rgb(0.74, 0.76, 0.80), borderWidth: 0.4 }); } catch (_) {}
            charTotal += cell.text.length;
            cx += colW;
          }
          y -= tLH;
        }
        y -= 4;

      // ── BLOCKQUOTE ─────────────────────────────────────────────────────────
      } else if (el.type === 'blockquote') {
        var bqFS    = BODY_FS;
        var bqLH    = bqFS * LINE_HF;
        var bqLines = _wrapText(el.text, fontItal, bqFS, usableW - INDENT - 6);
        if (!bqLines.length) return;
        _ensureSpace(bqLH * bqLines.length + 4);
        try {
          page.drawRectangle({ x: marginPt, y: y - bqLH * bqLines.length - 2, width: 3, height: bqLH * bqLines.length + 2, color: _rgb(0.58, 0.65, 0.82) });
        } catch (_) {}
        for (var bql = 0; bql < bqLines.length; bql++) {
          _ensureSpace(bqLH);
          try { page.drawText(bqLines[bql], { x: marginPt + INDENT, y: y - bqLH + 3, size: bqFS, font: fontItal, color: _rgb(0.28, 0.30, 0.30) }); } catch (_) {}
          y -= bqLH;
        }
        y -= PARA_GAP;
        charTotal += el.text.length;

      // ── HORIZONTAL RULE ────────────────────────────────────────────────────
      } else if (el.type === 'hr') {
        _ensureSpace(14);
        try { page.drawLine({ start: { x: marginPt, y: y - 7 }, end: { x: marginPt + usableW, y: y - 7 }, thickness: 0.5, color: _rgb(0.78, 0.78, 0.82) }); } catch (_) {}
        y -= 14;

      // ── PRE / CODE BLOCK ───────────────────────────────────────────────────
      } else if (el.type === 'pre') {
        var cFS    = CODE_FS;
        var cLH    = cFS * LINE_HF;
        var cLines = (el.text || '').split('\n').slice(0, 200); // cap at 200 lines
        _ensureSpace(cLH + 8);
        y -= 4;
        try { page.drawRectangle({ x: marginPt, y: y - cLH * cLines.length - 4, width: usableW, height: cLH * cLines.length + 8, color: _rgb(0.95, 0.96, 0.97) }); } catch (_) {}
        for (var crl = 0; crl < cLines.length; crl++) {
          _ensureSpace(cLH);
          var cLineText = cLines[crl].slice(0, 160);
          if (cLineText) {
            try { page.drawText(cLineText, { x: marginPt + 5, y: y - cLH + 3, size: cFS, font: fontReg, color: _rgb(0.12, 0.20, 0.14) }); } catch (_) {}
          }
          y -= cLH;
          charTotal += cLines[crl].length;
        }
        y -= PARA_GAP;

      // ── IMAGE ──────────────────────────────────────────────────────────────
      } else if (el.type === 'image') {
        imgCount++;
        var b64Str = (el.src || '').split(',')[1] || '';
        // Skip images with base64 payload > 2MB decoded to avoid OOM
        if (!b64Str || b64Str.length > MAX_IMG_B64 * 1.37) {
          _ensureSpace(20);
          try { page.drawText('[Image \u2014 too large to embed]', { x: marginPt, y: y - 14, size: 9, font: fontItal, color: _rgb(0.50, 0.50, 0.55) }); } catch (_) {}
          y -= 22;
          return;
        }
        try {
          var imgBytes = Uint8Array.from(atob(b64Str), function (c) { return c.charCodeAt(0); });
          var isPng    = (el.src || '').startsWith('data:image/png');
          var embImg   = isPng ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
          imgBytes     = null;
          var dims     = embImg.scale(1);
          var iW       = Math.min(dims.width, usableW);
          var iH       = (iW / dims.width) * dims.height;
          if (iH > IMG_MAX_H) { var sc = IMG_MAX_H / iH; iW *= sc; iH = IMG_MAX_H; }
          _ensureSpace(iH + 10);
          try { page.drawImage(embImg, { x: marginPt, y: y - iH, width: iW, height: iH }); } catch (_) {}
          y -= iH + 10;
        } catch (_imgErr) {
          _ensureSpace(20);
          try { page.drawText('[Image \u2014 could not embed]', { x: marginPt, y: y - 14, size: 9, font: fontItal, color: _rgb(0.50, 0.50, 0.55) }); } catch (_) {}
          y -= 22;
        }
      }
    }

    // ── Chunked element rendering with yield + memTier guard ─────────────────
    for (var ei2 = 0; ei2 < elements.length; ei2++) {
      if (memTier() === 'fallback') {
        DT().error('word-to-pdf-mem-abort', { ei: ei2, pagesDone: pagesDone });
        break; // return partial PDF — partial is better than crash
      }

      await _renderElement(elements[ei2]);
      elements[ei2] = null; // release after render

      if ((ei2 + 1) % ELEMENT_CHUNK === 0) {
        var renderPct = 37 + Math.round(((ei2 + 1) / totalElements) * 47);
        s(2, 'active', Math.min(renderPct, 83), 'Rendering\u2026 ' + (ei2 + 1) + '/' + totalElements + ' elements');
        await yieldToMain(10);
        if (memTier() === 'fallback') {
          DT().error('word-to-pdf-chunk-abort', { ei: ei2, pagesDone: pagesDone });
          break;
        }
      }
    }

    safeArrayNull(elements); elements = null;
    s(2, 'done', 85);

    // ── Phase 3: finalize ────────────────────────────────────────────────────
    s(3, 'active', 88, 'Finalizing PDF\u2026');

    var pdfBytes = await doc.save();
    doc = null;

    var blob = new Blob([pdfBytes], { type: 'application/pdf' });
    pdfBytes = null;

    if (blob.size < 500) {
      throw new Error('PDF generation produced an empty result. Please try with a different file.');
    }

    // Content-level quality gate
    validateContent('word-to-pdf', { paragraphs: paraCount, chars: charTotal });

    DT().validate('word-to-pdf-quality', {
      blobSize: blob.size, pagesDone: pagesDone,
      paraCount: paraCount, charTotal: charTotal,
      imgCount: imgCount, tableCount: tableCount,
    });
    DT().result('word-to-pdf-complete', {
      sizeMB: (blob.size / 1048576).toFixed(2),
      pages: pagesDone, paras: paraCount, chars: charTotal,
      images: imgCount, tables: tableCount,
    });

    s(3, 'done', 100);

    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.pdf'),
      _quality: { rows: paraCount, paras: pagesDone, pages: pagesDone, chars: charTotal },
    };
  };
  // ─── EXCEL TO PDF — Real Enterprise Pipeline v1.0 ────────────────────────
  //
  // Architecture:
  //   Phase 0  (5-15%)  : Input validation + XLSX + pdf-lib load (IDB-cached)
  //                        Hidden-sheet detection; workbook metadata
  //   Phase 1  (15-42%) : Per-sheet metadata scan — first 30 rows each;
  //                        column-width estimation, font/scale calc, range decode;
  //                        XLSX range parameter limits row allocation upfront
  //   Phase 2  (42-82%) : Chunked PDF rendering sheet-by-sheet, ROW_CHUNK rows
  //                        per yieldToMain(); memTier abort with partial result;
  //                        continuation headers on overflow pages
  //   Phase 3  (82-100%): Finalize + DT quality validate
  //
  // Improvements over BrowserTools excelToPdf() fallback:
  //   • XLSX range limiting — never allocates >MAX_RENDER_ROWS rows per sheet
  //   • ROW_CHUNK batch yield (PERF_MODE-aware 80/200/500) — browser stays responsive
  //   • rows array null'd immediately after each sheet — no cross-sheet RAM accumulation
  //   • wb null'd after all sheets — workbook released before pdf.save()
  //   • Hidden sheet detection (wb.Workbook.Sheets[i].Hidden)
  //   • memTier() abort: returns partial PDF if device enters 'fallback' tier
  //   • Per-sheet + per-batch progress via onStep()
  //   • Math.max empty-array crash bug fixed (guard against empty rows/cols)
  //   • Continuation page headers for multi-page sheets
  //   • Full DT() DebugTrace + _quality for analyzeResultQuality scoring
  //   • BrowserTools fallback PRESERVED — only fires on genuine library failure
  //
  processors['excel-to-pdf'] = async function (f, o, s) {
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');

    var fileSizeMB = (file.size / 1048576).toFixed(1);
    DT().log('excel-to-pdf-start', {
      sizeMB: fileSizeMB,
      opts:   o ? JSON.stringify(o).slice(0, 200) : '{}',
    });

    // ── Phase 0: load libraries ─────────────────────────────────────────────
    s(0, 'active', 5, 'Loading engine\u2026');

    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    if (!window.XLSX) throw new Error('Spreadsheet parser unavailable. Check your connection and try again.');

    await loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
    if (!window.PDFLib) throw new Error('PDF engine unavailable. Check your connection and try again.');

    var XLSX   = window.XLSX;
    var PDFLib = window.PDFLib;

    // ── Options ─────────────────────────────────────────────────────────────
    var pageSizeKey = String((o && o.pageSize)    || 'A4');
    var marginKey   = String((o && o.margins)     || 'normal');
    var orientOpt   = String((o && o.orientation) || '');
    var scalingOpt  = String((o && o.scaling)     || 'fit-page');

    var PAGE_SIZES   = { A4: [595, 842], Letter: [612, 792], A3: [842, 1191] };
    var MARGIN_SIZES = { none: 10, narrow: 25, normal: 40, wide: 55 };

    var psSrc    = PAGE_SIZES[pageSizeKey] || PAGE_SIZES.A4;
    var marginPt = MARGIN_SIZES[marginKey] || MARGIN_SIZES.normal;

    // Safety caps
    var MAX_RENDER_ROWS = 50000;
    var MAX_SCAN_ROWS   = 30;
    var MAX_SCAN_COLS   = 120;

    // ── Phase 0: parse workbook ──────────────────────────────────────────────
    s(0, 'active', 10, 'Parsing spreadsheet\u2026');

    var ab = await file.arrayBuffer();
    var wb;
    try {
      wb = XLSX.read(ab, { type: 'array' });
    } finally {
      ab = null;
    }

    if (!wb.SheetNames || !wb.SheetNames.length) {
      throw new Error('No sheets found. Please check this is a valid .xlsx/.xls/.csv file.');
    }

    // Hidden-sheet detection (wb.Workbook.Sheets[i].Hidden: 0=visible,1=hidden,2=very hidden)
    var sheetInfos = wb.SheetNames.map(function (name, idx) {
      var hidden = false;
      if (wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[idx]) {
        var h = wb.Workbook.Sheets[idx].Hidden;
        hidden = (h === 1 || h === 2);
      }
      return { name: name, idx: idx, hidden: hidden };
    }).filter(function (info) { return !info.hidden; });

    // If all sheets were hidden, fall back to rendering all of them
    if (!sheetInfos.length) {
      sheetInfos = wb.SheetNames.map(function (name, idx) {
        return { name: name, idx: idx, hidden: false };
      });
    }

    var totalSheets = sheetInfos.length;
    var hiddenCount = wb.SheetNames.length - totalSheets;
    DT().log('excel-to-pdf-sheets', {
      total: wb.SheetNames.length, active: totalSheets, hidden: hiddenCount,
    });
    s(0, 'done', 15);

    // ── Phase 1: per-sheet metadata scan ────────────────────────────────────
    s(1, 'active', 16, 'Analyzing sheets\u2026');

    // Auto-detect orientation from first sheet column count
    var firstWs  = wb.Sheets[sheetInfos[0].name];
    var firstRef = firstWs['!ref'];
    var firstRng = firstRef ? XLSX.utils.decode_range(firstRef) : null;
    var firstCols = firstRng ? (firstRng.e.c - firstRng.s.c + 1) : 1;
    var orient    = orientOpt || (firstCols > 6 ? 'landscape' : 'portrait');
    var PW        = orient === 'landscape' ? psSrc[1] : psSrc[0];
    var PH        = orient === 'landscape' ? psSrc[0] : psSrc[1];
    var usableW   = PW - marginPt * 2;
    var usableH   = PH - marginPt * 2;

    var sheetMeta = [];

    for (var mi = 0; mi < totalSheets; mi++) {
      var mInfo  = sheetInfos[mi];
      var ws     = wb.Sheets[mInfo.name];
      var wsRef  = ws['!ref'];
      var wsRng  = wsRef ? XLSX.utils.decode_range(wsRef) : null;

      if (!wsRng) {
        sheetMeta.push(null);
        if ((mi + 1) % 10 === 0) await yieldToMain(2);
        continue;
      }

      var sheetTotalRows = wsRng.e.r - wsRng.s.r + 1;
      var sheetTotalCols = wsRng.e.c - wsRng.s.c + 1;
      var cappedRows     = Math.min(sheetTotalRows, MAX_RENDER_ROWS);
      var wasCapped      = sheetTotalRows > MAX_RENDER_ROWS;

      // Scan first MAX_SCAN_ROWS rows for column-width estimation
      var scanEndRow  = Math.min(wsRng.e.r, wsRng.s.r + MAX_SCAN_ROWS - 1);
      var scanEndCol  = Math.min(wsRng.e.c, wsRng.s.c + MAX_SCAN_COLS - 1);
      var scanRange   = { s: { r: wsRng.s.r, c: wsRng.s.c }, e: { r: scanEndRow, c: scanEndCol } };
      var sample      = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', range: scanRange });
      var numCols     = sample.length
        ? Math.max.apply(null, sample.map(function (r) { return r.length || 0; }).concat([1]))
        : Math.max(1, sheetTotalCols);

      var fontSize = Math.max(6, Math.min(10, Math.floor(usableW / numCols / 6)));

      var colMaxW = [];
      for (var ci = 0; ci < numCols; ci++) {
        var maxLen = 3;
        for (var ri = 0; ri < sample.length; ri++) {
          var cv = sample[ri][ci];
          var cl = (cv !== undefined && cv !== null) ? String(cv).length : 0;
          if (cl > maxLen) maxLen = cl;
        }
        colMaxW.push(Math.min(maxLen * (fontSize * 0.6), 200));
      }
      sample = null;

      var rawTotal       = colMaxW.reduce(function (acc, w) { return acc + w; }, 0) || usableW;
      var scale          = (rawTotal > usableW && scalingOpt !== 'actual') ? usableW / rawTotal : 1;
      var colWidths      = colMaxW.map(function (w) { return w * scale; });
      var actualFontSize = Math.max(6, fontSize * scale);
      var actualLineH    = actualFontSize * 1.8;
      var titleRows      = 2; // header label + gap
      var rowsPerPage    = Math.max(1, Math.floor((usableH - actualLineH * titleRows) / actualLineH));

      sheetMeta.push({
        name:           mInfo.name,
        wsRng:          wsRng,
        totalRows:      cappedRows,
        wasCapped:      wasCapped,
        numCols:        numCols,
        colWidths:      colWidths,
        actualFontSize: actualFontSize,
        actualLineH:    actualLineH,
        rowsPerPage:    rowsPerPage,
        scale:          scale,
      });

      var metaPct = 16 + Math.round(((mi + 1) / totalSheets) * 26);
      s(1, 'active', metaPct, 'Sheet ' + (mi + 1) + ' of ' + totalSheets + '\u2026');
      if ((mi + 1) % 5 === 0) await yieldToMain(3);
    }

    s(1, 'done', 42);

    // ── Phase 2: build PDF sheet by sheet ────────────────────────────────────
    s(2, 'active', 44, 'Building PDF\u2026');

    var _PDFDocument   = PDFLib.PDFDocument;
    var _StandardFonts = PDFLib.StandardFonts;
    var _rgb           = PDFLib.rgb;

    var doc  = await _PDFDocument.create();
    var font = await doc.embedFont(_StandardFonts.Helvetica);
    var bold = await doc.embedFont(_StandardFonts.HelveticaBold);

    var ROW_CHUNK  = (PERF_MODE === 'high') ? 500 : (PERF_MODE === 'medium') ? 200 : 80;
    var pagesDone  = 0;
    var totalRows  = 0;
    var charTotal  = 0;
    var sheetsRendered = 0;

    for (var si = 0; si < totalSheets; si++) {
      if (memTier() === 'fallback') {
        DT().error('excel-to-pdf-mem-abort', { si: si, pagesDone: pagesDone });
        break;
      }

      var meta = sheetMeta[si];
      if (!meta) continue;

      // Load sheet rows with XLSX range cap — never allocates >MAX_RENDER_ROWS rows
      var ws2      = wb.Sheets[meta.name];
      var renderEndRow = Math.min(meta.wsRng.e.r, meta.wsRng.s.r + MAX_RENDER_ROWS - 1);
      var renderRange  = {
        s: { r: meta.wsRng.s.r, c: meta.wsRng.s.c },
        e: { r: renderEndRow,   c: meta.wsRng.e.c  },
      };
      var rows = XLSX.utils.sheet_to_json(ws2, {
        header: 1, defval: '', range: renderRange,
      });
      ws2 = null;

      if (!rows.length) {
        sheetMeta[si] = null;
        continue;
      }

      totalRows  += rows.length;
      sheetsRendered++;

      var afs  = meta.actualFontSize;
      var alh  = meta.actualLineH;
      var cws  = meta.colWidths;
      var nc   = meta.numCols;

      var sheetLabel = 'Sheet: ' + meta.name +
        (meta.wasCapped ? ' (first ' + MAX_RENDER_ROWS.toLocaleString() + ' rows)' : '');

      // ── Start first page for this sheet ──────────────────────────────────
      var page = doc.addPage([PW, PH]);
      pagesDone++;
      var pageInSheet = 1;
      var titleY = PH - marginPt;

      function _drawSheetHeader(pg, label) {
        try { pg.drawText(label, {
          x: marginPt, y: titleY - afs,
          size: Math.min(12, afs + 2), font: bold, color: _rgb(0.15, 0.15, 0.5),
        }); } catch (_) {}
      }

      _drawSheetHeader(page, sheetLabel);
      var y = titleY - afs * 2 - 4;

      // ── Render rows in ROW_CHUNK batches ──────────────────────────────────
      for (var ri2 = 0; ri2 < rows.length; ri2++) {
        // Page overflow check
        if (y < marginPt + alh) {
          page = doc.addPage([PW, PH]);
          pagesDone++;
          pageInSheet++;
          _drawSheetHeader(page, 'Sheet: ' + meta.name + ' (cont. p' + pageInSheet + ')');
          y = titleY - afs * 2 - 4;
        }

        var row    = rows[ri2];
        var isHdr  = ri2 === 0;
        var uFont  = isHdr ? bold : font;

        // Header row background
        if (isHdr) {
          var hdrW = 0;
          for (var hi = 0; hi < nc; hi++) hdrW += (cws[hi] || 0);
          hdrW = Math.min(hdrW, usableW);
          try { page.drawRectangle({
            x: marginPt, y: y - alh + 2, width: hdrW, height: alh,
            color: _rgb(0.91, 0.91, 0.97),
          }); } catch (_) {}
        }

        // Draw cells
        var x2 = marginPt;
        for (var ci2 = 0; ci2 < nc; ci2++) {
          var colW2 = cws[ci2] || 0;
          if (x2 + colW2 > PW - marginPt + 1) break;
          var rawCell  = (row[ci2] !== undefined && row[ci2] !== null) ? String(row[ci2]) : '';
          var maxChars = Math.max(1, Math.floor(colW2 / (afs * 0.55)));
          var cell     = rawCell.length > maxChars ? rawCell.slice(0, maxChars - 1) + '\u2026' : rawCell;
          charTotal += rawCell.length;
          if (cell) {
            try { page.drawText(cell, {
              x: x2 + 2, y: y - alh + 4, size: afs, font: uFont, color: _rgb(0, 0, 0),
            }); } catch (_) {}
          }
          // Vertical column divider (skip leftmost)
          if (ci2 > 0) {
            try { page.drawLine({
              start: { x: x2, y: y + 2 }, end: { x: x2, y: y - alh + 1 },
              thickness: 0.25, color: _rgb(0.8, 0.8, 0.8),
            }); } catch (_) {}
          }
          x2 += colW2;
        }

        // Horizontal row divider
        var rowWidth = Math.min(x2 - marginPt, usableW);
        try { page.drawLine({
          start: { x: marginPt,             y: y - alh },
          end:   { x: marginPt + rowWidth,  y: y - alh },
          thickness: isHdr ? 0.75 : 0.25,
          color:     isHdr ? _rgb(0.55, 0.55, 0.75) : _rgb(0.82, 0.82, 0.82),
        }); } catch (_) {}

        y -= alh;

        // Yield + progress every ROW_CHUNK rows
        if ((ri2 + 1) % ROW_CHUNK === 0) {
          if (memTier() === 'fallback') {
            DT().error('excel-to-pdf-row-mem-abort', { si: si, ri: ri2, pagesDone: pagesDone });
            rows.length = ri2 + 1; // truncate — break outer for-of on next iteration
            break;
          }
          var rowFrac    = (ri2 + 1) / Math.max(1, rows.length);
          var sheetFrac  = (si + rowFrac) / totalSheets;
          var renderPct  = 44 + Math.round(sheetFrac * 38);
          s(2, 'active', Math.min(renderPct, 81),
            'Sheet ' + (si + 1) + '/' + totalSheets + ' \u00b7 Row ' + (ri2 + 1) + '/' + rows.length);
          await yieldToMain(6);
        }
      }

      safeArrayNull(rows); rows = null;
      sheetMeta[si] = null;

      var sheetPct = 44 + Math.round(((si + 1) / totalSheets) * 38);
      s(2, 'active', Math.min(sheetPct, 82), 'Sheet ' + (si + 1) + ' of ' + totalSheets + ' complete\u2026');
      await yieldToMain(4);
    }

    // Release workbook — no longer needed
    wb = null;
    safeArrayNull(sheetMeta); sheetMeta = null;

    s(2, 'done', 82);

    // ── Phase 3: finalize + validate ─────────────────────────────────────────
    s(3, 'active', 84, 'Finalizing output\u2026');

    var pdfBytes = await doc.save();
    doc = null;
    var blob = new Blob([pdfBytes], { type: 'application/pdf' });
    pdfBytes = null;

    if (blob.size < 500) {
      throw new Error('PDF generation produced an empty result. Please try a different file.');
    }

    DT().validate('excel-to-pdf-quality', {
      blobSize:      blob.size,
      totalSheets:   sheetsRendered,
      totalRows:     totalRows,
      charTotal:     charTotal,
      pagesDone:     pagesDone,
      pageSizeKey:   pageSizeKey,
      orient:        orient,
      hiddenSkipped: hiddenCount,
    });
    DT().result('excel-to-pdf-complete', {
      sizeMB:  (blob.size / 1048576).toFixed(2),
      sheets:  sheetsRendered,
      rows:    totalRows,
      pages:   pagesDone,
      chars:   charTotal,
    });

    s(3, 'done', 100);

    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.pdf'),
      _quality: { rows: totalRows, paras: pagesDone, pages: sheetsRendered, chars: charTotal },
    };
  };
  // ─── WORD TO EXCEL — Real Enterprise Pipeline v1.0 ───────────────────────
  //
  // Architecture:
  //   Phase 0  (5-18%)  : Input validation + mammoth + XLSX load (IDB-cached)
  //                        DOCX parsed → full HTML via mammoth
  //   Phase 1  (18-55%) : HTML DOM walked → multi-strategy sheet extraction
  //                        Strategy 1: native <table> elements (one sheet per table)
  //                        Strategy 2: definition-list <dl> key-value pairs
  //                        Strategy 3: heading-grouped paragraphs (Section|Content)
  //                        Strategy 4: full-text fallback (row-per-paragraph)
  //                        DOM released immediately after extraction
  //   Phase 2  (55-90%) : Numeric coercion + buildXlsx via advanced-worker.js
  //   Phase 3  (90-100%): blob finalize + DT quality validate
  //
  // Design rules (same as word-to-pdf / excel-to-pdf):
  //   • ArrayBuffer null'd immediately after mammoth parse
  //   • DOM released after element extraction
  //   • Numeric coercion strips currency symbols / thousands commas
  //   • Full DT() DebugTrace + _quality for analyzeResultQuality
  //   • validateContent('word-to-excel') gate active
  //   • brandedFilename + .xlsx MIME type
  //
  processors['word-to-excel'] = async function (f, o, s) {
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');

    var fileSizeMB = (file.size / 1048576).toFixed(1);
    DT().log('word-to-excel-start', { sizeMB: fileSizeMB });

    // ── Phase 0: load libraries ───────────────────────────────────────────
    s(0, 'active', 5, 'Loading engine\u2026');

    await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js');
    if (!window.mammoth) throw new Error('Document parser unavailable. Check your connection and try again.');

    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    if (!window.XLSX) throw new Error('Spreadsheet engine unavailable. Check your connection and try again.');

    DT().log('word-to-excel-libs-ready', {});

    // ── Phase 0b: DOCX → HTML via mammoth ────────────────────────────────
    s(0, 'active', 12, 'Parsing document\u2026');

    var ab = await file.arrayBuffer();
    var mammothResult;
    try {
      mammothResult = await window.mammoth.convertToHtml({ arrayBuffer: ab });
    } finally {
      ab = null; // release ArrayBuffer immediately — mammoth holds internal copy
    }

    var htmlContent = (mammothResult && mammothResult.value) || '';
    mammothResult = null;

    if (!htmlContent.trim()) {
      throw new Error('Could not extract content from this Word document. The file may be empty or in an unsupported format.');
    }

    DT().log('word-to-excel-html-ready', { htmlLen: htmlContent.length });
    s(0, 'done', 18);

    // ── Phase 1: HTML → structured sheets ────────────────────────────────
    s(1, 'active', 20, 'Extracting content\u2026');

    var parser  = new DOMParser();
    var htmlDoc = parser.parseFromString('<div id="wr">' + htmlContent + '</div>', 'text/html');
    htmlContent = null;

    var rootEl   = htmlDoc.getElementById('wr') || htmlDoc.body;
    var children = rootEl ? Array.from(rootEl.children) : [];

    var sheets = [];

    // ── Strategy 1: native <table> elements (highest fidelity) ───────────
    var domTables = rootEl ? rootEl.querySelectorAll('table') : [];
    DT().log('word-to-excel-tables', { count: domTables.length });

    if (domTables && domTables.length > 0) {
      var tableIdx = 0;
      for (var ti = 0; ti < domTables.length; ti++) {
        tableIdx++;
        var tbl   = domTables[ti];
        var rows  = [];
        var trs   = tbl.querySelectorAll('tr');
        var maxCols = 0;

        for (var ri = 0; ri < trs.length; ri++) {
          var cells = trs[ri].querySelectorAll('th, td');
          var row   = [];
          for (var di = 0; di < cells.length; di++) {
            row.push((cells[di].textContent || '').trim());
          }
          if (row.length > maxCols) maxCols = row.length;
          if (row.some(function (c) { return c; })) rows.push(row);
        }

        if (rows.length > 0 && maxCols > 0) {
          // Normalize all rows to maxCols width
          for (var nri = 0; nri < rows.length; nri++) {
            while (rows[nri].length < maxCols) rows[nri].push('');
          }
          // Sheet name: prefer heading immediately before table, else "Table N"
          var sheetName = 'Table ' + tableIdx;
          var prevEl = tbl.previousElementSibling;
          if (prevEl && /^h[1-6]$/i.test(prevEl.tagName || '')) {
            var headingText = (prevEl.textContent || '').trim().slice(0, 31);
            if (headingText) sheetName = headingText;
          }
          sheets.push({ name: sheetName, rows: rows });
        }
      }
      DT().log('word-to-excel-strategy', { method: 'native-tables', sheets: sheets.length });
    }

    // ── Strategy 2: definition-list key-value pairs ───────────────────────
    if (sheets.length === 0 && rootEl) {
      var kvRows = [['Key', 'Value']];
      var dls    = rootEl.querySelectorAll('dl');
      for (var dli = 0; dli < dls.length; dli++) {
        var dts = dls[dli].querySelectorAll('dt');
        var dds = dls[dli].querySelectorAll('dd');
        var pairLen = Math.max(dts.length, dds.length);
        for (var pi = 0; pi < pairLen; pi++) {
          kvRows.push([
            dts[pi] ? (dts[pi].textContent || '').trim() : '',
            dds[pi] ? (dds[pi].textContent || '').trim() : '',
          ]);
        }
      }
      if (kvRows.length >= 3) {
        sheets.push({ name: 'Document Data', rows: kvRows });
        DT().log('word-to-excel-strategy', { method: 'definition-list', rows: kvRows.length });
      }
    }

    // ── Strategy 3: heading-grouped paragraphs → Section|Content ─────────
    if (sheets.length === 0 && children.length > 0) {
      var sectionRows   = [['Section', 'Content']];
      var curSection    = 'Document';
      var curLines      = [];

      for (var ci = 0; ci < children.length; ci++) {
        var ch  = children[ci];
        var tag = (ch.tagName || '').toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          if (curLines.length > 0) {
            sectionRows.push([curSection, curLines.join('\n')]);
            curLines = [];
          }
          curSection = (ch.textContent || '').trim() || ('Section ' + (sectionRows.length));
        } else {
          var txt = (ch.textContent || '').trim();
          if (txt) curLines.push(txt);
        }
      }
      if (curLines.length > 0) sectionRows.push([curSection, curLines.join('\n')]);

      if (sectionRows.length > 2) {
        sheets.push({ name: 'Document Content', rows: sectionRows });
        DT().log('word-to-excel-strategy', { method: 'heading-groups', rows: sectionRows.length });
      }
    }

    // ── Strategy 4: flat fallback — one row per paragraph ────────────────
    if (sheets.length === 0 && children.length > 0) {
      var flatRows = [['#', 'Content']];
      var rowNum   = 0;
      for (var fi = 0; fi < children.length; fi++) {
        var fch  = children[fi];
        var ftag = (fch.tagName || '').toLowerCase();
        if (ftag === 'table') continue;
        var ftext = (fch.textContent || '').trim();
        if (ftext) {
          rowNum++;
          flatRows.push([rowNum, ftext]);
        }
      }
      if (flatRows.length > 1) {
        sheets.push({ name: 'Document', rows: flatRows });
        DT().log('word-to-excel-strategy', { method: 'flat-fallback', rows: flatRows.length });
      }
    }

    // Release DOM — no longer needed
    rootEl = null; children = null; htmlDoc = null;

    if (sheets.length === 0) {
      throw new Error('No extractable content was found in this document. Please check the file and try again.');
    }

    var totalRows   = sheets.reduce(function (acc, sh) { return acc + sh.rows.length; }, 0);
    var totalSheets = sheets.length;
    DT().log('word-to-excel-extract', { sheets: totalSheets, totalRows: totalRows });

    s(1, 'active', 45, 'Processing ' + totalRows + ' rows\u2026');

    // Phase 2 (v5): content-level validation gate
    validateContent('word-to-excel', { rows: totalRows, sheets: totalSheets });

    // ── Numeric coercion (mirrors buildXlsx in advanced-worker.js) ────────
    var coercedSheets = sheets.map(function (sh) {
      var coercedRows = sh.rows.map(function (row) {
        return row.map(function (cell) {
          if (cell === '' || cell === null || cell === undefined) return cell;
          var str   = String(cell).trim();
          // Strip currency symbols, thousands commas, whitespace
          var clean = str.replace(/^[$\u20ac\u00a3\u00a5\u20b9\s]+/, '').replace(/[,\s]+$/, '').replace(/,/g, '');
          var n     = Number(clean);
          if (clean !== '' && !isNaN(n) && isFinite(n)) return n;
          return str;
        });
      });
      return { name: sh.name, rows: coercedRows };
    });
    sheets = null;

    s(1, 'done', 55);

    // ── Phase 2: build XLSX via advanced-worker.js buildXlsx ─────────────
    s(2, 'active', 58, 'Building spreadsheet\u2026');

    var wResult;
    try {
      wResult = await runAdvancedWorker({ op: 'build-xlsx', sheets: coercedSheets });
    } catch (xlsxWorkerErr) {
      DT().error('word-to-excel-worker-fail', { err: String(xlsxWorkerErr).slice(0, 120) });
    }
    coercedSheets = null;

    if (!wResult || !wResult.buffer) throw new Error(ERR.ORIG);

    s(2, 'done', 90);
    s(3, 'active', 93, 'Finalizing output\u2026');

    var blob = new Blob([wResult.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    wResult = null;

    DT().validate('word-to-excel-quality', {
      blobSize: blob.size, sheets: totalSheets, totalRows: totalRows,
    });
    DT().result('word-to-excel-complete', {
      sizeMB: (blob.size / 1048576).toFixed(3), sheets: totalSheets, rows: totalRows,
    });

    s(3, 'done', 100);

    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.xlsx'),
      _quality: { rows: totalRows, sheets: totalSheets, chars: totalRows * 10, pages: totalSheets },
    };
  };

  processors['html-to-pdf'] = async function (f, o, s) {
    s(0, 'active', 10, 'Preparing your document\u2026');
    // Phase 20E: wait for web fonts to finish loading before handing off to
    // the browser renderer — prevents missing-glyph or invisible-text artifacts.
    try {
      if (document.fonts && document.fonts.ready) {
        await Promise.race([
          document.fonts.ready,
          new Promise(function (r) { setTimeout(r, 3000); }), // 3 s timeout
        ]);
      }
    } catch (_) {}
    DT().log('html-to-pdf-prep', { fontsStatus: document.fonts ? document.fonts.status : 'n/a' });
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };
  processors['scan-to-pdf'] = async function (f, o, s) {
    s(0, 'active', 10, 'Analyzing images\u2026');
    // Phase 20E: validate combined image size before delegating to browser engine.
    var files = f || [];
    if (files.length > 0) {
      var totalMB = files.reduce(function (sum, fi) { return sum + (fi.size || 0); }, 0) / 1048576;
      DT().log('scan-to-pdf-prep', { files: files.length, totalMB: totalMB.toFixed(1) });
      if (totalMB > 400) {
        throw new Error('The combined image size (' + totalMB.toFixed(0) + ' MB) is too large. Please use fewer or smaller images.');
      }
    }
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  // ─── PHASE 22: GLOBAL ADVANCED ENGINE INTEGRATION ────────────────────────
  // Thin sentinel processors for the remaining 18 tools.
  // Each routes through the full Advanced Engine pipeline — Input Intelligence
  // pre-check, memory guard, LiveFeed, DT logging, yieldToMain — then hands
  // off to browser-tools.js via ERR.ORIG for the actual pdf-lib / canvas work.
  // This preserves all existing functionality while adding Phase 18-21 infra.

  // ── PDF restructuring tools (pure pdf-lib, no canvas) ────────────────────

  processors['merge'] = async function (f, o, s) {
    s(0, 'active', 8, 'Loading documents\u2026');
    var files = f || [];
    if (files.length < 2) throw new Error('Please upload at least two PDF files to merge.');
    var totalMB = files.reduce(function (sum, fi) { return sum + (fi.size || 0); }, 0) / 1048576;
    DT().log('merge-prep', { files: files.length, totalMB: totalMB.toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['split'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('split-prep', { sizeMB: (file.size / 1048576).toFixed(1), range: (o && o.range) || 'all' });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['rotate'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('rotate-prep', { sizeMB: (file.size / 1048576).toFixed(1), degrees: (o && o.degrees) || 90 });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['organize'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('organize-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['page-numbers'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('page-numbers-prep', { sizeMB: (file.size / 1048576).toFixed(1), position: (o && o.position) || 'bottom-center' });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['watermark'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('watermark-prep', { sizeMB: (file.size / 1048576).toFixed(1), text: (o && o.text) || 'WATERMARK' });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['crop'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('crop-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['protect'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('protect-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['unlock'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('unlock-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['edit'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('edit-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['sign'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('sign-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['redact'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('redact-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  // ── Image and conversion tools (canvas-heavy / CDN-dependent) ────────────

  processors['pdf-to-jpg'] = async function (f, o, s) {
    s(0, 'active', 8, 'Analyzing document\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    var sizeMB = file.size / 1048576;
    if (sizeMB > 80) {
      DT().log('pdf-to-jpg-large', { sizeMB: sizeMB.toFixed(1), note: 'canvas_memory_intensive' });
    }
    DT().log('pdf-to-jpg-prep', { sizeMB: sizeMB.toFixed(1) });
    await yieldToMain(8);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['jpg-to-pdf'] = async function (f, o, s) {
    s(0, 'active', 8, 'Loading images\u2026');
    var files = f || [];
    if (!files.length) throw new Error('Please upload at least one image.');
    var totalMB = files.reduce(function (sum, fi) { return sum + (fi.size || 0); }, 0) / 1048576;
    DT().log('jpg-to-pdf-prep', { files: files.length, totalMB: totalMB.toFixed(1) });
    if (totalMB > 200) {
      throw new Error('The combined image size (' + totalMB.toFixed(0) + ' MB) is too large. Please use fewer or smaller images.');
    }
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['crop-image'] = async function (f, o, s) {
    s(0, 'active', 8, 'Loading image\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('crop-image-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['resize-image'] = async function (f, o, s) {
    s(0, 'active', 8, 'Loading image\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('resize-image-prep', { sizeMB: (file.size / 1048576).toFixed(1) });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  processors['image-filters'] = async function (f, o, s) {
    s(0, 'active', 8, 'Loading image\u2026');
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');
    DT().log('image-filters-prep', { sizeMB: (file.size / 1048576).toFixed(1), filter: (o && o.filter) || 'none' });
    await yieldToMain(5);
    s(0, 'done', 15);
    throw new Error(ERR.ORIG);
  };

  // ─── POWERPOINT TO PDF — Real Enterprise Pipeline v1.0 ───────────────────
  //
  // Architecture:
  //   Phase 0  (5-14%)  : Input validation + JSZip + pdf-lib load (IDB-cached)
  //   Phase 1  (14-42%) : Chunked PPTX parsing — slide XML in PARSE_CHUNK batches
  //                        with yieldToMain() between chunks; XML refs null'd immediately
  //   Phase 2  (42-82%) : Chunked PDF rendering — handout grid in RENDER_CHUNK
  //                        page batches; memory pressure abort with partial result;
  //                        notes-below inline or notes-append trailing pages
  //   Phase 3  (82-100%): Finalize + quality validate
  //
  // Improvements over browser-tools.js powerpointToPdf() fallback:
  //   • Chunked slide parsing with per-chunk yieldToMain() — browser stays responsive
  //   • XML string null'd after each slide parse — never holds all raw XML in RAM
  //   • zip object null'd after parsing — only compact slide objects retained
  //   • Handout grid rendered in configurable page-batch chunks with yield + mem check
  //   • Adaptive chunk sizes driven by PERF_MODE (high/medium/low)
  //   • Memory-pressure abort: returns partial PDF if device enters 'fallback' tier
  //   • Per-slide progress reporting via onStep()
  //   • Full DT() DebugTrace: start, parsed, quality, result
  //   • _quality metadata for analyzeResultQuality scoring
  //   • BrowserTools fallback PRESERVED — only fires on genuine failures
  //
  processors['powerpoint-to-pdf'] = async function (f, o, s) {
    var file = f && f[0];
    if (!file || file.size < 20) throw new Error('empty_input');

    var fileSizeMB = (file.size / 1048576).toFixed(1);
    DT().log('powerpoint-to-pdf-start', {
      sizeMB: fileSizeMB,
      opts:   o ? JSON.stringify(o).slice(0, 200) : '{}',
    });

    // ── Phase 0: load libraries ─────────────────────────────────────────────
    s(0, 'active', 5, 'Loading engine\u2026');

    await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    if (!window.JSZip) throw new Error('ZIP parser unavailable. Check your connection and try again.');

    await loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
    if (!window.PDFLib) throw new Error('PDF engine unavailable. Check your connection and try again.');

    var JSZip  = window.JSZip;
    var PDFLib = window.PDFLib;

    // ── Options ─────────────────────────────────────────────────────────────
    var pageSizeKey = String((o && o.pageSize)     || 'presentation');
    var marginKey   = String((o && o.margins)      || 'none');
    var handout     = Math.max(1, parseInt(String((o && o.handoutMode)  || '1'),  10) || 1);
    var notesMode   = String((o && o.speakerNotes) || 'ignore');
    var watermark   = String((o && o.watermark)    || 'none');

    var PAGE_SIZES_PT = {
      presentation: [960, 540],
      A4:           [842, 595],
      Letter:       [792, 612],
      Legal:        [1008, 612],
      Tabloid:      [1224, 792],
    };
    var MARGIN_PT = { none: 6, narrow: 22, normal: 40, wide: 60 };
    var WM_TEXTS  = {
      confidential: 'CONFIDENTIAL',
      draft:        'DRAFT',
      'do-not-copy':'DO NOT COPY',
      none:         '',
    };

    var PW_PH  = PAGE_SIZES_PT[pageSizeKey] || PAGE_SIZES_PT.presentation;
    var PW     = PW_PH[0];
    var PH     = PW_PH[1];
    var margin = MARGIN_PT[marginKey] || 6;
    var wmText = WM_TEXTS[watermark]  || '';

    // ── Phase 0: parse PPTX zip ──────────────────────────────────────────────
    s(0, 'active', 10, 'Parsing presentation\u2026');

    var ab  = await file.arrayBuffer();
    var zip;
    try {
      zip = await JSZip.loadAsync(ab);
    } finally {
      ab = null;
    }

    var slideNames = Object.keys(zip.files)
      .filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
      .sort(function (a, b) {
        return parseInt((a.match(/\d+/) || ['0'])[0], 10) -
               parseInt((b.match(/\d+/) || ['0'])[0], 10);
      });

    if (!slideNames.length) {
      throw new Error('No slides found. Please check this is a valid .pptx file.');
    }

    var totalSlides = slideNames.length;
    DT().log('powerpoint-to-pdf-slides', { totalSlides: totalSlides });
    s(0, 'done', 14);

    // ── Phase 1: chunked slide XML extraction ────────────────────────────────
    s(1, 'active', 16, 'Extracting slide content\u2026');

    var PARSE_CHUNK = (PERF_MODE === 'high') ? 300 : (PERF_MODE === 'medium') ? 150 : 60;
    var slideData   = [];
    var notesData   = {};
    var charTotal   = 0;

    for (var si = 0; si < totalSlides; si++) {
      var xml = await zip.files[slideNames[si]].async('text');

      var allT = [];
      var re   = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      var m;
      while ((m = re.exec(xml)) !== null) {
        var tv = m[1]
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim();
        if (tv) allT.push(tv);
      }

      var hasTitle = /<p:ph[^>]*type=["'](title|ctrTitle)["']/.test(xml);
      slideData.push({
        num:      si + 1,
        texts:    allT,
        isTitle:  hasTitle || (allT.length <= 2 && allT[0] && allT[0].length < 80),
      });
      charTotal += allT.join(' ').length;
      xml = null;

      if ((si + 1) % PARSE_CHUNK === 0 || si === totalSlides - 1) {
        var parsePct = 16 + Math.round(((si + 1) / totalSlides) * 26);
        s(1, 'active', parsePct, 'Slide ' + (si + 1) + ' of ' + totalSlides + '\u2026');
        await yieldToMain(4);
      }
    }

    if (notesMode !== 'ignore') {
      var noteFiles = Object.keys(zip.files)
        .filter(function (n) { return /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n); })
        .sort(function (a, b) {
          return parseInt((a.match(/\d+/) || ['0'])[0], 10) -
                 parseInt((b.match(/\d+/) || ['0'])[0], 10);
        });
      for (var ni = 0; ni < noteFiles.length; ni++) {
        var nxml = await zip.files[noteFiles[ni]].async('text');
        var nT   = [];
        var nRe  = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
        var nm;
        while ((nm = nRe.exec(nxml)) !== null) {
          var nv = nm[1].replace(/&amp;/g, '&').trim();
          if (nv && nv.length > 2) nT.push(nv);
        }
        if (nT.length) notesData[ni] = nT.join(' ');
        nxml = null;
        if ((ni + 1) % 100 === 0) await yieldToMain(3);
      }
    }

    zip = null;

    DT().log('powerpoint-to-pdf-parsed', {
      slides:    totalSlides,
      chars:     charTotal,
      notesKeys: Object.keys(notesData).length,
    });
    s(1, 'done', 42);

    // ── Phase 2: build PDF ───────────────────────────────────────────────────
    s(2, 'active', 44, 'Building PDF\u2026');

    var _PDFDocument   = PDFLib.PDFDocument;
    var _StandardFonts = PDFLib.StandardFonts;
    var _rgb           = PDFLib.rgb;
    var _degrees       = PDFLib.degrees;

    var doc  = await _PDFDocument.create();
    var font = await doc.embedFont(_StandardFonts.Helvetica);
    var bold = await doc.embedFont(_StandardFonts.HelveticaBold);

    var GRID     = { 1: [1, 1], 2: [1, 2], 4: [2, 2], 6: [3, 2] };
    var gridConf = GRID[Math.min(handout, 6)] || [1, 1];
    var cols     = gridConf[0];
    var rows     = gridConf[1];
    var perPage  = cols * rows;

    var usableW    = PW - margin * 2;
    var usableH    = PH - margin * 2;
    var gapX       = cols > 1 ? margin * 0.5 : 0;
    var gapY       = rows > 1 ? margin * 0.5 : 0;
    var cellW      = (usableW - gapX * (cols - 1)) / cols;
    var cellHFull  = (usableH - gapY * (rows - 1)) / rows;
    var notesRatio = notesMode === 'below' ? 0.22 : 0;
    var slideH     = Math.round(cellHFull * (1 - notesRatio));
    var notesH     = Math.round(cellHFull * notesRatio);
    var textCol    = _rgb(0.18, 0.18, 0.18);

    function _drawWrapped(page, text, x, y, maxW, minY, sz, fnt, col) {
      var lh    = sz * 1.55;
      var words = String(text).split(' ');
      var line  = '';
      var cy    = y;
      for (var wi = 0; wi < words.length; wi++) {
        var tw   = words[wi];
        var test = line ? line + ' ' + tw : tw;
        if (line && fnt.widthOfTextAtSize(test, sz) > maxW) {
          if (cy - lh < minY) {
            try { page.drawText('\u2026', { x: x, y: cy, size: sz, font: fnt, color: col }); } catch (_) {}
            return cy - lh;
          }
          try { page.drawText(line, { x: x, y: cy, size: sz, font: fnt, color: col }); } catch (_) {}
          cy -= lh; line = tw;
        } else {
          line = test;
        }
      }
      if (line && cy >= minY) {
        try { page.drawText(line, { x: x, y: cy, size: sz, font: fnt, color: col }); } catch (_) {}
      }
      return cy - lh;
    }

    function _drawWatermark(page) {
      if (!wmText) return;
      try {
        page.drawText(wmText, {
          x:       PW * 0.10,
          y:       PH * 0.42,
          size:    Math.round(PW * 0.048),
          font:    font,
          color:   _rgb(0.80, 0.10, 0.10),
          opacity: 0.16,
          rotate:  _degrees(32),
        });
      } catch (_) {}
    }

    function _drawSlideCell(page, slide, bx, by, bw, bh) {
      var fm      = Math.max(4, Math.round(bh * 0.07));
      var titleSz = Math.max(7,  Math.round(bh * 0.105));
      var bodySz  = Math.max(5,  Math.round(bh * 0.075));
      var lhBody  = bodySz * 1.42;
      var accentH = Math.max(3, Math.round(bh * 0.022));

      try { page.drawRectangle({ x: bx, y: by, width: bw, height: bh,
        color: _rgb(0.974, 0.974, 0.999), borderColor: _rgb(0.82, 0.85, 0.95), borderWidth: 0.6 }); } catch (_) {}
      try { page.drawRectangle({ x: bx, y: by + bh - accentH, width: bw, height: accentH,
        color: _rgb(0.39, 0.40, 0.945) }); } catch (_) {}
      try { page.drawText(String(slide.num), {
        x: bx + bw - 13, y: by + bh - 13, size: 6, font: font, color: _rgb(0.6, 0.6, 0.6),
      }); } catch (_) {}

      if (!slide.texts || !slide.texts.length) {
        try { page.drawText('(empty)', {
          x: bx + fm, y: by + bh * 0.47, size: bodySz, font: font, color: _rgb(0.72, 0.72, 0.72),
        }); } catch (_) {}
        return;
      }

      var cy       = by + bh - accentH - fm - 4;
      var titleStr = slide.isTitle ? (slide.texts[0] || '') : '';
      if (titleStr) {
        try { page.drawText(titleStr.substring(0, 58), {
          x: bx + fm, y: cy, size: titleSz, font: bold, color: _rgb(0.10, 0.10, 0.42),
        }); } catch (_) {}
        cy -= titleSz * 1.55;
      }

      var startIdx = slide.isTitle ? 1 : 0;
      var bodyFloor = by + fm + bodySz;
      for (var ti = startIdx; ti < slide.texts.length && ti < 18; ti++) {
        if (cy < bodyFloor) break;
        try { page.drawText('\u00b7 ' + slide.texts[ti].substring(0, 74), {
          x: bx + fm, y: cy, size: bodySz, font: font, color: textCol,
        }); } catch (_) {}
        cy -= lhBody;
      }
    }

    var RENDER_CHUNK = (PERF_MODE === 'high') ? 300 : (PERF_MODE === 'medium') ? 120 : 40;
    var totalPages   = Math.ceil(totalSlides / perPage);
    var pagesDone    = 0;

    for (var pi = 0; pi < slideData.length; pi += perPage) {
      if (memTier() === 'fallback') {
        DT().error('powerpoint-to-pdf-mem-abort', { at: pi, pagesDone: pagesDone });
        break;
      }

      var batch = slideData.slice(pi, pi + perPage);
      var page  = doc.addPage([PW, PH]);
      pagesDone++;

      for (var bi = 0; bi < batch.length; bi++) {
        var col  = bi % cols;
        var row  = Math.floor(bi / cols);
        var bx   = margin + col * (cellW + gapX);
        var byCell = PH - margin - (row + 1) * cellHFull - row * gapY;

        _drawSlideCell(page, batch[bi], bx, byCell + notesH, cellW, slideH);

        if (notesMode === 'below' && notesH > 0) {
          var noteIdx  = batch[bi].num - 1;
          var noteText = notesData[noteIdx] || '';
          if (noteText) {
            try { page.drawText('Notes:', {
              x: bx + 4, y: byCell + notesH - 7, size: 5.5, font: bold, color: _rgb(0.4, 0.4, 0.4),
            }); } catch (_) {}
            _drawWrapped(page, noteText,
              bx + 4, byCell + notesH - 14, cellW - 8, byCell + 4, 5, font, _rgb(0.35, 0.35, 0.35));
          }
        }
      }

      _drawWatermark(page);
      try { page.drawText(String(pagesDone), {
        x: PW - margin, y: 7, size: 6.5, font: font, color: _rgb(0.7, 0.7, 0.7),
      }); } catch (_) {}

      if (pagesDone % RENDER_CHUNK === 0 || pi + perPage >= slideData.length) {
        var renderPct = 44 + Math.round((pagesDone / Math.max(1, totalPages)) * 38);
        s(2, 'active', Math.min(renderPct, 82), 'Page ' + pagesDone + ' of ' + totalPages + '\u2026');
        await yieldToMain(6);
      }
    }

    safeArrayNull(slideData); slideData = null;

    if (notesMode === 'append') {
      var noteKeys = Object.keys(notesData)
        .map(function (k) { return parseInt(k, 10); })
        .sort(function (a, b) { return a - b; });
      for (var nki = 0; nki < noteKeys.length; nki++) {
        var noteIdx2  = noteKeys[nki];
        var nText     = notesData[noteIdx2];
        if (!nText) continue;
        var np = doc.addPage([PW, PH]);
        try { np.drawText('Notes \u2014 Slide ' + (noteIdx2 + 1), {
          x: margin, y: PH - margin, size: 14, font: bold, color: _rgb(0.12, 0.12, 0.42),
        }); } catch (_) {}
        try { np.drawRectangle({
          x: margin, y: PH - margin - 5, width: PW - margin * 2, height: 1.5,
          color: _rgb(0.7, 0.7, 0.9),
        }); } catch (_) {}
        _drawWrapped(np, nText, margin, PH - margin - 22, PW - margin * 2, margin, 10, font, textCol);
        _drawWatermark(np);
        if ((nki + 1) % 50 === 0) await yieldToMain(3);
      }
    }

    notesData = null;
    s(2, 'done', 82);

    // ── Phase 3: finalize + validate ─────────────────────────────────────────
    s(3, 'active', 84, 'Finalizing output\u2026');

    var pdfBytes = await doc.save();
    doc = null;
    var blob = new Blob([pdfBytes], { type: 'application/pdf' });
    pdfBytes = null;

    if (blob.size < 500) {
      throw new Error('PDF generation produced an empty result. Please try a different file.');
    }

    DT().validate('powerpoint-to-pdf-quality', {
      blobSize:     blob.size,
      totalSlides:  totalSlides,
      charTotal:    charTotal,
      pagesDone:    pagesDone,
      handout:      handout,
      pageSizeKey:  pageSizeKey,
    });
    DT().result('powerpoint-to-pdf-complete', {
      sizeMB:  (blob.size / 1048576).toFixed(2),
      slides:  totalSlides,
      pages:   pagesDone,
      chars:   charTotal,
    });

    s(3, 'done', 100);

    return {
      blob:     blob,
      filename: brandedFilename(file.name, '.pdf'),
      _quality: { chars: charTotal, paras: pagesDone, pages: totalSlides },
    };
  };

  // ─── OCR Engine v4 — Phase 19A: OffscreenCanvas + Denoise Mode + Pool Cleanup ─
  //
  // Four-layer hybrid pipeline for the OCR PDF tool:
  //   1. Native text fast-path  (unchanged)
  //   2. Per-page preprocessing via ocr-preprocessor-worker (Phase 18)
  //      — grayscale → normalize → adaptive/Otsu threshold → deskew
  //   3. Confidence-based retry ladder (Phase 19A: 4 attempts):
  //      attempt A: 'auto' preprocessing  (adaptive threshold + deskew)
  //      attempt B: 'strong' preprocessing (Otsu + deskew)   if conf < 45
  //      attempt C: 'denoise' preprocessing (blur + Otsu)    if conf < 35  ← NEW
  //      attempt D: raw pixels, no preprocessing             if conf < 25
  //      → best result (highest confidence) is kept
  //   4. Phase 19A improvements:
  //      — OffscreenCanvas+ImageBitmap path skips JPEG encode/decode
  //      — Adaptive batch yield size (PERF_MODE-aware)
  //      — Adaptive render scale for large docs (> 30 / 60 pages)
  //      — Per-page min/max/avg confidence tracking
  //      — Cleanup safety: try/finally in _ocrRecognizePage
  //      — Post-OCR WorkerPool.terminatePool() for immediate memory reclaim

  var OCR_PREPROCESSOR_URL  = '/workers/ocr-preprocessor-worker.js';
  // Phase 19B: retry thresholds widened — catches more borderline pages
  //   RETRY:        45 → 50  (strong mode triggers sooner for marginal pages)
  //   DENOISE:      35 → 40  (blur+Otsu activated earlier for noisy mid-range pages)
  //   RAW_FALLBACK: 25       (unchanged — last resort for very poor results)
  var OCR_CONF_RETRY        = 50;
  var OCR_CONF_DENOISE      = 40;
  var OCR_CONF_RAW_FALLBACK = 25;
  // Phase 19A: adaptive batch yield — lower-end devices get smaller batches + explicit yield time
  var _ocrPerfMode      = (typeof PERF_MODE !== 'undefined') ? PERF_MODE : 'medium';
  var OCR_BATCH_YIELD   = _ocrPerfMode === 'low' ? 3 : _ocrPerfMode === 'high' ? 8 : 5;
  var OCR_BATCH_YIELD_MS = _ocrPerfMode === 'low' ? 20 : 5; // Phase 19B: min 5ms yield on all tiers

  // ── Helper: detect already-binarized / digitally-clean images (Phase 19B) ────
  // Samples ~4000 pixels from the RGBA buffer. If ≥87% of pixels are either
  // near-white (luma > 240) or near-black (luma < 15), the image is already
  // essentially binary — running adaptive/Otsu preprocessing would add no value
  // and wastes CPU. The caller can skip attempts A-C and jump straight to raw.
  function _isEssentiallyBinary(pixelsBuf, w, h) {
    try {
      var rgba     = new Uint8ClampedArray(pixelsBuf);
      var n        = w * h;
      var step     = Math.max(1, Math.floor(n / 4000)); // ~4000 samples
      var binary   = 0, sampled = 0;
      for (var i = 0; i < n; i += step) {
        var px  = i * 4;
        var lum = (0.299 * rgba[px] + 0.587 * rgba[px + 1] + 0.114 * rgba[px + 2]) | 0;
        if (lum < 15 || lum > 240) binary++;
        sampled++;
      }
      return sampled > 0 && (binary / sampled) > 0.87;
    } catch (_) { return false; }
  }

  // ── Helper: send pixels to the preprocessor worker via WorkerPool ──────────
  // Returns { pixels: ArrayBuffer, width, height } or null on any failure.
  // rawPixelsBuf is TRANSFERRED (detached after call) — caller must pass a .slice().
  //
  // Phase 7C: upgraded to route through RuntimeWorkers.dispatch() when available.
  // This adds full lifecycle management: cooldown detection, zombie prevention,
  // timeout enforcement, telemetry spans, and cancellation token propagation.
  // Falls back to direct WorkerPool.run() for backward compatibility.
  async function _ocrPreprocessPage(rawPixelsBuf, w, h, mode) {
    var msg = { pixels: rawPixelsBuf, width: w, height: h, mode: mode };

    // Phase 7C preferred path: RuntimeWorkers.dispatch() with full orchestration
    if (window.RuntimeWorkers && window.RuntimeWorkers.dispatch) {
      try {
        var result = await window.RuntimeWorkers.dispatch(
          OCR_PREPROCESSOR_URL,
          msg,
          [rawPixelsBuf],  // transferable — zero-copy
          {
            priority:  'high',        // OCR preprocessing is on the critical path
            label:     'ocr-preprocess-' + mode,
            timeoutMs: 15000,         // 15 s — preprocessing should be fast
            // No dedupeKey: each page has unique pixels
          }
        );
        if (!result || !result.pixels) return null;
        return result;
      } catch (_) {
        return null; // preprocessor unavailable / timed out → caller uses raw path
      }
    }

    // Legacy fallback: direct WorkerPool.run() (Phase 7C: bypasses lifecycle mgmt)
    if (!window.WorkerPool) return null;
    try {
      var legacyResult = await window.WorkerPool.run(
        OCR_PREPROCESSOR_URL,
        msg,
        [rawPixelsBuf]
      );
      if (!legacyResult || !legacyResult.pixels) return null;
      return legacyResult;
    } catch (_) {
      return null;
    }
  }

  // ── Helper: RGBA ArrayBuffer → Tesseract input ──────────────────────────────
  // Phase 19A: prefers OffscreenCanvas+ImageBitmap — skips JPEG encode/decode,
  // saves ~10-20% CPU and memory per page. Falls back to JPEG dataURL on older
  // browsers that lack OffscreenCanvas.
  // Returns { input, isImageBitmap }. Caller must close ImageBitmap when done.
  async function _ocrPixelsToInput(pixelsBuf, w, h) {
    if (typeof OffscreenCanvas !== 'undefined') {
      try {
        var oc   = new OffscreenCanvas(w, h);
        var octx = oc.getContext('2d');
        octx.putImageData(new ImageData(new Uint8ClampedArray(pixelsBuf), w, h), 0, 0);
        var bmp = oc.transferToImageBitmap();
        return { input: bmp, isImageBitmap: true };
      } catch (_) { /* fall through to JPEG dataURL path */ }
    }
    // Fallback: JPEG dataURL via a temporary DOM canvas
    var c   = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixelsBuf), w, h), 0, 0);
    var url = c.toDataURL('image/jpeg', 0.92);
    c.width = 0; c.height = 0; // free GPU backing store
    return { input: url, isImageBitmap: false };
  }

  // ── Helper: recognize one page with up to 4 confidence-ranked attempts ──────
  // Phase 19B: hardened cleanup + retry reason logging + binary skip optimization.
  //
  //   Attempt A: 'auto'    adaptive threshold + deskew       (always, unless already binary)
  //   Attempt B: 'strong'  Otsu global threshold             (if conf < OCR_CONF_RETRY=50)
  //   Attempt C: 'denoise' 5×5 blur + Otsu                  (if conf < OCR_CONF_DENOISE=40)
  //   Attempt D: raw pixels (no preprocessing)              (if conf < OCR_CONF_RAW_FALLBACK=25)
  //
  // Binary-skip optimization (Phase 19B): if the page render is already
  // essentially binary (digital PDF rendered at high quality), attempts A-C are
  // skipped entirely — saves preprocessor worker round-trips and ~50ms CPU per page.
  //
  // Memory safety (Phase 19B):
  //   — All ImageBitmaps are tracked in bitmapsToClose[] and closed in finally.
  //   — Worker pixel buffers are nulled in finally even on thrown errors.
  //
  // rawPixels: ArrayBuffer (RGBA, owned by caller — NOT transferred here)
  // Returns { text: string, confidence: number, attempts: number, skippedPreprocess: bool }
  async function _ocrRecognizePage(tesseractWorker, rawPixels, w, h) {
    var bestText = '', bestConf = -1;
    var resA = null, resB = null, resC = null;
    // Phase 19B: track every ImageBitmap so they are closed in finally even on error
    var bitmapsToClose  = [];
    // Phase 19B: record why each retry was triggered (logged at end for diagnostics)
    var retryReasons    = [];
    var attemptCount    = 0;
    var skippedPreprocess = false;

    // Phase 19B: binary-skip optimization
    // If ≥87% of sampled pixels are near-white or near-black, the image is already
    // binarized — skip A/B/C and go straight to raw for fastest/cleanest result.
    var alreadyBinary = _isEssentiallyBinary(rawPixels, w, h);
    if (alreadyBinary) {
      skippedPreprocess = true;
      bestConf = 0; // force attempt D below
    }

    try {
      if (!alreadyBinary) {
        // Attempt A — 'auto' adaptive preprocessing (best default quality)
        attemptCount++;
        resA = await _ocrPreprocessPage(rawPixels.slice(0), w, h, 'auto');
        if (resA && resA.pixels) {
          var inpA = await _ocrPixelsToInput(resA.pixels, resA.width, resA.height);
          resA.pixels = null; resA = null;
          if (inpA.isImageBitmap) bitmapsToClose.push(inpA.input);
          var rA = await tesseractWorker.recognize(inpA.input);
          var cA = (rA.data && typeof rA.data.confidence === 'number') ? rA.data.confidence : 0;
          var tA = (rA.data && rA.data.text) ? rA.data.text.trim() : '';
          if (cA > bestConf) { bestConf = cA; bestText = tA; }
        }

        // Attempt B — 'strong' Otsu binarization if confidence is still borderline
        if (bestConf < OCR_CONF_RETRY) {
          retryReasons.push('A_conf=' + bestConf.toFixed(0) + '<' + OCR_CONF_RETRY + '→strong');
          attemptCount++;
          resB = await _ocrPreprocessPage(rawPixels.slice(0), w, h, 'strong');
          if (resB && resB.pixels) {
            var inpB = await _ocrPixelsToInput(resB.pixels, resB.width, resB.height);
            resB.pixels = null; resB = null;
            if (inpB.isImageBitmap) bitmapsToClose.push(inpB.input);
            var rB = await tesseractWorker.recognize(inpB.input);
            var cB = (rB.data && typeof rB.data.confidence === 'number') ? rB.data.confidence : 0;
            var tB = (rB.data && rB.data.text) ? rB.data.text.trim() : '';
            if (cB > bestConf) { bestConf = cB; bestText = tB; }
          }
        }

        // Attempt C — 'denoise' (5×5 blur + Otsu) for persistent noise artifacts
        if (bestConf < OCR_CONF_DENOISE) {
          retryReasons.push('B_conf=' + bestConf.toFixed(0) + '<' + OCR_CONF_DENOISE + '→denoise');
          attemptCount++;
          resC = await _ocrPreprocessPage(rawPixels.slice(0), w, h, 'denoise');
          if (resC && resC.pixels) {
            var inpC = await _ocrPixelsToInput(resC.pixels, resC.width, resC.height);
            resC.pixels = null; resC = null;
            if (inpC.isImageBitmap) bitmapsToClose.push(inpC.input);
            var rC = await tesseractWorker.recognize(inpC.input);
            var cC = (rC.data && typeof rC.data.confidence === 'number') ? rC.data.confidence : 0;
            var tC = (rC.data && rC.data.text) ? rC.data.text.trim() : '';
            if (cC > bestConf) { bestConf = cC; bestText = tC; }
          }
        }
      }

      // Attempt D — raw input (no preprocessing) as final fallback
      // Also the only attempt when alreadyBinary is true (binary-skip optimization).
      // rawPixels still valid here — only .slice() copies were transferred above.
      if (bestConf < OCR_CONF_RAW_FALLBACK || alreadyBinary) {
        if (!alreadyBinary) {
          retryReasons.push('C_conf=' + bestConf.toFixed(0) + '<' + OCR_CONF_RAW_FALLBACK + '→raw');
        }
        attemptCount++;
        var inpD = await _ocrPixelsToInput(rawPixels, w, h);
        if (inpD.isImageBitmap) bitmapsToClose.push(inpD.input);
        var rD = await tesseractWorker.recognize(inpD.input);
        var cD = (rD.data && typeof rD.data.confidence === 'number') ? rD.data.confidence : 0;
        var tD = (rD.data && rD.data.text) ? rD.data.text.trim() : '';
        if (cD > bestConf) { bestConf = cD; bestText = tD; }
      }

    } finally {
      // Phase 19B: guaranteed ImageBitmap cleanup — prevents GPU memory leaks
      // even when Tesseract throws mid-recognition.
      for (var bi = 0; bi < bitmapsToClose.length; bi++) {
        try {
          var bmp = bitmapsToClose[bi];
          if (bmp && typeof bmp.close === 'function') bmp.close();
        } catch (_) {}
      }
      // Null any pixel buffers that weren't consumed by the worker
      if (resA && resA.pixels) { resA.pixels = null; }
      if (resB && resB.pixels) { resB.pixels = null; }
      if (resC && resC.pixels) { resC.pixels = null; }
    }

    // Phase 19B: emit diagnostic log when retries occurred or preprocessing was skipped
    if (retryReasons.length || skippedPreprocess) {
      DT().log('ocr-v4-retries', {
        skippedPreprocess: skippedPreprocess,
        attempts: attemptCount,
        reasons:  retryReasons,
        finalConf: bestConf.toFixed(0),
      });
    }

    return {
      text:              bestText,
      confidence:        Math.max(0, bestConf),
      attempts:          attemptCount,
      skippedPreprocess: skippedPreprocess,
    };
  }

  processors['ocr'] = async function (files, opts, onStep) {
    var file  = files[0];
    var fHash = _fileHash(file);
    onStep(0, 'active', 5, 'Preparing your file\u2026');

    DT().log('ocr-v4-start', { name: file.name, sizeMB: +(file.size / 1048576).toFixed(1) });

    var pdfjsLib  = await loadPdfJs();
    var pdfSource = await loadPdfSource(file);
    onStep(0, 'done', 12);

    var pdf   = await pdfjsLib.getDocument(pdfSource.src).promise;
    var total = pdf.numPages;

    // Phase 8: live preview for OCR
    LivePreview.show(pdf, pdfjsLib);

    // ── Fast path: check for a native text layer ────────────────────────────
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
      // Native text is sufficient — skip Tesseract entirely
      await pdf.destroy();
      pdfSource.cleanup();
      onStep(1, 'done', 50, 'Content ready');
      onStep(2, 'active', 60, 'Building document\u2026');

      var nativePageTexts = nativeText.split('\n');
      var nativeParas = nativePageTexts.filter(function (l) { return l.trim(); }).map(function (l) {
        return { text: l.trim(), isHeading: false };
      });
      var nativeDocPages = [{
        pageNum: 1,
        paragraphs: nativeParas.length ? nativeParas : [{ text: nativeText.trim(), isHeading: false }],
      }];

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

      // Fallback: plain text
      onStep(2, 'done', 90);
      onStep(3, 'active', 93, 'Preparing result\u2026');
      var nTxtBlob = new Blob([nativeText.trim()], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);
      return { blob: nTxtBlob, filename: brandedFilename(file.name, '.txt') };
    }

    // ── Image-based path: Tesseract + Phase 18 preprocessing pipeline ────────
    onStep(1, 'done', 22);
    onStep(2, 'active', 25, 'Processing content\u2026');

    if (!window.Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    }
    if (!window.Tesseract) throw AEError(ERR.NETWORK, 'engine_load_failed');

    var lang   = (opts && opts.language) || _detectOcrLanguage(nativeText);
    var worker = await window.Tesseract.createWorker(lang, 1, { logger: function () {} });

    // Phase 19A: adaptive render scale for large documents — reduce peak memory
    // for 30+ page docs (many concurrent canvas allocations). Scale is floored at 0.6.
    var baseScale = DEVICE.ocrScale;
    var scale = total > 60 ? Math.max(baseScale * 0.70, 0.6) :
                total > 30 ? Math.max(baseScale * 0.85, 0.6) :
                baseScale;
    if (scale !== baseScale) {
      DT().log('ocr-v4-adaptive-scale', { pages: total, base: baseScale, effective: scale.toFixed(2) });
    }

    // ── Resume support (unchanged from v2) ───────────────────────────────────
    var savedProg = await ProgressStore.load('ocr', fHash);
    var startPage = 1;
    var allLines  = [];
    // Phase 19A: per-page confidence tracking (min / sum / max)
    var totalConf = 0;
    var minConf   = 100;
    var maxConf   = 0;
    var confPages = 0;

    if (savedProg && savedProg.pagesDone > 0 && savedProg.pagesDone < total) {
      if (window._aeResumeOcr === fHash) {
        startPage = savedProg.pagesDone + 1;
        allLines  = savedProg.lines || [];
        onStep(2, 'active', 25 + Math.round((startPage - 1) / total * 55),
          'Continuing where you left off\u2026');
      }
    }

    var strictStream = pdfSource.strictStreaming; // Phase 10

    try {
      for (var i = startPage; i <= total; i++) {

        // ── Batch yield: keeps browser responsive on large docs ─────────────
        // Phase 19A: OCR_BATCH_YIELD and OCR_BATCH_YIELD_MS are PERF_MODE-adaptive
        if (i > startPage && (i - startPage) % OCR_BATCH_YIELD === 0) {
          await new Promise(function (r) { setTimeout(r, OCR_BATCH_YIELD_MS); });
        }

        var pg        = await pdf.getPage(i);
        var pgContent = await pg.getTextContent();

        if (isPageBlank(pgContent)) {
          pg.cleanup();
          allLines.push('=== Page ' + i + ' ===\n(no content)');
          continue;
        }

        // ── Render page to canvas ────────────────────────────────────────────
        var viewport = pg.getViewport({ scale: scale });
        var capW     = Math.min(Math.floor(viewport.width),  HARD_MAX_IMG_DIM);
        var capH     = Math.min(Math.floor(viewport.height), HARD_MAX_IMG_DIM);
        var capScale = scale * Math.min(capW / viewport.width, capH / viewport.height);
        var capVp    = pg.getViewport({ scale: capScale });

        // ── Render page → capture raw RGBA pixels with guaranteed canvas cleanup ─
        // Phase 19B: try/finally ensures the GPU-backed canvas store is always
        // freed even when pg.render() or getImageData() throws (e.g. OOM, abort).
        var rawW = 0, rawH = 0, rawPixels = null;
        var _cvs = null;
        try {
          _cvs = document.createElement('canvas');
          _cvs.width  = Math.floor(capVp.width);
          _cvs.height = Math.floor(capVp.height);
          var ctx = _cvs.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, _cvs.width, _cvs.height);
          await pg.render({ canvasContext: ctx, viewport: capVp }).promise;
          pg.cleanup(); // Phase 2: release PDF page resources immediately
          rawW      = _cvs.width;
          rawH      = _cvs.height;
          rawPixels = ctx.getImageData(0, 0, rawW, rawH).data.buffer.slice(0);
        } finally {
          if (_cvs) { _cvs.width = 0; _cvs.height = 0; _cvs = null; } // free GPU backing store
        }

        // Skip page if render failed (rawPixels will be null)
        if (!rawPixels) {
          allLines.push('=== Page ' + i + ' ===\n(render failed)');
          continue;
        }

        // ── Phase 19B: preprocess + 4-attempt confidence-ranked recognition ───
        var pageResult = await _ocrRecognizePage(worker, rawPixels, rawW, rawH);
        rawPixels = null; // free after recognition is done

        // Phase 19A/19B: accumulate per-page confidence stats + attempt count
        var pageConf = pageResult.confidence;
        DT().log('ocr-v4-page', {
          page:     i,
          conf:     pageConf,
          attempts: pageResult.attempts,
          skipPrep: pageResult.skippedPreprocess,
        });
        totalConf += pageConf;
        confPages++;
        if (pageConf < minConf) minConf = pageConf;
        if (pageConf > maxConf) maxConf = pageConf;

        allLines.push('=== Page ' + i + ' ===\n' + pageResult.text);

        await ProgressStore.save('ocr', fHash, {
          pagesDone: i, totalPages: total, lines: allLines.slice(),
        });

        var pct = 25 + Math.round((i / total) * 55);
        onStep(2, 'active', pct, 'Page ' + i + ' of ' + total);

        // Phase 19A: GC hint in strict-streaming OR low-memory mode (not just strict)
        var lowMem = (typeof memTier === 'function' && memTier() === 'low');
        if ((strictStream || lowMem) && typeof gc === 'function') { try { gc(); } catch (_) {} }
      }
    } finally {
      try { await worker.terminate(); } catch (_) {}
      await pdf.destroy();      // Phase 2: full destroy before revoking source
      pdfSource.cleanup();      // Safe to revoke OPFS blob URL now
      await ProgressStore.clear('ocr', fHash);
      // Phase 19A: immediately reclaim preprocessor worker memory post-OCR
      if (window.WorkerPool && window.WorkerPool.terminatePool) {
        try { window.WorkerPool.terminatePool(OCR_PREPROCESSOR_URL); } catch (_) {}
      }
    }

    var pagesProcessed = allLines.length;
    var avgConf = confPages > 0 ? Math.round(totalConf / confPages) : 0;
    DT().log('ocr-v4-complete', {
      pages:         pagesProcessed,
      avgConfidence: avgConf,
      minConfidence: confPages > 0 ? minConf : 0,
      maxConfidence: confPages > 0 ? maxConf : 0,
      adaptiveScale: scale !== baseScale,
      batchYield:    OCR_BATCH_YIELD,
    });

    onStep(2, 'done', 80);
    onStep(3, 'active', 84, 'Building document\u2026');

    var ocrPages = allLines.map(function (lineStr, idx) {
      var text       = lineStr.replace(/^=== Page \d+ ===\n?/, '').trim();
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

    // Final fallback: plain text
    var ocrTxtBlob = new Blob([allLines.join('\n\n').trim()], { type: 'text/plain;charset=utf-8' });
    onStep(3, 'done', 100);
    return { blob: ocrTxtBlob, filename: brandedFilename(file.name, '.txt') };
  };

  // ── PHASE 20C: ALPHA EDGE SMOOTHER ───────────────────────────────────────
  // Applies a 3×3 box-blur to transitional alpha pixels only (50–220 range).
  // Fully opaque (>220) and fully transparent (<50) pixels are left alone so
  // the sharp object boundaries stay clean while jagged staircase edges caused
  // by threshold-based segmentation are softened.
  // Input / output: raw RGBA ArrayBuffer; returns a new ArrayBuffer.
  // Phase 25B: Two-pass Gaussian edge smoother — replaces basic 3×3 box blur.
  // Pass 1: 5×5 Gaussian-weighted kernel on uncertain edge pixels (alpha 10–245).
  // Pass 2: Gentle 3×3 cleanup pass to remove residual staircasing artifacts.
  // Only the alpha channel is modified — RGB pixel colors are never touched.
  function _smoothAlphaEdges(pixelsBuf, w, h) {
    var rgba = new Uint8ClampedArray(pixelsBuf);
    var out  = new Uint8ClampedArray(rgba.length);
    out.set(rgba);
    var G5 = [1,4,7,4,1, 4,16,26,16,4, 7,26,41,26,7, 4,16,26,16,4, 1,4,7,4,1];
    for (var y = 2; y < h - 2; y++) {
      for (var x = 2; x < w - 2; x++) {
        var ai   = (y * w + x) * 4 + 3;
        var curA = rgba[ai];
        if (curA > 245 || curA < 10) continue;
        var sum = 0, wt = 0, k = 0;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var g = G5[k++];
            sum += rgba[((y + dy) * w + (x + dx)) * 4 + 3] * g;
            wt  += g;
          }
        }
        out[ai] = Math.round(sum / wt);
      }
    }
    var out2 = new Uint8ClampedArray(out);
    for (var y2 = 1; y2 < h - 1; y2++) {
      for (var x2 = 1; x2 < w - 1; x2++) {
        var ai2  = (y2 * w + x2) * 4 + 3;
        var curA2 = out[ai2];
        if (curA2 > 245 || curA2 < 10) continue;
        var sum2 = curA2 * 4 +
          out[ai2 - 4] + out[ai2 + 4] +
          out[ai2 - w * 4] + out[ai2 + w * 4];
        out2[ai2] = Math.round(sum2 / 8);
      }
    }
    return out2.buffer;
  }

  // ─── BACKGROUND REMOVER v3.0 (Confidence-Based Foreground Preservation) ─────
  // Accepts: qualityMode ('fast'|'hd'|'ultra'), subjectMode ('auto'|'portrait'|'product'|'logo'),
  //          bgColor ('transparent'|'#rrggbb'|'white'|'black'|'gradient-blue'|'gradient-warm')
  // Uses v3.0 worker: 5-factor confidence scoring, conservative BFS, color-weighted feathering
  processors['background-remover'] = async function (files, opts, onStep) {
    var file        = files[0];
    var qualityMode = (opts && opts.qualityMode) || 'hd';
    var subjectMode = (opts && opts.subjectMode) || 'auto';
    var bgColor     = (opts && opts.bgColor)     || 'transparent';
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

    var cvs = document.createElement('canvas');
    cvs.width = drawW; cvs.height = drawH;
    var ctx = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0, drawW, drawH);
    img = null;

    var imageData = ctx.getImageData(0, 0, drawW, drawH);
    var threshold = Math.max(50, Math.min(255, parseInt((opts && opts.threshold) || '235', 10)));

    onStep(1, 'done', 35);
    onStep(2, 'active', 40, 'Processing image\u2026');

    var rawBuffer = imageData.data.buffer.slice(0);
    imageData = null;

    DT().log('bg-remover-start', {
      width: drawW, height: drawH, threshold: threshold,
      qualityMode: qualityMode, subjectMode: subjectMode, bgColor: bgColor,
    });

    function _sampleHasAlpha(pixelsBuf) {
      var samp = new Uint8ClampedArray(pixelsBuf, 0, Math.min(pixelsBuf.byteLength, 40000));
      var step = Math.max(1, Math.floor(samp.length / (4 * 500)));
      for (var ai = 3; ai < samp.length; ai += 4 * step) {
        if (samp[ai] < 200) return true;
      }
      return false;
    }

    var wResult   = null;
    var _hasAlpha = false;

    // Pass 1: v3.0 worker — confidence-based foreground preservation
    try {
      wResult = await runAdvancedWorker(
        { op: 'remove-bg', pixels: rawBuffer, width: drawW, height: drawH,
          threshold: threshold, qualityMode: qualityMode, subjectMode: subjectMode },
        [rawBuffer]
      );
    } catch (bgWorkerErr) {
      DT().error('bg-remover-worker', bgWorkerErr);
      onStep(2, 'active', 45, 'Processing image\u2026');
      var fbBuf = cvs.getContext('2d').getImageData(0, 0, drawW, drawH).data.buffer.slice(0);
      wResult = removeBgInline(fbBuf, drawW, drawH, threshold);
      fbBuf = null;
    }
    rawBuffer = null;

    if (wResult && wResult.pixels instanceof ArrayBuffer) {
      _hasAlpha = _sampleHasAlpha(wResult.pixels);
      DT().validate('bg-remover-alpha', { attempt: 1, hasTransparent: _hasAlpha, threshold: threshold });
    }

    // Pass 2: relax threshold by 30 + escalate to ultra quality if still no alpha
    if (!_hasAlpha) {
      DT().log('bg-remover-retry', { reason: 'no_alpha', pass: 2 });
      onStep(2, 'active', 56, 'Refining result\u2026');
      var relaxThresh = Math.max(50, threshold - 30);
      var retryBuf    = cvs.getContext('2d').getImageData(0, 0, drawW, drawH).data.buffer.slice(0);
      try {
        var retryWRes = await runAdvancedWorker(
          { op: 'remove-bg', pixels: retryBuf, width: drawW, height: drawH,
            threshold: relaxThresh, qualityMode: 'ultra', subjectMode: subjectMode },
          [retryBuf]
        );
        retryBuf = null;
        if (retryWRes && retryWRes.pixels instanceof ArrayBuffer) {
          _hasAlpha = _sampleHasAlpha(retryWRes.pixels);
          DT().validate('bg-remover-alpha', { attempt: 2, hasTransparent: _hasAlpha, threshold: relaxThresh });
          if (_hasAlpha) { wResult = retryWRes; DT().log('bg-remover-retry-ok', { threshold: relaxThresh }); }
        }
      } catch (_retErr) {
        retryBuf = null;
        var fallbackBuf = cvs.getContext('2d').getImageData(0, 0, drawW, drawH).data.buffer.slice(0);
        var fallbackRes = removeBgInline(fallbackBuf, drawW, drawH, relaxThresh);
        fallbackBuf = null;
        if (fallbackRes && fallbackRes.pixels instanceof ArrayBuffer) {
          _hasAlpha = _sampleHasAlpha(fallbackRes.pixels);
          if (_hasAlpha) wResult = fallbackRes;
        }
      }
    }

    if (!wResult || !(wResult.pixels instanceof ArrayBuffer)) {
      DT().error('bg-remover-result', 'no pixels in output after all attempts');
      throw AEError(ERR.WORKER, 'bg_remove_failed');
    }
    if (!_hasAlpha) {
      DT().error('bg-remover-no-alpha', { attempts: 2 });
      throw new Error('No background detected. Please try with an image that has a solid or uniform background.');
    }

    onStep(2, 'done', 80);
    onStep(3, 'active', 83, 'Saving result\u2026');

    var outW = wResult.width, outH = wResult.height;
    var finalPixels = wResult.pixels;
    try {
      var smoothed = _smoothAlphaEdges(wResult.pixels, outW, outH);
      if (smoothed && smoothed.byteLength === wResult.pixels.byteLength) {
        finalPixels = smoothed;
        DT().log('bg-remover-smooth', { pixels: smoothed.byteLength });
      }
    } catch (smoothErr) {
      DT().log('bg-remover-smooth-skip', { err: String(smoothErr).slice(0, 40) });
    }
    wResult = null;

    safeCanvasCleanup(cvs); cvs = null;

    var blob;
    var filename = brandedFilename(file.name, '.png');
    var outCvs = document.createElement('canvas');
    try {
      outCvs.width  = outW;
      outCvs.height = outH;
      var outCtx  = outCvs.getContext('2d');
      var outData = outCtx.createImageData(outW, outH);
      outData.data.set(new Uint8ClampedArray(finalPixels));
      finalPixels = null;
      outCtx.putImageData(outData, 0, 0);
      outData = null;

      if (bgColor && bgColor !== 'transparent') {
        var bgCvs = document.createElement('canvas');
        try {
          bgCvs.width  = outW;
          bgCvs.height = outH;
          var bgCtx = bgCvs.getContext('2d');
          if (bgColor === 'gradient-blue') {
            var grd1 = bgCtx.createLinearGradient(0, 0, outW, outH);
            grd1.addColorStop(0, '#1a56db'); grd1.addColorStop(1, '#4f46e5');
            bgCtx.fillStyle = grd1;
          } else if (bgColor === 'gradient-warm') {
            var grd2 = bgCtx.createLinearGradient(0, 0, outW, outH);
            grd2.addColorStop(0, '#f59e0b'); grd2.addColorStop(1, '#ef4444');
            bgCtx.fillStyle = grd2;
          } else {
            bgCtx.fillStyle = bgColor;
          }
          bgCtx.fillRect(0, 0, outW, outH);
          bgCtx.drawImage(outCvs, 0, 0);
          var isJpegBg = !bgColor.startsWith('gradient');
          var exportMime = isJpegBg ? 'image/jpeg' : 'image/png';
          blob = await new Promise(function (res, rej) {
            bgCvs.toBlob(function (b) {
              if (b && b.size > 0) res(b);
              else rej(AEError(ERR.WORKER, 'canvas_export_empty'));
            }, exportMime, 0.92);
          });
          filename = brandedFilename(file.name, isJpegBg ? '.jpg' : '.png');
        } finally {
          safeCanvasCleanup(bgCvs);
        }
      } else {
        blob = await new Promise(function (res, rej) {
          outCvs.toBlob(function (b) {
            if (b && b.size > 0) res(b);
            else rej(AEError(ERR.WORKER, 'canvas_export_empty'));
          }, 'image/png');
        });
      }
    } finally {
      safeCanvasCleanup(outCvs);
    }

    onStep(3, 'done', 100);
    return {
      blob:     blob,
      filename: filename,
      _quality: { hasTransparent: _hasAlpha, qualityMode: qualityMode, subjectMode: subjectMode },
    };
  };

  // ── PHASE 20A: PDF RAW BYTE RECOVERY SCANNER ─────────────────────────────
  // Emergency diagnostic for severely corrupted PDFs where pdfjs / pdf-lib
  // both fail.  Scans raw bytes for structural markers to estimate how much
  // of the file is recoverable, then returns a report used by the repair
  // processor to choose between a "partially recovered" message and a hard
  // "too damaged" error.
  //
  // Algorithm:
  //   1. Locate %PDF- header  — confirms this is a real PDF
  //   2. Count obj / endobj pairs (matched) — each is a recoverable object
  //   3. Count stream / endstream pairs  — each is a page/resource stream
  //   4. Search for /Type /Page markers  — estimates page count
  //   5. Check xref + trailer presence  — structural completeness signals
  //
  // Scans at most 8 MB of the file for speed (covers most corrupt cases).
  function _repairRawByteScan(buf) {
    var report = {
      hasPdfHeader:   false,
      headerVersion:  null,
      objPairs:       0,
      streamPairs:    0,
      xrefFound:      false,
      trailerFound:   false,
      estimatedPages: 0,
      confidence:     0,   // 0–1: fraction of expected structure found
      scanBytes:      0,
    };
    try {
      var bytes   = new Uint8Array(buf);
      var len     = bytes.length;
      report.scanBytes = len;

      // Helper: find ASCII string in byte array (coarse scan, no RegExp)
      function findStr(str, startOff, maxSearch) {
        var target = [];
        for (var ci = 0; ci < str.length; ci++) target.push(str.charCodeAt(ci));
        var end = Math.min(len, startOff + (maxSearch || len));
        outer: for (var i = startOff; i < end - target.length + 1; i++) {
          for (var j = 0; j < target.length; j++) {
            if (bytes[i + j] !== target[j]) continue outer;
          }
          return i;
        }
        return -1;
      }

      // 1. PDF header (first 1 KB)
      var hdrPos = findStr('%PDF-', 0, 1024);
      if (hdrPos >= 0) {
        report.hasPdfHeader = true;
        var vStart = hdrPos + 5, vEnd = Math.min(vStart + 5, len), vStr = '';
        for (var vi = vStart; vi < vEnd; vi++) {
          var vc = bytes[vi];
          if (vc === 10 || vc === 13) break;
          vStr += String.fromCharCode(vc);
        }
        report.headerVersion = vStr.trim().slice(0, 5);
      } else {
        return report; // Not a PDF — nothing to recover
      }

      // 2. Count structural markers (scan up to 8 MB)
      var scanEnd = Math.min(len, 8 * 1024 * 1024);
      var objCount = 0, endobjCount = 0, streamCount = 0, endstreamCount = 0;
      for (var si = 0; si < scanEnd - 9; si++) {
        var b = bytes[si];
        if (b === 111 && bytes[si+1] === 98 && bytes[si+2] === 106) { // "obj"
          var pre = si > 0 ? bytes[si-1] : 32;
          if (pre === 32 || pre === 10 || pre === 13) objCount++;
        } else if (b === 101 && bytes[si+1] === 110 && bytes[si+2] === 100) { // "end…"
          if (bytes[si+3] === 111) endobjCount++;    // "endobj"
          if (bytes[si+3] === 115) endstreamCount++; // "endstream"
        } else if (b === 115 && bytes[si+1] === 116 && bytes[si+2] === 114 &&
                   bytes[si+3] === 101 && bytes[si+4] === 97  && bytes[si+5] === 109) { // "stream"
          var spre = si > 0 ? bytes[si-1] : 32;
          if (spre === 10 || spre === 13 || spre === 32) streamCount++;
        }
      }
      report.objPairs    = Math.min(objCount, endobjCount);
      report.streamPairs = Math.min(streamCount, endstreamCount);

      // 3. xref / trailer presence
      report.xrefFound    = findStr('xref',    0, scanEnd) >= 0;
      report.trailerFound = findStr('trailer', 0, scanEnd) >= 0;

      // 4. Estimate page count via /Type /Page markers (up to 4 MB)
      var pageCount = 0, peEnd = Math.min(len, 4 * 1024 * 1024);
      for (var pi = 0; pi < peEnd - 14; pi++) {
        if (bytes[pi]    === 47  && bytes[pi+1]  === 84  && bytes[pi+2]  === 121 &&
            bytes[pi+3]  === 112 && bytes[pi+4]  === 101 && bytes[pi+5]  === 32  &&
            bytes[pi+6]  === 47  && bytes[pi+7]  === 80  && bytes[pi+8]  === 97  &&
            bytes[pi+9]  === 103 && bytes[pi+10] === 101 && bytes[pi+11] !== 115) { // /Type /Page (not /Pages)
          pageCount++;
        }
      }
      report.estimatedPages = pageCount;

      // 5. Confidence composite
      var conf = 0;
      if (report.hasPdfHeader)    conf += 0.25;
      if (report.objPairs    > 0) conf += 0.25;
      if (report.streamPairs > 0) conf += 0.20;
      if (report.xrefFound)       conf += 0.15;
      if (report.trailerFound)    conf += 0.15;
      report.confidence = Math.min(1, conf);

      DT().log('repair-raw-scan', {
        version:    report.headerVersion,
        objPairs:   report.objPairs,
        streams:    report.streamPairs,
        xref:       report.xrefFound,
        trailer:    report.trailerFound,
        pages:      report.estimatedPages,
        confidence: report.confidence.toFixed(2),
        scannedMB:  (scanEnd / 1048576).toFixed(1),
      });
    } catch (scanErr) {
      DT().log('repair-raw-scan-err', { err: String(scanErr).slice(0, 60) });
    }
    return report;
  }

  // ─── REPAIR (Phase 20A: raw-byte scan + confidence tracking) ────────────
  processors['repair'] = async function (files, opts, onStep) {
    var file = files[0];
    onStep(0, 'active', 8, 'Preparing your file\u2026');

    var buf = null;
    try {
      buf = await file.arrayBuffer();
    } catch (loadErr) {
      DT().error('repair-load', loadErr);
      throw new Error('The file is too large to load. Please try a smaller file.');
    }
    onStep(0, 'done', 18);
    onStep(1, 'active', 22, 'Checking integrity\u2026');

    // Phase 20A: pre-scan the raw bytes to record baseline structural confidence.
    // We keep a copy of the scan report so that if both repair passes fail we can
    // give a precise error message instead of a generic one.
    var rawScan = null;
    try {
      rawScan = _repairRawByteScan(buf);
      DT().log('repair-prescan', {
        hasPdf:     rawScan.hasPdfHeader,
        version:    rawScan.headerVersion,
        confidence: rawScan.confidence.toFixed(2),
        estPages:   rawScan.estimatedPages,
      });
    } catch (_) {}

    // Hard-reject files that don't look like PDFs at all (no %PDF- header)
    if (rawScan && !rawScan.hasPdfHeader) {
      throw new Error('This file does not appear to be a valid PDF. Please check that you uploaded the correct file.');
    }

    var resultBuf  = null;
    var repairPass = 0;

    // Phase 20A: confidence tracking — record pass results for diagnostics
    var repairLog = [];

    // v5: Multi-pass repair — try progressively deeper passes (up to 2)
    try {
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
              repairLog.push({ pass: repairPass, ok: true, size: resultBuf.byteLength });
              DT().log('repair-pass-ok', { pass: repairPass, size: resultBuf.byteLength });
            } else {
              repairLog.push({ pass: repairPass, ok: false, reason: 'empty_result' });
            }
          }
        } catch (repairErr) {
          repairLog.push({ pass: repairPass, ok: false, reason: String(repairErr).slice(0, 60) });
          DT().error('repair-pass-' + repairPass, repairErr);
        }
      }
    } finally {
      buf = null; // Phase 20F: guaranteed release
    }

    if (!resultBuf) {
      // Phase 20A: use scan confidence to choose the right error path
      if (rawScan && rawScan.confidence < 0.30) {
        // Very little recoverable structure — nothing to fall back to
        DT().error('repair-unrecoverable', { confidence: rawScan.confidence, log: repairLog });
        throw new Error(
          'This PDF appears to be severely damaged (less than 30% recoverable structure detected). ' +
          'It may not be possible to recover this file.'
        );
      }
      // Some structure remains — try browser-tools.js repairPdf as last resort
      DT().log('repair-fallback-orig', { confidence: rawScan ? rawScan.confidence : 'n/a', log: repairLog });
      throw new Error(ERR.ORIG);
    }

    DT().result('repair-passes', { passes: repairLog, rawConfidence: rawScan ? rawScan.confidence : 'n/a' });

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
      // Phase 21: OCR fallback for scanned documents — if text is sparse, use Tesseract
      var _cmpChars = pages.join('').replace(/\s/g, '').length;
      DT().log('compare-extract', { file: file.name, chars: _cmpChars, pages: pages.length });
      if (_cmpChars < 30) {
        DT().log('compare-ocr-trigger', { file: file.name, reason: 'sparse_text', chars: _cmpChars });
        try {
          var ocrCPages = await autoOcrFallback(file, onStep, base, 1);
          if (ocrCPages.length > 0) {
            pages = ocrCPages.map(function (p) { return p.text || ''; });
            DT().log('compare-ocr-result', { file: file.name, chars: pages.join('').length });
          }
        } catch (_) {}
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

    // Phase 24: Set worker priority tier for all WorkerPool.run() calls made
    // by this tool's processor (runAdvancedWorker / runPdfWorker both read
    // _currentWorkerPriority).  Reset in finally to avoid bleed-over.
    var _prevPriority = _currentWorkerPriority;
    _currentWorkerPriority = _TOOL_PRIORITY[toolId] || 'normal';
    DT().log('runTool-priority', { toolId: toolId, priority: _currentWorkerPriority });

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
      'background-remover': { threshold: 200, qualityMode: 'ultra' },
      'compress':           { _retryDeep: true },
    };
    var _canRetry    = !!_SMART_RETRY_OPTS[toolId];
    var _maxAttempts = _canRetry ? 2 : 1;
    var result       = null;

    var _onStep = function (idx, state, pct, hint) { LiveFeed.update(idx, state, pct, hint); };

    try { // Phase 24: priority reset guard — wraps entire retry loop

    for (var _attempt = 1; _attempt <= _maxAttempts; _attempt++) {
      var _curOpts = (_attempt === 1)
        ? (opts || {})
        : Object.assign({}, opts || {}, _SMART_RETRY_OPTS[toolId] || {});

      if (_attempt > 1) {
        DT().log('smart-retry-v54', { toolId: toolId, attempt: _attempt, opts: Object.keys(_SMART_RETRY_OPTS[toolId] || {}) });
        // Neutral UX message — Stealth Mode (never expose internals)
        LiveFeed.update(1, 'active', 38,
          _attempt === 2
            ? (typeof window.t === 'function' ? window.t('steps.improving_result') : 'Improving result\u2026')
            : (typeof window.t === 'function' ? window.t('steps.optimizing_output') : 'Optimizing output\u2026'));
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
          LiveFeed.update(1, 'active', 30, (typeof window.t === 'function' ? window.t('steps.preparing_content') : 'Preparing content\u2026'));
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
          LiveFeed.update(1, 'active', 40, (typeof window.t === 'function' ? window.t('steps.optimizing_output') : 'Optimizing output\u2026'));
          result = null;
          continue;
        }
        LiveFeed.hide(); vanish();
        throw new Error('The output quality was too low to be useful. Please try with a clearer or higher-quality file.');
      }

      break; // success — exit retry loop
    }

    } finally {
      // Phase 24: always restore priority tier — prevents bleed into the next
      // tool invocation if this one threw, was cancelled, or hit ERR.ORIG.
      _currentWorkerPriority = _prevPriority;
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
      // Phase 7J: record processing start + capture forensics on failures
      var _p7started = Date.now();
      try {
        var _p7Srx = window.RuntimeSessionRecorder;
        if (_p7Srx && typeof _p7Srx.record === 'function') {
          _p7Srx.record('ae_process_start', {
            tool: toolId,
            advanced: ADVANCED_IDS.has(toolId),
          });
        }
      } catch (_) {}

      var _p7Result;
      try {
        if (ADVANCED_IDS.has(toolId)) {
          _p7Result = await runTool(toolId, files, opts, origProcess);
        } else {
          _p7Result = await origProcess(toolId, files, opts);
        }
      } catch (err) {
        // Phase 7J: forensics snapshot + incident report + security stream on AE errors
        try {
          var _p7Ctx = {
            tool: toolId,
            error: (err && err.message || 'unknown').slice(0, 120),
            aeType: err && err.aeType,
            elapsed: Date.now() - _p7started,
          };
          var _p7Rf2 = window.RuntimeForensics;
          if (_p7Rf2 && typeof _p7Rf2.snapshot === 'function') {
            _p7Rf2.snapshot('ae-error', _p7Ctx);
          }
          var _p7Sr3 = window.RuntimeSessionRecorder;
          if (_p7Sr3 && typeof _p7Sr3.record === 'function') {
            _p7Sr3.record('ae_process_error', _p7Ctx);
          }
          // Raise incident only for worker/timeout failures — not user-facing rejections
          var _errType = (err && err.aeType) || '';
          if (_errType === 'WORKER_ERROR' || _errType === 'TIMEOUT_ERROR' || _errType === 'MEMORY_ERROR') {
            var _p7Inc2 = window.RuntimeIncidentEngine;
            if (_p7Inc2 && typeof _p7Inc2.report === 'function') {
              var _sev = _errType === 'TIMEOUT_ERROR' ? 50 : _errType === 'WORKER_ERROR' ? 55 : 40;
              _p7Inc2.report('ae-' + _errType.toLowerCase(), _sev, 'advanced-engine', _p7Ctx);
            }
            var _p7Ss4 = window.RuntimeSecurityStream;
            if (_p7Ss4 && typeof _p7Ss4.push === 'function') {
              _p7Ss4.push('ae-failure', 'advanced-engine', 'WARN',
                'AdvancedEngine error: ' + toolId + ' / ' + _errType, _p7Ctx);
            }
          }
        } catch (_) {}
        throw err; // re-throw so caller sees the original error
      }

      // Phase 7J: record success
      try {
        var _p7SrDone = window.RuntimeSessionRecorder;
        if (_p7SrDone && typeof _p7SrDone.record === 'function') {
          _p7SrDone.record('ae_process_done', {
            tool: toolId,
            elapsed: Date.now() - _p7started,
            outputBytes: (_p7Result && _p7Result.blob) ? _p7Result.blob.size : null,
          });
        }
      } catch (_) {}

      return _p7Result;
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
    version:              '5.7',
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

      console.group('AdvancedEngine v5.7 — Audit Report (Phase 7J)');
      console.log('Version: 5.7 (Phase 24 — Priority Routing + Background Queue | Phase 7J — Security Integration)');
      console.log('Tools registered:', tools.length, tools);
      console.log('DebugTrace entries:', entries.length,
        '| errors:', errors.length, '| results:', results.length, '| validates:', validates.length);

      // Phase 7J: Phase 7 systems health summary
      console.group('Phase 7 Security Systems');
      var _p7Systems = [
        'RuntimeHumanSignals', 'RuntimeAutomationDetection', 'RuntimeBehaviorAnalysis',
        'RuntimeWorkerMesh', 'RuntimeWorkerAuth', 'RuntimeWorkerEncryption', 'RuntimeWorkerRouting',
        'RuntimeIncidentEngine', 'RuntimeForensics', 'RuntimeSessionRecorder',
        'RuntimeSecurityStream', 'RuntimeSecurityDashboard',
        'RuntimeExecutionCrypto', 'RuntimeSessionKeys', 'RuntimePacketIntegrity',
        'RuntimeDeploymentRegistry', 'RuntimeBuildChain', 'RuntimeReleaseChannel',
        'RuntimeEdgeRuntime', 'RuntimeEdgePolicy', 'RuntimeEdgeProof',
        'RuntimeWasmMesh', 'RuntimeWasmScheduler', 'RuntimeWasmAttestation',
      ];
      var _p7Loaded = 0, _p7Missing = [];
      _p7Systems.forEach(function (name) {
        if (window[name]) { _p7Loaded++; }
        else { _p7Missing.push(name); }
      });
      console.log('P7 systems loaded:', _p7Loaded + '/' + _p7Systems.length);
      if (_p7Missing.length) console.warn('Not yet loaded:', _p7Missing);

      // Behavior analysis summary
      try {
        var _ba = window.RuntimeBehaviorAnalysis;
        if (_ba) {
          console.log('BehaviorAnalysis — risk:', _ba.getRiskLevel(), '| score:', _ba.getHealthScore());
        }
      } catch (_) {}

      // Worker mesh summary
      try {
        var _wm = window.RuntimeWorkerMesh;
        if (_wm) console.log('WorkerMesh health:', JSON.stringify(_wm.getMeshHealth()));
      } catch (_) {}

      // Incident engine summary
      try {
        var _ie = window.RuntimeIncidentEngine;
        if (_ie) console.log('IncidentEngine:', JSON.stringify(_ie.getSummary()));
      } catch (_) {}

      // Automation detection summary
      try {
        var _adx = window.RuntimeAutomationDetection;
        if (_adx) console.log('AutomationDetection — score:', _adx.getScore(), '| automated:', _adx.isAutomated());
      } catch (_) {}

      // Forensics snapshot count
      try {
        var _rf = window.RuntimeForensics;
        if (_rf) console.log('Forensics — snapshots:', _rf.listSnapshots ? _rf.listSnapshots().length : 'n/a');
      } catch (_) {}

      // Session recorder status
      try {
        var _srx = window.RuntimeSessionRecorder;
        if (_srx && _srx.status) console.log('SessionRecorder:', JSON.stringify(_srx.status()));
      } catch (_) {}

      console.groupEnd(); // Phase 7 Security Systems

      // v5.4: Input Intelligence Engine tracking
      var inputIntelChecks = entries.filter(function (e) {
        return e.key === 'input-intelligence' || e.key === 'input-intelligence-magic' || e.key === 'input-intelligence-scan';
      });
      console.log('Input Intelligence checks:', inputIntelChecks.length);
      var magicChecks = entries.filter(function (e) { return e.key === 'input-intelligence-magic'; });
      var magicTypes = magicChecks.map(function(e) { return (e.data || {}).detected; }).filter(Boolean);
      if (magicTypes.length) console.log('File types detected:', magicTypes.join(', '));

      // OCR v4 tracking (Phase 19A)
      var ocrV4Starts = entries.filter(function (e) { return e.key === 'ocr-v4-start'; });
      var ocrV4Done   = entries.filter(function (e) { return e.key === 'ocr-v4-complete'; });
      var ocrV2Starts = entries.filter(function (e) { return e.key === 'ocr-v2-start'; });
      var ocrV2Done   = entries.filter(function (e) { return e.key === 'ocr-v2-done'; });
      var ocrNative   = ocrV2Done.filter(function(e) { return (e.data||{}).method === 'native-only'; });
      var ocrAdaptive = ocrV4Done.filter(function(e) { return (e.data||{}).adaptiveScale; });
      console.log('OCR v4 runs:', ocrV4Starts.length,
        '| adaptive-scale:', ocrAdaptive.length,
        '| avg-conf:', ocrV4Done.length ? Math.round(ocrV4Done.reduce(function(s,e){return s+((e.data||{}).avgConfidence||0);},0)/ocrV4Done.length) + '%' : 'n/a');
      console.log('OCR v2 (autoOcr) runs:', ocrV2Starts.length,
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

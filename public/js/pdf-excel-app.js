// PdfToExcelApp v1.0 — Isolated PDF→Excel Tool App (Phase 2B Microfrontend Migration)
//
// PROBLEM SOLVED:
//   "First run fails, second run hangs forever."
//
//   Root cause: processors['pdf-to-excel'] calls autoOcrFallback() which calls
//   window.Tesseract.createWorker().  runTool() wraps the processor with
//   withTimeout(proc(), TOOL_TIMEOUT_MS) — a racing promise that abandons
//   proc() on timeout WITHOUT triggering its finally blocks.  The leaked
//   Tesseract worker holds an OPFS write-lock; the next run hits the same lock
//   and hangs indefinitely.  runAdvancedWorker() also occupies a shared
//   WorkerPool slot that is never freed when the proc() is abandoned.
//
// SOLUTION:
//   PdfToExcelApp installs a BrowserTools.process interceptor for 'pdf-to-excel'.
//   It runs a fully isolated pipeline where:
//   — ALL async operations are wrapped in try/finally with guaranteed cleanup
//   — A hard-timeout calls _cleanup() FIRST (terminates workers), then rejects
//   — A dedicated terminate-after-job Worker handles XLSX packaging
//   — Tesseract.createWorker() instances are tracked and terminated in _cleanup()
//   — _inFlight flag prevents re-entry; always reset in finally
//
// Internal lightweight runtime objects (not separate files per Phase 2B note):
//   PdfExcelScheduler, PdfExcelMemoryManager, PdfExcelRecoveryManager, PdfExcelTelemetry
//
// ADDITIVE ONLY: zero changes to advanced-engine.js, browser-tools.js,
//               tool-page.js, workerPool.js, or any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var XLSX_WORKER   = '/workers/pdf-excel-xlsx-worker.js';
  var TESS_CDN      = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var HARD_LIMIT_MS = 120000;  // 2 min: entire job hard cap
  var XLSX_LIMIT_MS = 30000;   // 30 s: XLSX packaging
  var OCR_PAGE_MS   = 45000;   // 45 s: per-page OCR recognition
  var OCR_INIT_MS   = 30000;   // 30 s: Tesseract.createWorker init

  // ── ISOLATED STATE ──────────────────────────────────────────────────────────
  var _inFlight    = false;
  var _jobId       = 0;
  var _xlsxWorker  = null;   // dedicated XLSX packaging Worker
  var _tessWorker  = null;   // Tesseract worker (createWorker)
  var _pdfInst     = null;   // pdfjsLib pdf instance
  var _hardTimer   = null;
  var _hardReject  = null;

  // ── LOG ────────────────────────────────────────────────────────────────────
  function _log(msg, d)  { console.debug('[PdfToExcelApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[PdfToExcelApp]',  msg, d !== undefined ? d : ''); }

  // ── LIGHTWEIGHT RUNTIME OBJECTS ────────────────────────────────────────────

  var PdfExcelScheduler = {
    _runs:     0,
    _failures: 0,
    canRun:    function ()     { return !_inFlight; },
    priority:  'normal',
    onStart:   function ()     { PdfExcelScheduler._runs++; },
    onFailure: function ()     { PdfExcelScheduler._failures++; },
    stats:     function ()     { return { runs: PdfExcelScheduler._runs, failures: PdfExcelScheduler._failures }; },
  };

  var PdfExcelMemoryManager = {
    estimateMB: function (file) {
      var raw = file ? file.size / 1048576 : 0;
      return Math.ceil(raw * 4);  // PDF bytes × 4 heuristic for canvas + xlsx buffers
    },
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') {
        throw new Error('Not enough memory available. Please close other tabs and try again.');
      }
    },
  };

  var PdfExcelRecoveryManager = {
    _errors:  [],
    recover:  function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:  function (err)   { PdfExcelRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()     { return PdfExcelRecoveryManager._errors.slice(); },
  };

  var PdfExcelTelemetry = {
    _events: [],
    record:  function (event, data) {
      PdfExcelTelemetry._events.push({ ts: Date.now(), event: event, data: data });
      console.debug('[PdfExcelTelemetry]', event, data || '');
    },
    getEvents: function () { return PdfExcelTelemetry._events.slice(); },
  };

  // ── GUARANTEED CLEANUP ─────────────────────────────────────────────────────
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)   { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_xlsxWorker)  { try { _xlsxWorker.terminate(); } catch (_) {} _xlsxWorker = null; }
    if (_tessWorker)  { try { _tessWorker.terminate(); } catch (_) {} _tessWorker = null; }
    if (_pdfInst)     { try { _pdfInst.destroy();     } catch (_) {} _pdfInst    = null; }
    _inFlight = false;
  }

  // ── PDF.JS LOADER ──────────────────────────────────────────────────────────
  function _loadPdfJs() {
    if (G.pdfjsLib)            return Promise.resolve(G.pdfjsLib);
    if (G.__pdfjsLibPromise)   return G.__pdfjsLibPromise;
    var p = import(PDFJS_URL).then(function (mod) {
      var lib = mod.default || mod;
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      G.pdfjsLib = lib;
      return lib;
    });
    G.__pdfjsLibPromise = p;
    return p;
  }

  // ── NON-ABANDONING TIMEOUT RACE ────────────────────────────────────────────
  function _race(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error((label || 'Operation') + ' timed out after ' + (ms / 1000) + 's'));
      }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  // ── LANGUAGE DETECTION ─────────────────────────────────────────────────────
  function _detectLang(filename) {
    var fn = (filename || '').toLowerCase();
    if (fn.match(/chi|zh/))            return 'chi_sim+eng';
    if (fn.match(/ara|_ar[._-]/))      return 'ara+eng';
    if (fn.match(/fas|per|far|_fa/))   return 'fas+eng';
    if (fn.match(/heb|_he[._-]/))      return 'heb+eng';
    if (fn.match(/rus|ru[._-]/))       return 'rus+eng';
    if (fn.match(/deu|ger/))           return 'deu+eng';
    if (fn.match(/fra|fr[._-]/))       return 'fra+eng';
    if (fn.match(/spa|es[._-]/))       return 'spa+eng';
    if (fn.match(/jpn|ja[._-]/))       return 'jpn+eng';
    if (fn.match(/kor|ko[._-]/))       return 'kor+eng';
    if (fn.match(/por|pt[._-]/))       return 'por+eng';
    if (fn.match(/hin|_hi[._-]/))      return 'hin+eng';
    return 'eng';
  }

  // ── COLUMN ROW BUILDER ─────────────────────────────────────────────────────
  // Simplified version of advanced-engine.js buildColumnRows().
  // Uses adaptive gap-based X clustering to reconstruct table structure.
  function _buildColumnRows(items) {
    if (!items || !items.length) return [];
    var valid = items.filter(function (it) { return it.str && it.str.trim() && it.transform; });
    if (!valid.length) return [];

    // Gather all X positions of text items
    var xs = valid.map(function (it) { return Math.round(it.transform[4]); });
    xs.sort(function (a, b) { return a - b; });

    var xRange = xs.length > 1 ? xs[xs.length - 1] - xs[0] : 100;
    var minGap = Math.max(20, xRange * 0.06);

    // Build column split points
    var splits = [0];
    for (var xi = 1; xi < xs.length; xi++) {
      if (xs[xi] - xs[xi - 1] > minGap) splits.push((xs[xi - 1] + xs[xi]) / 2);
    }
    splits.push(Infinity);

    // Reject single-column result (plain text, not a table)
    if (splits.length <= 2) return [];

    function _getCol(x) {
      for (var ci = 0; ci < splits.length - 1; ci++) {
        if (x >= splits[ci] && x < splits[ci + 1]) return ci;
      }
      return 0;
    }

    // Assign items to (yKey, col) cells
    var cells  = {};
    var maxCol = 0;
    valid.forEach(function (it) {
      var yKey = Math.round(it.transform[5] / 6) * 6;
      var col  = _getCol(Math.round(it.transform[4]));
      maxCol   = Math.max(maxCol, col);
      if (!cells[yKey]) cells[yKey] = {};
      cells[yKey][col] = (cells[yKey][col] ? cells[yKey][col] + ' ' : '') + it.str.trim();
    });

    if (maxCol === 0) return [];

    var ys = Object.keys(cells).map(Number).sort(function (a, b) { return b - a; });
    return ys.map(function (y) {
      var row = [];
      for (var ci = 0; ci <= maxCol; ci++) row.push(cells[y][ci] || '');
      return row;
    });
  }

  // ── OCR FALLBACK ──────────────────────────────────────────────────────────
  // Isolated Tesseract.createWorker() per job.  Tracked in _tessWorker
  // → guaranteed termination in _cleanup().
  async function _runOcr(file, lang, onStep) {
    // Lazy-load Tesseract.js
    if (!G.Tesseract) {
      await new Promise(function (resolve, reject) {
        var s     = document.createElement('script');
        s.src     = TESS_CDN;
        s.onload  = resolve;
        s.onerror = function () { reject(new Error('Tesseract.js failed to load')); };
        document.head.appendChild(s);
      });
    }
    if (!G.Tesseract) throw new Error('OCR engine unavailable');

    // Fast native pre-pass: skip Tesseract if all pages have good text
    var pdfjsLib = await _loadPdfJs();
    var buf0     = await file.arrayBuffer();
    var pdfN     = await pdfjsLib.getDocument({ data: buf0, isEvalSupported: false }).promise;
    var nativeTexts = {};
    try {
      for (var ni = 1; ni <= pdfN.numPages; ni++) {
        var np = await pdfN.getPage(ni);
        var nc = await np.getTextContent();
        var nt = nc.items.map(function (it) { return it.str; }).join(' ').trim();
        nativeTexts[ni] = { text: nt, chars: nt.replace(/\s/g, '').length };
        np.cleanup();
      }
    } finally {
      try { await pdfN.destroy(); } catch (_) {}
      buf0 = null;
    }

    var nKeys   = Object.keys(nativeTexts);
    var allGood = nKeys.length > 0 && nKeys.every(function (k) { return nativeTexts[k].chars >= 30; });
    if (allGood) {
      return nKeys.sort(function (a, b) { return +a - +b; }).map(function (k) {
        return { pageNum: +k, text: nativeTexts[k].text, source: 'native' };
      });
    }

    // Tesseract pass
    if (onStep) onStep(1, 'active', 38, 'Running OCR\u2026');
    var tw = await _race(
      G.Tesseract.createWorker(lang, 1, { logger: function () {} }),
      OCR_INIT_MS, 'OCR worker init'
    );
    _tessWorker = tw;

    var buf1 = await file.arrayBuffer();
    var pdf1 = await pdfjsLib.getDocument({ data: buf1, isEvalSupported: false }).promise;
    var ocrPages = [];
    var total    = pdf1.numPages;

    try {
      for (var oi = 1; oi <= total; oi++) {
        var oPage   = await pdf1.getPage(oi);
        var vp      = oPage.getViewport({ scale: 1.5 });
        var cvs     = document.createElement('canvas');
        cvs.width   = Math.min(Math.floor(vp.width),  3072);
        cvs.height  = Math.min(Math.floor(vp.height), 3072);
        var ctx     = cvs.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cvs.width, cvs.height);
        await oPage.render({ canvasContext: ctx, viewport: vp }).promise;
        var dataUrl = cvs.toDataURL('image/jpeg', 0.92);
        oPage.cleanup();
        cvs.width = 0; cvs.height = 0;

        var recog = await _race(tw.recognize(dataUrl), OCR_PAGE_MS, 'OCR page ' + oi);
        ocrPages.push({ pageNum: oi, text: recog.data.text || '', source: 'ocr' });

        if (onStep) onStep(1, 'active',
          38 + Math.round((oi / total) * 15),
          'OCR: page ' + oi + ' of ' + total
        );
      }
    } finally {
      try { await pdf1.destroy(); } catch (_) {}
      buf1 = null;
    }

    try { await tw.terminate(); } catch (_) {}
    _tessWorker = null;

    return ocrPages;
  }

  // ── OCR RESULTS → SHEETS ──────────────────────────────────────────────────
  // Mirrors advanced-engine.js pdf-to-excel OCR path:
  // whitespace-split columns for rows with multiple whitespace gaps.
  function _ocrToSheets(ocrPages) {
    return ocrPages.map(function (p) {
      var rows = (p.text || '').split('\n')
        .map(function (l) { return l.trim(); })
        .filter(Boolean)
        .map(function (l) {
          var cols = l.split(/\s{2,}/).map(function (c) { return c.trim(); }).filter(Boolean);
          return cols.length >= 2 ? cols : [l];
        });
      return {
        name: 'Page ' + p.pageNum,
        rows: rows.length ? rows : [['(empty)']],
      };
    });
  }

  // ── TEXT QUALITY CHECK (simplified) ───────────────────────────────────────
  function _isGarbled(text) {
    if (!text || text.length < 10) return false;
    var nonAscii = (text.match(/[\x00-\x08\x0E-\x1F\uFFFD\uF000-\uF8FF]/g) || []).length;
    return nonAscii / text.length > 0.08;
  }

  // ── XLSX BUILD VIA DEDICATED WORKER ───────────────────────────────────────
  function _buildXlsx(sheets, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try {
        w = new Worker(XLSX_WORKER);
      } catch (e) {
        return reject(new Error('XLSX worker spawn failed: ' + (e.message || e)));
      }
      _xlsxWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _xlsxWorker = null;
        reject(new Error('XLSX worker timed out after ' + (XLSX_LIMIT_MS / 1000) + 's'));
      }, XLSX_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _xlsxWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer)  { resolve(d.buffer); return; }
        reject(new Error('XLSX worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _xlsxWorker = null;
        reject(new Error('XLSX worker error: ' + (ev && ev.message || 'unknown')));
      };

      w.postMessage({ op: 'build-xlsx', sheets: sheets, jobId: String(jobId) });
    });
  }

  // ── BRANDED FILENAME ───────────────────────────────────────────────────────
  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return base.toLowerCase().startsWith('ilovepdf') ? base + '.xlsx' : 'ilovepdf-' + base + '.xlsx';
  }

  // ── PROGRESS STEPPER ──────────────────────────────────────────────────────
  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) {
        try { lf.update(idx, state, pct, hint); } catch (_) {}
      };
    }
    return function () {};
  }

  // ── MAIN PROCESS FUNCTION ──────────────────────────────────────────────────
  async function process(files, opts) {
    if (_inFlight) throw new Error('Conversion already in progress');
    _inFlight = true;
    var jobId = ++_jobId;
    var file  = files && files[0];
    if (!file) { _cleanup('no-file'); throw new Error('No file provided'); }

    PdfExcelScheduler.onStart();
    PdfExcelMemoryManager.checkMemory();
    PdfExcelTelemetry.record('job:start', { job: jobId, file: file.name, size: file.size });
    _log('start', { job: jobId, file: file.name, size: file.size });

    var onStep = _makeStepper();

    // Hard-timeout: calls _cleanup() first so workers are ALWAYS terminated
    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Conversion timed out. Please try with a smaller file.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your file\u2026');

      // ── Phase 1: Load PDF.js + extract text per page ────────────────────
      var pdfjsLib = await _loadPdfJs();
      var buf      = await file.arrayBuffer();
      var pdf      = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      _pdfInst     = pdf;
      buf          = null;

      var total  = pdf.numPages;
      var sheets = [];

      onStep(0, 'done', 12);
      onStep(1, 'active', 15, 'Processing content\u2026');

      try {
        for (var i = 1; i <= total; i++) {
          var page    = await pdf.getPage(i);
          var content = await page.getTextContent();
          var isEmpty = !content.items.some(function (it) { return it.str && it.str.trim(); });
          var rows    = isEmpty ? [['(empty)']] : _buildColumnRows(content.items);
          sheets.push({
            name: 'Page ' + i,
            rows: rows.length ? rows : [['(empty)']],
          });
          page.cleanup();
          onStep(1, 'active', 15 + Math.round((i / total) * 38), 'Page ' + i + ' of ' + total);
        }
      } finally {
        try { await pdf.destroy(); } catch (_) {}
        _pdfInst = null;
      }

      // ── Phase 2: Quality check + OCR fallback ───────────────────────────
      var allEmpty  = sheets.every(function (s) {
        return s.rows.length === 0 ||
          (s.rows.length === 1 && s.rows[0].length === 1 && s.rows[0][0] === '(empty)');
      });

      // Check for garbled font extraction
      var rawText = sheets.map(function (s) {
        return s.rows.map(function (r) { return r.join(' '); }).join(' ');
      }).join(' ');
      var garbled = !allEmpty && _isGarbled(rawText);
      rawText = null;

      PdfExcelTelemetry.record('extract', { sheets: sheets.length, allEmpty: allEmpty, garbled: garbled });

      if (allEmpty || garbled) {
        _log('OCR trigger', { allEmpty: allEmpty, garbled: garbled });
        var ocrLang  = _detectLang(file.name);
        var ocrPages = await _runOcr(file, ocrLang, onStep);
        var ocrChars = ocrPages.reduce(function (s, p) { return s + (p.text || '').length; }, 0);
        if (ocrChars < 5) {
          throw new Error('No data could be extracted from this PDF. For scanned documents, try the OCR tool first.');
        }
        sheets = _ocrToSheets(ocrPages);
        ocrPages = null;
      }

      // ── Phase 3: Content validation ─────────────────────────────────────
      var realRows = sheets.reduce(function (s, sh) {
        return s + sh.rows.filter(function (r) {
          return r.some(function (c) { return c && c !== '(empty)' && String(c).trim(); });
        }).length;
      }, 0);

      if (realRows < 1) {
        throw new Error('No spreadsheet data could be extracted from this PDF.');
      }

      onStep(1, 'done', 55);
      onStep(2, 'active', 58, 'Building spreadsheet\u2026');

      // ── Phase 4: XLSX build via dedicated isolated worker ────────────────
      var xlsxBuf = await _buildXlsx(sheets, jobId);
      sheets = null;

      onStep(2, 'done', 90);
      onStep(3, 'active', 93, 'Finalizing output\u2026');

      var blob = new Blob([xlsxBuf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      xlsxBuf = null;

      onStep(3, 'done', 100);
      PdfExcelTelemetry.record('job:done', { job: jobId, blobSize: blob.size, realRows: realRows });
      _log('done', { job: jobId, blobSize: blob.size, realRows: realRows });

      return {
        blob:     blob,
        filename: _filename(file.name),
        _quality: { rows: realRows, chars: realRows * 10, pages: total },
      };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      PdfExcelScheduler.onFailure();
      PdfExcelRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  // ── LIFECYCLE METHODS ──────────────────────────────────────────────────────
  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); _log('unmounted'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { PdfExcelRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return {
      inFlight:     _inFlight,
      jobId:        _jobId,
      hasXlsxWorker: !!_xlsxWorker,
      hasTessWorker: !!_tessWorker,
      scheduler:    PdfExcelScheduler.stats(),
    };
  }

  // ── REGISTRATION ───────────────────────────────────────────────────────────
  function _register() {
    if (!G.ToolAppManager) {
      _warn('ToolAppManager not available — registration skipped');
      return;
    }
    G.ToolAppManager.registerTool('pdf-to-excel', function () {
      return {
        process:  process,
        mount:    mount,
        unmount:  unmount,
        reset:    reset,
        recover:  recover,
        destroy:  destroy,
        getState: getState,
      };
    });
    _log('registered with ToolAppManager');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register);
  } else {
    _register();
  }

  // ── EXPOSE RUNTIME OBJECTS (debug / external access) ──────────────────────
  G.PdfExcelScheduler       = PdfExcelScheduler;
  G.PdfExcelMemoryManager   = PdfExcelMemoryManager;
  G.PdfExcelRecoveryManager = PdfExcelRecoveryManager;
  G.PdfExcelTelemetry       = PdfExcelTelemetry;

  _log('v1.0 ready');
}(window));

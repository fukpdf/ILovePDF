// OCRToolApp v1.0 — Isolated OCR Tool App (Phase 2B Microfrontend Migration)
//
// PROBLEM SOLVED:
//   "First run fails, second run hangs forever."
//
//   Root cause: processors['ocr'] creates window.Tesseract.createWorker() and
//   calls runAdvancedWorker({op:'build-docx'}) which takes a shared WorkerPool
//   slot.  runTool()'s withTimeout() races the inner proc() promise — on timeout
//   it abandons proc() WITHOUT triggering its finally blocks.  The leaked
//   Tesseract worker holds an OPFS write-lock.  The shared WorkerPool slot is
//   never freed.  Next run: hits the same OPFS write-lock → hangs forever.
//
// SOLUTION:
//   OCRToolApp installs a BrowserTools.process interceptor for 'ocr' ONLY.
//   Fully isolated pipeline with:
//   — ALL async operations in try/finally with guaranteed cleanup
//   — Hard-timeout calls _cleanup() FIRST (terminates workers), then rejects
//   — Dedicated terminate-after-job Worker for DOCX packaging (reuses
//     /workers/pdf-word-docx-worker.js — already serves PdfToWordApp)
//   — Tesseract.createWorker() tracked and terminated in _cleanup()
//   — _inFlight flag prevents re-entry; always reset in finally
//
// Internal lightweight runtime objects:
//   OCRScheduler, OCRMemoryManager, OCRRecoveryManager, OCRTelemetry
//
// NOTE: scan-to-pdf processor throws ERR.ORIG immediately (delegates to browser-
//       tools.js fallback), does NOT hold any Tesseract worker, so it is NOT
//       intercepted here — its original behavior is preserved unchanged.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var DOCX_WORKER   = '/workers/pdf-word-docx-worker.js';
  var TESS_CDN      = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var HARD_LIMIT_MS = 300000;  // 5 min: OCR on large docs can be slow
  var DOCX_LIMIT_MS = 30000;   // 30 s: DOCX packaging
  var OCR_PAGE_MS   = 60000;   // 60 s: per-page OCR recognition (generous for large pages)
  var OCR_INIT_MS   = 30000;   // 30 s: Tesseract.createWorker init

  // ── ISOLATED STATE ──────────────────────────────────────────────────────────
  var _inFlight    = false;
  var _jobId       = 0;
  var _docxWorker  = null;   // dedicated DOCX packaging Worker
  var _tessWorker  = null;   // Tesseract worker
  var _pdfInst     = null;   // pdfjsLib pdf instance
  var _hardTimer   = null;
  var _hardReject  = null;

  // ── LOG ────────────────────────────────────────────────────────────────────
  function _log(msg, d)  { console.debug('[OCRToolApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[OCRToolApp]',  msg, d !== undefined ? d : ''); }

  // ── LIGHTWEIGHT RUNTIME OBJECTS ────────────────────────────────────────────

  var OCRScheduler = {
    _runs:     0,
    _failures: 0,
    canRun:    function ()   { return !_inFlight; },
    priority:  'high',
    onStart:   function ()   { OCRScheduler._runs++; },
    onFailure: function ()   { OCRScheduler._failures++; },
    stats:     function ()   { return { runs: OCRScheduler._runs, failures: OCRScheduler._failures }; },
  };

  var OCRMemoryManager = {
    estimateMB: function (file) {
      var raw = file ? file.size / 1048576 : 0;
      // OCR: PDF bytes × 6 heuristic (Tesseract model + canvas buffer + DOCX output)
      return Math.ceil(raw * 6);
    },
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') {
        throw new Error('Not enough memory available. Please close other tabs and try again.');
      }
    },
  };

  var OCRRecoveryManager = {
    _errors:   [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { OCRRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return OCRRecoveryManager._errors.slice(); },
  };

  var OCRTelemetry = {
    _events: [],
    record:  function (event, data) {
      OCRTelemetry._events.push({ ts: Date.now(), event: event, data: data });
      console.debug('[OCRTelemetry]', event, data || '');
    },
    getEvents: function () { return OCRTelemetry._events.slice(); },
  };

  // ── GUARANTEED CLEANUP ─────────────────────────────────────────────────────
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)   { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_docxWorker)  { try { _docxWorker.terminate(); } catch (_) {} _docxWorker = null; }
    if (_tessWorker)  { try { _tessWorker.terminate(); } catch (_) {} _tessWorker = null; }
    if (_pdfInst)     { try { _pdfInst.destroy();     } catch (_) {} _pdfInst    = null; }
    _inFlight = false;
  }

  // ── PDF.JS LOADER ──────────────────────────────────────────────────────────
  function _loadPdfJs() {
    if (G.pdfjsLib)          return Promise.resolve(G.pdfjsLib);
    if (G.__pdfjsLibPromise) return G.__pdfjsLibPromise;
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
  function _detectLang(filename, nativeText) {
    var fn = (filename || '').toLowerCase();
    if (fn.match(/chi|zh/))             return 'chi_sim+eng';
    if (fn.match(/ara|_ar[._-]/))       return 'ara+eng';
    if (fn.match(/fas|per|far|_fa/))    return 'fas+eng';
    if (fn.match(/heb|_he[._-]/))       return 'heb+eng';
    if (fn.match(/rus|ru[._-]/))        return 'rus+eng';
    if (fn.match(/deu|ger/))            return 'deu+eng';
    if (fn.match(/fra|fr[._-]/))        return 'fra+eng';
    if (fn.match(/spa|es[._-]/))        return 'spa+eng';
    if (fn.match(/jpn|ja[._-]/))        return 'jpn+eng';
    if (fn.match(/kor|ko[._-]/))        return 'kor+eng';
    if (fn.match(/por|pt[._-]/))        return 'por+eng';
    if (fn.match(/hin|_hi[._-]/))       return 'hin+eng';

    // Try to detect from native text if available
    if (nativeText && nativeText.length >= 20) {
      var t = nativeText;
      if (/[\u0600-\u06FF]/.test(t))   return 'ara+eng';
      if (/[\u0400-\u04FF]/.test(t))   return 'rus+eng';
      if (/[\u4E00-\u9FFF]/.test(t))   return 'chi_sim+eng';
      if (/[\u3040-\u309F\u30A0-\u30FF]/.test(t)) return 'jpn+eng';
      if (/[\uAC00-\uD7AF]/.test(t))   return 'kor+eng';
    }
    return 'eng';
  }

  // ── DOCX BUILD VIA DEDICATED WORKER ───────────────────────────────────────
  // Reuses /workers/pdf-word-docx-worker.js (already serves PdfToWordApp).
  function _buildDocx(pages, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try {
        w = new Worker(DOCX_WORKER);
      } catch (e) {
        return reject(new Error('DOCX worker spawn failed: ' + (e.message || e)));
      }
      _docxWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _docxWorker = null;
        reject(new Error('DOCX worker timed out after ' + (DOCX_LIMIT_MS / 1000) + 's'));
      }, DOCX_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _docxWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer)  { resolve(d.buffer); return; }
        reject(new Error('DOCX worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _docxWorker = null;
        reject(new Error('DOCX worker error: ' + (ev && ev.message || 'unknown')));
      };

      w.postMessage({ op: 'build-docx', pages: pages, jobId: String(jobId) });
    });
  }

  // ── BRANDED FILENAME ───────────────────────────────────────────────────────
  function _filename(orig, ext) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    var e    = ext || '.docx';
    return base.toLowerCase().startsWith('ilovepdf') ? base + e : 'ilovepdf-' + base + e;
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

    OCRScheduler.onStart();
    OCRMemoryManager.checkMemory();
    OCRTelemetry.record('job:start', { job: jobId, file: file.name, size: file.size });
    _log('start', { job: jobId, file: file.name, size: file.size });

    var onStep = _makeStepper();
    var userLang = (opts && opts.language) || null;

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('OCR timed out. Please try with a smaller or fewer-page document.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your file\u2026');

      // ── Phase 1: Load PDF.js + native text probe ─────────────────────────
      var pdfjsLib = await _loadPdfJs();
      var buf      = await file.arrayBuffer();
      var pdf      = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      _pdfInst     = pdf;
      buf          = null;

      var total      = pdf.numPages;
      var nativeText = '';
      var nativeChars = 0;

      onStep(0, 'done', 12);
      onStep(1, 'active', 15, 'Analyzing document structure\u2026');

      // Probe native text layer
      try {
        for (var ni = 1; ni <= total; ni++) {
          var np = await pdf.getPage(ni);
          var nc = await np.getTextContent();
          var t  = nc.items.map(function (it) { return it.str; }).join(' ');
          nativeText  += t + '\n';
          nativeChars += t.replace(/\s/g, '').length;
          np.cleanup();
        }
      } catch (_) {}

      // ── Fast path: document already has a text layer ─────────────────────
      if (nativeChars > 60) {
        _log('fast-path', { nativeChars: nativeChars });
        OCRTelemetry.record('path', { type: 'native', chars: nativeChars });

        try { await pdf.destroy(); } catch (_) {}
        _pdfInst = null;

        onStep(1, 'done', 50, 'Content ready');
        onStep(2, 'active', 60, 'Building document\u2026');

        var nativeLines = nativeText.split('\n');
        var nativeParas = nativeLines
          .filter(function (l) { return l.trim(); })
          .map(function (l) { return { text: l.trim(), isHeading: false }; });

        var nativeDocPages = [{
          pageNum:    1,
          paragraphs: nativeParas.length ? nativeParas : [{ text: nativeText.trim(), isHeading: false }],
        }];

        try {
          var nBuf = await _buildDocx(nativeDocPages, jobId);
          var nBlob = new Blob([nBuf], {
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          });
          onStep(2, 'done', 90);
          onStep(3, 'active', 93, 'Preparing result\u2026');
          onStep(3, 'done', 100);
          OCRTelemetry.record('job:done', { job: jobId, blobSize: nBlob.size, path: 'native' });
          return { blob: nBlob, filename: _filename(file.name, '.docx') };
        } catch (_) {
          // DOCX build failed — fall back to plain text
          var nTxtBlob = new Blob([nativeText.trim()], { type: 'text/plain;charset=utf-8' });
          onStep(2, 'done', 90);
          onStep(3, 'active', 93, 'Preparing result\u2026');
          onStep(3, 'done', 100);
          OCRTelemetry.record('job:done', { job: jobId, path: 'native-txt-fallback' });
          return { blob: nTxtBlob, filename: _filename(file.name, '.txt') };
        }
      }

      // ── OCR path: document is image-based ───────────────────────────────
      OCRTelemetry.record('path', { type: 'tesseract', nativeChars: nativeChars });
      onStep(1, 'done', 22);
      onStep(2, 'active', 25, 'Processing content\u2026');

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

      var lang = userLang || _detectLang(file.name, nativeText);
      nativeText = null;

      // Initialize Tesseract worker (isolated per job)
      var tw = await _race(
        G.Tesseract.createWorker(lang, 1, { logger: function () {} }),
        OCR_INIT_MS, 'OCR worker init'
      );
      _tessWorker = tw;

      // Reload PDF for rendering (original buf was null'd)
      var buf2 = await file.arrayBuffer();
      var pdf2 = await pdfjsLib.getDocument({ data: buf2, isEvalSupported: false }).promise;
      var allLines  = [];
      var totalConf = 0;
      var confPages = 0;

      try {
        for (var i = 1; i <= total; i++) {
          // Batch yield every 5 pages to keep browser responsive
          if (i > 1 && (i - 1) % 5 === 0) {
            await new Promise(function (r) { setTimeout(r, 0); });
          }

          var pg = await pdf2.getPage(i);

          // Check if this page has content
          var pgContent = await pg.getTextContent();
          var pgIsBlank = !pgContent.items.some(function (it) { return it.str && it.str.trim(); });
          if (pgIsBlank) {
            pg.cleanup();
            allLines.push('=== Page ' + i + ' ===\n(no content)');
            continue;
          }

          // Render page to canvas
          var scale   = 1.5;
          var vp      = pg.getViewport({ scale: scale });
          var capW    = Math.min(Math.floor(vp.width),  3072);
          var capH    = Math.min(Math.floor(vp.height), 3072);
          var capScale = scale * Math.min(capW / vp.width, capH / vp.height);
          var capVp   = pg.getViewport({ scale: capScale });

          var rawPixels = null;
          var cvs = null;
          try {
            cvs         = document.createElement('canvas');
            cvs.width   = Math.floor(capVp.width);
            cvs.height  = Math.floor(capVp.height);
            var ctx     = cvs.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, cvs.width, cvs.height);
            await pg.render({ canvasContext: ctx, viewport: capVp }).promise;
            pg.cleanup();
            rawPixels = cvs.toDataURL('image/jpeg', 0.90);
          } finally {
            if (cvs) { cvs.width = 0; cvs.height = 0; cvs = null; }
          }

          if (!rawPixels) {
            allLines.push('=== Page ' + i + ' ===\n(render failed)');
            continue;
          }

          var recog    = await _race(tw.recognize(rawPixels), OCR_PAGE_MS, 'OCR page ' + i);
          rawPixels    = null;
          var pageText = ((recog.data && recog.data.text) || '').trim();
          var pageConf = (recog.data && typeof recog.data.confidence === 'number')
            ? recog.data.confidence : 0;

          allLines.push('=== Page ' + i + ' ===\n' + pageText);
          totalConf += pageConf;
          confPages++;

          OCRTelemetry.record('page', { page: i, conf: pageConf, chars: pageText.length });

          var pct = 25 + Math.round((i / total) * 55);
          onStep(2, 'active', pct, 'Page ' + i + ' of ' + total);
        }
      } finally {
        try { await tw.terminate(); } catch (_) {}
        _tessWorker = null;
        try { await pdf2.destroy(); } catch (_) {}
        buf2 = null;
      }

      var avgConf = confPages > 0 ? Math.round(totalConf / confPages) : 0;
      _log('ocr-complete', { pages: allLines.length, avgConf: avgConf });
      OCRTelemetry.record('ocr-done', { pages: allLines.length, avgConf: avgConf });

      onStep(2, 'done', 80);
      onStep(3, 'active', 84, 'Building document\u2026');

      // Convert allLines to structured pages for DOCX builder
      var ocrDocPages = allLines.map(function (lineStr, idx) {
        var text       = lineStr.replace(/^=== Page \d+ ===\n?/, '').trim();
        var paragraphs = text.split('\n').filter(Boolean).map(function (ln) {
          return { text: ln.trim(), isHeading: false };
        });
        if (!paragraphs.length) paragraphs = [{ text: '(no content)', isHeading: false }];
        return { pageNum: idx + 1, paragraphs: paragraphs };
      });

      // Try to build DOCX; fall back to plain text on failure
      try {
        var ocrBuf  = await _buildDocx(ocrDocPages, jobId);
        var ocrBlob = new Blob([ocrBuf], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        onStep(3, 'done', 100);
        OCRTelemetry.record('job:done', { job: jobId, blobSize: ocrBlob.size, path: 'tesseract-docx' });
        return { blob: ocrBlob, filename: _filename(file.name, '.docx') };
      } catch (_) {}

      var ocrTxtBlob = new Blob([allLines.join('\n\n').trim()], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);
      OCRTelemetry.record('job:done', { job: jobId, path: 'tesseract-txt-fallback' });
      return { blob: ocrTxtBlob, filename: _filename(file.name, '.txt') };
    })();

    // Cleanup PDF instance if still open (should be null'd inside, but safety net)
    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      OCRScheduler.onFailure();
      OCRRecoveryManager.onError(err);
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
  function recover()  { OCRRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return {
      inFlight:      _inFlight,
      jobId:         _jobId,
      hasDocxWorker: !!_docxWorker,
      hasTessWorker: !!_tessWorker,
      scheduler:     OCRScheduler.stats(),
    };
  }

  // ── REGISTRATION ───────────────────────────────────────────────────────────
  function _register() {
    if (!G.ToolAppManager) {
      _warn('ToolAppManager not available — registration skipped');
      return;
    }
    G.ToolAppManager.registerTool('ocr', function () {
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
    _log('registered with ToolAppManager for ocr');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _register);
  } else {
    _register();
  }

  // ── EXPOSE RUNTIME OBJECTS ─────────────────────────────────────────────────
  G.OCRScheduler       = OCRScheduler;
  G.OCRMemoryManager   = OCRMemoryManager;
  G.OCRRecoveryManager = OCRRecoveryManager;
  G.OCRTelemetry       = OCRTelemetry;

  _log('v1.0 ready');
}(window));

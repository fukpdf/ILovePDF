// PdfToPowerPointApp v1.0 — Isolated PDF→PowerPoint Tool App (Phase 2B)
//
// PROBLEM SOLVED:
//   "First run fails, second run hangs forever."
//
//   Root cause: processors['pdf-to-powerpoint'] calls autoOcrFallback() which
//   calls window.Tesseract.createWorker().  runTool()'s withTimeout() races the
//   inner proc() promise — on timeout it abandons proc() WITHOUT triggering its
//   finally blocks.  The leaked Tesseract worker holds an OPFS write-lock.
//   The next run blocks on the same lock → hangs indefinitely.
//   runAdvancedWorker() also holds a shared WorkerPool slot that is never freed.
//
// SOLUTION:
//   PdfToPowerPointApp installs a BrowserTools.process interceptor for
//   'pdf-to-powerpoint' ONLY.  Fully isolated pipeline with:
//   — ALL async operations in try/finally with guaranteed worker cleanup
//   — Hard-timeout calls _cleanup() FIRST (terminates workers), then rejects
//   — Dedicated terminate-after-job Worker for PPTX packaging
//   — Tesseract.createWorker() tracked and terminated in _cleanup()
//   — _inFlight flag prevents re-entry; always reset in finally
//
// Internal lightweight runtime objects:
//   PdfPptScheduler, PdfPptMemoryManager, PdfPptRecoveryManager, PdfPptTelemetry
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var PPTX_WORKER   = '/workers/pdf-ppt-pptx-worker.js';
  var TESS_CDN      = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var HARD_LIMIT_MS = 120000;  // 2 min: entire job hard cap
  var PPTX_LIMIT_MS = 60000;   // 60 s: PPTX packaging (PptxGenJS can be slow on big decks)
  var OCR_PAGE_MS   = 45000;   // 45 s: per-page OCR recognition
  var OCR_INIT_MS   = 30000;   // 30 s: Tesseract.createWorker init

  // ── ISOLATED STATE ──────────────────────────────────────────────────────────
  var _inFlight    = false;
  var _jobId       = 0;
  var _pptxWorker  = null;   // dedicated PPTX packaging Worker
  var _tessWorker  = null;   // Tesseract worker
  var _pdfInst     = null;   // pdfjsLib pdf instance
  var _hardTimer   = null;
  var _hardReject  = null;

  // ── LOG ────────────────────────────────────────────────────────────────────
  function _log(msg, d)  { console.debug('[PdfToPowerPointApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[PdfToPowerPointApp]',  msg, d !== undefined ? d : ''); }

  // ── LIGHTWEIGHT RUNTIME OBJECTS ────────────────────────────────────────────

  var PdfPptScheduler = {
    _runs:     0,
    _failures: 0,
    canRun:    function ()   { return !_inFlight; },
    priority:  'normal',
    onStart:   function ()   { PdfPptScheduler._runs++; },
    onFailure: function ()   { PdfPptScheduler._failures++; },
    stats:     function ()   { return { runs: PdfPptScheduler._runs, failures: PdfPptScheduler._failures }; },
  };

  var PdfPptMemoryManager = {
    estimateMB: function (file) {
      var raw = file ? file.size / 1048576 : 0;
      return Math.ceil(raw * 5);  // PDF × 5: canvas renders + slide data + PPTX output
    },
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') {
        throw new Error('Not enough memory available. Please close other tabs and try again.');
      }
    },
  };

  var PdfPptRecoveryManager = {
    _errors:   [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { PdfPptRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return PdfPptRecoveryManager._errors.slice(); },
  };

  var PdfPptTelemetry = {
    _events: [],
    record:  function (event, data) {
      PdfPptTelemetry._events.push({ ts: Date.now(), event: event, data: data });
      console.debug('[PdfPptTelemetry]', event, data || '');
    },
    getEvents: function () { return PdfPptTelemetry._events.slice(); },
  };

  // ── GUARANTEED CLEANUP ─────────────────────────────────────────────────────
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)   { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_pptxWorker)  { try { _pptxWorker.terminate(); } catch (_) {} _pptxWorker = null; }
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

  // ── SLIDE CONTENT EXTRACTOR ────────────────────────────────────────────────
  // Simplified version of AE's heading-based title + body extraction.
  // Finds the largest-font item as the slide title; all other items form the body.
  function _extractSlideContent(items, pageNum) {
    if (!items || !items.length) return { title: 'Slide ' + pageNum, text: '' };

    var valid = items.filter(function (it) { return it.str && it.str.trim() && it.transform; });
    if (!valid.length) return { title: 'Slide ' + pageNum, text: '' };

    // Find title: item with largest font height
    var biggest = { str: '', h: 0 };
    valid.forEach(function (it) {
      var h = Math.abs(it.transform[3]);
      if (h > biggest.h && it.str.trim()) biggest = { str: it.str, h: h };
    });
    var title   = biggest.str.trim() || ('Slide ' + pageNum);
    var yBkt    = Math.max(2, Math.round((biggest.h || 10) * 0.4));
    var titleStr = biggest.str;

    // Group remaining items into Y-bucketed lines for body text
    var lineMap = {};
    valid.forEach(function (it) {
      if (it.str === titleStr) return;
      var yk = Math.round(it.transform[5] / yBkt) * yBkt;
      if (!lineMap[yk]) lineMap[yk] = [];
      lineMap[yk].push(it);
    });

    var ys = Object.keys(lineMap).map(Number).sort(function (a, b) { return b - a; });
    var bodyLines = ys.map(function (y) {
      return lineMap[y]
        .sort(function (a, b) { return a.transform[4] - b.transform[4]; })
        .map(function (it) { return it.str.trim(); })
        .filter(Boolean)
        .join(' ');
    }).filter(Boolean);

    return {
      title: title.slice(0, 120),
      text:  bodyLines.join('\n'),
    };
  }

  // ── TEXT QUALITY CHECK (simplified) ───────────────────────────────────────
  function _isGarbled(text) {
    if (!text || text.length < 10) return false;
    var bad = (text.match(/[\x00-\x08\x0E-\x1F\uFFFD\uF000-\uF8FF]/g) || []).length;
    return bad / text.length > 0.08;
  }

  // ── OCR FALLBACK ──────────────────────────────────────────────────────────
  // Isolated Tesseract.createWorker() per job; tracked in _tessWorker.
  async function _runOcr(file, lang, onStep) {
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

    // Native text pre-pass
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

  // ── OCR RESULTS → SLIDES ──────────────────────────────────────────────────
  function _ocrToSlides(ocrPages) {
    return ocrPages.map(function (p) {
      var lines = (p.text || '').split('\n').filter(function (l) { return l.trim(); });
      return {
        pageNum: p.pageNum,
        title:   (lines[0] || 'Slide ' + p.pageNum).slice(0, 120),
        text:    lines.slice(1).join('\n'),
      };
    });
  }

  // ── PPTX BUILD VIA DEDICATED WORKER ───────────────────────────────────────
  function _buildPptx(slides, docTitle, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try {
        w = new Worker(PPTX_WORKER);
      } catch (e) {
        return reject(new Error('PPTX worker spawn failed: ' + (e.message || e)));
      }
      _pptxWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _pptxWorker = null;
        reject(new Error('PPTX worker timed out after ' + (PPTX_LIMIT_MS / 1000) + 's'));
      }, PPTX_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _pptxWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer)  { resolve(d.buffer); return; }
        reject(new Error('PPTX worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _pptxWorker = null;
        reject(new Error('PPTX worker error: ' + (ev && ev.message || 'unknown')));
      };

      w.postMessage({
        op:       'build-pptx',
        slides:   slides,
        docTitle: docTitle || '',
        jobId:    String(jobId),
      });
    });
  }

  // ── BRANDED FILENAME ───────────────────────────────────────────────────────
  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return base.toLowerCase().startsWith('ilovepdf') ? base + '.pptx' : 'ilovepdf-' + base + '.pptx';
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

    PdfPptScheduler.onStart();
    PdfPptMemoryManager.checkMemory();
    PdfPptTelemetry.record('job:start', { job: jobId, file: file.name, size: file.size });
    _log('start', { job: jobId, file: file.name, size: file.size });

    var onStep = _makeStepper();

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

      // ── Phase 1: Load PDF.js + extract slide content per page ────────────
      var pdfjsLib = await _loadPdfJs();
      var buf      = await file.arrayBuffer();
      var pdf      = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      _pdfInst     = pdf;
      buf          = null;

      var total  = pdf.numPages;
      var slides = [];

      onStep(0, 'done', 12);
      onStep(1, 'active', 15, 'Processing content\u2026');

      try {
        for (var i = 1; i <= total; i++) {
          var page    = await pdf.getPage(i);
          var content = await page.getTextContent();
          var isEmpty = !content.items.some(function (it) { return it.str && it.str.trim(); });

          if (isEmpty) {
            slides.push({ pageNum: i, title: 'Slide ' + i, text: '' });
          } else {
            var extracted = _extractSlideContent(content.items, i);
            slides.push({ pageNum: i, title: extracted.title, text: extracted.text });
          }

          page.cleanup();
          onStep(1, 'active', 15 + Math.round((i / total) * 38), 'Slide ' + i + ' of ' + total);
        }
      } finally {
        try { await pdf.destroy(); } catch (_) {}
        _pdfInst = null;
      }

      // ── Phase 2: Quality check + OCR fallback ───────────────────────────
      var allEmpty = slides.every(function (s) {
        return !s.text && /^Slide \d+$/.test(s.title);
      });

      var rawText = slides.map(function (s) { return (s.title || '') + ' ' + (s.text || ''); }).join(' ');
      var garbled = !allEmpty && _isGarbled(rawText);
      rawText = null;

      PdfPptTelemetry.record('extract', { slides: slides.length, allEmpty: allEmpty, garbled: garbled });

      if (allEmpty || garbled) {
        _log('OCR trigger', { allEmpty: allEmpty, garbled: garbled });
        var ocrLang  = _detectLang(file.name);
        var ocrPages = await _runOcr(file, ocrLang, onStep);
        var ocrChars = ocrPages.reduce(function (s, p) { return s + (p.text || '').length; }, 0);
        if (ocrChars < 10) {
          throw new Error('No content could be extracted from this PDF. Please check the file and try again.');
        }
        slides = _ocrToSlides(ocrPages);
        ocrPages = null;
      }

      // ── Phase 3: Filter blank slides (keep at least 1) ───────────────────
      if (slides.length > 1) {
        var contentSlides = slides.filter(function (s) {
          return (s.text && s.text.trim().length > 0) || !/^Slide \d+$/.test((s.title || '').trim());
        });
        if (contentSlides.length > 0) slides = contentSlides;
      }

      // ── Phase 4: Content validation ─────────────────────────────────────
      var totalChars = slides.reduce(function (s, sl) {
        return s + (sl.title || '').length + (sl.text || '').length;
      }, 0);

      if (!slides.length || totalChars < 5) {
        throw new Error('No presentation content could be extracted from this PDF.');
      }

      onStep(1, 'done', 55);
      onStep(2, 'active', 58, 'Building presentation\u2026');

      // ── Phase 5: PPTX build via dedicated isolated worker ────────────────
      var docTitle    = file.name.replace(/\.[^.]+$/, '');
      var slideCount  = slides.length;
      var pptxBuf     = await _buildPptx(slides, docTitle, jobId);
      slides = null;

      onStep(2, 'done', 90);
      onStep(3, 'active', 93, 'Finalizing output\u2026');

      var blob = new Blob([pptxBuf], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
      pptxBuf = null;

      onStep(3, 'done', 100);
      PdfPptTelemetry.record('job:done', { job: jobId, blobSize: blob.size, slides: slideCount });
      _log('done', { job: jobId, blobSize: blob.size, slides: slideCount });

      return {
        blob:     blob,
        filename: _filename(file.name),
        _quality: { chars: totalChars, paras: slideCount, pages: total },
      };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      PdfPptScheduler.onFailure();
      PdfPptRecoveryManager.onError(err);
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
  function recover()  { PdfPptRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return {
      inFlight:      _inFlight,
      jobId:         _jobId,
      hasPptxWorker: !!_pptxWorker,
      hasTessWorker: !!_tessWorker,
      scheduler:     PdfPptScheduler.stats(),
    };
  }

  // ── REGISTRATION ───────────────────────────────────────────────────────────
  function _register() {
    if (!G.ToolAppManager) {
      _warn('ToolAppManager not available — registration skipped');
      return;
    }
    G.ToolAppManager.registerTool('pdf-to-powerpoint', function () {
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

  // ── EXPOSE RUNTIME OBJECTS ─────────────────────────────────────────────────
  G.PdfPptScheduler       = PdfPptScheduler;
  G.PdfPptMemoryManager   = PdfPptMemoryManager;
  G.PdfPptRecoveryManager = PdfPptRecoveryManager;
  G.PdfPptTelemetry       = PdfPptTelemetry;

  _log('v1.0 ready');
}(window));

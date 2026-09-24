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
    if (!file) throw new Error('No PDF supplied for OCR.');
    var worker = RuntimeWorkerFactory.spawn('/workers/ocr-pdf-worker.js');
    var buffer = await file.arrayBuffer();
    return await new Promise(function(resolve, reject) {
      var settled = false;
      var timer = setTimeout(function(){ finish(reject,new Error('OCR worker timed out.')); }, 180000);
      function finish(fn,value){ if(settled)return; settled=true; clearTimeout(timer); try{worker.terminate();}catch(_){} fn(value); }
      worker.onmessage = function(ev){ var d=ev.data||{}; if(d.type==='ocr-progress'){ if(onStep) onStep(1,'active',Math.min(94,18+(d.percent||0)),d.stage==='native'?'Checking native text…':'OCR: page '+d.page+' of '+d.total); } else if(d.type==='ocr-done'){ finish(resolve,d.pages||[]); } else if(d.type==='ocr-error'){ finish(reject,new Error(d.message||'OCR worker failed')); } };
      worker.onerror = function(ev){ finish(reject,new Error(ev&&ev.message||'OCR worker failed')); };
      worker.postMessage({type:'ocr-pdf',buffer:buffer,language:lang||'eng',scale:1.5},[buffer]);
    });
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

  // ── NATIVE PDF CONTENT EXTRACTION WORKER ─────────────────────────────────
  async function _extractPdfItems(file, onStep) {
    var worker = new Worker('/workers/pdf-content-extract-worker.js');
    var timer = null;
    var pages = [];
    try {
      var buf = await file.arrayBuffer();
      return await new Promise(function (resolve, reject) {
        timer = setTimeout(function () { reject(new Error('PDF content extraction timed out.')); }, HARD_LIMIT_MS);
        worker.onmessage = function (event) {
          var d = event.data || {};
          if (d.type === 'pdf-content-page') {
            pages.push({ pageNum: d.pageNum, totalPages: d.totalPages, items: d.items || [] });
            if (onStep) onStep(1, 'active', 15 + Math.round((d.pageNum / d.totalPages) * 38), 'Page ' + d.pageNum + ' of ' + d.totalPages);
          } else if (d.type === 'pdf-content-done') {
            resolve(pages);
          } else if (d.type === 'pdf-content-error') {
            reject(new Error(d.message || 'PDF content extraction failed'));
          }
        };
        worker.onerror = function (event) { reject(new Error(event && event.message || 'PDF content extraction worker failed')); };
        worker.postMessage({ type: 'extract-pdf-content', buffer: buf }, [buf]);
      });
    } finally {
      if (timer) clearTimeout(timer);
      try { worker.terminate(); } catch (_) {}
    }
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

      // ── Phase 1: native PDF content extraction in dedicated Worker ───────
      var extractedPages = await _extractPdfItems(file, onStep);
      var total = extractedPages.length ? extractedPages[0].totalPages : 0;
      var slides = extractedPages.map(function (entry) {
        var isEmpty = !entry.items.some(function (it) { return it.str && it.str.trim(); });
        if (isEmpty) return { pageNum: entry.pageNum, title: 'Slide ' + entry.pageNum, text: '' };
        var extracted = _extractSlideContent(entry.items, entry.pageNum);
        return { pageNum: entry.pageNum, title: extracted.title, text: extracted.text };
      });
      extractedPages = null;
      onStep(0, 'done', 12);
      onStep(1, 'active', 55, 'Native extraction complete');

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

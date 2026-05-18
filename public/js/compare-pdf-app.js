// ComparePdfApp v1.0 — Isolated Compare PDF Tool App (Phase 2C)
//
// PROBLEM SOLVED:
//   processors['compare'] calls autoOcrFallback() which calls
//   Tesseract.createWorker().  withTimeout() abandons proc() WITHOUT triggering
//   finally blocks.  The Tesseract worker holds an OPFS write-lock that blocks
//   the next OCR job indefinitely (second-run hang).
//
// SOLUTION:
//   ComparePdfApp intercepts 'compare', uses isolated PDF.js instances (one per
//   file per job), tracks the Tesseract worker in _tessWorker and terminates it
//   in _cleanup().  compare-worker.js handles report building off-thread.
//   Every resource is freed in try/finally blocks — even on hard timeout.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL      = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER   = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var COMPARE_WORKER = '/workers/compare-worker.js';
  var TESS_CDN       = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var HARD_LIMIT_MS  = 180000;  // 3 min
  var WORKER_LIMIT_MS = 15000;  // 15 s for report worker
  var OCR_INIT_MS    = 30000;
  var OCR_PAGE_MS    = 45000;

  var _inFlight      = false;
  var _jobId         = 0;
  var _compareWorker = null;
  var _tessWorker    = null;
  var _hardTimer     = null;
  var _hardReject    = null;

  function _log(msg, d)  { console.debug('[ComparePdfApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[ComparePdfApp]',  msg, d !== undefined ? d : ''); }

  var CompareScheduler = {
    _runs: 0, _failures: 0,
    canRun:    function () { return !_inFlight; }, priority: 'normal',
    onStart:   function () { CompareScheduler._runs++; },
    onFailure: function () { CompareScheduler._failures++; },
    stats:     function () { return { runs: CompareScheduler._runs, failures: CompareScheduler._failures }; },
  };
  var CompareMemoryManager = {
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') throw new Error('Not enough memory. Please close other tabs.');
    },
  };
  var CompareRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { CompareRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return CompareRecoveryManager._errors.slice(); },
  };
  var CompareTelemetry = {
    _events: [],
    record:  function (event, data) { CompareTelemetry._events.push({ ts: Date.now(), event: event, data: data }); },
    getEvents: function () { return CompareTelemetry._events.slice(); },
  };

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)      { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_compareWorker)  { try { _compareWorker.terminate(); } catch (_) {} _compareWorker = null; }
    if (_tessWorker)     { try { _tessWorker.terminate();    } catch (_) {} _tessWorker    = null; }
    _inFlight = false;
  }

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

  function _race(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error((label || 'Op') + ' timed out after ' + (ms / 1000) + 's'));
      }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ── Extract text from one PDF (isolated PDF.js instance) ──────────────────
  async function _extractText(pdfjsLib, file, label) {
    var buf = await file.arrayBuffer();
    var pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var pages = [];
    var chars = 0;
    try {
      for (var i = 1; i <= pdf.numPages; i++) {
        var pg      = await pdf.getPage(i);
        var content = await pg.getTextContent();
        var t       = content.items.map(function (it) { return it.str; }).join(' ');
        pages.push(t);
        chars += t.replace(/\s/g, '').length;
        pg.cleanup();
      }
    } finally {
      try { await pdf.destroy(); } catch (_) {}
      buf = null;
    }
    return { pages: pages, chars: chars, label: label };
  }

  // ── OCR fallback (isolated Tesseract per job) ──────────────────────────────
  async function _ocrFile(pdfjsLib, file, lang) {
    if (!G.Tesseract) {
      await new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src     = TESS_CDN;
        s.onload  = resolve;
        s.onerror = function () { reject(new Error('Tesseract.js failed to load')); };
        document.head.appendChild(s);
      });
    }
    if (!G.Tesseract) throw new Error('OCR engine unavailable');

    var tw = await _race(
      G.Tesseract.createWorker(lang, 1, { logger: function () {} }),
      OCR_INIT_MS, 'OCR worker init'
    );
    _tessWorker = tw;

    var buf  = await file.arrayBuffer();
    var pdf  = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var text = '';

    try {
      for (var i = 1; i <= pdf.numPages; i++) {
        var pg  = await pdf.getPage(i);
        var vp  = pg.getViewport({ scale: 1.5 });
        var cvs = document.createElement('canvas');
        cvs.width  = Math.min(Math.floor(vp.width),  3072);
        cvs.height = Math.min(Math.floor(vp.height), 3072);
        var ctx = cvs.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cvs.width, cvs.height);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        pg.cleanup();
        var recog = await _race(tw.recognize(cvs.toDataURL('image/jpeg', 0.90)), OCR_PAGE_MS, 'OCR page ' + i);
        text += (recog.data.text || '') + '\n';
        cvs.width = 0; cvs.height = 0;
      }
    } finally {
      try { await pdf.destroy(); } catch (_) {}
      buf = null;
    }

    try { await tw.terminate(); } catch (_) {}
    _tessWorker = null;

    return text;
  }

  // ── Report worker ──────────────────────────────────────────────────────────
  function _runCompareWorker(textA, textB, filenameA, filenameB, pagesA, pagesB, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(COMPARE_WORKER); }
      catch (e) { return reject(new Error('compare-worker spawn failed: ' + (e.message || e))); }
      _compareWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _compareWorker = null;
        reject(new Error('compare-worker timed out'));
      }, WORKER_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _compareWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer instanceof ArrayBuffer) { resolve(d); return; }
        reject(new Error('compare-worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _compareWorker = null;
        reject(new Error('compare-worker error: ' + (ev && ev.message || 'unknown')));
      };

      w.postMessage({ op: 'compare', textA: textA, textB: textB,
        filenameA: filenameA, filenameB: filenameB,
        pagesA: pagesA, pagesB: pagesB, jobId: String(jobId) });
    });
  }

  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Comparison already in progress');
    if (!files || files.length < 2) throw new Error('Two PDF files are required for comparison');
    _inFlight = true;
    var jobId = ++_jobId;
    CompareScheduler.onStart();
    CompareMemoryManager.checkMemory();
    CompareTelemetry.record('job:start', { job: jobId });
    _log('start', { job: jobId });

    var onStep = _makeStepper();

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Comparison timed out. Please try with smaller files.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your files\u2026');
      var pdfjsLib = await _loadPdfJs();
      onStep(0, 'done', 12);
      onStep(1, 'active', 15, 'Analyzing first document\u2026');

      // Extract text from both files
      var exA = await _extractText(pdfjsLib, files[0], 'Document A');
      onStep(1, 'active', 33, 'Analyzing second document\u2026');
      var exB = await _extractText(pdfjsLib, files[1], 'Document B');

      // OCR fallback for sparse text files
      if (exA.chars < 30) {
        CompareTelemetry.record('ocr:trigger', { file: 'A', chars: exA.chars });
        try {
          var ocrA = await _ocrFile(pdfjsLib, files[0], 'eng');
          exA = { pages: [ocrA], chars: ocrA.length, label: 'Document A' };
        } catch (_) {}
      }
      if (exB.chars < 30) {
        CompareTelemetry.record('ocr:trigger', { file: 'B', chars: exB.chars });
        try {
          var ocrB = await _ocrFile(pdfjsLib, files[1], 'eng');
          exB = { pages: [ocrB], chars: ocrB.length, label: 'Document B' };
        } catch (_) {}
      }

      onStep(1, 'done', 51);
      onStep(2, 'active', 54, 'Finding differences\u2026');

      // Flat text per document (split marker for per-page diff)
      var textA = exA.pages.map(function (t, i) { return '=== page ' + (i + 1) + ' ===\n' + t; }).join('\n');
      var textB = exB.pages.map(function (t, i) { return '=== page ' + (i + 1) + ' ===\n' + t; }).join('\n');

      var wResult = await _runCompareWorker(
        textA, textB, files[0].name, files[1].name,
        exA.pages.length, exB.pages.length, jobId
      );

      onStep(2, 'done', 80);
      onStep(3, 'active', 83, 'Building report\u2026');

      var blob = new Blob([wResult.buffer], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);

      CompareTelemetry.record('job:done', { job: jobId, similarity: wResult.similarity });
      _log('done', { job: jobId, sim: wResult.similarity });
      return { blob: blob, filename: 'ILovePDF-comparison-report.txt' };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      CompareScheduler.onFailure();
      CompareRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { CompareRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasTessWorker: !!_tessWorker, scheduler: CompareScheduler.stats() };
  }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool('compare', function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.CompareScheduler       = CompareScheduler;
  G.CompareMemoryManager   = CompareMemoryManager;
  G.CompareRecoveryManager = CompareRecoveryManager;
  G.CompareTelemetry       = CompareTelemetry;
  _log('v1.0 ready');
}(window));

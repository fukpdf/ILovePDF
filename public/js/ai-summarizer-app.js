// AiSummarizerApp v1.0 — Isolated AI Summarizer Tool App (Phase 2C)
//
// PROBLEM SOLVED:
//   processors['ai-summarize'] calls autoOcrFallback() (Tesseract.createWorker)
//   AND runAdvancedWorker({op:'chunk-text-score'}) (shared WorkerPool slot).
//   withTimeout() abandons proc() WITHOUT triggering finally blocks → BOTH leaks
//   happen simultaneously.  Tesseract OPFS write-lock + WorkerPool exhaustion.
//
// SOLUTION:
//   AiSummarizerApp intercepts 'ai-summarize'.  Isolated PDF.js per job.
//   Isolated Tesseract per job (tracked in _tessWorker, terminated in _cleanup).
//   summary-worker.js replaces runAdvancedWorker (dedicated, terminates-after-job).
//   Inline TF-IDF fallback if summary-worker fails.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL       = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var SUMMARY_WORKER  = '/workers/summary-worker.js';
  var TESS_CDN        = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var HARD_LIMIT_MS   = 120000;  // 2 min
  var SUMMARY_LIMIT_MS = 20000;  // 20 s for scoring worker
  var OCR_INIT_MS     = 30000;
  var OCR_PAGE_MS     = 45000;

  var _inFlight       = false;
  var _jobId          = 0;
  var _summaryWorker  = null;
  var _tessWorker     = null;
  var _pdfInst        = null;
  var _hardTimer      = null;
  var _hardReject     = null;

  function _log(msg, d)  { console.debug('[AiSummarizerApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[AiSummarizerApp]',  msg, d !== undefined ? d : ''); }

  var SummaryScheduler = {
    _runs: 0, _failures: 0,
    canRun: function () { return !_inFlight; }, priority: 'normal',
    onStart:   function () { SummaryScheduler._runs++; },
    onFailure: function () { SummaryScheduler._failures++; },
    stats:     function () { return { runs: SummaryScheduler._runs, failures: SummaryScheduler._failures }; },
  };
  var SummaryMemoryManager = {
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') throw new Error('Not enough memory. Please close other tabs.');
    },
  };
  var SummaryRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { SummaryRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return SummaryRecoveryManager._errors.slice(); },
  };
  var SummaryTelemetry = {
    _events: [],
    record:  function (event, data) { SummaryTelemetry._events.push({ ts: Date.now(), event: event, data: data }); },
    getEvents: function () { return SummaryTelemetry._events.slice(); },
  };

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)      { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_summaryWorker)  { try { _summaryWorker.terminate(); } catch (_) {} _summaryWorker = null; }
    if (_tessWorker)     { try { _tessWorker.terminate();    } catch (_) {} _tessWorker    = null; }
    if (_pdfInst)        { try { _pdfInst.destroy();         } catch (_) {} _pdfInst       = null; }
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
      var t = setTimeout(function () { reject(new Error((label || 'Op') + ' timed out')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ── OCR fallback (isolated Tesseract per job) ──────────────────────────────
  async function _ocrFallback(pdfjsLib, file) {
    if (!G.Tesseract) {
      await new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = TESS_CDN; s.onload = resolve;
        s.onerror = function () { reject(new Error('Tesseract.js failed to load')); };
        document.head.appendChild(s);
      });
    }
    if (!G.Tesseract) throw new Error('OCR engine unavailable');

    var tw = await _race(G.Tesseract.createWorker('eng', 1, { logger: function () {} }), OCR_INIT_MS, 'OCR init');
    _tessWorker = tw;

    var buf  = await file.arrayBuffer();
    var pdf  = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var text = '';

    try {
      for (var i = 1; i <= pdf.numPages; i++) {
        var pg  = await pdf.getPage(i);
        var vp  = pg.getViewport({ scale: 1.5 });
        var cvs = document.createElement('canvas');
        cvs.width = Math.min(Math.floor(vp.width), 3072); cvs.height = Math.min(Math.floor(vp.height), 3072);
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

  // ── Summary worker ─────────────────────────────────────────────────────────
  function _runSummaryWorker(text, maxSentences, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(SUMMARY_WORKER); }
      catch (e) { return reject(new Error('summary-worker spawn failed: ' + (e.message || e))); }
      _summaryWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _summaryWorker = null;
        reject(new Error('summary-worker timed out'));
      }, SUMMARY_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _summaryWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (typeof d.summary === 'string') { resolve(d); return; }
        reject(new Error('summary-worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _summaryWorker = null;
        reject(new Error('summary-worker error: ' + (ev && ev.message || 'unknown')));
      };

      w.postMessage({ op: 'summarize', text: text, maxSentences: maxSentences, jobId: String(jobId) });
    });
  }

  // ── Inline TF-IDF fallback ──────────────────────────────────────────────────
  function _inlineSummarize(text, maxSentences) {
    var max       = Math.min(25, Math.max(3, parseInt(maxSentences || 7, 10)));
    var sentences = (text.match(/[^.!?\n]{10,}[.!?]/g) || []).map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 15; });
    if (!sentences.length) sentences = text.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
    var allWords  = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    var freq = {};
    allWords.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });
    var scored = sentences.map(function (s) {
      var sw = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      return { s: s, score: sw.reduce(function (n, w) { return n + (freq[w] || 0); }, 0) / (sw.length || 1) };
    }).sort(function (a, b) { return b.score - a.score; }).slice(0, max).map(function (x) { return x.s; });
    return { summary: scored.join(' '), wordCount: allWords.length, sentenceCount: sentences.length, topCount: scored.length };
  }

  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return base.toLowerCase().startsWith('ilovepdf') ? base + '-summary.txt' : 'ilovepdf-' + base + '-summary.txt';
  }

  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Summarization already in progress');
    _inFlight = true;
    var jobId = ++_jobId;
    var file  = files && files[0];
    if (!file) { _cleanup('no-file'); throw new Error('No file provided'); }

    SummaryScheduler.onStart();
    SummaryMemoryManager.checkMemory();
    SummaryTelemetry.record('job:start', { job: jobId, file: file.name });
    _log('start', { job: jobId, file: file.name });

    var onStep = _makeStepper();
    var maxSentences = parseInt((opts && (opts.sentences || opts.length)) || '7', 10) || 7;

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Summarization timed out. Please try with a smaller document.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your file\u2026');

      var pdfjsLib  = await _loadPdfJs();
      var buf       = await file.arrayBuffer();
      var pdf       = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      _pdfInst      = pdf;
      buf           = null;

      var total   = pdf.numPages;
      var allText = '';
      var skipped = 0;

      onStep(0, 'done', 12);
      onStep(1, 'active', 15, 'Processing content\u2026');

      try {
        for (var i = 1; i <= total; i++) {
          var pg      = await pdf.getPage(i);
          var content = await pg.getTextContent();
          var t       = content.items.map(function (it) { return it.str; }).join(' ').trim();
          if (!t) skipped++;
          allText += t + ' ';
          pg.cleanup();
          onStep(1, 'active', 15 + Math.round((i / total) * 25), 'Page ' + i + ' of ' + total);
        }
      } finally {
        try { await pdf.destroy(); } catch (_) {}
        _pdfInst = null;
      }

      allText = allText.trim();
      SummaryTelemetry.record('extract', { chars: allText.length, skipped: skipped });

      // OCR fallback for image-based PDFs
      if (!allText) {
        onStep(1, 'active', 38, 'Scanning pages for content\u2026');
        var ocrText = await _ocrFallback(pdfjsLib, file);
        allText = ocrText.trim();
        SummaryTelemetry.record('ocr:done', { chars: allText.length });
        if (!allText) throw new Error('No text could be found in this document.');
      }

      onStep(1, 'done', 45);
      onStep(2, 'active', 49, 'Generating summary\u2026');

      var scored = null;
      try {
        scored = await _runSummaryWorker(allText, maxSentences, jobId);
      } catch (wErr) {
        _warn('summary-worker failed, using inline fallback', wErr.message);
        scored = _inlineSummarize(allText, maxSentences);
      }
      allText = null;

      if (!scored || !scored.summary || scored.summary.trim().length < 10) {
        throw new Error('The summary could not be generated from this document. The content may be too fragmented.');
      }

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

      SummaryTelemetry.record('job:done', { job: jobId, blobSize: blob.size });
      _log('done', { job: jobId });
      return {
        blob: blob,
        filename: _filename(file.name),
        _quality: { chars: scored.summary.length, paras: scored.topCount, pages: total },
      };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      SummaryScheduler.onFailure();
      SummaryRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { SummaryRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasTessWorker: !!_tessWorker, hasSummaryWorker: !!_summaryWorker, scheduler: SummaryScheduler.stats() };
  }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool('ai-summarize', function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.SummaryScheduler       = SummaryScheduler;
  G.SummaryMemoryManager   = SummaryMemoryManager;
  G.SummaryRecoveryManager = SummaryRecoveryManager;
  G.SummaryTelemetry       = SummaryTelemetry;
  _log('v1.0 ready');
}(window));

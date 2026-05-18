// TranslatePdfApp v1.0 — Isolated Translate PDF Tool App (Phase 2C)
//
// PROBLEM SOLVED:
//   processors['translate'] calls autoOcrFallback() → Tesseract.createWorker().
//   withTimeout() abandons proc() WITHOUT triggering finally blocks.
//   Tesseract OPFS write-lock is held indefinitely → second-run hang.
//
// SOLUTION:
//   TranslatePdfApp intercepts 'translate', uses isolated PDF.js + isolated
//   Tesseract per job (tracked in _tessWorker, terminated in _cleanup()).
//   External mymemory API calls are cancellable via AbortController.
//   translation-worker.js builds the final report off-thread.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL        = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var TRANSLATION_WORKER = '/workers/translation-worker.js';
  var TESS_CDN         = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var MYMEMORY_URL     = 'https://api.mymemory.translated.net/get';
  var HARD_LIMIT_MS    = 300000; // 5 min (translation can be slow)
  var WORKER_LIMIT_MS  = 15000;
  var OCR_INIT_MS      = 30000;
  var OCR_PAGE_MS      = 45000;

  var _inFlight         = false;
  var _jobId            = 0;
  var _translationWorker = null;
  var _tessWorker       = null;
  var _pdfInst          = null;
  var _abortCtrl        = null;
  var _hardTimer        = null;
  var _hardReject       = null;

  function _log(msg, d)  { console.debug('[TranslatePdfApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[TranslatePdfApp]',  msg, d !== undefined ? d : ''); }

  var TranslateScheduler = {
    _runs: 0, _failures: 0,
    canRun:    function () { return !_inFlight; }, priority: 'normal',
    onStart:   function () { TranslateScheduler._runs++; },
    onFailure: function () { TranslateScheduler._failures++; },
    stats:     function () { return { runs: TranslateScheduler._runs, failures: TranslateScheduler._failures }; },
  };
  var TranslateMemoryManager = {
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') throw new Error('Not enough memory. Please close other tabs.');
    },
  };
  var TranslateRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { TranslateRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return TranslateRecoveryManager._errors.slice(); },
  };
  var TranslateTelemetry = {
    _events: [],
    record:  function (event, data) { TranslateTelemetry._events.push({ ts: Date.now(), event: event, data: data }); },
    getEvents: function () { return TranslateTelemetry._events.slice(); },
  };

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)          { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_translationWorker)  { try { _translationWorker.terminate(); } catch (_) {} _translationWorker = null; }
    if (_tessWorker)         { try { _tessWorker.terminate();         } catch (_) {} _tessWorker         = null; }
    if (_pdfInst)            { try { _pdfInst.destroy();              } catch (_) {} _pdfInst            = null; }
    if (_abortCtrl)          { try { _abortCtrl.abort();              } catch (_) {} _abortCtrl          = null; }
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

  // ── OCR fallback ──────────────────────────────────────────────────────────
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

  // ── Translation via mymemory API ──────────────────────────────────────────
  var _CHUNK_MAX  = 420; // mymemory safe limit per request
  var _PAUSE_MS   = 320; // rate-limit pause between requests

  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function _translateChunk(text, srcLang, tgtLang, signal) {
    var params = new URLSearchParams({ q: text, langpair: srcLang + '|' + tgtLang, de: 'ilovepdf' });
    var resp   = null;
    try {
      resp = await fetch(MYMEMORY_URL + '?' + params.toString(), { signal: signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return text; // network error — keep original chunk
    }
    if (!resp.ok) return text;
    try {
      var json = await resp.json();
      if (json && json.responseStatus === 200 && json.responseData && json.responseData.translatedText) {
        return json.responseData.translatedText;
      }
    } catch (_) {}
    return text;
  }

  async function _translateText(fullText, srcLang, tgtLang, signal) {
    var sentences = (fullText.match(/[^.!?\n]{5,}[.!?\n]|[^.!?\n]{15,}/g) || [fullText]);
    var chunks    = [];
    var current   = '';

    for (var si = 0; si < sentences.length; si++) {
      var sentence = sentences[si].trim();
      if (!sentence) continue;
      if ((current + ' ' + sentence).length > _CHUNK_MAX && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = current ? current + ' ' + sentence : sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    var translated = [];
    for (var ci = 0; ci < chunks.length; ci++) {
      if (signal && signal.aborted) throw new Error('Translation cancelled');
      var out = await _translateChunk(chunks[ci], srcLang, tgtLang, signal);
      translated.push(out);
      if (ci < chunks.length - 1) await _sleep(_PAUSE_MS);
    }
    return translated.join(' ');
  }

  // ── Report worker ─────────────────────────────────────────────────────────
  function _runTranslationWorker(translated, sourceName, pages, targetLang, srcLang, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(TRANSLATION_WORKER); }
      catch (e) { return reject(new Error('translation-worker spawn failed: ' + (e.message || e))); }
      _translationWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _translationWorker = null;
        reject(new Error('translation-worker timed out'));
      }, WORKER_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _translationWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer instanceof ArrayBuffer) { resolve(d); return; }
        reject(new Error('translation-worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _translationWorker = null;
        reject(new Error('translation-worker error: ' + (ev && ev.message || 'unknown')));
      };

      w.postMessage({ op: 'build-report', translated: translated, sourceName: sourceName,
        pages: pages, targetLang: targetLang, srcLang: srcLang, jobId: String(jobId) });
    });
  }

  function _filename(orig, targetLang) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return 'ilovepdf-' + base.toLowerCase().replace(/^ilovepdf-?/, '') + '-' + targetLang + '.txt';
  }

  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Translation already in progress');
    _inFlight = true;
    var jobId  = ++_jobId;
    var file   = files && files[0];
    if (!file) { _cleanup('no-file'); throw new Error('No file provided'); }

    TranslateScheduler.onStart();
    TranslateMemoryManager.checkMemory();
    TranslateTelemetry.record('job:start', { job: jobId, file: file.name });
    _log('start', { job: jobId, file: file.name });

    var onStep   = _makeStepper();
    var tgtLang  = (opts && (opts.targetLanguage || opts.targetLang)) || 'es';
    var srcLang  = (opts && (opts.sourceLanguage || opts.srcLang))    || 'en';
    _abortCtrl   = new AbortController();
    var signal   = _abortCtrl.signal;

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Translation timed out. Please try with a smaller document.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your file\u2026');

      var pdfjsLib = await _loadPdfJs();
      var buf      = await file.arrayBuffer();
      var pdf      = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
      _pdfInst     = pdf;
      buf          = null;

      var total   = pdf.numPages;
      var rawPages = [];

      onStep(0, 'done', 12);
      onStep(1, 'active', 15, 'Extracting text\u2026');

      try {
        for (var i = 1; i <= total; i++) {
          var pg      = await pdf.getPage(i);
          var content = await pg.getTextContent();
          var t       = content.items.map(function (it) { return it.str; }).join(' ').trim();
          rawPages.push(t);
          pg.cleanup();
          onStep(1, 'active', 15 + Math.round((i / total) * 15), 'Extracting page ' + i);
        }
      } finally {
        try { await pdf.destroy(); } catch (_) {}
        _pdfInst = null;
      }

      var fullText  = rawPages.join('\n');
      var totalChars = fullText.replace(/\s/g, '').length;
      TranslateTelemetry.record('extract', { chars: totalChars, pages: total });

      // OCR fallback
      if (totalChars < 30) {
        onStep(1, 'active', 33, 'Scanning pages for content\u2026');
        var ocrText = await _ocrFallback(pdfjsLib, file);
        fullText    = ocrText.trim();
        rawPages    = [fullText];
        if (!fullText) throw new Error('No text could be found in this document.');
      }

      onStep(1, 'done', 35);
      onStep(2, 'active', 38, 'Translating to ' + tgtLang.toUpperCase() + '\u2026');

      // Translate each page with progress
      var translatedPages = [];
      for (var pi = 0; pi < rawPages.length; pi++) {
        if (signal.aborted) throw new Error('Translation cancelled');
        var pageText  = rawPages[pi];
        var pageTrans = pageText.trim() ? await _translateText(pageText, srcLang, tgtLang, signal) : '';
        translatedPages.push({ num: pi + 1, text: pageTrans });
        onStep(2, 'active', 38 + Math.round((pi / rawPages.length) * 30), 'Translating page ' + (pi + 1));
      }

      onStep(2, 'done', 72);
      onStep(3, 'active', 74, 'Building output\u2026');

      var wResult = await _runTranslationWorker(
        translatedPages, file.name, total, tgtLang, srcLang, jobId
      );

      var blob = new Blob([wResult.buffer], { type: 'text/plain;charset=utf-8' });
      onStep(3, 'done', 100);

      TranslateTelemetry.record('job:done', { job: jobId, blobSize: blob.size });
      _log('done', { job: jobId });
      return { blob: blob, filename: _filename(file.name, tgtLang) };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      TranslateScheduler.onFailure();
      TranslateRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { TranslateRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasTessWorker: !!_tessWorker, scheduler: TranslateScheduler.stats() };
  }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool('translate', function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.TranslateScheduler       = TranslateScheduler;
  G.TranslateMemoryManager   = TranslateMemoryManager;
  G.TranslateRecoveryManager = TranslateRecoveryManager;
  G.TranslateTelemetry       = TranslateTelemetry;
  _log('v1.0 ready');
}(window));

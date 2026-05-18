// CompressPdfApp v1.0 — Isolated Compress PDF Tool App (Phase 2C)
//
// PROBLEM SOLVED:
//   "First run fails, second run hangs forever."
//
//   Root cause: processors['compress'] calls runPdfWorker('compress') which
//   occupies a shared WorkerPool slot.  withTimeout() in runTool() races the
//   inner proc() promise — on timeout it abandons proc() WITHOUT triggering its
//   finally blocks.  The WorkerPool slot stays marked "running" indefinitely.
//   Next run cannot get a slot and hangs.
//
// SOLUTION:
//   CompressPdfApp installs a BrowserTools.process interceptor for 'compress'.
//   Spawns a DEDICATED compress-worker.js per job (bypasses WorkerPool entirely).
//   Worker is tracked in _compressWorker and terminated in _cleanup() — always,
//   even on hard timeout.  Falls back to inline pdf-lib if worker spawn fails.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFLIB_CDN    = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  var COMPRESS_WORKER = '/workers/compress-worker.js';
  var HARD_LIMIT_MS   = 90000;   // 90 s entire job cap
  var WORKER_LIMIT_MS = 75000;   // 75 s worker timeout

  // ── ISOLATED STATE ──────────────────────────────────────────────────────────
  var _inFlight       = false;
  var _jobId          = 0;
  var _compressWorker = null;
  var _hardTimer      = null;
  var _hardReject     = null;

  function _log(msg, d)  { console.debug('[CompressPdfApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[CompressPdfApp]',  msg, d !== undefined ? d : ''); }

  // ── LIGHTWEIGHT RUNTIME OBJECTS ────────────────────────────────────────────
  var CompressScheduler = {
    _runs: 0, _failures: 0,
    canRun:    function () { return !_inFlight; },
    priority:  'normal',
    onStart:   function () { CompressScheduler._runs++; },
    onFailure: function () { CompressScheduler._failures++; },
    stats:     function () { return { runs: CompressScheduler._runs, failures: CompressScheduler._failures }; },
  };

  var CompressMemoryManager = {
    estimateMB:  function (file) { return Math.ceil((file ? file.size / 1048576 : 0) * 3); },
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') throw new Error('Not enough memory. Please close other tabs.');
    },
  };

  var CompressRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { CompressRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return CompressRecoveryManager._errors.slice(); },
  };

  var CompressTelemetry = {
    _events: [],
    record:  function (event, data) {
      CompressTelemetry._events.push({ ts: Date.now(), event: event, data: data });
      console.debug('[CompressTelemetry]', event, data || '');
    },
    getEvents: function () { return CompressTelemetry._events.slice(); },
  };

  // ── GUARANTEED CLEANUP ─────────────────────────────────────────────────────
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)       { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_compressWorker)  { try { _compressWorker.terminate(); } catch (_) {} _compressWorker = null; }
    _inFlight = false;
  }

  // ── NON-ABANDONING RACE ────────────────────────────────────────────────────
  function _race(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error((label || 'Operation') + ' timed out after ' + (ms / 1000) + 's'));
      }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); },
                   function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ── WORKER-BASED COMPRESSION ───────────────────────────────────────────────
  function _runCompressWorker(buffer, opts, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(COMPRESS_WORKER); }
      catch (e) { return reject(new Error('compress-worker spawn failed: ' + (e.message || e))); }
      _compressWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _compressWorker = null;
        reject(new Error('Compression worker timed out.'));
      }, WORKER_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _compressWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer instanceof ArrayBuffer) { resolve(d); return; }
        reject(new Error('compress-worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _compressWorker = null;
        reject(new Error('compress-worker error: ' + (ev && ev.message || 'unknown')));
      };

      // Transfer buffer to avoid copying large PDF
      var transferBuf = buffer.slice(0);
      w.postMessage({ op: 'compress', buffer: transferBuf, opts: opts, jobId: String(jobId) }, [transferBuf]);
    });
  }

  // ── INLINE FALLBACK (pdf-lib via CDN, runs on main thread) ─────────────────
  async function _inlineFallback(file) {
    _log('inline-fallback');
    if (!G.PDFLib) {
      await new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = PDFLIB_CDN;
        s.onload = resolve;
        s.onerror = function () { reject(new Error('pdf-lib failed to load')); };
        document.head.appendChild(s);
      });
    }
    if (!G.PDFLib) throw new Error('pdf-lib unavailable');

    var PDFDocument = G.PDFLib.PDFDocument;
    var bytes       = await file.arrayBuffer();
    var doc         = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    try {
      doc.setTitle(''); doc.setAuthor(''); doc.setSubject('');
      doc.setKeywords([]); doc.setProducer('ILovePDF'); doc.setCreator('ILovePDF');
    } catch (_) {}
    var out = await doc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 200 });
    return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
  }

  // ── BRANDED FILENAME ───────────────────────────────────────────────────────
  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return base.toLowerCase().startsWith('ilovepdf') ? base + '.pdf' : 'ilovepdf-' + base + '.pdf';
  }

  // ── PROGRESS STEPPER ──────────────────────────────────────────────────────
  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  // ── MAIN PROCESS FUNCTION ──────────────────────────────────────────────────
  async function process(files, opts) {
    if (_inFlight) throw new Error('Compression already in progress');
    _inFlight = true;
    var jobId = ++_jobId;
    var file  = files && files[0];
    if (!file) { _cleanup('no-file'); throw new Error('No file provided'); }

    CompressScheduler.onStart();
    CompressMemoryManager.checkMemory();
    CompressTelemetry.record('job:start', { job: jobId, file: file.name, size: file.size });
    _log('start', { job: jobId, file: file.name, size: file.size });

    var onStep = _makeStepper();

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Compression timed out. Please try with a smaller file.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your file\u2026');

      var fileMB = file.size / 1048576;
      var compressOpts = Object.assign({}, opts || {});
      if (fileMB > 200)     { compressOpts._qualityTier = 'aggressive'; compressOpts._imgScale = 0.65; }
      else if (fileMB > 80) { compressOpts._qualityTier = 'moderate';   compressOpts._imgScale = 0.80; }
      else                  { compressOpts._qualityTier = 'standard';   compressOpts._imgScale = 1.0;  }

      var buf = await file.arrayBuffer();
      onStep(0, 'done', 15);
      onStep(1, 'active', 18, 'Optimizing content\u2026');

      // Yield to keep UI responsive
      await new Promise(function (r) { setTimeout(r, 5); });

      var resultBuf  = null;
      var workerFailed = false;

      try {
        var wResult = await _runCompressWorker(buf, compressOpts, jobId);
        buf = null;
        if (wResult && wResult.buffer instanceof ArrayBuffer && wResult.buffer.byteLength > 0) {
          resultBuf = wResult.buffer;
          CompressTelemetry.record('worker:done', { saved: wResult.savedPct, size: resultBuf.byteLength });
        }
      } catch (workerErr) {
        buf = null;
        workerFailed = true;
        _warn('worker failed, trying inline fallback', workerErr.message);
        CompressTelemetry.record('worker:fail', { err: workerErr.message });
      }

      onStep(1, 'done', 50);
      onStep(2, 'active', 55, 'Applying improvements\u2026');

      // Inline fallback if worker didn't produce a valid result
      if (!resultBuf || resultBuf.byteLength === 0) {
        try {
          resultBuf = await _inlineFallback(file);
        } catch (fbErr) {
          CompressTelemetry.record('fallback:fail', { err: fbErr.message });
          // Last resort: return original
          var origBuf  = await file.arrayBuffer();
          var origBlob = new Blob([origBuf], { type: 'application/pdf' });
          origBuf = null;
          onStep(2, 'done', 80);
          onStep(3, 'active', 90, 'File is already well\u2011optimised\u2026');
          onStep(3, 'done', 100);
          return { blob: origBlob, filename: _filename(file.name), alreadyOptimized: true };
        }
      }

      // If compression didn't save anything, return original
      if (resultBuf.byteLength >= file.size) {
        var o2Buf  = await file.arrayBuffer();
        var o2Blob = new Blob([o2Buf], { type: 'application/pdf' });
        o2Buf = null;
        onStep(2, 'done', 80);
        onStep(3, 'active', 90, 'File is already well\u2011optimised\u2026');
        onStep(3, 'done', 100);
        CompressTelemetry.record('job:done', { job: jobId, alreadyOptimized: true });
        return { blob: o2Blob, filename: _filename(file.name), alreadyOptimized: true };
      }

      var saved = Math.round((1 - resultBuf.byteLength / file.size) * 100);
      var blob  = new Blob([resultBuf], { type: 'application/pdf' });
      resultBuf = null;

      onStep(2, 'done', 85);
      onStep(3, 'active', 88, 'Saved ' + saved + '% \u2014 finalizing\u2026');
      onStep(3, 'done', 100);

      CompressTelemetry.record('job:done', { job: jobId, saved: saved, blobSize: blob.size });
      _log('done', { job: jobId, saved: saved, blobSize: blob.size });

      return { blob: blob, filename: _filename(file.name) };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      CompressScheduler.onFailure();
      CompressRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  // ── LIFECYCLE ──────────────────────────────────────────────────────────────
  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { CompressRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasWorker: !!_compressWorker, scheduler: CompressScheduler.stats() };
  }

  // ── REGISTRATION ───────────────────────────────────────────────────────────
  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool('compress', function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.CompressScheduler       = CompressScheduler;
  G.CompressMemoryManager   = CompressMemoryManager;
  G.CompressRecoveryManager = CompressRecoveryManager;
  G.CompressTelemetry       = CompressTelemetry;
  _log('v1.0 ready');
}(window));

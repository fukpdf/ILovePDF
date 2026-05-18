// RepairPdfApp v1.0 — Isolated Repair PDF Tool App (Phase 2C)
//
// PROBLEM SOLVED:
//   processors['repair'] calls runPdfWorker('repair') up to TWICE (2 passes).
//   Each call consumes a shared WorkerPool slot.  withTimeout() abandons the
//   inner proc() without triggering finally blocks → up to 2 permanent leaked
//   WorkerPool slots per timeout event.  After 2-3 events the pool is exhausted.
//
// SOLUTION:
//   RepairPdfApp intercepts 'repair', spawns a dedicated repair-worker.js per
//   job (bypassing WorkerPool entirely), tracks it in _repairWorker, and
//   terminates it in _cleanup() — always, even on hard timeout.
//   Also includes PDF.js integrity verification of the repaired document.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL       = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var REPAIR_WORKER   = '/workers/repair-worker.js';
  var HARD_LIMIT_MS   = 120000;  // 2 min
  var WORKER_LIMIT_MS = 100000;  // 100 s worker timeout

  var _inFlight     = false;
  var _jobId        = 0;
  var _repairWorker = null;
  var _hardTimer    = null;
  var _hardReject   = null;

  function _log(msg, d)  { console.debug('[RepairPdfApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[RepairPdfApp]',  msg, d !== undefined ? d : ''); }

  var RepairScheduler = {
    _runs: 0, _failures: 0,
    canRun: function () { return !_inFlight; }, priority: 'normal',
    onStart:   function () { RepairScheduler._runs++; },
    onFailure: function () { RepairScheduler._failures++; },
    stats:     function () { return { runs: RepairScheduler._runs, failures: RepairScheduler._failures }; },
  };

  var RepairMemoryManager = {
    estimateMB:  function (file) { return Math.ceil((file ? file.size / 1048576 : 0) * 4); },
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') throw new Error('Not enough memory. Please close other tabs.');
    },
  };

  var RepairRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { RepairRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return RepairRecoveryManager._errors.slice(); },
  };

  var RepairTelemetry = {
    _events: [],
    record:  function (event, data) {
      RepairTelemetry._events.push({ ts: Date.now(), event: event, data: data });
      console.debug('[RepairTelemetry]', event, data || '');
    },
    getEvents: function () { return RepairTelemetry._events.slice(); },
  };

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)    { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_repairWorker) { try { _repairWorker.terminate(); } catch (_) {} _repairWorker = null; }
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

  function _runRepairWorker(buffer, opts, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(REPAIR_WORKER); }
      catch (e) { return reject(new Error('repair-worker spawn failed: ' + (e.message || e))); }
      _repairWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _repairWorker = null;
        reject(new Error('Repair worker timed out.'));
      }, WORKER_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _repairWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer instanceof ArrayBuffer) { resolve(d); return; }
        reject(new Error('repair-worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _repairWorker = null;
        reject(new Error('repair-worker error: ' + (ev && ev.message || 'unknown')));
      };

      var transferBuf = buffer.slice(0);
      w.postMessage({ op: 'repair', buffer: transferBuf, opts: opts, jobId: String(jobId) }, [transferBuf]);
    });
  }

  // ── Raw byte scan (mirrors AE's _repairRawByteScan) ─────────────────────────
  function _rawByteScan(buf) {
    var bytes = new Uint8Array(buf.slice ? buf.slice(0, Math.min(buf.byteLength, 8 * 1048576)) : buf);
    var text  = '';
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, Math.min(bytes.length, 8192))); } catch (_) {}
    var hasPdfHeader     = text.startsWith('%PDF-');
    var headerVersion    = hasPdfHeader ? (text.match(/%PDF-(\d+\.\d+)/) || [,'?'])[1] : null;
    var objCount         = (text.match(/\d+ \d+ obj/g) || []).length;
    var endObjCount      = (text.match(/endobj/g) || []).length;
    var streamCount      = (text.match(/\bstream\b/g) || []).length;
    var pageCount        = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    var hasXref          = /\bxref\b/.test(text);
    var hasTrailer       = /\btrailer\b/.test(text);
    var matched          = Math.min(objCount, endObjCount);
    var confidence       = hasPdfHeader
      ? Math.min(1, matched * 0.08 + (hasXref ? 0.12 : 0) + (hasTrailer ? 0.12 : 0) + (pageCount > 0 ? 0.15 : 0))
      : 0;
    return { hasPdfHeader: hasPdfHeader, headerVersion: headerVersion, confidence: confidence, estimatedPages: pageCount };
  }

  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return base.toLowerCase().startsWith('ilovepdf') ? base + '-repaired.pdf' : 'ilovepdf-' + base + '-repaired.pdf';
  }

  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Repair already in progress');
    _inFlight = true;
    var jobId = ++_jobId;
    var file  = files && files[0];
    if (!file) { _cleanup('no-file'); throw new Error('No file provided'); }

    RepairScheduler.onStart();
    RepairMemoryManager.checkMemory();
    RepairTelemetry.record('job:start', { job: jobId, file: file.name, size: file.size });
    _log('start', { job: jobId, file: file.name, size: file.size });

    var onStep = _makeStepper();

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Repair timed out. The file may be too severely damaged to recover.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 8, 'Preparing your file\u2026');

      var buf = null;
      try { buf = await file.arrayBuffer(); }
      catch (e) { throw new Error('The file is too large to load. Please try a smaller file.'); }

      // Pre-scan for PDF header
      var rawScan = null;
      try { rawScan = _rawByteScan(buf); } catch (_) {}

      if (rawScan && !rawScan.hasPdfHeader) {
        throw new Error('This file does not appear to be a valid PDF. Please check that you uploaded the correct file.');
      }

      onStep(0, 'done', 18);
      onStep(1, 'active', 22, 'Checking integrity\u2026');

      var repairOpts = Object.assign({}, opts || {});

      var wResult = null;
      try {
        onStep(1, 'done', 30);
        onStep(2, 'active', 34, 'Restoring document\u2026');
        wResult = await _runRepairWorker(buf, repairOpts, jobId);
        buf = null;
      } catch (repairErr) {
        buf = null;
        RepairTelemetry.record('worker:fail', { err: repairErr.message });
        _warn('repair-worker failed', repairErr.message);

        // Check if the error is about severe damage
        if (repairErr.message && repairErr.message.toLowerCase().includes('severely damaged')) {
          throw repairErr;
        }

        // Escalate as ORIG fallback signal for severely damaged files
        if (rawScan && rawScan.confidence < 0.30) {
          throw new Error('This PDF appears to be severely damaged (less than 30% recoverable structure). It may not be possible to recover this file.');
        }
        throw new Error('The document could not be repaired. It may be too severely damaged. Please try re-downloading the original file.');
      }

      if (!wResult || !(wResult.buffer instanceof ArrayBuffer) || wResult.buffer.byteLength < 10) {
        throw new Error('Repair produced an empty or invalid result. The PDF may be too severely damaged.');
      }

      var resultBuf = wResult.buffer;

      // ── PDF.js integrity verification ────────────────────────────────────
      onStep(2, 'done', 75);
      onStep(3, 'active', 78, 'Verifying document\u2026');

      try {
        var pdfjsLib  = await _loadPdfJs();
        var verifyDoc = await pdfjsLib.getDocument({ data: resultBuf.slice(0), isEvalSupported: false }).promise;
        var repPages  = verifyDoc.numPages;
        await verifyDoc.destroy();
        RepairTelemetry.record('verify:ok', { pages: repPages });
        if (repPages < 1) throw new Error('repaired_pdf_empty');
      } catch (intErr) {
        throw new Error('The document could not be fully repaired. It may be too severely damaged to recover. Please try re-downloading the original file.');
      }

      onStep(3, 'active', 92, 'Finalizing output\u2026');
      var blob = new Blob([resultBuf], { type: 'application/pdf' });
      resultBuf = null;
      onStep(3, 'done', 100);

      RepairTelemetry.record('job:done', { job: jobId, blobSize: blob.size, pages: wResult.pages });
      _log('done', { job: jobId, blobSize: blob.size });
      return { blob: blob, filename: _filename(file.name) };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      RepairScheduler.onFailure();
      RepairRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { RepairRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasWorker: !!_repairWorker, scheduler: RepairScheduler.stats() };
  }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool('repair', function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.RepairScheduler       = RepairScheduler;
  G.RepairMemoryManager   = RepairMemoryManager;
  G.RepairRecoveryManager = RepairRecoveryManager;
  G.RepairTelemetry       = RepairTelemetry;
  _log('v1.0 ready');
}(window));

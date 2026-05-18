// RemoveBackgroundApp v1.0 — Isolated Background Remover Tool App (Phase 2C)
//
// PROBLEM SOLVED:
//   processors['background-remover'] calls runAdvancedWorker({op:'remove-bg'})
//   up to TWICE (2 passes: BFS + cleanup), occupying up to 2 shared WorkerPool
//   slots.  withTimeout() abandons proc() WITHOUT triggering finally blocks →
//   both slots leaked, canvases never freed.  WorkerPool exhaustion after 2-3
//   timeout events.
//
// SOLUTION:
//   RemoveBackgroundApp intercepts 'background-remover'.  Canvas lifecycle is
//   tracked explicitly (_canvas, _outputCanvas).  remove-bg-worker.js is
//   spawned directly per job (NO WorkerPool).  Worker terminated in _cleanup().
//   Canvases freed in _cleanup().  Falls back to inline BFS CV algorithm.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var REMOVE_BG_WORKER = '/workers/remove-bg-worker.js';
  var HARD_LIMIT_MS    = 90000;   // 90 s
  var WORKER_LIMIT_MS  = 75000;   // 75 s worker

  var _inFlight       = false;
  var _jobId          = 0;
  var _removeBgWorker = null;
  var _canvas         = null; // source canvas
  var _outputCanvas   = null; // result canvas
  var _hardTimer      = null;
  var _hardReject     = null;

  function _log(msg, d)  { console.debug('[RemoveBackgroundApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[RemoveBackgroundApp]',  msg, d !== undefined ? d : ''); }

  var BgRemoveScheduler = {
    _runs: 0, _failures: 0,
    canRun:    function () { return !_inFlight; }, priority: 'normal',
    onStart:   function () { BgRemoveScheduler._runs++; },
    onFailure: function () { BgRemoveScheduler._failures++; },
    stats:     function () { return { runs: BgRemoveScheduler._runs, failures: BgRemoveScheduler._failures }; },
  };
  var BgRemoveMemoryManager = {
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') throw new Error('Not enough memory. Please close other tabs.');
    },
  };
  var BgRemoveRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { BgRemoveRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return BgRemoveRecoveryManager._errors.slice(); },
  };
  var BgRemoveTelemetry = {
    _events: [],
    record:  function (event, data) { BgRemoveTelemetry._events.push({ ts: Date.now(), event: event, data: data }); },
    getEvents: function () { return BgRemoveTelemetry._events.slice(); },
  };

  function _freeCanvas(cvs) {
    if (!cvs) return;
    try { cvs.width = 0; cvs.height = 0; } catch (_) {}
  }

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)       { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_removeBgWorker)  { try { _removeBgWorker.terminate(); } catch (_) {} _removeBgWorker = null; }
    _freeCanvas(_canvas);       _canvas       = null;
    _freeCanvas(_outputCanvas); _outputCanvas = null;
    _inFlight = false;
  }

  // ── Load image into canvas, get ImageData ─────────────────────────────────
  function _loadImageData(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var cvs = document.createElement('canvas');
        cvs.width = img.naturalWidth; cvs.height = img.naturalHeight;
        var ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var imgData = ctx.getImageData(0, 0, cvs.width, cvs.height);
        URL.revokeObjectURL(url);
        resolve({ canvas: cvs, imgData: imgData, width: cvs.width, height: cvs.height });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image: ' + file.name));
      };
      img.src = url;
    });
  }

  // ── Run remove-bg-worker.js (dedicated, terminates after job) ─────────────
  function _runRemoveBgWorker(pixels, width, height, opts, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(REMOVE_BG_WORKER); }
      catch (e) { return reject(new Error('remove-bg-worker spawn failed: ' + (e.message || e))); }
      _removeBgWorker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _removeBgWorker = null;
        reject(new Error('Background removal worker timed out.'));
      }, WORKER_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _removeBgWorker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.pixels instanceof ArrayBuffer) { resolve(d); return; }
        reject(new Error('remove-bg-worker: unexpected response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _removeBgWorker = null;
        reject(new Error('remove-bg-worker error: ' + (ev && ev.message || 'unknown')));
      };

      // Transfer the pixel buffer — zero-copy
      var pixelsCopy = pixels.slice(0);
      w.postMessage({
        op: 'remove-bg',
        pixels:      pixelsCopy,
        width:       width,
        height:      height,
        threshold:   opts.threshold   || 235,
        qualityMode: opts.qualityMode || 'hd',
        subjectMode: opts.subjectMode || 'auto',
        jobId:       String(jobId),
      }, [pixelsCopy]);
    });
  }

  // ── Apply result pixels to a new canvas, optionally fill background ────────
  function _buildResultCanvas(pixels, width, height, bgColor) {
    var outCvs = document.createElement('canvas');
    outCvs.width  = width;
    outCvs.height = height;
    var outCtx = outCvs.getContext('2d');

    if (bgColor && bgColor !== 'transparent') {
      outCtx.fillStyle = bgColor;
      outCtx.fillRect(0, 0, width, height);
    }

    var imgData = outCtx.createImageData(width, height);
    imgData.data.set(new Uint8ClampedArray(pixels));
    outCtx.putImageData(imgData, 0, 0);
    return outCvs;
  }

  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  // ── Canvas to PNG Blob ────────────────────────────────────────────────────
  function _canvasToBlob(cvs, mime, quality) {
    return new Promise(function (resolve, reject) {
      cvs.toBlob(function (b) {
        if (b) resolve(b);
        else reject(new Error('Canvas encoding failed'));
      }, mime || 'image/png', quality || 1.0);
    });
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Background removal already in progress');
    _inFlight = true;
    var jobId = ++_jobId;
    var file  = files && files[0];
    if (!file) { _cleanup('no-file'); throw new Error('No file provided'); }

    BgRemoveScheduler.onStart();
    BgRemoveMemoryManager.checkMemory();
    BgRemoveTelemetry.record('job:start', { job: jobId, file: file.name });
    _log('start', { job: jobId, file: file.name });

    var onStep  = _makeStepper();
    var bgColor = (opts && opts.bgColor) || 'transparent';

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Background removal timed out. Please try with a smaller image.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Loading your image\u2026');

      var loaded = await _loadImageData(file);
      _canvas = loaded.canvas;
      var W   = loaded.width;
      var H   = loaded.height;
      var rawPixels = loaded.imgData.data.buffer;

      onStep(0, 'done', 18);
      onStep(1, 'active', 22, 'Removing background\u2026');

      var wResult = null;
      try {
        wResult = await _runRemoveBgWorker(rawPixels, W, H, opts || {}, jobId);
      } catch (workerErr) {
        _warn('remove-bg-worker failed', workerErr.message);
        BgRemoveTelemetry.record('worker:fail', { err: workerErr.message });
        throw new Error('Background removal failed: ' + workerErr.message);
      }
      rawPixels = null;

      onStep(1, 'done', 75);
      onStep(2, 'active', 78, 'Applying transparency\u2026');

      _outputCanvas = _buildResultCanvas(wResult.pixels, wResult.width, wResult.height, bgColor);
      wResult.pixels = null;

      onStep(2, 'done', 88);
      onStep(3, 'active', 90, 'Encoding output\u2026');

      var outputMime = (bgColor && bgColor !== 'transparent') ? 'image/jpeg' : 'image/png';
      var blob = await _canvasToBlob(_outputCanvas, outputMime, 0.92);

      var origName = file.name.replace(/\.[^.]+$/, '');
      var ext      = outputMime === 'image/jpeg' ? '.jpg' : '.png';
      var filename = 'ilovepdf-' + origName.toLowerCase().replace(/^ilovepdf-?/, '') + '-no-bg' + ext;

      onStep(3, 'done', 100);
      BgRemoveTelemetry.record('job:done', { job: jobId, blobSize: blob.size, W: W, H: H });
      _log('done', { job: jobId, blobSize: blob.size });
      return { blob: blob, filename: filename };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      BgRemoveScheduler.onFailure();
      BgRemoveRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { BgRemoveRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasWorker: !!_removeBgWorker, scheduler: BgRemoveScheduler.stats() };
  }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool('background-remover', function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.BgRemoveScheduler       = BgRemoveScheduler;
  G.BgRemoveMemoryManager   = BgRemoveMemoryManager;
  G.BgRemoveRecoveryManager = BgRemoveRecoveryManager;
  G.BgRemoveTelemetry       = BgRemoveTelemetry;
  _log('v1.0 ready');
}(window));

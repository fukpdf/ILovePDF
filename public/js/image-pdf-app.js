// ImagePdfApp v1.0 — Isolated Image↔PDF Tool App (Phase 2C)
//
// Handles TWO tool IDs:
//   'jpg-to-pdf'  → images → PDF via image-pipeline-worker.js
//   'pdf-to-jpg'  → PDF → images via isolated PDF.js + canvas renders
//
// PROBLEM SOLVED:
//   Both processors throw ERR.ORIG → browser-tools.js.  imagesToPdf uses
//   canvas for EXIF correction — canvases not freed on withTimeout().
//   pdfToJpg uses PDF.js instance that is not destroyed on withTimeout().
//
// SOLUTION:
//   ImagePdfApp intercepts both tool IDs.
//   jpg-to-pdf: delegates to image-pipeline-worker.js (dedicated, terminates after job).
//   pdf-to-jpg: isolated PDF.js per job (tracked in _pdfInst, destroyed in _cleanup).
//   Canvases tracked in _canvasList, freed in _cleanup.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL       = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var PIPELINE_WORKER = '/workers/image-pipeline-worker.js';
  // No artificial file/page/time limits. Processing remains constrained only by
  // the browser/device's real resources; recovery and cancellation stay active.

  var _inFlight        = false;
  var _jobId           = 0;
  var _pipelineWorker  = null;
  var _pdfInst         = null;
  var _canvasList      = [];
  var _hardTimer       = null;

  function _log(msg, d)  { console.debug('[ImagePdfApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[ImagePdfApp]',  msg, d !== undefined ? d : ''); }

  var ImagePdfScheduler = {
    _runs: 0, _failures: 0,
    canRun:    function () { return !_inFlight; }, priority: 'normal',
    onStart:   function () { ImagePdfScheduler._runs++; },
    onFailure: function () { ImagePdfScheduler._failures++; },
    stats:     function () { return { runs: ImagePdfScheduler._runs, failures: ImagePdfScheduler._failures }; },
  };
  var ImagePdfMemoryManager = {
    checkMemory: function () {
      try {
        if (G.RuntimeTelemetry && G.memTier && G.memTier() === 'critical') {
          G.RuntimeTelemetry.record('image-pdf:memory-advisory', { state: 'critical' });
        }
      } catch (_) {}
      return true;
    },
  };
  var ImagePdfRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { ImagePdfRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return ImagePdfRecoveryManager._errors.slice(); },
  };
  var ImagePdfTelemetry = {
    _events: [],
    record:  function (event, data) { ImagePdfTelemetry._events.push({ ts: Date.now(), event: event, data: data }); },
    getEvents: function () { return ImagePdfTelemetry._events.slice(); },
  };

  function _freeCanvas(cvs) { try { if (cvs) { cvs.width = 0; cvs.height = 0; } } catch (_) {} }

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)       { clearTimeout(_hardTimer); _hardTimer = null; }
    if (_pipelineWorker)  { try { _pipelineWorker.terminate(); } catch (_) {} _pipelineWorker = null; }
    if (_pdfInst)         { try { _pdfInst.destroy();           } catch (_) {} _pdfInst        = null; }
    _canvasList.forEach(_freeCanvas);
    _canvasList = [];
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

  // ── jpg-to-pdf path ────────────────────────────────────────────────────────
  function _runPipelineWorker(files, jobId, onStep) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(PIPELINE_WORKER); }
      catch (e) { return reject(new Error('image-pipeline-worker spawn failed: ' + (e.message || e))); }
      _pipelineWorker = w;

      var settled = false;
      function finish(err, value) {
        if (settled) return;
        settled = true;
        try { w.terminate(); } catch (_) {}
        _pipelineWorker = null;
        if (err) reject(err); else resolve(value);
      }

      w.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.__error) { finish(new Error(d.__error)); return; }
        if (d.type === 'ready') {
          w.postMessage({ op: 'init', jobId: String(jobId) });
          return;
        }
        if (d.type === 'image-ack') {
          var index = d.index;
          onStep(0, 'active', 5 + Math.round(((index + 1) / files.length) * 20), 'Loaded image ' + (index + 1));
          sendNext(index + 1);
          return;
        }
        if (d.type === 'done' && d.buffer instanceof ArrayBuffer) {
          finish(null, d);
          return;
        }
        finish(new Error('image-pipeline-worker: unexpected response'));
      };
      w.onerror = function (ev) {
        finish(new Error('image-pipeline-worker error: ' + (ev && ev.message || 'unknown')));
      };

      function sendNext(index) {
        if (index >= files.length) {
          onStep(1, 'active', 28, 'Converting images to PDF…');
          w.postMessage({ op: 'finalize', jobId: String(jobId) });
          return;
        }
        files[index].arrayBuffer().then(function (buf) {
          w.postMessage({
            op: 'add-image',
            data: buf,
            mime: files[index].type || 'image/jpeg',
            name: files[index].name,
            index: index,
            jobId: String(jobId),
          }, [buf]);
        }).catch(function (err) { finish(err); });
      }

      // The worker acknowledges each image before the next File is read, so
      // the main thread never accumulates every source image as ArrayBuffers.
      w.postMessage({ op: 'init', jobId: String(jobId) });
      function start() { sendNext(0); }
      var originalOnMessage = w.onmessage;
      // Start after the worker has accepted initialization; a second init is
      // harmless and keeps compatibility with cached worker startup timing.
      w.addEventListener('message', function boot(ev) {
        if (ev.data && ev.data.type === 'ready') {
          w.removeEventListener('message', boot);
          start();
        }
      });
    });
  }

  async function _processJpgToPdf(files, opts, onStep, jobId) {
    onStep(0, 'active', 5, 'Reading your images…');
    onStep(0, 'active', 5, 'Preparing image pipeline…');

    onStep(0, 'done', 25);
    onStep(1, 'active', 28, 'Converting to PDF…');

    var wResult = await _runPipelineWorker(files, jobId, onStep);

    onStep(1, 'done', 85);
    onStep(2, 'active', 88, 'Finalizing…');

    var blob = new Blob([wResult.buffer], { type: 'application/pdf' });
    onStep(2, 'done', 100);

    var name = files[0].name.replace(/\.[^.]+$/, '');
    return { blob: blob, filename: 'ilovepdf-' + name.toLowerCase().replace(/^ilovepdf-?/, '') + '.pdf' };
  }

  // ── pdf-to-jpg path ────────────────────────────────────────────────────────
  async function _processPdfToJpg(files, opts, onStep, jobId) {
    onStep(0, 'active', 5, 'Preparing your PDF\u2026');

    var file     = files[0];
    var buf      = await file.arrayBuffer();
    var pdfjsLib = await _loadPdfJs();
    var pdf      = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    _pdfInst     = pdf;
    buf          = null;

    var numPages = pdf.numPages;
    var scale    = (opts && opts.dpi === 300) ? 4.17 : (opts && opts.dpi === 150) ? 2.08 : 2.78; // 96dpi base
    var jpgBlobs = [];
    _canvasList  = [];

    onStep(0, 'done', 12);
    onStep(1, 'active', 15, 'Rendering pages\u2026');

    try {
      for (var i = 1; i <= numPages; i++) {
        var pg = await pdf.getPage(i);
        var vp = pg.getViewport({ scale: scale });
        var W  = Math.min(Math.round(vp.width),  8192);
        var H  = Math.min(Math.round(vp.height), 8192);

        var cvs = document.createElement('canvas');
        cvs.width = W; cvs.height = H;
        _canvasList.push(cvs);

        var ctx = cvs.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        pg.cleanup();

        var quality = (opts && opts.quality === 'low') ? 0.60 : (opts && opts.quality === 'medium') ? 0.80 : 0.92;
        var blob = await new Promise(function (resolve, reject) {
          cvs.toBlob(function (b) { b ? resolve(b) : reject(new Error('Canvas encode failed')); }, 'image/jpeg', quality);
        });
        jpgBlobs.push({ blob: blob, page: i });

        // Free canvas immediately — we only need the blob
        _freeCanvas(cvs);
        _canvasList[_canvasList.length - 1] = null;

        onStep(1, 'active', 15 + Math.round((i / numPages) * 60), 'Rendering page ' + i);
      }
    } finally {
      try { await pdf.destroy(); } catch (_) {}
      _pdfInst = null;
    }

    onStep(1, 'done', 78);
    onStep(2, 'active', 80, 'Packaging output\u2026');

    var fname = file.name.replace(/\.[^.]+$/, '');
    var blob2 = null;
    var filename = '';

    if (numPages === 1) {
      blob2    = jpgBlobs[0].blob;
      filename = 'ilovepdf-' + fname.toLowerCase().replace(/^ilovepdf-?/, '') + '.jpg';
    } else {
      // Multi-page: create a ZIP using JSZip if available, otherwise return first page
      if (G.JSZip) {
        var zip = new G.JSZip();
        jpgBlobs.forEach(function (item) {
          zip.file('page-' + item.page + '.jpg', item.blob);
        });
        blob2    = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
        filename = 'ilovepdf-' + fname.toLowerCase().replace(/^ilovepdf-?/, '') + '-pages.zip';
      } else {
        // Fallback: return first page with note
        blob2    = jpgBlobs[0].blob;
        filename = 'ilovepdf-' + fname.toLowerCase().replace(/^ilovepdf-?/, '') + '-page1.jpg';
        _warn('JSZip not available — returning page 1 only');
      }
    }

    onStep(2, 'done', 100);
    return { blob: blob2, filename: filename };
  }

  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  // ── Unified entry point (handles both tool IDs) ────────────────────────────
  async function process(files, opts) {
    if (_inFlight) throw new Error('Image/PDF conversion already in progress');
    if (!files || files.length === 0) throw new Error('No files provided');
    _inFlight = true;
    var jobId  = ++_jobId;

    // Determine tool ID from opts or file type
    var toolId = (opts && opts._toolId)
      || ((files[0].type === 'application/pdf' || /\.pdf$/i.test(files[0].name)) ? 'pdf-to-jpg' : 'jpg-to-pdf');

    ImagePdfScheduler.onStart();
    ImagePdfMemoryManager.checkMemory();
    ImagePdfTelemetry.record('job:start', { job: jobId, toolId: toolId, files: files.length });
    _log('start', { job: jobId, toolId: toolId, files: files.length });

    var onStep = _makeStepper();

    var hardPromise = null;

    var jobPromise = (toolId === 'pdf-to-jpg')
      ? _processPdfToJpg(files, opts, onStep, jobId)
      : _processJpgToPdf(files, opts, onStep, jobId);

    try {
      var result = await jobPromise;
      ImagePdfTelemetry.record('job:done', { job: jobId, blobSize: result.blob && result.blob.size });
      _log('done', { job: jobId });
      return result;
    } catch (err) {
      ImagePdfScheduler.onFailure();
      ImagePdfRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { ImagePdfRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasPdfInst: !!_pdfInst, canvases: _canvasList.length, scheduler: ImagePdfScheduler.stats() };
  }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    var factory = function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    };
    // Register with _toolId hint injected so process() knows which path to take
    ['jpg-to-pdf', 'pdf-to-jpg'].forEach(function (id) {
      G.ToolAppManager.registerTool(id, factory);
    });
    _log('registered for jpg-to-pdf + pdf-to-jpg');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.ImagePdfScheduler       = ImagePdfScheduler;
  G.ImagePdfMemoryManager   = ImagePdfMemoryManager;
  G.ImagePdfRecoveryManager = ImagePdfRecoveryManager;
  G.ImagePdfTelemetry       = ImagePdfTelemetry;
  _log('v1.0 ready');
}(window));

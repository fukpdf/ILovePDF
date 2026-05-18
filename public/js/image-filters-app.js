// ImageFiltersApp v1.0 — Isolated Image Filters Tool (Phase 3 Full Isolation)
// Uses OffscreenCanvas inside dedicated image-tools-worker.js.
// Supports: grayscale, sepia, blur, brighten, contrast, invert, sharpen.
// Sharpen uses manual 3×3 convolution — no ctx.filter needed.
// Spawns a fresh worker per job, terminated immediately after result.
// ADDITIVE ONLY — zero changes to any existing file.
(function (G) {
  'use strict';

  var TAG              = '[ImageFiltersApp]';
  var TOOL_ID          = 'image-filters';
  var IMAGE_WORKER     = '/workers/image-tools-worker.js';
  var HARD_LIMIT_MS    = 60000;
  var WORKER_LIMIT_MS  = 50000;

  var _inFlight   = false;
  var _jobId      = 0;
  var _worker     = null;
  var _hardTimer  = null;
  var _hardReject = null;

  function _log(m, d)  { console.debug(TAG, m, d !== undefined ? d : ''); }
  function _warn(m, d) { console.warn(TAG,  m, d !== undefined ? d : ''); }

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer) { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_worker)    { try { _worker.terminate(); } catch (_) {} _worker = null; }
    _inFlight = false;
  }

  function _getMime(file) { return file.type || 'image/png'; }
  function _ext(mime) {
    if (!mime) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('png'))  return 'png';
    if (mime.includes('webp')) return 'webp';
    return 'png';
  }

  function _runWorker(buffer, mime, opts, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(IMAGE_WORKER); }
      catch (e) { return reject(new Error(TAG + ' worker spawn failed: ' + (e.message || e))); }
      _worker = w;

      var timer = setTimeout(function () {
        try { w.terminate(); } catch (_) {}
        _worker = null;
        reject(new Error('Image filter worker timed out.'));
      }, WORKER_LIMIT_MS);

      w.onmessage = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _worker = null;
        var d = ev.data || {};
        if (d.__error) { reject(new Error(d.__error)); return; }
        if (d.buffer instanceof ArrayBuffer) { resolve(d); return; }
        reject(new Error(TAG + ' unexpected worker response'));
      };
      w.onerror = function (ev) {
        clearTimeout(timer);
        try { w.terminate(); } catch (_) {}
        _worker = null;
        reject(new Error(TAG + ' worker error: ' + (ev && ev.message || 'unknown')));
      };

      var xfer = buffer.slice(0);
      w.postMessage({ op: 'image-filters', buffer: xfer, mime: mime, opts: opts, jobId: String(jobId) }, [xfer]);
    });
  }

  function _filename(orig, ext, filter) {
    var base = (orig || 'image').replace(/\.[^.]+$/, '');
    var tag  = filter ? '-' + filter : '';
    return (base.toLowerCase().startsWith('ilovepdf') ? base : 'ilovepdf-' + base) + tag + '.' + ext;
  }

  function _step() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') return function (i, s, p, h) { try { lf.update(i, s, p, h); } catch (_) {} };
    return function () {};
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Image filter already in progress');
    if (!files || !files[0]) throw new Error('No file provided');
    _inFlight = true;
    var jobId  = ++_jobId;
    var file   = files[0];
    var mime   = _getMime(file);
    var filter = (opts && opts.filter) || 'grayscale';
    _log('start', { job: jobId, file: file.name, filter: filter });

    var onStep = _step();

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _cleanup('hard-timeout');
        reject(new Error('Image filter timed out.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Reading image\u2026');
      var buf = await file.arrayBuffer();
      onStep(0, 'done', 25);
      onStep(1, 'active', 30, 'Applying ' + filter + ' filter\u2026');
      await new Promise(function (r) { setTimeout(r, 4); });

      var result = await _runWorker(buf, mime, opts || {}, jobId);
      buf = null;

      onStep(1, 'done', 85);
      onStep(2, 'active', 90, 'Finalizing\u2026');
      var ext  = result.ext || _ext(result.mime || mime);
      var blob = new Blob([result.buffer], { type: result.mime || mime });
      onStep(2, 'done', 100);
      _log('done', { job: jobId, size: blob.size });
      return { blob: blob, filename: _filename(file.name, ext, filter), ext: ext, mime: result.mime || mime };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      _warn('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { _cleanup('recover'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() { return { inFlight: _inFlight, jobId: _jobId, hasWorker: !!_worker }; }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool(TOOL_ID, function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  _log('v1.0 ready');
}(window));

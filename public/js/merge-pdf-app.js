// MergePdfApp v1.0 — Isolated Merge PDF Tool (Phase 3 Full Isolation)
// Spawns a dedicated pdf-lib-worker.js per job. Terminated after result.
// Fixes: main-thread blocking, no cleanup on error, first-fail contamination.
// ADDITIVE ONLY — zero changes to any existing file.
(function (G) {
  'use strict';

  var TAG             = '[MergePdfApp]';
  var TOOL_ID         = 'merge';
  var PDF_LIB_WORKER  = '/workers/pdf-lib-worker.js';
  var WORKER_LIMIT_MS = 180000;

  // ── isolated state ──────────────────────────────────────────────────────────
  var _inFlight   = false;
  var _jobId      = 0;
  var _worker     = null;
  var _hardTimer = null;
  var _hardReject = null;

  function _log(m, d)  { console.debug(TAG, m, d !== undefined ? d : ''); }
  function _warn(m, d) { console.warn(TAG,  m, d !== undefined ? d : ''); }

  // ── guaranteed cleanup ──────────────────────────────────────────────────────
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)  { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_worker)     { try { _worker.terminate(); } catch (_) {} _worker = null; }
    _inFlight = false;
  }

  // ── dedicated worker (spawn-per-job, terminate-after-result) ───────────────
  function _runWorker(files, opts, jobId) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(PDF_LIB_WORKER); }
      catch (e) { return reject(new Error(TAG + ' worker spawn failed: ' + (e.message || e))); }
      _worker = w;
      var timer = setTimeout(function () { try { w.terminate(); } catch (_) {} _worker = null; reject(new Error('Merge worker timed out.')); }, WORKER_LIMIT_MS);
      var settled = false;
      function finish(fn, value) { if (settled) return; settled = true; clearTimeout(timer); try { w.terminate(); } catch (_) {} _worker = null; fn(value); }
      function send(index) {
        return files[index].arrayBuffer().then(function (buffer) {
          w.postMessage({ op: 'merge-stream-item', index: index, buffer: buffer, jobId: String(jobId) }, [buffer]);
        });
      }
      w.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.__error) return finish(reject, new Error(d.__error));
        if (d.type === 'merge-stream-ready') return send(0).catch(function(e){ finish(reject,e); });
        if (d.type === 'merge-stream-ack') {
          var next = Number(d.index) + 1;
          if (next < files.length) send(next).catch(function(e){ finish(reject,e); });
          else w.postMessage({ op: 'merge-stream-finish', jobId: String(jobId) });
          return;
        }
        if (d.type === 'merge-stream-done' && d.buffer instanceof ArrayBuffer) return finish(resolve, d.buffer);
      };
      w.onerror = function(ev){ finish(reject, new Error(TAG + ' worker error: ' + (ev && ev.message || 'unknown'))); };
      w.postMessage({ op: 'merge-stream-start', count: files.length, opts: opts || {}, jobId: String(jobId) });
    });
  }

  // ── filename helper ─────────────────────────────────────────────────────────
  function _filename() {
    return 'ilovepdf-merged.pdf';
  }

  // ── progress helper ─────────────────────────────────────────────────────────
  function _step() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') return function (i, s, p, h) { try { lf.update(i, s, p, h); } catch (_) {} };
    return function () {};
  }

  // ── main process ────────────────────────────────────────────────────────────
  async function process(files, opts) {
    if (_inFlight) throw new Error('Merge already in progress');
    if (!files || !files.length) throw new Error('No files provided');
    _inFlight = true;
    var jobId = ++_jobId;
    _log('start', { job: jobId, files: files.length });

    var onStep = _step();

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer = setTimeout(function () { _log('HARD TIMEOUT', jobId); _cleanup('hard-timeout'); reject(new Error('Merge timed out.')); }, WORKER_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Reading files\u2026');
      var resultBuf = await _runWorker(files, opts || {}, jobId);

      onStep(1, 'done', 85);
      onStep(2, 'active', 90, 'Finalizing\u2026');

      var blob = new Blob([resultBuf], { type: 'application/pdf' });
      resultBuf = null;

      onStep(2, 'done', 100);
      _log('done', { job: jobId, size: blob.size });
      return { blob: blob, filename: _filename() };
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

  // ── lifecycle ───────────────────────────────────────────────────────────────
  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { _cleanup('recover'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() { return { inFlight: _inFlight, jobId: _jobId, hasWorker: !!_worker }; }

  // ── registration ────────────────────────────────────────────────────────────
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

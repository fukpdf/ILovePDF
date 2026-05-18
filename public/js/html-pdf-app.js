// HtmlPdfApp v1.0 — Isolated HTML-to-PDF Tool (Phase 3 Full Isolation)
// html2pdf.js requires real DOM + html2canvas — cannot run in a worker.
// Isolation via: in-flight guard, hard timeout, container cleanup, canvas zeroing.
// Tracks all canvases created during processing and zeros them on cleanup.
// ADDITIVE ONLY — zero changes to any existing file.
(function (G) {
  'use strict';

  var TAG           = '[HtmlPdfApp]';
  var TOOL_ID       = 'html-to-pdf';
  var HARD_LIMIT_MS = 120000; // 2 min — html2canvas can be slow on complex pages

  var _inFlight     = false;
  var _jobId        = 0;
  var _hardTimer    = null;
  var _hardReject   = null;
  var _container    = null; // hidden render container
  var _canvases     = [];   // canvases created during processing

  function _log(m, d)  { console.debug(TAG, m, d !== undefined ? d : ''); }
  function _warn(m, d) { console.warn(TAG,  m, d !== undefined ? d : ''); }

  // ── guaranteed cleanup ──────────────────────────────────────────────────────
  // Zeros all canvases created during processing, removes container element.
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer) { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }

    // Zero out any canvases to release GPU memory
    for (var i = 0; i < _canvases.length; i++) {
      try { _canvases[i].width = 0; _canvases[i].height = 0; } catch (_) {}
    }
    _canvases = [];

    // Remove hidden render container from DOM
    if (_container && _container.parentNode) {
      try { _container.parentNode.removeChild(_container); } catch (_) {}
    }
    _container = null;

    // Also sweep any orphaned ilovepdf-html2pdf-* containers
    try {
      var orphans = document.querySelectorAll('[data-ilovepdf-html2pdf]');
      for (var j = 0; j < orphans.length; j++) {
        try { orphans[j].parentNode && orphans[j].parentNode.removeChild(orphans[j]); } catch (_) {}
      }
    } catch (_) {}

    _inFlight = false;
  }

  // ── canvas tracker ──────────────────────────────────────────────────────────
  // Wraps document.createElement to intercept canvas creation during html2canvas.
  // Restored immediately after processing completes.
  var _origCreateElement = null;
  function _installCanvasTracker() {
    if (_origCreateElement) return;
    _origCreateElement = document.createElement.bind(document);
    document.createElement = function (tag) {
      var el = _origCreateElement(tag);
      if (String(tag).toLowerCase() === 'canvas') {
        _canvases.push(el);
      }
      return el;
    };
  }
  function _uninstallCanvasTracker() {
    if (_origCreateElement) {
      document.createElement = _origCreateElement;
      _origCreateElement = null;
    }
  }

  // ── filename helper ─────────────────────────────────────────────────────────
  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return (base.toLowerCase().startsWith('ilovepdf') ? base : 'ilovepdf-' + base) + '.pdf';
  }

  // ── progress helper ─────────────────────────────────────────────────────────
  function _step() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') return function (i, s, p, h) { try { lf.update(i, s, p, h); } catch (_) {} };
    return function () {};
  }

  // ── load html2pdf.js if not present ────────────────────────────────────────
  var _html2pdfSlot = null;
  function _loadHtml2Pdf() {
    if (_html2pdfSlot) return _html2pdfSlot;
    _html2pdfSlot = new Promise(function (resolve, reject) {
      if (G.html2pdf) { resolve(); return; }
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      s.onload  = resolve;
      s.onerror = function () { reject(new Error('html2pdf.js failed to load')); };
      document.head.appendChild(s);
    });
    return _html2pdfSlot;
  }

  // ── main process ────────────────────────────────────────────────────────────
  async function process(files, opts) {
    if (_inFlight) throw new Error('HTML to PDF already in progress');
    if (!files || !files[0]) throw new Error('No file provided');
    _inFlight = true;
    var jobId = ++_jobId;
    var file  = files[0];
    _log('start', { job: jobId, file: file.name });

    var onStep = _step();

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _uninstallCanvasTracker();
        _cleanup('hard-timeout');
        reject(new Error('HTML to PDF timed out. The document may be too complex.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Reading HTML file\u2026');
      var htmlText = await file.text();
      onStep(0, 'done', 15);
      onStep(1, 'active', 20, 'Loading converter\u2026');

      await _loadHtml2Pdf();
      if (!G.html2pdf) throw new Error('html2pdf.js unavailable');

      onStep(1, 'done', 30);
      onStep(2, 'active', 35, 'Rendering HTML\u2026');

      // Build isolated container
      _container = document.createElement('div');
      _container.setAttribute('data-ilovepdf-html2pdf', '1');
      _container.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:794px;visibility:hidden;pointer-events:none;z-index:-1';
      _container.innerHTML = htmlText;
      document.body.appendChild(_container);

      // Install canvas tracker before html2canvas runs
      _installCanvasTracker();

      var pageSize    = (opts && opts.pageSize)    || 'a4';
      var orientation = (opts && opts.orientation) || 'portrait';
      var marginVal   = parseFloat((opts && opts.margins) || '10') || 10;

      var pdfBlob = await G.html2pdf()
        .set({
          margin:      marginVal,
          filename:    _filename(file.name),
          pagebreak:   { mode: ['css', 'legacy'] },
          image:       { type: 'jpeg', quality: 0.92 },
          html2canvas: { scale: 2, useCORS: true, logging: false, removeContainer: true },
          jsPDF:       { unit: 'mm', format: pageSize, orientation: orientation },
        })
        .from(_container)
        .outputPdf('blob');

      _uninstallCanvasTracker();

      onStep(2, 'done', 85);
      onStep(3, 'active', 90, 'Finalizing\u2026');
      onStep(3, 'done', 100);

      _log('done', { job: jobId, size: pdfBlob.size });
      return { blob: pdfBlob, filename: _filename(file.name) };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      _uninstallCanvasTracker();
      _warn('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _uninstallCanvasTracker(); _cleanup('unmount'); }
  function reset()    { _uninstallCanvasTracker(); _cleanup('reset'); }
  function recover()  { _uninstallCanvasTracker(); _cleanup('recover'); }
  function destroy()  { _uninstallCanvasTracker(); _cleanup('destroy'); }
  function getState() { return { inFlight: _inFlight, jobId: _jobId, canvases: _canvases.length, hasContainer: !!_container }; }

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

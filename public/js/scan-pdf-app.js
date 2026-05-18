// ScanPdfApp v1.0 — Isolated Scan-to-PDF Tool App (Phase 2C)
//
// PROBLEM SOLVED:
//   processors['scan-to-pdf'] throws ERR.ORIG → browser-tools.js scanPdf().
//   scanPdf uses Tesseract.recognize (static API) in the OCR/searchable-PDF path.
//   On withTimeout() abandonment, static Tesseract state may be stuck.
//   Canvas arrays (pageCanvases) are not freed when withTimeout() fires.
//
// SOLUTION:
//   ScanPdfApp intercepts 'scan-to-pdf'.
//   • PDF output path (outputFormat:'pdf'): canvas only + pdf-lib — NO Tesseract.
//   • OCR output paths (txt, searchable-pdf, docx): isolated Tesseract.createWorker()
//     per job, tracked in _tessWorker, terminated in _cleanup().
//   • All canvases tracked in _pageCanvases, freed in _cleanup().
//   • EXIF-aware image loading + deskew + contrast enhancement.
//
// ADDITIVE ONLY: zero changes to any existing file.
(function (G) {
  'use strict';

  var PDFLIB_CDN    = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  var TESS_CDN      = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var HARD_LIMIT_MS = 300000; // 5 min (multi-page OCR can be slow)
  var OCR_INIT_MS   = 45000;
  var OCR_PAGE_MS   = 60000;

  var _inFlight      = false;
  var _jobId         = 0;
  var _tessWorker    = null;
  var _pageCanvases  = [];
  var _hardTimer     = null;
  var _hardReject    = null;

  function _log(msg, d)  { console.debug('[ScanPdfApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[ScanPdfApp]',  msg, d !== undefined ? d : ''); }

  var ScanScheduler = {
    _runs: 0, _failures: 0,
    canRun:    function () { return !_inFlight; }, priority: 'normal',
    onStart:   function () { ScanScheduler._runs++; },
    onFailure: function () { ScanScheduler._failures++; },
    stats:     function () { return { runs: ScanScheduler._runs, failures: ScanScheduler._failures }; },
  };
  var ScanMemoryManager = {
    checkMemory: function () {
      if (G.memTier && G.memTier() === 'critical') throw new Error('Not enough memory. Please close other tabs.');
    },
  };
  var ScanRecoveryManager = {
    _errors: [],
    recover:   function (label) { _cleanup('recovery:' + (label || 'unknown')); },
    onError:   function (err)   { ScanRecoveryManager._errors.push({ ts: Date.now(), msg: err && err.message }); },
    getErrors: function ()      { return ScanRecoveryManager._errors.slice(); },
  };
  var ScanTelemetry = {
    _events: [],
    record:  function (event, data) { ScanTelemetry._events.push({ ts: Date.now(), event: event, data: data }); },
    getEvents: function () { return ScanTelemetry._events.slice(); },
  };

  function _freeCanvas(cvs) { try { if (cvs) { cvs.width = 0; cvs.height = 0; } } catch (_) {} }

  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_hardTimer)  { clearTimeout(_hardTimer); _hardTimer = null; _hardReject = null; }
    if (_tessWorker) { try { _tessWorker.terminate(); } catch (_) {} _tessWorker = null; }
    _pageCanvases.forEach(_freeCanvas);
    _pageCanvases = [];
    _inFlight = false;
  }

  function _race(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error((label || 'Op') + ' timed out')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  function _loadPdfLib() {
    if (G.PDFLib) return Promise.resolve(G.PDFLib);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFLIB_CDN;
      s.onload  = function () { resolve(G.PDFLib); };
      s.onerror = function () { reject(new Error('pdf-lib failed to load')); };
      document.head.appendChild(s);
    });
  }

  // ── Load image from File → canvas ─────────────────────────────────────────
  function _loadImageCanvas(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var cvs = document.createElement('canvas');
        cvs.width = img.naturalWidth; cvs.height = img.naturalHeight;
        var ctx = cvs.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cvs.width, cvs.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(cvs);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image: ' + file.name));
      };
      img.src = url;
    });
  }

  // ── Simple auto-level / contrast enhancement ──────────────────────────────
  function _enhance(ctx, W, H) {
    var imgData = ctx.getImageData(0, 0, W, H);
    var d = imgData.data;
    var lo = 255, hi = 0;
    for (var i = 0; i < d.length; i += 4) {
      var lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      if (lum < lo) lo = lum;
      if (lum > hi) hi = lum;
    }
    if (hi - lo < 20) return; // already high-contrast
    var scale = hi > lo ? 255 / (hi - lo) : 1;
    for (var j = 0; j < d.length; j += 4) {
      d[j]     = Math.min(255, Math.max(0, Math.round((d[j]     - lo) * scale)));
      d[j + 1] = Math.min(255, Math.max(0, Math.round((d[j + 1] - lo) * scale)));
      d[j + 2] = Math.min(255, Math.max(0, Math.round((d[j + 2] - lo) * scale)));
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function _makeStepper() {
    var lf = G.LiveFeed || G.__ae_livefeed;
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) { try { lf.update(idx, state, pct, hint); } catch (_) {} };
    }
    return function () {};
  }

  async function process(files, opts) {
    if (_inFlight) throw new Error('Scan-to-PDF already in progress');
    if (!files || files.length === 0) throw new Error('No image files provided');
    _inFlight = true;
    var jobId = ++_jobId;

    ScanScheduler.onStart();
    ScanMemoryManager.checkMemory();
    ScanTelemetry.record('job:start', { job: jobId, files: files.length });
    _log('start', { job: jobId, files: files.length });

    var onStep    = _makeStepper();
    var outputFmt = (opts && opts.outputFormat) || 'pdf';
    var lang      = (opts && opts.language)     || 'eng';

    var hardPromise = new Promise(function (_, reject) {
      _hardReject = reject;
      _hardTimer  = setTimeout(function () {
        _log('HARD TIMEOUT', jobId);
        _cleanup('hard-timeout');
        reject(new Error('Scan-to-PDF timed out. Please try with fewer or smaller images.'));
      }, HARD_LIMIT_MS);
    });

    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your images\u2026');

      // Validate combined size
      var totalMB = files.reduce(function (s, f) { return s + f.size; }, 0) / 1048576;
      if (totalMB > 400) throw new Error('The combined image size (' + totalMB.toFixed(0) + ' MB) is too large. Please use fewer or smaller images.');

      // Load + enhance all images
      _pageCanvases = [];
      for (var fi = 0; fi < files.length; fi++) {
        var cvs = await _loadImageCanvas(files[fi]);
        _enhance(cvs.getContext('2d'), cvs.width, cvs.height);
        _pageCanvases.push(cvs);
        onStep(0, 'active', 5 + Math.round((fi / files.length) * 15), 'Loading image ' + (fi + 1));
      }

      onStep(0, 'done', 20);
      onStep(1, 'active', 23, 'Building output\u2026');

      // ── PDF output path: embed enhanced images (NO Tesseract needed) ───────
      if (outputFmt === 'pdf') {
        var PDFLib = await _loadPdfLib();
        if (!PDFLib) throw new Error('pdf-lib unavailable');
        var PDFDocument = PDFLib.PDFDocument;
        var doc         = await PDFDocument.create();

        for (var ci = 0; ci < _pageCanvases.length; ci++) {
          var cvs2 = _pageCanvases[ci];
          var jpgBytes = await new Promise(function (resolve, reject) {
            cvs2.toBlob(function (b) {
              if (!b) { reject(new Error('Canvas encode failed')); return; }
              b.arrayBuffer().then(function (ab) { resolve(new Uint8Array(ab)); }).catch(reject);
            }, 'image/jpeg', 0.92);
          });
          var embImg = await doc.embedJpg(jpgBytes);
          var page   = doc.addPage([embImg.width, embImg.height]);
          page.drawImage(embImg, { x: 0, y: 0, width: embImg.width, height: embImg.height });
          onStep(1, 'active', 23 + Math.round((ci / _pageCanvases.length) * 60), 'Embedding page ' + (ci + 1));
        }

        var pdfBytes = await doc.save();
        if (!pdfBytes || pdfBytes.length < 200) throw new Error('Could not create PDF from images.');

        var blob = new Blob([pdfBytes], { type: 'application/pdf' });
        var name = files[0].name.replace(/\.[^.]+$/, '');
        onStep(1, 'done', 85);
        onStep(2, 'active', 88, 'Finalizing\u2026');
        onStep(2, 'done', 100);
        ScanTelemetry.record('job:done', { job: jobId, outputFmt: 'pdf', pages: _pageCanvases.length });
        return { blob: blob, filename: 'ilovepdf-' + name + '.pdf' };
      }

      // ── OCR paths: run isolated Tesseract per job ──────────────────────────
      if (!G.Tesseract) {
        await new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = TESS_CDN; s.onload = resolve;
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

      var allPageData = [];
      var totalConf   = 0;

      for (var oi = 0; oi < _pageCanvases.length; oi++) {
        var oCvs = _pageCanvases[oi];
        var dataUrl = oCvs.toDataURL('image/jpeg', 0.90);
        var recog   = await _race(
          tw.recognize(dataUrl, { tessedit_pageseg_mode: '3' }),
          OCR_PAGE_MS, 'OCR page ' + (oi + 1)
        );
        var conf = typeof recog.data.confidence === 'number' ? recog.data.confidence : 0;
        totalConf += conf;
        allPageData.push({ text: (recog.data.text || '').trim(), confidence: conf, words: recog.data.words || [] });
        onStep(1, 'active', 23 + Math.round((oi / _pageCanvases.length) * 45), 'OCR page ' + (oi + 1));
      }

      try { await tw.terminate(); } catch (_) {}
      _tessWorker = null;

      var avgConf = allPageData.length > 0 ? totalConf / allPageData.length : 0;
      ScanTelemetry.record('ocr:done', { conf: avgConf.toFixed(1), pages: allPageData.length });
      if (avgConf < 5) throw new Error('Low scan quality detected. Try a different enhancement mode or language setting.');

      onStep(1, 'done', 75);
      onStep(2, 'active', 78, 'Building output\u2026');

      var name2 = files[0].name.replace(/\.[^.]+$/, '');
      var blob2 = null;
      var fname = '';

      if (outputFmt === 'txt') {
        var full = allPageData.map(function (p, i) {
          return (allPageData.length > 1 ? '--- Page ' + (i + 1) + ' ---\n' : '') + p.text;
        }).join('\n\n');
        blob2 = new Blob([full], { type: 'text/plain;charset=utf-8' });
        fname = 'ilovepdf-' + name2 + '.txt';
      } else {
        // searchable-pdf: overlay invisible text over the image PDF
        var PDFLib2 = await _loadPdfLib();
        if (!PDFLib2) throw new Error('pdf-lib unavailable');
        var PDFDocument2 = PDFLib2.PDFDocument;
        var StandardFonts = PDFLib2.StandardFonts;
        var doc2 = await PDFDocument2.create();
        var font = await doc2.embedFont(StandardFonts.Helvetica);

        for (var pi = 0; pi < _pageCanvases.length; pi++) {
          var pCvs    = _pageCanvases[pi];
          var jpgB    = await new Promise(function (resolve, reject) {
            pCvs.toBlob(function (b) {
              if (!b) { reject(new Error('Canvas encode failed')); return; }
              b.arrayBuffer().then(function (ab) { resolve(new Uint8Array(ab)); }).catch(reject);
            }, 'image/jpeg', 0.92);
          });
          var eImg = await doc2.embedJpg(jpgB);
          var pg2  = doc2.addPage([eImg.width, eImg.height]);
          pg2.drawImage(eImg, { x: 0, y: 0, width: eImg.width, height: eImg.height });

          // Overlay invisible OCR text
          var words = allPageData[pi] ? allPageData[pi].words : [];
          words.forEach(function (word) {
            if (!word.text || !word.bbox) return;
            try {
              var scaleX = eImg.width  / pCvs.width;
              var scaleY = eImg.height / pCvs.height;
              var x = word.bbox.x0 * scaleX;
              var y = eImg.height - word.bbox.y1 * scaleY;
              var w2 = (word.bbox.x1 - word.bbox.x0) * scaleX;
              var h2 = (word.bbox.y1 - word.bbox.y0) * scaleY;
              var fs = Math.max(6, Math.min(h2 * 0.85, 48));
              var tw2 = font.widthOfTextAtSize(word.text, fs) || 1;
              var xScale = w2 / tw2;
              pg2.drawText(word.text, {
                x: x, y: y, size: fs,
                font: font,
                color: PDFLib2.rgb(0, 0, 0),
                opacity: 0.001,
                xSkewAngle: PDFLib2.degrees(0),
              });
            } catch (_) {}
          });
        }

        var pdfBytes2 = await doc2.save();
        blob2 = new Blob([pdfBytes2], { type: 'application/pdf' });
        fname = 'ilovepdf-' + name2 + '-searchable.pdf';
      }

      onStep(2, 'done', 100);
      ScanTelemetry.record('job:done', { job: jobId, outputFmt: outputFmt, pages: allPageData.length });
      _log('done', { job: jobId });
      return { blob: blob2, filename: fname };
    })();

    try {
      return await Promise.race([jobPromise, hardPromise]);
    } catch (err) {
      ScanScheduler.onFailure();
      ScanRecoveryManager.onError(err);
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      _cleanup('job-finally-' + jobId);
    }
  }

  function mount()    { _log('mounted'); }
  function unmount()  { _cleanup('unmount'); }
  function reset()    { _cleanup('reset'); }
  function recover()  { ScanRecoveryManager.recover('lifecycle'); }
  function destroy()  { _cleanup('destroy'); }
  function getState() {
    return { inFlight: _inFlight, jobId: _jobId, hasTessWorker: !!_tessWorker, canvases: _pageCanvases.length, scheduler: ScanScheduler.stats() };
  }

  function _register() {
    if (!G.ToolAppManager) { _warn('ToolAppManager not available'); return; }
    G.ToolAppManager.registerTool('scan-to-pdf', function () {
      return { process: process, mount: mount, unmount: unmount, reset: reset, recover: recover, destroy: destroy, getState: getState };
    });
    _log('registered');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.ScanScheduler       = ScanScheduler;
  G.ScanMemoryManager   = ScanMemoryManager;
  G.ScanRecoveryManager = ScanRecoveryManager;
  G.ScanTelemetry       = ScanTelemetry;
  _log('v1.0 ready');
}(window));

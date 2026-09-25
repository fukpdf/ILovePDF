// PdfToWordApp v1.0 — Isolated PDF→Word Tool App (Phase 2 Microfrontend Migration)
//
// Worker-safe packaging migration for the high-fidelity PDF→Word pipeline.
// PDF.js extraction, OCR rasterisation, Tesseract recognition, and DOCX
// packaging are progressively isolated behind shared WorkerPool boundaries.
//
// SOLUTION:
//   PdfToWordApp installs a BrowserTools.process interceptor for 'pdf-to-word' ONLY.
//   It runs a fully isolated pipeline where:
//   — ALL async operations are wrapped in try/finally with guaranteed cleanup
//   — Cancellation propagates through WorkerPool.CancelToken
//   — PDF.js extraction/rendering, OCR, and DOCX packaging use WorkerPool jobs
//   — _inFlight flag prevents re-entry; always reset in finally
//
// ADDITIVE ONLY: zero changes to advanced-engine.js, browser-tools.js,
//               tool-page.js, workerPool.js, or any existing file.
(function (G) {
  'use strict';

  var DOCX_WORKER    = '/workers/pdf-word-docx-worker.js';
  var EXTRACT_WORKER = '/workers/pdf-word-extract-worker.js';
  var RENDER_WORKER  = '/workers/pdf-word-render-worker.js';
  var OCR_WORKER     = '/workers/pdf-word-ocr-worker.js';
  // No artificial job timeout; cancellation and worker lifecycle cleanup remain active.\n
  // ── ISOLATED STATE ─────────────────────────────────────────────────────────
  var _inFlight     = false;    // re-entry guard
  var _jobId        = 0;        // monotonic job counter

  // ── LOG ───────────────────────────────────────────────────────────────────
  function _log(msg, d)  { console.debug('[PdfToWordApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[PdfToWordApp]', msg, d !== undefined ? d : ''); }

  // ── GUARANTEED CLEANUP ───────────────────────────────────────────────────
  // Called from EVERY finally block (including the hard-timeout callback).
  // Never throws.
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    _inFlight = false;
  }

  async function _extractWithSharedWorker(file, cancelToken, onStep, jobId) {
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') throw new Error('Shared WorkerPool runtime unavailable');
    var buf = await file.arrayBuffer();
    var transfer = [buf];
    var result = await G.WorkerPool.run(EXTRACT_WORKER, {op:'extract-text',buffer:buf,jobId:String(jobId)}, transfer, {priority:'normal',token:cancelToken});
    if (!result || result.__error) throw new Error(result && result.__error || 'PDF extraction worker failed');
    if (!Array.isArray(result.pages)) throw new Error('PDF extraction worker returned invalid pages');
    if (!result.analysis || typeof result.analysis.totalChars !== 'number') throw new Error('PDF extraction worker returned invalid quality analysis');
    return result;
  }

  async function _recognizeOcrWithSharedWorker(imageBlob, lang, cancelToken, jobId) {
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') throw new Error('Shared WorkerPool runtime unavailable');
    var buffer = await imageBlob.arrayBuffer();
    var result = await G.WorkerPool.run(
      OCR_WORKER,
      {op:'recognize', buffer:buffer, lang:lang, jobId:String(jobId)},
      [buffer],
      {priority:'normal', token:cancelToken}
    );
    if (!result || result.__error) throw new Error(result && result.__error || 'OCR worker failed');
    if (typeof result.text !== 'string') throw new Error('OCR worker returned invalid text');
    if (!Array.isArray(result.paragraphs)) throw new Error('OCR worker returned invalid paragraphs');
    if (typeof result.charCount !== 'number') throw new Error('OCR worker returned invalid character count');
    return result;
  }

  async function _renderOcrPageWithSharedWorker(file, pageNum, scale, cancelToken, jobId) {
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') throw new Error('Shared WorkerPool runtime unavailable');
    var buf = await file.arrayBuffer();
    var result = await G.WorkerPool.run(
      RENDER_WORKER,
      {op:'render-page', buffer:buf, pageNum:pageNum, scale:scale, jobId:String(jobId)},
      [buf],
      {priority:'normal',token:cancelToken}
    );
    if (!result || result.__error) throw new Error(result && result.__error || 'PDF render worker failed');
    if (!result.buffer) throw new Error('PDF render worker returned no image buffer');
    return result;
  }

  // ── LANGUAGE DETECTION ────────────────────────────────────────────────────
  function _detectLang(filename) {
    var fn = (filename || '').toLowerCase();
    if (fn.match(/chi|zh/))               return 'chi_sim+eng';
    if (fn.match(/ara|_ar[._-]/))         return 'ara+eng';
    if (fn.match(/fas|per|far|_fa/))      return 'fas+eng';
    if (fn.match(/heb|_he[._-]/))         return 'heb+eng';
    if (fn.match(/rus|ru[._-]/))          return 'rus+eng';
    if (fn.match(/deu|ger/))              return 'deu+eng';
    if (fn.match(/fra|fr[._-]/))          return 'fra+eng';
    if (fn.match(/spa|es[._-]/))          return 'spa+eng';
    if (fn.match(/jpn|ja[._-]/))          return 'jpn+eng';
    if (fn.match(/kor|ko[._-]/))          return 'kor+eng';
    if (fn.match(/por|pt[._-]/))          return 'por+eng';
    if (fn.match(/hin|_hi[._-]/))         return 'hin+eng';
    return 'eng';
  }

  // ── OCR FALLBACK ──────────────────────────────────────────────────────────
  // Native PDF.js extraction has already completed in Phase 1 through
  // _extractWithSharedWorker(). This stage must not reopen the PDF in page
  // context just to perform a duplicate text pre-pass; totalPages is the
  // authoritative page count from that shared extraction result.
  // Tesseract recognition and rasterisation are both isolated behind WorkerPool.
  async function _runOcr(file, lang, onStep, cancelToken, jobId, totalPages) {
    // The OCR engine itself is loaded inside pdf-word-ocr-worker.js.
    // Keep this page-side compatibility reference out of the processing path.
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') {
      throw new Error('Shared WorkerPool runtime unavailable');
    }

    // Tesseract recognition is isolated behind the shared WorkerPool.
    onStep(1, 'active', 35, 'Running OCR\\u2026');

    var total = totalPages || 0;
    if (!total) throw new Error('OCR render stage received no page count');

    var ocrPages = [];
    var renderScale = 1.5;
    for (var oi = 1; oi <= total; oi++) {
      var rendered = await _renderOcrPageWithSharedWorker(file, oi, renderScale, cancelToken, jobId);
      var imageBlob = new Blob([rendered.buffer], {type: rendered.mimeType || 'image/png'});
      var recog = await _recognizeOcrWithSharedWorker(imageBlob, lang, cancelToken, jobId);
      ocrPages.push({ pageNum: oi, text: recog.text || '', paragraphs: recog.paragraphs || [], source: 'ocr' });
      ocrPages._charCount = (ocrPages._charCount || 0) + recog.charCount;

      onStep(1, 'active',
        35 + Math.round((oi / total) * 18),
        'OCR: page ' + oi + ' of ' + total
      );
    }

    return ocrPages;
  }

  // ── DOCX BUILD VIA DEDICATED WORKER ──────────────────────────────────────
  // DOCX packaging is scheduled through the shared WorkerPool; the worker URL
  // remains isolated because its protocol is richer than pdf-worker.js.
  function _buildDocx(pages, jobId, cancelToken) {
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') {
      return Promise.reject(new Error('Shared WorkerPool runtime unavailable'));
    }
    var message = { op: 'build-docx', pages: pages, jobId: String(jobId) };
    return G.WorkerPool.run(DOCX_WORKER, message, [], {
      priority: 'normal',
      token: cancelToken || null,
    }).then(function (d) {
      if (!d || d.__error) throw new Error((d && d.__error) || 'DOCX worker: unexpected response');
      if (!d.buffer) throw new Error('DOCX worker returned no document buffer');
      return d;
    });
  }


  // ── BRANDED FILENAME ─────────────────────────────────────────────────────
  function _filename(orig) {
    var base = (orig || 'document').replace(/\.[^.]+$/, '');
    return base.toLowerCase().startsWith('ilovepdf') ? base + '.docx' : 'ilovepdf-' + base + '.docx';
  }

  // ── PROGRESS REPORTING ────────────────────────────────────────────────────
  // Use window.LiveFeed if the AdvancedEngine has exposed it (it doesn't, but
  // some compatibility layers might). Fallback: no-op.  The tool page will still
  // show its spinner while the promise is pending and trigger download on resolve.
  function _makeStepper() {
    var lf = G.LiveFeed || (G.__ae_livefeed);  // check both possible exports
    if (lf && typeof lf.update === 'function') {
      return function (idx, state, pct, hint) {
        try { lf.update(idx, state, pct, hint); } catch (_) {}
      };
    }
    return function () {};  // no-op fallback
  }

  // ── MAIN PROCESS FUNCTION ─────────────────────────────────────────────────
  async function process(files, opts) {
    // Re-entry guard — prevents a second call while one is already in flight.
    // (tool-page.js also has its own guard, but we add a layer here.)
    if (_inFlight) throw new Error('Conversion already in progress');
    _inFlight = true;
    var jobId = ++_jobId;
    var file  = files && files[0];
    if (!file) { _cleanup('no-file'); throw new Error('No file provided'); }

    var forceOcr = !!(opts && (opts._forceOcr || opts._retryForceOcr));
    var ocrLang  = _detectLang(file.name);
    var onStep   = _makeStepper();
    var cancelToken = (G.WorkerPool && G.WorkerPool.CancelToken) ? new G.WorkerPool.CancelToken() : null;

    _log('start', { job: jobId, file: file.name, size: file.size, forceOcr: forceOcr });

    // No automatic job timeout. The user can cancel; finally still cleans up workers.\n
    // The actual job as an immediately-invoked async function so we can wrap
    // the entire thing in try/finally and guarantee cleanup even on unexpected
    // throws (e.g. OOM errors thrown by PDF.js during parsing).
    var jobPromise = (async function () {
      onStep(0, 'active', 5, 'Preparing your file\u2026');

      // ── Phase 1: PDF.js extraction in shared WorkerPool ───────────────────
      var extracted = await _extractWithSharedWorker(file, cancelToken, onStep, jobId);
      var extractedPages = extracted.pages;
      var total = extractedPages.length;
      var pages = extractedPages.map(function (p) {
        return { pageNum: p.pageNum, paragraphs: p.paragraphs || [] };
      }).filter(function (p) { return p.paragraphs.length > 0; });
      onStep(0, 'done', 53);
      onStep(1, 'active', 55, 'Checking text quality…');


      // ── Phase 2: Text quality check + OCR fallback ────────────────────────
      var avgCharsPerPage = extracted.analysis.avgCharsPerPage;
      var needsOcr = forceOcr || !pages.length || avgCharsPerPage < 8;

      if (needsOcr) {
        _log('OCR trigger', { avgCharsPerPage: avgCharsPerPage, forceOcr: forceOcr });
        var ocrRaw  = await _runOcr(file, ocrLang, onStep, cancelToken, jobId, total);
        var ocrLen  = ocrRaw._charCount;
        if (ocrLen < 10) {
          throw new Error('No readable text found. This may be a scanned document with unclear content.');
        }
        pages = ocrRaw.map(function (p) {
          return { pageNum: p.pageNum, paragraphs: p.paragraphs || [] };
        }).filter(function (p) { return p.paragraphs.length > 0; });
      }

      if (!pages.length) {
        pages = [{ pageNum: 1, paragraphs: [{ text: '(empty document)', isHeading: false }] }];
      }

      onStep(1, 'done', 53);
      onStep(2, 'active', 57, 'Building document\u2026');

      // ── Phase 3: DOCX build via dedicated isolated worker ─────────────────
      var docxResult = await _buildDocx(pages, jobId, cancelToken);
      var docxBuf = docxResult.buffer;
      // Worker already terminated inside _buildDocx on success/error.

      onStep(2, 'done', 90);
      onStep(3, 'active', 93, 'Finalizing\u2026');

      var blob = new Blob([docxBuf], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      docxBuf = null;

      var finalChars = docxResult.stats && typeof docxResult.stats.chars === 'number' ? docxResult.stats.chars : 0;
      var finalParas = docxResult.stats && typeof docxResult.stats.paras === 'number' ? docxResult.stats.paras : 0;

      onStep(3, 'done', 100);
      _log('done', { job: jobId, blobSize: blob.size, chars: finalChars, pages: total });

      return {
        blob:     blob,
        filename: _filename(file.name),
        _quality: { chars: finalChars, paras: finalParas, pages: total, ocrUsed: needsOcr },
      };
    })();

    // Race the job against the cancellation. Cleanup always runs in finally.
    try {
      return await jobPromise;
    } catch (err) {
      _log('error', { job: jobId, err: err && err.message });
      throw err;
    } finally {
      if (cancelToken && cancelToken.cancelled === false) { try { cancelToken.cancel(); } catch (_) {} }
      // This finally block is the CRITICAL guarantee:
      // Whether the job succeeded, errored, or was hard-timed-out,
      // all workers are terminated and the in-flight flag is reset.
      _cleanup('job-finally-' + jobId);
    }
  }

  // ── LIFECYCLE METHODS (used by ToolAppManager) ────────────────────────────
  function mount()   { _log('mounted'); }
  function unmount() { _cleanup('unmount'); _log('unmounted'); }
  function reset()   { _cleanup('reset'); }
  function recover() { _cleanup('recover'); }
  function destroy() { _cleanup('destroy'); }
  function getState() {
    return {
      inFlight: _inFlight,
      jobId: _jobId,
    };
  }

  // ── REGISTRATION ─────────────────────────────────────────────────────────
  // ToolAppManager.mountTool('pdf-to-word') is called on DOMContentLoaded by
  // ToolAppManager's auto-mount — it installs our BrowserTools.process interceptor.
  function _register() {
    if (!G.ToolAppManager) {
      _warn('ToolAppManager not available — registration skipped');
      return;
    }
    G.ToolAppManager.registerTool('pdf-to-word', function () {
      return {
        process:  process,
        mount:    mount,
        unmount:  unmount,
        reset:    reset,
        recover:  recover,
        destroy:  destroy,
        getState: getState,
      };
    });
    _log('registered with ToolAppManager');
  }

  _register();

}(window));

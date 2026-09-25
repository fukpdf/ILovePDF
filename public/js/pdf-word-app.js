// PdfToWordApp v1.0 — Isolated PDF→Word Tool App (Phase 2 Microfrontend Migration)
//
// Worker-safe packaging migration for the high-fidelity PDF→Word pipeline.
// PDF.js extraction and OCR rendering are progressively isolated; DOCX packaging
// is owned by the shared WorkerPool. Tesseract recognition remains page-context
// because its browser/runtime contract has not yet been proven safe to relocate.
//
// SOLUTION:
//   PdfToWordApp installs a BrowserTools.process interceptor for 'pdf-to-word' ONLY.
//   It runs a fully isolated pipeline where:
//   — ALL async operations are wrapped in try/finally with guaranteed worker cleanup
//   — Cancellation calls _cleanup() explicitly (terminates workers before rejecting)
//   — DOCX packaging is scheduled through the shared WorkerPool.
//   — Tesseract.createWorker() instances are tracked and terminated in _cleanup()
//   — _inFlight flag prevents re-entry; always reset in finally
//
// ADDITIVE ONLY: zero changes to advanced-engine.js, browser-tools.js,
//               tool-page.js, workerPool.js, or any existing file.
(function (G) {
  'use strict';

  var PDFJS_URL      = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WORKER   = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var DOCX_WORKER    = '/workers/pdf-word-docx-worker.js';
  var EXTRACT_WORKER = '/workers/pdf-word-extract-worker.js';
  var RENDER_WORKER  = '/workers/pdf-word-render-worker.js';
  var TESS_CDN       = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  // No artificial job timeout; cancellation and worker lifecycle cleanup remain active.\n
  // ── ISOLATED STATE ─────────────────────────────────────────────────────────
  var _inFlight     = false;    // re-entry guard
  var _jobId        = 0;        // monotonic job counter
  var _tessWorker   = null;     // current Tesseract worker (from createWorker)
  var _pdfInst      = null;     // current pdfjsLib pdf instance

  // ── LOG ───────────────────────────────────────────────────────────────────
  function _log(msg, d)  { console.debug('[PdfToWordApp]', msg, d !== undefined ? d : ''); }
  function _warn(msg, d) { console.warn('[PdfToWordApp]', msg, d !== undefined ? d : ''); }

  // ── GUARANTEED CLEANUP ───────────────────────────────────────────────────
  // Called from EVERY finally block (including the hard-timeout callback).
  // Never throws.
  function _cleanup(label) {
    if (label) _log('cleanup', label);
    if (_tessWorker)   { try { _tessWorker.terminate(); } catch (_) {} _tessWorker = null; }
    if (_pdfInst)      { try { _pdfInst.destroy();    } catch (_) {} _pdfInst    = null; }
    _inFlight = false;
  }

  // ── PDF.JS LOADER ─────────────────────────────────────────────────────────
  // Reuses the shared promise already set by advanced-engine.js (cache-safe).
  function _loadPdfJs() {
    if (G.pdfjsLib) return Promise.resolve(G.pdfjsLib);
    if (G.__pdfjsLibPromise) return G.__pdfjsLibPromise;
    var p = import(PDFJS_URL).then(function (mod) {
      var lib = (mod && (mod.default || mod));
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      G.pdfjsLib = lib;
      return lib;
    });
    G.__pdfjsLibPromise = p;
    return p;
  }

  // ── TIMEOUT RACE (NON-ABANDONING) ─────────────────────────────────────────
  // Unlike runTool's withTimeout(), this does NOT abandon the inner promise.
  // It rejects the outer awaiter but the inner async stack will still reach
  // its own finally — the key property that prevents the worker leak.
  function _race(promise) {
    // Compatibility wrapper retained for existing callers; no artificial timeout.
    return Promise.resolve(promise);
  }

  async function _extractWithSharedWorker(file, cancelToken, onStep, jobId) {
    if (!G.WorkerPool || typeof G.WorkerPool.run !== 'function') throw new Error('Shared WorkerPool runtime unavailable');
    var buf = await file.arrayBuffer();
    var transfer = [buf];
    var result = await G.WorkerPool.run(EXTRACT_WORKER, {op:'extract-text',buffer:buf,jobId:String(jobId)}, transfer, {priority:'normal',token:cancelToken});
    if (!result || result.__error) throw new Error(result && result.__error || 'PDF extraction worker failed');
    if (!Array.isArray(result.pages)) throw new Error('PDF extraction worker returned invalid pages');
    return result.pages;
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

  // ── SYMBOL NORMALISATION (mirrors advanced-worker.js) ─────────────────────
  function _normSym(t) {
    return (t || '')
      .replace(/[☑✓✔☒✗✘]/g, '[x]').replace(/[☐□\u2610]/g, '[ ]')
      .replace(/[\u2611\u2612]/g, '[x]');
  }
  function _isSignLine(t) {
    var s = (t || '').trim();
    return /^[_]{6,}$/.test(s) || /^[-]{8,}$/.test(s) || /^[=]{8,}$/.test(s) ||
           /^\.{8,}$/.test(s)  ||
           /^_{3,}\s*(Date|Sign|Name|Title|Signature|Witness)[:\s]*_{0,}$/i.test(s);
  }
  function _isFormLine(t) {
    return /^[A-Za-z\u0600-\u06FF\s]{2,40}:\s*\S/.test(t) ||
           /^[A-Za-z\u0600-\u06FF\s]{2,40}[.]{5,}\s*\S/.test(t);
  }
  var _LIST_RE     = /^\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb]\s/;
  var _NUMLIST_RE  = /^\s*(?:\d+|[a-zA-Z])[.)]\s+\S/;
  var _SECTION_RE  = /^(CHAPTER|SECTION|PART|ARTICLE|APPENDIX)\s+[\d\w]/i;

  // ── TEXT EXTRACTION FROM PDF.JS CONTENT ITEMS ─────────────────────────────
  // Implements the core of AE's _buildParaLines logic.
  function _extractParagraphs(items) {
    if (!items || !items.length) return [];

    var validItems = items.filter(function (it) { return it.str && it.str.trim() && it.transform; });
    if (!validItems.length) return [];

    // Font-height stats
    var heights = validItems.map(function (it) { return Math.abs(it.transform[3]); }).filter(function (h) { return h > 0; });
    heights.sort(function (a, b) { return a - b; });
    var medH = heights[Math.floor(heights.length / 2)] || 10;
    var maxH = heights[heights.length - 1] || 10;
    var yBkt = Math.max(2, Math.min(8, Math.round(medH * 0.35)));

    // Group into y-buckets
    var lineMap = {};
    validItems.forEach(function (it) {
      var yk = Math.round(it.transform[5] / yBkt) * yBkt;
      if (!lineMap[yk]) lineMap[yk] = [];
      lineMap[yk].push(it);
    });

    var ys  = Object.keys(lineMap).map(Number).sort(function (a, b) { return b - a; });
    var out = [];
    var lastY = null, lastText = '', lastH = medH;

    ys.forEach(function (y) {
      var row   = lineMap[y].sort(function (a, b) { return a.transform[4] - b.transform[4]; });
      var txt   = '';
      for (var i = 0; i < row.length; i++) {
        var s = row[i].str || '';
        if (!s) continue;
        if (txt && !txt.endsWith(' ') && !s.startsWith(' ')) {
          // Insert space if there is a visual gap between glyphs
          var prevRight = i > 0 ? (row[i - 1].transform[4] + (row[i - 1].width || 0)) : 0;
          if (prevRight > 0 && (row[i].transform[4] - prevRight) > medH * 0.25) txt += ' ';
        }
        txt += s;
      }
      txt = _normSym(txt.trim());
      if (!txt) return;

      var lineH    = Math.max.apply(null, row.map(function (it) { return Math.abs(it.transform[3]); }));
      var lineBold = row.some(function (it) { return it.fontName && /bold/i.test(it.fontName); });
      var lineItal = row.some(function (it) { return it.fontName && /italic|oblique/i.test(it.fontName); });

      if (_isSignLine(txt)) {
        out.push({ text: txt, isHeading: false, isList: false, isNumList: false, isSignature: true, fontSize: lineH });
        lastY = y; lastText = txt; lastH = lineH; return;
      }

      var isList    = _LIST_RE.test(txt);
      var isNumList = _NUMLIST_RE.test(txt);
      var isSection = _SECTION_RE.test(txt.trim());
      var isForm    = !isList && !isNumList && _isFormLine(txt);
      var isHeading = !isList && !isForm && (
        lineH > medH * 1.3 || (lineBold && lineH >= medH) || isSection ||
        (txt.length >= 2 && txt.length < 90 && txt === txt.toUpperCase() && /[A-Z]/.test(txt))
      );
      var level = 0;
      if (isHeading) {
        level = lineH >= maxH * 0.85 ? 1 : lineH >= medH * 1.5 ? 2 : lineH >= medH * 1.2 ? 3 : 4;
      }

      var gap      = lastY !== null ? lastY - y : 0;
      var newBlock = gap > medH * 2.0 || isHeading || isForm || isSection;
      var sentEnd  = lastText ? /[.!?:;)\]"'\u2019\u201d]$/.test(lastText.trim()) : true;
      var merge    = !newBlock && !sentEnd && gap > 0 && gap < medH * 1.8 &&
                     Math.abs(lineH - lastH) < medH * 0.3 && lastY !== null && !isForm;

      if (merge && out.length) {
        var last = out[out.length - 1];
        if (last && !last.isHeading && !last.isSignature && !last.isForm) {
          last.text = last.text.trim().endsWith('-')
            ? last.text.trim().slice(0, -1) + txt
            : last.text + ' ' + txt;
          last.bold   = last.bold   || lineBold;
          last.italic = last.italic || lineItal;
          lastY = y; lastText = txt; lastH = lineH; return;
        }
      }
      var xs = row.map(function (it) { return it.transform[4]; }).filter(function (x) { return x > 0; });
      out.push({
        text: txt, isHeading: isHeading, isList: isList, isNumList: isNumList,
        isSection: isSection, isForm: isForm, bold: lineBold, italic: lineItal,
        level: level, fontSize: lineH,
        xPositions: xs.length > 1 ? xs : undefined, pageWidth: 612,
      });
      lastY = y; lastText = txt; lastH = lineH;
    });

    // Remove consecutive duplicates (scanning artefacts)
    return out.filter(function (p, i) {
      return i === 0 || p.text.trim().toLowerCase() !== out[i - 1].text.trim().toLowerCase();
    });
  }

  // ── OCR FALLBACK ──────────────────────────────────────────────────────────
  // Tesseract recognition remains page-context; PDF page rasterisation is delegated
  // to the isolated shared WorkerPool render worker below. The Tesseract instance
  // is still tracked in _tessWorker → guaranteed termination in _cleanup().
  async function _runOcr(file, lang, onStep, cancelToken, jobId, totalPages) {
    // Lazy-load Tesseract.js
    if (!G.Tesseract) {
      await new Promise(function (resolve, reject) {
        var s     = document.createElement('script');
        s.src     = TESS_CDN;
        s.onload  = resolve;
        s.onerror = function () { reject(new Error('Tesseract.js failed to load')); };
        document.head.appendChild(s);
      });
    }
    if (!G.Tesseract) throw new Error('OCR engine unavailable');

    // Fast native pre-pass: skip OCR if all pages have good text
    var pdfjsLib = await _loadPdfJs();
    var buf0 = await file.arrayBuffer();
    var pdfN = await pdfjsLib.getDocument({ data: buf0, isEvalSupported: false }).promise;
    var nativeTexts = {};
    try {
      for (var ni = 1; ni <= pdfN.numPages; ni++) {
        var np = await pdfN.getPage(ni);
        var nc = await np.getTextContent();
        var nt = nc.items.map(function (it) { return it.str; }).join(' ').trim();
        nativeTexts[ni] = { text: nt, chars: nt.replace(/\s/g, '').length };
        np.cleanup();
      }
    } finally {
      try { await pdfN.destroy(); } catch (_) {}
      buf0 = null;
    }
    var nKeys    = Object.keys(nativeTexts);
    var allGood  = nKeys.length > 0 && nKeys.every(function (k) { return nativeTexts[k].chars >= 30; });
    if (allGood) {
      return nKeys.sort(function (a, b) { return +a - +b; }).map(function (k) {
        return { pageNum: +k, text: nativeTexts[k].text, source: 'native' };
      });
    }

    // Tesseract pass
    onStep(1, 'active', 35, 'Running OCR\u2026');
    var tw = await _race(G.Tesseract.createWorker(lang, 1, { logger: function () {} }));
    _tessWorker = tw;   // register for cleanup

    var total = totalPages || 0;
    if (!total) throw new Error('OCR render stage received no page count');

    var ocrPages = [];
    var renderScale = 1.5;
    for (var oi = 1; oi <= total; oi++) {
      var rendered = await _renderOcrPageWithSharedWorker(file, oi, renderScale, cancelToken, jobId);
      var imageBlob = new Blob([rendered.buffer], {type: rendered.mimeType || 'image/png'});
      var recog = await _race(tw.recognize(imageBlob));
      ocrPages.push({ pageNum: oi, text: recog.data.text || '', source: 'ocr' });

      onStep(1, 'active',
        35 + Math.round((oi / total) * 18),
        'OCR: page ' + oi + ' of ' + total
      );
    }

    // Terminate Tesseract worker immediately after use
    try { await tw.terminate(); } catch (_) {}
    _tessWorker = null;

    return ocrPages;
  }

  // ── OCR RESULTS → STRUCTURED PAGES ───────────────────────────────────────
  function _ocrToPages(ocrPages) {
    return ocrPages.map(function (ocrP) {
      var lines = (ocrP.text || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
      var paras = lines.map(function (line) {
        var t = _normSym(line.trim());
        if (!t) return null;
        var isList    = _LIST_RE.test(t);
        var isNumList = _NUMLIST_RE.test(t);
        var isHeading = !isList && t.length >= 2 && t.length < 90 &&
                        t === t.toUpperCase() && /[A-Z]/.test(t);
        return { text: t, isHeading: isHeading, isList: isList, isNumList: isNumList, level: isHeading ? 1 : 0 };
      }).filter(Boolean);
      if (!paras.length) paras = [{ text: '(no content)', isHeading: false }];
      return { pageNum: ocrP.pageNum, paragraphs: paras };
    });
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
      return d.buffer;
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
      var extractedPages = await _extractWithSharedWorker(file, cancelToken, onStep, jobId);
      var total = extractedPages.length;
      var pages = extractedPages.map(function (p) {
        return { pageNum: p.pageNum, paragraphs: _extractParagraphs(p.items || []) };
      }).filter(function (p) { return p.paragraphs.length > 0; });
      onStep(0, 'done', 53);
      onStep(1, 'active', 55, 'Checking text quality…');


      // ── Phase 2: Text quality check + OCR fallback ────────────────────────
      var totalChars = pages.reduce(function (s, p) {
        return s + p.paragraphs.reduce(function (ps, para) { return ps + (para.text || '').length; }, 0);
      }, 0);
      var avgCharsPerPage = total > 0 ? totalChars / total : 0;
      var needsOcr = forceOcr || !pages.length || avgCharsPerPage < 8;

      if (needsOcr) {
        _log('OCR trigger', { avgCharsPerPage: avgCharsPerPage, forceOcr: forceOcr });
        var ocrRaw  = await _runOcr(file, ocrLang, onStep, cancelToken, jobId, total);
        var ocrLen  = ocrRaw.reduce(function (s, p) { return s + (p.text || '').length; }, 0);
        if (ocrLen < 10) {
          throw new Error('No readable text found. This may be a scanned document with unclear content.');
        }
        pages = _ocrToPages(ocrRaw);
      }

      if (!pages.length) {
        pages = [{ pageNum: 1, paragraphs: [{ text: '(empty document)', isHeading: false }] }];
      }

      onStep(1, 'done', 53);
      onStep(2, 'active', 57, 'Building document\u2026');

      // ── Phase 3: DOCX build via dedicated isolated worker ─────────────────
      var docxBuf = await _buildDocx(pages, jobId, cancelToken);
      // Worker already terminated inside _buildDocx on success/error.

      onStep(2, 'done', 90);
      onStep(3, 'active', 93, 'Finalizing\u2026');

      var blob = new Blob([docxBuf], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      docxBuf = null;

      var finalChars = pages.reduce(function (s, p) {
        return s + p.paragraphs.reduce(function (ps, para) { return ps + (para.text || '').length; }, 0);
      }, 0);
      var finalParas = pages.reduce(function (s, p) { return s + p.paragraphs.length; }, 0);

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
      inFlight:    _inFlight,
      jobId:       _jobId,
      hasTessWorker: !!_tessWorker,
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

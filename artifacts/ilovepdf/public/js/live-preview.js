// Live Preview Engine v6.0 — Phase 9 Global Preview Hardening
// Production-grade previews for 9 tools. All previews show REAL extracted data.
//
// Supported tools:
//   word-to-pdf       → print-style preview, rulers, zoom, page-breaks, font warnings
//   excel-to-pdf      → print-grid, page-split viz, overflow prediction, multi-page map
//   pdf-to-word       → structure analysis, confidence scores, mini-map, quality badge
//   pdf-to-excel      → column overlays, numeric coercion, overflow detection, mini-map
//   background-remover→ swipe compare, alpha-mask viz, edge quality, export size
//   translate         → side-by-side, language detection, coverage %, output format
//   ai-summarize      → section preview, key topics, compression ratio, mode switch
//   edit              → PDF page canvas, ruler overlay, safe-zone, grid toggle
//
// window.LivePreview.mount(toolId, files, hostEl) → Promise<void>
// window.LivePreview.supported(toolId)            → boolean
(function () {
  'use strict';

  var MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js';
  var XLSX_URL    = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var PDFJS_MOD   = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  var PDFJS_WRK   = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  var JSZIP_URL   = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

  var SUPPORTED = new Set([
    'word-to-pdf', 'excel-to-pdf',
    'pdf-to-word', 'pdf-to-excel',
    'background-remover',
    'translate', 'ai-summarize',
    'edit',
    'pdf-to-powerpoint', 'powerpoint-to-pdf',
    'html-to-pdf', 'ocr',
    'scan-to-pdf', 'repair',
    'word-to-excel',
  ]);

  // ── JSZip loader ─────────────────────────────────────────────────────────
  function loadJsZip() { return loadScript(JSZIP_URL, 'JSZip'); }

  // ── Script loader ──────────────────────────────────────────────────────────
  var _slots = {};
  function loadScript(url, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (_slots[url]) return _slots[url];
    _slots[url] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload  = function () { res(globalName ? window[globalName] : true); };
      s.onerror = function () { delete _slots[url]; rej(new Error('load-fail:' + url)); };
      document.head.appendChild(s);
    });
    return _slots[url];
  }

  // ── PDF.js loader (ESM) ───────────────────────────────────────────────────
  // All loaders (browser-tools, advanced-engine, pdf-preview, live-preview) share
  // window.__pdfjsLibPromise — guaranteeing one import() call and one workerSrc.
  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) {
      if (window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDFJS_WRK) {
        console.warn('[LivePreview] workerSrc corrected:',
          window.pdfjsLib.GlobalWorkerOptions.workerSrc, '→', PDFJS_WRK);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WRK;
      }
      return Promise.resolve(window.pdfjsLib);
    }
    if (window.__pdfjsLibPromise) return window.__pdfjsLibPromise;
    window.__pdfjsLibPromise = import(PDFJS_MOD).then(function (mod) {
      var lib = mod.GlobalWorkerOptions ? mod : (mod.default || mod);
      if (!lib || !lib.getDocument) {
        throw new Error('LivePreview: pdfjsLib.getDocument missing after import');
      }
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WRK;
      window.pdfjsLib = lib;
      return lib;
    }).catch(function (err) {
      console.error('[LivePreview] pdfjs import failed:', err);
      window.__pdfjsLibPromise = null;
      throw err;
    });
    return window.__pdfjsLibPromise;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtNum(n) { return n.toLocaleString(); }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── Quality badge (real scoring) ──────────────────────────────────────────
  function qualityBadge(score) {
    // score 0-100
    if (score >= 85) return '<span class="lp-quality lp-q-excellent">✓ Excellent</span>';
    if (score >= 60) return '<span class="lp-quality lp-q-good">✓ Good</span>';
    if (score >= 30) return '<span class="lp-quality lp-q-review">⚠ Needs Review</span>';
    return '<span class="lp-quality lp-q-ocr">🔍 OCR Required</span>';
  }

  // ── Skeleton loader ───────────────────────────────────────────────────────
  function skeletonHtml(rows) {
    rows = rows || 4;
    var lines = '';
    for (var i = 0; i < rows; i++) {
      var w = [80, 60, 90, 70, 50][i % 5];
      lines += '<div class="lp-skel-line" style="width:' + w + '%"></div>';
    }
    return '<div class="lp-skel">' + lines + '</div>';
  }

  // ── Error recovery ────────────────────────────────────────────────────────
  function errorHtml(msg, retryFn) {
    var id = 'lp-retry-' + Date.now();
    setTimeout(function () {
      var btn = document.getElementById(id);
      if (btn && retryFn) btn.addEventListener('click', retryFn);
    }, 50);
    return '<div class="lp-error-state">' +
      '<div class="lp-error-icon">⚠</div>' +
      '<div class="lp-error-msg">' + esc(msg || 'Preview unavailable') + '</div>' +
      (retryFn ? '<button id="' + id + '" class="lp-retry-btn">Try again</button>' : '') +
    '</div>';
  }

  // ── Page size constants ───────────────────────────────────────────────────
  var PAGE_SIZES = { A4: { w: 210, h: 297 }, Letter: { w: 216, h: 279 }, A3: { w: 297, h: 420 } };

  // ── Shared control builders ───────────────────────────────────────────────
  function pageSizeBtns(activeSize, extra) {
    var keys = ['A4', 'Letter'];
    if (extra) keys = keys.concat(extra);
    return keys.map(function (k) {
      return '<button type="button" class="lp-ctrl-btn' + (k === activeSize ? ' active' : '') +
             '" data-size="' + k + '">' + k + '</button>';
    }).join('');
  }

  function orientBtns(activeOrient) {
    var items = [
      { id: 'portrait',  svg: '<svg width="10" height="13" viewBox="0 0 10 13" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x=".5" y=".5" width="9" height="12" rx="1" stroke="currentColor"/></svg>', label: 'Portrait' },
      { id: 'landscape', svg: '<svg width="13" height="10" viewBox="0 0 13 10" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x=".5" y=".5" width="12" height="9" rx="1" stroke="currentColor"/></svg>', label: 'Landscape' },
    ];
    return items.map(function (o) {
      return '<button type="button" class="lp-ctrl-btn' + (o.id === activeOrient ? ' active' : '') +
             '" data-orient="' + o.id + '">' + o.svg + ' ' + o.label + '</button>';
    }).join('');
  }

  function wireCtrlSync(host, state) {
    host.querySelectorAll('[data-size]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.size = b.dataset.size;
        host.querySelectorAll('[data-size]').forEach(function (x) { x.classList.toggle('active', x.dataset.size === state.size); });
        var el = document.getElementById('opt-pageSize'); if (el) el.value = state.size;
        if (state.onchange) state.onchange();
      });
    });
    host.querySelectorAll('[data-orient]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.orient = b.dataset.orient;
        host.querySelectorAll('[data-orient]').forEach(function (x) { x.classList.toggle('active', x.dataset.orient === state.orient); });
        var el = document.getElementById('opt-orientation'); if (el) el.value = state.orient;
        if (state.onchange) state.onchange();
      });
    });
  }

  // ── Language detection from text ──────────────────────────────────────────
  function detectLanguage(text) {
    if (!text || text.length < 20) return null;
    var s = text.slice(0, 800);
    var cjk    = (s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
    var arabic = (s.match(/[\u0600-\u06ff]/g) || []).length;
    var cyril  = (s.match(/[\u0400-\u04ff]/g) || []).length;
    var korean = (s.match(/[\uac00-\ud7af]/g) || []).length;
    var latin  = (s.match(/[a-zA-Z]/g) || []).length;
    var total  = cjk + arabic + cyril + korean + latin || 1;
    if (cjk / total > 0.2)    return { code: 'ZH', label: 'Chinese', flag: '🇨🇳' };
    if (arabic / total > 0.2) return { code: 'AR', label: 'Arabic', flag: '🇸🇦' };
    if (cyril / total > 0.2)  return { code: 'RU', label: 'Russian', flag: '🇷🇺' };
    if (korean / total > 0.2) return { code: 'KO', label: 'Korean', flag: '🇰🇷' };
    return { code: 'EN', label: 'English', flag: '🇬🇧' };
  }

  // ── Key-topic extractor (lightweight, no NLP library) ────────────────────
  function extractTopics(text, max) {
    if (!text) return [];
    max = max || 6;
    var STOP = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with',
      'this','that','is','are','was','were','be','been','have','has','had','do','does','did',
      'will','would','could','should','may','might','it','its','not','from','by','as','i',
      'we','you','he','she','they','our','your','their','page','pdf']);
    var words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    var freq = {};
    words.forEach(function (w) {
      if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
    });
    return Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, max);
  }

  // ── Memory cleanup ────────────────────────────────────────────────────────
  function cleanupHost(host) {
    // Revoke object URLs
    host.querySelectorAll('[data-obj-url]').forEach(function (el) {
      try { URL.revokeObjectURL(el.dataset.objUrl); } catch (_) {}
    });
    // Destroy canvases
    host.querySelectorAll('canvas').forEach(function (cv) {
      try { var ctx = cv.getContext('2d'); if (ctx) ctx.clearRect(0, 0, cv.width, cv.height); } catch (_) {}
    });
  }

  // ======================================================================
  // WORD → PDF  (v6.0 — print-style, zoom, page-breaks, rulers, font warnings)
  // ======================================================================
  async function mountWordToPdf(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Generating document preview…' + skeletonHtml(5) + '</div>';

    var mammoth;
    try { mammoth = await loadScript(MAMMOTH_URL, 'mammoth'); }
    catch (_) { host.innerHTML = errorHtml('Could not load document renderer. Check your connection.'); return; }

    var buf, result;
    try {
      buf    = await file.arrayBuffer();
      result = await mammoth.convertToHtml({ arrayBuffer: buf });
    } catch (_) { host.innerHTML = errorHtml('Could not read document. Is it a valid .docx file?'); return; }

    var html = result.value || '';
    if (!html.trim()) { host.innerHTML = errorHtml('Document appears empty or could not be converted.'); return; }

    // Analyse warnings from mammoth
    var warnings     = result.messages || [];
    var fontWarnings = warnings.filter(function (m) { return m && m.message && /font|style|unsupported/i.test(m.message); });
    var hasFontWarn  = fontWarnings.length > 0;

    // Estimate word count and reading time
    var wordCount    = (html.replace(/<[^>]+>/g, ' ').match(/\b\w+\b/g) || []).length;
    var readMinutes  = Math.max(1, Math.ceil(wordCount / 200));

    // Detect tables and page breaks
    var tableCount = (html.match(/<table/gi) || []).length;
    var hasWideTable = (html.match(/<table[^>]*style="[^"]*width\s*:\s*(\d+)[^"]*"/gi) || []).some(function (m) {
      var match = m.match(/width\s*:\s*(\d+)/i);
      return match && parseInt(match[1], 10) > 600;
    });

    var state = { size: 'A4', orient: 'portrait', zoom: 'fit' };

    function pxFromMm(mm) { return (mm * 96 / 25.4 * 0.62); }

    function computePageStyle() {
      var ps  = PAGE_SIZES[state.size] || PAGE_SIZES.A4;
      var wMm = state.orient === 'landscape' ? ps.h : ps.w;
      var hMm = state.orient === 'landscape' ? ps.w : ps.h;
      var wpx = pxFromMm(wMm);
      var hpx = pxFromMm(hMm);
      var marginPx = pxFromMm(20);
      if (state.zoom === '100')   return { width: wpx + 'px', minHeight: hpx + 'px', padding: marginPx + 'px', transform: 'scale(1)' };
      if (state.zoom === '200')   return { width: wpx + 'px', minHeight: hpx + 'px', padding: marginPx + 'px', transform: 'scale(1.8)', transformOrigin: 'top center' };
      if (state.zoom === 'width') return { width: '100%', minHeight: hpx + 'px', padding: marginPx + 'px', transform: 'none' };
      // fit-page default
      return { width: wpx + 'px', minHeight: hpx + 'px', padding: marginPx + 'px', transform: 'none' };
    }

    function applyStyle() {
      var pg  = host.querySelector('.lp-page-content');
      var s   = computePageStyle();
      if (!pg) return;
      pg.style.width          = s.width;
      pg.style.minHeight      = s.minHeight;
      pg.style.padding        = s.padding;
      pg.style.transform      = s.transform;
      pg.style.transformOrigin = 'top center';
    }

    state.onchange = applyStyle;

    var fontWarnHtml = hasFontWarn
      ? '<div class="lp-warn-banner"><span class="lp-warn-icon">⚠</span> Some fonts may not render identically in the PDF output.</div>'
      : '';

    var tableWarnHtml = hasWideTable
      ? '<div class="lp-warn-banner lp-warn-table"><span class="lp-warn-icon">📐</span> Wide table detected — may overflow the page width.</div>'
      : '';

    host.innerHTML =
      '<div class="lp-panel lp-panel--word">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            ' Document Preview' +
          '</span>' +
          '<div class="lp-header-stats">' +
            '<span class="lp-stat"><b>' + fmtNum(wordCount) + '</b> words</span>' +
            '<span class="lp-stat"><b>~' + readMinutes + '</b> min read</span>' +
            (tableCount ? '<span class="lp-stat"><b>' + tableCount + '</b> table' + (tableCount > 1 ? 's' : '') + '</span>' : '') +
          '</div>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page</span><div class="lp-ctrl-row">' + pageSizeBtns('A4') + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Orientation</span><div class="lp-ctrl-row">' + orientBtns('portrait') + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Zoom</span><div class="lp-ctrl-row">' +
              ['fit', 'width', '100', '200'].map(function (z) {
                var label = { fit: 'Fit page', width: 'Fit width', '100': '100%', '200': '200%' }[z];
                return '<button type="button" class="lp-ctrl-btn' + (z === 'fit' ? ' active' : '') + '" data-zoom="' + z + '">' + label + '</button>';
              }).join('') +
            '</div></div>' +
          '</div>' +
        '</div>' +
        (fontWarnHtml || tableWarnHtml ? '<div class="lp-warn-stack">' + fontWarnHtml + tableWarnHtml + '</div>' : '') +
        '<div class="lp-ruler-row">' +
          '<div class="lp-ruler lp-ruler--h" aria-hidden="true"></div>' +
        '</div>' +
        '<div class="lp-scroll lp-scroll--page">' +
          '<div class="lp-page-wrap lp-page-wrap--print">' +
            '<div class="lp-margin-guide lp-mg-top"></div>' +
            '<div class="lp-margin-guide lp-mg-bottom"></div>' +
            '<div class="lp-margin-guide lp-mg-left"></div>' +
            '<div class="lp-margin-guide lp-mg-right"></div>' +
            '<div class="lp-page-content lp-word-content" style="' +
              'width:' + (pxFromMm(210)) + 'px;min-height:' + (pxFromMm(297)) + 'px;' +
              'padding:' + (pxFromMm(20)) + 'px;' +
            '">' + html + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="lp-footer">' +
          'Print-style preview · margins and page boundaries shown · ' +
          (hasFontWarn ? 'font substitution may apply · ' : '') +
          'actual output may differ slightly' +
        '</div>' +
      '</div>';

    wireCtrlSync(host, state);

    // Wire zoom
    host.querySelectorAll('[data-zoom]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.zoom = b.dataset.zoom;
        host.querySelectorAll('[data-zoom]').forEach(function (x) { x.classList.toggle('active', x.dataset.zoom === state.zoom); });
        applyStyle();
      });
    });

    applyStyle();
  }

  // ======================================================================
  // EXCEL → PDF  (v6.0 — page-split, overflow prediction, multi-page map)
  // ======================================================================
  async function mountExcelToPdf(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Generating spreadsheet preview…' + skeletonHtml(6) + '</div>';

    var XLSX;
    try { XLSX = await loadScript(XLSX_URL, 'XLSX'); }
    catch (_) { host.innerHTML = errorHtml('Could not load spreadsheet renderer. Check your connection.'); return; }

    var buf, wb;
    try {
      buf = await file.arrayBuffer();
      wb  = XLSX.read(buf, { type: 'array', cellStyles: true });
    } catch (_) { host.innerHTML = errorHtml('Could not read spreadsheet. Is it a valid .xlsx/.xls/.csv file?'); return; }

    if (!wb.SheetNames.length) { host.innerHTML = errorHtml('No sheets found in this file.'); return; }

    var firstWs   = wb.Sheets[wb.SheetNames[0]];
    var firstRows = XLSX.utils.sheet_to_json(firstWs, { header: 1, defval: '' });
    var maxCols   = firstRows.length ? Math.max.apply(null, firstRows.map(function (r) { return r.length; })) : 1;
    var autoOrient = maxCols > 6 ? 'landscape' : 'portrait';

    var state = { sheet: 0, size: 'A4', orient: autoOrient, margins: 'normal', scaling: 'fit-page', showSplit: true };

    // Estimate pages per sheet
    function estimatePages(ws, size, orient) {
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      var ps   = PAGE_SIZES[size] || PAGE_SIZES.A4;
      var pageH = orient === 'landscape' ? ps.w : ps.h;
      var rowsPerPage = Math.floor(pageH / 6); // ~6mm per row
      return Math.max(1, Math.ceil(rows.length / rowsPerPage));
    }

    function detectNumericCol(rows, colIdx) {
      var numCount = 0, total = 0;
      rows.slice(1).forEach(function (r) {
        var v = r[colIdx];
        if (v !== '' && v !== undefined && v !== null) {
          total++;
          if (!isNaN(parseFloat(String(v))) && isFinite(v)) numCount++;
        }
      });
      return total > 2 && numCount / total > 0.7;
    }

    function renderSheet() {
      var ws      = wb.Sheets[wb.SheetNames[state.sheet]];
      var rows    = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      var numCols = rows.length ? Math.max.apply(null, rows.map(function (r) { return r.length; })) : 0;
      var estPages = estimatePages(ws, state.size, state.orient);
      var ps       = PAGE_SIZES[state.size] || PAGE_SIZES.A4;
      var pageW    = state.orient === 'landscape' ? ps.h : ps.w;
      var pageH    = state.orient === 'landscape' ? ps.w : ps.h;
      var colWidthMm = numCols > 0 ? (pageW - 20) / numCols : 30;
      var overflowCols = colWidthMm < 12;
      var rowsPerPage = Math.floor((pageH - 20) / 6);
      var numericCols = [];
      for (var ci = 0; ci < numCols; ci++) {
        if (detectNumericCol(rows, ci)) numericCols.push(ci);
      }

      // Sync tool options
      ['opt-pageSize','opt-orientation','opt-margins','opt-scaling'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        if (id === 'opt-pageSize')    el.value = state.size;
        if (id === 'opt-orientation') el.value = state.orient;
        if (id === 'opt-margins')     el.value = state.margins;
        if (id === 'opt-scaling')     el.value = state.scaling;
      });

      // Update stats bar
      var statsEl = host.querySelector('.lp-xlsx-stats');
      if (statsEl) {
        statsEl.innerHTML =
          '<span class="lp-stat"><b>' + rows.length + '</b> rows</span>' +
          '<span class="lp-stat"><b>' + numCols + '</b> cols</span>' +
          '<span class="lp-stat lp-stat--pages"><b>' + estPages + '</b> page' + (estPages > 1 ? 's' : '') + '</span>' +
          (overflowCols ? '<span class="lp-stat lp-stat--warn"><b>⚠</b> Overflow risk</span>' : '') +
          (numericCols.length ? '<span class="lp-stat lp-stat--num"><b>' + numericCols.length + '</b> numeric col' + (numericCols.length > 1 ? 's' : '') + '</span>' : '');
      }

      // Update page map
      var mapEl = host.querySelector('.lp-page-map');
      if (mapEl) {
        var cells = '';
        for (var p = 0; p < Math.min(estPages, 12); p++) {
          cells += '<div class="lp-page-map-cell' + (p === 0 ? ' lp-page-map-cell--active' : '') + '" title="Page ' + (p + 1) + '">' + (p + 1) + '</div>';
        }
        if (estPages > 12) cells += '<div class="lp-page-map-more">+' + (estPages - 12) + ' more</div>';
        mapEl.innerHTML = '<div class="lp-page-map-label">Page map (' + estPages + ' pages)</div><div class="lp-page-map-grid">' + cells + '</div>';
      }

      // Build table with enhancements
      var maxDisplayRows = 60;
      var displayRows    = rows.slice(0, maxDisplayRows);
      var splitAt        = rowsPerPage - 1;
      var pageNum        = 1;

      var tHead = '<thead><tr>' + (function () {
        var ths = '';
        for (var ci2 = 0; ci2 < numCols; ci2++) {
          var isNum = numericCols.indexOf(ci2) >= 0;
          ths += '<th class="' + (isNum ? 'lp-tbl-num-col' : '') + '" title="' + (isNum ? 'Numeric column' : 'Col ' + (ci2 + 1)) + '">' +
            'Col&nbsp;' + (ci2 + 1) +
            (isNum ? '<span class="lp-num-badge">123</span>' : '') +
          '</th>';
        }
        return ths;
      }()) + '</tr></thead>';

      var tBodyRows = '';
      displayRows.forEach(function (row, ri) {
        var isSplitRow = state.showSplit && ri > 0 && ri % splitAt === 0;
        if (isSplitRow) {
          pageNum++;
          tBodyRows += '<tr class="lp-page-split-row"><td colspan="' + numCols + '" class="lp-page-split-cell">' +
            '<span class="lp-split-label">— Page ' + pageNum + ' starts here —</span>' +
          '</td></tr>';
        }
        var cells = '';
        for (var ci3 = 0; ci3 < numCols; ci3++) {
          var cell  = row[ci3];
          var sv    = (cell === 0 ? '0' : (cell || ''));
          var isNum = numericCols.indexOf(ci3) >= 0;
          var overflow = String(sv).length > 18;
          cells += '<td class="' +
            (isNum ? 'lp-tbl-num-col' : '') +
            (overflow ? ' lp-cell-overflow' : '') +
          '" title="' + esc(String(sv)) + '">' +
            esc(String(sv).slice(0, 22)) + (overflow ? '…' : '') +
          '</td>';
        }
        tBodyRows += '<tr' + (ri === 0 ? ' class="lp-tbl-header-row"' : '') + '>' + cells + '</tr>';
      });

      var more = rows.length > maxDisplayRows
        ? '<div class="lp-tbl-more">Showing ' + maxDisplayRows + ' of ' + rows.length + ' rows — all rows export to PDF</div>' : '';

      var cv = host.querySelector('.lp-xlsx-canvas');
      if (cv) {
        var marginMap = { none: '4px', narrow: '10px', normal: '18px' };
        var m = marginMap[state.margins] || '18px';
        var isLand = state.orient === 'landscape';
        var isA3   = state.size === 'A3';
        var wrap   = host.querySelector('.lp-xlsx-page-wrap');
        if (wrap) {
          wrap.style.padding  = m;
          wrap.style.maxWidth = isLand ? (isA3 ? '920px' : '780px') : (isA3 ? '650px' : '560px');
        }
        cv.innerHTML = (overflowCols
          ? '<div class="lp-warn-banner"><span class="lp-warn-icon">📐</span> ' + numCols + ' columns may overflow this page width. Consider landscape or A3.</div>'
          : '') +
          '<table class="lp-tbl lp-tbl--xlsx">' + tHead + '<tbody>' + tBodyRows + '</tbody></table>' +
          more;
      }

      host.querySelectorAll('[data-sheet]').forEach(function (b) {
        b.classList.toggle('active', parseInt(b.dataset.sheet, 10) === state.sheet);
      });
    }

    state.onchange = renderSheet;

    function marginBtns(active) {
      return [{ id: 'none', label: 'None' }, { id: 'narrow', label: 'Narrow' }, { id: 'normal', label: 'Normal' }].map(function (o) {
        return '<button type="button" class="lp-ctrl-btn' + (o.id === active ? ' active' : '') + '" data-margin="' + o.id + '">' + o.label + '</button>';
      }).join('');
    }

    function scalingBtns(active) {
      return [{ id: 'fit-page', label: 'Fit page' }, { id: 'fit-width', label: 'Fit width' }, { id: 'actual', label: 'Actual' }].map(function (o) {
        return '<button type="button" class="lp-ctrl-btn' + (o.id === active ? ' active' : '') + '" data-scaling="' + o.id + '">' + o.label + '</button>';
      }).join('');
    }

    var sheetTabsHtml = wb.SheetNames.length > 1
      ? '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Sheet</span><div class="lp-ctrl-row lp-ctrl-row--scroll">' +
          wb.SheetNames.map(function (n, i) {
            return '<button type="button" class="lp-ctrl-btn' + (i === 0 ? ' active' : '') + '" data-sheet="' + i + '">' + esc(n.slice(0, 16)) + '</button>';
          }).join('') +
        '</div></div>'
      : '';

    var dimBadge = '<span class="lp-dim-badge">' + firstRows.length + ' rows × ' + maxCols + ' cols</span>';
    var estPagesBadge = estimatePages(firstWs, 'A4', autoOrient);

    host.innerHTML =
      '<div class="lp-panel lp-panel--excel">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>' +
            ' Spreadsheet Preview ' + dimBadge +
          '</span>' +
          '<div class="lp-xlsx-stats lp-stats">' +
            '<span class="lp-stat"><b>' + firstRows.length + '</b> rows</span>' +
            '<span class="lp-stat"><b>' + maxCols + '</b> cols</span>' +
            '<span class="lp-stat lp-stat--pages"><b>~' + estPagesBadge + '</b> pages</span>' +
          '</div>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page</span><div class="lp-ctrl-row">' + pageSizeBtns('A4', ['A3']) + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Orientation</span><div class="lp-ctrl-row">' + orientBtns(autoOrient) + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Margins</span><div class="lp-ctrl-row">' + marginBtns('normal') + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Scaling</span><div class="lp-ctrl-row">' + scalingBtns('fit-page') + '</div></div>' +
            sheetTabsHtml +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Splits</span><div class="lp-ctrl-row">' +
              '<button type="button" class="lp-ctrl-btn active" data-split="on">Show</button>' +
              '<button type="button" class="lp-ctrl-btn" data-split="off">Hide</button>' +
            '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="lp-xlsx-page-map"><div class="lp-page-map"></div></div>' +
        '<div class="lp-scroll lp-scroll--wide">' +
          '<div class="lp-xlsx-page-wrap"><div class="lp-xlsx-canvas"></div></div>' +
        '</div>' +
        '<div class="lp-footer">Page-split lines show where PDF pages begin · numeric columns detected · orange cells have overflow text</div>' +
      '</div>';

    wireCtrlSync(host, state);

    host.querySelectorAll('[data-margin]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.margins = b.dataset.margin;
        host.querySelectorAll('[data-margin]').forEach(function (x) { x.classList.toggle('active', x.dataset.margin === state.margins); });
        var el = document.getElementById('opt-margins'); if (el) el.value = state.margins;
        state.onchange();
      });
    });

    host.querySelectorAll('[data-scaling]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.scaling = b.dataset.scaling;
        host.querySelectorAll('[data-scaling]').forEach(function (x) { x.classList.toggle('active', x.dataset.scaling === state.scaling); });
        var el = document.getElementById('opt-scaling'); if (el) el.value = state.scaling;
        state.onchange();
      });
    });

    host.querySelectorAll('[data-sheet]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.sheet = parseInt(b.dataset.sheet, 10);
        renderSheet();
      });
    });

    host.querySelectorAll('[data-split]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.showSplit = b.dataset.split === 'on';
        host.querySelectorAll('[data-split]').forEach(function (x) { x.classList.toggle('active', x.dataset.split === b.dataset.split); });
        renderSheet();
      });
    });

    renderSheet();
  }

  // ======================================================================
  // PDF → WORD  (v6.0 — confidence scores, mini-map, quality badge)
  // ======================================================================
  async function mountPdfWordPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing document structure…' + skeletonHtml(8) + '</div>';

    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (lpErr) { console.error('[LP_DEBUG] loadPdfJs failed (pdf-to-word):', lpErr); host.innerHTML = errorHtml('PDF renderer not available. Check your connection.'); return; }

    var buf, pdf;
    try {
      buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    } catch (lpErr) { console.error('[LP_DEBUG] getDocument failed (pdf-to-word):', lpErr); host.innerHTML = errorHtml('Could not parse this PDF. It may be corrupted or encrypted.'); return; }

    var numPages   = pdf.numPages;
    var checkPages = Math.min(numPages, 5);
    var totalRawChars = 0;
    var allLines   = [];

    for (var pg = 1; pg <= checkPages; pg++) {
      var page     = await pdf.getPage(pg);
      var viewport = page.getViewport({ scale: 1 });
      var content  = await page.getTextContent();
      var pageWidth = viewport.width || 612;
      var buckets   = {};

      content.items.forEach(function (it) {
        if (!it.str || !it.str.trim()) return;
        totalRawChars += it.str.replace(/\s/g, '').length;
        var yKey = Math.round(it.transform[5] / 3) * 3;
        if (!buckets[yKey]) buckets[yKey] = { parts: [], fontSize: 0 };
        buckets[yKey].parts.push({ text: it.str, x: it.transform[4] });
        if ((it.height || 0) > buckets[yKey].fontSize) buckets[yKey].fontSize = it.height || 0;
      });
      page.cleanup();

      Object.keys(buckets).map(Number).sort(function (a, b) { return b - a; }).forEach(function (y) {
        var bucket = buckets[y];
        var sorted = bucket.parts.sort(function (a, b) { return a.x - b.x; });
        var text   = sorted.map(function (p) { return p.text; }).join(' ').trim();
        if (!text) return;
        allLines.push({
          text: text,
          fontSize: bucket.fontSize,
          xPositions: sorted.map(function (p) { return p.x; }),
          pageWidth: pageWidth,
        });
      });
    }
    try { await pdf.destroy(); } catch (_) {}

    var isScanned = totalRawChars < 50;

    // Modal font size
    var sizes = allLines.map(function (l) { return Math.round(l.fontSize); }).filter(function (s) { return s > 0; });
    var base  = 11;
    if (sizes.length) {
      var freq = {};
      sizes.forEach(function (s) { freq[s] = (freq[s] || 0) + 1; });
      base = parseInt(Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })[0], 10) || 11;
    }

    var headingCount = 0, paraCount = 0, tableCount = 0;
    var structLines  = [];

    allLines.forEach(function (line) {
      var t   = line.text;
      var fs  = line.fontSize || 0;
      var gap = (line.pageWidth || 612) * 0.045;
      var type = 'p', confidence = 0;

      if ((fs > 0 && fs > base * 1.35) || (t === t.toUpperCase() && t.length >= 3 && t.length < 90 && /[A-Z]/.test(t) && !/^\d/.test(t))) {
        type = 'h1';
        confidence = fs > 0 ? Math.round(Math.min(99, ((fs - base) / base) * 150)) : 70;
      } else if ((fs > 0 && fs > base * 1.15 && fs <= base * 1.35) || (/^(\d+\.)+\s+\S/.test(t) && t.length <= 100) || (/^[A-Z]\.\s+\S/.test(t) && t.length <= 100)) {
        type = 'h2';
        confidence = fs > 0 ? Math.round(Math.min(99, ((fs - base) / base) * 120)) : 60;
      } else if (line.xPositions && line.xPositions.length >= 2) {
        for (var k = 1; k < line.xPositions.length; k++) {
          if (line.xPositions[k] - line.xPositions[k - 1] >= gap) { type = 'table'; confidence = 85; break; }
        }
      }
      if (type === 'p' && t.split(/\s{3,}/).length >= 3) { type = 'table'; confidence = 75; }

      if (type === 'h1') { headingCount++; if (structLines.length < 18) structLines.push({ type: 'h1', text: t.slice(0, 72), conf: confidence }); }
      else if (type === 'h2') { headingCount++; if (structLines.length < 18) structLines.push({ type: 'h2', text: t.slice(0, 72), conf: confidence }); }
      else if (type === 'table') { tableCount++; if (structLines.length < 18) structLines.push({ type: 'table', text: t.slice(0, 80), conf: confidence }); }
      else { paraCount++; if (structLines.length < 18) structLines.push({ type: 'para', text: t.slice(0, 72), conf: 0 }); }
    });

    // Quality scoring
    var qualityScore = isScanned ? 20 :
      Math.min(100, Math.round(
        (Math.min(totalRawChars, 5000) / 5000) * 40 +
        (headingCount > 0 ? 20 : 0) +
        (paraCount > 5 ? 20 : paraCount * 4) +
        (tableCount > 0 ? 10 : 0) +
        (numPages <= 50 ? 10 : 5)
      ));
    var estWords   = isScanned ? 0 : Math.round(totalRawChars / 5);
    var readMins   = Math.max(1, Math.ceil(estWords / 200));
    var mode       = isScanned ? 'OCR' : 'Digital';

    var ocrBadge = isScanned
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' Scanned PDF — AI OCR Engine will reconstruct headings, paragraphs and tables.' +
        '</div>'
      : '';

    // Structure mini-map (headings only)
    var miniMapItems = structLines.filter(function (l) { return l.type === 'h1' || l.type === 'h2'; });
    var miniMapHtml = miniMapItems.length
      ? '<div class="lp-minimap">' +
          '<div class="lp-minimap-title">Document outline</div>' +
          miniMapItems.map(function (l) {
            return '<div class="lp-minimap-item lp-minimap-' + l.type + '">' +
              '<span class="lp-minimap-dot"></span>' +
              '<span class="lp-minimap-text">' + esc(l.text.slice(0, 40)) + '</span>' +
            '</div>';
          }).join('') +
        '</div>'
      : '';

    var structPanel = '';
    if (isScanned) {
      structPanel = '<div class="lp-struct">' +
        '<div class="lp-struct-title">OCR mode</div>' +
        '<div class="lp-struct-line lp-struct-para">' +
          '<span class="lp-struct-icon">🔍</span>' +
          '<span class="lp-struct-text">AI OCR Engine will process each page using word positions to detect headings, paragraphs and tables. Enhanced automatically.</span>' +
        '</div></div>';
    } else if (!structLines.length) {
      structPanel = '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
        '<span class="lp-struct-icon">⚠️</span>' +
        '<span class="lp-struct-text">No readable content in the first ' + checkPages + ' pages. OCR will be attempted.</span>' +
      '</div></div>';
    } else {
      structPanel = '<div class="lp-struct"><div class="lp-struct-title">Detected structure</div>' +
        structLines.map(function (l) {
          var icon = l.type === 'h1' ? '📌' : l.type === 'h2' ? '🔷' : l.type === 'table' ? '📊' : '¶';
          var cls  = (l.type === 'h1' || l.type === 'h2') ? 'lp-struct-heading' : l.type === 'table' ? 'lp-struct-table' : 'lp-struct-para';
          var confBadge = l.conf > 0
            ? '<span class="lp-conf-badge lp-conf-' + (l.conf >= 80 ? 'high' : l.conf >= 50 ? 'med' : 'low') + '">' + l.conf + '%</span>'
            : '';
          return '<div class="lp-struct-line ' + cls + '">' +
            '<span class="lp-struct-icon">' + icon + '</span>' +
            '<span class="lp-struct-text">' + esc(l.text) + '</span>' +
            confBadge +
          '</div>';
        }).join('') +
      '</div>';
    }

    host.innerHTML =
      '<div class="lp-panel lp-panel--pdfword">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
            ' Document Structure' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages === 1 ? '' : 's') + '</span>' +
            (isScanned
              ? '<span class="lp-stat lp-stat--warn"><b>Scanned</b> — OCR</span>'
              : '<span class="lp-stat"><b>' + headingCount + '</b> heading' + (headingCount !== 1 ? 's' : '') + '</span>' +
                '<span class="lp-stat"><b>' + tableCount + '</b> table' + (tableCount !== 1 ? 's' : '') + '</span>' +
                '<span class="lp-stat"><b>~' + fmtNum(estWords) + '</b> words</span>' +
                '<span class="lp-stat"><b>~' + readMins + '</b> min read</span>') +
            '<span class="lp-stat"><b>' + mode + '</b></span>' +
            qualityBadge(qualityScore) +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        '<div class="lp-extract-body lp-extract-body--with-map">' +
          miniMapHtml +
          '<div class="lp-struct-wrap">' + structPanel + '</div>' +
        '</div>' +
        '<div class="lp-footer">Confidence % shown on headings and tables · first ' + checkPages + ' pages analysed · full conversion processes entire document.</div>' +
      '</div>';
  }

  // ======================================================================
  // PDF → EXCEL  (v6.0 — column overlays, numeric detection, overflow, mini-map)
  // ======================================================================
  async function mountPdfExcelPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing table structure…' + skeletonHtml(6) + '</div>';

    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (lpErr) { console.error('[LP_DEBUG] loadPdfJs failed (pdf-to-excel):', lpErr); host.innerHTML = errorHtml('PDF renderer not available. Check your connection.'); return; }

    var buf, pdf;
    try {
      buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    } catch (lpErr) { console.error('[LP_DEBUG] getDocument failed (pdf-to-excel):', lpErr); host.innerHTML = errorHtml('Could not parse this PDF.'); return; }

    var numPages    = pdf.numPages;
    var previewPgs  = Math.min(numPages, 3);
    var totalRawChars = 0;
    var allPageData = [];

    for (var pg = 1; pg <= previewPgs; pg++) {
      var page      = await pdf.getPage(pg);
      var viewport  = page.getViewport({ scale: 1 });
      var content   = await page.getTextContent();
      var pageWidth  = viewport.width || 612;
      var colGap     = Math.max(12, Math.min(35, pageWidth * 0.04));

      var items = content.items
        .filter(function (it) { return it.str && it.str.trim(); })
        .map(function (it) {
          totalRawChars += it.str.replace(/\s/g, '').length;
          return { x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), text: it.str.trim() };
        });
      page.cleanup();

      if (items.length >= 3) {
        var xVals    = items.map(function (it) { return it.x; });
        var xUniq    = xVals.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
        var clusters = [];
        xUniq.forEach(function (x) {
          var last = clusters[clusters.length - 1];
          if (!last || x - last.max > colGap) clusters.push({ min: x, max: x, center: x });
          else { last.max = x; last.center = Math.round((last.min + last.max) / 2); }
        });
        var numCols = clusters.length;

        function findC(x) {
          var best = 0, bd = Infinity;
          for (var c = 0; c < clusters.length; c++) {
            var d = Math.abs(x - clusters[c].center);
            if (d < bd) { bd = d; best = c; }
          }
          return best;
        }

        var rowMap = {};
        items.forEach(function (it) {
          var yKey = Math.round(it.y / 10) * 10;
          if (!rowMap[yKey]) rowMap[yKey] = {};
          var col = findC(it.x);
          rowMap[yKey][col] = (rowMap[yKey][col] ? rowMap[yKey][col] + ' ' : '') + it.text;
        });

        var sortedYs = Object.keys(rowMap).map(Number).sort(function (a, b) { return b - a; });
        var rows = sortedYs.map(function (y) {
          var row = new Array(numCols).fill('');
          Object.keys(rowMap[y]).forEach(function (col) { row[parseInt(col, 10)] = String(rowMap[y][col]).trim(); });
          return row;
        });

        // Detect numeric columns
        var numericCols = [];
        for (var ci = 0; ci < numCols; ci++) {
          var numCount = 0, total2 = 0;
          rows.slice(1).forEach(function (r) {
            var v = r[ci];
            if (v !== '') { total2++; if (!isNaN(parseFloat(v)) && isFinite(v)) numCount++; }
          });
          if (total2 > 2 && numCount / total2 > 0.65) numericCols.push(ci);
        }

        // Column widths (relative)
        var colWidths = clusters.map(function (cl) { return Math.max(40, Math.min(200, cl.max - cl.min + 40)); });
        var totalW    = colWidths.reduce(function (s, w) { return s + w; }, 0) || 1;
        var colPcts   = colWidths.map(function (w) { return Math.round(w / totalW * 100); });

        allPageData.push({ rows: rows, numCols: numCols, isOcr: false, pageNum: pg, numericCols: numericCols, colPcts: colPcts });
      } else {
        allPageData.push({ rows: [], numCols: 0, isOcr: true, pageNum: pg, numericCols: [], colPcts: [] });
      }
    }

    await pdf.destroy();

    var isScanned  = totalRawChars < 50;
    var willUseOcr = isScanned || allPageData.some(function (d) { return d.isOcr; });
    var totalRows  = allPageData.reduce(function (s, d) { return s + d.rows.length; }, 0);
    var maxCols    = allPageData.reduce(function (s, d) { return Math.max(s, d.numCols); }, 0);

    // Quality score
    var qualityScore = isScanned ? 25 : Math.min(100, Math.round(
      (totalRows > 0 ? 40 : 0) +
      (maxCols > 1 ? 30 : 0) +
      (totalRawChars > 500 ? 30 : Math.round(totalRawChars / 500 * 30))
    ));

    var ocrBadge = willUseOcr
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' OCR mode — AI OCR Engine will extract table data during conversion.' +
        '</div>'
      : '';

    // Sheet mini-map (per-page summary)
    var miniMapHtml = '<div class="lp-sheet-minimap">' +
      allPageData.map(function (pd) {
        return '<div class="lp-sheet-minimap-page">' +
          '<div class="lp-smp-label">Page ' + pd.pageNum + '</div>' +
          (pd.isOcr
            ? '<div class="lp-smp-ocr">OCR</div>'
            : '<div class="lp-smp-grid">' + pd.colPcts.slice(0, 8).map(function (pct) {
                return '<div class="lp-smp-col" style="flex:' + pct + '"></div>';
              }).join('') + '</div>' +
              '<div class="lp-smp-info">' + pd.rows.length + 'r × ' + pd.numCols + 'c</div>'
          ) +
        '</div>';
      }).join('') +
      (numPages > previewPgs ? '<div class="lp-smp-more">+' + (numPages - previewPgs) + ' more pages</div>' : '') +
    '</div>';

    var tableHtml = '';
    if (totalRows > 0) {
      tableHtml = allPageData.map(function (pd) {
        if (!pd.rows.length) {
          return '<div class="lp-tbl-page">' +
            '<div class="lp-tbl-page-label">Page ' + pd.pageNum + ' — scanned (OCR during conversion)</div>' +
            '<div class="lp-tbl-ocr-badge">🔍 OCR will process this page</div>' +
          '</div>';
        }
        var displayRows = pd.rows.slice(0, 40);

        // Column width visualization header
        var colWidthBar = '<div class="lp-col-width-bar">' +
          pd.colPcts.map(function (pct, ci) {
            var isNum = pd.numericCols.indexOf(ci) >= 0;
            return '<div class="lp-cwb-col' + (isNum ? ' lp-cwb-num' : '') + '" style="flex:' + pct + '" title="Col ' + (ci + 1) + (isNum ? ' (numeric)' : '') + '">' +
              (ci + 1) + (isNum ? '<sup>123</sup>' : '') +
            '</div>';
          }).join('') +
        '</div>';

        var tHead = '<thead><tr>' + pd.rows[0].map(function (_, ci) {
          var isNum = pd.numericCols.indexOf(ci) >= 0;
          return '<th class="' + (isNum ? 'lp-tbl-num-col' : '') + '" style="min-width:' + (pd.colPcts[ci] ? Math.max(40, pd.colPcts[ci]) + 'px' : '60px') + '">' +
            'Col&nbsp;' + (ci + 1) + (isNum ? '<span class="lp-num-badge">123</span>' : '') +
          '</th>';
        }).join('') + '</tr></thead>';

        var tBody = '<tbody>' + displayRows.map(function (row) {
          return '<tr>' + row.map(function (cell, ci) {
            var sv      = String(cell === 0 ? '0' : (cell || ''));
            var isNum   = pd.numericCols.indexOf(ci) >= 0;
            var overflow = sv.length > 16;
            return '<td class="' + (isNum ? 'lp-tbl-num-col' : '') + (overflow ? ' lp-cell-overflow' : '') + '" title="' + esc(sv) + '">' +
              esc(sv.slice(0, 18)) + (overflow ? '…' : '') +
            '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody>';

        var more = pd.rows.length > 40 ? '<div class="lp-tbl-more">+' + (pd.rows.length - 40) + ' more rows (not shown in preview)</div>' : '';

        return '<div class="lp-tbl-page">' +
          '<div class="lp-tbl-page-label">Page ' + pd.pageNum + ' &mdash; <b>' + pd.rows.length + '</b> rows × <b>' + pd.numCols + '</b> cols' +
            (pd.numericCols.length ? ' · <span class="lp-num-note">' + pd.numericCols.length + ' numeric col' + (pd.numericCols.length > 1 ? 's' : '') + '</span>' : '') +
          '</div>' +
          colWidthBar +
          '<div class="lp-tbl-scroll"><table class="lp-tbl">' + tHead + tBody + '</table></div>' +
          more +
        '</div>';
      }).join('');
    } else if (willUseOcr) {
      tableHtml = '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
        '<span class="lp-struct-icon">🔍</span>' +
        '<span class="lp-struct-text">No digital table found. AI OCR Engine will extract table structure during conversion.</span>' +
      '</div></div>';
    } else {
      tableHtml = '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
        '<span class="lp-struct-icon">⚠️</span>' +
        '<span class="lp-struct-text">No structured table detected. Conversion may produce limited results.</span>' +
      '</div></div>';
    }

    host.innerHTML =
      '<div class="lp-panel lp-panel--pdfexcel">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>' +
            ' Table Preview' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages !== 1 ? 's' : '') + '</span>' +
            (totalRows > 0 ? '<span class="lp-stat"><b>' + totalRows + '</b> rows</span><span class="lp-stat"><b>' + maxCols + '</b> cols</span>' : '') +
            (willUseOcr ? '<span class="lp-stat lp-stat--warn"><b>OCR</b> mode</span>' : '<span class="lp-stat"><b>Digital</b> text</span>') +
            qualityBadge(qualityScore) +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        miniMapHtml +
        '<div class="lp-extract-body">' + tableHtml + '</div>' +
        '<div class="lp-footer">Column widths are proportional to detected data · blue headers = numeric columns detected · orange cells have overflow text</div>' +
      '</div>';
  }

  // ======================================================================
  // BACKGROUND REMOVER v7.0 — multi-background, quality modes, subject modes,
  //   instant color switching, swipe compare, export presets, edge quality
  // ======================================================================
  async function mountBgRemover(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Loading image preview\u2026</div>';

    var objUrl = URL.createObjectURL(file);
    var img    = new Image();
    try {
      await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = objUrl; });
    } catch (_) {
      URL.revokeObjectURL(objUrl);
      host.innerHTML = errorHtml('Could not load image. Please use JPG, PNG, or WebP.');
      return;
    }
    URL.revokeObjectURL(objUrl);

    var MAX_DIM = 340;
    var scale   = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight, 1));
    var W       = Math.max(1, Math.round(img.naturalWidth  * scale));
    var H       = Math.max(1, Math.round(img.naturalHeight * scale));
    var origW   = img.naturalWidth;
    var origH   = img.naturalHeight;

    var srcCanvas    = document.createElement('canvas');
    srcCanvas.width  = W; srcCanvas.height = H;
    var sCtx = srcCanvas.getContext('2d');
    sCtx.drawImage(img, 0, 0, W, H);
    var srcData = sCtx.getImageData(0, 0, W, H);

    var afterCanvas   = document.createElement('canvas');
    afterCanvas.width = W; afterCanvas.height = H;
    var aCtx = afterCanvas.getContext('2d');

    // ── background color definitions ──────────────────────────────────────
    var BG_SWATCHES = [
      { id: 'transparent', label: 'None',     fill: null,      isGrad: false },
      { id: 'white',       label: 'White',    fill: '#ffffff', isGrad: false },
      { id: '#f1f5f9',     label: 'Light',    fill: '#f1f5f9', isGrad: false },
      { id: 'black',       label: 'Black',    fill: '#000000', isGrad: false },
      { id: '#2563eb',     label: 'Blue',     fill: '#2563eb', isGrad: false },
      { id: '#16a34a',     label: 'Green',    fill: '#16a34a', isGrad: false },
      { id: '#dc2626',     label: 'Red',      fill: '#dc2626', isGrad: false },
      { id: 'gradient-blue', label: 'Grad',   fill: null,      isGrad: true, grad: ['#1a56db','#4f46e5'] },
    ];

    var currentBg     = 'transparent';
    var currentQmode  = 'hd';
    var currentSmode  = 'auto';
    var maskMode      = false;
    var initThresh    = 240;

    // ── Checkerboard / solid background on afterCanvas ────────────────────
    function drawBgLayer(bgId) {
      aCtx.clearRect(0, 0, W, H);
      if (!bgId || bgId === 'transparent') {
        var SZ = 8;
        for (var ry = 0; ry < H; ry += SZ) {
          for (var rx = 0; rx < W; rx += SZ) {
            aCtx.fillStyle = (((rx / SZ) + (ry / SZ)) % 2 === 0) ? '#d4d4d4' : '#ffffff';
            aCtx.fillRect(rx, ry, SZ, SZ);
          }
        }
      } else if (bgId === 'gradient-blue') {
        var grd = aCtx.createLinearGradient(0, 0, W, H);
        grd.addColorStop(0, '#1a56db'); grd.addColorStop(1, '#4f46e5');
        aCtx.fillStyle = grd;
        aCtx.fillRect(0, 0, W, H);
      } else {
        aCtx.fillStyle = bgId;
        aCtx.fillRect(0, 0, W, H);
      }
    }

    // ── Build transparent result on a temp canvas, composite on afterCanvas ─
    var DX8 = [-1, 1, 0, 0, -1, 1, -1, 1];
    var DY8 = [0, 0, -1, 1, -1, -1, 1, 1];

    function applyThreshold(threshold, maskModeFlag, bgId) {
      var out = new ImageData(new Uint8ClampedArray(srcData.data), W, H);
      var d   = out.data;

      // Simple luminance threshold for preview (fast)
      for (var i = 0; i < d.length; i += 4) {
        if (d[i] >= threshold && d[i+1] >= threshold && d[i+2] >= threshold) d[i+3] = 0;
      }

      // Soft edge pass
      var copy = new Uint8ClampedArray(d);
      for (var ry = 1; ry < H - 1; ry++) {
        for (var rx = 1; rx < W - 1; rx++) {
          var idx = (ry * W + rx) * 4;
          if (copy[idx+3] === 0) continue;
          var transparent = 0;
          for (var n = 0; n < 8; n++) {
            var ni = ((ry + DY8[n]) * W + (rx + DX8[n])) * 4;
            if (ni >= 0 && ni < copy.length && copy[ni+3] === 0) transparent++;
          }
          if (transparent > 0) d[idx+3] = Math.round(copy[idx+3] * (1 - transparent / 8));
        }
      }

      if (maskModeFlag) {
        for (var mi = 0; mi < d.length; mi += 4) {
          var av = out.data[mi+3];
          out.data[mi] = av; out.data[mi+1] = av; out.data[mi+2] = av; out.data[mi+3] = 255;
        }
      }

      // Draw bg layer, then composite transparent image on top
      drawBgLayer(maskModeFlag ? 'white' : bgId);
      var tmpCvs = document.createElement('canvas');
      tmpCvs.width = W; tmpCvs.height = H;
      tmpCvs.getContext('2d').putImageData(out, 0, 0);
      if (!maskModeFlag) aCtx.drawImage(tmpCvs, 0, 0);
      else { aCtx.clearRect(0, 0, W, H); aCtx.putImageData(out, 0, 0); }
    }

    // ── Edge quality heuristic ────────────────────────────────────────────
    function computeEdgeQuality(threshold) {
      var d = new Uint8ClampedArray(srcData.data);
      for (var i = 0; i < d.length; i += 4) {
        if (d[i] >= threshold && d[i+1] >= threshold && d[i+2] >= threshold) d[i+3] = 0;
      }
      var edgeCount = 0;
      for (var ry = 1; ry < H - 1; ry++) {
        for (var rx = 1; rx < W - 1; rx++) {
          var idx = (ry * W + rx) * 4 + 3;
          if (Math.abs(d[idx] - d[(ry * W + rx + 1) * 4 + 3]) > 50 ||
              Math.abs(d[idx] - d[((ry+1) * W + rx) * 4 + 3]) > 50) edgeCount++;
        }
      }
      var ratio = edgeCount / (W * H);
      if (ratio < 0.01) return { label: 'Clean', score: 95, cls: 'lp-eq-good' };
      if (ratio < 0.04) return { label: 'Good',  score: 78, cls: 'lp-eq-good' };
      if (ratio < 0.10) return { label: 'Jagged', score: 50, cls: 'lp-eq-med' };
      return { label: 'Rough', score: 25, cls: 'lp-eq-bad' };
    }

    function estimateExportKB(bgId) {
      var px = origW * origH;
      return bgId && bgId !== 'transparent'
        ? Math.round(px * 3 / 1024 / 5)   // JPEG estimate
        : Math.round(px * 4 / 1024 / 3);  // PNG estimate
    }

    // ── Sync opts to tool page selectors ─────────────────────────────────
    function syncOpts() {
      var tEl = document.getElementById('opt-threshold');
      var qEl = document.getElementById('opt-qualityMode');
      var sEl = document.getElementById('opt-subjectMode');
      var bEl = document.getElementById('opt-bgColor');
      if (tEl) tEl.value = initThresh;
      if (qEl) qEl.value = currentQmode;
      if (sEl) sEl.value = currentSmode;
      if (bEl) bEl.value = currentBg;
    }

    // ── Initial render ────────────────────────────────────────────────────
    applyThreshold(initThresh, false, currentBg);
    var edgeQ = computeEdgeQuality(initThresh);

    // ── Build swatches HTML ───────────────────────────────────────────────
    var swatchHtml = BG_SWATCHES.map(function (s) {
      var style = s.isGrad
        ? 'background:linear-gradient(135deg,' + s.grad[0] + ',' + s.grad[1] + ')'
        : (s.fill ? 'background:' + s.fill : 'background:repeating-conic-gradient(#ccc 0% 25%,#fff 0% 50%) 0 0/10px 10px');
      var active = s.id === currentBg ? ' active' : '';
      return '<button type="button" class="lp-swatch' + active + '" data-bgid="' + s.id + '" title="' + s.label + '" style="' + style + '"></button>';
    }).join('');

    host.innerHTML =
      '<div class="lp-panel lp-panel--image">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
            ' Background Remover Preview' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + origW + '\xd7' + origH + '</b> px</span>' +
            '<span class="lp-stat lp-export-size"><b>~<span id="lp-expkb">' + estimateExportKB(currentBg) + '</span></b> KB</span>' +
            '<span class="lp-eq-badge ' + edgeQ.cls + '" id="lp-eq-badge">' + edgeQ.label + '</span>' +
          '</div>' +

          '<div class="lp-controls">' +
            // Background swatches
            '<div class="lp-ctrl-group">' +
              '<span class="lp-ctrl-label">Background</span>' +
              '<div class="lp-swatch-row" id="lp-swatch-row">' + swatchHtml + '</div>' +
            '</div>' +
            // Threshold slider
            '<div class="lp-ctrl-group">' +
              '<span class="lp-ctrl-label">Sensitivity: <b id="lp-thresh-val">' + initThresh + '</b></span>' +
              '<input type="range" class="lp-slider" id="lp-thresh" min="50" max="255" value="' + initThresh + '" aria-label="Background threshold">' +
            '</div>' +
            // Quality + Subject mode
            '<div class="lp-ctrl-group lp-ctrl-group--row">' +
              '<div class="lp-ctrl-inline">' +
                '<span class="lp-ctrl-label">Quality</span>' +
                '<div class="lp-ctrl-row">' +
                  '<button type="button" class="lp-ctrl-btn" data-qmode="fast">Fast</button>' +
                  '<button type="button" class="lp-ctrl-btn active" data-qmode="hd">HD</button>' +
                  '<button type="button" class="lp-ctrl-btn" data-qmode="ultra">Ultra</button>' +
                '</div>' +
              '</div>' +
              '<div class="lp-ctrl-inline">' +
                '<span class="lp-ctrl-label">Subject</span>' +
                '<div class="lp-ctrl-row">' +
                  '<button type="button" class="lp-ctrl-btn active" data-smode="auto">Auto</button>' +
                  '<button type="button" class="lp-ctrl-btn" data-smode="portrait">Person</button>' +
                  '<button type="button" class="lp-ctrl-btn" data-smode="product">Product</button>' +
                  '<button type="button" class="lp-ctrl-btn" data-smode="logo">Logo</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            // View mode
            '<div class="lp-ctrl-group">' +
              '<span class="lp-ctrl-label">View</span>' +
              '<div class="lp-ctrl-row">' +
                '<button type="button" class="lp-ctrl-btn active" data-bgview="normal">Before/After</button>' +
                '<button type="button" class="lp-ctrl-btn" data-bgview="swipe">Swipe</button>' +
                '<button type="button" class="lp-ctrl-btn" data-bgview="mask">Alpha mask</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="lp-before-after" id="lp-ba-wrap">' +
          '<div class="lp-ba-col"><div class="lp-ba-label">Original</div><div class="lp-ba-canvas" id="lp-before-host"></div></div>' +
          '<div class="lp-ba-divider" aria-hidden="true">\u2192</div>' +
          '<div class="lp-ba-col"><div class="lp-ba-label">Result preview</div><div class="lp-ba-canvas lp-ba-canvas--after" id="lp-after-host"></div></div>' +
        '</div>' +
        '<div class="lp-swipe-wrap" id="lp-swipe-wrap" style="display:none">' +
          '<div class="lp-swipe-container" id="lp-swipe-container">' +
            '<div class="lp-swipe-after" id="lp-swipe-after"></div>' +
            '<div class="lp-swipe-before" id="lp-swipe-before"></div>' +
            '<div class="lp-swipe-handle" id="lp-swipe-handle"></div>' +
          '</div>' +
        '</div>' +

        '<div class="lp-eq-meter">' +
          '<div class="lp-eq-label">Edge quality</div>' +
          '<div class="lp-eq-bar"><div class="lp-eq-fill" id="lp-eq-fill" style="width:' + edgeQ.score + '%"></div></div>' +
          '<div class="lp-eq-hint" id="lp-eq-hint">' + edgeQ.label + ' \u2014 ' + edgeQ.score + '/100</div>' +
        '</div>' +

        '<div class="lp-footer">Pick a background color · adjust sensitivity · choose quality &amp; subject mode · final result uses the selected settings</div>' +
      '</div>';

    var bHost = host.querySelector('#lp-before-host');
    var aHost = host.querySelector('#lp-after-host');
    if (bHost) bHost.appendChild(srcCanvas);
    if (aHost) aHost.appendChild(afterCanvas);

    var slider  = host.querySelector('#lp-thresh');
    var valLbl  = host.querySelector('#lp-thresh-val');
    var eqBadge = host.querySelector('#lp-eq-badge');
    var eqFill  = host.querySelector('#lp-eq-fill');
    var eqHint  = host.querySelector('#lp-eq-hint');
    var expKb   = host.querySelector('#lp-expkb');

    function refreshEdge(thresh) {
      var eq = computeEdgeQuality(thresh);
      if (eqBadge) { eqBadge.textContent = eq.label; eqBadge.className = 'lp-eq-badge ' + eq.cls; }
      if (eqFill)  eqFill.style.width = eq.score + '%';
      if (eqHint)  eqHint.textContent = eq.label + ' \u2014 ' + eq.score + '/100';
    }

    function refreshExportSize() {
      if (expKb) expKb.textContent = estimateExportKB(currentBg);
    }

    var rafPending = null;
    function scheduleUpdate() {
      if (rafPending) cancelAnimationFrame(rafPending);
      rafPending = requestAnimationFrame(function () {
        var v = slider ? parseInt(slider.value, 10) : initThresh;
        applyThreshold(v, maskMode, currentBg);
        refreshEdge(v);
        updateSwipeCanvases(v);
        rafPending = null;
      });
    }

    // ── Threshold slider ──────────────────────────────────────────────────
    if (slider) slider.addEventListener('input', function () {
      var v = parseInt(slider.value, 10);
      if (valLbl) valLbl.textContent = v;
      var optEl = document.getElementById('opt-threshold'); if (optEl) optEl.value = v;
      scheduleUpdate();
    });

    // ── Background swatches ───────────────────────────────────────────────
    host.querySelectorAll('[data-bgid]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentBg = btn.dataset.bgid;
        host.querySelectorAll('[data-bgid]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.bgid === currentBg);
        });
        refreshExportSize();
        syncOpts();
        scheduleUpdate();
      });
    });

    // ── Quality mode buttons ──────────────────────────────────────────────
    host.querySelectorAll('[data-qmode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentQmode = btn.dataset.qmode;
        host.querySelectorAll('[data-qmode]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.qmode === currentQmode);
        });
        syncOpts();
      });
    });

    // ── Subject mode buttons ──────────────────────────────────────────────
    host.querySelectorAll('[data-smode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentSmode = btn.dataset.smode;
        host.querySelectorAll('[data-smode]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.smode === currentSmode);
        });
        syncOpts();
      });
    });

    // ── View mode toggle ──────────────────────────────────────────────────
    host.querySelectorAll('[data-bgview]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode2  = b.dataset.bgview;
        maskMode   = mode2 === 'mask';
        host.querySelectorAll('[data-bgview]').forEach(function (x) {
          x.classList.toggle('active', x.dataset.bgview === mode2);
        });
        var baWrap    = host.querySelector('#lp-ba-wrap');
        var swipeWrap = host.querySelector('#lp-swipe-wrap');
        if (baWrap)    baWrap.style.display    = (mode2 === 'swipe') ? 'none' : '';
        if (swipeWrap) swipeWrap.style.display = (mode2 === 'swipe') ? ''    : 'none';
        scheduleUpdate();
      });
    });

    // ── Swipe compare ─────────────────────────────────────────────────────
    function updateSwipeCanvases(thresh) {
      var sc = host.querySelector('#lp-swipe-container');
      if (!sc || sc.parentElement.style.display === 'none') return;
      var afterEl  = host.querySelector('#lp-swipe-after');
      var beforeEl = host.querySelector('#lp-swipe-before');
      if (!afterEl || !beforeEl) return;
      afterEl.style.backgroundImage  = 'url(' + afterCanvas.toDataURL() + ')';
      beforeEl.style.backgroundImage = 'url(' + srcCanvas.toDataURL() + ')';
    }

    var swipeHandle = host.querySelector('#lp-swipe-handle');
    if (swipeHandle) {
      var dragging = false;
      var container = host.querySelector('#lp-swipe-container');
      swipeHandle.addEventListener('mousedown', function () { dragging = true; });
      document.addEventListener('mouseup', function () { dragging = false; });
      document.addEventListener('mousemove', function (e) {
        if (!dragging || !container) return;
        var rect = container.getBoundingClientRect();
        var pct  = clamp((e.clientX - rect.left) / rect.width * 100, 0, 100);
        var bEl  = host.querySelector('#lp-swipe-before');
        if (bEl) bEl.style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
        swipeHandle.style.left = pct + '%';
      });
      swipeHandle.addEventListener('touchmove', function (e) {
        if (!container) return;
        e.preventDefault();
        var rect = container.getBoundingClientRect();
        var pct  = clamp((e.touches[0].clientX - rect.left) / rect.width * 100, 0, 100);
        var bEl  = host.querySelector('#lp-swipe-before');
        if (bEl) bEl.style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
        swipeHandle.style.left = pct + '%';
      }, { passive: false });
    }

    syncOpts();
  }

  // ======================================================================
  // TRANSLATE PDF  (v6.0 — side-by-side, language detect, coverage %, format)
  // ======================================================================
  async function mountTranslatePreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing document…' + skeletonHtml(5) + '</div>';

    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (lpErr) { console.error('[LP_DEBUG] loadPdfJs failed (translate):', lpErr); host.innerHTML = errorHtml('PDF renderer not available. Check your connection.'); return; }

    var buf, pdf;
    try {
      buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    } catch (lpErr) { console.error('[LP_DEBUG] getDocument failed (translate):', lpErr); host.innerHTML = errorHtml('Could not parse this PDF.'); return; }

    var numPages   = pdf.numPages;
    var checkPages = Math.min(numPages, 3);
    var totalChars = 0;
    var textSnippet = '';
    var allText = '';

    for (var pg = 1; pg <= checkPages; pg++) {
      var page    = await pdf.getPage(pg);
      var content = await page.getTextContent();
      var pageText = content.items.map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim();
      totalChars += pageText.replace(/\s/g, '').length;
      allText    += pageText + ' ';
      if (!textSnippet && pageText.length > 30) textSnippet = pageText.slice(0, 300);
      page.cleanup();
    }
    await pdf.destroy();

    var isScanned  = totalChars < 50;
    var estWords   = isScanned ? 0 : Math.round(totalChars * (numPages / checkPages) / 5);
    var detectedLang = detectLanguage(allText);
    var coverage   = isScanned ? 0 : Math.min(100, Math.round(totalChars / Math.max(1, numPages * 200) * 100));

    // Sync target language from tool option
    var targetLangEl = document.getElementById('opt-targetLang') || document.getElementById('opt-target_lang');
    var targetLang   = targetLangEl ? targetLangEl.value : 'en';
    var targetLabel  = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', zh: 'Chinese',
                         ar: 'Arabic', ru: 'Russian', pt: 'Portuguese', it: 'Italian', ja: 'Japanese' }[targetLang] || targetLang;

    var ocrBadge = isScanned
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' Scanned PDF — AI OCR Engine will extract text before translating.' +
        '</div>'
      : '';

    var snippetLines = textSnippet
      ? textSnippet.replace(/(.{60})/g, '$1\n').split('\n').slice(0, 5)
      : [];

    host.innerHTML =
      '<div class="lp-panel lp-panel--translate">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>' +
            ' Translation Preview' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages !== 1 ? 's' : '') + '</span>' +
            (detectedLang ? '<span class="lp-stat"><b>' + detectedLang.flag + ' ' + detectedLang.label + '</b> detected</span>' : '') +
            (isScanned
              ? '<span class="lp-stat lp-stat--warn"><b>Scanned</b> — OCR</span>'
              : '<span class="lp-stat"><b>~' + fmtNum(estWords) + '</b> words</span>' +
                '<span class="lp-stat lp-cov-badge" title="Text coverage of sampled pages"><b>' + coverage + '%</b> coverage</span>') +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        '<div class="lp-sxs-wrap">' +
          '<div class="lp-sxs-col">' +
            '<div class="lp-sxs-label">' +
              (detectedLang ? detectedLang.flag + ' ' : '📄 ') + 'Source text' +
              (detectedLang ? '<span class="lp-lang-badge">' + detectedLang.label + '</span>' : '') +
            '</div>' +
            '<div class="lp-sxs-content">' +
              (textSnippet
                ? esc(textSnippet.slice(0, 500)) + (textSnippet.length > 500 ? '…' : '')
                : isScanned
                  ? '<span class="lp-sxs-placeholder">🔍 OCR will extract text during translation</span>'
                  : '<span class="lp-sxs-placeholder">No readable text in the first pages</span>') +
            '</div>' +
          '</div>' +
          '<div class="lp-sxs-arrow">→</div>' +
          '<div class="lp-sxs-col lp-sxs-col--target">' +
            '<div class="lp-sxs-label">🌐 Translation output<span class="lp-lang-badge lp-lang-badge--target">' + targetLabel + '</span></div>' +
            '<div class="lp-sxs-content lp-sxs-content--pending">' +
              '<div class="lp-translate-pending">' +
                '<div class="lp-tp-icon">🌐</div>' +
                '<div class="lp-tp-msg">Translation will appear after processing</div>' +
                (snippetLines.length ? '<div class="lp-skel lp-skel--translate">' + snippetLines.map(function (l) {
                  return '<div class="lp-skel-line" style="width:' + Math.round(60 + Math.random() * 35) + '%"></div>';
                }).join('') + '</div>' : '') +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        (!isScanned && coverage < 40
          ? '<div class="lp-warn-banner lp-warn-coverage"><span class="lp-warn-icon">⚠</span> Low text coverage (' + coverage + '%) — PDF may contain mostly images. Translation quality may vary.</div>'
          : '') +
        '<div class="lp-footer">Full document will be translated · large PDFs may take a moment · OCR runs automatically for scanned pages</div>' +
      '</div>';
  }

  // ======================================================================
  // AI SUMMARIZER  (v6.0 — key topics, compression, mode switch, section preview)
  // ======================================================================
  async function mountSummarizePreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing document…' + skeletonHtml(8) + '</div>';

    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (lpErr) { console.error('[LP_DEBUG] loadPdfJs failed (ai-summarize):', lpErr); host.innerHTML = errorHtml('PDF renderer not available. Check your connection.'); return; }

    var buf, pdf;
    try {
      buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    } catch (lpErr) { console.error('[LP_DEBUG] getDocument failed (ai-summarize):', lpErr); host.innerHTML = errorHtml('Could not parse this PDF.'); return; }

    var numPages   = pdf.numPages;
    var checkPages = Math.min(numPages, 4);
    var totalChars = 0;
    var allLines   = [];
    var allText    = '';

    for (var pg = 1; pg <= checkPages; pg++) {
      var page     = await pdf.getPage(pg);
      var content  = await page.getTextContent();
      var buckets  = {};
      var pageSizes2 = [];

      content.items.forEach(function (it) {
        if (!it.str || !it.str.trim()) return;
        totalChars += it.str.replace(/\s/g, '').length;
        allText    += it.str + ' ';
        var yKey = Math.round(it.transform[5] / 3) * 3;
        if (!buckets[yKey]) buckets[yKey] = { parts: [], fontSize: 0 };
        buckets[yKey].parts.push({ text: it.str });
        if ((it.height || 0) > buckets[yKey].fontSize) buckets[yKey].fontSize = it.height || 0;
        if (it.height > 0) pageSizes2.push(Math.round(it.height));
      });
      page.cleanup();

      var freq2 = {};
      pageSizes2.forEach(function (s) { freq2[s] = (freq2[s] || 0) + 1; });
      var baseFs = pageSizes2.length
        ? parseInt(Object.keys(freq2).sort(function (a, b) { return freq2[b] - freq2[a]; })[0], 10) || 11 : 11;

      Object.keys(buckets).map(Number).sort(function (a, b) { return b - a; }).forEach(function (y) {
        var bucket = buckets[y];
        var text   = bucket.parts.map(function (p) { return p.text; }).join(' ').trim();
        if (!text) return;
        var isHeading =
          (bucket.fontSize > 0 && bucket.fontSize > baseFs * 1.2) ||
          (text === text.toUpperCase() && text.length >= 3 && text.length < 80 && /[A-Z]/.test(text) && !/^\d/.test(text)) ||
          (/^(\d+\.)+\s+\S/.test(text) && text.length <= 80);
        allLines.push({ text: text, isHeading: isHeading, chars: text.length });
      });
    }
    await pdf.destroy();

    var isScanned    = totalChars < 50;
    var estWords     = isScanned ? 0 : Math.round(totalChars * (numPages / checkPages) / 5);
    var readingMins  = Math.max(1, Math.ceil(estWords / 200));
    var headings     = allLines.filter(function (l) { return l.isHeading; });
    var headCount    = headings.length;
    var topics       = extractTopics(allText, 8);

    // Compression ratios for modes
    var COMPRESSION = { brief: 0.05, standard: 0.12, detailed: 0.25 };
    var activeMode   = 'standard';

    // Summary estimation based on mode
    function summaryStats(mode) {
      var ratio    = COMPRESSION[mode] || 0.12;
      var sumWords = Math.round(estWords * ratio);
      var sumMins  = Math.max(1, Math.ceil(sumWords / 200));
      var pct      = Math.round(ratio * 100);
      var reduction = Math.round((1 - ratio) * 100);
      return { sumWords: sumWords, sumMins: sumMins, pct: pct, reduction: reduction };
    }

    function renderModeStats() {
      var s = summaryStats(activeMode);
      var el = host.querySelector('.lp-sum-modestats');
      if (el) {
        el.innerHTML =
          '<span class="lp-stat"><b>~' + fmtNum(s.sumWords) + '</b> summary words</span>' +
          '<span class="lp-stat"><b>~' + s.sumMins + '</b> min read</span>' +
          '<span class="lp-stat lp-stat--good"><b>' + s.reduction + '%</b> shorter</span>';
      }
      var barEl = host.querySelector('.lp-compress-fill');
      if (barEl) barEl.style.width = s.pct + '%';
      var ratioEl = host.querySelector('.lp-compress-label');
      if (ratioEl) ratioEl.textContent = s.pct + '% of original';
    }

    var ocrBadge = isScanned
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' Scanned PDF — OCR will extract text before summarizing.' +
        '</div>'
      : '';

    // Section preview (group lines between headings)
    var sections = [];
    var cur = null;
    allLines.slice(0, 30).forEach(function (l) {
      if (l.isHeading) { cur = { heading: l.text, paras: [] }; sections.push(cur); }
      else if (cur) { if (cur.paras.length < 2) cur.paras.push(l.text); }
      else { if (!sections.length) { cur = { heading: null, paras: [] }; sections.push(cur); } cur.paras.push(l.text); }
    });

    var structPanel = '';
    if (isScanned) {
      structPanel = '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
        '<span class="lp-struct-icon">🔍</span>' +
        '<span class="lp-struct-text">OCR will process each page. Summary generated after text extraction.</span>' +
      '</div></div>';
    } else if (sections.length) {
      structPanel = '<div class="lp-sum-sections">' +
        sections.slice(0, 4).map(function (sec, si) {
          return '<div class="lp-sum-section">' +
            (sec.heading
              ? '<div class="lp-sum-sec-heading">📌 ' + esc(sec.heading.slice(0, 60)) + '</div>'
              : '<div class="lp-sum-sec-heading lp-sum-sec-heading--implicit">§ Section ' + (si + 1) + '</div>') +
            sec.paras.map(function (p) {
              return '<div class="lp-sum-sec-para">¶ ' + esc(p.slice(0, 80)) + (p.length > 80 ? '…' : '') + '</div>';
            }).join('') +
          '</div>';
        }).join('') +
        (sections.length > 4 ? '<div class="lp-struct-line lp-struct-para" style="margin-top:6px"><span class="lp-struct-icon">⋯</span><span class="lp-struct-text">+' + (sections.length - 4) + ' more sections</span></div>' : '') +
      '</div>';
    } else {
      structPanel = '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
        '<span class="lp-struct-icon">⚠️</span>' +
        '<span class="lp-struct-text">No readable content detected. OCR will be attempted during summarization.</span>' +
      '</div></div>';
    }

    var topicsHtml = topics.length
      ? '<div class="lp-topics"><div class="lp-topics-label">Key topics detected</div><div class="lp-topics-list">' +
          topics.map(function (t) { return '<span class="lp-topic-badge">' + esc(t) + '</span>'; }).join('') +
        '</div></div>'
      : '';

    var s0 = summaryStats('standard');

    host.innerHTML =
      '<div class="lp-panel lp-panel--summarize">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
            ' Document Analysis' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages !== 1 ? 's' : '') + '</span>' +
            (isScanned
              ? '<span class="lp-stat lp-stat--warn"><b>Scanned</b> — OCR</span>'
              : '<span class="lp-stat"><b>~' + fmtNum(estWords) + '</b> words</span>' +
                '<span class="lp-stat"><b>~' + readingMins + '</b> min read</span>' +
                '<span class="lp-stat"><b>' + headCount + '</b> section' + (headCount !== 1 ? 's' : '') + '</span>') +
          '</div>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Summary mode</span><div class="lp-ctrl-row">' +
              [{ id: 'brief', label: '⚡ Brief' }, { id: 'standard', label: '📄 Standard' }, { id: 'detailed', label: '📚 Detailed' }].map(function (m) {
                return '<button type="button" class="lp-ctrl-btn' + (m.id === 'standard' ? ' active' : '') + '" data-summode="' + m.id + '">' + m.label + '</button>';
              }).join('') +
            '</div></div>' +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        '<div class="lp-sum-modestats lp-stats" style="padding:8px 14px;border-bottom:1px solid #f1f5f9;">' +
          '<span class="lp-stat"><b>~' + fmtNum(s0.sumWords) + '</b> summary words</span>' +
          '<span class="lp-stat"><b>~' + s0.sumMins + '</b> min read</span>' +
          '<span class="lp-stat lp-stat--good"><b>' + s0.reduction + '%</b> shorter</span>' +
        '</div>' +
        '<div class="lp-compress-bar-wrap">' +
          '<div class="lp-compress-bar">' +
            '<div class="lp-compress-fill" style="width:' + s0.pct + '%"></div>' +
          '</div>' +
          '<div class="lp-compress-label">' + s0.pct + '% of original</div>' +
        '</div>' +
        topicsHtml +
        '<div class="lp-extract-body">' + structPanel + '</div>' +
        '<div class="lp-footer">Section preview from first ' + checkPages + ' pages · mode selector affects summary length · full document summarized</div>' +
      '</div>';

    // Wire mode buttons
    host.querySelectorAll('[data-summode]').forEach(function (b) {
      b.addEventListener('click', function () {
        activeMode = b.dataset.summode;
        host.querySelectorAll('[data-summode]').forEach(function (x) { x.classList.toggle('active', x.dataset.summode === activeMode); });
        var optEl = document.getElementById('opt-summaryMode') || document.getElementById('opt-mode'); if (optEl) optEl.value = activeMode;
        renderModeStats();
      });
    });
  }

  // ======================================================================
  // EDIT PDF  (v6.0 — canvas page preview, ruler, safe-zone, grid toggle)
  // ======================================================================
  async function mountEditPdfPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Loading PDF preview…</div>';

    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (lpErr) { console.error('[LP_DEBUG] loadPdfJs failed (edit):', lpErr); host.innerHTML = errorHtml('PDF renderer not available. Check your connection.'); return; }

    var buf, pdf;
    try {
      buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    } catch (lpErr) { console.error('[LP_DEBUG] getDocument failed (edit):', lpErr); host.innerHTML = errorHtml('Could not parse this PDF.'); return; }

    var numPages  = pdf.numPages;
    var curPage   = 1;
    var showGrid  = false;
    var showSafe  = true;
    var scale     = 1.2;
    var pdfPageRef = null;

    async function renderPage(pageNum) {
      pdfPageRef = await pdf.getPage(pageNum);
      var viewport = pdfPageRef.getViewport({ scale: scale });
      var W = Math.round(viewport.width);
      var H = Math.round(viewport.height);

      var pgCanvas = host.querySelector('#lp-edit-canvas');
      if (!pgCanvas) return;
      pgCanvas.width  = W;
      pgCanvas.height = H;
      var ctx = pgCanvas.getContext('2d');
      await pdfPageRef.render({ canvasContext: ctx, viewport: viewport }).promise;

      // Overlay canvas
      var ov = host.querySelector('#lp-edit-overlay');
      if (ov) {
        ov.width  = W;
        ov.height = H;
        var octx = ov.getContext('2d');
        octx.clearRect(0, 0, W, H);

        // Safe zone (5% margin)
        if (showSafe) {
          var mx = W * 0.05, my = H * 0.05;
          octx.strokeStyle = 'rgba(99,102,241,0.4)';
          octx.setLineDash([4, 4]);
          octx.lineWidth = 1;
          octx.strokeRect(mx, my, W - mx * 2, H - my * 2);
          octx.setLineDash([]);
          // Label
          octx.fillStyle = 'rgba(99,102,241,0.7)';
          octx.font = '10px sans-serif';
          octx.fillText('Safe zone', mx + 3, my + 12);
        }

        // Grid
        if (showGrid) {
          octx.strokeStyle = 'rgba(148,163,184,0.3)';
          octx.lineWidth   = 0.5;
          var step = Math.round(Math.min(W, H) / 10);
          for (var gx = step; gx < W; gx += step) {
            octx.beginPath(); octx.moveTo(gx, 0); octx.lineTo(gx, H); octx.stroke();
          }
          for (var gy = step; gy < H; gy += step) {
            octx.beginPath(); octx.moveTo(0, gy); octx.lineTo(W, gy); octx.stroke();
          }
        }

        // Rulers (tick marks along top and left)
        octx.fillStyle = 'rgba(100,116,139,0.5)';
        octx.font = '9px sans-serif';
        var tickStep = Math.round(W / 8);
        for (var tx = tickStep; tx < W; tx += tickStep) {
          octx.fillRect(tx, 0, 1, 6);
          octx.fillText(Math.round(tx / scale) + 'px', tx + 2, 12);
        }
        var tyStep = Math.round(H / 8);
        for (var ty = tyStep; ty < H; ty += tyStep) {
          octx.fillRect(0, ty, 6, 1);
          octx.fillText(Math.round(ty / scale), 2, ty - 2);
        }
      }

      // Update page info
      var pgInfoEl = host.querySelector('.lp-edit-pginfo');
      if (pgInfoEl) {
        pgInfoEl.textContent = 'Page ' + pageNum + ' of ' + numPages + ' · ' +
          Math.round(viewport.width / scale) + ' × ' + Math.round(viewport.height / scale) + ' px';
      }

      pdfPageRef.cleanup();
    }

    host.innerHTML =
      '<div class="lp-panel lp-panel--edit">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
            ' Page Preview' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat lp-edit-pginfo">Page 1 of ' + numPages + '</span>' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages !== 1 ? 's' : '') + ' total</span>' +
          '</div>' +
          '<div class="lp-controls">' +
            (numPages > 1 ? '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page</span><div class="lp-ctrl-row">' +
              '<button type="button" class="lp-ctrl-btn" id="lp-edit-prev">‹ Prev</button>' +
              '<button type="button" class="lp-ctrl-btn" id="lp-edit-next">Next ›</button>' +
            '</div></div>' : '') +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Zoom</span><div class="lp-ctrl-row">' +
              [{ v: 0.8, l: '80%' }, { v: 1.2, l: '120%' }, { v: 1.8, l: '180%' }].map(function (z) {
                return '<button type="button" class="lp-ctrl-btn' + (z.v === 1.2 ? ' active' : '') + '" data-editzoom="' + z.v + '">' + z.l + '</button>';
              }).join('') +
            '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Overlays</span><div class="lp-ctrl-row">' +
              '<button type="button" class="lp-ctrl-btn active" data-overlay="safe">Safe zone</button>' +
              '<button type="button" class="lp-ctrl-btn" data-overlay="grid">Grid</button>' +
            '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="lp-edit-canvas-scroll">' +
          '<div class="lp-edit-canvas-host">' +
            '<canvas id="lp-edit-canvas" class="lp-edit-canvas"></canvas>' +
            '<canvas id="lp-edit-overlay" class="lp-edit-overlay"></canvas>' +
          '</div>' +
        '</div>' +
        '<div class="lp-footer">PDF page preview with safe-zone and grid overlays · add text and annotations using the options below · full editor on process</div>' +
      '</div>';

    // Wire page navigation
    var prevBtn = host.querySelector('#lp-edit-prev');
    var nextBtn = host.querySelector('#lp-edit-next');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (curPage > 1) { curPage--; renderPage(curPage); }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        if (curPage < numPages) { curPage++; renderPage(curPage); }
      });
    }

    // Wire zoom
    host.querySelectorAll('[data-editzoom]').forEach(function (b) {
      b.addEventListener('click', function () {
        scale = parseFloat(b.dataset.editzoom);
        host.querySelectorAll('[data-editzoom]').forEach(function (x) { x.classList.toggle('active', x.dataset.editzoom === b.dataset.editzoom); });
        renderPage(curPage);
      });
    });

    // Wire overlays
    host.querySelectorAll('[data-overlay]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ov2 = b.dataset.overlay;
        b.classList.toggle('active');
        if (ov2 === 'safe') showSafe = b.classList.contains('active');
        if (ov2 === 'grid') showGrid = b.classList.contains('active');
        renderPage(curPage);
      });
    });

    await renderPage(1);
  }

  // ======================================================================
  // PDF → POWERPOINT  v6.0
  // Slide structure analysis, type classification, theme/layout preview
  // ======================================================================
  async function mountPdfPowerPointPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing slide structure…' + skeletonHtml(6) + '</div>';

    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (lpErr) { console.error('[LP_DEBUG] loadPdfJs failed (ocr):', lpErr); host.innerHTML = errorHtml('PDF renderer not available. Check your connection.'); return; }

    var pdf;
    try {
      var buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    } catch (lpErr) { console.error('[LP_DEBUG] getDocument failed (ocr):', lpErr); host.innerHTML = errorHtml('Could not parse this PDF. It may be corrupted or encrypted.'); return; }

    var numPages   = pdf.numPages;
    var prevPgs    = Math.min(numPages, 8);
    var totalChars = 0;
    var pageData   = [];

    // ── Analyse pages ─────────────────────────────────────────────────
    for (var pg = 1; pg <= prevPgs; pg++) {
      var page    = await pdf.getPage(pg);
      var vp      = page.getViewport({ scale: 1 });
      var content = await page.getTextContent();
      var items   = content.items.filter(function (it) { return it.str && it.str.trim(); });
      var pgText  = items.map(function (it) { return it.str; }).join(' ').trim();
      var chars   = pgText.replace(/\s/g, '').length;
      totalChars += chars;

      // Base font size
      var fSizes = items.map(function (it) { return Math.round(it.height || 0); }).filter(function (s) { return s > 0; });
      var fFreq  = {};
      fSizes.forEach(function (s) { fFreq[s] = (fFreq[s] || 0) + 1; });
      var baseFont = fSizes.length ? parseInt(Object.keys(fFreq).sort(function (a,b) { return fFreq[b]-fFreq[a]; })[0],10) || 11 : 11;
      var maxFont  = fSizes.length ? Math.max.apply(null, fSizes) : 0;

      // Column / table gaps
      var xVals = items.map(function (it) { return Math.round(it.transform[4]); });
      var xUniq = xVals.filter(function (v,i,a) { return a.indexOf(v)===i; }).sort(function (a,b) { return a-b; });
      var colGaps = 0;
      var pgW     = vp.width || 612;
      for (var xi = 1; xi < xUniq.length; xi++) {
        if (xUniq[xi] - xUniq[xi-1] > pgW * 0.09) colGaps++;
      }

      // Line count
      var yVals = items.map(function (it) { return Math.round(it.transform[5] / 5) * 5; });
      var yUniq = yVals.filter(function (v,i,a) { return a.indexOf(v)===i; });

      // Top line text (title candidate)
      var yMapT = {};
      items.forEach(function (it) {
        var y = Math.round(it.transform[5] / 5) * 5;
        if (!yMapT[y]) yMapT[y] = [];
        yMapT[y].push(it.str);
      });
      var topY    = Object.keys(yMapT).map(Number).sort(function (a,b) { return b-a; })[0];
      var topLine = topY !== undefined ? yMapT[topY].join(' ').trim() : '';

      // Classify slide type
      var type = 'content', conf = 70;
      if (pg === 1 && chars < 420 && (maxFont > baseFont * 1.35 || yUniq.length <= 5)) {
        type = 'title'; conf = 92;
      } else if (chars < 200 && maxFont > baseFont * 1.22 && yUniq.length <= 6) {
        type = 'section'; conf = 85;
      } else if (colGaps >= 3) {
        type = 'table'; conf = 83;
      } else if (chars < 55 && pg > 1) {
        type = 'image'; conf = 76;
      } else {
        conf = yUniq.length > 10 ? 88 : 72;
      }

      page.cleanup();
      pageData.push({ pg: pg, type: type, conf: conf, title: topLine.slice(0,56), chars: chars, colGaps: colGaps, lines: yUniq.length });
    }

    await pdf.destroy();

    var isScanned  = totalChars < 50;
    var tablePages = pageData.filter(function (p) { return p.type === 'table'; });
    var imagePages = pageData.filter(function (p) { return p.type === 'image'; });
    var qualScore  = isScanned ? 28 : Math.min(100, Math.round(
      (totalChars > 100 ? 32 : totalChars > 0 ? 14 : 0) +
      (pageData.some(function (p) { return p.type === 'title'; }) ? 14 : 0) +
      (pageData.some(function (p) { return p.type === 'section'; }) ? 14 : 0) +
      (numPages <= 50 ? 20 : 10) + 20
    ));

    var THEME_COLORS = {
      modern:    { bg: '#1e1b4b', title: '#ffffff', text: '#c7d2fe', accent: '#818cf8' },
      corporate: { bg: '#1e3a5f', title: '#ffffff', text: '#bfdbfe', accent: '#60a5fa' },
      minimal:   { bg: '#ffffff', title: '#0f172a', text: '#334155', accent: '#6366f1' },
      dark:      { bg: '#0f172a', title: '#f8fafc', text: '#94a3b8', accent: '#6366f1' },
      pitch:     { bg: '#0c0a09', title: '#ffffff', text: '#d6d3d1', accent: '#f59e0b' },
      white:     { bg: '#ffffff', title: '#111827', text: '#374151', accent: '#2563eb' },
    };
    var LAYOUT_AR = { '16x9': 16/9, '4x3': 4/3, 'wide': 2.0, 'a4': 297/210 };
    var TYPE_META = {
      title:   { label: 'Title',   col: '#4f46e5', bg: '#ede9fe' },
      section: { label: 'Section', col: '#0891b2', bg: '#e0f2fe' },
      content: { label: 'Content', col: '#059669', bg: '#d1fae5' },
      table:   { label: 'Table',   col: '#b45309', bg: '#fef3c7' },
      image:   { label: 'Image',   col: '#7c3aed', bg: '#f3e8ff' },
    };
    var state = { layout: '16x9', strategy: 'smart', theme: 'modern' };

    function makeSlideCard(pa, themeKey, layoutKey) {
      var tc  = THEME_COLORS[themeKey] || THEME_COLORS.modern;
      var ar  = LAYOUT_AR[layoutKey]  || 16/9;
      var W   = 162;
      var H   = Math.round(W / ar);
      var tm  = TYPE_META[pa.type] || TYPE_META.content;
      var titlePart = pa.title
        ? '<div class="lp-sc-title" style="color:' + tc.title + '">' + esc(pa.title.slice(0,36)) + '</div>' : '';
      var bodyPart  = pa.chars > 0 && pa.type !== 'image'
        ? '<div class="lp-sc-body">' +
            [0,1,2].map(function (_,i) {
              return '<div class="lp-sc-line" style="background:' + tc.accent + ';width:' + [82,66,74][i] + '%"></div>';
            }).join('') +
          '</div>'
        : (pa.type === 'image' ? '<div class="lp-sc-img" style="background:' + tc.accent + '">🖼</div>' : '');
      var tablePart = pa.type === 'table'
        ? '<div class="lp-sc-table"><div class="lp-sc-row" style="background:' + tc.accent + '"></div><div class="lp-sc-row"></div><div class="lp-sc-row"></div></div>'
        : '';
      return '<div class="lp-slide-card" style="width:' + W + 'px;height:' + H + 'px;background:' + tc.bg + '">' +
        '<div class="lp-sc-badge" style="background:' + tm.bg + ';color:' + tm.col + '">' + tm.label + ' <span class="lp-sc-conf">' + pa.conf + '%</span></div>' +
        '<div class="lp-sc-num">' + pa.pg + '</div>' +
        titlePart + bodyPart + tablePart +
        '<div class="lp-sc-accent-bar" style="background:' + tc.accent + '"></div>' +
      '</div>';
    }

    function renderGrid() {
      var el = host.querySelector('.lp-slide-grid');
      if (!el) return;
      el.innerHTML = pageData.map(function (pa) { return makeSlideCard(pa, state.theme, state.layout); }).join('');
      if (numPages > prevPgs) {
        el.innerHTML += '<div class="lp-sc-more">+' + (numPages - prevPgs) + ' more</div>';
      }
    }

    function updateEstSlides() {
      var el = host.querySelector('.lp-ppt-est');
      if (!el) return;
      var mult = state.strategy === 'spacious' ? 1.5 : state.strategy === 'minimal' ? 0.65 : 1;
      el.textContent = '~' + Math.max(numPages, Math.round(numPages * mult)) + ' slides';
    }

    host.innerHTML =
      '<div class="lp-panel lp-panel--pptx-from">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">Slide Structure Preview</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages !== 1 ? 's' : '') + '</span>' +
            '<span class="lp-stat lp-ppt-est"><b>~' + numPages + '</b> slides</span>' +
            (tablePages.length ? '<span class="lp-stat lp-stat--warn"><b>' + tablePages.length + '</b> table</span>' : '') +
            (imagePages.length ? '<span class="lp-stat"><b>' + imagePages.length + '</b> image</span>' : '') +
            (isScanned ? '<span class="lp-stat lp-stat--warn"><b>OCR</b></span>' : '') +
            qualityBadge(qualScore) +
          '</div>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Layout</span><div class="lp-ctrl-row">' +
              [['16x9','16:9'],['4x3','4:3'],['wide','Wide'],['a4','A4']].map(function (o) {
                return '<button type="button" class="lp-ctrl-btn' + (o[0]==='16x9'?' active':'') + '" data-pptlay="' + o[0] + '">' + o[1] + '</button>';
              }).join('') +
            '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Strategy</span><div class="lp-ctrl-row">' +
              [['smart','Smart'],['preserve','Preserve'],['minimal','Minimal'],['executive','Executive']].map(function (o) {
                return '<button type="button" class="lp-ctrl-btn' + (o[0]==='smart'?' active':'') + '" data-pptstr="' + o[0] + '">' + o[1] + '</button>';
              }).join('') +
            '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Theme</span><div class="lp-ctrl-row">' +
              [['modern','Modern'],['corporate','Corp.'],['minimal','Minimal'],['dark','Dark'],['pitch','Pitch'],['white','White']].map(function (o) {
                return '<button type="button" class="lp-ctrl-btn' + (o[0]==='modern'?' active':'') + '" data-pptthm="' + o[0] + '">' + o[1] + '</button>';
              }).join('') +
            '</div></div>' +
          '</div>' +
        '</div>' +
        (isScanned ? '<div class="lp-warn-banner"><span class="lp-warn-icon">⚠</span> Scanned PDF detected — OCR-enhanced mode will extract text before building slides</div>' : '') +
        (tablePages.length ? '<div class="lp-warn-banner"><span class="lp-warn-icon">📊</span> ' + tablePages.length + ' table slide' + (tablePages.length>1?'s':'') + ' detected — use "Table Handling" option for best quality</div>' : '') +
        '<div class="lp-ppt-legend">' +
          Object.keys(TYPE_META).map(function (k) {
            var tm = TYPE_META[k];
            return '<span class="lp-legend-pill" style="background:' + tm.bg + ';color:' + tm.col + '">' + tm.label + '</span>';
          }).join('') +
        '</div>' +
        '<div class="lp-scroll lp-scroll--grid"><div class="lp-slide-grid"></div></div>' +
        '<div class="lp-footer">' + prevPgs + ' of ' + numPages + ' pages analysed · type badges show slide classification confidence · theme controls mirror output colors</div>' +
      '</div>';

    // ── Wire controls ────────────────────────────────────────────────
    host.querySelectorAll('[data-pptlay]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.layout = b.dataset.pptlay;
        host.querySelectorAll('[data-pptlay]').forEach(function (x) { x.classList.toggle('active', x.dataset.pptlay === state.layout); });
        var el = document.getElementById('opt-layout'); if (el) el.value = state.layout;
        renderGrid();
      });
    });
    host.querySelectorAll('[data-pptstr]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.strategy = b.dataset.pptstr;
        host.querySelectorAll('[data-pptstr]').forEach(function (x) { x.classList.toggle('active', x.dataset.pptstr === state.strategy); });
        var el = document.getElementById('opt-contentStrategy'); if (el) el.value = state.strategy;
        updateEstSlides();
      });
    });
    host.querySelectorAll('[data-pptthm]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.theme = b.dataset.pptthm;
        host.querySelectorAll('[data-pptthm]').forEach(function (x) { x.classList.toggle('active', x.dataset.pptthm === state.theme); });
        var el = document.getElementById('opt-theme'); if (el) el.value = state.theme;
        renderGrid();
      });
    });

    renderGrid();
    updateEstSlides();
  }

  // ======================================================================
  // POWERPOINT → PDF  v6.0
  // Slide grid, handout modes, font warnings, overflow detection, notes
  // ======================================================================
  async function mountPowerPointPdfPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Parsing presentation…' + skeletonHtml(5) + '</div>';

    var JSZip;
    try { JSZip = await loadJsZip(); }
    catch (_) { host.innerHTML = errorHtml('Could not load presentation parser. Check your connection.'); return; }

    var zip;
    try {
      var ab = await file.arrayBuffer();
      zip = await JSZip.loadAsync(ab);
    } catch (_) { host.innerHTML = errorHtml('Could not parse this file. Please use a valid .pptx file.'); return; }

    var slideNames = Object.keys(zip.files)
      .filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
      .sort(function (a, b) {
        var na = parseInt((a.match(/\d+/)||['0'])[0],10);
        var nb = parseInt((b.match(/\d+/)||['0'])[0],10);
        return na - nb;
      });

    if (!slideNames.length) { host.innerHTML = errorHtml('No slides found. Is this a valid .pptx file?'); return; }

    var slides   = [];
    var allFonts = [];
    var SAFE_FONTS = ['calibri','arial','helvetica','times new roman','georgia','trebuchet ms','verdana','tahoma','courier new','sans-serif','serif','monospace'];

    for (var si = 0; si < slideNames.length; si++) {
      var xml   = await zip.files[slideNames[si]].async('text');
      var allT  = [];
      var tRe   = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      var tM;
      while ((tM = tRe.exec(xml)) !== null) {
        var tv = tM[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&apos;/g,"'").replace(/&quot;/g,'"').trim();
        if (tv) allT.push(tv);
      }
      // Title heuristic
      var isTitle = /<p:ph[^>]*type=["'](title|ctrTitle)["']/.test(xml) || (allT.length <= 2 && allT[0] && allT[0].length < 80);
      // Fonts
      var fRe = /typeface=["']([^"']+)["']/g;
      var fM;
      while ((fM = fRe.exec(xml)) !== null) {
        var fn = fM[1];
        if (fn && fn[0] !== '+' && allFonts.indexOf(fn.toLowerCase()) < 0) allFonts.push(fn.toLowerCase());
      }
      slides.push({ num: si+1, isTitle: isTitle, texts: allT, chars: allT.join(' ').length, notes: null });
    }

    // Notes
    var noteFiles = Object.keys(zip.files)
      .filter(function (n) { return /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n); })
      .sort(function (a, b) { return parseInt((a.match(/\d+/)||['0'])[0],10) - parseInt((b.match(/\d+/)||['0'])[0],10); });

    for (var ni = 0; ni < noteFiles.length; ni++) {
      var nxml = await zip.files[noteFiles[ni]].async('text');
      var nT   = [];
      var nRe  = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      var nM;
      while ((nM = nRe.exec(nxml)) !== null) {
        var nv = nM[1].replace(/&amp;/g,'&').trim();
        if (nv && nv.length > 2) nT.push(nv);
      }
      if (slides[ni] && nT.length) slides[ni].notes = nT.join(' ').slice(0, 90);
    }

    var totalSlides    = slides.length;
    var notesCount     = slides.filter(function (s) { return s.notes; }).length;
    var overflowSlides = slides.filter(function (s) { return s.chars > 750; });
    var nonSafe        = allFonts.filter(function (f) { return SAFE_FONTS.indexOf(f) < 0; });
    var qualScore      = Math.min(100, Math.round(
      (totalSlides > 0 ? 28 : 0) +
      (totalSlides > 5 ? 20 : totalSlides * 4) +
      (nonSafe.length === 0 ? 20 : 10) +
      (overflowSlides.length === 0 ? 22 : 12) + 10
    ));

    var state = { size: 'presentation', handout: '1', notesMode: 'ignore', watermark: 'none' };

    var WM_LABELS = { none: '', confidential: 'CONFIDENTIAL', draft: 'DRAFT', 'do-not-copy': 'DO NOT COPY' };

    function makeSlideCard(slide, showNotes, wmLabel) {
      var overflow = slide.chars > 750;
      var titleStr = slide.isTitle && slide.texts[0] ? slide.texts[0] : '';
      var bodyTexts = slide.texts.slice(slide.isTitle ? 1 : 0, 4);
      return '<div class="lp-pptpdf-card' + (overflow ? ' lp-pptpdf-card--ov' : '') + '">' +
        (wmLabel ? '<div class="lp-pptpdf-wm">' + esc(wmLabel) + '</div>' : '') +
        '<div class="lp-pptpdf-inner">' +
          (titleStr ? '<div class="lp-pptpdf-title">' + esc(titleStr.slice(0,44)) + '</div>'
                    : '<div class="lp-pptpdf-title lp-pptpdf-title--empty">Slide ' + slide.num + '</div>') +
          (bodyTexts.length ? '<div class="lp-pptpdf-body">' + bodyTexts.map(function (t) { return '<div>' + esc(t.slice(0,52)) + '</div>'; }).join('') + '</div>' : '') +
        '</div>' +
        (overflow ? '<div class="lp-pptpdf-ov-badge">⚠</div>' : '') +
        (showNotes && slide.notes ? '<div class="lp-pptpdf-notes">' + esc(slide.notes.slice(0,55)) + '</div>' : '') +
        '<div class="lp-pptpdf-num">' + slide.num + '</div>' +
      '</div>';
    }

    function renderSlideGrid() {
      var el = host.querySelector('.lp-pptpdf-grid');
      if (!el) return;
      var cols = { '1':1, '2':1, '4':2, '6':3 }[state.handout] || 1;
      el.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
      var showNotes = state.notesMode !== 'ignore' && notesCount > 0;
      var wm = WM_LABELS[state.watermark] || '';
      el.innerHTML = slides.map(function (s) { return makeSlideCard(s, showNotes, wm); }).join('');
    }

    function updatePageCount() {
      var el = host.querySelector('.lp-pptpdf-pgcount');
      if (!el) return;
      var perPage = parseInt(state.handout, 10) || 1;
      var pgCount = Math.ceil(totalSlides / perPage);
      if (state.notesMode === 'append') pgCount += notesCount;
      el.textContent = '~' + pgCount + ' page' + (pgCount !== 1 ? 's' : '');
    }

    var fontWarnHtml = nonSafe.length
      ? '<div class="lp-warn-banner"><span class="lp-warn-icon">🔤</span> Non-standard fonts: ' +
          nonSafe.slice(0,4).map(function (f) { return '<b>' + esc(f) + '</b>'; }).join(', ') +
          (nonSafe.length > 4 ? ' +' + (nonSafe.length - 4) + ' more' : '') + ' — may substitute in PDF</div>'
      : '';
    var ovWarnHtml = overflowSlides.length
      ? '<div class="lp-warn-banner"><span class="lp-warn-icon">📐</span> ' + overflowSlides.length + ' slide' + (overflowSlides.length>1?'s':'') + ' may have overflow in PDF output</div>'
      : '';

    host.innerHTML =
      '<div class="lp-panel lp-panel--pptx-to">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">Presentation Export Preview</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + totalSlides + '</b> slide' + (totalSlides!==1?'s':'') + '</span>' +
            '<span class="lp-stat lp-pptpdf-pgcount"><b>~' + totalSlides + '</b> pages</span>' +
            (notesCount ? '<span class="lp-stat"><b>' + notesCount + '</b> notes</span>' : '') +
            (nonSafe.length ? '<span class="lp-stat lp-stat--warn"><b>' + nonSafe.length + '</b> font' + (nonSafe.length>1?'s':'') + '</span>' : '') +
            (overflowSlides.length ? '<span class="lp-stat lp-stat--warn"><b>' + overflowSlides.length + '</b> overflow</span>' : '') +
            qualityBadge(qualScore) +
          '</div>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page size</span><div class="lp-ctrl-row">' +
              [['presentation','16:9'],['A4','A4'],['Letter','Letter'],['Legal','Legal'],['Tabloid','Tabloid']].map(function (o) {
                return '<button type="button" class="lp-ctrl-btn' + (o[0]==='presentation'?' active':'') + '" data-pdfsize="' + o[0] + '">' + o[1] + '</button>';
              }).join('') +
            '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Handout</span><div class="lp-ctrl-row">' +
              [['1','1/pg'],['2','2/pg'],['4','4/pg'],['6','6/pg']].map(function (o) {
                return '<button type="button" class="lp-ctrl-btn' + (o[0]==='1'?' active':'') + '" data-handout="' + o[0] + '">' + o[1] + '</button>';
              }).join('') +
            '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Notes</span><div class="lp-ctrl-row">' +
              [['ignore','None'],['append','Append'],['below','Below']].map(function (o) {
                return '<button type="button" class="lp-ctrl-btn' + (o[0]==='ignore'?' active':'') + '" data-notesm="' + o[0] + '">' + o[1] + '</button>';
              }).join('') +
            '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Watermark</span><div class="lp-ctrl-row">' +
              [['none','None'],['confidential','Confidential'],['draft','Draft'],['do-not-copy','Do Not Copy']].map(function (o) {
                return '<button type="button" class="lp-ctrl-btn' + (o[0]==='none'?' active':'') + '" data-wm="' + o[0] + '">' + o[1] + '</button>';
              }).join('') +
            '</div></div>' +
          '</div>' +
        '</div>' +
        (fontWarnHtml || ovWarnHtml ? '<div class="lp-warn-stack">' + fontWarnHtml + ovWarnHtml + '</div>' : '') +
        '<div class="lp-scroll lp-scroll--grid"><div class="lp-pptpdf-grid"></div></div>' +
        '<div class="lp-footer">Slide grid reflects actual content · orange border = overflow risk · handout mode mirrors PDF layout · notes shown when enabled</div>' +
      '</div>';

    // ── Wire controls ────────────────────────────────────────────────
    host.querySelectorAll('[data-pdfsize]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.size = b.dataset.pdfsize;
        host.querySelectorAll('[data-pdfsize]').forEach(function (x) { x.classList.toggle('active', x.dataset.pdfsize === state.size); });
        var el = document.getElementById('opt-pageSize'); if (el) el.value = state.size;
        updatePageCount();
      });
    });
    host.querySelectorAll('[data-handout]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.handout = b.dataset.handout;
        host.querySelectorAll('[data-handout]').forEach(function (x) { x.classList.toggle('active', x.dataset.handout === state.handout); });
        var el = document.getElementById('opt-handoutMode'); if (el) el.value = state.handout;
        renderSlideGrid(); updatePageCount();
      });
    });
    host.querySelectorAll('[data-notesm]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.notesMode = b.dataset.notesm;
        host.querySelectorAll('[data-notesm]').forEach(function (x) { x.classList.toggle('active', x.dataset.notesm === state.notesMode); });
        var el = document.getElementById('opt-speakerNotes'); if (el) el.value = state.notesMode;
        renderSlideGrid(); updatePageCount();
      });
    });
    host.querySelectorAll('[data-wm]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.watermark = b.dataset.wm;
        host.querySelectorAll('[data-wm]').forEach(function (x) { x.classList.toggle('active', x.dataset.wm === state.watermark); });
        var el = document.getElementById('opt-watermark'); if (el) el.value = state.watermark;
        renderSlideGrid();
      });
    });

    renderSlideGrid();
    updatePageCount();
  }

  // ======================================================================
  // HTML → PDF PRO MAX PREVIEW  (.lp-html-*)
  // Renders the HTML in an isolated iframe showing real CSS/layout.
  // Controls: Page Size, Orientation, Margins, Zoom — all sync with opts.
  // ======================================================================
  async function mountHtmlToPdfPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Loading HTML preview\u2026' + skeletonHtml(4) + '</div>';

    var text;
    try { text = await file.text(); }
    catch (_) { host.innerHTML = errorHtml('Could not read HTML file.'); return; }
    if (!text.trim()) { host.innerHTML = errorHtml('HTML file appears empty.'); return; }

    // Analyse for stats and warnings
    var parser    = new DOMParser();
    var inputDoc  = parser.parseFromString(text, 'text/html');
    var bodyText  = inputDoc.body ? inputDoc.body.innerText : text;
    var wc        = (bodyText.match(/\b\w+\b/g) || []).length;
    var tableCount = (text.match(/<table/gi) || []).length;
    var imgCount   = (text.match(/<img/gi)   || []).length;
    var hasCustomFonts = /font-family\s*:/i.test(text);
    var hasGridFlex    = /display\s*:\s*(grid|flex)/i.test(text);
    var hasExternalCSS = /<link[^>]+stylesheet/i.test(text);

    var warnings = [];
    if (tableCount > 0)    warnings.push({ icon: '\uD83D\uDCB3', msg: tableCount + ' table' + (tableCount > 1 ? 's' : '') + ' detected \u2014 may reflow across pages' });
    if (imgCount > 5)      warnings.push({ icon: '\uD83D\uDDBC', msg: imgCount + ' images \u2014 ensure they use accessible URLs' });
    if (hasCustomFonts)    warnings.push({ icon: '\uD83D\uDD24', msg: 'Custom fonts may fall back to system fonts in PDF' });
    if (hasGridFlex)       warnings.push({ icon: '\uD83D\uDCE6', msg: 'CSS Grid/Flexbox may render differently in print' });
    if (hasExternalCSS)    warnings.push({ icon: '\uD83D\uDD17', msg: 'External stylesheets loaded \u2014 cross-origin sheets may be blocked' });

    var qualScore = Math.max(25, 100 - warnings.length * 15);

    // Page-size constants (mm)
    var PS_W = { A4: 210, Letter: 216, A3: 297, A5: 148, Legal: 216, Tabloid: 279 };
    var PS_H = { A4: 297, Letter: 279, A3: 420, A5: 210, Legal: 356, Tabloid: 432 };

    function pxFromMm(mm) { return mm * 96 / 25.4 * 0.62; }

    var state = { size: 'A4', orient: 'portrait', zoom: 'fit', margins: 'normal' };
    var MARGIN_MM = { none: 0, narrow: 5, normal: 10, wide: 20 };

    // Extract all inline styles + cross-origin-safe external links
    var headStyles = Array.from(inputDoc.querySelectorAll('style')).map(function (s) { return s.outerHTML; }).join('');
    var linkStyles = Array.from(inputDoc.querySelectorAll('link[rel="stylesheet"][href]'))
      .filter(function (l) { return /^https?:\/\//i.test(l.getAttribute('href') || ''); })
      .map(function (l) { return l.outerHTML; }).join('');
    var bodyHtml   = inputDoc.body ? inputDoc.body.innerHTML : text;

    function buildIframeDoc() {
      var mPx = pxFromMm(MARGIN_MM[state.margins] !== undefined ? MARGIN_MM[state.margins] : 10);
      return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        linkStyles + headStyles +
        '<style>' +
        '*{box-sizing:border-box;}' +
        'body{margin:' + mPx + 'px;font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.55;color:#111;word-wrap:break-word;}' +
        'img{max-width:100%;height:auto;}table{max-width:100%;border-collapse:collapse;}' +
        'pre,code{white-space:pre-wrap;word-break:break-all;}svg{max-width:100%;}' +
        'h1,h2,h3{page-break-after:avoid;}table,figure,img{page-break-inside:avoid;}' +
        '</style>' +
        '</head><body>' + bodyHtml + '</body></html>';
    }

    function applyIframe() {
      var wMm = state.orient === 'landscape' ? (PS_H[state.size] || 297) : (PS_W[state.size] || 210);
      var hMm = state.orient === 'landscape' ? (PS_W[state.size] || 210) : (PS_H[state.size] || 297);
      var wPx = pxFromMm(wMm);
      var hPx = pxFromMm(hMm);

      var iframe = host.querySelector('.lp-html-iframe');
      var wrap   = host.querySelector('.lp-html-page-wrap');
      if (!iframe || !wrap) return;

      iframe.srcdoc = buildIframeDoc();
      iframe.style.width  = wPx + 'px';
      iframe.style.height = hPx + 'px';

      var availW = wrap.offsetWidth || 600;
      var scl    = 1;
      if (state.zoom === 'fit' && wPx > availW - 24) scl = (availW - 24) / wPx;
      else if (state.zoom === '75')  scl = 0.75;
      else if (state.zoom === '50')  scl = 0.5;
      iframe.style.transform       = scl < 1 ? 'scale(' + scl.toFixed(3) + ')' : 'none';
      iframe.style.transformOrigin = 'top left';
      wrap.style.height            = Math.round(hPx * scl + 8) + 'px';
    }

    var warnHtml = warnings.map(function (w) {
      return '<div class="lp-warn-banner"><span class="lp-warn-icon">' + w.icon + '</span> ' + esc(w.msg) + '</div>';
    }).join('');

    host.innerHTML =
      '<div class="lp-panel lp-panel--html-pdf">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>' +
            ' HTML Preview' +
          '</span>' +
          '<div class="lp-header-stats">' +
            (wc ? '<span class="lp-stat"><b>' + fmtNum(wc) + '</b> words</span>' : '') +
            (tableCount ? '<span class="lp-stat"><b>' + tableCount + '</b> table' + (tableCount > 1 ? 's' : '') + '</span>' : '') +
            (imgCount   ? '<span class="lp-stat"><b>' + imgCount   + '</b> image' + (imgCount   > 1 ? 's' : '') + '</span>' : '') +
            qualityBadge(qualScore) +
          '</div>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page</span>' +
              '<div class="lp-ctrl-row">' + pageSizeBtns(state.size, ['A3', 'A5', 'Legal', 'Tabloid']) + '</div>' +
            '</div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Orientation</span>' +
              '<div class="lp-ctrl-row">' + orientBtns(state.orient) + '</div>' +
            '</div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Margins</span>' +
              '<div class="lp-ctrl-row">' +
                ['none', 'narrow', 'normal', 'wide'].map(function (m) {
                  return '<button type="button" class="lp-ctrl-btn' + (m === state.margins ? ' active' : '') +
                    '" data-margin="' + m + '">' + (m.charAt(0).toUpperCase() + m.slice(1)) + '</button>';
                }).join('') +
              '</div>' +
            '</div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Zoom</span>' +
              '<div class="lp-ctrl-row">' +
                ['fit', '75', '50'].map(function (z) {
                  return '<button type="button" class="lp-ctrl-btn' + (z === state.zoom ? ' active' : '') +
                    '" data-zoom="' + z + '">' + (z === 'fit' ? 'Fit' : z + '%') + '</button>';
                }).join('') +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        (warnHtml ? '<div class="lp-warn-stack">' + warnHtml + '</div>' : '') +
        '<div class="lp-scroll lp-scroll--page">' +
          '<div class="lp-page-wrap lp-page-wrap--print lp-html-page-wrap" style="overflow:hidden;">' +
            '<iframe class="lp-html-iframe" sandbox="allow-same-origin allow-scripts" ' +
              'style="border:0;display:block;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,0.14);transform-origin:top left;">' +
            '</iframe>' +
          '</div>' +
        '</div>' +
        '<div class="lp-footer">Live HTML preview \xb7 page boundaries shown \xb7 actual PDF may vary slightly</div>' +
      '</div>';

    // Wire page-size + orientation buttons (existing helpers)
    wireCtrlSync(host, state);
    state.onchange = function () {
      var ps = document.getElementById('opt-pageSize');    if (ps) ps.value = state.size.toLowerCase();
      var or = document.getElementById('opt-orientation'); if (or) or.value = state.orient;
      requestAnimationFrame(applyIframe);
    };

    // Wire margin buttons
    host.querySelectorAll('[data-margin]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.margins = b.dataset.margin;
        host.querySelectorAll('[data-margin]').forEach(function (x) {
          x.classList.toggle('active', x.dataset.margin === state.margins);
        });
        var el = document.getElementById('opt-margins'); if (el) el.value = state.margins;
        requestAnimationFrame(applyIframe);
      });
    });

    // Wire zoom buttons
    host.querySelectorAll('[data-zoom]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.zoom = b.dataset.zoom;
        host.querySelectorAll('[data-zoom]').forEach(function (x) {
          x.classList.toggle('active', x.dataset.zoom === state.zoom);
        });
        requestAnimationFrame(applyIframe);
      });
    });

    // Initial render after layout settles
    requestAnimationFrame(function () { setTimeout(applyIframe, 80); });
  }

  // ======================================================================
  // OCR PRO MAX PREVIEW  (.lp-ocr-*)
  // Split view: original page (pdfjs canvas) left, extracted text right.
  // Shows scan quality, language hint, page count, confidence estimate.
  // ======================================================================
  async function mountOcrPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analyzing PDF\u2026' + skeletonHtml(4) + '</div>';

    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (_) { host.innerHTML = errorHtml('Could not load PDF renderer. Check your connection.'); return; }

    var buf, pdf;
    try {
      buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    } catch (_) { host.innerHTML = errorHtml('Could not open this PDF. Is it a valid PDF file?'); return; }

    var numPages = pdf.numPages;

    // Render page 1 at moderate scale for preview
    var page, viewport, canvas, ctx;
    try {
      page     = await pdf.getPage(1);
      viewport = page.getViewport({ scale: 1.5 });
      canvas   = document.createElement('canvas');
      canvas.width  = Math.min(Math.floor(viewport.width),  1600);
      canvas.height = Math.min(Math.floor(viewport.height), 2200);
      ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (_) {
      host.innerHTML = errorHtml('Could not render PDF page.', function () { mountOcrPreview(file, host); });
      await pdf.destroy();
      return;
    }

    // Extract digital text from page 1 for preview
    var content     = await page.getTextContent();
    var digitalText = content.items.map(function (it) { return it.str; }).join(' ').trim();
    var hasDigital  = digitalText.replace(/\s/g, '').length >= 30;
    var digitalWc   = (digitalText.match(/\b\w+\b/g) || []).length;
    page.cleanup();
    await pdf.destroy();

    // Language hint from digital text
    var langHint = detectLanguage(digitalText);

    // Scan quality estimate
    var isScanned  = !hasDigital;
    var qualScore  = isScanned ? 55 : 90;
    var qualLabel  = isScanned ? 'OCR Required' : 'Text Ready';
    var statusMsg  = isScanned
      ? '\u26A0\uFE0F Image-based PDF detected \u2014 AI OCR Engine will extract text when you click Process'
      : '\u2713 Selectable text found \u2014 AI OCR Engine will enhance and reconstruct layout';

    // Estimate digital text statistics for the indicators panel
    var digitalLines    = digitalText ? digitalText.split('\n').filter(function (l) { return l.trim(); }).length : 0;
    var estTables       = (digitalText.match(/\t{2,}|[ ]{4,}/g) || []).length > 2 ? 1 : 0;
    var estHeadings     = (digitalText.match(/\n[A-Z][A-Z ]{3,}\n/g) || []).length;

    // Convert canvas to data URL, then free
    var thumbUrl = canvas.toDataURL('image/jpeg', 0.82);
    canvas.width = 0; canvas.height = 0;

    // Confidence meter bar (visual estimate before real OCR runs)
    var confEst     = isScanned ? 65 : 92;
    var confColor   = confEst >= 80 ? '#22c55e' : confEst >= 60 ? '#f59e0b' : '#ef4444';
    var confMeterHtml =
      '<div class="lp-conf-meter-wrap">' +
        '<div class="lp-conf-meter-label">Estimated quality</div>' +
        '<div class="lp-conf-meter-bar">' +
          '<div class="lp-conf-meter-fill" style="width:' + confEst + '%;background:' + confColor + '"></div>' +
        '</div>' +
        '<div class="lp-conf-meter-pct">' + confEst + '%</div>' +
      '</div>';

    // Feature badges row
    var featureBadges =
      '<div class="lp-ocr-badges">' +
        '<span class="lp-ocr-badge lp-ocr-badge--active">\u2728 Enhanced automatically</span>' +
        (isScanned ? '<span class="lp-ocr-badge lp-ocr-badge--active">\uD83E\uDD16 Deep OCR active</span>' : '') +
        (estTables > 0 ? '<span class="lp-ocr-badge">\uD83D\uDCCA Table reconstruction enabled</span>' : '') +
        (langHint ? '<span class="lp-ocr-badge">' + langHint.flag + ' ' + esc(langHint.label) + ' detected</span>' : '') +
      '</div>';

    host.innerHTML =
      '<div class="lp-panel lp-panel--ocr">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
              '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>' +
              '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
              '<line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>' +
            '</svg>' +
            ' OCR Analysis' +
          '</span>' +
          '<div class="lp-header-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages > 1 ? 's' : '') + '</span>' +
            (digitalWc > 0 ? '<span class="lp-stat"><b>' + fmtNum(digitalWc) + '</b> words</span>' : '') +
            (estHeadings > 0 ? '<span class="lp-stat"><b>' + estHeadings + '</b> heading' + (estHeadings > 1 ? 's' : '') + '</span>' : '') +
            qualityBadge(qualScore) +
          '</div>' +
        '</div>' +
        '<div class="lp-warn-stack">' +
          '<div class="lp-warn-banner lp-ocr-status-banner">' + esc(statusMsg) + '</div>' +
        '</div>' +
        featureBadges +
        confMeterHtml +
        '<div class="lp-scroll lp-scroll--wide">' +
          '<div class="lp-ocr-split">' +
            '<div class="lp-ocr-col">' +
              '<div class="lp-split-label">Original \u2014 Page 1 of ' + numPages + '</div>' +
              '<img class="lp-ocr-orig-img" src="' + thumbUrl + '" alt="PDF page 1 preview">' +
            '</div>' +
            '<div class="lp-ocr-col">' +
              '<div class="lp-split-label">Text Extraction Preview</div>' +
              '<div class="lp-ocr-text-preview">' +
                (hasDigital
                  ? '<div class="lp-ocr-text-content">' + esc(digitalText.slice(0, 900)) + (digitalText.length > 900 ? '\u2026' : '') + '</div>'
                  : '<div class="lp-ocr-text-placeholder">' +
                      '<div class="lp-ocr-scan-icon">\uD83D\uDD0D</div>' +
                      '<div><strong>AI OCR Engine</strong> will extract text when you click <strong>Process</strong></div>' +
                      '<div class="lp-ocr-hint">Adjust OCR Mode, Language and Output Format below to control result quality.</div>' +
                    '</div>'
                ) +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="lp-footer">' +
          'Scan analysis \xb7 ' +
          (isScanned ? 'image-based PDF \u2014 AI OCR Engine active' : 'text-based PDF \u2014 fast extraction mode') +
          ' \xb7 all ' + numPages + ' page' + (numPages > 1 ? 's' : '') + ' will be processed' +
        '</div>' +
      '</div>';
  }

  // ── SCAN PDF PRO MAX PREVIEW ──────────────────────────────────────────────
  // Shows before/after enhancement comparison from the first uploaded image,
  // plus resolution, DPI estimate, document-type badge, quality score.
  async function mountScanPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analyzing image\u2026' + skeletonHtml(3) + '</div>';
    var url = URL.createObjectURL(file);
    var img = new Image();
    try {
      await new Promise(function (resolve, reject) { img.onload = resolve; img.onerror = reject; img.src = url; });
    } catch (_) {
      URL.revokeObjectURL(url);
      host.innerHTML = errorHtml('Could not load this image file.');
      return;
    }
    URL.revokeObjectURL(url);

    var W = img.naturalWidth, H = img.naturalHeight;
    var isLandscape = W > H;
    var mp    = Math.round(W * H / 1e5) / 10;
    var dpiEst = W > 2480 ? '~300' : W > 1654 ? '~200' : '~150';
    var qualScore = Math.min(100, Math.max(20, Math.round(mp * 12)));
    var docType   = isLandscape ? 'Landscape document' : mp > 4 ? 'High-res scan' : 'Standard scan';

    var PREV_W = Math.min(W, 480);
    var scale  = PREV_W / W;
    var PW = Math.round(W * scale), PH = Math.round(H * scale);

    var canvas = document.createElement('canvas');
    canvas.width = PW; canvas.height = PH;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PW, PH);
    ctx.drawImage(img, 0, 0, PW, PH);
    var origUrl = canvas.toDataURL('image/jpeg', 0.82);

    // Enhancement preview: grayscale + auto-level + 1.5× contrast curve
    var id = ctx.getImageData(0, 0, PW, PH);
    var d = id.data, N = d.length;
    var minV = 255, maxV = 0, g;
    for (var px = 0; px < N; px += 4) {
      g = Math.round(0.299 * d[px] + 0.587 * d[px + 1] + 0.114 * d[px + 2]);
      d[px] = d[px + 1] = d[px + 2] = g;
      if (g < minV) minV = g; if (g > maxV) maxV = g;
    }
    var rng = Math.max(1, maxV - minV), v;
    for (var px = 0; px < N; px += 4) {
      v = Math.round((d[px] - minV) * 255 / rng);
      v = Math.min(255, Math.max(0, Math.round((v - 128) * 1.5 + 128)));
      d[px] = d[px + 1] = d[px + 2] = v;
    }
    ctx.putImageData(id, 0, 0);
    var enhUrl = canvas.toDataURL('image/jpeg', 0.82);
    canvas.width = 0; canvas.height = 0;

    host.innerHTML =
      '<div class="lp-panel lp-panel--scan">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>' +
            ' Scan Analysis' +
          '</span>' +
          '<div class="lp-header-stats">' +
            '<span class="lp-stat"><b>' + W + '\xd7' + H + '</b> px</span>' +
            '<span class="lp-stat"><b>' + dpiEst + '</b> DPI</span>' +
            '<span class="lp-stat"><b>' + mp + '</b> MP</span>' +
            qualityBadge(qualScore) +
          '</div>' +
        '</div>' +
        '<div class="lp-scan-badges">' +
          '<span class="lp-scan-badge lp-scan-badge--active">\u2728 Auto enhancement ready</span>' +
          '<span class="lp-scan-badge lp-scan-badge--active">\uD83E\uDD16 AI OCR Engine enabled</span>' +
          '<span class="lp-scan-badge">\uD83D\uDCCB ' + esc(docType) + '</span>' +
          (mp > 4 ? '<span class="lp-scan-badge">\uD83D\uDD0D High-res scan detected</span>' : '') +
        '</div>' +
        '<div class="lp-scan-compare">' +
          '<div class="lp-scan-col">' +
            '<div class="lp-split-label">Original</div>' +
            '<img class="lp-scan-img" src="' + origUrl + '" alt="Original scan">' +
          '</div>' +
          '<div class="lp-scan-col">' +
            '<div class="lp-split-label">Enhanced preview</div>' +
            '<img class="lp-scan-img" src="' + enhUrl + '" alt="Enhanced preview">' +
          '</div>' +
        '</div>' +
        '<div class="lp-footer">' +
          'Image analysis \xb7 ' + (isLandscape ? 'Landscape' : 'Portrait') + ' \xb7 ' + mp + ' megapixels \xb7 ready to scan' +
        '</div>' +
      '</div>';
  }

  // ── REPAIR PDF PRO MAX PREVIEW ────────────────────────────────────────────
  // Loads the PDF with pdfjs, probes renderable pages, shows corruption
  // severity meter, repair confidence bar, and a page-1 thumbnail when readable.
  async function mountRepairPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analyzing PDF\u2026' + skeletonHtml(4) + '</div>';
    var pdfjsLib;
    try { pdfjsLib = await loadPdfJs(); }
    catch (_) { host.innerHTML = errorHtml('Could not load PDF renderer. Check your connection.'); return; }

    var pdf = null, numPages = 0, loadFailed = false;
    try {
      var buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      numPages = pdf.numPages;
    } catch (_) { loadFailed = true; }

    var thumbUrl = null, renderableCount = 0;
    if (pdf) {
      var checkCount = Math.min(numPages, 3);
      for (var i = 1; i <= checkCount; i++) {
        try {
          var page = await pdf.getPage(i);
          var vp   = page.getViewport({ scale: 0.8 });
          var c    = document.createElement('canvas');
          c.width  = Math.min(Math.floor(vp.width),  480);
          c.height = Math.min(Math.floor(vp.height), 680);
          var cx   = c.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: cx, viewport: vp }).promise;
          if (i === 1) thumbUrl = c.toDataURL('image/jpeg', 0.82);
          c.width = 0; c.height = 0;
          renderableCount++;
          page.cleanup();
        } catch (_) {}
      }
      await pdf.destroy();
    }

    var fileSizeKB  = Math.round(file.size / 1024);
    var fileSizeFmt = fileSizeKB > 1024 ? (fileSizeKB / 1024).toFixed(1) + ' MB' : fileSizeKB + ' KB';
    var checked     = Math.min(numPages || 0, 3);
    var damagePct   = loadFailed ? 100 : (checked > 0 ? Math.round((1 - renderableCount / checked) * 100) : 0);
    var severity    = loadFailed ? 'Severe' : damagePct > 50 ? 'Moderate' : damagePct > 0 ? 'Minor' : 'None detected';
    var sevColor    = loadFailed ? '#ef4444' : damagePct > 50 ? '#f59e0b' : damagePct > 0 ? '#eab308' : '#22c55e';
    var repairConf  = loadFailed ? 42 : damagePct > 50 ? 62 : damagePct > 0 ? 80 : 96;
    var confColor   = repairConf >= 80 ? '#22c55e' : repairConf >= 60 ? '#f59e0b' : '#ef4444';

    host.innerHTML =
      '<div class="lp-panel lp-panel--repair">' +
        '<div class="lp-header lp-header--sticky">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>' +
            ' Repair Analysis' +
          '</span>' +
          '<div class="lp-header-stats">' +
            (numPages > 0 ? '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages > 1 ? 's' : '') + '</span>' : '') +
            '<span class="lp-stat"><b>' + fileSizeFmt + '</b></span>' +
            qualityBadge(repairConf) +
          '</div>' +
        '</div>' +
        '<div class="lp-repair-analysis">' +
          '<div class="lp-repair-row">' +
            '<span class="lp-repair-label">Damage severity</span>' +
            '<span class="lp-repair-val" style="color:' + sevColor + ';font-weight:700">' + severity + '</span>' +
          '</div>' +
          '<div class="lp-repair-row">' +
            '<span class="lp-repair-label">Pages readable</span>' +
            '<span class="lp-repair-val">' + renderableCount + ' of ' + (numPages || '?') + ' checked</span>' +
          '</div>' +
          '<div class="lp-repair-row">' +
            '<span class="lp-repair-label">Repair confidence</span>' +
            '<span class="lp-repair-val" style="color:' + confColor + ';font-weight:700">' + repairConf + '%</span>' +
          '</div>' +
          '<div class="lp-repair-conf-bar">' +
            '<div class="lp-repair-conf-fill" style="width:' + repairConf + '%;background:' + confColor + '"></div>' +
          '</div>' +
        '</div>' +
        (thumbUrl
          ? '<div class="lp-repair-thumb-wrap"><div class="lp-split-label">Recoverable content preview</div><img class="lp-repair-thumb" src="' + thumbUrl + '" alt="Page 1 preview"></div>'
          : '<div class="lp-repair-no-preview"><div class="lp-ocr-scan-icon">\uD83D\uDD27</div>' +
              '<div>' + (loadFailed
                ? 'File structure severely damaged \u2014 repair will attempt deep recovery'
                : 'PDF structure has minor damage \u2014 standard repair recommended') +
              '</div>' +
            '</div>'
        ) +
        '<div class="lp-footer">' +
          'Structural analysis \xb7 ' + severity + ' damage detected \xb7 ' + repairConf + '% estimated recovery success' +
        '</div>' +
      '</div>';
  }

  // ======================================================================
  // WORD → EXCEL  (v1.0 — mammoth parse → grid table preview)
  // Shows parsed tables as interactive grid with sheet tabs.
  // Falls back to paragraph list when no tables are present.
  // ======================================================================
  async function mountWordToExcel(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Generating spreadsheet preview\u2026' + skeletonHtml(5) + '</div>';

    // Load mammoth for DOCX parsing
    var mammoth;
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js');
      mammoth = window.mammoth;
    } catch (_) {
      host.innerHTML = errorHtml('Could not load document parser. Check your connection.');
      return;
    }
    if (!mammoth) { host.innerHTML = errorHtml('Document parser unavailable.'); return; }

    var htmlContent;
    try {
      var ab = await file.arrayBuffer();
      var result = await mammoth.convertToHtml({ arrayBuffer: ab });
      ab = null;
      htmlContent = (result && result.value) || '';
    } catch (_) {
      host.innerHTML = errorHtml('Could not read this Word document. Is it a valid .docx file?');
      return;
    }

    if (!htmlContent.trim()) {
      host.innerHTML = errorHtml('This document appears to be empty.');
      return;
    }

    // Parse HTML
    var parser  = new DOMParser();
    var htmlDoc = parser.parseFromString('<div id="wr">' + htmlContent + '</div>', 'text/html');
    htmlContent = null;
    var rootEl  = htmlDoc.getElementById('wr') || htmlDoc.body;

    // Extract tables from the document
    var domTables  = rootEl ? rootEl.querySelectorAll('table') : [];
    var tableCount = domTables ? domTables.length : 0;
    var sheets     = [];

    if (tableCount > 0) {
      for (var ti = 0; ti < domTables.length; ti++) {
        var tbl   = domTables[ti];
        var rows  = [];
        var trs   = tbl.querySelectorAll('tr');
        var maxCols = 0;
        for (var ri = 0; ri < trs.length; ri++) {
          var cells = trs[ri].querySelectorAll('th, td');
          var row   = [];
          for (var di = 0; di < cells.length; di++) row.push((cells[di].textContent || '').trim());
          if (row.length > maxCols) maxCols = row.length;
          if (row.some(function (c) { return c; })) rows.push(row);
        }
        if (rows.length > 0 && maxCols > 0) {
          var sheetName = 'Table ' + (ti + 1);
          var prev = tbl.previousElementSibling;
          if (prev && /^h[1-6]$/i.test(prev.tagName || '')) {
            var ht = (prev.textContent || '').trim().slice(0, 28);
            if (ht) sheetName = ht;
          }
          sheets.push({ name: sheetName, rows: rows, maxCols: maxCols });
        }
      }
    }

    // Fallback: paragraph list as two-column preview
    if (sheets.length === 0) {
      var paras    = rootEl ? rootEl.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6') : [];
      var flatRows = [];
      var rowIdx   = 0;
      for (var pi = 0; pi < paras.length && rowIdx < 60; pi++) {
        var ptxt = (paras[pi].textContent || '').trim();
        if (ptxt) { rowIdx++; flatRows.push([rowIdx, ptxt]); }
      }
      if (flatRows.length > 0) {
        sheets.push({ name: 'Document', rows: flatRows, maxCols: 2 });
      }
    }

    rootEl = null; htmlDoc = null;

    if (sheets.length === 0) {
      host.innerHTML = errorHtml('No content could be extracted from this document for preview.');
      return;
    }

    var totalRows  = sheets.reduce(function (a, s) { return a + s.rows.length; }, 0);
    var activeSheet = 0;

    function buildTableHtml(sh) {
      var maxDisplay = 80;
      var display    = sh.rows.slice(0, maxDisplay);
      var isHeaderRow = display.length > 0 && display[0].every(function (c) { return c !== ''; });
      var thead = '';
      var tbody = '';
      if (isHeaderRow) {
        thead = '<thead><tr>' + display[0].map(function (c) {
          return '<th class="lp-w2x-th">' + _escHtml(c) + '</th>';
        }).join('') + '</tr></thead>';
        display = display.slice(1);
      }
      tbody = '<tbody>' + display.map(function (row, ri) {
        return '<tr class="' + (ri % 2 === 0 ? 'lp-w2x-row-even' : 'lp-w2x-row-odd') + '">' +
          row.map(function (c) { return '<td class="lp-w2x-td">' + _escHtml(String(c)) + '</td>'; }).join('') +
          '</tr>';
      }).join('') + '</tbody>';
      var moreNote = sh.rows.length > maxDisplay
        ? '<div class="lp-w2x-more">Showing first ' + maxDisplay + ' of ' + sh.rows.length + ' rows</div>'
        : '';
      return '<div class="lp-w2x-tbl-wrap"><table class="lp-w2x-tbl">' + thead + tbody + '</table>' + moreNote + '</div>';
    }

    function _escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function buildTabsHtml() {
      return sheets.map(function (sh, i) {
        return '<button type="button" class="lp-w2x-tab' + (i === activeSheet ? ' active' : '') + '" data-sheet="' + i + '">' +
          _escHtml(sh.name) + '</button>';
      }).join('');
    }

    function render() {
      var sh = sheets[activeSheet];
      var statsHtml =
        '<span class="lp-stat"><b>' + sh.rows.length + '</b> rows</span>' +
        '<span class="lp-stat"><b>' + sh.maxCols + '</b> col' + (sh.maxCols !== 1 ? 's' : '') + '</span>' +
        '<span class="lp-stat"><b>' + totalRows + '</b> total rows</span>';

      host.innerHTML =
        '<div class="lp-panel lp-panel--w2x">' +
          '<div class="lp-header lp-header--sticky">' +
            '<span class="lp-title">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>' +
              ' Spreadsheet Preview' +
            '</span>' +
            '<div class="lp-header-stats">' + statsHtml + '</div>' +
          '</div>' +
          (sheets.length > 1
            ? '<div class="lp-w2x-tabs">' + buildTabsHtml() + '</div>'
            : '') +
          buildTableHtml(sh) +
          '<div class="lp-footer">' +
            'Live preview \xb7 ' + sheets.length + ' sheet' + (sheets.length !== 1 ? 's' : '') + ' detected' +
            (tableCount > 0 ? ' \xb7 ' + tableCount + ' table' + (tableCount !== 1 ? 's' : '') + ' in document' : '') +
            ' \xb7 numeric values will be auto-detected in output' +
          '</div>' +
        '</div>';

      // Wire tab clicks
      host.querySelectorAll('.lp-w2x-tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
          activeSheet = parseInt(btn.dataset.sheet, 10) || 0;
          render();
        });
      });
    }

    render();
  }

  // ======================================================================
  // MOUNT DISPATCHER
  // ======================================================================
  async function mount(toolId, files, host) {
    if (!host || !SUPPORTED.has(toolId)) return;
    var file = Array.isArray(files) ? files[0] : files;
    if (!file) return;

    cleanupHost(host);

    try {
      if      (toolId === 'word-to-pdf')         await mountWordToPdf(file, host);
      else if (toolId === 'excel-to-pdf')        await mountExcelToPdf(file, host);
      else if (toolId === 'pdf-to-word')         await mountPdfWordPreview(file, host);
      else if (toolId === 'pdf-to-excel')        await mountPdfExcelPreview(file, host);
      else if (toolId === 'background-remover')  await mountBgRemover(file, host);
      else if (toolId === 'translate')           await mountTranslatePreview(file, host);
      else if (toolId === 'ai-summarize')        await mountSummarizePreview(file, host);
      else if (toolId === 'edit')                await mountEditPdfPreview(file, host);
      else if (toolId === 'pdf-to-powerpoint')   await mountPdfPowerPointPreview(file, host);
      else if (toolId === 'powerpoint-to-pdf')   await mountPowerPointPdfPreview(file, host);
      else if (toolId === 'html-to-pdf')         await mountHtmlToPdfPreview(file, host);
      else if (toolId === 'ocr')                 await mountOcrPreview(file, host);
      else if (toolId === 'scan-to-pdf')         await mountScanPreview(file, host);
      else if (toolId === 'repair')              await mountRepairPreview(file, host);
      else if (toolId === 'word-to-excel')       await mountWordToExcel(file, host);
    } catch (err) {
      // Never blank-screen — show recovery UI
      host.innerHTML = errorHtml(
        'Preview could not load for this file. The tool will still work normally.',
        function () { mount(toolId, files, host); }
      );
      if (window.DebugTrace) {
        window.DebugTrace.error('live-preview', { toolId: toolId, msg: err && err.message });
      }
    }
  }

  window.LivePreview = {
    mount:     mount,
    supported: function (toolId) { return SUPPORTED.has(toolId); },
  };
}());

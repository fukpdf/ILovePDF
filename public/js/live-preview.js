// Live Preview Engine v5.5
// Provides real "see before you convert" previews for key tool groups.
// Non-blocking — if preview fails for any reason, the tool still works normally.
//
// Supported tools:
//   word-to-pdf       → HTML print preview with page layout controls
//   excel-to-pdf      → Table print preview with page/orientation controls
//   pdf-to-word       → PDF page thumbnails + extracted document structure
//   pdf-to-excel      → PDF page thumbnails + column/table detection
//   background-remover→ Live before/after canvas comparison + threshold slider
//
// window.LivePreview.mount(toolId, files, hostEl) → Promise<void>
// window.LivePreview.supported(toolId)            → boolean
(function () {
  'use strict';

  var MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js';
  var XLSX_URL    = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

  var SUPPORTED = new Set([
    'word-to-pdf', 'excel-to-pdf',
    'pdf-to-word', 'pdf-to-excel',
    'background-remover',
    'translate', 'ai-summarize',
  ]);

  // ── Tiny script loader (shared CDN cache with browser-tools.js slots) ────
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

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  var PAGE_SIZES = {
    A4:     { w: 210, h: 297 },
    Letter: { w: 216, h: 279 },
  };

  // ── Shared controls renderer ─────────────────────────────────────────────
  function pageSizeBtns(activeSize) {
    return ['A4','Letter'].map(function (k) {
      return '<button type="button" class="lp-ctrl-btn' + (k === activeSize ? ' active' : '') +
             '" data-size="' + k + '">' + k + '</button>';
    }).join('');
  }

  function orientBtns(activeOrient) {
    var items = [
      { id:'portrait',  svg:'<svg width="10" height="13" viewBox="0 0 10 13" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x=".5" y=".5" width="9" height="12" rx="1" stroke="currentColor"/></svg>', label:'Portrait'  },
      { id:'landscape', svg:'<svg width="13" height="10" viewBox="0 0 13 10" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x=".5" y=".5" width="12" height="9" rx="1" stroke="currentColor"/></svg>', label:'Landscape' },
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
        host.querySelectorAll('[data-size]').forEach(function (x) {
          x.classList.toggle('active', x.dataset.size === state.size);
        });
        var el = document.getElementById('opt-pageSize');
        if (el) el.value = state.size;
        if (state.onchange) state.onchange();
      });
    });
    host.querySelectorAll('[data-orient]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.orient = b.dataset.orient;
        host.querySelectorAll('[data-orient]').forEach(function (x) {
          x.classList.toggle('active', x.dataset.orient === state.orient);
        });
        var el = document.getElementById('opt-orientation');
        if (el) el.value = state.orient;
        if (state.onchange) state.onchange();
      });
    });
  }

  // ── WORD → PDF PREVIEW ───────────────────────────────────────────────────
  async function mountWordToPdf(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Generating document preview…</div>';

    var mammoth = await loadScript(MAMMOTH_URL, 'mammoth');
    var buf     = await file.arrayBuffer();
    var result  = await mammoth.convertToHtml({ arrayBuffer: buf });
    var html    = result.value || '';
    if (!html.trim()) { host.innerHTML = ''; return; }

    var state = { size: 'A4', orient: 'portrait' };

    function computeStyle() {
      var ps  = PAGE_SIZES[state.size] || PAGE_SIZES.A4;
      var wMm = state.orient === 'landscape' ? ps.h : ps.w;
      var hMm = state.orient === 'landscape' ? ps.w : ps.h;
      var px  = function (mm) { return (mm * 96 / 25.4 * 0.6) + 'px'; };
      return 'width:' + px(wMm) + ';min-height:' + px(hMm) + ';';
    }

    state.onchange = function () {
      var page = host.querySelector('.lp-page-content');
      if (page) page.setAttribute('style', computeStyle());
    };

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            ' Document Preview' +
          '</span>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page size</span><div class="lp-ctrl-row">' + pageSizeBtns('A4') + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Orientation</span><div class="lp-ctrl-row">' + orientBtns('portrait') + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="lp-scroll">' +
          '<div class="lp-page-wrap">' +
            '<div class="lp-page-content" style="' + computeStyle() + '">' + html + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="lp-footer">Preview only — actual PDF output may differ slightly in fonts and spacing</div>' +
      '</div>';

    wireCtrlSync(host, state);
  }

  // ── EXCEL → PDF PREVIEW (v3.0 — margins + scaling controls) ─────────────
  async function mountExcelToPdf(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Generating spreadsheet preview…</div>';

    var XLSX = await loadScript(XLSX_URL, 'XLSX');
    var buf  = await file.arrayBuffer();
    var wb   = XLSX.read(buf, { type: 'array', cellStyles: true });
    if (!wb.SheetNames.length) { host.innerHTML = ''; return; }

    // Auto-detect orientation from column count
    var firstWs   = wb.Sheets[wb.SheetNames[0]];
    var firstRows = XLSX.utils.sheet_to_json(firstWs, { header: 1, defval: '' });
    var maxCols   = firstRows.length ? Math.max.apply(null, firstRows.map(function (r) { return r.length; })) : 1;
    var autoOrient = maxCols > 6 ? 'landscape' : 'portrait';

    var state = { sheet: 0, size: 'A4', orient: autoOrient, margins: 'normal', scaling: 'fit-page' };

    function syncOpts() {
      var el;
      el = document.getElementById('opt-pageSize');    if (el) el.value = state.size;
      el = document.getElementById('opt-orientation'); if (el) el.value = state.orient;
      el = document.getElementById('opt-margins');     if (el) el.value = state.margins;
      el = document.getElementById('opt-scaling');     if (el) el.value = state.scaling;
    }

    function renderSheet() {
      var ws  = wb.Sheets[wb.SheetNames[state.sheet]];
      var tbl = XLSX.utils.sheet_to_html(ws, { header: '', id: 'lp-xlsx-table' });
      var cv  = host.querySelector('.lp-xlsx-canvas');
      if (cv) cv.innerHTML = tbl;
      host.querySelectorAll('[data-sheet]').forEach(function (b) {
        b.classList.toggle('active', parseInt(b.dataset.sheet, 10) === state.sheet);
      });
      // update page boundary indicator
      var wrap = host.querySelector('.lp-xlsx-page-wrap');
      if (wrap) {
        var isLand = state.orient === 'landscape';
        var isA3   = state.size === 'A3';
        var marginMap = { none: '4px', narrow: '12px', normal: '20px' };
        var m = marginMap[state.margins] || '20px';
        wrap.style.padding = m;
        wrap.style.maxWidth = isLand ? (isA3 ? '900px' : '780px') : (isA3 ? '640px' : '540px');
      }
      syncOpts();
    }
    state.onchange = renderSheet;

    function marginBtns(active) {
      return [
        { id: 'none',   label: 'None' },
        { id: 'narrow', label: 'Narrow' },
        { id: 'normal', label: 'Normal' },
      ].map(function (o) {
        return '<button type="button" class="lp-ctrl-btn' + (o.id === active ? ' active' : '') +
               '" data-margin="' + o.id + '">' + o.label + '</button>';
      }).join('');
    }

    function scalingBtns(active) {
      return [
        { id: 'fit-page',  label: 'Fit page' },
        { id: 'fit-width', label: 'Fit width' },
        { id: 'actual',    label: 'Actual' },
      ].map(function (o) {
        return '<button type="button" class="lp-ctrl-btn' + (o.id === active ? ' active' : '') +
               '" data-scaling="' + o.id + '">' + o.label + '</button>';
      }).join('');
    }

    var sheetTabsHtml = wb.SheetNames.length > 1
      ? '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Sheet</span><div class="lp-ctrl-row">' +
          wb.SheetNames.map(function (n, i) {
            return '<button type="button" class="lp-ctrl-btn' + (i === 0 ? ' active' : '') +
                   '" data-sheet="' + i + '">' + esc(n) + '</button>';
          }).join('') + '</div></div>'
      : '';

    // Dimension badge
    var dimBadge = '<span class="lp-dim-badge">' + firstRows.length + ' rows × ' + maxCols + ' cols</span>';

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>' +
            ' Spreadsheet Preview ' + dimBadge +
          '</span>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page size</span><div class="lp-ctrl-row">' + pageSizeBtns('A4') +
              '<button type="button" class="lp-ctrl-btn" data-size="A3">A3</button>' +
            '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Orientation</span><div class="lp-ctrl-row">' + orientBtns(autoOrient) + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Margins</span><div class="lp-ctrl-row">' + marginBtns('normal') + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Scaling</span><div class="lp-ctrl-row">' + scalingBtns('fit-page') + '</div></div>' +
            sheetTabsHtml +
          '</div>' +
        '</div>' +
        '<div class="lp-scroll lp-scroll--wide"><div class="lp-xlsx-page-wrap"><div class="lp-xlsx-canvas"></div></div></div>' +
        '<div class="lp-footer">Wide tables auto-switch to landscape · scaling controls affect PDF output</div>' +
      '</div>';

    wireCtrlSync(host, state);

    // Wire margin buttons
    host.querySelectorAll('[data-margin]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.margins = b.dataset.margin;
        host.querySelectorAll('[data-margin]').forEach(function (x) {
          x.classList.toggle('active', x.dataset.margin === state.margins);
        });
        var el = document.getElementById('opt-margins');
        if (el) el.value = state.margins;
        if (state.onchange) state.onchange();
      });
    });

    // Wire scaling buttons
    host.querySelectorAll('[data-scaling]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.scaling = b.dataset.scaling;
        host.querySelectorAll('[data-scaling]').forEach(function (x) {
          x.classList.toggle('active', x.dataset.scaling === state.scaling);
        });
        var el = document.getElementById('opt-scaling');
        if (el) el.value = state.scaling;
        if (state.onchange) state.onchange();
      });
    });

    host.querySelectorAll('[data-sheet]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.sheet = parseInt(b.dataset.sheet, 10);
        renderSheet();
      });
    });

    renderSheet();
  }

  // ── PDF → WORD / EXCEL PREVIEW (v3.0 — scanned PDF badge, richer structure) ──
  // Shows page thumbnails + detected document structure (headings, tables, paragraphs).
  // Adds a "Scanned PDF — OCR will run" badge when no text is found.
  async function mountPdfExtract(file, host, toolId) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing document structure…</div>';

    if (!window.PdfPreview) throw new Error('PdfPreview not loaded');

    var pdfDoc = await window.PdfPreview.loadDocument(file);
    var numPages    = pdfDoc.pageCount;
    var previewPgs  = Math.min(numPages, 3);

    var thumbPromises = [];
    for (var i = 1; i <= previewPgs; i++) {
      thumbPromises.push(window.PdfPreview.renderPage(pdfDoc, i, 140, 0));
    }
    var canvases = await Promise.all(thumbPromises);
    window.PdfPreview.unloadDocument(pdfDoc);

    var headingCount = 0, tableCount = 0, paraCount = 0;
    var structLines  = [];
    var totalRawChars = 0;
    var isScanned     = false;

    if (window.pdfjsLib) {
      try {
        var buf = await file.arrayBuffer();
        var pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
        var checkPages = Math.min(pdf.numPages, 5);

        for (var p = 1; p <= checkPages; p++) {
          var pg  = await pdf.getPage(p);
          var tc  = await pg.getTextContent();
          var buckets = {};
          tc.items.forEach(function (it) {
            if (!it.str || !it.str.trim()) return;
            totalRawChars += it.str.replace(/\s/g, '').length;
            var yKey = Math.round(it.transform[5] / 5) * 5;
            if (!buckets[yKey]) buckets[yKey] = { text: '', fontSize: 0 };
            buckets[yKey].text += it.str + ' ';
            if ((it.height || 0) > buckets[yKey].fontSize) buckets[yKey].fontSize = it.height || 0;
          });
          var ys = Object.keys(buckets).map(Number).sort(function (a, b) { return b - a; });
          ys.forEach(function (y) {
            var l   = buckets[y];
            var t   = l.text.trim();
            if (!t || t.length < 3) return;
            var isHeading = (l.fontSize > 12) ||
                            (t === t.toUpperCase() && t.length >= 3 && t.length < 80 && /[A-Z]/.test(t) && !/^\d/.test(t));
            var isTable   = /\s{3,}/.test(t) && t.split(/\s{3,}/).length >= 3;
            if (isHeading) {
              headingCount++;
              if (structLines.length < 14) structLines.push({ type: 'heading', text: t.slice(0, 70) });
            } else if (isTable) {
              tableCount++;
              if (structLines.length < 14) structLines.push({ type: 'table', text: t.slice(0, 80) });
            } else {
              paraCount++;
              if (structLines.length < 14) structLines.push({ type: 'para', text: t.slice(0, 70) });
            }
          });
          pg.cleanup();
        }
        await pdf.destroy();

        // Scanned PDF = very little extractable text
        isScanned = totalRawChars < 50;
      } catch (_) {}
    }

    // Scanned PDF notice (shown when OCR will be needed)
    var scannedBadge = isScanned
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
          ' Scanned PDF detected — OCR will run automatically to extract text' +
        '</div>'
      : '';

    // Structure panel: show "No digital text" hint when scanned
    var structPanel = '';
    if (isScanned) {
      structPanel = '<div class="lp-struct">' +
        '<div class="lp-struct-title">OCR mode</div>' +
        '<div class="lp-struct-line lp-struct-para">' +
          '<span class="lp-struct-icon">🔍</span>' +
          '<span class="lp-struct-text">No selectable text found. Tesseract OCR will analyse each page and extract content into your ' +
          (toolId === 'pdf-to-excel' ? 'spreadsheet' : 'document') + '.</span>' +
        '</div></div>';
    } else if (structLines.length) {
      structPanel = '<div class="lp-struct">' +
        '<div class="lp-struct-title">Detected structure</div>' +
        structLines.map(function (l) {
          var cls  = 'lp-struct-' + l.type;
          var icon = l.type === 'heading' ? '📌' : l.type === 'table' ? '📊' : '¶';
          return '<div class="lp-struct-line ' + cls + '">' +
                   '<span class="lp-struct-icon">' + icon + '</span>' +
                   '<span class="lp-struct-text">' + esc(l.text) + '</span>' +
                 '</div>';
        }).join('') +
      '</div>';
    }

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
            ' Document Analysis' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages === 1 ? '' : 's') + '</span>' +
            (isScanned
              ? '<span class="lp-stat lp-stat--warn"><b>Scanned</b> — OCR</span>'
              : '<span class="lp-stat"><b>' + headingCount + '</b> heading' + (headingCount === 1 ? '' : 's') + '</span>' +
                '<span class="lp-stat"><b>' + tableCount + '</b> table' + (tableCount === 1 ? '' : 's') + '</span>' +
                '<span class="lp-stat"><b>' + paraCount + '</b> para' + (paraCount === 1 ? '' : 's') + '</span>'
            ) +
          '</div>' +
        '</div>' +
        (scannedBadge ? '<div class="lp-scanned-wrap">' + scannedBadge + '</div>' : '') +
        '<div class="lp-extract-body">' +
          '<div class="lp-thumbs" id="lp-thumbs-host"></div>' +
          structPanel +
        '</div>' +
        '<div class="lp-footer">Preview shows what will be extracted into your ' +
          (toolId === 'pdf-to-excel' ? 'spreadsheet' : 'document') + '</div>' +
      '</div>';

    var thumbHost = host.querySelector('#lp-thumbs-host');
    if (thumbHost) {
      canvases.forEach(function (cv, idx) {
        cv.style.borderRadius = '4px';
        cv.style.boxShadow = '0 2px 8px rgba(0,0,0,.15)';
        cv.style.display = 'block';
        var wrap = document.createElement('div');
        wrap.className = 'lp-thumb-wrap';
        var lbl = document.createElement('div');
        lbl.className = 'lp-thumb-label';
        lbl.textContent = 'Page ' + (idx + 1);
        wrap.appendChild(cv);
        wrap.appendChild(lbl);
        thumbHost.appendChild(wrap);
      });
    }
  }

  // ── BACKGROUND REMOVER PREVIEW ───────────────────────────────────────────
  // Shows original image + live threshold-preview side-by-side.
  async function mountBgRemover(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Loading image preview…</div>';

    var objUrl = URL.createObjectURL(file);
    var img    = new Image();
    await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = objUrl; });
    URL.revokeObjectURL(objUrl);

    var MAX_DIM = 320;
    var scale   = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight, 1));
    var W       = Math.max(1, Math.round(img.naturalWidth  * scale));
    var H       = Math.max(1, Math.round(img.naturalHeight * scale));

    var beforeCanvas       = document.createElement('canvas');
    beforeCanvas.width     = W; beforeCanvas.height = H;
    var bCtx               = beforeCanvas.getContext('2d');
    bCtx.drawImage(img, 0, 0, W, H);
    var srcData            = bCtx.getImageData(0, 0, W, H);

    var afterCanvas        = document.createElement('canvas');
    afterCanvas.width      = W; afterCanvas.height = H;
    var aCtx               = afterCanvas.getContext('2d');

    function drawCheckerboard() {
      var SZ = 8;
      for (var ry = 0; ry < H; ry += SZ) {
        for (var rx = 0; rx < W; rx += SZ) {
          aCtx.fillStyle = (((rx / SZ) + (ry / SZ)) % 2 === 0) ? '#d4d4d4' : '#ffffff';
          aCtx.fillRect(rx, ry, SZ, SZ);
        }
      }
    }

    var DX = [-1, 1, 0, 0, -1, 1, -1, 1];
    var DY = [ 0, 0,-1, 1, -1,-1,  1, 1];

    function applyThreshold(threshold) {
      drawCheckerboard();
      var out  = new ImageData(new Uint8ClampedArray(srcData.data), W, H);
      var d    = out.data;

      for (var i = 0; i < d.length; i += 4) {
        if (d[i] >= threshold && d[i+1] >= threshold && d[i+2] >= threshold) {
          d[i+3] = 0;
        }
      }

      var copy = new Uint8ClampedArray(d);
      for (var ry = 1; ry < H - 1; ry++) {
        for (var rx = 1; rx < W - 1; rx++) {
          var idx = (ry * W + rx) * 4;
          if (copy[idx + 3] === 0) continue;
          var transparent = 0;
          for (var n = 0; n < 8; n++) {
            var ni = ((ry + DY[n]) * W + (rx + DX[n])) * 4;
            if (ni >= 0 && ni < copy.length && copy[ni + 3] === 0) transparent++;
          }
          if (transparent > 0) {
            d[idx + 3] = Math.round(copy[idx + 3] * (1 - transparent / 8));
          }
        }
      }
      aCtx.putImageData(out, 0, 0);
    }

    var initThresh = 240;
    applyThreshold(initThresh);

    host.innerHTML =
      '<div class="lp-panel lp-panel--image">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
            ' Before / After Preview' +
          '</span>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group">' +
              '<span class="lp-ctrl-label">Threshold: <b id="lp-thresh-val">' + initThresh + '</b></span>' +
              '<input type="range" class="lp-slider" id="lp-thresh" min="50" max="255" value="' + initThresh + '">' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="lp-before-after">' +
          '<div class="lp-ba-col"><div class="lp-ba-label">Original</div><div class="lp-ba-canvas" id="lp-before-host"></div></div>' +
          '<div class="lp-ba-divider" aria-hidden="true">→</div>' +
          '<div class="lp-ba-col"><div class="lp-ba-label">Preview</div><div class="lp-ba-canvas lp-ba-canvas--after" id="lp-after-host"></div></div>' +
        '</div>' +
        '<div class="lp-footer">Adjust threshold to tune edge sensitivity — higher values remove more background</div>' +
      '</div>';

    var bHost = host.querySelector('#lp-before-host');
    var aHost = host.querySelector('#lp-after-host');
    if (bHost) bHost.appendChild(beforeCanvas);
    if (aHost) aHost.appendChild(afterCanvas);

    var slider = host.querySelector('#lp-thresh');
    var valLbl = host.querySelector('#lp-thresh-val');
    if (slider) {
      slider.addEventListener('input', function () {
        var v = parseInt(slider.value, 10);
        if (valLbl) valLbl.textContent = v;
        var optEl = document.getElementById('opt-threshold');
        if (optEl) optEl.value = v;
        applyThreshold(v);
      });
    }
  }

  // ── PDF → WORD LIVE PREVIEW ──────────────────────────────────────────────
  // Dedicated preview for pdf-to-word. Uses same ratio-based heading detection
  // as the engine. Shows 📌 H1, 🔷 H2, ¶ paragraph, 📊 table, OCR badge for
  // scanned docs. Stats: pages / headings / tables / paras / mode.
  async function mountPdfWordPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing document structure…</div>';

    var pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      try {
        var mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
        if (!mod.GlobalWorkerOptions.workerSrc) {
          mod.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
        }
        pdfjsLib = mod; window.pdfjsLib = mod;
      } catch (_) { pdfjsLib = null; }
    }
    if (!pdfjsLib) throw new Error('PDF library not available');

    var buf        = await file.arrayBuffer();
    var pdf        = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var numPages   = pdf.numPages;
    var checkPages = Math.min(numPages, 3);
    var totalRawChars = 0;
    var allLines = [];  // [{ text, fontSize, xPositions, pageWidth }]

    for (var pg = 1; pg <= checkPages; pg++) {
      var page      = await pdf.getPage(pg);
      var viewport  = page.getViewport({ scale: 1 });
      var content   = await page.getTextContent();
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
        allLines.push({ text: text, fontSize: bucket.fontSize, xPositions: sorted.map(function (p) { return p.x; }), pageWidth: pageWidth });
      });
    }
    await pdf.destroy();

    var isScanned = totalRawChars < 50;

    // ── Modal base font size (same logic as engine) ─────────────────────────
    var sizes = allLines.map(function (l) { return Math.round(l.fontSize); }).filter(function (s) { return s > 0; });
    var base  = 11;
    if (sizes.length) {
      var freq = {};
      sizes.forEach(function (s) { freq[s] = (freq[s] || 0) + 1; });
      base = parseInt(Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })[0], 10) || 11;
    }

    // ── Classify lines with same thresholds as engine ───────────────────────
    var headingCount = 0, paraCount = 0, tableCount = 0;
    var structLines  = [];

    allLines.forEach(function (line) {
      var t   = line.text;
      var fs  = line.fontSize || 0;
      var gap = (line.pageWidth || 612) * 0.045;
      var type = 'p';

      if (
        (fs > 0 && fs > base * 1.35) ||
        (t === t.toUpperCase() && t.length >= 3 && t.length < 90 && /[A-Z]/.test(t) && !/^\d/.test(t))
      ) type = 'h1';
      else if (
        (fs > 0 && fs > base * 1.15 && fs <= base * 1.35) ||
        (/^(\d+\.)+\s+\S/.test(t) && t.length <= 100) ||
        (/^[A-Z]\.\s+\S/.test(t) && t.length <= 100)
      ) type = 'h2';
      else if (line.xPositions && line.xPositions.length >= 2) {
        for (var k = 1; k < line.xPositions.length; k++) {
          if (line.xPositions[k] - line.xPositions[k - 1] >= gap) { type = 'table'; break; }
        }
      }
      if (type === 'p' && t.split(/\s{3,}/).length >= 3) type = 'table';

      if (type === 'h1') {
        headingCount++;
        if (structLines.length < 16) structLines.push({ type: 'h1', text: t.slice(0, 72) });
      } else if (type === 'h2') {
        headingCount++;
        if (structLines.length < 16) structLines.push({ type: 'h2', text: t.slice(0, 72) });
      } else if (type === 'table') {
        tableCount++;
        if (structLines.length < 16) structLines.push({ type: 'table', text: t.slice(0, 80) });
      } else {
        paraCount++;
        if (structLines.length < 16) structLines.push({ type: 'para', text: t.slice(0, 72) });
      }
    });

    var mode = isScanned ? 'OCR' : 'Digital';

    var ocrBadge = isScanned
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' Scanned PDF — Tesseract OCR will reconstruct headings, paragraphs and tables during conversion.' +
        '</div>'
      : '';

    var structPanel = '';
    if (isScanned) {
      structPanel = '<div class="lp-struct">' +
        '<div class="lp-struct-title">OCR mode — no selectable text found</div>' +
        '<div class="lp-struct-line lp-struct-para">' +
          '<span class="lp-struct-icon">🔍</span>' +
          '<span class="lp-struct-text">Tesseract will process each page using word bounding boxes to detect and reconstruct headings, paragraphs and tables.</span>' +
        '</div></div>';
    } else if (!structLines.length) {
      structPanel = '<div class="lp-struct">' +
        '<div class="lp-struct-line lp-struct-para">' +
          '<span class="lp-struct-icon">⚠️</span>' +
          '<span class="lp-struct-text">No readable content detected in the first 3 pages. OCR will be attempted during conversion.</span>' +
        '</div></div>';
    } else {
      structPanel = '<div class="lp-struct"><div class="lp-struct-title">Detected structure</div>' +
        structLines.map(function (l) {
          var icon = l.type === 'h1' ? '📌' : l.type === 'h2' ? '🔷' : l.type === 'table' ? '📊' : '¶';
          var cls  = (l.type === 'h1' || l.type === 'h2') ? 'lp-struct-heading' : l.type === 'table' ? 'lp-struct-table' : 'lp-struct-para';
          return '<div class="lp-struct-line ' + cls + '">' +
                   '<span class="lp-struct-icon">' + icon + '</span>' +
                   '<span class="lp-struct-text">' + esc(l.text) + '</span>' +
                 '</div>';
        }).join('') +
      '</div>';
    }

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' +
            '<line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
            ' Document Structure' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages === 1 ? '' : 's') + '</span>' +
            (isScanned
              ? '<span class="lp-stat lp-stat--warn"><b>Scanned</b> — OCR</span>'
              : '<span class="lp-stat"><b>' + headingCount + '</b> heading' + (headingCount === 1 ? '' : 's') + '</span>' +
                '<span class="lp-stat"><b>' + tableCount + '</b> table' + (tableCount === 1 ? '' : 's') + '</span>' +
                '<span class="lp-stat"><b>' + paraCount + '</b> para' + (paraCount === 1 ? '' : 's') + '</span>') +
            '<span class="lp-stat"><b>' + mode + '</b></span>' +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        '<div class="lp-extract-body">' + structPanel + '</div>' +
        '<div class="lp-footer">Structure preview — first 3 pages. Conversion processes the full document.</div>' +
      '</div>';
  }

  // ── PDF → EXCEL LIVE PREVIEW ─────────────────────────────────────────────
  // Shows a real HTML table preview with per-page rows/columns, OCR badge when
  // scanned, and stats header. Non-blocking — failure silently clears host.
  async function mountPdfExcelPreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing table structure…</div>';

    // Use pdfjsLib if already initialised; otherwise try dynamic import
    var pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      try {
        var mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
        if (!mod.GlobalWorkerOptions.workerSrc) {
          mod.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
        }
        pdfjsLib = mod; window.pdfjsLib = mod;
      } catch (_) { pdfjsLib = null; }
    }
    if (!pdfjsLib) throw new Error('PDF library not available');

    var buf         = await file.arrayBuffer();
    var pdf         = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var numPages    = pdf.numPages;
    var previewPgs  = Math.min(numPages, 3);
    var totalRawChars = 0;
    var allPageData = [];  // [{ rows, numCols, isOcr, pageNum }]

    for (var pg = 1; pg <= previewPgs; pg++) {
      var page     = await pdf.getPage(pg);
      var viewport = page.getViewport({ scale: 1 });
      var content  = await page.getTextContent();
      var pageWidth = viewport.width || 612;
      var colGap    = Math.max(12, Math.min(35, pageWidth * 0.04));

      var items = content.items
        .filter(function (it) { return it.str && it.str.trim(); })
        .map(function (it) {
          totalRawChars += it.str.replace(/\s/g, '').length;
          return { x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), text: it.str.trim() };
        });
      page.cleanup();

      if (items.length >= 3) {
        // ── Digital extraction: cluster X → cols, bucket Y → rows ──────
        var xVals  = items.map(function (it) { return it.x; });
        var xUniq  = xVals.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
        var clusters = [];
        xUniq.forEach(function (x) {
          var last = clusters[clusters.length - 1];
          if (!last || x - last.max > colGap) { clusters.push({ min: x, max: x, center: x }); }
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
        allPageData.push({ rows: rows, numCols: numCols, isOcr: false, pageNum: pg });
      } else {
        // Scanned page — mark for OCR during conversion; no OCR in preview
        allPageData.push({ rows: [], numCols: 0, isOcr: true, pageNum: pg });
      }
    }

    await pdf.destroy();

    var isScanned  = totalRawChars < 50;
    var willUseOcr = isScanned || allPageData.some(function (d) { return d.isOcr; });
    var totalRows  = allPageData.reduce(function (s, d) { return s + d.rows.length; }, 0);
    var maxCols    = allPageData.reduce(function (s, d) { return Math.max(s, d.numCols); }, 0);

    var ocrBadge = willUseOcr
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' OCR mode — scanned or image PDF. Tesseract will extract table data during conversion.' +
        '</div>'
      : '';

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
        var tHead = '<thead><tr>' + pd.rows[0].map(function (_, ci) {
          return '<th>Col&nbsp;' + (ci + 1) + '</th>';
        }).join('') + '</tr></thead>';
        var tBody = '<tbody>' + displayRows.map(function (row) {
          return '<tr>' + row.map(function (cell) {
            return '<td>' + esc(String(cell === 0 ? '0' : (cell || ''))) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody>';
        var more = pd.rows.length > 40
          ? '<div class="lp-tbl-more">+' + (pd.rows.length - 40) + ' more rows (not shown)</div>' : '';
        return '<div class="lp-tbl-page">' +
          '<div class="lp-tbl-page-label">Page ' + pd.pageNum +
            ' &mdash; <b>' + pd.rows.length + '</b> rows &times; <b>' + pd.numCols + '</b> cols</div>' +
          '<div class="lp-tbl-scroll"><table class="lp-tbl">' + tHead + tBody + '</table></div>' +
          more +
        '</div>';
      }).join('');
    } else if (willUseOcr) {
      tableHtml = '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
        '<span class="lp-struct-icon">🔍</span>' +
        '<span class="lp-struct-text">No digital table found. Tesseract OCR will extract table structure during conversion.</span>' +
        '</div></div>';
    } else {
      tableHtml = '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
        '<span class="lp-struct-icon">⚠️</span>' +
        '<span class="lp-struct-text">No structured table detected. Conversion may produce limited results.</span>' +
        '</div></div>';
    }

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>' +
            ' Table Preview' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages === 1 ? '' : 's') + '</span>' +
            (totalRows > 0
              ? '<span class="lp-stat"><b>' + totalRows + '</b> rows</span>' +
                '<span class="lp-stat"><b>' + maxCols + '</b> cols</span>'
              : '') +
            (willUseOcr
              ? '<span class="lp-stat lp-stat--warn"><b>OCR</b> mode</span>'
              : '<span class="lp-stat"><b>Digital</b> text</span>') +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        '<div class="lp-extract-body">' + tableHtml + '</div>' +
        '<div class="lp-footer">Preview shows up to 3 pages and 40 rows per page. OCR runs automatically during full conversion.</div>' +
      '</div>';
  }

  // ── TRANSLATE LIVE PREVIEW ────────────────────────────────────────────────
  // Shows before-translate: page count, word estimate, detected mode (digital/OCR),
  // and a snippet of extracted text so the user knows what will be translated.
  async function mountTranslatePreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing document…</div>';

    var pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      try {
        var mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
        if (!mod.GlobalWorkerOptions.workerSrc)
          mod.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
        pdfjsLib = mod; window.pdfjsLib = mod;
      } catch (_) { pdfjsLib = null; }
    }
    if (!pdfjsLib) throw new Error('PDF library not available');

    var buf        = await file.arrayBuffer();
    var pdf        = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var numPages   = pdf.numPages;
    var checkPages = Math.min(numPages, 2);
    var totalChars = 0;
    var textSnippet = '';

    for (var pg = 1; pg <= checkPages; pg++) {
      var page    = await pdf.getPage(pg);
      var content = await page.getTextContent();
      var pageText = content.items.map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim();
      totalChars += pageText.replace(/\s/g, '').length;
      if (!textSnippet && pageText.length > 30) textSnippet = pageText.slice(0, 220);
      page.cleanup();
    }
    await pdf.destroy();

    var isScanned  = totalChars < 50;
    // Estimate full-doc word count from sampled pages
    var estWords   = isScanned ? 0 : Math.round(totalChars * (numPages / checkPages) / 5);

    var ocrBadge = isScanned
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' Scanned PDF — Tesseract OCR will extract the text automatically before translating.' +
        '</div>'
      : '';

    var snippetHtml = textSnippet
      ? '<div class="lp-struct"><div class="lp-struct-title">Extracted text (preview)</div>' +
          '<div class="lp-struct-line lp-struct-para">' +
            '<span class="lp-struct-icon">¶</span>' +
            '<span class="lp-struct-text">' + esc(textSnippet) + (textSnippet.length >= 220 ? '…' : '') + '</span>' +
          '</div></div>'
      : '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
          '<span class="lp-struct-icon">⚠️</span>' +
          '<span class="lp-struct-text">No selectable text found — OCR will extract text automatically before translating.</span>' +
        '</div></div>';

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M5 8l6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/>' +
            '<path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>' +
            ' Translation Preview' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages === 1 ? '' : 's') + '</span>' +
            (isScanned
              ? '<span class="lp-stat lp-stat--warn"><b>Scanned</b> — OCR</span>'
              : '<span class="lp-stat"><b>~' + estWords.toLocaleString() + '</b> words</span>') +
            '<span class="lp-stat"><b>' + (isScanned ? 'OCR' : 'Digital') + '</b> mode</span>' +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        '<div class="lp-extract-body">' + snippetHtml + '</div>' +
        '<div class="lp-footer">Full document will be translated. Large PDFs may take a moment.</div>' +
      '</div>';
  }

  // ── AI SUMMARIZER LIVE PREVIEW ────────────────────────────────────────────
  // Shows before-summarize: page count, estimated word count, reading time,
  // heading count, and a structure preview of the first 3 pages.
  async function mountSummarizePreview(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Analysing document…</div>';

    var pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      try {
        var mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
        if (!mod.GlobalWorkerOptions.workerSrc)
          mod.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
        pdfjsLib = mod; window.pdfjsLib = mod;
      } catch (_) { pdfjsLib = null; }
    }
    if (!pdfjsLib) throw new Error('PDF library not available');

    var buf        = await file.arrayBuffer();
    var pdf        = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    var numPages   = pdf.numPages;
    var checkPages = Math.min(numPages, 3);
    var totalChars = 0;
    var allLines   = [];

    for (var pg = 1; pg <= checkPages; pg++) {
      var page      = await pdf.getPage(pg);
      var viewport  = page.getViewport({ scale: 1 });
      var content   = await page.getTextContent();
      var buckets   = {};

      content.items.forEach(function (it) {
        if (!it.str || !it.str.trim()) return;
        totalChars += it.str.replace(/\s/g, '').length;
        var yKey = Math.round(it.transform[5] / 3) * 3;
        if (!buckets[yKey]) buckets[yKey] = { parts: [], fontSize: 0 };
        buckets[yKey].parts.push({ text: it.str });
        if ((it.height || 0) > buckets[yKey].fontSize) buckets[yKey].fontSize = it.height || 0;
      });
      page.cleanup();

      // Modal font size for heading detection
      var pageSizes = Object.values(buckets).map(function (b) { return Math.round(b.fontSize); }).filter(function (s) { return s > 0; });
      var freq = {};
      pageSizes.forEach(function (s) { freq[s] = (freq[s] || 0) + 1; });
      var baseFs = pageSizes.length
        ? parseInt(Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })[0], 10) || 11 : 11;

      Object.keys(buckets).map(Number).sort(function (a, b) { return b - a; }).forEach(function (y) {
        var bucket = buckets[y];
        var text   = bucket.parts.map(function (p) { return p.text; }).join(' ').trim();
        if (!text) return;
        var isHeading =
          (bucket.fontSize > 0 && bucket.fontSize > baseFs * 1.2) ||
          (text === text.toUpperCase() && text.length >= 3 && text.length < 80 && /[A-Z]/.test(text) && !/^\d/.test(text)) ||
          (/^(\d+\.)+\s+\S/.test(text) && text.length <= 80);
        allLines.push({ text: text, isHeading: isHeading });
      });
    }
    await pdf.destroy();

    var isScanned   = totalChars < 50;
    var estWords    = isScanned ? 0 : Math.round(totalChars * (numPages / checkPages) / 5);
    var readingMins = Math.max(1, Math.ceil(estWords / 200));
    var headCount   = allLines.filter(function (l) { return l.isHeading; }).length;

    var ocrBadge = isScanned
      ? '<div class="lp-scanned-notice">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          ' Scanned PDF — OCR will extract the text automatically before summarizing.' +
        '</div>'
      : '';

    var structPanel = '';
    if (isScanned) {
      structPanel =
        '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
          '<span class="lp-struct-icon">🔍</span>' +
          '<span class="lp-struct-text">No selectable text found. OCR will process each page automatically during summarization.</span>' +
        '</div></div>';
    } else if (allLines.length) {
      var preview = allLines.slice(0, 12);
      structPanel =
        '<div class="lp-struct"><div class="lp-struct-title">Document structure (first ' + checkPages + ' pages)</div>' +
        preview.map(function (l) {
          var icon = l.isHeading ? '📌' : '¶';
          var cls  = l.isHeading ? 'lp-struct-heading' : 'lp-struct-para';
          return '<div class="lp-struct-line ' + cls + '">' +
            '<span class="lp-struct-icon">' + icon + '</span>' +
            '<span class="lp-struct-text">' + esc(l.text.slice(0, 72)) + '</span>' +
          '</div>';
        }).join('') +
        '</div>';
    } else {
      structPanel =
        '<div class="lp-struct"><div class="lp-struct-line lp-struct-para">' +
          '<span class="lp-struct-icon">⚠️</span>' +
          '<span class="lp-struct-text">No readable content detected in the first 3 pages. OCR will be attempted during summarization.</span>' +
        '</div></div>';
    }

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
            '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' +
            ' Document Analysis' +
          '</span>' +
          '<div class="lp-stats">' +
            '<span class="lp-stat"><b>' + numPages + '</b> page' + (numPages === 1 ? '' : 's') + '</span>' +
            (isScanned
              ? '<span class="lp-stat lp-stat--warn"><b>Scanned</b> — OCR</span>'
              : '<span class="lp-stat"><b>~' + estWords.toLocaleString() + '</b> words</span>' +
                '<span class="lp-stat"><b>~' + readingMins + '</b> min read</span>' +
                '<span class="lp-stat"><b>' + headCount + '</b> heading' + (headCount === 1 ? '' : 's') + '</span>') +
          '</div>' +
        '</div>' +
        (ocrBadge ? '<div class="lp-scanned-wrap">' + ocrBadge + '</div>' : '') +
        '<div class="lp-extract-body">' + structPanel + '</div>' +
        '<div class="lp-footer">Structure preview — first ' + checkPages + ' pages. Summary covers the full document.</div>' +
      '</div>';
  }

  // ── MOUNT DISPATCHER ─────────────────────────────────────────────────────
  async function mount(toolId, files, host) {
    if (!host || !SUPPORTED.has(toolId)) return;
    var file = Array.isArray(files) ? files[0] : files;
    if (!file) return;

    try {
      if (toolId === 'word-to-pdf')                         await mountWordToPdf(file, host);
      else if (toolId === 'excel-to-pdf')                   await mountExcelToPdf(file, host);
      else if (toolId === 'pdf-to-word')                    await mountPdfWordPreview(file, host);
      else if (toolId === 'pdf-to-excel')                   await mountPdfExcelPreview(file, host);
      else if (toolId === 'background-remover')             await mountBgRemover(file, host);
      else if (toolId === 'translate')                      await mountTranslatePreview(file, host);
      else if (toolId === 'ai-summarize')                   await mountSummarizePreview(file, host);
    } catch (err) {
      host.innerHTML = '';
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

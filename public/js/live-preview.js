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

  // ── EXCEL → PDF PREVIEW ──────────────────────────────────────────────────
  async function mountExcelToPdf(file, host) {
    host.innerHTML = '<div class="lp-loading"><div class="lp-spinner"></div>Generating spreadsheet preview…</div>';

    var XLSX = await loadScript(XLSX_URL, 'XLSX');
    var buf  = await file.arrayBuffer();
    var wb   = XLSX.read(buf, { type: 'array', cellStyles: true });
    if (!wb.SheetNames.length) { host.innerHTML = ''; return; }

    var state = { sheet: 0, size: 'A4', orient: 'landscape' };

    function renderSheet() {
      var ws  = wb.Sheets[wb.SheetNames[state.sheet]];
      var tbl = XLSX.utils.sheet_to_html(ws, { header: '', id: 'lp-xlsx-table' });
      var cv  = host.querySelector('.lp-xlsx-canvas');
      if (cv) cv.innerHTML = tbl;
      host.querySelectorAll('[data-sheet]').forEach(function (b) {
        b.classList.toggle('active', parseInt(b.dataset.sheet, 10) === state.sheet);
      });
    }
    state.onchange = renderSheet;

    var sheetTabsHtml = wb.SheetNames.length > 1
      ? '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Sheet</span><div class="lp-ctrl-row">' +
          wb.SheetNames.map(function (n, i) {
            return '<button type="button" class="lp-ctrl-btn' + (i === 0 ? ' active' : '') +
                   '" data-sheet="' + i + '">' + esc(n) + '</button>';
          }).join('') + '</div></div>'
      : '';

    host.innerHTML =
      '<div class="lp-panel">' +
        '<div class="lp-header">' +
          '<span class="lp-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>' +
            ' Spreadsheet Preview' +
          '</span>' +
          '<div class="lp-controls">' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Page size</span><div class="lp-ctrl-row">' + pageSizeBtns('A4') + '</div></div>' +
            '<div class="lp-ctrl-group"><span class="lp-ctrl-label">Orientation</span><div class="lp-ctrl-row">' + orientBtns('landscape') + '</div></div>' +
            sheetTabsHtml +
          '</div>' +
        '</div>' +
        '<div class="lp-scroll lp-scroll--wide"><div class="lp-xlsx-canvas"></div></div>' +
        '<div class="lp-footer">Tables will be auto-scaled to fit the selected page size</div>' +
      '</div>';

    wireCtrlSync(host, state);
    host.querySelectorAll('[data-sheet]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.sheet = parseInt(b.dataset.sheet, 10);
        renderSheet();
      });
    });
    renderSheet();
  }

  // ── PDF → WORD / EXCEL PREVIEW ───────────────────────────────────────────
  // Shows page thumbnails + detected document structure (headings, tables, paragraphs)
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
                            (t === t.toUpperCase() && t.length >= 3 && t.length < 80 && /[A-Z]/.test(t));
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
      } catch (_) {}
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
            '<span class="lp-stat"><b>' + headingCount + '</b> heading' + (headingCount === 1 ? '' : 's') + '</span>' +
            '<span class="lp-stat"><b>' + tableCount + '</b> table' + (tableCount === 1 ? '' : 's') + '</span>' +
            '<span class="lp-stat"><b>' + paraCount + '</b> paragraph' + (paraCount === 1 ? '' : 's') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="lp-extract-body">' +
          '<div class="lp-thumbs" id="lp-thumbs-host"></div>' +
          (structLines.length
            ? '<div class="lp-struct">' +
                '<div class="lp-struct-title">Detected structure</div>' +
                structLines.map(function (l) {
                  var cls  = 'lp-struct-' + l.type;
                  var icon = l.type === 'heading' ? '📌' : l.type === 'table' ? '📊' : '¶';
                  return '<div class="lp-struct-line ' + cls + '">' +
                           '<span class="lp-struct-icon">' + icon + '</span>' +
                           '<span class="lp-struct-text">' + esc(l.text) + '</span>' +
                         '</div>';
                }).join('') +
              '</div>'
            : '') +
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

  // ── MOUNT DISPATCHER ─────────────────────────────────────────────────────
  async function mount(toolId, files, host) {
    if (!host || !SUPPORTED.has(toolId)) return;
    var file = Array.isArray(files) ? files[0] : files;
    if (!file) return;

    try {
      if (toolId === 'word-to-pdf')                         await mountWordToPdf(file, host);
      else if (toolId === 'excel-to-pdf')                   await mountExcelToPdf(file, host);
      else if (toolId === 'pdf-to-word' ||
               toolId === 'pdf-to-excel')                   await mountPdfExtract(file, host, toolId);
      else if (toolId === 'background-remover')             await mountBgRemover(file, host);
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

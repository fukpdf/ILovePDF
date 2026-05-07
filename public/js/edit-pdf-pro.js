// Edit PDF PRO MAX — full interactive PDF editor
// 100% browser-side: pdf.js rendering, pdf-lib export, zero upload.
// Architecture: self-contained — EditPdfPro.mount(file, container, onResult)
(function () {
  'use strict';

  const PDFJS_URL    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
  const PDFLIB_URL   = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';

  // ── State ─────────────────────────────────────────────────────────────────
  let _file = null;
  let _onResult = null;
  let _pdfJs = null;      // pdfjs document
  let _pdfDoc = null;     // pdf-lib PDFDocument
  let _fileBytes = null;  // original Uint8Array

  // Page management
  let _pageCount = 0;
  let _pageOrder = [];    // 1-indexed, tracks reorder. e.g. [1,3,2]
  let _pageRotations = {};// pageNum → extra rotation (0/90/180/270)
  let _deletedPages = new Set(); // 1-indexed original pages to skip

  // Current view
  let _curPage = 1;       // 1-indexed in _pageOrder
  let _zoom = 1.0;
  let _renderScale = 1.5; // pdf.js render scale
  let _renderTask = null;

  // Annotations (all pages)
  let _annotations = []; // { id, page, type, x, y, w, h, content, style, rotation }
  let _selId = null;
  let _nextId = 0;

  // Active tool
  let _activeTool = 'select';

  // Signature pad
  let _sigPadDrawing = false;
  let _sigPadCtx = null;
  let _sigLastX = 0, _sigLastY = 0;
  let _sigPoints = [];

  // Undo/redo for annotations
  const MAX_UNDO = 20;
  let _undoStack = [];
  let _redoStack = [];

  // Drag/resize
  let _dragState = null; // { id, startX, startY, origX, origY, origW, origH, handle }

  // ── Public mount ──────────────────────────────────────────────────────────
  async function mount(file, container, onResult) {
    _file = file; _onResult = onResult;
    _reset();
    container.innerHTML = _html();
    _showLoader(container, 'Loading PDF…');

    try {
      _fileBytes = new Uint8Array(await file.arrayBuffer());
      await _loadLibs();
      _pdfJs = await window.pdfjsLib.getDocument({ data: _fileBytes, isEvalSupported: false }).promise;
      _pageCount = _pdfJs.numPages;
      _pageOrder = Array.from({ length: _pageCount }, (_, i) => i + 1);
      for (let i = 1; i <= _pageCount; i++) _pageRotations[i] = 0;
    } catch (e) {
      container.innerHTML = `<div style="padding:24px;color:red">Cannot open PDF: ${e.message}</div>`;
      return;
    }

    _hideLoader(container);
    _buildThumbnails(container);
    _renderPage(container, 1);
    _wireToolbar(container);
    _wirePageActions(container);
    _wireCanvas(container);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  function _html() {
    return `<div class="epro" id="epro-root">
  <!-- Top toolbar -->
  <div class="epro-toolbar">
    <div class="epro-tg epro-tools">
      <button class="epro-tb epro-on" id="epro-t-select"    title="Select/Move">&#9654;</button>
      <button class="epro-tb" id="epro-t-text"     title="Add Text">T</button>
      <button class="epro-tb" id="epro-t-image"    title="Add Image">&#128444;</button>
      <button class="epro-tb" id="epro-t-highlight" title="Highlight">&#9744;</button>
      <button class="epro-tb" id="epro-t-whiteout" title="Whiteout / Redact">&#9632;</button>
      <button class="epro-tb" id="epro-t-draw"     title="Freehand Draw">&#9998;</button>
      <button class="epro-tb" id="epro-t-signature" title="Add Signature">&#9999;</button>
    </div>
    <div class="epro-tsep"></div>
    <div class="epro-tg">
      <button class="epro-tb" id="epro-undo" title="Undo (Ctrl+Z)">&#8630;</button>
      <button class="epro-tb" id="epro-redo" title="Redo">&#8631;</button>
    </div>
    <div class="epro-tsep"></div>
    <div class="epro-tg">
      <button class="epro-tb" id="epro-zout">−</button>
      <span class="epro-zlbl" id="epro-zlbl">100%</span>
      <button class="epro-tb" id="epro-zin">+</button>
      <button class="epro-tb" id="epro-zfit" title="Fit page">&#x26F6;</button>
    </div>
    <div class="epro-tsep"></div>
    <div class="epro-tg">
      <button class="epro-tb" id="epro-del-el" title="Delete selected">&#128465;</button>
    </div>
    <div class="epro-flex1"></div>
    <button class="epro-tb epro-export-btn" id="epro-export">&#11123; Export PDF</button>
  </div>

  <!-- Three-panel layout -->
  <div class="epro-body">
    <!-- Left: Page thumbnails -->
    <div class="epro-thumbs" id="epro-thumbs">
      <div class="epro-thumbs-header">
        Pages <span id="epro-pgcount"></span>
      </div>
      <div class="epro-thumbs-list" id="epro-thumbs-list"></div>
      <div class="epro-thumbs-actions">
        <button class="epro-btn-sm" id="epro-add-blank">+ Blank Page</button>
      </div>
    </div>

    <!-- Center: Canvas -->
    <div class="epro-canvas-area" id="epro-canvas-area">
      <div class="epro-page-nav">
        <button class="epro-tb" id="epro-prev-page">&#8249;</button>
        <span id="epro-page-label">Page 1 of 1</span>
        <button class="epro-tb" id="epro-next-page">&#8250;</button>
      </div>
      <div class="epro-canvas-scroll" id="epro-canvas-scroll">
        <div class="epro-canvas-host" id="epro-canvas-host">
          <canvas id="epro-page-canvas" class="epro-page-canvas"></canvas>
          <canvas id="epro-draw-canvas" class="epro-draw-canvas"></canvas>
          <div class="epro-annot-layer" id="epro-annot-layer"></div>
          <div class="epro-rulers">
            <div class="epro-ruler-h" id="epro-ruler-h"></div>
            <div class="epro-ruler-v" id="epro-ruler-v"></div>
          </div>
          <div class="epro-margin-guide epro-mg-top"></div>
          <div class="epro-margin-guide epro-mg-bottom"></div>
          <div class="epro-margin-guide epro-mg-left"></div>
          <div class="epro-margin-guide epro-mg-right"></div>
          <div class="epro-loader" id="epro-loader" style="display:none">Rendering…</div>
        </div>
      </div>
    </div>

    <!-- Right: Properties -->
    <div class="epro-props" id="epro-props">
      <div class="epro-props-header">Properties</div>
      <div id="epro-props-body">
        <div class="epro-prop-hint">Select an element or choose a tool to get started.</div>
      </div>
    </div>
  </div>

  <!-- Signature modal -->
  <div class="epro-modal-bg" id="epro-sig-modal" style="display:none">
    <div class="epro-modal">
      <div class="epro-modal-header">Add Signature <button class="epro-modal-close" id="epro-sig-close">&#10005;</button></div>
      <div class="epro-sig-tabs">
        <button class="epro-sig-tab epro-on" id="epro-sig-draw-tab">Draw</button>
        <button class="epro-sig-tab" id="epro-sig-type-tab">Type</button>
        <button class="epro-sig-tab" id="epro-sig-upload-tab">Upload</button>
      </div>
      <div id="epro-sig-draw-panel">
        <canvas id="epro-sig-pad" width="400" height="160"></canvas>
        <div class="epro-sig-pad-btns">
          <button class="epro-btn-sm" id="epro-sig-clear">Clear</button>
        </div>
      </div>
      <div id="epro-sig-type-panel" style="display:none">
        <input class="epro-sig-type-input" id="epro-sig-text" placeholder="Your signature" maxlength="60">
        <div class="epro-sig-font-row">
          <select class="epro-sel-sm" id="epro-sig-font">
            <option value="cursive">Cursive</option>
            <option value="'Dancing Script',cursive">Script</option>
            <option value="monospace">Monospace</option>
            <option value="serif">Serif</option>
          </select>
          <input type="color" id="epro-sig-color" value="#1a237e" style="height:28px;width:36px;border:none;cursor:pointer">
        </div>
        <div class="epro-sig-preview" id="epro-sig-preview"></div>
      </div>
      <div id="epro-sig-upload-panel" style="display:none">
        <label class="epro-sig-upload-label" for="epro-sig-file">Click to upload signature image (PNG/JPG/SVG)</label>
        <input type="file" id="epro-sig-file" accept="image/*" style="display:none">
      </div>
      <div class="epro-modal-actions">
        <button class="epro-btn-primary" id="epro-sig-insert">Insert Signature</button>
        <button class="epro-btn-sm" id="epro-sig-cancel">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Image upload input (hidden) -->
  <input type="file" id="epro-img-file" accept="image/*" style="display:none">
  <div class="epro-status-bar" id="epro-statusbar">
    <span id="epro-sb-page">Page 1</span>
    <span class="epro-sbsep">|</span>
    <span id="epro-sb-annots">0 annotations</span>
    <span class="epro-sbsep">|</span>
    <span id="epro-sb-size">—</span>
  </div>
</div>`;
  }

  // ── Library loading ──────────────────────────────────────────────────────
  async function _loadLibs() {
    // pdf.js
    if (!window.pdfjsLib) {
      const mod = await import(PDFJS_URL);
      window.pdfjsLib = mod.default || mod;
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    }
    // pdf-lib
    if (!window.PDFLib) {
      await new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = PDFLIB_URL;
        s.onload = res; s.onerror = rej; document.head.appendChild(s);
      });
    }
  }

  // ── Page rendering ────────────────────────────────────────────────────────
  async function _renderPage(container, viewIdx) {
    _curPage = viewIdx;
    const origPageNum = _pageOrder[viewIdx - 1];
    if (!origPageNum) return;

    const loader = container.querySelector('#epro-loader');
    if (loader) loader.style.display = 'flex';

    try {
      if (_renderTask) { try { _renderTask.cancel(); } catch (_) {} }
      const page = await _pdfJs.getPage(origPageNum);
      const extraRot = _pageRotations[origPageNum] || 0;
      const totalRot = (page.rotate + extraRot) % 360;
      const viewport = page.getViewport({ scale: _renderScale * _zoom, rotation: totalRot });

      const canvas = container.querySelector('#epro-page-canvas');
      const drawC  = container.querySelector('#epro-draw-canvas');
      canvas.width  = drawC.width  = Math.floor(viewport.width);
      canvas.height = drawC.height = Math.floor(viewport.height);

      const host = container.querySelector('#epro-canvas-host');
      if (host) { host.style.width = canvas.width + 'px'; host.style.height = canvas.height + 'px'; }

      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      _renderTask = page.render({ canvasContext: ctx, viewport });
      await _renderTask.promise;
      page.cleanup();

      _updateAnnotLayer(container);
      _updatePageLabel(container, viewIdx);
      _updateStatusBar(container);
      _drawRulers(container, canvas.width, canvas.height);
      _drawMarginGuides(container, canvas.width, canvas.height);
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.warn('[EditPDFPro] render error:', e);
    } finally {
      if (loader) loader.style.display = 'none';
    }
  }

  // ── Thumbnail panel ───────────────────────────────────────────────────────
  async function _buildThumbnails(container) {
    const list = container.querySelector('#epro-thumbs-list');
    const pgcount = container.querySelector('#epro-pgcount');
    if (!list) return;
    const visibleCount = _pageOrder.filter(p => !_deletedPages.has(p)).length;
    if (pgcount) pgcount.textContent = `(${visibleCount})`;
    list.innerHTML = '';

    let viewIdx = 0;
    for (let i = 0; i < _pageOrder.length; i++) {
      const origP = _pageOrder[i];
      if (_deletedPages.has(origP)) continue;
      viewIdx++;
      const vi = viewIdx;
      const thumb = document.createElement('div');
      thumb.className = 'epro-thumb' + (vi === _curPage ? ' epro-thumb-active' : '');
      thumb.dataset.vi = vi;
      thumb.innerHTML = `
        <div class="epro-thumb-canvas-wrap">
          <canvas class="epro-thumb-canvas" id="epro-tc-${vi}" width="80" height="110"></canvas>
          <div class="epro-thumb-overlay">
            <button class="epro-thumb-act" data-act="rotate" data-vi="${vi}" title="Rotate 90°">&#8635;</button>
            <button class="epro-thumb-act" data-act="delete" data-vi="${vi}" title="Delete page">&#128465;</button>
          </div>
        </div>
        <div class="epro-thumb-label">Page ${vi}</div>`;
      thumb.addEventListener('click', e => {
        if (e.target.dataset.act) return;
        _renderPage(container, vi);
        _setActiveThumb(container, vi);
      });
      list.appendChild(thumb);
      _renderThumbAsync(container, origP, vi);
    }

    list.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const vi = parseInt(btn.dataset.vi, 10);
        if (btn.dataset.act === 'rotate') _rotatePage(container, vi);
        if (btn.dataset.act === 'delete') _deletePage(container, vi);
      });
    });

    // Drag-to-reorder thumbnails
    _wireThumbDrag(container, list);
  }

  async function _renderThumbAsync(container, origPageNum, vi) {
    try {
      const page = await _pdfJs.getPage(origPageNum);
      const extraRot = _pageRotations[origPageNum] || 0;
      const totalRot = (page.rotate + extraRot) % 360;
      const viewport = page.getViewport({ scale: 0.15, rotation: totalRot });
      const canvas = container.querySelector(`#epro-tc-${vi}`);
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
    } catch (_) {}
  }

  function _wireThumbDrag(container, list) {
    let dragVI = null;
    list.querySelectorAll('.epro-thumb').forEach(el => {
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', () => { dragVI = parseInt(el.dataset.vi, 10); el.classList.add('epro-dragging'); });
      el.addEventListener('dragend',   () => { el.classList.remove('epro-dragging'); dragVI = null; });
      el.addEventListener('dragover',  e => { e.preventDefault(); el.classList.add('epro-drop-target'); });
      el.addEventListener('dragleave', () => el.classList.remove('epro-drop-target'));
      el.addEventListener('drop', e => {
        e.preventDefault(); el.classList.remove('epro-drop-target');
        const targetVI = parseInt(el.dataset.vi, 10);
        if (dragVI === null || dragVI === targetVI) return;
        _reorderPage(container, dragVI, targetVI);
      });
    });
  }

  function _setActiveThumb(container, vi) {
    container.querySelectorAll('.epro-thumb').forEach(t => t.classList.remove('epro-thumb-active'));
    const active = container.querySelector(`.epro-thumb[data-vi="${vi}"]`);
    if (active) { active.classList.add('epro-thumb-active'); active.scrollIntoView({ block: 'nearest' }); }
  }

  // ── Page actions ──────────────────────────────────────────────────────────
  function _rotatePage(container, vi) {
    const origP = _getOrigPage(vi);
    if (!origP) return;
    _pageRotations[origP] = ((_pageRotations[origP] || 0) + 90) % 360;
    _buildThumbnails(container);
    if (_curPage === vi) _renderPage(container, vi);
  }

  function _deletePage(container, vi) {
    const totalVisible = _pageOrder.filter(p => !_deletedPages.has(p)).length;
    if (totalVisible <= 1) { alert('Cannot delete the last page.'); return; }
    const origP = _getOrigPage(vi);
    if (origP) _deletedPages.add(origP);
    const newCur = vi > 1 ? vi - 1 : 1;
    _buildThumbnails(container);
    _renderPage(container, newCur);
    _setActiveThumb(container, newCur);
  }

  function _reorderPage(container, fromVI, toVI) {
    const visiblePages = _pageOrder.filter(p => !_deletedPages.has(p));
    const moved = visiblePages.splice(fromVI - 1, 1)[0];
    visiblePages.splice(toVI - 1, 0, moved);
    // Rebuild _pageOrder maintaining deleted pages at their relative positions
    _pageOrder = visiblePages;
    _buildThumbnails(container);
    _renderPage(container, toVI);
    _setActiveThumb(container, toVI);
  }

  function _addBlankPage(container) {
    // Track as a "blank" synthetic page
    _pageOrder.push(-(_pageOrder.length + 1)); // negative = blank
    _buildThumbnails(container);
  }

  function _getOrigPage(vi) {
    let count = 0;
    for (const p of _pageOrder) {
      if (_deletedPages.has(p)) continue;
      count++;
      if (count === vi) return p;
    }
    return null;
  }

  // ── Wire toolbar buttons ──────────────────────────────────────────────────
  function _wireToolbar(container) {
    const tools = ['select','text','image','highlight','whiteout','draw','signature'];
    tools.forEach(t => {
      const btn = container.querySelector(`#epro-t-${t}`);
      if (btn) btn.addEventListener('click', () => _setTool(container, t));
    });

    _b(container, '#epro-undo', () => _undo(container));
    _b(container, '#epro-redo', () => _redo(container));
    _b(container, '#epro-zin',  () => { _zoom = Math.min(5, _zoom * 1.2); _applyZoom(container); });
    _b(container, '#epro-zout', () => { _zoom = Math.max(0.2, _zoom * 0.83); _applyZoom(container); });
    _b(container, '#epro-zfit', () => _fitZoom(container));
    _b(container, '#epro-del-el', () => _deleteSelected(container));
    _b(container, '#epro-export', () => _exportPdf(container));

    _wirePageActions(container);
    _wireSigModal(container);
    _wireImageUpload(container);

    // Keyboard shortcuts
    window.addEventListener('keydown', e => {
      if (e.target.matches('input,textarea,select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); _undo(container); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); _redo(container); }
      if (e.key === 'Delete' || e.key === 'Backspace') _deleteSelected(container);
      if (e.key === 'Escape') { _selId = null; _updateAnnotLayer(container); _showDefaultProps(container); }
    });
  }

  function _wirePageActions(container) {
    _b(container, '#epro-prev-page', () => {
      const visible = _pageOrder.filter(p => !_deletedPages.has(p)).length;
      if (_curPage > 1) { _renderPage(container, _curPage - 1); _setActiveThumb(container, _curPage); }
    });
    _b(container, '#epro-next-page', () => {
      const visible = _pageOrder.filter(p => !_deletedPages.has(p)).length;
      if (_curPage < visible) { _renderPage(container, _curPage + 1); _setActiveThumb(container, _curPage); }
    });
    _b(container, '#epro-add-blank', () => _addBlankPage(container));
  }

  // ── Tool selection ────────────────────────────────────────────────────────
  function _setTool(container, tool) {
    _activeTool = tool;
    container.querySelectorAll('.epro-tools .epro-tb').forEach(b => b.classList.remove('epro-on'));
    const btn = container.querySelector(`#epro-t-${tool}`);
    if (btn) btn.classList.add('epro-on');
    const host = container.querySelector('#epro-canvas-host');
    if (host) {
      host.style.cursor = tool === 'select' ? 'default'
        : tool === 'text' ? 'text'
        : tool === 'draw' ? 'crosshair'
        : 'crosshair';
    }
    if (tool === 'signature') { _openSigModal(container); _setTool(container, 'select'); }
    if (tool === 'image') {
      container.querySelector('#epro-img-file')?.click();
      setTimeout(() => _setTool(container, 'select'), 100);
    }
    if (tool !== 'select') { _selId = null; _updateAnnotLayer(container); }
  }

  // ── Canvas click → add annotation ────────────────────────────────────────
  function _wireCanvas(container) {
    const host = container.querySelector('#epro-canvas-host');
    const drawC = container.querySelector('#epro-draw-canvas');
    if (!host) return;

    host.addEventListener('click', e => {
      if (e.target.closest('.epro-annot')) return;
      if (_activeTool === 'select') { _selId = null; _updateAnnotLayer(container); _showDefaultProps(container); return; }
      const { x, y } = _hostCoords(e, host);
      _handleCanvasClick(container, x, y);
    });

    // Freehand draw
    let drawCtx = null;
    let drawPts = [];
    drawC.addEventListener('mousedown', e => {
      if (_activeTool !== 'draw') return;
      drawCtx = drawC.getContext('2d');
      drawPts = [_hostCoords(e, host)];
      drawCtx.clearRect(0, 0, drawC.width, drawC.height);
      drawCtx.strokeStyle = '#e53e3e';
      drawCtx.lineWidth = 2;
      drawCtx.lineCap = 'round';
      drawCtx.beginPath();
      drawCtx.moveTo(drawPts[0].x, drawPts[0].y);
    });
    drawC.addEventListener('mousemove', e => {
      if (_activeTool !== 'draw' || !drawCtx || !drawPts.length) return;
      const pt = _hostCoords(e, host);
      drawPts.push(pt);
      drawCtx.lineTo(pt.x, pt.y);
      drawCtx.stroke();
    });
    drawC.addEventListener('mouseup', e => {
      if (_activeTool !== 'draw' || !drawPts.length) return;
      _pushUndo();
      // Capture the draw canvas as an image annotation
      const bounds = _getBounds(drawPts);
      const imgData = drawC.toDataURL('image/png');
      _annotations.push({ id: ++_nextId, page: _curPage, type: 'draw-img', x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, content: imgData, style: {} });
      drawCtx.clearRect(0, 0, drawC.width, drawC.height);
      drawPts = [];
      _updateAnnotLayer(container);
      _updateStatusBar(container);
    });

    // Scroll to zoom
    const scroll = container.querySelector('#epro-canvas-scroll');
    if (scroll) {
      scroll.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        _zoom = Math.max(0.2, Math.min(5, _zoom * (e.deltaY < 0 ? 1.12 : 0.89)));
        _applyZoom(container);
      }, { passive: false });
    }
  }

  function _getBounds(pts) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(10, Math.max(...xs) - x), h: Math.max(10, Math.max(...ys) - y) };
  }

  function _hostCoords(e, host) {
    const r = host.getBoundingClientRect();
    return { x: (e.clientX - r.left) / _zoom, y: (e.clientY - r.top) / _zoom };
  }

  function _handleCanvasClick(container, x, y) {
    _pushUndo();
    if (_activeTool === 'text') {
      const a = { id: ++_nextId, page: _curPage, type: 'text', x, y, w: 200, h: 40, content: 'Double-click to edit', style: { fontSize: 16, fontFamily: 'Arial', color: '#000', bold: false, italic: false, underline: false, align: 'left', opacity: 1, bgColor: 'transparent' } };
      _annotations.push(a);
      _selId = a.id;
    } else if (_activeTool === 'highlight') {
      _annotations.push({ id: ++_nextId, page: _curPage, type: 'highlight', x: x - 60, y: y - 10, w: 120, h: 22, content: '', style: { color: '#ffff00', opacity: 0.45 } });
    } else if (_activeTool === 'whiteout') {
      _annotations.push({ id: ++_nextId, page: _curPage, type: 'whiteout', x: x - 60, y: y - 10, w: 120, h: 22, content: '', style: { color: '#ffffff', opacity: 1 } });
    }
    _updateAnnotLayer(container);
    _updateStatusBar(container);
    if (_selId) _showPropsForAnnot(container, _selId);
  }

  // ── Annotation layer ──────────────────────────────────────────────────────
  function _updateAnnotLayer(container) {
    const layer = container.querySelector('#epro-annot-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const pageAnnots = _annotations.filter(a => a.page === _curPage);

    pageAnnots.forEach(a => {
      const el = document.createElement('div');
      el.className = 'epro-annot' + (a.id === _selId ? ' epro-sel' : '');
      el.dataset.id = a.id;
      el.style.cssText = `left:${a.x * _zoom}px;top:${a.y * _zoom}px;width:${a.w * _zoom}px;height:${a.h * _zoom}px;position:absolute;`;

      if (a.type === 'text') {
        el.style.cursor = 'move';
        el.style.fontFamily = a.style.fontFamily || 'Arial';
        el.style.fontSize   = (a.style.fontSize || 16) * _zoom + 'px';
        el.style.color      = a.style.color || '#000';
        el.style.fontWeight = a.style.bold ? 'bold' : 'normal';
        el.style.fontStyle  = a.style.italic ? 'italic' : 'normal';
        el.style.textDecoration = a.style.underline ? 'underline' : 'none';
        el.style.textAlign  = a.style.align || 'left';
        el.style.opacity    = a.style.opacity || 1;
        el.style.background = a.style.bgColor || 'transparent';
        el.style.padding    = '2px 4px';
        el.style.whiteSpace = 'pre-wrap';
        el.style.boxSizing  = 'border-box';
        el.textContent = a.content;
        el.addEventListener('dblclick', () => _startTextEdit(container, a.id, el));
      } else if (a.type === 'highlight' || a.type === 'whiteout') {
        el.style.background = a.style.color || '#ffff00';
        el.style.opacity    = a.style.opacity || 0.45;
        el.style.cursor     = 'move';
        el.style.pointerEvents = 'all';
      } else if (a.type === 'image' || a.type === 'signature' || a.type === 'draw-img') {
        const img = document.createElement('img');
        img.src = a.content;
        img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'contain';
        img.style.opacity = a.style.opacity || 1;
        if (a.style.borderRadius) img.style.borderRadius = a.style.borderRadius + 'px';
        el.appendChild(img);
        el.style.cursor = 'move';
      }

      // Resize handles (when selected)
      if (a.id === _selId) {
        ['nw','ne','se','sw','n','s','e','w'].forEach(h => {
          const dot = document.createElement('div');
          dot.className = `epro-handle epro-handle-${h}`;
          dot.dataset.handle = h;
          dot.addEventListener('mousedown', ev => { ev.stopPropagation(); _startResize(container, a.id, h, ev); });
          el.appendChild(dot);
        });
      }

      el.addEventListener('mousedown', ev => {
        if (ev.target.dataset.handle) return;
        _selId = a.id;
        _updateAnnotLayer(container);
        _showPropsForAnnot(container, a.id);
        _startDrag(container, a.id, ev);
      });

      layer.appendChild(el);
    });
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  function _startDrag(container, id, e) {
    const a = _annotations.find(x => x.id === id);
    if (!a) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = a.x, origY = a.y;
    const onMove = ev => {
      a.x = origX + (ev.clientX - startX) / _zoom;
      a.y = origY + (ev.clientY - startY) / _zoom;
      _updateAnnotLayer(container);
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function _startResize(container, id, handle, e) {
    const a = _annotations.find(x => x.id === id);
    if (!a) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = a.x, origY = a.y, origW = a.w, origH = a.h;
    const onMove = ev => {
      const dx = (ev.clientX - startX) / _zoom;
      const dy = (ev.clientY - startY) / _zoom;
      if (handle.includes('e')) a.w = Math.max(20, origW + dx);
      if (handle.includes('s')) a.h = Math.max(10, origH + dy);
      if (handle.includes('w')) { a.x = origX + dx; a.w = Math.max(20, origW - dx); }
      if (handle.includes('n')) { a.y = origY + dy; a.h = Math.max(10, origH - dy); }
      _updateAnnotLayer(container);
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── Inline text editing ───────────────────────────────────────────────────
  function _startTextEdit(container, id, el) {
    const a = _annotations.find(x => x.id === id);
    if (!a) return;
    const ta = document.createElement('textarea');
    ta.value = a.content;
    ta.style.cssText = `width:100%;height:100%;border:none;outline:none;resize:none;background:transparent;font-family:${a.style.fontFamily||'Arial'};font-size:${(a.style.fontSize||16)*_zoom}px;color:${a.style.color||'#000'};font-weight:${a.style.bold?'bold':'normal'};font-style:${a.style.italic?'italic':'normal'};padding:2px 4px;box-sizing:border-box;`;
    el.innerHTML = '';
    el.appendChild(ta);
    ta.focus(); ta.select();
    const commit = () => { a.content = ta.value; _updateAnnotLayer(container); };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', e => { if (e.key === 'Escape') { a.content = ta.value; _updateAnnotLayer(container); } });
  }

  // ── Properties panel ──────────────────────────────────────────────────────
  function _showPropsForAnnot(container, id) {
    const a = _annotations.find(x => x.id === id);
    const body = container.querySelector('#epro-props-body');
    if (!a || !body) return;

    if (a.type === 'text') {
      body.innerHTML = `
        <div class="epro-prop-group"><label>Content</label>
          <textarea class="epro-prop-ta" id="pp-content" rows="3">${_esc(a.content)}</textarea></div>
        <div class="epro-prop-group"><label>Font</label>
          <select class="epro-prop-sel" id="pp-font">
            ${['Arial','Georgia','Times New Roman','Courier New','Verdana','Helvetica'].map(f=>`<option${a.style.fontFamily===f?' selected':''}>${f}</option>`).join('')}
          </select></div>
        <div class="epro-prop-group epro-prop-row"><label>Size</label><input type="number" class="epro-prop-num" id="pp-size" value="${a.style.fontSize||16}" min="6" max="120"></div>
        <div class="epro-prop-group epro-prop-row"><label>Color</label><input type="color" id="pp-color" value="${a.style.color||'#000000'}"></div>
        <div class="epro-prop-group epro-prop-row"><label>Bg</label><input type="color" id="pp-bg" value="${a.style.bgColor&&a.style.bgColor!=='transparent'?a.style.bgColor:'#ffffff'}"><label style="margin-left:6px"><input type="checkbox" id="pp-bg-none" ${a.style.bgColor==='transparent'?'checked':''}> None</label></div>
        <div class="epro-prop-group epro-prop-row">
          <label><input type="checkbox" id="pp-bold" ${a.style.bold?'checked':''}> B</label>
          <label><input type="checkbox" id="pp-italic" ${a.style.italic?'checked':''}> I</label>
          <label><input type="checkbox" id="pp-underline" ${a.style.underline?'checked':''}> U</label>
        </div>
        <div class="epro-prop-group"><label>Align</label>
          <select class="epro-prop-sel" id="pp-align">
            <option value="left" ${a.style.align==='left'?'selected':''}>Left</option>
            <option value="center" ${a.style.align==='center'?'selected':''}>Center</option>
            <option value="right" ${a.style.align==='right'?'selected':''}>Right</option>
          </select></div>
        <div class="epro-prop-group epro-prop-row"><label>Opacity</label><input type="range" id="pp-opacity" min="0.1" max="1" step="0.05" value="${a.style.opacity||1}"> <span id="pp-ov">${Math.round((a.style.opacity||1)*100)}%</span></div>
        <button class="epro-btn-sm" style="margin-top:8px;width:100%;background:#ef4444;color:#fff" id="pp-del">Delete</button>`;

      const update = () => {
        const fv  = body.querySelector('#pp-font');
        const sv  = body.querySelector('#pp-size');
        const cv  = body.querySelector('#pp-color');
        const bgv = body.querySelector('#pp-bg');
        const bgn = body.querySelector('#pp-bg-none');
        const blv = body.querySelector('#pp-bold');
        const iv  = body.querySelector('#pp-italic');
        const uv  = body.querySelector('#pp-underline');
        const alv = body.querySelector('#pp-align');
        const opv = body.querySelector('#pp-opacity');
        const cov = body.querySelector('#pp-content');
        if (cov) a.content = cov.value;
        if (fv)  a.style.fontFamily = fv.value;
        if (sv)  a.style.fontSize = parseInt(sv.value, 10);
        if (cv)  a.style.color = cv.value;
        if (bgn) a.style.bgColor = bgn.checked ? 'transparent' : (bgv ? bgv.value : 'transparent');
        if (blv) a.style.bold = blv.checked;
        if (iv)  a.style.italic = iv.checked;
        if (uv)  a.style.underline = uv.checked;
        if (alv) a.style.align = alv.value;
        if (opv) { a.style.opacity = parseFloat(opv.value); const ov = body.querySelector('#pp-ov'); if (ov) ov.textContent = Math.round(a.style.opacity*100)+'%'; }
        _updateAnnotLayer(container);
      };
      body.querySelectorAll('input,select,textarea').forEach(el => el.addEventListener('input', update));
      _b(body, '#pp-del', () => { _deleteSelected(container); _showDefaultProps(container); });
    } else if (a.type === 'highlight' || a.type === 'whiteout') {
      body.innerHTML = `
        <div class="epro-prop-group epro-prop-row"><label>Color</label><input type="color" id="pp-color" value="${a.style.color||'#ffff00'}"></div>
        <div class="epro-prop-group epro-prop-row"><label>Opacity</label><input type="range" id="pp-opacity" min="0.05" max="1" step="0.05" value="${a.style.opacity||0.45}"> <span id="pp-ov">${Math.round((a.style.opacity||0.45)*100)}%</span></div>
        <button class="epro-btn-sm" style="margin-top:8px;width:100%;background:#ef4444;color:#fff" id="pp-del">Delete</button>`;
      body.querySelector('#pp-color')?.addEventListener('input', e => { a.style.color = e.target.value; _updateAnnotLayer(container); });
      body.querySelector('#pp-opacity')?.addEventListener('input', e => { a.style.opacity = parseFloat(e.target.value); const ov = body.querySelector('#pp-ov'); if (ov) ov.textContent = Math.round(a.style.opacity*100)+'%'; _updateAnnotLayer(container); });
      _b(body, '#pp-del', () => { _deleteSelected(container); _showDefaultProps(container); });
    } else if (a.type === 'image' || a.type === 'signature') {
      body.innerHTML = `
        <div class="epro-prop-group epro-prop-row"><label>Opacity</label><input type="range" id="pp-opacity" min="0.1" max="1" step="0.05" value="${a.style.opacity||1}"> <span id="pp-ov">${Math.round((a.style.opacity||1)*100)}%</span></div>
        <div class="epro-prop-group epro-prop-row"><label>Radius</label><input type="range" id="pp-radius" min="0" max="50" value="${a.style.borderRadius||0}"> <span id="pp-rv">${a.style.borderRadius||0}px</span></div>
        <button class="epro-btn-sm" style="margin-top:8px;width:100%;background:#ef4444;color:#fff" id="pp-del">Delete</button>`;
      body.querySelector('#pp-opacity')?.addEventListener('input', e => { a.style.opacity = parseFloat(e.target.value); const ov = body.querySelector('#pp-ov'); if (ov) ov.textContent = Math.round(a.style.opacity*100)+'%'; _updateAnnotLayer(container); });
      body.querySelector('#pp-radius')?.addEventListener('input',  e => { a.style.borderRadius = parseInt(e.target.value,10); const rv = body.querySelector('#pp-rv'); if (rv) rv.textContent = a.style.borderRadius+'px'; _updateAnnotLayer(container); });
      _b(body, '#pp-del', () => { _deleteSelected(container); _showDefaultProps(container); });
    } else {
      _showDefaultProps(container);
    }
  }

  function _showDefaultProps(container) {
    const body = container.querySelector('#epro-props-body');
    if (body) body.innerHTML = '<div class="epro-prop-hint">Select an element to edit its properties.</div>';
  }

  // ── Delete selected ───────────────────────────────────────────────────────
  function _deleteSelected(container) {
    if (_selId === null) return;
    _pushUndo();
    _annotations = _annotations.filter(a => a.id !== _selId);
    _selId = null;
    _updateAnnotLayer(container);
    _updateStatusBar(container);
    _showDefaultProps(container);
  }

  // ── Signature modal ───────────────────────────────────────────────────────
  function _openSigModal(container) {
    const modal = container.querySelector('#epro-sig-modal');
    if (modal) modal.style.display = 'flex';
    setTimeout(() => _initSigPad(container), 50);
  }

  function _initSigPad(container) {
    const pad = container.querySelector('#epro-sig-pad');
    if (!pad) return;
    _sigPadCtx = pad.getContext('2d');
    _sigPadCtx.strokeStyle = '#1a237e';
    _sigPadCtx.lineWidth = 2.5;
    _sigPadCtx.lineCap = 'round';
    _sigPadCtx.lineJoin = 'round';
    _sigPadDrawing = false;
    _sigPoints = [];

    pad.onmousedown = e => { _sigPadDrawing = true; const p = _padCoords(e, pad); _sigPadCtx.beginPath(); _sigPadCtx.moveTo(p.x, p.y); _sigPoints = [p]; };
    pad.onmousemove = e => {
      if (!_sigPadDrawing) return;
      const p = _padCoords(e, pad);
      _sigPoints.push(p);
      if (_sigPoints.length > 2) {
        const prev = _sigPoints[_sigPoints.length - 2];
        _sigPadCtx.quadraticCurveTo(prev.x, prev.y, (prev.x + p.x) / 2, (prev.y + p.y) / 2);
        _sigPadCtx.stroke();
      }
    };
    pad.onmouseup = pad.onmouseleave = () => { _sigPadDrawing = false; };

    // Touch
    pad.ontouchstart = e => { e.preventDefault(); const p = _padCoordsTouch(e, pad); _sigPadCtx.beginPath(); _sigPadCtx.moveTo(p.x, p.y); _sigPadDrawing = true; _sigPoints = [p]; };
    pad.ontouchmove  = e => { e.preventDefault(); if (!_sigPadDrawing) return; const p = _padCoordsTouch(e, pad); _sigPoints.push(p); if (_sigPoints.length > 2) { const prev = _sigPoints[_sigPoints.length-2]; _sigPadCtx.quadraticCurveTo(prev.x, prev.y, (prev.x+p.x)/2, (prev.y+p.y)/2); _sigPadCtx.stroke(); } };
    pad.ontouchend   = () => { _sigPadDrawing = false; };
  }

  function _padCoords(e, pad) { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function _padCoordsTouch(e, pad) { const r = pad.getBoundingClientRect(); return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top }; }

  function _wireSigModal(container) {
    _b(container, '#epro-sig-close',  () => { container.querySelector('#epro-sig-modal').style.display = 'none'; });
    _b(container, '#epro-sig-cancel', () => { container.querySelector('#epro-sig-modal').style.display = 'none'; });
    _b(container, '#epro-sig-clear',  () => { const pad = container.querySelector('#epro-sig-pad'); if (pad) { pad.getContext('2d').clearRect(0,0,pad.width,pad.height); _sigPoints = []; } });

    // Tab switching
    ['draw','type','upload'].forEach(tab => {
      _b(container, `#epro-sig-${tab}-tab`, () => {
        container.querySelectorAll('.epro-sig-tab').forEach(t => t.classList.remove('epro-on'));
        container.querySelector(`#epro-sig-${tab}-tab`)?.classList.add('epro-on');
        ['draw','type','upload'].forEach(p => { const el = container.querySelector(`#epro-sig-${p}-panel`); if (el) el.style.display = p === tab ? 'block' : 'none'; });
      });
    });

    // Type signature preview
    const typeInput = container.querySelector('#epro-sig-text');
    const fontSel   = container.querySelector('#epro-sig-font');
    const colorIn   = container.querySelector('#epro-sig-color');
    const preview   = container.querySelector('#epro-sig-preview');
    const updateTypePreview = () => {
      if (!preview || !typeInput) return;
      preview.textContent = typeInput.value || 'Your Signature';
      preview.style.fontFamily = fontSel ? fontSel.value : 'cursive';
      preview.style.color = colorIn ? colorIn.value : '#1a237e';
    };
    [typeInput, fontSel, colorIn].forEach(el => el && el.addEventListener('input', updateTypePreview));

    // Upload
    const sigFile = container.querySelector('#epro-sig-file');
    const uploadLabel = container.querySelector('.epro-sig-upload-label');
    if (uploadLabel && sigFile) uploadLabel.addEventListener('click', () => sigFile.click());
    if (sigFile) sigFile.addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      const url = await _fileToDataUrl(f);
      _insertImageAnnot(container, url, 'signature');
      container.querySelector('#epro-sig-modal').style.display = 'none';
    });

    // Insert button
    _b(container, '#epro-sig-insert', () => {
      const activeTab = container.querySelector('.epro-sig-tab.epro-on')?.id || 'epro-sig-draw-tab';
      if (activeTab === 'epro-sig-draw-tab') {
        const pad = container.querySelector('#epro-sig-pad');
        if (!pad || !_sigPoints.length) { alert('Please draw your signature first.'); return; }
        const dataUrl = pad.toDataURL('image/png');
        _insertImageAnnot(container, dataUrl, 'signature');
      } else if (activeTab === 'epro-sig-type-tab') {
        const text  = container.querySelector('#epro-sig-text')?.value.trim();
        if (!text) { alert('Please type your signature.'); return; }
        const font  = container.querySelector('#epro-sig-font')?.value || 'cursive';
        const color = container.querySelector('#epro-sig-color')?.value || '#1a237e';
        // Render typed signature to canvas
        const tc = document.createElement('canvas'); tc.width = 300; tc.height = 80;
        const tctx = tc.getContext('2d');
        tctx.font = `italic 40px ${font}`;
        tctx.fillStyle = color;
        tctx.fillText(text, 10, 55);
        _insertImageAnnot(container, tc.toDataURL('image/png'), 'signature');
      }
      container.querySelector('#epro-sig-modal').style.display = 'none';
    });
  }

  function _insertImageAnnot(container, dataUrl, type) {
    _pushUndo();
    const canvas = container.querySelector('#epro-page-canvas');
    const cx = canvas ? canvas.width / 2 / _zoom : 200;
    const cy = canvas ? canvas.height / 2 / _zoom : 200;
    _annotations.push({ id: ++_nextId, page: _curPage, type, x: cx - 100, y: cy - 40, w: 200, h: 80, content: dataUrl, style: { opacity: 1 } });
    _selId = _nextId;
    _updateAnnotLayer(container);
    _updateStatusBar(container);
  }

  // ── Image insertion ───────────────────────────────────────────────────────
  function _wireImageUpload(container) {
    const inp = container.querySelector('#epro-img-file');
    if (!inp) return;
    inp.addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      const url = await _fileToDataUrl(f);
      _insertImageAnnot(container, url, 'image');
      inp.value = '';
    });
  }

  function _fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = e => res(e.target.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  function _applyZoom(container) {
    const lbl = container.querySelector('#epro-zlbl');
    if (lbl) lbl.textContent = Math.round(_zoom * 100) + '%';
    _renderPage(container, _curPage);
  }

  function _fitZoom(container) {
    const scroll = container.querySelector('#epro-canvas-scroll');
    const canvas = container.querySelector('#epro-page-canvas');
    if (!scroll || !canvas) return;
    const sw = scroll.clientWidth - 32;
    if (sw > 0 && canvas.width > 0) {
      _zoom = Math.min(sw / (canvas.width / _zoom), 1.5);
      _applyZoom(container);
    }
  }

  // ── Undo/redo ──────────────────────────────────────────────────────────────
  function _pushUndo() {
    _undoStack.push(JSON.parse(JSON.stringify(_annotations)));
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    _redoStack = [];
  }

  function _undo(container) {
    if (_undoStack.length < 2) return;
    _redoStack.push(_undoStack.pop());
    _annotations = JSON.parse(JSON.stringify(_undoStack[_undoStack.length - 1]));
    _selId = null;
    _updateAnnotLayer(container);
    _updateStatusBar(container);
    _showDefaultProps(container);
  }

  function _redo(container) {
    if (!_redoStack.length) return;
    const state = _redoStack.pop();
    _undoStack.push(state);
    _annotations = JSON.parse(JSON.stringify(state));
    _selId = null;
    _updateAnnotLayer(container);
    _updateStatusBar(container);
  }

  // ── Rulers & guides ────────────────────────────────────────────────────────
  function _drawRulers(container, W, H) {
    const rh = container.querySelector('#epro-ruler-h');
    const rv = container.querySelector('#epro-ruler-v');
    if (rh) { rh.style.width = W + 'px'; }
    if (rv) { rv.style.height = H + 'px'; }
  }

  function _drawMarginGuides(container, W, H) {
    const margin = 40 * _zoom;
    const set = (sel, style) => { const el = container.querySelector(sel); if (el) Object.assign(el.style, style); };
    set('.epro-mg-top',    { top: margin+'px', left: 0, right: 0, height: '1px', position: 'absolute' });
    set('.epro-mg-bottom', { bottom: margin+'px', left: 0, right: 0, height: '1px', position: 'absolute' });
    set('.epro-mg-left',   { left: margin+'px', top: 0, bottom: 0, width: '1px', position: 'absolute' });
    set('.epro-mg-right',  { right: margin+'px', top: 0, bottom: 0, width: '1px', position: 'absolute' });
  }

  // ── Status / page labels ──────────────────────────────────────────────────
  function _updatePageLabel(container, vi) {
    const visible = _pageOrder.filter(p => !_deletedPages.has(p)).length;
    const lbl = container.querySelector('#epro-page-label');
    if (lbl) lbl.textContent = `Page ${vi} of ${visible}`;
    const sb = container.querySelector('#epro-sb-page');
    if (sb) sb.textContent = `Page ${vi}`;
    _setActiveThumb(container, vi);
  }

  function _updateStatusBar(container) {
    const visCount = _pageOrder.filter(p => !_deletedPages.has(p)).length;
    const annotCount = _annotations.length;
    const sbA = container.querySelector('#epro-sb-annots');
    if (sbA) sbA.textContent = `${annotCount} annotation${annotCount !== 1 ? 's' : ''}`;
    const pgc = container.querySelector('#epro-pgcount');
    if (pgc) pgc.textContent = `(${visCount})`;
  }

  // ── Export PDF ────────────────────────────────────────────────────────────
  async function _exportPdf(container) {
    const btn = container.querySelector('#epro-export');
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }

    // Validation
    const visiblePages = _pageOrder.filter(p => !_deletedPages.has(p));
    if (visiblePages.length === 0) {
      alert('No pages remaining. Please keep at least one page.'); 
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Export PDF'; }
      return;
    }

    try {
      if (!window.PDFLib) await _loadLibs();
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;

      const srcDoc = await PDFDocument.load(_fileBytes, { ignoreEncryption: true });
      const outDoc = await PDFDocument.create();

      // Copy pages in the new order (skip deleted)
      for (const origP of visiblePages) {
        if (origP < 0) {
          // Blank page — use standard A4 size
          outDoc.addPage([595, 842]);
          continue;
        }
        const [copied] = await outDoc.copyPages(srcDoc, [origP - 1]);
        const extraRot = _pageRotations[origP] || 0;
        if (extraRot !== 0) {
          const { degrees } = window.PDFLib;
          copied.setRotation(degrees((copied.getRotation().angle + extraRot) % 360));
        }
        outDoc.addPage(copied);
      }

      // Bake annotations onto each page
      const font      = await outDoc.embedFont(StandardFonts.Helvetica);
      const fontBold  = await outDoc.embedFont(StandardFonts.HelveticaBold);

      // Map view-index → out-doc page index
      for (let vi = 1; vi <= visiblePages.length; vi++) {
        const page = outDoc.getPages()[vi - 1];
        if (!page) continue;
        const { width: pw, height: ph } = page.getSize();

        // Get page-canvas dimensions for coordinate mapping
        const annots = _annotations.filter(a => a.page === vi);
        if (!annots.length) continue;

        // We need to know what rendered canvas size was used for this page
        // Approximate using pdf.js viewport (renderScale * zoom) — or use actual canvas
        const canvas = container.querySelector('#epro-page-canvas');
        const cw = canvas && _curPage === vi ? canvas.width : pw * _renderScale * _zoom;
        const ch = canvas && _curPage === vi ? canvas.height : ph * _renderScale * _zoom;
        const scaleX = pw / cw;
        const scaleY = ph / ch;

        for (const a of annots) {
          // Convert canvas coords to PDF coords (PDF origin is bottom-left)
          const px = a.x * _zoom * scaleX;
          const py = ph - (a.y + a.h) * _zoom * scaleY;
          const pw2 = a.w * _zoom * scaleX;
          const ph2 = a.h * _zoom * scaleY;

          if (a.type === 'text') {
            const s = a.style;
            const fs = Math.max(6, Math.min(96, (s.fontSize || 14)));
            const hexToRgb = hex => { const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255; return rgb(r,g,b); };
            const col = _isValidHex(s.color) ? hexToRgb(s.color) : rgb(0,0,0);
            const useFont = s.bold ? fontBold : font;
            // Bg rect
            if (s.bgColor && s.bgColor !== 'transparent' && _isValidHex(s.bgColor)) {
              page.drawRectangle({ x: px, y: py, width: pw2, height: ph2, color: hexToRgb(s.bgColor), opacity: s.opacity || 1 });
            }
            // Text — pdf-lib only supports single-line; split on newlines
            const lines = (a.content || '').split('\n');
            const lineH = fs * 1.4;
            lines.forEach((line, li) => {
              const ty = py + ph2 - fs - li * lineH;
              if (ty < 0) return;
              try {
                page.drawText(line || ' ', { x: px + 2, y: ty, size: fs, font: useFont, color: col, opacity: s.opacity || 1, maxWidth: pw2 });
              } catch (_) {}
            });
          } else if (a.type === 'highlight') {
            const col = _hexToRgbArr(a.style.color || '#ffff00');
            page.drawRectangle({ x: px, y: py, width: pw2, height: ph2, color: rgb(...col), opacity: a.style.opacity || 0.45 });
          } else if (a.type === 'whiteout') {
            page.drawRectangle({ x: px, y: py, width: pw2, height: ph2, color: rgb(1,1,1), opacity: 1 });
          } else if (a.type === 'image' || a.type === 'signature' || a.type === 'draw-img') {
            try {
              const dataUrl = a.content;
              const isPng = dataUrl.includes('image/png') || dataUrl.includes('data:image/svg');
              const imgData = _dataUrlToBytes(dataUrl);
              const embedded = isPng ? await outDoc.embedPng(imgData) : await outDoc.embedJpg(imgData);
              page.drawImage(embedded, { x: px, y: py, width: pw2, height: Math.abs(ph2), opacity: a.style.opacity || 1 });
            } catch (_) {}
          }
        }
      }

      const bytes = await outDoc.save({ useObjectStreams: true });
      const blob = new Blob([bytes], { type: 'application/pdf' });

      // Validation
      if (!blob || blob.size < 500) throw new Error('Export produced an empty or corrupt PDF.');

      const fname = 'ILovePDF-' + (_file.name.replace(/\.[^.]+$/, '') || 'edited') + '.pdf';
      if (_onResult) _onResult(blob, fname, 'application/pdf');
      else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (e) {
      alert('Export failed: ' + (e.message || 'Unknown error'));
      console.error('[EditPDFPro] export error:', e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Export PDF'; }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _b(c, sel, fn) { const el = typeof c.querySelector === 'function' ? c.querySelector(sel) : document.querySelector(sel); if (el) el.addEventListener('click', fn); }
  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _isValidHex(s) { return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s); }
  function _hexToRgbArr(hex) {
    if (!_isValidHex(hex)) return [0, 0, 0];
    return [parseInt(hex.slice(1,3),16)/255, parseInt(hex.slice(3,5),16)/255, parseInt(hex.slice(5,7),16)/255];
  }
  function _dataUrlToBytes(dataUrl) {
    const b64 = dataUrl.split(',')[1] || '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function _showLoader(container, msg) { const h = container.querySelector('#epro-loader'); if (h) { h.style.display = 'flex'; h.textContent = msg || 'Loading…'; } }
  function _hideLoader(container) { const h = container.querySelector('#epro-loader'); if (h) h.style.display = 'none'; }
  function _reset() { _pdfJs = null; _pdfDoc = null; _fileBytes = null; _pageCount = 0; _pageOrder = []; _pageRotations = {}; _deletedPages = new Set(); _curPage = 1; _zoom = 1; _annotations = []; _selId = null; _nextId = 0; _undoStack = []; _redoStack = []; _activeTool = 'select'; }

  // ── Expose ─────────────────────────────────────────────────────────────────
  window.EditPdfPro = { mount };
})();

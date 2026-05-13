// Page-level Organize UI for single-PDF tools.
// v2.0 — Final Stabilization
//
// Key hardening in v2.0:
//   • Per-tile render state machine (idle→queued→rendering→rendered→failed→retrying)
//   • Per-render cancellation token — old tokens flipped on grid re-render
//   • Retry failed tiles up to 3 times (handled by PdfPreview v3.0)
//   • Thumbnail cache validation before use (checks image decodes)
//   • Spinner shown during render; fallback placeholder shown after all retries
//   • PdfPreview.invalidateSession() called on destroy
//   • Bounded thumbCache (max 200 entries, FIFO eviction)
(function () {
  const PAGE_LEVEL_TOOLS = new Set([
    'split', 'rotate', 'organize', 'crop', 'page-numbers',
    'watermark', 'sign', 'redact', 'ocr',
    'ai-summarize', 'translate', 'repair', 'edit',
  ]);

  function shouldHandle(toolId, files) {
    if (!toolId || !files || files.length !== 1) return false;
    if (!PAGE_LEVEL_TOOLS.has(toolId)) return false;
    const f = files[0];
    return /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  }

  // ── pdf-lib ──────────────────────────────────────────────────────────────
  async function loadPdfLib() {
    if (window.PDFLib) return window.PDFLib;
    if (window.BrowserTools && window.BrowserTools._loadPdfLib) {
      return window.BrowserTools._loadPdfLib();
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.onload  = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib load failed'));
      s.onerror = (e) => {
        console.error('[PO] pdf-lib script load failed:', e);
        reject(new Error('pdf-lib load failed'));
      };
      document.head.appendChild(s);
    });
  }

  // ── Tile state machine states ─────────────────────────────────────────────
  const STATE = {
    IDLE:      'idle',
    QUEUED:    'queued',
    RENDERING: 'rendering',
    RENDERED:  'rendered',
    RETRYING:  'retrying',
    FAILED:    'failed',
    DESTROYED: 'destroyed',
  };

  function uid() {
    return 'p_' + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ── Validate thumbnail blob before using it ───────────────────────────────
  // Returns true if the dataURL can be decoded as a valid image.
  function validateThumbDataUrl(dataUrl) {
    return new Promise(function (resolve) {
      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return resolve(false);
      }
      var img = new Image();
      var timer = setTimeout(function () {
        img.onload = img.onerror = null;
        resolve(false);
      }, 1000);
      img.onload  = function () { clearTimeout(timer); resolve(img.naturalWidth > 0 && img.naturalHeight > 0); };
      img.onerror = function () { clearTimeout(timer); resolve(false); };
      img.src = dataUrl;
    });
  }

  // ── Bounded thumbnail cache ───────────────────────────────────────────────
  // Max 200 entries — FIFO eviction.
  function makeBoundedCache(maxSize) {
    var keys = []; // insertion order
    var map  = new Map();
    return {
      has: function (k) { return map.has(k); },
      get: function (k) { return map.get(k); },
      set: function (k, v) {
        if (map.has(k)) {
          map.set(k, v);
          return;
        }
        if (keys.length >= maxSize) {
          var evict = keys.shift();
          map.delete(evict);
        }
        keys.push(k);
        map.set(k, v);
      },
      delete: function (k) {
        var idx = keys.indexOf(k);
        if (idx >= 0) keys.splice(idx, 1);
        map.delete(k);
      },
      clear: function () { keys = []; map.clear(); },
      size: function () { return map.size; },
    };
  }

  // ── Open the organizer ────────────────────────────────────────────────────
  async function open(containerEl, file, opts) {
    opts = opts || {};
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    containerEl.innerHTML = `
      <div class="po-loading">
        <div class="po-spinner"></div>
        <div class="po-loading-text">
          Reading <strong>${escapeHtml(file.name)}</strong> and rendering page previews…
        </div>
      </div>`;

    let pdfDoc;
    try {
      pdfDoc = await window.PdfPreview.loadDocument(file);
    } catch (err) {
      console.error('[PageOrganizer] loadDocument failed:', err);
      containerEl.innerHTML = `
        <div class="po-error">
          <strong>PDF load failed</strong><br>
          <code style="font-size:11px;color:#c00">${escapeHtml(err && err.message ? err.message : String(err))}</code>
        </div>`;
      throw err;
    }

    let pages = Array.from({ length: pdfDoc.pageCount }, (_, i) => ({
      id: uid(),
      originalIndex: i,
      rotation: 0,
    }));

    containerEl.innerHTML = `
      <div class="po-toolbar">
        <div class="po-toolbar-info">
          <strong class="po-filename">${escapeHtml(file.name)}</strong>
          <span class="po-pagecount-pill"><span class="po-pagecount">${pages.length}</span> pages</span>
        </div>
        <div class="po-toolbar-actions">
          <button type="button" class="po-btn" data-act="rotate-all" title="Rotate every page 90°">
            <i data-lucide="rotate-cw"></i><span>Rotate all</span>
          </button>
          <button type="button" class="po-btn po-btn-danger" data-act="reset" title="Restore original order">
            <i data-lucide="rotate-ccw"></i><span>Reset</span>
          </button>
        </div>
      </div>
      <div class="po-grid" role="list" aria-label="PDF pages — drag to reorder"></div>
      <div class="po-hint">
        <i data-lucide="info"></i>
        Drag thumbnails to reorder. Use the per-page buttons to rotate or delete.
        Your final file follows this exact order.
      </div>`;
    if (window.lucide) lucide.createIcons();
    const grid = containerEl.querySelector('.po-grid');

    // ── State tracking ────────────────────────────────────────────────────
    const thumbCache   = makeBoundedCache(200);
    const tileStates   = new Map(); // tileId → STATE.*
    let   renderToken  = 0;        // grid-level render generation counter

    // Active cancellation tokens for in-flight renders.
    // Each is an object `{ cancelled: false }` so we can flip it by reference.
    const activeCancelTokens = new Set();

    function thumbKey(originalIndex, rotation) {
      return `${originalIndex}@${rotation}`;
    }

    // ── Per-tile render ───────────────────────────────────────────────────
    async function renderTileCanvas(tileEl, originalIndex, rotation, cancelToken) {
      const tileId = tileEl.dataset.id;
      if (!tileId) return;
      if (cancelToken.cancelled) return;

      const key  = thumbKey(originalIndex, rotation);
      const slot = tileEl.querySelector('.po-tile-canvas');
      if (!slot) return;

      const pageNum = originalIndex + 1;
      console.debug('[PDF_DEBUG] tile start page=' + pageNum + ' rot=' + rotation + ' key=' + key);

      // Check cache first — validate before using
      if (thumbCache.has(key)) {
        const cached = thumbCache.get(key);
        const valid  = await validateThumbDataUrl(cached);
        if (cancelToken.cancelled) {
          console.debug('[PDF_DEBUG] tile cancelled during cache-validate page=' + pageNum);
          return;
        }
        if (valid) {
          console.debug('[PDF_DEBUG] tile cache-hit page=' + pageNum);
          slot.innerHTML = `<img src="${cached}" alt="" draggable="false" />`;
          tileStates.set(tileId, STATE.RENDERED);
          _setTileState(tileEl, STATE.RENDERED);
          return;
        }
        // Invalid cache entry — evict and re-render
        console.warn('[PDF_DEBUG] tile cache-invalid page=' + pageNum + ' — evicting and re-rendering');
        thumbCache.delete(key);
      }

      // Mark as rendering
      tileStates.set(tileId, STATE.RENDERING);
      _setTileState(tileEl, STATE.RENDERING);

      if (cancelToken.cancelled) return;

      let canvas;
      try {
        // PdfPreview.renderPage v4.0 handles its own internal retries (up to 3).
        canvas = await window.PdfPreview.renderPage(pdfDoc, pageNum, 220, rotation);
      } catch (err) {
        // PdfPreview v4.0 never throws (returns error canvas) — but defensive catch.
        const reason = (err && err.message) ? err.message : String(err);
        console.error('[PDF_RENDER_FAIL] renderPage threw unexpectedly page=' + pageNum + ':', reason);
        if (cancelToken.cancelled) return;
        tileStates.set(tileId, STATE.FAILED);
        _setTileState(tileEl, STATE.FAILED);
        if (slot.isConnected) {
          slot.innerHTML = `<div class="po-tile-fallback" title="${escapeHtml(reason)}">Page ${pageNum}</div>`;
        }
        return;
      }

      if (cancelToken.cancelled) {
        console.debug('[PDF_DEBUG] tile cancelled after render page=' + pageNum);
        return;
      }

      // Check if canvas is error canvas (all retries exhausted in pdf-preview)
      if (canvas && canvas._isErrorCanvas) {
        const reason = canvas._errorReason || 'all render attempts failed';
        console.warn('[PDF_RENDER_FAIL] error canvas returned for page=' + pageNum + ' reason:', reason);
        tileStates.set(tileId, STATE.FAILED);
        _setTileState(tileEl, STATE.FAILED);
        if (slot.isConnected) {
          slot.innerHTML = `<div class="po-tile-fallback" title="${escapeHtml(reason)}">Page ${pageNum}</div>`;
        }
        return;
      }

      if (!canvas || !canvas.width || !canvas.height) {
        console.error('[PDF_CANVAS_STATE] zero-dimension canvas page=' + pageNum +
          ' (' + (canvas ? canvas.width + 'x' + canvas.height : 'null') + ')');
        tileStates.set(tileId, STATE.FAILED);
        _setTileState(tileEl, STATE.FAILED);
        if (slot.isConnected) {
          slot.innerHTML = `<div class="po-tile-fallback">Page ${pageNum}</div>`;
        }
        return;
      }

      console.debug('[PDF_RENDER_SUCCESS] tile page=' + pageNum +
        ' canvas=' + canvas.width + 'x' + canvas.height);

      // Convert to dataURL and cache
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        if (!dataUrl || !dataUrl.startsWith('data:')) {
          throw new Error('toDataURL returned invalid string (length=' + (dataUrl ? dataUrl.length : 0) + ')');
        }
        thumbCache.set(key, dataUrl);
        if (slot.isConnected && !cancelToken.cancelled) {
          slot.innerHTML = `<img src="${dataUrl}" alt="" draggable="false" />`;
          tileStates.set(tileId, STATE.RENDERED);
          _setTileState(tileEl, STATE.RENDERED);
          console.debug('[PDF_THUMB_STATE] tile injected page=' + pageNum);
        } else if (cancelToken.cancelled) {
          console.debug('[PDF_DEBUG] tile cancelled after toDataURL page=' + pageNum);
        }
      } catch (err) {
        const reason = (err && err.message) ? err.message : String(err);
        console.error('[PDF_THUMB_STATE] toDataURL failed page=' + pageNum + ':', reason);
        // Fallback: insert canvas directly (no objectFit, but shows something real)
        if (slot.isConnected && !cancelToken.cancelled) {
          try {
            slot.innerHTML = '';
            canvas.style.cssText = 'display:block;max-width:100%;height:auto;';
            slot.appendChild(canvas);
            tileStates.set(tileId, STATE.RENDERED);
            _setTileState(tileEl, STATE.RENDERED);
            console.debug('[PDF_THUMB_STATE] tile injected via canvas fallback page=' + pageNum);
          } catch (appendErr) {
            const appendReason = (appendErr && appendErr.message) ? appendErr.message : String(appendErr);
            console.error('[PDF_THUMB_STATE] canvas append also failed page=' + pageNum + ':', appendReason);
            tileStates.set(tileId, STATE.FAILED);
            _setTileState(tileEl, STATE.FAILED);
            if (slot.isConnected) {
              slot.innerHTML = `<div class="po-tile-fallback" title="DOM injection failed: ${escapeHtml(appendReason)}">Page ${pageNum}</div>`;
            }
          }
        }
      }
    }

    // ── Visual state indicator on tile ────────────────────────────────────
    function _setTileState(tileEl, state) {
      if (!tileEl || !tileEl.isConnected) return;
      tileEl.dataset.renderState = state;
      // Add/remove CSS classes for visual state
      tileEl.classList.toggle('po-tile--rendering', state === STATE.RENDERING || state === STATE.RETRYING);
      tileEl.classList.toggle('po-tile--failed',    state === STATE.FAILED);
      tileEl.classList.toggle('po-tile--rendered',  state === STATE.RENDERED);
    }

    // ── Grid render ───────────────────────────────────────────────────────
    function renderGrid() {
      // Cancel all active renders from the previous grid generation
      activeCancelTokens.forEach(function (tok) { tok.cancelled = true; });
      activeCancelTokens.clear();

      const myToken = ++renderToken;

      tileStates.clear();

      grid.innerHTML = pages.map((p, i) => `
        <div class="po-tile" role="listitem" tabindex="0"
             draggable="true"
             data-id="${p.id}" data-pos="${i}" data-render-state="${STATE.IDLE}"
             aria-label="Page ${i + 1}, originally page ${p.originalIndex + 1}">
          <div class="po-tile-pos">${i + 1}</div>
          <div class="po-tile-canvas">
            <div class="po-tile-spinner"></div>
          </div>
          <div class="po-tile-meta">
            <span class="po-tile-orig">orig p.${p.originalIndex + 1}</span>
            <span class="po-tile-rot${p.rotation ? ' is-rotated' : ''}">${p.rotation}°</span>
          </div>
          <div class="po-tile-actions">
            <button type="button" class="po-tile-act" data-tact="rotate" title="Rotate 90° clockwise" aria-label="Rotate page">
              <i data-lucide="rotate-cw"></i>
            </button>
            <button type="button" class="po-tile-act po-tile-act-del" data-tact="delete" title="Remove this page" aria-label="Delete page">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
      `).join('');
      if (window.lucide) lucide.createIcons();
      bindTileEvents();
      updatePageCount();

      // Render thumbnails sequentially — respects mobile render semaphore.
      // Each tile gets its own cancellation token.
      (async function renderThumbsInOrder() {
        const tiles = Array.from(grid.querySelectorAll('.po-tile'));
        for (const tile of tiles) {
          // If this grid generation has been superseded, stop.
          if (myToken !== renderToken) return;

          const id = tile.dataset.id;
          const p  = pages.find((x) => x.id === id);
          if (!p) continue;

          tileStates.set(id, STATE.QUEUED);

          // Create a per-tile cancellation token and register it.
          const cancelToken = { cancelled: false };
          activeCancelTokens.add(cancelToken);

          try {
            await renderTileCanvas(tile, p.originalIndex, p.rotation, cancelToken);
          } finally {
            activeCancelTokens.delete(cancelToken);
          }
        }
      })();
    }

    function updatePageCount() {
      const el = containerEl.querySelector('.po-pagecount');
      if (el) el.textContent = String(pages.length);
      onChange({ pageCount: pages.length });
    }

    // ── Per-tile event wiring ─────────────────────────────────────────────
    function bindTileEvents() {
      const tiles = grid.querySelectorAll('.po-tile');
      tiles.forEach((tile) => {
        tile.querySelectorAll('[data-tact]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = tile.dataset.id;
            const p = pages.find((x) => x.id === id);
            if (!p) return;
            const act = btn.dataset.tact;
            if (act === 'rotate') {
              p.rotation = (p.rotation + 90) % 360;
            } else if (act === 'delete') {
              if (pages.length <= 1) {
                alert('Your PDF must have at least one page.');
                return;
              }
              pages = pages.filter((x) => x.id !== id);
            }
            renderGrid();
          });
        });

        tile.addEventListener('keydown', (e) => {
          const id = tile.dataset.id;
          const idx = pages.findIndex((x) => x.id === id);
          if (idx < 0) return;
          if (e.key === 'r' || e.key === 'R') {
            pages[idx].rotation = (pages[idx].rotation + 90) % 360;
            renderGrid(); e.preventDefault();
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (pages.length > 1) { pages.splice(idx, 1); renderGrid(); }
            e.preventDefault();
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            if (idx < pages.length - 1) {
              [pages[idx], pages[idx + 1]] = [pages[idx + 1], pages[idx]];
              renderGrid();
              setTimeout(() => grid.querySelector(`[data-id="${id}"]`)?.focus(), 0);
            }
            e.preventDefault();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            if (idx > 0) {
              [pages[idx], pages[idx - 1]] = [pages[idx - 1], pages[idx]];
              renderGrid();
              setTimeout(() => grid.querySelector(`[data-id="${id}"]`)?.focus(), 0);
            }
            e.preventDefault();
          }
        });
      });
      bindDragAndDrop();
    }

    // ── Drag and drop ─────────────────────────────────────────────────────
    function bindDragAndDrop() {
      let dragId = null;
      let placeholder = null;
      let touchTile = null;
      let touchStart = null;
      let longPressTimer = null;
      let dragging = false;

      grid.querySelectorAll('.po-tile').forEach((tile) => {
        tile.addEventListener('dragstart', (e) => {
          dragId = tile.dataset.id;
          tile.classList.add('po-dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
        });
        tile.addEventListener('dragend', () => {
          tile.classList.remove('po-dragging');
          grid.querySelectorAll('.po-drop-after, .po-drop-before').forEach((t) =>
            t.classList.remove('po-drop-after', 'po-drop-before'));
          dragId = null;
        });
        tile.addEventListener('dragover', (e) => {
          if (!dragId || tile.dataset.id === dragId) return;
          e.preventDefault();
          const rect = tile.getBoundingClientRect();
          const after = (e.clientX - rect.left) > rect.width / 2;
          tile.classList.toggle('po-drop-after',  after);
          tile.classList.toggle('po-drop-before', !after);
        });
        tile.addEventListener('dragleave', () => {
          tile.classList.remove('po-drop-after', 'po-drop-before');
        });
        tile.addEventListener('drop', (e) => {
          e.preventDefault();
          if (!dragId || tile.dataset.id === dragId) return;
          const rect = tile.getBoundingClientRect();
          const after = (e.clientX - rect.left) > rect.width / 2;
          movePage(dragId, tile.dataset.id, after);
        });

        tile.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse') return;
          if (e.target.closest('[data-tact]')) return;
          touchTile = tile;
          touchStart = { x: e.clientX, y: e.clientY };
          longPressTimer = setTimeout(() => {
            dragging = true;
            tile.classList.add('po-dragging');
            tile.setPointerCapture?.(e.pointerId);
            placeholder = document.createElement('div');
            placeholder.className = 'po-tile po-placeholder';
            placeholder.style.height = tile.offsetHeight + 'px';
            tile.parentNode.insertBefore(placeholder, tile.nextSibling);
            tile.style.position = 'fixed';
            tile.style.zIndex = '999';
            tile.style.pointerEvents = 'none';
            tile.style.left = (e.clientX - tile.offsetWidth / 2) + 'px';
            tile.style.top  = (e.clientY - tile.offsetHeight / 2) + 'px';
            tile.style.width = tile.offsetWidth + 'px';
          }, 250);
        });
        tile.addEventListener('pointermove', (e) => {
          if (!touchTile) return;
          if (touchStart && !dragging) {
            const dx = Math.abs(e.clientX - touchStart.x);
            const dy = Math.abs(e.clientY - touchStart.y);
            if (dx > 10 || dy > 10) {
              clearTimeout(longPressTimer);
              touchTile = null; touchStart = null;
            }
            return;
          }
          if (!dragging) return;
          e.preventDefault();
          touchTile.style.left = (e.clientX - touchTile.offsetWidth / 2) + 'px';
          touchTile.style.top  = (e.clientY - touchTile.offsetHeight / 2) + 'px';
          const vh = window.innerHeight;
          if (e.clientY > vh - 60) window.scrollBy(0, 12);
          else if (e.clientY < 60)  window.scrollBy(0, -12);
          touchTile.style.visibility = 'hidden';
          const elBelow = document.elementFromPoint(e.clientX, e.clientY);
          touchTile.style.visibility = 'visible';
          const overTile = elBelow?.closest('.po-tile:not(.po-placeholder)');
          grid.querySelectorAll('.po-drop-after, .po-drop-before').forEach((t) =>
            t.classList.remove('po-drop-after', 'po-drop-before'));
          if (overTile && overTile !== touchTile) {
            const rect = overTile.getBoundingClientRect();
            const after = (e.clientX - rect.left) > rect.width / 2;
            overTile.classList.toggle('po-drop-after',  after);
            overTile.classList.toggle('po-drop-before', !after);
          }
        }, { passive: false });
        tile.addEventListener('pointerup', (e) => {
          clearTimeout(longPressTimer);
          if (!dragging) { touchTile = null; touchStart = null; return; }
          dragging = false;
          touchTile.classList.remove('po-dragging');
          touchTile.style.cssText = '';
          const elBelow = document.elementFromPoint(e.clientX, e.clientY);
          const overTile = elBelow?.closest('.po-tile:not(.po-placeholder)');
          if (overTile && overTile !== touchTile) {
            const rect = overTile.getBoundingClientRect();
            const after = (e.clientX - rect.left) > rect.width / 2;
            movePage(touchTile.dataset.id, overTile.dataset.id, after);
          } else {
            placeholder?.remove();
            renderGrid();
          }
          placeholder = null;
          touchTile = null;
          touchStart = null;
        });
        tile.addEventListener('pointercancel', () => {
          clearTimeout(longPressTimer);
          if (touchTile) { touchTile.classList.remove('po-dragging'); touchTile.style.cssText = ''; }
          placeholder?.remove();
          placeholder = null; touchTile = null; touchStart = null; dragging = false;
          renderGrid();
        });
      });
    }

    function movePage(fromId, toId, after) {
      const fromIdx = pages.findIndex((p) => p.id === fromId);
      if (fromIdx < 0) return;
      const moved = pages.splice(fromIdx, 1)[0];
      let toIdx = pages.findIndex((p) => p.id === toId);
      if (toIdx < 0) toIdx = pages.length;
      if (after) toIdx += 1;
      pages.splice(toIdx, 0, moved);
      renderGrid();
    }

    // ── Toolbar actions ───────────────────────────────────────────────────
    containerEl.querySelector('[data-act="rotate-all"]').addEventListener('click', () => {
      pages.forEach((p) => { p.rotation = (p.rotation + 90) % 360; });
      renderGrid();
    });
    containerEl.querySelector('[data-act="reset"]').addEventListener('click', () => {
      pages = Array.from({ length: pdfDoc.pageCount }, (_, i) => ({
        id: uid(), originalIndex: i, rotation: 0,
      }));
      renderGrid();
    });

    renderGrid();

    // ── Build edited PDF ──────────────────────────────────────────────────
    async function getEditedPdf() {
      const unchanged =
        pages.length === pdfDoc.pageCount &&
        pages.every((p, i) => p.originalIndex === i && p.rotation === 0);
      if (unchanged) {
        const blob = new Blob([pdfDoc.fileBytes], { type: 'application/pdf' });
        return { blob, file: new File([blob], file.name, { type: 'application/pdf' }) };
      }
      const { PDFDocument, degrees } = await loadPdfLib();
      const src = await PDFDocument.load(pdfDoc.fileBytes, { ignoreEncryption: true });
      const out = await PDFDocument.create();
      const wantedIndices = pages.map((p) => p.originalIndex);
      const copied = await out.copyPages(src, wantedIndices);
      copied.forEach((page, i) => {
        const rot = pages[i].rotation;
        if (rot) {
          const cur = page.getRotation().angle || 0;
          page.setRotation(degrees((cur + rot) % 360));
        }
        out.addPage(page);
      });
      const bytes = await out.save({ useObjectStreams: true });
      const blob = new Blob([bytes], { type: 'application/pdf' });
      return { blob, file: new File([blob], file.name, { type: 'application/pdf' }) };
    }

    function getOrderSummary() {
      return {
        order:     pages.map((p) => p.originalIndex + 1),
        rotations: pages.map((p) => p.rotation),
      };
    }

    // Idempotent destroy — safe to call multiple times.
    let _destroyed = false;
    function destroy() {
      if (_destroyed) return;
      _destroyed = true;

      // Cancel all in-flight renders
      activeCancelTokens.forEach(function (tok) { tok.cancelled = true; });
      activeCancelTokens.clear();

      // Invalidate PdfPreview session
      if (window.PdfPreview && window.PdfPreview.invalidateSession) {
        window.PdfPreview.invalidateSession();
      }

      thumbCache.clear();
      tileStates.clear();
      containerEl.innerHTML = '';
      window.PdfPreview.unloadDocument(pdfDoc);
    }

    return {
      getEditedPdf,
      getOrderSummary,
      getPageCount: () => pages.length,
      destroy,
    };
  }

  window.PageOrganizer = { shouldHandle, open, PAGE_LEVEL_TOOLS };
})();

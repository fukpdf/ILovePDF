// Page-level Organize UI for single-PDF tools.
//
// When a user uploads a PDF for an "organizable" tool (split, rotate,
// organize, compress, ocr, etc.), we replace the plain file-list view with
// a high-resolution thumbnail grid. Each thumbnail can be rotated, deleted,
// or dragged to reorder. On submit, we assemble a NEW PDF in the browser
// (using pdf-lib) that reflects every edit, then hand it back to the
// existing tool-page.js submit flow.
//
// This means:
//   • Client-side tools: BrowserTools receives the edited PDF and works as-is.
//   • Server-side tools: the API endpoint receives the edited PDF and works
//     without any backend change — the server just sees a "normal" PDF.
//
// Public API:
//   PageOrganizer.shouldHandle(toolId, files)   -> boolean
//   PageOrganizer.open(containerEl, file, opts) -> Promise<Controller>
//   Controller.getEditedPdf()                   -> Promise<{ blob, file }>
//   Controller.getOrderSummary()                -> { order: number[], rotations: number[] }
//   Controller.getPageCount()                   -> number   (after deletions)
//   Controller.destroy()
(function () {
  // Single-PDF tools that benefit from page-level organize UI.
  const PAGE_LEVEL_TOOLS = new Set([
    'split', 'rotate', 'organize', 'crop', 'page-numbers',
    'watermark', 'sign', 'redact', 'compress', 'ocr',
    'ai-summarize', 'translate', 'repair', 'edit',
  ]);

  function shouldHandle(toolId, files) {
    if (!toolId || !files || files.length !== 1) return false;
    if (!PAGE_LEVEL_TOOLS.has(toolId)) return false;
    const f = files[0];
    return /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  }

  // ── pdf-lib (re-uses the loader that BrowserTools already shipped) ──────
  async function loadPdfLib() {
    if (window.PDFLib) return window.PDFLib;
    if (window.BrowserTools && window.BrowserTools._loadPdfLib) {
      return window.BrowserTools._loadPdfLib();
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.onload  = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib load failed'));
      s.onerror = () => reject(new Error('pdf-lib load failed'));
      document.head.appendChild(s);
    });
  }

  function uid() {
    return 'p_' + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ── Open the organizer in `containerEl` for a single PDF file ──────────
  async function open(containerEl, file, opts) {
    opts = opts || {};
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    // Loading skeleton (instant feedback while PDF.js spins up)
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
      containerEl.innerHTML = `
        <div class="po-error">
          Couldn't read this PDF.
          <small>${escapeHtml(err && err.message ? err.message : 'Unknown error')}</small>
        </div>`;
      throw err;
    }

    // State: each entry is one page slot. `originalIndex` is 0-indexed into pdfDoc.pdf.
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

    // ── Thumbnail render queue (sequential = avoids GPU stalls on big PDFs)
    const thumbCache = new Map();   // originalIndex@rotation -> dataURL
    let renderToken = 0;

    function thumbKey(originalIndex, rotation) {
      return `${originalIndex}@${rotation}`;
    }

    async function renderTileCanvas(tileEl, originalIndex, rotation) {
      const key = thumbKey(originalIndex, rotation);
      const slot = tileEl.querySelector('.po-tile-canvas');
      if (!slot) return;
      const cached = thumbCache.get(key);
      if (cached) {
        slot.innerHTML = `<img src="${cached}" alt="" draggable="false" />`;
        return;
      }
      try {
        const canvas = await window.PdfPreview.renderPage(pdfDoc, originalIndex + 1, 220, rotation);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        thumbCache.set(key, dataUrl);
        // Tile may have been re-rendered while we were rendering — guard.
        if (slot.isConnected) slot.innerHTML = `<img src="${dataUrl}" alt="" draggable="false" />`;
      } catch (err) {
        if (slot.isConnected) {
          slot.innerHTML = `<div class="po-tile-error" title="${escapeHtml(err.message)}">!</div>`;
        }
      }
    }

    function renderGrid() {
      const myToken = ++renderToken;
      grid.innerHTML = pages.map((p, i) => `
        <div class="po-tile" role="listitem" tabindex="0"
             draggable="true"
             data-id="${p.id}" data-pos="${i}"
             aria-label="Page ${i + 1}, originally page ${p.originalIndex + 1}">
          <div class="po-tile-pos">${i + 1}</div>
          <div class="po-tile-canvas" style="transform:none"></div>
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

      // Render thumbnails sequentially so a 200-page PDF doesn't melt the tab.
      (async function renderThumbsInOrder() {
        for (const tile of grid.querySelectorAll('.po-tile')) {
          if (myToken !== renderToken) return;          // grid was re-rendered, abort
          const id = tile.dataset.id;
          const p = pages.find((x) => x.id === id);
          if (!p) continue;
          await renderTileCanvas(tile, p.originalIndex, p.rotation);
        }
      })();
    }

    function updatePageCount() {
      const el = containerEl.querySelector('.po-pagecount');
      if (el) el.textContent = String(pages.length);
      onChange({ pageCount: pages.length });
    }

    // ── Per-tile event wiring (rotate / delete / drag-and-drop) ──────────
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

        // Keyboard accessibility — R rotates, Delete removes, arrows move.
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

    // ── Drag and drop with mouse + touch (Pointer Events for mobile) ──────
    function bindDragAndDrop() {
      let dragId = null;
      let placeholder = null;
      let touchTile = null;
      let touchStart = null;
      let longPressTimer = null;
      let dragging = false;

      grid.querySelectorAll('.po-tile').forEach((tile) => {
        // Native HTML5 drag (mouse / trackpad)
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

        // ── Touch / Pen (Pointer Events) — long-press 250 ms to pick up ──
        tile.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse') return;       // mouse uses native dnd
          if (e.target.closest('[data-tact]')) return; // tapping a button
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
            if (dx > 10 || dy > 10) {                  // user is scrolling
              clearTimeout(longPressTimer);
              touchTile = null; touchStart = null;
            }
            return;
          }
          if (!dragging) return;
          e.preventDefault();
          touchTile.style.left = (e.clientX - touchTile.offsetWidth / 2) + 'px';
          touchTile.style.top  = (e.clientY - touchTile.offsetHeight / 2) + 'px';
          // Auto-scroll near edges
          const vh = window.innerHeight;
          if (e.clientY > vh - 60) window.scrollBy(0, 12);
          else if (e.clientY < 60)  window.scrollBy(0, -12);
          // Find drop target
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

    // ── Toolbar actions ─────────────────────────────────────────────────
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

    // ── Build edited PDF using pdf-lib (called on submit) ───────────────
    async function getEditedPdf() {
      // No-op fast path: nothing changed → return original bytes & file.
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
        order:     pages.map((p) => p.originalIndex + 1),    // 1-indexed for the legacy `pageOrder` field
        rotations: pages.map((p) => p.rotation),
      };
    }

    function destroy() {
      containerEl.innerHTML = '';
      window.PdfPreview.unloadDocument(pdfDoc);
      thumbCache.clear();
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

/* Shared post-upload file cards for the standard tool workspace.
 * Loaded only after a user selects files. The preview UI never waits for a
 * processing engine; PDF page thumbnails are best-effort background work.
 */
(function () {
  'use strict';
  if (window.SharedFilePreview) return;

  var mountTokens = new WeakMap();
  var activeHosts = new Set();
  var sequence = 0;
  var TOOL_IDS = new Set([
    'merge','split','rotate','crop','organize','compress',
    'pdf-to-word','pdf-to-powerpoint','pdf-to-excel','pdf-to-jpg',
    'word-to-pdf','powerpoint-to-pdf','excel-to-pdf','word-to-excel',
    'jpg-to-pdf','html-to-pdf','edit','watermark','sign','page-numbers',
    'redact','protect','unlock','repair','scan-to-pdf','ocr','compare',
    'ai-summarize','translate','workflow','background-remover',
    'crop-image','resize-image','image-filters'
  ]);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function bytes(value) {
    if (!Number.isFinite(value) || value < 0) return 'File';
    if (value < 1024) return value + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var size = value / 1024, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[unit];
  }

  function extension(file) {
    var name = String(file && file.name || '');
    var dot = name.lastIndexOf('.');
    return dot < 0 ? 'FILE' : (name.slice(dot + 1).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'FILE');
  }

  function kind(ext) {
    if (ext === 'PDF') return 'pdf';
    if (/^(DOC|DOCX|RTF|TXT|HTML|HTM)$/.test(ext)) return 'doc';
    if (/^(XLS|XLSX|CSV)$/.test(ext)) return 'xls';
    if (/^(PPT|PPTX)$/.test(ext)) return 'ppt';
    if (/^(JPG|JPEG|PNG|WEBP|GIF|BMP|SVG|AVIF)$/.test(ext)) return 'image';
    return 'file';
  }

  function normalized(entries) {
    return (Array.isArray(entries) ? entries : [entries]).filter(Boolean).map(function (entry) {
      return entry && entry.file ? entry : { file: entry, rotation: 0 };
    }).filter(function (entry) { return entry.file; });
  }

  function cleanup(host) {
    if (!host) return;
    host.querySelectorAll('[data-shared-object-url]').forEach(function (node) {
      try { URL.revokeObjectURL(node.getAttribute('data-shared-object-url')); } catch (_) {}
      node.removeAttribute('data-shared-object-url');
    });
    host.querySelectorAll('canvas').forEach(function (canvas) {
      try { var ctx = canvas.getContext('2d'); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (_) {}
    });
  }

  function cleanupDetachedHosts() {
    activeHosts.forEach(function (host) {
      if (!host.isConnected) {
        cleanup(host);
        activeHosts.delete(host);
      }
    });
  }

  function unmount(host) {
    if (!host) return;
    cleanup(host);
    activeHosts.delete(host);
    host.innerHTML = '';
  }

  function cleanupAll() {
    activeHosts.forEach(function (host) { cleanup(host); });
    activeHosts.clear();
  }

  window.addEventListener('pagehide', function (event) {
    // Keep object URLs intact when the browser places the page in BFCache.
    if (!event.persisted) cleanupAll();
  });

  function visual(entry, index, host) {
    var file = entry.file;
    var ext = extension(file);
    var type = String(file.type || '').toLowerCase();
    var visualKind = kind(ext);
    if (type.indexOf('image/') === 0 || visualKind === 'image') {
      var url = URL.createObjectURL(file);
      return '<span class="lp-shared-image-wrap"><img class="lp-shared-image" src="' + url +
        '" data-shared-object-url="' + url + '" alt="Preview of ' + escapeHtml(file.name || 'image') +
        '" loading="lazy"></span>';
    }
    if (visualKind === 'pdf') {
      return '<span class="lp-shared-file-art lp-shared-file-art--pdf" data-shared-pdf-index="' + index +
        '" aria-label="PDF preview placeholder"><span class="lp-shared-file-fold"></span>' +
        '<span class="lp-shared-file-lines"></span><b>PDF</b></span>';
    }
    return '<span class="lp-shared-file-art lp-shared-file-art--' + visualKind +
      '" aria-hidden="true"><span class="lp-shared-file-fold"></span><span class="lp-shared-file-lines"></span><b>' +
      escapeHtml(ext === 'FILE' ? 'FILE' : ext) + '</b></span>';
  }

  function loadPdfPreview() {
    if (window.PdfPreview && typeof window.PdfPreview.loadDocument === 'function') return Promise.resolve(true);
    if (window.__sharedPdfPreviewPromise) return window.__sharedPdfPreviewPromise;
    window.__sharedPdfPreviewPromise = new Promise(function (resolve) {
      var existing = Array.prototype.find.call(document.querySelectorAll('script[src]'), function (node) {
        return node.src.replace(/^https?:\/\/[^/]+/, '').split('?')[0] === '/js/pdf-preview.js';
      });
      if (existing) {
        if (window.PdfPreview || existing.dataset.sharedLoaded === '1' || existing.dataset.ilpdfLoaded === '1') {
          resolve(!!window.PdfPreview); return;
        }
        existing.addEventListener('load', function () { resolve(!!window.PdfPreview); }, { once: true });
        existing.addEventListener('error', function () { resolve(false); }, { once: true });
        return;
      }
      var script = document.createElement('script');
      script.src = '/js/pdf-preview.js?v=20261016-shared-file-preview-v1';
      script.async = true;
      script.dataset.sharedPdfPreview = '1';
      script.onload = function () { script.dataset.sharedLoaded = '1'; resolve(!!window.PdfPreview); };
      script.onerror = function () { resolve(false); };
      document.head.appendChild(script);
    }).then(function (ready) {
      if (!ready) window.__sharedPdfPreviewPromise = null;
      return ready;
    });
    return window.__sharedPdfPreviewPromise;
  }

  async function renderPdfThumbnails(items, host, token) {
    var pdfEntries = items.map(function (entry, index) {
      return { entry: entry, index: index, file: entry.file };
    }).filter(function (item) {
      return item.file && (String(item.file.type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(item.file.name || ''));
    });
    if (!pdfEntries.length) return;
    if (!(await loadPdfPreview()) || !window.PdfPreview) return;

    for (var i = 0; i < pdfEntries.length; i++) {
      if (!host.isConnected || mountTokens.get(host) !== token) return;
      var item = pdfEntries[i];
      var placeholder = host.querySelector('[data-shared-pdf-index="' + item.index + '"]');
      if (!placeholder) continue;
      var pdfDoc = null, canvas = null;
      try {
        pdfDoc = await window.PdfPreview.loadDocument(item.file);
        canvas = await window.PdfPreview.renderPage(pdfDoc, 1, 160, 0);
        if (!canvas || canvas._isErrorCanvas || !host.isConnected || mountTokens.get(host) !== token || !placeholder.isConnected) continue;
        var wrap = document.createElement('span');
        wrap.className = 'lp-shared-image-wrap';
        var image = document.createElement('img');
        image.className = 'lp-shared-image lp-shared-pdf-thumb';
        image.alt = 'First page preview of ' + String(item.file.name || 'PDF');
        image.src = canvas.toDataURL('image/jpeg', 0.82);
        wrap.appendChild(image);
        placeholder.replaceWith(wrap);
      } catch (_) {
        // Keep the file card and PDF badge usable if thumbnail rendering fails.
      } finally {
        try { if (canvas) { var ctx = canvas.getContext('2d'); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); } } catch (_) {}
        try { if (pdfDoc && window.PdfPreview && window.PdfPreview.unloadDocument) window.PdfPreview.unloadDocument(pdfDoc); } catch (_) {}
      }
    }
  }

  function mount(toolId, entries, host, options) {
    if (!host) return Promise.resolve(false);
    options = options || {};
    cleanupDetachedHosts();
    var items = normalized(entries);
    var token = ++sequence;
    mountTokens.set(host, token);
    cleanup(host);

    if (!items.length) {
      activeHosts.delete(host);
      host.innerHTML = '';
      return Promise.resolve(true);
    }
    activeHosts.add(host);

    var totalBytes = items.reduce(function (sum, entry) {
      return sum + (Number.isFinite(entry.file.size) ? entry.file.size : 0);
    }, 0);
    var allowAdd = !!options.multiple;
    var accept = escapeHtml(options.accept || '');
    host.innerHTML = '<section class="lp-shared-preview" aria-label="Selected file preview">' +
      '<header class="lp-shared-preview-head"><div><span class="lp-shared-kicker">PREVIEW WORKSPACE</span>' +
      '<h2>' + (items.length > 1 ? 'Your files are ready' : 'Your file is ready') + '</h2>' +
      '<p>Review your selection before processing.</p></div>' +
      '<span class="lp-shared-count">' + items.length + ' file' + (items.length === 1 ? '' : 's') + '</span></header>' +
      '<ul class="lp-shared-file-list" aria-label="Selected documents">' + items.map(function (entry, index) {
        var file = entry.file;
        var name = String(file.name || ('File ' + (index + 1)));
        var ext = extension(file);
        var mime = String(file.type || '').split('/').pop().replace(/[^a-z0-9.+-]/gi, '').toUpperCase();
        var label = mime || ext;
        var reorder = toolId === 'merge' && items.length > 1;
        return '<li class="lp-shared-file-card"><span class="lp-shared-index" aria-hidden="true">' + (index + 1) + '</span>' +
          visual(entry, index, host) + '<span class="lp-shared-file-info"><strong title="' + escapeHtml(name) + '">' +
          escapeHtml(name) + '</strong><small>' + bytes(file.size) + ' <span aria-hidden="true">·</span> ' +
          escapeHtml(label) + '</small><span class="lp-shared-ready"><span aria-hidden="true"></span>Ready to process</span></span>' +
          (reorder ? '<span class="lp-shared-reorder" aria-label="Reorder files">' +
            (index > 0 ? '<button type="button" data-shared-move="up" data-shared-index="' + index + '" aria-label="Move ' + escapeHtml(name) + ' up" title="Move up">↑</button>' : '') +
            (index < items.length - 1 ? '<button type="button" data-shared-move="down" data-shared-index="' + index + '" aria-label="Move ' + escapeHtml(name) + ' down" title="Move down">↓</button>' : '') +
          '</span>' : '') +
          '<button class="lp-shared-remove" type="button" data-shared-remove="' + index + '" aria-label="Remove ' + escapeHtml(name) + '" title="Remove file">×</button></li>';
      }).join('') + '</ul><footer class="lp-shared-preview-footer"><span>' + items.length + ' selected · ' + bytes(totalBytes) +
      ' total</span>' + (allowAdd ? '<button type="button" class="lp-shared-add" data-shared-add>+ Add files</button>' : '') +
      '</footer><p class="lp-shared-preview-note">Your original files stay unchanged. Processing starts when you press the tool’s Process button.</p>' +
      (allowAdd ? '<input class="lp-shared-add-input" data-shared-add-input type="file" multiple accept="' + accept + '" tabindex="-1" aria-hidden="true">' : '') +
      '</section>';

    host.querySelectorAll('[data-shared-remove]').forEach(function (button) {
      button.addEventListener('click', function () {
        var index = Number(button.getAttribute('data-shared-remove'));
        if (typeof options.onRemove === 'function') options.onRemove(index);
        else if (typeof window.removeFile === 'function') window.removeFile(index);
      });
    });
    host.querySelectorAll('[data-shared-move]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (typeof window.moveSharedPreviewFile === 'function') {
          var index = Number(button.getAttribute('data-shared-index'));
          window.moveSharedPreviewFile(index, index + (button.getAttribute('data-shared-move') === 'up' ? -1 : 1));
        }
      });
    });
    var addButton = host.querySelector('[data-shared-add]');
    var addInput = host.querySelector('[data-shared-add-input]');
    if (addButton && addInput) {
      addButton.addEventListener('click', function () {
        if (typeof options.onAdd === 'function') options.onAdd();
        else addInput.click();
      });
      addInput.addEventListener('change', function () {
        if (addInput.files && addInput.files.length && typeof window.handleFiles === 'function') {
          window.handleFiles(addInput.files);
        }
        addInput.value = '';
      });
    }

    // Cards are available immediately; PDF thumbnails enhance them in background.
    renderPdfThumbnails(items, host, token).catch(function () {});
    return Promise.resolve(true);
  }

  window.SharedFilePreview = {
    mount: mount,
    unmount: unmount,
    cleanupAll: cleanupAll,
    supported: function (toolId) { return TOOL_IDS.has(toolId); },
    toolIds: Array.from(TOOL_IDS)
  };
}());

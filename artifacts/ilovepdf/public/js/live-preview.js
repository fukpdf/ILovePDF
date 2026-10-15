// Shared selected-file preview for every upload-enabled standard-shell tool.
// Heavy processing engines stay in their existing on-demand tool modules.
(function () {
  'use strict';

  // Keep aligned with tools-config.js entries that declare acceptedFiles.
  var UPLOAD_TOOL_IDS = new Set([
    'merge', 'split', 'rotate', 'crop', 'organize', 'compress',
    'pdf-to-word', 'pdf-to-powerpoint', 'pdf-to-excel', 'pdf-to-jpg',
    'word-to-pdf', 'powerpoint-to-pdf', 'excel-to-pdf', 'word-to-excel',
    'jpg-to-pdf', 'html-to-pdf', 'edit', 'watermark', 'sign',
    'page-numbers', 'redact', 'protect', 'unlock', 'repair',
    'scan-to-pdf', 'ocr', 'compare', 'ai-summarize', 'translate',
    'workflow', 'background-remover', 'crop-image', 'resize-image',
    'image-filters'
  ]);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return 'File';
    if (value < 1024) return value + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var size = value / 1024;
    var unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[unit];
  }

  function getExtension(file) {
    var name = String(file && file.name || 'file');
    var dot = name.lastIndexOf('.');
    var extension = dot >= 0
      ? name.slice(dot + 1).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5)
      : 'FILE';
    return extension || 'FILE';
  }

  function getKind(extension) {
    if (extension === 'PDF') return 'PDF';
    if (/^(DOC|DOCX|RTF|TXT|HTML|HTM)$/.test(extension)) return 'DOC';
    if (/^(XLS|XLSX|CSV)$/.test(extension)) return 'XLS';
    if (/^(PPT|PPTX)$/.test(extension)) return 'PPT';
    return extension;
  }

  var activePreviewHost = null;

  function cleanupHost(host) {
    if (!host) return;
    host.querySelectorAll('[data-obj-url]').forEach(function (element) {
      try { URL.revokeObjectURL(element.getAttribute('data-obj-url')); } catch (_) {}
      element.removeAttribute('data-obj-url');
    });
    host.querySelectorAll('canvas').forEach(function (canvas) {
      try {
        var context = canvas.getContext('2d');
        if (context) context.clearRect(0, 0, canvas.width, canvas.height);
      } catch (_) {}
    });
  }

  function fileVisual(file, index) {
    var type = String(file && file.type || '').toLowerCase();
    var extension = getExtension(file);
    if (type.indexOf('image/') === 0 ||
        /^(JPG|JPEG|PNG|WEBP|GIF|BMP|SVG|AVIF)$/.test(extension)) {
      var imageUrl = URL.createObjectURL(file);
      return '<span class="lp-shared-image-wrap"><img class="lp-shared-image" src="' +
        imageUrl + '" data-obj-url="' + imageUrl + '" alt="Preview of ' +
        escapeAttr(file.name || 'image') + '" loading="lazy"></span>';
    }
    var kind = getKind(extension);
    if (kind === 'PDF') {
      return '<span class="lp-shared-file-art lp-shared-file-art--pdf" data-shared-pdf-index="' +
        index + '" aria-label="PDF first-page preview placeholder"><span class="lp-shared-file-fold"></span>' +
        '<span class="lp-shared-file-lines"></span><b>PDF</b></span>';
    }
    return '<span class="lp-shared-file-art lp-shared-file-art--' +
      escapeAttr(kind.toLowerCase()) + '" aria-hidden="true"><span class="lp-shared-file-fold"></span>' +
      '<span class="lp-shared-file-lines"></span><b>' + escapeHtml(kind) + '</b></span>';
  }

  async function mountSharedFilePreview(toolId, files, host) {
    var items = (Array.isArray(files) ? files : [files]).filter(Boolean);
    cleanupHost(host);
    if (!items.length) {
      host.innerHTML = '<section class="lp-shared-preview" aria-label="Selected file preview">' +
        '<p class="lp-shared-preview-note">Select a file to see its preview.</p></section>';
      return;
    }

    host.innerHTML = '<section class="lp-shared-preview" aria-label="Selected file preview">' +
      '<header class="lp-shared-preview-head"><div><span class="lp-shared-kicker">PREVIEW WORKSPACE</span>' +
      '<h2>' + (items.length > 1 ? 'Review your files' : 'Review your file') + '</h2>' +
      '<p>Check your selected file' + (items.length > 1 ? 's' : '') + ' before processing.</p></div>' +
      '<span class="lp-shared-count">' + items.length + ' file' + (items.length === 1 ? '' : 's') + '</span></header>' +
      '<ul class="lp-shared-file-list">' + items.map(function (file, index) {
        var name = String(file.name || ('File ' + (index + 1)));
        var extension = getExtension(file);
        var mime = String(file.type || '').split('/').pop().replace(/[^a-z0-9.+-]/gi, '').toUpperCase();
        var label = mime || extension || 'FILE';
        return '<li class="lp-shared-file-card"><span class="lp-shared-index">' + (index + 1) + '</span>' +
          fileVisual(file, index) + '<span class="lp-shared-file-info"><strong title="' +
          escapeAttr(name) + '">' + escapeHtml(name) + '</strong><small>' +
          escapeHtml(formatBytes(file.size)) + ' <span aria-hidden="true">·</span> ' +
          escapeHtml(label) + '</small><span class="lp-shared-ready"><span aria-hidden="true"></span>' +
          ' Ready to process</span></span>' +
          (toolId === 'merge' && items.length > 1
            ? '<span class="lp-shared-reorder" aria-label="Reorder files">' +
              (index > 0 ? '<button type="button" data-shared-move="up" data-shared-index="' + index + '" aria-label="Move ' + escapeAttr(name) + ' up" title="Move up">↑</button>' : '') +
              (index < items.length - 1 ? '<button type="button" data-shared-move="down" data-shared-index="' + index + '" aria-label="Move ' + escapeAttr(name) + ' down" title="Move down">↓</button>' : '') +
              '</span>'
            : '') +
          (items.length > 1 ? '<button class="lp-shared-remove" type="button" data-shared-remove="' +
          index + '" aria-label="Remove ' + escapeAttr(name) + '" title="Remove file">×</button>' : '') +
          '</li>';
      }).join('') + '</ul><p class="lp-shared-preview-note">Your original file stays unchanged. ' +
      'Processing starts only when you press the Process button.</p></section>';

    host.querySelectorAll('[data-shared-remove]').forEach(function (button) {
      button.addEventListener('click', function () {
        var index = Number(button.getAttribute('data-shared-remove'));
        cleanupHost(host);
        if (typeof window.removeFile === 'function') window.removeFile(index);
      });
    });
    host.querySelectorAll('[data-shared-move]').forEach(function (button) {
      button.addEventListener('click', function () {
        var index = Number(button.getAttribute('data-shared-index'));
        var delta = button.getAttribute('data-shared-move') === 'up' ? -1 : 1;
        if (typeof window.moveMergePreviewFile === 'function') {
          window.moveMergePreviewFile(index, index + delta);
        }
      });
    });

    // Reuse the existing PDF renderer only when already available; never load
    // a PDF engine just to draw the initial selected-file card.
    if (window.PdfPreview &&
        typeof window.PdfPreview.loadDocument === 'function' &&
        typeof window.PdfPreview.renderPage === 'function') {
      for (var i = 0; i < items.length; i++) {
        var file = items[i];
        var isPdf = file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
        if (!isPdf || !host.isConnected) continue;
        var placeholder = host.querySelector('[data-shared-pdf-index="' + i + '"]');
        if (!placeholder) continue;
        var pdfDocument = null;
        try {
          pdfDocument = await window.PdfPreview.loadDocument(file);
          var canvas = await window.PdfPreview.renderPage(pdfDocument, 1, 180, 0);
          if (!host.isConnected || !placeholder.isConnected || !canvas) continue;
          var image = document.createElement('img');
          image.className = 'lp-shared-image lp-shared-pdf-thumb';
          image.alt = 'First page preview of ' + String(file.name || 'PDF file');
          image.src = canvas.toDataURL('image/jpeg', 0.82);
          placeholder.replaceWith(image);
          try {
            var context = canvas.getContext('2d');
            if (context) context.clearRect(0, 0, canvas.width, canvas.height);
          } catch (_) {}
        } catch (_) {
          // Metadata preview remains usable if thumbnail rendering fails.
        } finally {
          try {
            if (pdfDocument && window.PdfPreview.unloadDocument) {
              window.PdfPreview.unloadDocument(pdfDocument);
            }
          } catch (_) {}
        }
      }
    }
  }

  async function mount(toolId, files, host) {
    if (!host || !UPLOAD_TOOL_IDS.has(toolId)) return;
    if (activePreviewHost && activePreviewHost !== host) cleanupHost(activePreviewHost);
    activePreviewHost = host;
    host.setAttribute('aria-busy', 'true');
    try {
      await mountSharedFilePreview(toolId, files, host);
    } catch (error) {
      cleanupHost(host);
      host.innerHTML = '<section class="lp-shared-preview" role="status" aria-label="Selected file preview">' +
        '<h2>File selected</h2><p class="lp-shared-preview-note">The preview could not be rendered, ' +
        'but your selected file is still available for processing.</p></section>';
      if (window.DebugTrace) {
        try { window.DebugTrace.error('shared-file-preview', { toolId: toolId, message: error && error.message }); } catch (_) {}
      }
    } finally {
      if (host.isConnected) host.setAttribute('aria-busy', 'false');
    }
  }

  window.addEventListener('ilpdf:step', function (event) {
    if (event && event.detail && event.detail.step === 'preview') return;
    if (activePreviewHost) cleanupHost(activePreviewHost);
    activePreviewHost = null;
  });
  window.addEventListener('pagehide', function () {
    if (activePreviewHost) cleanupHost(activePreviewHost);
    activePreviewHost = null;
  });

  window.LivePreview = {
    mount: mount,
    supported: function (toolId) { return UPLOAD_TOOL_IDS.has(toolId); }
  };
}());

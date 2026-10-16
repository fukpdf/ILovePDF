// Shared post-upload file preview used by every upload-enabled tool.
// This module is deliberately small and does not load processing engines.
(function () {
  'use strict';
  var TOOL_IDS = new Set([
    'merge','split','rotate','crop','organize','compress',
    'pdf-to-word','pdf-to-powerpoint','pdf-to-excel','pdf-to-jpg',
    'word-to-pdf','powerpoint-to-pdf','excel-to-pdf','word-to-excel',
    'jpg-to-pdf','html-to-pdf','edit','watermark','sign','page-numbers',
    'redact','protect','unlock','repair','scan-to-pdf','ocr','compare',
    'ai-summarize','translate','workflow','background-remover',
    'crop-image','resize-image','image-filters'
  ]);
  var sequence = 0;
  var activeHost = null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function attr(value) {
    return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function extension(file) {
    var name = String(file && file.name || 'file');
    var dot = name.lastIndexOf('.');
    return (dot >= 0 ? name.slice(dot + 1) : 'FILE')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'FILE';
  }
  function bytes(value) {
    if (!Number.isFinite(value) || value < 0) return 'File';
    if (value < 1024) return value + ' B';
    var units = ['KB','MB','GB','TB'], size = value / 1024, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[unit];
  }
  function totalBytes(files) {
    return files.reduce(function (sum, file) { return sum + (Number(file && file.size) || 0); }, 0);
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
  function visual(file, index) {
    var ext = extension(file);
    var mime = String(file && file.type || '').toLowerCase();
    var isImage = mime.indexOf('image/') === 0 || /^(JPG|JPEG|PNG|WEBP|GIF|BMP|SVG|AVIF|TIFF)$/.test(ext);
    if (isImage) {
      try {
        var url = URL.createObjectURL(file);
        return '<span class="lp-shared-image-wrap"><img class="lp-shared-image" src="' + attr(url) +
          '" data-shared-object-url="' + attr(url) + '" alt="Preview of ' + attr(file.name || 'image') +
          '" loading="lazy" decoding="async"></span>';
      } catch (_) {}
    }
    var kind = ext === 'PDF' ? 'PDF' :
      (/^(DOC|DOCX|RTF|TXT|HTML|HTM)$/.test(ext) ? 'DOC' :
      (/^(XLS|XLSX|CSV)$/.test(ext) ? 'XLS' :
      (/^(PPT|PPTX)$/.test(ext) ? 'PPT' : ext)));
    if (kind === 'PDF') {
      return '<span class="lp-shared-file-art lp-shared-file-art--pdf" data-shared-pdf-index="' + index +
        '" aria-label="PDF page thumbnail loading"><span class="lp-shared-file-fold"></span>' +
        '<span class="lp-shared-file-lines"></span><b>PDF</b></span>';
    }
    return '<span class="lp-shared-file-art lp-shared-file-art--' + attr(kind.toLowerCase()) +
      '" aria-hidden="true"><span class="lp-shared-file-fold"></span><span class="lp-shared-file-lines"></span><b>' +
      esc(kind) + '</b></span>';
  }
  function hydratePdfThumbnails(files, host) {
    if (!host || !window.PdfPreview ||
        typeof window.PdfPreview.loadDocument !== 'function' ||
        typeof window.PdfPreview.renderPage !== 'function') return;
    var token = host.getAttribute('data-shared-mount-token');
    (async function () {
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!(file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')))) continue;
        if (!host.isConnected || host.getAttribute('data-shared-mount-token') !== token) return;
        var placeholder = host.querySelector('[data-shared-pdf-index="' + i + '"]');
        if (!placeholder) continue;
        var pdf = null;
        try {
          pdf = await window.PdfPreview.loadDocument(file);
          var canvas = await window.PdfPreview.renderPage(pdf, 1, 180, 0);
          if (!canvas || !host.isConnected ||
              host.getAttribute('data-shared-mount-token') !== token ||
              !placeholder.isConnected) continue;
          var img = document.createElement('img');
          img.className = 'lp-shared-image lp-shared-pdf-thumb';
          img.alt = 'First page preview of ' + String(file.name || 'PDF file');
          img.decoding = 'async';
          img.src = canvas.toDataURL('image/jpeg', 0.82);
          placeholder.replaceWith(img);
          try { var ctx = canvas.getContext('2d'); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (_) {}
        } catch (_) {
          // The file card remains usable if PDF thumbnail rendering fails.
        } finally {
          try { if (pdf && window.PdfPreview.unloadDocument) window.PdfPreview.unloadDocument(pdf); } catch (_) {}
        }
      }
    })().catch(function () {});
  }
  function openAddFiles(options) {
    if (typeof window.handleFiles !== 'function') return;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = String(options.acceptedFiles || '');
    input.multiple = true;
    input.setAttribute('aria-label', 'Add more files');
    input.style.position = 'fixed';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    var cleaned = false;
    function cleanupInput() {
      if (cleaned) return;
      cleaned = true;
      if (input.parentNode) input.parentNode.removeChild(input);
    }
    input.addEventListener('change', function () {
      if (input.files && input.files.length) window.handleFiles(input.files);
      cleanupInput();
    }, { once: true });
    input.addEventListener('cancel', cleanupInput, { once: true });
    input.click();
  }
  function mount(toolId, files, host, options) {
    if (!host || !TOOL_IDS.has(toolId)) return Promise.resolve(false);
    options = options || {};
    var items = (Array.isArray(files) ? files : [files]).filter(Boolean);
    if (activeHost && activeHost !== host) cleanup(activeHost);
    activeHost = host;
    cleanup(host);
    var token = String(++sequence);
    host.setAttribute('data-shared-mount-token', token);
    host.setAttribute('aria-busy', 'false');
    if (!items.length) {
      host.innerHTML = '<section class="lp-shared-preview lp-shared-preview--empty" aria-label="Selected file preview">' +
        '<div class="lp-shared-preview-head"><div><span class="lp-shared-kicker">PREVIEW WORKSPACE</span>' +
        '<h2>Your files will appear here</h2><p>Select a file to get started.</p></div></div></section>';
      return Promise.resolve(true);
    }
    var countLabel = items.length + (items.length === 1 ? ' file' : ' files');
    var addMore = options.multipleFiles
      ? '<button type="button" class="lp-shared-add" data-shared-add-files><span aria-hidden="true">＋</span> Add more files</button>'
      : '';
    host.innerHTML = '<section class="lp-shared-preview" aria-label="Selected file preview">' +
      '<header class="lp-shared-preview-head"><div><span class="lp-shared-kicker">PREVIEW WORKSPACE</span>' +
      '<h2>' + (items.length > 1 ? 'Review your files' : 'Review your file') + '</h2>' +
      '<p>Check your selection before processing. Your original files stay unchanged.</p></div>' +
      '<span class="lp-shared-count">' + countLabel + '</span></header>' +
      '<ul class="lp-shared-file-list">' + items.map(function (file, index) {
        var name = String(file && file.name || ('File ' + (index + 1)));
        var ext = extension(file);
        var mime = String(file && file.type || '').split('/').pop().replace(/[^a-z0-9.+-]/gi, '').toUpperCase();
        var label = mime || ext || 'FILE';
        var reorder = toolId === 'merge' && items.length > 1
          ? '<span class="lp-shared-reorder" aria-label="Reorder files">' +
            (index > 0 ? '<button type="button" data-shared-move="up" data-shared-index="' + index +
              '" aria-label="Move ' + attr(name) + ' up" title="Move up">↑</button>' : '') +
            (index < items.length - 1 ? '<button type="button" data-shared-move="down" data-shared-index="' + index +
              '" aria-label="Move ' + attr(name) + ' down" title="Move down">↓</button>' : '') + '</span>' : '';
        return '<li class="lp-shared-file-card"><span class="lp-shared-index">' + (index + 1) + '</span>' +
          visual(file, index) + '<span class="lp-shared-file-info"><strong title="' + attr(name) + '">' +
          esc(name) + '</strong><small>' + esc(bytes(Number(file && file.size))) + ' <span aria-hidden="true">·</span> ' +
          esc(label) + '</small><span class="lp-shared-ready"><span aria-hidden="true"></span>Ready to process</span></span>' +
          reorder + '<button class="lp-shared-remove" type="button" data-shared-remove="' + index +
          '" aria-label="Remove ' + attr(name) + '" title="Remove file">×</button></li>';
      }).join('') + '</ul><div class="lp-shared-preview-foot"><span>' + countLabel + ' · ' +
      esc(bytes(totalBytes(items))) + ' total</span>' + addMore + '</div>' +
      '<p class="lp-shared-preview-note">Processing starts only when you press the Process button.</p></section>';

    host.querySelectorAll('[data-shared-remove]').forEach(function (button) {
      button.addEventListener('click', function () {
        var index = Number(button.getAttribute('data-shared-remove'));
        if (typeof window.removeFile === 'function') window.removeFile(index);
      });
    });
    host.querySelectorAll('[data-shared-move]').forEach(function (button) {
      button.addEventListener('click', function () {
        var index = Number(button.getAttribute('data-shared-index'));
        var delta = button.getAttribute('data-shared-move') === 'up' ? -1 : 1;
        if (typeof window.moveMergePreviewFile === 'function') window.moveMergePreviewFile(index, index + delta);
      });
    });
    host.querySelectorAll('[data-shared-add-files]').forEach(function (button) {
      button.addEventListener('click', function () { openAddFiles(options); });
    });
    hydratePdfThumbnails(items, host);
    return Promise.resolve(true);
  }
  window.SharedFilePreview = {
    mount: mount,
    supported: function (toolId) { return TOOL_IDS.has(toolId); },
    hydratePdfThumbnails: hydratePdfThumbnails
  };
  window.addEventListener('ilpdf:step', function (event) {
    if (event && event.detail && event.detail.step === 'preview') return;
    if (activeHost) cleanup(activeHost);
    activeHost = null;
  });
  window.addEventListener('pagehide', function () {
    if (activeHost) cleanup(activeHost);
    activeHost = null;
  });
}());
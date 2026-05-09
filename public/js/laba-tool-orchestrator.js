/**
 * LABA UNIVERSAL TOOL ORCHESTRATOR  v1.0
 * window.LabaToolOrchestrator  |  window.LabaToolRegistry
 *
 * Purely additive — augments LabaAiChat with:
 *   • File upload (button, drag-drop, paste) inside the chat panel
 *   • Intent detection → tool routing (33 tools)
 *   • Tool execution via window.BrowserTools.process OR server API
 *   • Streaming progress + download-ready result cards in chat
 *
 * No existing modules are modified.
 */
(function () {
  'use strict';

  if (window.LabaToolOrchestrator) return;

  var LOG = '[LTO]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ═══════════════════════════════════════════════════════════════════
  // § 1  TOOL REGISTRY
  // ═══════════════════════════════════════════════════════════════════
  var TOOLS = [
    { id:'compress',          name:'Compress PDF',         endpoint:'/api/compress',           accepts:['.pdf'],                               multiple:false,
      intents:[/compress/i,/reduce.*size/i,/shrink/i,/smaller.*pdf/i,/file.*size/i,/make.*smaller/i] },
    { id:'merge',             name:'Merge PDFs',           endpoint:'/api/merge',              accepts:['.pdf'],                               multiple:true,
      intents:[/merge/i,/combin/i,/join.*pdf/i,/concat/i,/together/i,/multiple.*pdf/i] },
    { id:'split',             name:'Split PDF',            endpoint:'/api/split',              accepts:['.pdf'],                               multiple:false,
      intents:[/split/i,/extract.*page/i,/separate/i,/divide/i,/cut.*page/i] },
    { id:'rotate',            name:'Rotate PDF',           endpoint:'/api/rotate',             accepts:['.pdf'],                               multiple:false,
      intents:[/rotat/i,/turn.*page/i,/flip.*page/i,/upside.*down/i,/orientation/i] },
    { id:'watermark',         name:'Watermark PDF',        endpoint:'/api/watermark',          accepts:['.pdf'],                               multiple:false,
      intents:[/watermark/i,/stamp/i,/overlay.*text/i,/add.*text.*pdf/i] },
    { id:'protect',           name:'Protect PDF',          endpoint:'/api/protect',            accepts:['.pdf'],                               multiple:false,
      intents:[/protect/i,/password/i,/encrypt/i,/lock.*pdf/i,/secure.*pdf/i] },
    { id:'unlock',            name:'Unlock PDF',           endpoint:'/api/unlock',             accepts:['.pdf'],                               multiple:false,
      intents:[/unlock/i,/remove.*password/i,/decrypt/i,/open.*lock/i,/unprotect/i] },
    { id:'repair',            name:'Repair PDF',           endpoint:'/api/repair',             accepts:['.pdf'],                               multiple:false,
      intents:[/repair/i,/fix.*pdf/i,/corrupt/i,/damaged/i,/broken.*pdf/i] },
    { id:'ocr',               name:'OCR PDF',              endpoint:'/api/ocr',                accepts:['.pdf','.jpg','.jpeg','.png'],          multiple:false,
      intents:[/\bocr\b/i,/extract.*text/i,/recogni[sz]e.*text/i,/text.*from.*image/i,/read.*scan/i,/scan.*text/i] },
    { id:'compare',           name:'Compare PDFs',         endpoint:'/api/compare',            accepts:['.pdf'],                               multiple:true,
      intents:[/compar/i,/\bdiff\b/i,/difference/i,/versus/i,/\bvs\b/i] },
    { id:'ai-summarize',      name:'AI Summarize',         endpoint:'/api/ai-summarize',       accepts:['.pdf'],                               multiple:false,
      intents:[/summar/i,/\btldr\b/i,/overview/i,/key.*point/i,/\bbrief\b/i,/main.*point/i,/synopsis/i] },
    { id:'translate',         name:'Translate PDF',        endpoint:'/api/translate',          accepts:['.pdf'],                               multiple:false,
      intents:[/translat/i,/change.*language/i,/convert.*language/i,/to (urdu|arabic|french|spanish|german|chinese|hindi|japanese|korean|russian|turkish)/i] },
    { id:'pdf-to-word',       name:'PDF to Word',          endpoint:'/api/pdf-to-word',        accepts:['.pdf'],                               multiple:false,
      intents:[/pdf.*(to|2).*word/i,/convert.*pdf.*word/i,/word.*from.*pdf/i,/\.docx/i,/make.*editable/i,/editable.*pdf/i] },
    { id:'pdf-to-excel',      name:'PDF to Excel',         endpoint:'/api/pdf-to-excel',       accepts:['.pdf'],                               multiple:false,
      intents:[/pdf.*(to|2).*excel/i,/extract.*table/i,/table.*excel/i,/\.xlsx/i,/spreadsheet/i] },
    { id:'pdf-to-powerpoint', name:'PDF to PowerPoint',    endpoint:'/api/pdf-to-powerpoint',  accepts:['.pdf'],                               multiple:false,
      intents:[/pdf.*(to|2).*powerpoint/i,/pdf.*(to|2).*pptx/i,/pdf.*(to|2).*ppt\b/i,/presentation.*from.*pdf/i,/pdf.*slides/i] },
    { id:'pdf-to-jpg',        name:'PDF to JPG',           endpoint:'/api/pdf-to-jpg',         accepts:['.pdf'],                               multiple:false,
      intents:[/pdf.*(to|2).*jpg/i,/pdf.*(to|2).*image/i,/pdf.*(to|2).*png/i,/screenshot.*pdf/i,/render.*pdf.*image/i] },
    { id:'word-to-pdf',       name:'Word to PDF',          endpoint:'/api/word-to-pdf',        accepts:['.doc','.docx'],                       multiple:false,
      intents:[/word.*(to|2).*pdf/i,/docx.*(to|2).*pdf/i,/convert.*word.*pdf/i,/doc.*to.*pdf/i] },
    { id:'powerpoint-to-pdf', name:'PowerPoint to PDF',    endpoint:'/api/powerpoint-to-pdf',  accepts:['.ppt','.pptx'],                       multiple:false,
      intents:[/ppt.*(to|2).*pdf/i,/powerpoint.*(to|2).*pdf/i,/presentation.*(to|2).*pdf/i,/slide.*(to|2).*pdf/i] },
    { id:'excel-to-pdf',      name:'Excel to PDF',         endpoint:'/api/excel-to-pdf',       accepts:['.xls','.xlsx'],                       multiple:false,
      intents:[/excel.*(to|2).*pdf/i,/xlsx.*(to|2).*pdf/i,/spreadsheet.*(to|2).*pdf/i,/csv.*(to|2).*pdf/i] },
    { id:'jpg-to-pdf',        name:'JPG to PDF',           endpoint:'/api/jpg-to-pdf',         accepts:['.jpg','.jpeg','.png','.gif','.webp'], multiple:true,
      intents:[/image.*(to|2).*pdf/i,/jpg.*(to|2).*pdf/i,/png.*(to|2).*pdf/i,/photo.*(to|2).*pdf/i,/picture.*(to|2).*pdf/i] },
    { id:'html-to-pdf',       name:'HTML to PDF',          endpoint:'/api/html-to-pdf',        accepts:['.html','.htm'],                       multiple:false,
      intents:[/html.*(to|2).*pdf/i,/webpage.*(to|2).*pdf/i,/website.*(to|2).*pdf/i] },
    { id:'background-remover',name:'Remove Background',    endpoint:'/api/background-remove',  accepts:['.jpg','.jpeg','.png','.webp'],         multiple:false,
      intents:[/remove.*background/i,/background.*remov/i,/\bbg\b.*remov/i,/transparent.*bg/i,/cut.*out/i,/erase.*background/i] },
    { id:'crop-image',        name:'Crop Image',           endpoint:'/api/crop-image',         accepts:['.jpg','.jpeg','.png','.webp'],         multiple:false,
      intents:[/crop.*image/i,/crop.*photo/i,/trim.*image/i,/cut.*image/i] },
    { id:'resize-image',      name:'Resize Image',         endpoint:'/api/resize-image',       accepts:['.jpg','.jpeg','.png','.webp'],         multiple:false,
      intents:[/resize.*image/i,/resize.*photo/i,/scale.*image/i,/change.*size.*image/i,/make.*image.*smaller/i,/make.*image.*bigger/i] },
    { id:'image-filters',     name:'Image Filters',        endpoint:'/api/filters',            accepts:['.jpg','.jpeg','.png','.webp'],         multiple:false,
      intents:[/filter/i,/grayscale/i,/\bsepia\b/i,/\bblur\b/i,/sharpen/i,/effect.*image/i,/black.*white.*image/i] },
    { id:'sign',              name:'Sign PDF',             endpoint:'/api/sign',               accepts:['.pdf'],                               multiple:false,
      intents:[/\bsign\b/i,/signature/i,/esign/i,/e-sign/i] },
    { id:'redact',            name:'Redact PDF',           endpoint:'/api/redact',             accepts:['.pdf'],                               multiple:false,
      intents:[/redact/i,/black.*out/i,/hide.*text/i,/censor/i,/mask.*text/i] },
    { id:'page-numbers',      name:'Add Page Numbers',     endpoint:'/api/page-numbers',       accepts:['.pdf'],                               multiple:false,
      intents:[/page.*number/i,/add.*number/i,/number.*page/i,/paginate/i] },
    { id:'edit',              name:'Edit PDF',             endpoint:'/api/edit',               accepts:['.pdf'],                               multiple:false,
      intents:[/edit.*pdf/i,/annotate/i,/add.*annotation/i,/mark.*up/i] },
    { id:'organize',          name:'Organize Pages',       endpoint:'/api/organize',           accepts:['.pdf'],                               multiple:false,
      intents:[/organiz/i,/reorder/i,/rearrange.*page/i,/sort.*page/i,/delete.*page/i] },
    { id:'crop',              name:'Crop PDF',             endpoint:'/api/crop',               accepts:['.pdf'],                               multiple:false,
      intents:[/crop.*pdf/i,/trim.*margin/i,/cut.*margin/i,/remove.*margin/i] },
    { id:'scan-to-pdf',       name:'Scan to PDF',          endpoint:'/api/scan-to-pdf',        accepts:['.jpg','.jpeg','.png'],                multiple:true,
      intents:[/scan.*(to|2).*pdf/i,/scanned.*image.*pdf/i,/photo.*to.*pdf/i] },
  ];

  var _SLUG_MAP = {
    'compress':'compress-pdf','merge':'merge-pdf','split':'split-pdf','rotate':'rotate-pdf',
    'watermark':'watermark-pdf','protect':'protect-pdf','unlock':'unlock-pdf','repair':'repair-pdf',
    'ocr':'ocr-pdf','compare':'compare-pdf','ai-summarize':'ai-summarizer','translate':'translate-pdf',
    'pdf-to-word':'pdf-to-word','pdf-to-excel':'pdf-to-excel','pdf-to-powerpoint':'pdf-to-powerpoint',
    'pdf-to-jpg':'pdf-to-jpg','word-to-pdf':'word-to-pdf','powerpoint-to-pdf':'powerpoint-to-pdf',
    'excel-to-pdf':'excel-to-pdf','jpg-to-pdf':'jpg-to-pdf','html-to-pdf':'html-to-pdf',
    'background-remover':'background-remover','crop-image':'crop-image','resize-image':'resize-image',
    'image-filters':'image-filters','sign':'sign-pdf','redact':'redact-pdf',
    'page-numbers':'add-page-numbers','edit':'edit-pdf','organize':'organize-pdf',
    'crop':'crop-pdf','scan-to-pdf':'scan-pdf',
  };

  window.LabaToolRegistry = {
    tools: TOOLS,

    findByIntent: function (text, fileExt) {
      var scored = [];
      for (var i = 0; i < TOOLS.length; i++) {
        var tool  = TOOLS[i];
        var score = 0;
        for (var j = 0; j < tool.intents.length; j++) {
          if (tool.intents[j].test(text)) { score += 10 + tool.intents[j].toString().length; break; }
        }
        if (fileExt) {
          var ext = fileExt.toLowerCase();
          if (tool.accepts.some(function (a) { return a === ext || a === '.' + ext.replace(/^\./, ''); })) score += 5;
        }
        if (score > 0) scored.push({ tool: tool, score: score });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.length ? scored[0].tool : null;
    },

    findById: function (id) {
      return TOOLS.find(function (t) { return t.id === id; }) || null;
    },
  };

  // ═══════════════════════════════════════════════════════════════════
  // § 2  UTILS
  // ═══════════════════════════════════════════════════════════════════
  function _ext(file)        { var n = (file && file.name) || ''; var d = n.lastIndexOf('.'); return d >= 0 ? n.slice(d).toLowerCase() : ''; }
  function _fmtSize(bytes)   { if (bytes < 1024) return bytes + ' B'; if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB'; return (bytes/1048576).toFixed(1) + ' MB'; }
  function _safe(s)          { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _guessExt(mime)   {
    return ({ 'application/pdf':'.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation':'.pptx',
              'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','text/plain':'.txt','application/zip':'.zip' })[mime] || '';
  }
  function _mdToHtml(text) {
    return (text || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/```([\s\S]*?)```/g, '<pre style="background:#1e1b4b;color:#e0e7ff;padding:8px;border-radius:6px;font-size:11px;overflow:auto;margin:4px 0">$1</pre>')
      .replace(/`([^`]+)`/g, '<code style="background:#ede9fe;color:#4f46e5;padding:1px 4px;border-radius:3px;font-size:11px">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#4f46e5;text-decoration:underline">$1</a>')
      .replace(/\n\n/g, '</p><p style="margin:6px 0 0">').replace(/\n/g, '<br>');
  }

  // ═══════════════════════════════════════════════════════════════════
  // § 3  FILE STORE (files staged in chat input area)
  // ═══════════════════════════════════════════════════════════════════
  var _stagedFiles = [];

  function _stageFiles(fileList) {
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (f && !_stagedFiles.find(function (x) { return x.name === f.name && x.size === f.size; })) {
        _stagedFiles.push(f);
      }
    }
    _renderFilesBar();
  }

  function _unstageFile(idx) { _stagedFiles.splice(idx, 1); _renderFilesBar(); }
  function _clearStaged()    { _stagedFiles = []; _renderFilesBar(); }

  // ═══════════════════════════════════════════════════════════════════
  // § 4  TOOL EXECUTOR
  // ═══════════════════════════════════════════════════════════════════
  async function _executeTool(tool, files, options, onProgress) {
    if (!files || !files.length) throw new Error('No files provided.');

    onProgress('🔧 Starting ' + tool.name + '…');

    // ① Try BrowserTools.process (client-side, no upload)
    var BT = window.BrowserTools;
    if (BT && typeof BT.process === 'function') {
      try {
        onProgress('⚡ Processing in browser (no upload needed)…');
        var btResult = await BT.process(tool.id, files, options || {});
        if (btResult) return { type: 'browsertools', result: btResult };
      } catch (btErr) {
        warn('BrowserTools.process →', tool.id, ':', btErr.message, '— trying server…');
      }
    }

    // ② Server API fallback
    onProgress('📤 Uploading ' + _fmtSize(files.reduce(function(a,f){return a+f.size;},0)) + '…');
    var fd = new FormData();
    if (tool.multiple) {
      files.forEach(function (f) { fd.append('files', f); });
    } else {
      fd.append('file', files[0]);
    }
    if (options) Object.keys(options).forEach(function (k) { fd.append(k, options[k]); });

    onProgress('⚙️ Processing with ' + tool.name + '…');
    var resp = await fetch(tool.endpoint, { method: 'POST', body: fd });

    if (!resp.ok) {
      var errMsg = '';
      try { var j = await resp.json(); errMsg = j.error || j.message || ''; } catch (_) {}
      throw new Error(errMsg || 'Server error ' + resp.status);
    }

    var ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      var json = await resp.json();
      return { type: 'json', data: json };
    }

    onProgress('📥 Preparing download…');
    var blob = await resp.blob();
    var disp = resp.headers.get('content-disposition') || '';
    var fnm  = (disp.match(/filename[^;=\n]*=\s*["']?([^"';\n]+)/i) || [])[1] || ('result-' + tool.id + _guessExt(blob.type));
    return { type: 'file', blob: blob, filename: fnm.trim() };
  }

  // ═══════════════════════════════════════════════════════════════════
  // § 5  CHAT PANEL AUGMENTATION
  // ═══════════════════════════════════════════════════════════════════
  var _chatPatched = false;

  function _injectStyles() {
    if (document.getElementById('lto-styles')) return;
    var s = document.createElement('style');
    s.id = 'lto-styles';
    s.textContent = [
      /* file-attach button */
      '.lto-file-btn{background:#ede9fe;color:#4f46e5;border:1px solid #ddd6fe;border-radius:8px;',
      '  padding:5px 9px;cursor:pointer;font-size:15px;flex-shrink:0;line-height:1;transition:background .15s;}',
      '.lto-file-btn:hover{background:#ddd6fe;}',
      /* file chips */
      '.lto-files-bar{padding:4px 10px 0;display:flex;flex-wrap:wrap;gap:4px;flex-shrink:0;}',
      '.lto-files-bar:empty{padding:0;}',
      '.lto-file-chip{display:inline-flex;align-items:center;gap:5px;background:#f3f4f6;border:1px solid #e5e7eb;',
      '  border-radius:8px;padding:3px 8px;font-size:11px;color:#374151;max-width:200px;}',
      '.lto-file-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.lto-rm{cursor:pointer;color:#9ca3af;font-size:10px;flex-shrink:0;padding:0 1px;}',
      '.lto-rm:hover{color:#ef4444;}',
      /* progress */
      '.lto-progress{display:none;padding:5px 12px;font-size:11px;color:#6366f1;',
      '  background:#f5f3ff;border-top:1px solid #ede9fe;flex-shrink:0;}',
      '.lto-progress.lto-visible{display:block;}',
      /* result card */
      '.lto-result-card{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;margin-top:8px;}',
      '.lto-dl-btn{display:inline-flex;align-items:center;gap:6px;',
      '  background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff!important;',
      '  border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;',
      '  cursor:pointer;text-decoration:none!important;margin-top:6px;}',
      '.lto-dl-btn:hover{opacity:.88;}',
      /* drop zone highlight */
      '#laba-ai-chat-panel.lto-drag-over{outline:2px dashed #6366f1;outline-offset:-3px;}',
    ].join('');
    document.head.appendChild(s);
  }

  function _patchPanel() {
    if (_chatPatched) return;
    var panel = document.getElementById('laba-ai-chat-panel');
    if (!panel) return;
    _chatPatched = true;

    _injectStyles();

    // ── File input (hidden) ──────────────────────────────────────────
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id   = 'lto-file-input';
    fileInput.multiple = true;
    fileInput.accept = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.html,.htm,.jpg,.jpeg,.png,.webp,.gif,.txt,.csv,.zip';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () { _stageFiles(fileInput.files); fileInput.value = ''; });
    panel.appendChild(fileInput);

    // ── Attach button injected BEFORE the textarea in .lac-input-area ─
    var inputArea = panel.querySelector('.lac-input-area');
    if (inputArea) {
      var btn = document.createElement('button');
      btn.className  = 'lto-file-btn';
      btn.title      = 'Upload file';
      btn.type       = 'button';
      btn.innerHTML  = '📎';
      btn.addEventListener('click', function () { fileInput.click(); });
      inputArea.insertBefore(btn, inputArea.firstChild);
    }

    // ── Files bar (above input area) ─────────────────────────────────
    var filesBar = document.createElement('div');
    filesBar.className = 'lto-files-bar';
    filesBar.id        = 'lto-files-bar';
    if (inputArea) inputArea.parentNode.insertBefore(filesBar, inputArea);

    // ── Progress strip ───────────────────────────────────────────────
    var prog = document.createElement('div');
    prog.className = 'lto-progress';
    prog.id        = 'lto-progress';
    if (inputArea) inputArea.parentNode.insertBefore(prog, inputArea);

    // ── Drag & drop onto panel ───────────────────────────────────────
    panel.addEventListener('dragover', function (e) {
      e.preventDefault();
      panel.classList.add('lto-drag-over');
    });
    panel.addEventListener('dragleave', function (e) {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('lto-drag-over');
    });
    panel.addEventListener('drop', function (e) {
      e.preventDefault();
      panel.classList.remove('lto-drag-over');
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) _stageFiles(dt.files);
    });

    // ── Paste image from clipboard ───────────────────────────────────
    panel.addEventListener('paste', function (e) {
      var items = ((e.clipboardData || {}).items) || [];
      var pastedFiles = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') pastedFiles.push(items[i].getAsFile());
      }
      if (pastedFiles.length) { e.preventDefault(); _stageFiles(pastedFiles); }
    });

    // ── Enter key intercept when files are staged ────────────────────
    var input = panel.querySelector('#lac-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && _stagedFiles.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          _dispatchWithFiles((input.value || '').trim());
          input.value = '';
          if (input.style) input.style.height = 'auto';
        }
      }, true);
    }

    // ── Send button intercept when files are staged ──────────────────
    var sendBtn = panel.querySelector('#lac-send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', function (e) {
        if (_stagedFiles.length > 0) {
          e.stopImmediatePropagation();
          var text = input ? (input.value || '').trim() : '';
          if (input) { input.value = ''; if (input.style) input.style.height = 'auto'; }
          _dispatchWithFiles(text);
        }
      }, true);
    }

    log('chat panel patched — file upload + drag-drop ready');
  }

  function _renderFilesBar() {
    var bar = document.getElementById('lto-files-bar');
    if (!bar) return;
    bar.innerHTML = '';
    _stagedFiles.forEach(function (f, idx) {
      var chip = document.createElement('span');
      chip.className = 'lto-file-chip';
      chip.title = f.name;

      var icon = _ext(f) === '.pdf' ? '📄' : /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name) ? '🖼️' : '📎';
      var name = document.createElement('span');
      name.className = 'lto-file-chip-name';
      name.textContent = icon + ' ' + f.name.slice(0, 28) + (f.name.length > 28 ? '…' : '') + ' (' + _fmtSize(f.size) + ')';

      var rm = document.createElement('span');
      rm.className = 'lto-rm';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.addEventListener('click', (function (i) { return function () { _unstageFile(i); }; })(idx));

      chip.appendChild(name);
      chip.appendChild(rm);
      bar.appendChild(chip);
    });
  }

  function _setProgress(msg) {
    var el = document.getElementById('lto-progress');
    if (!el) return;
    if (msg) { el.textContent = msg; el.classList.add('lto-visible'); }
    else     { el.textContent = ''; el.classList.remove('lto-visible'); }
  }

  // ═══════════════════════════════════════════════════════════════════
  // § 6  DISPATCH — tool intent → execute → render result
  // ═══════════════════════════════════════════════════════════════════
  var _busy = false;

  function _dispatchWithFiles(userText) {
    if (_busy) { warn('busy, ignoring request'); return; }
    var files = _stagedFiles.slice();
    _clearStaged();

    var autoText = userText || _inferCommand(files);
    _handleRequest(autoText, files).catch(function (err) {
      warn('unhandled error in _handleRequest:', err);
    });
  }

  function _inferCommand(files) {
    if (!files.length) return 'What can I do?';
    var e = _ext(files[0]);
    if (e === '.pdf' && files.length > 1) return 'Merge these PDFs';
    if (e === '.pdf')                      return 'What can I do with this PDF?';
    if (['.jpg','.jpeg','.png','.webp'].includes(e)) return 'What can I do with this image?';
    if (['.doc','.docx'].includes(e))     return 'Convert this to PDF';
    if (['.ppt','.pptx'].includes(e))     return 'Convert this presentation to PDF';
    if (['.xls','.xlsx'].includes(e))     return 'Convert this spreadsheet to PDF';
    return 'Process this file';
  }

  async function _handleRequest(userText, files) {
    _busy = true;
    try {
      var LAC    = window.LabaAiChat;
      var msgEl  = document.getElementById('lac-messages');
      if (!msgEl) { _busy = false; return; }

      // Remove empty-state placeholder if present
      var es = msgEl.querySelector('.lac-empty-state');
      if (es) es.remove();

      // Show user message
      _appendMsg(msgEl, 'user', userText + (files.length ? '\n\n_📎 ' + files.length + ' file(s) attached_' : ''));

      // Remember in LAC memory
      var sessId = LAC && LAC.getSession ? LAC.getSession() : null;
      if (LAC && LAC.Memory && sessId) LAC.Memory.add(sessId, 'user', userText);

      // No files — pass straight to LAC query engine
      if (!files.length) {
        if (LAC && LAC.send) {
          _busy = false;
          LAC.send(userText);
          return;
        }
        _busy = false;
        return;
      }

      // Detect tool intent
      var fileExt = _ext(files[0]);
      var tool    = window.LabaToolRegistry.findByIntent(userText, fileExt);

      if (!tool) {
        // No specific tool matched — offer suggestions
        var suggestions = _suggestForFile(files[0]);
        _appendMsg(msgEl, 'assistant',
          '📎 **' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' attached** (' + files.map(function(f){return f.name;}).join(', ') + ')\n\n' + suggestions
        );
        if (LAC && LAC.Memory && sessId) LAC.Memory.add(sessId, 'assistant', suggestions);
        _busy = false;
        return;
      }

      // Announce the plan
      var plan = '🎯 Running **' + tool.name + '** on ' + _descFiles(files) + '…';
      _appendMsg(msgEl, 'assistant', plan);
      if (LAC && LAC.Memory && sessId) LAC.Memory.add(sessId, 'assistant', plan);

      // Execute
      try {
        var result = await _executeTool(tool, files, {}, _setProgress);
        _setProgress('');
        _renderResult(msgEl, result, tool, sessId, LAC);
      } catch (err) {
        _setProgress('');
        warn('tool execution error:', err);
        var toolUrl = '/' + (_SLUG_MAP[tool.id] || tool.id);
        var errTxt = '❌ **' + _safe(tool.name) + ' failed:** ' + _safe(err.message) +
                     '\n\nYou can try the tool directly → [Open ' + _safe(tool.name) + '](' + toolUrl + ')';
        _appendMsg(msgEl, 'assistant', errTxt);
        if (LAC && LAC.Memory && sessId) LAC.Memory.add(sessId, 'assistant', errTxt);
      }
    } finally {
      _busy = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // § 7  RESULT RENDERER
  // ═══════════════════════════════════════════════════════════════════
  function _renderResult(msgEl, result, tool, sessId, LAC) {
    var div    = document.createElement('div');
    div.className = 'lac-msg assistant';
    var avatar = document.createElement('div');
    avatar.className = 'lac-avatar';
    avatar.textContent = '✦';
    var bubble = document.createElement('div');
    bubble.className = 'lac-bubble';

    if (result.type === 'json') {
      var d    = result.data || {};
      var body = d.summary || d.text || d.result || '';
      if (!body && d.similarity !== undefined) body = '**Similarity:** ' + (d.similarity * 100).toFixed(1) + '%\n\n' + (d.report || '');
      if (!body) body = '```json\n' + JSON.stringify(d, null, 2).slice(0, 800) + '\n```';
      bubble.innerHTML = '<p>✅ <strong>' + _safe(tool.name) + ' complete!</strong></p><p style="margin:4px 0 0">' + _mdToHtml(body.slice(0, 2000)) + '</p>';
      if (LAC && LAC.Memory && sessId) LAC.Memory.add(sessId, 'assistant', '✅ ' + tool.name + ' complete. ' + body.slice(0, 200));

    } else {
      var blob     = result.type === 'file' ? result.blob : (result.result && result.result.blob);
      var filename = result.type === 'file' ? result.filename : ((result.result && result.result.filename) || ('result' + _guessExt((blob||{}).type)));

      if (blob) {
        var url = URL.createObjectURL(blob);
        setTimeout(function () { URL.revokeObjectURL(url); }, 12 * 60 * 1000); // revoke after 12 min

        bubble.innerHTML = [
          '<p>✅ <strong>', _safe(tool.name), ' complete!</strong></p>',
          '<div class="lto-result-card">',
            '<div style="font-size:12px;color:#166534;margin-bottom:6px">',
              '📄 <strong>', _safe(filename), '</strong> &nbsp;·&nbsp; ', _fmtSize(blob.size),
            '</div>',
            '<a class="lto-dl-btn" href="', url, '" download="', _safe(filename), '">',
              '⬇️ Download Result',
            '</a>',
          '</div>',
        ].join('');
        if (LAC && LAC.Memory && sessId) LAC.Memory.add(sessId, 'assistant', '✅ ' + tool.name + ' complete — ' + filename + ' ready to download.');
      } else {
        bubble.innerHTML = '<p>✅ <strong>' + _safe(tool.name) + ' complete!</strong> Result processed in browser.</p>';
        if (LAC && LAC.Memory && sessId) LAC.Memory.add(sessId, 'assistant', '✅ ' + tool.name + ' complete.');
      }
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    msgEl.appendChild(div);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════════
  // § 8  HELPERS
  // ═══════════════════════════════════════════════════════════════════
  function _appendMsg(msgEl, role, text) {
    var div    = document.createElement('div');
    div.className = 'lac-msg ' + role;
    var avatar = document.createElement('div');
    avatar.className = 'lac-avatar';
    avatar.textContent = role === 'user' ? '👤' : '✦';
    var bubble = document.createElement('div');
    bubble.className = 'lac-bubble';
    bubble.innerHTML = '<p style="margin:0">' + _mdToHtml(text) + '</p>';
    div.appendChild(avatar);
    div.appendChild(bubble);
    msgEl.appendChild(div);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  function _descFiles(files) {
    if (!files.length) return 'file';
    if (files.length === 1) return '"' + _safe(files[0].name) + '"';
    return files.length + ' files';
  }

  function _suggestForFile(file) {
    var e = _ext(file);
    var n = _safe(file.name);
    if (e === '.pdf') return [
      '**Here\'s what I can do with** _' + n + '_:\n',
      '• Say **"compress"** — reduce file size',
      '• Say **"to Word"** — make it editable',
      '• Say **"OCR"** — extract text from scanned pages',
      '• Say **"summarize"** — get key points',
      '• Say **"split"** — extract specific pages',
      '• Say **"merge"** — attach more PDFs to combine',
      '\n_Just tell me what you\'d like to do!_',
    ].join('\n');
    if (['.doc','.docx'].includes(e)) return '**"' + n + '"** is a Word document.\n\n• Say **"to PDF"** to convert it.';
    if (['.ppt','.pptx'].includes(e)) return '**"' + n + '"** is a presentation.\n\n• Say **"to PDF"** to convert it.';
    if (['.xls','.xlsx'].includes(e)) return '**"' + n + '"** is a spreadsheet.\n\n• Say **"to PDF"** to convert it.';
    if (['.jpg','.jpeg','.png','.webp'].includes(e)) return [
      '**Here\'s what I can do with** _' + n + '_:\n',
      '• Say **"remove background"** — transparent PNG',
      '• Say **"resize"** — change dimensions',
      '• Say **"to PDF"** — convert to PDF',
      '• Say **"filters"** — apply effects (grayscale, sepia…)',
      '\n_Just tell me what you\'d like!_',
    ].join('\n');
    return '📎 **File attached:** _' + n + '_\n\nTell me what you\'d like to do with it!';
  }

  // ═══════════════════════════════════════════════════════════════════
  // § 9  BOOTSTRAP
  // ═══════════════════════════════════════════════════════════════════
  var _attempts = 0;
  var _timer = setInterval(function () {
    _attempts++;
    var panel = document.getElementById('laba-ai-chat-panel');
    if (panel) {
      clearInterval(_timer);
      _patchPanel();
      log('v1.0 ready — ' + TOOLS.length + ' tools, chat panel patched');
    } else if (window.LabaAiChat && !panel) {
      // Panel not yet in DOM — keep waiting
    } else if (_attempts > 40) {
      clearInterval(_timer);
      warn('chat panel not found after 20 s — abandoning patch');
    }
  }, 500);

  // Also try at DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_patchPanel, 2000); });
  } else {
    setTimeout(_patchPanel, 2000);
  }

  // ── Public API ───────────────────────────────────────────────────────
  window.LabaToolOrchestrator = {
    version:       '1.0',
    registry:      window.LabaToolRegistry,
    stagedFiles:   function () { return _stagedFiles.slice(); },
    stageFiles:    _stageFiles,
    clearStaged:   _clearStaged,
    executeTool:   function (toolId, files, opts) {
      var tool = window.LabaToolRegistry.findById(toolId);
      if (!tool) return Promise.reject(new Error('Unknown tool: ' + toolId));
      return _executeTool(tool, files, opts || {}, _setProgress);
    },
  };

  // ── LabaToolRouter — canonical routing API ───────────────────────────
  window.LabaToolRouter = {
    version: '1.0',

    // Detect intent label from a text message
    detectIntent: function (message) {
      return window.LabaToolRegistry.findByIntent(message, null);
    },

    // Detect best tool given files + message
    detectTool: function (files, message) {
      var ext = (files && files.length)
        ? (function (n) { var d = n.lastIndexOf('.'); return d >= 0 ? n.slice(d).toLowerCase() : ''; })(files[0].name)
        : null;
      return window.LabaToolRegistry.findByIntent(message || '', ext);
    },

    // Execute a tool by id against an array of File objects
    executeTool: function (toolId, files, options) {
      var tool = window.LabaToolRegistry.findById(toolId);
      if (!tool) return Promise.reject(new Error('Unknown tool: ' + toolId));
      return _executeTool(tool, files, options || {}, _setProgress);
    },

    // Stream progress text into the chat progress strip
    streamProgress: _setProgress,

    // Dispatch files + message through the full intent→execute→result pipeline
    dispatch: function (message, files) {
      _stageFiles(files || []);
      _dispatchWithFiles(message || '');
    },
  };

  log('LabaToolOrchestrator loaded — waiting for chat panel…');
}());

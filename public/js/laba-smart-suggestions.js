/**
 * PHASE 2 — LABA SMART SUGGESTIONS
 * window.LabaSmartSuggestions
 *
 * Context-aware next-action suggestion chips after every tool run.
 * Shows recent files section in chat. Memory-aware prompts.
 * Purely additive. No external deps.
 */
(function () {
  'use strict';

  if (window.LabaSmartSuggestions) return;

  var VERSION = '2.0';
  var LOG     = '[LSS]';

  function log()  { var a = [].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = [].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  SUGGESTION MAP
  // toolId → [{label, prompt, icon}]
  // ═══════════════════════════════════════════════════════════════════════════
  var SUGGESTION_MAP = {
    'compress':         [
      { icon: '📎', label: 'Merge PDFs',    prompt: 'Merge PDFs' },
      { icon: '✍️',  label: 'Sign PDF',     prompt: 'Sign this PDF' },
      { icon: '📝',  label: 'Convert to Word', prompt: 'Convert to Word' },
    ],
    'merge':            [
      { icon: '🗜️', label: 'Compress',      prompt: 'Compress the merged PDF' },
      { icon: '✍️',  label: 'Sign PDF',     prompt: 'Sign this PDF' },
      { icon: '🔒',  label: 'Protect PDF',  prompt: 'Protect with password' },
    ],
    'split':            [
      { icon: '🗜️', label: 'Compress',      prompt: 'Compress this PDF' },
      { icon: '📝',  label: 'Convert to Word', prompt: 'Convert to Word' },
      { icon: '🔍',  label: 'OCR',          prompt: 'Extract text with OCR' },
    ],
    'ocr':              [
      { icon: '🌐', label: 'Translate',     prompt: 'Translate to English' },
      { icon: '✂️',  label: 'Summarize',    prompt: 'Summarize the extracted text' },
      { icon: '📊',  label: 'To Excel',     prompt: 'Export tables to Excel' },
    ],
    'translate':        [
      { icon: '✂️',  label: 'Summarize',    prompt: 'Summarize the translation' },
      { icon: '📄',  label: 'Save as PDF',  prompt: 'Convert to PDF' },
      { icon: '📊',  label: 'Extract data', prompt: 'Extract key data' },
    ],
    'ai-summarize':     [
      { icon: '🌐', label: 'Translate',     prompt: 'Translate to Urdu' },
      { icon: '📤',  label: 'Export',       prompt: 'Download summary as text' },
      { icon: '🔍',  label: 'Find risks',   prompt: 'Find legal risks in this document' },
    ],
    'pdf-to-word':      [
      { icon: '📊',  label: 'To Excel',     prompt: 'Convert tables to Excel' },
      { icon: '✂️',  label: 'Summarize',    prompt: 'Summarize document' },
      { icon: '🌐',  label: 'Translate',    prompt: 'Translate the document' },
    ],
    'pdf-to-excel':     [
      { icon: '🗜️', label: 'Compress PDF', prompt: 'Compress the original PDF' },
      { icon: '✂️',  label: 'Summarize',   prompt: 'Summarize the data' },
      { icon: '✍️',  label: 'Sign PDF',    prompt: 'Sign the original PDF' },
    ],
    'word-to-pdf':      [
      { icon: '🗜️', label: 'Compress',     prompt: 'Compress the PDF' },
      { icon: '✍️',  label: 'Sign',        prompt: 'Sign this PDF' },
      { icon: '🔒',  label: 'Protect',     prompt: 'Protect with password' },
    ],
    'jpg-to-pdf':       [
      { icon: '🗜️', label: 'Compress',     prompt: 'Compress the PDF' },
      { icon: '🔍',  label: 'OCR',         prompt: 'Extract text with OCR' },
      { icon: '📎',  label: 'Merge',       prompt: 'Merge multiple PDFs' },
    ],
    'background-remover': [
      { icon: '🔍',  label: 'OCR image',   prompt: 'Extract text from the image' },
      { icon: '📄',  label: 'To PDF',      prompt: 'Convert image to PDF' },
      { icon: '✂️',  label: 'Crop',        prompt: 'Crop the image' },
    ],
    'protect':          [
      { icon: '📎',  label: 'Merge PDFs',  prompt: 'Merge with another PDF' },
      { icon: '📊',  label: 'To Excel',    prompt: 'Extract tables to Excel' },
      { icon: '✂️',  label: 'Summarize',   prompt: 'Summarize this document' },
    ],
    'unlock':           [
      { icon: '✂️',  label: 'Summarize',   prompt: 'Summarize document' },
      { icon: '📝',  label: 'To Word',     prompt: 'Convert to Word' },
      { icon: '🗜️',  label: 'Compress',   prompt: 'Compress PDF' },
    ],
    'sign':             [
      { icon: '🗜️', label: 'Compress',     prompt: 'Compress the signed PDF' },
      { icon: '🔒',  label: 'Protect',     prompt: 'Protect with password' },
      { icon: '📤',  label: 'Download',    prompt: 'The file is ready to download' },
    ],
    'watermark':        [
      { icon: '✍️',  label: 'Sign',        prompt: 'Add signature' },
      { icon: '🗜️',  label: 'Compress',   prompt: 'Compress PDF' },
      { icon: '🔒',  label: 'Protect',     prompt: 'Protect with password' },
    ],
    'rotate':           [
      { icon: '🗜️', label: 'Compress',     prompt: 'Compress PDF' },
      { icon: '📝',  label: 'To Word',     prompt: 'Convert to Word' },
      { icon: '🔍',  label: 'OCR',         prompt: 'Extract text' },
    ],
    'crop-image':       [
      { icon: '🖼️',  label: 'Remove BG',  prompt: 'Remove background' },
      { icon: '📄',  label: 'To PDF',     prompt: 'Convert to PDF' },
      { icon: '✂️',  label: 'Resize',     prompt: 'Resize image' },
    ],
    'resize-image':     [
      { icon: '🖼️',  label: 'Remove BG',  prompt: 'Remove background' },
      { icon: '📄',  label: 'To PDF',     prompt: 'Convert to PDF' },
      { icon: '✂️',  label: 'Add filter', prompt: 'Apply image filter' },
    ],
    'compare':          [
      { icon: '✂️',  label: 'Summarize',   prompt: 'Summarize the differences' },
      { icon: '📊',  label: 'To Excel',    prompt: 'Extract data to Excel' },
      { icon: '🔍',  label: 'OCR',         prompt: 'Extract text from both documents' },
    ],
  };

  var DEFAULT_SUGGESTIONS = [
    { icon: '🗜️', label: 'Compress PDF',    prompt: 'Compress a PDF' },
    { icon: '📎',  label: 'Merge PDFs',      prompt: 'Merge PDFs' },
    { icon: '📝',  label: 'PDF to Word',     prompt: 'Convert PDF to Word' },
    { icon: '✂️',  label: 'Summarize PDF',  prompt: 'Summarize a PDF' },
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  STYLES
  // ═══════════════════════════════════════════════════════════════════════════
  function _injectStyles() {
    if (document.getElementById('lss-styles')) return;
    var s = document.createElement('style');
    s.id  = 'lss-styles';
    s.textContent = [
      '.lss-block{margin:4px 0 8px;}',
      '.lss-title{font-size:11px;color:#6b7280;font-weight:600;margin-bottom:5px;}',
      '.lss-chips{display:flex;flex-wrap:wrap;gap:5px;}',
      '.lss-chip{display:inline-flex;align-items:center;gap:4px;background:#ede9fe;color:#4f46e5;',
      '  border:1px solid #ddd6fe;border-radius:14px;padding:4px 10px;font-size:11px;',
      '  cursor:pointer;transition:background .15s;white-space:nowrap;}',
      '.lss-chip:hover{background:#ddd6fe;}',
      '.lss-chip-icon{font-size:12px;}',
      '.lss-files-block{background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;',
      '  padding:8px 10px;margin:6px 0;font-size:12px;}',
      '.lss-files-title{font-weight:700;color:#374151;margin-bottom:5px;}',
      '.lss-file-row{display:flex;align-items:center;gap:7px;padding:3px 0;color:#6b7280;}',
      '.lss-file-icon{font-size:13px;}',
      '.lss-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;color:#374151;}',
      '.lss-file-tool{font-size:10px;background:#f3f4f6;border-radius:5px;padding:1px 5px;}',
      '.lss-file-use-btn{margin-left:auto;font-size:10px;color:#4f46e5;cursor:pointer;border:none;background:none;padding:0;}',
      '.lss-file-use-btn:hover{text-decoration:underline;}',
      '.lss-memory-hint{background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:11px;color:#92400e;margin:4px 0;}',
    ].join('');
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  CHIP RENDERER
  // ═══════════════════════════════════════════════════════════════════════════
  function _renderSuggestionChips(suggestions, label) {
    var msgEl = document.getElementById('lac-messages');
    if (!msgEl) return;

    var wrap = document.createElement('div');
    wrap.className = 'lac-msg assistant';

    var inner = document.createElement('div');
    inner.style.flex = '1';
    inner.innerHTML = [
      '<div class="lss-block">',
      '<div class="lss-title">' + (label || '💡 What would you like to do next?') + '</div>',
      '<div class="lss-chips">',
      suggestions.map(function (s) {
        return '<button class="lss-chip" data-prompt="' + _esc(s.prompt) + '">' +
               '<span class="lss-chip-icon">' + (s.icon || '▶') + '</span>' +
               '<span>' + _esc(s.label) + '</span>' +
               '</button>';
      }).join(''),
      '</div>',
      '</div>',
    ].join('');

    inner.querySelectorAll('.lss-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var prompt = chip.getAttribute('data-prompt');
        if (!prompt) return;
        var LAC = sys('LabaAiChat');
        if (LAC && LAC.send) {
          LAC.send(prompt);
        } else {
          var input = document.getElementById('lac-input');
          if (input) { input.value = prompt; input.focus(); }
        }
        // Remove suggestion block after click
        wrap.remove();
      });
    });

    wrap.appendChild(inner);
    msgEl.appendChild(wrap);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  RECENT FILES SECTION
  // ═══════════════════════════════════════════════════════════════════════════
  async function _renderRecentFiles() {
    var MEM = sys('LabaMemorySystem');
    if (!MEM) return;

    var files = await MEM.recallRecentFiles(4);
    if (!files || !files.length) return;

    var msgEl = document.getElementById('lac-messages');
    if (!msgEl) return;

    var wrap = document.createElement('div');
    wrap.className = 'lac-msg assistant';
    wrap.setAttribute('id', 'lss-recent-files-block');

    var html = [
      '<div class="lss-files-block">',
      '<div class="lss-files-title">📂 Recent Files</div>',
    ];

    files.forEach(function (f) {
      html.push(
        '<div class="lss-file-row">',
        '<span class="lss-file-icon">' + _fileIcon(f.type) + '</span>',
        '<span class="lss-file-name" title="' + _esc(f.name) + '">' + _esc(f.name) + '</span>',
        f.lastTool ? '<span class="lss-file-tool">' + _esc(f.lastTool) + '</span>' : '',
        '<button class="lss-file-use-btn" data-filename="' + _esc(f.name) + '">Use again</button>',
        '</div>'
      );
    });

    html.push('</div>');
    wrap.innerHTML = html.join('');

    wrap.querySelectorAll('.lss-file-use-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-filename');
        var LAC  = sys('LabaAiChat');
        if (LAC && LAC.send) LAC.send('I want to work with ' + name + ' again');
      });
    });

    msgEl.appendChild(wrap);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  function _fileIcon(mime) {
    if (!mime) return '📄';
    if (mime.includes('pdf'))   return '📕';
    if (mime.includes('image')) return '🖼️';
    if (mime.includes('word') || mime.includes('docx')) return '📝';
    if (mime.includes('excel') || mime.includes('xlsx')) return '📊';
    return '📄';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  MEMORY HINT RENDERER
  // Shows a banner like "You previously uploaded contract.pdf…"
  // ═══════════════════════════════════════════════════════════════════════════
  async function _renderMemoryHint(query) {
    var MEM = sys('LabaMemorySystem');
    if (!MEM) return;

    var msgEl = document.getElementById('lac-messages');
    if (!msgEl) return;

    // Check if message mentions a file we remember
    var files = await MEM.recallRecentFiles(3);
    var match = files.find(function (f) {
      var name = (f.name || '').toLowerCase();
      var q    = (query || '').toLowerCase();
      return name && q.includes(name.split('.')[0]);
    });

    if (!match) return;

    var wrap = document.createElement('div');
    wrap.className = 'lac-msg assistant';
    wrap.innerHTML = [
      '<div class="lac-avatar">✦</div>',
      '<div class="lss-memory-hint">',
      '💾 You previously uploaded <strong>' + _esc(match.name) + '</strong>',
      match.lastTool ? ' and ran <strong>' + _esc(match.lastTool) + '</strong>' : '',
      '.',
      match.summary ? ' <em>' + _esc(match.summary.slice(0, 80)) + '…</em>' : '',
      ' Should I use that file again?',
      '</div>',
    ].join('');

    msgEl.appendChild(wrap);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                          .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  INIT + INTEGRATION HOOKS
  // ═══════════════════════════════════════════════════════════════════════════
  _injectStyles();

  // Hook into LabaToolOrchestrator result events
  function _hookOrchestrator() {
    var LTO = sys('LabaToolOrchestrator');
    if (!LTO) return false;
    if (LTO._lss_hooked) return true;
    LTO._lss_hooked = true;

    var original = LTO.onToolComplete;
    LTO.onToolComplete = function (toolId, result, files, sessionId) {
      if (typeof original === 'function') original.call(LTO, toolId, result, files, sessionId);
      window.LabaSmartSuggestions.showForTool(toolId, sessionId);
      // Remember the file
      var MEM = sys('LabaMemorySystem');
      if (MEM && files && files.length) {
        files.forEach(function (f) { MEM.rememberFile(f, { lastTool: toolId }); });
      }
    };
    return true;
  }

  // Try hooking after a delay so all systems are ready
  setTimeout(function () {
    if (!_hookOrchestrator()) {
      // Retry once more
      setTimeout(_hookOrchestrator, 2000);
    }
  }, 1500);

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.LabaSmartSuggestions = {
    version: VERSION,

    showForTool: function (toolId, sessionId) {
      var suggestions = SUGGESTION_MAP[toolId] || DEFAULT_SUGGESTIONS;
      _renderSuggestionChips(suggestions, '💡 Next suggested steps:');
    },

    showDefault: function () {
      _renderSuggestionChips(DEFAULT_SUGGESTIONS, '💡 Popular tools:');
    },

    showForQuery: function (query) {
      return _renderMemoryHint(query);
    },

    showRecentFiles: function () {
      return _renderRecentFiles();
    },

    renderChips: function (suggestions, label) {
      _renderSuggestionChips(suggestions, label);
    },

    getSuggestions: function (toolId) {
      return SUGGESTION_MAP[toolId] || DEFAULT_SUGGESTIONS;
    },

    audit: function () { return { version: VERSION, tools: Object.keys(SUGGESTION_MAP).length }; },
  };

  log('LabaSmartSuggestions v' + VERSION + ' ready');
}());

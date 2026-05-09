/**
 * PHASE 46 — LABA AI CHAT INTERFACE
 * window.LabaAiChat
 *
 * Floating, draggable, resizable AI assistant panel.
 * Purely additive. Integrates with LabaAiFoundation, SemanticSearchEngine,
 * WorkflowChainEngine, UnifiedDocumentContext, VectorMemoryEngine,
 * GenerativeAiEngine. Degrades gracefully at every layer.
 */
(function () {
  'use strict';

  // ── Singleton guard ───────────────────────────────────────────────────────
  if (window.LABA_AI_INITIALIZED) return;
  window.LABA_AI_INITIALIZED = true;
  if (window.LABA_CHAT_ACTIVE) return;
  window.LABA_CHAT_ACTIVE = true;

  var VERSION = '1.0';
  var LOG = '[LAC]';

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console, [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'lac_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }

  // ── Constants ────────────────────────────────────────────────────────────────
  var CHAT_DB   = 'lac_sessions_v1';
  var PANEL_ID  = 'laba-ai-chat-panel';
  var TOGGLE_ID = 'laba-ai-chat-toggle';
  var MAX_SESSIONS = 20;
  var MAX_MSGS_PER_SESSION = 200;

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  IDB SESSION STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var SessionStore = (function () {
    var _db = null;
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(CHAT_DB, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('messages')) {
            var ms = db.createObjectStore('messages', { keyPath: 'id' });
            ms.createIndex('session', 'sessionId', { unique: false });
          }
        };
        req.onsuccess = function (e) { _db = e.target.result; res(_db); };
        req.onerror   = function () { rej(req.error); };
      });
    }
    function put(store, obj) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(obj);
          tx.oncomplete = res; tx.onerror = res;
        });
      }).catch(function () {});
    }
    function getAll(store, indexName, key) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx  = db.transaction(store, 'readonly');
          var req = indexName
            ? tx.objectStore(store).index(indexName).getAll(key)
            : tx.objectStore(store).getAll();
          req.onsuccess = function () { res(req.result || []); };
          req.onerror   = function () { res([]); };
        });
      }).catch(function () { return []; });
    }
    function del(store, id) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).delete(id);
          tx.oncomplete = res; tx.onerror = res;
        });
      }).catch(function () {});
    }
    return { put: put, getAll: getAll, del: del };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  CHAT SESSION MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var ChatSessionManager = (function () {
    var _sessions = new Map();
    var _active   = null;

    function create(docId) {
      var s = { id: uid(), docId: docId || null, title: 'New Chat', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
      _sessions.set(s.id, s);
      SessionStore.put('sessions', s);
      _active = s.id;
      return s;
    }
    function activate(id) { if (_sessions.has(id)) { _active = id; return _sessions.get(id); } return null; }
    function get(id)     { return _sessions.get(id) || null; }
    function getActive() { return _sessions.get(_active) || null; }
    function list()      { return Array.from(_sessions.values()).sort(function (a,b) { return b.updatedAt - a.updatedAt; }); }
    function setTitle(id, title) {
      var s = _sessions.get(id);
      if (s) { s.title = title; s.updatedAt = Date.now(); SessionStore.put('sessions', s); }
    }
    function remove(id) { _sessions.delete(id); SessionStore.del('sessions', id); if (_active === id) _active = null; }
    function touch(id) { var s = _sessions.get(id); if (s) { s.updatedAt = Date.now(); s.messageCount++; SessionStore.put('sessions', s); } }

    async function restore() {
      try {
        var rows = await SessionStore.getAll('sessions');
        rows.forEach(function (r) { _sessions.set(r.id, r); });
        if (!_active && rows.length) _active = rows.sort(function (a,b) { return b.updatedAt - a.updatedAt; })[0].id;
        log('restored', _sessions.size, 'sessions');
      } catch (e) { warn('restore failed', e.message); }
    }

    return { create: create, activate: activate, get: get, getActive: getActive,
             list: list, setTitle: setTitle, remove: remove, touch: touch, restore: restore };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  CONVERSATION MEMORY
  // ═══════════════════════════════════════════════════════════════════════════
  var ConversationMemory = (function () {
    var _msgs = new Map(); // sessionId → []

    function add(sessionId, role, text, meta) {
      if (!_msgs.has(sessionId)) _msgs.set(sessionId, []);
      var arr = _msgs.get(sessionId);
      var msg = { id: uid(), sessionId: sessionId, role: role, text: text, ts: Date.now(), meta: meta || {} };
      arr.push(msg);
      if (arr.length > MAX_MSGS_PER_SESSION) arr.splice(0, arr.length - MAX_MSGS_PER_SESSION);
      SessionStore.put('messages', msg);
      ChatSessionManager.touch(sessionId);
      return msg;
    }

    function get(sessionId) { return (_msgs.get(sessionId) || []).slice(); }

    function getContext(sessionId, maxTokens) {
      var msgs = _msgs.get(sessionId) || [];
      var result = []; var tokens = 0;
      for (var i = msgs.length - 1; i >= 0; i--) {
        var t = Math.ceil(msgs[i].text.length / 4);
        if (tokens + t > (maxTokens || 2048)) break;
        result.unshift(msgs[i]);
        tokens += t;
      }
      return result;
    }

    async function loadSession(sessionId) {
      if (_msgs.has(sessionId)) return;
      try {
        var rows = await SessionStore.getAll('messages', 'session', sessionId);
        rows.sort(function (a, b) { return a.ts - b.ts; });
        _msgs.set(sessionId, rows);
      } catch (e) { _msgs.set(sessionId, []); }
    }

    function clear(sessionId) { _msgs.delete(sessionId); }

    return { add: add, get: get, getContext: getContext, loadSession: loadSession, clear: clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  CHAT CONTEXT ASSEMBLER
  // ═══════════════════════════════════════════════════════════════════════════
  var ChatContextAssembler = (function () {
    function build(sessionId, query) {
      var session = ChatSessionManager.get(sessionId);
      var docCtx  = '';

      // Pull document context from LabaAiFoundation or UnifiedDocumentContext
      if (session && session.docId) {
        var LAF = sys('LabaAiFoundation');
        if (LAF && LAF.UnifiedDocumentContext) {
          var ctx = LAF.UnifiedDocumentContext.get(session.docId);
          if (ctx) {
            docCtx = [
              ctx.ocrText   ? 'Document text: ' + ctx.ocrText.slice(0, 1500)   : '',
              ctx.summary   ? 'Summary: '        + ctx.summary.slice(0, 500)   : '',
              ctx.tables && ctx.tables.length ? 'Tables found: ' + ctx.tables.length : '',
            ].filter(Boolean).join('\n');
          }
        }
        // Also check VectorMemoryEngine for richer context
        var VME = sys('VectorMemoryEngine');
        if (VME && query) {
          try {
            var results = VME.search(query, session.docId, 3);
            if (results && results.length) {
              docCtx += '\nRelevant passages:\n' + results.map(function (r) { return '- ' + r.chunk; }).join('\n');
            }
          } catch (_) {}
        }
      }

      var history  = ConversationMemory.getContext(sessionId, 1200);
      var histText = history.map(function (m) { return m.role + ': ' + m.text; }).join('\n');

      return { docCtx: docCtx, history: histText, query: query, sessionId: sessionId };
    }
    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  STREAMING RESPONSE RENDERER (markdown-lite)
  // ═══════════════════════════════════════════════════════════════════════════
  var StreamingResponseRenderer = (function () {
    function _mdToHtml(text) {
      return text
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/```([\s\S]*?)```/g, '<pre class="lac-code"><code>$1</code></pre>')
        .replace(/`([^`]+)`/g, '<code class="lac-inline-code">$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^#{3} (.+)$/gm, '<h3>$1</h3>')
        .replace(/^#{2} (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
    }

    function render(el, text, streaming) {
      if (!el) return;
      el.innerHTML = '<p>' + _mdToHtml(text) + '</p>';
      if (streaming) el.classList.add('lac-streaming');
      else           el.classList.remove('lac-streaming');
    }

    function append(el, chunk) {
      if (!el) return;
      el.setAttribute('data-raw', (el.getAttribute('data-raw') || '') + chunk);
      el.innerHTML = '<p>' + _mdToHtml(el.getAttribute('data-raw')) + '</p>';
    }

    return { render: render, append: append };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  SEMANTIC CITATION BUILDER
  // ═══════════════════════════════════════════════════════════════════════════
  var SemanticCitationBuilder = (function () {
    function build(sessionId, query, answer) {
      var session = ChatSessionManager.get(sessionId);
      if (!session || !session.docId) return [];
      var LAF = sys('LabaAiFoundation');
      if (!LAF || !LAF.SemanticSearchEngine) return [];
      return LAF.SemanticSearchEngine.searchSync
        ? LAF.SemanticSearchEngine.searchSync(query, session.docId, 3)
        : [];
    }
    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  AI QUERY ENGINE (routes to GenerativeAiEngine or heuristic)
  // ═══════════════════════════════════════════════════════════════════════════
  var AiQueryEngine = (function () {
    var _intents = [
      { pattern: /summar/i,           label: 'summarize' },
      { pattern: /translat/i,         label: 'translate' },
      { pattern: /extract.*(table|row|col)/i, label: 'extract_table' },
      { pattern: /extract.*(name|date|amount|total|invoice|address)/i, label: 'extract_entity' },
      { pattern: /explain|what is|describe/i, label: 'explain' },
      { pattern: /compar/i,           label: 'compare' },
      { pattern: /legal|risk|clause|contract/i, label: 'legal_analysis' },
      { pattern: /rewrite|improve/i,  label: 'rewrite' },
      { pattern: /email/i,            label: 'generate_email' },
      { pattern: /find|search|where/i, label: 'search' },
    ];

    function _detectIntent(query) {
      for (var i = 0; i < _intents.length; i++) {
        if (_intents[i].pattern.test(query)) return _intents[i].label;
      }
      return 'general';
    }

    // General conversational knowledge (no document needed)
    var _generalKB = {
      'hello|hi|hey|greetings': 'Hello! I\'m Laba, your AI assistant for ILovePDF. I can answer questions about your documents, help you process files, and guide you through PDF and image tools. How can I help?',
      'how are you|how do you do': 'I\'m doing great, thanks for asking! Ready to help with your documents and files. What would you like to work on?',
      'what can you do|help|features|capabilities': 'I can:\n\n• **Answer questions** about your documents\n• **Summarize** PDFs and extract key points\n• **Execute tools** — just upload a file and tell me what you want (compress, convert, OCR, merge, etc.)\n• **Guide you** through all 33+ PDF and image tools\n\nYou can also drag & drop a file into this chat!',
      'compress|reduce.*size|shrink': 'To compress a PDF: drop your file here and say "compress this" — or go to the **Compress PDF** tool. It reduces file size while keeping quality.',
      'merge|combine|join': 'To merge PDFs: drop 2+ PDF files here and say "merge these" — or use the **Merge PDF** tool.',
      'split|separate|divide': 'To split a PDF: drop your file and say "split this" — or use the **Split PDF** tool to extract specific pages.',
      'ocr|extract.*text|text.*from': 'To extract text from a scanned PDF or image: drop your file and say "extract text" or "run OCR" — or use the **OCR PDF** tool.',
      'convert|word|excel|powerpoint|ppt|docx|xlsx': 'I can convert between many formats! Drop your file and tell me the target format (e.g. "convert to Word"), or browse the conversion tools in the sidebar.',
      'pdf to word|pdf.*word': 'Drop your PDF here and say "convert to Word" — or use the **PDF to Word** tool directly.',
      'remove.*background|background.*remov|bg.*remov': 'Drop your image here and say "remove background" — or use the **Background Remover** tool.',
      'protect|password|encrypt': 'Drop your PDF and say "protect with password" — or use the **Protect PDF** tool.',
      'watermark|stamp': 'Drop your PDF and say "add watermark" — or use the **Watermark PDF** tool.',
      'sign|signature|esign': 'Use the **Sign PDF** tool to add electronic signatures to your document.',
      'free|cost|price|pricing': 'ILovePDF tools are free for most tasks! Some advanced features require a free account. Sign up to unlock larger file sizes and more.',
      'thank|thanks|appreciate': 'You\'re welcome! Let me know if there\'s anything else I can help with.',
      'bye|goodbye|see you': 'Goodbye! Feel free to come back whenever you need help with your documents.',
    };

    function _conversationalReply(text) {
      var lower = text.toLowerCase();
      for (var pattern in _generalKB) {
        if (new RegExp(pattern, 'i').test(lower)) return _generalKB[pattern];
      }
      return null;
    }

    function _heuristicAnswer(ctx, intent) {
      var doc = ctx.docCtx || '';
      var query = (ctx.query || '').trim();

      // No document — try conversational reply first
      if (!doc) {
        var conv = _conversationalReply(query);
        if (conv) return conv;
        // Generic helpful reply
        return 'I\'m here to help! You can:\n\n• **Upload a file** (drag & drop into this chat) and ask me to process it\n• **Ask about any tool** — compress, convert, OCR, merge, sign, watermark, and more\n• **Browse tools** in the sidebar\n\nWhat would you like to do?';
      }

      switch (intent) {
        case 'summarize':
          var lines = doc.split('\n').filter(Boolean).slice(0, 8);
          return 'Based on the document:\n\n' + lines.join('\n') + '\n\n*(AI summary — attach a model provider for full generation)*';
        case 'extract_entity':
          var nums = doc.match(/\$[\d,]+\.?\d*|\b\d{4}[-\/]\d{2}[-\/]\d{2}\b|\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [];
          return nums.length ? 'Extracted values:\n- ' + [...new Set(nums)].slice(0,20).join('\n- ') : 'No entities found with pattern matching. Configure a model provider for deeper extraction.';
        case 'translate':
          var TP = sys('UniversalTranslationPipeline');
          return TP ? 'Translation pipeline available. Use the translate tool for full document translation.' : 'Translation requires the translate tool to be run first.';
        case 'legal_analysis':
          var kw = (doc.match(/\b(shall|must|obligation|liability|warranty|indemnif|terminat|breach|clause|agree|party|parties)\b/gi) || []);
          return kw.length ? 'Legal keywords found: ' + [...new Set(kw.map(function (k) { return k.toLowerCase(); }))].slice(0,15).join(', ') + '.\n\nConfigure a model provider for full clause analysis.' : 'No obvious legal keywords found.';
        case 'search':
          return doc.slice(0, 800) + (doc.length > 800 ? '\n\n*...document continues*' : '');
        default:
          return 'Document context loaded (' + doc.length + ' chars). Ask more specific questions or configure a model provider for advanced AI answers.';
      }
    }

    // ── Sanitise AI responses — block raw prompt echoes before any render ─────
    function sanitizeAiResponse(text) {
      if (!text) return null;
      var t = (typeof text === 'string' ? text : String(text)).trim();
      if (!t) return null;
      var banned = [
        /^you are a/i,
        /^you are an/i,
        /^conversation:/i,
        /^conversation history:/i,
        /^assistant:/i,
        /^system:/i,
        /^document context:/i,
        /^user:/i,
        /^context:/i,
        /^instructions:/i,
        /^here is the conversation/i,
        /^the following is/i,
        /^below is/i,
      ];
      if (banned.some(function (r) { return r.test(t); })) {
        warn('sanitizeAiResponse: blocked prompt-echo starting with:', t.slice(0, 60));
        return null;
      }
      // Discard full-prompt echoes that contain both User: and trailing Assistant:
      if (/\bUser:\s/.test(t) && /\bAssistant:\s*$/.test(t)) {
        warn('sanitizeAiResponse: blocked full-prompt echo');
        return null;
      }
      return t || null;
    }

    async function query(sessionId, text, onChunk) {
      var ctx    = ChatContextAssembler.build(sessionId, text);
      var intent = _detectIntent(text);

      // Try GenerativeAiEngine with buffered chunk-level echo guard.
      // Only the latest user message + document context go into the prompt —
      // never prior assistant replies — to minimise prompt-echo surface area.
      var GAE = sys('GenerativeAiEngine');
      if (GAE && GAE.generate) {
        try {
          var prompt = [
            ctx.docCtx ? 'Document context:\n' + ctx.docCtx.slice(0, 1000) : '',
            'User: ' + text,
            'Assistant:',
          ].filter(Boolean).join('\n\n');

          // Chunk interceptor: buffers the first 120 chars before forwarding any
          // content to the UI — lets us detect echoes without showing them.
          var _buf = '', _passed = false, _dropped = false;
          var _wrappedChunk = onChunk ? function (chunk) {
            if (_dropped) return;
            if (_passed)  { onChunk(chunk); return; }
            _buf += (chunk || '');
            if (_buf.length >= 120) {
              if (!sanitizeAiResponse(_buf)) { _dropped = true; return; }
              _passed = true;
              onChunk(_buf); // flush buffered safe content
            }
          } : null;

          var result = await GAE.generate(prompt, { stream: !!onChunk, onChunk: _wrappedChunk, intent: intent });
          if (_dropped) result = null; // streaming was an echo — discard
          result = sanitizeAiResponse(result);
          if (result) return result;
        } catch (e) { warn('GAE failed:', e.message); }
      }

      // Heuristic fallback — uses only ctx.docCtx + ctx.query (never raw history)
      var answer = _heuristicAnswer(ctx, intent);
      if (onChunk) {
        var words = answer.split(' ');
        for (var i = 0; i < words.length; i++) {
          onChunk(words[i] + (i < words.length - 1 ? ' ' : ''));
          await new Promise(function (r) { setTimeout(r, 12); });
        }
      }
      return answer;
    }

    return { query: query, detectIntent: _detectIntent, sanitize: sanitizeAiResponse };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 8  CHAT EXPORT ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var ChatExportEngine = (function () {
    function exportMarkdown(sessionId) {
      var session = ChatSessionManager.get(sessionId);
      var msgs    = ConversationMemory.get(sessionId);
      if (!session || !msgs.length) return '';
      var lines = ['# ' + session.title, '_Exported ' + new Date().toLocaleString() + '_', ''];
      msgs.forEach(function (m) { lines.push('**' + m.role + ':** ' + m.text, ''); });
      return lines.join('\n');
    }

    function exportJson(sessionId) {
      return JSON.stringify({ session: ChatSessionManager.get(sessionId), messages: ConversationMemory.get(sessionId) }, null, 2);
    }

    function download(sessionId, format) {
      var content = format === 'json' ? exportJson(sessionId) : exportMarkdown(sessionId);
      var type    = format === 'json' ? 'application/json' : 'text/markdown';
      var ext     = format === 'json' ? '.json' : '.md';
      var blob    = new Blob([content], { type: type });
      var a       = document.createElement('a');
      a.href      = URL.createObjectURL(blob);
      a.download  = 'chat-export' + ext;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    }

    return { exportMarkdown: exportMarkdown, exportJson: exportJson, download: download };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 9  CSS INJECTION
  // ═══════════════════════════════════════════════════════════════════════════
  function _injectCSS() {
    if (document.getElementById('lac-styles')) return;
    var s = document.createElement('style');
    s.id  = 'lac-styles';
    s.textContent = [
      '#laba-ai-chat-toggle{position:fixed;bottom:80px;right:20px;z-index:9998;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#7c3aed);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(79,70,229,.45);transition:transform .2s,box-shadow .2s;color:#fff;font-size:22px;}',
      '#laba-ai-chat-toggle:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(79,70,229,.6);}',
      '#laba-ai-chat-toggle .lac-badge{position:absolute;top:-2px;right:-2px;background:#ef4444;color:#fff;border-radius:50%;width:16px;height:16px;font-size:9px;display:flex;align-items:center;justify-content:center;font-weight:700;display:none;}',
      '#laba-ai-chat-panel{position:fixed;bottom:144px;right:20px;z-index:9997;width:380px;height:520px;min-width:280px;min-height:320px;background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;transition:opacity .2s,transform .2s;border:1px solid #e5e7eb;}',
      '#laba-ai-chat-panel.lac-hidden{opacity:0;pointer-events:none;transform:translateY(12px) scale(.97);}',
      '#laba-ai-chat-panel.lac-fullscreen{top:8px;left:8px;right:8px;bottom:8px;width:auto;height:auto;border-radius:12px;}',
      '.lac-header{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:12px 14px;display:flex;align-items:center;gap:10px;cursor:grab;user-select:none;flex-shrink:0;}',
      '.lac-header:active{cursor:grabbing;}',
      '.lac-header-title{flex:1;font-weight:700;font-size:14px;letter-spacing:.02em;}',
      '.lac-header-sub{font-size:11px;opacity:.75;margin-top:1px;}',
      '.lac-header-btns{display:flex;gap:4px;}',
      '.lac-hbtn{background:rgba(255,255,255,.18);border:none;color:#fff;width:24px;height:24px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;transition:background .15s;}',
      '.lac-hbtn:hover{background:rgba(255,255,255,.32);}',
      '.lac-sessions-bar{background:#f8f7ff;border-bottom:1px solid #e5e7eb;padding:6px 10px;display:flex;gap:6px;overflow-x:auto;flex-shrink:0;scrollbar-width:none;}',
      '.lac-sessions-bar::-webkit-scrollbar{display:none;}',
      '.lac-session-chip{background:#fff;border:1px solid #ddd6fe;border-radius:20px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap;color:#4f46e5;transition:background .15s;}',
      '.lac-session-chip.active{background:#4f46e5;color:#fff;border-color:#4f46e5;}',
      '.lac-session-chip:hover:not(.active){background:#ede9fe;}',
      '.lac-new-session{background:#4f46e5;color:#fff;border:none;border-radius:20px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap;}',
      '.lac-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;}',
      '.lac-msg{display:flex;gap:8px;align-items:flex-start;}',
      '.lac-msg.user{flex-direction:row-reverse;}',
      '.lac-avatar{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;}',
      '.lac-msg.user .lac-avatar{background:#4f46e5;color:#fff;}',
      '.lac-msg.assistant .lac-avatar{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;}',
      '.lac-bubble{max-width:80%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.55;word-break:break-word;}',
      '.lac-msg.user .lac-bubble{background:#4f46e5;color:#fff;border-bottom-right-radius:3px;}',
      '.lac-msg.assistant .lac-bubble{background:#f3f4f6;color:#111827;border-bottom-left-radius:3px;}',
      '.lac-bubble pre.lac-code{background:#1e1b4b;color:#e0e7ff;padding:8px 10px;border-radius:6px;overflow-x:auto;font-size:11px;margin:6px 0;}',
      '.lac-bubble code.lac-inline-code{background:#e0e7ff;color:#3730a3;padding:1px 4px;border-radius:3px;font-size:11px;}',
      '.lac-bubble p{margin:3px 0;} .lac-bubble h1,.lac-bubble h2,.lac-bubble h3{margin:6px 0 3px;}',
      '.lac-bubble ul{margin:4px 0;padding-left:18px;} .lac-bubble li{margin:2px 0;}',
      '.lac-streaming::after{content:"▋";animation:lac-blink .7s infinite;}',
      '@keyframes lac-blink{0%,100%{opacity:1}50%{opacity:0}}',
      '.lac-typing{display:flex;gap:4px;padding:8px 12px;background:#f3f4f6;border-radius:12px;align-items:center;}',
      '.lac-typing span{width:6px;height:6px;background:#9ca3af;border-radius:50%;animation:lac-bounce .9s infinite;}',
      '.lac-typing span:nth-child(2){animation-delay:.15s;} .lac-typing span:nth-child(3){animation-delay:.3s;}',
      '@keyframes lac-bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-5px)}}',
      '.lac-input-area{padding:10px;border-top:1px solid #e5e7eb;display:flex;gap:8px;align-items:flex-end;flex-shrink:0;background:#fafafa;}',
      '.lac-input{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:8px 10px;font-size:13px;font-family:inherit;resize:none;min-height:36px;max-height:100px;outline:none;transition:border .15s;background:#fff;}',
      '.lac-input:focus{border-color:#4f46e5;}',
      '.lac-send{background:#4f46e5;color:#fff;border:none;border-radius:10px;padding:8px 12px;cursor:pointer;font-size:15px;transition:background .15s;flex-shrink:0;}',
      '.lac-send:hover{background:#4338ca;} .lac-send:disabled{background:#9ca3af;cursor:not-allowed;}',
      '.lac-quick-btns{padding:4px 12px 8px;display:flex;gap:5px;flex-wrap:wrap;flex-shrink:0;}',
      '.lac-qbtn{background:#ede9fe;color:#4f46e5;border:none;border-radius:14px;padding:4px 10px;font-size:11px;cursor:pointer;transition:background .15s;}',
      '.lac-qbtn:hover{background:#ddd6fe;}',
      '.lac-resize-handle{position:absolute;bottom:0;left:0;width:14px;height:14px;cursor:sw-resize;opacity:.3;}',
      '.lac-resize-handle:hover{opacity:.6;}',
      '.lac-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;color:#9ca3af;text-align:center;padding:20px;}',
      '.lac-empty-state .lac-es-icon{font-size:36px;}',
      '.lac-empty-state p{font-size:13px;line-height:1.5;max-width:240px;}',
      '@media(max-width:768px){#laba-ai-chat-toggle{bottom:90px;right:16px;}}',
      '@media(max-width:480px){#laba-ai-chat-panel{right:8px;bottom:8px;width:calc(100vw - 16px);height:calc(100vh - 80px);}}',
    ].join('');
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 10  DOM BUILDER
  // ═══════════════════════════════════════════════════════════════════════════
  var _panel  = null;
  var _toggle = null;
  var _open   = false;
  var _fs     = false;
  var _drag   = { active: false, sx: 0, sy: 0, ox: 0, oy: 0 };
  var _currentSession = null;

  function _buildToggle() {
    if (document.getElementById(TOGGLE_ID)) return;
    _toggle = document.createElement('button');
    _toggle.id = TOGGLE_ID;
    _toggle.setAttribute('aria-label', 'Open Laba AI Chat');
    _toggle.innerHTML = '✦<span class="lac-badge" id="lac-badge">0</span>';
    _toggle.addEventListener('click', function () { _open ? _hidePanel() : _showPanel(); });
    document.body.appendChild(_toggle);
  }

  function _buildPanel() {
    if (document.getElementById(PANEL_ID)) { _panel = document.getElementById(PANEL_ID); return; }
    _panel = document.createElement('div');
    _panel.id = PANEL_ID;
    _panel.className = 'lac-hidden';
    _panel.innerHTML = [
      '<div class="lac-header" id="lac-drag-handle">',
        '<div style="display:flex;flex-direction:column;flex:1">',
          '<span class="lac-header-title">✦ Laba AI Assistant</span>',
          '<span class="lac-header-sub" id="lac-session-subtitle">No session</span>',
        '</div>',
        '<div class="lac-header-btns">',
          '<button class="lac-hbtn" id="lac-export-btn" title="Export chat">⬇</button>',
          '<button class="lac-hbtn" id="lac-fs-btn" title="Fullscreen">⛶</button>',
          '<button class="lac-hbtn" id="lac-close-btn" title="Close">✕</button>',
        '</div>',
      '</div>',
      '<div class="lac-sessions-bar" id="lac-sessions-bar">',
        '<button class="lac-new-session" id="lac-new-session-btn">+ New</button>',
      '</div>',
      '<div class="lac-messages" id="lac-messages"></div>',
      '<div class="lac-quick-btns" id="lac-quick-btns">',
        '<button class="lac-qbtn" data-q="Summarize this document">Summarize</button>',
        '<button class="lac-qbtn" data-q="Extract all key data">Extract data</button>',
        '<button class="lac-qbtn" data-q="Find legal risks">Legal risks</button>',
        '<button class="lac-qbtn" data-q="Generate executive summary">Exec summary</button>',
        '<button class="lac-qbtn" data-q="Explain this document">Explain</button>',
      '</div>',
      '<div class="lac-input-area">',
        '<textarea class="lac-input" id="lac-input" placeholder="Ask about your document…" rows="1"></textarea>',
        '<button class="lac-send" id="lac-send-btn">➤</button>',
      '</div>',
      '<div class="lac-resize-handle" id="lac-resize-handle" title="Resize"></div>',
    ].join('');
    document.body.appendChild(_panel);
    _bindEvents();
  }

  function _bindEvents() {
    // Close
    _panel.querySelector('#lac-close-btn').addEventListener('click', _hidePanel);
    // Fullscreen toggle
    _panel.querySelector('#lac-fs-btn').addEventListener('click', function () {
      _fs = !_fs;
      _panel.classList.toggle('lac-fullscreen', _fs);
    });
    // Export
    _panel.querySelector('#lac-export-btn').addEventListener('click', function () {
      if (_currentSession) ChatExportEngine.download(_currentSession, 'md');
    });
    // New session
    _panel.querySelector('#lac-new-session-btn').addEventListener('click', function () {
      var s = ChatSessionManager.create(null);
      _currentSession = s.id;
      _refreshSessionsBar();
      _refreshMessages();
    });
    // Send
    _panel.querySelector('#lac-send-btn').addEventListener('click', _sendMessage);
    var input = _panel.querySelector('#lac-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendMessage(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });
    // Quick buttons
    _panel.querySelector('#lac-quick-btns').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-q]');
      if (btn) { input.value = btn.dataset.q; _sendMessage(); }
    });
    // Drag
    _panel.querySelector('#lac-drag-handle').addEventListener('mousedown', _onDragStart);
    // Resize
    _panel.querySelector('#lac-resize-handle').addEventListener('mousedown', _onResizeStart);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 11  DRAG + RESIZE
  // ═══════════════════════════════════════════════════════════════════════════
  function _onDragStart(e) {
    if (_fs) return;
    _drag.active = true;
    _drag.sx = e.clientX; _drag.sy = e.clientY;
    var r = _panel.getBoundingClientRect();
    _drag.ox = r.left; _drag.oy = r.top;
    _panel.style.right = 'auto';
    _panel.style.bottom = 'auto';
    _panel.style.left = r.left + 'px';
    _panel.style.top  = r.top  + 'px';
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup',   _onDragEnd);
  }
  function _onDragMove(e) {
    if (!_drag.active) return;
    var dx = e.clientX - _drag.sx, dy = e.clientY - _drag.sy;
    _panel.style.left = (_drag.ox + dx) + 'px';
    _panel.style.top  = (_drag.oy + dy) + 'px';
  }
  function _onDragEnd() {
    _drag.active = false;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup',   _onDragEnd);
  }

  var _resizing = false, _rsw = 0, _rsh = 0, _rsx = 0, _rsy = 0;
  function _onResizeStart(e) {
    _resizing = true;
    _rsx = e.clientX; _rsy = e.clientY;
    _rsw = _panel.offsetWidth; _rsh = _panel.offsetHeight;
    document.addEventListener('mousemove', _onResizeMove);
    document.addEventListener('mouseup',   _onResizeEnd);
    e.preventDefault();
  }
  function _onResizeMove(e) {
    if (!_resizing) return;
    var nw = Math.max(280, _rsw + (_rsx - e.clientX));
    var nh = Math.max(320, _rsh + (e.clientY - _rsy));
    _panel.style.width  = nw + 'px';
    _panel.style.height = nh + 'px';
  }
  function _onResizeEnd() {
    _resizing = false;
    document.removeEventListener('mousemove', _onResizeMove);
    document.removeEventListener('mouseup',   _onResizeEnd);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 12  MESSAGE RENDERING
  // ═══════════════════════════════════════════════════════════════════════════
  function _showPanel() {
    _open = true;
    _panel.classList.remove('lac-hidden');
    if (_toggle) _toggle.style.display = 'none'; // hide launcher while panel is open
    _ensureSession();
  }
  function _hidePanel() {
    _open = false;
    _panel.classList.add('lac-hidden');
    if (_toggle) _toggle.style.display = ''; // restore launcher when panel closes
  }

  function _ensureSession() {
    if (!_currentSession) {
      var sessions = ChatSessionManager.list();
      if (sessions.length) {
        _currentSession = sessions[0].id;
        ConversationMemory.loadSession(_currentSession).then(_refreshMessages);
      } else {
        var s = ChatSessionManager.create(null);
        _currentSession = s.id;
        _refreshMessages();
      }
    }
    _refreshSessionsBar();
  }

  function _refreshSessionsBar() {
    var bar = document.getElementById('lac-sessions-bar');
    if (!bar) return;
    var chips = bar.querySelectorAll('.lac-session-chip');
    chips.forEach(function (c) { c.remove(); });
    var btn = bar.querySelector('#lac-new-session-btn');
    ChatSessionManager.list().slice(0, 8).forEach(function (s) {
      var chip = document.createElement('button');
      chip.className = 'lac-session-chip' + (s.id === _currentSession ? ' active' : '');
      chip.textContent = s.title.slice(0, 16);
      chip.addEventListener('click', function () {
        _currentSession = s.id;
        ConversationMemory.loadSession(s.id).then(_refreshMessages);
        _refreshSessionsBar();
      });
      bar.insertBefore(chip, btn);
    });
    var sub = document.getElementById('lac-session-subtitle');
    if (sub && _currentSession) {
      var sess = ChatSessionManager.get(_currentSession);
      if (sess) sub.textContent = sess.title;
    }
  }

  function _refreshMessages() {
    var el = document.getElementById('lac-messages');
    if (!el) return;
    el.innerHTML = '';
    var msgs = _currentSession ? ConversationMemory.get(_currentSession) : [];
    if (!msgs.length) {
      el.innerHTML = '<div class="lac-empty-state"><div class="lac-es-icon">✦</div><p>Ask anything about your documents — summarize, extract, analyze, compare, translate, and more.</p></div>';
      return;
    }
    msgs.forEach(function (m) { _appendMsgEl(el, m.role, m.text); });
    el.scrollTop = el.scrollHeight;
  }

  function _appendMsgEl(container, role, text) {
    var el = container || document.getElementById('lac-messages');
    if (!el) return null;
    var div = document.createElement('div');
    div.className = 'lac-msg ' + role;
    var avatar = role === 'user' ? '👤' : '✦';
    var bubble = document.createElement('div');
    bubble.className = 'lac-bubble';
    StreamingResponseRenderer.render(bubble, text, false);
    div.innerHTML = '<div class="lac-avatar">' + avatar + '</div>';
    div.appendChild(bubble);
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    return bubble;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 13  SEND FLOW
  // ═══════════════════════════════════════════════════════════════════════════
  var _thinking = false;
  async function _sendMessage() {
    if (_thinking) return;
    var input = document.getElementById('lac-input');
    var text  = (input.value || '').trim();
    if (!text) return;
    if (!_currentSession) _ensureSession();

    input.value = '';
    input.style.height = 'auto';

    // Remove empty state
    var msgEl = document.getElementById('lac-messages');
    if (msgEl) {
      var es = msgEl.querySelector('.lac-empty-state');
      if (es) es.remove();
    }

    // Add user message
    ConversationMemory.add(_currentSession, 'user', text);
    _appendMsgEl(null, 'user', text);

    // Auto-title first message
    var sess = ChatSessionManager.get(_currentSession);
    if (sess && sess.messageCount <= 1) {
      ChatSessionManager.setTitle(_currentSession, text.slice(0, 28) + (text.length > 28 ? '…' : ''));
      _refreshSessionsBar();
    }

    // Typing indicator
    _thinking = true;
    var sendBtn = document.getElementById('lac-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    var typingRow = document.createElement('div');
    typingRow.className = 'lac-msg assistant';
    typingRow.innerHTML = '<div class="lac-avatar">✦</div><div class="lac-typing"><span></span><span></span><span></span></div>';
    if (msgEl) { msgEl.appendChild(typingRow); msgEl.scrollTop = msgEl.scrollHeight; }

    try {
      var streamBubble = null;
      var accumulated  = '';

      var answer = await AiQueryEngine.query(_currentSession, text, function (chunk) {
        accumulated += chunk;
        if (!streamBubble) {
          if (typingRow.parentNode) typingRow.remove();
          streamBubble = _appendMsgEl(null, 'assistant', accumulated);
          if (streamBubble) streamBubble.setAttribute('data-raw', accumulated);
        } else {
          StreamingResponseRenderer.render(streamBubble, accumulated, true);
        }
        if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
      });

      if (typingRow.parentNode) typingRow.remove();
      if (streamBubble) {
        StreamingResponseRenderer.render(streamBubble, accumulated || answer, false);
      } else {
        _appendMsgEl(null, 'assistant', answer || accumulated);
      }

      ConversationMemory.add(_currentSession, 'assistant', answer || accumulated);

    } catch (e) {
      if (typingRow.parentNode) typingRow.remove();
      _appendMsgEl(null, 'assistant', 'Sorry, I encountered an error: ' + e.message);
    }

    _thinking = false;
    if (sendBtn) sendBtn.disabled = false;
    if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 14  INIT + PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  function _init() {
    _injectCSS();
    _buildToggle();
    _buildPanel();
    ChatSessionManager.restore();
    log('LabaAiChat v' + VERSION + ' ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    setTimeout(_init, 0);
  }

  window.LabaAiChat = {
    version:  VERSION,
    open:     function ()       { _showPanel(); },
    close:    function ()       { _hidePanel(); },
    toggle:   function ()       { _open ? _hidePanel() : _showPanel(); },
    send:     function (text)   { if (text) { var el = document.getElementById('lac-input'); if (el) el.value = text; _showPanel(); setTimeout(_sendMessage, 100); } },
    newSession: function (docId) { var s = ChatSessionManager.create(docId); _currentSession = s.id; _refreshSessionsBar(); _refreshMessages(); return s; },
    setDocId:  function (docId) { var s = ChatSessionManager.getActive(); if (s) { s.docId = docId; } },
    export:    function (fmt)   { if (_currentSession) ChatExportEngine.download(_currentSession, fmt || 'md'); },
    getSession: function ()     { return _currentSession; },
    // sub-systems
    SessionManager:   ChatSessionManager,
    Memory:           ConversationMemory,
    ContextAssembler: ChatContextAssembler,
    ResponseRenderer: StreamingResponseRenderer,
    CitationBuilder:  SemanticCitationBuilder,
    ExportEngine:     ChatExportEngine,
    // audit
    audit: function () {
      return { sessions: ChatSessionManager.list().length, activeSession: _currentSession, open: _open, version: VERSION };
    },
    cleanup: function () { log('cleanup called'); },
  };

  // Workflow trigger integration
  if (window.WorkflowChainEngine) {
    try { window.WorkflowChainEngine.registerChatInterface && window.WorkflowChainEngine.registerChatInterface(window.LabaAiChat); } catch (_) {}
  }

}());

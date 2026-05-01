/* =========================================================
   LABA AI WIDGET — Browser-Side Only, Unlimited Chats
   Uses: local knowledge base JSON + Transformers.js t5-small
   NO external API calls. NO daily limits.
   ========================================================= */

(function () {
  'use strict';

  const LABA_KB_URL = '/laba/laba-knowledge.json';
  const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

  class LabaWidget {
    constructor() {
      this.kb = null;
      this.pipeline = null;
      this.modelLoading = false;
      this.modelLoaded = false;
      this.isOpen = false;
      this.isMinimized = false;
      this.dragState = { active: false, startX: 0, startY: 0, origX: 0, origY: 0 };
      this.busy = false;

      this._buildDOM();
      this._bindEvents();
      this.loadKnowledgeBase();
    }

    /* ---- DOM Construction ---- */

    _buildDOM() {
      // Launcher button
      const launcher = document.createElement('div');
      launcher.id = 'laba-launcher';
      launcher.setAttribute('role', 'button');
      launcher.setAttribute('aria-label', 'Open Laba AI Assistant');
      launcher.setAttribute('tabindex', '0');
      launcher.innerHTML = `
        <div class="laba-ripple"></div>
        <div class="laba-ring-inner"></div>
        <div class="laba-ring-outer"></div>
        <div class="laba-orbit-container">
          <div class="laba-dot"></div>
          <div class="laba-dot"></div>
          <div class="laba-dot"></div>
          <div class="laba-dot"></div>
          <div class="laba-dot"></div>
          <div class="laba-dot"></div>
          <div class="laba-dot"></div>
          <div class="laba-dot"></div>
        </div>
        <span class="laba-icon" aria-hidden="true">🤖</span>
      `;

      // Chat window
      const win = document.createElement('div');
      win.id = 'laba-window';
      win.className = 'laba-hidden';
      win.setAttribute('role', 'dialog');
      win.setAttribute('aria-label', 'Laba AI Assistant');
      win.innerHTML = `
        <div id="laba-header">
          <span id="laba-header-title">Laba 🤖 AI Assistant</span>
          <div id="laba-header-btns">
            <button class="laba-hbtn" id="laba-minimize-btn" title="Minimize" aria-label="Minimize">−</button>
            <button class="laba-hbtn" id="laba-close-btn" title="Close" aria-label="Close">✕</button>
          </div>
        </div>
        <div id="laba-messages" aria-live="polite">
          <div class="laba-msg laba-bot">
            👋 Hi! I'm <strong>Laba</strong>, your AI assistant for ILovePDF!<br><br>
            I can help with:<br>
            • PDF tool questions<br>
            • Email drafts<br>
            • Grammar correction<br>
            • Sentence rewrites<br><br>
            Ask me anything! 😊
          </div>
        </div>
        <div id="laba-typing" class="laba-hidden">
          <div class="laba-typing-dot"></div>
          <div class="laba-typing-dot"></div>
          <div class="laba-typing-dot"></div>
        </div>
        <div id="laba-model-bar" class="laba-hidden">
          <span id="laba-model-label">Loading AI model…</span>
          <div id="laba-model-progress"><div id="laba-model-fill"></div></div>
        </div>
        <div id="laba-input-area">
          <textarea
            id="laba-input"
            placeholder="Ask me about PDF tools, email drafts, grammar…"
            rows="1"
            aria-label="Type your message"
          ></textarea>
          <button id="laba-send" aria-label="Send message">➤</button>
        </div>
      `;

      document.body.appendChild(launcher);
      document.body.appendChild(win);

      this.launcher = launcher;
      this.win = win;
      this.msgArea = win.querySelector('#laba-messages');
      this.typingEl = win.querySelector('#laba-typing');
      this.inputEl = win.querySelector('#laba-input');
      this.sendBtn = win.querySelector('#laba-send');
      this.modelBar = win.querySelector('#laba-model-bar');
      this.modelLabel = win.querySelector('#laba-model-label');
      this.modelFill = win.querySelector('#laba-model-fill');
    }

    /* ---- Event Binding ---- */

    _bindEvents() {
      // Launcher click / keyboard
      this.launcher.addEventListener('click', () => this.toggleChat());
      this.launcher.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleChat(); }
      });

      // Header buttons
      this.win.querySelector('#laba-close-btn').addEventListener('click', () => this.closeChat());
      this.win.querySelector('#laba-minimize-btn').addEventListener('click', () => this.minimizeChat());

      // Send button + Enter key
      this.sendBtn.addEventListener('click', () => this._sendMessage());
      this.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._sendMessage();
        }
      });

      // Auto-resize textarea
      this.inputEl.addEventListener('input', () => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 90) + 'px';
      });

      // Drag — mouse
      const header = this.win.querySelector('#laba-header');
      header.addEventListener('mousedown', (e) => this._startDrag(e));
      document.addEventListener('mousemove', (e) => this._onDrag(e));
      document.addEventListener('mouseup', () => this._endDrag());

      // Drag — touch
      header.addEventListener('touchstart', (e) => this._startDrag(e.touches[0]), { passive: true });
      document.addEventListener('touchmove', (e) => this._onDrag(e.touches[0]), { passive: false });
      document.addEventListener('touchend', () => this._endDrag());
    }

    /* ---- Drag Logic ---- */

    _startDrag(e) {
      const rect = this.win.getBoundingClientRect();
      this.dragState = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        origX: rect.right,
        origY: rect.top,
      };
      this.win.style.transition = 'none';
    }

    _onDrag(e) {
      if (!this.dragState.active) return;
      const dx = e.clientX - this.dragState.startX;
      const dy = e.clientY - this.dragState.startY;
      const newRight = window.innerWidth - (this.dragState.origX + dx);
      const newTop = this.dragState.origY + dy;
      const w = this.win.offsetWidth;
      const h = this.win.offsetHeight;
      const clampedRight = Math.max(0, Math.min(newRight, window.innerWidth - w));
      const clampedTop = Math.max(0, Math.min(newTop, window.innerHeight - h));
      this.win.style.right = clampedRight + 'px';
      this.win.style.top = clampedTop + 'px';
      this.win.style.bottom = 'auto';
    }

    _endDrag() {
      this.dragState.active = false;
      this.win.style.transition = '';
    }

    /* ---- Open / Close / Minimize ---- */

    toggleChat() {
      if (this.isOpen) {
        if (this.isMinimized) {
          this.openChat();
        } else {
          this.closeChat();
        }
      } else {
        this.openChat();
      }
    }

    openChat() {
      this.win.classList.remove('laba-hidden');
      this.isOpen = true;
      this.isMinimized = false;
      this._vibrate(60);
      setTimeout(() => this.inputEl.focus(), 100);
      this._scrollToBottom();
    }

    closeChat() {
      this.win.classList.add('laba-hidden');
      this.isOpen = false;
      this.isMinimized = false;
    }

    minimizeChat() {
      this.win.classList.add('laba-hidden');
      this.isMinimized = true;
    }

    /* ---- Vibration ---- */

    _vibrate(ms) {
      try {
        if (navigator.vibrate) navigator.vibrate(ms);
      } catch (_) {}
    }

    /* ---- Knowledge Base ---- */

    async loadKnowledgeBase() {
      try {
        const res = await fetch(LABA_KB_URL);
        if (!res.ok) throw new Error('KB fetch failed');
        this.kb = await res.json();
      } catch (e) {
        console.warn('[Laba] Knowledge base load failed:', e.message);
        this.kb = { tools: [], faq: [] };
      }
    }

    searchKnowledgeBase(query) {
      if (!this.kb) return null;
      const q = query.toLowerCase().trim();

      // FAQ search
      for (const faq of this.kb.faq || []) {
        if (faq.keywords.some(kw => q.includes(kw))) {
          return { type: 'faq', data: faq };
        }
      }

      // Tool search — score by keyword matches
      let bestScore = 0;
      let bestTool = null;
      for (const tool of this.kb.tools || []) {
        let score = 0;
        for (const kw of tool.keywords) {
          if (q.includes(kw)) score += kw.length; // longer match = better
        }
        if (score > bestScore) { bestScore = score; bestTool = tool; }
      }

      if (bestTool && bestScore >= 3) {
        return { type: 'tool', data: bestTool };
      }

      return null;
    }

    _formatToolResponse(tool) {
      return (
        `📄 <strong>${tool.name}</strong>\n\n` +
        `${tool.description}\n\n` +
        `📋 <strong>How to use:</strong>\n${tool.how_to_use}\n\n` +
        `📦 <strong>File limit:</strong> ${tool.file_limit}\n` +
        `💰 <strong>Cost:</strong> Free ✅\n\n` +
        `<a class="laba-tool-link" href="/${tool.slug}" target="_blank">Open ${tool.name} →</a>`
      );
    }

    _formatFaqResponse(faq) {
      return `💬 ${faq.answer}`;
    }

    /* ---- Transformers.js Model ---- */

    async _ensureModelLoaded() {
      if (this.modelLoaded) return true;
      if (this.modelLoading) {
        // Wait until loaded
        return new Promise((resolve) => {
          const check = setInterval(() => {
            if (this.modelLoaded || !this.modelLoading) {
              clearInterval(check);
              resolve(this.modelLoaded);
            }
          }, 300);
        });
      }

      this.modelLoading = true;
      this._showModelBar('Downloading AI model (~24MB, first use only)…', 5);

      try {
        // Dynamically load transformers.js from CDN
        if (!window.__transformers_loaded) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = TRANSFORMERS_CDN;
            s.onload = () => { window.__transformers_loaded = true; resolve(); };
            s.onerror = () => reject(new Error('Failed to load Transformers.js'));
            document.head.appendChild(s);
          });
        }

        this._showModelBar('Initializing model…', 30);

        const { pipeline, env } = window.Transformers || window.transformers || {};
        if (!pipeline) throw new Error('Transformers.js not available');

        // Use smaller, faster model — runs in browser
        env.allowRemoteModels = true;
        env.useBrowserCache = true;

        this._showModelBar('Loading t5-small…', 55);

        this.pipeline = await pipeline('text2text-generation', 'Xenova/t5-small', {
          progress_callback: (info) => {
            if (info && info.progress) {
              const pct = Math.min(95, 55 + (info.progress * 0.4));
              this._showModelBar(`Loading model… ${Math.round(info.progress)}%`, pct);
            }
          },
        });

        this._showModelBar('Model ready!', 100);
        this.modelLoaded = true;
        this.modelLoading = false;
        setTimeout(() => this._hideModelBar(), 1200);
        return true;
      } catch (err) {
        console.warn('[Laba] Model load failed:', err.message);
        this.modelLoading = false;
        this._hideModelBar();
        return false;
      }
    }

    _showModelBar(label, pct) {
      this.modelBar.classList.remove('laba-hidden');
      this.modelLabel.textContent = label;
      this.modelFill.style.width = pct + '%';
    }

    _hideModelBar() {
      this.modelBar.classList.add('laba-hidden');
    }

    async processWithModel(task, text) {
      const loaded = await this._ensureModelLoaded();
      if (!loaded || !this.pipeline) {
        return null;
      }

      let prompt;
      if (task === 'grammar') {
        prompt = `Fix grammar: ${text}`;
      } else if (task === 'email') {
        prompt = `Write a professional email about: ${text}`;
      } else if (task === 'rewrite') {
        prompt = `Rewrite professionally: ${text}`;
      } else if (task === 'summarize') {
        prompt = `Summarize: ${text}`;
      } else {
        prompt = text;
      }

      try {
        const result = await this.pipeline(prompt, {
          max_new_tokens: 180,
          do_sample: false,
        });
        return result?.[0]?.generated_text?.trim() || null;
      } catch (err) {
        console.warn('[Laba] Model inference failed:', err.message);
        return null;
      }
    }

    /* ---- Intent Detection ---- */

    _detectIntent(msg) {
      const m = msg.toLowerCase();

      // Grammar correction
      if (
        m.includes('grammar') || m.includes('correct') || m.includes('fix sentence') ||
        m.includes('grammatically') || m.includes('theek karo') || m.includes('sahi karo') ||
        m.match(/fix[^.]*sentence/) || m.match(/correct[^.]*sentence/)
      ) {
        return 'grammar';
      }

      // Email draft
      if (
        m.includes('email') || m.includes('mail') || m.includes('write email') ||
        m.includes('draft email') || m.includes('email likho') || m.includes('email likhna')
      ) {
        return 'email';
      }

      // Sentence rewrite
      if (
        m.includes('rewrite') || m.includes('rephrase') || m.includes('improve') ||
        m.includes('make professional') || m.includes('better version') ||
        m.includes('professional banao') || m.includes('likhne ka tarika')
      ) {
        return 'rewrite';
      }

      // Short summary (text given inline)
      if (
        (m.includes('summarize') || m.includes('summary') || m.includes('summarise') || m.includes('tldr')) &&
        msg.length > 60
      ) {
        return 'summarize';
      }

      return null;
    }

    /* ---- Extract content from message (strip intent keywords) ---- */

    _extractContent(msg, intent) {
      let text = msg;
      const removals = {
        grammar: [/fix grammar[:\-]?\s*/gi, /correct[:\-]?\s*/gi, /theek karo[:\-]?\s*/gi, /sahi karo[:\-]?\s*/gi],
        email: [/write (?:an? )?email(?: about)?[:\-]?\s*/gi, /draft (?:an? )?email(?: about)?[:\-]?\s*/gi, /email likho[:\-]?\s*/gi],
        rewrite: [/rewrite[:\-]?\s*/gi, /rephrase[:\-]?\s*/gi, /make professional[:\-]?\s*/gi, /professional banao[:\-]?\s*/gi],
        summarize: [/summarize[:\-]?\s*/gi, /summarise[:\-]?\s*/gi, /give summary[:\-]?\s*/gi, /ka summary do[:\-]?\s*/gi, /tldr[:\-]?\s*/gi],
      };
      const pats = removals[intent] || [];
      for (const p of pats) text = text.replace(p, '');
      return text.trim() || msg;
    }

    /* ---- Main Message Handler ---- */

    async handleUserMessage(msg) {
      const trimmed = msg.trim();
      if (!trimmed) return;

      this.addMessage('user', trimmed);
      this._setInputBusy(true);
      this.showTyping();

      // Small delay for typing feel
      await this._delay(400);

      // 1. Check knowledge base first
      const kbResult = this.searchKnowledgeBase(trimmed);
      if (kbResult) {
        this.hideTyping();
        let answer;
        if (kbResult.type === 'tool') {
          answer = this._formatToolResponse(kbResult.data);
        } else {
          answer = this._formatFaqResponse(kbResult.data);
        }
        this.addMessage('bot', answer, true);
        this._vibrate(40);
        this._setInputBusy(false);
        return;
      }

      // 2. Detect model task intent
      const intent = this._detectIntent(trimmed);
      if (intent) {
        const content = this._extractContent(trimmed, intent);
        this.hideTyping();
        this._showModelBar('Loading AI model for this task…', 10);

        const result = await this.processWithModel(intent, content);

        this._hideModelBar();
        if (result) {
          const prefix = {
            grammar: '✏️ <strong>Corrected:</strong>\n',
            email: '📧 <strong>Email Draft:</strong>\n',
            rewrite: '✨ <strong>Rewritten:</strong>\n',
            summarize: '📝 <strong>Summary:</strong>\n',
          }[intent] || '';
          this.addMessage('bot', prefix + result, true);
          this._vibrate(40);
        } else {
          this.addMessage('bot', '⚠️ The AI model couldn\'t load right now. Please check your internet connection and try again.');
        }
        this._setInputBusy(false);
        return;
      }

      // 3. Out-of-scope fallback
      this.hideTyping();
      const fallbacks = [
        'I can help with PDF tools, email drafts, and grammar correction only. 😊\n\nTry asking:\n• "How to compress PDF?"\n• "Write email about PDF compression"\n• "Fix grammar: He go to school"',
        'I\'m specialized in ILovePDF tools, email drafts, and grammar help! For other questions, please try a general search engine.\n\nWhat PDF task can I help you with? 📄',
        'Great question! But that\'s a bit beyond my scope. I work best with:\n📄 PDF tool guidance\n📧 Email drafts\n✏️ Grammar correction\n✨ Sentence rewrites\n\nTry one of those!',
      ];
      const reply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      this.addMessage('bot', reply);
      this._vibrate(40);
      this._setInputBusy(false);
    }

    /* ---- UI Helpers ---- */

    addMessage(role, content, isHtml = false) {
      const div = document.createElement('div');
      div.className = `laba-msg laba-${role === 'user' ? 'user' : 'bot'}`;
      if (isHtml) {
        div.innerHTML = content;
      } else {
        div.textContent = content;
      }
      this.msgArea.appendChild(div);
      this._scrollToBottom();
    }

    showTyping() {
      this.typingEl.classList.remove('laba-hidden');
      this.msgArea.appendChild(this.typingEl);
      this._scrollToBottom();
    }

    hideTyping() {
      this.typingEl.classList.add('laba-hidden');
    }

    _scrollToBottom() {
      requestAnimationFrame(() => {
        this.msgArea.scrollTop = this.msgArea.scrollHeight;
      });
    }

    _setInputBusy(busy) {
      this.busy = busy;
      this.inputEl.disabled = busy;
      this.sendBtn.disabled = busy;
    }

    _sendMessage() {
      if (this.busy) return;
      const val = this.inputEl.value.trim();
      if (!val) return;
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.handleUserMessage(val);
    }

    _delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  }

  /* ---- Bootstrap ---- */

  function init() {
    if (document.getElementById('laba-launcher')) return; // already mounted
    window.__labaWidget = new LabaWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

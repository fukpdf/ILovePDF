/* ================================================================
   Laba AI Assistant Widget — ILovePDF
   - Floating, draggable chat popup (380×500 px max)
   - Daily limit: 20 messages/day (localStorage, auto-resets midnight)
   - Vibration on open + new AI message
   - API: POST /api/chat (key stays server-side)
   - Z-index: 999
   ================================================================ */
(function () {
  'use strict';

  const LIMIT_KEY   = 'laba:daily';
  const DAILY_MAX   = 20;
  const CHAT_URL    = '/api/chat';

  /* ── Daily-limit helpers ─────────────────────────────────── */
  function getUsage() {
    try {
      const raw = JSON.parse(localStorage.getItem(LIMIT_KEY) || '{}');
      const today = new Date().toISOString().slice(0, 10);
      if (raw.date !== today) return { date: today, count: 0 };
      return raw;
    } catch { return { date: new Date().toISOString().slice(0, 10), count: 0 }; }
  }
  function saveUsage(u) {
    try { localStorage.setItem(LIMIT_KEY, JSON.stringify(u)); } catch {}
  }
  function incrementUsage() {
    const u = getUsage();
    u.count = (u.count || 0) + 1;
    saveUsage(u);
    return u.count;
  }
  function isLimitReached() {
    return getUsage().count >= DAILY_MAX;
  }
  function remaining() {
    return Math.max(0, DAILY_MAX - getUsage().count);
  }

  /* ── Vibration ───────────────────────────────────────────── */
  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
  }

  /* ── Render markdown-lite ────────────────────────────────── */
  function renderText(text) {
    if (!text) return '';
    const esc = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return esc
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  /* ── Build DOM ───────────────────────────────────────────── */
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/css/laba-widget.css';
  document.head.appendChild(css);

  const toggle = document.createElement('button');
  toggle.id = 'laba-toggle';
  toggle.setAttribute('aria-label', 'Open Laba AI assistant');
  toggle.innerHTML = `
    <span class="laba-toggle-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </span>
    <span class="laba-badge" id="laba-badge"></span>
  `;

  const win = document.createElement('div');
  win.id = 'laba-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'Laba AI assistant');
  win.innerHTML = `
    <div id="laba-header">
      <div class="laba-avatar">🤖</div>
      <div class="laba-header-info">
        <div class="laba-header-name">Laba</div>
        <div class="laba-header-status">
          <span class="laba-status-dot"></span> Online · AI Assistant
        </div>
      </div>
      <div class="laba-header-btns">
        <button class="laba-hbtn" id="laba-minimize-btn" title="Minimize" aria-label="Minimize">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <button class="laba-hbtn" id="laba-close-btn" title="Close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    <div id="laba-messages"></div>
    <div id="laba-limit-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>Daily limit reached (${DAILY_MAX}/day). Come back tomorrow.</span>
    </div>
    <div id="laba-footer">
      <textarea id="laba-input" rows="1" placeholder="Ask Laba anything…" maxlength="1200" aria-label="Message"></textarea>
      <button id="laba-send" aria-label="Send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  `;

  document.body.appendChild(toggle);
  document.body.appendChild(win);

  /* ── Element refs ────────────────────────────────────────── */
  const messagesEl    = document.getElementById('laba-messages');
  const inputEl       = document.getElementById('laba-input');
  const sendBtn       = document.getElementById('laba-send');
  const closeBtn      = document.getElementById('laba-close-btn');
  const minimizeBtn   = document.getElementById('laba-minimize-btn');
  const limitBanner   = document.getElementById('laba-limit-banner');
  const badge         = document.getElementById('laba-badge');
  const headerEl      = document.getElementById('laba-header');

  /* ── State ───────────────────────────────────────────────── */
  let isOpen      = false;
  let isMinimized = false;
  let isLoading   = false;
  let messages    = [];  // { role: 'user'|'assistant', content: string }
  let unreadCount = 0;

  /* ── Welcome message ─────────────────────────────────────── */
  function renderWelcome() {
    messagesEl.innerHTML = `
      <div class="laba-welcome">
        <div class="laba-welcome-icon">🤖</div>
        <h3>Hi, I'm Laba!</h3>
        <p>Your AI assistant for ILovePDF. Ask me anything about PDF tools, file conversions, or general help.</p>
        <div class="laba-suggestions">
          <button class="laba-suggestion" data-q="How do I compress a PDF?">Compress PDF</button>
          <button class="laba-suggestion" data-q="How do I convert PDF to Word?">PDF → Word</button>
          <button class="laba-suggestion" data-q="What tools does ILovePDF offer?">All tools</button>
          <button class="laba-suggestion" data-q="How do I merge multiple PDFs?">Merge PDFs</button>
        </div>
      </div>
    `;
  }

  /* ── Badge / limit ───────────────────────────────────────── */
  function updateLimitUI() {
    if (isLimitReached()) {
      limitBanner.classList.add('laba-limit-show');
      inputEl.disabled = true;
      sendBtn.disabled = true;
    } else {
      limitBanner.classList.remove('laba-limit-show');
      inputEl.disabled = false;
      sendBtn.disabled = false;
    }
  }
  function updateBadge() {
    if (unreadCount > 0 && !isOpen) {
      badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
      badge.classList.add('laba-badge-show');
    } else {
      badge.classList.remove('laba-badge-show');
    }
  }

  /* ── Append message bubble ───────────────────────────────── */
  function appendMessage(role, content, isTyping = false) {
    const msgEl = document.createElement('div');
    msgEl.className = `laba-msg laba-${role === 'user' ? 'user' : 'ai'}${isTyping ? ' laba-typing' : ''}`;
    const initials = role === 'user' ? '👤' : '🤖';
    if (isTyping) {
      msgEl.innerHTML = `
        <div class="laba-msg-avatar">${initials}</div>
        <div class="laba-bubble">
          <span class="laba-dot"></span>
          <span class="laba-dot"></span>
          <span class="laba-dot"></span>
        </div>`;
    } else {
      msgEl.innerHTML = `
        <div class="laba-msg-avatar">${initials}</div>
        <div class="laba-bubble">${renderText(content)}</div>`;
    }
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msgEl;
  }

  /* ── Send message ────────────────────────────────────────── */
  async function sendMessage(text) {
    text = text.trim();
    if (!text || isLoading || isLimitReached()) return;

    // Remove welcome screen
    const welcome = messagesEl.querySelector('.laba-welcome');
    if (welcome) welcome.remove();

    // Append user message
    appendMessage('user', text);
    messages.push({ role: 'user', content: text });
    incrementUsage();
    updateLimitUI();
    inputEl.value = '';
    autoResizeInput();

    // Show typing indicator
    isLoading = true;
    sendBtn.disabled = true;
    const typingEl = appendMessage('assistant', '', true);

    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');

      const reply = data.reply || '';
      typingEl.remove();
      appendMessage('assistant', reply);
      messages.push({ role: 'assistant', content: reply });

      // Vibrate on new AI message
      vibrate([30, 20, 30]);

      // Badge if minimized/closed
      if (!isOpen || isMinimized) {
        unreadCount++;
        updateBadge();
      }
    } catch (err) {
      typingEl.remove();
      appendMessage('assistant', 'Sorry, I couldn\'t respond right now. Please try again in a moment.');
    } finally {
      isLoading = false;
      if (!isLimitReached()) sendBtn.disabled = false;
    }
  }

  /* ── Open/close ──────────────────────────────────────────── */
  function openWidget() {
    isOpen = true;
    isMinimized = false;
    win.classList.add('laba-visible');
    win.classList.remove('laba-minimized');
    toggle.classList.add('laba-open');
    toggle.setAttribute('aria-label', 'Close Laba AI assistant');
    toggle.innerHTML = `
      <span class="laba-toggle-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </span>
      <span class="laba-badge" id="laba-badge"></span>
    `;
    unreadCount = 0;
    updateBadge();
    updateLimitUI();
    setTimeout(() => { if (!isLimitReached()) inputEl.focus(); }, 80);
    vibrate([50]);
  }

  function closeWidget() {
    isOpen = false;
    win.classList.remove('laba-visible');
    toggle.classList.remove('laba-open');
    toggle.setAttribute('aria-label', 'Open Laba AI assistant');
    toggle.innerHTML = `
      <span class="laba-toggle-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </span>
      <span class="laba-badge" id="laba-badge"></span>
    `;
  }

  function minimizeWidget() {
    isMinimized = !isMinimized;
    win.classList.toggle('laba-minimized', isMinimized);
    minimizeBtn.setAttribute('title', isMinimized ? 'Expand' : 'Minimize');
  }

  /* ── Auto-resize textarea ────────────────────────────────── */
  function autoResizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
  }

  /* ── Event listeners ─────────────────────────────────────── */
  toggle.addEventListener('click', () => {
    if (isOpen) closeWidget(); else openWidget();
  });
  closeBtn.addEventListener('click', closeWidget);
  minimizeBtn.addEventListener('click', minimizeWidget);
  sendBtn.addEventListener('click', () => sendMessage(inputEl.value));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });
  inputEl.addEventListener('input', autoResizeInput);

  // Suggestion chips
  messagesEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.laba-suggestion');
    if (chip) sendMessage(chip.dataset.q || chip.textContent);
  });

  /* ── Drag logic ──────────────────────────────────────────── */
  let dragging = false;
  let dragStartX, dragStartY, winStartX, winStartY;

  headerEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.laba-hbtn')) return;
    dragging = true;
    win.classList.add('laba-dragging');
    const rect = win.getBoundingClientRect();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    winStartX = rect.left;
    winStartY = rect.top;
    e.preventDefault();
  });

  headerEl.addEventListener('touchstart', (e) => {
    if (e.target.closest('.laba-hbtn')) return;
    dragging = true;
    win.classList.add('laba-dragging');
    const rect = win.getBoundingClientRect();
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    winStartX = rect.left;
    winStartY = rect.top;
  }, { passive: true });

  function onDragMove(clientX, clientY) {
    if (!dragging) return;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;
    let newLeft = winStartX + dx;
    let newTop  = winStartY + dy;

    // Clamp inside viewport
    newLeft = Math.max(0, Math.min(window.innerWidth  - win.offsetWidth,  newLeft));
    newTop  = Math.max(0, Math.min(window.innerHeight - win.offsetHeight, newTop));

    win.style.left   = newLeft + 'px';
    win.style.top    = newTop  + 'px';
    win.style.right  = 'auto';
    win.style.bottom = 'auto';
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    win.classList.remove('laba-dragging');
  }

  document.addEventListener('mousemove', (e) => onDragMove(e.clientX, e.clientY));
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchmove', (e) => {
    if (dragging) onDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  document.addEventListener('touchend', onDragEnd);

  /* ── Midnight reset check ────────────────────────────────── */
  function scheduleMidnightReset() {
    const now  = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const ms   = next - now;
    setTimeout(() => {
      updateLimitUI();
      scheduleMidnightReset();
    }, ms + 100);
  }
  scheduleMidnightReset();

  /* ── Init ────────────────────────────────────────────────── */
  renderWelcome();
  updateLimitUI();
  updateBadge();

})();

/* Shared chrome — header, mobile drawer, auth modal.
   Loaded on every page (homepage + tool pages). */

// Each item: `tid` is the internal tool id (matches TOOLS[].id in tools-config.js
// and what tool-page.js looks up). `slug` is the SEO clean-URL slug (kept for
// backward compatibility with /merge-pdf style links). All navigation links
// emit `tool.html?id=<tid>` so they work both on the Replit backend and on
// Firebase Hosting (which has no SEO middleware).
window.TOOL_GROUPS = [
  {
    key:'organize', title:'Organize',
    items:[
      { tid:'merge',    slug:'merge-pdf',    name:'Merge PDF',    icon:'layers',       desc:'Combine multiple PDFs into one' },
      { tid:'split',    slug:'split-pdf',    name:'Split PDF',    icon:'scissors',     desc:'Extract pages or ranges' },
      { tid:'rotate',   slug:'rotate-pdf',   name:'Rotate PDF',   icon:'rotate-cw',    desc:'Fix page orientation' },
      { tid:'crop',     slug:'crop-pdf',     name:'Crop PDF',     icon:'crop',         desc:'Trim margins from pages' },
      { tid:'organize', slug:'organize-pdf', name:'Organize PDF', icon:'list-ordered', desc:'Reorder, delete, duplicate pages' },
      { tid:'compress', slug:'compress-pdf', name:'Compress PDF', icon:'archive',      desc:'Reduce PDF file size' },
    ]
  },
  {
    key:'convert', title:'Convert',
    items:[
      { tid:'pdf-to-word',       slug:'pdf-to-word',       name:'PDF to Word',       icon:'file-text',    desc:'Convert PDF to editable .docx' },
      { tid:'pdf-to-excel',      slug:'pdf-to-excel',      name:'PDF to Excel',      icon:'sheet',        desc:'Extract tables to .xlsx' },
      { tid:'pdf-to-powerpoint', slug:'pdf-to-powerpoint', name:'PDF to PowerPoint', icon:'presentation', desc:'Convert PDF to .pptx slides' },
      { tid:'pdf-to-jpg',        slug:'pdf-to-jpg',        name:'PDF to JPG',        icon:'image',        desc:'Export pages as images' },
      { tid:'word-to-pdf',       slug:'word-to-pdf',       name:'Word to PDF',       icon:'file-text',    desc:'Convert .docx into PDF' },
      { tid:'excel-to-pdf',      slug:'excel-to-pdf',      name:'Excel to PDF',      icon:'sheet',        desc:'Convert .xlsx into PDF' },
      { tid:'powerpoint-to-pdf', slug:'powerpoint-to-pdf', name:'PowerPoint to PDF', icon:'presentation', desc:'Convert .pptx into PDF' },
      { tid:'jpg-to-pdf',        slug:'jpg-to-pdf',        name:'JPG to PDF',        icon:'image',        desc:'Combine images into PDF' },
      { tid:'html-to-pdf',       slug:'html-to-pdf',       name:'HTML to PDF',       icon:'code',         desc:'Render HTML pages as PDF' },
    ]
  },
  {
    key:'edit', title:'Edit',
    items:[
      { tid:'edit',         slug:'edit-pdf',         name:'Edit PDF',         icon:'edit-3',  desc:'Add text, shapes, and notes' },
      { tid:'watermark',    slug:'watermark-pdf',    name:'Watermark PDF',    icon:'droplet', desc:'Stamp custom watermarks' },
      { tid:'sign',         slug:'sign-pdf',         name:'Sign PDF',         icon:'pen-tool',desc:'Add e-signatures' },
      { tid:'page-numbers', slug:'add-page-numbers', name:'Add Page Numbers', icon:'hash',    desc:'Insert page numbers' },
      { tid:'redact',       slug:'redact-pdf',       name:'Redact PDF',       icon:'eye-off', desc:'Hide sensitive content' },
    ]
  },
  {
    key:'security', title:'Security',
    items:[
      { tid:'protect', slug:'protect-pdf', name:'Protect PDF', icon:'lock',   desc:'Add password protection' },
      { tid:'unlock',  slug:'unlock-pdf',  name:'Unlock PDF',  icon:'unlock', desc:'Remove PDF password' },
    ]
  },
  {
    key:'advanced', title:'Advanced',
    items:[
      { tid:'repair',       slug:'repair-pdf',       name:'Repair PDF',       icon:'wrench',      desc:'Fix corrupted PDF files' },
      { tid:'scan-to-pdf',  slug:'scan-pdf',         name:'Scan PDF',         icon:'scan-line',   desc:'Create searchable scans' },
      { tid:'ocr',          slug:'ocr-pdf',          name:'OCR PDF',          icon:'type',        desc:'Recognize text in scans' },
      { tid:'compare',      slug:'compare-pdf',      name:'Compare PDF',      icon:'git-compare', desc:'Diff two PDF documents' },
      { tid:'ai-summarize', slug:'ai-summarizer',    name:'AI Summarizer',    icon:'sparkles',    desc:'Generate AI summaries' },
      { tid:'translate',    slug:'translate-pdf',    name:'Translate PDF',    icon:'languages',   desc:'Translate PDFs to any language' },
      { tid:'workflow',     slug:'workflow-builder', name:'Workflow Builder', icon:'workflow',    desc:'Chain multiple PDF tools' },
    ]
  },
  {
    key:'image', title:'Image',
    items:[
      { tid:'background-remover', slug:'background-remover', name:'Background Remover', icon:'image-off', desc:'Erase image backgrounds' },
      { tid:'crop-image',         slug:'crop-image',         name:'Crop Image',         icon:'crop',      desc:'Trim images precisely' },
      { tid:'resize-image',       slug:'resize-image',       name:'Resize Image',       icon:'maximize',  desc:'Change image dimensions' },
      { tid:'image-filters',      slug:'image-filters',      name:'Image Filters',      icon:'sliders',   desc:'Apply photo filters' },
    ]
  },
  {
    key:'utilities', title:'Utilities',
    items:[
      { url:'/currency-converter', name:'Currency Converter', icon:'dollar-sign', desc:'Live exchange rates for 160+ currencies' },
      { url:'/numbers-to-words',   name:'Numbers to Words',   icon:'calculator',  desc:'Convert numbers and currency to words' },
    ]
  },
];

const groupBy = key => window.TOOL_GROUPS.find(g => g.key === key);
// In-app navigation prefers the clean SEO slug ( /merge-pdf ) when present so
// users land on the indexable URL. Falls back to /tool.html?id=<id> for items
// without a slug (e.g. legacy entries) and to an explicit `url` when set.
const toolUrl = t => t.url || (t.slug ? `/${t.slug}` : `/tool.html?id=${t.tid}`);

function renderHeader(){
  const nav = document.getElementById('nav');
  if (!nav) return;

  // "All Tools" mega-menu: surfaces every category as a single complete index.
  const MEGA_KEYS = ['organize','convert','edit','security','advanced','image','utilities'];
  const megaCols = MEGA_KEYS.map(k => {
    const g = groupBy(k); if (!g) return '';
    return `
      <div class="mega-col">
        <h5>${g.title}</h5>
        ${g.items.map(t => `
          <a class="mega-link" href="${toolUrl(t)}" title="${t.desc||''}">
            <span class="mi"><i data-lucide="${t.icon}"></i></span>
            <span>${t.name}</span>
          </a>`).join('')}
      </div>`;
  }).join('');

  // Minimal header: search bar + All Tools dropdown only.
  nav.innerHTML = `
    <div class="header-search" id="header-search" role="search">
      <span class="hs-icon"><i data-lucide="search"></i></span>
      <input
        type="search"
        id="hs-input"
        class="hs-input"
        placeholder="Search 33+ tools…"
        autocomplete="off"
        aria-label="Search tools"
        aria-expanded="false"
        aria-controls="hs-results"
      >
      <div class="hs-results" id="hs-results" role="listbox" hidden></div>
    </div>
    <div class="nav-item has-dd has-mega" id="all-tools-item">
      <button class="nav-btn all-tools" id="all-tools-btn" type="button" aria-expanded="false" aria-haspopup="true">All Tools <i data-lucide="chevron-down"></i></button>
      <div class="mega" role="menu"><div class="mega-grid">${megaCols}</div></div>
    </div>
  `;

  // Defensive: the All Tools dropdown must NEVER be open on initial render.
  const allItem = document.getElementById('all-tools-item');
  if (allItem) allItem.classList.remove('is-open');

  wireAllToolsToggle();
  wireHoverPrefetch(nav);
  wireHeaderSearch();
}

/* Header search — live, fuzzy filter over every tool in TOOL_GROUPS.
   Click / Enter on a result navigates to the tool URL. Up/Down arrows move
   selection; Escape clears the input and closes the panel. */
function wireHeaderSearch(){
  const wrap    = document.getElementById('header-search');
  const input   = document.getElementById('hs-input');
  const results = document.getElementById('hs-results');
  if (!wrap || !input || !results) return;

  // Flatten all tools across groups into one searchable index.
  const INDEX = [];
  (window.TOOL_GROUPS || []).forEach(g => {
    (g.items || []).forEach(t => {
      INDEX.push({
        name: t.name,
        desc: t.desc || '',
        icon: t.icon || 'wrench',
        url:  toolUrl(t),
        cat:  g.title,
        hay:  (t.name + ' ' + (t.desc || '') + ' ' + g.title).toLowerCase(),
      });
    });
  });

  let selected = -1;
  let visible  = [];

  const close = () => {
    results.hidden = true;
    input.setAttribute('aria-expanded','false');
    selected = -1;
  };

  const render = (q) => {
    const query = (q || '').trim().toLowerCase();
    if (!query) { close(); return; }

    visible = INDEX.filter(t => {
      // tokenize so multi-word queries ("merge pdf") still match
      return query.split(/\s+/).every(tok => t.hay.includes(tok));
    }).slice(0, 8);

    if (!visible.length) {
      results.innerHTML = `<div class="hs-empty">No tools match &ldquo;${escapeHtml(query)}&rdquo;.</div>`;
    } else {
      results.innerHTML = visible.map((t, i) => `
        <a class="hs-item${i === selected ? ' is-active' : ''}" href="${t.url}" data-i="${i}" role="option">
          <span class="hs-mi"><i data-lucide="${t.icon}"></i></span>
          <span class="hs-text">
            <span class="hs-name">${escapeHtml(t.name)}</span>
            <span class="hs-cat">${escapeHtml(t.cat)}</span>
          </span>
        </a>`).join('');
    }
    results.hidden = false;
    input.setAttribute('aria-expanded','true');
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  };

  const updateActive = () => {
    [...results.querySelectorAll('.hs-item')].forEach((el, i) => {
      el.classList.toggle('is-active', i === selected);
    });
  };

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('focus', () => { if (input.value.trim()) render(input.value); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!visible.length) return;
      selected = (selected + 1) % visible.length;
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!visible.length) return;
      selected = (selected - 1 + visible.length) % visible.length;
      updateActive();
    } else if (e.key === 'Enter') {
      if (selected >= 0 && visible[selected]) {
        e.preventDefault();
        location.href = visible[selected].url;
      } else if (visible[0]) {
        e.preventDefault();
        location.href = visible[0].url;
      }
    } else if (e.key === 'Escape') {
      input.value = '';
      close();
      input.blur();
    }
  });

  // Click-outside closes the dropdown.
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

/* Prefetch tool pages on hover so the navigation feels instant.
   Adds a single <link rel="prefetch"> per URL — browsers natively dedupe and
   the request is low-priority so it never competes with critical resources. */
function wireHoverPrefetch(scope){
  const seen = new Set();
  const prefetch = (href) => {
    if (!href || seen.has(href)) return;
    if (!/^\/[a-z]/.test(href)) return; // only same-origin tool slugs
    seen.add(href);
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    document.head.appendChild(link);
  };
  scope.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a[href]');
    if (a) prefetch(a.getAttribute('href'));
  });
  scope.addEventListener('focusin', (e) => {
    const a = e.target.closest('a[href]');
    if (a) prefetch(a.getAttribute('href'));
  });
}

/* "All Tools" — opens on hover (CSS) on desktop. On touch / keyboard
   activation, toggle an .is-open class so it works without a hover state. */
function wireAllToolsToggle(){
  const item = document.getElementById('all-tools-item');
  const btn  = document.getElementById('all-tools-btn');
  if (!item || !btn) return;

  const close = () => {
    item.classList.remove('is-open');
    btn.setAttribute('aria-expanded','false');
  };
  const open = () => {
    item.classList.add('is-open');
    btn.setAttribute('aria-expanded','true');
  };

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.contains('is-open') ? close() : open();
  });

  // Click anywhere outside the mega closes it.
  document.addEventListener('click', e => {
    if (!item.classList.contains('is-open')) return;
    if (item.contains(e.target)) return;
    close();
  });

  // Mouse leaving the menu area also closes it (matches hover-open UX).
  // Small delay so quick reentries (e.g. crossing the gap) don't flicker.
  let leaveTimer = null;
  item.addEventListener('mouseleave', () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(close, 180);
  });
  item.addEventListener('mouseenter', () => {
    clearTimeout(leaveTimer);
  });

  // ESC closes.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

/* Drawer / hamburger removed — header is logo + search + All Tools only.
   Auth modal helpers below stay because the limit popup and tool-page
   inline links still trigger them via [data-auth]. */

/* Auth modal */
function ensureAuthModal(){
  if (document.getElementById('auth-modal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'auth-modal';
  wrap.className = 'auth-modal';
  wrap.innerHTML = `
    <div class="auth-back"></div>
    <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <button class="auth-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
      <div class="auth-tabs">
        <button class="auth-tab" data-tab="login">Login</button>
        <button class="auth-tab" data-tab="signup">Sign Up</button>
      </div>
      <h3 id="auth-title">Welcome back</h3>
      <p class="auth-sub" id="auth-sub">Login to access your saved documents.</p>

      <!-- LOGIN / SIGN-IN form (uses /api/auth/login) -->
      <form class="auth-form" id="auth-login-form" novalidate>
        <label class="auth-field"><span>Email</span>
          <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required></label>
        <label class="auth-field"><span>Password</span>
          <input type="password" name="password" placeholder="••••••••" autocomplete="current-password" required minlength="6"></label>
        <button class="auth-submit" type="submit">Login</button>
        <div class="auth-msg" id="login-msg"></div>
      </form>

      <!-- SIGN-UP step 1: just an email; server emails a confirmation link -->
      <form class="auth-form" id="auth-signup-form" novalidate hidden>
        <label class="auth-field"><span>Email address</span>
          <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required></label>
        <button class="auth-submit" type="submit">Send confirmation email</button>
        <p class="auth-fineprint">We'll email you a link to confirm your address. Then you'll set your name and password.</p>
        <div class="auth-msg" id="signup-msg"></div>
        <div class="signup-sent" id="signup-sent" hidden>
          <div class="ss-head">
            <i data-lucide="mail-check"></i>
            <strong>Check your inbox</strong>
          </div>
          <p>A confirmation link was sent to <strong id="ss-email"></strong>. Click it within 30 minutes to finish creating your account.</p>
          <div class="ss-demo" id="ss-demo" hidden>
            <p class="ss-demo-title">📬 Demo mode — no email service is configured yet, so the confirmation link is shown here:</p>
            <a id="ss-link" href="#" class="ss-link"></a>
          </div>
        </div>
      </form>
    </div>`;
  document.body.appendChild(wrap);

  wrap.querySelector('.auth-back').addEventListener('click', closeAuth);
  wrap.querySelector('.auth-close').addEventListener('click', closeAuth);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAuth(); });
  wrap.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => setAuthTab(t.dataset.tab)));

  // login / sign-in submit
  wrap.querySelector('#auth-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const msg = wrap.querySelector('#login-msg'); msg.className = 'auth-msg'; msg.textContent = '';
    try {
      const r = await (window.apiFetch || fetch)('/api/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
        credentials: 'include',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Login failed.');
      msg.className = 'auth-msg success';
      msg.textContent = `Welcome back, ${d.user.name.split(' ')[0]}!`;
      setTimeout(() => location.reload(), 700);
    } catch (err) { msg.className = 'auth-msg bad'; msg.textContent = err.message; }
  });

  // signup step 1: send confirmation email
  wrap.querySelector('#auth-signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get('email');
    const msg = wrap.querySelector('#signup-msg'); msg.className = 'auth-msg'; msg.textContent = '';
    const sent = wrap.querySelector('#signup-sent'); sent.hidden = true;
    try {
      const r = await (window.apiFetch || fetch)('/api/auth/start-signup', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email }),
        credentials: 'include',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not send confirmation email.');
      wrap.querySelector('#ss-email').textContent = d.email;
      if (!d.emailDelivered && d.link) {
        const a = wrap.querySelector('#ss-link');
        a.href = d.link; a.textContent = d.link;
        wrap.querySelector('#ss-demo').hidden = false;
      }
      sent.hidden = false;
      e.target.querySelector('button[type="submit"]').textContent = 'Resend email';
      window.lucide && window.lucide.createIcons && window.lucide.createIcons();
    } catch (err) { msg.className = 'auth-msg bad'; msg.textContent = err.message; }
  });
}

function setAuthTab(tab){
  const wrap = document.getElementById('auth-modal');
  wrap.dataset.tab = tab;
  wrap.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const titles = {
    login:  ['Welcome back', 'Login to access your saved documents.'],
    signin: ['Sign in to ILovePDF', 'Continue where you left off.'],
    signup: ['Create your account', 'Step 1 of 2 — confirm your email, then set your password.'],
  };
  const [h, s] = titles[tab] || titles.login;
  wrap.querySelector('#auth-title').textContent = h;
  wrap.querySelector('#auth-sub').textContent = s;
  const isSignup = (tab === 'signup');
  wrap.querySelector('#auth-login-form').hidden  =  isSignup;
  wrap.querySelector('#auth-signup-form').hidden = !isSignup;
  wrap.querySelector('#login-msg').textContent = '';
  wrap.querySelector('#signup-msg').textContent = '';
}

function openAuth(tab){
  ensureAuthModal();
  setAuthTab(tab || 'login');
  document.getElementById('auth-modal').classList.add('open');
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}
/* ─────────── Global usage-limit popup ─────────── */
window.showLimitPopup = function (message, isAnonymous) {
  let m = document.getElementById('limit-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'limit-modal';
    m.className = 'limit-modal';
    m.innerHTML = `
      <div class="limit-back"></div>
      <div class="limit-card">
        <button class="limit-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
        <div class="limit-icon"><i data-lucide="alert-triangle"></i></div>
        <h3 id="lim-title">Daily limit reached</h3>
        <p id="lim-msg"></p>
        <div class="limit-actions" id="lim-actions"></div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('.limit-back').addEventListener('click', () => m.classList.remove('open'));
    m.querySelector('.limit-close').addEventListener('click', () => m.classList.remove('open'));
  }
  m.querySelector('#lim-msg').textContent = message || 'You have reached today\'s limit.';
  const actions = m.querySelector('#lim-actions');
  actions.innerHTML = isAnonymous
    ? `<button class="btn btn-primary" id="lim-signup">Sign up to continue</button>
       <button class="btn btn-ghost" id="lim-close">Maybe later</button>`
    : `<button class="btn btn-ghost" id="lim-close">Got it</button>`;
  actions.querySelector('#lim-close').addEventListener('click', () => m.classList.remove('open'));
  if (isAnonymous) {
    actions.querySelector('#lim-signup').addEventListener('click', () => {
      m.classList.remove('open');
      if (typeof openAuth === 'function') { openAuth(); setAuthTab('signup'); }
    });
  }
  m.classList.add('open');
  window.lucide && window.lucide.createIcons && window.lucide.createIcons();
};

function closeAuth(){
  const w = document.getElementById('auth-modal');
  if (w) w.classList.remove('open');
}

function wireAuth(){
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-auth]');
    if (!t) return;
    e.preventDefault();
    openAuth(t.dataset.auth);
  });
}

// Auto-load the mobile bottom navbar across every page that loads chrome.js.
// Using a single dynamic include avoids needing a <script> tag in each HTML.
function loadMobileNav() {
  if (document.getElementById('mobile-nav-script')) return;
  const s = document.createElement('script');
  s.id  = 'mobile-nav-script';
  s.src = '/js/mobile-nav.js';
  s.defer = true;
  document.head.appendChild(s);
}

document.addEventListener("DOMContentLoaded", () => {
  renderHeader();
  wireAuth();
  startAuthStateObserver();
  loadMobileNav();

  const tryIcons = () => window.lucide && window.lucide.createIcons && window.lucide.createIcons();
  tryIcons();
  setTimeout(tryIcons, 150);
  setTimeout(tryIcons, 700);

  document.addEventListener("click", function(e) {
    const link = e.target.closest("a");
    if (!link) return;

    const href = link.getAttribute("href");

    if (href && href.startsWith("/") && !href.startsWith("//")) {
      e.preventDefault(); 
      e.stopPropagation();

      console.log("Navigating to:", href);

      history.pushState({}, "", href);

      if (typeof loadToolPage === "function") {
        loadToolPage(href);
      } else {
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    }
  });
});
window.addEventListener("popstate", () => {
  if (typeof loadToolPage === "function") {
    loadToolPage(window.location.pathname);
  }
});

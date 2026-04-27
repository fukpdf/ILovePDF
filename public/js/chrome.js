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
];

const groupBy = key => window.TOOL_GROUPS.find(g => g.key === key);
// All in-app navigation uses /tool.html?id=<internal-id>. This works both on
// the Node backend and on Firebase Hosting (which serves tool.html directly).
const toolUrl = t => `/tool.html?id=${t.tid}`;

function renderHeader(){
  const nav = document.getElementById('nav');
  if (!nav) return;

  const drop = (key) => {
    const g = groupBy(key); if (!g) return '';
    return `
      <div class="nav-item has-dd">
        <button class="nav-btn" type="button">${g.title} <i data-lucide="chevron-down"></i></button>
        <div class="dd">
          ${g.items.map(t => `
            <a class="dd-link" href="${toolUrl(t)}">
              <span class="mi"><i data-lucide="${t.icon}"></i></span>
              <span>${t.name}</span>
            </a>`).join('')}
        </div>
      </div>`;
  };

  // The main header already exposes Merge, Split, and the Organize / Convert /
  // Edit / Security dropdowns. The "All Tools" mega-menu therefore should
  // surface ONLY the tools that aren't reachable from the main header — i.e.
  // the Advanced and Image groups.
  const megaCols = ['advanced','image'].map(k => {
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

  nav.innerHTML = `
    <a class="nav-direct" href="/tool.html?id=merge">Merge PDF</a>
    <a class="nav-direct" href="/tool.html?id=split">Split PDF</a>
    ${drop('organize')}
    ${drop('convert')}
    ${drop('edit')}
    ${drop('security')}
    <div class="nav-item has-dd has-mega">
      <button class="nav-btn all-tools" type="button">All Tools <i data-lucide="chevron-down"></i></button>
      <div class="mega"><div class="mega-grid">${megaCols}</div></div>
    </div>
  `;
}

function renderDrawer(){
  const drawer = document.getElementById('drawer');
  if (!drawer) return;
  const panel = drawer.querySelector('.drawer-panel');
  if (!panel) return;
  const sectionLinks = (key) => {
    const g = groupBy(key); if (!g) return '';
    return `
      <div class="drawer-sec">
        <div class="drawer-sec-title">${g.title}</div>
        ${g.items.map(t => `<a href="${toolUrl(t)}">${t.name}</a>`).join('')}
      </div>`;
  };
  panel.innerHTML = `
    <button class="drawer-close" id="drawer-close" aria-label="Close menu"><i data-lucide="x"></i></button>
    <a class="drawer-top" href="/tool.html?id=merge">Merge PDF</a>
    <a class="drawer-top" href="/tool.html?id=split">Split PDF</a>
    ${sectionLinks('organize')}
    ${sectionLinks('convert')}
    ${sectionLinks('edit')}
    ${sectionLinks('security')}
    ${sectionLinks('advanced')}
    ${sectionLinks('image')}
    <div class="drawer-auth">
      <a href="#" class="btn btn-ghost" data-auth="login">Login</a>
      <a href="#" class="btn btn-primary" data-auth="signup">Sign Up</a>
    </div>
  `;
}

function wireDrawer(){
  const drawer = document.getElementById('drawer');
  const open  = document.getElementById('hamburger');
  if (!drawer || !open) return;
  const set = v => drawer.classList.toggle('open', v);
  open.addEventListener('click', () => set(true));
  drawer.addEventListener('click', e => {
    if (e.target.closest('.drawer-back') || e.target.closest('#drawer-close') || e.target.closest('a')) {
      set(false);
    }
  });
}

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

document.addEventListener('DOMContentLoaded', () => {
  renderHeader();
  renderDrawer();
  wireDrawer();
  wireAuth();
  startAuthStateObserver();
  const tryIcons = () => window.lucide && window.lucide.createIcons && window.lucide.createIcons();
  tryIcons();
  setTimeout(tryIcons, 150);
  setTimeout(tryIcons, 700);
});

// ── Smart header: hide Login/Sign-up + center the logo when signed in ────
// AuthUI doesn't currently emit events, so we lightweight-poll its
// `current()` value and toggle a class on the header. Cheap, no flicker.
function startAuthStateObserver() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  let lastSignedIn = null;
  function tick() {
    let signedIn = false;
    try {
      if (window.AuthUI && typeof window.AuthUI.current === 'function') {
        signedIn = !!window.AuthUI.current();
      } else if (window.firebase?.auth) {
        signedIn = !!window.firebase.auth().currentUser;
      }
    } catch (_) { signedIn = false; }
    if (signedIn !== lastSignedIn) {
      lastSignedIn = signedIn;
      header.classList.toggle('is-signed-in', signedIn);
    }
  }
  tick();
  setInterval(tick, 600);
}

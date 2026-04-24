// ── N2W front-end controller: converter UI + sidebar + auth + storage bar ──

const $ = id => document.getElementById(id);
const QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

// ── CONVERTER ──────────────────────────────────────────────────────────────
function runConvert() {
  const num   = $('num-input').value;
  const mode  = document.querySelector('input[name="mode"]:checked').value;
  const opts  = {
    mode,
    currency:   $('currency').value,
    suffix:     $('suffix').value,
    letterCase: $('letterCase').value,
  };
  $('result-err').classList.add('hidden');
  $('result-wrap').classList.add('hidden');

  const out = window.convertNumberToWords(num, opts);
  if (out.error) {
    $('result-err').textContent = out.error;
    $('result-err').classList.remove('hidden');
    return;
  }
  $('result-text').textContent = out.text;
  $('result-wrap').classList.remove('hidden');
}

$('convert-btn').addEventListener('click', runConvert);
$('clear-btn').addEventListener('click', () => {
  $('num-input').value = '';
  $('result-wrap').classList.add('hidden');
  $('result-err').classList.add('hidden');
  $('num-input').focus();
});
$('num-input').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runConvert();
});
$('copy-btn').addEventListener('click', async () => {
  const text = $('result-text').textContent;
  try {
    await navigator.clipboard.writeText(text);
    const orig = $('copy-btn').innerHTML;
    $('copy-btn').innerHTML = '✓ Copied!';
    setTimeout(() => { $('copy-btn').innerHTML = orig; }, 1500);
  } catch {
    alert('Could not copy. Please copy manually.');
  }
});
document.querySelectorAll('.example-btn').forEach(b => {
  b.addEventListener('click', () => { $('num-input').value = b.dataset.val; runConvert(); });
});

// ── SIDEBAR ────────────────────────────────────────────────────────────────
function openSidebar() {
  $('sidebar-backdrop').classList.remove('hidden');
  $('sidebar').classList.remove('-translate-x-full');
}
function closeSidebar() {
  $('sidebar-backdrop').classList.add('hidden');
  $('sidebar').classList.add('-translate-x-full');
}
$('open-sidebar').addEventListener('click', openSidebar);
$('open-sidebar-2').addEventListener('click', openSidebar);
$('close-sidebar').addEventListener('click', closeSidebar);
$('sidebar-backdrop').addEventListener('click', closeSidebar);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });

// ── ALL TOOLS DROPDOWN (header) ────────────────────────────────────────────
async function buildToolsDropdown() {
  const dd = $('tools-dropdown');
  // hard-coded list to avoid extra requests; matches /tool.html?id=… ids
  const tools = [
    ['Merge', 'merge'], ['Split', 'split'], ['Compress PDF', 'compress'],
    ['PDF to Word', 'pdf-to-word'], ['Word to PDF', 'word-to-pdf'],
    ['JPG to PDF', 'jpg-to-pdf'], ['HTML to PDF', 'html-to-pdf'],
    ['Edit PDF', 'edit'], ['Watermark', 'watermark'], ['Sign PDF', 'sign'],
    ['Protect PDF', 'protect'], ['Unlock PDF', 'unlock'],
    ['OCR', 'ocr'], ['AI Summarizer', 'ai-summarize'], ['Translate', 'translate'],
    ['Background Remover', 'background-remover'], ['Image Resize', 'resize-image'],
  ];
  dd.innerHTML = tools.map(([name, id]) =>
    `<a href="/tool.html?id=${id}" class="block px-3 py-2 rounded-md text-sm text-slate-700 hover:bg-brand-light hover:text-brand-dark">${name}</a>`
  ).join('') + `<a href="/" class="block mt-1 px-3 py-2 rounded-md text-sm font-semibold text-brand hover:bg-brand-light">View all tools →</a>`;
}
$('tools-dropdown-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('tools-dropdown').classList.toggle('hidden');
});
document.addEventListener('click', () => $('tools-dropdown').classList.add('hidden'));
buildToolsDropdown();

// ── AUTH MODAL ─────────────────────────────────────────────────────────────
let authMode = 'signup';
function openAuth(mode) {
  authMode = mode;
  $('auth-modal').classList.remove('hidden');
  $('auth-title').textContent  = mode === 'signup' ? 'Sign Up' : 'Log In';
  $('auth-sub').textContent    = mode === 'signup'
    ? 'Create a free account to unlock 2 GB of cloud storage.'
    : 'Welcome back. Sign in to access your account.';
  $('auth-submit').textContent = mode === 'signup' ? 'Create Account' : 'Log In';
  $('auth-toggle-text').textContent = mode === 'signup' ? 'Already have an account?' : 'Need an account?';
  $('auth-toggle').textContent = mode === 'signup' ? 'Log in' : 'Sign up';
  $('name-row').classList.toggle('hidden', mode !== 'signup');
  $('auth-err').classList.add('hidden');
}
$('show-signup').addEventListener('click', () => openAuth('signup'));
$('show-login').addEventListener('click',  () => openAuth('login'));
$('close-auth').addEventListener('click', () => $('auth-modal').classList.add('hidden'));
$('auth-modal').addEventListener('click', e => { if (e.target === e.currentTarget) $('auth-modal').classList.add('hidden'); });
$('auth-toggle').addEventListener('click', () => openAuth(authMode === 'signup' ? 'login' : 'signup'));

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('auth-err').classList.add('hidden');
  const body = {
    email:    $('auth-email').value.trim(),
    password: $('auth-pass').value,
  };
  if (authMode === 'signup') body.name = $('auth-name').value.trim();
  const url = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
  const res = await (window.apiFetch || fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('auth-err').textContent = json.error || 'Something went wrong.';
    $('auth-err').classList.remove('hidden');
    return;
  }
  $('auth-modal').classList.add('hidden');
  applyUser(json.user);
});

$('logout-btn').addEventListener('click', async () => {
  await (window.apiFetch || fetch)('/api/auth/logout', { method: 'POST', credentials: 'include' });
  applyUser(null);
});

// ── PROFILE / STORAGE ──────────────────────────────────────────────────────
function applyUser(user) {
  if (!user) {
    $('sb-name').textContent = 'Guest';
    $('sb-email').textContent = 'Not signed in';
    $('sb-avatar').src = 'https://api.dicebear.com/7.x/initials/svg?seed=Guest';
    $('header-avatar').src = 'https://api.dicebear.com/7.x/initials/svg?seed=Guest';
    $('storage-text').textContent = '0 GB / 2 GB';
    $('storage-bar').style.width = '0%';
    $('auth-buttons').classList.remove('hidden');
    $('logout-btn').classList.add('hidden');
    return;
  }
  $('sb-name').textContent  = user.name;
  $('sb-email').textContent = user.email;
  const seed = encodeURIComponent(user.name || user.email);
  $('sb-avatar').src      = `https://api.dicebear.com/7.x/initials/svg?seed=${seed}`;
  $('header-avatar').src  = `https://api.dicebear.com/7.x/initials/svg?seed=${seed}`;

  const usedGB  = (user.storage_used  / (1024 ** 3)).toFixed(2);
  const totalGB = (user.storage_quota / (1024 ** 3)).toFixed(0);
  const pct     = Math.min(100, (user.storage_used / user.storage_quota) * 100);
  $('storage-text').textContent = `${usedGB} GB / ${totalGB} GB`;
  $('storage-bar').style.width = `${pct}%`;

  $('auth-buttons').classList.add('hidden');
  $('logout-btn').classList.remove('hidden');
}

// Auto-open auth modal if URL is #auth=login or #auth=signup
(function checkHashAuth(){
  const m = /auth=(login|signup)/.exec(location.hash || '');
  if (m) setTimeout(() => openAuth(m[1]), 200);
})();

(async function loadMe() {
  try {
    const res = await (window.apiFetch || fetch)('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      const j = await res.json();
      applyUser(j.user);
    } else {
      applyUser(null);
    }
  } catch { applyUser(null); }
})();

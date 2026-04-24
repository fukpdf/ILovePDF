// Shared auth UI: injects an auth modal + a profile dropdown across all pages,
// swaps the v2-auth Log In/Sign Up buttons with the profile chip when logged in.
//
// Auth backends used in priority order:
//   1. Firebase Auth (Google sign-in + email/password) — when /api/config/firebase
//      returns a real config. After Firebase signs the user in, we POST the
//      ID token to /api/auth/firebase to mint our ilovepdf_token cookie.
//   2. Legacy email/password against /api/auth/{signup,login} — fallback when
//      Firebase is not configured on the server.
(function () {
  const MODAL_ID = 'global-auth-modal';
  let currentUser = null;
  let mode = 'signup';
  let firebaseReady = false;

  // ── Modal HTML (injected once) ─────────────────────────────────────────
  function injectModal() {
    if (document.getElementById(MODAL_ID)) return;
    const div = document.createElement('div');
    div.id = MODAL_ID;
    div.className = 'auth-modal hidden';
    div.innerHTML = `
      <div class="auth-modal-card">
        <button class="auth-x" type="button" aria-label="Close">&times;</button>
        <h3 class="auth-title">Sign Up</h3>
        <p class="auth-sub">Create a free account for higher daily limits and 2 GB cloud storage.</p>

        <button class="auth-google" type="button" hidden>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35.5 24 35.5c-6.4 0-11.5-5.1-11.5-11.5S17.6 12.5 24 12.5c2.9 0 5.6 1.1 7.6 2.9l5.7-5.7C33.6 6.4 29 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.3-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12.5 24 12.5c2.9 0 5.6 1.1 7.6 2.9l5.7-5.7C33.6 6.4 29 4.5 24 4.5 16.3 4.5 9.7 8.9 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 43.5c5.2 0 10-2 13.6-5.2l-6.3-5.2c-2 1.4-4.6 2.4-7.3 2.4-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.6 39 16.2 43.5 24 43.5z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.3 5.2C40.7 36.5 43.5 30.7 43.5 24c0-1.2-.1-2.3-.4-3.5z"/>
          </svg>
          Continue with Google
        </button>
        <div class="auth-divider" hidden><span>or</span></div>

        <form class="auth-form" autocomplete="on">
          <label class="auth-row" data-field="name">
            <span>Name</span>
            <input name="name" type="text" autocomplete="name">
          </label>
          <label class="auth-row">
            <span>Email</span>
            <input name="email" type="email" autocomplete="email" required>
          </label>
          <label class="auth-row">
            <span>Password</span>
            <input name="password" type="password" autocomplete="new-password" required minlength="6">
          </label>
          <div class="auth-err hidden"></div>
          <button class="auth-submit" type="submit">Create Account</button>
          <button class="auth-forgot" type="button" hidden>Forgot password?</button>
        </form>
        <p class="auth-toggle-line">
          <span class="auth-toggle-text">Already have an account?</span>
          <button class="auth-toggle" type="button">Log in</button>
        </p>
      </div>`;
    document.body.appendChild(div);

    div.addEventListener('click', e => { if (e.target === div) close(); });
    div.querySelector('.auth-x').addEventListener('click', close);
    div.querySelector('.auth-toggle').addEventListener('click', () => open(mode === 'signup' ? 'login' : 'signup'));
    div.querySelector('.auth-form').addEventListener('submit', submit);
    div.querySelector('.auth-google').addEventListener('click', loginWithGoogle);
    div.querySelector('.auth-forgot').addEventListener('click', forgotPassword);
  }

  function open(m) {
    injectModal();
    mode = m || 'signup';
    const card = document.getElementById(MODAL_ID);
    card.classList.remove('hidden');
    card.querySelector('.auth-title').textContent = mode === 'signup' ? 'Sign Up' : 'Log In';
    card.querySelector('.auth-sub').textContent = mode === 'signup'
      ? 'Create a free account for higher daily limits and 2 GB cloud storage.'
      : 'Welcome back. Sign in to your ILovePDF account.';
    card.querySelector('.auth-submit').textContent = mode === 'signup' ? 'Create Account' : 'Log In';
    card.querySelector('.auth-toggle-text').textContent = mode === 'signup' ? 'Already have an account?' : 'Need an account?';
    card.querySelector('.auth-toggle').textContent = mode === 'signup' ? 'Log in' : 'Sign up';
    card.querySelector('[data-field="name"]').classList.toggle('hidden', mode !== 'signup');
    card.querySelector('.auth-err').classList.add('hidden');
    card.querySelector('.auth-google').hidden  = !firebaseReady;
    card.querySelector('.auth-divider').hidden = !firebaseReady;
    card.querySelector('.auth-forgot').hidden  = !(firebaseReady && mode === 'login');
  }
  function close() { document.getElementById(MODAL_ID)?.classList.add('hidden'); }

  // ── Server-side cookie minting after Firebase login ────────────────────
  async function exchangeFirebaseToken() {
    const idToken = await window.FB.getIdToken(true);
    if (!idToken) throw new Error('No Firebase ID token');
    const r = await (window.apiFetch || fetch)('/api/auth/firebase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      credentials: 'include',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Server rejected Firebase token');
    return j.user;
  }

  async function loginWithGoogle() {
    const errBox = document.querySelector(`#${MODAL_ID} .auth-err`);
    errBox.classList.add('hidden');
    try {
      await window.FB.loginGoogle();
      currentUser = await exchangeFirebaseToken();
      close();
      renderProfile();
    } catch (err) {
      errBox.textContent = err.message || 'Google sign-in failed';
      errBox.classList.remove('hidden');
    }
  }

  async function forgotPassword() {
    const card = document.getElementById(MODAL_ID);
    const email = card.querySelector('input[name="email"]').value.trim();
    const errBox = card.querySelector('.auth-err');
    errBox.classList.remove('hidden');
    if (!email) { errBox.textContent = 'Enter your email above first.'; return; }
    try {
      await window.FB.resetPassword(email);
      errBox.textContent = `Password reset link sent to ${email}.`;
      errBox.style.color = '#10b981';
    } catch (err) {
      errBox.style.color = '';
      errBox.textContent = err.message || 'Could not send reset email.';
    }
  }

  async function submit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email    = fd.get('email')?.trim();
    const password = fd.get('password');
    const name     = fd.get('name')?.trim() || (email ? email.split('@')[0] : '');
    const errBox = e.target.querySelector('.auth-err');
    errBox.classList.add('hidden');
    errBox.style.color = '';
    try {
      if (firebaseReady) {
        if (mode === 'signup') {
          await window.FB.signupEmail(email, password, name);
        } else {
          await window.FB.loginEmail(email, password);
        }
        currentUser = await exchangeFirebaseToken();
      } else {
        // Fallback: legacy server-side auth
        const url = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
        const body = mode === 'signup' ? { email, password, name } : { email, password };
        const res = await (window.apiFetch || fetch)(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || 'Something went wrong');
        currentUser = j.user;
      }
      close();
      renderProfile();
    } catch (err) {
      errBox.textContent = (err && err.message) ? err.message.replace(/^Firebase: /, '') : 'Authentication failed';
      errBox.classList.remove('hidden');
    }
  }

  // ── Profile chip / dropdown ────────────────────────────────────────────
  function renderProfile() {
    const auth = document.querySelector('.v2-auth');
    if (!auth) return;
    if (!currentUser) {
      auth.innerHTML = `
        <button class="btn-login" type="button">Log In</button>
        <button class="btn-signup" type="button">Sign Up</button>`;
      auth.querySelector('.btn-login').addEventListener('click', () => open('login'));
      auth.querySelector('.btn-signup').addEventListener('click', () => open('signup'));
      return;
    }
    const u = currentUser;
    const seed = encodeURIComponent(u.name || u.email);
    const initials = (u.name || u.email).split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase();
    const avatar = u.avatar_url
      ? `<span class="profile-avatar" style="background-image:url('${u.avatar_url}')"></span>`
      : `<span class="profile-avatar" style="background-image:url('https://api.dicebear.com/7.x/initials/svg?seed=${seed}')">${initials}</span>`;
    auth.innerHTML = `
      <div class="profile-chip">
        <button class="profile-btn" type="button" aria-haspopup="true" aria-expanded="false">
          ${avatar}
          <span class="profile-name">${u.name || u.email.split('@')[0]}</span>
          <svg class="profile-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="profile-menu hidden" role="menu">
          <div class="pm-head">
            <div class="pm-name">${u.name || ''}</div>
            <div class="pm-email">${u.email}</div>
          </div>
          <a class="pm-item" href="/n2w.html#profile" role="menuitem">Profile</a>
          <a class="pm-item" href="/dashboard.html" role="menuitem">My Files</a>
          <a class="pm-item pm-danger" href="#" data-act="logout" role="menuitem">Log Out</a>
        </div>
      </div>`;
    const wrap  = auth.querySelector('.profile-chip');
    const btn   = wrap.querySelector('.profile-btn');
    const menu  = wrap.querySelector('.profile-menu');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = menu.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    });
    document.addEventListener('click', () => menu.classList.add('hidden'));
    menu.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.act === 'logout') {
        try { if (firebaseReady) await window.FB.logout(); } catch {}
        await (window.apiFetch || fetch)('/api/auth/logout', { method: 'POST', credentials: 'include' });
        currentUser = null;
        renderProfile();
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  async function init() {
    injectModal();
    // Wait briefly for Firebase to initialise (or report unavailable)
    if (window.FB && window.FB.ready) {
      try { firebaseReady = await window.FB.ready === true; } catch { firebaseReady = false; }
    } else {
      // firebase-init.js may not be loaded; wait one tick then proceed
      await new Promise(r => setTimeout(r, 50));
      firebaseReady = !!(window.FB && !window.FB.disabled);
    }
    try {
      const res = await (window.apiFetch || fetch)('/api/auth/me', { credentials: 'include' });
      if (res.ok) currentUser = (await res.json()).user;
    } catch {}
    renderProfile();
    const m = /auth=(login|signup)/.exec(location.hash);
    if (m && !currentUser) open(m[1]);
  }
  function waitAndInit() {
    if (document.querySelector('.v2-auth')) init();
    else setTimeout(waitAndInit, 50);
  }
  document.addEventListener('DOMContentLoaded', waitAndInit);

  window.AuthUI = { open, close, current: () => currentUser };
})();

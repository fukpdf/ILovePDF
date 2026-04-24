// Firebase web SDK bootstrap. Loads runtime config from the server (so the
// values live in env, not in source), then exposes window.FB with a tiny
// auth-helper API used by auth-ui.js.
(function () {
  const SDK = 'https://www.gstatic.com/firebasejs/10.13.0';
  let app = null;
  let auth = null;
  let configured = false;
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  async function loadModule(path) { return import(`${SDK}/${path}`); }

  async function init() {
    try {
      const cfgUrl = (typeof window.apiUrl === 'function') ? window.apiUrl('/api/config/firebase') : '/api/config/firebase';
      const cfgRes = await fetch(cfgUrl, { credentials: 'include' });
      if (!cfgRes.ok) throw new Error('config unavailable');
      const cfg = await cfgRes.json();
      if (!cfg.apiKey) throw new Error('Firebase not configured on server');

      const { initializeApp } = await loadModule('firebase-app.js');
      const authMod = await loadModule('firebase-auth.js');
      app = initializeApp(cfg);
      auth = authMod.getAuth(app);

      window.FB = {
        ready,
        auth,
        // email/password
        async signupEmail(email, password, displayName) {
          const u = await authMod.createUserWithEmailAndPassword(auth, email, password);
          if (displayName) {
            try { await authMod.updateProfile(u.user, { displayName }); } catch {}
          }
          try { await authMod.sendEmailVerification(u.user); } catch {}
          return u.user;
        },
        async loginEmail(email, password) {
          const u = await authMod.signInWithEmailAndPassword(auth, email, password);
          return u.user;
        },
        async resetPassword(email) {
          return authMod.sendPasswordResetEmail(auth, email);
        },
        // google
        async loginGoogle() {
          const provider = new authMod.GoogleAuthProvider();
          const u = await authMod.signInWithPopup(auth, provider);
          return u.user;
        },
        async logout() { try { await authMod.signOut(auth); } catch {} },
        currentUser: () => auth.currentUser,
        async getIdToken(forceRefresh = false) {
          const u = auth.currentUser;
          return u ? u.getIdToken(forceRefresh) : null;
        },
        onAuthChanged(cb) { return authMod.onAuthStateChanged(auth, cb); },
      };
      configured = true;
      readyResolve(true);
      document.dispatchEvent(new CustomEvent('firebase-ready'));
    } catch (e) {
      console.warn('[firebase] disabled:', e.message);
      window.FB = { ready: Promise.resolve(false), disabled: true, reason: e.message };
      readyResolve(false);
      document.dispatchEvent(new CustomEvent('firebase-ready'));
    }
  }

  init();
})();

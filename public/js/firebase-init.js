// Firebase web SDK bootstrap. Hardcoded config (these values are public
// by design — Firebase web API keys identify the project, they are not
// secrets — and locking them in here means Login/Signup keeps working
// without any server endpoint, fully serverless on Firebase Hosting).
//
// Override at runtime if needed: window.FIREBASE_CONFIG = { ... } before
// this script loads, or set localStorage 'ilovepdf:firebase_config' to
// a JSON blob.
(function () {
  const SDK = 'https://www.gstatic.com/firebasejs/10.13.0';
  let app = null;
  let auth = null;
  let configured = false;
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  // ── Public Firebase web config (project: ilovepdf-web) ───────────────────
  const DEFAULT_CONFIG = {
    apiKey:        'AIzaSyB6TpoTdUp_f3HxJHn7I0sV1FV4llJjybQ',
    authDomain:    'ilovepdf-web.firebaseapp.com',
    projectId:     'ilovepdf-web',
    storageBucket: 'ilovepdf-web.firebasestorage.app',
    appId:         '1:220495273530:web:68068202e588705e989f03',
  };

  function resolveConfig() {
    if (window.FIREBASE_CONFIG && typeof window.FIREBASE_CONFIG === 'object') {
      return window.FIREBASE_CONFIG;
    }
    try {
      const ls = localStorage.getItem('ilovepdf:firebase_config');
      if (ls) return JSON.parse(ls);
    } catch (_) {}
    return DEFAULT_CONFIG;
  }

  async function loadModule(path) { return import(`${SDK}/${path}`); }

  async function init() {
    try {
      const cfg = resolveConfig();
      if (!cfg.apiKey) throw new Error('Firebase config missing apiKey');

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

  // Defer init to browser idle time so the SDK fetch doesn't compete with
  // first paint or critical scripts. Auth UI calls `await window.FB.ready`
  // (created above), so any consumer that loads before init completes will
  // simply wait for the promise — fully backward-compatible.
  function scheduleInit() {
    const start = () => { try { init(); } catch (e) { console.warn('[firebase] init failed:', e); } };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(start, { timeout: 2500 });
    } else {
      setTimeout(start, 600);
    }
  }
  scheduleInit();
})();

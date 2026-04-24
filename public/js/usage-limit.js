// Daily usage limit: 15 / day for guests, 100 / day for logged-in users.
// Tracked in localStorage, keyed by date so it auto-resets every day.
// We add a tiny per-browser fingerprint so quotas aren't trivially reset
// by clearing one tab's storage.
(function () {
  const KEY_PREFIX = 'ilovepdf:usage:';
  const FP_KEY     = 'ilovepdf:fp';
  const GUEST_LIMIT = 15;
  const USER_LIMIT  = 100;

  function fp() {
    let v = localStorage.getItem(FP_KEY);
    if (!v) {
      v = 'fp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(FP_KEY, v);
    }
    return v;
  }
  function todayKey() {
    const d = new Date();
    return `${KEY_PREFIX}${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}:${fp()}`;
  }
  function getCount() {
    return parseInt(localStorage.getItem(todayKey()) || '0', 10);
  }
  function isLogged() { return !!(window.AuthUI && window.AuthUI.current()); }
  function limit()   { return isLogged() ? USER_LIMIT : GUEST_LIMIT; }

  function canUse() { return getCount() < limit(); }
  function record(n = 1) {
    const key = todayKey();
    localStorage.setItem(key, String(getCount() + n));
    updateBadge();
  }

  function ensureModal() {
    if (document.getElementById('usage-limit-modal')) return;
    const m = document.createElement('div');
    m.id = 'usage-limit-modal';
    m.className = 'auth-modal hidden';
    m.innerHTML = `
      <div class="auth-modal-card" style="text-align:center;">
        <button class="auth-x" type="button" aria-label="Close">&times;</button>
        <div style="font-size:42px;margin-bottom:8px;">⏱️</div>
        <h3 class="auth-title">Daily limit reached</h3>
        <p class="auth-sub">
          You've used your <strong id="ul-used">15</strong> free files for today.
          Sign up for a free account to <strong>upgrade to ${USER_LIMIT} files / day</strong>
          and unlock 2&nbsp;GB of cloud storage.
        </p>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:16px;">
          <button class="auth-submit" id="ul-upgrade" style="width:auto;padding:10px 22px;">Upgrade — Sign Up Free</button>
          <button class="auth-submit" id="ul-close" style="width:auto;padding:10px 22px;background:#fff;color:var(--brand-text);border:1.5px solid #d8dafd;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
    m.querySelector('.auth-x').addEventListener('click', () => m.classList.add('hidden'));
    m.querySelector('#ul-close').addEventListener('click', () => m.classList.add('hidden'));
    m.querySelector('#ul-upgrade').addEventListener('click', () => {
      m.classList.add('hidden');
      window.AuthUI?.open('signup');
    });
  }

  function showLimitModal() {
    ensureModal();
    document.getElementById('ul-used').textContent = String(limit());
    document.getElementById('usage-limit-modal').classList.remove('hidden');
  }

  // Tiny badge that displays "Daily usage X / Y" — appears next to the auth area
  function updateBadge() {
    const auth = document.querySelector('.v2-auth');
    if (!auth) return;
    let badge = document.getElementById('usage-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'usage-badge';
      badge.className = 'usage-badge';
      auth.parentNode.insertBefore(badge, auth);
    }
    const used = getCount(), max = limit();
    const pct = used / max;
    badge.dataset.level = pct >= 1 ? 'over' : pct >= .75 ? 'warn' : 'ok';
    badge.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${used}/${max} today`;
  }

  // Refresh badge whenever auth state may have changed
  setInterval(updateBadge, 1500);

  window.UsageLimit = { canUse, record, limit, getCount, showLimitModal };
})();

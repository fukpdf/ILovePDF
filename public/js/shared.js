// Shared helpers: modals, sidebar toggle, cookies, signup-required flow, processing overlay.

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

function handleModalBackdropClick(e) { if (e.target === e.currentTarget) closeComingSoonModal(); }
function closeComingSoonModal() {
  const m = document.getElementById('coming-soon-modal');
  if (m) m.classList.add('hidden');
  document.body.style.overflow = '';
}

function handleSignupBackdrop(e) { /* auth modal removed */ }
function showSignupModal(file) {
  const mb = file ? (file.size / (1024 * 1024)).toFixed(1) : '?';
  const name = file ? file.name : 'This file';
  // Show a non-blocking banner — auth modal removed, just inform user of size limit
  let banner = document.getElementById('size-limit-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'size-limit-banner';
    banner.style.cssText = [
      'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:9999',
      'background:#fff;border:1.5px solid #fecaca;border-left:4px solid #ef4444',
      'border-radius:10px;padding:14px 18px;max-width:430px;width:calc(100% - 32px)',
      'box-shadow:0 4px 20px rgba(0,0,0,.12);font-size:.88rem;color:#0f172a',
      'display:flex;gap:12px;align-items:flex-start'
    ].join(';');
    banner.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           style="flex-shrink:0;margin-top:1px">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div>
        <div style="font-weight:700;margin-bottom:3px">${window.t ? window.t('modal.file_too_large') : 'File too large'}</div>
        <div id="size-limit-msg"></div>
      </div>`;
    document.body.appendChild(banner);
  }
  const msgEl = banner.querySelector('#size-limit-msg');
  if (msgEl) msgEl.textContent = `"${name}" is ${mb} MB — the 100 MB limit applies. Please use a smaller file.`;
  banner.style.display = 'flex';
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => { banner.style.display = 'none'; }, 7000);
}
function closeSignupModal() { /* auth modal removed */ }

function showProcessing(title, msg) {
  const o = document.getElementById('processing-overlay');
  if (!o) return;
  if (title) document.getElementById('processing-title').textContent = title;
  if (msg)   document.getElementById('processing-msg').textContent = msg;
  o.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}
function hideProcessing() {
  const o = document.getElementById('processing-overlay');
  if (o) o.classList.add('hidden');
}

function acceptCookies() {
  localStorage.setItem('ilovepdf_cookies', '1');
  document.getElementById('cookie-banner').classList.add('hidden');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeComingSoonModal();
    closeSignupModal();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('ilovepdf_cookies')) {
    const b = document.getElementById('cookie-banner');
    if (b) b.classList.add('hidden');
  }

  const menuToggle = document.getElementById('menu-toggle');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      if (overlay) overlay.classList.toggle('hidden');
    });
  }
  if (overlay && sidebar) {
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.add('hidden');
    });
  }
});

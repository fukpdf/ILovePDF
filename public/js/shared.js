// Shared helpers: modals, sidebar toggle, cookies, signup-required flow, processing overlay.

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

function handleModalBackdropClick(e) { if (e.target === e.currentTarget) closeComingSoonModal(); }
function closeComingSoonModal() {
  const m = document.getElementById('coming-soon-modal');
  if (m) m.classList.add('hidden');
  document.body.style.overflow = '';
}

function handleSignupBackdrop(e) { if (e.target === e.currentTarget) closeSignupModal(); }
function showSignupModal(file) {
  const m = document.getElementById('signup-modal');
  const info = document.getElementById('signup-file-info');
  if (info && file) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    info.textContent = `"${file.name}" is ${mb} MB — exceeds the 100 MB free limit.`;
  }
  if (m) { m.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
}
function closeSignupModal() {
  const m = document.getElementById('signup-modal');
  if (m) m.classList.add('hidden');
  document.body.style.overflow = '';
}

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

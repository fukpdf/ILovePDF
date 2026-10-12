// Blog listing page — live search + category tab filter, plus hero CTA
// upgrade and image lazy-loading (mirrors blog-article.js).
(function () {
  // Promote the listing hero with a CTA button pointing at the tools grid.
  function upgradeListingHero() {
    const hero = document.querySelector('.blog-listing-hero');
    if (!hero || hero.querySelector('.blog-hero-cta-row')) return;
    const ctaRow = document.createElement('div');
    ctaRow.className = 'blog-hero-cta-row';
    ctaRow.style.justifyContent = 'center';
    ctaRow.innerHTML = `
      <a href="/#tools-root" class="blog-hero-cta">
        <i data-lucide="grid"></i> Explore all 35 tools
      </a>
      <span class="blog-hero-cta-meta">Free · No signup · Files auto-deleted</span>
    `;
    hero.appendChild(ctaRow);
    if (window.lucide) {
      try { lucide.createIcons(); } catch (_) {}
    }
  }

  function lazyImages() {
    document.querySelectorAll('main img').forEach((img) => {
      if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    upgradeListingHero();
    lazyImages();
  });

  const grid     = document.getElementById('blog-all-grid');
  const input    = document.getElementById('blog-search-input');
  const empty    = document.getElementById('blog-empty');
  const tabsBar  = document.querySelector('.blog-tabs');
  if (!grid) return;

  const cards = Array.from(grid.querySelectorAll('.blog-card-v2'));
  let activeTab = 'all';
  let query     = '';

  function apply() {
    let visible = 0;
    const q = query.trim().toLowerCase();
    cards.forEach((card) => {
      const cats   = (card.getAttribute('data-cat') || '').split(/\s+/);
      const search = card.getAttribute('data-search') || '';
      const okCat  = activeTab === 'all' || cats.includes(activeTab);
      const okQ    = !q || search.indexOf(q) !== -1;
      const show   = okCat && okQ;
      card.hidden  = !show;
      if (show) visible++;
    });
    if (empty) empty.hidden = visible !== 0;
  }

  if (input) {
    input.addEventListener('input', () => { query = input.value; apply(); });
  }
  if (tabsBar) {
    tabsBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.blog-tab');
      if (!btn) return;
      tabsBar.querySelectorAll('.blog-tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      activeTab = btn.getAttribute('data-tab') || 'all';
      apply();
    });
  }

  apply();
})();

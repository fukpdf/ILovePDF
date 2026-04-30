// Blog listing page — live search + category tab filter.
// All cards are present in the DOM; we only toggle visibility, no fetches.
(function () {
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

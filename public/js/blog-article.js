// Blog article page — reading progress bar + TOC active highlight.
// No-deps, runs on every /blog/<slug>.html page.
(function () {
  const bar = document.getElementById('blog-progress');
  const fill = bar ? bar.firstElementChild : null;

  function onScroll() {
    if (!fill) return;
    const doc = document.documentElement;
    const total = (doc.scrollHeight - window.innerHeight) || 1;
    const pct = Math.max(0, Math.min(100, (window.scrollY / total) * 100));
    fill.style.width = pct + '%';
  }

  // TOC active-section highlight (intersection-observer based; cheap).
  function bindToc() {
    const toc = document.querySelector('.blog-toc');
    if (!toc) return;
    const links = Array.from(toc.querySelectorAll('a[href^="#"]'));
    const targets = links
      .map((a) => document.getElementById(a.getAttribute('href').slice(1)))
      .filter(Boolean);
    if (!targets.length) return;

    const linkBy = new Map(targets.map((t, i) => [t.id, links[i]]));

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          const link = linkBy.get(e.target.id);
          if (!link) return;
          if (e.isIntersecting) {
            links.forEach((l) => l.classList.remove('is-active'));
            link.classList.add('is-active');
          }
        });
      },
      { rootMargin: '-30% 0px -60% 0px', threshold: 0 },
    );
    targets.forEach((t) => io.observe(t));
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('DOMContentLoaded', () => {
    onScroll();
    bindToc();
  });
})();

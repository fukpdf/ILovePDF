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

  // ───── "Was this guide helpful?" widget ─────
  // Stores votes in localStorage (one per blog slug). If FEEDBACK_FORMSPREE_ID
  // is set on window, also POSTs the vote to Formspree as a fire-and-forget.
  function bindFeedback() {
    const widget = document.querySelector('.blog-feedback');
    if (!widget) return;
    const slug = widget.getAttribute('data-feedback-slug') || location.pathname;
    const key  = 'blogFeedback:' + slug;
    const btns = Array.from(widget.querySelectorAll('.fb-btn'));
    const msg  = widget.querySelector('.blog-feedback-msg');
    if (!btns.length || !msg) return;

    // Already voted? Restore the visual state.
    let prior = null;
    try { prior = localStorage.getItem(key); } catch (_) {}
    if (prior === 'yes' || prior === 'no') {
      btns.forEach((b) => {
        b.disabled = true;
        if (b.dataset.vote === prior) b.classList.add('is-selected');
      });
      msg.textContent = 'Thanks for your feedback!';
      msg.classList.add('is-shown');
      return;
    }

    btns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const vote = btn.dataset.vote;
        btns.forEach((b) => { b.disabled = true; });
        btn.classList.add('is-selected');
        try { localStorage.setItem(key, vote); } catch (_) {}
        msg.textContent = 'Thanks for your feedback!';
        msg.classList.add('is-shown');

        // Optional: fire-and-forget POST to Formspree.
        const id = window.FEEDBACK_FORMSPREE_ID;
        if (id && typeof id === 'string' && id.indexOf('YOUR_') !== 0) {
          const fd = new FormData();
          fd.append('page', location.pathname);
          fd.append('slug', slug);
          fd.append('vote', vote);
          fd.append('timestamp', new Date().toISOString());
          fd.append('_subject', 'Blog feedback (' + vote + '): ' + slug);
          // Keep it cheap, ignore failures — vote is already saved locally.
          try {
            fetch('https://formspree.io/f/' + id, {
              method:  'POST',
              headers: { 'Accept': 'application/json' },
              body:    fd,
              keepalive: true,
            }).catch(function(){});
          } catch (_) {}
        }
      });
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('DOMContentLoaded', () => {
    onScroll();
    bindToc();
    bindFeedback();
  });
})();

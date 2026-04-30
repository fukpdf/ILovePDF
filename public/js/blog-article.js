// Blog article page — reading progress bar + TOC active highlight + UX upgrade.
// No-deps, runs on every /blog/<slug>.html page.
//
// Phase 1-6 additions (2026-04):
//   - Promote .blog-article-header to a hero (subtitle + CTA) without
//     touching the underlying HTML / SEO meta.
//   - Inject a "Key benefits" card after the article intro.
//   - Auto-add loading="lazy" + decoding="async" to article images.
//   - Show a sticky bottom CTA once the user scrolls past the hero.
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

  // ─── Derive the related tool slug from the article URL ────────────────
  // /blog/merge-pdf-guide.html → merge-pdf
  // /blog/compress-pdf-guide.html → compress-pdf
  // Fallback: first existing in-article link to a tool path.
  function deriveToolSlug() {
    const m = location.pathname.match(/\/blog\/([a-z0-9-]+?)(?:-guide)?\.html$/i);
    if (m && m[1] && m[1] !== 'index') return m[1];
    // Fallback: first link in the article body that points to a tool root path.
    const a = document.querySelector('.blog-article-body a[href^="/"]:not([href*="/blog"])');
    if (a) {
      const path = (a.getAttribute('href') || '').split(/[?#]/)[0];
      const seg = path.replace(/^\/+|\/+$/g, '');
      if (seg && !seg.startsWith('blog')) return seg;
    }
    return null;
  }

  function prettyToolName(slug) {
    return slug
      .split('-')
      .map((p) => {
        if (/^pdf$|^jpg$|^png$|^pptx?$|^docx?$|^xlsx?$|^html$|^ocr$/i.test(p)) {
          return p.toUpperCase();
        }
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join(' ');
  }

  // Pull a usable subtitle from the very first paragraph of the article body.
  // Trim to ~180 chars so it stays one short paragraph.
  function deriveSubtitle() {
    const firstP = document.querySelector('.blog-article-body > p');
    if (!firstP) return null;
    const text = (firstP.textContent || '').trim();
    if (text.length < 40) return null;
    if (text.length <= 200) return text;
    return text.slice(0, 197).replace(/[\s,;.]+\S*$/, '') + '…';
  }

  // Promote .blog-article-header into a hero: add subtitle + CTA button.
  function buildHero() {
    const header = document.querySelector('.blog-article-header');
    if (!header || header.classList.contains('blog-article-hero')) return null;
    const slug = deriveToolSlug();
    if (!slug) return null;

    header.classList.add('blog-article-hero');

    // Subtitle from intro paragraph
    const sub = deriveSubtitle();
    if (sub) {
      const subEl = document.createElement('p');
      subEl.className = 'blog-hero-sub';
      subEl.textContent = sub;
      // Insert after H1 if present, else at end (before trust strip).
      const h1 = header.querySelector('h1');
      const trust = header.querySelector('.blog-trust-strip');
      if (h1 && h1.nextSibling) {
        header.insertBefore(subEl, h1.nextSibling);
      } else if (trust) {
        header.insertBefore(subEl, trust);
      } else {
        header.appendChild(subEl);
      }
    }

    // CTA row
    const ctaRow = document.createElement('div');
    ctaRow.className = 'blog-hero-cta-row';
    ctaRow.innerHTML = `
      <a href="/${slug}" class="blog-hero-cta" data-blog-cta="hero">
        <i data-lucide="arrow-right-circle"></i> Open ${prettyToolName(slug)}
      </a>
      <span class="blog-hero-cta-meta">Free · No signup · Files auto-deleted</span>
    `;
    const trust = header.querySelector('.blog-trust-strip');
    if (trust) header.insertBefore(ctaRow, trust);
    else header.appendChild(ctaRow);

    return slug;
  }

  // Inject a "Key benefits" highlight card right after the intro paragraph.
  function buildKeyBenefits() {
    const body = document.querySelector('.blog-article-body');
    if (!body || body.querySelector('.blog-key-benefits')) return;
    // Anchor: insert after the SECOND <p> if available (so the intro reads
    // naturally), else after the first.
    const paras = body.querySelectorAll(':scope > p');
    const anchor = paras[1] || paras[0];
    if (!anchor) return;

    const benefits = [
      { icon: 'zap',          title: 'Fast in your browser',    desc: 'Most files are processed instantly — no waiting in a queue.' },
      { icon: 'shield-check', title: 'Private & secure',         desc: 'Files never leave your device for browser-side tools, and uploads are deleted within minutes.' },
      { icon: 'sparkles',     title: 'Free, no signup',          desc: 'No account required for files under 100 MB. Use as often as you need.' },
    ];

    const card = document.createElement('div');
    card.className = 'blog-key-benefits';
    card.setAttribute('aria-label', 'Key benefits');
    card.innerHTML = benefits.map((b) => `
      <div class="blog-key-benefit">
        <span class="blog-key-benefit-icon"><i data-lucide="${b.icon}"></i></span>
        <p class="blog-key-benefit-title">${b.title}</p>
        <p class="blog-key-benefit-desc">${b.desc}</p>
      </div>
    `).join('');
    anchor.insertAdjacentElement('afterend', card);
  }

  // Defensive: lazy-load any in-article images that don't already have it.
  function lazyLoadImages() {
    document.querySelectorAll('.blog-article-body img, .blog-listing-page img').forEach((img) => {
      if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
    });
  }

  // Sticky bottom CTA — appears once the hero scrolls out of view.
  function bindStickyCta(slug) {
    if (!slug) return;
    // Respect a per-slug dismissal in this session.
    const dismissKey = 'blogStickyDismissed:' + slug;
    try { if (sessionStorage.getItem(dismissKey)) return; } catch (_) {}

    const hero = document.querySelector('.blog-article-header');
    if (!hero) return;

    const cta = document.createElement('a');
    cta.href = '/' + slug;
    cta.className = 'blog-sticky-cta';
    cta.setAttribute('data-blog-cta', 'sticky');
    cta.innerHTML = `
      <i data-lucide="arrow-right-circle"></i>
      <span>Open ${prettyToolName(slug)}</span>
      <button type="button" class="blog-sticky-cta-close" aria-label="Dismiss">×</button>
    `;
    document.body.appendChild(cta);
    if (window.lucide) lucide.createIcons();

    cta.querySelector('.blog-sticky-cta-close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cta.classList.remove('is-visible');
      try { sessionStorage.setItem(dismissKey, '1'); } catch (_) {}
      setTimeout(() => cta.remove(), 400);
    });

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) cta.classList.remove('is-visible');
        else cta.classList.add('is-visible');
      });
    }, { rootMargin: '0px 0px -100px 0px', threshold: 0 });
    io.observe(hero);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('DOMContentLoaded', () => {
    onScroll();
    bindToc();
    bindFeedback();
    const slug = buildHero();
    buildKeyBenefits();
    lazyLoadImages();
    // Re-paint Lucide icons we just injected.
    if (window.lucide) {
      try { lucide.createIcons(); } catch (_) {}
    }
    bindStickyCta(slug);
  });
})();

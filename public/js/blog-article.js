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

  // Per-tool emotional hook (eyebrow line above the H1) and benefit-focused
  // subtitle. Keyed by the slug derived from the article URL. Anything not
  // in the map falls back to a generic hook + the first-paragraph derivation.
  const HOOK_MAP = {
    'merge-pdf':         'Working with multiple PDFs?',
    'split-pdf':         'Need just a few pages from a long PDF?',
    'compress-pdf':      'Struggling with large PDF files?',
    'rotate-pdf':        'Pages turned the wrong way?',
    'crop-pdf':          'Annoying margins on your PDF?',
    'organize-pdf':      'Pages out of order?',
    'add-page-numbers':  'Long PDF with no page numbers?',
    'watermark-pdf':     'Need to brand or protect your PDFs?',
    'protect-pdf':       'Sharing sensitive documents?',
    'unlock-pdf':        'Locked out of your own PDF?',
    'jpg-to-pdf':        'Got images you need as a PDF?',
    'png-to-pdf':        'Got images you need as a PDF?',
    'pdf-to-jpg':        'Need PDF pages as images?',
    'pdf-to-word':       'Need to edit a PDF in Word?',
    'pdf-to-powerpoint': 'Need PDF content in slides?',
    'pdf-to-excel':      'Tables stuck inside a PDF?',
    'word-to-pdf':       'Need a polished PDF from Word?',
    'powerpoint-to-pdf': 'Sharing slides that need to look perfect?',
    'excel-to-pdf':      'Sharing spreadsheets without losing formatting?',
    'html-to-pdf':       'Need to save a webpage as a PDF?',
    'ocr-pdf':           'Text trapped inside scanned pages?',
    'scan-pdf':          'Need to scan a document on the go?',
    'repair-pdf':        "PDF won't open or looks broken?",
    'compare-pdf':       'Need to spot changes between two versions?',
    'ai-summarizer':     'PDF too long to read?',
    'translate-pdf':     'PDF in the wrong language?',
    'workflow-builder':  'Tired of running tools one by one?',
    'background-remover':'Need a clean cutout from your photo?',
    'crop-image':        'Need just part of an image?',
    'resize-image':      'Image too big or wrong dimensions?',
    'image-filters':     'Want to enhance your photos quickly?',
  };

  const SUBTITLE_MAP = {
    'merge-pdf':         'Combine PDFs instantly without losing quality — no signup required.',
    'split-pdf':         'Pull out exactly the pages you need in seconds — right in your browser.',
    'compress-pdf':      'Shrink PDFs up to 70% smaller while keeping crisp quality — no upload needed.',
    'rotate-pdf':        'Fix every page orientation in one click and download in seconds.',
    'crop-pdf':          'Trim margins and tighten layouts visually — no software install.',
    'organize-pdf':      'Reorder, duplicate or delete pages with a simple drag-and-drop.',
    'add-page-numbers':  'Add clean, customisable page numbers in seconds — choose position and style.',
    'watermark-pdf':     'Stamp text or image watermarks across every page with full control.',
    'protect-pdf':       'Add strong password protection right in your browser — your file never leaves your device.',
    'unlock-pdf':        'Remove PDF passwords you own and regain full access — instantly and securely.',
    'jpg-to-pdf':        'Combine images into one polished PDF with adjustable size and orientation.',
    'png-to-pdf':        'Turn PNGs into a single sharable PDF in seconds — no uploads.',
    'pdf-to-jpg':        'Export every page as a high-quality image for slides, web or social.',
    'pdf-to-word':       'Convert PDFs to fully editable .docx with layout intact.',
    'pdf-to-powerpoint': 'Turn PDFs into editable .pptx slides ready to present.',
    'pdf-to-excel':      'Pull tables out of any PDF straight into a clean .xlsx spreadsheet.',
    'word-to-pdf':       'Turn Word docs into pixel-perfect PDFs ready to share or print.',
    'powerpoint-to-pdf': 'Lock your slides into a portable PDF that looks the same everywhere.',
    'excel-to-pdf':      'Convert spreadsheets to crisp PDFs with formulas frozen in place.',
    'html-to-pdf':       'Capture any webpage as a clean, paginated PDF.',
    'ocr-pdf':           'Make scanned PDFs fully searchable with on-device-grade OCR — fast and accurate.',
    'scan-pdf':          'Turn phone photos into clean, searchable PDF scans.',
    'repair-pdf':        'Recover content from broken or partially corrupted PDFs in seconds.',
    'compare-pdf':       'Highlight every difference between two PDF versions — side by side.',
    'ai-summarizer':     'Get the key points from any PDF in seconds — powered by AI.',
    'translate-pdf':     'Translate entire PDFs into 100+ languages while keeping the layout.',
    'workflow-builder':  'Chain multiple PDF tools into one repeatable workflow — set it once, run it forever.',
    'background-remover':'Get a clean transparent cutout from any photo in one click.',
    'crop-image':        'Trim images precisely with a visual crop — perfect for thumbnails and avatars.',
    'resize-image':      'Resize images to exact dimensions without losing sharpness.',
    'image-filters':     'Apply pro-grade filters and adjustments to any photo in your browser.',
  };

  // Whether the tool is browser-only (no upload). Used to show "Works in browser"
  // checkmark; defaults true for any slug we know about.
  const ADVANCED_SLUGS = new Set([
    'pdf-to-word','pdf-to-powerpoint','pdf-to-excel',
    'word-to-pdf','powerpoint-to-pdf','excel-to-pdf','html-to-pdf',
    'ocr-pdf','scan-pdf','repair-pdf','compare-pdf',
    'ai-summarizer','translate-pdf','workflow-builder','background-remover',
    'edit-pdf','sign-pdf','redact-pdf',
  ]);

  function genericHook(slug) {
    if (!slug) return 'Need to handle PDFs the easy way?';
    if (slug.startsWith('pdf-to-') || slug.endsWith('-to-pdf')) return 'Need to convert your file to a different format?';
    if (slug.includes('image')) return 'Working with images?';
    return 'Need a quick fix for your PDF?';
  }

  // Pull a usable subtitle from the very first paragraph of the article body.
  // Trim to ~180 chars so it stays one short paragraph. Used as a fallback
  // when SUBTITLE_MAP doesn't have an entry for the current tool.
  function deriveSubtitle() {
    const firstP = document.querySelector('.blog-article-body > p');
    if (!firstP) return null;
    const text = (firstP.textContent || '').trim();
    if (text.length < 40) return null;
    if (text.length <= 200) return text;
    return text.slice(0, 197).replace(/[\s,;.]+\S*$/, '') + '…';
  }

  // Promote .blog-article-header into a hero: emotional hook + benefit subtitle
  // + CTA button + checkmark trust indicators.
  function buildHero() {
    const header = document.querySelector('.blog-article-header');
    if (!header || header.classList.contains('blog-article-hero')) return null;
    const slug = deriveToolSlug();
    if (!slug) return null;

    header.classList.add('blog-article-hero');
    const h1 = header.querySelector('h1');

    // ── 1. Emotional hook (eyebrow above H1) ──────────────────────────────
    if (h1 && !header.querySelector('.blog-hero-hook')) {
      const hookText = HOOK_MAP[slug] || genericHook(slug);
      const hookEl = document.createElement('p');
      hookEl.className = 'blog-hero-hook';
      hookEl.textContent = hookText;
      header.insertBefore(hookEl, h1);
    }

    // ── 2. Benefit-focused subtitle (right after H1) ──────────────────────
    const subText = SUBTITLE_MAP[slug] || deriveSubtitle();
    if (subText) {
      const subEl = document.createElement('p');
      subEl.className = 'blog-hero-sub';
      subEl.textContent = subText;
      const trust = header.querySelector('.blog-trust-strip');
      if (h1 && h1.nextSibling) {
        header.insertBefore(subEl, h1.nextSibling);
      } else if (trust) {
        header.insertBefore(subEl, trust);
      } else {
        header.appendChild(subEl);
      }
    }

    // ── 3. CTA + checkmark trust indicators ───────────────────────────────
    const inBrowser = !ADVANCED_SLUGS.has(slug);
    const ctaRow = document.createElement('div');
    ctaRow.className = 'blog-hero-cta-row';
    ctaRow.innerHTML = `
      <a href="/${slug}" class="blog-hero-cta" data-blog-cta="hero">
        <i data-lucide="arrow-right-circle"></i> Open ${prettyToolName(slug)}
      </a>
    `;
    const trustList = document.createElement('ul');
    trustList.className = 'blog-hero-checks';
    trustList.setAttribute('aria-label', 'What you get');
    trustList.innerHTML = `
      <li><span class="blog-hero-check">✔</span> No signup</li>
      <li><span class="blog-hero-check">✔</span> 100% free</li>
      <li><span class="blog-hero-check">✔</span> ${inBrowser ? 'Works in browser' : 'Files auto-deleted'}</li>
    `;
    const trust = header.querySelector('.blog-trust-strip');
    if (trust) {
      header.insertBefore(ctaRow, trust);
      header.insertBefore(trustList, trust);
    } else {
      header.appendChild(ctaRow);
      header.appendChild(trustList);
    }

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

// scripts/generate-blog-listing.js
// Builds public/blog.html — featured top-3 + live search + category tabs +
// every blog card rendered (filtered client-side). All 35 blogs are
// indexed once; tabs/search just toggle visibility — no SPA rebuild.
//
// Usage: node scripts/generate-blog-listing.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BLOGS } from './blog-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OUT = path.join(__dirname, '..', 'public', 'blog.html');

// User-facing category buckets. The first is "All" (no filter).
// Each key maps to the blog-data.js `category` values it should show.
const TABS = [
  { id: 'all',       label: 'All',         match: () => true },
  { id: 'organize',  label: 'Organize',    match: (c) => c === 'Organize PDFs' },
  { id: 'convert',   label: 'Convert',     match: (c) => c === 'Convert From PDF' || c === 'Convert To PDF' },
  { id: 'compress',  label: 'Compress',    match: (c) => c === 'Compress & Optimize' },
  { id: 'edit',      label: 'Edit',        match: (c) => c === 'Edit & Annotate' },
  { id: 'security',  label: 'Security',    match: (c) => c === 'Security' },
  { id: 'ai',        label: 'AI Tools',    match: (c) => c === 'Advanced Tools' },
  { id: 'image',     label: 'Image Tools', match: (c) => c === 'Image Tools' },
];

// Featured top 3 blogs.
const FEATURED_SLUGS = ['merge-pdf-guide', 'compress-pdf-guide', 'pdf-to-word-guide'];

function escAttr(s){
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function tabIdFor(category) {
  for (const t of TABS) {
    if (t.id === 'all') continue;
    if (t.match(category)) return t.id;
  }
  return 'all';
}

function listingTitle(b){
  if (b.title.length <= 75) return b.title;
  return `${b.toolName}: complete guide`;
}

// All cards in one flat grid; data-* attributes power filter/search.
function renderCard(b){
  const tabs = TABS.filter(t => t.id !== 'all' && t.match(b.category)).map(t => t.id).join(' ');
  const haystack = `${b.title} ${b.description} ${b.toolName} ${b.tag} ${b.category}`.toLowerCase();
  return `      <a href="/blog/${b.slug}.html" class="blog-card-v2" data-cat="${tabs}" data-search="${escAttr(haystack)}">
        <span class="blog-tag"><i data-lucide="${b.icon}" style="width:11px;height:11px;vertical-align:middle;margin-right:4px;"></i>${b.tag}</span>
        <h2>${escAttr(listingTitle(b))}</h2>
        <p>${escAttr(b.description)}</p>
        <span class="blog-read">Read article <i data-lucide="arrow-right"></i></span>
      </a>`;
}

const allCardsHtml = BLOGS.map(renderCard).join('\n');

const featured = FEATURED_SLUGS
  .map(s => BLOGS.find(b => b.slug === s))
  .filter(Boolean)
  .slice(0, 3);
const featuredHtml = featured.map(b => `      <a href="/blog/${b.slug}.html" class="blog-feature-card">
        <span class="blog-feature-tag"><i data-lucide="${b.icon}" style="width:12px;height:12px;vertical-align:middle;margin-right:5px;"></i>Featured · ${escAttr(b.tag)}</span>
        <h3>${escAttr(listingTitle(b))}</h3>
        <p>${escAttr(b.description)}</p>
        <span class="blog-feature-read">Read article <i data-lucide="arrow-right"></i></span>
      </a>`).join('\n');

const tabsHtml = TABS.map((t, i) => `        <button type="button" class="blog-tab${i===0?' is-active':''}" data-tab="${t.id}">${t.label}</button>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ILovePDF Blog — PDF Tips, Guides &amp; Tutorials for ${BLOGS.length} Tools</title>
  <meta name="description" content="The ILovePDF blog: complete tutorials and guides for every free PDF and image tool — merge, split, compress, convert, sign, OCR, AI summarise and more.">
  <meta name="keywords" content="pdf guide, pdf tutorial, merge pdf, compress pdf, convert pdf, sign pdf, ocr pdf, ai pdf summary, free pdf tools, pdf blog">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://ilovepdf.cyou/blog.html">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="/favicon.svg">
  <link rel="apple-touch-icon" href="/favicon.svg">
  <meta name="theme-color" content="#4f46e5">
  <meta property="og:type"        content="website">
  <meta property="og:title"       content="ILovePDF Blog — Guides for ${BLOGS.length} PDF &amp; Image Tools">
  <meta property="og:description" content="Step-by-step tutorials for every free ILovePDF tool. No signup, no install, no watermark.">
  <meta property="og:url"         content="https://ilovepdf.cyou/blog.html">
  <meta property="og:site_name"   content="ILovePDF">
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://ilovepdf.cyou/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://ilovepdf.cyou/blog.html' },
    ],
  })}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/home.css">
  <link rel="stylesheet" href="/css/blog.css">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3242156405919556" crossorigin="anonymous"></script>
</head>
<body>

  <header class="site-header">
    <div class="header-inner">
      <a href="/" class="brand" aria-label="ILovePDF home">
        <span class="brand-mark"><i data-lucide="file-text"></i></span>
        <span class="brand-name">ILove<span>PDF</span></span>
      </a>
      <nav class="nav" id="nav" aria-label="Main"></nav>
    </div>
  </header>

  <!-- Top banner ad slot -->
  <div class="ad-slot ad-slot-top" aria-label="Advertisement"></div>

  <main class="blog-listing-page">

    <section class="blog-listing-hero">
      <span class="blog-eyebrow"><i data-lucide="book-open" style="width:13px;height:13px;vertical-align:middle;margin-right:5px;"></i> Blog</span>
      <h1>PDF Tips, Tutorials &amp; Tool Guides</h1>
      <p>Step-by-step guides for every free ILovePDF tool — ${BLOGS.length} articles covering merging, compressing, converting, editing, OCR, AI summarisation, image work and more.</p>
    </section>

    <!-- Featured -->
    <section class="blog-featured" aria-label="Featured guides">
      <div class="blog-section-head">
        <h2><i data-lucide="star" style="width:16px;height:16px;vertical-align:middle;margin-right:5px;"></i> Featured guides</h2>
      </div>
      <div class="blog-feature-grid">
${featuredHtml}
      </div>
    </section>

    <!-- Search + Tabs -->
    <section class="blog-filter-bar" aria-label="Filter articles">
      <div class="blog-search">
        <i data-lucide="search"></i>
        <input type="search" id="blog-search-input" placeholder="Search ${BLOGS.length} guides…" aria-label="Search guides">
      </div>
      <div class="blog-tabs" role="tablist" aria-label="Categories">
${tabsHtml}
      </div>
    </section>

    <!-- All -->
    <section class="blog-grid" id="blog-all-grid" aria-label="All articles">
${allCardsHtml}
    </section>

    <p class="blog-empty" id="blog-empty" hidden>No articles match your search. Try a different keyword or category.</p>

  </main>

  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-col footer-brand">
        <a href="/" class="brand" aria-label="ILovePDF home">
          <span class="brand-mark"><i data-lucide="file-text"></i></span>
          <span class="brand-name">ILove<span>PDF</span></span>
        </a>
        <p>Free PDF &amp; Image tools online. Files are deleted automatically after processing &mdash; your privacy comes first.</p>
      </div>
      <div class="footer-col">
        <h4>Product</h4>
        <a href="/#tools-root">All Tools</a>
        <a href="/merge-pdf">Merge PDF</a>
        <a href="/compress-pdf">Compress</a>
        <a href="/pdf-to-word">PDF to Word</a>
        <a href="/numbers-to-words">Numbers to Words</a>
        <a href="/currency-converter">Currency Converter</a>
      </div>
      <div class="footer-col">
        <h4>Company</h4>
        <a href="/about">About</a>
        <a href="/about#contact">Contact</a>
        <a href="/blog.html">Blog</a>
      </div>
      <div class="footer-col">
        <h4>Legal</h4>
        <a href="/privacy.html">Privacy</a>
        <a href="/terms.html">Terms</a>
        <a href="/disclaimer.html">Disclaimer</a>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; 2026 ILovePDF &mdash; All rights reserved.</span>
      <span>Files are deleted automatically within seconds.</span>
    </div>
  </footer>

  <script src="/js/config.js" defer></script>
  <script src="https://unpkg.com/lucide@latest" defer></script>
  <script type="module" src="/js/firebase-init.js"></script>
  <script src="/js/chrome.js" defer></script>
  <script src="/js/auth-ui.js" defer></script>
  <script src="/js/blog-listing.js" defer></script>
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(`✅ Wrote ${OUT} (${BLOGS.length} blogs · ${TABS.length - 1} category tabs · ${featured.length} featured)`);

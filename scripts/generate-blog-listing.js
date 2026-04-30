// scripts/generate-blog-listing.js
// Builds public/blog.html — a listing page that groups all 35 blog cards
// by category, using the new design system (home.css + chrome.js).
//
// Usage: node scripts/generate-blog-listing.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BLOGS } from './blog-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OUT = path.join(__dirname, '..', 'public', 'blog.html');

// Category display order on the listing page.
const CATEGORY_ORDER = [
  'Organize PDFs',
  'Compress & Optimize',
  'Convert From PDF',
  'Convert To PDF',
  'Edit & Annotate',
  'Security',
  'Advanced Tools',
  'Image Tools',
];

function escAttr(s){
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Group blogs by category preserving CATEGORY_ORDER.
const byCategory = {};
for (const cat of CATEGORY_ORDER) byCategory[cat] = [];
for (const b of BLOGS) {
  if (!byCategory[b.category]) byCategory[b.category] = [];
  byCategory[b.category].push(b);
}

// Short hook headline & blurb per blog used on the listing card.
function listingTitle(b){
  // Use the article H1 if it's reasonably short, else fall back to a tool-name title.
  if (b.title.length <= 75) return b.title;
  return `${b.toolName}: complete guide`;
}
function listingBlurb(b){
  return b.description;
}

function renderCategorySection(cat){
  const blogs = byCategory[cat];
  if (!blogs || !blogs.length) return '';
  const cards = blogs.map(b => `      <a href="/blog/${b.slug}.html" class="blog-card-v2">
        <span class="blog-tag">${b.tag}</span>
        <h2>${escAttr(listingTitle(b))}</h2>
        <p>${escAttr(listingBlurb(b))}</p>
        <span class="blog-read">Read article <i data-lucide="arrow-right"></i></span>
      </a>`).join('\n');
  return `    <h3 class="blog-category-label">${cat}</h3>
    <section class="blog-grid" aria-label="${cat} articles">
${cards}
    </section>`;
}

const sections = CATEGORY_ORDER.map(renderCategorySection).join('\n\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ILovePDF Blog — PDF Tips, Guides &amp; Tutorials for 35 Tools</title>
  <meta name="description" content="The ILovePDF blog: complete tutorials and guides for every free PDF and image tool — merge, split, compress, convert, sign, OCR, AI summarise and more.">
  <meta name="keywords" content="pdf guide, pdf tutorial, merge pdf, compress pdf, convert pdf, sign pdf, ocr pdf, ai pdf summary, free pdf tools, pdf blog">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://ilovepdf.cyou/blog.html">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="/favicon.svg">
  <link rel="apple-touch-icon" href="/favicon.svg">
  <meta name="theme-color" content="#4f46e5">
  <meta property="og:type"        content="website">
  <meta property="og:title"       content="ILovePDF Blog — Guides for 35 PDF &amp; Image Tools">
  <meta property="og:description" content="Step-by-step tutorials for every free ILovePDF tool. No signup, no install, no watermark.">
  <meta property="og:url"         content="https://ilovepdf.cyou/blog.html">
  <meta property="og:site_name"   content="ILovePDF">
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

  <main class="blog-listing-page">
    <section class="blog-listing-hero">
      <span class="blog-eyebrow"><i data-lucide="book-open" style="width:13px;height:13px;vertical-align:middle;margin-right:5px;"></i> Blog</span>
      <h1>PDF Tips, Tutorials &amp; Tool Guides</h1>
      <p>Step-by-step guides for every free ILovePDF tool — ${BLOGS.length} articles covering merging, compressing, converting, editing, OCR, AI summarisation, image work and more.</p>
    </section>

${sections}
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
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(`✅ Wrote ${OUT} (${BLOGS.length} blogs in ${CATEGORY_ORDER.length} categories)`);

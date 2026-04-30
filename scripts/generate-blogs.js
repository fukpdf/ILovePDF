// scripts/generate-blogs.js
// Generates one HTML file per blog entry into public/blog/<slug>.html.
// Uses the new design system (home.css + blog.css + chrome.js header).
//
// Usage: node scripts/generate-blogs.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BLOGS } from './blog-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SITE = 'https://ilovepdf.cyou';
const OUT_DIR = path.join(__dirname, '..', 'public', 'blog');
const TODAY = new Date().toISOString().slice(0, 10);

// Build a quick lookup so the related-articles block can show titles.
const BY_SLUG = Object.fromEntries(BLOGS.map(b => [b.slug, b]));

// Popular tools featured on every blog.
const POPULAR_TOOLS = [
  { slug: '/merge-pdf',         name: 'Merge PDF',         icon: 'layers'      },
  { slug: '/split-pdf',         name: 'Split PDF',         icon: 'scissors'    },
  { slug: '/compress-pdf',      name: 'Compress PDF',      icon: 'archive'     },
  { slug: '/pdf-to-word',       name: 'PDF to Word',       icon: 'file-text'   },
  { slug: '/pdf-to-jpg',        name: 'PDF to JPG',        icon: 'image'       },
  { slug: '/jpg-to-pdf',        name: 'JPG to PDF',        icon: 'image'       },
  { slug: '/protect-pdf',       name: 'Protect PDF',       icon: 'lock'        },
  { slug: '/ai-summarizer',     name: 'AI Summarizer',     icon: 'sparkles'    },
  { slug: '/background-remover',name: 'Background Remover',icon: 'image-minus' },
];

function escAttr(s){
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderSteps(steps){
  return `<ol>
${steps.map(s => `      <li><strong>${s.title}.</strong> ${s.body}</li>`).join('\n')}
    </ol>`;
}

function renderBenefits(benefits){
  return `<ul>
${benefits.map(b => `      <li><strong>${b.title}.</strong> ${b.body}</li>`).join('\n')}
    </ul>`;
}

function renderUseCases(useCases){
  return useCases.map(uc => `<h3>For ${uc.audience}</h3>
    <p>${uc.body}</p>`).join('\n    ');
}

function renderTips(tips){
  return tips.map((t, i) => `<h3>${i+1}. ${t.title}</h3>
    <p>${t.body}</p>`).join('\n    ');
}

function renderFaq(faq){
  return faq.map(f => `<h3>${f.q}</h3>
    <p>${f.a}</p>`).join('\n    ');
}

function renderRelated(related){
  const cards = related
    .map(slug => BY_SLUG[slug])
    .filter(Boolean)
    .slice(0, 5)
    .map(b => `<a href="/blog/${b.slug}.html" class="blog-related-card">
        <span class="rel-tag">${b.tag}</span>
        <span class="rel-title">${b.toolName} guide</span>
        <span class="rel-arrow">Read article →</span>
      </a>`).join('\n      ');
  return `<section class="blog-related" aria-label="Related articles">
      <h2>Related guides</h2>
      <div class="blog-related-grid">
      ${cards}
      </div>
    </section>`;
}

function renderPopularTools(currentToolSlug){
  const pills = POPULAR_TOOLS
    .filter(t => t.slug !== currentToolSlug)
    .slice(0, 8)
    .map(t => `<a href="${t.slug}" class="blog-tool-pill"><i data-lucide="${t.icon}"></i> ${t.name}</a>`).join('\n        ');
  return `<aside class="blog-popular-tools" aria-label="Popular tools">
      <h3>Popular ILovePDF tools</h3>
      <div class="blog-popular-tools-grid">
        ${pills}
      </div>
    </aside>`;
}

function renderJsonLd(b){
  const url = `${SITE}/blog/${b.slug}.html`;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: b.title,
    description: b.description,
    author:    { '@type': 'Organization', name: 'ILovePDF', url: SITE },
    publisher: { '@type': 'Organization', name: 'ILovePDF', url: SITE,
                 logo: { '@type': 'ImageObject', url: `${SITE}/favicon.svg` } },
    datePublished: '2026-01-01',
    dateModified: TODAY,
    mainEntityOfPage: url,
    image: `${SITE}/favicon.svg`,
  }, null, 2);
}

function renderHtml(b){
  const url = `${SITE}/blog/${b.slug}.html`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escAttr(b.title)} | ILovePDF</title>
  <meta name="description" content="${escAttr(b.description)}">
  <meta name="robots" content="index, follow">
  <meta name="author" content="ILovePDF">
  <link rel="canonical" href="${url}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="/favicon.svg">
  <link rel="apple-touch-icon" href="/favicon.svg">
  <meta name="theme-color" content="#4f46e5">
  <meta property="og:type"        content="article">
  <meta property="og:title"       content="${escAttr(b.title)}">
  <meta property="og:description" content="${escAttr(b.description)}">
  <meta property="og:url"         content="${url}">
  <meta property="og:site_name"   content="ILovePDF">
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${escAttr(b.title)}">
  <meta name="twitter:description" content="${escAttr(b.description)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/home.css">
  <link rel="stylesheet" href="/css/blog.css">
  <script type="application/ld+json">${renderJsonLd(b)}</script>
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

  <main class="blog-article-page">

    <nav class="blog-breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span class="bc-sep">/</span>
      <a href="/blog.html">Blog</a>
      <span class="bc-sep">/</span>
      <span>${b.toolName} guide</span>
    </nav>

    <header class="blog-article-header">
      <div class="blog-article-eyebrow">
        <span class="blog-article-tag"><i data-lucide="${b.icon}" style="width:13px;height:13px;vertical-align:middle;margin-right:5px;"></i> ${b.tag}</span>
        <span class="blog-article-meta">By ILovePDF · Updated ${TODAY} · ${b.category}</span>
      </div>
      <h1>${escAttr(b.title)}</h1>
    </header>

    <article class="blog-article-body">

      ${b.intro}

      <h2>Step-by-step: how to use ${escAttr(b.toolName)}</h2>
      ${renderSteps(b.steps)}

      <div class="blog-cta-box">
        <h3>Try ${escAttr(b.toolName)} now — free</h3>
        <p>No signup. No software. Just fast, secure ${escAttr(b.toolName.toLowerCase())} online.</p>
        <a href="${b.toolSlug}" class="blog-cta-btn">
          <i data-lucide="${b.icon}"></i> Open ${escAttr(b.toolName)}
        </a>
      </div>

      <h2>Why use ${escAttr(b.toolName)}?</h2>
      ${renderBenefits(b.benefits)}

      <h2>Common use cases</h2>
      ${renderUseCases(b.useCases)}

      <h2>Pro tips for the best results</h2>
      ${renderTips(b.tips)}

      <h2>Frequently asked questions</h2>
      ${renderFaq(b.faq)}

      <h2>Wrapping up</h2>
      <p>${escAttr(b.toolName)} is one of ${BLOGS.length}+ free tools in the ILovePDF suite — built for everyday document tasks that shouldn\'t require expensive software or a paid subscription. Files are processed securely in your browser, deleted within minutes, and never used to train models. Give it a spin: <a href="${b.toolSlug}">open ${escAttr(b.toolName)}</a> and see how fast it works.</p>

    </article>

    ${renderRelated(b.related)}

    ${renderPopularTools(b.toolSlug)}

  </main>

  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-col footer-brand">
        <a href="/" class="brand" aria-label="ILovePDF home">
          <span class="brand-mark"><i data-lucide="file-text"></i></span>
          <span class="brand-name">ILove<span>PDF</span></span>
        </a>
        <p>Free PDF &amp; Image tools online. Files are deleted automatically after processing — your privacy comes first.</p>
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
      <span>&copy; 2026 ILovePDF — All rights reserved.</span>
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
}

// ── Run ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
for (const b of BLOGS) {
  const out = path.join(OUT_DIR, `${b.slug}.html`);
  fs.writeFileSync(out, renderHtml(b), 'utf8');
  written++;
}

console.log(`✅ Generated ${written} blog files in ${OUT_DIR}`);
console.log(`   Sample: ${BLOGS.slice(0, 3).map(b => b.slug + '.html').join(', ')}, ...`);

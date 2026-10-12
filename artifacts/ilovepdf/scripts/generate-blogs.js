// scripts/generate-blogs.js
// Generates one HTML file per blog entry into public/blog/<slug>.html.
// Adds: TOC + sticky sidebar (desktop), reading-progress bar, mid + end CTAs,
// FAQ + Breadcrumb schema, related tools (5-7), related blogs (5-7),
// trust strip, "why choose" block, and ad-slot placeholders.
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

// Curated tool list. Each blog picks 7 related tools — the tool the post is
// about plus 6 contextually relevant siblings (same category first, then
// a few highest-traffic anchors).
const ALL_TOOLS = [
  { slug: '/merge-pdf',          name: 'Merge PDF',          icon: 'layers',        cat: 'Organize PDFs' },
  { slug: '/split-pdf',          name: 'Split PDF',          icon: 'scissors',      cat: 'Organize PDFs' },
  { slug: '/rotate-pdf',         name: 'Rotate PDF',         icon: 'rotate-cw',     cat: 'Organize PDFs' },
  { slug: '/organize-pdf',       name: 'Organize PDF',       icon: 'list-ordered',  cat: 'Organize PDFs' },
  { slug: '/crop-pdf',           name: 'Crop PDF',           icon: 'crop',          cat: 'Organize PDFs' },
  { slug: '/compress-pdf',       name: 'Compress PDF',       icon: 'archive',       cat: 'Compress & Optimize' },
  { slug: '/pdf-to-word',        name: 'PDF to Word',        icon: 'file-text',     cat: 'Convert From PDF' },
  { slug: '/pdf-to-excel',       name: 'PDF to Excel',       icon: 'file-spreadsheet', cat: 'Convert From PDF' },
  { slug: '/pdf-to-powerpoint',  name: 'PDF to PowerPoint',  icon: 'presentation',  cat: 'Convert From PDF' },
  { slug: '/pdf-to-jpg',         name: 'PDF to JPG',         icon: 'image',         cat: 'Convert From PDF' },
  { slug: '/word-to-pdf',        name: 'Word to PDF',        icon: 'file-text',     cat: 'Convert To PDF' },
  { slug: '/excel-to-pdf',       name: 'Excel to PDF',       icon: 'file-spreadsheet', cat: 'Convert To PDF' },
  { slug: '/powerpoint-to-pdf',  name: 'PowerPoint to PDF',  icon: 'presentation',  cat: 'Convert To PDF' },
  { slug: '/jpg-to-pdf',         name: 'JPG to PDF',         icon: 'image',         cat: 'Convert To PDF' },
  { slug: '/html-to-pdf',        name: 'HTML to PDF',        icon: 'code-2',        cat: 'Convert To PDF' },
  { slug: '/edit-pdf',           name: 'Edit PDF',           icon: 'pencil',        cat: 'Edit & Annotate' },
  { slug: '/watermark-pdf',      name: 'Watermark PDF',      icon: 'droplet',       cat: 'Edit & Annotate' },
  { slug: '/sign-pdf',           name: 'Sign PDF',           icon: 'pen-tool',      cat: 'Edit & Annotate' },
  { slug: '/add-page-numbers',   name: 'Add Page Numbers',   icon: 'hash',          cat: 'Edit & Annotate' },
  { slug: '/redact-pdf',         name: 'Redact PDF',         icon: 'eye-off',       cat: 'Edit & Annotate' },
  { slug: '/protect-pdf',        name: 'Protect PDF',        icon: 'lock',          cat: 'Security' },
  { slug: '/unlock-pdf',         name: 'Unlock PDF',         icon: 'unlock',        cat: 'Security' },
  { slug: '/repair-pdf',         name: 'Repair PDF',         icon: 'wrench',        cat: 'Advanced Tools' },
  { slug: '/scan-pdf',           name: 'Scan to PDF',        icon: 'scan',          cat: 'Advanced Tools' },
  { slug: '/ocr-pdf',            name: 'OCR PDF',            icon: 'text-search',   cat: 'Advanced Tools' },
  { slug: '/compare-pdf',        name: 'Compare PDF',        icon: 'git-compare',   cat: 'Advanced Tools' },
  { slug: '/ai-summarizer',      name: 'AI Summarizer',      icon: 'sparkles',      cat: 'Advanced Tools' },
  { slug: '/translate-pdf',      name: 'Translate PDF',      icon: 'languages',     cat: 'Advanced Tools' },
  { slug: '/workflow-builder',   name: 'Workflow Builder',   icon: 'workflow',      cat: 'Advanced Tools' },
  { slug: '/numbers-to-words',   name: 'Numbers to Words',   icon: 'spell-check',   cat: 'Utilities' },
  { slug: '/currency-converter', name: 'Currency Converter', icon: 'dollar-sign',   cat: 'Utilities' },
  { slug: '/background-remover', name: 'Background Remover', icon: 'image-minus',   cat: 'Image Tools' },
  { slug: '/crop-image',         name: 'Crop Image',         icon: 'crop',          cat: 'Image Tools' },
  { slug: '/resize-image',       name: 'Resize Image',       icon: 'maximize-2',    cat: 'Image Tools' },
  { slug: '/image-filters',      name: 'Image Filters',      icon: 'image',         cat: 'Image Tools' },
];
const TOOLS_BY_SLUG = Object.fromEntries(ALL_TOOLS.map(t => [t.slug, t]));

// 6-anchor fallback list of evergreen high-traffic tools.
const ANCHOR_TOOLS = ['/merge-pdf', '/split-pdf', '/compress-pdf', '/pdf-to-word', '/pdf-to-jpg', '/protect-pdf'];

function pickRelatedTools(blog, count = 7) {
  const out = [];
  const seen = new Set();
  // Always include the blog's own tool first.
  if (TOOLS_BY_SLUG[blog.toolSlug]) {
    out.push(TOOLS_BY_SLUG[blog.toolSlug]); seen.add(blog.toolSlug);
  }
  // Then same-category tools.
  for (const t of ALL_TOOLS) {
    if (out.length >= count) break;
    if (seen.has(t.slug)) continue;
    if (t.cat === blog.category) { out.push(t); seen.add(t.slug); }
  }
  // Then anchors.
  for (const slug of ANCHOR_TOOLS) {
    if (out.length >= count) break;
    if (seen.has(slug)) continue;
    if (TOOLS_BY_SLUG[slug]) { out.push(TOOLS_BY_SLUG[slug]); seen.add(slug); }
  }
  return out;
}

function pickRelatedBlogs(blog, count = 6) {
  const out = [];
  const seen = new Set([blog.slug]);
  // Author-specified relations first.
  for (const slug of (blog.related || [])) {
    if (out.length >= count) break;
    if (seen.has(slug)) continue;
    if (BY_SLUG[slug]) { out.push(BY_SLUG[slug]); seen.add(slug); }
  }
  // Fill from same category.
  for (const b of BLOGS) {
    if (out.length >= count) break;
    if (seen.has(b.slug)) continue;
    if (b.category === blog.category) { out.push(b); seen.add(b.slug); }
  }
  // Final fill: any remaining.
  for (const b of BLOGS) {
    if (out.length >= count) break;
    if (seen.has(b.slug)) continue;
    out.push(b); seen.add(b.slug);
  }
  return out;
}

function escAttr(s){
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function slugifyHeading(text){
  return String(text).toLowerCase()
    .replace(/&[a-z]+;/g,' ')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'');
}

// ── Body sections ────────────────────────────────────────────────────────
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
  return faq.map(f => `<details class="blog-faq-item">
      <summary>${escAttr(f.q)}</summary>
      <div class="blog-faq-answer"><p>${f.a}</p></div>
    </details>`).join('\n    ');
}

function renderRelatedBlogs(blog){
  const list = pickRelatedBlogs(blog, 6);
  const cards = list.map(b => `<a href="/blog/${b.slug}.html" class="blog-related-card">
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

function renderRelatedTools(blog){
  const list = pickRelatedTools(blog, 7);
  const pills = list.map(t => `<a href="${t.slug}" class="blog-tool-card">
        <span class="blog-tool-card-icon"><i data-lucide="${t.icon}"></i></span>
        <span class="blog-tool-card-name">${t.name}</span>
      </a>`).join('\n      ');
  return `<section class="blog-related-tools" aria-label="Related tools">
      <h2>Related tools you might need</h2>
      <p class="blog-section-sub">Hand-picked ILovePDF tools that pair well with this guide.</p>
      <div class="blog-tool-card-grid">
      ${pills}
      </div>
    </section>`;
}

// ── Sidebar ──────────────────────────────────────────────────────────────
function renderSidebarPopularTools(currentToolSlug){
  const list = ALL_TOOLS
    .filter(t => ['/merge-pdf','/split-pdf','/compress-pdf','/pdf-to-word','/pdf-to-jpg','/jpg-to-pdf','/protect-pdf','/ai-summarizer','/background-remover'].includes(t.slug))
    .filter(t => t.slug !== currentToolSlug)
    .slice(0, 8);
  const pills = list.map(t => `<a href="${t.slug}" class="blog-tool-pill"><i data-lucide="${t.icon}"></i> ${t.name}</a>`).join('\n        ');
  return `<aside class="blog-sidebar-block" aria-label="Popular tools">
        <h4>Popular tools</h4>
        <div class="blog-sidebar-pills">
          ${pills}
        </div>
      </aside>`;
}

function buildToc(blog){
  // Build the TOC entries from the H2s we know we render in renderHtml().
  // Static order matches the template exactly.
  const items = [
    { id: 'how-to', label: `How to use ${blog.toolName}` },
    { id: 'why',    label: `Why use ${blog.toolName}` },
    { id: 'use-cases', label: 'Common use cases' },
    { id: 'tips',   label: 'Pro tips' },
    { id: 'faq',    label: 'FAQs' },
    { id: 'related-tools', label: 'Related tools' },
    { id: 'related-articles', label: 'Related guides' },
  ];
  const lis = items.map(i => `<li><a href="#${i.id}">${i.label}</a></li>`).join('\n          ');
  return `<aside class="blog-sidebar-block blog-toc" aria-label="Table of contents">
        <h4><i data-lucide="list" style="width:14px;height:14px;vertical-align:middle;margin-right:5px;"></i> Table of contents</h4>
        <ol class="blog-toc-list">
          ${lis}
        </ol>
      </aside>`;
}

// ── Trust + Why-choose ──────────────────────────────────────────────────
function renderTrustStrip(){
  return `<ul class="blog-trust-strip" aria-label="Why you can trust ILovePDF">
      <li><i data-lucide="shield-check"></i> Secure processing</li>
      <li><i data-lucide="cloud-off"></i> No installation required</li>
      <li><i data-lucide="trash-2"></i> Files auto-deleted after 10 minutes</li>
      <li><i data-lucide="user-x"></i> No signup needed</li>
    </ul>`;
}

function renderFeedback(blog){
  // Lightweight client-side widget. JS lives in /js/blog-article.js and
  // is keyed by blog slug so each guide tracks its own vote in localStorage.
  return `<section class="blog-feedback" data-feedback-slug="${escAttr(blog.slug)}" aria-labelledby="fb-h-${escAttr(blog.slug)}">
      <h3 id="fb-h-${escAttr(blog.slug)}" class="blog-feedback-title">Was this guide helpful?</h3>
      <div class="blog-feedback-actions" role="group" aria-label="Feedback">
        <button type="button" class="fb-btn" data-vote="yes" aria-label="Yes, this guide was helpful">
          <span aria-hidden="true">👍</span> Yes
        </button>
        <button type="button" class="fb-btn" data-vote="no" aria-label="No, this guide was not helpful">
          <span aria-hidden="true">👎</span> No
        </button>
      </div>
      <p class="blog-feedback-msg" role="status" aria-live="polite"></p>
    </section>`;
}

function renderWhyChoose(){
  return `<aside class="blog-why-choose" aria-label="Why choose ILovePDF">
      <h2>Why choose ILovePDF</h2>
      <div class="blog-why-grid">
        <div><i data-lucide="zap"></i><h4>Fast</h4><p>Most files are processed in seconds, right from your browser.</p></div>
        <div><i data-lucide="gift"></i><h4>Free</h4><p>${BLOGS.length}+ tools with no daily cap and no watermark on output.</p></div>
        <div><i data-lucide="shield"></i><h4>Secure</h4><p>HTTPS uploads and automatic file deletion within minutes.</p></div>
        <div><i data-lucide="user-check"></i><h4>No signup</h4><p>No account required for files under 100&nbsp;MB.</p></div>
      </div>
    </aside>`;
}

// ── Schemas ──────────────────────────────────────────────────────────────
function renderArticleJsonLd(b){
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
  });
}
function renderFaqJsonLd(b){
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: b.faq.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: String(f.a).replace(/<[^>]+>/g, '') },
    })),
  });
}
function renderBreadcrumbJsonLd(b){
  const url = `${SITE}/blog/${b.slug}.html`;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: SITE + '/blog.html' },
      { '@type': 'ListItem', position: 3, name: `${b.toolName} guide`, item: url },
    ],
  });
}

// ── Page ─────────────────────────────────────────────────────────────────
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
  <script type="application/ld+json">${renderArticleJsonLd(b)}</script>
  <script type="application/ld+json">${renderBreadcrumbJsonLd(b)}</script>
  <script type="application/ld+json">${renderFaqJsonLd(b)}</script>
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3242156405919556" crossorigin="anonymous"></script>
</head>
<body>

  <!-- Reading progress bar -->
  <div class="blog-progress" id="blog-progress" aria-hidden="true"><span></span></div>

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
      ${renderTrustStrip()}
    </header>

    <div class="blog-layout">

      <article class="blog-article-body">

        ${b.intro}

        <h2 id="how-to">Step-by-step: how to use ${escAttr(b.toolName)}</h2>
        ${renderSteps(b.steps)}

        <!-- Mid-article CTA -->
        <div class="blog-cta-box blog-cta-mid">
          <h3>Use ${escAttr(b.toolName)} now</h3>
          <p>No signup. No software. Just fast, secure ${escAttr(b.toolName.toLowerCase())} online.</p>
          <a href="${b.toolSlug}" class="blog-cta-btn">
            <i data-lucide="${b.icon}"></i> Open ${escAttr(b.toolName)}
          </a>
        </div>

        <!-- In-content ad slot -->
        <div class="ad-slot ad-slot-incontent" aria-label="Advertisement"></div>

        <h2 id="why">Why use ${escAttr(b.toolName)}?</h2>
        ${renderBenefits(b.benefits)}

        <h2 id="use-cases">Common use cases</h2>
        ${renderUseCases(b.useCases)}

        <h2 id="tips">Pro tips for the best results</h2>
        ${renderTips(b.tips)}

        <h2 id="faq">Frequently asked questions</h2>
        <div class="blog-faq-list">
          ${renderFaq(b.faq)}
        </div>

        <h2>Wrapping up</h2>
        <p>${escAttr(b.toolName)} is one of ${BLOGS.length}+ free tools in the ILovePDF suite — built for everyday document tasks that shouldn\'t require expensive software or a paid subscription. Files are processed securely, deleted within minutes, and never used to train models. Give it a spin: <a href="${b.toolSlug}">open ${escAttr(b.toolName)}</a> and see how fast it works.</p>

        <!-- End CTA -->
        <div class="blog-cta-box blog-cta-end">
          <h3>Try ${escAttr(b.toolName)} now — free</h3>
          <p>${BLOGS.length}+ tools, no signup, no watermark. Your files auto-delete within minutes.</p>
          <a href="${b.toolSlug}" class="blog-cta-btn">
            <i data-lucide="${b.icon}"></i> Try ${escAttr(b.toolName)}
          </a>
        </div>

      </article>

      <aside class="blog-sidebar" aria-label="Article sidebar">
        ${buildToc(b)}
        ${renderSidebarPopularTools(b.toolSlug)}
        <div class="ad-slot ad-slot-sidebar" aria-label="Advertisement"></div>
      </aside>

    </div>

    ${renderFeedback(b)}

    <section id="related-tools">
      ${renderRelatedTools(b)}
    </section>

    ${renderWhyChoose()}

    <section id="related-articles">
      ${renderRelatedBlogs(b)}
    </section>

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
  <script src="/js/blog-article.js" defer></script>
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

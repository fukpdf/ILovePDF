// routes/seo-routes.js
// Enterprise-grade SEO + sitemap architecture.
//
// Sitemap hierarchy (sitemapindex):
//   /sitemap.xml           → sitemapindex master
//   /sitemaps/pages.xml    → homepage + categories + utility pages
//   /sitemaps/tools.xml    → all 33+ tool pages
//   /sitemaps/blog.xml     → static guides + DB-published posts (per-request)
//   /sitemaps/images.xml   → key site images
//   /sitemaps/locales.xml  → hreflang-ready structure (en + x-default)
//
// All XML payloads except blog.xml are pre-built at boot and served from
// memory so per-request cost is just res.send(string).

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SLUG_MAP, buildCategoryHtml } from '../utils/seo.js';
import { injectNonce } from '../utils/csp-nonce.js';
import { CATEGORIES, allPublicSlugs } from '../utils/seo-categories.js';
import { COMPARISONS, buildComparisonHtml, buildCompareIndexHtml } from '../utils/seo-comparison.js';
import { GUIDES, buildGuideHtml, buildGuideIndexHtml } from '../utils/seo-guides.js';
import db from '../utils/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SITE = (process.env.SITE_URL || 'https://ilovepdf.cyou').replace(/\/$/, '');

const TOP_TOOLS = new Set([
  'merge-pdf', 'split-pdf', 'compress-pdf',
  'pdf-to-word', 'pdf-to-jpg', 'word-to-pdf', 'jpg-to-pdf',
  'edit-pdf', 'protect-pdf', 'background-remover',
]);

const UTILITY_PAGES = [
  { path: '/privacy.html',    priority: 0.5, changefreq: 'yearly'  },
  { path: '/terms.html',      priority: 0.5, changefreq: 'yearly'  },
  { path: '/disclaimer.html', priority: 0.5, changefreq: 'yearly'  },
  { path: '/blog.html',       priority: 0.7, changefreq: 'weekly'  },
  { path: '/about',           priority: 0.5, changefreq: 'monthly' },
  { path: '/tools',           priority: 0.8, changefreq: 'weekly'  },
];

// Static guide blog posts that exist as public/blog/*.html
const STATIC_BLOG_PATHS = [
  '/blog/merge-pdf-guide.html',
  '/blog/split-pdf-guide.html',
  '/blog/rotate-pdf-guide.html',
  '/blog/crop-pdf-guide.html',
  '/blog/organize-pdf-guide.html',
  '/blog/compress-pdf-guide.html',
  '/blog/pdf-to-word-guide.html',
  '/blog/pdf-to-powerpoint-guide.html',
  '/blog/pdf-to-excel-guide.html',
  '/blog/pdf-to-jpg-guide.html',
  '/blog/word-to-pdf-guide.html',
  '/blog/powerpoint-to-pdf-guide.html',
  '/blog/excel-to-pdf-guide.html',
  '/blog/jpg-to-pdf-guide.html',
  '/blog/html-to-pdf-guide.html',
  '/blog/edit-pdf-guide.html',
  '/blog/watermark-pdf-guide.html',
  '/blog/sign-pdf-guide.html',
  '/blog/add-page-numbers-guide.html',
  '/blog/redact-pdf-guide.html',
  '/blog/protect-pdf-guide.html',
  '/blog/unlock-pdf-guide.html',
  '/blog/repair-pdf-guide.html',
  '/blog/scan-pdf-guide.html',
  '/blog/ocr-pdf-guide.html',
  '/blog/compare-pdf-guide.html',
  '/blog/ai-summarizer-guide.html',
  '/blog/translate-pdf-guide.html',
  '/blog/workflow-builder-guide.html',
  '/blog/numbers-to-words-guide.html',
  '/blog/currency-converter-guide.html',
  '/blog/background-remover-guide.html',
  '/blog/crop-image-guide.html',
  '/blog/resize-image-guide.html',
  '/blog/image-filters-guide.html',
  '/blog/best-pdf-tools.html',
  '/blog/support-the-project.html',
];

// ── XML helpers ───────────────────────────────────────────────────────────────
function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildUrlset(urls, extraNs = '') {
  const body = urls.map(u =>
    `  <url><loc>${escXml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod>` +
    `<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${extraNs}>\n` +
    `${body}\n</urlset>\n`;
}

// ── Sitemap index ─────────────────────────────────────────────────────────────
function buildSitemapIndex() {
  const today = new Date().toISOString().slice(0, 10);
  const subs  = ['pages', 'tools', 'blog', 'images', 'locales'];
  const body  = subs.map(s =>
    `  <sitemap><loc>${escXml(`${SITE}/sitemaps/${s}.xml`)}</loc><lastmod>${today}</lastmod></sitemap>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${body}\n</sitemapindex>\n`;
}

// ── Sub-sitemaps ──────────────────────────────────────────────────────────────
function buildPagesSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, lastmod: today, changefreq: 'weekly', priority: '1.0' },
    ...Object.entries(CATEGORIES).map(([s, c]) => ({
      loc: `${SITE}/${s}`, lastmod: today, changefreq: 'weekly',
      priority: (c.priority ?? 0.8).toFixed(1),
    })),
    ...UTILITY_PAGES.map(u => ({
      loc: `${SITE}${u.path}`, lastmod: today,
      changefreq: u.changefreq, priority: u.priority.toFixed(1),
    })),
    // Compare hub + individual comparison pages
    { loc: `${SITE}/compare`, lastmod: today, changefreq: 'monthly', priority: '0.7' },
    ...Object.keys(COMPARISONS).map(s => ({
      loc: `${SITE}/compare/${s}`, lastmod: today, changefreq: 'monthly', priority: '0.7',
    })),
    // Guides hub + individual guide pages
    { loc: `${SITE}/guides`, lastmod: today, changefreq: 'monthly', priority: '0.8' },
    ...Object.keys(GUIDES).map(s => ({
      loc: `${SITE}/guides/${s}`, lastmod: today, changefreq: 'monthly', priority: '0.75',
    })),
  ];
  return buildUrlset(urls);
}

function buildToolsSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const urls  = Object.keys(SLUG_MAP).map(slug => ({
    loc: `${SITE}/${slug}`, lastmod: today, changefreq: 'monthly',
    priority: (TOP_TOOLS.has(slug) ? 0.9 : 0.8).toFixed(1),
  }));
  return buildUrlset(urls);
}

// Blog sitemap is built per-request so new DB posts appear without restart.
function buildBlogSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const urls  = [];

  for (const p of STATIC_BLOG_PATHS) {
    urls.push({ loc: `${SITE}${p}`, lastmod: today, changefreq: 'monthly', priority: '0.6' });
  }

  try {
    const posts = db.prepare(
      `SELECT slug, updated_at, published_at FROM adm_blog_posts
       WHERE status='published' ORDER BY published_at DESC`,
    ).all();
    for (const post of posts) {
      const ts  = post.updated_at || post.published_at || Math.floor(Date.now() / 1000);
      const lm  = new Date(ts * 1000).toISOString().slice(0, 10);
      const loc = `${SITE}/blog/${post.slug}`;
      if (!urls.find(u => u.loc === loc)) {
        urls.push({ loc, lastmod: lm, changefreq: 'monthly', priority: '0.6' });
      }
    }
  } catch (e) {
    console.warn('[seo-routes] blog DB query failed (non-fatal):', e.message);
  }

  return buildUrlset(urls);
}

function buildImagesSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const rows  = [
    { loc: `${SITE}/`,               img: `${SITE}/favicon.svg`,
      title: 'ILovePDF Logo',        caption: 'ILovePDF — Free Online PDF and Image Tools' },
    { loc: `${SITE}/merge-pdf`,      img: `${SITE}/favicon.svg`,
      title: 'Merge PDF',            caption: 'Combine multiple PDF files into one' },
    { loc: `${SITE}/compress-pdf`,   img: `${SITE}/favicon.svg`,
      title: 'Compress PDF',         caption: 'Reduce PDF file size without quality loss' },
    { loc: `${SITE}/pdf-to-word`,    img: `${SITE}/favicon.svg`,
      title: 'PDF to Word',          caption: 'Convert PDF to editable Word document' },
    { loc: `${SITE}/background-remover`, img: `${SITE}/favicon.svg`,
      title: 'Background Remover',   caption: 'Remove image background with AI' },
  ];

  const body = rows.map(r =>
    `  <url>\n    <loc>${escXml(r.loc)}</loc>\n    <lastmod>${today}</lastmod>\n` +
    `    <image:image>\n      <image:loc>${escXml(r.img)}</image:loc>\n` +
    `      <image:title>${escXml(r.title)}</image:title>\n` +
    `      <image:caption>${escXml(r.caption)}</image:caption>\n` +
    `    </image:image>\n  </url>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    `${body}\n</urlset>\n`;
}

function buildLocalesSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  // hreflang-ready structure. Currently English-only (en + x-default).
  // When locale prefixes (/es/, /fr/, ...) are added, extend this list.
  const pages = [
    { path: '/',    priority: '1.0' },
    ...Object.keys(CATEGORIES).map(s => ({ path: `/${s}`, priority: '0.85' })),
    ...Object.keys(SLUG_MAP).map(s    => ({ path: `/${s}`, priority: '0.8'  })),
  ];

  const body = pages.map(p => {
    const loc = `${SITE}${p.path}`;
    return `  <url>\n    <loc>${escXml(loc)}</loc>\n    <lastmod>${today}</lastmod>` +
      `\n    <priority>${p.priority}</priority>` +
      `\n    <xhtml:link rel="alternate" hreflang="en" href="${escXml(loc)}"/>` +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${escXml(loc)}"/>` +
      `\n  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    `${body}\n</urlset>\n`;
}

// ── robots.txt ────────────────────────────────────────────────────────────────
function buildRobots() {
  return `# robots.txt — ILovePDF
# Updated for Google Search Console compatibility

User-agent: *
Allow: /

# ── Rendering resources — explicitly allowed so Googlebot can render pages ──
Allow: /js/
Allow: /css/
Allow: /core/
Allow: /locales/
Allow: /laba/
Allow: /images/
Allow: /fonts/
Allow: /favicon.svg
Allow: /manifest.json
Allow: /sw.js
Allow: /sitemaps/

# ── Block admin + private surfaces ──────────────────────────────────────────
Disallow: /admin
Disallow: /admin/
Disallow: /api/admin/
Disallow: /api/temp/
Disallow: /api/auth/
Disallow: /api/r2/
Disallow: /uploads/tmp/
Disallow: /dashboard/private/

# ── Block non-indexable tool sub-steps (carry noindex meta anyway) ───────────
Disallow: /*/preview
Disallow: /*/download

# ── Block debug / internal-only endpoints ───────────────────────────────────
Disallow: /live-intel
Disallow: /ping-index
Disallow: /verify-signup

# Crawl politeness
Crawl-delay: 1

Sitemap: ${SITE}/sitemap.xml
Sitemap: ${SITE}/sitemaps/tools.xml
Sitemap: ${SITE}/sitemaps/blog.xml
Sitemap: ${SITE}/sitemaps/pages.xml
`;
}

// ── Pre-build static payloads at boot ─────────────────────────────────────────
function loadToolShell() {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'tool.html'), 'utf8');
}

const SITEMAP_INDEX = buildSitemapIndex();
const PAGES_XML     = buildPagesSitemap();
const TOOLS_XML     = buildToolsSitemap();
const IMAGES_XML    = buildImagesSitemap();
const LOCALES_XML   = buildLocalesSitemap();
const ROBOTS_TXT    = buildRobots();

const CATEGORY_HTML = (() => {
  try {
    const shell = loadToolShell();
    const out   = {};
    for (const [slug, cat] of Object.entries(CATEGORIES)) {
      out[slug] = buildCategoryHtml(slug, shell, cat);
    }
    return out;
  } catch (e) {
    console.warn('[seo-routes] could not pre-build category HTML:', e.message);
    return {};
  }
})();

const COMPARE_INDEX_HTML = (() => {
  try { return buildCompareIndexHtml(loadToolShell()); }
  catch (e) { console.warn('[seo-routes] could not pre-build compare index:', e.message); return null; }
})();

const COMPARISON_HTML = (() => {
  try {
    const shell = loadToolShell();
    const out   = {};
    for (const slug of Object.keys(COMPARISONS)) {
      out[slug] = buildComparisonHtml(slug, shell);
    }
    return out;
  } catch (e) { console.warn('[seo-routes] could not pre-build comparison HTML:', e.message); return {}; }
})();

const GUIDE_INDEX_HTML = (() => {
  try { return buildGuideIndexHtml(loadToolShell()); }
  catch (e) { console.warn('[seo-routes] could not pre-build guide index:', e.message); return null; }
})();

const GUIDE_HTML = (() => {
  try {
    const shell = loadToolShell();
    const out   = {};
    for (const slug of Object.keys(GUIDES)) {
      out[slug] = buildGuideHtml(slug, shell);
    }
    return out;
  } catch (e) { console.warn('[seo-routes] could not pre-build guide HTML:', e.message); return {}; }
})();

// ── Router ────────────────────────────────────────────────────────────────────
const router = express.Router();

// Master sitemap index
router.get('/sitemap.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(SITEMAP_INDEX);
});

// Sub-sitemaps — static (built at boot)
router.get('/sitemaps/pages.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(PAGES_XML);
});

router.get('/sitemaps/tools.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(TOOLS_XML);
});

router.get('/sitemaps/images.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/xml').send(IMAGES_XML);
});

router.get('/sitemaps/locales.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(LOCALES_XML);
});

// Blog sitemap — built per-request to include freshly published DB posts
router.get('/sitemaps/blog.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=1800');
  res.type('application/xml').send(buildBlogSitemap());
});

// robots.txt
router.get('/robots.txt', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send(ROBOTS_TXT);
});

// ── Comparison pages ──────────────────────────────────────────────────────────
// Phase 2: all HTML responses inject the per-request nonce so that
// __CSP_NONCE__ placeholders in pre-built templates are replaced with
// the real nonce before the response is sent. Cache-Control is set to
// no-store because nonces change per request and must not be cached.
router.get('/compare', (_req, res, next) => {
  if (!COMPARE_INDEX_HTML) return next();
  res.set('Cache-Control', 'no-store');
  res.type('html').send(injectNonce(COMPARE_INDEX_HTML, res.locals.nonce));
});

router.get('/compare/:slug', (req, res, next) => {
  const html = COMPARISON_HTML[req.params.slug];
  if (!html) return next();
  res.set('Cache-Control', 'no-store');
  res.type('html').send(injectNonce(html, res.locals.nonce));
});

// ── Guide / tutorial pages ────────────────────────────────────────────────────
router.get('/guides', (_req, res, next) => {
  if (!GUIDE_INDEX_HTML) return next();
  res.set('Cache-Control', 'no-store');
  res.type('html').send(injectNonce(GUIDE_INDEX_HTML, res.locals.nonce));
});

router.get('/guides/:slug', (req, res, next) => {
  const html = GUIDE_HTML[req.params.slug];
  if (!html) return next();
  res.set('Cache-Control', 'no-store');
  res.type('html').send(injectNonce(html, res.locals.nonce));
});

// Category hub pages — only matches known category slugs; anything else falls through.
router.get('/:catSlug', (req, res, next) => {
  const slug = req.params.catSlug;
  const html = CATEGORY_HTML[slug];
  if (!html) return next();
  res.set('Cache-Control', 'no-store');
  res.type('html').send(injectNonce(html, res.locals.nonce));
});

// ── Indexing boost endpoints ──────────────────────────────────────────────────
router.get('/submit-urls', (_req, res) => {
  const slugs = allPublicSlugs();
  const urls  = [
    `${SITE}/`,
    ...slugs.categories.map(s => `${SITE}/${s}`),
    ...slugs.tools.map(s => `${SITE}/${s}`),
    ...slugs.utilities.map(s => `${SITE}/${s}.html`),
    ...slugs.blogs.map(s => `${SITE}/blog/${s}.html`),
    `${SITE}/compare`,
    ...Object.keys(COMPARISONS).map(s => `${SITE}/compare/${s}`),
    `${SITE}/guides`,
    ...Object.keys(GUIDES).map(s => `${SITE}/guides/${s}`),
  ];
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    site: SITE, sitemap: `${SITE}/sitemap.xml`,
    count: urls.length, urls,
    submitTargets: {
      googleSearchConsole: 'https://search.google.com/search-console/sitemaps',
      bingWebmaster: 'https://www.bing.com/webmasters/sitemaps',
      indexNow: 'https://www.indexnow.org/',
    },
  });
});

router.get('/ping-index', async (_req, res) => {
  const sitemap = encodeURIComponent(`${SITE}/sitemap.xml`);
  const targets = [
    { name: 'bing',   url: `https://www.bing.com/ping?sitemap=${sitemap}` },
    { name: 'yandex', url: `https://blogs.yandex.ru/pings/?status=success&url=${sitemap}` },
  ];
  const results = await Promise.all(targets.map(async t => {
    try {
      const r = await fetch(t.url, { method: 'GET' });
      return { engine: t.name, ok: r.ok, status: r.status };
    } catch (e) {
      return { engine: t.name, ok: false, error: e.message };
    }
  }));
  res.set('Cache-Control', 'no-store');
  res.json({
    site: SITE, sitemap: `${SITE}/sitemap.xml`, pinged: results,
    note: 'Google sitemap ping was retired in 2023. Submit via Search Console: https://search.google.com/search-console',
  });
});

export default router;

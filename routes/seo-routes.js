// routes/seo-routes.js
// Phase-3 SEO endpoints: dynamic sitemap.xml, optimized robots.txt, category
// hub pages, and indexing-boost endpoints (/ping-index, /submit-urls).
//
// All HTML responses are pre-built at boot and cached in memory so per-request
// cost is just `res.send(string)`.

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SLUG_MAP, buildCategoryHtml } from '../utils/seo.js';
import { CATEGORIES, allPublicSlugs } from '../utils/seo-categories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SITE = (process.env.SITE_URL || 'https://ilovepdf.cyou').replace(/\/$/, '');

// Tools considered "top" (priority 0.9). Others get 0.8.
const TOP_TOOLS = new Set([
  'merge-pdf', 'split-pdf', 'compress-pdf',
  'pdf-to-word', 'pdf-to-jpg', 'word-to-pdf', 'jpg-to-pdf',
  'edit-pdf', 'protect-pdf', 'background-remover',
]);

// Utility / legal pages and current static blogs.
const UTILITY_PAGES = [
  { path: '/privacy.html',    priority: 0.5, changefreq: 'yearly'  },
  { path: '/terms.html',      priority: 0.5, changefreq: 'yearly'  },
  { path: '/disclaimer.html', priority: 0.5, changefreq: 'yearly'  },
  { path: '/blog.html',       priority: 0.7, changefreq: 'weekly'  },
];
const BLOG_POSTS = [
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
];

function escXml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// ── Sitemap ──────────────────────────────────────────────────────────────────
function buildSitemap(){
  const today = new Date().toISOString().slice(0, 10);
  const urls = [];

  urls.push({ loc: `${SITE}/`, lastmod: today, changefreq: 'weekly', priority: '1.0' });

  for (const catSlug of Object.keys(CATEGORIES)) {
    urls.push({
      loc: `${SITE}/${catSlug}`,
      lastmod: today,
      changefreq: 'weekly',
      priority: (CATEGORIES[catSlug].priority ?? 0.8).toFixed(1),
    });
  }

  for (const slug of Object.keys(SLUG_MAP)) {
    urls.push({
      loc: `${SITE}/${slug}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: (TOP_TOOLS.has(slug) ? 0.9 : 0.8).toFixed(1),
    });
  }

  for (const u of UTILITY_PAGES) {
    urls.push({ loc: `${SITE}${u.path}`, lastmod: today, changefreq: u.changefreq, priority: u.priority.toFixed(1) });
  }
  for (const p of BLOG_POSTS) {
    urls.push({ loc: `${SITE}${p}`, lastmod: today, changefreq: 'monthly', priority: '0.6' });
  }

  const body = urls.map(u =>
    `  <url><loc>${escXml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

// ── Robots.txt ───────────────────────────────────────────────────────────────
function buildRobots(){
  return `# robots.txt — ILovePDF
User-agent: *
Allow: /

# Block private / non-public surfaces
Disallow: /admin
Disallow: /admin/
Disallow: /dashboard/private
Disallow: /api/temp
Disallow: /api/temp/
Disallow: /uploads/tmp
Disallow: /uploads/tmp/
Disallow: /api/auth/
Disallow: /api/r2/

# Crawl politeness
Crawl-delay: 1

Sitemap: ${SITE}/sitemap.xml
`;
}

// ── Pre-build all HTML / text payloads at boot ───────────────────────────────
function loadToolShell(){
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'tool.html'), 'utf8');
}

const SITEMAP_XML = buildSitemap();
const ROBOTS_TXT  = buildRobots();

const CATEGORY_HTML = (() => {
  try {
    const shell = loadToolShell();
    const out = {};
    for (const [slug, cat] of Object.entries(CATEGORIES)) {
      out[slug] = buildCategoryHtml(slug, shell, cat);
    }
    return out;
  } catch (e) {
    console.warn('[seo-routes] could not pre-build category HTML:', e.message);
    return {};
  }
})();

// ── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

router.get('/sitemap.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(SITEMAP_XML);
});

router.get('/robots.txt', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send(ROBOTS_TXT);
});

// Category hub pages — registered as a parametrised handler that only matches
// known category slugs. Anything else falls through to the next route.
router.get('/:catSlug', (req, res, next) => {
  const slug = req.params.catSlug;
  const html = CATEGORY_HTML[slug];
  if (!html) return next();
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
});

// ── Indexing boost endpoints ─────────────────────────────────────────────────
// Returns the full URL list (homepage + categories + tools + utility + blog)
// in JSON so it's easy to feed to Google Search Console / Bing Webmaster /
// IndexNow tools, scripts, or curl. Lightweight and safe to expose publicly.
router.get('/submit-urls', (_req, res) => {
  const slugs = allPublicSlugs();
  const urls = [
    `${SITE}/`,
    ...slugs.categories.map(s => `${SITE}/${s}`),
    ...slugs.tools.map(s => `${SITE}/${s}`),
    ...slugs.utilities.map(s => `${SITE}/${s}.html`),
    ...slugs.blogs.map(s => `${SITE}/blog/${s}.html`),
  ];
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    site: SITE,
    sitemap: `${SITE}/sitemap.xml`,
    count: urls.length,
    urls,
    submitTargets: {
      googleSearchConsole: 'https://search.google.com/search-console/sitemaps',
      bingWebmaster: 'https://www.bing.com/webmasters/sitemaps',
      indexNow: 'https://www.indexnow.org/',
    },
  });
});

// Pings the major search engines with the sitemap location. Google deprecated
// their sitemap-ping endpoint in 2023, so we hit Bing, IndexNow and Yandex
// (still active) and return what each responded. ?key= can override the
// IndexNow key for site owners that have one configured.
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
    site: SITE,
    sitemap: `${SITE}/sitemap.xml`,
    pinged: results,
    note: 'Google sitemap ping was retired in 2023. Submit via Search Console: https://search.google.com/search-console',
  });
});

export default router;

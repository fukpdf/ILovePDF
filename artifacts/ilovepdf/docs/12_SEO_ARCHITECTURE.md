# 12 — SEO ARCHITECTURE

## Overview

ILovePDF has a comprehensive programmatic SEO system that generates all metadata server-side at request time. Every page has unique title, description, canonical URL, Open Graph tags, Twitter cards, and multiple JSON-LD schemas.

---

## URL Structure

### Clean URLs (No .html extensions)

| Pattern | Example | Notes |
|---------|---------|-------|
| `/:slug` | `/merge-pdf` | Tool upload step |
| `/:slug/preview` | `/merge-pdf/preview` | Tool preview step |
| `/:slug/download` | `/merge-pdf/download` | Tool download step |
| `/blog/:slug` | `/blog/merge-pdf-guide` | Blog article |
| `/about` | `/about` | Static page |
| `/privacy` | `/privacy` | Legal page |
| `/terms` | `/terms` | Legal page |
| `/disclaimer` | `/disclaimer` | Legal page |
| `/blog` | `/blog` | Blog index |
| `/tools` | `/tools` | Tools directory |

**Redirects** (server + Firebase Hosting):
- `/*.html` → `/*` (301 permanent)
- `/contact` → `/about#contact` (301)

---

## SEO Injection System (`utils/seo.js`)

The `buildHtml(slug, template, step)` function:
1. Looks up the slug in `SLUG_MAP`
2. Gets SEO metadata from `getToolSeo(slug, name)` in `utils/seo-keywords.js`
3. Builds all HTML head elements
4. Injects `window.__TOOL_ID` and `window.__STEP`
5. Returns complete HTML ready to serve

### Tool SEO Metadata (per tool)

**Title pattern**: `{Tool Action} Online Free — {short benefit} | ILovePDF`
**Description**: 150-160 character unique description with primary keyword
**Canonical**: `https://ilovepdf.cyou/{slug}`

### JSON-LD Schemas per Tool Page

**1. SoftwareApplication**
```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Merge PDF",
  "applicationCategory": "UtilitiesApplication",
  "operatingSystem": "Web",
  "url": "https://ilovepdf.cyou/merge-pdf",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.9", "ratingCount": "1284" }
}
```

**2. FAQPage** (5-7 Q&A pairs per tool, from `seo-keywords.js`)
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How do I merge PDF files?",
      "acceptedAnswer": { "@type": "Answer", "text": "..." }
    }
  ]
}
```

**3. HowTo** (5-step instructions per tool)
```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Merge PDF Files",
  "step": [
    { "@type": "HowToStep", "position": 1, "name": "Open the Merge PDF tool", "text": "..." }
  ]
}
```

**4. BreadcrumbList**
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "All Tools", "item": "https://ilovepdf.cyou" },
    { "@type": "ListItem", "position": 2, "name": "Organize PDFs", "item": "..." },
    { "@type": "ListItem", "position": 3, "name": "Merge PDF" }
  ]
}
```

---

## Sitemap (`routes/seo-routes.js`)

**`/sitemap.xml`** — Sitemap index pointing to 4 sub-sitemaps:
- `/sitemap-tools.xml` — All 43 tool pages
- `/sitemap-blog.xml` — All 37 blog articles
- `/sitemap-categories.xml` — Category landing pages
- `/sitemap-static.xml` — Static pages (about, privacy, terms, etc.)

**Sitemap features**:
- `<lastmod>` dates
- `<changefreq>`: tools=daily, blog=monthly, static=yearly
- `<priority>`: homepage=1.0, tools=0.8, blog=0.6, static=0.5
- Proper XML namespace and encoding

---

## robots.txt (`routes/seo-routes.js`)

```
User-agent: *
Allow: /
Disallow: /admin
Disallow: /debug
Disallow: /p9-test
Disallow: /dashboard
Disallow: /api/

Crawl-delay: 1

Sitemap: https://ilovepdf.cyou/sitemap.xml
Sitemap: https://ilovepdf.cyou/sitemap-tools.xml
Sitemap: https://ilovepdf.cyou/sitemap-blog.xml
Sitemap: https://ilovepdf.cyou/sitemap-categories.xml
```

---

## Blog SEO

37 articles at `/blog/:slug`, each with:

**Head tags**:
- Unique `<title>` per article
- Unique `<meta name="description">`
- `<link rel="canonical">`
- Full OG block (og:type=article, og:title, og:description, og:image, og:url)
- Full Twitter card (twitter:card=summary_large_image, twitter:title, twitter:description, twitter:image)

**JSON-LD schemas**:
1. `Article` with author, datePublished, dateModified, publisher
2. `FAQPage` with article-relevant Q&A
3. `BreadcrumbList` (All Tools → Blog → Article)

**Blog index** (`/blog`):
- `CollectionPage` JSON-LD
- BreadcrumbList

---

## Static Page SEO

All static pages have been audited (Phase P AdSense compliance):

| Page | title | desc | OG | Twitter | JSON-LD |
|------|-------|------|----|---------|---------|
| `/` | ✓ (dynamic) | ✓ | ✓ | ✓ | ✓ WebSite + Organization |
| `/about` | ✓ | ✓ | ✓ | ✓ | ✓ AboutPage + Organization |
| `/privacy` | ✓ | ✓ | ✓ | ✓ | ✓ WebPage |
| `/terms` | ✓ | ✓ | ✓ | ✓ | ✓ WebPage |
| `/disclaimer` | ✓ | ✓ | ✓ | ✓ | ✓ WebPage |
| `/blog` | ✓ | ✓ | ✓ | ✓ | ✓ CollectionPage |
| `/tools` | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## AdSense Integration

**Publisher ID**: `ca-pub-3242156405919556`

Present on all publicly-indexed pages:
```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3242156405919556" crossorigin="anonymous"></script>
```

**CSP allows all AdSense domains**:
- `script-src`: `pagead2.googlesyndication.com`, `partner.googleadservices.com`, `tpc.googlesyndication.com`
- `frame-src`: `googleads.g.doubleclick.net`, `tpc.googlesyndication.com`, `www.google.com`, `pagead2.googlesyndication.com`
- `connect-src`: `pagead2.googlesyndication.com`, `adservice.google.com`, `ep1.adtrafficquality.google`

**Ad slot containers** (class `ad-slot`):
- Empty containers for ad scripts to target
- Present in tool page HTML (above/below tool, between sections)
- `aria-hidden="true"` — accessible

---

## SEO Content System

### Tool Body Content (`utils/seo.js`)

Each tool page has 300+ words of visible body content:
- H1: Tool name + primary action
- Intro paragraph: What the tool does
- Feature highlights: 3-4 benefit blocks
- H2: "How to {tool name}"
- Step-by-step numbered list
- H2: FAQ section (5-7 questions)
- Related tools section

### Keyword Coverage (`utils/seo-keywords.js`)

Per-tool SEO data:
- Primary keyword
- Long-tail variants (3-5 per tool)
- FAQ questions targeting featured snippets
- Comparison phrases (e.g., "vs ilovepdf.com")

### Category Pages (`utils/seo-categories.js`)

Landing pages for tool categories:
- `/pdf-tools` — All PDF tools
- Category-specific landing pages

---

## Canonical URL Strategy

All canonical URLs use:
- Protocol: `https://`
- Domain: `ilovepdf.cyou`
- Path: clean URL without `.html` or trailing slash
- No query parameters in canonical

Canonical is injected server-side by `buildHtml()` for all tool pages. Static pages have hardcoded canonicals in their `<head>`.

---

## SEO Performance Notes

- `Cache-Control: public, max-age=300` for blog + static pages (5 min CDN)
- `Cache-Control: no-store` for tool pages (nonce changes per request)
- Firebase Hosting `cleanUrls: true` eliminates double-URL issues
- 301 redirects for all legacy `.html` URLs prevent duplicate content
- `hreflang` not yet implemented (multilingual UI exists but no alternate URLs)

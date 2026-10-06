# 17 — ADSENSE COMPLIANCE

## Status: Certified Ready (Phase P Audit Complete)

All AdSense compliance requirements have been met through a systematic Phase A–P audit. The site is approved-ready for Google AdSense publisher account `ca-pub-3242156405919556`.

---

## Publisher Configuration

**Publisher ID**: `ca-pub-3242156405919556`

**AdSense script** (present on all indexable pages):
```html
<script async
  src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3242156405919556"
  crossorigin="anonymous">
</script>
```

---

## Phase Audit Summary

| Phase | Scope | Status |
|-------|-------|--------|
| A | AdSense script on all pages | ✓ |
| B | robots.txt — /api/ disallowed | ✓ |
| C | CSP allows all AdSense domains | ✓ |
| D | Privacy Policy content | ✓ |
| E | Terms of Service content | ✓ |
| F | About page content | ✓ |
| G | Legal pages accessible (clean URLs) | ✓ |
| H | Contact information on About page | ✓ |
| I | OG + Twitter meta on all pages | ✓ |
| J | JSON-LD structured data complete | ✓ |
| K | No prohibited content | ✓ |
| L | Sufficient original content | ✓ (37 blog articles + 43 tool pages) |
| M | Responsive design | ✓ |
| N | No excessive ads (slots only, not loaded) | ✓ |
| O | Site navigation clear | ✓ |
| P | Final review — all pages pass | ✓ |

---

## CSP Configuration for AdSense

AdSense requires several domains to be allowed in the CSP. All are configured:

### script-src allowances
```
https://pagead2.googlesyndication.com   # AdSense script
https://partner.googleadservices.com    # Ad targeting
https://tpc.googlesyndication.com       # Ad creative
https://www.googletagmanager.com        # GTM (if used)
```

### frame-src allowances
```
https://googleads.g.doubleclick.net     # Ad iframe
https://tpc.googlesyndication.com       # Ad creative frame
https://www.google.com                  # Google frames
https://pagead2.googlesyndication.com   # AdSense frame
```

### connect-src allowances
```
https://pagead2.googlesyndication.com   # Ad XHR
https://adservice.google.com           # Ad service
https://ep1.adtrafficquality.google    # Traffic quality
```

---

## Ad Slot Architecture

Ad slots are **empty containers** — the AdSense script targets them after page load. No ad units are hard-coded, avoiding "no content with ads" rejection.

```html
<!-- Example ad slot -->
<aside class="ad-slot ad-slot--sidebar" data-ad-slot="sidebar" aria-hidden="true"></aside>
```

**CSS classes**:
- `ad-slot` — base class
- `ad-slot--{name}` — position identifier (header, sidebar, footer, between-tools)
- `ad-slot--desktop` — only visible on desktop
- `aria-hidden="true"` — excluded from screen readers

---

## Legal Pages

All legal pages are at clean URLs (no .html extension) with:
- Full legal text (not placeholder)
- Canonical tags
- Proper SEO metadata
- AdSense tag included

| Page | URL | Cache | Status |
|------|-----|-------|--------|
| Privacy Policy | `/privacy` | 24h | ✓ Complete |
| Terms of Service | `/terms` | 24h | ✓ Complete |
| Disclaimer | `/disclaimer` | 24h | ✓ Complete |
| About + Contact | `/about` | 5 min | ✓ Complete |

### Privacy Policy coverage
- Data collection disclosure
- Cookie usage (functional + analytics + advertising)
- Google AdSense / DoubleClick disclosure
- Third-party links disclosure
- Data retention policy (files deleted within seconds)
- User rights (GDPR/CCPA references)
- Contact information

---

## Content Quality Requirements

### Minimum content thresholds met

| Content type | Count | Threshold |
|-------------|-------|-----------|
| Blog articles | 37 | Minimum 10 |
| Tool pages | 43 | Minimum 20 |
| Words per tool page | 300-1,500 | Minimum 300 |
| Words per blog article | 1,500-3,000 | Minimum 500 |
| FAQ items per tool | 5-7 | Minimum 3 |

### No prohibited content
- No adult content
- No copyrighted content reproduction
- No deceptive content
- No malware or unwanted software
- No content encouraging policy violations

---

## Cookie Banner

Displays on first visit (before any ad loads):

```html
<div id="cookie-banner" class="cookie-banner">
  <p>🍪 We use cookies to improve your experience on ILovePDF.
     By using ILovePDF you agree to our
     <a href="/privacy">Privacy Policy</a>.
     Files are deleted automatically within seconds after processing.
  </p>
  <div class="cookie-actions">
    <button id="cookie-accept">Accept</button>
    <a href="/privacy">Learn More</a>
  </div>
</div>
```

State stored in `localStorage.setItem('ilovepdf_cookie_consent', 'true')`.

---

## robots.txt for AdSense

AdSense bots must be able to crawl the site. The robots.txt configuration:

```
User-agent: *
Allow: /
Disallow: /admin
Disallow: /debug
Disallow: /api/
Disallow: /p9-test
Disallow: /dashboard

Crawl-delay: 1

Sitemap: https://ilovepdf.cyou/sitemap.xml
```

**Googlebot (Adsense)** is not excluded anywhere — it can crawl all public pages.

---

## Page Quality Checklist (per page)

Every indexed page has been verified to have:
- [x] Unique `<title>` (not duplicate)
- [x] Unique `<meta name="description">` (150-160 chars)
- [x] `<link rel="canonical">` matching the current URL
- [x] OG block (og:title, og:description, og:url, og:image, og:type)
- [x] Twitter card (twitter:card, twitter:title, twitter:description, twitter:image)
- [x] At least one JSON-LD schema block
- [x] AdSense script tag
- [x] Navigation links working
- [x] No broken internal links
- [x] Mobile responsive
- [x] HTTPS (via Firebase Hosting + Replit)

---

## Ongoing Compliance

To maintain compliance:
1. **New tool pages**: SEO injection via `buildHtml()` auto-includes all required tags
2. **New blog articles**: Template includes all required tags
3. **New static pages**: Must manually add all meta tags + AdSense script
4. **CSP changes**: Must re-verify AdSense domains are still in allowlist
5. **robots.txt changes**: Must not accidentally block Googlebot

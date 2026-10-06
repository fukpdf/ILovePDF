# 15 — INTERNATIONALIZATION (i18n)

## Overview

ILovePDF has a client-side internationalization system that supports multiple languages via `public/js/i18n.js`. Language preference is stored in `localStorage`. A geo-detection API provides a language hint for first-time visitors.

---

## i18n Files

| File | Purpose |
|------|---------|
| `public/js/i18n.js` | Main i18n engine (translations + language switching) |
| `public/js/i18n-ext.js` | Extended translations (additional UI strings) |
| `public/js/global-multilingual-renderer.js` | Renders translated content in rich text areas |
| `public/js/footer-lang.js` | Language selector in footer |

---

## Language Detection

On first visit (no stored preference), i18n.js calls the geo API:

```javascript
// Geo API (server.js)
GET /api/geo
Response: { country: "SA" } or { country: null }

// Reads from CDN headers:
req.headers['cf-ipcountry']        // Cloudflare
req.headers['x-country-code']     // Generic CDN
req.headers['x-vercel-ip-country']  // Vercel
req.headers['x-amz-cf-ipcountry'] // AWS CloudFront
```

Country code → language mapping:
- `SA`, `AE`, `EG`, `MA` → Arabic (RTL)
- `FR`, `BE`, `CH` → French
- `DE`, `AT` → German
- `ES`, `MX`, `AR`, `CO` → Spanish
- `PT`, `BR` → Portuguese
- `IT` → Italian
- `JP` → Japanese
- `CN`, `TW` → Chinese
- `KR` → Korean
- Default → English

---

## Language Storage

```javascript
// Language preference stored in localStorage
localStorage.setItem('ilovepdf_lang', 'ar');

// Auto-applied on page load
const lang = localStorage.getItem('ilovepdf_lang') || 'en';
i18n.setLanguage(lang);
```

---

## Translation System

### Translation Lookup

```javascript
// i18n.t('key') → translated string
i18n.t('upload.title')        // → "Faites glisser votre fichier PDF ici" (fr)
i18n.t('upload.subtitle')     // → "ou cliquez pour parcourir"
i18n.t('process.button')      // → "Fusionner les fichiers PDF"
```

### Translation Coverage

Core UI strings translated for:
- Upload zone text
- Processing overlay text
- Status messages (success/error)
- Button labels
- Navigation menu items
- Footer links
- Auth modal labels
- Error messages
- Tool category names

### RTL Support

For Arabic (and other RTL languages):
```javascript
// Applied to <html> element
document.documentElement.dir = 'rtl';
document.documentElement.lang = 'ar';
```

CSS uses logical properties where possible for automatic RTL adaptation. Some components have explicit `[dir="rtl"]` overrides.

---

## Language Switcher (Footer)

`public/js/footer-lang.js` renders a language selector dropdown in the page footer:

```html
<select id="lang-selector">
  <option value="en">English</option>
  <option value="fr">Français</option>
  <option value="de">Deutsch</option>
  <option value="es">Español</option>
  <option value="pt">Português</option>
  <option value="ar">العربية</option>
  <option value="it">Italiano</option>
  <option value="ja">日本語</option>
  <option value="zh">中文</option>
  <option value="ko">한국어</option>
</select>
```

On change: `i18n.setLanguage(value)` → `localStorage` update → page re-renders translated strings.

---

## SEO Note on Multilingual

The UI is multilingual but URLs are English-only (no `/fr/merge-pdf` variant URLs). This is a known limitation:
- `hreflang` tags are NOT currently implemented
- All tools canonicalize to `https://ilovepdf.cyou/{english-slug}`
- Search engines will index the English version regardless of UI language

This is acceptable at the current stage. Full hreflang implementation would require:
- Language-prefixed URL variants (`/fr/merge-pdf`)
- Server-side language negotiation
- Per-language sitemaps

---

## Server-Side Language

The server currently has no language negotiation. All server-generated HTML (tool page shells, blog articles) is English only. The i18n system is purely client-side string replacement on DOM elements after page load.

This means:
- Initial server-sent HTML: English
- After `i18n.js` runs: strings replaced in DOM
- No flash of untranslated content (strings replaced before paint in most cases)
- Crawlers see English content (which is the SEO-optimized language)

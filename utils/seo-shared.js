// utils/seo-shared.js
// Shared HTML/JSON-LD utilities used by seo.js, seo-comparison.js, seo-guides.js.
// Extracted here to keep each module focused without code duplication.

export function escAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escJsonLd(str) {
  return JSON.stringify(String(str)).slice(1, -1).replace(/<\/(script)/gi, '<\\/$1');
}

export function buildBreadcrumb(crumbs) {
  const visible = crumbs.map((c, i) => {
    const sep  = i === 0 ? '' : `<span class="bc-sep" aria-hidden="true">/</span>`;
    const node = c.url
      ? `<a class="bc-link" href="${escAttr(c.url)}">${escAttr(c.name)}</a>`
      : `<span class="bc-current" aria-current="page">${escAttr(c.name)}</span>`;
    return sep + node;
  }).join('');

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      ...(c.url ? { item: c.url.startsWith('http') ? c.url : `https://ilovepdf.cyou${c.url}` } : {}),
    })),
  };

  return {
    html:   `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${visible}</ol></nav>`,
    jsonLd: `<script type="application/ld+json">${escJsonLd(JSON.stringify(ld))}</script>`,
  };
}

export function adSlot(name, opts = {}) {
  const cls = ['ad-slot', `ad-slot--${name}`, opts.desktopOnly ? 'ad-slot--desktop' : ''].filter(Boolean).join(' ');
  return `<aside class="${cls}" data-ad-slot="${escAttr(name)}" aria-hidden="true"></aside>`;
}

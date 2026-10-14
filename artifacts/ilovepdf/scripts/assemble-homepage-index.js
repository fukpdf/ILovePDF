#!/usr/bin/env node
/**
 * assemble-homepage-index.js
 *
 * Rebuilds public/index.html from public/index-chunks/z0..z3.b64.
 * Run in CI before Firebase deploy so production serves full HTML, not a runtime loader.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_DIR = path.join(ROOT, 'public', 'index-chunks');
const OUT = path.join(ROOT, 'public', 'index.html');

function fail(message) {
  console.error('[assemble-index] ' + message);
  process.exitCode = 1;
}

function optimizeHomepageResourceHints(html) {
  // Warm up external origins used by the homepage without blocking rendering.
  const hints = [
    // Lucide is loaded as a deferred script; warm only that origin. Google
    // Fonts intentionally stays un-preconnected so it cannot compete with
    // first paint; its stylesheet already uses non-blocking optional display.
    ['https://unpkg.com', '<link rel="preconnect" href="https://unpkg.com">']
  ];
  if (!/<\/head\s*>/i.test(html)) throw new Error('homepage head closing tag not found');
  for (const [origin, hint] of hints) {
    const hasHint = html.includes('rel="preconnect" href="' + origin + '"') ||
      html.includes('href="' + origin + '" rel="preconnect"');
    if (!hasHint) html = html.replace(/<\/head\s*>/i, '  ' + hint + '\n</head>');
  }

  // Analytics and decorative effects are non-critical to first content paint.
  // Lower their fetch priority while preserving defer and script execution order.
  const lowPriorityScripts = /(?:analytics-engine|savings-animation|live-stats-sim|community-economy|runtime-changelog|runtime-perf)\.js(?:[?#][^"']*)?/i;
  html = html.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi, tag => {
    if (!lowPriorityScripts.test(tag) || /\bfetchpriority\s*=/i.test(tag)) return tag;
    return tag.replace(/>$/, ' fetchpriority="low">');
  });
  return html;
}

/**
 * Warm the single shared tool/upload document from the homepage without
 * applying tool-only CSS or evaluating tool processors on the homepage.
 * The real tool route still serves SEO-specific metadata from buildHtml().
 */
function addSharedUploadWarmupHints(html) {
  const hints = [
    '<link rel="prefetch" href="/tool.html" as="document" fetchpriority="low" data-shared-upload-prefetch="document">',
    '<link rel="prefetch" href="/css/styles.css?v=20261014-root-scrollbar-fix-v1" as="style" fetchpriority="low" data-shared-upload-prefetch="styles">',
    '<link rel="prefetch" href="/css/editor-workspace.css?v=20261009-custom-feedback-v2" as="style" fetchpriority="low" data-shared-upload-prefetch="editor">',
    '<link rel="prefetch" href="/css/download-page.css?v=20261010-continue-cards-match-popular-v1" as="style" fetchpriority="low" data-shared-upload-prefetch="download">'
  ];
  if (!/<\/head\s*>/i.test(html)) throw new Error('homepage head closing tag not found for shared upload warmup');
  for (const hint of hints) {
    const marker = hint.match(/data-shared-upload-prefetch="([^"]+)"/)[1];
    if (html.includes('data-shared-upload-prefetch="' + marker + '"')) continue;
    html = html.replace(/<\/head\s*>/i, '  ' + hint + '\n</head>');
  }
  return html;
}

function moveExternalScriptAfter(html, targetPattern, anchorPattern) {
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi)];
  const target = tags.find(match => targetPattern.test(match[0]));
  const anchor = tags.find(match => anchorPattern.test(match[0]));
  if (!target || !anchor || target.index > anchor.index) return { html, moved: false };

  html = html.slice(0, target.index) + html.slice(target.index + target[0].length);
  const updatedTags = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi)];
  const updatedAnchor = updatedTags.find(match => anchorPattern.test(match[0]));
  if (!updatedAnchor) return { html, moved: false };
  const insertAt = updatedAnchor.index + updatedAnchor[0].length;
  return {
    html: html.slice(0, insertAt) + '\n' + target[0] + html.slice(insertAt),
    moved: true
  };
}

const TOOL_ONLY_HOMEPAGE_SCRIPTS = new Set([
  '/core/core-manifest.js',
  '/core/shared-constants.js',
  '/core/runtime-contracts.js',
  '/core/runtime-federation.js',
  '/core/ai-runtime.js',
  '/core/runtime-governor.js',
  '/core/runtime-chunk-manifest.js',
  '/js/tool-i18n-bridge.js',
  '/js/runtime-ai-scheduler.js',
  '/js/runtime-worker-factory.js',
  '/js/runtime-wasm-registry.js',
  '/js/runtime-compression-presets.js',
  '/js/runtime-pinned-tools.js',
  '/js/runtime-tool-engagement.js',
  '/js/runtime-failed-log.js',
  // These modules are for tool/runtime telemetry, not the marketing homepage.
  // The Firebase static homepage has no API backend to receive their events.
  '/js/runtime-analytics.js',
  '/js/runtime-identity.js',
  '/js/analytics-sync.js',
  '/js/runtime-recovery.js',
  '/js/runtime-perf-safety.js',
  '/js/n2w-converter.js',
  '/js/runtime-protection.js',
  '/js/runtime-shield-core.js',
  '/js/runtime-shield-integrity.js',
  '/js/runtime-shield-workers.js',
  '/js/runtime-shield-dependency.js',
  '/js/runtime-manifest.js',
  '/js/runtime-compat-validator.js',
  '/js/runtime-rollback.js',
  '/js/runtime-deployment-bind.js',
  '/js/runtime-security-tiers.js',
  '/js/runtime-security-telemetry.js',
  '/js/runtime-sri-engine.js',
  '/js/runtime-foreign-deploy.js',
]);

function dedupeLocalStylesheets(html) {
  const identity = href => {
    try {
      const parsed = new URL(href, 'https://homepage.invalid');
      if (parsed.origin === 'https://homepage.invalid' && parsed.pathname.startsWith('/css/')) {
        return parsed.pathname;
      }
      return href;
    } catch (_) { return href; }
  };
  const attr = (tag, name) => {
    const match = tag.match(new RegExp("\\s" + name + "=[\"']([^\"']+)[\"']", 'i'));
    return match ? match[1] : '';
  };
  const links = [...html.matchAll(/<link\b[^>]*>/gi)];
  const preloadedStyles = new Set(links
    .filter(match => attr(match[0], 'rel').toLowerCase() === 'preload' &&
      attr(match[0], 'as').toLowerCase() === 'style')
    .map(match => identity(attr(match[0], 'href')))
    .filter(Boolean));
  const stylesheets = links.filter(match =>
    attr(match[0], 'rel').toLowerCase().split(/\s+/).includes('stylesheet')
  );
  const lastByIdentity = new Map();
  for (const match of stylesheets) {
    const key = identity(attr(match[0], 'href'));
    if (key && !preloadedStyles.has(key)) lastByIdentity.set(key, match.index);
  }
  const duplicates = stylesheets.filter(match => {
    const key = identity(attr(match[0], 'href'));
    return key && (preloadedStyles.has(key) || lastByIdentity.get(key) !== match.index);
  }).sort((left, right) => right.index - left.index);
  for (const match of duplicates) {
    html = html.slice(0, match.index) + html.slice(match.index + match[0].length);
  }
  return { html, removed: duplicates.length };
}

/**
 * Stabilize the first render before the assembled HTML is written:
 * - Keep the server-rendered nav in place and hydrate its dropdowns. Rebuilding
 *   the nav in chrome.js changes link widths/positions after first paint.
 * - Avoid a late Google-font swap changing nav/button widths and pushing the
 *   homepage sections around on slower or cold-cache visits.
 */
function stabilizeHomepageFirstRender(html) {
  const hasCompleteServerNav =
    /id=["']nav["']/i.test(html) &&
    /id=["']nav-organize["']/i.test(html) &&
    /id=["']nav-convert["']/i.test(html) &&
    /id=["']all-tools-btn["']/i.test(html) &&
    /class=["'][^"']*\bnav-direct\b[^"']*["']/i.test(html);
  let navPreservationEnabled = false;
  if (hasCompleteServerNav && /<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i,
      '<script>window.__ILOVE_PRESERVE_SERVER_NAV = true;</script>\n</head>');
    navPreservationEnabled = true;
  }
  const beforeFontPolicy = html;
  html = html.replace(
    /((?:https?:)?\/\/fonts\.googleapis\.com\/css2?\?[^"'<>]*?display=)swap/gi,
    '$1optional'
  );
  const fontDisplayAdjusted = html !== beforeFontPolicy;
  let fontStylesheetDeferred = false;
  let nonCriticalStylesheetsDeferred = 0;
  html = html.replace(/<link\b[^>]*>/gi, tag => {
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1] || '';
    const rel = (tag.match(/\brel=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
    if ((rel === 'preconnect' || rel === 'dns-prefetch') &&
        /(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com/i.test(href)) return '';
    if (rel.split(/\s+/).includes('stylesheet') &&
        /(?:https?:)?\/\/fonts\.googleapis\.com\/css2?\?/i.test(href)) {
      fontStylesheetDeferred = true;
      return '<link rel="preload" as="style" href="' + href + '" fetchpriority="low" onload="this.onload=null;this.rel=\'stylesheet\'">\n<noscript><link rel="stylesheet" href="' + href + '"></noscript>';
    }
    if (rel.split(/\s+/).includes('stylesheet') &&
        /(?:^|\/)css\/(?:seo-extended|home-footer-v2|ads|responsive-ads)\.css(?:[?#]|$)/i.test(href)) {
      nonCriticalStylesheetsDeferred += 1;
      return '<link rel="preload" as="style" href="' + href + '" fetchpriority="low" onload="this.onload=null;this.rel=\'stylesheet\'">\n<noscript><link rel="stylesheet" href="' + href + '"></noscript>';
    }
    return tag;
  });
  return { html, serverNavFound: hasCompleteServerNav, navPreservationEnabled, fontDisplayAdjusted, fontStylesheetDeferred, nonCriticalStylesheetsDeferred };
}

function removeHomepageOnlyOverlaysAndLaba(html) {
  const before = html;
  // Keep tool-runtime/federation/worker modules on tool routes. The homepage
  // only needs marketing UI, shared chrome, language support, and explicit
  // homepage interactions; these modules remain available in public/tool.html.
  html = html.replace(
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>\s*/gi,
    (tag, src) => {
      const path = src.split(/[?#]/, 1)[0];
      return TOOL_ONLY_HOMEPAGE_SCRIPTS.has(path) ? '' : tag;
    }
  );
  // The shared chrome already owns the footer language selector; the old
  // standalone handler would duplicate events on the homepage.
  html = html.replace(
    /<script\b(?=[^>]*\bsrc=["'][^"']*\/js\/footer-lang\.js(?:[?#][^"']*)?["'])[^>]*>[\s\S]*?<\/script>\s*/gi,
    ''
  );
  // The supplemental locale extension is a ~140KB payload. Base locale JSON
  // already renders the homepage; load this extension only for non-English use.
  html = html.replace(
    /<script\b(?=[^>]*\bsrc=["'][^"']*\/js\/i18n-ext\.js(?:[?#][^"']*)?["'])[^>]*>[\s\S]*?<\/script>\s*/gi,
    ''
  );
  // These scripts/styles belong to the optional Laba chatbot or the one-off
  // announcement modal. Neither is required to render the homepage tool catalogue.
  html = html.replace(
    /<script\b(?=[^>]*\bsrc=["'][^"']*(?:\/laba\/|laba-widget|laba-ai-|homepage-lazy-loader\.js|site-announcement\.js)[^"']*["'])[^>]*>[\s\S]*?<\/script>\s*/gi,
    ''
  );
  html = html.replace(
    /<link\b(?=[^>]*\bhref=["'][^"']*(?:\/laba\/|laba-widget|site-announcement\.css)[^"']*["'])[^>]*>\s*/gi,
    ''
  );
  html = html.replace(/<!--\s*Laba AI Assistant[\s\S]*?-->/gi, '');
  html = html.replace(/<!--\s*Phase 13\/14: AI\/Laba stack[\s\S]*?-->/gi, '');
  html = html.replace(/<!--\s*Site announcement[\s\S]*?-->/gi, '');

  const forbidden = /(?:\/laba\/|laba-widget|laba-ai-|homepage-lazy-loader\.js|site-announcement\.(?:js|css))/i;
  if (forbidden.test(html)) {
    fail('homepage still contains a Laba or delayed announcement asset reference after cleanup');
    return null;
  }
  const remainingToolOnly = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map(match => match[1].split(/[?#]/, 1)[0])
    .filter(path => TOOL_ONLY_HOMEPAGE_SCRIPTS.has(path));
  if (remainingToolOnly.length) {
    fail('homepage still includes tool-only runtime scripts: ' + remainingToolOnly.join(', '));
    return null;
  }
  return { html, changed: html !== before };
}

function injectStaticApiGuard(html) {
  if (html.includes('window.__ILOVE_STATIC_API_GUARD__')) return html;
  const guard = '<script>(function(){var host=String(location.hostname||"").toLowerCase();var testStaticHost=(host==="localhost"||host==="127.0.0.1")&&new URLSearchParams(location.search).get("static-hosting-test")==="1";var staticHost=host.endsWith(".web.app")||host.endsWith(".firebaseapp.com")||host==="ilovepdf.cyou"||testStaticHost;if(!staticHost||typeof window.fetch!=="function"||window.__ILOVE_STATIC_API_GUARD__)return;window.__ILOVE_STATIC_API_GUARD__=true;var nativeFetch=window.fetch;window.fetch=function(input,init){var raw=typeof input==="string"?input:(input&&input.url)||"";try{var url=new URL(raw,location.href);if(url.origin===location.origin&&url.pathname.startsWith("/api/"))return Promise.resolve(new Response(JSON.stringify({available:false,error:"API backend unavailable on static hosting"}),{status:503,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}}));}catch(_){}return nativeFetch.call(this,input,init);};})();</script>';
  const charset = /<meta\b(?=[^>]*\bcharset\s*=)[^>]*>/i.exec(html);
  if (charset) {
    const insertAt = charset.index + charset[0].length;
    return html.slice(0, insertAt) + '\n' + guard + html.slice(insertAt);
  }
  if (!/<head\b[^>]*>/i.test(html)) {
    fail('cannot inject the static-hosting API guard because the homepage head element is missing');
    return null;
  }
  return html.replace(/<head\b[^>]*>/i, head => head + '\n' + guard);
}

function deferHomepageAds(html) {
  const pattern = /<script\b(?=[^>]*\bsrc=["']https?:\/\/pagead2?\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js[^"']*["'])[^>]*>\s*<\/script>/gi;
  let count = 0;
  html = html.replace(pattern, tag => {
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!src) return tag;
    count++;
    // Preserve ad monetization, but don't fetch the large third-party runtime
    // until an ad slot is near the viewport, the visitor scrolls, or a post-load
    // fallback fires. The original tag is removed from the critical request path.
    return '<script>(function(){var src=' + JSON.stringify(src) + ';var loaded=false;function load(){if(loaded)return;loaded=true;var s=document.createElement("script");s.async=true;s.src=src;s.crossOrigin="anonymous";s.onload=function(){if(window.AdManager&&typeof window.AdManager.activateAll==="function")window.AdManager.activateAll();};document.head.appendChild(s);}function watchSlots(){var slots=document.querySelectorAll("[data-ad-slot],.ad-slot,ins.adsbygoogle");if("IntersectionObserver" in window&&slots.length){var observer=new IntersectionObserver(function(entries){if(entries.some(function(e){return e.isIntersecting;})){observer.disconnect();load();}},{rootMargin:"0px"});slots.forEach(function(slot){if(slot.getBoundingClientRect().top>=window.innerHeight)observer.observe(slot);});}}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watchSlots,{once:true});else watchSlots();window.addEventListener("load",function(){setTimeout(load,4500);},{once:true});window.addEventListener("scroll",load,{once:true,passive:true});})();</script>';
  });
  return { html, count };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readLiteralFields(block) {
  const fields = {};
  const pairPattern = /([A-Za-z_$][\w$]*)\s*:\s*'((?:\\.|[^'])*)'/g;
  for (const match of block.matchAll(pairPattern)) {
    fields[match[1]] = match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  return fields;
}

function parseHomepageRegistry(chromeSource, homeSource) {
  const registry = chromeSource.match(/window\.TOOL_GROUPS\s*=\s*\[([\s\S]*?)\n\];/);
  const iconSource = homeSource.match(/const TOOL_ICON_SVGS\s*=\s*\{([\s\S]*?)\n\};/);
  const configSource = homeSource.match(/const CAT_CONFIG\s*=\s*\{([\s\S]*?)\n\};/);
  if (!registry || !iconSource || !configSource) throw new Error('homepage registry/icon/config source is incomplete');

  const groups = [];
  const groupPattern = /\{\s*key\s*:\s*'([^']+)'\s*,\s*title\s*:\s*'[^']*'\s*,\s*items\s*:\s*\[([\s\S]*?)\]\s*\}/g;
  for (const groupMatch of registry[1].matchAll(groupPattern)) {
    const group = { key: groupMatch[1], items: [] };
    for (const itemMatch of groupMatch[2].matchAll(/\{([^{}]*)\}/g)) {
      const item = readLiteralFields(itemMatch[1]);
      if (!item.name || !item.icon || !item.desc) throw new Error('incomplete homepage tool entry in ' + group.key);
      group.items.push(item);
    }
    if (group.items.length) groups.push(group);
  }

  const icons = {};
  for (const match of iconSource[1].matchAll(/'([^']+)'\s*:\s*'((?:\\.|[^'])*)'/g)) {
    icons[match[1]] = match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  const config = {};
  for (const match of configSource[1].matchAll(/(pdf|image|utilities)\s*:\s*\{([^{}]*)\}/g)) {
    config[match[1]] = readLiteralFields(match[2]);
  }
  return { groups, icons, config };
}

function renderHomepageCards(html) {
  const chromePath = path.join(ROOT, 'public', 'js', 'chrome.js');
  const homePath = path.join(ROOT, 'public', 'js', 'home.js');
  if (!fs.existsSync(chromePath) || !fs.existsSync(homePath)) {
    fail('homepage card pre-render requires public/js/chrome.js and public/js/home.js');
    return null;
  }
  let registry;
  try {
    registry = parseHomepageRegistry(fs.readFileSync(chromePath, 'utf8'), fs.readFileSync(homePath, 'utf8'));
  } catch (error) {
    fail('homepage card pre-render could not read the existing tool registry: ' + error.message);
    return null;
  }

  const urlFor = tool => tool.url || (tool.slug ? '/' + tool.slug : '/tool.html?id=' + (tool.tid || ''));
  const badge = prio => {
    const instant = '<span class="tool-badge tool-badge--instant" aria-label="⚡ Instant">⚡ <span data-i18n="badge.instant">Instant</span></span>';
    const advanced = '<span class="tool-badge tool-badge--advanced" aria-label="☁️ Advanced">☁️ <span data-i18n="badge.advanced">Advanced</span></span>';
    if (!prio) return '';
    if (prio === 'compress') return '<span class="tool-badges">' + instant + advanced + '</span>';
    return prio === 'instant' ? instant : advanced;
  };

  const renderSection = (id, groupKeys, type) => {
    const items = registry.groups.filter(group => groupKeys.includes(group.key))
      .flatMap(group => group.items.map(tool => ({ ...tool, _cat: group.key })));
    const cfg = registry.config[type];
    if (!items.length || !cfg?.title) throw new Error('empty tool group or missing category config for ' + id);

    const toolCards = items.map(tool => {
      const tid = tool.tid || (tool.url ? tool.url.replace(/^\/+/, '') : '');
      const titleKey = tid ? 'tools.' + tid + '.title' : '';
      const descKey = tid ? 'tools.' + tid + '.desc' : '';
      const iconKey = tool.icon || 'file-text';
      const sticker = '<span class="tool-name-sticker" aria-hidden="true" data-icon="' + escapeHtml(iconKey) + '">' +
        (registry.icons[iconKey] || registry.icons['file-text'] || '') + '</span>';
      return '<a class="tool" data-cat="' + escapeHtml(tool._cat) + '" data-prio="' + escapeHtml(tool.prio || 'instant') +
        '"' + (tid ? ' data-tid="' + escapeHtml(tid) + '"' : '') + ' href="' + escapeHtml(urlFor(tool)) +
        '"><div class="tool-text"><h4 class="tool-name">' + sticker + '<span class="tool-name-label"' +
        (titleKey ? ' data-i18n="' + escapeHtml(titleKey) + '"' : '') + '>' + escapeHtml(tool.name) +
        '</span></h4><p' + (descKey ? ' data-i18n="' + escapeHtml(descKey) + '"' : '') + '>' +
        escapeHtml(tool.desc) + '</p></div>' + badge(tool.prio) + '</a>';
    }).join('');

    const sectionHtml = '<div class="home-cat-inner"><div class="home-cat-head"><span class="home-cat-ico" style="background:' +
      escapeHtml(cfg.bg) + ';color:' + escapeHtml(cfg.color) + '"><i data-lucide="' + escapeHtml(cfg.icon) +
      '"></i></span><div><h2 class="home-cat-title" id="' + id + '-title">' + escapeHtml(cfg.title) +
      '</h2><p class="home-cat-sub">' + escapeHtml(cfg.sub) + '</p></div></div><div class="tools-grid">' +
      toolCards + '</div></div>';

    const opening = [...html.matchAll(/<section\b[^>]*>/gi)].find(entry =>
      entry[0].includes('id="' + id + '"') || entry[0].includes("id='" + id + "'"));
    if (!opening) throw new Error('homepage section not found: ' + id);
    const closeIndex = html.indexOf('</section>', opening.index + opening[0].length);
    if (closeIndex < 0) throw new Error('homepage section close tag not found: ' + id);
    const sectionEnd = closeIndex + '</section>'.length;
    const existingSection = html.slice(opening.index, sectionEnd);
    const anchors = [...existingSection.matchAll(/<a\b[^>]*>/gi)].map(entry => entry[0])
      .filter(tag => /\bclass=["'][^"']*\btool\b[^"']*["']/i.test(tag));
    const hrefs = new Set(anchors.map(tag => tag.match(/\bhref=["']([^"']+)["']/i)?.[1] || ''));
    const expected = items.map(urlFor);
    if (anchors.length === items.length && expected.every(href => hrefs.has(href))) {
      return { html, count: items.length, changed: false };
    }
    html = html.slice(0, opening.index) + opening[0] + sectionHtml + '</section>' + html.slice(sectionEnd);
    return { html, count: items.length, changed: true };
  };

  try {
    let changed = false;
    let total = 0;
    for (const [id, keys, type] of [
      ['cat-pdf-tools', ['organize','security','edit','convert','advanced'], 'pdf'],
      ['cat-image-tools', ['image'], 'image'],
      ['cat-utilities', ['utilities'], 'utilities']
    ]) {
      const result = renderSection(id, keys, type);
      html = result.html;
      total += result.count;
      changed = changed || result.changed;
    }
    if (total !== registry.groups.reduce((sum, group) => sum + group.items.length, 0)) {
      throw new Error('rendered card count differs from registry count');
    }
    return { html, total, changed };
  } catch (error) {
    fail('homepage card pre-render failed: ' + error.message);
    return null;
  }
}

function normalizeSharedShellAssetUrls(html) {
  const canonicalChromeUrl = '/js/chrome.js?v=20261014-shared-shell-v2';
  const canonicalHeaderCssUrl = '/css/home-header-v2.css?v=20261014-hide-all-scrollbars-v2';
  html = html.replace(/\/js\/chrome\.js(?:\?[^"' >]*)?/g, canonicalChromeUrl);
  html = html.replace(/\/css\/home-header-v2\.css(?:\?[^"' >]*)?/g, canonicalHeaderCssUrl);
  return html;
}

export function assembleHomepageIndex() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const chunkPath = path.join(CHUNK_DIR, 'z' + i + '.b64');
    if (!fs.existsSync(chunkPath)) {
      fail('missing chunk: ' + chunkPath);
      return false;
    }
    const chunk = fs.readFileSync(chunkPath, 'utf8').replace(/\s+/g, '');
    if (!chunk || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) {
      fail('chunk is empty or invalid base64: ' + chunkPath);
      return false;
    }
    parts.push(chunk);
  }

  let html;
  try {
    html = zlib.inflateSync(Buffer.from(parts.join(''), 'base64')).toString('utf8');
  } catch (error) {
    fail('zlib decompress failed: ' + error.message);
    return false;
  }

  html = normalizeSharedShellAssetUrls(html);
  console.log('[assemble-index] normalized compressed homepage shell asset URLs before validation');

  if (!/<!doctype\s+html/i.test(html)) {
    fail('decompressed output is not a full HTML document');
    return false;
  }
  for (const required of ['/js/chrome.js', '/js/home.js', 'home-fast-boot.js']) {
    if (!html.includes(required)) {
      fail('missing required homepage reference: ' + required);
      return false;
    }
  }
  if (html.includes('DecompressionStream')) {
    fail('decompressed output still contains the runtime chunk loader');
    return false;
  }

  const chromeAt = html.indexOf('/js/chrome.js');
  const runtimeAt = html.indexOf('/js/runtime-protection.js');
  if (runtimeAt !== -1 && chromeAt > runtimeAt) {
    fail('critical-path order invalid: chrome.js appears after runtime-protection.js');
    return false;
  }

  const preRendered = renderHomepageCards(html);
  if (!preRendered) return false;
  html = preRendered.html;
  console.log('[assemble-index] pre-rendered ' + preRendered.total + ' homepage tool cards' + (preRendered.changed ? '' : ' (matching markup retained)'));

  const cleanup = removeHomepageOnlyOverlaysAndLaba(html);
  if (!cleanup) return false;
  html = cleanup.html;

  // Static Firebase Hosting has no /api/* backend route. Short-circuit those
  // requests locally instead of downloading tool.html as the wildcard fallback.
  html = injectStaticApiGuard(html);
  if (!html) return false;

  // Ads remain enabled but are activated only when useful, not as a startup cost.
  const adsCleanup = deferHomepageAds(html);
  html = adsCleanup.html;
  if (adsCleanup.count) {
    console.log('[assemble-index] deferred ' + adsCleanup.count + ' AdSense script(s) until a slot approaches view or post-load fallback');
  }

  // De-duplicate active stylesheets against async style preloads and each other.
  const stylesheetCleanup = dedupeLocalStylesheets(html);
  html = stylesheetCleanup.html;
  if (stylesheetCleanup.removed) {
    console.log('[assemble-index] removed ' + stylesheetCleanup.removed + ' duplicate local stylesheet link(s)');
  }

  // Prevent post-paint navigation replacement and late font-swap reflow.
  const firstRender = stabilizeHomepageFirstRender(html);
  html = firstRender.html;
  if (firstRender.serverNavFound && !firstRender.navPreservationEnabled) {
    fail('server-rendered homepage nav found but preservation flag could not be injected');
    return false;
  }
  if (firstRender.navPreservationEnabled) {
    console.log('[assemble-index] enabled server-nav preservation before deferred chrome.js');
  }
  if (firstRender.fontDisplayAdjusted) {
    console.log('[assemble-index] changed Google Fonts display=swap to display=optional to reduce late font reflow');
  }
  if (firstRender.fontStylesheetDeferred) {
    console.log('[assemble-index] made Google Fonts stylesheet non-blocking so system fallback can paint first');
  }
  if (firstRender.nonCriticalStylesheetsDeferred) {
    console.log('[assemble-index] made ' + firstRender.nonCriticalStylesheetsDeferred + ' below-fold/ads stylesheets non-blocking');
  }

  // Catch duplicate stylesheet application after asynchronous first-render transforms.
  const activeStyleHtml = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  const activeStyleLinks = [...activeStyleHtml.matchAll(/<link\b[^>]*>/gi)]
    .filter(match => {
      const tag = match[0];
      const rel = (tag.match(/\srel=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
      const as = (tag.match(/\sas=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
      return rel.split(/\s+/).includes('stylesheet') || (rel === 'preload' && as === 'style');
    })
    .map(match => {
      const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1] || '';
      try {
        const url = new URL(href, 'https://homepage.invalid');
        return url.origin === 'https://homepage.invalid' && url.pathname.startsWith('/css/')
          ? url.pathname : href;
      } catch (_) { return href; }
    }).filter(Boolean);
  if (new Set(activeStyleLinks).size !== activeStyleLinks.length) {
    fail('homepage contains duplicate active stylesheet/preload URLs after optimization');
    return false;
  }

  // chrome.js owns TOOL_GROUPS; execute it before home.js to avoid an empty-registry render.
  const homeMove = moveExternalScriptAfter(
    html,
    /\/js\/home[.]js(?:[?#]|["'])/i,
    /\/js\/chrome[.]js(?:[?#]|["'])/i
  );
  html = homeMove.html;

  // i18n-ext.js waits for RuntimeI18n when the core i18n module is not ready,
  // so it can execute after the first homepage render without losing translations.
  const i18nExtMove = moveExternalScriptAfter(
    html,
    /i18n-ext[.]js/i,
    /\/js\/home[.]js(?:[?#]|["'])/i
  );
  html = i18nExtMove.html;

  // firebase-init.js already schedules Firebase SDK initialization during idle time.
  // Making its external script deferred removes the only parser-blocking script while
  // preserving classic-script execution order and the existing auth readiness promise.
  let firebaseDeferred = false;
  html = html.replace(
    /<script\b(?![^>]*\b(?:defer|async)\b)([^>]*\bsrc=["'][^"']*\/js\/firebase-init\.js(?:[?#][^"']*)?["'][^>]*)>/i,
    (_tag, attrs) => {
      firebaseDeferred = true;
      return '<script defer' + attrs + '>';
    }
  );

  try {
    html = optimizeHomepageResourceHints(html);
    html = addSharedUploadWarmupHints(html);
    console.log('[assemble-index] warmed the shared upload document and tool-only styles at low priority; processors remain out of the homepage path');
    console.log('[assemble-index] added non-blocking external-origin hints and lowered non-critical script fetch priority');
  } catch (error) {
    fail('homepage resource-hint optimization failed: ' + error.message);
    return false;
  }

  const blockingScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi)]
    .filter(match => !/\bdefer\b/i.test(match[0]) && !/\basync\b/i.test(match[0]));
  if (blockingScripts.length) {
    fail('homepage still has parser-blocking external scripts: ' + blockingScripts.length);
    return false;
  }

  fs.writeFileSync(OUT, html, 'utf8');
  console.log('[assemble-index] wrote ' + OUT + ' (' + Buffer.byteLength(html, 'utf8') + ' bytes)');
  console.log('[assemble-index] chunk integrity, full HTML, required scripts, and critical-path order OK');
  console.log('[assemble-index] parser-blocking external scripts: 0' + (firebaseDeferred ? ' (firebase-init deferred)' : ''));
  if (homeMove.moved) console.log('[assemble-index] chrome.js now executes before the homepage renderer');
  if (cleanup.changed) console.log('[assemble-index] removed homepage-only Laba/announcement assets and tool-only runtime modules');
  if (i18nExtMove.moved) console.log('[assemble-index] homepage renderer now executes before the extended translation payload');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!assembleHomepageIndex()) process.exitCode = 1;
}

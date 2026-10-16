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
  const localPath = href => {
    try {
      const parsed = new URL(href, 'https://homepage.invalid');
      return parsed.origin === 'https://homepage.invalid' && parsed.pathname.startsWith('/css/')
        ? parsed.pathname : null;
    } catch (_) { return null; }
  };
  const tags = [...html.matchAll(/<link\b[^>]*>/gi)].filter(match =>
    /\brel=["'][^"']*\bstylesheet\b[^"']*["']/i.test(match[0]) &&
    localPath(match[0].match(/\bhref=["']([^"']+)["']/i)?.[1] || '')
  );
  const lastByPath = new Map();
  for (const match of tags) {
    const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const pathname = href ? localPath(href) : null;
    if (pathname) lastByPath.set(pathname, match.index);
  }
  const duplicates = tags.filter(match => {
    const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const pathname = href ? localPath(href) : null;
    return pathname && lastByPath.get(pathname) !== match.index;
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
  const firstPaintCss = `
    :root{--bg:#f6f7fb;--surface:#fff;--surface-2:#f1f3f9;--border:#e5e8f0;--text:#1a1f36;--text-soft:#5b6478;--text-mute:#8a92a6;--primary:#4f46e5;--primary-2:#7c3aed;--grad:linear-gradient(135deg,#4f46e5 0%,#7c3aed 50%,#9333ea 100%);--header-h:68px;--rail-w:280px}
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0;width:100%;max-width:100%;overflow-x:hidden}
    body{padding-top:var(--header-h);font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-decoration:none}
    button{font:inherit;cursor:pointer}
    .site-header{position:fixed;top:0;left:0;right:0;z-index:1000;height:var(--header-h);background:rgba(255,255,255,.97);border-bottom:1px solid var(--border)}
    .site-header .header-inner{height:var(--header-h);width:100%;padding:0 clamp(16px,3vw,40px);display:flex;align-items:center;gap:24px}
    .site-header .brand{display:flex;align-items:center;gap:10px;white-space:nowrap;color:var(--text);font-size:1.25rem;font-weight:800}
    .site-header .brand-mark{width:34px;height:34px;flex:0 0 34px;display:grid;place-items:center;border-radius:10px;background:var(--grad);color:#fff}
    .site-header .brand-name span{-webkit-background-clip:text;background-clip:text;color:transparent;background-image:var(--grad)}
    .site-header .nav{margin:0 0 0 auto;display:flex;align-items:center;justify-content:center;gap:2px;min-width:0}
    .site-header .nav-direct,.site-header .nav .nav-btn{display:inline-flex;align-items:center;gap:5px;padding:9px 12px;border:0;border-radius:9px;background:transparent;color:var(--text-soft);font-size:.9rem;font-weight:600;white-space:nowrap}
    .site-header .nav .all-tools{background:var(--grad);color:#fff}
    .site-header .header-cta{display:flex;align-items:center;gap:8px}
    .page{width:100%;padding:24px clamp(16px,3vw,40px);display:grid;grid-template-columns:var(--rail-w) minmax(0,1fr);gap:24px;align-items:start}
    .rail{width:var(--rail-w);display:flex;flex-direction:column;gap:16px}
    .rail-sticky{position:sticky;top:80px;display:flex;flex-direction:column;gap:14px}
    .content{min-width:0;display:flex;flex-direction:column;gap:22px}
    .hero{position:relative;overflow:hidden;isolation:isolate;min-height:0;padding:14px 24px;border-radius:20px;background:var(--grad);color:#fff;box-shadow:0 20px 40px rgba(79,70,229,.18)}
    .hero-text{flex:1;min-width:0}
    .hero-eyebrow{display:inline-flex;align-items:center;gap:6px;margin-bottom:8px;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.18);font-size:.68rem;font-weight:600}
    .hero h1{margin:0 0 4px;font-size:clamp(1.05rem,1.8vw,1.4rem);font-weight:800;line-height:1.18;letter-spacing:-.01em}
    .hero p{max-width:680px;margin:0 0 8px;font-size:.82rem;line-height:1.4;opacity:.92}
    .hero-actions{display:flex;flex-wrap:wrap;gap:8px}
    .hero-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;background:#fff;color:var(--primary);font-size:.8rem;font-weight:700;white-space:nowrap}
    .hero-btn.outline{border:1.5px solid rgba(255,255,255,.55);background:transparent;color:#fff}
    .calc-card,.qa-card,.tool{background:#fff;border:1px solid var(--border);border-radius:14px}
    .quick-access{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .qa-card{min-width:0;display:flex;align-items:center;gap:12px;padding:14px;box-shadow:0 4px 16px rgba(31,41,55,.08)}
    .qa-card h3,.qa-card p{margin:0}
    .qa-card h3{font-size:.95rem;font-weight:800}
    .qa-card p{margin-top:3px;color:var(--text-soft);font-size:.78rem;line-height:1.4}
    .qa-ico{width:38px;height:38px;flex:0 0 38px;display:grid;place-items:center;border-radius:11px;background:#eef2ff;color:var(--primary)}
    .tools-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
    .tool{position:relative;display:flex;min-width:0;flex-direction:column;gap:10px;padding:18px 16px;overflow:hidden}
    .tool-text{display:flex;flex-direction:column;gap:4px}
    @media(max-width:1100px){.tools-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.quick-access{gap:10px}}
    @media(max-width:900px){.page{grid-template-columns:minmax(0,1fr);padding:18px 16px}.rail{display:none}.quick-access{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:640px){:root{--header-h:60px}.site-header .header-inner{height:60px;padding:0 14px;gap:10px}.site-header .nav{gap:0}.site-header .nav-direct,.site-header .nav .nav-btn{padding:7px 8px;font-size:.78rem}.site-header .header-cta{gap:4px}.page{padding:14px 12px}.content{gap:16px}.hero{padding:14px 16px;border-radius:15px}.hero-actions{gap:6px}.hero-btn{padding:6px 11px;font-size:.75rem}.quick-access{grid-template-columns:1fr;gap:8px}.qa-card{padding:11px}.tools-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tool{padding:13px 11px}}
  `;
  let criticalStylesInjected = false;
  if (/<\/head>/i.test(html) && !/id=["']homepage-first-paint-css["']/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, match => `${match}\n<style id="homepage-first-paint-css">${firstPaintCss}</style>`);
    criticalStylesInjected = true;
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
      return '<link rel="preload" as="style" href="' + href + '" fetchpriority="low" onload="this.onload=null;this.dataset.preloaded=true">\n<noscript><link rel="stylesheet" href="' + href + '"></noscript>';
    }
    if (rel.split(/\s+/).includes('stylesheet') &&
        /(?:^|\/)css\/(?:seo-extended|home-footer-v2|ads|responsive-ads|home|home-header-v2|economy|community-economy|rtl)\.css(?:[?#]|$)/i.test(href)) {
      nonCriticalStylesheetsDeferred += 1;
      return '<link rel="preload" as="style" href="' + href + '" fetchpriority="low" onload="this.onload=null;this.dataset.preloaded=true">\n<noscript><link rel="stylesheet" href="' + href + '"></noscript>';
    }
    return tag;
  });
  const deferredHomepageScripts = [];
  const headEnd = html.search(/<\/head>/i);
  const bodyEnd = html.search(/<\/body>/i);
  if (headEnd !== -1 && bodyEnd > headEnd) {
    const head = html.slice(0, headEnd + '</head>'.length);
    let body = html.slice(headEnd + '</head>'.length, bodyEnd);
    const tail = html.slice(bodyEnd);
    body = body.replace(/^[\t ]*<script\b(?=[^>]*\bsrc=["'][^"']+["'])[^>]*>[\s\S]*?<\/script>[\t ]*(?:\r?\n|$)/gim, tag => {
      deferredHomepageScripts.push(tag);
      return '';
    });
    if (deferredHomepageScripts.length) {
      const runtimeTemplate = `<template id="ilove-home-runtime-template">${deferredHomepageScripts.join('\n')}</template>`;
      const runtimeLoader = `<script>
        (function () {
          var template = document.getElementById('ilove-home-runtime-template');
          if (!template || window.__ILOVE_HOME_SCRIPTS_STARTED) return;
          var loaderNonce = document.currentScript && document.currentScript.nonce || '';
          var started = false;
          function replayLifecycleEvents() {
            window.__ILOVE_HOME_RUNTIME_READY = true;
            try { document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true })); } catch (_) {}
            try { window.dispatchEvent(new Event('load')); } catch (_) {}
          }
          function applyPreloadedStyles() {
            Array.from(document.querySelectorAll('link[rel="preload"][as="style"]')).forEach(function (link) {
              var enableStylesheet = function () {
                if (link.dataset.stylesheetApplied === 'true') return;
                link.dataset.stylesheetApplied = 'true';
                link.rel = 'stylesheet';
              };
              if (link.dataset.preloaded === 'true') enableStylesheet();
              else link.addEventListener('load', enableStylesheet, { once: true });
            });
          }
          function startRuntime() {
            if (started) return;
            started = true;
            window.__ILOVE_HOME_SCRIPTS_STARTED = true;
            applyPreloadedStyles();
            var jobs = Array.from(template.content.querySelectorAll('script[src]')).map(function (source) {
              return new Promise(function (resolve) {
                var script = document.createElement('script');
                script.async = false;
                Array.from(source.attributes).forEach(function (attr) {
                  if (['async','defer','src'].includes(attr.name.toLowerCase())) return;
                  script.setAttribute(attr.name, attr.value);
                });
                if (!script.nonce && loaderNonce) script.nonce = loaderNonce;
                script.onload = resolve;
                script.onerror = function () { console.warn('[home-loader] script failed:', source.getAttribute('src')); resolve(); };
                script.src = source.getAttribute('src');
                document.head.appendChild(script);
              });
            });
            Promise.all(jobs).then(replayLifecycleEvents);
          }
          function startAfterFirstPaint() {
            if (performance.getEntriesByName('first-contentful-paint').length) {
              startRuntime();
              return;
            }
            var observer;
            if (window.PerformanceObserver) {
              try {
                observer = new PerformanceObserver(function (list) {
                  if (list.getEntries().some(function (entry) { return entry.name === 'first-contentful-paint'; })) {
                    observer.disconnect();
                    startRuntime();
                  }
                });
                observer.observe({ type: 'paint', buffered: true });
              } catch (_) {}
            }
            window.setTimeout(function () {
              if (observer) observer.disconnect();
              startRuntime();
            }, 1500);
          }
          startAfterFirstPaint();
        })();
      </script>`;
      html = head + body + runtimeTemplate + runtimeLoader + tail;
    }
  }
  return { html, serverNavFound: hasCompleteServerNav, navPreservationEnabled, criticalStylesInjected, fontDisplayAdjusted, fontStylesheetDeferred, nonCriticalStylesheetsDeferred, deferredHomepageScripts: deferredHomepageScripts.length };
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

  // Repeated local CSS paths with different query strings still download the same stylesheet.
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

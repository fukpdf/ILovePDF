#!/usr/bin/env node
/**
 * Homepage-only integrity audit.
 * Decompresses committed homepage chunks in memory and never rewrites public/index.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const CHUNK_DIR = path.join(PUBLIC, 'index-chunks');
const failures = [];
const warnings = [];
const pass = (message) => console.log('PASS:', message);
const fail = (message) => { failures.push(message); console.error('FAIL:', message); };
const warn = (message) => { warnings.push(message); console.warn('WARN:', message); };
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function inflateHomepage() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(CHUNK_DIR, 'z' + i + '.b64');
    if (!fs.existsSync(file)) throw new Error('Missing homepage chunk z' + i + '.b64');
    const chunk = fs.readFileSync(file, 'utf8').replace(/\s+/g, '');
    if (!chunk || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) {
      throw new Error('Homepage chunk z' + i + '.b64 is empty or invalid base64');
    }
    parts.push(chunk);
  }
  const html = zlib.inflateSync(Buffer.from(parts.join(''), 'base64')).toString('utf8');
  if (!html.toLowerCase().includes('<!doctype html')) throw new Error('Decompressed homepage is not a full HTML document');
  return html;
}

let sourceHtml;

let html;
try {
  sourceHtml = inflateHomepage();
  pass('all four homepage chunks exist and inflate to a full HTML document');
  html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  if (!html.toLowerCase().includes('<!doctype html') || html.includes('DecompressionStream')) {
    throw new Error('public/index.html is still the runtime loader instead of the assembled production artifact');
  }
  pass('public/index.html is the assembled production artifact, not the runtime loader');
} catch (error) {
  fail(error.message);
  console.error('Homepage deep audit: BLOCKED (cannot inspect assembled artifact)');
  process.exit(1);
}

const chrome = read('public/js/chrome.js');
const config = read('public/js/tools-config.js');
const assembler = read('scripts/assemble-homepage-index.js');

const metaDescriptionTag = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]).find(tag => /\bname=["']description["']/i.test(tag));
const hasMetaDescription = !!metaDescriptionTag && /\bcontent=["'][^"']{20,}["']/i.test(metaDescriptionTag);
const seoInventory = {
  metaDescription: hasMetaDescription,
  canonical: /<link\b[^>]*\brel=["']canonical["']/i.test(html),
  robots: /<meta\b[^>]*\bname=["']robots["']/i.test(html),
  ogTitle: /<meta\b[^>]*\bproperty=["']og:title["']/i.test(html),
  ogDescription: /<meta\b[^>]*\bproperty=["']og:description["']/i.test(html),
  jsonLdBlocks: (html.match(/type=["']application\/ld\+json["']/gi) || []).length
};
console.log('SEO inventory: ' + JSON.stringify(seoInventory));

const staticChecks = [
  ['homepage contains a viewport meta tag', /<meta\s+name=["']viewport["']/i.test(html)],
  ['homepage has a substantive meta description', hasMetaDescription],
  ['homepage has a non-empty title', /<title>\s*[^<]+\s*<\/title>/i.test(html)],
  ['homepage contains universal chrome loader', /src=["'][^"']*\/js\/chrome\.js(?:[?#][^"']*)?["']/i.test(html)],
  ['homepage contains homepage-only logic', /src=["'][^"']*\/js\/home\.js(?:[?#][^"']*)?["']/i.test(html)],
  ['homepage includes the card paint accelerator', /home-fast-boot\.js/.test(html)],
  ['assembler validates the full HTML output', assembler.includes('decompressed output is not a full HTML document')],
  ['homepage source has responsive viewport configuration', /width=device-width/i.test(html)]
];
for (const [label, condition] of staticChecks) condition ? pass(label) : fail(label);

const allScriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const inlineScripts = allScriptTags.filter(match => !/\bsrc\s*=/i.test(match[1]));
const headEnd = html.toLowerCase().indexOf('</head>');
const headScripts = allScriptTags.filter(match => headEnd >= 0 && (match.index ?? 0) < headEnd);
console.log('Script structure: total=' + allScriptTags.length + ', inline=' + inlineScripts.length + ', beforeHeadClose=' + headScripts.length);
inlineScripts.forEach((match, index) => {
  const snippet = (match[2] || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  console.log('INLINE SCRIPT ' + (index + 1) + ': ' + snippet);
});

const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
  .map(match => ({ src: match[1], tag: match[0], index: match.index ?? 0, defer: match[0].toLowerCase().includes(' defer'), async: match[0].toLowerCase().includes(' async') }));
const toolOnlyHomepageScripts = new Set([
  '/core/core-manifest.js', '/core/shared-constants.js', '/core/runtime-contracts.js',
  '/core/runtime-federation.js', '/core/ai-runtime.js', '/core/runtime-governor.js',
  '/core/runtime-chunk-manifest.js', '/js/tool-i18n-bridge.js',
  '/js/runtime-ai-scheduler.js', '/js/runtime-worker-factory.js',
  '/js/runtime-wasm-registry.js', '/js/runtime-compression-presets.js',
  '/js/runtime-pinned-tools.js', '/js/runtime-tool-engagement.js',
  '/js/runtime-failed-log.js'
]);
const toolOnlyScriptRefs = scriptSources
  .map(item => item.src.split(/[?#]/, 1)[0])
  .filter(src => toolOnlyHomepageScripts.has(src));
if (toolOnlyScriptRefs.length) fail('tool-only runtime scripts remain on homepage: ' + toolOnlyScriptRefs.join(', '));
else pass('tool-only runtime, worker, and federation scripts are absent from homepage');

const scriptIndex = (needle) => scriptSources.find(item => item.src.includes(needle))?.index ?? -1;
const chromeAt = scriptIndex('/js/chrome.js');
const runtimeAt = scriptIndex('/js/runtime-protection.js');
if (chromeAt < 0) fail('chrome.js script is absent from assembled homepage');
else if (runtimeAt >= 0 && chromeAt > runtimeAt) fail('chrome.js appears after runtime-protection.js');
else pass('critical script order keeps chrome before runtime protection');
const homeAt = scriptIndex('/js/home.js');
if (chromeAt >= 0 && homeAt >= 0 && chromeAt < homeAt) pass('tool registry source executes before homepage renderer');
else fail('homepage renderer executes before chrome.js tool registry');
const forbiddenHomepageRefs = /(?:\/laba\/|laba-widget|laba-ai-|homepage-lazy-loader\.js|site-announcement\.(?:js|css))/i;
if (forbiddenHomepageRefs.test(html)) fail('assembled homepage still references Laba assets or delayed announcement modal');
else pass('assembled homepage contains no Laba widget, Laba lazy loader, or delayed announcement assets');
const i18nExtAt = scriptIndex('i18n-ext.js');
if (homeAt >= 0 && i18nExtAt >= 0 && homeAt < i18nExtAt) pass('homepage renderer executes before extended translation payload');
else fail('extended translation payload is ahead of the homepage renderer or missing');
if (scriptIndex('footer-lang.js') < 0) pass('duplicate footer language handler is excluded from homepage');
else fail('duplicate footer language handler remains on homepage');

// Static asset references in the assembled HTML must resolve within public/.
const assetRefs = new Set();
for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/gi)) {
  const raw = match[1].trim();
  if (!raw || /^(?:https?:)?\/\//i.test(raw) || /^(?:data:|blob:|mailto:|tel:|javascript:)/i.test(raw)) continue;
  const pathname = raw.split(/[?#]/, 1)[0];
  if (!pathname.startsWith('/')) continue;
  if (!/^\/(?:js|css|assets|images|img|fonts|locales|index-chunks)\//i.test(pathname)) continue;
  assetRefs.add(pathname);
}
const missingAssets = [...assetRefs].filter(asset => !fs.existsSync(path.join(PUBLIC, asset.replace(/^\//, ''))));
if (missingAssets.length) missingAssets.forEach(asset => fail('homepage references missing static asset: ' + asset));
else pass('all ' + assetRefs.size + ' referenced local JS/CSS/image/font/locale assets exist');

// Extract cards from the authoritative shared TOOL_GROUPS declaration.
const groupsMatch = chrome.match(/window\.TOOL_GROUPS\s*=\s*\[([\s\S]*?)\n\];/);
let cardObjects = [];
if (!groupsMatch) {
  fail('cannot locate authoritative window.TOOL_GROUPS catalogue');
} else {
  cardObjects = [...groupsMatch[1].matchAll(/\{([^{}]*)\}/g)]
    .map(match => match[1])
    .filter(source => /\bname\s*:/.test(source) && /\bicon\s*:/.test(source));
}
const readField = (source, field) => {
  const match = source.match(new RegExp("\\b" + field + "\\s*:\\s*(['\"])(.*?)\\1"));
  return match?.[2] ?? null;
};
if (!cardObjects.length) fail('no tool cards found in TOOL_GROUPS');
const names = cardObjects.map(source => readField(source, 'name')).filter(Boolean);
const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
if (duplicateNames.length) fail('duplicate homepage card names: ' + [...new Set(duplicateNames)].join(', '));
else pass('found ' + cardObjects.length + ' unique named homepage card definitions');

const slugMapMatch = config.match(/window\.SLUG_MAP\s*=\s*\{([\s\S]*?)\n\};/);
const slugMap = new Set(slugMapMatch ? [...slugMapMatch[1].matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)].map(match => match[1]) : []);
const toolRegistryMatch = config.match(/const\s+TOOLS\s*=\s*\[([\s\S]*?)\n\];/);
const toolIds = new Set(toolRegistryMatch ? [...toolRegistryMatch[1].matchAll(/\bid\s*:\s*['"]([^'"]+)['"]/g)].map(match => match[1]) : []);
if (!slugMap.size) fail('cannot read SLUG_MAP route inventory from tools-config.js');
if (!toolIds.size) fail('cannot read TOOLS id inventory from tools-config.js');

const routeProblems = [];
const iconProblems = [];
for (const source of cardObjects) {
  const name = readField(source, 'name') || '(unnamed card)';
  const tid = readField(source, 'tid');
  const slug = readField(source, 'slug');
  const url = readField(source, 'url');
  const icon = readField(source, 'icon');
  if (!icon) iconProblems.push(name + ': missing icon');
  if (tid && !toolIds.has(tid)) routeProblems.push(name + ': tool id not found in TOOLS (' + tid + ')');
  if (slug && !slugMap.has(slug)) routeProblems.push(name + ': slug not found in SLUG_MAP (' + slug + ')');
  if (url) {
    const normalized = url.replace(/^\/+|\/+$/g, '');
    if (!slugMap.has(normalized) && !fs.existsSync(path.join(PUBLIC, normalized + '.html'))) {
      routeProblems.push(name + ': URL has no SLUG_MAP or static HTML destination (' + url + ')');
    }
  }
  if (!tid && !slug && !url) routeProblems.push(name + ': no route metadata');
}
if (routeProblems.length) routeProblems.forEach(problem => fail('homepage route mapping: ' + problem));
else pass('all ' + cardObjects.length + ' homepage cards have matching route metadata');
if (iconProblems.length) iconProblems.forEach(problem => fail(problem));
else pass('all ' + cardObjects.length + ' homepage cards define icons');

// Only inspect initial script URLs; no engine files are modified by this audit.
const heavyPattern = /(?:pdf([.]min)?[.]js|pdfjs|pdf[-_.]?lib|pdfium|tesseract|ghostscript|mupdf|libreoffice|opencv|ocr[-_/])/i;
const heavyInitialScripts = scriptSources.filter(item => heavyPattern.test(item.src));
if (heavyInitialScripts.length) heavyInitialScripts.forEach(item => fail('heavy processing resource is in initial homepage script list: ' + item.src));
else pass('no known heavy PDF/OCR/conversion engine appears in initial homepage script URLs');

const initialScriptBytes = scriptSources.reduce((total, item) => {
  const pathname = item.src.split(/[?#]/, 1)[0];
  if (!pathname.startsWith('/')) return total;
  const file = path.join(PUBLIC, pathname.slice(1));
  return fs.existsSync(file) ? total + fs.statSync(file).size : total;
}, 0);
const cssAssets = [...assetRefs].filter(asset => asset.split('?')[0].split('#')[0].toLowerCase().endsWith('.css'));
const initialCssBytes = cssAssets.reduce((total, asset) => {
  const pathname = asset.split('?')[0].split('#')[0];
  const file = path.join(PUBLIC, pathname.startsWith('/') ? pathname.slice(1) : pathname);
  return fs.existsSync(file) ? total + fs.statSync(file).size : total;
}, 0);
const sizedScripts = scriptSources.map(item => {
  const pathname = item.src.split(/[?#]/, 1)[0];
  const file = pathname.startsWith('/') ? path.join(PUBLIC, pathname.slice(1)) : null;
  return { src: item.src, bytes: file && fs.existsSync(file) ? fs.statSync(file).size : 0 };
}).sort((a, b) => b.bytes - a.bytes);
console.log('Homepage audit summary: cards=' + cardObjects.length + ', scripts=' + scriptSources.length + ', initialScriptBytes=' + initialScriptBytes + ', cssFiles=' + cssAssets.length + ', initialCssBytes=' + initialCssBytes + ', staticAssets=' + assetRefs.size + ', warnings=' + warnings.length + ', failures=' + failures.length);
const blockingScripts = scriptSources.filter(item => !item.defer && !item.async);
console.log('Initial script scheduling: blocking=' + blockingScripts.length + ', defer=' + scriptSources.filter(item => item.defer).length + ', async=' + scriptSources.filter(item => item.async).length);
if (blockingScripts.length) fail('homepage contains parser-blocking external scripts: ' + blockingScripts.map(item => item.src).join(', '));
else pass('all external homepage scripts are deferred or async');
console.log('All initial script references:');
sizedScripts.forEach(item => {
  const source = scriptSources.find(script => script.src === item.src);
  const mode = source ? (source.async ? 'async' : source.defer ? 'defer' : 'BLOCKING') : 'unknown';
  console.log('SCRIPT ' + mode + ' ' + item.bytes + ' bytes ' + item.src);
});
if (failures.length) {
  console.error('Homepage deep audit: FAILED');
  process.exit(1);
}
console.log('Homepage deep audit: PASSED (static/source checks only; browser, viewport, and performance metrics are not covered)');

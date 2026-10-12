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
  if (/<script\b[^>]*\bsrc=["'][^"']*\/js\/i18n-ext\.js/i.test(html)) {
    fail('supplemental locale payload is still in the homepage initial script list');
  } else if (!/function loadExtendedI18n\s*\(/.test(fs.readFileSync(path.join(PUBLIC, 'js/chrome.js'), 'utf8'))) {
    fail('homepage locale payload was removed without a lazy loader');
  } else {
    pass('supplemental locale payload is lazy-loaded, not part of initial homepage requests');
  }
} catch (error) {
  fail(error.message);
  console.error('Homepage deep audit: BLOCKED (cannot inspect assembled artifact)');
  process.exit(1);
}

const chrome = read('public/js/chrome.js');
const homeSource = read('public/js/home.js');
const config = read('public/js/tools-config.js');
const assembler = read('scripts/assemble-homepage-index.js');
const serverSource = read('server.js');
const firebaseConfig = JSON.parse(read('firebase.json'));
const packageConfig = JSON.parse(read('package.json'));

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

const stylesheetAuditHtml = html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
const localStylesheetPaths = [...stylesheetAuditHtml.matchAll(/<link\b[^>]*>/gi)]
  .map(match => match[0])
  .filter(tag => /\brel=["'][^"']*\bstylesheet\b[^"']*["']/i.test(tag))
  .map(tag => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
  .filter(href => {
    try {
      const parsed = new URL(href, 'https://homepage.invalid');
      return parsed.origin === 'https://homepage.invalid' && parsed.pathname.startsWith('/css/');
    } catch (_) { return false; }
  })
  .map(href => new URL(href, 'https://homepage.invalid').pathname);
const duplicateStylesheets = localStylesheetPaths.filter((href, index) => localStylesheetPaths.indexOf(href) !== index);
if (duplicateStylesheets.length) fail('duplicate local stylesheet requests remain: ' + [...new Set(duplicateStylesheets)].join(', '));
else pass('no duplicate local stylesheet URLs remain in assembled homepage');
const staticHomepageCardCount = [...html.matchAll(/<a\b[^>]*>/gi)]
  .map(match => match[0])
  .filter(tag => /\bclass=["'][^"']*\btool\b[^"']*["']/i.test(tag)).length;
if (staticHomepageCardCount !== 41) fail('assembled homepage must contain all 41 tool cards before JavaScript; found ' + staticHomepageCardCount);
else pass('assembled homepage contains all 41 tool cards in initial HTML');

const staticChecks = [
  ['homepage contains a viewport meta tag', /<meta\s+name=["']viewport["']/i.test(html)],
  ['homepage has a substantive meta description', hasMetaDescription],
  ['homepage has a non-empty title', /<title>\s*[^<]+\s*<\/title>/i.test(html)],
  ['homepage contains universal chrome loader', /src=["'][^"']*\/js\/chrome\.js(?:[?#][^"']*)?["']/i.test(html)],
  ['homepage contains homepage-only logic', /src=["'][^"']*\/js\/home\.js(?:[?#][^"']*)?["']/i.test(html)],
  ['homepage includes the card paint accelerator', /home-fast-boot\.js/.test(html)],
  ['homepage short-circuits missing Firebase API routes instead of downloading tool.html', html.includes('__ILOVE_STATIC_API_GUARD__') && assembler.includes('injectStaticApiGuard')],
  ['static API guard is inserted after the complete charset meta tag', (() => { const meta = /<meta\b(?=[^>]*\bcharset\s*=)[^>]*>/i.exec(html); const guardAt = html.indexOf('__ILOVE_STATIC_API_GUARD__'); return !!meta && guardAt > meta.index + meta[0].length; })()],
  ['homepage defers AdSense loading until an ad slot is near view or post-load fallback', !/<script\b[^>]*\bsrc=["']https?:\/\/pagead2?\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i.test(html) && html.includes('setTimeout(load,4500)')],
  ['homepage excludes tool-only analytics and identity scripts', !/src=["'][^"']*\/js\/runtime-analytics\.js/i.test(html) && !/src=["'][^"']*\/js\/runtime-identity\.js/i.test(html)],
  ['tool page has the same static-hosting API guard', read('public/tool.html').includes('__ILOVE_STATIC_API_GUARD__')],
  ['tool page defers AdSense until slot visibility or post-load fallback', !/<script\b[^>]*\bsrc=["']https?:\/\/pagead2?\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i.test(read('public/tool.html')) && read('public/tool.html').includes('setTimeout(loadAds, 4500)')],
  ['local benchmark server compresses text assets with gzip', read('scripts/homepage-test-server.js').includes('createGzip') && read('scripts/homepage-test-server.js').includes("'Content-Encoding': 'gzip'")],
  ['below-fold catalogues defer offscreen rendering with intrinsic size', read('public/css/home.css').includes('content-visibility: auto') && read('public/css/home.css').includes('contain-intrinsic-size: auto')],
  ['assembler validates the full HTML output', assembler.includes('decompressed output is not a full HTML document')],
  ['Firebase Hosting assembles the static homepage before deployment', String(firebaseConfig.hosting?.predeploy || '').includes('npm run build')],
  ['npm build runs the homepage assembler rather than a placeholder command', packageConfig.scripts?.build === 'npm run build:homepage' && String(packageConfig.scripts?.['build:homepage'] || '').includes('assemble-homepage-index.js')],
  ['Node server assembles homepage before static middleware', serverSource.includes('assembleHomepageIndex()') && serverSource.indexOf('assembleHomepageIndex()') < serverSource.indexOf('app.use(express.static(PUBLIC_DIR')],
  ['homepage source has responsive viewport configuration', /width=device-width/i.test(html)],
  ['homepage navigation preservation is enabled before paint or detected from the existing server nav', /window\.__ILOVE_PRESERVE_SERVER_NAV\s*=\s*true/.test(html) || (/const preserveHomepageNav\s*=\s*!!\(/.test(chrome) && /window\.__ILOVE_PRESERVE_SERVER_NAV\s*=\s*preserveHomepageNav/.test(chrome) && /const findNavItem\s*=/.test(chrome))],
  ['assembler includes first-render layout stabilization', assembler.includes('stabilizeHomepageFirstRender')],
  ['header refresh preserves server-rendered nav even after locale changes', chrome.includes('if (window.__ILOVE_PRESERVE_SERVER_NAV)') && !chrome.includes('if (window.__ILOVE_PRESERVE_SERVER_NAV && !forceRefresh)')],
  ['Google Fonts uses optional display to avoid late font-swap reflow', /fonts\.googleapis\.com\/css2?[^"']*display=optional/i.test(html)],
  ['Google Fonts stylesheet is discovered early with preconnects to prevent late font-swap CLS', (() => { const visibleHtml = html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ''); return /<link\b(?=[^>]*\srel=["']stylesheet["'])(?=[^>]*\shref=["'](?:https?:)?\/\/fonts\.googleapis\.com\/css2?\?[^"']*display=optional)[^>]*>/i.test(visibleHtml) && /<link\b(?=[^>]*\srel=["']preconnect["'])(?=[^>]*\shref=["'](?:https?:)?\/\/fonts\.googleapis\.com)[^>]*>/i.test(visibleHtml) && /<link\b(?=[^>]*\srel=["']preconnect["'])(?=[^>]*\shref=["'](?:https?:)?\/\/fonts\.gstatic\.com)[^>]*>/i.test(visibleHtml); })()],
  ['below-fold SEO, footer, and ad stylesheets are non-blocking', (() => { return ['/css/seo-extended.css', '/css/home-footer-v2.css', '/css/ads.css', '/css/responsive-ads.css'].every(path => { const tag = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]).find(candidate => candidate.includes(path) && /\srel=["']preload["']/.test(candidate)); return !!tag && /\sas=["']style["']/.test(tag) && /\sfetchpriority=["']low["']/.test(tag); }); })()],
  ['tool page Google Fonts stylesheet is non-blocking', read('public/tool.html').includes('fetchpriority="low"') && read('public/tool.html').includes("this.rel='stylesheet'")],
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
  '/js/runtime-failed-log.js',
  '/js/analytics-sync.js', '/js/runtime-recovery.js', '/js/runtime-perf-safety.js',
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
if (i18nExtAt === -1 && /function\s+loadExtendedI18n\s*\(/.test(chrome)) {
  pass('supplemental locale payload is excluded from initial HTML and loaded on demand');
} else {
  fail('supplemental locale payload must be lazy-loaded outside the initial script list');
}
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
  const match = source.match(new RegExp("\\b" + field + "\s*:\s*(['\"])(.*?)\\1"));
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

const iconMapMatch = homeSource.match(/const TOOL_ICON_SVGS\s*=\s*\{([\s\S]*?)\n\};/);
const availableIcons = new Set(iconMapMatch ? [...iconMapMatch[1].matchAll(/'([^']+)'\s*:/g)].map(match => match[1]) : []);
if (!availableIcons.size) fail('cannot read inline homepage SVG icon map');
const missingCardIcons = cardObjects.map(source => ({ name: readField(source, 'name'), icon: readField(source, 'icon') }))
  .filter(item => item.icon && !availableIcons.has(item.icon));
if (missingCardIcons.length) missingCardIcons.forEach(item => fail(item.name + ': icon has no inline SVG (' + item.icon + ')'));
else pass('all ' + cardObjects.length + ' homepage card icons resolve to real inline SVGs');

const iconsByTool = new Map();
for (const source of cardObjects) {
  const name = readField(source, 'name') || '(unnamed card)';
  const icon = readField(source, 'icon');
  if (!icon) continue;
  if (!iconsByTool.has(icon)) iconsByTool.set(icon, []);
  iconsByTool.get(icon).push(name);
}
const duplicateToolIcons = [...iconsByTool.entries()].filter(([, toolNames]) => toolNames.length > 1);
if (duplicateToolIcons.length) duplicateToolIcons.forEach(([icon, toolNames]) => fail('duplicate homepage tool icon "' + icon + '": ' + toolNames.join(', ')));
else pass('all ' + cardObjects.length + ' homepage tools use distinct icon identities');

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
if (initialScriptBytes > 720000) fail('homepage initial JS budget exceeded: ' + initialScriptBytes + ' bytes (budget 720000)');
else pass('homepage initial JS payload is within the 720KB performance budget (' + initialScriptBytes + ' bytes)');
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

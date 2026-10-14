import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.resolve(process.cwd(), 'public');
const canonicalChromeUrl = '/js/chrome.js?v=20261014-shared-shell-v2';
const htmlFiles = fs.readdirSync(publicDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
  .map(entry => entry.name);

assert.ok(htmlFiles.includes('index.html'), 'Homepage HTML must exist.');
assert.ok(htmlFiles.includes('tool.html'), 'Tool shell HTML must exist.');

const chromeUsers = [];
for (const file of htmlFiles) {
  const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
  const urls = [...source.matchAll(/src=["']([^"']*\/js\/chrome\.js[^"']*)["']/g)]
    .map(match => match[1]);
  if (!urls.length) continue;
  chromeUsers.push(file);
  for (const url of urls) {
    assert.equal(
      url,
      canonicalChromeUrl,
      `${file} must use the one canonical chrome.js URL; got ${url}`
    );
  }
}
assert.ok(chromeUsers.includes('index.html'), 'Homepage must load shared chrome.');
assert.ok(chromeUsers.includes('tool.html'), 'Tool shell must load shared chrome.');

const toolHtml = fs.readFileSync(path.join(publicDir, 'tool.html'), 'utf8');
const directScriptCount = [...toolHtml.matchAll(/<script\b[^>]*\ssrc=["'][^"']+["'][^>]*>\s*<\/script>/gi)].length;
const lazyScriptCount = [...toolHtml.matchAll(/data-lazy-src=["'][^"']+["']/g)].length;
assert.ok(directScriptCount <= 30, 'Shared upload HTML must keep its critical script path small; found ' + directScriptCount + ' direct external scripts.');
assert.ok(lazyScriptCount >= 150, 'Runtime/processor support scripts must remain demand-loaded; found ' + lazyScriptCount + ' lazy scripts.');
assert.match(toolHtml, /SharedToolRuntimeBoot/, 'Shared upload shell must expose its on-demand runtime boot loader.');
assert.match(toolHtml, /document\.addEventListener\('change',[\s\S]*?isFileInput/, 'File selection must wait for the ordered runtime stack before dispatching the upload change.');
assert.match(toolHtml, /data-shared-header-css="1"/, 'Shared header CSS must stay in the first-paint HTML.');
assert.match(toolHtml, /data-shared-footer-css="1"/, 'Shared footer CSS must stay in the first-paint HTML.');
assert.ok(!toolHtml.includes('data-tool-worker-prefetch'), 'Tool workers must not be prefetched during idle time before user action.');

const chromeSource = fs.readFileSync(path.join(publicDir, 'js/chrome.js'), 'utf8');
assert.match(
  chromeSource,
  /const existingCanonicalFooter = isHomepage &&/,
  'Only the homepage may preserve its server-rendered footer; other pages must normalize to the canonical footer.'
);
assert.match(
  chromeSource,
  /const currentFooters = \[\.\.\.document\.querySelectorAll\('footer\.footer'\)\]/,
  'Shared shell must enumerate footers so duplicate footers can be removed.'
);

const sharedHeaderUrl = '/css/home-header-v2.css?v=20261014-hide-all-scrollbars-v2';
const sharedFooterUrl = '/css/home-footer-v2.css?v=20261014-shared-footer-v1';
for (const file of ['index.html', 'tool.html']) {
  const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.ok(
    source.includes(sharedHeaderUrl),
    file + ' must load the cache-busted shared stylesheet that hides nested scrollbars.'
  );
}

for (const file of ['index.html', 'tool.html']) {
  const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.ok(source.includes(sharedFooterUrl), file + ' must use the canonical cache-busted shared footer stylesheet URL.');
  const activeSource = source.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  assert.doesNotMatch(activeSource, /href=["'][^"']*\/css\/home-footer-v2\.css["']/i,
    file + ' must not leave the shared footer stylesheet unversioned.');
}

const homeCss = fs.readFileSync(path.resolve(process.cwd(), 'public/css/home.css'), 'utf8');
const activeHomeCss = homeCss.replace(/\/\*[\s\S]*?\*\//g, '');
assert.doesNotMatch(
  activeHomeCss,
  /(?:^|[,\s])\.(?:drawer(?:-back|-panel|-close|-top|-sec(?:-title)?|-auth)?|header-cta|hamburger)(?=[\s.:#[,{]|$)/m,
  'Homepage CSS must not retain legacy drawer/header-CTA/hamburger selectors that the canonical shared chrome no longer renders.'
);
assert.doesNotMatch(
  homeCss,
  /@keyframes\s+slideIn\s*\{/,
  'Homepage CSS must not retain the unused legacy drawer slide animation.'
);

const chromeJs = fs.readFileSync(path.join(publicDir, 'js/chrome.js'), 'utf8');
assert.ok(
  chromeJs.includes(sharedHeaderUrl),
  'Pages that inject the shared header stylesheet must use the same cache-busted URL.'
);
assert.ok(chromeJs.includes(sharedFooterUrl), 'Pages that inject the shared footer stylesheet must use the canonical cache-busted URL.');

const sharedHeaderCss = fs.readFileSync(path.join(publicDir, 'css/home-header-v2.css'), 'utf8');
assert.match(
  sharedHeaderCss,
  /body \* \{[\s\S]*?scrollbar-width:\s*none\s*!important;/,
  'Shared shell stylesheet must suppress visible scrollbars on nested page containers, not only html/body.'
);
assert.match(
  sharedHeaderCss,
  /body \*::-webkit-scrollbar \{[\s\S]*?display:\s*none\s*!important;/,
  'Shared shell stylesheet must suppress WebKit scrollbars on nested containers.'
);

const homepageAssembler = fs.readFileSync(path.resolve(process.cwd(), 'scripts/assemble-homepage-index.js'), 'utf8');
assert.match(
  homepageAssembler,
  /function normalizeSharedShellAssetUrls\(html\)/,
  'Homepage assembly must normalize stale cache-busting URLs embedded in compressed source chunks.'
);
assert.ok(
  homepageAssembler.includes("const canonicalFooterCssUrl = '/css/home-footer-v2.css?v=20261014-shared-footer-v1';"),
  'Homepage assembly must normalize the shared footer stylesheet to the cache-busted URL.'
);
assert.match(
  homepageAssembler,
  /html = normalizeSharedShellAssetUrls\(html\)/,
  'Homepage asset normalization must run before the assembled HTML is validated and written.'
);
for (const marker of ['data-shared-upload-prefetch="document"', 'data-shared-upload-prefetch="styles"', 'data-shared-upload-prefetch="editor"', 'data-shared-upload-prefetch="download"']) {
  assert.ok(homepageAssembler.includes(marker), 'Homepage assembler must warm the shared upload shell resource: ' + marker);
}
assert.match(homepageAssembler, /addSharedUploadWarmupHints\(html\)/, 'Homepage assembly must inject the shared upload warmup hints.');
const warmupHelper = homepageAssembler.slice(
  homepageAssembler.indexOf('function addSharedUploadWarmupHints'),
  homepageAssembler.indexOf('function moveExternalScriptAfter')
);
assert.ok(warmupHelper && !warmupHelper.includes('tool-page.js'), 'The warmup helper must not inject the tool-page controller or processors.');

const sharedSpecialUploadCssUrl = '/css/special-upload-flow.css?v=20261014-shared-upload-v1';
const sharedSpecialUploadCss = fs.readFileSync(path.join(publicDir, 'css/special-upload-flow.css'), 'utf8');
const sharedSpecialUploadJs = fs.readFileSync(path.join(publicDir, 'js/special-upload-flow.js'), 'utf8');
assert.match(sharedSpecialUploadJs, /function renderSharedDropzones\(\)/, 'Special tools must render their upload area from one shared component.');
assert.match(sharedSpecialUploadJs, /renderSharedDropzones\(\);[\s\S]*SharedSpecialUpload/, 'Shared upload component must render synchronously before tool-specific event handlers run.');
assert.match(sharedSpecialUploadCss, /\.ilpdf-special-dropzone\s*\{/, 'Shared upload stylesheet must own the single dropzone style definition.');
for (const [file, zoneId, inputId, browseId] of [
  ['image-compressor.html', 'ic-dropzone', 'ic-file-input', 'ic-browse-btn'],
  ['image-converter.html', 'iconv-dropzone', 'iconv-file-input', 'iconv-browse-btn'],
  ['zip-builder.html', 'zip-dropzone', 'zip-file-input', 'zip-browse-btn']
]) {
  const source = fs.readFileSync(path.join(publicDir, file), 'utf8');
  assert.ok(source.includes(sharedSpecialUploadCssUrl), file + ' must use the shared upload stylesheet.');
  assert.ok(source.includes('data-special-upload-mount'), file + ' must mount the shared upload component.');
  for (const id of [zoneId, inputId, browseId]) {
    assert.ok(source.includes(id), file + ' must preserve the tool-specific DOM contract for ' + id + '.');
  }
  assert.ok(!source.includes('.ilpdf-special-dropzone{'), file + ' must not duplicate shared dropzone CSS inline.');
  assert.ok(!source.includes('class="ilpdf-special-dropzone"'), file + ' must not duplicate upload-zone markup.');
}

const swSource = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
assert.match(swSource, /const CACHE_VERSION = 'v8';/, 'Service-worker cache version must be rotated with this cache contract.');
assert.match(swSource, /if \(path === '\/js\/chrome\.js'\)/, 'Shared chrome must use the explicit cache-first route.');
assert.match(swSource, /await cache\.put\(request, response\.clone\(\)\)/, 'Asset cache write must complete before the first response returns.');

// All root HTML pages must avoid applying/preloading the same stylesheet URL twice.
// Ignore noscript fallbacks: only those links are active when JavaScript is disabled.
for (const file of htmlFiles) {
  const source = fs.readFileSync(path.join(publicDir, file), 'utf8')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  const styleUrls = [...source.matchAll(/<link\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => {
      const rel = (tag.match(/\srel=["']([^"']+)["']/i) || [])[1] || '';
      const as = (tag.match(/\sas=["']([^"']+)["']/i) || [])[1] || '';
      return rel.toLowerCase().split(/\s+/).includes('stylesheet') ||
        (rel.toLowerCase() === 'preload' && as.toLowerCase() === 'style');
    })
    .map(tag => (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1])
    .filter(Boolean);
  assert.equal(new Set(styleUrls).size, styleUrls.length,
    file + ' must not apply/preload the same stylesheet URL more than once.');
}

console.log(`[shared-shell] PASS — ${chromeUsers.length} HTML pages use the canonical chrome URL; shared shell and cache guards are present.`);


// Tool shell performance regression guard: one active stylesheet per URL.
// Duplicate print/onload + regular links cause the same CSS to be parsed/applied twice.
const toolStyles = [...toolHtml.matchAll(/<link\b[^>]*>/gi)]
  .map(match => match[0])
  .filter(tag => /\srel=[\"'](?:stylesheet|preload)[\"']/i.test(tag) &&
    (/\srel=[\"']stylesheet[\"']/i.test(tag) || /\srel=[\"']preload[\"'][^>]*as=[\"']style[\"']/i.test(tag)))
  .map(tag => (tag.match(/\bhref=[\"']([^\"']+)[\"']/i) || [])[1])
  .filter(Boolean);
assert.equal(new Set(toolStyles).size, toolStyles.length,
  'Tool shell must not apply/preload the same stylesheet URL more than once.');
assert.ok(toolStyles.includes('/css/styles.css?v=20261014-root-scrollbar-fix-v1'), 'Tool shell must retain the primary styles.css.');
assert.ok(toolStyles.includes('/css/home.css?v=20261014-root-scrollbar-fix-v1'), 'Tool shell must retain home.css.');

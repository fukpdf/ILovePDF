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

const swSource = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
assert.match(swSource, /const CACHE_VERSION = 'v8';/, 'Service-worker cache version must be rotated with this cache contract.');
assert.match(swSource, /if \(path === '\/js\/chrome\.js'\)/, 'Shared chrome must use the explicit cache-first route.');
assert.match(swSource, /await cache\.put\(request, response\.clone\(\)\)/, 'Asset cache write must complete before the first response returns.');

console.log(`[shared-shell] PASS — ${chromeUsers.length} HTML pages use the canonical chrome URL; shared shell and cache guards are present.`);

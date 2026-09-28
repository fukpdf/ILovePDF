#!/usr/bin/env node
// Phase 5 bulk page/i18n coverage gate.
// Units 74-85: static-page loading, shared chrome/i18n presence,
// translation hook ordering, tool-directory hydration, and duplicate-runtime
// protection. This is an audit gate; it does not alter processing behavior.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fail = [];
const pass = [];
const publicRoot = path.join(ROOT, 'public');

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const htmlFiles = walk(publicRoot)
  .filter(p => p.endsWith('.html'))
  .map(p => path.relative(ROOT, p).replace(/\\/g, '/'));

const expectedSpecial = [
  'public/index.html',
  'public/tools.html',
  'public/tool.html',
  'public/about.html',
  'public/blog.html',
  'public/privacy.html',
  'public/terms.html',
  'public/disclaimer.html',
  'public/offline.html',
  'public/currency-converter.html',
  'public/numbers-to-words.html',
  'public/n2w.html',
  'public/image-compressor.html',
  'public/image-converter.html',
  'public/qr-code-generator.html',
  'public/barcode-generator.html',
  'public/zip-builder.html'
];

if (htmlFiles.length < 50) fail.push('74 public HTML inventory unexpectedly dropped below 50 pages.');
else pass.push('74 public HTML inventory is populated: ' + htmlFiles.length + ' pages.');

for (const rel of htmlFiles) {
  const source = read(rel);
  const hasChrome = /\/js\/chrome\.js/.test(source) || /\/js\/chrome-shim\.js/.test(source);
  const hasI18n = /\/js\/i18n\.js/.test(source);
  if (!hasChrome && !isAdmin && !isOffline) fail.push('75 shared chrome missing: ' + rel);
  if (!hasI18n) fail.push('75 RuntimeI18n loader missing: ' + rel);

  const i18nPos = source.search(/\/js\/i18n\.js/);
  const chromePos = source.search(/\/js\/chrome(?:-shim)?\.js/);
  if (hasChrome && hasI18n && i18nPos >= 0 && chromePos >= 0 && i18nPos > chromePos) {
    fail.push('76 i18n.js is loaded after shared chrome: ' + rel);
  }

  const runtimeRefs = (source.match(/\/js\/i18n\.js/g) || []).length;
  if (runtimeRefs > 1) fail.push('77 duplicate i18n.js script reference: ' + rel);

  const chromeRefs = (source.match(/\/js\/chrome\.js/g) || []).length;
  if (chromeRefs > 1) fail.push('77 duplicate chrome.js script reference: ' + rel);
}

if (!fail.some(x => x.startsWith('75 '))) pass.push('75 every public-facing HTML page loads shared chrome and RuntimeI18n; admin/offline shells remain intentionally exempt from shared chrome.');
if (!fail.some(x => x.startsWith('76 '))) pass.push('76 page script ordering keeps RuntimeI18n available before shared chrome.');
if (!fail.some(x => x.startsWith('77 '))) pass.push('77 no public HTML page duplicates the core i18n/chrome runtime.');

for (const rel of expectedSpecial) {
  if (!htmlFiles.includes(rel)) fail.push('78 expected special page missing from public inventory: ' + rel);
}

const toolPage = read('public/tool.html');
const toolsPage = read('public/tools.html');
const home = read('public/index.html');

if (!/tool-i18n-bridge\.js/.test(toolPage)) fail.push('79 tool.html is missing the tool i18n bridge.');
else pass.push('79 tool.html loads the tool i18n bridge.');

if (!/tool-i18n-bridge\.js/.test(home)) fail.push('80 homepage is missing the tool i18n bridge.');
else pass.push('80 homepage loads the tool i18n bridge.');

if (!/data-i18n=/.test(home) || !/data-i18n=/.test(toolPage)) {
  fail.push('81 canonical pages do not expose semantic data-i18n hooks.');
} else pass.push('81 canonical homepage/tool shell expose semantic translation hooks.');

if (!/RuntimeI18n\.patch\(container\)/.test(read('public/js/tools-page.js'))) {
  fail.push('82 tools directory does not patch dynamically rendered tool cards.');
} else pass.push('82 tools directory patches newly rendered tool cards immediately.');

const homeJs = read('public/js/home.js');
if (!/RuntimeI18n\.patch\(root\)/.test(homeJs) || !/RuntimeI18n\.patch\(el\)/.test(homeJs)) {
  fail.push('83 homepage dynamic tool sections lack direct RuntimeI18n patching.');
} else pass.push('83 homepage dynamic sections use direct RuntimeI18n patching.');

const bridge = read('public/js/tool-i18n-bridge.js');
if (!/humanisedFallback/.test(bridge) || !/data-tid/.test(bridge) || !/i18n:change/.test(bridge)) {
  fail.push('84 tool i18n bridge is missing its hydration-safe/canonical-ID/change-event safeguards.');
} else pass.push('84 tool i18n bridge retains canonical-ID, fallback-safety, and change-event safeguards.');

const i18n = read('public/js/i18n.js');
if (!/new MutationObserver/.test(i18n) || !/refreshDynamic: function \(\)/.test(i18n)) {
  fail.push('85 RuntimeI18n dynamic hydration contract is incomplete.');
} else pass.push('85 RuntimeI18n retains observer-backed dynamic hydration and refresh API.');

if (fail.length) {
  console.error('[FAIL] Phase 5 bulk page/i18n coverage gate (' + fail.length + ' issue(s))');
  fail.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  pass.forEach(x => console.log('[PASS] ' + x));
  console.log('Phase 5 bulk page/i18n coverage gate: PASS');
}

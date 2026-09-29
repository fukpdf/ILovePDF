#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS:', msg); }

const requiredFiles = [
  'public/css/home-header-v2.css',
  'public/css/home-footer-v2.css',
  'public/css/shared-a11y.css',
  'public/index.html',
  'public/tool.html',
  'public/js/chrome.js'
];
for (const rel of requiredFiles) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail('missing required shared-platform artifact: ' + rel);
  else pass('artifact present: ' + rel);
}
if (process.exitCode) process.exit(1);

const index = read('public/index.html');
const tool = read('public/tool.html');
const chrome = read('public/js/chrome.js');
const headerCss = read('public/css/home-header-v2.css');
const footerCss = read('public/css/home-footer-v2.css');
const a11yCss = read('public/css/shared-a11y.css');

const contracts = [
  ['homepage uses canonical header CSS', index.includes('home-header-v2.css')],
  ['homepage uses canonical footer CSS', index.includes('home-footer-v2.css')],
  ['tool shell uses canonical header CSS', tool.includes('home-header-v2.css')],
  ['tool shell uses canonical footer CSS', tool.includes('home-footer-v2.css')],
  ['universal chrome defines canonical header shell', chrome.includes('SHARED_HEADER_HTML')],
  ['universal chrome defines canonical footer shell', chrome.includes('SHARED_FOOTER_HTML')],
  ['universal chrome injects canonical header CSS', chrome.includes('/css/home-header-v2.css')],
  ['universal chrome injects canonical footer CSS', chrome.includes('/css/home-footer-v2.css')],
  ['universal chrome injects accessibility CSS', chrome.includes('/css/shared-a11y.css')],
  ['universal chrome wires footer language selector', chrome.includes('wireFooterLangSelector')],
  ['universal chrome provides i18n assets', chrome.includes('ensureI18nAssets')],
  ['canonical header defines bounded dropdown z-index', /--ilpdf-header-dropdown-z:\s*\d+/.test(headerCss)],
  ['canonical header defines theme variables', /--ilpdf-header-(primary|grad|surface)/.test(headerCss)],
  ['canonical footer contains language selector styling', footerCss.includes('.footer-lang-btn') && footerCss.includes('.footer-lang-panel')],
  ['canonical footer contains sticker system', footerCss.includes('.footer-sticker') && footerCss.includes('.footer-section-sticker')],
  ['accessibility layer exists and is non-empty', a11yCss.trim().length > 200],
  ['tool shell exposes shared header marker', tool.includes('class="site-header"')],
  ['tool shell exposes shared footer marker', tool.includes('<footer class="footer">')],
  ['tool shell contains footer language control', tool.includes('id="footer-lang-btn"') && tool.includes('id="footer-lang-panel"')],
  ['tool shell contains footer donation control', tool.includes('footer-donate-btn')]
];
for (const [name, ok] of contracts) ok ? pass(name) : fail(name);

const htmlFiles = walk(PUBLIC).filter(p => p.endsWith('.html'));
const excludedPrefixes = [
  path.join(PUBLIC, 'admin') + path.sep,
  path.join(PUBLIC, 'dashboard.html'),
  path.join(PUBLIC, 'verify-signup.html')
];
const publicShellPages = htmlFiles.filter(p => !excludedPrefixes.some(x => p === x || p.startsWith(x)));

let missingChrome = 0;
for (const file of publicShellPages) {
  const rel = path.relative(ROOT, file).replaceAll(path.sep, '/');
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes('/js/chrome.js')) {
    fail(rel + ': missing universal shared chrome loader');
    missingChrome++;
  }
}
if (!missingChrome) pass('all public shell pages load the universal shared chrome loader');
else console.error('Public shell pages missing chrome.js:', missingChrome);

const duplicateHeaderRefs = [];
for (const file of htmlFiles) {
  const rel = path.relative(ROOT, file).replaceAll(path.sep, '/');
  const html = fs.readFileSync(file, 'utf8');
  const count = (html.match(/home-header-v2\.css/g) || []).length;
  if (count > 1) duplicateHeaderRefs.push(rel + ' (' + count + ')');
}
if (duplicateHeaderRefs.length) fail('duplicate canonical header stylesheet references: ' + duplicateHeaderRefs.join(', '));
else pass('no duplicate canonical header stylesheet references');

if (process.exitCode) {
  console.error('Phase 2 Shared Design/Platform Closure: FAILED');
  process.exit(1);
}
console.log('Phase 2 Shared Design/Platform Closure: PASSED');

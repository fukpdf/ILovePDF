#!/usr/bin/env node
'use strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const failures = [];
const fail = m => failures.push(m);

const i18n = read('public/js/i18n.js');
const chrome = read('public/js/chrome.js');
const publicDir = path.join(ROOT, 'public');
const localeDir = path.join(publicDir, 'locales');

const expectedLocales = ['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];
const localePattern = lang => new RegExp('code\\s*:\\s*[\\x27\\x22]' + lang + '[\\x27\\x22]');

if (!/var AVAILABLE = \[/.test(i18n)) fail('RuntimeI18n AVAILABLE registry is missing.');
for (const lang of expectedLocales) {
  if (!localePattern(lang).test(i18n)) fail('RuntimeI18n does not declare locale: ' + lang);
  const file = path.join(localeDir, lang + '.json');
  if (!fs.existsSync(file)) fail('Locale file is missing: locales/' + lang + '.json');
}

if (!/var STORAGE_KEY\s*=\s*['"]ilovepdf_lang['"]/.test(i18n)) fail('Global language storage key is missing.');
if (!/var EXPLICIT_STORAGE_KEY\s*=\s*['"]ilovepdf_lang_user['"]/.test(i18n)) fail('Explicit language-choice marker is missing.');
if (!/localStorage\.setItem\(STORAGE_KEY, target\)/.test(i18n)) fail('Explicit language selection is not persisted.');
if (!/localStorage\.setItem\(EXPLICIT_STORAGE_KEY, '1'\)/.test(i18n)) fail('Explicit language-choice marker is not persisted.');
if (!/if \(explicit && stored\)/.test(i18n)) fail('Explicit stored language does not take precedence.');
if (!/detectBrowserLanguage\(\)/.test(i18n)) fail('Browser-language detection is missing.');
if (!/setLanguage\(browserLang, \{ persist: false \}\)/.test(i18n)) fail('Initial browser-language detection is not applied without persistence.');
if (!/if \(!explicit && stored\)/.test(i18n) || !/localStorage\.removeItem\(STORAGE_KEY\)/.test(i18n)) fail('Legacy automatic language storage is not prevented from overriding browser preference.');
if (!/document\.documentElement\.setAttribute\('dir'/.test(i18n) || !/document\.documentElement\.setAttribute\('lang'/.test(i18n)) fail('Language/RTL document attributes are not updated.');
if (!/window\.dispatchEvent\(new CustomEvent\('i18n:change'/.test(i18n)) fail('Global i18n change event is missing.');
if (!/MutationObserver/.test(i18n) || !/self\.observe\(\)/.test(i18n)) fail('Dynamic DOM translation observer contract is incomplete.');

if (!/function wireFooterLangSelector\(\)/.test(chrome)) fail('Shared chrome footer language selector is missing.');
if (!/RuntimeI18n\.setLanguage\(lang\)/.test(chrome)) fail('Shared chrome language selector does not call RuntimeI18n.setLanguage.');
if (!/\/js\/i18n\.js\?v=shared-shell/.test(chrome)) fail('Shared chrome does not load the global i18n runtime.');

const htmlFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === 'node_modules' || name.name === 'admin') continue;
      walk(p);
    } else if (name.name.endsWith('.html')) htmlFiles.push(p);
  }
}
walk(publicDir);

if (!htmlFiles.length) fail('No public HTML pages were discovered.');

let chromePages = 0;
let directI18nPages = 0;
for (const file of htmlFiles) {
  const rel = path.relative(ROOT, file).replaceAll(path.sep, '/');
  const src = fs.readFileSync(file, 'utf8');
  const hasChrome = /<script[^>]+src=["'][^"']*\/js\/chrome\.js(?:\?[^"']*)?["']/i.test(src);
  const hasI18n = /<script[^>]+src=["'][^"']*\/js\/i18n\.js(?:\?[^"']*)?["']/i.test(src);
  if (hasChrome) chromePages++;
  if (hasI18n) directI18nPages++;
  if (!hasChrome && !hasI18n) fail(rel + ' loads neither the shared chrome nor RuntimeI18n directly.');
}

const specialPages = [
  'public/n2w.html','public/currency-converter.html','public/qr-code-generator.html',
  'public/barcode-generator.html','public/image-compressor.html','public/image-converter.html','public/zip-builder.html'
];
for (const rel of specialPages) {
  if (!fs.existsSync(path.join(ROOT, rel))) { fail('Required special page is missing: ' + rel); continue; }
  const src = read(rel);
  if (!/\/js\/chrome\.js/.test(src)) fail(rel + ' does not load canonical chrome.');
  if (!/\/js\/special-page-i18n\.js/.test(src)) fail(rel + ' does not load the special-page i18n bridge.');
}

console.log('Global i18n contract:');
console.log('  locale registry=' + expectedLocales.length + ' expected');
console.log('  public shell pages discovered=' + htmlFiles.length);
console.log('  pages loading chrome=' + chromePages);
console.log('  pages loading i18n directly=' + directI18nPages);
console.log('  admin pages excluded=' + path.join(publicDir, 'admin'));

if (failures.length) {
  console.error('[FAIL] Phase 5 global i18n contract (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Phase 5 global i18n contract');
}

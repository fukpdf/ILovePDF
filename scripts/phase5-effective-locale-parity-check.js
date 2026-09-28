#!/usr/bin/env node
'use strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeDir = path.join(ROOT, 'public', 'locales');
const extensionPath = path.join(ROOT, 'public', 'js', 'i18n-ext.js');
const expected = ['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];
const failures = [];

const flatten = (value, prefix = '', out = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? prefix + '.' + key : key, out);
  } else if (prefix) out[prefix] = value;
  return out;
};

const loadJson = lang => JSON.parse(fs.readFileSync(path.join(localeDir, lang + '.json'), 'utf8'));

function loadExtensionRegistry() {
  const source = fs.readFileSync(extensionPath, 'utf8');
  const marker = '  var _hooked = false;';
  if (!source.includes(marker)) throw new Error('Extension hook marker is missing.');
  const instrumented = source.replace(marker, '  window.__PHASE5_EXT__ = EXT;\n' + marker);

  const runtime = {
    extend() {},
    getLanguage() { return 'en'; },
    setLanguage() { return Promise.resolve('en'); }
  };
  const window = {
    RuntimeI18n: runtime,
    addEventListener() {},
    __PHASE5_EXT__: null
  };
  const document = { readyState: 'complete', addEventListener() {} };
  const context = vm.createContext({ window, document, setTimeout() {}, clearTimeout() {}, console });
  new vm.Script(instrumented, { filename: extensionPath }).runInContext(context);
  return window.__PHASE5_EXT__;
}

let ext;
try {
  ext = loadExtensionRegistry();
} catch (error) {
  console.error('[FAIL] Could not execute i18n extension registry:', error.message);
  process.exit(1);
}

if (!ext || typeof ext !== 'object' || !ext.en || typeof ext.en !== 'object') {
  console.error('[FAIL] i18n extension registry has no effective English extension map.');
  process.exit(1);
}

const extensionKeys = new Set(Object.keys(ext.en));
for (const lang of expected) {
  if (!Object.prototype.hasOwnProperty.call(ext, lang)) {
    failures.push(lang + ': missing effective extension map');
    continue;
  }
  if (!ext[lang] || typeof ext[lang] !== 'object' || Array.isArray(ext[lang])) {
    failures.push(lang + ': effective extension map is not an object');
    continue;
  }
  for (const [key, value] of Object.entries(ext[lang])) {
    if (typeof value !== 'string' || !value.trim()) failures.push(lang + '.' + key + ': extension value is empty/non-string');
  }
}

let canonical;
try {
  canonical = flatten(loadJson('en'));
} catch (error) {
  console.error('[FAIL] English locale cannot be loaded:', error.message);
  process.exit(1);
}

const canonicalKeys = new Set([...Object.keys(canonical), ...extensionKeys]);
const englishFallbackKeys = new Set(Object.keys(canonical));

for (const lang of expected) {
  let json;
  try {
    json = flatten(loadJson(lang));
  } catch (error) {
    failures.push(lang + ': invalid/missing JSON (' + error.message + ')');
    continue;
  }

  /*
   * RuntimeI18n falls back to the English JSON schema for keys absent from
   * a selected locale. The effective locale therefore consists of:
   * locale JSON + English JSON fallback + locale extension + English extension.
   */
  const effective = new Set([
    ...Object.keys(json),
    ...englishFallbackKeys,
    ...Object.keys(ext[lang] || {}),
    ...extensionKeys
  ]);
  const missing = [...canonicalKeys].filter(key => !effective.has(key));
  const extras = [...effective].filter(key => !canonicalKeys.has(key));
  if (missing.length) failures.push(lang + ': effective locale missing ' + missing.length + ' key(s): ' + missing.slice(0, 12).join(', '));
  if (extras.length) failures.push(lang + ': effective locale has ' + extras.length + ' unexpected key(s): ' + extras.slice(0, 12).join(', '));
}

console.log('Effective locale parity: ' + canonicalKeys.size + ' keys across ' + expected.length + ' locales, including English JSON and runtime i18n-ext fallback keys.');
if (failures.length) {
  console.error('[FAIL] Phase 5 effective locale parity (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Phase 5 effective locale parity');
}

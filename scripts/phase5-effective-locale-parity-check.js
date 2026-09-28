#!/usr/bin/env node
'use strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeDir = path.join(ROOT, 'public', 'locales');
const expected = ['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];
const failures = [];

const flatten = (value, prefix = '', out = {}) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? prefix + '.' + key : key, out);
    }
  } else if (prefix) {
    out[prefix] = value;
  }
  return out;
};

const loadJson = lang => JSON.parse(fs.readFileSync(path.join(localeDir, lang + '.json'), 'utf8'));

function extractObject(source, marker) {
  const markerIndex = source.indexOf(marker);
  const open = source.indexOf('{', markerIndex);
  if (markerIndex < 0 || open < 0) throw new Error('i18n extension registry is missing.');

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error('i18n extension registry is incomplete.');
}

let ext;
try {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n-ext.js'), 'utf8');
  ext = Function('return (' + extractObject(source, 'var EXT =') + ')')();
} catch (error) {
  console.error('[FAIL] Could not parse i18n extension registry:', error.message);
  process.exit(1);
}

if (!ext || typeof ext !== 'object' || !ext.en || typeof ext.en !== 'object') {
  console.error('[FAIL] i18n extension registry has no canonical English extension map.');
  process.exit(1);
}

const extensionKeys = new Set(Object.keys(ext.en));
const extensionErrors = [];
for (const [lang, values] of Object.entries(ext)) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    extensionErrors.push(lang + ': extension map is not an object');
    continue;
  }
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !value.trim()) extensionErrors.push(lang + '.' + key + ': extension value is empty/non-string');
  }
}
for (const lang of expected) {
  if (!Object.prototype.hasOwnProperty.call(ext, lang)) {
    extensionErrors.push(lang + ': missing locale extension map');
  }
}
if (extensionErrors.length) {
  console.error('[FAIL] Extension registry integrity (' + extensionErrors.length + ' issue(s))');
  extensionErrors.slice(0, 50).forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
  process.exit();
}

let canonical;
try {
  canonical = flatten(loadJson('en'));
} catch (error) {
  console.error('[FAIL] English locale cannot be loaded:', error.message);
  process.exit(1);
}

const canonicalKeys = new Set([...Object.keys(canonical), ...extensionKeys]);

for (const lang of expected) {
  let json;
  try {
    json = flatten(loadJson(lang));
  } catch (error) {
    failures.push(lang + ': invalid/missing JSON (' + error.message + ')');
    continue;
  }

  const effective = new Set([
    ...Object.keys(json),
    ...extensionKeys,
    ...Object.keys(ext[lang] || {})
  ]);

  const missing = [...canonicalKeys].filter(key => !effective.has(key));
  const extras = [...effective].filter(key => !canonicalKeys.has(key));
  if (missing.length) failures.push(lang + ': effective locale missing ' + missing.length + ' key(s): ' + missing.slice(0, 12).join(', '));
  if (extras.length) failures.push(lang + ': effective locale has ' + extras.length + ' unexpected key(s): ' + extras.slice(0, 12).join(', '));

  const collisions = Object.keys(ext[lang] || {}).filter(key => Object.prototype.hasOwnProperty.call(json, key));
  if (collisions.length) {
    console.error('[WARN] ' + lang + ': extension overrides ' + collisions.length + ' JSON key(s): ' + collisions.slice(0, 12).join(', '));
  }
}

console.log('Effective locale parity: ' + canonicalKeys.size + ' keys across ' + expected.length + ' locales, including i18n-ext fallback keys.');
if (failures.length) {
  console.error('[FAIL] Phase 5 effective locale parity (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Phase 5 effective locale parity');
}

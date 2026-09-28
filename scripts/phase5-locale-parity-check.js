#!/usr/bin/env node
'use strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'public', 'locales');
const expected = ['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];
const fail = [];
const flatten = (v, p = '', out = {}) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, p ? p + '.' + k : k, out);
  } else if (p) out[p] = v;
  return out;
};
const load = lang => JSON.parse(fs.readFileSync(path.join(dir, lang + '.json'), 'utf8'));
const extSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n-ext.js'), 'utf8');
function extractObject(source, marker) {
  const start = source.indexOf(marker);
  const open = source.indexOf('{', start);
  if (start < 0 || open < 0) throw new Error('i18n extension registry is missing.');
  let depth = 0, quote = null, escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error('i18n extension registry is incomplete.');
}
let extensions;
try {
  extensions = Function('return (' + extractObject(extSource, 'var EXT =') + ')')();
} catch (e) {
  console.error('[FAIL] i18n extension pack cannot be parsed:', e.message);
  process.exit(1);
}

let base;
try { base = flatten(load('en')); } catch (e) {
  console.error('[FAIL] English locale cannot be loaded:', e.message);
  process.exit(1);
}

const baseKeys = new Set(Object.keys(base));
for (const lang of expected) {
  let data;
  try { data = flatten(load(lang)); }
  catch (e) { fail.push(lang + ': invalid/missing JSON (' + e.message + ')'); continue; }
  const keys = new Set(Object.keys(data));
  const missing = [...baseKeys].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !baseKeys.has(k));
  if (missing.length) fail.push(lang + ': missing ' + missing.length + ' key(s): ' + missing.slice(0, 12).join(', '));
  if (extra.length) fail.push(lang + ': extra ' + extra.length + ' key(s): ' + extra.slice(0, 12).join(', '));
}
console.log('Locale parity: ' + baseKeys.size + ' canonical English keys across ' + expected.length + ' effective runtime locales (JSON + i18n-ext).');
if (fail.length) {
  console.error('[FAIL] Phase 5 locale parity (' + fail.length + ' issue(s))');
  fail.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else console.log('[PASS] Phase 5 locale parity');

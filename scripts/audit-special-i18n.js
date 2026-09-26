#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'public/js/special-page-i18n.js'), 'utf8');
const LOCALES = ['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];

function extractObject(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0, quote = null, esc = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  return null;
}

const EXT_OBJECT = extractObject(BRIDGE, 'var EXT =');
const EXT = EXT_OBJECT ? vm.runInNewContext('(' + EXT_OBJECT + ')') : {};


const PAGES = [
  ['n2w', 'public/n2w.html'],
  ['currency-converter', 'public/currency-converter.html'],
  ['qr-code-generator', 'public/qr-code-generator.html'],
  ['barcode-generator', 'public/barcode-generator.html'],
  ['image-compressor', 'public/image-compressor.html'],
  ['image-converter', 'public/image-converter.html'],
  ['zip-builder', 'public/zip-builder.html']
];

const TAG_RE = /<(h1|h2|h3|h4|h5|h6|label|legend|p|button|summary|option|figcaption|a)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ATTR_RE = /<(?:input|textarea|select|button|summary|a)\b[^>]*(?:aria-label|title|placeholder)=(["'])(.*?)\1[^>]*>/gi;
const STRIP_RE = /<[^>]+>/g;
const ENTITY_RE = /&(?:nbsp|amp|lt|gt|quot|apos);/gi;

function clean(raw) {
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(STRIP_RE, ' ')
    .replace(ENTITY_RE, m => ({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[m.toLowerCase()] || ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function likelyVisible(text) {
  if (!text || text.length < 2) return false;
  if (/^[\d\s.,:%+\-–—/()]+$/.test(text)) return false;
  if (/^(JPG|PNG|WebP|JPEG|SVG|URL|SSID|ZIP|PDF)$/i.test(text)) return false;
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(text);
}

function mappingKey(text) {
  const escaped = text.replace(/[.*+?^$\\{}()|[\]\\]/g, '\\function mapped(text) {
  if (/data-i18n\s*=/.test(text)) return true;
  return BRIDGE.includes("'" + text.replace(/'/g, "\\'") + "'") ||
         BRIDGE.includes('"' + text.replace(/"/g, '\\"') + '"');
}');
  const re = new RegExp("['\\\"]([^'\\\"]+)['\\\"]\\s*:\\s*['\\\"]" + escaped + "['\\\"]");
  const m = re.exec(BRIDGE);
  return m ? m[1] : '';
}
function translatedEverywhere(key) {
  return LOCALES.slice(1).every(lang => EXT[lang] && Object.prototype.hasOwnProperty.call(EXT[lang], key));
}

function collect(html) {
  const out = new Set();
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const t = clean(m[2]);
    if (likelyVisible(t)) out.add(t);
  }
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(html))) {
    const t = clean(m[2]);
    if (likelyVisible(t)) out.add(t);
  }
  return [...out];
}

let total = 0, mappedCount = 0, translatedCount = 0, fallbackCount = 0, unmappedCount = 0;

console.log('Special-page i18n coverage audit');
console.log('Status: mapped / translated-all-locales / English-fallback / unmapped');
console.log('');

for (const [name, rel] of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const candidates = collect(html);
  let pageMapped = 0, pageTranslated = 0, pageFallback = 0, pageUnmapped = 0;

  for (const text of candidates) {
    const key = mappingKey(text);
    if (!key) { pageUnmapped++; continue; }
    pageMapped++;
    if (translatedEverywhere(key)) pageTranslated++;
    else pageFallback++;
  }

  total += candidates.length;
  mappedCount += pageMapped;
  translatedCount += pageTranslated;
  fallbackCount += pageFallback;
  unmappedCount += pageUnmapped;

  console.log(name + ': candidates=' + candidates.length +
    ' mapped=' + pageMapped +
    ' translated-all-locales=' + pageTranslated +
    ' english-fallback=' + pageFallback +
    ' unmapped=' + pageUnmapped);
}

console.log('');
console.log('TOTAL: candidates=' + total +
  ' mapped=' + mappedCount +
  ' translated-all-locales=' + translatedCount +
  ' english-fallback=' + fallbackCount +
  ' unmapped=' + unmappedCount);
console.log('English-fallback means a semantic key exists but at least one non-English locale has no explicit override. This is not counted as translated.');

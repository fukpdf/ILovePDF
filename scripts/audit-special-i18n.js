#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'public/js/special-page-i18n.js'), 'utf8');

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

function mapped(text) {
  if (/data-i18n\s*=/.test(text)) return true;
  return BRIDGE.includes("'" + text.replace(/'/g, "\\'") + "'") ||
         BRIDGE.includes('"' + text.replace(/"/g, '\\"') + '"');
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

let total = 0;
let mappedCount = 0;
let unmappedCount = 0;

console.log('Special-page i18n coverage audit');
console.log('Bridge: public/js/special-page-i18n.js');
console.log('');

for (const [name, rel] of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const candidates = collect(html);
  const mappedItems = candidates.filter(mapped);
  const unmappedItems = candidates.filter(t => !mapped(t));

  total += candidates.length;
  mappedCount += mappedItems.length;
  unmappedCount += unmappedItems.length;

  console.log(name + ': candidates=' + candidates.length +
    ' mapped=' + mappedItems.length + ' unmapped=' + unmappedItems.length);

  if (unmappedItems.length) {
    console.log('  Unmapped visible candidates:');
    for (const item of unmappedItems) console.log('   - ' + item);
  }
}

console.log('');
console.log('TOTAL: candidates=' + total + ' mapped=' + mappedCount + ' unmapped=' + unmappedCount);
console.log('Interpretation: mapped means the bridge has a deterministic semantic mapping/data-i18n hook; it does not claim every locale has a reviewed translation.');

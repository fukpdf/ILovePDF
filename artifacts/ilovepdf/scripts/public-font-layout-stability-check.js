#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHtml } from './normalize-public-font-display.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

const fixture = `<!doctype html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
<noscript><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet"></noscript>
</head>`;
const normalized = normalizeHtml(fixture);
assert.equal(normalized.changed, 1, 'one active Google Fonts stylesheet should be normalized');
assert.match(normalized.html, /rel="preload" as="style"/, 'font CSS should leave the render-blocking stylesheet path');
assert.match(normalized.html, /display=optional/, 'late font swaps should be discouraged');
assert.match(normalized.html, /onload="this\.onload=null;this\.rel='stylesheet'"/, 'font stylesheet should apply asynchronously');
assert.match(normalized.html, /<noscript><link href="https:\/\/fonts\.googleapis\.com\/css2[^"]*display=optional[^"]*" rel="stylesheet"><\/noscript>/, 'noscript fallback should use the stable optional font policy');
assert.doesNotMatch(normalized.html, /display=swap/i, 'normalized markup should not retain swap policy even in noscript fallbacks');
assert.equal(normalizeHtml(normalized.html).changed, 0, 'normalization must be idempotent');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : (entry.isFile() && entry.name.toLowerCase().endsWith('.html') ? [full] : []);
  });
}
const htmlFiles = walk(publicDir);
let normalizedLinks = 0;
for (const file of htmlFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const result = normalizeHtml(source);
  normalizedLinks += result.changed;
  assert.doesNotMatch(
    result.html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ''),
    /<link\b(?=[^>]*\bhref=["']https?:\/\/fonts\.googleapis\.com\/css2?\?[^"']*display=swap)(?=[^>]*\brel=["']stylesheet["'])[^>]*>/i,
    path.relative(publicDir, file) + ' must not keep a blocking Google Fonts swap stylesheet after normalization'
  );
}
assert.ok(htmlFiles.length > 0, 'public HTML files should be discoverable');
console.log('PASS font stylesheet normalization is idempotent and preserves noscript fallbacks');
console.log('PASS ' + htmlFiles.length + ' public HTML files scanned in memory; ' + normalizedLinks + ' blocking font stylesheet(s) would be normalized');

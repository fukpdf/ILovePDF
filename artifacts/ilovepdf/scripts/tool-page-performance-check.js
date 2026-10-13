#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'public/tool.html'), 'utf8');
const styles = readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');

const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
const externalScripts = scriptTags.filter((tag) => /\bsrc\s*=/i.test(tag));
const parserBlocking = externalScripts.filter((tag) =>
  !/\b(?:defer|async)\b/i.test(tag) &&
  !/\btype\s*=\s*["']module["']/i.test(tag)
);
const scriptUrls = externalScripts.map((tag) => {
  const match = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}).filter(Boolean);

const checks = [
  ['tool-page.js is deferred', /<script\b[^>]*src=["']\/js\/tool-page\.js(?:\?[^"']*)?["'][^>]*\bdefer\b/i.test(html)],
  ['compression runtime adapter is deferred', /<script\b[^>]*src=["']\/js\/compress-worker-adapter\.js["'][^>]*\bdefer\b/i.test(html)],
  ['compression runtime is deferred', /<script\b[^>]*src=["']\/js\/compress-runtime\.js["'][^>]*\bdefer\b/i.test(html)],
  ['idle runtime loader is present', /<script\b[^>]*src=["']\/js\/runtime-tool-idle-loader\.js["'][^>]*\bdefer\b/i.test(html)],
  ['admin/dev diagnostics are not shipped on public tool pages', !/src=["']\/js\/runtime-(?:production-certification|devtools-dashboard|enterprise-certification|inspector)\.js["']/i.test(html)],
  ['upload skeleton is present in initial HTML', /class=["']sk-upload-wrap["']/.test(html) && /class=["']sk-upload-icon["']/.test(html)],
  ['upload skeleton reserves stable dimensions', /\.sk-upload-icon\s*\{[^}]*width:\s*64px[^}]*height:\s*64px/s.test(styles) && /\.sk-upload-btn\s*\{[^}]*width:\s*200px[^}]*height:\s*48px/s.test(styles)],
  ['essential tool shell stylesheet is included', /href=["']\/css\/styles\.css(?:\?[^"']*)?["']/.test(html)],
  ['duplicate external script URLs are absent', new Set(scriptUrls).size === scriptUrls.length],
];

let failed = 0;
for (const [name, passed] of checks) {
  console.log((passed ? 'PASS' : 'FAIL') + ' ' + name);
  if (!passed) failed++;
}

console.log('INFO external script tags: ' + externalScripts.length);
console.log('INFO parser-blocking external script tags remaining: ' + parserBlocking.length);
console.log('INFO duplicate URLs: ' + (scriptUrls.length - new Set(scriptUrls).size));

if (parserBlocking.length > 0) {
  console.warn('WARN parser-blocking scripts remain; these need dependency-aware refactoring, not a blanket defer conversion.');
}
assert.equal(failed, 0, failed + ' tool-page performance check(s) failed.');

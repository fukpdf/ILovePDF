#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

function attr(tag, name) {
  const match = tag.match(new RegExp('\\b' + name + '=["\']([^"\']*)["\']', 'i'));
  return match ? match[1] : '';
}

export function normalizeHtml(source) {
  // Preserve noscript fallbacks as opaque blocks so the active-link rewrite
  // cannot accidentally nest or rewrite their fallback markup.
  const fallbacks = [];
  let html = source.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, block => {
    const marker = '__ILOVE_NOSCRIPT_FONT_FALLBACK_' + fallbacks.length + '__';
    fallbacks.push(block);
    return marker;
  });
  let changed = 0;
  html = html.replace(/<link\b[^>]*>/gi, tag => {
    const href = attr(tag, 'href');
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/);
    if (!/https?:\/\/fonts\.googleapis\.com\/css2?\?/i.test(href) ||
        !rel.includes('stylesheet')) return tag;

    let stableHref = href.replace(/([?&]display=)swap\b/i, '$1optional');
    if (!/[?&]display=/i.test(stableHref)) {
      stableHref += (stableHref.includes('?') ? '&' : '?') + 'display=optional';
    }
    changed += 1;
    return '<link rel="preload" as="style" href="' + stableHref +
      '" fetchpriority="low" onload="this.onload=null;this.rel=\'stylesheet\'">\n' +
      '<noscript><link rel="stylesheet" href="' + stableHref + '"></noscript>';
  });
  html = html.replace(/__ILOVE_NOSCRIPT_FONT_FALLBACK_(\d+)__/g, (_, index) => fallbacks[Number(index)] || '');
  return { html, changed };
}

function listHtmlFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listHtmlFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) result.push(full);
  }
  return result;
}

export function normalizePublicHtml() {
  const files = listHtmlFiles(PUBLIC);
  let changedFiles = 0;
  let changedLinks = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const result = normalizeHtml(source);
    if (!result.changed) continue;
    fs.writeFileSync(file, result.html, 'utf8');
    changedFiles += 1;
    changedLinks += result.changed;
    console.log('[font-stability] normalized ' + path.relative(PUBLIC, file) + ' (' + result.changed + ' stylesheet(s))');
  }
  console.log('[font-stability] scanned ' + files.length + ' HTML files; normalized ' + changedLinks + ' stylesheet(s) in ' + changedFiles + ' file(s)');
  return { files: files.length, changedFiles, changedLinks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  normalizePublicHtml();
}

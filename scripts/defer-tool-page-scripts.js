/**
 * defer-tool-page-scripts.js
 * Build step: ensure every external <script src> in public/tool.html has defer.
 * Mirrors assemble-homepage-index.js pattern — production path only; preserves order.
 * Does not change routes, processors, or design.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TOOL = path.join(__dirname, '..', 'public', 'tool.html');

function main() {
  let html = fs.readFileSync(TOOL, 'utf8');
  const before = html;
  html = html.replace(/<script(\s[^>]*)>/gi, (full, attrs) => {
    if (!/src=/.test(attrs)) return full;
    if (/\bdefer\b|\basync\b/.test(attrs)) return full;
    if (full.endsWith('></script>')) return full.slice(0, -('></script>').length) + ' defer></script>';
    return full.slice(0, -1) + ' defer>';
  });
  if (html === before) {
    console.log('[defer-tool-page] no changes needed');
    return;
  }
  const opens = (html.match(/<script\b/gi) || []).length;
  const closes = (html.match(/<\/script>/gi) || []).length;
  if (opens !== closes) {
    throw new Error('script tag balance broken: ' + opens + ' vs ' + closes);
  }
  fs.writeFileSync(TOOL, html, 'utf8');
  console.log('[defer-tool-page] wrote deferred tool.html (' + html.length + ' bytes)');
}

main();

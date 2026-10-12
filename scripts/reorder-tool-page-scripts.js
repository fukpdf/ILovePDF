/**
 * reorder-tool-page-scripts.js
 * Build step: put core UI scripts first, defer all external scripts in tool.html.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const TOOL = path.join(__dirname, '..', 'public', 'tool.html');
const PRIORITY = [
  '/js/config.js',
  '/js/timer-registry.js',
  '/js/phase1-stabilization.js',
  '/js/object-url-registry.js',
  '/js/browser-tools.js',
  '/js/browser-tool-runtime.js',
  '/js/app-router.js',
  'lucide',
  '/js/i18n.js',
  '/js/chrome.js',
  '/js/chrome-shim.js',
  '/js/tools-config.js',
  '/js/tool-content.js',
  '/js/tool-state.js',
  '/js/tool-page.js',
];
function main() {
  let html = fs.readFileSync(TOOL, 'utf8');
  if (html.length < 500 || !html.includes('id="tool-content"')) {
    throw new Error('tool.html looks invalid');
  }
  if (html.includes('PLACEHOLDER')) {
    throw new Error('tool.html contains PLACEHOLDER');
  }
  const re = /(\s*)<script(\s[^>]*src=["'][^"']+["'][^>]*)>\s*<\/script>/g;
  const scripts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    scripts.push({ tag: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (scripts.length < 10) throw new Error('too few scripts: ' + scripts.length);
  function isPri(tag) { return PRIORITY.some((p) => tag.includes(p)); }
  function withDefer(tag) {
    if (!/src=/.test(tag)) return tag;
    if (/\bdefer\b|\basync\b/.test(tag)) return tag;
    return tag.replace(/<script(\s)/, '<script defer$1');
  }
  const pri = [];
  const rest = [];
  for (const s of scripts) {
    const t = withDefer(s.tag);
    if (isPri(s.tag)) pri.push(t);
    else rest.push(t);
  }
  pri.sort((a, b) => {
    const ia = PRIORITY.findIndex((p) => a.includes(p));
    const ib = PRIORITY.findIndex((p) => b.includes(p));
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  const first = scripts[0].start;
  const last = scripts[scripts.length - 1].end;
  const before = html.slice(0, first);
  const after = html.slice(last);
  const block = '\n' + pri.concat(['  <!-- runtime extensions after core UI shell -->'], rest).join('\n') + '\n';
  const out = before + block + after;
  if (!out.includes('id="tool-content"') || !out.includes('tool-page.js')) {
    throw new Error('rewrite lost critical markers');
  }
  if ((out.match(/<script\b/g) || []).length !== (out.match(/<\/script>/g) || []).length) {
    throw new Error('unbalanced script tags');
  }
  fs.writeFileSync(TOOL, out, 'utf8');
  console.log('[reorder-tool] priority', pri.length, 'rest', rest.length, 'bytes', out.length);
}
main();

#!/usr/bin/env node
/**
 * Tool-page render-path guard.
 *
 * A classic external script without defer/async pauses HTML parsing while it is
 * fetched and executed. Keep the shared tool shell non-blocking while preserving
 * ordered execution through classic-script defer semantics.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const htmlPath = path.join(root, 'public', 'tool.html');
const failures = [];
const pass = message => console.log('PASS:', message);
const fail = message => { failures.push(message); console.error('FAIL:', message); };

if (!fs.existsSync(htmlPath)) {
  console.error('FAIL: public/tool.html is missing');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi)].map(match => match[0]);
const blockingClassic = scriptTags.filter(tag =>
  !/\b(?:defer|async)\b/i.test(tag) &&
  !/\btype=["']module["']/i.test(tag)
);
const deferredClassic = scriptTags.filter(tag =>
  /\bdefer\b/i.test(tag) &&
  !/\btype=["']module["']/i.test(tag)
);
const moduleScripts = scriptTags.filter(tag => /\btype=["']module["']/i.test(tag));

if (blockingClassic.length) {
  fail(blockingClassic.length + ' parser-blocking classic external script(s) remain: ' +
    blockingClassic.slice(0, 8).map(tag => tag.match(/\bsrc=["']([^"']+)/i)?.[1] || '(unknown)').join(', '));
} else {
  pass('no parser-blocking classic external scripts');
}

const scriptSources = scriptTags.map(tag => tag.match(/\\bsrc=["']([^"']+)/i)?.[1] || '');
const indexOfScript = fragment => scriptSources.findIndex(src => src.includes(fragment));
const requiredBeforeToolPage = [
  '/js/browser-tools.js',
  '/js/i18n.js',
  '/js/chrome.js',
  '/js/tools-config.js',
  '/js/tool-registry-runtime.js',
  '/js/tool-module-registry.js',
  '/js/tool-content.js',
  '/js/tool-state.js',
  '/js/session-persist.js'
];
const toolPageIndex = indexOfScript('/js/tool-page.js');
if (toolPageIndex < 0) {
  fail('tool-page.js is missing from the shared tool shell');
} else {
  const missingOrLate = requiredBeforeToolPage.filter(fragment => {
    const index = indexOfScript(fragment);
    return index < 0 || index >= toolPageIndex;
  });
  if (missingOrLate.length) {
    fail('tool-page.js appears before required dependencies: ' + missingOrLate.join(', '));
  } else {
    pass('tool UI entry follows its declared critical dependencies');
  }
  const optionalRuntimeIndices = [
    indexOfScript('/js/runtime-protection.js'),
    indexOfScript('/js/advanced-engine.js'),
    indexOfScript('/js/runtime-tool-idle-loader.js')
  ].filter(index => index >= 0);
  if (optionalRuntimeIndices.some(index => index < toolPageIndex)) {
    fail('optional runtime extensions are ordered before tool-page.js');
  } else {
    pass('tool UI entry is ordered before optional runtime extensions');
  }
}

const stylesheetTags = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]).filter(tag =>
  /\brel=["'][^"']*\bstylesheet\b[^"']*["']/i.test(tag)
);
const activeHtml = html.replace(/<noscript\\b[^>]*>[\\s\\S]*?<\\/noscript>/gi, '');
const nonCriticalCss = ['/css/home-footer-v2.css', '/css/blog.css', '/css/seo-extended.css'];
const blockingNonCriticalCss = nonCriticalCss.filter(asset =>
  [...activeHtml.matchAll(/<link\\b[^>]*>/gi)].some(match =>
    /\\brel=["'][^"']*\\bstylesheet\\b[^"']*["']/i.test(match[0]) &&
    (match[0].match(/\\bhref=["']([^"']+)/i)?.[1] || '').split('?')[0] === asset
  )
);
if (blockingNonCriticalCss.length) {
  fail('below-the-fold CSS is render-blocking: ' + blockingNonCriticalCss.join(', '));
} else {
  pass('footer, FAQ/blog and extended SEO CSS are non-blocking');
}

const seenStylesheets = new Set();
const duplicateStylesheets = new Set();
for (const tag of stylesheetTags) {
  const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!href) continue;
  let url;
  try { url = new URL(href, 'https://ilovepdf.invalid'); } catch { continue; }
  if (url.origin !== 'https://ilovepdf.invalid' || !url.pathname.startsWith('/css/')) continue;
  if (seenStylesheets.has(url.pathname)) duplicateStylesheets.add(url.pathname);
  seenStylesheets.add(url.pathname);
}
if (duplicateStylesheets.size) {
  fail('duplicate local stylesheet path(s): ' + [...duplicateStylesheets].join(', '));
} else {
  pass('no duplicate local stylesheet paths');
}

console.log('Tool-page render-path summary: ' + JSON.stringify({
  externalScripts: scriptTags.length,
  deferredClassicScripts: deferredClassic.length,
  asyncClassicScripts: scriptTags.filter(tag => /\basync\b/i.test(tag) && !/\btype=["']module["']/i.test(tag)).length,
  moduleScripts: moduleScripts.length,
  parserBlockingClassicScripts: blockingClassic.length,
  stylesheets: stylesheetTags.length
}, null, 2));

if (failures.length) {
  console.error('Tool-page rendering audit failed with ' + failures.length + ' issue(s).');
  process.exit(1);
}
console.log('Tool-page rendering audit passed.');

#!/usr/bin/env node
/**
 * assemble-homepage-index.js
 *
 * Rebuilds public/index.html from public/index-chunks/z0..z3.b64.
 * Run in CI before Firebase deploy so production serves full HTML, not a runtime loader.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_DIR = path.join(ROOT, 'public', 'index-chunks');
const OUT = path.join(ROOT, 'public', 'index.html');

function fail(message) {
  console.error('[assemble-index] ' + message);
  process.exitCode = 1;
}

function moveExternalScriptAfter(html, targetPattern, anchorPattern) {
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi)];
  const target = tags.find(match => targetPattern.test(match[0]));
  const anchor = tags.find(match => anchorPattern.test(match[0]));
  if (!target || !anchor || target.index > anchor.index) return { html, moved: false };

  html = html.slice(0, target.index) + html.slice(target.index + target[0].length);
  const updatedTags = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi)];
  const updatedAnchor = updatedTags.find(match => anchorPattern.test(match[0]));
  if (!updatedAnchor) return { html, moved: false };
  const insertAt = updatedAnchor.index + updatedAnchor[0].length;
  return {
    html: html.slice(0, insertAt) + '\n' + target[0] + html.slice(insertAt),
    moved: true
  };
}

function removeHomepageOnlyOverlaysAndLaba(html) {
  const before = html;
  // These scripts/styles belong to the optional Laba chatbot or the one-off
  // announcement modal. Neither is required to render the homepage tool catalogue.
  html = html.replace(
    /<script\\b(?=[^>]*\\bsrc=["'][^"']*(?:\\/laba\\/|laba-widget|laba-ai-|homepage-lazy-loader\\.js|site-announcement\\.js)[^"']*["'])[^>]*>[\\s\\S]*?<\\/script>\\s*/gi,
    ''
  );
  html = html.replace(
    /<link\\b(?=[^>]*\\bhref=["'][^"']*(?:\\/laba\\/|laba-widget|site-announcement\\.css)[^"']*["'])[^>]*>\\s*/gi,
    ''
  );
  html = html.replace(/<!--\\s*Laba AI Assistant[\\s\\S]*?-->/gi, '');
  html = html.replace(/<!--\\s*Phase 13\\/14: AI\\/Laba stack[\\s\\S]*?-->/gi, '');
  html = html.replace(/<!--\\s*Site announcement[\\s\\S]*?-->/gi, '');

  const forbidden = /(?:\\/laba\\/|laba-widget|laba-ai-|homepage-lazy-loader\\.js|site-announcement\\.(?:js|css))/i;
  if (forbidden.test(html)) {
    fail('homepage still contains a Laba or delayed announcement asset reference after cleanup');
    return null;
  }
  return { html, changed: html !== before };
}

function main() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const chunkPath = path.join(CHUNK_DIR, 'z' + i + '.b64');
    if (!fs.existsSync(chunkPath)) {
      fail('missing chunk: ' + chunkPath);
      return;
    }
    const chunk = fs.readFileSync(chunkPath, 'utf8').replace(/\s+/g, '');
    if (!chunk || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) {
      fail('chunk is empty or invalid base64: ' + chunkPath);
      return;
    }
    parts.push(chunk);
  }

  let html;
  try {
    html = zlib.inflateSync(Buffer.from(parts.join(''), 'base64')).toString('utf8');
  } catch (error) {
    fail('zlib decompress failed: ' + error.message);
    return;
  }

  if (!/<!doctype\s+html/i.test(html)) {
    fail('decompressed output is not a full HTML document');
    return;
  }
  for (const required of ['/js/chrome.js', '/js/home.js', 'home-fast-boot.js']) {
    if (!html.includes(required)) {
      fail('missing required homepage reference: ' + required);
      return;
    }
  }
  if (html.includes('DecompressionStream')) {
    fail('decompressed output still contains the runtime chunk loader');
    return;
  }

  const chromeAt = html.indexOf('/js/chrome.js');
  const runtimeAt = html.indexOf('/js/runtime-protection.js');
  if (runtimeAt !== -1 && chromeAt > runtimeAt) {
    fail('critical-path order invalid: chrome.js appears after runtime-protection.js');
    return;
  }

  const cleanup = removeHomepageOnlyOverlaysAndLaba(html);
  if (!cleanup) return;
  html = cleanup.html;

  // chrome.js owns TOOL_GROUPS; execute it before home.js to avoid an empty-registry render.
  const homeMove = moveExternalScriptAfter(
    html,
    /\/js\/home[.]js(?:[?#]|["'])/i,
    /\/js\/chrome[.]js(?:[?#]|["'])/i
  );
  html = homeMove.html;

  // i18n-ext.js waits for RuntimeI18n when the core i18n module is not ready,
  // so it can execute after the first homepage render without losing translations.
  const i18nExtMove = moveExternalScriptAfter(
    html,
    /i18n-ext[.]js/i,
    /\/js\/home[.]js(?:[?#]|["'])/i
  );
  html = i18nExtMove.html;

  // firebase-init.js already schedules Firebase SDK initialization during idle time.
  // Making its external script deferred removes the only parser-blocking script while
  // preserving classic-script execution order and the existing auth readiness promise.
  let firebaseDeferred = false;
  html = html.replace(
    /<script\b(?![^>]*\b(?:defer|async)\b)([^>]*\bsrc=["'][^"']*\/js\/firebase-init\.js(?:[?#][^"']*)?["'][^>]*)>/i,
    (_tag, attrs) => {
      firebaseDeferred = true;
      return '<script defer' + attrs + '>';
    }
  );

  const blockingScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi)]
    .filter(match => !/\bdefer\b/i.test(match[0]) && !/\basync\b/i.test(match[0]));
  if (blockingScripts.length) {
    fail('homepage still has parser-blocking external scripts: ' + blockingScripts.length);
    return;
  }

  fs.writeFileSync(OUT, html, 'utf8');
  console.log('[assemble-index] wrote ' + OUT + ' (' + Buffer.byteLength(html, 'utf8') + ' bytes)');
  console.log('[assemble-index] chunk integrity, full HTML, required scripts, and critical-path order OK');
  console.log('[assemble-index] parser-blocking external scripts: 0' + (firebaseDeferred ? ' (firebase-init deferred)' : ''));
  if (homeMove.moved) console.log('[assemble-index] chrome.js now executes before the homepage renderer');
  if (cleanup.changed) console.log('[assemble-index] removed homepage-only Laba widget/lazy-loader and delayed announcement assets');
  if (i18nExtMove.moved) console.log('[assemble-index] homepage renderer now executes before the extended translation payload');
}

main();

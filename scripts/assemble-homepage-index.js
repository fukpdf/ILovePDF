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
  if (!html.includes('/js/chrome.js')) {
    fail('missing chrome.js reference');
    return;
  }
  if (!html.includes('/js/home.js')) {
    fail('missing home.js reference');
    return;
  }
  if (!html.includes('home-fast-boot.js')) {
    fail('missing home-fast-boot.js reference');
    return;
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

  fs.writeFileSync(OUT, html, 'utf8');
  console.log('[assemble-index] wrote ' + OUT + ' (' + Buffer.byteLength(html, 'utf8') + ' bytes)');
  console.log('[assemble-index] chunk integrity, full HTML, required scripts, and critical-path order OK');
}

main();

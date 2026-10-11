#!/usr/bin/env node
/**
 * assemble-homepage-index.js
 *
 * Rebuilds public/index.html from public/index-chunks/z0..z3.b64
 * (zlib + base64 of the Step-2 critical-path homepage).
 *
 * Run in CI before Firebase deploy so production serves a normal full HTML
 * file (no runtime chunk loader).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const CHUNK_DIR = path.join(ROOT, 'public', 'index-chunks');
const OUT = path.join(ROOT, 'public', 'index.html');

function main() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const p = path.join(CHUNK_DIR, `z${i}.b64`);
    if (!fs.existsSync(p)) {
      console.error(`[assemble-index] missing chunk: ${p}`);
      process.exit(1);
    }
    parts.push(fs.readFileSync(p, 'utf8').replace(/\s+/g, ''));
  }

  const buf = Buffer.from(parts.join(''), 'base64');
  let html;
  try {
    html = zlib.inflateSync(buf).toString('utf8');
  } catch (err) {
    console.error('[assemble-index] zlib decompress failed:', err.message);
    process.exit(1);
  }

  if (!html.includes('<!DOCTYPE') && !html.includes('<!doctype')) {
    console.error('[assemble-index] decompressed output is not HTML');
    process.exit(1);
  }
  if (!html.includes('/js/chrome.js')) {
    console.error('[assemble-index] missing chrome.js reference');
    process.exit(1);
  }
  if (!html.includes('/js/home.js')) {
    console.error('[assemble-index] missing home.js reference');
    process.exit(1);
  }

  // Critical-path order check: chrome must appear before runtime-protection
  const chromeAt = html.indexOf('/js/chrome.js');
  const runtimeAt = html.indexOf('/js/runtime-protection.js');
  if (runtimeAt !== -1 && chromeAt > runtimeAt) {
    console.error('[assemble-index] FAIL: chrome.js still after runtime-protection');
    process.exit(1);
  }

  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`[assemble-index] wrote ${OUT} (${html.length} bytes)`);
  console.log('[assemble-index] critical-path order OK');
}

main();

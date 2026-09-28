#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const arch = read('docs/09_RUNTIME_ARCHITECTURE.md');
const engine = read('docs/10_TOOL_ENGINE.md');
const browser = read('public/js/browser-tools.js');
const page = read('public/js/tool-page.js');

const failures = [];
function requireText(file, text, label) {
  if (!file.includes(text)) failures.push(label);
}
function forbidText(file, text, label) {
  if (file.includes(text)) failures.push(label);
}

// Runtime contract: browser execution is authoritative; no documented server fallback.
requireText(engine, '### Client-side Path (primary)', 'missing client-side processing section');
requireText(engine, '### Browser Tools Library', 'missing BrowserTools contract');
requireText(engine, 'There is no server fallback path', 'missing no-server-fallback statement');
forbidText(engine, '### Server Fallback Path', 'obsolete server fallback section remains');
forbidText(engine, 'apiEndpoint: \'/api/rotate\'', 'obsolete apiEndpoint tool contract remains');
forbidText(engine, 'server fallback endpoint', 'obsolete fallback field description remains');

// Runtime thresholds must match the actual BrowserTools routing.
requireText(browser, 'files[0].size >= 10 * 1024 * 1024', '10 MiB streaming threshold missing from runtime');
requireText(arch, '10 MB threshold', 'architecture document missing current streaming threshold');
requireText(arch, '4 MB chunks', 'architecture document missing current chunk size');

// Worker-safe tools must remain fail-closed.
requireText(browser, 'There is intentionally NO silent worker → main-thread fallback.', 'worker fail-closed contract missing');
requireText(page, 'canonical browser execution cannot continue', 'tool-page canonical browser execution guard missing');

// Documentation must identify current authoritative processing globals.
requireText(arch, 'window.BrowserTools', 'BrowserTools global missing from architecture reference');
requireText(engine, 'window.BrowserTools', 'BrowserTools global missing from engine reference');

if (failures.length) {
  console.error('Phase 5 runtime documentation contract FAILED');
  failures.forEach(f => console.error(' - ' + f));
  process.exit(1);
}
console.log('Phase 5 runtime documentation contract PASSED');

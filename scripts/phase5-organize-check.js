#!/usr/bin/env node
// Phase 5 Unit 6 — Organize PDF standard-tool migration gate.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const registry = JSON.parse(read('config/tool-registry.json'));
const published = read('public/config/tool-registry.json');
const failures = [];
const fail = msg => failures.push(msg);

const organize = (registry.tools || []).find(t => t.id === 'organize');
if (!organize) fail('Organize is missing from the canonical tool registry.');
else {
  if (organize.slug !== 'organize-pdf') fail('Organize slug is not organize-pdf.');
  if (organize.module !== 'pdf-module') fail('Organize module owner is not pdf-module.');
  if (organize.execution !== 'browser-worker') fail('Organize execution is not browser-worker.');
  if (!organize.capabilities || organize.capabilities.lazyLoad !== true) fail('Organize lazyLoad contract is missing.');
  if (organize.capabilities.workerPool !== true) fail('Organize workerPool contract is missing.');
  if (organize.capabilities.streaming !== 'adaptive-worker') fail('Organize adaptive-worker streaming contract is missing.');
  if (organize.capabilities.fileSizePolicy !== 'unlimited') fail('Organize file-size policy is not unlimited.');
}

if (published !== read('config/tool-registry.json')) fail('Published registry is out of sync with canonical registry.');

const browserTools = read('public/js/browser-tools.js');
const workerTools = browserTools.match(/const WORKER_TOOLS = new Set\(\[([\\s\\S]*?)\]\);/)?.[1] || '';
if (!/['"]organize['"]/.test(workerTools)) fail('Organize is not in BrowserTools WORKER_TOOLS.');
if (!/RuntimeStreamBridge/.test(browserTools) || !/pipelineStreamToWorker/.test(browserTools)) fail('Shared adaptive streaming path is missing from BrowserTools.');
if (/MAX_FILE_BYTES|100\s*\*\s*1024\s*1024/.test(browserTools)) fail('BrowserTools contains an artificial 100 MB file-size guard.');
if (/HARD_LIMIT_MS|WORKER_LIMIT_MS|75000|90000|105000|120000/.test(browserTools)) fail('BrowserTools retains a fixed processing-time limit in the migrated execution path.');

const worker = read('public/workers/pdf-worker.js');
if (!/OPS\.organize\s*=\s*async function/.test(worker)) fail('Shared PDF worker has no Organize operation.');
if (!/pageOrder/.test(worker)) fail('Shared Organize worker operation has no page-order input.');

const toolPage = read('public/js/tool-page.js');
if (!/BrowserTools\.validateInputFiles/.test(toolPage)) fail('Shared input validation boundary is missing from tool-page.');
if (!/OutputValidator\.check/.test(toolPage)) fail('Shared output validation boundary is missing from tool-page.');
if (/MAX_FILE_BYTES/.test(toolPage)) fail('Shared tool page still contains the legacy MAX_FILE_BYTES rejection.');

const pageOrganizer = read('public/js/page-organizer.js');
if (!/['"]organize['"]/.test(pageOrganizer)) fail('PageOrganizer does not recognize Organize.');
if (!/getEditedPdf/.test(pageOrganizer)) fail('PageOrganizer does not expose the edited-PDF output boundary.');

if (failures.length) {
  console.error('[FAIL] Phase 5 Organize gate (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Organize registry execution + capability contract');
  console.log('[PASS] canonical/published registry parity');
  console.log('[PASS] Organize BrowserTools worker capability');
  console.log('[PASS] shared PDF worker Organize operation');
  console.log('[PASS] adaptive streaming infrastructure available');
  console.log('[PASS] unlimited file-size / no fixed execution timeout policy');
  console.log('[PASS] shared input/output validation boundaries');
  console.log('[PASS] PageOrganizer edited-PDF integration');
  console.log('\nPhase 5 Unit 6 Organize reference gate: PASS');
}

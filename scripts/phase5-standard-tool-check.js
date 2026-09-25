#!/usr/bin/env node
// Phase 5 Unit 1 — Crop PDF standard-tool migration gate.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const registry = JSON.parse(read('config/tool-registry.json'));
const published = read('public/config/tool-registry.json');
const failures = [];
const fail = msg => failures.push(msg);

const crop = (registry.tools || []).find(t => t.id === 'crop');
if (!crop) fail('Crop is missing from the canonical tool registry.');
else {
  if (crop.slug !== 'crop-pdf') fail('Crop slug is not crop-pdf.');
  if (crop.module !== 'pdf-module') fail('Crop module owner is not pdf-module.');
  if (crop.execution !== 'browser-worker') fail('Crop execution is not browser-worker.');
  if (!crop.capabilities || crop.capabilities.lazyLoad !== true) fail('Crop lazyLoad contract is missing.');
  if (crop.capabilities.workerPool !== true) fail('Crop workerPool contract is missing.');
  if (crop.capabilities.streaming !== 'adaptive-worker') fail('Crop adaptive-worker streaming contract is missing.');
  if (crop.capabilities.fileSizePolicy !== 'unlimited') fail('Crop file-size policy is not unlimited.');
}

if (published !== read('config/tool-registry.json')) fail('Published registry is out of sync with canonical registry.');

const browserTools = read('public/js/browser-tools.js');
if (!/['"]crop['"]/.test(browserTools.match(/const WORKER_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '')) fail('Crop is not in BrowserTools WORKER_TOOLS.');
if (!/toolId === 'crop'/.test(browserTools) && !/toolId === "crop"/.test(browserTools)) {
  fail('Crop prewarm hook is missing.');
}

const worker = read('public/workers/pdf-worker.js');
if (!/OPS\.crop\s*=\s*async function/.test(worker)) fail('Shared PDF worker has no Crop operation.');

const app = read('public/js/crop-pdf-app.js');
if (!/WorkerPool\.run/.test(app)) fail('Crop app does not use shared WorkerPool execution.');
if (!/RuntimeStreamBridge/.test(app) || !/pipelineStreamToWorker/.test(app)) fail('Crop app does not use adaptive streaming for large files.');
if (/HARD_LIMIT_MS|WORKER_LIMIT_MS/.test(app)) fail('Crop app retains an artificial processing timeout.');
if (/MAX_FILE_BYTES|100\s*\*\s*1024\s*1024/.test(app)) fail('Crop app contains an artificial file-size limit.');
if (!/WorkerPool\.CancelToken/.test(app)) fail('Crop app has no cancellation token.');
if (!/function unmount\(\)/.test(app) || !/_cancel\(\)/.test(app)) fail('Crop app lifecycle cleanup is incomplete.');

const toolPage = read('public/js/tool-page.js');
if (/MAX_FILE_BYTES/.test(toolPage)) fail('Shared tool page still contains the legacy MAX_FILE_BYTES rejection.');
if (!/BrowserTools\.validateInputFiles/.test(toolPage)) fail('Shared input validation boundary is missing from tool-page.');
if (!/OutputValidator\.check/.test(toolPage)) fail('Shared output validation boundary is missing from tool-page.');

const toolHtml = read('public/tool.html');
if (!/src="\/js\/crop-pdf-app\.js" defer/.test(toolHtml)) fail('Crop app is not loaded by the standard tool shell.');

if (failures.length) {
  console.error('[FAIL] Phase 5 Crop reference gate (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Crop registry execution + capability contract');
  console.log('[PASS] canonical/published registry parity');
  console.log('[PASS] Crop BrowserTools worker capability');
  console.log('[PASS] shared PDF worker Crop operation');
  console.log('[PASS] Crop ToolApp WorkerPool execution');
  console.log('[PASS] Crop adaptive streaming path');
  console.log('[PASS] Crop cancellation + lifecycle cleanup');
  console.log('[PASS] Crop unlimited file-size / no artificial timeout policy');
  console.log('[PASS] shared input/output validation boundaries');
  console.log('[PASS] standard tool shell integration');
  console.log('\nPhase 5 Unit 1 Crop reference gate: PASS');
}

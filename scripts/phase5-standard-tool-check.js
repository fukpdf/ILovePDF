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

const rotate = (registry.tools || []).find(t => t.id === 'rotate');
if (!rotate) fail('Rotate is missing from the canonical tool registry.');
else {
  if (rotate.slug !== 'rotate-pdf') fail('Rotate slug is not rotate-pdf.');
  if (rotate.module !== 'pdf-module') fail('Rotate module owner is not pdf-module.');
  if (rotate.execution !== 'browser-worker') fail('Rotate execution is not browser-worker.');
  if (!rotate.capabilities || rotate.capabilities.lazyLoad !== true) fail('Rotate lazyLoad contract is missing.');
  if (rotate.capabilities.workerPool !== true) fail('Rotate workerPool contract is missing.');
  if (rotate.capabilities.streaming !== 'adaptive-worker') fail('Rotate adaptive-worker streaming contract is missing.');
  if (rotate.capabilities.fileSizePolicy !== 'unlimited') fail('Rotate file-size policy is not unlimited.');
}

const rotateApp = read('public/js/rotate-pdf-app.js');
if (!/return _runtime\(\)\.execute\(file, options\)/.test(rotateApp)) fail('Rotate app does not dispatch to canonical RotateRuntime.');
if (!/G\.ToolAppManager\.registerTool\(TOOL_ID, function \(\)/.test(rotateApp)) fail('Rotate ToolApp boundary is not registered.');
if (!/function unmount\(\)[\s\S]*?_cancel\(/.test(rotateApp)) fail('Rotate unmount cancellation is missing.');
if (!/function reset\(\)[\s\S]*?_cancel\(/.test(rotateApp)) fail('Rotate reset cancellation is missing.');
if (!/function destroy\(\)[\s\S]*?_cancel\(/.test(rotateApp)) fail('Rotate destroy cancellation is missing.');

const rotateRuntime = read('public/js/rotate-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(rotateRuntime)) fail('RotateRuntime does not use RuntimeScheduler.');
if (/runRotateLegacy|force legacy path|trigger fallback|runtime or legacy|do NOT fallback/i.test(rotateRuntime)) fail('RotateRuntime contains an automatic legacy/fallback path.');
if (!/__rotateRunToken/.test(rotateRuntime)) fail('Rotate runtime error ownership token is missing.');
if (!/timeoutMs\s*:\s*0/.test(rotateRuntime)) fail('RotateRuntime scoped cancellation does not explicitly use unlimited timeout.');

const rotateAdapter = read('public/js/rotate-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(rotateAdapter)) fail('Rotate adapter does not use RuntimeWorkers.dispatch.');
if (/WorkerPool\.run\(/.test(rotateAdapter)) fail('Rotate adapter retains a secondary direct WorkerPool fallback.');
if (!/TIMEOUT_MS\s*=\s*0/.test(rotateAdapter)) fail('Rotate adapter has an artificial execution timeout.');
if (!/JSON\.stringify\(opts\.pagePlan\)/.test(rotateAdapter)) fail('Rotate dedupe key does not include the complete page plan.');

const rotateWorker = read('public/workers/pdf-worker.js');
const rotateBlock = rotateWorker.match(/OPS\.rotate\s*=\s*async function[\s\S]*?(?=\nOPS\.[A-Za-z'\[]|\n\/\/ ──)/)?.[0] || '';
const rotateExecutableBlock = rotateBlock.replace(/\/\/.*$/gm, '');
if (!rotateBlock) fail('Shared PDF worker Rotate operation could not be isolated.');
if (!/Array\.isArray\(opts\.pagePlan\)/.test(rotateExecutableBlock)) fail('Rotate worker does not consume pagePlan.');
if (!/normalizedPlan\.length\s*!==\s*pages\.length/.test(rotateExecutableBlock)) fail('Rotate worker does not require a complete page plan.');
if (!/item\.page\s*===\s*i\s*\+\s*1/.test(rotateExecutableBlock)) fail('Rotate worker does not enforce ordered original page numbers.');
if (!/page\.getRotation\(\)\.angle/.test(rotateExecutableBlock)) fail('Rotate worker does not preserve intrinsic PDF rotation.');
if (/\b(?:PDFDocument\.)?copyPages\s*\(/.test(rotateExecutableBlock)) fail('Rotate worker rebuilds pages with copyPages().');

const rotateOrganizer = read('public/js/page-organizer.js');
if (!/allowStructuralEdits\s*=\s*opts\.allowStructuralEdits\s*!==\s*false/.test(rotateOrganizer)) fail('PageOrganizer structural-edit isolation is missing.');
if (!/function getRotationPlan\(\)/.test(rotateOrganizer)) fail('PageOrganizer does not expose a Rotate page plan.');
if (!/page:\s*p\.originalIndex\s*\+\s*1/.test(rotateOrganizer)) fail('Rotate page plan does not use original page numbers.');

const rotateToolPage = read('public/js/tool-page.js');
if (!/allowStructuralEdits:\s*!\(currentTool\s*&&\s*currentTool\.id\s*===\s*['"]rotate['"]\)/.test(rotateToolPage)) fail('Rotate page organizer is not configured as rotation-only.');
if (!/opts\.pagePlan\s*=\s*rotatePagePlan/.test(rotateToolPage)) fail('Rotate page plan is not passed to the browser worker options.');

const rotatePreview = read('public/js/pdf-preview.js');
if (!/Number\(page\.rotate\s*\|\|\s*0\)/.test(rotatePreview) || !/basePageRotation\s*\+\s*rotation/.test(rotatePreview)) fail('Rotate preview does not combine intrinsic and requested rotation.');

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
  console.log('[PASS] Phase 5 Unit 2 Rotate canonical-tool gate');
}

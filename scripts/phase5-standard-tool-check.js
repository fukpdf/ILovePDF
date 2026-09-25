#!/usr/bin/env node
// Phase 5 standard-tool migration gates.
// Crop is the approved reference; Rotate and Merge must satisfy the same
// canonical browser-worker architecture without hidden legacy fallbacks.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const registry = JSON.parse(read('config/tool-registry.json'));
const published = read('public/config/tool-registry.json');
const failures = [];
const fail = msg => failures.push(msg);

function requirePdfWorkerContract(id, label) {
  const tool = (registry.tools || []).find(t => t.id === id);
  if (!tool) {
    fail(label + ' is missing from the canonical tool registry.');
    return null;
  }
  if (tool.slug !== id + '-pdf' && !(id === 'page-numbers' && tool.slug === 'add-page-numbers')) {
    fail(label + ' slug is incorrect.');
  }
  if (tool.module !== 'pdf-module') fail(label + ' module owner is not pdf-module.');
  if (tool.execution !== 'browser-worker') fail(label + ' execution is not browser-worker.');
  if (!tool.capabilities || tool.capabilities.lazyLoad !== true) fail(label + ' lazyLoad contract is missing.');
  if (!tool.capabilities || tool.capabilities.workerPool !== true) fail(label + ' workerPool contract is missing.');
  if (!tool.capabilities || tool.capabilities.streaming !== 'adaptive-worker') fail(label + ' adaptive-worker streaming contract is missing.');
  if (!tool.capabilities || tool.capabilities.fileSizePolicy !== 'unlimited') fail(label + ' file-size policy is not unlimited.');
  return tool;
}

if (published !== read('config/tool-registry.json')) {
  fail('Published registry is out of sync with canonical registry.');
}

const browserTools = read('public/js/browser-tools.js');
const workerSet = browserTools.match(/const WORKER_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
if (!/['"]crop['"]/.test(workerSet)) fail('Crop is not in BrowserTools WORKER_TOOLS.');
if (!/['"]rotate['"]/.test(workerSet)) fail('Rotate is not in BrowserTools WORKER_TOOLS.');
if (!/['"]merge['"]/.test(workerSet)) fail('Merge is not in BrowserTools WORKER_TOOLS.');
if (!/silentWorkerFallback:\s*false/.test(browserTools)) fail('BrowserTools execution manifest permits silent worker fallback.');

const worker = read('public/workers/pdf-worker.js');
if (!/OPS\.crop\s*=\s*async function/.test(worker)) fail('Shared PDF worker has no Crop operation.');
if (!/OPS\.rotate\s*=\s*async function/.test(worker)) fail('Shared PDF worker has no Rotate operation.');
if (!/OPS\.merge\s*=\s*async function/.test(worker)) fail('Shared PDF worker has no Merge operation.');

const toolPage = read('public/js/tool-page.js');
if (/MAX_FILE_BYTES/.test(toolPage)) fail('Shared tool page still contains the legacy MAX_FILE_BYTES rejection.');
if (!/BrowserTools\.validateInputFiles/.test(toolPage)) fail('Shared input validation boundary is missing from tool-page.');
if (!/OutputValidator\.check/.test(toolPage)) fail('Shared output validation boundary is missing from tool-page.');
if (!/window\.BrowserTools\.process\(toolId, files, opts\)/.test(toolPage)) fail('Shared tool page does not dispatch browser tools through the canonical process boundary.');
if (!/No verified browser processor exists for this tool/.test(toolPage)) fail('Shared tool page fallback policy is not explicit.');

const toolHtml = read('public/tool.html');
if (!/src="\/js\/crop-pdf-app\.js" defer/.test(toolHtml)) fail('Crop app is not loaded by the standard tool shell.');

// ── Crop reference ─────────────────────────────────────────────────────────
requirePdfWorkerContract('crop', 'Crop');
const cropApp = read('public/js/crop-pdf-app.js');
if (!/WorkerPool\.run/.test(cropApp)) fail('Crop app does not use shared WorkerPool execution.');
if (!/RuntimeStreamBridge/.test(cropApp) || !/pipelineStreamToWorker/.test(cropApp)) fail('Crop app does not use adaptive streaming for large files.');
if (/HARD_LIMIT_MS|WORKER_LIMIT_MS/.test(cropApp)) fail('Crop app retains an artificial processing timeout.');
if (/MAX_FILE_BYTES|100\s*\*\s*1024\s*1024/.test(cropApp)) fail('Crop app contains an artificial file-size limit.');
if (!/WorkerPool\.CancelToken/.test(cropApp)) fail('Crop app has no cancellation token.');
if (!/function unmount\(\)[\s\S]*?_cancel\(/.test(cropApp)) fail('Crop app lifecycle cleanup is incomplete.');

// ── Rotate canonical tool ──────────────────────────────────────────────────
requirePdfWorkerContract('rotate', 'Rotate');
const rotateApp = read('public/js/rotate-pdf-app.js');
if (!/return _runtime\(\)\.execute\(file, options\)/.test(rotateApp)) fail('Rotate app does not dispatch to canonical RotateRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID, function \(\)/.test(rotateApp)) fail('Rotate ToolApp boundary is not registered.');
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
if (/WorkerPool\.run\(/.test(rotateAdapter)) fail('Rotate adapter retains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS\s*=\s*0/.test(rotateAdapter)) fail('Rotate adapter has an artificial execution timeout.');
if (!/JSON\.stringify\(opts\.pagePlan\)/.test(rotateAdapter)) fail('Rotate dedupe key does not include the complete page plan.');

const rotateBlock = worker.match(/OPS\.rotate\s*=\s*async function[\s\S]*?(?=\nOPS\.[A-Za-z'\[]|\n\/\/ ──)/)?.[0] || '';
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

if (!/allowStructuralEdits:\s*!\(currentTool\s*&&\s*currentTool\.id\s*===\s*['"]rotate['"]\)/.test(toolPage)) fail('Rotate page organizer is not configured as rotation-only.');
if (!/opts\.pagePlan\s*=\s*rotatePagePlan/.test(toolPage)) fail('Rotate page plan is not passed to the browser worker options.');

const rotatePreview = read('public/js/pdf-preview.js');
if (!/Number\(page\.rotate\s*\|\|\s*0\)/.test(rotatePreview) || !/basePageRotation\s*\+\s*rotation/.test(rotatePreview)) {
  fail('Rotate preview does not combine intrinsic and requested rotation.');
}

// ── Split canonical tool ───────────────────────────────────────────────────
requirePdfWorkerContract('split', 'Split');
const splitApp = read('public/js/split-pdf-app.js');
if (!/runtime\(\)\.execute\(files\[0\],opts\|\|\{\}\)/.test(splitApp)) fail('Split app does not dispatch to SplitRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID,function\(\)/.test(splitApp)) fail('Split ToolApp boundary is not registered.');
if (!/function unmount\(\)\{cancel\(/.test(splitApp) || !/function reset\(\)\{cancel\(/.test(splitApp) || !/function destroy\(\)\{cancel\(/.test(splitApp)) fail('Split lifecycle cancellation is incomplete.');

const splitRuntime = read('public/js/split-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(splitRuntime)) fail('SplitRuntime does not use RuntimeScheduler.');
if (!/RuntimeScheduler is unavailable/.test(splitRuntime)) fail('SplitRuntime does not fail closed.');
if (!/__splitRunToken/.test(splitRuntime)) fail('Split run ownership token is missing.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back/i.test(splitRuntime)) fail('SplitRuntime retains legacy factory/fallback architecture.');
if (!/timeoutMs:0/.test(splitRuntime)) fail('SplitRuntime does not use an unlimited execution timeout.');

const splitAdapter = read('public/js/split-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(splitAdapter)) fail('Split adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(splitAdapter)) fail('Split adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS\s*=\s*0/.test(splitAdapter)) fail('Split adapter has an artificial timeout.');
if (!/pipelineStreamToWorker/.test(splitAdapter)) fail('Split adapter does not use adaptive streaming.');
if (!/STREAM_THRESHOLD\s*=\s*10\s*\*\s*1024\s*\*\s*1024/.test(splitAdapter)) fail('Split adaptive threshold is missing.');
if (!/dedupeKey\s*:\s*key\(file\s*,\s*opts\)/.test(splitAdapter)) fail('Split dedupe key is missing.');

const splitWorker = read('public/workers/pdf-worker.js');
const splitBlock = splitWorker.match(/OPS\.split\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!splitBlock) fail('Shared PDF worker has no Split operation.');
if (!/PDFDocument\.load/.test(splitBlock) || !/parsePageRange/.test(splitBlock) || !/copyPages/.test(splitBlock)) fail('Split worker page extraction contract is incomplete.');
if (!/out\.getPageCount\(\) === 0/.test(splitBlock)) fail('Split worker does not reject empty output.');

if (!/['"]split['"]/.test(workerSet)) fail('Split is not in BrowserTools WORKER_TOOLS.');

// ── Organize canonical tool ────────────────────────────────────────────────
requirePdfWorkerContract('organize', 'Organize');
const organizeApp = read('public/js/organize-app.js');
if (!/runtime\(\)\.execute\(files\[0\],opts\|\|\{\}\)/.test(organizeApp)) fail('Organize app does not dispatch to OrganizeRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID,function\(\)/.test(organizeApp)) fail('Organize ToolApp boundary is not registered.');
if (!/function unmount\(\)\{cancel\(/.test(organizeApp) || !/function reset\(\)\{cancel\(/.test(organizeApp) || !/function destroy\(\)\{cancel\(/.test(organizeApp)) fail('Organize lifecycle cancellation is incomplete.');

const organizeRuntime = read('public/js/organize-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(organizeRuntime)) fail('OrganizeRuntime does not use RuntimeScheduler.');
if (!/RuntimeScheduler is unavailable/.test(organizeRuntime)) fail('OrganizeRuntime does not fail closed.');
if (!/__organizeRunToken/.test(organizeRuntime)) fail('Organize run ownership token is missing.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back/i.test(organizeRuntime)) fail('OrganizeRuntime retains legacy factory/fallback architecture.');
if (!/timeoutMs:0/.test(organizeRuntime)) fail('OrganizeRuntime does not use an unlimited execution timeout.');

const organizeAdapter = read('public/js/organize-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(organizeAdapter)) fail('Organize adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(organizeAdapter)) fail('Organize adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS\s*=\s*0/.test(organizeAdapter)) fail('Organize adapter has an artificial timeout.');
if (!/pipelineStreamToWorker/.test(organizeAdapter)) fail('Organize adapter does not use adaptive streaming.');
if (!/STREAM_THRESHOLD\s*=\s*10\s*\*\s*1024\s*\*\s*1024/.test(organizeAdapter)) fail('Organize adaptive threshold is missing.');
if (!/dedupeKey\s*:\s*key\(file\s*,\s*opts\)/.test(organizeAdapter)) fail('Organize dedupe key is missing.');

const organizeWorker = read('public/workers/pdf-worker.js');
const organizeBlock = organizeWorker.match(/OPS\.organize\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!organizeBlock) fail('Shared PDF worker has no Organize operation.');
if (!/PDFDocument\.load/.test(organizeBlock) || !/copyPages/.test(organizeBlock)) fail('Organize worker page reorder contract is incomplete.');
if (!/pageOrder/.test(organizeBlock)) fail('Organize worker does not consume pageOrder.');
if (!/buffers\[0\]\s*=\s*null/.test(organizeBlock)) fail('Organize worker does not release the source buffer.');
if (!/\bresult\b/.test(organizeBlock)) fail('Organize worker does not produce a result buffer.');
if (!/['"]organize['"]/.test(workerSet)) fail('Organize is not in BrowserTools WORKER_TOOLS.');

// ── Merge canonical tool ───────────────────────────────────────────────────
requirePdfWorkerContract('merge', 'Merge');
const mergeApp = read('public/js/merge-pdf-app.js');
if (!/return _runtime\(\)\.execute\(list, opts \|\| \{\}\)/.test(mergeApp)) fail('Merge app does not dispatch to canonical MergeRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID, function \(\)/.test(mergeApp)) fail('Merge ToolApp boundary is not registered.');
if (!/function unmount\(\)[\s\S]*?_cancel\(/.test(mergeApp)) fail('Merge unmount cancellation is missing.');
if (!/function reset\(\)[\s\S]*?_cancel\(/.test(mergeApp)) fail('Merge reset cancellation is missing.');
if (!/function destroy\(\)[\s\S]*?_cancel\(/.test(mergeApp)) fail('Merge destroy cancellation is missing.');

const mergeRuntime = read('public/js/merge-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(mergeRuntime)) fail('MergeRuntime does not use RuntimeScheduler.');
if (!/RuntimeScheduler is unavailable/.test(mergeRuntime)) fail('MergeRuntime does not fail closed when the canonical scheduler is unavailable.');
if (!/__mergeRunToken/.test(mergeRuntime)) fail('Merge runtime error ownership token is missing.');
if (/runMergeLegacy|runtime-fallback|falling back|legacy path/i.test(mergeRuntime)) fail('MergeRuntime contains a legacy/fallback processing path.');
if (!/timeoutMs\s*:\s*0/.test(mergeRuntime)) fail('Merge runtime does not use unlimited execution timeout.');

const mergeAdapter = read('public/js/merge-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(mergeAdapter)) fail('Merge adapter does not use RuntimeWorkers.dispatch.');
if (/WorkerPool\.run\(/.test(mergeAdapter)) fail('Merge adapter retains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS\s*=\s*0/.test(mergeAdapter)) fail('Merge adapter has an artificial execution timeout.');
if (!/_dedupeKey\(files\)/.test(mergeAdapter)) fail('Merge dedupe key is missing.');
if (!/file\.arrayBuffer\(\)/.test(mergeAdapter)) fail('Merge adapter does not read browser File inputs.');
if (!/buffers\.push\(await file\.arrayBuffer\(\)\)/.test(mergeAdapter)) fail('Merge adapter input ordering is not explicit.');
if (!/streamFilesToWorkerReadable/.test(mergeAdapter)) fail('Merge adapter does not use the shared multi-file streaming bridge.');
if (!/streamThreshold\s*=\s*10\s*\*\s*1024\s*\*\s*1024/.test(mergeAdapter)) fail('Merge adaptive streaming threshold is missing.');
if (!/totalBytes\s*>=\s*streamThreshold/.test(mergeAdapter)) fail('Merge adapter does not route large jobs to streaming.');

if (!/throw new Error\('Merge requires at least one PDF'\)/.test(worker)) fail('Merge worker does not reject an empty input set.');
if (!/Unable to read Merge input/.test(worker)) fail('Merge worker silently skips unreadable Merge inputs.');
if (!/totalPages === 0/.test(worker)) fail('Merge worker does not reject an empty merged document.');
if (!/buffers\[i\] = null/.test(worker)) fail('Merge worker does not release each source buffer after copying.');
if (!/state\.tool === 'merge'/.test(worker)) fail('Merge stream worker does not have an incremental Merge path.');
if (!/state\.mergeDoc\.copyPages/.test(worker)) fail('Merge stream worker does not copy each streamed source into the output document.');
if (!/state\.mergePages\s*===\s*0/.test(worker)) fail('Merge stream worker does not reject an empty streamed output.');
if (/MAX_FILE_BYTES|HARD_LIMIT_MS|WORKER_LIMIT_MS/.test(worker)) fail('Shared PDF worker contains an artificial Merge processing limit.');

const mergeTool = (registry.tools || []).find(t => t.id === 'merge');
if (!mergeTool || mergeTool.multipleFiles !== true) fail('Merge registry does not declare multi-file input.');
if (!mergeTool || mergeTool.clientSide !== true) fail('Merge registry does not declare browser-side processing.');

if (failures.length) {
  console.error('[FAIL] Phase 5 standard-tool gate (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Crop reference contract');
  console.log('[PASS] Rotate canonical-tool contract');
  console.log('[PASS] Merge canonical-tool contract');
  console.log('Phase 5 standard-tool gate: PASS');
}

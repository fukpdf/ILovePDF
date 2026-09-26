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
  if (tool.slug !== id + '-pdf' && !(id === 'page-numbers' && tool.slug === 'add-page-numbers') && !(id === 'workflow' && tool.slug === 'workflow-builder')) {
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

// ── Shared 3-step tool-flow contract ──────────────────────────────────────
const standardFlowIds = (registry.tools || [])
  .filter(t => t.execution !== 'special-page')
  .map(t => t.id);
const toolPageFlow = read('public/js/tool-page.js');
if (!/function renderBrandedUploadStep\(tool, config\)/.test(toolPageFlow)) fail('Shared branded upload renderer is missing.');
if (!/function renderToolPreviewPreparation\(tool\)/.test(toolPageFlow)) fail('Shared preview preparation stage is missing.');
if (!/function runToolPreviewPreparation\(tool, runId, startedAt, minimumMs\)/.test(toolPageFlow)) fail('Shared preview preparation runner is missing.');
if (!/function renderStandardPreviewStep\(tool\)/.test(toolPageFlow)) fail('Shared standard preview renderer is missing.');
if (!/async function processFile\(\)/.test(toolPageFlow)) fail('Shared process boundary is missing.');
if (!/Flow\.commitResult\(\)/.test(toolPageFlow)) fail('Shared result/download flow commit is missing.');
if (!/BrowserTools\.validateInputFiles/.test(toolPageFlow)) fail('Shared input validation boundary is missing.');
if (!/OutputValidator\.check/.test(toolPageFlow)) fail('Shared output validation boundary is missing.');
if (!/No verified browser processor exists for this tool/.test(toolPageFlow)) fail('Shared browser execution fail-closed boundary is missing.');
if (!/cloudButtons:\s*false/.test(toolPageFlow)) fail('Shared upload cloud-provider state changed without a verified CloudUpload integration.');
if (standardFlowIds.length !== 34) fail('Expected 34 non-special standard tools; registry composition changed.');
standardFlowIds.forEach(function (id) {
  const t = (registry.tools || []).find(x => x.id === id);
  if (!t || t.specialRoute) fail(id + ' is a standard tool but still declares a special route.');
});
if (!/function renderStep\(\)[\s\S]*?return renderUploadStep\(currentTool\)/.test(toolPageFlow)) {
  fail('Shared flow orchestrator does not route the canonical upload step through renderUploadStep.');
}
if (!/function renderStep\(\)[\s\S]*?Flow\.step === 'preview'[\s\S]*?renderPreviewStep\(currentTool\)/.test(toolPageFlow)) {
  fail('Shared flow orchestrator does not route preview through renderPreviewStep.');
}
if (!/function renderStep\(\)[\s\S]*?Flow\.step === 'download'[\s\S]*?renderDownloadStep\(currentTool\)/.test(toolPageFlow)) {
  fail('Shared flow orchestrator does not route download through renderDownloadStep.');
}
if (!/function renderPreviewStep\(tool\)[\s\S]*?renderToolPreviewPreparation\(tool\)/.test(toolPageFlow)) {
  fail('Shared preview entry does not use the common preparation stage.');
}
if (!/async function handleFiles\(fileList\)[\s\S]*?Flow\.step === 'upload'[\s\S]*?Flow\.navTo\('preview'\)/.test(toolPageFlow)) {
  fail('Shared file-selection boundary does not transition upload → preview through Flow.');
}
if (!/function renderUploadStep\(tool\)[\s\S]*?renderBrandedUploadStep\(tool, getBrandedUploadConfig\(tool\)\)/.test(toolPageFlow)) {
  fail('Shared upload step does not use the canonical branded upload renderer.');
}
// These are deliberate UI/engine exceptions, not alternate upload flows.
const previewExceptionIds = ['rotate', 'edit', 'background-remover'];
previewExceptionIds.forEach(function (id) {
  const t = (registry.tools || []).find(x => x.id === id);
  if (!t || !standardFlowIds.includes(id)) fail(id + ' preview exception is not part of the standard registry flow.');
});
if (!/tool\.id === 'rotate'[\s\S]*?renderRotatePreviewStep\(tool\)/.test(toolPageFlow)) fail('Rotate preview exception is not isolated behind the shared preview boundary.');
if (!/tool\.id === 'background-remover'[\s\S]*?renderProPreviewStep\(tool\)/.test(toolPageFlow)) fail('Background Remover preview exception is not isolated behind the shared preview boundary.');
if (!/tool\.id === 'edit'[\s\S]*?renderProPreviewStep\(tool\)/.test(toolPageFlow)) fail('Edit PDF preview exception is not isolated behind the shared preview boundary.');
if (/currentTool\.id === 'crop'|currentTool\.id === "crop"/.test(toolPageFlow)) fail('Shared tool page still contains a Crop-only runtime/UI branch.');


// ── Special-page canonical boundary ────────────────────────────────────────
// These tools intentionally remain standalone pages because their UI/engine
// contracts are not the shared PDF tool-shell contract. The gate prevents them
// from silently drifting into the wrong execution path or regressing to hard
// processing limits.
function requireSpecialPageContract(id, label, page, requiredSrc) {
  const tool = (registry.tools || []).find(t => t.id === id);
  if (!tool) {
    fail(label + ' is missing from the canonical tool registry.');
    return;
  }
  if (tool.execution !== 'special-page') fail(label + ' execution must remain special-page.');
  if (!tool.specialRoute || tool.specialRoute !== page.replace(/^public/, '')) {
    fail(label + ' specialRoute does not match its standalone page.');
  }
  if (!tool.capabilities || tool.capabilities.lazyLoad !== true) fail(label + ' lazyLoad contract is missing.');
  if (!tool.capabilities || tool.capabilities.fileSizePolicy !== 'unlimited') fail(label + ' file-size policy is not unlimited.');
  const source = read(page);
  if (!/\/js\/chrome\.js/.test(source)) fail(label + ' does not load the shared chrome layer.');
  if (requiredSrc && !source.includes(requiredSrc)) {
    fail(label + ' required runtime dependency is missing: ' + requiredSrc);
  }
  if (/new\s+Worker\s*\(/.test(source)) fail(label + ' directly spawns a Worker outside the approved runtime boundary.');
  if (/RuntimeScheduler/.test(source)) fail(label + ' unexpectedly embeds the standard tool runtime.');
  if (/HARD_LIMIT_MS|WORKER_LIMIT_MS|MAX_FILE_BYTES|MAX_FILE_SIZE|MAX_INPUT_BYTES|totalMB\s*>\s*400/.test(source)) {
    fail(label + ' retains an artificial processing/input limit.');
  }
}

function requireBrowserRuntimeContract(id, label) {
  const tool = (registry.tools || []).find(t => t.id === id);
  if (!tool) {
    fail(label + ' is missing from the canonical tool registry.');
    return;
  }
  if (tool.execution !== 'browser') fail(label + ' execution must remain browser (non-worker engine).');
  if (!tool.capabilities || tool.capabilities.lazyLoad !== true) fail(label + ' lazyLoad contract is missing.');
  if (!tool.capabilities || tool.capabilities.fileSizePolicy !== 'unlimited') fail(label + ' file-size policy is not unlimited.');
}

// ── Runtime scheduler cancellation contract ───────────────────────────────
const taskScheduler = read('public/js/task-scheduler.js');
const runtimeScheduler = read('public/js/runtime-task-scheduler.js');
if (!/function acquireSlot\(tier, token\)/.test(taskScheduler)) fail('TaskScheduler acquireSlot is not token-cancellable.');
if (!/token\.onCancel\(function \(reason\)/.test(taskScheduler)) fail('TaskScheduler does not remove cancelled queued waiters.');
if (!/slot\.queue\.indexOf\(entry\)/.test(taskScheduler)) fail('TaskScheduler cancellation does not identify the queued entry.');
if (!/entry\.resolve\(\)/.test(taskScheduler)) fail('TaskScheduler queue entries do not resolve through their scheduler contract.');
if (!/acquireSlot\(tier, token\)/.test(runtimeScheduler)) fail('RuntimeScheduler does not pass cancellation into TaskScheduler.');
if (!/if \(!_canStart\(type\)\)[\s\S]*?token\.onCancel\(function \(reason\)[\s\S]*?releaseSlot\(tier\)/.test(runtimeScheduler)) fail('RuntimeScheduler type-cap queue does not release its held tier slot on cancellation.');
if (!/Only create telemetry\/progress resources once both queue layers can start/.test(runtimeScheduler)) fail('RuntimeScheduler may allocate telemetry/progress before queued cancellation is settled.');

const browserRuntime = read('public/js/browser-tool-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(browserRuntime)) fail('BrowserToolRuntime does not use RuntimeScheduler.');
if (!/BrowserTools\.process\(toolId, files, opts/.test(browserRuntime)) fail('BrowserToolRuntime does not dispatch to the existing browser processor.');
if (!/TIMEOUT_MS\s*=\s*0/.test(browserRuntime)) fail('BrowserToolRuntime contains an artificial execution timeout.');
if (!/dedupeKey\(toolId, files, opts\)/.test(browserRuntime) || !/dedupeKey: dedupeKey/.test(browserRuntime)) fail('BrowserToolRuntime dedupe contract is missing.');
if (!/cancelAll\(reason\)/.test(browserRuntime) || !/pagehide/.test(browserRuntime)) fail('BrowserToolRuntime lifecycle cancellation is incomplete.');

const browserRuntimeIds = [
  ['pdf-to-word', 'PDF to Word'], ['pdf-to-powerpoint', 'PDF to PowerPoint'],
  ['pdf-to-excel', 'PDF to Excel'], ['pdf-to-jpg', 'PDF to JPG'],
  ['word-to-pdf', 'Word to PDF'], ['powerpoint-to-pdf', 'PowerPoint to PDF'],
  ['excel-to-pdf', 'Excel to PDF'], ['word-to-excel', 'Word to Excel'],
  ['jpg-to-pdf', 'JPG to PDF'], ['html-to-pdf', 'HTML to PDF'],
  ['scan-to-pdf', 'Scan'], ['ocr', 'OCR'], ['ai-summarize', 'AI Summarizer'],
  ['background-remover', 'Background Remover'], ['crop-image', 'Crop Image'],
  ['resize-image', 'Image Resize'], ['image-filters', 'Image Filters'],
];
browserRuntimeIds.forEach(function (pair) { requireBrowserRuntimeContract(pair[0], pair[1]); });
const browserEngineLimitChecks = [
  ['ai-summarize', 'public/js/ai-summarizer-app.js'],
  ['scan-to-pdf', 'public/js/scan-pdf-app.js'],
  ['background-remover', 'public/js/remove-background-app.js'],
  ['html-to-pdf', 'public/js/html-pdf-app.js'],
];
browserEngineLimitChecks.forEach(function (pair) {
  const source = read(pair[1]);
  if (/HARD_LIMIT_MS|WORKER_LIMIT_MS|hard-timeout|hardPromise|_hardTimer|_hardReject/.test(source)) {
    fail(pair[0] + ' retains an artificial execution timeout.');
  }
  if (/totalMB\s*>\s*400|400\s*\*\s*1024\s*\*\s*1024/.test(source)) {
    fail(pair[0] + ' retains an artificial 400 MB input limit.');
  }
});


if (!/browser-tool-runtime\.js/.test(read('public/tool.html'))) fail('Canonical browser runtime adapter is not loaded by the standard tool shell.');
if (!/registryTool\.execution === 'browser'/.test(read('public/js/tool-page.js'))) fail('Tool page does not route registry browser tools through BrowserToolRuntime.');

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
if (!/currentTool\.id === 'organize'[\s\S]*?getOrderSummary/.test(toolPage) || !/opts\.pageOrder\s*=\s*Array\.isArray\(summary\.order\)/.test(toolPage)) fail('Organize page order is not passed from PageOrganizer to the canonical worker options.');


// ── Page Numbers canonical tool ────────────────────────────────────────────
requirePdfWorkerContract('page-numbers', 'Page Numbers');
const pageNumbersApp = read('public/js/page-numbers-app.js');
if (!/runtime\(\)\.execute\(files\[0\]\s*,\s*opts\s*\|\|\s*\{\}\)/.test(pageNumbersApp)) fail('Page Numbers app does not dispatch to PageNumbersRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID, function \(\)/.test(pageNumbersApp)) fail('Page Numbers ToolApp boundary is not registered.');
if (!/function unmount\(\) \{ cancel\(\); \}/.test(pageNumbersApp) || !/function reset\(\) \{ cancel\(\); \}/.test(pageNumbersApp) || !/function destroy\(\) \{ cancel\(\); \}/.test(pageNumbersApp)) fail('Page Numbers lifecycle cancellation is incomplete.');

const pageNumbersRuntime = read('public/js/page-numbers-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(pageNumbersRuntime)) fail('Page Numbers runtime does not use RuntimeScheduler.');
if (!/RuntimeScheduler is unavailable/.test(pageNumbersRuntime)) fail('Page Numbers runtime does not fail closed.');
if (!/__pageNumbersRunToken/.test(pageNumbersRuntime)) fail('Page Numbers run ownership token is missing.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back|fallback/i.test(pageNumbersRuntime)) fail('Page Numbers runtime retains legacy/fallback architecture.');
if (!/timeoutMs: 0/.test(pageNumbersRuntime)) fail('Page Numbers runtime does not use an unlimited execution timeout.');

const pageNumbersAdapter = read('public/js/page-numbers-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(pageNumbersAdapter)) fail('Page Numbers adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(pageNumbersAdapter)) fail('Page Numbers adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS = 0/.test(pageNumbersAdapter)) fail('Page Numbers adapter has an artificial timeout.');
if (!/pipelineStreamToWorker/.test(pageNumbersAdapter)) fail('Page Numbers adapter does not use adaptive streaming.');
if (!/STREAM_THRESHOLD = 10 \* 1024 \* 1024/.test(pageNumbersAdapter)) fail('Page Numbers adaptive threshold is missing.');
if (!/dedupeKey: key\(file, opts\)/.test(pageNumbersAdapter)) fail('Page Numbers dedupe key is missing.');
if (!/startFrom/.test(pageNumbersAdapter) || !/position/.test(pageNumbersAdapter)) fail('Page Numbers option identity is incomplete.');

const pageNumbersWorker = read('public/workers/pdf-worker.js');
const pageNumbersBlock = pageNumbersWorker.match(/OPS\['page-numbers'\]\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!pageNumbersBlock) fail('Shared PDF worker has no Page Numbers operation.');
if (!/PDFDocument\.load/.test(pageNumbersBlock) || !/getPages\(\)/.test(pageNumbersBlock) || !/drawText/.test(pageNumbersBlock)) fail('Page Numbers worker drawing contract is incomplete.');
if (!/startFrom/.test(pageNumbersBlock) || !/position/.test(pageNumbersBlock)) fail('Page Numbers worker does not consume numbering options.');
if (!/buffers\[0\]\s*=\s*null/.test(pageNumbersBlock)) fail('Page Numbers worker does not release the source buffer.');
if (!/['"]page-numbers['"]/.test(workerSet)) fail('Page Numbers is not in BrowserTools WORKER_TOOLS.');
if (!/page-numbers-worker-adapter\.js/.test(toolHtml)) fail('Page Numbers adapter is not loaded by the standard tool shell.');

// ── Redact PDF canonical tool ─────────────────────────────────────────────
requirePdfWorkerContract('redact', 'Redact PDF');
const redactApp = read('public/js/redact-pdf-app.js');
if (!/execute\(f\[0\],o\|\|\{\}\)/.test(redactApp)) fail('Redact app does not dispatch to RedactRuntime.');
if (!/ToolAppManager\.registerTool\(ID,function\(\)/.test(redactApp)) fail('Redact ToolApp boundary is not registered.');
if (!/function unmount\(\)\{cancel\(\)\}/.test(redactApp) || !/function reset\(\)\{cancel\(\)\}/.test(redactApp) || !/function destroy\(\)\{cancel\(\)\}/.test(redactApp)) fail('Redact lifecycle cancellation is incomplete.');
const redactRuntime = read('public/js/redact-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(redactRuntime)) fail('Redact runtime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|fallback/i.test(redactRuntime)) fail('Redact runtime retains legacy/fallback architecture.');
if (!/timeoutMs:0/.test(redactRuntime)) fail('Redact runtime has an artificial timeout.');
if (!/__redactRunToken/.test(redactRuntime)) fail('Redact run ownership token is missing.');
const redactAdapter = read('public/js/redact-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(redactAdapter)) fail('Redact adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(redactAdapter)) fail('Redact adapter contains a direct WorkerPool fallback.');
if (!/T=0/.test(redactAdapter)) fail('Redact adapter timeout contract is missing.');
if (!/dedupeKey:key\(f,o\)/.test(redactAdapter)) fail('Redact dedupe key is missing.');
const redactWorker = read('public/workers/redact-worker.js');
if (!/d\.tool !== 'redact'|d\.tool === 'redact'/.test(redactWorker) || !/d\.opts = d\.opts \|\| d\.options/.test(redactWorker)) fail('Redact worker canonical protocol is missing.');
if (!/pdfjs-dist/.test(redactWorker) || !/renderRedactedPage/.test(redactWorker) || !/embedPng/.test(redactWorker)) fail('Redact true-flattening security path is missing.');
if (!/copyPages/.test(redactWorker)) fail('Redact non-target page preservation is missing.');
if (!/redact-worker-adapter\.js/.test(toolHtml)) fail('Redact adapter is not loaded by the standard tool shell.');

// ── Sign PDF canonical tool ───────────────────────────────────────────────
requirePdfWorkerContract('sign', 'Sign PDF');
const signApp = read('public/js/sign-pdf-app.js');
if (!/execute\(f\[0\],o\|\|\{\}\)/.test(signApp)) fail('Sign app does not dispatch to SignRuntime.');
if (!/ToolAppManager\.registerTool\(ID,function\(\)/.test(signApp)) fail('Sign ToolApp boundary is not registered.');
if (!/function unmount\(\)\{cancel\(\)\}/.test(signApp) || !/function reset\(\)\{cancel\(\)\}/.test(signApp) || !/function destroy\(\)\{cancel\(\)\}/.test(signApp)) fail('Sign lifecycle cancellation is incomplete.');
const signRuntime = read('public/js/sign-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(signRuntime)) fail('Sign runtime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|fallback/i.test(signRuntime)) fail('Sign runtime retains legacy/fallback architecture.');
if (!/timeoutMs:0/.test(signRuntime)) fail('Sign runtime has an artificial timeout.');
if (!/__signRunToken/.test(signRuntime)) fail('Sign run ownership token is missing.');
const signAdapter = read('public/js/sign-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(signAdapter)) fail('Sign adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(signAdapter)) fail('Sign adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS:W|T=0/.test(signAdapter)) fail('Sign adapter timeout contract is missing.');
if (!/pipelineStreamToWorker/.test(signAdapter) || !/S=10\*1024\*1024/.test(signAdapter)) fail('Sign adaptive streaming contract is missing.');
if (!/dedupeKey:key\(f,o\)/.test(signAdapter)) fail('Sign dedupe key is missing.');
const signWorker = read('public/workers/pdf-worker.js');
const signBlock = signWorker.match(/OPS\.sign\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!signBlock) fail('Shared PDF worker has no Sign operation.');
if (!/PDFDocument\.load/.test(signBlock) || !/drawText/.test(signBlock) || !/drawLine/.test(signBlock)) fail('Sign worker drawing contract is incomplete.');
if (!/signatureText|opts\.text/.test(signBlock)) fail('Sign worker does not consume signature text.');
if (!/buffers\[0\]\s*=\s*null/.test(signBlock)) fail('Sign worker does not release the source buffer.');
if (!/sign-worker-adapter\.js/.test(toolHtml)) fail('Sign adapter is not loaded by the standard tool shell.');

// ── Compress PDF canonical tool ─────────────────────────────────────────────
requirePdfWorkerContract('compress', 'Compress PDF');
const compressApp = read('public/js/compress-pdf-app.js');
if (!/runtime\(\)\.execute\(files\[0\], opts \|\| \{\}\)/.test(compressApp)) fail('Compress app does not dispatch to CompressRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID, function \(\)/.test(compressApp)) fail('Compress ToolApp boundary is not registered.');
if (!/function unmount\(\) \{ cancel\(\); \}/.test(compressApp) || !/function reset\(\) \{ cancel\(\); \}/.test(compressApp) || !/function destroy\(\) \{ cancel\(\); \}/.test(compressApp)) fail('Compress lifecycle cancellation is incomplete.');

const compressRuntime = read('public/js/compress-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(compressRuntime)) fail('Compress runtime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back|fallback|inlineFallback/i.test(compressRuntime)) fail('Compress runtime retains legacy/fallback architecture.');
if (!/__compressRunToken/.test(compressRuntime)) fail('Compress run ownership token is missing.');
if (!/timeoutMs: 0/.test(compressRuntime)) fail('Compress runtime does not use an unlimited execution timeout.');

const compressAdapter = read('public/js/compress-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(compressAdapter)) fail('Compress adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(compressAdapter)) fail('Compress adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS = 0/.test(compressAdapter)) fail('Compress adapter has an artificial execution timeout.');
if (!/dedupeKey: key\(file, opts\)/.test(compressAdapter)) fail('Compress dedupe key is missing.');
if (!/buffers: \[buffer\]/.test(compressAdapter)) fail('Compress adapter input transfer is incomplete.');

const compressWorker = read('public/workers/pdf-worker.js');
const compressBlock = compressWorker.match(/OPS\.compress\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!compressBlock) fail('Shared PDF worker has no Compress operation.');
if (!/PDFDocument\.load/.test(compressBlock) || !/useObjectStreams/.test(compressBlock)) fail('Compress worker optimization contract is incomplete.');
if (!/stripMetadata/.test(compressBlock)) fail('Compress worker does not strip document metadata.');
if (!/result\.byteLength < original\.byteLength/.test(compressBlock)) fail('Compress worker does not avoid returning a larger result.');

// ── Edit PDF canonical tool ─────────────────────────────────────────────────
requirePdfWorkerContract('edit', 'Edit PDF');
const editApp = read('public/js/edit-pdf-app.js');
if (!/__canonical/.test(editApp) || !/runtime\(\)\.execute\(files\[0\],opts\|\|\{\}\)/.test(editApp)) fail('Edit app does not dispatch to canonical EditRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID,\s*function\s*\(\)/.test(editApp)) fail('Edit ToolApp boundary is not registered.');
if (!/function unmount\(\)\{cancel\(\);\}/.test(editApp) || !/function reset\(\)\{cancel\(\);\}/.test(editApp) || !/function destroy\(\)\{cancel\(\);\}/.test(editApp)) fail('Edit lifecycle cancellation is incomplete.');

const editRuntime = read('public/js/edit-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(editRuntime)) fail('Edit runtime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back|fallback/i.test(editRuntime)) fail('Edit runtime retains legacy/fallback architecture.');
if (!/__editRunToken/.test(editRuntime)) fail('Edit run ownership token is missing.');
if (!/timeoutMs:0/.test(editRuntime)) fail('Edit runtime does not use an unlimited execution timeout.');

const editAdapter = read('public/js/edit-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(editAdapter)) fail('Edit adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(editAdapter)) fail('Edit adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS = 0/.test(editAdapter)) fail('Edit adapter has an artificial execution timeout.');
if (!/dedupeKey: key\(file, opts\)/.test(editAdapter)) fail('Edit dedupe key is missing.');
if (!/buffers: \[buffer\]/.test(editAdapter)) fail('Edit adapter input transfer is incomplete.');

const editWorker = read('public/workers/pdf-worker.js');
const editBlock = editWorker.match(/OPS\.edit\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!editBlock) fail('Shared PDF worker has no Edit operation.');
if (!/PDFDocument\.load/.test(editBlock) || !/doc\.drawText|page\.drawText/.test(editBlock)) fail('Edit worker text operation contract is incomplete.');
if (!/fontSize/.test(editBlock) || !/opts\.page/.test(editBlock)) fail('Edit worker page/font options contract is incomplete.');

// ── Repair PDF canonical tool ───────────────────────────────────────────────
requirePdfWorkerContract('repair', 'Repair PDF');
const repairRuntime = read('public/js/repair-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(repairRuntime)) fail('Repair runtime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back|fallback|RUNTIME_REPAIR_ENABLED/i.test(repairRuntime)) fail('Repair runtime retains legacy/fallback architecture.');
if (!/timeoutMs:0/.test(repairRuntime)) fail('Repair runtime does not use unlimited execution timeout.');

const repairAdapter = read('public/js/repair-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(repairAdapter)) fail('Repair adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(repairAdapter)) fail('Repair adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS=0/.test(repairAdapter)) fail('Repair adapter has an artificial execution timeout.');
if (!/dedupeKey:key\(file\)/.test(repairAdapter)) fail('Repair dedupe key is missing.');
if (!/buffers:\[buffer\]/.test(repairAdapter)) fail('Repair adapter input transfer is incomplete.');

const repairApp = read('public/js/repair-pdf-app.js');
if (!/ToolAppManager\.registerTool\('repair'/.test(repairApp)) fail('Repair app canonical ToolApp boundary is missing.');
if (!/cancelActive\('unmount'\)/.test(repairApp) || !/cancelActive\('destroy'\)/.test(repairApp)) fail('Repair app lifecycle cancellation is incomplete.');
if (/new Worker\(|repair-worker\.js|HARD_LIMIT_MS|WORKER_LIMIT_MS/.test(repairApp)) fail('Repair app still owns a legacy dedicated worker/timeout path.');

// ── Workflow Builder canonical tool ─────────────────────────────────────────
requirePdfWorkerContract('workflow', 'Workflow Builder');
const workflowRuntime = read('public/js/workflow-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(workflowRuntime)) fail('Workflow runtime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back|fallback|RUNTIME_WORKFLOW_ENABLED/i.test(workflowRuntime)) fail('Workflow runtime retains legacy/fallback architecture.');
if (!/__workflowRunToken/.test(workflowRuntime)) fail('Workflow run ownership token is missing.');
if (!/timeoutMs:0/.test(workflowRuntime)) fail('Workflow runtime does not use an unlimited execution timeout.');

const workflowAdapter = read('public/js/workflow-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(workflowAdapter)) fail('Workflow adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(workflowAdapter)) fail('Workflow adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS = 0/.test(workflowAdapter)) fail('Workflow adapter has an artificial execution timeout.');
if (!/dedupeKey:key\(file,opts\)/.test(workflowAdapter)) fail('Workflow dedupe key is missing.');
if (!/buffers:\[buffer\]/.test(workflowAdapter)) fail('Workflow adapter input transfer is incomplete.');

const workflowWorker = read('public/workers/pdf-worker.js');
const workflowBlock = workflowWorker.match(/OPS\.workflow\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!workflowBlock) fail('Shared PDF worker has no Workflow operation.');
if (!/opts\.step1/.test(workflowBlock) || !/opts\.step2/.test(workflowBlock) || !/opts\.step3/.test(workflowBlock)) fail('Workflow worker step contract is incomplete.');
if (!/Please select at least one operation/.test(workflowBlock)) fail('Workflow worker validation contract is incomplete.');

// ── Watermark canonical tool ──────────────────────────────────────────────
requirePdfWorkerContract('watermark', 'Watermark');
const watermarkApp = read('public/js/watermark-pdf-app.js');
if (!/runtime\(\)\.execute\(files\[0\], opts \|\| \{\}\)/.test(watermarkApp)) fail('Watermark app does not dispatch to WatermarkRuntime.');
if (!/ToolAppManager\.registerTool\(TOOL_ID, function \(\)/.test(watermarkApp)) fail('Watermark ToolApp boundary is not registered.');
if (!/function unmount\(\)[\s\S]*?_cancel\(/.test(watermarkApp) && !/function unmount\(\) \{ cancel\(\); \}/.test(watermarkApp)) fail('Watermark unmount cancellation is missing.');
if (!/function reset\(\)[\s\S]*?_cancel\(/.test(watermarkApp) && !/function reset\(\) \{ cancel\(\); \}/.test(watermarkApp)) fail('Watermark reset cancellation is missing.');
if (!/function destroy\(\)[\s\S]*?_cancel\(/.test(watermarkApp) && !/function destroy\(\) \{ cancel\(\); \}/.test(watermarkApp)) fail('Watermark destroy cancellation is missing.');

const watermarkRuntime = read('public/js/watermark-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(watermarkRuntime)) fail('Watermark runtime does not use RuntimeScheduler.');
if (!/RuntimeScheduler is unavailable/.test(watermarkRuntime)) fail('Watermark runtime does not fail closed.');
if (!/__watermarkRunToken/.test(watermarkRuntime)) fail('Watermark run ownership token is missing.');
if (/PdfWorkerRuntimeFactory|legacy path|falling back|fallback/i.test(watermarkRuntime)) fail('Watermark runtime retains legacy/fallback architecture.');
if (!/timeoutMs: 0/.test(watermarkRuntime)) fail('Watermark runtime does not use an unlimited execution timeout.');

const watermarkAdapter = read('public/js/watermark-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(watermarkAdapter)) fail('Watermark adapter does not use RuntimeWorkers.');
if (/WorkerPool\.run\(/.test(watermarkAdapter)) fail('Watermark adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS = 0/.test(watermarkAdapter)) fail('Watermark adapter has an artificial timeout.');
if (!/pipelineStreamToWorker/.test(watermarkAdapter)) fail('Watermark adapter does not use adaptive streaming.');
if (!/STREAM_THRESHOLD = 10 \* 1024 \* 1024/.test(watermarkAdapter)) fail('Watermark adaptive threshold is missing.');
if (!/dedupeKey: key\(file, opts\)/.test(watermarkAdapter)) fail('Watermark dedupe key is missing.');
if (!/text/.test(watermarkAdapter) || !/opacity/.test(watermarkAdapter) || !/position/.test(watermarkAdapter)) fail('Watermark option identity is incomplete.');

const watermarkWorker = read('public/workers/pdf-worker.js');
const watermarkBlock = watermarkWorker.match(/OPS\.watermark\s*=\s*async function[\s\S]*?(?=\nOPS\.|$)/)?.[0] || '';
if (!watermarkBlock) fail('Shared PDF worker has no Watermark operation.');
if (!/PDFDocument\.load/.test(watermarkBlock) || !/drawText/.test(watermarkBlock)) fail('Watermark worker drawing contract is incomplete.');
if (!/text/.test(watermarkBlock) || !/opacity/.test(watermarkBlock) || !/position/.test(watermarkBlock)) fail('Watermark worker does not consume watermark options.');
if (!/buffers\[0\]\s*=\s*null/.test(watermarkBlock)) fail('Watermark worker does not release the source buffer.');
if (!/['"]watermark['"]/.test(workerSet)) fail('Watermark is not in BrowserTools WORKER_TOOLS.');
if (!/watermark-worker-adapter\.js/.test(toolHtml)) fail('Watermark adapter is not loaded by the standard tool shell.');

// ── Rotate canonical-tool residue checks ─────────────────────────────────
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
  console.log('[PASS] Compress PDF canonical-tool contract');
  console.log('[PASS] Edit PDF canonical-tool contract');
  console.log('[PASS] Workflow Builder canonical-tool contract');
  console.log('[PASS] Crop reference contract');
  console.log('[PASS] Rotate canonical-tool contract');
  console.log('[PASS] Page Numbers canonical-tool contract');
  console.log('[PASS] Merge canonical-tool contract');
  console.log('Phase 5 standard-tool gate: PASS');
}


// ── Protect canonical tool ────────────────────────────────────────────────
requirePdfWorkerContract('protect', 'Protect');
const protectApp = read('public/js/protect-pdf-app.js');
if (!/return result=await G\.ProtectRuntime\.execute/.test(protectApp) && !/G\.ProtectRuntime\.execute/.test(protectApp)) fail('Protect app does not dispatch to canonical ProtectRuntime.');
if (!/ToolAppManager\.registerTool\('protect'/.test(protectApp)) fail('Protect ToolApp boundary is not registered.');
if (!/function unmount\(\)[\s\S]*?cancelActive/.test(protectApp)) fail('Protect unmount cancellation is missing.');
if (!/function reset\(\)[\s\S]*?cancelActive/.test(protectApp)) fail('Protect reset cancellation is missing.');
if (!/function destroy\(\)[\s\S]*?cancelActive/.test(protectApp)) fail('Protect destroy cancellation is missing.');

const protectRuntime = read('public/js/protect-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(protectRuntime)) fail('ProtectRuntime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|fallback/i.test(protectRuntime)) fail('ProtectRuntime retains legacy factory/fallback architecture.');
if (!/timeoutMs\s*:\s*0/.test(protectRuntime)) fail('ProtectRuntime does not use an unlimited execution timeout.');
if (!/cancelActive/.test(protectRuntime)) fail('ProtectRuntime cancellation is missing.');

const protectAdapter = read('public/js/protect-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(protectAdapter)) fail('Protect adapter does not use RuntimeWorkers.dispatch.');
if (/WorkerPool\.run\(/.test(protectAdapter)) fail('Protect adapter retains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS\s*=\s*0/.test(protectAdapter)) fail('Protect adapter has an artificial execution timeout.');
if (!/dedupeKey:key\(file,options\)/.test(protectAdapter)) fail('Protect adapter does not provide a password-aware dedupe key.');
if (!/\[buffer\]/.test(protectAdapter)) fail('Protect adapter does not transfer the input ArrayBuffer.');

const protectWorker = read('public/workers/pdf-worker.js');
if (!/OPS\.protect\s*=\s*async function/.test(protectWorker)) fail('Shared PDF worker has no Protect operation.');
if (!/Please enter a password to protect the PDF/.test(protectWorker)) fail('Protect worker password validation is missing.');


// ── Unlock canonical tool ────────────────────────────────────────────────
requirePdfWorkerContract('unlock', 'Unlock');
const unlockApp = read('public/js/unlock-pdf-app.js');
if (!/G\.UnlockRuntime\.execute/.test(unlockApp)) fail('Unlock app does not dispatch to canonical UnlockRuntime.');
if (!/ToolAppManager\.registerTool\('unlock'/.test(unlockApp)) fail('Unlock ToolApp boundary is not registered.');
if (!/function unmount\(\)[\s\S]*?cancelActive/.test(unlockApp)) fail('Unlock unmount cancellation is missing.');
if (!/function reset\(\)[\s\S]*?cancelActive/.test(unlockApp)) fail('Unlock reset cancellation is missing.');
if (!/function destroy\(\)[\s\S]*?cancelActive/.test(unlockApp)) fail('Unlock destroy cancellation is missing.');

const unlockRuntime = read('public/js/unlock-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(unlockRuntime)) fail('UnlockRuntime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|fallback/i.test(unlockRuntime)) fail('UnlockRuntime retains legacy factory/fallback architecture.');
if (!/timeoutMs:0/.test(unlockRuntime)) fail('UnlockRuntime does not use an unlimited execution timeout.');

const unlockAdapter = read('public/js/unlock-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(unlockAdapter)) fail('Unlock adapter does not use RuntimeWorkers.dispatch.');
if (/WorkerPool\.run\(/.test(unlockAdapter)) fail('Unlock adapter retains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS\s*=\s*0/.test(unlockAdapter)) fail('Unlock adapter has an artificial execution timeout.');
if (!/dedupeKey:key\(file\)/.test(unlockAdapter)) fail('Unlock adapter does not provide a dedupe key.');
if (!/\[buffer\]/.test(unlockAdapter)) fail('Unlock adapter does not transfer the input ArrayBuffer.');

const unlockWorker = read('public/workers/pdf-worker.js');
if (!/OPS\.unlock\s*=\s*async function/.test(unlockWorker)) fail('Shared PDF worker has no Unlock operation.');


// ── Compare canonical tool ───────────────────────────────────────────────
requirePdfWorkerContract('compare', 'Compare');
const compareApp = read('public/js/compare-pdf-app.js');
if (!/G\.CompareRuntime\.execute/.test(compareApp)) fail('Compare app does not dispatch to canonical CompareRuntime.');
if (!/ToolAppManager\.registerTool\('compare'/.test(compareApp)) fail('Compare ToolApp boundary is not registered.');
if (!/function unmount\(\)[\s\S]*?cancelActive/.test(compareApp)) fail('Compare unmount cancellation is missing.');
if (!/function reset\(\)[\s\S]*?cancelActive/.test(compareApp)) fail('Compare reset cancellation is missing.');
if (!/function destroy\(\)[\s\S]*?cancelActive/.test(compareApp)) fail('Compare destroy cancellation is missing.');
if (/new Worker\(|compare-worker\.js|HARD_LIMIT_MS|WORKER_LIMIT_MS|Tesseract/i.test(compareApp)) fail('Compare app still owns the legacy dedicated worker/OCR timeout path.');

const compareRuntime = read('public/js/compare-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(compareRuntime)) fail('CompareRuntime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|legacy path|fallback|RUNTIME_COMPARE_ENABLED/i.test(compareRuntime)) fail('CompareRuntime retains legacy/factory/fallback architecture.');
if (!/timeoutMs:0/.test(compareRuntime)) fail('CompareRuntime does not use an unlimited execution timeout.');
if (!/cancelActive/.test(compareRuntime)) fail('CompareRuntime cancellation is missing.');

const compareAdapter = read('public/js/compare-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(compareAdapter)) fail('Compare adapter does not use RuntimeWorkers.dispatch.');
if (/WorkerPool\.run\(/.test(compareAdapter)) fail('Compare adapter retains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS=0/.test(compareAdapter)) fail('Compare adapter has an artificial execution timeout.');
if (!/dedupeKey:key\(files\)/.test(compareAdapter)) fail('Compare adapter does not provide a two-file dedupe key.');
if (!/buffers\.push\(buffer\)/.test(compareAdapter)) fail('Compare adapter does not preserve multi-file input buffers.');
if (!/WORKER_URL='\/workers\/pdf-worker\.js'/.test(compareAdapter)) fail('Compare adapter does not use the shared PDF worker.');

const compareWorker = read('public/workers/pdf-worker.js');
if (!/OPS\.compare\s*=\s*async function/.test(compareWorker)) fail('Shared PDF worker has no Compare operation.');
if (!/Two PDFs required for comparison/.test(compareWorker)) fail('Compare worker does not validate two PDF inputs.');
if (!/PDFDocument\.load\(buffers\[0\]/.test(compareWorker) || !/PDFDocument\.load\(buffers\[1\]/.test(compareWorker)) fail('Compare worker does not load both PDF inputs.');
if (!/Structural result/.test(compareWorker)) fail('Compare worker structural report contract is missing.');
if (!/buffers\[0\] = null/.test(compareWorker) || !/buffers\[1\] = null/.test(compareWorker)) fail('Compare worker does not release source buffers.');

const compareTool = (registry.tools || []).find(t => t.id === 'compare');
if (!compareTool || compareTool.execution !== 'browser-worker') fail('Compare registry is not browser-worker.');
if (!compareTool || !compareTool.capabilities || compareTool.capabilities.streaming !== 'adaptive-worker') fail('Compare registry does not declare adaptive worker streaming.');
if (!compareTool || !compareTool.capabilities || compareTool.capabilities.workerPool !== true) fail('Compare registry does not declare worker pool execution.');
if (!/compare-worker-adapter\.js/.test(toolHtml)) fail('Compare adapter is not loaded by the standard tool shell.');



// ── OCR canonical specialized tool boundary ────────────────────────────────
const ocrApp = read('public/js/ocr-tool-app.js');
if (!/G\.OCRRuntime\.execute/.test(ocrApp)) fail('OCR app does not dispatch to canonical OCRRuntime.');
if (!/ToolAppManager\.registerTool\('ocr'/.test(ocrApp)) fail('OCR ToolApp boundary is not registered.');
if (!/G\.__OCRToolEngine/.test(ocrApp)) fail('OCR engine boundary is missing.');
if (!/G\.OCRRuntime\.cancelActive\('unmount'\)/.test(ocrApp) || !/G\.OCRRuntime\.cancelActive\('reset'\)/.test(ocrApp) || !/G\.OCRRuntime\.cancelActive\('destroy'\)/.test(ocrApp)) fail('OCR lifecycle cancellation is incomplete.');
if (/PdfWorkerRuntimeFactory|RUNTIME_OCR_ENABLED/i.test(ocrApp)) fail('OCR app retains legacy runtime factory/feature flag architecture.');

const ocrRuntime = read('public/js/ocr-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(ocrRuntime)) fail('OCRRuntime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|fallback/i.test(ocrRuntime)) fail('OCRRuntime retains legacy/fallback architecture.');
if (!/timeoutMs:0/.test(ocrRuntime)) fail('OCRRuntime does not use an unlimited scheduler timeout.');
if (!/OCRWorkerAdapter\.dispatch/.test(ocrRuntime)) fail('OCRRuntime does not dispatch through OCRWorkerAdapter.');

const ocrAdapter = read('public/js/ocr-worker-adapter.js');
if (!/G\.__OCRToolEngine\.process/.test(ocrAdapter)) fail('OCR adapter does not bind to the isolated OCR engine.');
if (/WorkerPool\.run\(/.test(ocrAdapter)) fail('OCR adapter contains a direct WorkerPool fallback.');
if (!/TIMEOUT_MS=0/.test(ocrAdapter)) fail('OCR adapter has an artificial scheduler timeout.');
if (!/function key\(file,opts\)/.test(ocrAdapter) || !/dedupeKey:key/.test(ocrAdapter)) fail('OCR adapter dedupe key is missing.');
if (!/cancel\(reason\)/.test(ocrAdapter)) fail('OCR adapter cancellation contract is missing.');
if (!/ocr-worker-adapter\.js/.test(toolHtml) || !/ocr-runtime\.js/.test(toolHtml)) fail('OCR canonical runtime files are not loaded by the standard tool shell.');

// ── Translate canonical tool ─────────────────────────────────────────────
requirePdfWorkerContract('translate', 'Translate');
const translateApp = read('public/js/translate-pdf-app.js');
if (!/G\.TranslateRuntime\.execute/.test(translateApp)) fail('Translate app does not dispatch to canonical TranslateRuntime.');
if (!/ToolAppManager\.registerTool\('translate'/.test(translateApp)) fail('Translate ToolApp boundary is not registered.');
if (!/cancelActive/.test(translateApp)) fail('Translate lifecycle cancellation is missing.');
if (/new Worker\(|translation-worker\.js|HARD_LIMIT_MS|WORKER_LIMIT_MS|PdfWorkerRuntimeFactory|RUNTIME_TRANSLATE_ENABLED/i.test(translateApp)) fail('Translate app still owns legacy worker/factory timeout architecture.');

const translateRuntime = read('public/js/translate-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(translateRuntime)) fail('TranslateRuntime does not use RuntimeScheduler.');
if (/PdfWorkerRuntimeFactory|RUNTIME_TRANSLATE_ENABLED|fallback/i.test(translateRuntime)) fail('TranslateRuntime retains legacy/factory/fallback architecture.');
if (!/timeoutMs:0/.test(translateRuntime)) fail('TranslateRuntime does not use unlimited execution timeout.');

const translateAdapter = read('public/js/translate-worker-adapter.js');
if (!/RuntimeWorkers\.dispatch\(/.test(translateAdapter)) fail('Translate adapter does not use RuntimeWorkers.dispatch.');
if (!/TIMEOUT_MS=0/.test(translateAdapter)) fail('Translate adapter has an artificial execution timeout.');
if (!/dedupeKey:key\(file,o\)/.test(translateAdapter)) fail('Translate adapter does not provide a deterministic dedupe key.');
if (!/WORKER_URL='\/workers\/pdf-worker\.js'/.test(translateAdapter)) fail('Translate adapter does not use shared PDF worker.');

const translateWorker = read('public/workers/pdf-worker.js');
if (!/OPS\.translate\s*=\s*async function/.test(translateWorker)) fail('Shared PDF worker has no Translate operation.');

const translateTool = (registry.tools || []).find(t => t.id === 'translate');
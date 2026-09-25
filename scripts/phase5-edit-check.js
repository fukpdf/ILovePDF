#!/usr/bin/env node
// Phase 5 Unit 8 — Edit PDF standard-tool migration gate.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const registry = JSON.parse(read('config/tool-registry.json'));
const published = JSON.parse(read('public/config/tool-registry.json'));
const failures = [];
const fail = msg => failures.push(msg);

const edit = (registry.tools || []).find(t => t.id === 'edit');
if (!edit) fail('Edit is missing from the canonical tool registry.');
else {
  if (edit.slug !== 'edit-pdf') fail('Edit slug is not edit-pdf.');
  if (edit.module !== 'pdf-module') fail('Edit module owner is not pdf-module.');
  if (edit.execution !== 'browser-worker') fail('Edit execution is not browser-worker.');
  if (!edit.capabilities || edit.capabilities.lazyLoad !== true) fail('Edit lazyLoad contract is missing.');
  if (edit.capabilities.workerPool !== true) fail('Edit workerPool contract is missing.');
  if (edit.capabilities.streaming !== 'adaptive-worker') fail('Edit adaptive-worker streaming contract is missing.');
  if (edit.capabilities.fileSizePolicy !== 'unlimited') fail('Edit file-size policy is not unlimited.');
}

const pubEdit = published.tools.find(t => t.id === 'edit');
if (JSON.stringify(pubEdit) !== JSON.stringify(edit)) fail('Published Edit registry entry differs from canonical.');

const browserTools = read('public/js/browser-tools.js');
const workerSet = browserTools.match(/const WORKER_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
if (!/['"]edit['"]/.test(workerSet)) fail('Edit is not in BrowserTools WORKER_TOOLS.');
if (!/cancelToken/.test(browserTools)) fail('BrowserTools has no shared cancellation-token boundary.');
if (!/pipelineStreamToWorker/.test(browserTools) || !/WorkerPool/.test(browserTools)) fail('BrowserTools lacks adaptive-worker + WorkerPool execution.');

const worker = read('public/workers/pdf-worker.js');
if (!/OPS\.edit\s*=\s*async function/.test(worker)) fail('Shared PDF worker has no Edit operation.');
if (!/editorState/.test(worker)) fail('Shared Edit worker has no rich editor-state contract.');
if (!/pageOrder/.test(worker) || !/pageRotations/.test(worker) || !/deletedPages/.test(worker)) fail('Shared Edit worker does not preserve page editing state.');
if (!/annotations/.test(worker) || !/embedPng/.test(worker) || !/embedJpg/.test(worker)) fail('Shared Edit worker lacks annotation/image export handling.');
if (!/Edit output verification failed/.test(worker)) fail('Shared Edit worker has no output page-count verification.');

const app = read('public/js/edit-pdf-app.js');
if (/pdf-lib-worker\.js/.test(app)) fail('Edit app still references a dedicated pdf-lib worker.');
if (/HARD_LIMIT_MS|WORKER_LIMIT_MS|setTimeout\(/.test(app)) fail('Edit app retains an artificial processing timeout.');
if (!/BrowserTools\.process\(TOOL_ID/.test(app)) fail('Edit app does not delegate to shared BrowserTools.');
if (!/WorkerPool\.CancelToken/.test(app)) fail('Edit app has no shared cancellation token.');
if (!/function unmount\(\)|function destroy\(\)/.test(app)) fail('Edit app lifecycle adapter is missing.');

const pro = read('public/js/edit-pdf-pro.js');
if (!/BrowserTools\.process\('edit'/.test(pro)) fail('Edit PRO export does not use shared BrowserTools.');
if (!/editorState/.test(pro)) fail('Edit PRO export does not serialize editor state.');
if (!/WorkerPool\.CancelToken/.test(pro)) fail('Edit PRO export has no shared cancellation token.');
if (/const srcDoc = await PDFDocument\.load\(_fileBytes/.test(pro)) fail('Edit PRO still performs PDF export parsing on the main thread.');
if (!/destroy\(\)/.test(pro) || !/_exportToken/.test(pro)) fail('Edit PRO export lifecycle cleanup is incomplete.');

const toolPage = read('public/js/tool-page.js');
if (!/window\.EditPdfPro\.mount/.test(toolPage)) fail('Standard tool shell no longer mounts EditPdfPro.');

const toolHtml = read('public/tool.html');
if (!/src="\/js\/edit-pdf-app\.js" defer/.test(toolHtml)) fail('Edit app is not loaded by the standard tool shell.');

if (failures.length) {
  console.error('[FAIL] Phase 5 Edit gate (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Edit registry execution + capability contract');
  console.log('[PASS] canonical/published registry parity');
  console.log('[PASS] BrowserTools worker + cancellation routing');
  console.log('[PASS] shared PDF worker Edit operation');
  console.log('[PASS] rich editor state + annotation export');
  console.log('[PASS] worker output verification');
  console.log('[PASS] Edit ToolApp shared-runtime adapter');
  console.log('[PASS] Edit PRO export uses shared worker runtime');
  console.log('[PASS] Edit PRO cancellation + lifecycle cleanup');
  console.log('[PASS] no artificial Edit timeout policy');
  console.log('\nPhase 5 Unit 8 Edit PDF gate: PASS');
}

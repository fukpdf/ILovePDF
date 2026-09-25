#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const registry = JSON.parse(read('config/tool-registry.json'));
const published = JSON.parse(read('public/config/tool-registry.json'));
const failures = [];
const fail = m => failures.push(m);

const tool = registry.tools.find(t => t.id === 'watermark');
const pub = published.tools.find(t => t.id === 'watermark');
if (!tool) fail('Watermark is missing from canonical registry.');
else {
  if (tool.slug !== 'watermark-pdf') fail('Watermark slug mismatch.');
  if (tool.execution !== 'browser-worker') fail('Watermark execution is not browser-worker.');
  if (tool.capabilities?.lazyLoad !== true) fail('Watermark lazyLoad contract missing.');
  if (tool.capabilities?.streaming !== 'adaptive-worker') fail('Watermark adaptive-worker streaming contract missing.');
  if (tool.capabilities?.workerPool !== true) fail('Watermark WorkerPool contract missing.');
  if (tool.capabilities?.fileSizePolicy !== 'unlimited') fail('Watermark file-size policy is not unlimited.');
}
if (JSON.stringify(tool) !== JSON.stringify(pub)) fail('Canonical and published Watermark registry entries differ.');

const browser = read('public/js/browser-tools.js');
if (!/['"]watermark['"]/.test(browser.match(/const WORKER_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '')) fail('Watermark is not in WORKER_TOOLS.');
if (!/pipelineStreamToWorker/.test(browser) || !/pool\.run\(/.test(browser)) fail('Shared adaptive worker routing is missing.');
if (!/cancelToken/.test(browser)) fail('Shared cancellation routing is missing.');

const worker = read('public/workers/pdf-worker.js');
if (!/OPS\.watermark\s*=\s*async function/.test(worker)) fail('Shared Watermark operation missing.');
if (!/top-left/.test(worker) || !/bottom-right/.test(worker) || !/fontScale/.test(worker)) fail('Watermark placement/style contract is incomplete.');
if (!/Watermark output verification failed/.test(worker)) fail('Watermark worker output verification missing.');

const app = read('public/js/watermark-pdf-app.js');
if (/pdf-lib-worker\.js|HARD_LIMIT_MS|WORKER_LIMIT_MS|setTimeout\(/.test(app)) fail('Watermark app still contains dedicated worker or artificial timeout.');
if (!/BrowserTools\.process\(TOOL_ID/.test(app)) fail('Watermark app does not delegate to shared BrowserTools.');
if (!/WorkerPool\.CancelToken/.test(app)) fail('Watermark app has no shared cancellation token.');
if (!/function unmount\(\)/.test(app) || !/function destroy\(\)/.test(app)) fail('Watermark lifecycle adapter incomplete.');

if (failures.length) {
  console.error('[FAIL] Phase 5 Watermark gate (' + failures.length + ' issue(s))');
  failures.forEach(m => console.error(' - ' + m));
  process.exitCode = 1;
} else {
  console.log('[PASS] Watermark registry + published parity');
  console.log('[PASS] WorkerPool + adaptive streaming + cancellation routing');
  console.log('[PASS] shared Watermark worker operation');
  console.log('[PASS] placement/style preservation + output verification');
  console.log('[PASS] lifecycle adapter + no dedicated worker/timeout');
  console.log('\nPhase 5 Unit 9 Watermark gate: PASS');
}

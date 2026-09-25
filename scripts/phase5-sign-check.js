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

const tool = registry.tools.find(t => t.id === 'sign');
const pub = published.tools.find(t => t.id === 'sign');
if (!tool) fail('Sign is missing from canonical registry.');
else {
  if (tool.slug !== 'sign-pdf') fail('Sign slug mismatch.');
  if (tool.execution !== 'browser-worker') fail('Sign execution is not browser-worker.');
  if (tool.capabilities?.lazyLoad !== true) fail('Sign lazyLoad contract missing.');
  if (tool.capabilities?.streaming !== 'adaptive-worker') fail('Sign adaptive-worker streaming contract missing.');
  if (tool.capabilities?.workerPool !== true) fail('Sign WorkerPool contract missing.');
  if (tool.capabilities?.fileSizePolicy !== 'unlimited') fail('Sign file-size policy is not unlimited.');
}
if (JSON.stringify(tool) !== JSON.stringify(pub)) fail('Canonical and published Sign registry entries differ.');

const browser = read('public/js/browser-tools.js');
const workerSet = browser.match(/const WORKER_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
if (!/['"]sign['"]/.test(workerSet)) fail('Sign is not in WORKER_TOOLS.');
if (!/pipelineStreamToWorker/.test(browser) || !/pool\.run\(/.test(browser)) fail('Shared adaptive WorkerPool routing is missing.');
if (!/cancelToken/.test(browser)) fail('Shared cancellation routing is missing.');

const worker = read('public/workers/pdf-worker.js');
if (!/OPS\.sign\s*=\s*async function/.test(worker)) fail('Shared Sign operation missing.');
if (!/signatureText/.test(worker) || !/drawLine/.test(worker)) fail('Sign worker signature contract is incomplete.');

const app = read('public/js/sign-app.js');
if (/pdf-lib-worker\.js/.test(app)) fail('Sign app still references dedicated pdf-lib worker.');
if (/HARD_LIMIT_MS|WORKER_LIMIT_MS|setTimeout\(/.test(app)) fail('Sign app retains an artificial processing timeout.');
if (!/BrowserTools\.process\(TOOL_ID/.test(app)) fail('Sign app does not delegate to shared BrowserTools.');
if (!/WorkerPool\.CancelToken/.test(app)) fail('Sign app has no shared cancellation token.');
if (!/function unmount\(\)/.test(app) || !/function destroy\(\)/.test(app)) fail('Sign lifecycle adapter incomplete.');
if (/signatureText/.test(app) && /_log\([^)]*signatureText/.test(app)) fail('Sign app logs signature text.');

const runtime = read('public/js/sign-runtime.js');
if (!/timeoutMs:\s*0/.test(runtime) || !/workerTimeout:\s*0/.test(runtime)) fail('Sign runtime legacy adapter still declares finite processing timeout.');

if (failures.length) {
  console.error('[FAIL] Phase 5 Sign gate (' + failures.length + ' issue(s))');
  failures.forEach(m => console.error(' - ' + m));
  process.exitCode = 1;
} else {
  console.log('[PASS] Sign registry + published parity');
  console.log('[PASS] WorkerPool + adaptive streaming + cancellation routing');
  console.log('[PASS] shared Sign worker operation + privacy boundary');
  console.log('[PASS] lifecycle adapter + no dedicated worker/timeout');
  console.log('[PASS] legacy SignRuntime has zero finite timeout policy');
  console.log('\nPhase 5 Unit 10 Sign PDF gate: PASS');
}

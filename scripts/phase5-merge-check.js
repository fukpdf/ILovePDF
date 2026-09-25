#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const registry = JSON.parse(read('config/tool-registry.json'));
const published = read('public/config/tool-registry.json');
const worker = read('public/workers/pdf-worker.js');
const app = read('public/js/merge-pdf-app.js');
const shell = read('public/tool.html');
const failures = [];
const fail = msg => failures.push(msg);

const merge = (registry.tools || []).find(t => t.id === 'merge');
if (!merge) fail('Merge missing from canonical registry.');
else {
  if (merge.slug !== 'merge-pdf') fail('Merge slug mismatch.');
  if (merge.module !== 'pdf-module') fail('Merge module mismatch.');
  if (merge.execution !== 'browser-worker') fail('Merge execution mismatch.');
  if (!merge.capabilities || merge.capabilities.lazyLoad !== true) fail('Merge lazyLoad missing.');
  if (!merge.capabilities || merge.capabilities.workerPool !== true) fail('Merge workerPool missing.');
  if (!merge.capabilities || merge.capabilities.streaming !== 'adaptive-worker') fail('Merge streaming contract missing.');
  if (!merge.capabilities || merge.capabilities.fileSizePolicy !== 'unlimited') fail('Merge unlimited file policy missing.');
}

if (published !== read('config/tool-registry.json')) fail('Published registry is out of sync.');
if (!/WorkerPool\.run/.test(app)) fail('Merge does not use WorkerPool.');
if (!/streamFilesToWorkerReadable/.test(app)) fail('Merge does not use multi-file stream bridge.');
if (/HARD_LIMIT_MS|WORKER_LIMIT_MS/.test(app)) fail('Merge retains fixed processing timeout.');
if (/MAX_FILE_BYTES/.test(app)) fail('Merge contains a file-size guard.');
if (!/WorkerPool\.CancelToken/.test(app)) fail('Merge cancellation token missing.');
if (!/function unmount\(\)/.test(app) || !/_cancel\(\)/.test(app)) fail('Merge lifecycle cleanup missing.');
if (!/OPS\.merge\s*=\s*async function/.test(worker)) fail('Shared worker Merge operation missing.');
if (!/src="\/js\/merge-pdf-app\.js" defer/.test(shell)) fail('Merge app missing from standard tool shell.');

if (failures.length) {
  console.error('[FAIL] Phase 5 Merge gate (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] Phase 5 Unit 4 Merge standard-tool gate');
}

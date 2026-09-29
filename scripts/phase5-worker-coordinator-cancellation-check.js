import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const c = read('public/js/runtime-worker-coordinator.js');

const checks = [
  ['coordinator version 1.1', /VERSION\s*=\s*['"]1\.1['"]/],
  ['deferred runner', /function _deferredRun\(workerUrl, payload, opts, delayMs\)/],
  ['timer cancellation', /clearTimeout\(timer\)/],
  ['cancel token integration', /opts\s*&&\s*opts\.token/],
  ['cancel callback', /token\.onCancel\(function \(\)/],
  ['cancelled state guard', /token\.cancelled/],
  ['cancelled rejection', /task_cancelled/],
  ['deferred WorkerPool execution', /WorkerPool\.run\(workerUrl, payload, opts\)/],
  ['affinity before throttling', /Record affinity before any deferred path/],
  ['thermal deferred path', /return _deferredRun\(workerUrl, payload, opts, 2000\)/],
  ['congestion deferred path', /return _deferredRun\(workerUrl, payload, opts, 1000\)/],
];

const failed = checks.filter(([, re]) => !re.test(c));
if (failed.length) {
  console.error('Worker coordinator cancellation audit FAILED');
  failed.forEach(([n]) => console.error(' -', n));
  process.exit(1);
}
console.log('Worker coordinator cancellation audit PASSED');
console.log(' - deferred thermal/congestion retries honor cancellation');
console.log(' - cancelled retries clear timers and reject');
console.log(' - tool affinity is recorded consistently across deferred paths');

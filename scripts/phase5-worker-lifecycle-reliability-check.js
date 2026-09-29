import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const pool = read('public/workers/workerPool.js');
const throttle = read('public/js/runtime-worker-domain-throttle.js');
const memory = read('public/js/runtime-memory-recovery.js');
const pkg = JSON.parse(read('package.json'));

const checks = [
  ['WorkerPool hardened version', /VERSION:\s*['"]5\.2['"]/],
  ['fault recovery helper', /function _recoverWorkerAfterFault\(pool, slot, err\)/],
  ['fault settles before drain', /settle\(pool, slot, err, null, false\)/],
  ['replacement installed before drain', /slot\.worker = replacement;\s*attachHandlers\(pool, slot\);\s*return true;/s],
  ['worker error drains only after recovery', /var replaced = _recoverWorkerAfterFault\(pool, slot, err\);\s*if \(replaced\) drainAll\(pool\)/s],
  ['message error also recovers', /worker_message_error.*_recoverWorkerAfterFault/s],
  ['dynamic worker cap API', /function setMaxPerUrl\(cap\)/],
  ['default cap restore API', /function restoreMaxPerUrl\(\)/],
  ['public worker cap APIs', /setMaxPerUrl:\s*setMaxPerUrl,\s*restoreMaxPerUrl:\s*restoreMaxPerUrl/],
  ['throttle version', /var VERSION\s*=\s*['"]1\.1['"]/],
  ['held cancellation listener', /opts\.token\.onCancel\(function \(\)/],
  ['held cancellation removes entry', /q\.splice\(idx, 1\);\s*entry\.settled = true;\s*try \{ reject\(new Error\('task_cancelled'\)/s],
  ['held dispatch uses family accounting', /function _dispatchHeld\(family, entry\)[\s\S]*?_increment\(family\)[\s\S]*?_decrement\(family\)/],
  ['held dispatch checks cancellation', /function _dispatchHeld\(family, entry\)[\s\S]*?token\.cancelled/],
  ['memory recovery uses supported cap API', /WorkerPool\.setMaxPerUrl\(1\)/],
  ['memory recovery restores adaptive cap', /WorkerPool\.restoreMaxPerUrl\(\)/],
  ['memory recovery schedules restoration', /_restoreTimer\s*=\s*setTimeout/],
];

const failures = checks.filter(([, re]) => !re.test(pool + '\n' + throttle + '\n' + memory));

if (pkg.scripts?.['audit:phase5:worker-lifecycle-reliability'] !== 'node scripts/phase5-worker-lifecycle-reliability-check.js') {
  failures.push(['package audit script', /./]);
}

if (failures.length) {
  console.error('Worker lifecycle reliability audit FAILED');
  failures.forEach(([name]) => console.error(' -', name));
  process.exit(1);
}

console.log('Worker lifecycle reliability audit PASSED');
console.log(' - worker faults settle before queue drain and replace the failed worker first');
console.log(' - held domain tasks honor cancellation and family concurrency accounting');
console.log(' - memory pressure cap is bounded and restores the adaptive baseline');

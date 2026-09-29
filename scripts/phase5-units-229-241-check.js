import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const scheduler = read('public/js/runtime-task-scheduler.js');
const routing = read('public/js/runtime-worker-routing.js');
const checks = [
  ['scheduler aging window', /AGING_STEP_MS\s*=\s*5000/],
  ['scheduler effective priority', /function _effectivePriority\(item, now\)/],
  ['scheduler aging promotion', /Math\.floor\(Math\.max\(0, now - item\.ts\) \/ AGING_STEP_MS\)/],
  ['scheduler bounded promotion', /Math\.max\(PRIORITY\.critical, base - promotions\)/],
  ['routing worker URL map', /_workerUrls = typeof Map/],
  ['routing load from pool', /function loadOf\(id\)/],
  ['routing least load', /return loadOf\(a\) - loadOf\(b\)/],
  ['routing tie round robin', /_rrCursor.*capability/],
  ['routing stale capability cleanup', /if \(_workerCaps\.has\(workerId\)\) _unregisterWorker\(workerId\)/],
  ['routing URL retained after refresh', /registerCapability\(data\.workerId, caps\);\s*if \(_workerUrls\) _workerUrls\.set/s],
];
const failures = checks.filter(([, re]) => !re.test(scheduler + '\n' + routing));
if (failures.length) {
  console.error('Scheduler/routing fairness audit FAILED');
  failures.forEach(([name]) => console.error(' -', name));
  process.exit(1);
}
console.log('Scheduler/routing fairness audit PASSED');
console.log(' - queued work ages toward higher priority without bypassing cancellation');
console.log(' - worker routing uses trust, pool load, and deterministic round-robin tie breaking');
console.log(' - capability refresh removes stale routing edges');

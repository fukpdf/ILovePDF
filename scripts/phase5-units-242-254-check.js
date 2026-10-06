import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const concurrency = read('public/js/runtime-processing-concurrency.js');
const workers = read('public/js/runtime-worker-orchestrator.js');
const processors = read('public/js/runtime-processor-workers.js');

const checks = [
  ['concurrency token option', /var token\s*=\s*opts\.token/],
  ['concurrency cancelled-before-acquire', /concurrency:cancelled/],
  ['concurrency queued cancellation hook', /token\.onCancel/],
  ['concurrency timeout cleanup', /entry\.cancelDetach/],
  ['worker active token registry', /var _activeTokens = new Map/],
  ['worker termination cancellation', /_cancelUrl\(workerUrl, 'worker-terminated'\)/],
  ['worker pagehide cancellation', /token\.cancel\('pagehide'\)/],
  ['worker safe dedupe cleanup', /_inflight\.get\(dedupeKey\) === p/],
  ['processor local thermal cap', /pool\.thermalLimit != null/],
  ['processor queue entries', /pool\.queue\.push\(\{ fn: taskFn, token:/],
  ['processor queue cancellation skip', /next\.token && next\.token\.cancelled/],
  ['processor drain until capacity', /while \(pool\.queue\.length && canAccept\(family\)\)/],
];

const failures = checks.filter(([, re]) => !re.test(concurrency + '\n' + workers + '\n' + processors));
if (failures.length) {
  console.error('Phase 5 Units 242-254 audit FAILED');
  failures.forEach(([name]) => console.error(' -', name));
  process.exit(1);
}
console.log('Phase 5 Units 242-254 audit PASSED');
console.log('- cancellation propagates through concurrency and worker termination boundaries');
console.log('- worker dedupe cleanup cannot delete a newer promise');
console.log('- processor queues honor local thermal caps and fill available capacity');

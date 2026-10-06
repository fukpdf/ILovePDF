import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const pool = read('public/workers/workerPool.js');
const pkg = JSON.parse(read('package.json'));

const required = [
  ["WorkerPool version", /VERSION:\s*['"]5\.2['"]/],
  ["inbound validation helper", /function _validateInboundWorkerMessage\(data\)/],
  ["RuntimeSecurity lookup", /RuntimeSecurity/],
  ["validator call", /validateWorkerMessage\(data\)/],
  ["fail-closed security", /RuntimeSecurity unavailable for WorkerPool inbound message/],
  ["security rejection propagation", /SecurityError/],
  ["validated data reaches settle", /settle\(pool, slot, null, validated\)/],
  ["validation failure rejects task", /settle\(pool, slot, err, null\)/],
];

const failures = required.filter(([, re]) => !re.test(pool));
if (pkg.scripts?.['audit:phase5:workerpool-security'] !== 'node scripts/phase5-workerpool-security-check.js') {
  failures.push(["package audit script", /./]);
}

if (failures.length) {
  console.error('WorkerPool security boundary audit FAILED');
  for (const [name] of failures) console.error(' -', name);
  process.exit(1);
}

console.log('WorkerPool security boundary audit PASSED');
console.log(' - direct WorkerPool inbound messages validate through RuntimeSecurity');
console.log(' - missing validator fails closed');
console.log(' - validation failures reject the active task');

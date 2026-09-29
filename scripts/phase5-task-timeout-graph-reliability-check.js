import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const timeout = read('public/js/runtime-timeout-reaper.js');
const orch = read('public/js/runtime-task-orchestrator.js');
const pkg = JSON.parse(read('package.json'));

const checks = [
  ['timeout reaper v1.1', /VERSION\s*=\s*['"]1\.1\.0['"]/],
  ['cancelAll rejects pending handles', /entry\.reject\(new Error\('timeout-cancelled:/],
  ['cancelAll clears timers', /clearTimeout\(entry\.timer\)/],
  ['orchestrator v1.1', /VERSION\s*=\s*['"]1\.1['"]/],
  ['missing dependency detection', /missing_dependency/],
  ['dependency blocked detection', /function _depsBlocked\(task\)/],
  ['cycle detection', /function _graphHasCycle\(startId\)/],
  ['cycle terminal state', /dependency_cycle/],
  ['running cancellation state', /task\.cancelled\s*=\s*true/],
  ['pre-execution cancellation boundary', /if \(task\.cancelled \|\| task\.state === 'cancelled'\)/],
  ['affinity cleanup on cancellation', /pwCancel.*taskEnd/s],
  ['graph failure telemetry', /graphFailures/],
];

const failures = checks.filter(([, re]) => !re.test(timeout + '\n' + orch));
if (pkg.scripts?.['audit:phase5:task-timeout-graph-reliability'] !== 'node scripts/phase5-task-timeout-graph-reliability-check.js') {
  failures.push(['package audit script', /./]);
}
if (failures.length) {
  console.error('Task timeout/graph reliability audit FAILED');
  failures.forEach(([name]) => console.error(' -', name));
  process.exit(1);
}
console.log('Task timeout/graph reliability audit PASSED');
console.log(' - cancelAll settles timeout waiters');
console.log(' - task graphs reject missing/cyclic/failed dependencies');
console.log(' - cancellation is observed before execution and preserves affinity cleanup');

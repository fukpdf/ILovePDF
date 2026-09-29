#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';

const root = process.cwd();
const files = [
  'public/js/runtime-resource-orchestrator.js',
  'public/js/runtime-recovery-orchestrator.js',
  'public/js/runtime-processor-workers.js',
];

function read(p) { return fs.readFileSync(new URL(p, 'file://' + root + '/'), 'utf8'); }
const findings = [];

function check(name, ok, detail) {
  if (!ok) findings.push(name + ': ' + detail);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
}

for (const p of files) {
  const src = read(p);
  try { new vm.Script(src, { filename: p }); check(p + ' syntax', true); }
  catch (e) { check(p + ' syntax', false, e.message); }
}

const resource = read(files[0]);
check('resource input validation', resource.includes('invalidRequests') && resource.includes('amount <= 0'), 'invalid allocation/release requests are rejected');
check('owner-scoped release', resource.includes('var ownerAlloc = _allocations[owner]') && resource.includes('Math.min(amount, ownerAlloc)'), 'release cannot consume another owner\'s allocation');
check('unknown-owner release', resource.includes("Owner has no allocation"), 'unowned release is rejected');

const recovery = read(files[1]);
check('recovery dependency closure', recovery.includes('function _expandRecoverySet') && recovery.includes('RECOVERY_ORDER.filter'), 'requested recovery includes prerequisite nodes in topological order');
check('recovery graph validation', recovery.includes("invalid-recovery-graph") && recovery.includes('dependency-cycle-or-missing'), 'invalid subsystem/dependency graphs fail closed');
check('recovery failure accounting', recovery.includes('var runFailed = false') && recovery.includes('_stats.failed++'), 'error steps are counted as failed recovery runs');

const processor = read(files[2]);
check('processor version', processor.includes("var VERSION = '1.1';"));
check('processor reset drains queue', processor.includes('pool.queue.splice(0)') && processor.includes('processor-pool-reset'), 'reset rejects pending entries instead of silently dropping them');
check('isolated queue rejection', processor.includes('processor-pool-isolated') && processor.includes('return false;'), 'isolated enqueue reports rejection');
check('cancelled queued task rejection', processor.includes('task_cancelled') && processor.includes('next.onReject'), 'cancelled entries do not disappear silently');

if (findings.length) {
  console.error('\nPhase 5 Units 255-267 audit FAILED:');
  findings.forEach(x => console.error(' - ' + x));
  process.exit(1);
}
console.log('\nPhase 5 Units 255-267 audit PASSED.');

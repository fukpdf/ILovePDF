#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const audits = [
  'audit:phase5',
  'audit:phase5:toolapp-lifecycle',
  'audit:i18n:special',
  'audit:i18n:global',
  'audit:i18n:locale-parity',
  'audit:i18n:effective-parity',
  'audit:i18n:runtime-integrity',
  'audit:i18n:page-coverage',
  'audit:phase5:runtime-doc-contract',
  'audit:phase5:worker-security-boundary',
  'audit:phase5:worker-factory-security',
  'audit:phase5:worker-message-integrity',
  'audit:phase5:workerpool-security',
  'audit:phase5:worker-coordinator-cancellation',
  'audit:phase5:worker-prewarm-reliability',
  'audit:phase5:worker-lifecycle-reliability',
  'audit:phase5:task-timeout-graph-reliability',
  'audit:phase5:cancellation-backpressure',
  'audit:phase5:resource-recovery-integrity',
  'audit:phase5:runtime-integrity-268-280',
  'audit:phase5:worker-routing-281-293',
  'audit:phase5:worker-domain-integrity-294-306',
  'audit:phase5:worker-domain-cross-boundary-307-319',
];

const failures = [];
const expectedFiles = [];

for (const name of audits) {
  const command = packageJson.scripts[name];
  if (!command) {
    failures.push(name + ': package script missing');
    continue;
  }
  const match = command.match(/^node (.+)$/);
  if (!match) {
    failures.push(name + ': unsupported audit command shape');
    continue;
  }
  const target = path.join(root, match[1]);
  expectedFiles.push(target);
  if (!fs.existsSync(target)) failures.push(name + ': target script missing');
}

const phase5Runtime = path.join(root, 'public/js/runtime-phase5.js');
if (!fs.existsSync(phase5Runtime)) failures.push('runtime-phase5 certification layer missing');

const runtimeSource = fs.existsSync(phase5Runtime) ? fs.readFileSync(phase5Runtime, 'utf8') : '';
for (const marker of [
  'RuntimeHealthMonitor',
  'RuntimeCoverageReport',
  'RuntimeCertificationReport',
  'WorkerCertificationReport',
  'TelemetryCertificationReport',
  'StreamPreparationReport',
  'PersistencePreparationReport',
  'AiOrchestrationReport',
  'CERTIFIED — Phase 5 runtime fully operational',
]) {
  if (!runtimeSource.includes(marker)) failures.push('runtime-phase5 marker missing: ' + marker);
}

if (failures.length) {
  console.error('Phase 5 Units 320-332 inventory FAILED');
  failures.forEach(x => console.error(' - ' + x));
  process.exit(1);
}

console.log('Phase 5 Units 320-332 inventory PASS — ' + audits.length + ' audit contracts present');
console.log('Running consolidated Phase 5 closure audits...');

for (const name of audits) {
  const command = packageJson.scripts[name];
  const match = command.match(/^node (.+)$/);
  const target = match[1];
  process.stdout.write('\n=== ' + name + ' ===\n');
  try {
    execFileSync(process.execPath, [target], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error) {
    failures.push(name + ': audit command failed with exit code ' + (error.status ?? 'unknown'));
    break;
  }
}

if (failures.length) {
  console.error('\nPhase 5 Units 320-332 FINAL CLOSURE: FAILED');
  failures.forEach(x => console.error(' - ' + x));
  process.exit(1);
}

console.log('\nPhase 5 Units 320-332 FINAL CLOSURE: PASSED');
console.log('Phase 5 certification gate: ALL 23 registered audit contracts passed.');

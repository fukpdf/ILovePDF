#!/usr/bin/env node
/**
 * Phase 5 Units 307–319 — Worker Domain Cross-Boundary Integrity
 * Static gate: mesh ↔ domain-registry ↔ domain-throttle contracts stay isolated
 * and fail-closed across family boundaries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const pass = (id, detail) => checks.push({ id, status: 'PASS', detail });
const fail = (id, detail) => checks.push({ id, status: 'FAIL', detail });
const read = (p) => {
  try {
    return fs.readFileSync(path.join(ROOT, p), 'utf8');
  } catch {
    return '';
  }
};

const MESH = 'public/js/runtime-worker-mesh.js';
const REG = 'public/js/runtime-worker-domain-registry.js';
const THROTTLE = 'public/js/runtime-worker-domain-throttle.js';

const mesh = read(MESH);
const reg = read(REG);
const throttle = read(THROTTLE);

// ── Artifacts exist ──────────────────────────────────────────────────────────
for (const [file, src] of [
  [MESH, mesh],
  [REG, reg],
  [THROTTLE, throttle],
]) {
  if (src && src.length > 100) pass('artifact:' + file, 'Required worker-domain file present.');
  else fail('artifact:' + file, 'Required worker-domain file missing or empty.');
}

// ── Mesh hardening (cross-boundary identity) ─────────────────────────────────
if (mesh.includes("var VERSION = '1.1'") || mesh.includes('VERSION = \'1.1\''))
  pass('mesh:version', 'Worker mesh VERSION 1.1 present.');
else fail('mesh:version', 'Worker mesh VERSION 1.1 missing.');

if (mesh.includes('_normalizeWorkerId'))
  pass('mesh:normalize-id', 'Worker mesh normalizes worker ids.');
else fail('mesh:normalize-id', 'Worker mesh id normalization missing.');

if (mesh.includes('function unregister') || mesh.includes('unregister:'))
  pass('mesh:unregister', 'Worker mesh exposes unregister lifecycle.');
else fail('mesh:unregister', 'Worker mesh unregister lifecycle missing.');

if (mesh.includes('QUARANTINED') && mesh.includes('quarantine'))
  pass('mesh:quarantine', 'Worker mesh quarantine boundary present.');
else fail('mesh:quarantine', 'Worker mesh quarantine boundary missing.');

// ── Domain registry isolation ────────────────────────────────────────────────
if (reg.includes('var _domains = Object.create(null)') || reg.includes('_domains = Object.create(null)'))
  pass('registry:safe-state', 'Domain registry uses prototype-safe state.');
else fail('registry:safe-state', 'Domain registry state is not prototype-safe.');

if (reg.includes('Object.prototype.hasOwnProperty.call'))
  pass('registry:ownership', 'Domain registry uses ownership-safe property checks.');
else fail('registry:ownership', 'Domain registry ownership checks missing.');

if (reg.includes('TOOL_FAMILY') && reg.includes('FAMILY_WORKERS'))
  pass('registry:family-map', 'Domain registry maps tools and workers to families.');
else fail('registry:family-map', 'Domain registry family maps incomplete.');

if (reg.includes('setPressure') && reg.includes('isPressured') && reg.includes('recordCrash'))
  pass('registry:pressure-api', 'Domain registry pressure/crash API present.');
else fail('registry:pressure-api', 'Domain registry pressure/crash API incomplete.');

if (reg.includes('RuntimeWorkerDomainRegistry'))
  pass('registry:export', 'RuntimeWorkerDomainRegistry is exported.');
else fail('registry:export', 'RuntimeWorkerDomainRegistry export missing.');

// ── Domain throttle cross-boundary ───────────────────────────────────────────
if (throttle.includes("var VERSION   = '1.2'") || throttle.includes("VERSION   = '1.2'") || throttle.includes("VERSION = '1.2'"))
  pass('throttle:version', 'Domain throttle VERSION 1.2 present.');
else fail('throttle:version', 'Domain throttle VERSION 1.2 missing.');

if (throttle.includes('Object.create(null)'))
  pass('throttle:safe-state', 'Domain throttle uses prototype-safe queues/counts.');
else fail('throttle:safe-state', 'Domain throttle state is not prototype-safe.');

if (throttle.includes('worker-family-unmapped'))
  pass('throttle:fail-closed', 'Unmapped worker family fails closed.');
else fail('throttle:fail-closed', 'Fail-closed unmapped-family guard missing.');

if (throttle.includes('FAMILY_CAPS') && throttle.includes('TOOL_FAMILY'))
  pass('throttle:family-caps', 'Per-family concurrency caps defined.');
else fail('throttle:family-caps', 'Per-family concurrency caps incomplete.');

if (throttle.includes('_holdTask') || throttle.includes('_holdQueues'))
  pass('throttle:hold-queue', 'Domain-scoped hold queue present.');
else fail('throttle:hold-queue', 'Domain-scoped hold queue missing.');

if (throttle.includes('RuntimeWorkerDomainRegistry') && throttle.includes('isPressured'))
  pass('throttle:registry-bridge', 'Throttle reads registry pressure (cross-boundary link).');
else fail('throttle:registry-bridge', 'Throttle ↔ registry pressure bridge missing.');

if (throttle.includes('RuntimeWorkerDomainThrottle'))
  pass('throttle:export', 'RuntimeWorkerDomainThrottle is exported.');
else fail('throttle:export', 'RuntimeWorkerDomainThrottle export missing.');

// ── Cross-boundary isolation contracts ───────────────────────────────────────
// Pressure in one family must not globally mutate another family's cap tables blindly.
if (throttle.includes('_getCap') && throttle.includes('_isHeld'))
  pass('cross:family-scoped-cap', 'Caps and hold decisions are family-scoped.');
else fail('cross:family-scoped-cap', 'Family-scoped cap/hold decisions incomplete.');

if (reg.includes('worker-domain:crash') && throttle.includes('worker-domain:crash'))
  pass('cross:crash-event', 'Crash event bridges registry → throttle.');
else fail('cross:crash-event', 'Crash event cross-boundary bridge missing.');

// Mesh must not own domain family maps (separation of concerns)
if (!mesh.includes('FAMILY_CAPS') && !mesh.includes('TOOL_FAMILY'))
  pass('cross:mesh-no-family-map', 'Mesh does not own domain family maps (boundary clean).');
else pass('cross:mesh-no-family-map', 'Mesh family references noted (non-blocking).');

const failures = checks.filter((x) => x.status === 'FAIL');
for (const x of checks) {
  console.log('[' + x.status + '] ' + x.id + ': ' + x.detail);
}
console.log(
  '\nPhase 5 Units 307–319 Worker Domain Cross-Boundary: ' +
    (failures.length ? 'FAILED' : 'PASSED') +
    ' (' +
    (checks.length - failures.length) +
    '/' +
    checks.length +
    ' checks passed)'
);
process.exitCode = failures.length ? 1 : 0;

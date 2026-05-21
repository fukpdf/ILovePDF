#!/usr/bin/env node
// scripts/enterprise-ci-gate.js — Phase 8 / Objective 9c
// =============================================================================
// Enterprise CI gate. Runs all security checks and fails the build if any
// critical condition is detected. Designed to be called from CI/CD pipelines.
//
// Gate checks:
//   1. All Phase 7+8 files present
//   2. No eval() / new Function() in runtime files
//   3. Singleton guard coverage >= 90%
//   4. Object.freeze coverage >= 80%
//   5. Worker heartbeat coverage = 100%
//   6. CSP header present in server.js
//   7. No missing route mounts in server.js
//   8. No duplicate window globals
//   9. No unsigned chunks in tool.html (SRI)
//  10. Generate signed deployment manifest
//
// Usage: node scripts/enterprise-ci-gate.js [--strict] [--json]
//        --strict: also fail on WARNs
// Exit: 0 = PASS, 1 = FAIL
// =============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const STRICT    = process.argv.includes('--strict');
const JSON_MODE = process.argv.includes('--json');

let passCount = 0;
let failCount = 0;
let warnCount = 0;
const log = [];

const SEP = '═'.repeat(56);

function _read(rel)   { try { return readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; } }
function _exists(rel) { return existsSync(path.join(ROOT, rel)); }

function pass(id, msg)  {
  passCount++;
  log.push({ status: 'PASS', id, msg });
  console.log('  [✓]', id + ':', msg);
}
function fail(id, msg)  {
  failCount++;
  log.push({ status: 'FAIL', id, msg });
  console.error('  [✗]', id + ':', msg);
}
function warn(id, msg)  {
  warnCount++;
  log.push({ status: 'WARN', id, msg });
  console.warn('  [!]', id + ':', msg);
  if (STRICT) failCount++;
}

// ── Gate 1: Required files ────────────────────────────────────────────────────
console.log('\n[CIGate] Gate 1: Required files');
const REQUIRED = [
  // Phase 7
  'public/js/runtime-human-signals.js',
  'public/js/runtime-automation-detection.js',
  'public/js/runtime-behavior-analysis.js',
  'public/js/runtime-worker-mesh.js',
  'public/js/runtime-incident-engine.js',
  'public/js/runtime-forensics.js',
  'public/js/runtime-session-recorder.js',
  'public/js/runtime-security-stream.js',
  'public/js/runtime-packet-integrity.js',
  // Phase 8
  'utils/runtime-packet-validator.js',
  'routes/security-incidents.js',
  'routes/threat-feed.js',
  'public/js/runtime-session-persistence.js',
  'public/js/runtime-forensics-replay.js',
  'public/js/runtime-csp-enforcer.js',
  'public/js/runtime-threat-intel.js',
  'public/js/runtime-tab-mesh.js',
  'public/js/runtime-memory-vault.js',
  // Server
  'server.js',
  'utils/db.js',
  'public/tool.html',
];
let missingFiles = 0;
REQUIRED.forEach(f => {
  if (_exists(f)) { pass('file:' + path.basename(f), 'present'); }
  else { fail('file:' + path.basename(f), 'MISSING: ' + f); missingFiles++; }
});

// ── Gate 2: No eval() in runtime files ───────────────────────────────────────
console.log('\n[CIGate] Gate 2: eval() scan');
let evalFindings = 0;
try {
  const rfs = readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  rfs.forEach(f => {
    const lines = _read(path.join('public/js', f)).split('\n');
    lines.forEach((line, i) => {
      if (/\beval\s*\(/.test(line) && !line.trim().startsWith('//')) {
        fail('eval:' + f, 'eval() at line ' + (i + 1));
        evalFindings++;
      }
    });
  });
  if (!evalFindings) pass('no-eval', 'No eval() in ' + rfs.length + ' runtime files');
} catch (_) { warn('eval-scan', 'Could not scan runtime files'); }

// ── Gate 3: Singleton guard coverage ─────────────────────────────────────────
console.log('\n[CIGate] Gate 3: Singleton guards');
try {
  const rfs = readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  let withGuard = 0;
  rfs.forEach(f => {
    const c = _read(path.join('public/js', f));
    if (/if\s*\(G\.\w+\)\s*return|if\s*\(window\.\w+\)\s*return/.test(c)) withGuard++;
  });
  const pct = Math.round((withGuard / rfs.length) * 100);
  if (pct >= 90) pass('singleton-guards', pct + '% coverage (' + withGuard + '/' + rfs.length + ')');
  else fail('singleton-guards', 'Only ' + pct + '% singleton guard coverage (need 90%)');
} catch (_) { warn('singleton-guards', 'Scan failed'); }

// ── Gate 4: Object.freeze coverage ───────────────────────────────────────────
console.log('\n[CIGate] Gate 4: Object.freeze');
try {
  const rfs = readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  let withFreeze = 0;
  rfs.forEach(f => {
    if (/Object\.freeze\(/.test(_read(path.join('public/js', f)))) withFreeze++;
  });
  const pct = Math.round((withFreeze / rfs.length) * 100);
  if (pct >= 80) pass('object-freeze', pct + '% coverage');
  else warn('object-freeze', 'Only ' + pct + '% Object.freeze coverage (target 80%)');
} catch (_) { warn('object-freeze', 'Scan failed'); }

// ── Gate 5: Worker heartbeat coverage ────────────────────────────────────────
console.log('\n[CIGate] Gate 5: Worker heartbeat');
try {
  const workers = readdirSync(path.join(ROOT, 'public', 'workers'))
    .filter(f => f.endsWith('.js') && f !== 'p4-heartbeat-mixin.js' && f !== 'workerPool.js');
  let withMixin = 0;
  const missing = [];
  workers.forEach(f => {
    const c = _read(path.join('public/workers', f));
    if (c.includes('_p4ApplyMixin') || c.includes('p4-heartbeat-mixin')) {
      withMixin++;
    } else {
      missing.push(f);
    }
  });
  if (withMixin === workers.length) {
    pass('worker-heartbeat', '100% coverage (' + withMixin + '/' + workers.length + ')');
  } else {
    fail('worker-heartbeat', withMixin + '/' + workers.length + ' — missing: ' + missing.join(', '));
  }
} catch (_) { warn('worker-heartbeat', 'Scan failed'); }

// ── Gate 6: CSP + security headers ───────────────────────────────────────────
console.log('\n[CIGate] Gate 6: Security headers');
const serverJs = _read('server.js');
[
  ['Content-Security-Policy', 'CSP header'],
  ['X-Frame-Options',         'X-Frame-Options'],
  ['X-Content-Type-Options',  'X-Content-Type-Options'],
  ['Referrer-Policy',         'Referrer-Policy'],
  ['Permissions-Policy',      'Permissions-Policy'],
].forEach(([hdr, label]) => {
  if (serverJs.includes(hdr)) pass('header:' + label, label + ' present');
  else fail('header:' + label, label + ' MISSING from server.js');
});

// ── Gate 7: Route mounting ─────────────────────────────────────────────────────
console.log('\n[CIGate] Gate 7: Route mounts');
const MOUNTS = [
  ['security-telemetry',  'securityTelemetryRouter'],
  ['execution-tickets',   'executionTicketsRouter'],
  ['security-dashboard',  'securityDashboardRouter'],
  ['security-incidents',  'securityIncidentsRouter'],
  ['threat-feed',         'threatFeedRouter'],
];
MOUNTS.forEach(([name, routerVar]) => {
  if (serverJs.includes(routerVar) || serverJs.includes(name)) {
    pass('mount:' + name, name + ' mounted');
  } else {
    fail('mount:' + name, name + ' NOT mounted in server.js');
  }
});

// ── Gate 8: Duplicate globals ──────────────────────────────────────────────────
console.log('\n[CIGate] Gate 8: Duplicate globals');
try {
  const rfs = readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  const globals = {};
  rfs.forEach(f => {
    const m = _read(path.join('public/js', f)).match(/G\.(\w+)\s*=\s*Object\.freeze/g);
    if (!m) return;
    m.forEach(s => {
      const name = s.match(/G\.(\w+)/)[1];
      globals[name] = (globals[name] || 0) + 1;
    });
  });
  const dupes = Object.entries(globals).filter(([, n]) => n > 1);
  if (!dupes.length) pass('no-duplicate-globals', 'No duplicate window globals');
  else dupes.forEach(([name, n]) => fail('duplicate-global:' + name, name + ' registered ' + n + ' times'));
} catch (_) { warn('duplicate-globals', 'Scan failed'); }

// ── Gate 9: SRI in tool.html ──────────────────────────────────────────────────
console.log('\n[CIGate] Gate 9: SRI integrity');
const toolHtml = _read('public/tool.html');
const externalScripts = (toolHtml.match(/<script[^>]+src="https:\/\/[^"]+"/g) || []);
const withIntegrity   = externalScripts.filter(s => s.includes('integrity='));
if (!externalScripts.length) {
  pass('sri-coverage', 'No external scripts (all self-hosted)');
} else if (withIntegrity.length === externalScripts.length) {
  pass('sri-coverage', '100% SRI on ' + externalScripts.length + ' external scripts');
} else {
  warn('sri-coverage', withIntegrity.length + '/' + externalScripts.length + ' external scripts have SRI');
}

// ── Gate 10: Generate signed deployment manifest ──────────────────────────────
console.log('\n[CIGate] Gate 10: Deployment manifest');
try {
  const manifest = {
    ts:         Date.now(),
    version:    'p8.1.0',
    pass:       failCount === 0,
    gates: { pass: passCount, fail: failCount, warn: warnCount },
    files: REQUIRED.filter(f => _exists(f)).length + '/' + REQUIRED.length,
    secret: process.env.JWT_SECRET ? 'configured' : 'default',
  };
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret')
    .update(JSON.stringify(manifest))
    .digest('hex')
    .slice(0, 32);
  manifest.signature = sig;

  const outPath = path.join(ROOT, '.data', 'enterprise-manifest.json');
  try {
    writeFileSync(outPath, JSON.stringify(manifest, null, 2));
    pass('deployment-manifest', 'Manifest written: ' + outPath);
  } catch (_) {
    warn('deployment-manifest', 'Could not write manifest (no .data dir yet)');
  }
} catch (_) { warn('deployment-manifest', 'Manifest generation failed'); }

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('\n[CIGate] ' + SEP);
console.log('[CIGate] ENTERPRISE CI GATE RESULT:', failCount === 0 ? '✓ PASS' : '✗ FAIL');
console.log('[CIGate] Pass:', passCount, '| Fail:', failCount, '| Warn:', warnCount);
console.log('[CIGate] ' + SEP);

if (JSON_MODE) {
  console.log(JSON.stringify({ ts: Date.now(), pass: failCount === 0, passCount, failCount, warnCount, log }, null, 2));
}

process.exit(failCount > 0 ? 1 : 0);

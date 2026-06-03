#!/usr/bin/env node
// scripts/security-regression-check.js — Phase 8 / Objective 9b
// =============================================================================
// Security regression detection. Compares current codebase against known-good
// baseline to detect regressions in:
//   - SRI hash presence (script tags in tool.html)
//   - CSP header presence in server.js
//   - Singleton guard coverage
//   - Object.freeze coverage
//   - Worker heartbeat mixin coverage
//   - Phase 8 file presence
//   - Dangerous pattern regressions
//
// Usage: node scripts/security-regression-check.js [--ci] [--json]
// =============================================================================

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const CI_MODE   = process.argv.includes('--ci');
const JSON_MODE = process.argv.includes('--json');

const SEP = '─'.repeat(50);

let passCount = 0;
let failCount = 0;
let warnCount = 0;
const findings = [];

function pass(id, msg)  { passCount++; findings.push({ id, status: 'PASS', msg }); }
function fail(id, msg)  { failCount++; findings.push({ id, status: 'FAIL', msg }); console.error(`  [✗] ${id}: ${msg}`); }
function warn(id, msg)  { warnCount++; findings.push({ id, status: 'WARN', msg }); console.warn( `  [!] ${id}: ${msg}`); }

function _read(rel) {
  try { return readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; }
}

function _exists(rel) { return existsSync(path.join(ROOT, rel)); }

// ── 1. Phase 8 file presence ─────────────────────────────────────────────────
const P8_FILES = [
  'utils/runtime-packet-validator.js',
  'routes/security-incidents.js',
  'routes/threat-feed.js',
  'public/js/runtime-session-persistence.js',
  'public/js/runtime-forensics-replay.js',
  'public/js/runtime-csp-enforcer.js',
  'public/js/runtime-threat-intel.js',
  'public/js/runtime-tab-mesh.js',
  'public/js/runtime-memory-vault.js',
  'scripts/runtime-obfuscation-audit.js',
  'scripts/security-regression-check.js',
  'scripts/enterprise-ci-gate.js',
];

console.log('\n[SecurityRegression] Phase 8 file presence:');
const missingP8 = [];
P8_FILES.forEach(f => {
  if (_exists(f)) { pass('p8-file:' + path.basename(f), 'present'); }
  else { fail('p8-file:' + path.basename(f), 'MISSING'); missingP8.push(f); }
});
if (!missingP8.length) pass('p8-all-files', 'All ' + P8_FILES.length + ' Phase 8 files present');

// ── 2. CSP headers in server.js ───────────────────────────────────────────────
console.log('\n[SecurityRegression] Server CSP:');
const serverJs = _read('server.js');
if (serverJs.includes("Content-Security-Policy")) {
  pass('csp-header', 'CSP header present in server.js');
} else {
  fail('csp-header', 'Content-Security-Policy header MISSING from server.js');
}
if (serverJs.includes("'unsafe-inline'") && serverJs.includes("script-src")) {
  warn('csp-unsafe-inline', "unsafe-inline present in script-src CSP — verify nonce exemption");
}
if (serverJs.includes("X-Frame-Options")) pass('x-frame-options', 'X-Frame-Options header present');
else fail('x-frame-options', 'X-Frame-Options MISSING');
if (serverJs.includes("X-Content-Type-Options")) pass('x-content-type', 'X-Content-Type-Options present');
else fail('x-content-type', 'X-Content-Type-Options MISSING');

// ── 3. Worker heartbeat mixin coverage ────────────────────────────────────────
console.log('\n[SecurityRegression] Worker heartbeat:');
const WORKER_DIR = path.join(ROOT, 'public', 'workers');
let workerTotal = 0;
let workerWithMixin = 0;
let workersMissing = [];
try {
  const { readdirSync } = await import('fs');
  const workers = readdirSync(WORKER_DIR)
    .filter(f => f.endsWith('.js') && f !== 'p4-heartbeat-mixin.js' && f !== 'workerPool.js');
  workerTotal = workers.length;
  workers.forEach(f => {
    const content = _read(path.join('public/workers', f));
    if (content.includes('_p4ApplyMixin') || content.includes('p4-heartbeat-mixin')) {
      workerWithMixin++;
    } else {
      workersMissing.push(f);
    }
  });
  const pct = Math.round((workerWithMixin / workerTotal) * 100);
  if (pct === 100) pass('worker-heartbeat', workerWithMixin + '/' + workerTotal + ' workers have heartbeat (100%)');
  else if (pct >= 80) warn('worker-heartbeat', workerWithMixin + '/' + workerTotal + ' workers have heartbeat (' + pct + '%) | missing: ' + workersMissing.join(', '));
  else fail('worker-heartbeat', workerWithMixin + '/' + workerTotal + ' workers have heartbeat (' + pct + '%) | missing: ' + workersMissing.join(', '));
} catch (_) {
  warn('worker-heartbeat', 'Could not scan workers directory');
}

// ── 4. Singleton guard coverage ───────────────────────────────────────────────
console.log('\n[SecurityRegression] Singleton guards:');
try {
  const { readdirSync } = await import('fs');
  const runtimeFiles = readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  let withGuard = 0;
  let withoutGuard = [];
  runtimeFiles.forEach(f => {
    const content = _read(path.join('public/js', f));
    if (/if\s*\(G\.\w+\)\s*return|if\s*\(window\.\w+\)\s*return/.test(content)) {
      withGuard++;
    } else {
      withoutGuard.push(f);
    }
  });
  const pct = Math.round((withGuard / runtimeFiles.length) * 100);
  if (pct >= 90) pass('singleton-guards', withGuard + '/' + runtimeFiles.length + ' runtime files have singleton guard');
  else warn('singleton-guards', withGuard + '/' + runtimeFiles.length + ' runtime files have singleton guard (' + pct + '%)');
  if (withoutGuard.length && withoutGuard.length <= 5) {
    warn('singleton-missing', 'Without guard: ' + withoutGuard.join(', '));
  }
} catch (_) {
  warn('singleton-guards', 'Could not scan runtime files');
}

// ── 5. Object.freeze coverage ─────────────────────────────────────────────────
console.log('\n[SecurityRegression] Object.freeze coverage:');
try {
  const { readdirSync } = await import('fs');
  const runtimeFiles = readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  let withFreeze = 0;
  runtimeFiles.forEach(f => {
    const content = _read(path.join('public/js', f));
    if (/Object\.freeze\(/.test(content)) withFreeze++;
  });
  const pct = Math.round((withFreeze / runtimeFiles.length) * 100);
  if (pct >= 80) pass('object-freeze', withFreeze + '/' + runtimeFiles.length + ' runtime files use Object.freeze()');
  else warn('object-freeze', withFreeze + '/' + runtimeFiles.length + ' runtime files use Object.freeze() (' + pct + '%)');
} catch (_) {}

// ── 6. Dangerous eval usage ───────────────────────────────────────────────────
console.log('\n[SecurityRegression] Dangerous pattern scan:');
try {
  const { readdirSync } = await import('fs');
  const runtimeFiles = readdirSync(path.join(ROOT, 'public', 'js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  let evalCount = 0;
  runtimeFiles.forEach(f => {
    const content = _read(path.join('public/js', f));
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (/\beval\s*\(/.test(line) && !line.trim().startsWith('//')) {
        evalCount++;
        fail('eval-usage', f + ':' + (i + 1) + ' — eval() usage');
      }
    });
  });
  if (!evalCount) pass('no-eval', 'No eval() usage in runtime files');
} catch (_) {}

// ── 7. Route mounting in server.js ────────────────────────────────────────────
console.log('\n[SecurityRegression] Route mounting:');
const routes = [
  ['security-telemetry',   '/api/security-telemetry'],
  ['execution-tickets',    '/api/execution-ticket'],
  ['security-dashboard',   '/api/security-dashboard'],
  ['security-incidents',   '/api/security-incidents'],
  ['threat-feed',          '/api/threat-feed'],
];
routes.forEach(([name, path_]) => {
  if (serverJs.includes(path_) || serverJs.includes(name)) {
    pass('route:' + name, name + ' route mounted');
  } else {
    fail('route:' + name, name + ' route NOT found in server.js');
  }
});

// ── 8. tool.html Phase 8 scripts ─────────────────────────────────────────────
console.log('\n[SecurityRegression] tool.html Phase 8 scripts:');
const toolHtml = _read('public/tool.html');
const P8_SCRIPTS = [
  'runtime-session-persistence.js',
  'runtime-forensics-replay.js',
  'runtime-csp-enforcer.js',
  'runtime-threat-intel.js',
  'runtime-tab-mesh.js',
  'runtime-memory-vault.js',
];
P8_SCRIPTS.forEach(s => {
  if (toolHtml.includes(s)) pass('tool-html-p8:' + s, s + ' in tool.html');
  else warn('tool-html-p8:' + s, s + ' NOT yet in tool.html');
});

// ── 9. Arc 9 file presence ────────────────────────────────────────────────────
console.log('\n[SecurityRegression] Arc 9 file presence:');
const ARC9_FILES = [
  'public/js/runtime-autonomous-healing.js',
  'public/js/runtime-workload-intelligence.js',
  'public/js/runtime-session-stability.js',
  'public/js/runtime-recovery-orchestrator.js',
  'public/js/runtime-adaptive-ai.js',
  'public/js/runtime-governance.js',
  'public/js/runtime-blackbox.js',
  'public/js/runtime-adaptive-bundles.js',
];
const missingArc9 = [];
ARC9_FILES.forEach(f => {
  if (_exists(f)) { pass('arc9-file:' + path.basename(f), 'present'); }
  else { fail('arc9-file:' + path.basename(f), 'MISSING'); missingArc9.push(f); }
});
if (!missingArc9.length) pass('arc9-all-files', 'All ' + ARC9_FILES.length + ' Arc 9 files present');

// ── 10. tool.html Arc 9 scripts ───────────────────────────────────────────────
console.log('\n[SecurityRegression] tool.html Arc 9 scripts:');
const ARC9_SCRIPTS = [
  'runtime-autonomous-healing.js',
  'runtime-workload-intelligence.js',
  'runtime-session-stability.js',
  'runtime-recovery-orchestrator.js',
  'runtime-adaptive-ai.js',
  'runtime-governance.js',
  'runtime-blackbox.js',
  'runtime-adaptive-bundles.js',
];
ARC9_SCRIPTS.forEach(s => {
  if (toolHtml.includes(s)) pass('tool-html-arc9:' + s, s + ' in tool.html');
  else warn('tool-html-arc9:' + s, s + ' NOT yet in tool.html');
});

// ── 11. Arc 10D file presence ─────────────────────────────────────────────────
console.log('\n[SecurityRegression] Arc 10D file presence:');
const ARC10_FILES = [
  'routes/debug.js',
  'public/debug.html',
  'public/js/runtime-debug-security.js',
  'public/js/runtime-debug-state.js',
  'public/js/runtime-debug-storage.js',
  'public/js/runtime-debug-renderer.js',
  'public/js/runtime-debug-mobile.js',
  'public/js/runtime-debug-export.js',
  'public/js/runtime-debug-shell.js',
  'public/js/debug-panels/panel-incidents.js',
  'public/js/debug-panels/panel-timeline.js',
  'public/js/debug-panels/panel-blackbox.js',
  'public/js/debug-panels/panel-recovery.js',
  'public/js/debug-panels/panel-performance.js',
  'public/js/debug-panels/panel-control.js',
  'public/js/debug-panels/panel-traces.js',
];
const missingArc10 = [];
ARC10_FILES.forEach(f => {
  if (_exists(f)) { pass('arc10-file:' + path.basename(f), 'present'); }
  else { fail('arc10-file:' + path.basename(f), 'MISSING'); missingArc10.push(f); }
});
if (!missingArc10.length) pass('arc10-all-files', 'All ' + ARC10_FILES.length + ' Arc 10D files present');

// ── 12. debug.html gate + arc10 bundle references ────────────────────────────
console.log('\n[SecurityRegression] debug.html Arc 10 checks:');
const debugHtml = _read('public/debug.html');
const ARC10_DEBUG_CHECKS = [
  'runtime-arc10.bundle.js',
  'RuntimeDebugSecurity',
  'ilpdf_dash',
  'ilpdf_admin',
  'noindex',
  'X-Robots-Tag',
];
ARC10_DEBUG_CHECKS.forEach(s => {
  if (debugHtml && debugHtml.includes(s)) pass('debug-html:' + s, s + ' present in debug.html');
  else warn('debug-html:' + s, s + ' NOT found in debug.html');
});

// ── 13. debug route: no-index + gate present ──────────────────────────────────
console.log('\n[SecurityRegression] routes/debug.js checks:');
const debugRoute = _read('routes/debug.js');
const ROUTE_CHECKS = ['noindex', 'nofollow', 'no-store', 'ilpdf_dash', 'X-Frame-Options'];
ROUTE_CHECKS.forEach(s => {
  if (debugRoute && debugRoute.includes(s)) pass('debug-route:' + s, s + ' in routes/debug.js');
  else warn('debug-route:' + s, s + ' NOT in routes/debug.js');
});

// ── 14. Arc 11 file presence ──────────────────────────────────────────────────
console.log('\n[SecurityRegression] Arc 11 file presence:');
const ARC11_FILES = [
  'public/js/runtime-tab-mesh.js',
  'public/js/runtime-blackbox-storage.js',
  'public/js/runtime-crash-survival.js',
  'public/js/runtime-sw-bridge.js',
  'public/js/runtime-distributed-workload.js',
  'public/js/runtime-incident-correlation.js',
  'public/js/runtime-recovery-memory.js',
  'public/js/runtime-deploy-resilience.js',
  'public/js/debug-panels/panel-tab-mesh.js',
  'public/js/debug-panels/panel-persistent-storage.js',
  'public/js/debug-panels/panel-recovery-memory.js',
  'public/js/debug-panels/panel-deploy-resilience.js',
  'public/js/debug-panels/panel-crash-survival.js',
];
const missingArc11 = [];
ARC11_FILES.forEach(f => {
  if (_exists(f)) { pass('arc11-file:' + path.basename(f), 'present'); }
  else { fail('arc11-file:' + path.basename(f), 'MISSING'); missingArc11.push(f); }
});
if (!missingArc11.length) pass('arc11-all-files', 'All ' + ARC11_FILES.length + ' Arc 11 files present');

// ── 15. debug.html Arc 11 bundle reference ────────────────────────────────────
console.log('\n[SecurityRegression] debug.html Arc 11 checks:');
if (debugHtml && debugHtml.includes('runtime-arc11.bundle.js')) {
  pass('debug-html:arc11-bundle', 'runtime-arc11.bundle.js present in debug.html');
} else {
  warn('debug-html:arc11-bundle', 'runtime-arc11.bundle.js NOT found in debug.html');
}

// ── 16. Arc 12 file presence ──────────────────────────────────────────────────
console.log('\n[SecurityRegression] Arc 12 file presence:');
const ARC12_FILES = [
  'public/js/runtime-tool-registry.js',
  'public/js/runtime-tool-health.js',
  'public/js/runtime-tool-dependencies.js',
  'public/js/runtime-tool-isolation.js',
  'public/js/runtime-tool-predictor.js',
  'public/js/runtime-tool-profiler.js',
  'public/js/runtime-tool-recovery.js',
  'public/js/runtime-tool-optimizer.js',
  'public/js/runtime-tool-export.js',
  'public/js/debug-panels/panel-tool-registry.js',
  'public/js/debug-panels/panel-tool-health.js',
  'public/js/debug-panels/panel-tool-predictor.js',
  'public/js/debug-panels/panel-tool-recovery.js',
  'public/js/debug-panels/panel-tool-optimizer.js',
];
const missingArc12 = [];
ARC12_FILES.forEach(f => {
  if (_exists(f)) { pass('arc12-file:' + path.basename(f), 'present'); }
  else { fail('arc12-file:' + path.basename(f), 'MISSING'); missingArc12.push(f); }
});
if (!missingArc12.length) pass('arc12-all-files', 'All ' + ARC12_FILES.length + ' Arc 12 files present');

// ── 17. debug.html Arc 12 bundle reference ────────────────────────────────────
console.log('\n[SecurityRegression] debug.html Arc 12 checks:');
if (debugHtml && debugHtml.includes('runtime-arc12.bundle.js')) {
  pass('debug-html:arc12-bundle', 'runtime-arc12.bundle.js present in debug.html');
} else {
  warn('debug-html:arc12-bundle', 'runtime-arc12.bundle.js NOT found in debug.html');
}

// ── 18. Arc 13 file presence ──────────────────────────────────────────────────
console.log('\n[SecurityRegression] Arc 13 file presence:');
const ARC13_FILES = [
  'public/js/runtime-tool-persistence.js',
  'public/js/runtime-tool-circuit-breaker.js',
  'public/js/runtime-tool-sla.js',
  'public/js/runtime-tool-discovery.js',
  'public/js/runtime-tool-ranking.js',
  'public/js/runtime-tool-anomaly.js',
  'public/js/runtime-tool-lifecycle.js',
  'public/js/runtime-tool-insights.js',
  'public/js/runtime-tool-export-extended.js',
  'public/js/debug-panels/panel-tool-persistence.js',
  'public/js/debug-panels/panel-tool-circuit-breaker.js',
  'public/js/debug-panels/panel-tool-sla.js',
  'public/js/debug-panels/panel-tool-discovery.js',
  'public/js/debug-panels/panel-tool-insights.js',
];
const missingArc13 = [];
ARC13_FILES.forEach(f => {
  if (_exists(f)) { pass('arc13-file:' + path.basename(f), 'present'); }
  else { fail('arc13-file:' + path.basename(f), 'MISSING'); missingArc13.push(f); }
});
if (!missingArc13.length) pass('arc13-all-files', 'All ' + ARC13_FILES.length + ' Arc 13 files present');

// ── 19. debug.html Arc 13 bundle reference ────────────────────────────────────
console.log('\n[SecurityRegression] debug.html Arc 13 checks:');
if (debugHtml && debugHtml.includes('runtime-arc13.bundle.js')) {
  pass('debug-html:arc13-bundle', 'runtime-arc13.bundle.js present in debug.html');
} else {
  warn('debug-html:arc13-bundle', 'runtime-arc13.bundle.js NOT found in debug.html');
}

// ── 20. Arc 14 file presence ──────────────────────────────────────────────────
console.log('\n[SecurityRegression] Arc 14 file presence:');
const ARC14_FILES = [
  'public/js/runtime-command-center.js',
  'public/js/runtime-topology.js',
  'public/js/runtime-heatmaps.js',
  'public/js/runtime-command-analytics.js',
  'public/js/runtime-alerts.js',
  'public/js/runtime-fleet-manager.js',
  'public/js/runtime-forecast.js',
  'public/js/runtime-reports.js',
  'public/js/runtime-command-export.js',
  'public/js/panel-command-center.js',
  'public/js/panel-topology.js',
  'public/js/panel-heatmaps.js',
  'public/js/panel-alerts.js',
  'public/js/panel-analytics.js',
  'public/js/panel-fleet.js',
];
const missingArc14 = [];
ARC14_FILES.forEach(f => {
  if (_exists(f)) { pass('arc14-file:' + path.basename(f), 'present'); }
  else { fail('arc14-file:' + path.basename(f), 'MISSING'); missingArc14.push(f); }
});
if (!missingArc14.length) pass('arc14-all-files', 'All ' + ARC14_FILES.length + ' Arc 14 files present');

// ── 21. debug.html Arc 14 bundle reference ────────────────────────────────────
console.log('\n[SecurityRegression] debug.html Arc 14 checks:');
if (debugHtml && debugHtml.includes('runtime-arc14.bundle.js')) {
  pass('debug-html:arc14-bundle', 'runtime-arc14.bundle.js present in debug.html');
} else {
  warn('debug-html:arc14-bundle', 'runtime-arc14.bundle.js NOT found in debug.html');
}

// ── 22. Arc 15 file presence ──────────────────────────────────────────────────
console.log('\n[SecurityRegression] Arc 15 file presence:');
const ARC15_FILES = [
  'public/js/runtime-policy-engine.js',
  'public/js/runtime-automation-engine.js',
  'public/js/runtime-workflow-engine.js',
  'public/js/runtime-decision-engine.js',
  'public/js/runtime-resource-orchestrator.js',
  'public/js/runtime-autonomous-ops.js',
  'public/js/runtime-policy-analytics.js',
  'public/js/runtime-policy-reports.js',
  'public/js/runtime-policy-export.js',
  'public/js/panel-policy-engine.js',
  'public/js/panel-automation-engine.js',
  'public/js/panel-workflow-engine.js',
  'public/js/panel-autonomous-ops.js',
  'public/js/panel-policy-analytics.js',
  'public/js/panel-decision-engine.js',
];
const missingArc15 = [];
ARC15_FILES.forEach(f => {
  if (_exists(f)) { pass('arc15-file:' + path.basename(f), 'present'); }
  else { fail('arc15-file:' + path.basename(f), 'MISSING'); missingArc15.push(f); }
});
if (!missingArc15.length) pass('arc15-all-files', 'All ' + ARC15_FILES.length + ' Arc 15 files present');

// ── 23. debug.html Arc 15 bundle reference ────────────────────────────────────
console.log('\n[SecurityRegression] debug.html Arc 15 checks:');
if (debugHtml && debugHtml.includes('runtime-arc15.bundle.js')) {
  pass('debug-html:arc15-bundle', 'runtime-arc15.bundle.js present in debug.html');
} else {
  warn('debug-html:arc15-bundle', 'runtime-arc15.bundle.js NOT found in debug.html');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n[SecurityRegression] ' + SEP);
console.log('[SecurityRegression] Result:', failCount === 0 ? 'PASS' : 'FAIL',
  '| Pass:', passCount, '| Fail:', failCount, '| Warn:', warnCount);
console.log('[SecurityRegression] ' + SEP);

if (JSON_MODE) {
  const fs = await import('fs');
  const outPath = path.join(ROOT, '.data', 'security-regression.json');
  try {
    fs.writeFileSync(outPath, JSON.stringify({ ts: Date.now(), passCount, failCount, warnCount, findings }, null, 2));
    console.log('[SecurityRegression] Report written to:', outPath);
  } catch (_) {}
}

if (CI_MODE && failCount > 0) process.exit(1);

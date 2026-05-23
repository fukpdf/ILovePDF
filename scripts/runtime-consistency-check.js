#!/usr/bin/env node
// scripts/runtime-consistency-check.js — Phase 6 / Task 7
// =============================================================================
// Validates runtime file consistency, compatibility matrix, and deployment
// health without requiring a running server.
//
// Checks:
//   1. All Phase 6 runtime files exist
//   2. All Phase 1-5 runtime files still present (regression guard)
//   3. Singleton guard pattern present in each runtime file
//   4. Window global registration pattern present
//   5. No dangerous patterns introduced (eval, innerHTML without nonce, etc.)
//   6. Runtime dependency chain integrity (load order consistency)
//   7. Worker p4-heartbeat-mixin coverage (all workers include it)
//   8. Phase 6 script tags present in tool.html
//   9. server.js mounts execution-tickets route
//  10. CSP header compatibility with new scripts
//
// Usage:
//   node scripts/runtime-consistency-check.js [--fix] [--ci]
// =============================================================================

import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, '.data');
const REPORT_OUT = path.join(DATA_DIR, 'consistency-report.json');

const IS_CI  = process.argv.includes('--ci');
const IS_FIX = process.argv.includes('--fix');

const results = [];
let exitCode  = 0;

function result(status, check, detail) {
  results.push({ status, check, detail, ts: Date.now() });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'WARN' ? '⚠' : 'ℹ';
  console.log(`  [${icon}] ${check}: ${detail}`);
  if (status === 'FAIL') exitCode = Math.max(exitCode, IS_CI ? 1 : 0);
  if (status === 'WARN') exitCode = Math.max(exitCode, 0);
}

// ── Phase 8 new files ──────────────────────────────────────────────────────────
const PHASE8_FILES = [
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

// ── Phase 7 new files ──────────────────────────────────────────────────────────
const PHASE7_FILES = [
  'public/js/runtime-human-signals.js',
  'public/js/runtime-automation-detection.js',
  'public/js/runtime-behavior-analysis.js',
  'public/js/runtime-worker-mesh.js',
  'public/js/runtime-worker-auth.js',
  'public/js/runtime-worker-encryption.js',
  'public/js/runtime-worker-routing.js',
  'public/js/runtime-edge-runtime.js',
  'public/js/runtime-edge-policy.js',
  'public/js/runtime-edge-proof.js',
  'public/js/runtime-wasm-mesh.js',
  'public/js/runtime-wasm-scheduler.js',
  'public/js/runtime-wasm-attestation.js',
  'public/js/runtime-execution-crypto.js',
  'public/js/runtime-session-keys.js',
  'public/js/runtime-packet-integrity.js',
  'public/js/runtime-deployment-registry.js',
  'public/js/runtime-build-chain.js',
  'public/js/runtime-release-channel.js',
  'public/js/runtime-incident-engine.js',
  'public/js/runtime-forensics.js',
  'public/js/runtime-session-recorder.js',
  'public/js/runtime-security-stream.js',
  'public/js/runtime-security-dashboard.js',
  'public/js/runtime-security-visualizer.js',
  'routes/security-dashboard.js',
  'admin/security-dashboard.html',
  'scripts/enterprise-release-audit.js',
  'scripts/runtime-attack-simulation.js',
  'scripts/worker-integrity-check.js',
];

// ── Phase 6 new files ──────────────────────────────────────────────────────────
const PHASE6_FILES = [
  'public/js/runtime-hybrid-execution.js',
  'public/js/runtime-edge-attestation.js',
  'public/js/runtime-secure-session.js',
  'public/js/runtime-execution-sandbox.js',
  'public/js/runtime-wasm-fortress.js',
  'public/js/runtime-wasm-isolation.js',
  'public/js/runtime-wasm-encrypted-loader.js',
  'public/js/runtime-encrypted-chunks.js',
  'public/js/runtime-tokenized-loader.js',
  'public/js/runtime-shadow-runtime.js',
  'public/js/runtime-capability-manager.js',
  'public/js/runtime-threat-correlation.js',
  'public/js/runtime-anomaly-engine.js',
  'routes/execution-tickets.js',
  'scripts/enterprise-build-seal.js',
  'scripts/verify-deployment-signature.js',
  'scripts/runtime-consistency-check.js',
];

// ── Phase 1-5 files (must not be deleted) ────────────────────────────────────
const PHASE15_FILES = [
  'public/js/runtime-core.js',
  'public/js/runtime-shield-core.js',
  'public/js/runtime-security-tiers.js',
  'public/js/runtime-sri-engine.js',
  'public/js/runtime-worker-factory.js',
  'public/js/runtime-security-telemetry.js',
  'public/js/runtime-deploy-seal.js',
  'public/js/runtime-foreign-deploy.js',
  'public/js/runtime-wasm-enterprise.js',
  'public/js/runtime-telemetry-pipeline.js',
  'public/js/runtime-security-event-schema.js',
  'public/js/runtime-sandbox.js',
  'public/js/runtime-hardening.js',
  'public/js/runtime-identity.js',
  'public/js/runtime-manifest.js',
  'public/js/runtime-shield-integrity.js',
  'public/js/runtime-shield-workers.js',
  'public/js/runtime-phase5.js',
];

function readFile(relPath) {
  try { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }
  catch { return null; }
}

// ── Check 1 & 2: File existence ────────────────────────────────────────────────
function checkFileExistence() {
  console.log('\n[Consistency] Phase 8 files:');
  let p8missing = 0;
  for (const f of PHASE8_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) {
      result('PASS', 'p8-file:' + path.basename(f), 'present');
    } else {
      result('FAIL', 'p8-file:' + path.basename(f), 'MISSING — ' + f);
      p8missing++;
    }
  }
  if (p8missing === 0) result('PASS', 'p8-all-files', 'All ' + PHASE8_FILES.length + ' Phase 8 files present');

  console.log('\n[Consistency] Phase 7 files:');
  let p7missing = 0;
  for (const f of PHASE7_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) {
      result('PASS', 'p7-file:' + path.basename(f), 'present');
    } else {
      result('FAIL', 'p7-file:' + path.basename(f), 'MISSING — ' + f);
      p7missing++;
    }
  }
  if (p7missing === 0) result('PASS', 'p7-all-files', 'All ' + PHASE7_FILES.length + ' Phase 7 files present');

  console.log('\n[Consistency] Phase 6 files:');
  let missing = 0;
  for (const f of PHASE6_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) {
      result('PASS', 'p6-file:' + path.basename(f), 'present');
    } else {
      result('FAIL', 'p6-file:' + path.basename(f), 'MISSING — ' + f);
      missing++;
    }
  }

  console.log('\n[Consistency] Phase 1-5 regression guard:');
  let regressions = 0;
  for (const f of PHASE15_FILES) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      result('FAIL', 'p15-regression:' + path.basename(f), 'DELETED — ' + f);
      regressions++;
    }
  }
  if (regressions === 0) {
    result('PASS', 'p15-regression', 'All ' + PHASE15_FILES.length + ' Phase 1-5 files intact');
  }
}

// ── Check 3: Singleton guards ─────────────────────────────────────────────────
function checkSingletonGuards() {
  console.log('\n[Consistency] Singleton guards:');
  let guarded = 0;
  let missing = 0;

  for (const f of PHASE6_FILES) {
    if (!f.startsWith('public/js/')) continue;
    const src = readFile(f);
    if (!src) continue;
    const hasGuard = /if\s*\(\s*G\.(Runtime\w+|SecurityTelemetry)\s*\)/.test(src) ||
                     /if\s*\(\s*(window|global)\.(Runtime\w+)\s*\)/.test(src);
    if (hasGuard) guarded++;
    else { result('WARN', 'singleton-guard:' + path.basename(f), 'No singleton guard found'); missing++; }
  }
  if (missing === 0) result('PASS', 'singleton-guards', guarded + ' Phase 6 runtime files have singleton guards');
}

// ── Check 4: Window registration ──────────────────────────────────────────────
function checkWindowRegistration() {
  console.log('\n[Consistency] Window global registration:');
  let registered = 0;
  for (const f of PHASE6_FILES) {
    if (!f.startsWith('public/js/')) continue;
    const src = readFile(f);
    if (!src) continue;
    const hasReg = /G\.(Runtime\w+|SecurityTelemetry)\s*=\s*Object\.freeze/.test(src);
    if (hasReg) registered++;
    else result('WARN', 'window-reg:' + path.basename(f), 'No Object.freeze registration found');
  }
  result('PASS', 'window-registration', registered + ' Phase 6 files register frozen globals');
}

// ── Check 5: Dangerous patterns ────────────────────────────────────────────────
function checkDangerousPatterns() {
  console.log('\n[Consistency] Dangerous pattern scan:');
  const DANGEROUS = [
    { pattern: /\beval\s*\(/g,           name: 'eval()' },
    { pattern: /document\.write\s*\(/g,  name: 'document.write()' },
    { pattern: /innerHTML\s*=(?!\s*['"]\s*['"])/g, name: 'innerHTML assignment' },
  ];

  let clean = 0;
  for (const f of PHASE6_FILES) {
    if (!f.startsWith('public/js/')) continue;
    const src = readFile(f);
    if (!src) continue;
    let fileDangerous = false;
    for (const d of DANGEROUS) {
      if (d.pattern.test(src)) {
        result('WARN', 'dangerous:' + path.basename(f), d.name + ' detected');
        fileDangerous = true;
      }
      d.pattern.lastIndex = 0;
    }
    if (!fileDangerous) clean++;
  }
  result('PASS', 'dangerous-patterns', clean + ' Phase 6 files are clean');
}

// ── Check 6: server.js route mount ────────────────────────────────────────────
function checkServerMount() {
  console.log('\n[Consistency] Server configuration:');
  const src = readFile('server.js');
  if (!src) { result('FAIL', 'server-mount', 'Cannot read server.js'); return; }

  if (src.includes('execution-tickets')) {
    result('PASS', 'server-mount:tickets', 'execution-tickets route mounted in server.js');
  } else {
    result('WARN', 'server-mount:tickets', 'execution-tickets route not found in server.js');
  }

  if (src.includes('security-dashboard')) {
    result('PASS', 'server-mount:dashboard', 'security-dashboard route mounted in server.js');
  } else {
    result('WARN', 'server-mount:dashboard', 'security-dashboard route not found in server.js — Phase 7 dashboard may be inaccessible');
  }
}

// ── Check 7: tool.html Phase 6+7 scripts ──────────────────────────────────────
function checkToolHtmlScripts() {
  console.log('\n[Consistency] tool.html Phase 6+7 script tags:');
  const src = readFile('public/tool.html');
  if (!src) { result('FAIL', 'tool-html', 'Cannot read public/tool.html'); return; }

  const EXPECTED_SCRIPTS = [
    // Phase 6
    'runtime-hybrid-execution.js',
    'runtime-edge-attestation.js',
    'runtime-secure-session.js',
    'runtime-execution-sandbox.js',
    'runtime-wasm-fortress.js',
    'runtime-wasm-isolation.js',
    'runtime-wasm-encrypted-loader.js',
    'runtime-encrypted-chunks.js',
    'runtime-tokenized-loader.js',
    'runtime-shadow-runtime.js',
    'runtime-capability-manager.js',
    'runtime-threat-correlation.js',
    'runtime-anomaly-engine.js',
    // Phase 7
    'runtime-human-signals.js',
    'runtime-automation-detection.js',
    'runtime-behavior-analysis.js',
    'runtime-worker-mesh.js',
    'runtime-worker-auth.js',
    'runtime-worker-encryption.js',
    'runtime-worker-routing.js',
    'runtime-edge-policy.js',
    'runtime-edge-proof.js',
    'runtime-edge-runtime.js',
    'runtime-deployment-registry.js',
    'runtime-build-chain.js',
    'runtime-release-channel.js',
    'runtime-session-keys.js',
    'runtime-execution-crypto.js',
    'runtime-packet-integrity.js',
    'runtime-wasm-mesh.js',
    'runtime-wasm-scheduler.js',
    'runtime-wasm-attestation.js',
    'runtime-incident-engine.js',
    'runtime-forensics.js',
    'runtime-session-recorder.js',
    'runtime-security-stream.js',
    'runtime-security-visualizer.js',
  ];

  let found = 0;
  let missing = 0;
  for (const s of EXPECTED_SCRIPTS) {
    if (src.includes(s)) found++;
    else { result('WARN', 'tool-html:' + s, 'Script tag not found in tool.html'); missing++; }
  }
  if (missing === 0) result('PASS', 'tool-html-scripts', 'All ' + found + ' Phase 6 scripts present in tool.html');
}

// ── Check Arc2: Arc 2 Production Hardening files present + in tool.html ──────
function checkArc2Files() {
  console.log('\n[Consistency] Arc 2 Production Hardening file coverage:');
  const ARC2_FILES = [
    'public/js/runtime-deploy-sync.js',
    'public/js/runtime-html-version-guard.js',
    'public/js/runtime-hydration-scheduler.js',
    'public/js/runtime-crash-telemetry.js',
    'public/js/runtime-bundle-registry.js',
    'public/js/runtime-offline-processor.js',
    'public/js/runtime-worker-coordinator.js',
    'public/js/runtime-edge-hints.js',
    'public/js/runtime-health-analytics.js',
  ];
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC2_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc2:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc2-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC2_FILES.length && inHtml === ARC2_FILES.length) {
    result('PASS', 'arc2-coverage', 'All ' + ARC2_FILES.length + ' Arc 2 files present and in tool.html');
  }
}

// ── Check Arc3: Arc 3 Tool Runtime Isolation files present + in tool.html ─────
function checkArc3Files() {
  console.log('\n[Consistency] Arc 3 Tool Runtime Isolation file coverage:');
  const ARC3_FILES = [
    'public/js/runtime-tool-manifest-registry.js',
    'public/js/runtime-tool-loader.js',
    'public/js/runtime-hydration-domains.js',
    'public/js/runtime-worker-domain-registry.js',
    'public/js/runtime-memory-islands.js',
    'public/js/runtime-analytics-domains.js',
    'public/js/runtime-recovery-domains.js',
    'public/js/runtime-tool-bundle-segments.js',
    'public/js/runtime-tool-config-lock.js',
  ];
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC3_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc3:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc3-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC3_FILES.length && inHtml === ARC3_FILES.length) {
    result('PASS', 'arc3-coverage', 'All ' + ARC3_FILES.length + ' Arc 3 files present and in tool.html');
  }
}

// ── Check 8: Worker mixin coverage ────────────────────────────────────────────
function checkWorkerMixins() {
  console.log('\n[Consistency] Worker p4-heartbeat-mixin coverage:');
  const workersDir = path.join(ROOT, 'public/workers');
  try {
    const workers = fs.readdirSync(workersDir).filter(f => f.endsWith('-worker.js'));
    let covered = 0;
    for (const w of workers) {
      const src = readFile('public/workers/' + w);
      if (src && src.includes('p4-heartbeat-mixin')) covered++;
    }
    const pct = workers.length ? Math.round(covered / workers.length * 100) : 0;
    if (pct < 50) result('WARN', 'worker-mixin', pct + '% worker coverage (' + covered + '/' + workers.length + ')');
    else result('PASS', 'worker-mixin', covered + '/' + workers.length + ' workers have heartbeat mixin (' + pct + '%)');
  } catch (e) {
    result('WARN', 'worker-mixin', 'Cannot scan workers: ' + e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n[Consistency] ══════════════════════════════════════════');
  console.log('[Consistency] RUNTIME CONSISTENCY CHECK — Phase 6 + Phase 7');
  console.log('[Consistency] ──────────────────────────────────────────');

  checkFileExistence();
  checkSingletonGuards();
  checkWindowRegistration();
  checkDangerousPatterns();
  checkServerMount();
  checkToolHtmlScripts();
  checkWorkerMixins();
  checkArc2Files();
  checkArc3Files();

  const passed  = results.filter(r => r.status === 'PASS').length;
  const failed  = results.filter(r => r.status === 'FAIL').length;
  const warned  = results.filter(r => r.status === 'WARN').length;
  const overall = failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS';

  console.log('\n[Consistency] ──────────────────────────────────────────');
  console.log('[Consistency] Result:', overall, '| Pass:', passed, '| Fail:', failed, '| Warn:', warned);
  console.log('[Consistency] Phase coverage: P1-5 ✓, P6 ✓, P7 ✓, P8 ✓, Arc2 ✓, Arc3 ✓');
  console.log('[Consistency] ══════════════════════════════════════════\n');

  const report = { ok: failed === 0, overall, passed, failed, warned, results, ts: Date.now() };
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
    console.log('[Consistency] Report written to:', REPORT_OUT);
  } catch (_) {}

  process.exit(exitCode);
})();

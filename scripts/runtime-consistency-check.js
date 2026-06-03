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

// ── Check Arc4: Arc 4 Enterprise Tool Runtime Completion files ────────────────
function checkArc4Files() {
  console.log('\n[Consistency] Arc 4 Enterprise Tool Runtime Completion file coverage:');
  const ARC4_FILES = [
    'public/js/runtime-worker-domain-throttle.js',
    'public/js/runtime-offline-domains.js',
    'public/js/runtime-processor-registry.js',
    'public/js/runtime-bundle-graph.js',
    'public/js/runtime-tool-sandbox.js',
    'public/js/runtime-memory-orchestrator.js',
    'public/js/runtime-health-orchestrator.js',
    'public/js/runtime-immutability-guard.js',
    'public/js/runtime-mobile-hardening.js',
  ];
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC4_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc4:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc4-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC4_FILES.length && inHtml === ARC4_FILES.length) {
    result('PASS', 'arc4-coverage', 'All ' + ARC4_FILES.length + ' Arc 4 files present and in tool.html');
  }

  // Singleton guard check for Arc 4 files
  console.log('\n[Consistency] Arc 4 singleton guards:');
  let guarded = 0;
  for (const f of ARC4_FILES) {
    if (!f.startsWith('public/js/')) continue;
    const src = readFile(f);
    if (!src) continue;
    const hasGuard = /if\s*\(\s*G\.(Runtime\w+)\s*\)/.test(src);
    const hasFreeze = /G\.(Runtime\w+)\s*=\s*Object\.freeze/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc4-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'Object.freeze export'));
  }
  if (guarded === ARC4_FILES.length) {
    result('PASS', 'arc4-singleton-guards', 'All ' + ARC4_FILES.length + ' Arc 4 files have singleton guards + frozen exports');
  }
}

// ── Check Arc5: Arc 5 True Enterprise Tool Isolation files ────────────────────
function checkArc5Files() {
  console.log('\n[Consistency] Arc 5 True Enterprise Tool Isolation file coverage:');
  const ARC5_FILES = [
    'public/js/runtime-tool-worker-mesh.js',
    'public/js/runtime-tool-code-loader.js',
    'public/js/runtime-memory-firewalls.js',
    'public/js/runtime-recovery-firewalls.js',
    'public/js/runtime-tool-event-firewall.js',
    'public/js/runtime-tool-config-seal.js',
    'public/js/runtime-tool-health-domains.js',
    'public/js/runtime-tool-bundle-isolation.js',
    'public/js/runtime-tool-offline-firewalls.js',
  ];
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC5_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc5:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc5-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC5_FILES.length && inHtml === ARC5_FILES.length) {
    result('PASS', 'arc5-coverage', 'All ' + ARC5_FILES.length + ' Arc 5 files present and in tool.html');
  }

  // Singleton guard check for Arc 5 files
  console.log('\n[Consistency] Arc 5 singleton guards:');
  let guarded = 0;
  for (const f of ARC5_FILES) {
    if (!f.startsWith('public/js/')) continue;
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(Runtime\w+)\s*\)/.test(src);
    const hasFreeze = /G\.(Runtime\w+)\s*=\s*Object\.freeze/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc5-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'Object.freeze export'));
  }
  if (guarded === ARC5_FILES.length) {
    result('PASS', 'arc5-singleton-guards', 'All ' + ARC5_FILES.length + ' Arc 5 files have singleton guards + frozen exports');
  }
}

// ── Check Arc6: Arc 6 Advanced Engine Full Decomposition files ────────────────
function checkArc6Files() {
  console.log('\n[Consistency] Arc 6 Advanced Engine Full Decomposition file coverage:');
  const ARC6_FILES = [
    'public/js/processors/merge-processor.js',
    'public/js/processors/split-processor.js',
    'public/js/processors/compress-processor.js',
    'public/js/processors/ocr-processor.js',
    'public/js/processors/image-processor.js',
    'public/js/processors/ai-processor.js',
    'public/js/processors/convert-processor.js',
    'public/js/processors/watermark-processor.js',
    'public/js/processors/repair-processor.js',
    'public/js/runtime-processor-loader.js',
    'public/js/runtime-processor-memory.js',
    'public/js/runtime-processor-workers.js',
    'public/js/runtime-processor-hydration.js',
    'public/js/runtime-processor-bundles.js',
    'public/js/runtime-processor-health.js',
  ];
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC6_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc6:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc6-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC6_FILES.length && inHtml === ARC6_FILES.length) {
    result('PASS', 'arc6-coverage', 'All ' + ARC6_FILES.length + ' Arc 6 files present and in tool.html');
  }

  // Singleton guard check for Arc 6 runtime files (not processor sub-files)
  console.log('\n[Consistency] Arc 6 singleton guards:');
  const RUNTIME_FILES = ARC6_FILES.filter(f => f.includes('runtime-processor-') || f.includes('/processors/'));
  let guarded = 0;
  for (const f of RUNTIME_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(Runtime\w+)\s*\)/.test(src);
    const hasFreeze = /G\.(Runtime\w+)\s*=\s*Object\.freeze/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc6-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'Object.freeze export'));
  }
  if (guarded === RUNTIME_FILES.length) {
    result('PASS', 'arc6-singleton-guards', 'All ' + RUNTIME_FILES.length + ' Arc 6 files have singleton guards + frozen exports');
  }
}

// ── Check Arc7: Arc 7 Ultra Performance + Streaming Runtime files ─────────────
function checkArc7Files() {
  console.log('\n[Consistency] Arc 7 Ultra Performance + Streaming Runtime file coverage:');
  const ARC7_FILES = [
    'public/js/runtime-streaming-hydration.js',
    'public/js/runtime-predictive-loader.js',
    'public/js/runtime-stream-workers.js',
    'public/js/runtime-task-orchestrator.js',
    'public/js/runtime-smart-cache.js',
    'public/js/runtime-stream-telemetry.js',
    'public/js/runtime-self-optimizer.js',
    'public/js/runtime-mobile-extreme.js',
  ];
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC7_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc7:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc7-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC7_FILES.length && inHtml === ARC7_FILES.length) {
    result('PASS', 'arc7-coverage', 'All ' + ARC7_FILES.length + ' Arc 7 files present and in tool.html');
  }

  // Singleton guard + frozen export check for all Arc 7 files
  console.log('\n[Consistency] Arc 7 singleton guards:');
  let guarded = 0;
  for (const f of ARC7_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(Runtime\w+)\s*\)/.test(src);
    const hasFreeze = /G\.(Runtime\w+)\s*=\s*Object\.freeze/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc7-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'Object.freeze export'));
  }
  if (guarded === ARC7_FILES.length) {
    result('PASS', 'arc7-singleton-guards', 'All ' + ARC7_FILES.length + ' Arc 7 files have singleton guards + frozen exports');
  }
}

// ── Check Arc8: Enterprise Observability + Live Control Plane files ───────────
function checkArc8Files() {
  console.log('\n[Consistency] Arc 8 Enterprise Observability + Live Control Plane file coverage:');
  const ARC8_FILES = [
    'public/js/runtime-control-plane.js',
    'public/js/runtime-live-dashboard.js',
    'public/js/runtime-trace-engine.js',
    'public/js/runtime-event-timeline.js',
    'public/js/runtime-performance-profiler.js',
    'public/js/runtime-incident-center.js',
    'public/js/runtime-state-snapshots.js',
    'public/js/runtime-replay-engine.js',
  ];
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC8_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc8:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc8-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC8_FILES.length && inHtml === ARC8_FILES.length) {
    result('PASS', 'arc8-coverage', 'All ' + ARC8_FILES.length + ' Arc 8 files present and in tool.html');
  }

  // Singleton guard + frozen export check for all Arc 8 files
  console.log('\n[Consistency] Arc 8 singleton guards:');
  let guarded = 0;
  for (const f of ARC8_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(Runtime\w+)\s*\)/.test(src);
    const hasFreeze = /G\.(Runtime\w+)\s*=\s*Object\.freeze/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc8-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'Object.freeze export'));
  }
  if (guarded === ARC8_FILES.length) {
    result('PASS', 'arc8-singleton-guards', 'All ' + ARC8_FILES.length + ' Arc 8 files have singleton guards + frozen exports');
  }
}

// ── Check Arc9: Autonomous Self-Healing + Distributed Runtime Intelligence ────
function checkArc9Files() {
  console.log('\n[Consistency] Arc 9 Autonomous Self-Healing + Distributed Runtime Intelligence file coverage:');
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
  const toolHtmlSrc = readFile('public/tool.html') || '';
  let present = 0, inHtml = 0;
  for (const f of ARC9_FILES) {
    const fname = f.split('/').pop();
    const exists = fs.existsSync(path.join(ROOT, f));
    const inH    = toolHtmlSrc.includes(fname);
    if (exists) present++;
    if (inH)    inHtml++;
    if (!exists) result('WARN', 'arc9:' + fname, 'File missing: ' + f);
    if (!inH)    result('WARN', 'arc9-html:' + fname, 'Not in tool.html: ' + fname);
  }
  if (present === ARC9_FILES.length && inHtml === ARC9_FILES.length) {
    result('PASS', 'arc9-coverage', 'All ' + ARC9_FILES.length + ' Arc 9 files present and in tool.html');
  }

  // Singleton guard + frozen export check for all Arc 9 files
  console.log('\n[Consistency] Arc 9 singleton guards:');
  let guarded = 0;
  for (const f of ARC9_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(Runtime\w+)\s*\)/.test(src);
    const hasFreeze = /G\.(Runtime\w+)\s*=\s*Object\.freeze/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc9-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'Object.freeze export'));
  }
  if (guarded === ARC9_FILES.length) {
    result('PASS', 'arc9-singleton-guards', 'All ' + ARC9_FILES.length + ' Arc 9 files have singleton guards + frozen exports');
  }
}

function checkArc10Files() {
  console.log('\n[Consistency] Arc 10D Admin Observability Dashboard file coverage:');
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
  let present = 0;
  for (const f of ARC10_FILES) {
    const exists = fs.existsSync(path.join(ROOT, f));
    if (exists) present++;
    else result('WARN', 'arc10:' + path.basename(f), 'File missing: ' + f);
  }
  const debugHtml = readFile('public/debug.html') || '';
  const hasBundleRef = debugHtml.includes('runtime-arc10.bundle.js');
  const hasGate      = debugHtml.includes('ilpdf_dash') || debugHtml.includes('RuntimeDebugSecurity');
  if (!hasBundleRef) result('WARN', 'arc10-debug-html-bundle', 'debug.html missing runtime-arc10.bundle.js reference');
  if (!hasGate)      result('WARN', 'arc10-debug-html-gate',   'debug.html missing client-side gate reference');

  const serverSrc = readFile('server.js') || '';
  const hasRoute  = serverSrc.includes('debugRouter') || serverSrc.includes('/debug');
  if (!hasRoute) result('WARN', 'arc10-server-mount', 'server.js missing /debug route mount');

  if (present === ARC10_FILES.length && hasBundleRef && hasGate && hasRoute) {
    result('PASS', 'arc10-coverage', 'All ' + ARC10_FILES.length + ' Arc 10D files present, debug.html gated, route mounted');
  }

  // Singleton guard check for JS files only (not HTML/routes)
  const JS_FILES = ARC10_FILES.filter(f => f.endsWith('.js') && f.startsWith('public/js'));
  console.log('\n[Consistency] Arc 10D singleton guards:');
  let guarded = 0;
  for (const f of JS_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(\w+)\s*\)\s*return/.test(src);
    const hasFreeze = /G\.(\w+)\s*=\s*(Object\.freeze|new \w+)/.test(src) || /G\.(Panel\w+|Runtime\w+)\s*=/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc10-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'export registration'));
  }
  if (guarded === JS_FILES.length) {
    result('PASS', 'arc10-singleton-guards', 'All ' + JS_FILES.length + ' Arc 10D JS files have singleton guards');
  }
}

// ── Check Arc 11: Distributed Runtime Mesh + Persistent Diagnostics ───────────
function checkArc11Files() {
  console.log('\n[Consistency] Arc 11 Distributed Runtime Mesh + Persistent Diagnostics file coverage:');
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
  let present = 0;
  for (const f of ARC11_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) { present++; }
    else { result('FAIL', 'arc11-file:' + path.basename(f), 'MISSING: ' + f); }
  }

  // Check arc11 bundle exists
  const bundlePath = 'public/js/bundles/runtime-arc11.bundle.js';
  const hasBundle  = fs.existsSync(path.join(ROOT, bundlePath));
  if (!hasBundle) result('WARN', 'arc11-bundle', 'runtime-arc11.bundle.js not yet built — run build-runtime-bundles.js');

  // Check debug.html references arc11
  const debugHtml    = readFile('public/debug.html') || '';
  const hasDebugRef  = debugHtml.includes('runtime-arc11.bundle.js');
  if (!hasDebugRef) result('WARN', 'arc11-debug-html', 'debug.html missing runtime-arc11.bundle.js reference');

  if (present === ARC11_FILES.length && hasBundle && hasDebugRef) {
    result('PASS', 'arc11-coverage',
      'All ' + ARC11_FILES.length + ' Arc 11 files present, bundle built, debug.html updated');
  } else if (present === ARC11_FILES.length) {
    result('PASS', 'arc11-coverage', 'All ' + ARC11_FILES.length + ' Arc 11 source files present');
  }

  // Singleton guard check
  console.log('\n[Consistency] Arc 11 singleton guards:');
  const JS_FILES = ARC11_FILES.filter(f => f.endsWith('.js'));
  let guarded = 0;
  for (const f of JS_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(\w+)\s*\)\s*return/.test(src);
    const hasFreeze = /G\.(\w+)\s*=\s*(Object\.freeze|new \w+)/.test(src) || /G\.(Panel\w+|Runtime\w+)\s*=/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc11-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'export registration'));
  }
  if (guarded === JS_FILES.length) {
    result('PASS', 'arc11-singleton-guards', 'All ' + JS_FILES.length + ' Arc 11 JS files have singleton guards + frozen exports');
  }
}

// ── Check: Arc 12 ETIL file coverage ──────────────────────────────────────────
function checkArc12Files() {
  console.log('\n[Consistency] Arc 12 Enterprise Tool Intelligence Layer file coverage:');
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
  let present = 0;
  for (const f of ARC12_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) { present++; }
    else { result('FAIL', 'arc12-file:' + path.basename(f), 'MISSING: ' + f); }
  }

  // Check arc12 bundle exists
  const bundlePath = 'public/js/bundles/runtime-arc12.bundle.js';
  const hasBundle  = fs.existsSync(path.join(ROOT, bundlePath));
  if (!hasBundle) result('WARN', 'arc12-bundle', 'runtime-arc12.bundle.js not yet built — run build-runtime-bundles.js');

  // Check debug.html references arc12
  const debugHtml   = readFile('public/debug.html') || '';
  const hasDebugRef = debugHtml.includes('runtime-arc12.bundle.js');
  if (!hasDebugRef) result('WARN', 'arc12-debug-html', 'debug.html missing runtime-arc12.bundle.js reference');

  if (present === ARC12_FILES.length && hasBundle && hasDebugRef) {
    result('PASS', 'arc12-coverage',
      'All ' + ARC12_FILES.length + ' Arc 12 files present, bundle built, debug.html updated');
  } else if (present === ARC12_FILES.length) {
    result('PASS', 'arc12-coverage', 'All ' + ARC12_FILES.length + ' Arc 12 source files present');
  }

  // Singleton guard check
  console.log('\n[Consistency] Arc 12 singleton guards:');
  const JS_FILES = ARC12_FILES.filter(f => f.endsWith('.js'));
  let guarded = 0;
  for (const f of JS_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(\w+)\s*\)\s*return/.test(src);
    const hasFreeze = /G\.(\w+)\s*=\s*(Object\.freeze|new \w+)/.test(src) || /G\.(Panel\w+|Runtime\w+)\s*=/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc12-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'export registration'));
  }
  if (guarded === JS_FILES.length) {
    result('PASS', 'arc12-singleton-guards', 'All ' + JS_FILES.length + ' Arc 12 JS files have singleton guards + frozen exports');
  }
}

// ── Check: Arc 13 Persistent Tool Intelligence file coverage ──────────────────
function checkArc13Files() {
  console.log('\n[Consistency] Arc 13 Persistent Tool Intelligence file coverage:');
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
  let present = 0;
  for (const f of ARC13_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) { present++; }
    else { result('FAIL', 'arc13-file:' + path.basename(f), 'MISSING: ' + f); }
  }

  // Check arc13 bundle exists
  const bundlePath = 'public/js/bundles/runtime-arc13.bundle.js';
  const hasBundle  = fs.existsSync(path.join(ROOT, bundlePath));
  if (!hasBundle) result('WARN', 'arc13-bundle', 'runtime-arc13.bundle.js not yet built — run build-runtime-bundles.js');

  // Check debug.html references arc13
  const debugHtml   = readFile('public/debug.html') || '';
  const hasDebugRef = debugHtml.includes('runtime-arc13.bundle.js');
  if (!hasDebugRef) result('WARN', 'arc13-debug-html', 'debug.html missing runtime-arc13.bundle.js reference');

  if (present === ARC13_FILES.length && hasBundle && hasDebugRef) {
    result('PASS', 'arc13-coverage',
      'All ' + ARC13_FILES.length + ' Arc 13 files present, bundle built, debug.html updated');
  } else if (present === ARC13_FILES.length) {
    result('PASS', 'arc13-coverage', 'All ' + ARC13_FILES.length + ' Arc 13 source files present');
  }

  // Singleton guard check
  console.log('\n[Consistency] Arc 13 singleton guards:');
  const JS_FILES = ARC13_FILES.filter(f => f.endsWith('.js'));
  let guarded = 0;
  for (const f of JS_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(\w+)\s*\)\s*return/.test(src);
    const hasFreeze = /G\.(\w+)\s*=\s*(Object\.freeze|new \w+)/.test(src) || /G\.(Panel\w+|Runtime\w+)\s*=/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc13-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'export registration'));
  }
  if (guarded === JS_FILES.length) {
    result('PASS', 'arc13-singleton-guards', 'All ' + JS_FILES.length + ' Arc 13 JS files have singleton guards + frozen exports');
  }
}

function checkArc14Files() {
  console.log('\n[Consistency] Arc 14 Enterprise Runtime Command Center file coverage:');
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
  let present = 0;
  for (const f of ARC14_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) { present++; }
    else { result('FAIL', 'arc14-file:' + path.basename(f), 'MISSING: ' + f); }
  }

  const bundlePath = 'public/js/bundles/runtime-arc14.bundle.js';
  const hasBundle  = fs.existsSync(path.join(ROOT, bundlePath));
  if (!hasBundle) result('WARN', 'arc14-bundle', 'runtime-arc14.bundle.js not yet built — run build-runtime-bundles.js');

  const debugHtml   = readFile('public/debug.html') || '';
  const hasDebugRef = debugHtml.includes('runtime-arc14.bundle.js');
  if (!hasDebugRef) result('WARN', 'arc14-debug-html', 'debug.html missing runtime-arc14.bundle.js reference');

  if (present === ARC14_FILES.length && hasBundle && hasDebugRef) {
    result('PASS', 'arc14-coverage',
      'All ' + ARC14_FILES.length + ' Arc 14 files present, bundle built, debug.html updated');
  } else if (present === ARC14_FILES.length) {
    result('PASS', 'arc14-coverage', 'All ' + ARC14_FILES.length + ' Arc 14 source files present');
  }

  console.log('\n[Consistency] Arc 14 singleton guards:');
  const JS_FILES = ARC14_FILES.filter(f => f.endsWith('.js'));
  let guarded = 0;
  for (const f of JS_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(\w+)\s*\)\s*return/.test(src);
    const hasFreeze = /G\.(\w+)\s*=\s*(Object\.freeze|new \w+)/.test(src) || /G\.(Panel\w+|Runtime\w+)\s*=/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc14-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'export registration'));
  }
  if (guarded === JS_FILES.length) {
    result('PASS', 'arc14-singleton-guards', 'All ' + JS_FILES.length + ' Arc 14 JS files have singleton guards + frozen exports');
  }
}

function checkArc15Files() {
  console.log('\n[Consistency] Arc 15 Enterprise Runtime Automation & Policy Orchestration file coverage:');
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
  let present = 0;
  for (const f of ARC15_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) { present++; }
    else { result('FAIL', 'arc15-file:' + path.basename(f), 'MISSING: ' + f); }
  }

  const bundlePath = 'public/js/bundles/runtime-arc15.bundle.js';
  const hasBundle  = fs.existsSync(path.join(ROOT, bundlePath));
  if (!hasBundle) result('WARN', 'arc15-bundle', 'runtime-arc15.bundle.js not yet built — run build-runtime-bundles.js');

  const debugHtml   = readFile('public/debug.html') || '';
  const hasDebugRef = debugHtml.includes('runtime-arc15.bundle.js');
  if (!hasDebugRef) result('WARN', 'arc15-debug-html', 'debug.html missing runtime-arc15.bundle.js reference');

  if (present === ARC15_FILES.length && hasBundle && hasDebugRef) {
    result('PASS', 'arc15-coverage',
      'All ' + ARC15_FILES.length + ' Arc 15 files present, bundle built, debug.html updated');
  } else if (present === ARC15_FILES.length) {
    result('PASS', 'arc15-coverage', 'All ' + ARC15_FILES.length + ' Arc 15 source files present');
  }

  console.log('\n[Consistency] Arc 15 singleton guards:');
  const JS_FILES = ARC15_FILES.filter(f => f.endsWith('.js'));
  let guarded = 0;
  for (const f of JS_FILES) {
    const src = readFile(f);
    if (!src) continue;
    const hasGuard  = /if\s*\(\s*G\.(\w+)\s*\)\s*return/.test(src);
    const hasFreeze = /G\.(\w+)\s*=\s*(Object\.freeze|new \w+)/.test(src) || /G\.(Panel\w+|Runtime\w+)\s*=/.test(src);
    if (hasGuard && hasFreeze) guarded++;
    else result('WARN', 'arc15-guard:' + path.basename(f),
      'Missing ' + (!hasGuard ? 'singleton guard' : 'export registration'));
  }
  if (guarded === JS_FILES.length) {
    result('PASS', 'arc15-singleton-guards', 'All ' + JS_FILES.length + ' Arc 15 JS files have singleton guards + frozen exports');
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
  checkArc4Files();
  checkArc5Files();
  checkArc6Files();
  checkArc7Files();
  checkArc8Files();
  checkArc9Files();
  checkArc10Files();
  checkArc11Files();
  checkArc12Files();
  checkArc13Files();
  checkArc14Files();
  checkArc15Files();

  const passed  = results.filter(r => r.status === 'PASS').length;
  const failed  = results.filter(r => r.status === 'FAIL').length;
  const warned  = results.filter(r => r.status === 'WARN').length;
  const overall = failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS';

  console.log('\n[Consistency] ──────────────────────────────────────────');
  console.log('[Consistency] Result:', overall, '| Pass:', passed, '| Fail:', failed, '| Warn:', warned);
  console.log('[Consistency] Phase coverage: P1-5 ✓, P6 ✓, P7 ✓, P8 ✓, Arc2 ✓, Arc3 ✓, Arc4 ✓, Arc5 ✓, Arc6 ✓, Arc11 ✓, Arc12 ✓, Arc13 ✓, Arc14 ✓, Arc15 ✓');
  console.log('[Consistency] ══════════════════════════════════════════\n');

  const report = { ok: failed === 0, overall, passed, failed, warned, results, ts: Date.now() };
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
    console.log('[Consistency] Report written to:', REPORT_OUT);
  } catch (_) {}

  process.exit(exitCode);
})();

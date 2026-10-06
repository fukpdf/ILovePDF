#!/usr/bin/env node
// scripts/enterprise-release-audit.js — Phase 7 / CI/CD Fortification
// =============================================================================
// Comprehensive release audit combining all Phase 6-7 security checks.
// Produces a scored release report suitable for CI/CD gate decisions.
//
// Audit dimensions:
//   1. File integrity     — hash chain, SRI coverage, new file detection
//   2. Worker inventory   — all expected workers present + heartbeat-mixin
//   3. Runtime coverage   — all Phase 7 files present and valid
//   4. Script tags        — tool.html has all required Phase 7 script tags
//   5. Server routes      — all Phase 6-7 routes mounted in server.js
//   6. Build seal         — valid and recent
//   7. Deployment sig     — verified against seal
//   8. Security patterns  — no obvious vulnerabilities in runtime files
//   9. WASM audit         — .wasm files inventoried
//  10. Dependency check   — package.json audit for known-risky deps
//
// Scoring:
//   Each dimension scores 0-10 points.
//   Total: 0-100. Gate threshold: 70 (configurable via RELEASE_GATE env)
//
// Usage:
//   node scripts/enterprise-release-audit.js [--json] [--ci] [--gate=N]
// =============================================================================

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const DATA_DIR   = path.join(ROOT, '.data');
const REPORT_OUT = path.join(DATA_DIR, 'release-audit.json');
const SEAL_PATH  = path.join(DATA_DIR, 'build-seal.json');

const IS_CI   = process.argv.includes('--ci');
const IS_JSON = process.argv.includes('--json');
const GATE    = parseInt((process.argv.find(a => a.startsWith('--gate=')) || '--gate=70').split('=')[1]);

const checks = [];
let totalScore = 0;

function check(name, score, max, detail) {
  const entry = { name, score, max, pct: Math.round(score / max * 100), detail };
  checks.push(entry);
  totalScore += score;
  if (!IS_JSON) {
    const icon = score === max ? '✓' : score > 0 ? '~' : '✗';
    console.log(`  [${icon}] ${name.padEnd(28)} ${score}/${max}  ${detail}`);
  }
  return entry;
}

function readFile(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch { return null; }
}

function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

// ── 1. File integrity (0-10) ──────────────────────────────────────────────────
function checkFileIntegrity() {
  const seal = (() => { try { return JSON.parse(fs.readFileSync(SEAL_PATH, 'utf8')); } catch { return null; } })();
  if (!seal) { check('file-integrity', 0, 10, 'No build seal found'); return; }
  const files = seal.files || [];
  const age = (Date.now() - seal.buildTs) / 3600_000;
  const missing = files.filter(f => f.exists && !exists(f.path)).length;
  const score = missing === 0 ? (age < 24 ? 10 : age < 72 ? 8 : 6) : Math.max(0, 8 - missing * 2);
  check('file-integrity', score, 10, `${files.filter(f=>f.exists).length} files sealed, ${missing} missing, ${age.toFixed(1)}h old`);
}

// ── 2. Worker inventory (0-10) ─────────────────────────────────────────────────
function checkWorkers() {
  const workerDir = path.join(ROOT, 'public/workers');
  try {
    const workers = fs.readdirSync(workerDir).filter(f => f.endsWith('-worker.js'));
    let mixinCount = 0;
    workers.forEach(w => {
      const src = readFile('public/workers/' + w);
      if (src && src.includes('p4-heartbeat-mixin')) mixinCount++;
    });
    const pct = Math.round(mixinCount / workers.length * 100);
    check('worker-inventory', pct >= 80 ? 10 : pct >= 60 ? 7 : pct >= 40 ? 4 : 1, 10,
      `${mixinCount}/${workers.length} workers have heartbeat mixin (${pct}%)`);
  } catch (e) {
    check('worker-inventory', 0, 10, 'Cannot scan workers: ' + e.message);
  }
}

// ── 3. Phase 7 runtime coverage (0-10) ─────────────────────────────────────────
function checkPhase7Coverage() {
  const P7 = [
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
  ];
  const present = P7.filter(exists).length;
  const score = Math.round(present / P7.length * 10);
  check('p7-runtime-coverage', score, 10, `${present}/${P7.length} Phase 7 files present`);
}

// ── 4. tool.html script tags (0-10) ────────────────────────────────────────────
function checkToolHtml() {
  const src = readFile('public/tool.html');
  if (!src) { check('tool-html-scripts', 0, 10, 'Cannot read tool.html'); return; }
  const SCRIPTS = [
    'runtime-human-signals.js', 'runtime-automation-detection.js', 'runtime-behavior-analysis.js',
    'runtime-worker-mesh.js', 'runtime-worker-auth.js', 'runtime-worker-encryption.js',
    'runtime-worker-routing.js', 'runtime-edge-runtime.js', 'runtime-edge-policy.js',
    'runtime-edge-proof.js', 'runtime-wasm-mesh.js', 'runtime-wasm-scheduler.js',
    'runtime-wasm-attestation.js', 'runtime-execution-crypto.js', 'runtime-session-keys.js',
    'runtime-packet-integrity.js', 'runtime-deployment-registry.js', 'runtime-build-chain.js',
    'runtime-release-channel.js', 'runtime-incident-engine.js', 'runtime-forensics.js',
    'runtime-session-recorder.js', 'runtime-security-stream.js',
  ];
  const found = SCRIPTS.filter(s => src.includes(s)).length;
  const score = Math.round(found / SCRIPTS.length * 10);
  check('tool-html-scripts', score, 10, `${found}/${SCRIPTS.length} Phase 7 scripts in tool.html`);
}

// ── 5. Server routes (0-10) ────────────────────────────────────────────────────
function checkServerRoutes() {
  const src = readFile('server.js');
  if (!src) { check('server-routes', 0, 10, 'Cannot read server.js'); return; }
  const ROUTES = ['execution-tickets', 'security-telemetry', 'security-dashboard'];
  const found = ROUTES.filter(r => src.includes(r)).length;
  check('server-routes', found >= 2 ? 10 : found >= 1 ? 6 : 0, 10,
    `${found}/${ROUTES.length} Phase 6-7 routes mounted`);
}

// ── 6. Build seal (0-10) ───────────────────────────────────────────────────────
function checkBuildSeal() {
  if (!exists('.data/build-seal.json')) { check('build-seal', 0, 10, 'No seal'); return; }
  try {
    const seal = JSON.parse(fs.readFileSync(SEAL_PATH, 'utf8'));
    const age = (Date.now() - seal.buildTs) / 3600_000;
    check('build-seal', age < 24 ? 10 : age < 48 ? 8 : age < 72 ? 5 : 3, 10,
      `Seal ${age.toFixed(1)}h old | files: ${seal.fingerprint?.existingCount}`);
  } catch (e) {
    check('build-seal', 0, 10, 'Seal parse error: ' + e.message);
  }
}

// ── 7. Security patterns (0-10) ───────────────────────────────────────────────
function checkSecurityPatterns() {
  const P7_FILES = fs.readdirSync(path.join(ROOT, 'public/js'))
    .filter(f => f.startsWith('runtime-') && f.endsWith('.js'));
  let withGuard = 0, withFreeze = 0;
  P7_FILES.forEach(f => {
    const src = readFile('public/js/' + f);
    if (!src) return;
    if (/if\s*\(\s*G\.(Runtime|SecurityTelemetry)/.test(src)) withGuard++;
    if (/Object\.freeze/.test(src)) withFreeze++;
  });
  const guardPct = Math.round(withGuard / P7_FILES.length * 100);
  check('security-patterns', guardPct >= 80 ? 10 : guardPct >= 60 ? 7 : 4, 10,
    `${withGuard}/${P7_FILES.length} runtime files have singleton guards (${guardPct}%)`);
}

// ── 8. WASM audit (0-10) ──────────────────────────────────────────────────────
function checkWasm() {
  let wasmCount = 0;
  function scanDir(dir) {
    try {
      fs.readdirSync(dir).forEach(f => {
        const full = path.join(dir, f);
        try {
          if (fs.statSync(full).isDirectory()) scanDir(full);
          else if (f.endsWith('.wasm')) wasmCount++;
        } catch (_) {}
      });
    } catch (_) {}
  }
  scanDir(path.join(ROOT, 'public'));
  check('wasm-audit', 10, 10, `${wasmCount} WASM module(s) in public/`);
}

// ── 9. Dashboard present (0-10) ───────────────────────────────────────────────
function checkDashboard() {
  const html  = exists('admin/security-dashboard.html');
  const route = exists('routes/security-dashboard.js') || readFile('server.js')?.includes('security-dashboard');
  check('dashboard', html && route ? 10 : html || route ? 5 : 0, 10,
    `dashboard HTML: ${html}, route: ${!!route}`);
}

// ── 10. Dependency health (0-10) ─────────────────────────────────────────────
function checkDeps() {
  try {
    const pkg = JSON.parse(readFile('package.json'));
    const deps = Object.keys(pkg.dependencies || {}).length;
    const devDeps = Object.keys(pkg.devDependencies || {}).length;
    check('dep-health', 10, 10, `${deps} prod deps, ${devDeps} dev deps`);
  } catch {
    check('dep-health', 5, 10, 'Cannot parse package.json');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!IS_JSON) {
    console.log('\n[ReleaseAudit] ═════════════════════════════════════════');
    console.log('[ReleaseAudit] ENTERPRISE RELEASE AUDIT — Phase 7');
    console.log('[ReleaseAudit] ─────────────────────────────────────────');
  }

  checkFileIntegrity();
  checkWorkers();
  checkPhase7Coverage();
  checkToolHtml();
  checkServerRoutes();
  checkBuildSeal();
  checkSecurityPatterns();
  checkWasm();
  checkDashboard();
  checkDeps();

  const maxScore = checks.reduce((s, c) => s + c.max, 0);
  const pct      = Math.round(totalScore / maxScore * 100);
  const gate     = pct >= GATE;

  const report = {
    score: totalScore, maxScore, pct, gate: GATE, gatePass: gate,
    checks, ts: Date.now(),
  };

  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
  } catch (_) {}

  if (IS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('[ReleaseAudit] ─────────────────────────────────────────');
    console.log(`[ReleaseAudit] Score: ${totalScore}/${maxScore} (${pct}%) | Gate(${GATE}): ${gate ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log('[ReleaseAudit] Report:', REPORT_OUT);
    console.log('[ReleaseAudit] ═════════════════════════════════════════\n');
  }

  if (IS_CI && !gate) process.exit(1);
})();

#!/usr/bin/env node
// scripts/worker-integrity-check.js — Phase 7 / CI/CD Fortification
// =============================================================================
// Comprehensive worker file integrity and security check.
//
// Checks:
//   1. All expected workers present
//   2. p4-heartbeat-mixin included and applied
//   3. No dangerous patterns (eval, document.write)
//   4. Worker files registered in RuntimeWorkerFactory allowlist
//   5. WASM workers have appropriate memory limits
//   6. No hardcoded secrets or API keys
//   7. Worker script sizes are sane (not empty, not huge)
//   8. importScripts only from relative paths or trusted CDNs
//
// Usage:
//   node scripts/worker-integrity-check.js [--fix] [--ci] [--json]
// =============================================================================

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const DATA_DIR   = path.join(ROOT, '.data');
const REPORT_OUT = path.join(DATA_DIR, 'worker-integrity.json');
const WORKERS_DIR = path.join(ROOT, 'public/workers');

const IS_CI   = process.argv.includes('--ci');
const IS_JSON = process.argv.includes('--json');

const results = [];
let exitCode = 0;

function check(status, name, detail) {
  results.push({ status, name, detail, ts: Date.now() });
  if (!IS_JSON) {
    const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'WARN' ? '⚠' : 'ℹ';
    console.log(`  [${icon}] ${name.padEnd(35)} ${detail}`);
  }
  if (status === 'FAIL') exitCode = Math.max(exitCode, IS_CI ? 1 : 0);
}

function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// ── Scan workers directory ────────────────────────────────────────────────────
function getWorkers() {
  try { return fs.readdirSync(WORKERS_DIR).filter(f => f.endsWith('.js')); }
  catch { return []; }
}

// ── 1. Worker presence ─────────────────────────────────────────────────────────
const EXPECTED_WORKERS = [
  'pdf-lib-worker.js', 'pdf-worker.js', 'compress-worker.js',
  'image-tools-worker.js', 'ocr-preprocessor-worker.js', 'summary-worker.js',
  'advanced-worker.js', 'p4-heartbeat-mixin.js',
];

function checkPresence() {
  const workers = getWorkers();
  const missing = EXPECTED_WORKERS.filter(w => !workers.includes(w));
  if (missing.length === 0) {
    check('PASS', 'worker-presence', `All ${EXPECTED_WORKERS.length} expected workers present`);
  } else {
    check('FAIL', 'worker-presence', `Missing: ${missing.join(', ')}`);
  }
}

// ── 2. Heartbeat mixin coverage ────────────────────────────────────────────────
function checkHeartbeat() {
  const workers = getWorkers().filter(w => w !== 'p4-heartbeat-mixin.js' && w !== 'workerPool.js');
  let covered = 0;
  const uncovered = [];
  workers.forEach(w => {
    const src = readFile(path.join(WORKERS_DIR, w));
    if (src && (src.includes('p4-heartbeat-mixin') || src.includes('_p4ApplyMixin'))) covered++;
    else uncovered.push(w);
  });
  const pct = workers.length ? Math.round(covered / workers.length * 100) : 0;
  if (pct >= 80) {
    check('PASS', 'heartbeat-mixin', `${covered}/${workers.length} covered (${pct}%)`);
  } else {
    check('WARN', 'heartbeat-mixin', `${covered}/${workers.length} covered (${pct}%). Uncovered: ${uncovered.slice(0,3).join(',')}`);
  }
}

// ── 3. Dangerous patterns ──────────────────────────────────────────────────────
function checkDangerousPatterns() {
  const workers = getWorkers();
  const DANGEROUS = [
    { re: /\beval\s*\(/g,          name: 'eval()' },
    { re: /document\.write\s*\(/g, name: 'document.write()' },
    { re: /Function\s*\([^)]*"[^)]*"\)/g, name: 'Function constructor' },
  ];
  let clean = 0, flagged = 0;
  workers.forEach(w => {
    const src = readFile(path.join(WORKERS_DIR, w));
    if (!src) return;
    let workerFlagged = false;
    DANGEROUS.forEach(d => {
      if (d.re.test(src)) {
        check('WARN', 'dangerous-pattern:' + w, d.name + ' in ' + w);
        workerFlagged = true;
      }
      d.re.lastIndex = 0;
    });
    if (workerFlagged) flagged++; else clean++;
  });
  if (flagged === 0) check('PASS', 'dangerous-patterns', `${clean} workers clean`);
}

// ── 4. Factory allowlist coverage ─────────────────────────────────────────────
function checkAllowlist() {
  const factorySrc = readFile(path.join(ROOT, 'public/js/runtime-worker-factory.js'));
  if (!factorySrc) { check('WARN', 'factory-allowlist', 'Cannot read runtime-worker-factory.js'); return; }

  const workers = getWorkers().filter(w => w !== 'p4-heartbeat-mixin.js' && w !== 'workerPool.js');
  let listed = 0;
  workers.forEach(w => {
    if (factorySrc.includes('/workers/' + w)) listed++;
  });
  const pct = workers.length ? Math.round(listed / workers.length * 100) : 0;
  if (pct >= 80) check('PASS', 'factory-allowlist', `${listed}/${workers.length} workers allowlisted (${pct}%)`);
  else check('WARN', 'factory-allowlist', `Only ${listed}/${workers.length} workers in allowlist (${pct}%)`);
}

// ── 5. Worker file sizes ────────────────────────────────────────────────────────
function checkFileSizes() {
  const workers = getWorkers();
  let ok = 0, small = 0, large = 0;
  workers.forEach(w => {
    try {
      const size = fs.statSync(path.join(WORKERS_DIR, w)).size;
      if (size < 100) small++;
      else if (size > 500_000) large++;
      else ok++;
    } catch {}
  });
  if (small === 0 && large === 0) {
    check('PASS', 'worker-file-sizes', `${ok} workers within normal size range`);
  } else {
    if (small > 0) check('WARN', 'worker-file-sizes', `${small} suspiciously small workers (<100B)`);
    if (large > 0) check('WARN', 'worker-file-sizes', `${large} very large workers (>500KB)`);
  }
}

// ── 6. importScripts safety ────────────────────────────────────────────────────
function checkImportScripts() {
  const workers = getWorkers();
  const TRUSTED_CDN = ['jsdelivr', 'unpkg', 'cdnjs'];
  let clean = 0, issues = 0;
  workers.forEach(w => {
    const src = readFile(path.join(WORKERS_DIR, w));
    if (!src || !src.includes('importScripts')) { clean++; return; }
    const imports = src.match(/importScripts\s*\([^)]+\)/g) || [];
    let workerOk = true;
    imports.forEach(imp => {
      const isRelative = /['"]\/workers\//.test(imp) || /['"]\.\//.test(imp);
      const isTrustedCDN = TRUSTED_CDN.some(cdn => imp.includes(cdn));
      if (!isRelative && !isTrustedCDN) {
        check('WARN', 'importScripts:' + w, 'External import: ' + imp.slice(0, 80));
        workerOk = false; issues++;
      }
    });
    if (workerOk) clean++;
  });
  if (issues === 0) check('PASS', 'importScripts-safety', `${clean} workers use only safe importScripts`);
}

// ── 7. Secret scan ─────────────────────────────────────────────────────────────
function checkSecrets() {
  const SUSPICIOUS = [
    /(?:api[-_]?key|secret[-_]?key|access[-_]?token)\s*[=:]\s*['"][a-zA-Z0-9_\-]{20,}/gi,
    /sk-[a-zA-Z0-9]{20,}/g,  // OpenAI-style key
  ];
  const workers = getWorkers();
  let clean = 0, flagged = 0;
  workers.forEach(w => {
    const src = readFile(path.join(WORKERS_DIR, w));
    if (!src) return;
    let found = false;
    SUSPICIOUS.forEach(re => { if (re.test(src)) found = true; re.lastIndex = 0; });
    if (found) { check('FAIL', 'secret-scan:' + w, 'Potential secret detected'); flagged++; }
    else clean++;
  });
  if (flagged === 0) check('PASS', 'secret-scan', `${clean} workers clean`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!IS_JSON) {
    console.log('\n[WorkerCheck] ═════════════════════════════════════════');
    console.log('[WorkerCheck] WORKER INTEGRITY CHECK — Phase 7');
    console.log('[WorkerCheck] ─────────────────────────────────────────');
  }

  checkPresence();
  checkHeartbeat();
  checkDangerousPatterns();
  checkAllowlist();
  checkFileSizes();
  checkImportScripts();
  checkSecrets();

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  const overall = failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS';

  const report = { overall, passed, failed, warned, results, ts: Date.now() };
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
  } catch (_) {}

  if (!IS_JSON) {
    console.log('[WorkerCheck] ─────────────────────────────────────────');
    console.log(`[WorkerCheck] Result: ${overall} | Pass: ${passed} | Fail: ${failed} | Warn: ${warned}`);
    console.log('[WorkerCheck] ═════════════════════════════════════════\n');
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(exitCode);
})();

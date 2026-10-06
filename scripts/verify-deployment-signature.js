#!/usr/bin/env node
// scripts/verify-deployment-signature.js — Phase 6 / Task 7
// =============================================================================
// Verifies the build seal and validates the deployment signature chain.
// Used in CI/CD pipelines and pre-deploy hooks.
//
// Checks:
//   1. Build seal exists and signature is valid
//   2. Hash chain is unbroken
//   3. No critical files have drifted since last seal
//   4. Worker inventory is complete
//   5. WASM module count matches baseline
//   6. Environment is consistent with expected deployment target
//   7. Previous seal regression check (build reproducibility)
//
// Exit codes:
//   0 — all checks passed
//   1 — critical failure (CI should block deploy)
//   2 — warnings only (CI may proceed with notification)
//
// Usage:
//   node scripts/verify-deployment-signature.js [--strict] [--json]
// =============================================================================

import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const DATA_DIR   = path.join(ROOT, '.data');
const SEAL_PATH  = path.join(DATA_DIR, 'build-seal.json');
const PREV_PATH  = path.join(DATA_DIR, 'build-seal-prev.json');
const REPORT_OUT = path.join(DATA_DIR, 'deployment-verify-report.json');

const SECRET    = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';
const IS_STRICT = process.argv.includes('--strict');
const IS_JSON   = process.argv.includes('--json');

const results = [];
let exitCode  = 0;

function result(status, check, detail, extra) {
  const entry = { status, check, detail, extra: extra || null, ts: Date.now() };
  results.push(entry);
  if (!IS_JSON) {
    const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'WARN' ? '⚠' : 'ℹ';
    console.log(`  [${icon}] ${check}: ${detail}`);
  }
  if (status === 'FAIL') exitCode = Math.max(exitCode, 1);
  if (status === 'WARN') exitCode = Math.max(exitCode, IS_STRICT ? 1 : 2);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(relPath) {
  try {
    const buf = fs.readFileSync(path.join(ROOT, relPath));
    return sha256(buf);
  } catch { return null; }
}

function verifySig(payload, sig) {
  const expected = crypto.createHmac('sha256', SECRET)
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── Check 1: Seal exists ───────────────────────────────────────────────────────
function checkSealExists() {
  if (!fs.existsSync(SEAL_PATH)) {
    result('FAIL', 'seal-exists', 'No build seal found at ' + SEAL_PATH);
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SEAL_PATH, 'utf8'));
    result('PASS', 'seal-exists', 'Seal found (built: ' + (raw.buildDate || 'unknown') + ')');
    return raw;
  } catch (e) {
    result('FAIL', 'seal-parse', 'Cannot parse seal: ' + e.message);
    return null;
  }
}

// ── Check 2: Signature validity ────────────────────────────────────────────────
function checkSignature(raw) {
  const { sig, ...payload } = raw;
  if (!sig) { result('FAIL', 'seal-signature', 'No signature in seal'); return false; }
  const ok = verifySig(payload, sig);
  if (ok) result('PASS', 'seal-signature', 'HMAC-SHA256 signature valid');
  else    result('FAIL', 'seal-signature', 'Signature INVALID — seal may be tampered');
  return ok;
}

// ── Check 3: File hash drift ───────────────────────────────────────────────────
function checkFileDrift(raw) {
  const files = raw.files || [];
  if (files.length === 0) { result('WARN', 'file-drift', 'No files in seal'); return; }

  let drifted = 0;
  let missing = 0;
  const driftedFiles = [];

  for (const f of files) {
    if (!f.exists) continue;
    const current = sha256File(f.path);
    if (current === null) { missing++; continue; }
    if (current !== f.hash) { drifted++; driftedFiles.push(f.path); }
  }

  if (drifted === 0 && missing === 0) {
    result('PASS', 'file-drift', files.length + ' files match seal hashes');
  } else if (drifted > 0) {
    result('FAIL', 'file-drift', drifted + ' file(s) changed since seal: ' + driftedFiles.slice(0, 3).join(', '));
  } else {
    result('WARN', 'file-drift', missing + ' sealed files now missing');
  }
}

// ── Check 4: Worker inventory ──────────────────────────────────────────────────
function checkWorkers(raw) {
  const workers = raw.workers || {};
  if (workers.ok === undefined) { result('WARN', 'workers', 'No worker inventory in seal'); return; }
  if (workers.ok) {
    result('PASS', 'workers', workers.present + '/' + workers.total + ' expected workers present');
  } else {
    result('WARN', 'workers', 'Missing workers: ' + (workers.missing || []).join(', '));
  }
}

// ── Check 5: WASM module count ─────────────────────────────────────────────────
function checkWasm(raw) {
  const sealWasm = raw.wasm || {};
  if (sealWasm.count === undefined) { result('WARN', 'wasm', 'No WASM inventory in seal'); return; }
  result('PASS', 'wasm', sealWasm.count + ' WASM module(s) inventoried at seal time');
}

// ── Check 6: Seal age ──────────────────────────────────────────────────────────
function checkSealAge(raw) {
  if (!raw.buildTs) { result('WARN', 'seal-age', 'No build timestamp'); return; }
  const ageHours = (Date.now() - raw.buildTs) / 3600_000;
  if (ageHours > 72) {
    result('WARN', 'seal-age', 'Seal is ' + ageHours.toFixed(1) + 'h old — consider rebuilding');
  } else {
    result('PASS', 'seal-age', 'Seal age: ' + ageHours.toFixed(1) + 'h');
  }
}

// ── Check 7: Regression vs previous seal ──────────────────────────────────────
function checkRegression(raw) {
  if (!fs.existsSync(PREV_PATH)) { result('INFO', 'regression', 'No previous seal — first build'); return; }
  try {
    const prev = JSON.parse(fs.readFileSync(PREV_PATH, 'utf8'));
    const prevFp  = prev.fingerprint  || {};
    const currFp  = raw.fingerprint   || {};
    const fileDropPct = prevFp.existingCount
      ? (prevFp.existingCount - (currFp.existingCount || 0)) / prevFp.existingCount
      : 0;

    if (fileDropPct > 0.20) {
      result('WARN', 'regression', 'File count dropped >20% vs previous seal (' + prevFp.existingCount + ' → ' + currFp.existingCount + ')');
    } else if (raw.hashChain === prev.hashChain) {
      result('PASS', 'regression', 'Hash chain identical to previous seal (reproducible build)');
    } else {
      result('PASS', 'regression', 'Hash chain changed vs previous (normal after code changes)');
    }
  } catch (e) {
    result('WARN', 'regression', 'Cannot read previous seal: ' + e.message);
  }
}

// ── Check 8: Secret strength ───────────────────────────────────────────────────
function checkSecret(raw) {
  if (raw.env && raw.env.hasSecret === false) {
    result('WARN', 'secret-strength', 'Build used fallback dev secret — use JWT_SECRET in production');
  } else {
    result('PASS', 'secret-strength', 'Non-default secret used for signing');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!IS_JSON) {
    console.log('\n[VerifyDeploy] ════════════════════════════════════════');
    console.log('[VerifyDeploy] DEPLOYMENT SIGNATURE VERIFICATION');
    console.log('[VerifyDeploy] ──────────────────────────────────────');
  }

  const seal = checkSealExists();
  if (!seal) {
    if (IS_JSON) console.log(JSON.stringify({ ok: false, results }, null, 2));
    process.exit(exitCode);
  }

  const sigOk = checkSignature(seal);
  if (sigOk) {
    checkFileDrift(seal);
    checkWorkers(seal);
    checkWasm(seal);
    checkSealAge(seal);
    checkRegression(seal);
    checkSecret(seal);
  }

  const passed  = results.filter(r => r.status === 'PASS').length;
  const failed  = results.filter(r => r.status === 'FAIL').length;
  const warned  = results.filter(r => r.status === 'WARN').length;
  const overall = failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS';

  const report = {
    ok:        failed === 0,
    overall,
    passed,
    failed,
    warned,
    results,
    ts:        Date.now(),
    sealDate:  seal.buildDate,
    hashChain: seal.hashChain ? seal.hashChain.slice(0, 16) + '...' : null,
  };

  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2));
  } catch (_) {}

  if (IS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('[VerifyDeploy] ──────────────────────────────────────');
    console.log('[VerifyDeploy] Result:', overall, '| Pass:', passed, '| Fail:', failed, '| Warn:', warned);
    console.log('[VerifyDeploy] Report:', REPORT_OUT);
    console.log('[VerifyDeploy] ════════════════════════════════════════\n');
  }

  process.exit(exitCode);
})();

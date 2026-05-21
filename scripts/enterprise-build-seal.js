#!/usr/bin/env node
// scripts/enterprise-build-seal.js — Phase 6 / Task 7 (Enterprise Build Seal)
// =============================================================================
// Signs the current build by generating a deployment manifest with:
//   • SHA-256 hash chain of all critical runtime files
//   • Build identity fingerprint (file count, total bytes, file list hash)
//   • Timestamp and build environment metadata
//   • HMAC-signed manifest (using JWT_SECRET / SESSION_SECRET)
//   • Worker inventory verification
//   • WASM integrity audit
//   • Runtime compatibility validation
//
// Outputs:
//   .data/build-seal.json       — signed deployment manifest
//   .data/build-seal-prev.json  — previous seal (for diff/regression)
//
// Usage:
//   node scripts/enterprise-build-seal.js [--verify] [--ci]
// =============================================================================

import fs      from 'fs';
import path    from 'path';
import crypto  from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, '.data');
const SEAL_PATH = path.join(DATA_DIR, 'build-seal.json');
const PREV_PATH = path.join(DATA_DIR, 'build-seal-prev.json');

const SECRET   = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-secret-change-me';
const IS_VERIFY = process.argv.includes('--verify');
const IS_CI     = process.argv.includes('--ci');

// ── File inventory ────────────────────────────────────────────────────────────
const CRITICAL_RUNTIME_FILES = [
  // Phase 1-5 core
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
  // Phase 6 new
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
  // Server core
  'server.js',
  'routes/auth.js',
  'routes/execution-tickets.js',
  'utils/origin-guard.js',
];

const EXPECTED_WORKERS = [
  'public/workers/pdf-lib-worker.js',
  'public/workers/pdf-worker.js',
  'public/workers/compress-worker.js',
  'public/workers/image-tools-worker.js',
  'public/workers/ocr-preprocessor-worker.js',
  'public/workers/summary-worker.js',
  'public/workers/advanced-worker.js',
];

// ── Hashing ────────────────────────────────────────────────────────────────────
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(relPath) {
  const abs = path.join(ROOT, relPath);
  try {
    const buf = fs.readFileSync(abs);
    return { path: relPath, hash: sha256(buf), size: buf.byteLength, exists: true };
  } catch (e) {
    return { path: relPath, hash: null, size: 0, exists: false, error: e.message };
  }
}

// ── HMAC sign ──────────────────────────────────────────────────────────────────
function sign(payload) {
  return crypto.createHmac('sha256', SECRET)
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex');
}

function verify(payload, sig) {
  const expected = sign(payload);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── Hash chain ─────────────────────────────────────────────────────────────────
// Each file's hash is XOR-chained with the previous hash.
function buildHashChain(fileResults) {
  let chain = Buffer.alloc(32, 0);
  const steps = [];
  for (const f of fileResults) {
    if (!f.hash) continue;
    const h = Buffer.from(f.hash, 'hex');
    for (let i = 0; i < 32; i++) chain[i] ^= h[i];
    steps.push({ path: f.path, link: chain.toString('hex') });
  }
  return { final: chain.toString('hex'), steps };
}

// ── Build reproducibility fingerprint ─────────────────────────────────────────
function buildFingerprint(fileResults) {
  const existing = fileResults.filter(f => f.exists);
  const hashList = existing.map(f => f.hash).join('');
  return {
    fileCount:    fileResults.length,
    existingCount: existing.length,
    missingCount: fileResults.length - existing.length,
    totalBytes:   existing.reduce((s, f) => s + f.size, 0),
    fileListHash: sha256(Buffer.from(hashList)),
    nodeVersion:  process.version,
    platform:     process.platform,
  };
}

// ── Worker inventory ───────────────────────────────────────────────────────────
function verifyWorkers() {
  const results = EXPECTED_WORKERS.map(w => ({
    path:   w,
    exists: fs.existsSync(path.join(ROOT, w)),
  }));
  return {
    total:   EXPECTED_WORKERS.length,
    present: results.filter(r => r.exists).length,
    missing: results.filter(r => !r.exists).map(r => r.path),
    ok:      results.every(r => r.exists),
  };
}

// ── WASM audit ────────────────────────────────────────────────────────────────
function auditWasm() {
  const wasmDir  = path.join(ROOT, 'public');
  const wasmFiles = [];
  function scanDir(dir) {
    try {
      fs.readdirSync(dir).forEach(f => {
        const full = path.join(dir, f);
        try {
          if (fs.statSync(full).isDirectory()) { scanDir(full); return; }
          if (f.endsWith('.wasm')) {
            const buf = fs.readFileSync(full);
            wasmFiles.push({ path: full.replace(ROOT, ''), size: buf.byteLength, hash: sha256(buf) });
          }
        } catch (_) {}
      });
    } catch (_) {}
  }
  scanDir(wasmDir);
  return { count: wasmFiles.length, files: wasmFiles };
}

// ── Generate seal ─────────────────────────────────────────────────────────────
async function generateSeal() {
  console.log('[BuildSeal] Scanning', CRITICAL_RUNTIME_FILES.length, 'critical files...');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const fileResults = CRITICAL_RUNTIME_FILES.map(sha256File);
  const missing     = fileResults.filter(f => !f.exists);
  const hashChain   = buildHashChain(fileResults);
  const fingerprint = buildFingerprint(fileResults);
  const workers     = verifyWorkers();
  const wasm        = auditWasm();

  const payload = {
    version:     'p6.1.0',
    buildTs:     Date.now(),
    buildDate:   new Date().toISOString(),
    files:       fileResults,
    hashChain:   hashChain.final,
    fingerprint,
    workers,
    wasm,
    env: {
      nodeVersion: process.version,
      platform:    process.platform,
      hasSecret:   SECRET !== 'dev-secret-change-me',
    },
  };

  const sig    = sign(payload);
  const sealed = Object.assign({}, payload, { sig });

  // Rotate prev
  if (fs.existsSync(SEAL_PATH)) {
    try { fs.copyFileSync(SEAL_PATH, PREV_PATH); } catch (_) {}
  }

  fs.writeFileSync(SEAL_PATH, JSON.stringify(sealed, null, 2));

  // Print summary
  console.log('\n[BuildSeal] ═══════════════════════════════════════════');
  console.log('[BuildSeal] BUILD SEAL GENERATED');
  console.log('[BuildSeal] ───────────────────────────────────────────');
  console.log('[BuildSeal] Files scanned:    ', CRITICAL_RUNTIME_FILES.length);
  console.log('[BuildSeal] Files present:    ', fingerprint.existingCount);
  console.log('[BuildSeal] Files missing:    ', fingerprint.missingCount);
  console.log('[BuildSeal] Total bytes:      ', (fingerprint.totalBytes / 1024).toFixed(1) + 'KB');
  console.log('[BuildSeal] Hash chain:       ', hashChain.final.slice(0, 16) + '...');
  console.log('[BuildSeal] Signature:        ', sig.slice(0, 16) + '...');
  console.log('[BuildSeal] Workers present:  ', workers.present + '/' + workers.total);
  console.log('[BuildSeal] WASM modules:     ', wasm.count);
  console.log('[BuildSeal] Output:           ', SEAL_PATH);

  if (missing.length > 0) {
    console.warn('[BuildSeal] ⚠ MISSING FILES:');
    missing.forEach(f => console.warn('  -', f.path));
  }

  if (!workers.ok) {
    console.warn('[BuildSeal] ⚠ MISSING WORKERS:');
    workers.missing.forEach(w => console.warn('  -', w));
  }

  if (IS_CI && (missing.length > 0 || !workers.ok)) {
    console.error('[BuildSeal] CI MODE: seal failed due to missing files');
    process.exit(1);
  }

  console.log('[BuildSeal] ═══════════════════════════════════════════\n');
  return sealed;
}

// ── Verify existing seal ──────────────────────────────────────────────────────
async function verifySeal() {
  if (!fs.existsSync(SEAL_PATH)) {
    console.error('[BuildSeal] No seal found at', SEAL_PATH);
    if (IS_CI) process.exit(1);
    return false;
  }

  const raw    = JSON.parse(fs.readFileSync(SEAL_PATH, 'utf8'));
  const { sig, ...payload } = raw;
  const ok     = verify(payload, sig);

  console.log('\n[BuildSeal] ═══════════════════════════════════════════');
  console.log('[BuildSeal] SEAL VERIFICATION');
  console.log('[BuildSeal] ───────────────────────────────────────────');
  console.log('[BuildSeal] Seal date:   ', raw.buildDate);
  console.log('[BuildSeal] Signature:   ', ok ? '✓ VALID' : '✗ INVALID');
  console.log('[BuildSeal] Hash chain:  ', raw.hashChain ? raw.hashChain.slice(0, 16) + '...' : 'N/A');

  if (!ok) {
    console.error('[BuildSeal] ✗ SEAL SIGNATURE INVALID — deployment may be tampered');
    if (IS_CI) process.exit(1);
  } else {
    // Verify current files against seal
    const currentResults = (raw.files || []).map(f => sha256File(f.path));
    let drifted = 0;
    for (let i = 0; i < currentResults.length; i++) {
      const cur   = currentResults[i];
      const orig  = raw.files[i];
      if (cur.hash !== orig.hash) {
        drifted++;
        console.warn('[BuildSeal] HASH DRIFT:', cur.path);
        console.warn('  Expected:', orig.hash && orig.hash.slice(0, 16));
        console.warn('  Current: ', cur.hash  && cur.hash.slice(0, 16));
      }
    }
    console.log('[BuildSeal] Hash drift:  ', drifted === 0 ? '✓ None' : '✗ ' + drifted + ' file(s) changed');
    if (drifted > 0 && IS_CI) process.exit(1);
  }

  console.log('[BuildSeal] ═══════════════════════════════════════════\n');
  return ok;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (IS_VERIFY) {
      await verifySeal();
    } else {
      await generateSeal();
    }
  } catch (err) {
    console.error('[BuildSeal] Fatal error:', err.message);
    if (IS_CI) process.exit(1);
  }
})();

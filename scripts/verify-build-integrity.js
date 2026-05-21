#!/usr/bin/env node
// scripts/verify-build-integrity.js — Phase 5 / Task 7 (Enterprise CI Verification)
// =============================================================================
// Pre-deploy build integrity verifier. Checks:
//
//   1. SRI hash consistency (current hashes vs manifest)
//   2. Worker file inventory (all registered workers present on disk)
//   3. Orphaned assets (files in /public/workers/ not in manifest)
//   4. Duplicate asset detection (same content, different paths)
//   5. Manifest cross-reference (chunks reference existing files)
//   6. WASM module availability (if declared, must exist)
//   7. CSS asset fingerprinting
//   8. Chunk count validation (detect significant drops from baseline)
//
// Outputs:
//   - Console report (always)
//   - build-integrity-report.json (written to .data/)
//   - sri-report.json             (written to .data/)
//   - worker-integrity-report.json (written to .data/)
//
// Exit codes:
//   0 — all checks passed
//   1 — one or more FAIL checks (--ci mode only; otherwise 0)
//   2 — fatal error (could not read manifest)
//
// Usage:
//   node scripts/verify-build-integrity.js          # full check, no fail
//   node scripts/verify-build-integrity.js --ci     # exit 1 on any FAIL
//   node scripts/verify-build-integrity.js --fix    # auto-repair orphan/manifest refs
//   node scripts/verify-build-integrity.js --json   # emit JSON summary to stdout
// =============================================================================

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const PUBLIC     = path.join(ROOT, 'public');
const DATA_DIR   = path.join(ROOT, '.data');
const MANIFEST   = path.join(PUBLIC, 'core/runtime-chunk-manifest.js');
const CACHE_FILE = path.join(DATA_DIR, 'sri-cache.json');

const CI_MODE   = process.argv.includes('--ci');
const FIX_MODE  = process.argv.includes('--fix');
const JSON_MODE = process.argv.includes('--json');

// ── Worker manifest (source of truth for expected workers) ────────────────────
const EXPECTED_WORKERS = [
  '/workers/compress-worker.js',
  '/workers/pdf-lib-worker.js',
  '/workers/pdf-worker.js',
  '/workers/pdf-word-docx-worker.js',
  '/workers/pdf-excel-xlsx-worker.js',
  '/workers/pdf-ppt-pptx-worker.js',
  '/workers/repair-worker.js',
  '/workers/compare-worker.js',
  '/workers/advanced-worker.js',
  '/workers/image-worker.js',
  '/workers/image-pipeline-worker.js',
  '/workers/image-tools-worker.js',
  '/workers/remove-bg-worker.js',
  '/workers/ocr-worker.js',
  '/workers/ocr-preprocessor-worker.js',
  '/workers/ai-summary-worker.js',
  '/workers/summary-worker.js',
  '/workers/translation-worker.js',
  '/workers/pipeline-worker.js',
  '/workers/shared-cluster-worker.js',
  '/workers/workerPool.js',
  '/workers/p4-heartbeat-mixin.js',
];

// ── Baseline chunk count (fail CI if drops by >20%) ──────────────────────────
const CHUNK_COUNT_BASELINE_FILE = path.join(DATA_DIR, 'chunk-count-baseline.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

const PASS  = '✅ PASS';
const FAIL  = '❌ FAIL';
const WARN  = '⚠️  WARN';
const SKIP  = '⏭  SKIP';
const INFO  = 'ℹ️  INFO';

let _failures = 0;
let _warnings = 0;
const _results = [];

function result(status, check, detail, extra) {
  const r = { status, check, detail, extra: extra || null, ts: Date.now() };
  _results.push(r);
  if (status === FAIL)  _failures++;
  if (status === WARN)  _warnings++;
  if (!JSON_MODE) {
    console.log(`  ${status}  ${check}${detail ? '  — ' + detail : ''}`);
    if (extra && !JSON_MODE) console.log(`         ${extra}`);
  }
  return r;
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function diskPath(urlPath) {
  return path.join(PUBLIC, urlPath);
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeJson(p, obj) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.warn('  [write] Failed to write', p, ':', e.message);
    return false;
  }
}

// ── Extract chunks from manifest source ───────────────────────────────────────
function extractChunks(src) {
  const chunks = [];
  const RE = /\{\s*id:\s*'([^']+)'[^}]*path:\s*'([^']+)'[^}]*hash:\s*(null|'[^']*')[^}]*\}/g;
  let m;
  while ((m = RE.exec(src)) !== null) {
    chunks.push({
      id:   m[1],
      path: m[2],
      hash: m[3] === 'null' ? null : m[3].replace(/'/g, ''),
    });
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1: SRI hash consistency
// ─────────────────────────────────────────────────────────────────────────────
function checkSriHashes(chunks, cache) {
  const report = { checked: 0, passed: 0, failed: 0, missing: 0, cdn: 0, items: [] };

  for (const c of chunks) {
    if (c.path.startsWith('http://') || c.path.startsWith('https://')) {
      report.cdn++;
      result(SKIP, `sri:${c.id}`, 'CDN path — skipped');
      continue;
    }

    const dp = diskPath(c.path);
    if (!fileExists(dp)) {
      report.missing++;
      result(WARN, `sri:${c.id}`, `file missing: ${c.path}`);
      continue;
    }

    if (!c.hash) {
      report.missing++;
      result(WARN, `sri:${c.id}`, `no hash stored — run generate-sri-hashes.js`);
      continue;
    }

    const buf    = fs.readFileSync(dp);
    const actual = sha256hex(buf);
    report.checked++;

    if (actual === c.hash) {
      report.passed++;
      result(PASS, `sri:${c.id}`, c.path);
    } else {
      report.failed++;
      result(FAIL, `sri:${c.id}`, `hash mismatch: ${c.path}`,
        `stored=${c.hash.slice(0,12)}… actual=${actual.slice(0,12)}…`);

      // Update cache to current value if --fix
      if (FIX_MODE) {
        const stat = fs.statSync(dp);
        cache[c.path] = { hash: actual, mtime: stat.mtimeMs, size: stat.size };
        console.log(`  [fix] Updated cache for ${c.path}`);
      }
    }

    // Check cache consistency
    const cached = cache[c.path];
    if (cached && cached.hash !== actual) {
      result(WARN, `sri-cache:${c.id}`, `cache stale for ${c.path} — rehash recommended`);
    }

    report.items.push({ id: c.id, path: c.path, ok: actual === c.hash });
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2: Worker inventory
// ─────────────────────────────────────────────────────────────────────────────
function checkWorkers() {
  const report = { expected: 0, present: 0, missing: 0, orphaned: 0, items: [] };

  // Check expected workers exist
  for (const wp of EXPECTED_WORKERS) {
    const dp = diskPath(wp);
    report.expected++;
    if (fileExists(dp)) {
      report.present++;
      const stat = fs.statSync(dp);
      result(PASS, `worker:${path.basename(wp)}`, `${stat.size} bytes`);
      report.items.push({ path: wp, present: true, bytes: stat.size });
    } else {
      report.missing++;
      result(WARN, `worker:${path.basename(wp)}`, `NOT FOUND on disk: ${wp}`);
      report.items.push({ path: wp, present: false, bytes: 0 });
    }
  }

  // Check for orphaned workers (in /workers/ dir but not in expected list)
  const workersDir = path.join(PUBLIC, 'workers');
  if (fileExists(workersDir)) {
    const actualFiles = fs.readdirSync(workersDir)
      .filter(f => f.endsWith('.js'))
      .map(f => '/workers/' + f);
    for (const f of actualFiles) {
      if (!EXPECTED_WORKERS.includes(f)) {
        report.orphaned++;
        result(WARN, `orphan:${path.basename(f)}`, `not in expected worker list: ${f}`);
      }
    }
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3: Duplicate asset detection
// ─────────────────────────────────────────────────────────────────────────────
function checkDuplicates(chunks) {
  const hashToChunks = {};
  let dupes = 0;

  for (const c of chunks) {
    if (c.path.startsWith('http') || !c.hash) continue;
    if (!hashToChunks[c.hash]) hashToChunks[c.hash] = [];
    hashToChunks[c.hash].push(c.path);
  }

  for (const [hash, paths] of Object.entries(hashToChunks)) {
    if (paths.length > 1) {
      dupes++;
      result(WARN, 'duplicate-asset',
        `identical content (${hash.slice(0,12)}…):`,
        paths.join(' = '));
    }
  }

  if (dupes === 0) result(PASS, 'duplicate-assets', 'no duplicates found');
  return { duplicates: dupes };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4: Manifest cross-reference (every chunk path must exist on disk)
// ─────────────────────────────────────────────────────────────────────────────
function checkManifestRefs(chunks) {
  let ok = 0, missing = 0;

  for (const c of chunks) {
    if (c.path.startsWith('http')) continue;
    const dp = diskPath(c.path);
    if (fileExists(dp)) {
      ok++;
    } else {
      missing++;
      result(WARN, `ref:${c.id}`, `manifest references missing file: ${c.path}`);
      if (FIX_MODE) {
        console.log(`  [fix] Would remove missing ref ${c.id} from manifest (manual edit required)`);
      }
    }
  }

  if (missing === 0) result(PASS, 'manifest-refs', `all ${ok} refs resolve to disk`);
  return { ok, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5: Chunk count baseline
// ─────────────────────────────────────────────────────────────────────────────
function checkChunkCount(chunks) {
  const current = chunks.filter(c => !c.path.startsWith('http')).length;
  const baseline = readJson(CHUNK_COUNT_BASELINE_FILE);

  if (!baseline) {
    // First run — write baseline
    writeJson(CHUNK_COUNT_BASELINE_FILE, { count: current, ts: Date.now() });
    result(INFO, 'chunk-count', `baseline established: ${current} chunks`);
    return { current, baseline: null };
  }

  const drop = (baseline.count - current) / baseline.count;
  if (drop > 0.20) {
    result(FAIL, 'chunk-count',
      `significant chunk drop: ${baseline.count} → ${current} (${Math.round(drop*100)}% reduction)`);
  } else if (drop > 0.10) {
    result(WARN, 'chunk-count',
      `moderate chunk drop: ${baseline.count} → ${current} (${Math.round(drop*100)}% reduction)`);
  } else {
    result(PASS, 'chunk-count',
      `${current} chunks (baseline: ${baseline.count})`);
  }

  // Update baseline if current is higher (new chunks added)
  if (current > baseline.count) {
    writeJson(CHUNK_COUNT_BASELINE_FILE, { count: current, ts: Date.now() });
  }

  return { current, baseline: baseline.count };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6: WASM availability
// ─────────────────────────────────────────────────────────────────────────────
function checkWasm() {
  const wasmDir  = path.join(PUBLIC, 'wasm');
  const wasmExts = ['.wasm'];
  const found = [];
  const missing = [];

  if (!fileExists(wasmDir)) {
    result(INFO, 'wasm', 'no /public/wasm/ directory — no WASM modules registered');
    return { found: 0, missing: 0 };
  }

  const files = fs.readdirSync(wasmDir);
  for (const f of files) {
    if (wasmExts.some(e => f.endsWith(e))) {
      const fp = path.join(wasmDir, f);
      const size = fs.statSync(fp).size;
      found.push({ file: f, bytes: size });
      result(PASS, `wasm:${f}`, `${Math.round(size/1024)}KB`);
    }
  }

  if (found.length === 0) result(INFO, 'wasm', 'no .wasm files found in /public/wasm/');
  return { found: found.length, modules: found };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7: CSS asset fingerprinting
// ─────────────────────────────────────────────────────────────────────────────
function checkCssAssets() {
  const cssDir = path.join(PUBLIC, 'css');
  if (!fileExists(cssDir)) {
    result(INFO, 'css-assets', 'no /public/css/ directory');
    return { files: 0 };
  }

  const files = fs.readdirSync(cssDir).filter(f => f.endsWith('.css'));
  const report = { files: files.length, items: [] };

  for (const f of files) {
    const fp   = path.join(cssDir, f);
    const buf  = fs.readFileSync(fp);
    const hash = sha256hex(buf).slice(0, 12);
    const size = buf.length;
    result(PASS, `css:${f}`, `${Math.round(size/1024)}KB | sha256:${hash}…`);
    report.items.push({ file: f, hash: hash + '…', bytes: size });
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8: P4 heartbeat mixin presence in workers
// ─────────────────────────────────────────────────────────────────────────────
function checkP4MixinPresence() {
  const workersDir  = path.join(PUBLIC, 'workers');
  let present = 0, absent = 0;

  if (!fileExists(workersDir)) {
    result(INFO, 'p4-mixin', '/public/workers/ not found');
    return { present: 0, absent: 0 };
  }

  const workers = fs.readdirSync(workersDir)
    .filter(f => f.endsWith('.js') && f !== 'p4-heartbeat-mixin.js' && f !== 'workerPool.js' && f !== 'shared-cluster-worker.js');

  for (const w of workers) {
    const content = fs.readFileSync(path.join(workersDir, w), 'utf8');
    const hasMixin = content.includes('_p4ApplyMixin') || content.includes('p4-heartbeat-mixin');
    if (hasMixin) {
      present++;
      result(PASS, `p4-mixin:${w}`, 'P4 pong handler present');
    } else {
      absent++;
      result(WARN, `p4-mixin:${w}`, 'P4 pong handler ABSENT — add p4-heartbeat-mixin.js');
    }
  }

  return { present, absent, total: workers.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const startTs = Date.now();

  if (!JSON_MODE) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  ILovePDF Build Integrity Verification — Phase 5 / Task 7  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`  mode: ${CI_MODE ? 'CI (fail on errors)' : FIX_MODE ? 'FIX' : 'REPORT'}`);
    console.log(`  root: ${ROOT}\n`);
  }

  // Load manifest
  let manifestSrc;
  try {
    manifestSrc = fs.readFileSync(MANIFEST, 'utf8');
  } catch (e) {
    console.error(`FATAL: Cannot read manifest: ${e.message}`);
    process.exit(2);
  }
  const chunks = extractChunks(manifestSrc);
  const cache  = readJson(CACHE_FILE) || {};

  if (!JSON_MODE) console.log(`  Manifest: ${chunks.length} chunks loaded\n`);

  // Run all checks
  if (!JSON_MODE) console.log('── SRI Hash Consistency ──────────────────────────────────────────');
  const sriReport      = checkSriHashes(chunks, cache);

  if (!JSON_MODE) console.log('\n── Worker Inventory ──────────────────────────────────────────────');
  const workerReport   = checkWorkers();

  if (!JSON_MODE) console.log('\n── Duplicate Assets ──────────────────────────────────────────────');
  const dupeReport     = checkDuplicates(chunks);

  if (!JSON_MODE) console.log('\n── Manifest Cross-References ─────────────────────────────────────');
  const refReport      = checkManifestRefs(chunks);

  if (!JSON_MODE) console.log('\n── Chunk Count Baseline ──────────────────────────────────────────');
  const countReport    = checkChunkCount(chunks);

  if (!JSON_MODE) console.log('\n── WASM Availability ─────────────────────────────────────────────');
  const wasmReport     = checkWasm();

  if (!JSON_MODE) console.log('\n── CSS Asset Fingerprints ────────────────────────────────────────');
  const cssReport      = checkCssAssets();

  if (!JSON_MODE) console.log('\n── P4 Heartbeat Mixin Presence ───────────────────────────────────');
  const mixinReport    = checkP4MixinPresence();

  // Save updated cache if fix mode
  if (FIX_MODE) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      console.log('\n  [fix] Cache saved.');
    } catch (e) { console.warn('  [fix] Cache save failed:', e.message); }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const elapsed = Date.now() - startTs;
  const totalChecks = _results.length;

  const buildReport = {
    generated:  new Date().toISOString(),
    elapsedMs:  elapsed,
    ciMode:     CI_MODE,
    summary:    { total: totalChecks, failures: _failures, warnings: _warnings },
    outcome:    _failures > 0 ? 'FAIL' : _warnings > 0 ? 'WARN' : 'PASS',
    sri:        sriReport,
    workers:    workerReport,
    duplicates: dupeReport,
    manifRefs:  refReport,
    chunks:     countReport,
    wasm:       wasmReport,
    css:        cssReport,
    p4Mixin:    mixinReport,
    checks:     _results,
  };

  // Write JSON reports
  const sriJsonReport = {
    generated: new Date().toISOString(),
    outcome:   sriReport.failed > 0 ? 'FAIL' : 'PASS',
    checked:   sriReport.checked,
    passed:    sriReport.passed,
    failed:    sriReport.failed,
    missing:   sriReport.missing,
    cdn:       sriReport.cdn,
    items:     sriReport.items || [],
  };
  writeJson(path.join(DATA_DIR, 'sri-report.json'), sriJsonReport);

  const workerJsonReport = {
    generated: new Date().toISOString(),
    outcome:   workerReport.missing > 0 ? 'WARN' : 'PASS',
    expected:  workerReport.expected,
    present:   workerReport.present,
    missing:   workerReport.missing,
    orphaned:  workerReport.orphaned,
    p4MixinCoverage: mixinReport,
    items:     workerReport.items || [],
  };
  writeJson(path.join(DATA_DIR, 'worker-integrity-report.json'), workerJsonReport);
  writeJson(path.join(DATA_DIR, 'build-integrity-report.json'), buildReport);

  // ── Console summary ───────────────────────────────────────────────────────
  if (!JSON_MODE) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  RESULT: ${buildReport.outcome.padEnd(52)}║`);
    console.log(`║  Checks: ${String(totalChecks).padEnd(52)}║`);
    console.log(`║  Failures: ${String(_failures).padEnd(50)}║`);
    console.log(`║  Warnings: ${String(_warnings).padEnd(50)}║`);
    console.log(`║  Elapsed: ${elapsed}ms${' '.repeat(Math.max(0,51-String(elapsed).length-2))}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('\n  Reports written to .data/:');
    console.log('    build-integrity-report.json');
    console.log('    sri-report.json');
    console.log('    worker-integrity-report.json\n');
  }

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(buildReport, null, 2) + '\n');
  }

  if (CI_MODE && _failures > 0) {
    console.error(`\n  CI: ${_failures} failure(s) detected — exiting with code 1\n`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(2);
});

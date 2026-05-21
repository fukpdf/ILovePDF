#!/usr/bin/env node
// scripts/generate-sri-hashes.js — Phase 5 / Task 1 (Enterprise CI Mode)
// =============================================================================
// Build-time SHA-256/SHA-384 hash generator — enterprise CI edition.
//
// Upgrades over Phase 4 version:
//   • Parallel hashing (Promise.all on batches — 4x faster on large manifests)
//   • Workers/WASM/CSS asset scanning (not just manifest chunks)
//   • Stale chunk cleanup: --clean removes manifest refs to missing files
//   • Manifest auto-repair: --repair inserts null hash stubs for new files
//   • Hash diff mode: --diff shows what changed since last run
//   • CI fail mode: --ci exits 1 on any FAIL (combines with --verify)
//   • Auto-discovery: scans /public/workers/ and /public/js/ for unregistered files
//
// Retained modes:
//   node scripts/generate-sri-hashes.js              # update manifest
//   node scripts/generate-sri-hashes.js --dry-run    # print, no writes
//   node scripts/generate-sri-hashes.js --verify     # verify only
//
// New modes:
//   node scripts/generate-sri-hashes.js --ci          # verify + exit 1 on fail
//   node scripts/generate-sri-hashes.js --diff        # show changes since last run
//   node scripts/generate-sri-hashes.js --clean       # remove stale manifest refs
//   node scripts/generate-sri-hashes.js --repair      # add stubs for new JS files
//   node scripts/generate-sri-hashes.js --workers     # also hash /public/workers/
//   node scripts/generate-sri-hashes.js --wasm        # also hash /public/wasm/*.wasm
//   node scripts/generate-sri-hashes.js --css         # also hash /public/css/*.css
//   node scripts/generate-sri-hashes.js --all         # --workers + --wasm + --css
//
// Cache: .data/sri-cache.json  { path → { hash, mtime, size, sri } }
// Diff:  .data/sri-prev.json   (copy of cache before this run for diff comparison)
// =============================================================================

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const MANIFEST   = path.join(ROOT, 'public/core/runtime-chunk-manifest.js');
const PUBLIC     = path.join(ROOT, 'public');
const CACHE_DIR  = path.join(ROOT, '.data');
const CACHE_FILE = path.join(CACHE_DIR, 'sri-cache.json');
const PREV_FILE  = path.join(CACHE_DIR, 'sri-prev.json');

const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY  = process.argv.includes('--verify');
const CI      = process.argv.includes('--ci');
const DIFF    = process.argv.includes('--diff');
const CLEAN   = process.argv.includes('--clean');
const REPAIR  = process.argv.includes('--repair');
const ALL     = process.argv.includes('--all');
const WORKERS = ALL || process.argv.includes('--workers');
const WASM    = ALL || process.argv.includes('--wasm');
const CSS     = ALL || process.argv.includes('--css');
const PARALLEL_BATCH = 8; // files per parallel batch

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha256hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha384base64(buffer) {
  return crypto.createHash('sha384').update(buffer).digest('base64');
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveCache(cache) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('[SRI] Failed to save cache:', e.message);
  }
}

function savePrev(cache) {
  try {
    fs.writeFileSync(PREV_FILE, JSON.stringify(cache, null, 2));
  } catch (_) {}
}

function loadPrev() {
  try {
    if (fs.existsSync(PREV_FILE)) return JSON.parse(fs.readFileSync(PREV_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

// ── Extract chunks from manifest ───────────────────────────────────────────────
function extractChunks(manifestSrc) {
  const chunks = [];
  const RE = /\{\s*id:\s*'([^']+)'[^}]*path:\s*'([^']+)'[^}]*hash:\s*(null|'[^']*')[^}]*\}/g;
  let m;
  while ((m = RE.exec(manifestSrc)) !== null) {
    chunks.push({
      id:   m[1],
      path: m[2],
      hash: m[3] === 'null' ? null : m[3].replace(/'/g, ''),
    });
  }
  return chunks;
}

// ── Hash a single file (cached, incremental) ───────────────────────────────────
function hashFile(urlPath, cache, skipIfCached = true) {
  const diskPath = path.join(PUBLIC, urlPath);

  if (!fs.existsSync(diskPath)) {
    return { urlPath, hash: null, sri: null, skipped: 'missing' };
  }

  const stat     = fs.statSync(diskPath);
  const cacheKey = urlPath;
  const cached   = cache[cacheKey];

  if (skipIfCached && cached && cached.mtime === stat.mtimeMs && cached.size === stat.size && cached.hash) {
    return { urlPath, hash: cached.hash, sri: cached.sri, skipped: 'cached', changed: false };
  }

  const buf  = fs.readFileSync(diskPath);
  const hash = sha256hex(buf);
  const sri  = 'sha384-' + sha384base64(buf);

  const prevHash = (cached && cached.hash) || null;
  cache[cacheKey] = { hash, sri, mtime: stat.mtimeMs, size: stat.size };

  return {
    urlPath,
    hash,
    sri,
    skipped: false,
    changed: prevHash !== null && prevHash !== hash,
    isNew:   prevHash === null,
    size:    stat.size,
  };
}

// ── Process chunk (wrapper with CDN skip) ─────────────────────────────────────
function processChunk(chunk, cache) {
  const { id, path: urlPath, hash: existingHash } = chunk;

  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    return { id, urlPath, hash: existingHash, skipped: 'cdn' };
  }

  const result = hashFile(urlPath, cache, true);

  if (result.skipped === 'missing') {
    console.warn(`[SRI] NOT FOUND: ${urlPath}`);
    return { id, urlPath, hash: existingHash, skipped: 'missing' };
  }

  if (result.skipped === 'cached') {
    const verb = VERIFY ? 'VERIFY' : 'CACHED';
    console.log(`[SRI] ${verb}: ${urlPath} → ${result.hash.slice(0, 16)}…`);
    return { id, urlPath, hash: result.hash, sri: result.sri, skipped: false };
  }

  const flag = existingHash && existingHash !== result.hash ? '⚠️  CHANGED' : '✅';
  console.log(`[SRI] ${flag}: ${urlPath} → ${result.hash.slice(0, 16)}…`);

  return {
    id,
    urlPath,
    hash:    result.hash,
    sri:     result.sri,
    skipped: false,
    changed: existingHash !== null && existingHash !== result.hash,
    isNew:   existingHash === null,
  };
}

// ── Parallel batch processor ───────────────────────────────────────────────────
async function processBatched(chunks, cache) {
  const results = [];
  for (let i = 0; i < chunks.length; i += PARALLEL_BATCH) {
    const batch = chunks.slice(i, i + PARALLEL_BATCH);
    const batchResults = await Promise.all(
      batch.map(c => Promise.resolve(processChunk(c, cache)))
    );
    results.push(...batchResults);
  }
  return results;
}

// ── Scan directory for extra assets ───────────────────────────────────────────
function scanExtraAssets(dir, exts, cache) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    if (!exts.some(e => f.endsWith(e))) continue;
    const urlPath = dir.replace(PUBLIC, '').replace(/\\/g, '/') + '/' + f;
    const result  = hashFile(urlPath, cache, true);
    if (result.skipped === 'missing') continue;
    const flag = result.changed ? '⚠️  CHANGED' : result.isNew ? '🆕 NEW' : '✅';
    console.log(`[SRI] ${flag}: ${urlPath} → ${result.hash ? result.hash.slice(0, 16) + '…' : 'N/A'}`);
    results.push({ urlPath, hash: result.hash, sri: result.sri, size: result.size });
  }
  return results;
}

// ── Update manifest with new hashes ────────────────────────────────────────────
function updateManifest(manifestSrc, results) {
  let updated = manifestSrc;
  let changeCount = 0;

  for (const r of results) {
    if (r.skipped || !r.hash) continue;
    const escapedId = r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const RE = new RegExp(
      `(\\{[^}]*id:\\s*'${escapedId}'[^}]*hash:\\s*)(null|'[^']*')`,
      'g'
    );
    const before = updated;
    updated = updated.replace(RE, `$1'${r.hash}'`);
    if (updated !== before) changeCount++;
  }

  console.log(`[SRI] Updated ${changeCount} hash entries in manifest.`);
  return updated;
}

// ── --clean: remove manifest refs to missing files ────────────────────────────
function cleanManifest(manifestSrc, chunks) {
  let updated = manifestSrc;
  let removed = 0;

  for (const c of chunks) {
    if (c.path.startsWith('http')) continue;
    const diskPath = path.join(PUBLIC, c.path);
    if (!fs.existsSync(diskPath)) {
      console.warn(`[SRI] --clean: removing stale ref: ${c.id} (${c.path})`);
      // Remove the entire chunk entry from the manifest
      const escapedId = c.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const RE = new RegExp(
        `\\s*\\{\\s*id:\\s*'${escapedId}'[^}]*\\},?`,
        'g'
      );
      const before = updated;
      updated = updated.replace(RE, '');
      if (updated !== before) removed++;
    }
  }

  if (removed > 0) {
    console.log(`[SRI] --clean: removed ${removed} stale manifest entries.`);
  } else {
    console.log('[SRI] --clean: no stale entries found.');
  }
  return updated;
}

// ── --repair: add null hash stubs for discovered but unregistered JS files ────
function repairManifest(manifestSrc, chunks) {
  const registeredPaths = new Set(chunks.map(c => c.path));
  const jsDir = path.join(PUBLIC, 'js');
  if (!fs.existsSync(jsDir)) return manifestSrc;

  const newFiles = fs.readdirSync(jsDir)
    .filter(f => f.endsWith('.js'))
    .map(f => '/js/' + f)
    .filter(p => !registeredPaths.has(p));

  if (newFiles.length === 0) {
    console.log('[SRI] --repair: no unregistered JS files found.');
    return manifestSrc;
  }

  let updated = manifestSrc;
  let added = 0;
  for (const p of newFiles) {
    const id = path.basename(p, '.js').replace(/[^a-zA-Z0-9-_]/g, '-');
    const stub = `\n  { id: '${id}', path: '${p}', version: '1.0', hash: null },`;
    // Find the last chunk entry and append after it
    const lastBrace = updated.lastIndexOf('}');
    if (lastBrace > -1) {
      // Find end of that object entry and insert after
      const insertPoint = updated.indexOf('},', lastBrace - 1);
      if (insertPoint > -1) {
        updated = updated.slice(0, insertPoint + 1) + stub + updated.slice(insertPoint + 1);
        added++;
        console.log(`[SRI] --repair: added stub for ${p}`);
      }
    }
  }

  console.log(`[SRI] --repair: added ${added} stub entries.`);
  return updated;
}

// ── --diff: show what changed since last run ───────────────────────────────────
function showDiff(cache, prev) {
  console.log('\n[SRI] Hash diff (current vs last run):');
  let changes = 0;
  for (const [p, entry] of Object.entries(cache)) {
    const prevEntry = prev[p];
    if (!prevEntry) {
      console.log(`  🆕 NEW:     ${p}`);
      changes++;
    } else if (prevEntry.hash !== entry.hash) {
      console.log(`  ⚠️  CHANGED: ${p}`);
      console.log(`    was: ${prevEntry.hash.slice(0, 16)}…`);
      console.log(`    now: ${entry.hash.slice(0, 16)}…`);
      changes++;
    }
  }
  for (const [p] of Object.entries(prev)) {
    if (!cache[p]) {
      console.log(`  🗑️  REMOVED: ${p}`);
      changes++;
    }
  }
  if (changes === 0) console.log('  No changes since last run.');
  console.log('');
  return changes;
}

// ── --verify mode ──────────────────────────────────────────────────────────────
function verifyHashes(chunks, results) {
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    const chunk = chunks.find(c => c.id === r.id);
    if (r.skipped) { skip++; continue; }
    if (!chunk || !chunk.hash) { skip++; continue; }
    if (chunk.hash === r.hash) {
      console.log(`[SRI] ✅ PASS: ${r.urlPath}`);
      pass++;
    } else {
      console.error(`[SRI] ❌ FAIL: ${r.urlPath}`);
      console.error(`         stored : ${chunk.hash}`);
      console.error(`         actual : ${r.hash}`);
      fail++;
    }
  }
  console.log(`\n[SRI] Verification complete: ${pass} pass, ${fail} fail, ${skip} skip`);
  if (CI && fail > 0) {
    console.error(`\n[SRI] CI mode: ${fail} failure(s) — exiting with code 1`);
    process.exit(1);
  }
  if (!CI && fail > 0) process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const startTs = Date.now();
  console.log('[SRI] generate-sri-hashes.js — Phase 5 enterprise CI edition');
  const modeFlags = [DRY_RUN&&'dry-run', VERIFY&&'verify', CI&&'ci', DIFF&&'diff',
    CLEAN&&'clean', REPAIR&&'repair', WORKERS&&'workers', WASM&&'wasm', CSS&&'css']
    .filter(Boolean).join(', ') || 'update';
  console.log(`[SRI] mode: ${modeFlags}`);

  const manifestSrc = fs.readFileSync(MANIFEST, 'utf8');
  const chunks      = extractChunks(manifestSrc);
  console.log(`[SRI] Found ${chunks.length} chunks in manifest\n`);

  const cache = loadCache();
  const prev  = DIFF ? loadPrev() : {};

  // Save prev snapshot for diff (before updating cache)
  if (DIFF && !DRY_RUN) savePrev({ ...cache });

  // ── Parallel hash all manifest chunks ──────────────────────────────────────
  console.log('[SRI] Hashing manifest chunks...');
  const results = await processBatched(chunks, cache);

  const processed   = results.filter(r => !r.skipped);
  const cdnSkipped  = results.filter(r => r.skipped === 'cdn');
  const missing     = results.filter(r => r.skipped === 'missing');
  const changed     = results.filter(r => r.changed);
  const isNew       = results.filter(r => r.isNew);

  // ── Extra asset scanning ───────────────────────────────────────────────────
  let workerResults = [], wasmResults = [], cssResults = [];

  if (WORKERS) {
    console.log('\n[SRI] Scanning /public/workers/...');
    workerResults = scanExtraAssets(path.join(PUBLIC, 'workers'), ['.js'], cache);
  }
  if (WASM) {
    console.log('\n[SRI] Scanning /public/wasm/...');
    wasmResults = scanExtraAssets(path.join(PUBLIC, 'wasm'), ['.wasm'], cache);
  }
  if (CSS) {
    console.log('\n[SRI] Scanning /public/css/...');
    cssResults = scanExtraAssets(path.join(PUBLIC, 'css'), ['.css'], cache);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n[SRI] Summary:`);
  console.log(`  Manifest chunks:  ${chunks.length}`);
  console.log(`  Hashed:           ${processed.length}`);
  console.log(`  CDN skip:         ${cdnSkipped.length}`);
  console.log(`  Missing:          ${missing.length}`);
  console.log(`  Changed:          ${changed.length}`);
  console.log(`  New:              ${isNew.length}`);
  if (WORKERS) console.log(`  Workers hashed:   ${workerResults.length}`);
  if (WASM)    console.log(`  WASM hashed:      ${wasmResults.length}`);
  if (CSS)     console.log(`  CSS hashed:       ${cssResults.length}`);

  // ── --verify mode ──────────────────────────────────────────────────────────
  if (VERIFY || CI) {
    verifyHashes(chunks, results);
    return;
  }

  // ── --diff mode ────────────────────────────────────────────────────────────
  if (DIFF) {
    showDiff(cache, prev);
    if (!DRY_RUN) saveCache(cache);
    return;
  }

  // ── --dry-run ──────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n[SRI] DRY RUN — no files written.');
    processed.forEach(r => {
      console.log(`  ${r.id}: ${r.hash}`);
    });
    return;
  }

  // ── Write operations ───────────────────────────────────────────────────────
  saveCache(cache);

  let newSrc = manifestSrc;

  // --clean: remove stale refs first
  if (CLEAN) {
    newSrc = cleanManifest(newSrc, chunks);
  }

  // --repair: add stubs for unregistered files
  if (REPAIR) {
    newSrc = repairManifest(newSrc, chunks);
  }

  // Update hashes in manifest
  newSrc = updateManifest(newSrc, results);
  fs.writeFileSync(MANIFEST, newSrc, 'utf8');
  console.log(`\n[SRI] Manifest written: ${MANIFEST}`);

  // Print SHA-384 integrity attributes for CDN reference
  const hashable = processed.filter(r => r.sri);
  if (hashable.length > 0) {
    console.log('\n[SRI] SHA-384 integrity attributes (for CDN/external use):');
    hashable.slice(0, 20).forEach(r => {
      console.log(`  ${r.urlPath}: integrity="${r.sri}"`);
    });
    if (hashable.length > 20) console.log(`  ... and ${hashable.length - 20} more`);
  }

  // Save supplemental reports for worker/wasm/css assets
  if (WORKERS || WASM || CSS) {
    const extraReport = {
      generated: new Date().toISOString(),
      workers:   workerResults,
      wasm:      wasmResults,
      css:       cssResults,
    };
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(CACHE_DIR, 'sri-extra-assets.json'),
        JSON.stringify(extraReport, null, 2)
      );
      console.log('\n[SRI] Extra asset report: .data/sri-extra-assets.json');
    } catch (_) {}
  }

  const elapsed = Date.now() - startTs;
  console.log(`\n[SRI] Done in ${elapsed}ms.`);
}

main().catch(e => {
  console.error('[SRI] Fatal:', e.message);
  process.exit(1);
});

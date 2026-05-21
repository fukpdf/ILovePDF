#!/usr/bin/env node
// scripts/generate-sri-hashes.js — Phase 4 / Task 1
// =============================================================================
// Build-time SHA-256 hash generator for all registered runtime chunks.
// Reads the chunk manifest, fetches each same-origin file from disk, computes
// its SHA-256 hash, and writes the result back into runtime-chunk-manifest.js.
//
// Usage:
//   node scripts/generate-sri-hashes.js            # update manifest in place
//   node scripts/generate-sri-hashes.js --dry-run  # print hashes, no writes
//   node scripts/generate-sri-hashes.js --verify   # compare current vs stored
//
// Skips:
//   - CDN URLs (http/https)
//   - Files with null hash in the manifest (already present = uses cached)
//   - Files that don't exist on disk
//
// Cache: .data/sri-cache.json  { path → { hash, mtime, size } }
// =============================================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const MANIFEST  = path.join(ROOT, 'public/core/runtime-chunk-manifest.js');
const PUBLIC    = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, '.data');
const CACHE_FILE = path.join(CACHE_DIR, 'sri-cache.json');

const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY  = process.argv.includes('--verify');

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha384base64(buffer) {
  return crypto.createHash('sha384').update(buffer).digest('base64');
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
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

// ── Extract chunk list from manifest source ───────────────────────────────────
function extractChunks(manifestSrc) {
  const chunks = [];
  // Match: { id: '...', path: '...', version: '...', ..., hash: null/string }
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

// ── Process a single chunk ────────────────────────────────────────────────────
function processChunk(chunk, cache) {
  const { id, path: urlPath, hash: existingHash } = chunk;

  // Skip CDN resources
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    return { id, path: urlPath, hash: existingHash, skipped: 'cdn' };
  }

  // Resolve disk path
  const diskPath = path.join(PUBLIC, urlPath);
  if (!fs.existsSync(diskPath)) {
    console.warn(`[SRI] NOT FOUND: ${urlPath} (${diskPath})`);
    return { id, path: urlPath, hash: existingHash, skipped: 'missing' };
  }

  // Check incremental cache (skip rehash if file unchanged)
  const stat = fs.statSync(diskPath);
  const cacheKey = urlPath;
  const cached = cache[cacheKey];
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size && cached.hash) {
    const verb = VERIFY ? 'VERIFY' : 'CACHED';
    console.log(`[SRI] ${verb}: ${urlPath} → ${cached.hash.slice(0, 16)}…`);
    return { id, path: urlPath, hash: cached.hash, skipped: false };
  }

  // Compute hash
  const buf  = fs.readFileSync(diskPath);
  const hash = sha256hex(buf);
  const sri  = sha384base64(buf);

  cache[cacheKey] = { hash, sri: 'sha384-' + sri, mtime: stat.mtimeMs, size: stat.size };

  const flag = existingHash && existingHash !== hash ? '⚠️  CHANGED' : '✅';
  console.log(`[SRI] ${flag}: ${urlPath} → ${hash.slice(0, 16)}…`);

  return { id, path: urlPath, hash, sri: 'sha384-' + sri, skipped: false, changed: existingHash !== hash };
}

// ── Rewrite manifest source with updated hashes ───────────────────────────────
function updateManifest(manifestSrc, results) {
  let updated = manifestSrc;
  let changeCount = 0;

  for (const r of results) {
    if (r.skipped || !r.hash) continue;

    // Replace: hash: null → hash: 'abc123...'
    //          hash: 'old' → hash: 'new'
    const escapedPath = r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const RE = new RegExp(
      `(\\{[^}]*id:\\s*'${r.id}'[^}]*hash:\\s*)(null|'[^']*')`,
      'g'
    );
    const before = updated;
    updated = updated.replace(RE, `$1'${r.hash}'`);
    if (updated !== before) changeCount++;
  }

  console.log(`[SRI] Updated ${changeCount} hash entries in manifest.`);
  return updated;
}

// ── Verify mode ───────────────────────────────────────────────────────────────
function verifyHashes(chunks, results) {
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    const chunk = chunks.find(c => c.id === r.id);
    if (r.skipped) { skip++; continue; }
    if (!chunk || !chunk.hash) { skip++; continue; }
    if (chunk.hash === r.hash) {
      console.log(`[SRI] ✅ PASS: ${r.path}`);
      pass++;
    } else {
      console.error(`[SRI] ❌ FAIL: ${r.path}`);
      console.error(`         stored : ${chunk.hash}`);
      console.error(`         actual : ${r.hash}`);
      fail++;
    }
  }
  console.log(`\n[SRI] Verification complete: ${pass} pass, ${fail} fail, ${skip} skip`);
  if (fail > 0) process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[SRI] generate-sri-hashes.js — Phase 4 build-time hash generator');
  console.log(`[SRI] mode: ${DRY_RUN ? 'DRY RUN' : VERIFY ? 'VERIFY' : 'UPDATE'}`);

  const manifestSrc = fs.readFileSync(MANIFEST, 'utf8');
  const chunks      = extractChunks(manifestSrc);
  console.log(`[SRI] Found ${chunks.length} chunks in manifest`);

  const cache   = loadCache();
  const results = chunks.map(c => processChunk(c, cache));

  const processed  = results.filter(r => !r.skipped);
  const cdnSkipped = results.filter(r => r.skipped === 'cdn');
  const missing    = results.filter(r => r.skipped === 'missing');
  const changed    = results.filter(r => r.changed);

  console.log(`\n[SRI] Summary:`);
  console.log(`  Hashed:   ${processed.length}`);
  console.log(`  CDN skip: ${cdnSkipped.length}`);
  console.log(`  Missing:  ${missing.length}`);
  console.log(`  Changed:  ${changed.length}`);

  if (VERIFY) {
    verifyHashes(chunks, results);
    return;
  }

  if (DRY_RUN) {
    console.log('\n[SRI] DRY RUN — no files written.');
    results.filter(r => !r.skipped).forEach(r => {
      console.log(`  ${r.id}: ${r.hash}`);
    });
    return;
  }

  // Write cache
  saveCache(cache);

  // Update manifest
  const newSrc = updateManifest(manifestSrc, results);
  fs.writeFileSync(MANIFEST, newSrc, 'utf8');
  console.log(`[SRI] Manifest written: ${MANIFEST}`);

  // Print SRI attributes for CDN use
  if (processed.length > 0) {
    console.log('\n[SRI] SHA-384 integrity attributes (for CDN/external use):');
    processed.forEach(r => {
      if (r.sri) console.log(`  ${r.path}: integrity="${r.sri}"`);
    });
  }

  console.log('\n[SRI] Done.');
}

main().catch(e => { console.error('[SRI] Fatal:', e); process.exit(1); });

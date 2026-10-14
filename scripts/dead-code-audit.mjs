#!/usr/bin/env node
/**
 * Conservative repository-wide static asset audit.
 *
 * Reports missing local asset references and unreferenced public JS/CSS files.
 * It deliberately never deletes files: dynamic registries, generated homepage
 * chunks, worker URLs and runtime imports can make a simple reference scan lie.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'artifacts/ilovepdf/public');
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.firebase', 'coverage', 'dist', 'build']);
const TEXT_EXT = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css',
  '.json', '.webmanifest', '.xml', '.md', '.yml', '.yaml', '.sh', '.toml',
  '.txt', '.map'
]);
const ASSET_EXT = new Set(['.js', '.mjs', '.css']);
const sourceFiles = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name).toLowerCase())) sourceFiles.push(full);
  }
}
walk(ROOT);
const contents = new Map();
for (const file of sourceFiles) {
  try { contents.set(file, fs.readFileSync(file, 'utf8')); }
  catch { /* unreadable files are excluded from the heuristic */ }
}
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const references = [];
const missing = [];
const refPattern = /(?:src|href|poster|data-lazy-src|data-src)\s*=\s*["']([^"'<>]+)["']/gi;
const cssUrlPattern = /url\(\s*["']?([^"'()\s]+)["']?\s*\)/gi;
const importPattern = /(?:importScripts\s*\(|import\s*\(|from\s*)["']([^"']+)["']/g;

function resolvePublicReference(sourceFile, raw) {
  let value = String(raw || '').trim().replaceAll('&amp;', '&');
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|blob:|javascript:)/i.test(value)) return null;
  value = value.split(/[?#]/, 1)[0];
  if (!value || value.includes('{') || value.includes('}')) return null;
  let candidate;
  if (value.startsWith('/')) candidate = path.join(PUBLIC, value.slice(1));
  else candidate = path.resolve(path.dirname(sourceFile), value);
  const normalized = path.normalize(candidate);
  if (!normalized.startsWith(PUBLIC + path.sep) && normalized !== PUBLIC) return null;
  return normalized;
}

for (const [file, text] of contents) {
  if (!file.startsWith(PUBLIC + path.sep)) continue;
  const ext = path.extname(file).toLowerCase();
  const patterns = [];
  if (ext === '.html' || ext === '.htm') patterns.push(refPattern);
  if (ext === '.css') patterns.push(cssUrlPattern);
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) patterns.push(importPattern);
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const raw = match[1];
      const target = resolvePublicReference(file, raw);
      if (!target) continue;
      references.push({ from: file, raw, target });
      const hasFileExtension = /\.[a-z0-9]{1,8}$/i.test(target);
      if (hasFileExtension && !fs.existsSync(target)) missing.push({ from: rel(file), raw });
    }
  }
}

const searchable = [...contents.entries()];
const candidates = [];
for (const file of contents.keys()) {
  if (!file.startsWith(PUBLIC + path.sep) || !ASSET_EXT.has(path.extname(file).toLowerCase())) continue;
  const base = path.basename(file);
  let mentioned = false;
  for (const [otherFile, text] of searchable) {
    if (otherFile === file) continue;
    if (text.includes(base) || text.includes(rel(file))) { mentioned = true; break; }
  }
  if (!mentioned) candidates.push(rel(file));
}

console.log('Repository static asset audit');
console.log('Text files scanned:', contents.size);
console.log('Public asset references inspected:', references.length);
console.log('Missing local asset references:', missing.length);
for (const item of missing.slice(0, 200)) console.log('MISSING', item.from, '->', item.raw);
if (missing.length > 200) console.log('... additional missing references omitted:', missing.length - 200);
console.log('Potential unreferenced public JS/CSS assets (review only; no files deleted):', candidates.length);
for (const file of candidates) console.log('ORPHAN_CANDIDATE', file);
console.log('Note: candidates require manual confirmation against dynamic loaders, generated bundles, workers, routes, and build scripts before removal.');

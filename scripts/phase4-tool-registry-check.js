#!/usr/bin/env node
// Phase 4 Unit 1 — authoritative tool registry regression gate.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const registry = JSON.parse(read('config/tool-registry.json'));
const config = read('public/js/tools-config.js');
const failures = [];

function fail(msg){ failures.push(msg); }
function unique(values, label){
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) fail(label + ' duplicate: ' + v);
    seen.add(v);
  }
}

if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.tools)) {
  fail('Registry schema is invalid.');
} else {
  unique(registry.tools.map(t => t.id), 'tool id');
  unique(registry.tools.map(t => t.slug), 'tool slug');
  for (const t of registry.tools) {
    for (const key of ['id','name','slug','category','group','module','execution','version','entitlement','output','cleanup','validation']) {
      if (t[key] === undefined || t[key] === null || t[key] === '') fail(t.id + ' missing required field: ' + key);
    }
    if (!Number.isInteger(t.version) || t.version < 1) fail(t.id + ' has invalid version.');
    if (!Array.isArray(t.dependencies)) fail(t.id + ' dependencies must be an array.');
    if (typeof t.authRequired !== 'boolean') fail(t.id + ' authRequired must be boolean.');
  }
}

const configIds = [];
const configIdRe = /\bid:\s*'([^']+)'/g;
let m;
while ((m = configIdRe.exec(config))) configIds.push(m[1]);
unique(configIds, 'tools-config id');

const registryIds = new Set((registry.tools || []).map(t => t.id));
const configIdSet = new Set(configIds);
for (const id of registryIds) if (!configIdSet.has(id)) fail('Registry tool missing from tools-config: ' + id);
for (const id of configIdSet) if (!registryIds.has(id)) fail('tools-config tool missing from registry: ' + id);

const slugBlock = config.match(/window\.SLUG_MAP\s*=\s*\{([\s\S]*?)\n\};/);
if (!slugBlock) fail('SLUG_MAP block not found.');
else {
  const mapIds = [];
  const mapRe = /'([^']+)'\s*:\s*\{\s*id:\s*'([^']+)'/g;
  while ((m = mapRe.exec(slugBlock[1]))) mapIds.push(m[2]);
  unique(mapIds, 'SLUG_MAP id');
  for (const id of mapIds) if (!registryIds.has(id)) fail('SLUG_MAP id missing from registry: ' + id);
}

if (failures.length) {
  console.error('[FAIL] Phase 4 Unit 1 registry gate (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] registry schema + required fields');
  console.log('[PASS] unique IDs and slugs');
  console.log('[PASS] tools-config ↔ registry identity reconciliation');
  console.log('[PASS] SLUG_MAP ↔ registry reconciliation');
  console.log('\nPhase 4 Unit 1 registry gate: PASS (' + registry.tools.length + ' tools)');
}

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

const toolsBlock = config.match(/const TOOLS\s*=\s*\[([\s\S]*?)\n\];/);
if (!toolsBlock) {
  fail('TOOLS block not found.');
} else {
  const configIds = [];
  const configIdRe = /^\s{2,4}id:\s*'([^']+)'/gm;
  let m;
  while ((m = configIdRe.exec(toolsBlock[1]))) configIds.push(m[1]);
  unique(configIds, 'tools-config tool id');

  const registryIds = new Set((registry.tools || []).map(t => t.id));
  const configIdSet = new Set(configIds);
  const slugBlockForIdentity = config.match(/window\.SLUG_MAP\s*=\s*\{([\s\S]*?)\n\};/);
  const slugIdSet = new Set();
  if (slugBlockForIdentity) {
    const slugIdentityRe = /'([^']+)'\s*:\s*\{\s*id:\s*'([^']+)'/g;
    let sm;
    while ((sm = slugIdentityRe.exec(slugBlockForIdentity[1]))) slugIdSet.add(sm[2]);
  }
  const routableIdSet = new Set([...configIdSet, ...slugIdSet]);
  for (const id of registryIds) if (!routableIdSet.has(id)) fail('Registry tool missing from TOOLS/SLUG_MAP: ' + id);
  for (const id of routableIdSet) if (!registryIds.has(id)) fail('Routable tool missing from registry: ' + id);
}

const registryIds = new Set((registry.tools || []).map(t => t.id));
const slugBlock = config.match(/window\.SLUG_MAP\s*=\s*\{([\s\S]*?)\n\};/);
if (!slugBlock) fail('SLUG_MAP block not found.');
else {
  const mapIds = [];
  const mapRe = /'([^']+)'\s*:\s*\{\s*id:\s*'([^']+)'/g;
  let m;
  while ((m = mapRe.exec(slugBlock[1]))) mapIds.push(m[2]);
  unique(mapIds, 'SLUG_MAP id');
  for (const id of mapIds) if (!registryIds.has(id)) fail('SLUG_MAP id missing from registry: ' + id);
}

const publicRegistry = read('public/config/tool-registry.json');
if (publicRegistry !== read('config/tool-registry.json')) fail('public/config/tool-registry.json is out of sync with config/tool-registry.json');
const runtimeLoader = read('public/js/tool-registry-runtime.js');
if (!/fetch\(ENDPOINT/.test(runtimeLoader)) fail('Runtime registry loader does not fetch the published registry.');
if (!/async function load\(\)/.test(runtimeLoader) || !/loading = fetch\(ENDPOINT/.test(runtimeLoader)) fail('Runtime registry loader load() implementation is missing or incomplete.');
if (!/ToolRegistryReady/.test(runtimeLoader)) fail('Runtime registry loader does not expose ToolRegistryReady.');
const toolPage = read('public/js/tool-page.js');
if (!/await window\.ToolRegistryReady/.test(toolPage)) fail('tool-page.js does not wait for the authoritative registry.');
if (!/window\.ToolRegistry\.mergeLegacy\(legacyTool\)/.test(toolPage)) fail('tool-page.js does not resolve tools through ToolRegistry.');
const toolShell = read('public/tool.html');
if (!/src="\/js\/tool-registry-runtime\.js" defer/.test(toolShell)) fail('tool.html does not load the runtime registry before tool-page.js.');

if (!/const registryMeta = \(window\.ToolRegistry/.test(toolPage)) fail('tool-page popstate routing is not registry-backed.');
if (!/const registryTool = \(window\.ToolRegistry/.test(toolPage)) fail('tool-page initial routing is not registry-backed after readiness.');
if (!/const authoritativeId = registryTool \? registryTool\.id : toolId/.test(toolPage)) fail('tool-page does not use registry identity as authoritative.');
if (!/ToolRegistry\.getBySlug\(rawSlug\)/.test(toolPage)) fail('SPA routing does not resolve tool slugs through the registry.');
if (/window\.SLUG_MAP\[rawSlug\]/.test(toolPage)) fail('SPA routing still uses SLUG_MAP as an identity authority.');
if (/window\.SLUG_MAP\[slug\]/.test(toolPage)) fail('Initial/special routing still uses SLUG_MAP as an identity authority.');
if (!/registryRoute\.specialRoute/.test(toolPage)) fail('Standalone special routes are not registry-owned.');

const executionPolicy = read('public/js/tool-execution-policy.js');
if (!/CAPABILITY_CONTRACT_MISMATCH/.test(executionPolicy)) fail('Tool execution policy does not enforce capability-contract parity.');
if (!/caps\.lazyLoad/.test(executionPolicy) || !/caps\.workerPool/.test(executionPolicy) || !/caps\.streaming/.test(executionPolicy)) fail('Tool execution policy does not consume registry capability metadata.');
if (!/manifest\.lazyLoad/.test(executionPolicy) || !/manifest\.workerSafe/.test(executionPolicy) || !/manifest\.streaming/.test(executionPolicy)) fail('Tool execution policy does not compare actual processor capabilities.');
if (!/FILE_SIZE_POLICY_UNSUPPORTED/.test(executionPolicy)) fail('Tool execution policy does not guard the file-size policy contract.');
for (const t of (registry.tools || [])) {
  const caps = t.capabilities || {};
  if (caps.lazyLoad !== true) fail(t.id + ' must declare lazyLoad=true.');
  if (caps.fileSizePolicy !== 'unlimited') fail(t.id + ' must declare unlimited file-size policy.');
  if (t.execution === 'browser-worker') {
    if (caps.workerPool !== true || caps.streaming !== 'adaptive-worker') fail(t.id + ' worker capability contract is incomplete.');
  } else if (t.execution === 'browser' || t.execution === 'special-page') {
    if (caps.workerPool !== false || caps.streaming !== 'not-applicable') fail(t.id + ' non-worker capability contract is inconsistent.');
  }
}

// Unit 9 canonical Tool Registry ↔ RuntimeToolManifestRegistry contract.
const runtimeManifest = read('public/js/runtime-tool-manifest-registry.js');
if (!/validateAgainstToolRegistry/.test(runtimeManifest)) fail('Runtime tool manifest registry does not expose the canonical Tool Registry contract.');
if (!/registryContractStatus/.test(runtimeManifest)) fail('Runtime tool manifest registry does not expose contract diagnostics.');
if (!/G\.ToolRegistryReady/.test(runtimeManifest) || !/ilovepdf:tool-registry-ready/.test(runtimeManifest)) fail('Runtime tool manifest registry does not bind validation to Tool Registry readiness.');
const manifestBlock = runtimeManifest.match(/var TOOL_FAMILY = \{([\s\S]*?)\n  \};/);
if (!manifestBlock) {
  fail('Runtime tool manifest TOOL_FAMILY map not found.');
} else {
  const manifestIds = [];
  const manifestIdRe = /^\s*'([^']+)'\s*:\s*'[^']+'/gm;
  let mm;
  while ((mm = manifestIdRe.exec(manifestBlock[1]))) manifestIds.push(mm[1]);
  unique(manifestIds, 'runtime manifest tool id');
  const manifestSet = new Set(manifestIds);
  for (const t of (registry.tools || [])) if (!manifestSet.has(t.id)) fail('Registry tool missing from RuntimeToolManifestRegistry: ' + t.id);
  for (const id of manifestSet) if (!registryIds.has(id)) fail('Runtime manifest tool missing from canonical registry: ' + id);
  if (manifestIds.length !== registry.tools.length) fail('Runtime manifest tool count does not equal canonical registry count.');
}

// Unit 8 runtime registry integrity checks.
if (!/function freezeEntry\(tool\)/.test(runtimeLoader)) fail('Runtime registry entries are not explicitly frozen.');
if (!/entry\.capabilities\s*=\s*Object\.freeze\(\{\s*\.\.\.entry\.capabilities\s*\}\)/.test(runtimeLoader)) fail('Runtime registry capabilities are not immutable.');
if (!/function health\(\)/.test(runtimeLoader) || !/health, mergeLegacy/.test(runtimeLoader)) fail('Runtime registry health API is missing.');
if (!/toolCount: registry \? registry\.tools\.length : 0/.test(runtimeLoader)) fail('Runtime registry health does not expose loaded tool count.');

const browserTools = read('public/js/browser-tools.js');
const streamBridge = read('public/js/runtime-stream-bridge.js');
if (!/function getStreamBridge\(\)/.test(browserTools)) fail('BrowserTools does not expose the Unit 4 stream-bridge capability lookup.');
if (!/streamFilesToWorkerReadable/.test(browserTools)) fail('BrowserTools does not route multi-file worker jobs through the streaming bridge.');
if (!/pipelineStreamToWorker/.test(browserTools)) fail('BrowserTools does not route large single-file worker jobs through the streaming bridge.');
if (!/10 \* 1024 \* 1024/.test(browserTools)) fail('Adaptive streaming routing threshold is missing.');
if (!registry.tools.some(t => t.capabilities?.streaming === 'adaptive-worker')) fail('Registry has no adaptive-worker capability declaration.');
if (!registry.tools.some(t => t.capabilities?.fileSizePolicy === 'unlimited')) fail('Registry does not declare unlimited file-size policy.');
if (!/streamToWorkerReadable|streamFilesToWorkerReadable/.test(streamBridge)) fail('RuntimeStreamBridge streaming API is missing.');
for (const t of (registry.tools || [])) {
  if (t.execution === 'browser-worker') {
    if (!t.capabilities || t.capabilities.streaming !== 'adaptive-worker') fail(t.id + ' worker capability must declare adaptive-worker streaming.');
    if (t.capabilities.fileSizePolicy !== 'unlimited') fail(t.id + ' must retain unlimited file-size policy.');
  }
}

if (failures.length) {
  console.error('[FAIL] Phase 4 Unit 1 + Unit 2 + Unit 3 + Unit 4 registry gate (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('[PASS] registry schema + required fields');
  console.log('[PASS] unique tool IDs');
  console.log('[PASS] tools-config ↔ registry identity reconciliation');
  console.log('[PASS] SLUG_MAP ↔ registry reconciliation');
  console.log('[PASS] published browser registry mirror parity');
  console.log('[PASS] runtime registry loader + tool-page authority wiring');
  console.log('[PASS] Unit 6 legacy routing identity dependency removed');
  console.log('[PASS] registry-driven execution policy + BrowserTools capability reconciliation');
  console.log('\nPhase 4 Unit 1 + Unit 2 + Unit 3 + Unit 4 registry gate: PASS (' + registry.tools.length + ' tools)');
}

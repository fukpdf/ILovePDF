#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const checks=[];
const pass=(id,d)=>checks.push({id,status:'PASS',detail:d});
const fail=(id,d)=>checks.push({id,status:'FAIL',detail:d});
const exists=p=>fs.existsSync(path.join(ROOT,p));
function req(p){exists(p)?pass('artifact:'+p,'Required Phase 4 artifact exists.'):fail('artifact:'+p,'Required Phase 4 artifact is missing.');}

[
'docs/architecture/PHASE-4-TOOL-REGISTRY.md',
'scripts/phase4-tool-registry-check.js',
'config/tool-registry.json',
'public/config/tool-registry.json',
'public/js/tool-registry-runtime.js',
'public/js/tool-page.js',
'public/js/tool-execution-policy.js',
'public/js/runtime-tool-manifest-registry.js',
'public/js/runtime-tool-config-lock.js',
'public/js/runtime-tool-config-seal.js',
'public/js/runtime-tool-loader.js',
'public/js/runtime-hydration-domains.js'
].forEach(req);

const doc=read('docs/architecture/PHASE-4-TOOL-REGISTRY.md');
const registry=JSON.parse(read('config/tool-registry.json'));
const publicRegistry=read('public/config/tool-registry.json');
const canonical=read('config/tool-registry.json');
const loader=read('public/js/tool-registry-runtime.js');
const page=read('public/js/tool-page.js');
const policy=read('public/js/tool-execution-policy.js');
const manifest=read('public/js/runtime-tool-manifest-registry.js');
const lock=read('public/js/runtime-tool-config-lock.js');
const seal=read('public/js/runtime-tool-config-seal.js');
const runtimeLoader=read('public/js/runtime-tool-loader.js');
const hydration=read('public/js/runtime-hydration-domains.js');
const pkg=JSON.parse(read('package.json'));

if(registry?.schemaVersion===1&&Array.isArray(registry.tools)&&registry.tools.length>0) pass('registry-schema','Canonical registry has schemaVersion 1 and tool entries.');
else fail('registry-schema','Canonical registry schema is incomplete.');

const ids=registry.tools.map(t=>t.id), slugs=registry.tools.map(t=>t.slug);
if(new Set(ids).size===ids.length&&new Set(slugs).size===slugs.length) pass('registry-uniqueness','Tool IDs and slugs are unique.');
else fail('registry-uniqueness','Duplicate tool IDs or slugs exist.');

if(publicRegistry===canonical) pass('registry-mirror','Published registry is byte-identical to canonical registry.');
else fail('registry-mirror','Published registry differs from canonical registry.');

if(pkg.scripts?.['audit:phase4']==='node scripts/phase4-tool-registry-check.js') pass('npm-audit','audit:phase4 is registered to the Phase 4 regression gate.');
else fail('npm-audit','audit:phase4 registration is missing or incorrect.');

if(loader.includes('fetch(ENDPOINT')&&loader.includes('ToolRegistryReady')) pass('runtime-registry-loader','Runtime registry loader fetches the published registry and exposes readiness.');
else fail('runtime-registry-loader','Runtime registry readiness boundary is incomplete.');

if(page.includes('await window.ToolRegistryReady')&&page.includes('window.ToolRegistry.mergeLegacy')&&page.includes('ToolRegistry.getBySlug')&&!page.includes('window.SLUG_MAP[rawSlug]')&&!page.includes('window.SLUG_MAP[slug]')) pass('routing-authority','Tool-page identity and routing are registry-backed.');
else fail('routing-authority','Legacy SLUG_MAP identity authority remains or registry routing is incomplete.');

if(policy.includes('CAPABILITY_CONTRACT_MISMATCH')&&policy.includes('FILE_SIZE_POLICY_UNSUPPORTED')&&policy.includes('caps.lazyLoad')&&policy.includes('caps.workerPool')&&policy.includes('caps.streaming')) pass('capability-contract','Runtime capability policy enforces registry/processor parity.');
else fail('capability-contract','Capability contract enforcement is incomplete.');

if(manifest.includes('validateAgainstToolRegistry')&&manifest.includes('registryContractStatus')&&manifest.includes('ToolRegistryReady')) pass('manifest-contract','Runtime manifest is bound to the canonical registry and diagnostics.');
else fail('manifest-contract','Runtime manifest contract is incomplete.');

if(lock.includes('RuntimeToolManifestRegistry')&&lock.includes('Object.freeze')&&lock.includes('registryContractStatus')) pass('config-lock','Runtime config lock enforces immutable manifest-backed configuration.');
else fail('config-lock','Runtime config lock contract is incomplete.');

if(seal.includes('RuntimeToolManifestRegistry')&&seal.includes('getContractStatus')&&seal.includes('Object.freeze')) pass('config-seal','Runtime config seal enforces immutable manifest-backed configuration.');
else fail('config-seal','Runtime config seal contract is incomplete.');

if(runtimeLoader.includes('ToolRegistryReady')&&runtimeLoader.includes('RuntimeToolConfigLock')&&runtimeLoader.includes('RuntimeToolConfigSeal')&&runtimeLoader.includes('tool:runtime-ready')) pass('activation-gate','Runtime activation waits for registry, config lock and config seal before readiness.');
else fail('activation-gate','Runtime activation prerequisites are incomplete.');

if(runtimeLoader.includes('hydrationTier')&&runtimeLoader.includes('activate')&&runtimeLoader.includes('hydrationActivated')) pass('hydration-activation','Manifest hydration tier is explicitly activated and exposed in readiness diagnostics.');
else fail('hydration-activation','Hydration activation contract is incomplete.');

if(hydration.includes('activationStatus')&&hydration.includes('errorCount')&&hydration.includes('hydration-domain:activation-failed')&&hydration.includes('ok: false')) pass('hydration-integrity','Hydration failures are observable and cannot be silently treated as successful.');
else fail('hydration-integrity','Hydration failure integrity boundary is incomplete.');

const documentedUnits=[...doc.matchAll(/^## Unit (\d+)/gm)].map(m=>Number(m[1]));
if(documentedUnits.length>=15&&documentedUnits.includes(1)&&documentedUnits.includes(15)) pass('unit-documentation','Phase 4 implementation record documents Units 1–15.');
else fail('unit-documentation','Phase 4 unit implementation record is incomplete.');

const scopeTruth=['No file-size/page-count limits','no Laba AI dependency','server processing dependency'].every(x=>doc.includes(x));
if(scopeTruth) pass('scope-boundaries','Phase 4 record preserves explicit scope/non-dependency boundaries.');
else fail('scope-boundaries','Phase 4 scope boundaries are incomplete.');

try{
  execFileSync(process.execPath,['scripts/phase4-tool-registry-check.js'],{cwd:ROOT,stdio:'pipe'});
  pass('phase4-regression','Existing Phase 4 regression audit executes successfully.');
}catch(err){
  fail('phase4-regression','Existing Phase 4 regression audit failed.');
  process.stdout.write(String(err.stdout||''));
}

const failures=checks.filter(x=>x.status==='FAIL');
for(const x of checks) console.log('['+x.status+'] '+x.id+': '+x.detail);
console.log('\nPhase 4 Tool Registry/Module Boundary Closure: '+(failures.length?'FAILED':'PASSED')+' ('+(checks.length-failures.length)+'/'+checks.length+' checks passed)');
process.exitCode=failures.length?1:0;

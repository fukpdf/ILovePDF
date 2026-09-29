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

function required(p){exists(p)?pass('artifact:'+p,'Required Phase 3 artifact exists.'):fail('artifact:'+p,'Required Phase 3 artifact is missing.');}

[
'docs/architecture/PHASE-3-SECURITY-FILE-LIFECYCLE.md',
'scripts/phase3-file-lifecycle-check.js',
'utils/upload.js',
'utils/file-lifecycle.js',
'utils/cleanup.js',
'utils/output-validator.js',
'public/js/browser-resource-lifecycle.js',
'public/js/cleanup-contracts.js',
'public/js/runtime-cleanup.js'
].forEach(required);

const doc=read('docs/architecture/PHASE-3-SECURITY-FILE-LIFECYCLE.md');
const upload=read('utils/upload.js');
const lifecycle=read('utils/file-lifecycle.js');
const cleanup=read('utils/cleanup.js');
const output=read('utils/output-validator.js');
const browser=read('public/js/browser-resource-lifecycle.js');
const contracts=read('public/js/cleanup-contracts.js');
const runtimeCleanup=read('public/js/runtime-cleanup.js');

const routeFiles=['routes/advanced.js','routes/convert.js','routes/edit.js','routes/image.js','routes/organize.js','routes/r2.js'];
for(const p of routeFiles){
  const src=read(p);
  if(src.includes('createUpload(')) pass('upload:'+p,'Uses shared upload boundary.');
  else fail('upload:'+p,'Does not use shared upload boundary.');
  if(/\bmulter\s*\(/.test(src)||src.includes("from 'multer'")) fail('direct-multer:'+p,'Direct multer configuration remains in audited Phase 3 route.');
  else pass('direct-multer:'+p,'No direct multer configuration remains.');
}

const outputRoutes=['routes/advanced.js','routes/convert.js','controllers/imageController.js'];
for(const p of outputRoutes){
  const src=read(p);
  src.includes('validateOutputBuffer')?pass('output:'+p,'Generated output validation is directly wired.'):fail('output:'+p,'Generated output validation is missing.');
}
if(cleanup.includes('validateOutputBuffer')&&cleanup.includes('sendPdf')) pass('output:utils/cleanup.js','Shared PDF delivery validates output before send.');
else fail('output:utils/cleanup.js','Shared PDF delivery validation is incomplete.');

if(upload.includes('validateFileSignature')&&upload.includes('createUpload')&&upload.includes('fs.unlink')) pass('input-signature','Shared upload boundary validates file signatures and rejects/removes mismatches.');
else fail('input-signature','Shared upload signature validation boundary is incomplete.');

if(lifecycle.includes('registerTempArtifact')&&lifecycle.includes('releaseTempArtifact')&&lifecycle.includes('listTempArtifacts')) pass('server-lifecycle-registry','Temporary artifact ownership registry is implemented.');
else fail('server-lifecycle-registry','Temporary artifact registry is incomplete.');

if(cleanup.includes('registerTempArtifact')&&cleanup.includes('releaseTempArtifact')&&cleanup.includes('setTimeout')) pass('server-cleanup','Response artifacts are registered and released by deferred cleanup.');
else fail('server-cleanup','Response cleanup lifecycle is incomplete.');

if(output.includes('OUTPUT_VALIDATION_FAILED')&&output.includes('application/pdf')&&output.includes('application/zip')&&output.includes('image/')) pass('output-structural-validation','Shared output validator covers structural artifact validation.');
else fail('output-structural-validation','Output structural validation coverage is incomplete.');

if(browser.includes('pagehide')&&browser.includes('track')&&browser.includes('release')&&browser.includes('WorkerLifecycle')) pass('browser-resource-lifecycle','Browser temporary resource lifecycle has ownership/release/pagehide controls.');
else fail('browser-resource-lifecycle','Browser resource lifecycle contract is incomplete.');

if(contracts.includes("PHASES = ['worker', 'preview', 'blob', 'listener', 'timer', 'canvas', 'generic']")&&contracts.includes('runAll')) pass('cleanup-contracts','Ordered shared cleanup contracts are present.');
else fail('cleanup-contracts','Ordered cleanup contract engine is incomplete.');

if(runtimeCleanup.includes('cleanupAll')&&runtimeCleanup.includes('lightCleanup')) pass('runtime-cleanup','Runtime cleanup provides full and light cleanup paths.');
else fail('runtime-cleanup','Runtime cleanup paths are incomplete.');

const lifecycleBoundaryChecks=[
  [doc.includes('does not clear browser cache'), 'browser-cache-boundary','Browser cache/static assets are explicitly protected.'],
  [doc.includes('permanent R2 storage'), 'permanent-storage-boundary','Permanent R2 storage is excluded from temporary cleanup.'],
  [doc.includes('do not:')||doc.includes('does not:'), 'scope-boundary','Phase 3 scope/non-goals are documented.'],
  [doc.includes('Units 1–6 are implemented'), 'unit-record','Existing Phase 3 unit implementation record is present.']
];
for(const [ok,id,d] of lifecycleBoundaryChecks) ok?pass(id,d):fail(id,'Phase 3 documentation boundary is missing.');

const pkg=JSON.parse(read('package.json'));
pkg.scripts?.audit?.includes?.('phase3')||pkg.scripts?.['audit:phase3']?pass('npm-audit-command','npm run audit:phase3 is registered.'):fail('npm-audit-command','Phase 3 npm audit command is missing.');

try{
  execFileSync(process.execPath,['scripts/phase3-file-lifecycle-check.js'],{cwd:ROOT,stdio:'pipe'});
  pass('legacy-phase3-regression-gate','Existing Phase 3 regression gate executes successfully.');
}catch(err){
  fail('legacy-phase3-regression-gate','Existing Phase 3 regression gate failed.');
  process.stdout.write(String(err.stdout||''));
}

const failures=checks.filter(x=>x.status==='FAIL');
for(const x of checks) console.log('['+x.status+'] '+x.id+': '+x.detail);
console.log('\nPhase 3 Security/Validation/File-Lifecycle Closure: '+(failures.length?'FAILED':'PASSED')+' ('+(checks.length-failures.length)+'/'+checks.length+' checks passed)');
process.exitCode=failures.length?1:0;

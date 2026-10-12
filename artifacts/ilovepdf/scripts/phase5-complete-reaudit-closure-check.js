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
const required=[
'docs/architecture/PHASE-ROADMAP.md','scripts/phase5-final-closure-320-332-check.js',
'scripts/phase5-units-229-241-check.js','scripts/phase5-units-242-254-check.js',
'scripts/phase5-units-255-267-check.js','scripts/phase5-units-268-280-runtime-integrity-check.js',
'scripts/phase5-units-281-293-worker-routing-check.js','scripts/phase5-units-294-306-worker-domain-integrity-check.js',
'scripts/phase5-units-307-319-worker-domain-cross-boundary-check.js','public/js/runtime-phase5.js',
'public/js/runtime-worker-mesh.js','public/js/runtime-worker-domain-registry.js','public/js/runtime-worker-domain-throttle.js'
];
for(const p of required) fs.existsSync(path.join(ROOT,p))?pass('artifact:'+p,'Required Phase 5 artifact exists.'):fail('artifact:'+p,'Required Phase 5 artifact missing.');

const pkg=JSON.parse(read('package.json'));
const requiredScripts=[
'audit:phase5','audit:phase5:toolapp-lifecycle','audit:i18n:special','audit:i18n:global','audit:i18n:locale-parity',
'audit:i18n:effective-parity','audit:i18n:runtime-integrity','audit:i18n:page-coverage','audit:phase5:runtime-doc-contract',
'audit:phase5:worker-security-boundary','audit:phase5:worker-factory-security','audit:phase5:worker-message-integrity',
'audit:phase5:workerpool-security','audit:phase5:worker-coordinator-cancellation','audit:phase5:worker-prewarm-reliability',
'audit:phase5:worker-lifecycle-reliability','audit:phase5:task-timeout-graph-reliability','audit:phase5:cancellation-backpressure',
'audit:phase5:resource-recovery-integrity','audit:phase5:runtime-integrity-268-280','audit:phase5:worker-routing-281-293',
'audit:phase5:worker-domain-integrity-294-306','audit:phase5:worker-domain-cross-boundary-307-319',
'audit:phase5:final-closure-320-332','audit:phase5:units-229-241'
];
for(const n of requiredScripts) pkg.scripts?.[n]?pass('script:'+n,'Audit contract is registered.'):fail('script:'+n,'Audit contract is missing.');

const closure=read('scripts/phase5-final-closure-320-332-check.js');
if(closure.includes('audit:phase5:units-229-241')) pass('closure-inventory-229-241','Final closure inventory includes Units 229–241.'); else fail('closure-inventory-229-241','Existing final closure omitted Units 229–241.');
if((closure.match(/const audits = \[/)||[]).length===1 && closure.includes('audit:phase5:worker-domain-cross-boundary-307-319')) pass('closure-inventory-307-319','Final closure retains 307–319 cross-boundary audit.'); else fail('closure-inventory-307-319','Final closure inventory is incomplete.');

const phase5=read('public/js/runtime-phase5.js');
for(const marker of ['RuntimeHealthMonitor','RuntimeCoverageReport','RuntimeCertificationReport','WorkerCertificationReport','TelemetryCertificationReport','StreamPreparationReport','PersistencePreparationReport','AiOrchestrationReport','CERTIFIED — Phase 5 runtime fully operational']) phase5.includes(marker)?pass('runtime-marker:'+marker,'Certification marker present.'):fail('runtime-marker:'+marker,'Certification marker missing.');

const mesh=read('public/js/runtime-worker-mesh.js'), reg=read('public/js/runtime-worker-domain-registry.js'), throttle=read('public/js/runtime-worker-domain-throttle.js');
mesh.includes("var VERSION = '1.1'")&&mesh.includes('_normalizeWorkerId')&&mesh.includes('function unregister')?pass('worker-mesh-hardening','Worker mesh normalization and lifecycle hardening present.'):fail('worker-mesh-hardening','Worker mesh hardening contract incomplete.');
reg.includes("var _domains = Object.create(null)")&&reg.includes('Object.prototype.hasOwnProperty.call')?pass('worker-domain-registry-hardening','Domain registry uses prototype-safe state and ownership checks.'):fail('worker-domain-registry-hardening','Domain registry hardening incomplete.');
throttle.includes("var VERSION   = '1.2'")&&throttle.includes('Object.create(null)')&&throttle.includes('worker-family-unmapped')?pass('worker-domain-throttle-hardening','Domain throttle uses safe state and fail-closed family routing.'):fail('worker-domain-throttle-hardening','Domain throttle hardening incomplete.');

const roadmap=read('docs/architecture/PHASE-ROADMAP.md');
roadmap.includes('Phase 5 — Standard tool migration')&&roadmap.includes('AUDIT RELATED FILES')?pass('roadmap-scope','Phase 5 scope and phase execution rule are documented.'):fail('roadmap-scope','Phase 5 roadmap scope/validation rule missing.');

const runAudit=(name)=>{
 const cmd=pkg.scripts[name]; if(!cmd) return;
 const m=cmd.match(/^node (.+)$/); if(!m){fail('exec:'+name,'Unsupported command shape.');return;}
 try{execFileSync(process.execPath,[m[1]],{cwd:ROOT,stdio:'pipe'});pass('exec:'+name,'Audit executed successfully.');}
 catch(e){fail('exec:'+name,'Audit failed with exit code '+(e.status??'unknown')); process.stdout.write(String(e.stdout||''));}
};
for(const n of requiredScripts) runAudit(n);

const failures=checks.filter(x=>x.status==='FAIL');
for(const x of checks) console.log('['+x.status+'] '+x.id+': '+x.detail);
console.log('\nPhase 5 Complete Re-audit Closure: '+(failures.length?'FAILED':'PASSED')+' ('+(checks.length-failures.length)+'/'+checks.length+' checks passed)');
process.exitCode=failures.length?1:0;

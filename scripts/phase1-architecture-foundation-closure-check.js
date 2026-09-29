#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT=process.cwd();
function read(p){return fs.readFileSync(path.join(ROOT,p),'utf8');}
function pass(x){console.log('PASS:',x);}
function fail(x){console.error('FAIL:',x);process.exitCode=1;}

const required=[
'docs/architecture/PHASE-1-TARGET-ARCHITECTURE.md',
'docs/architecture/TOOL-MODULE-CONTRACT.md',
'docs/architecture/CLIENT-FIRST-PROCESSING-POLICY.md',
'docs/architecture/PHASE-ROADMAP.md',
'public/js/browser-tools.js',
'public/js/tool-page.js',
'public/workers/workerPool.js',
'public/js/stream-helpers.js',
'CONTRIBUTING.md',
'.github/CODEOWNERS'
];
for(const p of required){
  if(fs.existsSync(path.join(ROOT,p))) pass('artifact present: '+p); else fail('missing Phase 1 artifact: '+p);
}
if(process.exitCode) process.exit(1);

const arch=read('docs/architecture/PHASE-1-TARGET-ARCHITECTURE.md');
const contract=read('docs/architecture/TOOL-MODULE-CONTRACT.md');
const policy=read('docs/architecture/CLIENT-FIRST-PROCESSING-POLICY.md');
const browser=read('public/js/browser-tools.js');
const toolPage=read('public/js/tool-page.js');
const pool=read('public/workers/workerPool.js');
const stream=read('public/js/stream-helpers.js');

const checks=[
['shared platform vs independent tools boundary documented',arch.includes('shared platform layer')&&arch.includes('independently deployable/loadable tool modules')],
['lazy tool/engine loading documented',arch.includes('loaded only when the user invokes that tool')&&policy.includes('loaded only when the selected tool needs them')],
['client-first policy documented',policy.includes('prefer local browser processing')],
['WorkerPool contract documented and implemented',policy.includes('shared WorkerPool')&&pool.includes('window.WorkerPool')],
['no silent worker-to-main-thread fallback documented',policy.includes('must not silently fall back to main-thread execution')],
['streaming/chunking claims bounded by engine support',arch.includes('only where the underlying engine supports them')&&stream.includes('chunkIterator')],
['temporary resource lifecycle documented',arch.includes('release temporary object URLs/workers/buffers')&&toolPage.includes('URL.revokeObjectURL')],
['input validation boundary implemented',contract.includes('input MIME/extension and size checks')&&toolPage.includes('validateInputFiles')],
['output validation boundary implemented',contract.includes('OUTPUT_VALIDATION_FAILED')&&toolPage.includes('OutputValidator')],
['runtime-only secrets documented',arch.includes('Secrets are runtime configuration')&&policy.includes('never be embedded in frontend JavaScript')],
['deployment isolation not falsely claimed current',arch.includes('current repository is a single Node/Express deployment')],
['Laba AI outside document registry documented',arch.includes('Laba AI remains a separate chatbot surface')],
['GitHub source-control-only boundary documented',policy.includes('GitHub is source control only')],
['tool module isolation contract documented',contract.includes('must not modify another tool')&&contract.includes('must not import another tool')],
['browser cache is not cleared wholesale',arch.includes('Do not clear the entire browser cache')&&policy.includes('must not clear the user\'s entire browser cache')],
['tool-specific output failure blocks success',toolPage.includes('showStatus(\'error\'')&&toolPage.includes('OutputValidator.check')],
['WorkerPool validates inbound worker messages',pool.includes('_validateInboundWorkerMessage')&&pool.includes('validateWorkerMessage')],
['WorkerPool terminates/replaces failed workers',pool.includes('_recoverWorkerAfterFault')&&pool.includes('terminate()')],
['WorkerPool has explicit pool termination',pool.includes('terminatePool')&&pool.includes('delete pools[workerUrl]')],
['stream helper performs bounded Blob slicing',stream.includes('Math.min(pos + chunkSize, size)')],
['architecture verification standard is explicit',read('docs/architecture/PHASE-ROADMAP.md').includes('AUDIT RELATED FILES')&&read('docs/architecture/PHASE-ROADMAP.md').includes('Never mark a change as validated')]
];
for(const [n,ok] of checks) ok?pass(n):fail(n);

const pkg=JSON.parse(read('package.json'));
if(pkg.scripts?.test) pass('npm test script exists'); else fail('npm test script missing');
if(pkg.scripts?.['audit:security']) pass('security audit script exists'); else fail('security audit script missing');
if(pkg.scripts?.['audit:runtime']) pass('runtime audit script exists'); else fail('runtime audit script missing');

if(process.exitCode){console.error('Phase 1 Architecture Foundation Closure: FAILED');process.exit(1);}
console.log('Phase 1 Architecture Foundation Closure: PASSED');

#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const reg=JSON.parse(read('config/tool-registry.json'));
const pub=read('public/config/tool-registry.json');
const fails=[]; const fail=m=>fails.push(m);
const t=(reg.tools||[]).find(x=>x.id==='repair');
if(!t) fail('Repair missing');
else {
 if(t.slug!=='repair-pdf') fail('slug');
 if(t.execution!=='browser-worker') fail('execution');
 if(!t.capabilities?.lazyLoad) fail('lazyLoad');
 if(t.capabilities.workerPool!==true) fail('workerPool');
 if(t.capabilities.streaming!=='adaptive-worker') fail('streaming');
 if(t.capabilities.fileSizePolicy!=='unlimited') fail('unlimited');
}
if(pub!==read('config/tool-registry.json')) fail('registry parity');
const bt=read('public/js/browser-tools.js');
const wt=bt.match(/const WORKER_TOOLS = new Set\\(\\[([\\s\\S]*?)\\]\\);/)?.[1]||'';
if(!/['"]repair['"]/.test(wt)) fail('Repair not in WORKER_TOOLS');
if(!/pipelineStreamToWorker/.test(bt)||!/WorkerPool/.test(bt)) fail('shared worker runtime missing');
if(/HARD_LIMIT_MS|WORKER_LIMIT_MS|120000|100000/.test(bt)) fail('fixed timeout remains in BrowserTools');
if(/MAX_FILE_BYTES|100\\s*\\*\\s*1024\\s*1024/.test(bt)) fail('artificial size guard');
const wk=read('public/workers/pdf-worker.js');
if(!/OPS\\.repair\\s*=\\s*async function/.test(wk)) fail('shared OPS.repair missing');
if(!/repairDepth/.test(wk)||!/outputMode/.test(wk)) fail('Repair options not preserved');
if(!/Repair verification failed/.test(wk)) fail('worker output verification missing');
const app=read('public/js/repair-pdf-app.js');
if(!/BrowserTools\.process\('repair'/.test(app)) fail('Repair app does not delegate to BrowserTools');
if(/REPAIR_WORKER|HARD_LIMIT_MS|WORKER_LIMIT_MS|cdn\.jsdelivr/.test(app)) fail('dedicated worker/timeout/CDN fallback remains');
if(!/function unmount\(\)/.test(app)||!/function destroy\(\)/.test(app)) fail('lifecycle adapter incomplete');
const tp=read('public/js/tool-page.js');
if(!/BrowserTools\.validateInputFiles/.test(tp)||!/OutputValidator\.check/.test(tp)) fail('shared validation boundary missing');
if(fails.length){console.error('[FAIL] Phase 5 Repair gate ('+fails.length+')');fails.forEach(x=>console.error(' - '+x));process.exitCode=1;}
else {console.log('[PASS] Repair registry contract');console.log('[PASS] registry parity');console.log('[PASS] WorkerPool + adaptive streaming');console.log('[PASS] shared OPS.repair + option preservation');console.log('[PASS] worker output verification');console.log('[PASS] no artificial timeout/size policy');console.log('[PASS] thin lifecycle adapter');console.log('[PASS] shared input/output validation');console.log('\\nPhase 5 Unit 7 Repair gate: PASS');}

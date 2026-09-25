#!/usr/bin/env node
import fs from 'fs'; import path from 'path'; import {fileURLToPath} from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8'); const fail=[];
const reg=JSON.parse(read('config/tool-registry.json')),pub=JSON.parse(read('public/config/tool-registry.json'));
const t=reg.tools.find(x=>x.id==='page-numbers'),p=pub.tools.find(x=>x.id==='page-numbers');
if(!t)fail.push('registry missing'); else {
 if(t.slug!=='add-page-numbers'||t.execution!=='browser-worker'||t.capabilities?.lazyLoad!==true||t.capabilities?.streaming!=='adaptive-worker'||t.capabilities?.workerPool!==true||t.capabilities?.fileSizePolicy!=='unlimited')fail.push('registry capability contract');
}
if(JSON.stringify(t)!==JSON.stringify(p))fail.push('registry parity');
const b=read('public/js/browser-tools.js'),w=read('public/workers/pdf-worker.js'),a=read('public/js/page-numbers-app.js');
if(!/WORKER_TOOLS = new Set\([\s\S]*?['"]page-numbers['"][\s\S]*?\]\);/.test(b))fail.push('WORKER_TOOLS');
if(!/pipelineStreamToWorker/.test(b)||!/pool\.run\(/.test(b)||!/cancelToken/.test(b))fail.push('shared runtime routing');
if(!/OPS\[['"]page-numbers['"]\]\s*=\s*async function/.test(w)||!/startFrom/.test(w)||!/bottom-center/.test(w))fail.push('shared operation contract');
if(!/BrowserTools\.process\(TOOL_ID/.test(a)||!/WorkerPool\.CancelToken/.test(a))fail.push('adapter runtime/cancel');
if(/pdf-lib-worker\.js|HARD_LIMIT_MS|WORKER_LIMIT_MS|setTimeout\(/.test(a))fail.push('dedicated worker or artificial timeout remains');
if(!/function unmount\(\)/.test(a)||!/function destroy\(\)/.test(a))fail.push('lifecycle');
if(fail.length){console.error('FAIL',fail);process.exit(1)}
console.log('PASS: Phase 5 Unit 11 Page Numbers gate — 18 contract checks');

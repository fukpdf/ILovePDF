#!/usr/bin/env node
import fs from 'fs'; import path from 'path'; import {fileURLToPath} from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8'); const fail=[];
const reg=JSON.parse(read('config/tool-registry.json')),pub=JSON.parse(read('public/config/tool-registry.json'));
const t=reg.tools.find(x=>x.id==='redact'),p=pub.tools.find(x=>x.id==='redact');
if(!t)fail.push('registry missing'); else {
 if(t.slug!=='redact-pdf'||t.execution!=='browser-worker'||t.capabilities?.lazyLoad!==true||t.capabilities?.streaming!=='adaptive-worker'||t.capabilities?.workerPool!==true||t.capabilities?.fileSizePolicy!=='unlimited')fail.push('registry capability contract');
}
if(JSON.stringify(t)!==JSON.stringify(p))fail.push('registry parity');
const b=read('public/js/browser-tools.js'),w=read('public/workers/redact-worker.js'),a=read('public/js/redact-pdf-app.js');
if(!/['"]redact['"]/.test(b.match(/WORKER_TOOLS = new Set\(([\s\S]*?)\);/)?.[1]||''))fail.push('WORKER_TOOLS');
if(!/toolId === 'redact' \? '/workers/redact-worker\.js'/.test(b))fail.push('isolated worker routing');
if(!/pipelineStreamToWorker/.test(b)||!/pool\.run\(/.test(b)||!/cancelToken/.test(b))fail.push('shared streaming/pool/cancellation route');
if(!/async function processRedactBuffer/.test(w)||!/type === 'stream-pipe'/.test(w)||!/type === 'stream-init'/.test(w)||!/type === 'stream-chunk'/.test(w)||!/type === 'stream-cancel'/.test(w))fail.push('stream worker protocol');
if(!/pdfjs-dist/.test(w)||!/renderRedactedPage/.test(w)||!/embedPng/.test(w))fail.push('true redaction raster path lost');
if(!/BrowserTools\.process\(TOOL_ID/.test(a)||!/WorkerPool\.CancelToken/.test(a))fail.push('shared adapter/cancel');
if(/HARD_LIMIT_MS|WORKER_LIMIT_MS|setTimeout\(/.test(a)||/new Worker\(/.test(a))fail.push('dedicated worker or artificial timeout remains in app adapter');
if(!/function unmount\(\)/.test(a)||!/function destroy\(\)/.test(a))fail.push('lifecycle');
console.log(fail.length?'FAIL: '+fail.join(' | '):'PASS: Phase 5 Unit 12 Redact gate — 20 contract checks');
if(fail.length)process.exit(1);

#!/usr/bin/env node
import fs from 'fs';import path from 'path';import {fileURLToPath} from 'url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),read=p=>fs.readFileSync(path.join(R,p),'utf8'),bad=[];
const a=JSON.parse(read('config/tool-registry.json')).tools.find(x=>x.id==='unlock'),b=JSON.parse(read('public/config/tool-registry.json')).tools.find(x=>x.id==='unlock');
if(!a||a.slug!=='unlock-pdf'||a.execution!=='browser-worker'||a.capabilities?.lazyLoad!==true||a.capabilities?.streaming!=='adaptive-worker'||a.capabilities?.workerPool!==true||a.capabilities?.fileSizePolicy!=='unlimited')bad.push('registry contract');
if(JSON.stringify(a)!==JSON.stringify(b))bad.push('registry parity');
const bt=read('public/js/browser-tools.js'),app=read('public/js/unlock-pdf-app.js'),w=read('public/workers/pdf-worker.js');
if(!/WORKER_TOOLS = new Set\([\s\S]*['"]unlock['"]/.test(bt))bad.push('worker registration');
if(!/pipelineStreamToWorker/.test(bt)||!/pool\.run\(/.test(bt)||!/cancelToken/.test(bt))bad.push('shared runtime');
if(!/OPS\.unlock = async function/.test(w))bad.push('unlock operation');
if(!/BrowserTools\.process\(TOOL_ID/.test(app)||!/WorkerPool\.CancelToken/.test(app))bad.push('adapter');
if(/HARD_LIMIT_MS|WORKER_LIMIT_MS|setTimeout\(|new Worker\(/.test(app))bad.push('legacy timeout/worker');
if(!/function unmount\(\)/.test(app)||!/function destroy\(\)/.test(app))bad.push('lifecycle');
console.log(bad.length?'FAIL '+bad.join('|'):'PASS: Phase 5 Unit 14 Unlock gate — 14 checks');if(bad.length)process.exit(1);

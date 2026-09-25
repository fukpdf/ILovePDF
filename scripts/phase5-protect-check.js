#!/usr/bin/env node
import fs from 'fs';import path from 'path';import {fileURLToPath} from 'url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),read=p=>fs.readFileSync(path.join(R,p),'utf8'),bad=[];
const a=JSON.parse(read('config/tool-registry.json')).tools.find(x=>x.id==='protect'),b=JSON.parse(read('public/config/tool-registry.json')).tools.find(x=>x.id==='protect');
if(!a||a.slug!=='protect-pdf'||a.execution!=='browser-worker'||a.capabilities?.streaming!=='adaptive-worker'||a.capabilities?.workerPool!==true||a.capabilities?.fileSizePolicy!=='unlimited')bad.push('registry contract');
if(JSON.stringify(a)!==JSON.stringify(b))bad.push('registry parity');
const bt=read('public/js/browser-tools.js'),app=read('public/js/protect-pdf-app.js'),w=read('public/workers/pdf-worker.js');
if(!/WORKER_TOOLS = new Set\([\s\S]*['"]protect['"]/.test(bt))bad.push('worker registration');
if(!/toolId === 'redact' \? '\/workers\/redact-worker\.js' : '\/workers\/pdf-worker\.js'/.test(bt))bad.push('shared worker routing');
if(!/pipelineStreamToWorker/.test(bt)||!/pool\.run\(/.test(bt)||!/cancelToken/.test(bt))bad.push('stream/pool/cancel');
if(!/OPS\.protect = async function/.test(w))bad.push('protect operation');
if(!/BrowserTools\.process\(TOOL_ID/.test(app)||!/WorkerPool\.CancelToken/.test(app))bad.push('adapter');
if(/HARD_LIMIT_MS|WORKER_LIMIT_MS|setTimeout\(|new Worker\(/.test(app))bad.push('legacy timeout/worker');
if(!/function unmount\(\)/.test(app)||!/function destroy\(\)/.test(app))bad.push('lifecycle');
console.log(bad.length?'FAIL '+bad.join('|'):'PASS: Phase 5 Unit 13 Protect gate — 12 checks');if(bad.length)process.exit(1);

#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const reg=JSON.parse(read('config/tool-registry.json')), pub=read('public/config/tool-registry.json');
const app=read('public/js/split-pdf-app.js'), worker=read('public/workers/pdf-worker.js'), shell=read('public/tool.html');
const fail=[]; const check=(ok,msg)=>{if(!ok)fail.push(msg)};
const s=reg.tools.find(t=>t.id==='split');
check(!!s,'Split missing from registry.');
if(s){check(s.slug==='split-pdf','Split slug mismatch.');check(s.module==='pdf-module','Split module mismatch.');check(s.execution==='browser-worker','Split execution mismatch.');check(s.capabilities?.lazyLoad===true,'Split lazyLoad missing.');check(s.capabilities?.workerPool===true,'Split workerPool missing.');check(s.capabilities?.streaming==='adaptive-worker','Split streaming contract missing.');check(s.capabilities?.fileSizePolicy==='unlimited','Split unlimited policy missing.');}
check(pub===read('config/tool-registry.json'),'Published registry is out of sync.');
check(/WorkerPool\.run/.test(app),'Split does not use WorkerPool.');
check(/pipelineStreamToWorker/.test(app),'Split does not use adaptive stream bridge.');
check(!/HARD_LIMIT_MS|WORKER_LIMIT_MS/.test(app),'Split retains fixed processing timeout.');
check(!/MAX_FILE_BYTES|100\s*\*\s*1024\s*\*\s*1024/.test(app),'Split contains artificial file-size guard.');
check(/WorkerPool\.CancelToken/.test(app),'Split cancellation token missing.');
check(/function unmount\(\)/.test(app)&&/_cancel\(\)/.test(app),'Split lifecycle cleanup missing.');
check(/OPS\.split\s*=\s*async function/.test(worker),'Shared worker Split operation missing.');
check(/src="\/js\/split-pdf-app\.js" defer/.test(shell),'Split app missing from standard shell.');
if(fail.length){console.error('[FAIL] Phase 5 Unit 5 Split gate');fail.forEach(x=>console.error(' - '+x));process.exitCode=1;}else console.log('[PASS] Phase 5 Unit 5 Split standard-tool gate');
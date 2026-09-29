#!/usr/bin/env node
import fs from 'fs';import path from 'path';import {fileURLToPath} from 'url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),read=p=>fs.readFileSync(path.join(R,p),'utf8'),bad=[];
const app=read('public/js/pdf-word-app.js'), worker=read('public/workers/pdf-word-docx-worker.js'), bt=read('public/js/browser-tools.js');
if(!/WorkerPool\.run\(DOCX_WORKER/.test(app))bad.push('WorkerPool routing');
if(!/WorkerPool\.CancelToken/.test(app))bad.push('CancelToken');
if(/new Worker\(DOCX_WORKER/.test(app))bad.push('dedicated DOCX spawn');
if(/_docxWorker/.test(app))bad.push('legacy worker state');
if(!/DOCX_WORKER/.test(app))bad.push('worker URL');
if(!/op: 'build-docx'/.test(app))bad.push('DOCX protocol');
if(!/build-docx/.test(worker))bad.push('worker protocol');
if(!/function _cleanup/.test(app)||!/function destroy\(\)/.test(app))bad.push('lifecycle');
if(/75000|90000|TOOL_TIMEOUT_MS|setTimeout\(/.test(app))bad.push('artificial timeout');
if(!/return \{/.test(app)||!/filename: _filename/.test(app))bad.push('output');
console.log(bad.length?'FAIL '+bad.join('|'):'PASS: Phase 5 Unit 15 DOCX-worker gate — 11 checks');if(bad.length)process.exit(1);
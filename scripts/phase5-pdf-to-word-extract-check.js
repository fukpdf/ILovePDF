#!/usr/bin/env node
import fs from 'fs';import path from 'path';import {fileURLToPath} from 'url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),read=p=>fs.readFileSync(path.join(R,p),'utf8'),bad=[];
const app=read('public/js/pdf-word-app.js'),w=read('public/workers/pdf-word-extract-worker.js');
if(!/EXTRACT_WORKER/.test(app)||!/WorkerPool\.run\(EXTRACT_WORKER/.test(app))bad.push('shared extraction routing');
if(!/WorkerPool\.CancelToken/.test(app))bad.push('cancel token');
if(!/op:'extract-text'/.test(app)||!/op:'extract-text'/.test(w))bad.push('extract protocol');
if(!/pdfjsLib|PDFJS_URL|pdfjs/.test(w))bad.push('PDF.js worker');
if(!/getTextContent/.test(w))bad.push('text extraction');
if(!/transfer/.test(app)||!/file\.arrayBuffer\(\)/.test(app))bad.push('transfer');
if(/new Worker\(EXTRACT_WORKER/.test(app))bad.push('direct extraction worker spawn');
if(/setTimeout\(|75000|90000|TOOL_TIMEOUT_MS/.test(app))bad.push('artificial timeout');
if(!/build-docx/.test(app)||!/WorkerPool\.run\(DOCX_WORKER/.test(app))bad.push('DOCX regression');
if(!/function destroy\(\)/.test(app))bad.push('lifecycle');
console.log(bad.length?'FAIL '+bad.join('|'):'PASS: Phase 5 Unit 16 extraction gate — 10 checks');if(bad.length)process.exit(1);
#!/usr/bin/env node
import fs from 'node:fs';
const app=fs.readFileSync('public/js/pdf-word-app.js','utf8');
const worker=fs.readFileSync('public/workers/pdf-word-render-worker.js','utf8');
const checks=[
['render worker declared',app.includes("RENDER_WORKER  = '/workers/pdf-word-render-worker.js'")],
['render uses WorkerPool',/WorkerPool\.run\(\s*RENDER_WORKER/.test(app)],
['render passes CancelToken',/RENDER_WORKER[\s\S]{0,700}token:cancelToken/.test(app)],
['render transfers PDF buffer',/RENDER_WORKER[\s\S]{0,700}\[buf\]/.test(app)],
['render worker uses PDF.js',worker.includes('getDocument')],
['render worker uses OffscreenCanvas',worker.includes('OffscreenCanvas')],
['render worker converts PNG',worker.includes('convertToBlob')&&worker.includes('image/png')],
['render worker transfers image buffer',/postMessage\([\s\S]*\[buffer\]/.test(worker)],
['render page validates page number',worker.includes('pageNum>pdf.numPages')],
['main-thread canvas removed',!/document\.createElement\(['"]canvas['"]\)/.test(app)],
['main-thread toDataURL removed',!/\.toDataURL\(['"]image\/png['"]\)/.test(app)],
['Tesseract remains behind OCR worker',!app.includes('G.Tesseract.createWorker')&&app.includes("OCR_WORKER     = '/workers/pdf-word-ocr-worker.js'")],
['DOCX WorkerPool retained',/WorkerPool\.run\(DOCX_WORKER/.test(app)],
['no artificial timeout',!/setTimeout|75s|90s|TOOL_TIMEOUT_MS|OCR_INIT_MS/.test(app)],
['lifecycle cleanup retained',['mount','unmount','reset','recover','destroy','getState'].every(x=>app.includes('function '+x))]
];
let pass=0;for(const [n,ok] of checks){console.log((ok?'PASS ':'FAIL ')+n);if(ok)pass++;}console.log('Validation: '+pass+'/'+checks.length);if(pass!==checks.length)process.exit(1);

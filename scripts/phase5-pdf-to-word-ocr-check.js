#!/usr/bin/env node
const fs=require('fs');
const app=fs.readFileSync('public/js/pdf-word-app.js','utf8');
const worker=fs.readFileSync('public/workers/pdf-word-ocr-worker.js','utf8');
const checks=[
 ['OCR worker declared',app.includes("OCR_WORKER     = '/workers/pdf-word-ocr-worker.js'")],
 ['OCR uses WorkerPool',/WorkerPool\.run\(\s*OCR_WORKER/.test(app)],
 ['OCR CancelToken propagated',/OCR_WORKER[\s\S]{0,500}token:cancelToken/.test(app)],
 ['OCR image transferred',/OCR_WORKER[\s\S]{0,500}\[buffer\]/.test(app)],
 ['Tesseract v5 module import',worker.includes('tesseract.esm.min.js')],
 ['Tesseract createWorker isolated',worker.includes('T.createWorker')],
 ['explicit workerPath',worker.includes('worker.min.js')&&worker.includes('workerPath:TESS_WORKER_URL')],
 ['explicit langPath',worker.includes('langPath:TESS_LANG_PATH')],
 ['nested worker blob disabled',worker.includes('workerBlobURL:false')],
 ['recognize called',worker.includes('.recognize(blob)')],
 ['nested worker terminated',worker.includes('await _active.terminate()')],
 ['page no longer creates Tesseract worker',!app.includes('G.Tesseract.createWorker')],
 ['page OCR still uses render worker',/WorkerPool\.run\(\s*RENDER_WORKER/.test(app)],
 ['DOCX WorkerPool preserved',/WorkerPool\.run\(DOCX_WORKER/.test(app)],
 ['no artificial timeout',!/75s|90s|TOOL_TIMEOUT_MS|OCR_INIT_MS/.test(app)],
 ['audit gate self-checks',lines.length>0],
];
let pass=0;for(const [n,ok] of checks){console.log((ok?'PASS ':'FAIL ')+n);if(ok)pass++;}
console.log('Validation: '+pass+'/'+checks.length+' checks passed.');
if(pass!==checks.length)process.exit(1);

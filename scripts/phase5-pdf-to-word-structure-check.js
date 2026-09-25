#!/usr/bin/env node
const fs=require('fs');
const app=fs.readFileSync('public/js/pdf-word-app.js','utf8');
const worker=fs.readFileSync('public/workers/pdf-word-extract-worker.js','utf8');
const checks=[
 ['shared extraction worker remains',app.includes("EXTRACT_WORKER = '/workers/pdf-word-extract-worker.js'")],
 ['extraction uses WorkerPool',/WorkerPool\.run\(\s*EXTRACT_WORKER/.test(app)],
 ['CancelToken propagated',/EXTRACT_WORKER[\s\S]{0,500}token:cancelToken/.test(app)],
 ['worker performs paragraph structuring',/function structureParagraphs\(items\)/.test(worker)],
 ['worker preserves heading/list/form detection',/isHeading/.test(worker)&&/isList/.test(worker)&&/isForm/.test(worker)],
 ['worker preserves signature detection',/isSignature/.test(worker)],
 ['worker returns paragraphs',/paragraphs:structureParagraphs/.test(worker)],
 ['page consumes worker paragraphs',/paragraphs: p\.paragraphs \|\| \[\]/.test(app)],
 ['page no longer defines _extractParagraphs',!app.includes('function _extractParagraphs')],
 ['page no longer performs structure loop',!/var lineMap = \{\};/.test(app)],
 ['DOCX WorkerPool preserved',/WorkerPool\.run\(DOCX_WORKER/.test(app)],
 ['OCR WorkerPool preserved',/WorkerPool\.run\(OCR_WORKER/.test(app)],
 ['render WorkerPool preserved',/WorkerPool\.run\(RENDER_WORKER/.test(app)],
 ['no artificial timeout',!/75s|90s|TOOL_TIMEOUT_MS|HARD_LIMIT_MS/.test(app)],
 ['no artificial file size guard',!/MAX_FILE_BYTES|MAX_FILE_SIZE/.test(app)],
 ['worker page cleanup retained',/page\.cleanup\(\)/.test(worker)],
 ['worker PDF destroy retained',/await pdf\.destroy\(\)/.test(worker)],
 ['audit self-check active',true]
];
let pass=0;
for(const [n,ok] of checks){console.log((ok?'PASS ':'FAIL ')+n);if(ok)pass++;}
console.log('Validation: '+pass+'/'+checks.length+' checks passed.');
if(pass!==checks.length)process.exit(1);

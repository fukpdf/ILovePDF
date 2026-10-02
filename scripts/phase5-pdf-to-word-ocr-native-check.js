#!/usr/bin/env node
// Phase 5 Unit 19 — remove the remaining page-context PDF.js native-text prepass.
// Unit 18 and Unit 19 share the OCR runtime implementation, but Unit 19 has its
// own explicit closure contract so the 1–332 audit does not silently alias it.
import fs from 'node:fs';
const app=fs.readFileSync('public/js/pdf-word-app.js','utf8');
const worker=fs.readFileSync('public/workers/pdf-word-ocr-worker.js','utf8');
const checks=[
 ['page OCR no longer reopens PDF.js',!/async function _runOcr[\s\S]*?(getDocument|getTextContent)/.test(app)],
 ['page OCR does not create native PDF text prepass',!/async function _runOcr[\s\S]*?(pdfjsLib|PDFJS_URL)/.test(app)],
 ['shared extraction remains WorkerPool-backed',/WorkerPool\.run\(\s*EXTRACT_WORKER/.test(app)],
 ['OCR remains WorkerPool-backed',/WorkerPool\.run\(\s*OCR_WORKER/.test(app)],
 ['OCR cancellation remains propagated',/OCR_WORKER[\s\S]{0,500}token:cancelToken/.test(app)],
 ['OCR consumes authoritative totalPages',/async function _runOcr\([\s\S]*?var total = totalPages \|\| 0;/.test(app)],
 ['forced OCR does not perform native prepass',!/forceOcr[\s\S]{0,1200}(getDocument|getTextContent)/.test(app)],
 ['Tesseract remains isolated in OCR worker',worker.includes('T.createWorker')&&worker.includes('workerPath:TESS_WORKER_URL')],
 ['nested Tesseract worker blob remains disabled',worker.includes('workerBlobURL:false')],
 ['OCR worker cleanup remains explicit',worker.includes('await _active.terminate()')],
 ['no artificial timeout in page OCR path',!/setTimeout|75s|90s|TOOL_TIMEOUT_MS|OCR_INIT_MS/.test(app)],
 ['DOCX WorkerPool regression guard',/WorkerPool\.run\(DOCX_WORKER/.test(app)]
];
let failed=0;
for(const [name,ok] of checks){console.log((ok?'PASS ':'FAIL ')+name);if(!ok)failed++;}
console.log('Phase 5 Unit 19 validation: '+(checks.length-failed)+'/'+checks.length);
if(failed)process.exit(1);

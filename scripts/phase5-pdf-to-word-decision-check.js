// Phase 5 Unit 23 — PDF→Word worker-side conversion decision audit
import fs from 'node:fs';
const app=fs.readFileSync('public/js/pdf-word-app.js','utf8');
const ext=fs.readFileSync('public/workers/pdf-word-extract-worker.js','utf8');
const ocr=fs.readFileSync('public/workers/pdf-word-ocr-worker.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
 ['extraction receives forceOcr',/forceOcr:\s*!!forceOcr/.test(app)],
 ['worker computes needsOcr',/var needsOcr=/.test(ext)],
 ['worker preserves 8-char OCR threshold',/avgCharsPerPage<8/.test(ext)],
 ['worker distinguishes decision reason',/ocrDecision=/.test(ext)],
 ['page consumes worker decision',/var needsOcr = !!extracted\.needsOcr/.test(app)],
 ['page no longer computes OCR threshold',!/avgCharsPerPage < 8/.test(app)],
 ['page no longer forces decision locally',!/forceOcr \|\| !pages\.length/.test(app)],
 ['OCR worker returns readability',/readable:charCount>=10/.test(ocr)],
 ['page consumes OCR readability',/!ocrRaw\.length \|\| !ocrRaw\._readable/.test(app)],
 ['WorkerPool extraction retained',/WorkerPool\.run\(\s*EXTRACT_WORKER/.test(app)],
 ['WorkerPool OCR retained',/WorkerPool\.run\(\s*OCR_WORKER/.test(app)],
 ['no fixed timeout in app',!/setTimeout|TOOL_TIMEOUT_MS|75000|90000|120000|105000/.test(app)],
 ['audit command registered',pkg.scripts['audit:phase5:pdf-to-word-decision']==='node scripts/phase5-pdf-to-word-decision-check.js']
];
let failed=0;for(const [n,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+n);if(!ok)failed++;}
console.log(`Unit 23 decision checks: ${checks.length-failed}/${checks.length}`);if(failed)process.exit(1);

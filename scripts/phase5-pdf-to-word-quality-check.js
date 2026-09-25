// Phase 5 Unit 22 — PDF→Word quality-analysis audit
import fs from 'node:fs';
const app=fs.readFileSync('public/js/pdf-word-app.js','utf8');
const ext=fs.readFileSync('public/workers/pdf-word-extract-worker.js','utf8');
const ocr=fs.readFileSync('public/workers/pdf-word-ocr-worker.js','utf8');
const doc=fs.readFileSync('public/workers/pdf-word-docx-worker.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
 ['extraction returns analysis',/analysis:analysis/.test(ext)],
 ['extraction computes character metrics in worker',/totalChars=pages\.reduce/.test(ext)],
 ['page validates extraction analysis',/result\.analysis/.test(app)],
 ['page uses worker avgCharsPerPage',/extracted\.analysis\.avgCharsPerPage/.test(app)],
 ['OCR returns charCount',/charCount:text\.length/.test(ocr)],
 ['page validates OCR charCount',/typeof result\.charCount/.test(app)],
 ['page does not reduce OCR text for quality',!/ocrRaw\.reduce\(/.test(app)],
 ['DOCX worker returns stats',/stats:stats/.test(doc)],
 ['DOCX stats include chars and paras',/chars:pages\.reduce/.test(doc)&&/paras:pages\.reduce/.test(doc)],
 ['page consumes DOCX worker stats',/docxResult\.stats/.test(app)],
 ['page still uses WorkerPool for DOCX',/WorkerPool\.run\(DOCX_WORKER/.test(app)],
 ['no fixed timeout in app',!/setTimeout|TOOL_TIMEOUT_MS|75000|90000|120000|105000/.test(app)],
 ['audit command registered',pkg.scripts['audit:phase5:pdf-to-word-quality']==='node scripts/phase5-pdf-to-word-quality-check.js']
];
let failed=0;for(const [n,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+n);if(!ok)failed++;}
console.log(`Unit 22 quality checks: ${checks.length-failed}/${checks.length}`);if(failed)process.exit(1);

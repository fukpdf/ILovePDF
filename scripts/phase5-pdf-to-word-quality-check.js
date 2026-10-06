#!/usr/bin/env node
import fs from 'node:fs';
const app=fs.readFileSync('public/js/pdf-word-app.js','utf8'),ext=fs.readFileSync('public/workers/pdf-word-extract-worker.js','utf8'),ocr=fs.readFileSync('public/workers/pdf-word-ocr-worker.js','utf8'),doc=fs.readFileSync('public/workers/pdf-word-docx-worker.js','utf8'),pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
['extraction returns analysis',/analysis:analysis/.test(ext)],
['extraction computes character metrics in worker',/totalChars=pages\.reduce/.test(ext)],
['page validates extraction analysis',/extracted\.(analysis|needsOcr)/.test(app)],
['OCR worker returns charCount',/charCount=text\.length/.test(ocr)],
['page validates OCR result metrics',/typeof result\.charCount/.test(app)],
['page does not reduce OCR text for quality',!/ocrRaw\.reduce\(/.test(app)],
['DOCX worker returns stats',/return \{ buffer: ab, stats: stats \}/.test(doc)],
['DOCX stats include chars and paras',/chars:pages\.reduce/.test(doc)&&/paras:pages\.reduce/.test(doc)],
['page consumes DOCX worker stats',/docxResult\.stats/.test(app)],
['page uses WorkerPool for DOCX',/WorkerPool\.run\(DOCX_WORKER/.test(app)],
['no fixed timeout',!/setTimeout|TOOL_TIMEOUT_MS|75000|90000|120000|105000/.test(app)],
['quality audit registered',pkg.scripts['audit:phase5:pdf-to-word-quality']==='node scripts/phase5-pdf-to-word-quality-check.js']
];
let pass=0;for(const [n,ok] of checks){console.log((ok?'PASS ':'FAIL ')+n);if(ok)pass++;}console.log('Validation: '+pass+'/'+checks.length);if(pass!==checks.length)process.exit(1);

// Phase 5 Unit 21 — PDF→Word OCR post-processing audit
// Static gate: OCR recognition must return structured paragraphs from the
// WorkerPool boundary so the page does not parse OCR text into paragraphs.
import fs from 'node:fs';

const app = fs.readFileSync('public/js/pdf-word-app.js', 'utf8');
const worker = fs.readFileSync('public/workers/pdf-word-ocr-worker.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const checks = [
  ['OCR worker constant exists', app.includes("var OCR_WORKER     = '/workers/pdf-word-ocr-worker.js';")],
  ['OCR recognition uses WorkerPool', /WorkerPool\.run\(\s*OCR_WORKER/.test(app)],
  ['OCR cancellation token propagated', /OCR_WORKER[\s\S]{0,500}token:cancelToken/.test(app)],
  ['OCR result requires paragraphs', /Array\.isArray\(result\.paragraphs\)/.test(app)],
  ['page no longer defines _ocrToPages', !/function _ocrToPages\s*\(/.test(app)],
  ['page does not split OCR text into lines', !/\.split\(\/\\r\?\\n\//.test(app)],
  ['page consumes worker paragraphs', /paragraphs:\s*p\.paragraphs \|\| \[\]/.test(app)],
  ['worker defines OCR structuring', /function structureOcrText\s*\(/.test(worker)],
  ['worker normalises OCR symbols', /function normSym\s*\(/.test(worker)],
  ['worker preserves list detection', /LIST_RE/.test(worker) && /NUMLIST_RE/.test(worker)],
  ['worker preserves heading detection', /isHeading/.test(worker) && /toUpperCase/.test(worker)],
  ['worker returns structured paragraphs', /paragraphs:paragraphs/.test(worker)],
  ['worker still uses Tesseract v5', /tesseract\.js@5\.1\.1/.test(worker)],
  ['worker terminates nested Tesseract worker', /\.terminate\(\)/.test(worker)],
  ['no fixed processing timeout in app', !/setTimeout|TOOL_TIMEOUT_MS|75000|90000|120000|105000/.test(app)],
  ['audit command registered', pkg.scripts && pkg.scripts['audit:phase5:pdf-to-word-ocr-structure'] === 'node scripts/phase5-pdf-to-word-ocr-structure-check.js'],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) failed++;
}
console.log(`Unit 21 OCR-structure checks: ${checks.length - failed}/${checks.length}`);
if (failed) process.exit(1);

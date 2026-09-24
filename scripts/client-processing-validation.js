#!/usr/bin/env node
// Phase 3 client-processing validation harness.
// This is a deterministic contract/engine harness: it exercises the shared
// browser kernel, malformed PDF handling, timeout/termination semantics,
// transferable-message contracts, and per-tool worker invariants.
// It does NOT claim browser E2E or visual-fidelity certification.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PDFDocument, degrees } from 'pdf-lib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passCount = 0;
let failCount = 0;

function pass(id, msg) { passCount++; console.log('[PASS]', id, '-', msg); }
function fail(id, msg) { failCount++; console.error('[FAIL]', id, '-', msg); }
function assert(id, condition, msg) { condition ? pass(id, msg) : fail(id, msg); }
function read(rel) { return readFileSync(resolve(ROOT, rel), 'utf8'); }

console.log('\n[Phase3] Client processing validation harness');
assert('output-validator-present', existsSync(resolve(ROOT, 'public/js/client-output-validation.js')),
  'shared output validation boundary exists');
const outputValidator = read('public/js/client-output-validation.js');
const workerPoolSource = read('public/workers/workerPool.js');
assert('workerpool-cancel-unsubscribe', /return function \(\)/.test(workerPoolSource) &&
  /task\.removeCancel/.test(workerPoolSource),
  'worker-pool cancellation callbacks are removable and cleaned after settlement');
assert('workerpool-cancel-terminates', /terminateCurrent\(pool, slot, new Error\('task_cancelled'\)/.test(workerPoolSource),
  'running cancellation terminates the abandoned worker before reuse');
assert('workerpool-queued-cancel', /q\.indexOf\(task\)/.test(workerPoolSource) &&
  /task_cancelled/.test(workerPoolSource),
  'queued cancellation removes the task before dispatch');


assert('output-validator-api', /ClientOutputValidation/.test(outputValidator),
  'shared output validator API is exported');
assert('output-empty-guard', /processing_output_empty/.test(outputValidator),
  'empty outputs are rejected');
assert('output-size-guard', /processing_output_too_large/.test(outputValidator),
  'oversized outputs are rejected');
assert('output-pdf-signature-guard', /processing_output_invalid_pdf_signature/.test(outputValidator),
  'invalid PDF signatures are rejected');


async function kernelHarness() {
  const source = read('public/js/client-processing-kernel.js');
  let spawnedWorker = null;
  const context = {
    Blob,
    ArrayBuffer,
    Uint8Array,
    Math,
    Number,
    TypeError,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    navigator: {
      hardwareConcurrency: 4,
      deviceMemory: 4,
      connection: { saveData: false, effectiveType: '4g' }
    },
    RuntimeWorkerFactory: {
      spawn(url) {
        spawnedWorker = {
          url,
          terminated: false,
          posted: null,
          onmessage: null,
          onerror: null,
          postMessage(message, transfer) { this.posted = { message, transfer }; },
          terminate() { this.terminated = true; }
        };
        return spawnedWorker;
      }
    }
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'client-processing-kernel.js' });
  const k = context.ClientProcessingKernel;

  assert('kernel-export', !!k && typeof k.validateFile === 'function',
    'validation API exposed');
  assert('malformed-type', (() => {
    try { k.validateFile({ size: 1 }); return false; } catch (_) { return true; }
  })(), 'non-Blob input rejected');

  const empty = new Blob([]);
  k.validateFile(empty, { maxBytes: 1024 });
  assert('empty-input-contract', empty.size === 0, 'empty Blob accepted by lifecycle validator; parser remains responsible for format validity');

  const oversized = new Blob([new Uint8Array(8)]);
  assert('size-limit', (() => {
    try { k.validateFile(oversized, { maxBytes: 4 }); return false; } catch (_) { return true; }
  })(), 'configured byte limit enforced');

  assert('server-fallback-block', (() => {
    try { k.assertClientOnly({ allowServerFallback: true }); return false; } catch (_) { return true; }
  })(), 'server fallback prohibited');

  assert('foreign-worker-path-block', (() => {
    try { k.createWorkerJob('https://evil.example/worker.js'); return false; } catch (_) { return true; }
  })(), 'foreign worker URL rejected');

  let chunks = [];
  for await (const item of k.readChunks(new Blob([new Uint8Array(1024 * 1024 + 7)]), { chunkSize: 512 * 1024 })) chunks.push(item);
  assert('chunking', chunks.length === 3 && chunks[0].buffer instanceof ArrayBuffer,
    'bounded chunk stream yields transferable ArrayBuffers');

  const payload = new Uint8Array([1, 2, 3, 4]).buffer;
  const fakeFile = new Blob([payload]);
  const pending = k.processBuffer('/workers/test-worker.js', fakeFile, { timeoutMs: 1000 });
  await new Promise(r => setTimeout(r, 25));
  assert('transfer-list', spawnedWorker && spawnedWorker.posted &&
    spawnedWorker.posted.transfer && spawnedWorker.posted.transfer.length === 1 &&
    spawnedWorker.posted.transfer[0] instanceof ArrayBuffer,
    'input ArrayBuffer is placed in the transferable list');

  let timedOut = false;
  try { await pending; } catch (e) { timedOut = e && e.message === 'processing_worker_timeout'; }
  assert('worker-timeout', timedOut && spawnedWorker && spawnedWorker.terminated,
    'hung worker rejects on timeout and terminates');
  assert('kernel-cancel-signal', /AbortController/.test(source) && /processing_cancelled/.test(source) &&
    /addEventListener\('abort'/.test(source) &&
    /worker\.terminate\(\)/.test(source),
    'abort cancellation rejects and terminates the processing worker');
  assert('kernel-lifecycle-binding', /registerProcessingController/.test(source) && /internalController\.abort/.test(source),
    'WorkerLifecycle can cancel the active processing operation through an internal AbortController');
  assert('unlimited-input-policy', /return Infinity/.test(read('public/js/client-processing-kernel.js')) &&
    !/file_too_large_for_browser|memory_pressure/.test(read('public/js/client-processing-kernel.js')),
    'shared kernel keeps large-file processing uncapped while using runtime memory controls');
  const browserToolsSource = read('public/js/browser-tools.js');
  assert('streaming-image-ingestion', /_runSequentialImageWorker/.test(browserToolsSource) &&
    /images-to-pdf-item/.test(browserToolsSource) && /scan-to-pdf-item/.test(browserToolsSource) &&
    !/async function imagesToPdfWorker[\\s\\S]*Promise\.all/.test(browserToolsSource),
    'multi-image PDF adapters transfer one source buffer at a time');
  assert('streaming-worker-protocols', /images-to-pdf-start/.test(read('public/workers/image-pdf-worker.js')) &&
    /images-to-pdf-ack/.test(read('public/workers/image-pdf-worker.js')) &&
    /scan-to-pdf-start/.test(read('public/workers/scan-pdf-worker.js')) &&
    /scan-to-pdf-ack/.test(read('public/workers/scan-pdf-worker.js')),
    'image and scan workers expose start/item/ack/finish streaming boundaries');
  assert('browser-tool-worker-lifecycle', /_spawnProcessingWorker/.test(read('public/js/browser-tools.js')) &&
    /registerProcessingWorker/.test(read('public/js/browser-tools.js')),
    'migrated BrowserTools workers register with WorkerLifecycle and are released on terminate');
  assert('kernel-buffer-lifecycle', /ClientFileLifecycle[\s\S]*trackBuffer/.test(source) &&
    /ClientFileLifecycle[\s\S]*releaseBuffer/.test(source),
    'transferred input buffer is tracked and released on cleanup paths');

  // Ensure kernel source keeps transferable semantics explicit.
  assert('kernel-transfer-contract', /postMessage\(\{ type: 'process-buffer', buffer: bytes \}, \[bytes\]\)/.test(source),
    'processBuffer transfers the input ArrayBuffer');
 
}

async function pdfEngineHarness() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const valid = await doc.save({ useObjectStreams: true });
  const reopened = await PDFDocument.load(valid);
  assert('output-openability', reopened.getPageCount() === 1,
    'generated PDF reopens successfully');

  const truncated = valid.slice(0, Math.max(1, Math.floor(valid.length / 2)));
  let rejected = false;
  try { await PDFDocument.load(truncated); } catch (_) { rejected = true; }
  assert('truncated-input', rejected, 'truncated PDF is rejected by the parser');

  const empty = new Uint8Array();
  let emptyRejected = false;
  try { await PDFDocument.load(empty); } catch (_) { emptyRejected = true; }
  assert('empty-pdf-input', emptyRejected, 'empty PDF buffer is rejected by the parser');

  const rotateDoc = await PDFDocument.load(valid);
  const page = rotateDoc.getPages()[0];
  page.setRotation(degrees(90));
  const rotated = await rotateDoc.save();
  const rotatedOpen = await PDFDocument.load(rotated);
  assert('rotate-invariant', rotatedOpen.getPages()[0].getRotation().angle === 90,
    'rotation invariant survives save/reopen');

  const source2 = await PDFDocument.create();
  source2.addPage([300, 400]);
  source2.addPage([500, 600]);
  source2.addPage([700, 800]);
  const source2Bytes = await source2.save();

  const splitOut = await PDFDocument.create();
  const splitSrc = await PDFDocument.load(source2Bytes);
  const splitPages = await splitOut.copyPages(splitSrc, [2]);
  splitPages.forEach(p => splitOut.addPage(p));
  const splitBytes = await splitOut.save();
  const splitOpen = await PDFDocument.load(splitBytes);
  assert('split-invariant', splitOpen.getPageCount() === 1 &&
    splitOpen.getPages()[0].getSize().width === 700,
    'selected split page and its dimensions survive save/reopen');

  const cropDoc = await PDFDocument.load(source2Bytes);
  cropDoc.getPages()[0].setCropBox(20, 30, 240, 320);
  const cropBytes = await cropDoc.save();
  const cropOpen = await PDFDocument.load(cropBytes);
  const cropPage = cropOpen.getPages()[0];
  const cropSize = cropPage.getSize();
  assert('crop-invariant', cropSize.width === 240 && cropSize.height === 320,
    'crop box dimensions survive save/reopen');

  const mergeOut = await PDFDocument.create();
  const mergeA = await PDFDocument.load(source2Bytes);
  const mergeB = await PDFDocument.load(splitBytes);
  for (const srcDoc of [mergeA, mergeB]) {
    const pages = await mergeOut.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach(p => mergeOut.addPage(p));
  }
  const mergeBytes = await mergeOut.save();
  const mergeOpen = await PDFDocument.load(mergeBytes);
  assert('merge-invariant', mergeOpen.getPageCount() === 4,
    'merged fixture preserves source page counts');
}

function workerContractHarness() {
  const contracts = [
    ['public/workers/image-pdf-worker.js', ['images-to-pdf', 'images-to-pdf-done', 'ArrayBuffer']],
    ['public/workers/pdf-image-worker.js', ['PDF.js', 'OffscreenCanvas']],
    ['public/workers/spreadsheet-pdf-worker.js', ['XLSX', 'PDFDocument']],
    ['public/workers/pdf-text-extract-worker.js', ['getDocument', 'pdf-text-extract']],
    ['public/workers/pdf-content-extract-worker.js', ['getDocument', 'extract-pdf-content']],
    ['public/workers/word-excel-worker.js', ['mammoth', 'XLSX']],
    ['public/workers/powerpoint-pdf-worker.js', ['JSZip', 'PDFDocument']],
    ['public/workers/ocr-pdf-worker.js', ['Tesseract', 'getDocument']],
    ['public/workers/scan-pdf-worker.js', ['createImageBitmap', 'PDFDocument']],
    ['public/workers/image-tools-worker.js', ['crop-image', 'resize-image', 'image-filters']],
    ['public/workers/pdf-worker.js', ['OPS.compress', 'OPS.rotate', 'OPS.merge', 'OPS.repair', 'OPS.redact']]
  ];
  for (const [rel, markers] of contracts) {
    const exists = existsSync(resolve(ROOT, rel));
    if (!exists) { fail('worker-file:' + rel, 'worker missing'); continue; }
    const source = read(rel);
    const missing = markers.filter(m => !source.includes(m));
    assert('worker-contract:' + rel, missing.length === 0,
      missing.length ? 'missing markers: ' + missing.join(', ') : 'expected operation/protocol markers present');
  }

  const stale = [
    'public/workers/ocr-worker.js',
    'public/workers/pdf-xlsx-worker.js',
    'public/workers/pdf-pptx-worker.js'
  ];
  for (const rel of stale) assert('stale-worker:' + rel, !existsSync(resolve(ROOT, rel)), 'stale worker remains absent');

  const pdfWorker = read('public/workers/pdf-worker.js');
  assert('pdf-worker-output-transfer', /postMessage\([^;]*\[.*buffer.*\]/s.test(pdfWorker),
    'PDF worker contains transferable output messaging');
}

(async () => {
  try {
    await kernelHarness();
    await pdfEngineHarness();
    workerContractHarness();
  } catch (error) {
    fail('harness-exception', error && error.stack ? error.stack : String(error));
  }

  console.log(\`\\n[Phase3] Result: \${passCount} passed, \${failCount} failed\`);
  process.exitCode = failCount ? 1 : 0;
})();
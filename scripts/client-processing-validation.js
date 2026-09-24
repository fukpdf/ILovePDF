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
  // Ensure kernel source keeps transferable semantics explicit.
  assert('kernel-transfer-contract', /postMessage\\(\\{ type: 'process-buffer', buffer: bytes \\}, \\[bytes\\]\\)/.test(source),
    'processBuffer transfers the input ArrayBuffer');

  try { await fast; } catch (_) {}
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
  assert('pdf-worker-output-transfer', /postMessage\\([^;]*\\[.*buffer.*\\]/s.test(pdfWorker),
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

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolPage = readFileSync(path.join(root, 'public/js/tool-page.js'), 'utf8');
const toolHtml = readFileSync(path.join(root, 'public/tool.html'), 'utf8');

const worker = readFileSync(path.join(root, 'public/workers/pdf-worker.js'), 'utf8');
const compressionWorker = readFileSync(path.join(root, 'public/workers/compression-kit-worker.js'), 'utf8');
const kit = readFileSync(path.join(root, 'src/browser/compressionKit.ts'), 'utf8');
const integrity = readFileSync(path.join(root, 'src/browser/pdfContentIntegrity.ts'), 'utf8');
const wasmCli = readFileSync(path.join(root, 'src/browser/wasmCli.ts'), 'utf8');
const compressAdapter = readFileSync(path.join(root, 'public/js/compress-worker-adapter.js'), 'utf8');
const compressRuntime = readFileSync(path.join(root, 'public/js/compress-runtime.js'), 'utf8');
const buildScript = readFileSync(path.join(root, 'scripts/build-compression-kit.js'), 'utf8');
const fsShim = readFileSync(path.join(root, 'src/browser/node-fs-shim.cjs'), 'utf8');
const pathShim = readFileSync(path.join(root, 'src/browser/node-path-shim.cjs'), 'utf8');
const compressStart = worker.indexOf('OPS.compress = async function (buffers) {');
const compressEnd = worker.indexOf('\nOPS.repair =', compressStart);
const compressBody = compressStart >= 0 && compressEnd > compressStart ? worker.slice(compressStart, compressEnd) : '';

const checks = [
  ['compression UI invokes the canonical cancellable CompressRuntime', toolPage.includes('window.CompressRuntime.execute(file, {') && toolPage.includes("window.CompressRuntime.cancelActive('user-cancel')")],
  ['canonical CompressWorkerAdapter routes through the verified module worker', compressAdapter.includes("var WORKER_URL = '/workers/compression-kit-worker.js?v=20261010-qpdf-lossless-kit-v1'") && !compressAdapter.includes("window.RuntimeWorkers.dispatch(")],
  ['active UI no longer creates a duplicate uncancellable worker', !toolPage.includes("new Worker('/workers/compression-kit-worker.js?v=20261010-qpdf-lossless-kit-v1'")],
  ['cancel button interrupts preflight and the active WASM worker', toolPage.includes('let preflightCancelled = false') && toolPage.includes('preflightCancelled = true') && toolPage.includes('removeEventListener(\'click\', onCompressionCancel)')],
  ['canonical adapter preserves Deep/Custom and rejects missing mode', compressAdapter.includes("mode === 'custom'") && compressAdapter.includes("mode === 'deep'") && compressAdapter.includes('no default mode was substituted')],
  ['canonical adapter supports cancellation by terminating its worker', compressAdapter.includes('setInterval(function ()') && compressAdapter.includes('worker.terminate()') && compressAdapter.includes('Compression cancelled.')],
  ['CompressRuntime forwards the quality/target report without removing legacy result fields', compressRuntime.includes('alreadyOptimized: alreadyOptimized') && compressRuntime.includes('report: result.report || null')],
  ['canonical adapter transfers PDF bytes to the local worker, not a server', compressAdapter.includes('buffer: buffer') && compressAdapter.includes('}, [buffer])') && !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(kit + compressAdapter)],
  ['legacy page-rasterization compression path is removed', !toolPage.includes('page.render({ canvasContext: ctx, viewport })') && !toolPage.includes('outDoc.embedJpg(jpgBytes)')],
  ['signed/encrypted/XFA/form markers are checked in the active UI compression path', toolPage.includes('const sensitivePdfReason = [') && toolPage.includes("['/ByteRange', 'Digitally signed PDFs") && toolPage.includes("['/Encrypt', 'Encrypted PDFs") && toolPage.includes("['/XFA', 'XFA forms") && toolPage.includes("['/AcroForm', 'Interactive forms")],
  ['active UI returns original file for sensitive PDF types', toolPage.includes("showStatus(\n        'success',\n        'Compression safely skipped'") && toolPage.includes('createStatusUrl(file)')],
  ['parsed catalog AcroForm check runs before PDF.js page processing', toolPage.includes("sourcePdfLib.catalog.get(PDFName.of('AcroForm'))") && toolPage.indexOf("sourcePdfLib.catalog.get(PDFName.of('AcroForm'))") < toolPage.indexOf("srcPdf = await pdfjsLib.getDocument")],
  ['parsed PDF outlines and attachments are preserved unchanged', toolPage.includes('srcPdf.getOutline()') && toolPage.includes('srcPdf.getAttachments()') && toolPage.includes('if (outline || attachments)')],
  ['links and annotations cause a fail-closed no-op', toolPage.includes("page.getAnnotations({ intent: 'display' })") && toolPage.includes('annotations.length > 0') && toolPage.includes('The original is preserved unchanged.')],
  ['unsupported outlines, attachments, tags and interactive structures are rejected by QPDF preflight', integrity.includes('assertCompressionEligible') && integrity.includes('"/AcroForm", "/Outlines", "/StructTreeRoot", "/Perms"') && integrity.includes('"/OpenAction", "/AA", "/Collection", "/Names"')],
  ['QPDF preserves all stream payloads and does not recompress images', kit.includes('"--stream-data=preserve"') && kit.includes('"--object-streams=generate"') && !kit.includes('"--recompress-flate"')],
  ['QPDF candidate is accepted only after decoded content stream validation', kit.includes('hashPageContentStreams(inputJson)') && kit.includes('hashPageContentStreams(outputJson)') && kit.includes('assertPageContentStreamsUnchanged(before, after)')],
  ['decoded page-content streams use SHA-256', integrity.includes('subtle.digest("SHA-256", bytes)')],
  ['un-decodable content streams fail closed', integrity.includes('refusing to certify it')],
  ['page order, page count and ordered stream hashes must match', integrity.includes('before.pageCount !== after.pageCount') && integrity.includes('left.length !== right.length') && integrity.includes('changed decoded page content streams on page')],
  ['output larger than source is never returned', kit.includes('candidate.byteLength >= original.byteLength') && kit.includes('candidate.byteLength > original.byteLength')],
  ['output PDF signature is checked by UI and WASM adapter', toolPage.includes("outputSignature !== '%PDF-'") && wasmCli.includes('output[4] !== 0x2d')],
  ['QPDF engine and JSON inspection use only in-memory WASM FS', wasmCli.includes('module.FS.writeFile(inputPath, input)') && wasmCli.includes('module.FS.readFile(outputPath)') && !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(wasmCli)],
  ['worker loads only local same-origin WASM assets', compressionWorker.includes('"/vendor/compression/qpdf.wasm?v=20261010-qpdf-lossless-kit-v1"') && compressionWorker.includes('"/vendor/compression/gs.wasm?v=20261010-qpdf-lossless-kit-v1"')],
  ['Custom target remains mandatory', toolPage.includes('Custom target missing') && toolPage.includes("requestedMode !== 'deep' && requestedMode !== 'custom'")],
  ['root build creates the browser bundle and local WASM assets', readFileSync(path.join(root, 'scripts/build-compression-kit.js'), 'utf8').includes('public/js/compression-kit.js') && readFileSync(path.join(root, 'scripts/build-compression-kit.js'), 'utf8').includes('public/vendor/compression')],
  ['browser bundle splits dynamic engine chunks for lazy initialization', buildScript.includes('splitting: true') && buildScript.includes('chunkNames: "compression-chunks/[name]-[hash]"')],
  ['Node-only builtins are shimmed instead of emitted as bare browser imports', buildScript.includes('node-fs-shim.cjs') && buildScript.includes('node-path-shim.cjs') && !buildScript.includes('external: ["fs", "path", "node:fs", "node:path"]')],
  ['browser shims fail closed if Node-only APIs are unexpectedly called', fsShim.includes('Node filesystem APIs are unavailable in the browser compression bundle.') && pathShim.includes('Node path APIs are unavailable in the browser compression bundle.')],
  ['compression runtime does not call network APIs with PDF bytes', !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(kit + integrity + wasmCli + compressionWorker)],
  ['legacy pdf-worker compression rewrite is disabled', compressBody.includes('Legacy compression route disabled') && !compressBody.includes('PDFDocument.load(')],
  ['legacy worker returns an exact copy of original bytes', compressBody.includes('return original.slice();')],

];

for (const [name, condition] of checks) {
  assert.equal(condition, true, 'FAIL: ' + name);
  console.log('PASS: ' + name);
}
console.log('Compression hybrid regression checks passed: ' + checks.length);

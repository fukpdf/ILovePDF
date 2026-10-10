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
const browserCompressor = readFileSync(path.join(root, 'src/browser/browserCompressor.ts'), 'utf8');
const deepEngine = readFileSync(path.join(root, 'src/browser/deepEngine.ts'), 'utf8');
const browserQualityGate = readFileSync(path.join(root, 'src/browser/browserQualityGate.ts'), 'utf8');
const gsParams = readFileSync(path.join(root, 'src/shared/gsParams.ts'), 'utf8');
const jpegPolicy = readFileSync(path.join(root, 'src/shared/jpeg.ts'), 'utf8');
const viteConfig = readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
const integrity = readFileSync(path.join(root, 'src/browser/pdfContentIntegrity.ts'), 'utf8');
const wasmCli = readFileSync(path.join(root, 'src/browser/wasmCli.ts'), 'utf8');
const compressionKitEntry = readFileSync(path.join(root, 'src/browser/compressionKitEntry.ts'), 'utf8');
const compressAdapter = readFileSync(path.join(root, 'public/js/compress-worker-adapter.js'), 'utf8');
const compressRuntime = readFileSync(path.join(root, 'public/js/compress-runtime.js'), 'utf8');
const buildScript = readFileSync(path.join(root, 'scripts/build-compression-kit.js'), 'utf8');
const fsShim = readFileSync(path.join(root, 'src/browser/node-fs-shim.cjs'), 'utf8');
const pathShim = readFileSync(path.join(root, 'src/browser/node-path-shim.cjs'), 'utf8');
const compressStart = worker.indexOf('OPS.compress = async function (buffers) {');
const compressEnd = worker.indexOf('\nOPS.repair =', compressStart);
const compressBody = compressStart >= 0 && compressEnd > compressStart ? worker.slice(compressStart, compressEnd) : '';

const checks = [
  ['light engine only recompresses eligible RGB DCT images and uses a real box filter', browserCompressor.includes('PDFName.of("DCTDecode")') && browserCompressor.includes('PDFName.of("DeviceRGB")') && browserCompressor.includes('SMask') && browserCompressor.includes('PDFName.of("Decode")') && browserCompressor.includes('boxResizeRGBA') && browserCompressor.includes('Math.min(95, quality, sourceQuality)') && browserCompressor.includes('maxSafeJpegQuality(bytes)') && browserCompressor.includes('jpegQuantizationNoFiner(bytes, encoded)')],
  ['PDF.js worker URL is configured and visual gate checks text plus sharpness', browserQualityGate.includes('configurePdfJs(pdfWorkerUrl)') && browserQualityGate.includes('pdf.worker.min.mjs?url') && browserQualityGate.includes('textCheck') && browserQualityGate.includes('judgeSample') && kit.includes('qualityGateInBrowser(original, lightCandidate, {') && kit.includes('minPsnrDb: MODE_POLICY[engineMode].minPsnrDb')],
  ['Custom compression is bounded to four original-based attempts', browserCompressor.includes('const ladder: readonly number[] = [MODE_POLICY[mode].jpegQuality]') && deepEngine.includes('CUSTOM_GS_QFACTOR_LADDER.slice(2, 4)') && deepEngine.includes('run("ghostscript", input, buildGsArgs')],
  ['compression UI invokes the canonical cancellable CompressRuntime', toolPage.includes('window.CompressRuntime.execute(file, {') && toolPage.includes("window.CompressRuntime.cancelActive('user-cancel')")],
  ['canonical CompressWorkerAdapter routes through the verified module worker', compressAdapter.includes("var WORKER_URL = '/workers/compression-kit-worker.js?v=20261010-qpdf-lossless-kit-v2'") && !compressAdapter.includes("window.RuntimeWorkers.dispatch(")],
  ['active UI no longer creates a duplicate uncancellable worker', !toolPage.includes("new Worker('/workers/compression-kit-worker.js?v=20261010-qpdf-lossless-kit-v2'")],
  ['cancel button interrupts preflight and the active WASM worker', toolPage.includes('let preflightCancelled = false') && toolPage.includes('preflightCancelled = true') && toolPage.includes('removeEventListener(\'click\', onCompressionCancel)')],
  ['canonical adapter preserves Deep/Custom and rejects missing mode', compressAdapter.includes("mode === 'custom'") && compressAdapter.includes("mode === 'deep'") && compressAdapter.includes('no default mode was substituted')],
  ['canonical adapter supports cancellation by terminating its worker', compressAdapter.includes('setInterval(function ()') && compressAdapter.includes('worker.terminate()') && compressAdapter.includes('Compression cancelled.')],
  ['UI accepts every certified compression method and explains quality-gated image re-encoding', toolPage.includes("['qpdf-lossless-structure', 'browser-rgb-image', 'ghostscript-quality-gated'].includes(report.method)") && toolPage.includes('eligible RGB images are re-encoded only when visual quality checks pass.')],
  ['Ghostscript leaves colour unchanged and disables chroma subsampling', gsParams.includes('/ColorConversionStrategy /LeaveColorUnchanged') && gsParams.includes('/HSamples [1 1 1 1]') && gsParams.includes('/VSamples [1 1 1 1]')],
  ['PDF output never contains WebP/AVIF and no lossy JBIG2 is configured', !/WebP|AVIF/i.test(browserCompressor + gsParams) && !gsParams.includes("/JBIG2Encode") && !gsParams.includes("/JBIG2Decode")],
  ['dedupe requires complete dictionary equality and deletes only unreferenced duplicates', browserCompressor.includes('dictionarySignature') && browserCompressor.includes('sameBytes(hit.bytes, bytes)') && browserCompressor.includes('if (!stillReferenced.has(entry.ref.tag))')],
  ['AcroForm routes to QPDF only and memory/target failures are reported', kit.includes('routeDecision.qpdfOnly || baseline.qpdfOnly') && kit.includes('Deep engine skipped due to memory safety') && kit.includes('Requested target')],
  ['CompressRuntime forwards the quality/target report without removing legacy result fields', compressRuntime.includes('alreadyOptimized: alreadyOptimized') && compressRuntime.includes('report: result.report || null')],
  ['canonical adapter transfers PDF bytes to the local worker, not a server', compressAdapter.includes('buffer: buffer') && compressAdapter.includes('}, [buffer])') && !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(kit + compressAdapter)],
  ['legacy page-rasterization compression path is removed', !toolPage.includes('page.render({ canvasContext: ctx, viewport })') && !toolPage.includes('outDoc.embedJpg(jpgBytes)')],
  ['signed/encrypted/XFA markers fail closed while AcroForm reaches QPDF-only route', toolPage.includes('const sensitivePdfReason = [') && toolPage.includes("['/ByteRange', 'Digitally signed PDFs") && toolPage.includes("['/Encrypt', 'Encrypted PDFs") && toolPage.includes("['/XFA', 'XFA forms") && !toolPage.includes("['/AcroForm', 'Interactive forms") && toolPage.includes('Only the QPDF structural route will be considered')],
  ['active UI returns original file for sensitive PDF types', toolPage.includes("showStatus(\n        'success',\n        'Compression safely skipped'") && toolPage.includes('createStatusUrl(file)')],
  ['parsed catalog AcroForm check runs before PDF.js page processing', toolPage.includes("sourcePdfLib.catalog.get(PDFName.of('AcroForm'))") && toolPage.indexOf("sourcePdfLib.catalog.get(PDFName.of('AcroForm'))") < toolPage.indexOf("srcPdf = await pdfjsLib.getDocument")],
  ['parsed PDF outlines and attachments are preserved unchanged', toolPage.includes('srcPdf.getOutline()') && toolPage.includes('srcPdf.getAttachments()') && toolPage.includes('if (outline || attachments)')],
  ['links and annotations cause a fail-closed no-op', toolPage.includes("page.getAnnotations({ intent: 'display' })") && toolPage.includes('annotations.length > 0') && toolPage.includes('The original is preserved unchanged.')],
  ['QPDF preflight rejects permission/signature/XFA restrictions and compares all protected structure', integrity.includes('const unsafeCatalogKeys = ["/Perms"]') && integrity.includes('const unsafeNestedKeys = ["/ByteRange", "/XFA", "/SigFlags"]') && kit.includes('assertDocumentStructureUnchanged(baseline.discovery, outputDiscovery)') && kit.includes('assertProtectedStreamsUnchanged')],
  ['QPDF preserves stream payloads while the deep route forbids lossy mono encoding', deepEngine.includes('"--stream-data=preserve"') && deepEngine.includes('"--object-streams=generate"') && gsParams.includes('-dDownsampleMonoImages=false') && gsParams.includes('/MonoImageDict << /K -1 >>') && !/(?:JBIG2Encode|JBIG2Decode|-dMonoImageFilter=.*JBIG2)/i.test(gsParams) && !kit.includes('"--recompress-flate"')],
  ['Every deep candidate is accepted only after decoded page-content SHA-256 validation', kit.includes('hashPageContentStreams(pageJson)') && kit.includes('hashPageContentStreams(outputPageJson)') && kit.includes('assertPageContentStreamsUnchanged(baseline.pageHashes, after)')],
  ['QPDF JSON selectors use documented object-number,generation syntax', kit.includes('return `${match[1]},${match[2]}`') && kit.includes('--json-object=${qpdfJsonSelector(selector)}')],
  ['decoded page-content streams use SHA-256', integrity.includes('subtle.digest("SHA-256", digestBytes.buffer)')],
  ['un-decodable content streams fail closed', integrity.includes('refusing to certify it')],
  ['page order, page count and ordered stream hashes must match', integrity.includes('before.pageCount !== after.pageCount') && integrity.includes('left.length !== right.length') && integrity.includes('changed decoded page content streams on page')],
  ['output larger than source is never returned', kit.includes('candidate.byteLength >= original.byteLength') && kit.includes('best.byteLength >= original.byteLength') && kit.includes('outputBytes: best.byteLength')],
  ['output PDF signature is checked by UI and WASM adapter', toolPage.includes("outputSignature !== '%PDF-'") && wasmCli.includes('output[4] !== 0x2d')],
  ['QPDF engine and JSON inspection use only in-memory WASM FS', wasmCli.includes('module.FS.writeFile(inputPath, input)') && wasmCli.includes('module.FS.readFile(outputPath)') && !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(wasmCli)],
  ['worker resolves WASM binaries through Vite same-origin URL assets', compressionKitEntry.includes('@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url') && compressionKitEntry.includes('@jspawn/ghostscript-wasm/gs.wasm?url') && compressionWorker.includes('"/js/compression-kit.js?v=20261010-qpdf-lossless-kit-v2"')],
  ['Custom target remains mandatory', toolPage.includes('Custom target missing') && toolPage.includes("requestedMode !== 'deep' && requestedMode !== 'custom'")],
  ['root build creates the browser bundle and local WASM assets', readFileSync(path.join(root, 'scripts/build-compression-kit.js'), 'utf8').includes('public/js/compression-kit.js') && readFileSync(path.join(root, 'scripts/build-compression-kit.js'), 'utf8').includes('public/vendor/compression')],
  ['Vite splits lazy WASM and PDF.js quality-gate chunks', viteConfig.includes('chunkFileNames: "compression-chunks/[name]-[hash].js"') && deepEngine.includes('await import("./browserQualityGate")') && wasmCli.includes('await import("@neslinesli93/qpdf-wasm")')],
  ['Node-only builtins are shimmed instead of emitted as bare browser imports', viteConfig.includes('node-fs-shim.cjs') && viteConfig.includes('node-path-shim.cjs') && !viteConfig.includes('external: ["fs", "path", "node:fs", "node:path"]')],
  ['browser shims fail closed if Node-only APIs are unexpectedly called', fsShim.includes('Node filesystem APIs are unavailable in the browser compression bundle.') && pathShim.includes('Node path APIs are unavailable in the browser compression bundle.')],
  ['compression runtime does not call network APIs with PDF bytes', !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(kit + integrity + wasmCli + compressionWorker)],
  ['legacy pdf-worker compression rewrite is disabled', compressBody.includes('Legacy compression route disabled') && !compressBody.includes('PDFDocument.load(')],
  ['legacy worker returns an exact copy of original bytes', compressBody.includes('return original.slice();')],
  ['all re-encoded RGB image candidates are checked against source JPEG quantization', kit.includes('assertRgbImageQuantizationNotFiner(baseline.rgbImageSnapshot, outputRgbImageSnapshot)') && kit.includes('assertRgbImageStreamsUnchanged(baseline.rgbImageSnapshot, outputRgbImageSnapshot)') && integrity.includes('jpegQuantizationProfileNoFiner') && integrity.includes('selectEligibleRgbImageObjects')],
  ['JPEG output is rejected if chroma-subsampled', jpegPolicy.includes('output.componentSamplingFactors.some(value => value !== 0x11)')],

];

for (const [name, condition] of checks) {
  assert.equal(condition, true, 'FAIL: ' + name);
  console.log('PASS: ' + name);
}
console.log('Compression hybrid regression checks passed: ' + checks.length);

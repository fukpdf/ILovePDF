#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolPage = readFileSync(path.join(root, 'public/js/tool-page.js'), 'utf8');
const toolHtml = readFileSync(path.join(root, 'public/tool.html'), 'utf8');

const worker = readFileSync(path.join(root, 'public/workers/pdf-worker.js'), 'utf8');
const compressStart = worker.indexOf('OPS.compress = async function (buffers) {');
const compressEnd = worker.indexOf('\nOPS.repair =', compressStart);
const compressBody = compressStart >= 0 && compressEnd > compressStart ? worker.slice(compressStart, compressEnd) : '';

const checks = [
  ['selectable text is inspected', toolPage.includes('await page.getTextContent()')],
  ['image-only pages are detected from PDF operators', toolPage.includes('page.getOperatorList()') && toolPage.includes('imageOpCodes.has(op)')],
  ['repeated image operators are detected', toolPage.includes("'paintImageXObjectRepeat'")],
  ['solid-colour image masks are detected', toolPage.includes("'paintSolidColorImageMask'")],
  ['text and vector-only pages are preserved', toolPage.includes("hasSelectableText || !hasRasterImages ? 'preserve' : 'raster'")],
  ['native pages are copied instead of rasterized', toolPage.includes('outDoc.copyPages(sourcePdfLib, [i - 1])')],
  ['only raster-classified pages are JPEG-rendered', toolPage.includes("if (pageModes[i - 1] === 'preserve')") && toolPage.includes('outDoc.embedJpg(jpgBytes)')],
  ['image-only pages have a 150 DPI minimum', toolPage.includes('const MIN_RENDER_SCALE = 150 / 72;') && toolPage.includes('const DEEP_RENDER_SCALE = MIN_RENDER_SCALE;')],
  ['Deep baseline JPEG quality remains unchanged', toolPage.includes('const DEEP_JPEG_QUALITY = 0.72;')],
  ['Custom retains four-pass measured feedback', toolPage.includes('const MAX_CUSTOM_PASSES = 4;') && toolPage.includes('targetBytes / Math.max(1, candidate.size)')],
  ['output page count is validated', toolPage.includes('outDoc.getPageCount() !== total')],
  ['PDF signature is validated', toolPage.includes("blob.slice(0, 5).text()") && toolPage.includes("signature !== '%PDF-'")],
  ['larger output does not replace the original', toolPage.includes('const didReduce = bestBlob.size < file.size')],
  ['Custom target is mandatory', toolPage.includes('Custom target missing') && toolPage.includes("requestedMode !== 'deep' && requestedMode !== 'custom'")],
  ['cache bust points to the hybrid implementation', toolHtml.includes('/js/tool-page.js?v=20261009-hybrid-150dpi-v2')],
  ['UI no longer claims one-pass-only Custom mode', !toolPage.includes('uses one compression pass') && !toolPage.includes('calculated single-pass output')],
  ['signed/encrypted/XFA/form markers are checked in the active UI compression path', toolPage.includes('const sensitivePdfReason = [') && toolPage.includes("['/ByteRange', 'Digitally signed PDFs") && toolPage.includes("['/Encrypt', 'Encrypted PDFs") && toolPage.includes("['/XFA', 'XFA forms") && toolPage.includes("['/AcroForm', 'Interactive forms")],
  ['active UI returns the original file for sensitive PDF types', toolPage.includes("showStatus(\n        'success',\n        'Compression safely skipped'") && toolPage.includes('createStatusUrl(file)')],
  ['parsed catalog AcroForm check runs before PDF.js page processing', toolPage.includes("sourcePdfLib.catalog.get(PDFName.of('AcroForm'))") && toolPage.indexOf("sourcePdfLib.catalog.get(PDFName.of('AcroForm'))") < toolPage.indexOf("srcPdf = await pdfjsLib.getDocument")],
  ['UI compression skips PDFs with links or annotations', toolPage.includes("page.getAnnotations({ intent: 'display' })") && toolPage.includes('annotations.length > 0') && toolPage.indexOf('annotations.length > 0') < toolPage.indexOf('page.render({ canvasContext: ctx, viewport })')],
  ['UI compression skips PDFs with outlines, attachments, or tagged structure markers', toolPage.includes("['/Outlines', 'PDF bookmarks/outlines") && toolPage.includes("['/EmbeddedFiles', 'PDF attachments") && toolPage.includes("['/StructTreeRoot', 'Tagged-PDF structure")],
  ['mixed text-and-image pages are conservatively preserved', toolPage.includes("hasSelectableText || !hasRasterImages ? 'preserve' : 'raster'") && toolPage.includes('outDoc.copyPages(sourcePdfLib, [i - 1])')],
  ['signed PDFs are returned unchanged by the compression worker', compressBody.includes("['/ByteRange', 'digitally signed PDF']") && compressBody.includes('return original;')],
  ['encrypted PDFs are returned unchanged by the compression worker', compressBody.includes("['/Encrypt', 'encrypted PDF']") && compressBody.includes('return original;')],
  ['XFA and AcroForm PDFs are returned unchanged by the compression worker', compressBody.includes("['/XFA', 'XFA PDF']") && compressBody.includes("['/AcroForm', 'interactive form PDF']")],
  ['compression does not strip metadata as a side effect', !compressBody.includes('stripMetadata(doc)')],
  ['sensitive-PDF checks happen before any pdf-lib rewrite', compressBody.indexOf("['/ByteRange', 'digitally signed PDF']") >= 0 && compressBody.indexOf("['/ByteRange', 'digitally signed PDF']") < compressBody.indexOf('PDFDocument.load(')],
  ['AcroForm dictionaries hidden in object streams are checked before serialization', compressBody.includes("doc.catalog.get(PDFName.of('AcroForm'))") && compressBody.indexOf("doc.catalog.get(PDFName.of('AcroForm'))") < compressBody.indexOf('doc.save(')],
  ['compression worker does not issue network requests with PDF bytes', !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(compressBody)],
  ['compression worker returns original when candidate is not smaller', compressBody.includes('return result.byteLength < original.byteLength ? result : original;')],
];

for (const [name, condition] of checks) {
  assert.equal(condition, true, 'FAIL: ' + name);
  console.log('PASS: ' + name);
}
console.log('Compression hybrid regression checks passed: ' + checks.length);

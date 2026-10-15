import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const config = read('public/js/tools-config.js');
const livePreview = read('public/js/live-preview.js');
const toolPage = read('public/js/tool-page.js');
const styles = read('public/css/styles.css');

const toolsStart = config.indexOf('const TOOLS = [');
assert.notEqual(toolsStart, -1, 'tools-config.js must define TOOLS');
const toolsEnd = config.indexOf('\n];', toolsStart);
assert.notEqual(toolsEnd, -1, 'TOOLS array must have a closing bracket');
const toolsBlock = config.slice(toolsStart, toolsEnd);
const entries = [...toolsBlock.matchAll(/^\s{2}\{\n\s{4}id:\s*['"]([^'"]+)['"][\s\S]*?^\s{2}\},?/gm)];
assert.ok(entries.length > 0, 'must parse tool definitions');

const uploadTools = entries.map((match) => {
  const chunk = match[0];
  return {
    id: match[1],
    name: (chunk.match(/\bname:\s*['"]([^'"]+)['"]/) || [])[1] || match[1],
    acceptedFiles: (chunk.match(/\bacceptedFiles:\s*['"]([^'"]+)['"]/) || [])[1] || '',
    multipleFiles: (chunk.match(/\bmultipleFiles:\s*(true|false)/) || [])[1] || 'false',
  };
}).filter((tool) => tool.acceptedFiles);

const inventoryMatch = livePreview.match(/var UPLOAD_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(inventoryMatch, 'shared preview must declare upload-enabled tool inventory');
const declaredIds = [...inventoryMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
const declaredSet = new Set(declaredIds);
assert.deepEqual(uploadTools.filter((tool) => !declaredSet.has(tool.id)).map((tool) => tool.id), [],
  'every acceptedFiles tool must use the shared preview');
assert.deepEqual(declaredIds.filter((id) => !uploadTools.some((tool) => tool.id === id)), [],
  'shared preview inventory must not include non-upload tools');
assert.equal(declaredSet.size, declaredIds.length, 'shared preview inventory must not contain duplicate IDs');

assert.match(livePreview, /async function mountSharedFilePreview\(toolId, files, host\)/,
  'the shared renderer must be the only selected-file renderer');
assert.match(livePreview, /supported:\s*function\s*\(toolId\)\s*\{\s*return UPLOAD_TOOL_IDS\.has\(toolId\);/,
  'LivePreview.supported() must be true for every upload-enabled tool');
assert.match(livePreview, /data-obj-url/,
  'shared image previews must mark object URLs for cleanup');
assert.match(livePreview, /PdfPreview\.renderPage\(pdfDocument, 1, 180, 0\)/,
  'shared PDF preview should attempt a real first-page thumbnail without loading the engine eagerly');
for (const obsolete of [
  'mountMergePreview', 'mountWordToPdf', 'mountExcelToPdf', 'mountPdfWordPreview',
  'mountPdfExcelPreview', 'mountBgRemover', 'mountTranslatePreview',
  'mountSummarizePreview', 'mountEditPdfPreview', 'SUPPORTED = new Set'
]) {
  assert.ok(!livePreview.includes(obsolete), 'legacy per-tool renderer remains: ' + obsolete);
}

assert.match(toolPage, /const hasPrimaryLivePreview = !!\([\s\S]*?window\.LivePreview\.supported\(tool\.id\)/,
  'standard preview step must use the shared preview for upload-enabled tools');
assert.ok(toolPage.includes('id="live-preview-host"'), 'standard/editor layouts must provide shared preview host');
assert.ok(toolPage.includes('id="page-organizer-host"'), 'page editor controls must mount separately from the shared preview');
assert.ok(!toolPage.includes('renderCompressPreview'), 'legacy compression thumbnail renderer must be removed');
assert.ok(!toolPage.includes('compress-preview-host'), 'legacy compression preview host references must be removed');
assert.ok(!toolPage.includes('isMergeLivePreview') && !toolPage.includes('hasDedicatedPreview'),
  'per-tool preview eligibility branches must be removed');
for (const obsolete of [
  'renderFileList(', 'renderPdfThumbnails(', 'attachDragHandlers(', 'rotateFile(',
  '_thumbUrl', 'upload-file-item'
]) {
  assert.ok(!toolPage.includes(obsolete), 'legacy selected-file list implementation remains: ' + obsolete);
}
for (const obsoleteClass of [
  'upload-file-item', 'file-thumb-wrap', 'file-drag-handle', 'upload-file-name',
  'upload-file-size', 'file-rotate-btn', 'upload-file-remove'
]) {
  assert.ok(!styles.includes(obsoleteClass), 'legacy selected-file list CSS remains: ' + obsoleteClass);
}
assert.match(livePreview, /data-shared-move/,
  'Merge must retain ordering controls inside the shared preview');
assert.ok(toolPage.includes('window.moveMergePreviewFile = moveMergePreviewFile'),
  'shared Merge ordering controls must route through existing selected-file state');
assert.match(toolPage, /function refreshSharedPreview\(\)/,
  'file add/remove/reorder must refresh only the shared preview instead of replaying preparation');
assert.match(livePreview, /var hostMountTokens = new WeakMap\(\)/,
  'stale async preview mounts must be guarded');
assert.match(livePreview, /window\.addEventListener\('ilpdf:step'/,
  'preview object URLs must be cleaned up when leaving the preview step');
assert.match(toolPage, /wireCompressOptions\(\)/, 'compression options must remain wired after removing its old preview');
assert.match(toolPage, /mountLivePreviewForStep\(tool\.id, \[file\], sharedPreviewHost\)/,
  'PRO editor tools must also mount the shared selected-file preview');
assert.match(toolPage, /mountLivePreviewForStep\(tool\.id, selectedFiles\.map\(function \(entry\) \{ return entry\.file; \}\), rotatePreviewHost\)/,
  'Rotate PDF must mount the shared selected-file preview alongside its page editor');
assert.ok(styles.includes('/* Shared post-upload preview fallback'), 'shared-preview styles must be present');
assert.match(styles, /\.lp-shared-preview\{width:100%;min-width:0;/,
  'shared preview surface styles must apply outside the standard tool shell');

const specialUploadPages = [
  { file: 'public/image-compressor.html', markers: ['ic-dropzone', 'ic-preview-wrap', 'lp-shared-preview', 'renderSelectedImagePreview'] },
  { file: 'public/image-converter.html', markers: ['iconv-dropzone', 'lp-shared-file-card', 'lp-shared-image', 'imagePreviewUrls'] },
  { file: 'public/zip-builder.html', markers: ['zip-dropzone', 'zip-file-list', 'lp-shared-file-card', 'lp-shared-file-art'] },
];
for (const page of specialUploadPages) {
  const html = read(page.file);
  assert.ok(html.includes('/js/special-upload-flow.js'), page.file + ' must use the shared special upload flow');
  for (const marker of page.markers) assert.ok(html.includes(marker), page.file + ' missing ' + marker);
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const script of inlineScripts) {
    const attrs = script[1], source = script[2];
    if (/\bsrc\s*=/.test(attrs) || /application\/ld\+json/i.test(attrs) || /\btype=["']module["']/i.test(attrs) || !source.trim()) continue;
    assert.doesNotThrow(() => new Function(source), page.file + ' contains invalid inline JavaScript');
  }
}

console.log('PASS: shared-only post-upload preview source regression checks');
console.log('PASS: ' + uploadTools.length + ' upload-enabled tool definitions covered (' + declaredSet.size + ' registered)');
console.log('PASS: old rich per-tool preview dispatchers and compression thumbnail code removed');
console.log('PASS: shared preview, PDF thumbnail fallback, object-URL cleanup, editor separation, and responsive styling');
console.log('PASS: 3 standalone upload pages retain their specialized processing/result workflows');
console.log('Upload tools: ' + uploadTools.map((tool) => tool.id).join(', '));

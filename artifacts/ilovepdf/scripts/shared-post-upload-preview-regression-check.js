'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

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

const uploadSetMatch = livePreview.match(/var UPLOAD_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(uploadSetMatch, 'LivePreview must declare the upload-enabled tool inventory');
const declaredIds = [...uploadSetMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
const declaredSet = new Set(declaredIds);
const missing = uploadTools.filter((tool) => !declaredSet.has(tool.id)).map((tool) => tool.id);
const unexpected = declaredIds.filter((id) => !uploadTools.some((tool) => tool.id === id));
assert.deepEqual(missing, [], 'every acceptedFiles tool must be registered for shared preview eligibility');
assert.deepEqual(unexpected, [], 'preview inventory must not include non-upload tools');
assert.equal(declaredSet.size, declaredIds.length, 'preview inventory must not contain duplicate IDs');

assert.match(livePreview, /supported:\s*function\s*\(toolId\)\s*\{\s*return\s+SUPPORTED\.has\(toolId\)\s*\|\|\s*UPLOAD_TOOL_IDS\.has\(toolId\);/,
  'LivePreview.supported() must include every upload-enabled tool');
assert.match(livePreview, /async function mountSharedFilePreview\(toolId, files, host\)/,
  'a generic shared preview fallback must exist');
assert.match(livePreview, /if\s*\(!SUPPORTED\.has\(toolId\)\)\s*\{[\s\S]*?await mountSharedFilePreview\(toolId, files, host\)/,
  'tools without a dedicated rich renderer must use the shared fallback');
assert.match(livePreview, /data-obj-url/,
  'shared image previews must mark object URLs for cleanup');
assert.match(livePreview, /PdfPreview\.renderPage\(pdfDoc, 1, 180, 0\)/,
  'shared PDF preview should attempt a real first-page thumbnail');

assert.match(toolPage, /const hasPrimaryLivePreview = !!\([\s\S]*?window\.LivePreview\.supported\(tool\.id\)/,
  'preview step must select the shared preview when eligible');
assert.ok(toolPage.includes("${hasPrimaryLivePreview ? '' : `") && toolPage.includes('id="files-list"'),
  'legacy selected-files card must be conditionally rendered, not duplicated with shared preview');
assert.match(toolPage, /if \(hasPrimaryLivePreview && window\.LivePreview && window\.LivePreview\.supported\(tool\.id\)/,
  'preview mount must be gated to avoid duplicating specialized editors');
assert.ok(styles.includes('/* Shared post-upload preview fallback'),
  'responsive shared-preview styles must be present');

const specialUploadPages = [
  { file: 'public/image-compressor.html', markers: ['ic-dropzone', 'ic-preview-wrap', 'lp-shared-preview', 'renderSelectedImagePreview'] },
  { file: 'public/image-converter.html', markers: ['iconv-dropzone', 'lp-shared-file-card', 'lp-shared-image', 'imagePreviewUrls'] },
  { file: 'public/zip-builder.html', markers: ['zip-dropzone', 'zip-file-list', 'lp-shared-file-card', 'lp-shared-file-art'] },
];
for (const page of specialUploadPages) {
  const html = read(page.file);
  assert.ok(html.includes('/js/special-upload-flow.js'), page.file + ' must use the shared special upload flow');
  for (const marker of page.markers) assert.ok(html.includes(marker), page.file + ' missing ' + marker);
}

console.log('PASS: shared post-upload preview source regression checks');
console.log('PASS: ' + uploadTools.length + ' upload-enabled tool definitions covered (' + declaredSet.size + ' registered)');
console.log('PASS: shared generic fallback, PDF thumbnail path, object-URL cleanup, legacy-card gating, and responsive styles');
console.log('PASS: 3 standalone upload pages use shared preview styling while retaining their specialized workflows');
console.log('Upload tools: ' + uploadTools.map((tool) => tool.id).join(', '));

import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (path) => fs.readFileSync(path, 'utf8');
const tool = read('public/js/tool-page.js');
const preview = read('public/js/shared-file-preview.js');
const loader = read('public/js/tool-page-loader.js');
const css = read('public/css/styles.css');
const html = read('public/tool.html');
const chrome = read('public/js/chrome.js');
const specialFlow = read('public/js/special-upload-flow.js');
const imageCompressor = read('public/image-compressor.html');
const imageConverter = read('public/image-converter.html');
const zipBuilder = read('public/zip-builder.html');
const config = read('public/js/tools-config.js');

assert.ok(preview.includes('window.SharedFilePreview'), 'shared file preview module must export its API');
assert.ok(preview.includes('cleanupDetachedHosts') && preview.includes('cleanupAll: cleanupAll') && preview.includes('unmount: unmount'), 'shared preview must clean up detached hosts and object URLs');
assert.ok(preview.includes('var TOOL_IDS = new Set([') && preview.includes('supported: function (toolId) { return TOOL_IDS.has(toolId); }'), 'shared preview must declare the upload-tool inventory');
assert.ok(preview.includes('data-shared-remove'), 'shared preview must expose per-file removal');
assert.ok(preview.includes('window.removeFile'), 'removal must synchronize with the tool state');
assert.ok(preview.includes('window.moveSharedPreviewFile'), 'Merge ordering must synchronize with the tool state');
assert.ok(preview.includes('data-shared-add-input'), 'multi-file tools must expose an add-files input');
assert.ok(preview.includes('renderPdfThumbnails(items, host, token)'), 'PDF thumbnails must render asynchronously');
assert.ok(preview.includes("wrap.className = 'lp-shared-image-wrap'"), 'PDF thumbnails must remain constrained inside the fixed thumbnail wrapper');
assert.ok(preview.includes('/\\.pdf$/i'), 'PDF extension detection must match a normal .pdf filename');
assert.ok(preview.includes('Your files are ready'), 'shared preview heading must be present');
assert.ok(preview.includes('Ready to process'), 'file readiness status must be present');

assert.ok(tool.includes('id="shared-file-preview-host"'), 'standard tool preview must include the shared host');
assert.ok(tool.includes('function mountSharedFilePreview(tool)'), 'tool page must mount the shared preview');
assert.ok(tool.includes('function refreshSharedFilePreview()'), 'file list changes must refresh the shared preview');
assert.ok(tool.includes('function moveSharedPreviewFile(fromIndex, toIndex)'), 'Merge file order must be keyboard/button accessible');
assert.ok(tool.includes('scheduleToolEngineWarmup(tool);'), 'processor warm-up must happen after the preview shell renders');
assert.ok(tool.includes('function loadToolPreviewDependencies(tool)') && tool.includes('getToolPreviewDependencyUrls(tool)'), 'optional preview dependencies must load after selection');
assert.ok(tool.includes("await loadToolUiScript('/js/browser-tools.js')"), 'validation helper must be available before processing starts');
assert.ok(!tool.includes('await Promise.all([engineWarm, previewWarm])'), 'preview must not wait for processor/PDF.js warm-up');
assert.ok(tool.includes('mountSharedFilePreview(tool);'), 'preview renderer must mount after the preview shell is created');
assert.ok(tool.includes('ew-file-section--legacy'), 'legacy selected-file UI must be gated');
assert.ok(!tool.includes('window.LivePreview.mount'), 'legacy preview renderer must not overwrite the shared preview');
assert.ok(tool.includes('function removeFile(index)'), 'file removal workflow must remain present');
assert.ok(tool.includes("ilovepdf:tool-critical-ready") && tool.includes('function bootToolPage()'), 'tool page must initialize even if its lazy script graph finishes after DOMContentLoaded');

assert.ok(loader.includes('tool-page.js?v=20261016-shared-preview-v1'), 'tool page script cache key must be refreshed');
assert.ok(loader.includes("return ['/js/runtime-tool-code-loader.js'];"), 'page-open dependency graph must remain lightweight');
assert.ok(!loader.includes('live-preview.js') && !loader.includes('page-organizer.js') && !loader.includes('pdf-preview.js'), 'legacy preview, PDF and organizer modules must not load on page open');
assert.ok(loader.includes('/js/tool-i18n-bridge.js'), 'tool i18n bridge must be included in the lazy shell sequence');
assert.ok(!loader.includes('home-footer-v2.css'), 'tool workspace must not download marketing footer CSS');
assert.ok(!loader.includes('footer-lang.js'), 'tool workspace must not load footer-only language code');
assert.ok(html.includes('class="site-header"'), 'shared site header must remain on tool pages');
assert.ok(chrome.includes('main#tool-content.tool-page, .ilpdf-special-dropzone'), 'shared chrome must detect standard and standalone upload workspaces');
assert.ok(chrome.includes('window.__ILOVE_SHARED_FOOTER_SUPPRESSED = isToolWorkspace'), 'shared chrome must suppress the footer on tool pages');
assert.ok(chrome.includes('function startSharedChrome()') && chrome.includes("document.readyState === 'loading'"), 'shared chrome must boot whether loaded before or after DOMContentLoaded');
assert.ok(!html.includes('<footer class="footer">'), 'marketing footer markup must be absent from tool workspaces');
assert.ok(specialFlow.includes('mountPreview:mountPreview'), 'standalone upload pages must be able to lazy-load the shared preview');
assert.ok(imageCompressor.includes('id="ic-shared-preview-host"') && imageCompressor.includes("mountPreview('image-compressor'"), 'Image Compressor must use shared preview cards');
assert.ok(imageConverter.includes('id="iconv-shared-preview-host"') && imageConverter.includes("mountPreview('image-converter'"), 'Image Converter must use shared preview cards');
assert.ok(zipBuilder.includes('id="zip-shared-preview-host"') && zipBuilder.includes("mountPreview('zip-builder'"), 'ZIP Builder must use shared preview cards');
assert.ok(html.includes('styles.css?v=20261016-shared-preview-v1'), 'shared preview CSS cache key must be refreshed');

assert.ok(css.includes('.shared-file-preview-host') && css.includes('position: sticky'), 'shared preview host must be sticky on larger screens');
assert.ok(css.includes('.lp-shared-file-list') && css.includes('overflow-y: auto'), 'only the document list must scroll inside the preview');
assert.ok(css.includes('max-height: min(46vh, 430px)'), 'document list must be height-constrained');
assert.ok(css.includes('overflow-wrap: anywhere'), 'long filenames must not overflow');
assert.ok(css.includes('min-width: 0'), 'grid/flex children must be allowed to shrink');
assert.ok(css.includes('@media (max-width: 900px)'), 'tablet layout breakpoint must exist');
assert.ok(css.includes('@media (max-width: 560px)'), 'mobile layout breakpoint must exist');
assert.ok(css.includes('.ew-file-section--legacy.ew-file-section--organizer-active'), 'PageOrganizer compatibility must remain visible');
assert.ok(css.includes('body.has-shared-file-preview #iconv-queue') && css.includes('body.has-shared-file-preview #zip-files-ul'), 'standalone routes must hide their legacy duplicate file lists');
const blocks = config.split(/\n  \{\n/);
const configured = new Set();
for (const block of blocks) {
  if (!/acceptedFiles\s*:/.test(block)) continue;
  const id = block.match(/id\s*:\s*['"]([^'"]+)['"]/);
  if (id) configured.add(id[1]);
}
const inventory = preview.match(/var TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(inventory, 'shared preview must declare its upload-tool inventory');
const declared = [...inventory[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
assert.equal(new Set(declared).size, declared.length, 'shared preview inventory must not contain duplicate tool IDs');
assert.deepEqual([...configured].filter((id) => !declared.includes(id)).sort(), [], 'every configured upload tool must be covered by shared preview');
assert.deepEqual(declared.filter((id) => !configured.has(id)).sort(), [], 'shared preview must not claim an unknown standard-shell tool');
assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, 'CSS braces must be balanced');

console.log('Shared post-upload preview regression checks passed.');

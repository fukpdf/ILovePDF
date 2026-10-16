import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (path) => fs.readFileSync(path, 'utf8');
const tool = read('public/js/tool-page.js');
const preview = read('public/js/shared-file-preview.js');
const loader = read('public/js/tool-page-loader.js');
const css = read('public/css/styles.css');
const html = read('public/tool.html');

assert.ok(preview.includes('window.SharedFilePreview'), 'shared file preview module must export its API');
assert.ok(preview.includes('supported: function () { return true; }'), 'shared preview must be reusable by every standard-shell tool');
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
assert.ok(!tool.includes('await Promise.all([engineWarm, previewWarm])'), 'preview must not wait for processor/PDF.js warm-up');
assert.ok(tool.includes('mountSharedFilePreview(tool);'), 'preview renderer must mount after the preview shell is created');
assert.ok(tool.includes('ew-file-section--legacy'), 'legacy selected-file UI must be gated');
assert.ok(tool.includes('window.LivePreview.mount'), 'existing specialized preview renderers must remain available');
assert.ok(tool.includes('function removeFile(index)'), 'file removal workflow must remain present');

assert.ok(loader.includes('tool-page.js?v=20261016-shared-preview-v1'), 'tool page script cache key must be refreshed');
assert.ok(!loader.includes('home-footer-v2.css'), 'tool workspace must not download marketing footer CSS');
assert.ok(html.includes('class="site-header"'), 'shared site header must remain on tool pages');
const chrome = read('public/js/chrome.js');
assert.ok(chrome.includes("document.querySelector('main#tool-content.tool-page')"), 'shared chrome must detect the tool workspace');
assert.ok(chrome.includes('window.__ILOVE_SHARED_FOOTER_SUPPRESSED = isToolWorkspace'), 'shared chrome must suppress the footer on tool pages');
assert.ok(!html.includes('<footer class="footer">'), 'marketing footer markup must be absent from tool workspaces');
assert.ok(html.includes('styles.css?v=20261016-shared-preview-v1'), 'shared preview CSS cache key must be refreshed');

assert.ok(css.includes('.shared-file-preview-host') && css.includes('position: sticky'), 'shared preview host must be sticky on larger screens');
assert.ok(css.includes('.lp-shared-file-list') && css.includes('overflow-y: auto'), 'only the document list must scroll inside the preview');
assert.ok(css.includes('max-height: min(46vh, 430px)'), 'document list must be height-constrained');
assert.ok(css.includes('overflow-wrap: anywhere'), 'long filenames must not overflow');
assert.ok(css.includes('min-width: 0'), 'grid/flex children must be allowed to shrink');
assert.ok(css.includes('@media (max-width: 900px)'), 'tablet layout breakpoint must exist');
assert.ok(css.includes('@media (max-width: 560px)'), 'mobile layout breakpoint must exist');
assert.ok(css.includes('.ew-file-section--legacy.ew-file-section--organizer-active'), 'PageOrganizer compatibility must remain visible');
assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, 'CSS braces must be balanced');

console.log('Shared post-upload preview regression checks passed.');

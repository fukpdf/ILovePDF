import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const preview = read('public/js/shared-file-preview.js');
const toolPage = read('public/js/tool-page.js');
const loader = read('public/js/tool-page-loader.js');
const chrome = read('public/js/chrome.js');
const html = read('public/tool.html');
const css = read('public/css/styles.css');
const config = read('public/js/tools-config.js');

assert.match(preview, /window\.SharedFilePreview\s*=/, 'shared renderer must expose a public API');
assert.match(preview, /function hydratePdfThumbnails/, 'PDF thumbnails must hydrate asynchronously');
assert.match(preview, /window\.handleFiles\(input\.files\)/, 'Add more files must use the existing file-state pipeline');
assert.match(preview, /window\.removeFile\(index\)/, 'file removal must use the existing file-state pipeline');
assert.match(preview, /window\.moveMergePreviewFile/, 'Merge ordering controls must use the real selected-file state');
assert.ok(preview.includes('/\\.pdf$/i'), 'PDF detection must use a valid extension expression');
assert.match(toolPage, /loadSharedFilePreviewModule\(\)/, 'the shared preview must load after file selection');
assert.match(toolPage, /id="shared-file-preview-host"/, 'preview workspace must provide a shared mount host');
assert.match(toolPage, /function refreshSharedFilePreview\(\)/, 'selected file changes must refresh the shared cards');
assert.match(toolPage, /function moveMergePreviewFile\(/, 'Merge must preserve actual file order');
assert.match(toolPage, /_processPreparing = true/, 'Process must guard dependency preparation against duplicate taps');
assert.match(toolPage, /await window\.RuntimeToolCodeLoader\.load\(requestedToolId\)/, 'active processor runtime must load only after Process is clicked');
assert.match(toolPage, /function toolUiGlobalReady\(src\)/, 'dependency loading must handle already-loaded scripts without hanging');
assert.ok(!/window\.LivePreview\.mount\(tool\.id/.test(toolPage), 'legacy per-tool preview must not overwrite the shared preview');
assert.match(loader, /function relatedScripts\(\)\s*\{\s*return \['\/js\/runtime-tool-code-loader\.js'\];/s,
  'page-open loader must not fetch tool preview/processor modules');
assert.ok(!loader.includes('/css/home-footer-v2.css'), 'tool shell must not load marketing footer CSS');
assert.ok(!loader.includes('/js/footer-lang.js'), 'tool shell must not load footer-only language code');
assert.match(chrome, /const isToolWorkspace = !!document\.getElementById\('tool-content'\)/,
  'shared shell must detect tool workspace pages');
assert.match(chrome, /if \(isToolWorkspace\) \{[\s\S]*marketing footer[\s\S]*return null;/,
  'tool workspaces must keep the shared header but omit the footer');
assert.ok(!html.includes('<footer class="footer">'), 'tool.html must not contain a marketing footer');
assert.match(css, /\.ew-preview-page \.ew-preview-main\s*\{[^}]*position:sticky/s,
  'preview column must remain sticky under the shared header');
assert.match(css, /\.lp-shared-file-list\s*\{[^}]*overflow-y:auto/s,
  'only the selected-document list should scroll inside the preview panel');
assert.match(css, /overflow-wrap:anywhere/, 'long file names must not overflow cards');
assert.match(css, /@media \(max-width:560px\)/, 'mobile preview layout must be defined');
assert.match(css, /@media \(max-width:360px\)/, 'narrow mobile preview layout must be defined');

const blocks = config.split(/\n  \{\n/);
const configured = new Set();
for (const block of blocks) {
  if (!/acceptedFiles\s*:/.test(block)) continue;
  const id = block.match(/id\s*:\s*['"]([^'"]+)['"]/);
  if (id) configured.add(id[1]);
}
const inventory = preview.match(/var TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(inventory, 'shared preview must declare its tool inventory');
const declared = [...inventory[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const declaredSet = new Set(declared);
assert.equal(declaredSet.size, declared.length, 'shared preview inventory must not contain duplicate tool IDs');
assert.deepEqual([...configured].filter((id) => !declaredSet.has(id)).sort(), [],
  'every configured upload tool must be covered by the shared preview');
assert.deepEqual([...declaredSet].filter((id) => !configured.has(id)).sort(), [],
  'shared preview must not claim tools without an upload contract');

console.log('PASS: shared preview source, responsive/sticky layout, tool inventory, and footer-free tool shell');

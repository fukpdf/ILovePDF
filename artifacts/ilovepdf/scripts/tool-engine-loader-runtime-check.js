#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaderSource = readFileSync(path.join(root, 'public/js/tool-engine-loader.js'), 'utf8');

function createHarness() {
  const scripts = [];
  const preloads = [];
  const document = {
    head: {
      appendChild(element) {
        if (element.tagName === 'script') {
          scripts.push(element);
          if (typeof element.onload === 'function') element.onload();
        } else if (element.rel === 'preload') {
          preloads.push(element);
          if (typeof element.onload === 'function') element.onload();
        }
        return element;
      },
    },
    createElement(tagName) {
      return {
        tagName: String(tagName).toLowerCase(),
        dataset: {},
        remove() {
          const index = scripts.indexOf(this);
          if (index >= 0) scripts.splice(index, 1);
        },
      };
    },
    querySelector(selector) {
      const match = selector.match(/^script\\[src="([^"]+)"\\]$/);
      return match ? scripts.find((script) => script.src === match[1]) || null : null;
    },
  };
  const window = {};
  vm.runInNewContext(loaderSource, { window, document, console }, {
    filename: 'tool-engine-loader.js',
  });
  return { window, scripts, preloads };
}

function pass(label, assertion) {
  assertion();
  console.log('PASS ' + label);
}

async function main() {
  const harness = createHarness();
  const loader = harness.window.ToolEngineLoader;
  assert.ok(loader, 'ToolEngineLoader should register');

  await loader.preparePreview('compress');
  pass('compression preview loads only its preview module', () => {
    assert.deepEqual(Array.from(loader.getLoadedScripts()), ['/js/pdf-preview.js']);
  });

  await loader.prepareEngine('compress');
  const compressScripts = loader.getLoadedScripts();
  pass('compression engine excludes unrelated advanced, translation, and Word fidelity bundles', () => {
    assert.ok(compressScripts.includes('/js/browser-tools.js'));
    assert.ok(!compressScripts.includes('/js/advanced-engine.js'));
    assert.ok(!compressScripts.some((src) => src.includes('universal-translation') || src.includes('encoding-repair') || src.includes('ocr-cleanup')));
    assert.ok(!compressScripts.some((src) => src.includes('/js/pdf-pipeline/')));
  });

  await loader.prepareEngine('translate');
  const translationScripts = loader.getLoadedScripts();
  pass('translation loads its required advanced and translation modules only when selected', () => {
    assert.ok(translationScripts.includes('/js/advanced-engine.js'));
    assert.ok(translationScripts.includes('/js/universal-translation-pipeline.js'));
    assert.ok(translationScripts.includes('/js/global-multilingual-renderer.js'));
    assert.ok(!translationScripts.some((src) => src.includes('/js/pdf-pipeline/')));
  });

  await loader.preparePreview('translate');
  const previewScripts = loader.getLoadedScripts();
  pass('translation preview modules are loaded on demand for the selected tool', () => {
    assert.ok(previewScripts.includes('/js/pdf-preview.js'));
    assert.ok(previewScripts.includes('/js/live-preview.js'));
    assert.ok(previewScripts.includes('/js/page-organizer.js'));
  });

  await loader.prepareEngine('pdf-to-word');
  const wordScripts = loader.getLoadedScripts();
  pass('PDF-to-Word alone adds its ordered fidelity pipeline', () => {
    const ordered = [
      '/js/pdf-pipeline/font-mapper.js',
      '/js/pdf-pipeline/column-engine.js',
      '/js/pdf-pipeline/form-reconstruction.js',
      '/js/pdf-pipeline/fidelity-validator.js',
      '/js/pdf-pipeline/visual-reconstruction.js',
      '/js/pdf-pipeline/ocr-zoning.js',
      '/js/pdf-pipeline/image-anchor-engine.js',
      '/js/pdf-pipeline/layout-graph.js',
      '/js/pdf-pipeline/docx-coordinate-engine.js',
      '/js/pdf-pipeline/fidelity-debug.js',
    ];
    assert.ok(ordered.every((src) => wordScripts.includes(src)));
    assert.deepEqual(ordered.map((src) => wordScripts.indexOf(src)), ordered.map((_, index) => wordScripts.indexOf(ordered[0]) + index));
  });

  const beforeMerge = harness.scripts.filter((script) => script.src === '/js/advanced-engine.js').length;
  await Promise.all([loader.prepareEngine('merge'), loader.prepareEngine('merge')]);
  const afterMerge = harness.scripts.filter((script) => script.src === '/js/advanced-engine.js').length;
  pass('concurrent preparation shares promises and never injects duplicate scripts', () => {
    assert.equal(beforeMerge, 1);
    assert.equal(afterMerge, 1);
    const srcs = harness.scripts.map((script) => script.src);
    assert.equal(srcs.length, new Set(srcs).size);
  });

  console.log('INFO runtime loader checks: 6 passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

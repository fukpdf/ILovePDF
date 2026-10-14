#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'public/js/runtime-performance-monitor.js'), 'utf8');
const layoutEntries = [
  {
    value: 0.12,
    startTime: 143,
    hadRecentInput: false,
    sources: [{
      node: { tagName: 'DIV', id: 'tool-content', className: 'tool-page upload-shell', getAttribute: () => null },
      previousRect: { x: 0, y: 68, width: 390, height: 620, top: 68, right: 390, bottom: 688, left: 0 },
      currentRect: { x: 0, y: 100, width: 390, height: 620, top: 100, right: 390, bottom: 720, left: 0 },
    }],
  },
  {
    value: 0.5,
    startTime: 170,
    hadRecentInput: true,
    sources: [{
      node: { tagName: 'SECTION', id: 'preview', className: 'preview-panel', getAttribute: () => 'region' },
      previousRect: { x: 0, y: 0, width: 320, height: 200, top: 0, right: 320, bottom: 200, left: 0 },
      currentRect: { x: 0, y: 20, width: 320, height: 200, top: 20, right: 320, bottom: 220, left: 0 },
    }],
  },
];

class FakePerformanceObserver {
  constructor(callback) { this.callback = callback; }
  observe(options) {
    if (options.type === 'layout-shift') this.callback({ getEntries: () => layoutEntries });
  }
  disconnect() {}
}

const window = {
  PerformanceObserver: FakePerformanceObserver,
  performance: {
    getEntriesByType: () => [],
    getEntriesByName: () => [],
  },
  location: { pathname: '/tool.html' },
  addEventListener() {},
};
const document = { readyState: 'complete', addEventListener() {} };
vm.runInNewContext(source, { window, document, console, setInterval() {}, Date, Math });

const monitor = window.RuntimePerformanceMonitor;
assert.ok(monitor, 'monitor must register');
const report = monitor.getReport();
assert.equal(report.vitals.cls, 0.12, 'only shifts without recent input contribute to CLS');
assert.equal(report.route, '/tool.html', 'report should identify the current route');
assert.equal(report.layoutShifts.length, 2, 'diagnostics should retain recent layout-shift entries');
assert.equal(report.layoutShifts[0].sources[0].node.id, 'tool-content', 'diagnostics should identify the moved DOM node');
assert.equal(report.layoutShifts[0].sources[0].node.className, 'tool-page upload-shell', 'diagnostics should expose classes without collecting page text');
assert.equal(report.layoutShifts[0].sources[0].previousRect.y, 68, 'diagnostics should capture previous geometry');
assert.equal(report.layoutShifts[0].sources[0].currentRect.y, 100, 'diagnostics should capture current geometry');
assert.equal(report.layoutShifts[1].hadRecentInput, true, 'input-triggered shifts should be marked separately');
assert.equal(monitor.getLayoutShiftDiagnostics().length, 2, 'dedicated diagnostics API should be available');
console.log('PASS layout-shift attribution captures source nodes and geometry');
console.log('PASS CLS excludes shifts with recent user input');
console.log('PASS diagnostics include route and do not collect node text');

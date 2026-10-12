#!/usr/bin/env node
import { chromium } from 'playwright';


function makeMinimalPdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 4 >>\nstream\nq Q\nendstream\nendobj\n'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += 'xref\n0 5\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
  return Buffer.from(pdf, 'utf8');
}

const BASE = process.env.TOOL_PAGE_BASE_URL || 'http://127.0.0.1:4173/';
const failures = [];
const pass = message => console.log('PASS:', message);
const fail = message => { failures.push(message); console.error('FAIL:', message); };

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  for (const route of ['/compress-pdf', '/merge-pdf', '/compress-pdf/preview', '/compress-pdf/download']) {
    try {
      await page.goto(new URL(route, BASE).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#upload-area', { state: 'visible', timeout: 20000 });
      const result = await page.evaluate(() => ({
        title: document.title,
        header: !!document.querySelector('.site-header'),
        footer: !!document.querySelector('.footer'),
        fileInput: !!document.querySelector('#file-input'),
        uploadArea: !!document.querySelector('#upload-area'),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        toolContentText: (document.querySelector('#tool-content')?.innerText || '').trim().slice(0, 120)
      }));
      if (!result.header) fail(route + ': shared header missing');
      if (!result.footer) fail(route + ': shared footer missing');
      if (!result.fileInput || !result.uploadArea) fail(route + ': upload UI did not initialize');
      if (result.horizontalOverflow) fail(route + ': horizontal overflow at 390px viewport');
      if (!result.toolContentText) fail(route + ': tool content is empty');
      if (![result.header, result.footer, result.fileInput, result.uploadArea, !result.horizontalOverflow, !!result.toolContentText].includes(false)) {
        pass(route + ': shared shell and upload flow rendered');
      }
    } catch (error) {
      fail(route + ': ' + (error?.message || String(error)));
    }
  }

  await page.goto(new URL('/compress-pdf', BASE).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#upload-area', { state: 'visible', timeout: 20000 });
  await page.locator('#file-input').setInputFiles({
    name: 'render-smoke.pdf',
    mimeType: 'application/pdf',
    buffer: makeMinimalPdf()
  });
  await page.waitForSelector('#compress-preview-host', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const host = document.querySelector('#compress-preview-host');
    const process = document.querySelector('#process-btn');
    return !!host && !!process && !!host.querySelector('canvas');
  }, null, { timeout: 20000 });
  const uploadPreview = await page.evaluate(() => ({
    previewHost: !!document.querySelector('#compress-preview-host'),
    filenameVisible: (document.querySelector('#compress-preview-host')?.textContent || '').includes('render-smoke.pdf'),
    processButtonVisible: !!document.querySelector('#process-btn') && getComputedStyle(document.querySelector('#process-btn')).display !== 'none',
    processButtonEnabled: !!document.querySelector('#process-btn') && !document.querySelector('#process-btn').disabled,
    previewCanvas: !!document.querySelector('#compress-preview-host canvas')
  }));
  if (!uploadPreview.previewHost || !uploadPreview.filenameVisible || !uploadPreview.previewCanvas || !uploadPreview.processButtonVisible || !uploadPreview.processButtonEnabled) {
    fail('valid PDF selection did not reach a usable compression preview: ' + JSON.stringify(uploadPreview));
  } else {
    pass('valid PDF upload reaches compression preview with enabled process button; canvas=' + uploadPreview.previewCanvas);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(new URL('/compress-pdf', BASE).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#upload-area', { state: 'visible', timeout: 20000 });
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (desktopOverflow) fail('compress-pdf: horizontal overflow at 1280px viewport');
  else pass('compress-pdf: no horizontal overflow at 1280px viewport');

  if (pageErrors.length) {
    fail('uncaught browser errors: ' + pageErrors.slice(0, 5).join(' | '));
  } else {
    pass('no uncaught browser page errors');
  }

  await context.close();
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('Tool-page browser smoke test failed with ' + failures.length + ' issue(s).');
  process.exit(1);
}
console.log('Tool-page browser smoke test passed.');

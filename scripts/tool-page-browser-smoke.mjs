#!/usr/bin/env node
import { chromium } from 'playwright';

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

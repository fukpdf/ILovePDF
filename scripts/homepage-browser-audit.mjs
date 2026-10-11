#!/usr/bin/env node
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.HOMEPAGE_BASE_URL || 'http://127.0.0.1:4173/';
const WIDTHS = [320, 360, 375, 390, 414, 430, 600, 768, 820, 1024, 1280, 1366, 1440, 1600, 1920];
const failures = [];
const pageErrors = [];
const failedLocalAssets = [];
const report = (message) => console.log('PASS:', message);
const fail = (message) => { failures.push(message); console.error('FAIL:', message); };

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => {
    try {
      const url = new URL(request.url());
      if (url.origin === new URL(BASE).origin && /\/(js|css|core|laba|assets|images|fonts|locales)\//.test(url.pathname)) {
        failedLocalAssets.push(url.pathname + ' (' + (request.failure()?.errorText || 'request failed') + ')');
      }
    } catch {}
  });

  const response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!response || response.status() !== 200) fail('homepage did not return HTTP 200');
  await page.waitForFunction(() => document.querySelectorAll('a.tool').length >= 30, null, { timeout: 30000 })
    .catch(() => fail('homepage tool cards did not render within 30 seconds'));

  const initial = await page.evaluate(() => ({
    title: document.title,
    h1Count: document.querySelectorAll('h1').length,
    cards: [...document.querySelectorAll('a.tool')].map(a => ({
      text: (a.innerText || a.getAttribute('aria-label') || '').trim(),
      href: a.getAttribute('href'),
      icon: !!a.querySelector('svg, img, [data-icon]')
    })),
    header: !!document.querySelector('.site-header, header'),
    footer: !!document.querySelector('footer'),
    htmlWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  }));

  if (!initial.title.trim()) fail('homepage document title is empty');
  if (initial.h1Count < 1) fail('homepage has no H1 heading');
  if (!initial.header) fail('homepage header is missing');
  if (!initial.footer) fail('homepage footer is missing');
  if (initial.cards.length !== 41) fail('expected 41 rendered tool cards, found ' + initial.cards.length);
  const missingNames = initial.cards.filter(card => !card.text);
  if (missingNames.length) fail('tool cards with missing accessible text: ' + missingNames.length);
  const missingIcons = initial.cards.filter(card => !card.icon);
  if (missingIcons.length) {
    console.log('CARDS_WITHOUT_ICON_MARKUP: ' + missingIcons.map(card => card.text || '(unnamed)').join(' | '));
    fail('tool cards with missing visible icon markup: ' + missingIcons.length);
  }
  report('homepage rendered ' + initial.cards.length + ' cards with header/footer and a titled document');

  const seenHrefs = new Set();
  for (const card of initial.cards) {
    if (!card.href || card.href === '#') {
      fail('card has missing/placeholder href: ' + (card.text || '(unnamed)'));
      continue;
    }
    if (/^(https?:)?\/\//i.test(card.href)) continue;
    const href = new URL(card.href, BASE);
    if (href.origin !== new URL(BASE).origin) continue;
    seenHrefs.add(href.pathname + href.search);
  }
  for (const href of seenHrefs) {
    const result = await page.request.get(new URL(href, BASE).href, { timeout: 20000 }).catch(() => null);
    if (!result || result.status() < 200 || result.status() >= 400) {
      fail('homepage card route returned an unsuccessful response: ' + href + ' (' + (result?.status() ?? 'request failed') + ')');
    }
  }
  report('validated ' + seenHrefs.size + ' distinct internal card routes');

  // Check all required responsive widths for viewport overflow and clipped tool cards.
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(80);
    const layout = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const docWidth = document.documentElement.scrollWidth;
      const cards = [...document.querySelectorAll('a.tool')].map(element => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      });
      const outside = cards.filter(r => r.width <= 0 || r.left < -1 || r.right > vw + 1);
      let overlaps = 0;
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          const a = cards[i], b = cards[j];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps++;
        }
      }
      return { vw, docWidth, outside: outside.length, overlaps, cards: cards.length };
    });
    if (layout.docWidth > layout.vw + 1) fail(width + 'px: horizontal overflow (' + layout.docWidth + 'px document vs ' + layout.vw + 'px viewport)');
    if (layout.outside) fail(width + 'px: ' + layout.outside + ' tool cards outside viewport');
    if (layout.overlaps) fail(width + 'px: ' + layout.overlaps + ' overlapping tool-card pairs');
    console.log('VIEWPORT ' + width + 'px: ' + (layout.docWidth <= layout.vw + 1 && !layout.outside && !layout.overlaps ? 'PASS' : 'FAIL') +
      ' cards=' + layout.cards + ' documentWidth=' + layout.docWidth + ' overflowCards=' + layout.outside + ' overlaps=' + layout.overlaps);
  }

  // Automated accessibility audit; critical/serious violations block the check.
  await page.setViewportSize({ width: 1280, height: 900 });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const severe = axe.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious');
  console.log('ACCESSIBILITY: violations=' + axe.violations.length + ', criticalOrSerious=' + severe.length);
  for (const violation of severe) {
    fail('accessibility ' + violation.impact + ': ' + violation.id + ' — ' + violation.help + ' (' + violation.nodes.length + ' nodes)');
  }
  if (!severe.length) report('no critical/serious automated WCAG violations detected');

  if (pageErrors.length) pageErrors.forEach(error => fail('browser runtime error: ' + error));
  else report('no uncaught browser page errors');
  if (failedLocalAssets.length) [...new Set(failedLocalAssets)].forEach(asset => fail('failed local asset: ' + asset));
  else report('no failed same-origin static asset requests');

  console.log('BROWSER QA SUMMARY: widths=' + WIDTHS.length + ', cards=' + initial.cards.length +
    ', internalRoutes=' + seenHrefs.size + ', axeViolations=' + axe.violations.length +
    ', pageErrors=' + pageErrors.length + ', failedAssets=' + failedLocalAssets.length +
    ', failures=' + failures.length);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}

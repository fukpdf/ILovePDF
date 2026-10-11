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

  await page.addInitScript(() => {
    window.__homepageLabPerf = { lcp: null, cls: 0 };
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          window.__homepageLabPerf.lcp = Math.max(window.__homepageLabPerf.lcp || 0, entry.startTime);
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__homepageLabPerf.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
  });

  const response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!response || response.status() !== 200) fail('homepage did not return HTTP 200');
  await page.waitForFunction(() => document.querySelectorAll('a.tool').length >= 30, null, { timeout: 30000 })
    .catch(() => fail('homepage tool cards did not render within 30 seconds'));
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('a.tool')];
    return cards.length >= 41 && cards.every(card => card.querySelector('.tool-name-sticker, .tool-icon, svg, img, [data-icon], i[data-lucide]'));
  }, null, { timeout: 10000 }).catch(() => fail('homepage cards did not all expose icon markup after render stabilization'));

  const initial = await page.evaluate(() => ({
    title: document.title,
    h1Count: document.querySelectorAll('h1').length,
    cards: [...document.querySelectorAll('a.tool')].map(a => ({
      text: (a.innerText || a.getAttribute('aria-label') || '').trim(),
      href: a.getAttribute('href'),
      icon: (() => {
        const element = a.querySelector('.tool-name-sticker, .tool-icon, svg, img, [data-icon], i[data-lucide]');
        if (!element) return false;
        const style = getComputedStyle(element);
        const pseudo = getComputedStyle(element, '::before').content;
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          (element.childElementCount > 0 || !!element.textContent.trim() || (pseudo && pseudo !== 'none' && pseudo !== 'normal'));
      })()
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
    console.log('CARDS_WITHOUT_ICON_MARKUP: ' + missingIcons.slice(0, 10).map(card => card.text || '(unnamed)').join(' | '));
    fail('tool cards with missing visible icon markup: ' + missingIcons.length);
  }
  report('homepage rendered ' + initial.cards.length + ' cards with header/footer and a titled document');


  await page.waitForTimeout(250);
  const labMetrics = await page.evaluate(() => {
    const paints = performance.getEntriesByType('paint');
    const fcp = paints.find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null;
    const resources = performance.getEntriesByType('resource');
    const sameOrigin = resources.filter(entry => {
      try { return new URL(entry.name).origin === location.origin; } catch { return false; }
    });
    const scripts = sameOrigin.filter(entry => entry.initiatorType === 'script');
    const styles = sameOrigin.filter(entry => entry.name.split('?')[0].toLowerCase().endsWith('.css'));
    const bytes = entries => entries.reduce((total, entry) => total + (entry.encodedBodySize || 0), 0);
    return {
      fcp,
      lcp: window.__homepageLabPerf?.lcp ?? null,
      cls: window.__homepageLabPerf?.cls ?? null,
      requests: resources.length,
      scriptCount: scripts.length,
      scriptBytes: bytes(scripts),
      cssCount: styles.length,
      cssBytes: bytes(styles)
    };
  });
  const metricText = value => value === null || value === undefined ? 'NOT MEASURED' : Math.round(value) + 'ms';
  console.log('LAB PERFORMANCE (unthrottled local CI; not field CWV): FCP=' + metricText(labMetrics.fcp) +
    ', LCP=' + metricText(labMetrics.lcp) + ', CLS=' + (labMetrics.cls === null ? 'NOT MEASURED' : labMetrics.cls.toFixed(4)) +
    ', INP=NOT MEASURED, requests=' + labMetrics.requests + ', sameOriginScripts=' + labMetrics.scriptCount +
    ', scriptEncodedBytes=' + labMetrics.scriptBytes + ', cssFiles=' + labMetrics.cssCount + ', cssEncodedBytes=' + labMetrics.cssBytes);

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

  // Exercise mobile bottom navigation and desktop All Tools dropdown.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileNav = page.locator('#mobile-bottom-nav');
  if (!(await mobileNav.count()) || !(await mobileNav.isVisible())) {
    fail('mobile bottom navigation is missing or not visible at 390px');
  } else {
    const toolsButton = page.locator('#mobile-bottom-nav [data-action="tools"]');
    await toolsButton.click();
    const toolsOverlay = page.locator('#mobile-tools-overlay');
    const opened = (await toolsOverlay.getAttribute('aria-hidden')) === 'false' &&
      await toolsOverlay.evaluate(element => element.classList.contains('is-open'));
    if (!opened) fail('mobile Tools overlay did not open');
    else report('mobile Tools overlay opens and exposes its dialog state');
    await page.locator('#mobile-tools-overlay [data-close]').click();
    const closed = (await toolsOverlay.getAttribute('aria-hidden')) === 'true' &&
      !(await toolsOverlay.evaluate(element => element.classList.contains('is-open')));
    if (!closed) fail('mobile Tools overlay did not close');
    else report('mobile Tools overlay closes and restores its hidden state');
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  const allToolsButton = page.locator('#all-tools-btn');
  if (!(await allToolsButton.count()) || !(await allToolsButton.isVisible())) {
    fail('desktop All Tools navigation button is missing or not visible');
  } else {
    await allToolsButton.click();
    const expanded = (await allToolsButton.getAttribute('aria-expanded')) === 'true';
    if (!expanded) fail('desktop All Tools dropdown did not set aria-expanded=true');
    else report('desktop All Tools dropdown opens with correct ARIA state');
    await allToolsButton.click();
  }

  // Automated accessibility audit; critical/serious violations block the check.
  await page.setViewportSize({ width: 1280, height: 900 });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const severe = axe.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious');
  console.log('ACCESSIBILITY: violations=' + axe.violations.length + ', criticalOrSerious=' + severe.length);
  for (const violation of severe) {
    fail('accessibility ' + violation.impact + ': ' + violation.id + ' — ' + violation.help + ' (' + violation.nodes.length + ' nodes)');
    violation.nodes.forEach(node => console.log('A11Y_TARGET ' + node.target.join(' ') + ' | ' + (node.failureSummary || node.html).replace(/\\s+/g, ' ').slice(0, 320)));
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

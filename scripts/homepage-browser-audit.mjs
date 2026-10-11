#!/usr/bin/env node
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.HOMEPAGE_BASE_URL || 'http://127.0.0.1:4173/';
const WIDTHS = [320, 360, 375, 390, 414, 430, 600, 768, 820, 1024, 1280, 1366, 1440, 1600, 1920];
const failures = [];
const pageErrors = [];
const failedLocalAssets = [];
const labaRequests = [];
const toolOnlyRequests = [];
const report = (message) => console.log('PASS:', message);
const fail = (message) => { failures.push(message); console.error('FAIL:', message); };

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    try {
      const url = new URL(request.url());
      if (url.origin === new URL(BASE).origin && /\/core\/(?:core-manifest|shared-constants|runtime-contracts|runtime-federation|ai-runtime|runtime-governor|runtime-chunk-manifest)\.js$|\/js\/(?:tool-i18n-bridge|runtime-ai-scheduler|runtime-worker-factory|runtime-wasm-registry|runtime-compression-presets|runtime-pinned-tools|runtime-tool-engagement|runtime-failed-log)\.js$/i.test(url.pathname)) {
        toolOnlyRequests.push(url.pathname);
      }
      if (url.origin === new URL(BASE).origin && /(?:\/laba\/|\/js\/laba-|homepage-lazy-loader\.js)/i.test(url.pathname)) {
        labaRequests.push(url.pathname);
      }
    } catch {}
  });
  page.on('requestfailed', request => {
    try {
      const url = new URL(request.url());
      if (url.origin === new URL(BASE).origin && /\/(js|css|core|laba|assets|images|fonts|locales)\//.test(url.pathname)) {
        failedLocalAssets.push(url.pathname + ' (' + (request.failure()?.errorText || 'request failed') + ')');
      }
    } catch {}
  });

  await page.addInitScript(() => {
    window.__homepageLabPerf = { lcp: null, lcpElement: null, cls: 0, shifts: [] };
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          window.__homepageLabPerf.lcp = Math.max(window.__homepageLabPerf.lcp || 0, entry.startTime);
          const element = entry.element;
          if (element) window.__homepageLabPerf.lcpElement = {
            tag: element.tagName || '',
            id: element.id || '',
            className: typeof element.className === 'string' ? element.className : '',
            text: (element.textContent || '').trim().slice(0, 80)
          };
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__homepageLabPerf.cls += entry.value;
            const rect = value => value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
            const sources = (entry.sources || []).map(source => ({
              tag: source.node?.tagName || '',
              id: source.node?.id || '',
              className: typeof source.node?.className === 'string' ? source.node.className : '',
              text: (source.node?.textContent || '').trim().slice(0, 60),
              previous: rect(source.previousRect),
              current: rect(source.currentRect)
            }));
            window.__homepageLabPerf.shifts.push({ value: entry.value, sources });
          }
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

  // Observe the full idle window and verify the homepage never requests tool-only AI engines.
  await page.waitForTimeout(4500);
  const heavyStackLoaded = await page.evaluate(() => {
    const sentinels = ['/js/vector-memory-engine.js', '/js/generative-ai-engine.js', '/js/runtime-global-certification.js'];
    return performance.getEntriesByType('resource').map(entry => {
      try { return new URL(entry.name).pathname; } catch { return ''; }
    }).filter(path => sentinels.some(sentinel => path.endsWith(sentinel)));
  });
  if (heavyStackLoaded.length) fail('homepage auto-loaded heavy AI/Laba scripts without interaction: ' + heavyStackLoaded.join(', '));
  else report('heavy AI/processing stack remains unloaded during an idle homepage visit');

  const initial = await page.evaluate(() => ({
    title: document.title,
    h1Count: document.querySelectorAll('h1').length,
    ids: [...document.querySelectorAll('[id]')].map(element => element.id),
    links: [...document.querySelectorAll('a[href]')].map(a => ({
      href: a.getAttribute('href') || '',
      text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
      target: a.getAttribute('target') || '',
      rel: a.getAttribute('rel') || ''
    })),
    cards: [...document.querySelectorAll('a.tool')].map(a => ({
      text: (a.innerText || a.getAttribute('aria-label') || '').trim(),
      href: a.getAttribute('href'),
      title: (a.querySelector('.tool-name, .tool-title, h3, h4')?.textContent || '').trim(),
      description: (a.querySelector('.tool-desc, .tool-description, p')?.textContent || '').trim(),
      visible: (() => { const rect = a.getBoundingClientRect(); const style = getComputedStyle(a); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0; })(),
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
    labaUi: !!document.querySelector('#laba-widget-toggle, #laba-ai-chat-panel, .laba-toggle, .laba-fab, [data-laba]'),
    announcementUi: !!document.querySelector('#ilpdf-announcement-overlay'),
    htmlWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  }));

  if (!initial.title.trim()) fail('homepage document title is empty');
  if (initial.h1Count < 1) fail('homepage has no H1 heading');
  if (!initial.header) fail('homepage header is missing');
  if (!initial.footer) fail('homepage footer is missing');
  if (initial.labaUi || labaRequests.length) fail('Laba UI or assets are still present: UI=' + initial.labaUi + ', requests=' + [...new Set(labaRequests)].join(', '));
  else report('no Laba widget UI or Laba asset requests on homepage');
  if (toolOnlyRequests.length) fail('tool-only runtime scripts requested by homepage: ' + [...new Set(toolOnlyRequests)].join(', '));
  else report('no tool-only runtime/federation/worker scripts requested by homepage');
  if (initial.announcementUi) fail('delayed announcement overlay still appears on the homepage');
  else report('no delayed announcement overlay competes with the homepage first render');
  if (initial.cards.length !== 41) fail('expected 41 rendered tool cards, found ' + initial.cards.length);
  if (initial.h1Count !== 1) fail('homepage should have exactly one H1; found ' + initial.h1Count);
  const missingCardTitles = initial.cards.filter(card => !card.title);
  const missingCardDescriptions = initial.cards.filter(card => !card.description);
  if (missingCardTitles.length) fail('tool cards missing titles: ' + missingCardTitles.length);
  else report('all ' + initial.cards.length + ' tool cards have titles');
  if (missingCardDescriptions.length) fail('tool cards missing descriptions: ' + missingCardDescriptions.length + ' (' + missingCardDescriptions.slice(0, 8).map(card => card.title || card.text).join(' | ') + ')');
  else report('all ' + initial.cards.length + ' tool cards have descriptions');

  const emptyLinks = initial.links.filter(link => !link.href.trim());
  const placeholderLinks = initial.links.filter(link => link.href.trim() === '#');
  const brokenHashLinks = initial.links.filter(link => link.href.startsWith('#') && link.href.length > 1 && !initial.ids.includes(link.href.slice(1)));
  const unsafeBlankLinks = initial.links.filter(link => link.target === '_blank' && !/\b(?:noopener|noreferrer)\b/i.test(link.rel));
  if (emptyLinks.length) fail('anchors without href values: ' + emptyLinks.length);
  if (placeholderLinks.length) fail('placeholder href="#" links found: ' + placeholderLinks.length + ' (' + placeholderLinks.slice(0, 8).map(link => link.text || '(unnamed)').join(' | ') + ')');
  if (brokenHashLinks.length) fail('hash links without matching targets: ' + brokenHashLinks.map(link => link.href).join(', '));
  if (unsafeBlankLinks.length) fail('target="_blank" links missing noopener/noreferrer: ' + unsafeBlankLinks.length);
  if (!emptyLinks.length && !placeholderLinks.length && !brokenHashLinks.length && !unsafeBlankLinks.length) report('all ' + initial.links.length + ' homepage anchors have usable targets and safe new-tab attributes');

  const internalLinkPaths = [...new Set(initial.links
    .map(link => link.href.trim())
    .filter(href => href.startsWith('/') && href !== '#' && !href.startsWith('//'))
    .map(href => href.split('#')[0]))]
    .filter(href => href && !/^\/(?:js|css|assets|images|img|fonts|locales|index-chunks)\//i.test(href));
  for (const href of internalLinkPaths) {
    const linkResponse = await page.request.get(new URL(href, BASE).href, { timeout: 15000 }).catch(() => null);
    if (!linkResponse || linkResponse.status() >= 400) fail('homepage internal link returned an unsuccessful response: ' + href);
  }
  report('checked ' + internalLinkPaths.length + ' unique internal navigation/footer destinations');

  const missingNames = initial.cards.filter(card => !card.text);
  if (missingNames.length) fail('tool cards with missing accessible text: ' + missingNames.length);
  const hiddenCards = initial.cards.filter(card => !card.visible);
  if (hiddenCards.length) fail('homepage contains hidden tool cards: ' + hiddenCards.length + ' (' + hiddenCards.slice(0, 8).map(card => card.text).join(' | ') + ')');
  const missingIcons = initial.cards.filter(card => !card.icon);
  if (missingIcons.length) {
    console.log('CARDS_WITHOUT_ICON_MARKUP: ' + missingIcons.slice(0, 10).map(card => card.text || '(unnamed)').join(' | '));
    fail('tool cards with missing visible icon markup: ' + missingIcons.length);
  }
  report('homepage rendered ' + initial.cards.length + ' cards with header/footer and a titled document');




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
      lcpElement: window.__homepageLabPerf?.lcpElement ?? null,
      cls: window.__homepageLabPerf?.cls ?? null,
      requests: resources.length,
      scriptCount: scripts.length,
      scriptBytes: bytes(scripts),
      cssCount: styles.length,
      cssBytes: bytes(styles),
      shifts: (window.__homepageLabPerf?.shifts || []).sort((a, b) => b.value - a.value).slice(0, 5)
    };
  });
  const metricText = value => value === null || value === undefined ? 'NOT MEASURED' : Math.round(value) + 'ms';
  console.log('LAB PERFORMANCE (unthrottled local CI; not field CWV): FCP=' + metricText(labMetrics.fcp) +
    ', LCP=' + metricText(labMetrics.lcp) + ', CLS=' + (labMetrics.cls === null ? 'NOT MEASURED' : labMetrics.cls.toFixed(4)) +
    ', INP=NOT MEASURED, requests=' + labMetrics.requests + ', sameOriginScripts=' + labMetrics.scriptCount +
    ', scriptEncodedBytes=' + labMetrics.scriptBytes + ', cssFiles=' + labMetrics.cssCount + ', cssEncodedBytes=' + labMetrics.cssBytes);
  console.log('LCP ELEMENT: ' + JSON.stringify(labMetrics.lcpElement));
  console.log('CLS SHIFT DETAILS: ' + JSON.stringify(labMetrics.shifts));

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
        const style = getComputedStyle(element);
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, visible: style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0 };
      });
      const outside = cards.filter(r => r.width <= 0 || r.left < -1 || r.right > vw + 1);
      const hidden = cards.filter(r => !r.visible).length;
      let overlaps = 0;
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          const a = cards[i], b = cards[j];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps++;
        }
      }
      return { vw, docWidth, outside: outside.length, hidden, overlaps, cards: cards.length };
    });
    if (layout.docWidth > layout.vw + 1) fail(width + 'px: horizontal overflow (' + layout.docWidth + 'px document vs ' + layout.vw + 'px viewport)');
    if (layout.outside) fail(width + 'px: ' + layout.outside + ' tool cards outside viewport');
    if (layout.hidden) fail(width + 'px: ' + layout.hidden + ' tool cards are hidden or have zero size');
    if (layout.overlaps) fail(width + 'px: ' + layout.overlaps + ' overlapping tool-card pairs');
    console.log('VIEWPORT ' + width + 'px: ' + (layout.docWidth <= layout.vw + 1 && !layout.outside && !layout.overlaps ? 'PASS' : 'FAIL') +
      ' cards=' + layout.cards + ' hidden=' + layout.hidden + ' documentWidth=' + layout.docWidth + ' overflowCards=' + layout.outside + ' overlaps=' + layout.overlaps);
  }

  // Verify the 140 KB extended locale bundle is requested only after a language change.
  const langButton = page.locator('#lang-btn');
  if (!(await langButton.count()) || !(await langButton.isVisible())) {
    fail('header language selector is missing');
  } else {
    await langButton.click();
    const urOption = page.locator('#lang-list [data-code="ur"]');
    if (!(await urOption.count())) {
      fail('Urdu option is missing from the language selector');
    } else {
      await urOption.click();
      await page.waitForFunction(() => window.RuntimeI18n && window.RuntimeI18n.getLanguage() === 'ur', null, { timeout: 10000 });
      const localeExtensionLoaded = await page.evaluate(() => !!window.__ILOVE_I18N_EXT_LOADED);
      if (!localeExtensionLoaded) fail('extended locale bundle was not loaded on explicit language change');
      await langButton.click();
      await page.locator('#lang-list [data-code="en"]').click();
      await page.waitForFunction(() => window.RuntimeI18n && window.RuntimeI18n.getLanguage() === 'en', null, { timeout: 10000 });
      report('language switching lazily loads extended locale data and returns to English');
    }
  }

  // Dismiss the intentional first-visit announcement modal before testing underlying navigation.
  const announcement = page.locator('#ilpdf-announcement-overlay');
  const announcementClose = page.locator('#ilpdf-announcement-overlay .ilpdf-announcement-close');
  if (await announcement.count() && await announcement.isVisible()) {
    await announcementClose.click();
    await announcement.waitFor({ state: 'detached', timeout: 5000 });
    report('first-visit announcement modal closes and releases pointer interaction');
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
    ', pageErrors=' + pageErrors.length + ', failedAssets=' + failedLocalAssets.length + ', labaRequests=' + labaRequests.length +
    ', failures=' + failures.length);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}

#!/usr/bin/env node
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.HOMEPAGE_BASE_URL || 'http://127.0.0.1:4173/';
// Dense width sweep catches breakpoint gaps that a few device presets miss.
const WIDTHS = [...new Set([
  ...Array.from({ length: 41 }, (_, index) => 320 + index * 40),
  360, 375, 390, 414, 430, 600, 768, 820, 1024, 1100, 1200, 1279, 1280,
  1281, 1366, 1440, 1600, 1920, 2048, 2560, 2880
])].sort((a, b) => a - b);
const HEIGHT_PROFILES = [
  [320, 568], [360, 640], [390, 844], [600, 800], [768, 1024],
  [820, 600], [1024, 600], [1024, 768], [1280, 720], [1366, 768],
  [1440, 900], [1600, 900], [1920, 1080], [2560, 1440]
];
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
    window.__homepageDomAudit = [];
    const describeNode = node => {
      if (!node || node.nodeType !== 1) return { nodeType: node?.nodeType || 0 };
      return {
        tag: node.tagName || '',
        id: node.id || '',
        className: typeof node.className === 'string' ? node.className : '',
        text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45),
        toolCards: node.querySelectorAll ? node.querySelectorAll('a.tool').length : 0
      };
    };
    const watchedNode = node => {
      if (!node || node.nodeType !== 1) return false;
      if (['tools-root','recent-use-section','cat-pdf-tools','cat-image-tools','cat-utilities'].includes(node.id)) return true;
      if (node.tagName === 'FOOTER') return true;
      return !!(node.classList?.contains('home-lower') || node.classList?.contains('home-cat-section') || node.classList?.contains('hls-blog-section') || node.classList?.contains('hls-viewall-wrap'));
    };
    const containsWatchedNode = node => watchedNode(node) ||
      !!node?.querySelector?.('#tools-root,#recent-use-section,#cat-pdf-tools,#cat-image-tools,#cat-utilities,footer.footer,.home-cat-section,.hls-blog-section,.hls-viewall-wrap');
    try {
      new MutationObserver(records => {
        for (const record of records) {
          const targetRelevant = watchedNode(record.target);
          const added = [...(record.addedNodes || [])].filter(containsWatchedNode).map(describeNode);
          const removed = [...(record.removedNodes || [])].filter(containsWatchedNode).map(describeNode);
          if (!targetRelevant && !added.length && !removed.length) continue;
          window.__homepageDomAudit.push({
            t: Math.round(performance.now()),
            type: record.type,
            target: describeNode(record.target),
            attribute: record.attributeName || '',
            oldValue: record.oldValue || '',
            newValue: record.attributeName && record.target.getAttribute ? record.target.getAttribute(record.attributeName) : '',
            added,
            removed
          });
          if (window.__homepageDomAudit.length > 120) window.__homepageDomAudit.shift();
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['style','hidden','class'] });
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
    const sentinels = ['/js/vector-memory-engine.js', '/js/generative-ai-engine.js', '/js/runtime-global-certification.js', '/js/pdf-lib', '/js/pdf-engine', '/js/merge-pdf', '/js/compress-pdf', '/js/ocr-engine', '/js/tesseract', '/wasm/', '/workers/'];
    return performance.getEntriesByType('resource').map(entry => {
      try { return new URL(entry.name).pathname; } catch { return ''; }
    }).filter(path => sentinels.some(sentinel => path.endsWith(sentinel)));
  });
  if (heavyStackLoaded.length) fail('homepage auto-loaded heavy AI/Laba scripts without interaction: ' + heavyStackLoaded.join(', '));
  else report('heavy AI/processing stack remains unloaded during an idle homepage visit');

  const loadInventory = await page.evaluate(() => ({
    htmlBytes: new TextEncoder().encode(document.documentElement.outerHTML).length,
    runtimeLoaderPresent: [...document.scripts].some(script => script.textContent.includes('DecompressionStream')),
    stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => ({ href: link.href, media: link.media || 'all', disabled: link.disabled })),
    inlineStyleBlocks: document.querySelectorAll('style').length,
    scripts: [...document.scripts].map(script => ({ src: script.src || '(inline)', defer: script.defer, async: script.async, type: script.type || 'classic' })),
    fontFaces: [...document.fonts].length,
    images: [...document.images].map(image => ({ src: image.currentSrc || image.src, loading: image.loading, width: image.naturalWidth, height: image.naturalHeight }))
  }));
  console.log('FIRST-RENDER INVENTORY: ' + JSON.stringify(loadInventory));
  console.log('HOMEPAGE DOM MUTATION TRACE: ' + JSON.stringify(await page.evaluate(() => window.__homepageDomAudit || [])));
  if (loadInventory.runtimeLoaderPresent) fail('served homepage still contains the runtime chunk/decompression loader');
  else report('served homepage is not using the four-chunk runtime document-replacement loader');

  const initial = await page.evaluate(() => ({
    title: document.title,
    preservedServerHeader: window.__ILOVE_PRESERVE_SERVER_HEADER === true,
    h1Count: document.querySelectorAll('h1').length,
    footerCount: document.querySelectorAll('footer.footer').length,
    footerAfterLower: (() => { const footer = document.querySelector('footer.footer'); const lower = document.querySelector('.home-lower'); return !footer || !lower || !!(lower.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING); })(),
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
  if (!initial.preservedServerHeader) fail('homepage did not preserve its server-rendered header at boot');
  else report('server-rendered homepage header is preserved at boot');
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
  if (labMetrics.cls !== null && labMetrics.cls > 0.1) fail('CLS exceeds the 0.1 target: ' + labMetrics.cls.toFixed(4));

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
      const overflowElements = [...document.querySelectorAll('body *')].map(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { tag: element.tagName, id: element.id || '', className: typeof element.className === 'string' ? element.className : '',
          left: Math.round(rect.left * 10) / 10, right: Math.round(rect.right * 10) / 10, width: Math.round(rect.width * 10) / 10,
          position: style.position, overflowX: style.overflowX };
      }).filter(item => item.width > 0 && (item.left < -1 || item.right > vw + 1))
        .sort((left, right) => (right.right - vw) - (left.right - vw)).slice(0, 8);
      const hidden = cards.filter(r => !r.visible).length;
      let overlaps = 0;
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          const a = cards[i], b = cards[j];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps++;
        }
      }
      const rootMetrics = {
        htmlClientWidth: document.documentElement.clientWidth,
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyRect: (() => { const r = document.body.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; })()
      };
      const pseudoOverflow = [...document.querySelectorAll('body, body *')].flatMap(element => ['::before', '::after'].map(pseudo => {
        const style = getComputedStyle(element, pseudo);
        const rect = element.getBoundingClientRect();
        const width = parseFloat(style.width);
        const left = style.position === 'fixed' ? (style.left === 'auto' ? rect.right - width : parseFloat(style.left)) : rect.left + (parseFloat(style.left) || 0);
        return { selector: (element.id ? '#' + element.id : element.tagName.toLowerCase() + (typeof element.className === 'string' && element.className.trim() ? '.' + element.className.trim().split(/\\s+/).join('.') : '')) + pseudo, content: style.content, position: style.position, left, right: left + width, width };
      })).filter(item => item.content !== 'none' && item.content !== 'normal' && item.width > 0 && (item.left < -1 || item.right > vw + 1)).slice(0, 8);
      const pageElement = document.querySelector('.page');
      const pageRect = pageElement?.getBoundingClientRect();
      const toolsGrid = document.querySelector('.tools-grid');
      const gridRect = toolsGrid?.getBoundingClientRect();
      const gridColumns = toolsGrid ? getComputedStyle(toolsGrid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length : 0;
      const expectedColumns = vw <= 768 ? 2 : 3 + (vw > 1280 ? 1 : 0);
      const viewportCoverage = {
        pageFound: !!pageElement,
        pageLeft: pageRect ? Math.round(pageRect.left * 10) / 10 : null,
        pageRight: pageRect ? Math.round(pageRect.right * 10) / 10 : null,
        pageWidth: pageRect ? Math.round(pageRect.width * 10) / 10 : null,
        gridFound: !!toolsGrid,
        gridWidth: gridRect ? Math.round(gridRect.width * 10) / 10 : null,
        gridCoverage: gridRect && vw ? Math.round(gridRect.width / vw * 1000) / 1000 : 0,
        gridColumns,
        expectedColumns
      };
      return { vw, docWidth, outside: outside.length, hidden, overlaps, cards: cards.length, overflowElements, rootMetrics, pseudoOverflow, viewportCoverage };
    });
    if (layout.docWidth > layout.vw + 1) fail(width + 'px: horizontal overflow (' + layout.docWidth + 'px document vs ' + layout.vw + 'px viewport); root=' + JSON.stringify(layout.rootMetrics) + '; offenders=' + JSON.stringify(layout.overflowElements) + '; pseudo=' + JSON.stringify(layout.pseudoOverflow));
    if (layout.outside) fail(width + 'px: ' + layout.outside + ' tool cards outside viewport');
    if (layout.hidden) fail(width + 'px: ' + layout.hidden + ' tool cards are hidden or have zero size');
    if (layout.overlaps) fail(width + 'px: ' + layout.overlaps + ' overlapping tool-card pairs');
    const coverage = layout.viewportCoverage;
    if (!coverage.pageFound || coverage.pageLeft > 1 || coverage.pageRight < layout.vw - 1 || coverage.pageWidth < layout.vw - 1) {
      fail(width + 'px: homepage page shell does not cover the viewport width: ' + JSON.stringify(coverage));
    }
    if (!coverage.gridFound || coverage.gridCoverage < (width <= 768 ? 0.80 : 0.60)) {
      fail(width + 'px: tool grid leaves too much unused horizontal space: ' + JSON.stringify(coverage));
    }
    if (coverage.gridColumns !== coverage.expectedColumns) {
      fail(width + 'px: expected ' + coverage.expectedColumns + ' responsive tool columns, got ' + coverage.gridColumns + ': ' + JSON.stringify(coverage));
    }
    const passed = layout.docWidth <= layout.vw + 1 && !layout.outside && !layout.hidden && !layout.overlaps &&
      coverage.pageFound && coverage.pageLeft <= 1 && coverage.pageRight >= layout.vw - 1 &&
      coverage.gridFound && coverage.gridCoverage >= (width <= 768 ? 0.80 : 0.60) &&
      coverage.gridColumns === coverage.expectedColumns;
    console.log('VIEWPORT ' + width + 'px: ' + (passed ? 'PASS' : 'FAIL') +
      ' cards=' + layout.cards + ' hidden=' + layout.hidden + ' documentWidth=' + layout.docWidth +
      ' overflowCards=' + layout.outside + ' overlaps=' + layout.overlaps + ' viewport=' + JSON.stringify(coverage));
  }

  // Height/width combinations exercise short laptop windows, tablet portrait,
  // mobile landscape/portrait, and ultrawide displays without assuming a
  // particular device. Content must stay inside the horizontal viewport;
  // vertical scrolling remains expected for a long homepage.
  for (const [width, height] of HEIGHT_PROFILES) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(40);
    const frame = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const pageShell = document.querySelector('.page')?.getBoundingClientRect();
      const header = document.querySelector('.site-header, header')?.getBoundingClientRect();
      const hero = document.querySelector('.hero')?.getBoundingClientRect();
      const heroText = document.querySelector('.hero h1, .hero-text')?.getBoundingClientRect();
      return {
        vw, vh,
        documentWidth: document.documentElement.scrollWidth,
        pageShell: pageShell ? { left: pageShell.left, right: pageShell.right, width: pageShell.width } : null,
        header: header ? { left: header.left, right: header.right, top: header.top, bottom: header.bottom, width: header.width } : null,
        hero: hero ? { left: hero.left, right: hero.right, top: hero.top, bottom: hero.bottom } : null,
        heroText: heroText ? { left: heroText.left, right: heroText.right, top: heroText.top, bottom: heroText.bottom } : null
      };
    });
    const frameOk = frame.documentWidth <= frame.vw + 1 &&
      frame.pageShell && frame.pageShell.left <= 1 && frame.pageShell.right >= frame.vw - 1 &&
      frame.header && frame.header.left <= 1 && frame.header.right >= frame.vw - 1 &&
      (!frame.heroText || !frame.hero || (frame.heroText.left >= frame.hero.left - 1 &&
        frame.heroText.right <= frame.hero.right + 1 && frame.heroText.top >= frame.hero.top - 1 &&
        frame.heroText.bottom <= frame.hero.bottom + 1));
    if (!frameOk) fail(width + 'x' + height + ': viewport-height/layout coverage failure: ' + JSON.stringify(frame));
    else report(width + 'x' + height + ' viewport frame fills width with no horizontal overflow or clipped hero text');
  }

  // Verify the 140 KB extended locale bundle is requested only after a language change.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setViewportSize({ width: 1280, height: 900 });
  const langButton = page.locator('#footer-lang-btn');
  if (!(await langButton.count()) || !(await langButton.isVisible())) {
    fail('footer language selector is missing');
  } else {
    await langButton.scrollIntoViewIfNeeded();
    await langButton.click();
    const languageHitTest = await page.evaluate(() => {
      const option = document.querySelector('#footer-lang-panel [data-lang="ur"]');
      const footer = option?.closest('footer.footer');
      const panel = document.querySelector('#footer-lang-panel');
      if (!option || !footer || !panel) return { found: false };
      const rect = option.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const stack = element => {
        const result = [];
        for (let node = element; node && result.length < 6; node = node.parentElement) {
          const style = getComputedStyle(node);
          result.push({ tag: node.tagName, id: node.id || '', className: typeof node.className === 'string' ? node.className : '', position: style.position, zIndex: style.zIndex, isolation: style.isolation, overflow: style.overflow });
        }
        return result;
      };
      return {
        found: true,
        optionRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        footerStyle: { position: getComputedStyle(footer).position, zIndex: getComputedStyle(footer).zIndex, overflow: getComputedStyle(footer).overflow },
        panelStyle: { position: getComputedStyle(panel).position, zIndex: getComputedStyle(panel).zIndex, display: getComputedStyle(panel).display },
        topElement: top ? { tag: top.tagName, id: top.id || '', className: typeof top.className === 'string' ? top.className : '' } : null,
        topIsOption: !!top && (top === option || option.contains(top)),
        footerStack: stack(footer),
        blockerStack: stack(top)
      };
    });
    console.log('FOOTER LANGUAGE HIT TEST: ' + JSON.stringify(languageHitTest));
    if (!languageHitTest.topIsOption) fail('footer language dropdown is covered by another element: ' + JSON.stringify(languageHitTest.topElement));
    const urOption = page.locator('#footer-lang-panel [data-lang="ur"]');
    if (languageHitTest.topIsOption) await urOption.click({ timeout: 5000 });
    else await urOption.evaluate(element => element.click());
    await page.waitForFunction(() => window.RuntimeI18n && window.RuntimeI18n.getLanguage() === 'ur', null, { timeout: 10000 })
      .catch(() => fail('footer language selector did not switch to Urdu'));
    const localeExtensionPresent = await page.evaluate(() => !!document.querySelector('script[src*="i18n-ext.js"]'));
    if (!localeExtensionPresent) fail('extended locale bundle is missing from the homepage translation path');
    await langButton.click();
    await page.locator('#footer-lang-panel [data-lang="en"]').click();
    await page.waitForFunction(() => window.RuntimeI18n && window.RuntimeI18n.getLanguage() === 'en', null, { timeout: 10000 })
      .catch(() => fail('footer language selector did not return to English'));
    report('language switching uses extended locale data and returns to English');
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
    const menuBounds = await page.locator('.site-header .nav-item.has-mega .mega').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, viewportWidth: document.documentElement.clientWidth, visible: getComputedStyle(element).visibility === 'visible' };
    });
    console.log('DESKTOP MEGA MENU BOUNDS: ' + JSON.stringify(menuBounds));
    if (menuBounds.visible && (menuBounds.left < -1 || menuBounds.right > menuBounds.viewportWidth + 1 || menuBounds.width > menuBounds.viewportWidth)) {
      fail('desktop All Tools menu extends outside viewport: ' + JSON.stringify(menuBounds));
    } else if (menuBounds.visible) report('desktop All Tools menu stays within viewport bounds');
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

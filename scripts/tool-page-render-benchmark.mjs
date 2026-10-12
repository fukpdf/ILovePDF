#!/usr/bin/env node
/**
 * Repeated cold-load rendering benchmark for the PDF tool page.
 * Measures the local PR candidate and the deployed Firebase page on mobile
 * and desktop; does not upload a file or invoke PDF processing.
 */
import { chromium } from 'playwright';

const targets = [
  { name: 'Local candidate', url: 'http://127.0.0.1:4173/compress-pdf' },
  { name: 'Firebase production', url: 'https://ilovepdf-web.web.app/compress-pdf' }
];
const profiles = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 768 }
];
const runsPerTarget = 3;
const SETTLE_MS = 2200;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
const failures = [];
const fail = message => { failures.push(message); console.error('FAIL:', message); };

try {
  for (const profile of profiles) {
    for (const target of targets) {
      for (let run = 1; run <= runsPerTarget; run++) {
        const context = await browser.newContext({
          viewport: { width: profile.width, height: profile.height },
          deviceScaleFactor: 1,
          isMobile: profile.name === 'mobile',
          hasTouch: profile.name === 'mobile',
          reducedMotion: 'reduce'
        });
        const page = await context.newPage();
        const pageErrors = [];
        const failedLocalAssets = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('requestfailed', request => {
          try {
            const url = new URL(request.url());
            if (url.origin === new URL(target.url).origin &&
                /\/(?:js|css|core|assets|images|fonts|locales)\//i.test(url.pathname)) {
              failedLocalAssets.push(url.pathname + ' (' + (request.failure()?.errorText || 'failed') + ')');
            }
          } catch {}
        });
        await page.addInitScript(() => {
          window.__toolPerf = { lcp: null, cls: 0, shifts: [], longTasks: [] };
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) window.__toolPerf.lcp = entry.startTime;
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {}
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                if (!entry.hadRecentInput) {
                  window.__toolPerf.cls += entry.value;
                  window.__toolPerf.shifts.push({
                    value: entry.value,
                    sources: (entry.sources || []).slice(0, 3).map(source => ({
                      tag: source.node?.tagName || '',
                      id: source.node?.id || '',
                      className: typeof source.node?.className === 'string' ? source.node.className.slice(0, 100) : ''
                    }))
                  });
                }
              }
            }).observe({ type: 'layout-shift', buffered: true });
          } catch {}
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) window.__toolPerf.longTasks.push(entry.duration);
            }).observe({ type: 'longtask', buffered: true });
          } catch {}
        });

        let response = null;
        let navigationError = null;
        let sourceBlockingStylesheetCount = null;
        try {
          response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          if (response) {
            const sourceHtml = (await response.text()).replace(/<noscript\\b[\\s\\S]*?<\\/noscript>/gi, '');
            sourceBlockingStylesheetCount = [...sourceHtml.matchAll(/<link\\b[^>]*>/gi)]
              .map(match => match[0])
              .filter(tag => /(?:^|\\s)rel=["'][^"']*\\bstylesheet\\b[^"']*["']/i.test(tag)).length;
          }
          await page.waitForSelector('#upload-area', { state: 'visible', timeout: 20000 });
          await page.waitForTimeout(SETTLE_MS);
        } catch (error) {
          navigationError = String(error?.message || error);
        }
        const metrics = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const resources = performance.getEntriesByType('resource');
          const paint = performance.getEntriesByType('paint');
          const transfer = resources.reduce((sum, entry) => sum + (entry.transferSize || 0), nav?.transferSize || 0);
          const encodedBodyBytes = resources.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), nav?.encodedBodySize || 0);
          const decodedBodyBytes = resources.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), nav?.decodedBodySize || 0);
          const bodyCompressionRatioPct = decodedBodyBytes > 0
            ? Math.round((1 - encodedBodyBytes / decodedBodyBytes) * 1000) / 10
            : null;
          const externalScripts = [...document.scripts].filter(script => script.src);
          const blockingScripts = externalScripts.filter(script => !script.defer && !script.async && script.type !== 'module');
          const activeLinks = [...document.querySelectorAll('link[rel~="stylesheet"]')];
          const localFailed = [];
          return {
            title: document.title,
            uploadVisible: !!document.querySelector('#upload-area') && getComputedStyle(document.querySelector('#upload-area')).display !== 'none',
            fileInputPresent: !!document.querySelector('#file-input'),
            headerPresent: !!document.querySelector('.site-header'),
            footerPresent: !!document.querySelector('.footer'),
            horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            fcpMs: paint.find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null,
            lcpMs: window.__toolPerf?.lcp ?? null,
            domContentLoadedMs: nav?.domContentLoadedEventEnd ?? null,
            loadEventMs: nav?.loadEventEnd ?? null,
            responseStartMs: nav?.responseStart ?? null,
            transferBytes: transfer,
            encodedBodyBytes,
            decodedBodyBytes,
            bodyCompressionRatioPct,
            resourceCount: resources.length,
            scriptResourceCount: resources.filter(entry => /script/i.test(entry.initiatorType)).length,
            stylesheetResourceCount: resources.filter(entry => entry.name.split('?')[0].toLowerCase().endsWith('.css')).length,
            scriptTagCount: externalScripts.length,
            parserBlockingScriptCount: blockingScripts.length,
            activeStylesheetCountAfterSettle: activeLinks.length,
            cls: window.__toolPerf?.cls ?? null,
            layoutShifts: (window.__toolPerf?.shifts || []).slice(0, 3),
            longTaskCount: (window.__toolPerf?.longTasks || []).length,
            longTaskDurationMs: Math.round((window.__toolPerf?.longTasks || []).reduce((sum, value) => sum + value, 0) * 10) / 10
          };
        }).catch(error => ({ measurementError: String(error) }));
        const result = {
          target: target.name, profile: profile.name, run,
          status: response?.status() ?? null, navigationError, pageErrors, failedLocalAssets,
          blockingStylesheetCountAtSource: sourceBlockingStylesheetCount, ...metrics
        };
        results.push(result);
        console.log('TOOL_RENDER_BENCHMARK ' + JSON.stringify(result));
        if (target.name === 'Local candidate') {
          if (result.status !== 200) fail(profile.name + ' run ' + run + ': local tool page HTTP status ' + result.status);
          if (!result.uploadVisible || !result.fileInputPresent) fail(profile.name + ' run ' + run + ': upload UI failed to initialize');
          if (!result.headerPresent || !result.footerPresent) fail(profile.name + ' run ' + run + ': shared header/footer missing');
          if (result.horizontalOverflow) fail(profile.name + ' run ' + run + ': horizontal overflow');
          if (result.parserBlockingScriptCount !== 0) fail(profile.name + ' run ' + run + ': ' + result.parserBlockingScriptCount + ' parser-blocking scripts');
          if (result.fcpMs == null || result.lcpMs == null) fail(profile.name + ' run ' + run + ': paint metrics were not measured');
          if (result.cls == null || !Number.isFinite(result.cls) || result.cls > 0.1) fail(profile.name + ' run ' + run + ': CLS missing or exceeds 0.1 (' + result.cls + ')');
          if (pageErrors.length) fail(profile.name + ' run ' + run + ': browser errors: ' + pageErrors.slice(0, 4).join(' | '));
          if (failedLocalAssets.length) fail(profile.name + ' run ' + run + ': local asset failures: ' + failedLocalAssets.slice(0, 4).join(' | '));
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

for (const profile of profiles) {
  for (const target of targets) {
    const rows = results.filter(row => row.profile === profile.name && row.target === target.name && row.status === 200);
    const median = key => {
      const values = rows.map(row => row[key]).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : null;
    };
    console.log('TOOL_RENDER_MEDIAN ' + JSON.stringify({
      target: target.name, profile: profile.name, successfulRuns: rows.length,
      fcpMs: median('fcpMs'), lcpMs: median('lcpMs'), responseStartMs: median('responseStartMs'),
      domContentLoadedMs: median('domContentLoadedMs'), loadEventMs: median('loadEventMs'),
      transferBytes: median('transferBytes'), encodedBodyBytes: median('encodedBodyBytes'),
      decodedBodyBytes: median('decodedBodyBytes'), bodyCompressionRatioPct: median('bodyCompressionRatioPct'),
      resourceCount: median('resourceCount'),
      scriptResourceCount: median('scriptResourceCount'), stylesheetResourceCount: median('stylesheetResourceCount'),
      scriptTagCount: median('scriptTagCount'), parserBlockingScriptCount: median('parserBlockingScriptCount'),
      blockingStylesheetCountAtSource: median('blockingStylesheetCountAtSource'),
      activeStylesheetCountAfterSettle: median('activeStylesheetCountAfterSettle'), cls: median('cls'),
      longTaskCount: median('longTaskCount'), longTaskDurationMs: median('longTaskDurationMs')
    }));
  }
}
for (const profile of profiles) {
  const rows = results.filter(row => row.profile === profile.name && row.target === 'Local candidate' && row.status === 200);
  const median = key => {
    const values = rows.map(row => row[key]).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  };
  if (rows.length !== runsPerTarget) fail(profile.name + ': expected ' + runsPerTarget + ' successful local performance samples, got ' + rows.length);
  const fcp = median('fcpMs');
  const lcp = median('lcpMs');
  const cls = median('cls');
  if (fcp == null || fcp > 1800) fail(profile.name + ': median FCP missing or exceeds 1.8s (' + fcp + 'ms)');
  if (lcp == null || lcp > 2500) fail(profile.name + ': median LCP missing or exceeds 2.5s (' + lcp + 'ms)');
  if (cls == null || cls > 0.1) fail(profile.name + ': median CLS missing or exceeds 0.1 (' + cls + ')');
}

if (failures.length) {
  console.error('TOOL_RENDER_BENCHMARK_FAILED: ' + failures.join('; '));
  process.exitCode = 1;
} else {
  console.log('TOOL_RENDER_BENCHMARK_GUARD: local tool page loaded in all measured contexts without blocking scripts, layout overflow, browser errors or local asset failures.');
}

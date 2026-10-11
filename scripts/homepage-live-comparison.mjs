#!/usr/bin/env node
import { chromium } from 'playwright';

const targets = [
  { name: 'ILovePDF.cyou', url: 'https://ilovepdf.cyou/' },
  { name: 'Official iLovePDF', url: 'https://www.ilovepdf.com/' }
];
const profiles = [
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 1 },
  { name: 'desktop', width: 1366, height: 768, deviceScaleFactor: 1 }
];
const repetitions = 3;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (const profile of profiles) {
    for (const target of targets) {
      for (let run = 1; run <= repetitions; run++) {
        const context = await browser.newContext({
          viewport: { width: profile.width, height: profile.height },
          deviceScaleFactor: profile.deviceScaleFactor,
          isMobile: profile.name === 'mobile',
          hasTouch: profile.name === 'mobile',
          reducedMotion: 'reduce'
        });
        const page = await context.newPage();
        await page.addInitScript(() => {
          window.__livePerf = { lcp: null, cls: 0 };
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                window.__livePerf.lcp = entry.startTime;
              }
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch {}
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                if (!entry.hadRecentInput) window.__livePerf.cls += entry.value;
              }
            }).observe({ type: 'layout-shift', buffered: true });
          } catch {}
        });
        const failedRequests = [];
        page.on('requestfailed', request => failedRequests.push({ url: request.url(), reason: request.failure()?.errorText || 'failed' }));
        let status = null;
        let navigationError = null;
        const started = Date.now();
        try {
          const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          status = response?.status() ?? null;
          // Give post-load scripts and the LCP observer the same short settling window.
          await page.waitForTimeout(2500);
        } catch (error) {
          navigationError = String(error?.message || error);
        }
        const metrics = await page.evaluate(() => {
          const navigation = performance.getEntriesByType('navigation')[0];
          const resources = performance.getEntriesByType('resource');
          const paints = performance.getEntriesByType('paint');
          const bytes = entries => entries.reduce((sum, entry) => sum + (entry.transferSize || 0), 0);
          const html = document.documentElement;
          return {
            title: document.title,
            fcpMs: paints.find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null,
            domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
            loadEventMs: navigation?.loadEventEnd ?? null,
            responseStartMs: navigation?.responseStart ?? null,
            totalTransferBytes: bytes(resources) + (navigation?.transferSize || 0),
            resourceCount: resources.length,
            scriptCount: resources.filter(entry => /script/i.test(entry.initiatorType)).length,
            stylesheetCount: resources.filter(entry => entry.name.split('?')[0].toLowerCase().endsWith('.css')).length,
            documentWidth: html?.scrollWidth ?? null,
            viewportWidth: html?.clientWidth ?? null,
            lcpMs: window.__livePerf?.lcp ?? null,
            cls: window.__livePerf?.cls ?? null
          };
        }).catch(error => ({ measurementError: String(error) }));
        results.push({
          target: target.name,
          url: target.url,
          profile: profile.name,
          run,
          status,
          wallMs: Date.now() - started,
          navigationError,
          failedRequestCount: failedRequests.length,
          failedRequestExamples: failedRequests.slice(0, 3),
          ...metrics
        });
        console.log('LIVE_BENCHMARK ' + JSON.stringify(results[results.length - 1]));
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
    console.log('LIVE_BENCHMARK_MEDIAN ' + JSON.stringify({
      target: target.name, profile: profile.name, successfulRuns: rows.length,
      fcpMs: median('fcpMs'), lcpMs: median('lcpMs'), responseStartMs: median('responseStartMs'),
      domContentLoadedMs: median('domContentLoadedMs'), loadEventMs: median('loadEventMs'),
      totalTransferBytes: median('totalTransferBytes'), resourceCount: median('resourceCount'),
      scriptCount: median('scriptCount'), stylesheetCount: median('stylesheetCount'),
      cls: median('cls')
    }));
  }
}
const incompleteComparisons = profiles.some(profile => targets.some(target => !results.some(row => row.profile === profile.name && row.target === target.name && row.status === 200)));
if (incompleteComparisons) {
  console.error('LIVE_BENCHMARK_WARNING: at least one site/profile had no successful navigation; comparison is incomplete.');
  process.exitCode = 1;
} else if (results.some(row => row.status !== 200 || row.navigationError)) {
  console.warn('LIVE_BENCHMARK_WARNING: some samples failed, but each site/profile has at least one successful sample; medians use successful runs only.');
}

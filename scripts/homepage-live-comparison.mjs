#!/usr/bin/env node
import { chromium } from 'playwright';

const targets = [
  { name: 'Local candidate build', url: 'http://127.0.0.1:4173/?static-hosting-test=1' },
  { name: 'Firebase production', url: 'https://ilovepdf-web.web.app/' },
  { name: 'Official iLovePDF', url: 'https://www.ilovepdf.com/' }
];
const profiles = [
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 1 },
  { name: 'desktop', width: 1366, height: 768, deviceScaleFactor: 1 },
  // Lighthouse-like mobile lab profile: 1.6 Mbps down, 750 Kbps up,
  // 150 ms RTT, and 4x CPU slowdown. Compare candidate vs Firebase only.
  { name: 'mobile-throttled', width: 390, height: 844, deviceScaleFactor: 1, throttle: true }
];
const repetitions = 3;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (const profile of profiles) {
    const profileTargets = profile.throttle
      ? targets.filter(target => target.name !== 'Official iLovePDF')
      : targets;
    for (const target of profileTargets) {
      for (let run = 1; run <= repetitions; run++) {
        const context = await browser.newContext({
          viewport: { width: profile.width, height: profile.height },
          deviceScaleFactor: profile.deviceScaleFactor,
          isMobile: profile.name.startsWith('mobile'),
          hasTouch: profile.name.startsWith('mobile'),
          reducedMotion: 'reduce'
        });
        const page = await context.newPage();
        if (profile.throttle) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 150,
            downloadThroughput: 1.6 * 1024 * 1024 / 8,
            uploadThroughput: 750 * 1024 / 8,
            connectionType: 'cellular3g'
          });
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        }
        await page.addInitScript(() => {
          window.__livePerf = { lcp: null, cls: 0, shifts: [], longTasks: [] };
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
                if (!entry.hadRecentInput) {
                  window.__livePerf.cls += entry.value;
                  window.__livePerf.shifts.push({
                    value: entry.value,
                    startTime: entry.startTime,
                    sources: (entry.sources || []).slice(0, 3).map(source => ({
                      node: source.node?.tagName || null,
                      id: source.node?.id || null,
                      className: typeof source.node?.className === 'string' ? source.node.className.slice(0, 120) : '',
                      previousRect: source.previousRect ? { x: source.previousRect.x, y: source.previousRect.y, width: source.previousRect.width, height: source.previousRect.height } : null,
                      currentRect: source.currentRect ? { x: source.currentRect.x, y: source.currentRect.y, width: source.currentRect.width, height: source.currentRect.height } : null
                    }))
                  });
                }
              }
            }).observe({ type: 'layout-shift', buffered: true });
          } catch {}
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) {
                window.__livePerf.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
              }
            }).observe({ type: 'longtask', buffered: true });
          } catch {}
        });
        const failedRequests = [];
        page.on('requestfailed', request => failedRequests.push({ url: request.url(), reason: request.failure()?.errorText || 'failed' }));
        let status = null;
        let documentHeaders = null;
        let navigationError = null;
        const started = Date.now();
        let blockingStylesheetCountAtDOMContentLoaded = null;
        try {
          const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          status = response?.status() ?? null;
          if (response) {
            const headers = await response.allHeaders();
            documentHeaders = {
              contentEncoding: headers['content-encoding'] || null,
              contentLength: headers['content-length'] || null,
              cacheControl: headers['cache-control'] || null,
              contentType: headers['content-type'] || null,
              server: headers['server'] || null
            };
          }
          blockingStylesheetCountAtDOMContentLoaded = await page.evaluate(() => Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).filter(link => link.getAttribute('fetchpriority') !== 'low').length);
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
            apiRequestCount: resources.filter(entry => {
              try { const url = new URL(entry.name); return url.origin === location.origin && url.pathname.startsWith('/api/'); } catch { return false; }
            }).length,
            apiTransferBytes: resources.filter(entry => {
              try { const url = new URL(entry.name); return url.origin === location.origin && url.pathname.startsWith('/api/'); } catch { return false; }
            }).reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
            adScriptCount: resources.filter(entry => /pagead2?\.googlesyndication\.com/i.test(entry.name)).length,
            adTransferBytes: resources.filter(entry => /pagead2?\.googlesyndication\.com/i.test(entry.name)).reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
            topTransferredResources: resources
              .filter(entry => entry.transferSize > 0)
              .sort((a, b) => b.transferSize - a.transferSize)
              .slice(0, 12)
              .map(entry => ({
                url: entry.name,
                initiatorType: entry.initiatorType,
                transferBytes: entry.transferSize,
                encodedBodyBytes: entry.encodedBodySize,
                decodedBodyBytes: entry.decodedBodySize,
                durationMs: Math.round(entry.duration * 10) / 10
              })),
            documentWidth: html?.scrollWidth ?? null,
            viewportWidth: html?.clientWidth ?? null,
            lcpMs: window.__livePerf?.lcp ?? null,
            cls: window.__livePerf?.cls ?? null,
            layoutShifts: (window.__livePerf?.shifts || []).slice(0, 5),
            longTaskCount: (window.__livePerf?.longTasks || []).length,
            longTaskDurationMs: Math.round((window.__livePerf?.longTasks || []).reduce((sum, task) => sum + task.duration, 0) * 10) / 10,
            fontStatus: document.fonts?.status || 'unsupported',
            scriptUrls: resources.filter(entry => /script/i.test(entry.initiatorType)).map(entry => entry.name),
            stylesheetUrls: resources.filter(entry => entry.name.split('?')[0].toLowerCase().endsWith('.css')).map(entry => entry.name),
            scriptTags: Array.from(document.scripts).filter(script => script.src).map(script => ({ url: script.src, async: script.async, defer: script.defer })),
            stylesheetTags: Array.from(document.querySelectorAll('link[rel~="stylesheet"], link[rel="preload"][as="style"]')).map(link => ({ href: link.href, rel: link.rel, media: link.media }))
          };
        }).catch(error => ({ measurementError: String(error) }));
        metrics.blockingStylesheetCount = blockingStylesheetCountAtDOMContentLoaded;
        const includeInventory = target.name === 'Local candidate build' && profile.name === 'mobile' && run === 1;
        if (!includeInventory) {
          delete metrics.scriptUrls;
          delete metrics.stylesheetUrls;
          delete metrics.scriptTags;
          delete metrics.stylesheetTags;
        }
        results.push({
          target: target.name,
          url: target.url,
          profile: profile.name,
          run,
          status,
          wallMs: Date.now() - started,
          navigationError,
          documentHeaders,
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
  const profileTargets = profile.throttle
    ? targets.filter(target => target.name !== 'Official iLovePDF')
    : targets;
  for (const target of profileTargets) {
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
      blockingStylesheetCount: median('blockingStylesheetCount'),
      apiRequestCount: median('apiRequestCount'), apiTransferBytes: median('apiTransferBytes'),
      adScriptCount: median('adScriptCount'), adTransferBytes: median('adTransferBytes'),
      cls: median('cls')
    }));
  }
}
const candidateFailures = [];
for (const profile of profiles) {
  const rows = results.filter(row => row.profile === profile.name && row.target === 'Local candidate build' && row.status === 200);
  const median = key => {
    const values = rows.map(row => row[key]).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  };
  if (!rows.length) {
    candidateFailures.push(profile.name + ': no successful local candidate samples');
    continue;
  }
  if (median('apiRequestCount') !== 0) candidateFailures.push(profile.name + ': static candidate still makes ' + median('apiRequestCount') + ' same-origin API request(s)');
  if (median('adTransferBytes') !== 0) candidateFailures.push(profile.name + ': AdSense transferred ' + median('adTransferBytes') + ' bytes before the initial-view measurement ended');
  if (median('totalTransferBytes') > 320 * 1024) candidateFailures.push(profile.name + ': initial-view transfer exceeded 320 KiB (' + median('totalTransferBytes') + ' bytes)');
  if (median('scriptCount') > 35) candidateFailures.push(profile.name + ': initial-view script count exceeded 35 (' + median('scriptCount') + ')');
  if (median('blockingStylesheetCount') > 5) candidateFailures.push(profile.name + ': blocking stylesheet count exceeded 5 (' + median('blockingStylesheetCount') + ')');
  const fcpBudgetMs = profile.throttle ? 3000 : 300;
  const lcpBudgetMs = profile.throttle ? 4000 : 300;
  if (median('fcpMs') > fcpBudgetMs) candidateFailures.push(profile.name + ': local candidate FCP exceeded ' + fcpBudgetMs + ' ms (' + median('fcpMs') + ' ms)');
  if (median('lcpMs') > lcpBudgetMs) candidateFailures.push(profile.name + ': local candidate LCP exceeded ' + lcpBudgetMs + ' ms (' + median('lcpMs') + ' ms)');
  if (median('cls') > 0.1) candidateFailures.push(profile.name + ': local candidate CLS exceeded 0.1 (' + median('cls') + ')');
}
if (candidateFailures.length) {
  console.error('LOCAL_CANDIDATE_PERFORMANCE_REGRESSION: ' + candidateFailures.join('; '));
  process.exitCode = 1;
} else {
  console.log('LOCAL_CANDIDATE_PERFORMANCE_GUARD: no same-origin API traffic or AdSense transfer during initial-view measurement');
}

const incompleteComparisons = profiles.some(profile => {
  const profileTargets = profile.throttle
    ? targets.filter(target => target.name !== 'Official iLovePDF')
    : targets;
  return profileTargets.some(target => !results.some(row => row.profile === profile.name && row.target === target.name && row.status === 200));
});
if (incompleteComparisons) {
  console.warn('LIVE_BENCHMARK_INCOMPLETE: at least one site/profile had no successful navigation. Do not compare its challenge/error page metrics with the other site. External bot protection or availability can block live lab tests; this diagnostic does not fail the homepage regression gate.');
} else if (results.some(row => row.status !== 200 || row.navigationError)) {
  console.warn('LIVE_BENCHMARK_WARNING: some samples failed, but each site/profile has at least one successful sample; medians use successful runs only.');
}

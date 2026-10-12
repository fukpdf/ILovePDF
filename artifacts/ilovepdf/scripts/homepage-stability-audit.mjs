#!/usr/bin/env node
/**
 * Repeated first-render stability gate for the assembled homepage.
 * Runs independent cold browser contexts so one lucky font/cache timing cannot
 * hide an intermittent CLS regression. Does not touch application files.
 */
import { chromium } from 'playwright';

const BASE = process.env.HOMEPAGE_BASE_URL || 'http://127.0.0.1:4173/';
const PROFILES = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 768 }
];
const RUNS_PER_PROFILE = 3;
const SETTLE_MS = 2200;
const failures = [];
const results = [];
const fail = message => {
  failures.push(message);
  console.error('FAIL:', message);
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const profile of PROFILES) {
    for (let run = 1; run <= RUNS_PER_PROFILE; run++) {
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
          if (url.origin === new URL(BASE).origin &&
              /\/(?:js|css|core|assets|images|fonts|locales)\//i.test(url.pathname)) {
            failedLocalAssets.push(url.pathname + ' (' + (request.failure()?.errorText || 'failed') + ')');
          }
        } catch {}
      });
      await page.addInitScript(() => {
        window.__homepageStability = { cls: 0, shifts: [] };
        try {
          new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              if (entry.hadRecentInput) continue;
              const rect = value => value ? {
                x: value.x, y: value.y, width: value.width, height: value.height
              } : null;
              window.__homepageStability.cls += entry.value;
              window.__homepageStability.shifts.push({
                value: entry.value,
                startTime: entry.startTime,
                sources: (entry.sources || []).slice(0, 4).map(source => ({
                  tag: source.node?.tagName || '',
                  id: source.node?.id || '',
                  className: typeof source.node?.className === 'string' ? source.node.className : '',
                  text: (source.node?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
                  previous: rect(source.previousRect),
                  current: rect(source.currentRect)
                }))
              });
            }
          }).observe({ type: 'layout-shift', buffered: true });
        } catch {}
      });

      let response;
      try {
        response = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(SETTLE_MS);
      } catch (error) {
        fail(profile.name + ' run ' + run + ': navigation failed: ' + String(error?.message || error));
        await context.close();
        continue;
      }

      const measurement = await page.evaluate(() => ({
        title: document.title,
        cards: document.querySelectorAll('a.tool').length,
        h1: document.querySelectorAll('h1').length,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        cls: window.__homepageStability?.cls ?? null,
        shifts: (window.__homepageStability?.shifts || []).sort((a, b) => b.value - a.value).slice(0, 3)
      }));
      const result = {
        profile: profile.name, run, status: response?.status() ?? null,
        ...measurement, pageErrors, failedLocalAssets
      };
      results.push(result);
      console.log('HOMEPAGE_STABILITY ' + JSON.stringify(result));

      if (result.status !== 200) fail(profile.name + ' run ' + run + ': homepage returned HTTP ' + result.status);
      if (result.cards !== 41) fail(profile.name + ' run ' + run + ': expected 41 visible catalogue cards in DOM, found ' + result.cards);
      if (result.h1 !== 1) fail(profile.name + ' run ' + run + ': expected exactly one H1, found ' + result.h1);
      if (result.documentWidth > result.viewportWidth + 1) fail(profile.name + ' run ' + run + ': horizontal overflow ' + result.documentWidth + ' > ' + result.viewportWidth);
      if (result.cls === null || !Number.isFinite(result.cls)) fail(profile.name + ' run ' + run + ': CLS was not measured');
      else if (result.cls > 0.1) fail(profile.name + ' run ' + run + ': CLS ' + result.cls.toFixed(4) + ' exceeds the 0.1 target; shifts=' + JSON.stringify(result.shifts));
      if (pageErrors.length) fail(profile.name + ' run ' + run + ': browser errors: ' + pageErrors.join(' | '));
      if (failedLocalAssets.length) fail(profile.name + ' run ' + run + ': failed local assets: ' + failedLocalAssets.join(' | '));
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const clsValues = results.map(result => result.cls).filter(Number.isFinite).sort((a, b) => a - b);
console.log('HOMEPAGE_STABILITY_SUMMARY ' + JSON.stringify({
  runs: results.length,
  expectedRuns: PROFILES.length * RUNS_PER_PROFILE,
  clsMedian: clsValues.length ? clsValues[Math.floor(clsValues.length / 2)] : null,
  clsMax: clsValues.length ? Math.max(...clsValues) : null,
  failures: failures.length
}));
if (results.length !== PROFILES.length * RUNS_PER_PROFILE) fail('not all repeated homepage stability runs completed');
if (failures.length) {
  console.error('Homepage repeated stability audit: BLOCKED (' + failures.length + ' failure(s))');
  process.exit(1);
}
console.log('Homepage repeated stability audit: PASS');

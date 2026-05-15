/* RuntimeGlobalCertification — Phase 10J
   Certifies that all Phase 10 global systems are operational.
   Checks: i18n engine, locale loading, RTL support, language selector,
   homepage bands, and tool group completeness.

   Usage:
     const report = await window.RuntimeGlobalCertification();
     console.table(report.checks);
*/
(function () {
  'use strict';

  async function RuntimeGlobalCertification() {
    const started = Date.now();
    const checks  = [];
    let   passed  = 0;
    let   failed  = 0;

    function check(name, fn) {
      try {
        const result = fn();
        const ok = Boolean(result);
        checks.push({ check: name, status: ok ? 'PASS' : 'FAIL', detail: ok ? '' : 'returned falsy' });
        ok ? passed++ : failed++;
      } catch (err) {
        checks.push({ check: name, status: 'FAIL', detail: String(err) });
        failed++;
      }
    }

    async function checkAsync(name, fn) {
      try {
        const result = await fn();
        const ok = Boolean(result);
        checks.push({ check: name, status: ok ? 'PASS' : 'FAIL', detail: ok ? '' : 'resolved falsy' });
        ok ? passed++ : failed++;
      } catch (err) {
        checks.push({ check: name, status: 'FAIL', detail: String(err) });
        failed++;
      }
    }

    check('10B: window.RuntimeI18n exists',
      () => typeof window.RuntimeI18n === 'object' && window.RuntimeI18n !== null);

    check('10B: RuntimeI18n.getLanguage()',
      () => typeof window.RuntimeI18n?.getLanguage === 'function' &&
            typeof window.RuntimeI18n.getLanguage() === 'string');

    check('10B: RuntimeI18n.translate()',
      () => typeof window.RuntimeI18n?.translate === 'function');

    check('10B: window.t() shorthand exists',
      () => typeof window.t === 'function');

    check('10B: RuntimeI18n.availableLanguages() returns 19+',
      () => Array.isArray(window.RuntimeI18n?.availableLanguages?.()) &&
            window.RuntimeI18n.availableLanguages().length >= 19);

    check('10D: RTL languages included',
      () => {
        const langs = window.RuntimeI18n?.availableLanguages?.() || [];
        const rtl   = langs.filter(l => l.rtl);
        return rtl.length >= 3;
      });

    check('10D: html[dir] attribute present',
      () => document.documentElement.hasAttribute('dir'));

    check('10E: html[lang] attribute present',
      () => document.documentElement.hasAttribute('lang'));

    await checkAsync('10F: English locale loads and translates hero.title',
      async () => {
        await window.RuntimeI18n?.loadLocale?.('en');
        const orig = window.RuntimeI18n?.getLanguage?.();
        await window.RuntimeI18n?.setLanguage?.('en');
        const text = window.RuntimeI18n?.translate?.('hero.title');
        if (orig) await window.RuntimeI18n?.setLanguage?.(orig);
        return typeof text === 'string' && text.length > 0 && text !== 'hero.title';
      });

    await checkAsync('10G: Arabic RTL locale loads',
      async () => {
        const locale = await window.RuntimeI18n?.loadLocale?.('ar');
        return locale && Object.keys(locale).length > 5;
      });

    await checkAsync('10G: Urdu RTL locale loads',
      async () => {
        const locale = await window.RuntimeI18n?.loadLocale?.('ur');
        return locale && Object.keys(locale).length > 5;
      });

    await checkAsync('10G: 10+ locales loadable',
      async () => {
        const codes = ['en','fr','de','es','pt','ru','zh','ja','ko','hi','tr'];
        const results = await Promise.all(codes.map(c => window.RuntimeI18n?.loadLocale?.(c)));
        return results.filter(r => r && Object.keys(r).length > 0).length >= 10;
      });

    check('10A: window.TOOL_GROUPS has 7 categories',
      () => Array.isArray(window.TOOL_GROUPS) && window.TOOL_GROUPS.length === 7);

    check('10A: window.HOMEPAGE_BANDS has 7 bands (all categories)',
      () => Array.isArray(window.HOMEPAGE_BANDS) && window.HOMEPAGE_BANDS.length === 7);

    check('10A: HOMEPAGE_BANDS total items ≥ 35',
      () => {
        const total = (window.HOMEPAGE_BANDS || []).reduce((s, b) => s + (b.items || []).length, 0);
        return total >= 35;
      });

    check('10A: organize band present in HOMEPAGE_BANDS',
      () => (window.HOMEPAGE_BANDS || []).some(b => b.key === 'organize'));

    check('10A: advanced band present in HOMEPAGE_BANDS',
      () => (window.HOMEPAGE_BANDS || []).some(b => b.key === 'advanced'));

    check('10C: lang-sel DOM element exists',
      () => Boolean(document.getElementById('lang-sel')));

    check('10C: lang-btn DOM element exists',
      () => Boolean(document.getElementById('lang-btn')));

    check('10H: data-i18n attributes present on page',
      () => document.querySelectorAll('[data-i18n]').length > 0);

    check('10J: RuntimeGlobalCertification self-test',
      () => typeof window.RuntimeGlobalCertification === 'function');

    const duration = Date.now() - started;
    const summary  = {
      total: checks.length,
      passed,
      failed,
      duration_ms: duration,
      phase: 'Phase 10 — Global Productization',
      certified: failed === 0,
      timestamp: new Date().toISOString(),
    };

    const report = { summary, checks };

    if (failed === 0) {
      console.log(
        '%c✅ RuntimeGlobalCertification — ALL CHECKS PASSED (' + passed + '/' + checks.length + ') in ' + duration + 'ms',
        'color:#059669;font-weight:700;font-size:13px'
      );
    } else {
      console.warn(
        '⚠️ RuntimeGlobalCertification — ' + failed + ' check(s) FAILED, ' + passed + ' passed in ' + duration + 'ms'
      );
      checks.filter(c => c.status === 'FAIL').forEach(c =>
        console.warn('  FAIL:', c.check, c.detail ? ('— ' + c.detail) : '')
      );
    }

    console.table(checks);
    return report;
  }

  window.RuntimeGlobalCertification = RuntimeGlobalCertification;
})();

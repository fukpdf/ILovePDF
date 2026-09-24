/* Processing Experience — device-aware pacing + rotating user-friendly status copy.
 * No file/page limits are imposed here. Low-capability devices get fewer concurrent
 * jobs and a gentler progress cadence so processing remains responsive.
 */
(function (G) {
  'use strict';
  if (G.ProcessingExperience) return;

  var QUOTES = Object.freeze([
    'Your files are doing the heavy lifting — you can relax.',
    'Good things take a moment. Your document is getting ready.',
    'Almost there — the pages are lining up nicely.',
    'A little processing magic is happening behind the scenes.',
    'You can grab a sip of coffee while we finish this.',
    'Your document is being carefully prepared for you.',
    'Big file, small patience test — we are still working on it.',
    'The busy pixels are doing their thing. Hang tight.',
    'Neat, tidy, and almost ready to download.'
  ]);

  function profile() {
    var cores = Math.max(1, Number(navigator.hardwareConcurrency) || 2);
    var memory = Number(navigator.deviceMemory) || 4;
    var tier = (memory <= 1 || cores <= 2) ? 'low' : (memory <= 2 || cores <= 4) ? 'medium' : 'high';
    return { cores: cores, memoryGB: memory, tier: tier };
  }

  function cadenceMs() {
    var t = profile().tier;
    return t === 'low' ? 7000 : t === 'medium' ? 5000 : 3500;
  }

  function create(options) {
    options = options || {};
    var index = Math.floor(Math.random() * QUOTES.length);
    var timer = null;
    var mounted = false;
    var root = options.element || null;
    var prefix = options.prefix || '';
    var onChange = typeof options.onChange === 'function' ? options.onChange : function () {};

    function emit() {
      if (!mounted) return;
      var quote = prefix ? prefix + ' ' + QUOTES[index] : QUOTES[index];
      try { onChange(quote, index, profile()); } catch (_) {}
      index = (index + 1) % QUOTES.length;
    }

    return {
      start: function () {
        if (mounted) return;
        mounted = true;
        emit();
        timer = setInterval(emit, cadenceMs());
      },
      stop: function () {
        mounted = false;
        if (timer) { clearInterval(timer); timer = null; }
      },
      next: function () { emit(); },
      getProfile: profile,
      getCadenceMs: cadenceMs
    };
  }

  G.ProcessingExperience = Object.freeze({
    VERSION: '1.0.0',
    QUOTES: QUOTES,
    profile: profile,
    cadenceMs: cadenceMs,
    create: create
  });
}(window));

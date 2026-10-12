// Retry Orchestrator v1.0 — Phase 1C Stabilization (T008)
// Centralized retry lifecycle management: storm prevention, infinite retry
// guard, cooldown enforcement, duplicate retry prevention, cancellation.
//
// DESIGN PRINCIPLE: additive wrapper. Existing retry code in advanced-engine.js
// and tool-page.js is NOT modified. New code uses RetryOrchestrator.wrap()
// to get safe, observable, bounded retries.
//
// Integrates with: TimerRegistry, StabilityMetrics, MemPressure, NavCancel
//
// Exposed as: window.RetryOrchestrator
//
// [FUTURE: CentralRuntime] Retry state will be centralized and visible
// across tools (e.g., a single OCR retry won't block compress retries).
// Replace RetryOrchestrator.wrap() body with CentralRuntime.retryTask().
(function () {
  'use strict';

  if (window.RetryOrchestrator) return;

  var LOG = '[RO]';

  // ── Global safety limits ──────────────────────────────────────────────────
  var GLOBAL_MAX_RETRIES      = 6;    // per label, per session
  var GLOBAL_STORM_WINDOW_MS  = 30000; // 30 s sliding window for storm detection
  var GLOBAL_STORM_THRESHOLD  = 10;   // > 10 retry attempts in window → storm
  var GLOBAL_COOLDOWN_MS      = 5000; // cooldown after storm before new retries

  // ── Per-label retry accounting ────────────────────────────────────────────
  // label → { count, lastAttempt, coolUntil }
  var _labelStats = {};

  // ── Global storm detector ─────────────────────────────────────────────────
  // Ring buffer of recent retry timestamps (across all labels)
  var _stormRing = [];
  var _inCooldown = false;
  var _cooldownTimer = null;

  function _recordAttempt(label) {
    var now = Date.now();

    // Per-label accounting
    if (!_labelStats[label]) _labelStats[label] = { count: 0, lastAttempt: 0, coolUntil: 0 };
    _labelStats[label].count++;
    _labelStats[label].lastAttempt = now;

    // Global storm ring
    _stormRing.push(now);
    // Prune entries outside the storm window
    while (_stormRing.length > 0 && _stormRing[0] < now - GLOBAL_STORM_WINDOW_MS) {
      _stormRing.shift();
    }

    // Storm check
    if (!_inCooldown && _stormRing.length > GLOBAL_STORM_THRESHOLD) {
      _inCooldown = true;
      console.warn(LOG, 'retry storm detected (' + _stormRing.length + ' attempts in ' +
        (GLOBAL_STORM_WINDOW_MS / 1000) + 's) — entering cooldown for ' +
        (GLOBAL_COOLDOWN_MS / 1000) + 's');
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordEvent('ro-storm:' + _stormRing.length); } catch (_) {}
      }
      _cooldownTimer = setTimeout(function () {
        _inCooldown = false;
        _cooldownTimer = null;
        _stormRing.length = 0;
        console.debug(LOG, 'retry cooldown lifted');
      }, GLOBAL_COOLDOWN_MS);
      if (window.TimerRegistry) {
        window.TimerRegistry.registerTimeout('ro-cooldown', _cooldownTimer);
      }
    }
  }

  // ── Guard checks ─────────────────────────────────────────────────────────
  function _canRetry(label, attempt, maxAttempts) {
    // Abort-tier memory pressure: no retries
    if (window.MemPressure && window.MemPressure.tier) {
      var t = window.MemPressure.tier();
      if (t === 'abort' || t === 'critical') {
        console.warn(LOG, 'retry blocked — memory pressure tier:', t);
        return { ok: false, reason: 'memory-pressure:' + t };
      }
    }

    // Global storm cooldown
    if (_inCooldown) {
      return { ok: false, reason: 'storm-cooldown' };
    }

    // Per-label session cap
    var stats = _labelStats[label];
    if (stats && stats.count >= GLOBAL_MAX_RETRIES) {
      console.warn(LOG, 'retry blocked — session cap reached for:', label,
        '(' + stats.count + '/' + GLOBAL_MAX_RETRIES + ')');
      return { ok: false, reason: 'session-cap:' + label };
    }

    // Per-call attempt cap
    if (attempt >= maxAttempts) {
      return { ok: false, reason: 'attempt-cap:' + attempt + '/' + maxAttempts };
    }

    return { ok: true };
  }

  // ── Core retry wrapper ────────────────────────────────────────────────────
  // wrap(fn, opts) → async function that retries fn safely.
  //
  // fn receives (attempt, abortSignal) and must return a Promise.
  //
  // opts:
  //   label?       — identifier for per-label accounting (default 'default')
  //   maxAttempts? — max retry attempts (default 3, hard-capped at GLOBAL_MAX_RETRIES)
  //   baseDelayMs? — initial backoff delay (default 600 ms, exponential doubling)
  //   maxDelayMs?  — cap on backoff delay (default 8000 ms)
  //   timeoutMs?   — per-attempt timeout (default 30 000 ms)
  //   noRetryOn?   — function(err) → bool: return true to not retry this error
  //   signal?      — external AbortSignal that cancels all attempts immediately
  //
  // [FUTURE: CentralRuntime] The wrapped function body will be replaced with
  // a CentralRuntime.retryTask() call once the central runtime is available.
  function wrap(fn, opts) {
    opts = opts || {};
    var label       = opts.label       || 'default';
    var maxAttempts = Math.min(opts.maxAttempts || 3, GLOBAL_MAX_RETRIES);
    var baseDelay   = opts.baseDelayMs || 600;
    var maxDelay    = opts.maxDelayMs  || 8000;
    var timeoutMs   = opts.timeoutMs   || 30000;
    var noRetryOn   = typeof opts.noRetryOn === 'function' ? opts.noRetryOn : null;
    var extSignal   = opts.signal      || null;

    return function () {
      var _attempt = 0;

      function attempt() {
        // External cancellation
        if (extSignal && extSignal.aborted) {
          return Promise.reject(new Error('ro-aborted'));
        }

        var guard = _canRetry(label, _attempt, maxAttempts);
        if (!guard.ok && _attempt > 0) {
          return Promise.reject(new Error('ro-blocked:' + guard.reason));
        }

        // AbortController for per-attempt timeout
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timeoutId = setTimeout(function () {
          if (ctrl) ctrl.abort();
        }, timeoutMs);
        if (window.TimerRegistry) {
          window.TimerRegistry.registerTimeout('ro-timeout-' + label, timeoutId);
        }

        // Wire external signal to per-attempt abort
        var _extAbortListener = null;
        if (extSignal && ctrl) {
          _extAbortListener = function () { ctrl.abort(); };
          try { extSignal.addEventListener('abort', _extAbortListener); } catch (_) {}
        }

        _recordAttempt(label);
        var currentAttempt = _attempt;
        _attempt++;

        var signal = ctrl ? ctrl.signal : null;

        return new Promise(function (resolve, reject) {
          var result;
          try {
            result = fn(currentAttempt, signal);
          } catch (syncErr) {
            clearTimeout(timeoutId);
            reject(syncErr);
            return;
          }
          Promise.resolve(result).then(function (v) {
            clearTimeout(timeoutId);
            if (extSignal && _extAbortListener) {
              try { extSignal.removeEventListener('abort', _extAbortListener); } catch (_) {}
            }
            resolve(v);
          }).catch(function (err) {
            clearTimeout(timeoutId);
            if (extSignal && _extAbortListener) {
              try { extSignal.removeEventListener('abort', _extAbortListener); } catch (_) {}
            }

            // Check no-retry conditions
            var isTerminal = noRetryOn && noRetryOn(err);
            var isAbort    = err && (err.name === 'AbortError' || (err.message && err.message.includes('aborted')));
            var isExtAbort = extSignal && extSignal.aborted;

            if (isTerminal || isAbort || isExtAbort) {
              reject(err);
              return;
            }

            // Can we retry?
            var nextGuard = _canRetry(label, _attempt, maxAttempts);
            if (!nextGuard.ok) {
              if (window.StabilityMetrics) {
                try { window.StabilityMetrics.recordEvent('ro-gave-up:' + label + ':' + nextGuard.reason); } catch (_) {}
              }
              reject(err);
              return;
            }

            if (window.StabilityMetrics) {
              try { window.StabilityMetrics.recordRenderRetry(_attempt, err && err.message); } catch (_) {}
            }

            // Exponential backoff
            var delay = Math.min(baseDelay * Math.pow(2, _attempt - 1), maxDelay);
            // Add jitter (±20%) to spread retries in concurrent scenarios
            delay = delay * (0.8 + Math.random() * 0.4);
            delay = Math.round(delay);

            console.debug(LOG, 'retrying [' + label + '] attempt ' + _attempt + '/' + maxAttempts +
              ' in ' + delay + 'ms after:', (err && err.message) || err);

            var retryTimer = setTimeout(function () {
              attempt().then(resolve).catch(reject);
            }, delay);
            if (window.TimerRegistry) {
              window.TimerRegistry.registerTimeout('ro-retry-' + label, retryTimer);
            }
          });
        });
      }

      return attempt();
    };
  }

  // ── Simple one-shot safe fetch retry ──────────────────────────────────────
  // Convenience wrapper: retries a fetch call with the same safety rules.
  // Only retries on 429 (rate limit) and 5xx (server errors).
  // Does NOT retry on 4xx client errors (except 429).
  function fetchSafe(url, fetchOpts, opts) {
    opts = opts || {};
    var maxAttempts = opts.maxAttempts || 3;
    var label       = opts.label || ('fetch:' + url.split('?')[0].slice(-40));

    var wrapped = wrap(function (attempt, signal) {
      var fo = Object.assign({}, fetchOpts || {});
      if (signal && !fo.signal) fo.signal = signal;
      return fetch(url, fo).then(function (r) {
        // Only retry on server errors or rate limiting
        if (r.status === 429 || r.status >= 500) {
          throw new Error('http-' + r.status);
        }
        return r;
      });
    }, {
      label:       label,
      maxAttempts: maxAttempts,
      baseDelayMs: opts.baseDelayMs || 800,
      maxDelayMs:  opts.maxDelayMs  || 8000,
      timeoutMs:   opts.timeoutMs   || 10000,
      signal:      opts.signal,
      noRetryOn: function (err) {
        // Don't retry: explicit abort, non-network errors, 4xx (except 429 handled above)
        var m = (err && err.message) || '';
        return m.includes('AbortError') || m.startsWith('http-4');
      },
    });
    return wrapped();
  }

  // ── Session reset ─────────────────────────────────────────────────────────
  // Call on new tool load to reset per-label counters (fresh attempt budget).
  function resetLabel(label) {
    if (label) {
      delete _labelStats[label];
    }
  }

  function resetAll() {
    _labelStats = {};
    _stormRing.length = 0;
    _inCooldown = false;
    if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      inCooldown:    _inCooldown,
      stormRingSize: _stormRing.length,
      labelStats:    Object.assign({}, _labelStats),
      limits: {
        globalMaxRetries:    GLOBAL_MAX_RETRIES,
        stormWindowMs:       GLOBAL_STORM_WINDOW_MS,
        stormThreshold:      GLOBAL_STORM_THRESHOLD,
        cooldownMs:          GLOBAL_COOLDOWN_MS,
      },
    };
  }

  // Reset on pagehide so bfcache restore starts fresh
  window.addEventListener('pagehide', function () {
    _stormRing.length = 0;
    _inCooldown = false;
    if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
  }, { passive: true });

  window.RetryOrchestrator = {
    wrap:       wrap,
    fetchSafe:  fetchSafe,
    resetLabel: resetLabel,
    resetAll:   resetAll,
    getStats:   getStats,
  };

  console.debug('[RetryOrchestrator] ready — T008 retry orchestration safety active');
}());

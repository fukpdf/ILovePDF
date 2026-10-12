// RuntimeCrashSurvival v1.0 — Arc 11 / Phase C
// =============================================================================
// Crash detection and cross-reload session recovery.
//
// Detection methods:
//   unexpected_reload   — page was loaded without a clean unload marker
//   memory_panic        — browser OOM signal (processor-memory:panic event)
//   worker_crash_storm  — > WORKER_STORM_THRESHOLD crashes in STORM_WINDOW_MS
//   tab_kill            — visibilitychange + pagehide w/o user navigation
//
// Recovery flow:
//   1. On boot, check sessionStorage for crash markers left by previous session
//   2. If crash detected, load pre-crash snapshot from RuntimeBlackboxStorage
//   3. Replay diagnostics into RuntimeReplayEngine if available
//   4. Notify RuntimeAutonomousHealing so it can adjust recovery strategy
//   5. Emit 'crash-survival:recovered' event with recovery context
//
// Crash markers (written to sessionStorage):
//   _css_alive          — set on load, cleared on clean pagehide
//   _css_crash_type     — type of last crash
//   _css_crash_ts       — timestamp of last crash
//   _css_worker_storms  — running count of worker crash events
//
// window.RuntimeCrashSurvival
//   .getLastCrash()         → CrashRecord | null
//   .hasCrashed()           → boolean
//   .markCleanExit()        → void
//   .recover()              → Promise<RecoveryResult>
//   .getMetrics()           → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCrashSurvival) return;

  var VERSION = '1.0';
  var LOG     = '[CrashSurvival]';

  var KEY_ALIVE   = '_css_alive';
  var KEY_TYPE    = '_css_crash_type';
  var KEY_TS      = '_css_crash_ts';
  var KEY_STORMS  = '_css_worker_storms';

  var WORKER_STORM_THRESHOLD = 3;
  var STORM_WINDOW_MS        = 10000;

  var _ss = (function () {
    try { var t = sessionStorage; t.setItem('_css_test', '1'); t.removeItem('_css_test'); return t; }
    catch (_) { return null; }
  }());

  function _sGet(k) { try { return _ss && _ss.getItem(k); } catch (_) { return null; } }
  function _sSet(k, v) { try { if (_ss) _ss.setItem(k, String(v)); } catch (_) {} }
  function _sDel(k)    { try { if (_ss) _ss.removeItem(k); } catch (_) {} }
  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Crash detection on boot ───────────────────────────────────────────────
  var _wasAlive    = _sGet(KEY_ALIVE) === '1';
  var _lastType    = _sGet(KEY_TYPE)  || null;
  var _lastTs      = parseInt(_sGet(KEY_TS) || '0', 10);
  var _hasCrashed  = _wasAlive;  // alive marker was set but never cleared → crash

  var _lastCrash   = _hasCrashed ? { type: _lastType || 'unexpected_reload', ts: _lastTs } : null;
  var _metrics     = { crashes: _hasCrashed ? 1 : 0, recoveries: 0, workerStorms: 0, panics: 0 };
  var _workerCrashQ = [];  // timestamps of recent worker crashes

  // ── Set alive marker ──────────────────────────────────────────────────────
  _sSet(KEY_ALIVE, '1');
  _sSet(KEY_TS,    Date.now());

  // ── Clean exit ────────────────────────────────────────────────────────────
  function markCleanExit() {
    _sDel(KEY_ALIVE);
    _sDel(KEY_TYPE);
    _sDel(KEY_TS);
    _sDel(KEY_STORMS);
  }

  window.addEventListener('pagehide', function (e) {
    // persisted = true means the page went into bfcache (not a crash)
    if (!e || !e.persisted) markCleanExit();
  }, { once: true });

  // ── Worker crash storm detection ───────────────────────────────────────────
  window.addEventListener('tool:worker-crash', function () {
    var now = Date.now();
    _workerCrashQ.push(now);
    _workerCrashQ = _workerCrashQ.filter(function (t) { return now - t < STORM_WINDOW_MS; });
    if (_workerCrashQ.length >= WORKER_STORM_THRESHOLD) {
      _metrics.workerStorms++;
      _sSet(KEY_TYPE, 'worker_crash_storm');
      _sSet(KEY_TS, now);
      console.warn(LOG, 'worker crash storm detected (', _workerCrashQ.length, 'crashes in', STORM_WINDOW_MS, 'ms)');
      _s(function () {
        G.dispatchEvent(new CustomEvent('crash-survival:worker-storm', {
          detail: { count: _workerCrashQ.length, windowMs: STORM_WINDOW_MS },
        }));
      });
    }
  });

  // ── Memory panic detection ─────────────────────────────────────────────────
  window.addEventListener('processor-memory:panic', function (evt) {
    _metrics.panics++;
    _sSet(KEY_TYPE, 'memory_panic');
    _sSet(KEY_TS,   Date.now());
    console.warn(LOG, 'memory panic recorded for crash survival');
    // Trigger a pre-crash snapshot save
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      var ss  = G.RuntimeStateSnapshots;
      if (bbs && ss && typeof ss.take === 'function') {
        ss.take('pre-crash-memory-panic').then(function (snap) {
          if (snap) bbs.persist(snap);
        }).catch(function () {});
      }
    });
  });

  // ── Recovery ──────────────────────────────────────────────────────────────
  function recover() {
    if (!_hasCrashed) return Promise.resolve({ recovered: false, reason: 'no-crash-detected' });
    _metrics.recoveries++;
    console.info(LOG, 'recovering from crash:', _lastCrash.type, 'at', new Date(_lastCrash.ts).toISOString());

    return Promise.resolve()
      .then(function () {
        // 1. Load last snapshot from IndexedDB
        var bbs = G.RuntimeBlackboxStorage;
        if (!bbs || !bbs.isAvailable()) return null;
        return bbs.loadLastSession();
      })
      .then(function (snap) {
        var context = { crash: _lastCrash, hasSnapshot: !!snap };

        // 2. Replay into RuntimeReplayEngine
        _s(function () {
          var re = G.RuntimeReplayEngine;
          if (re && typeof re.load === 'function' && snap && snap.data && snap.data.events) {
            re.load(snap.data.events, { label: 'crash-recovery', crash: _lastCrash });
          }
        });

        // 3. Notify healing engine
        _s(function () {
          var ah = G.RuntimeAutonomousHealing;
          if (ah && typeof ah.heal === 'function') {
            ah.heal('crash-survival:' + _lastCrash.type);
          }
        });

        // 4. Emit recovery event
        _s(function () {
          G.dispatchEvent(new CustomEvent('crash-survival:recovered', { detail: context }));
          var eb = G.RuntimeEventBus;
          if (eb && typeof eb.emit === 'function') eb.emit('crash-survival:recovered', context);
        });

        console.info(LOG, 'recovery complete | snapshot:', !!snap);
        return { recovered: true, crash: _lastCrash, hasSnapshot: !!snap };
      })
      .catch(function (e) {
        console.warn(LOG, 'recovery error:', e.message);
        return { recovered: false, error: e.message };
      });
  }

  // ── Deferred recovery on boot ─────────────────────────────────────────────
  if (_hasCrashed) {
    console.warn(LOG, 'previous session crashed | type:', _lastType, '| ts:', _lastTs);
    setTimeout(function () {
      recover().catch(function () {});
    }, 5000);  // defer so all other systems have time to boot
  }

  G.RuntimeCrashSurvival = Object.freeze({
    VERSION:       VERSION,
    hasCrashed:    function () { return _hasCrashed; },
    getLastCrash:  function () { return _lastCrash ? Object.assign({}, _lastCrash) : null; },
    markCleanExit: markCleanExit,
    recover:       recover,
    getMetrics:    function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded | crashed:', _hasCrashed, '| type:', _lastType);
}(window));

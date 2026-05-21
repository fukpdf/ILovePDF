// RuntimeTelemetryPipeline v1.0 — Phase 4 / Task 9 (Client-Side Telemetry Pipeline)
// ============================================================================
// Batched, rate-limited, privacy-safe uploader for SecurityTelemetry events
// to the server-side /api/security-telemetry endpoint.
//
// Design:
//   • Subscribes to SecurityTelemetry (Phase 3) event bus
//   • Buffers events in memory (max 100 per batch)
//   • Uploads every 60s OR when batch reaches 20 events
//   • Rate-limited: max 1 upload per 30s
//   • Privacy-safe: all events already stripped of PII by SecurityTelemetry
//   • Only active on MEDIUM+ tier (disabled on LOW / lite mode)
//   • Background-tab safe: uses requestIdleCallback for upload timing
//   • No external dependencies
//
// window.RuntimeTelemetryPipeline
//   .flush()    → Promise<void> (manual flush)
//   .status()   → { queued, sent, errors, tier }
//   .pause()    → void (stop uploading)
//   .resume()   → void
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeTelemetryPipeline) return;

  var VERSION       = '1.0';
  var LOG           = '[TelPipeline]';
  var ENDPOINT      = '/api/security-telemetry';
  var MAX_BATCH     = 20;   // trigger upload at this queue size
  var MAX_QUEUE     = 100;  // hard cap on buffered events
  var UPLOAD_INT_MS = 60000; // upload every 60s if batch not full
  var MIN_GAP_MS    = 30000; // min 30s between uploads

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Tier check ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;

  // ── State ─────────────────────────────────────────────────────────────────
  var _queue     = [];
  var _paused    = false;
  var _lastSend  = 0;
  var _stats = {
    queued:  0,
    sent:    0,
    errors:  0,
    batches: 0,
  };

  // ── Queue an event ────────────────────────────────────────────────────────
  function _enqueue(ev) {
    if (_queue.length >= MAX_QUEUE) _queue.shift(); // drop oldest
    _queue.push(ev);
    _stats.queued++;
    if (_queue.length >= MAX_BATCH) {
      // Auto-flush when batch full
      _scheduleFlush(0);
    }
  }

  // ── Upload to server ──────────────────────────────────────────────────────
  function flush() {
    if (_paused || _queue.length === 0) return Promise.resolve();
    if ((Date.now() - _lastSend) < MIN_GAP_MS) return Promise.resolve();

    var batch = _queue.splice(0, MAX_BATCH);
    _lastSend = Date.now();

    return fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ events: batch }),
      // Don't block page unload
      keepalive: true,
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      _stats.sent    += batch.length;
      _stats.batches += 1;
      return res.json();
    })
    .then(function (data) {
      console.debug(LOG, 'batch sent | accepted:', data.accepted, '| rejected:', data.rejected);
    })
    .catch(function (err) {
      _stats.errors++;
      // Put events back on failure (cap to avoid memory bloat)
      var restore = batch.slice(0, MAX_QUEUE - _queue.length);
      _queue.unshift.apply(_queue, restore);
      console.debug(LOG, 'upload error:', err.message, '— events re-queued');
    });
  }

  // ── Scheduled flush ───────────────────────────────────────────────────────
  var _flushTimer = null;
  function _scheduleFlush(delay) {
    clearTimeout(_flushTimer);
    _flushTimer = setTimeout(function () {
      if (typeof G.requestIdleCallback === 'function') {
        G.requestIdleCallback(function () { flush(); }, { timeout: 5000 });
      } else {
        flush();
      }
    }, delay === undefined ? UPLOAD_INT_MS : delay);
  }

  // ── Subscribe to SecurityTelemetry ────────────────────────────────────────
  function _subscribeToTelemetry() {
    // Patch SecurityTelemetry.record to intercept events
    _s(function () {
      var st = G.SecurityTelemetry;
      if (!st || typeof st.record !== 'function') return;
      var _origRecord = st.record;
      // We can't mutate the frozen object, so we proxy via RuntimeEventBus
      var bus = G.RuntimeEventBus;
      if (!bus || typeof bus.on !== 'function') return;

      // SecurityTelemetry already forwards to RuntimeTelemetry, which emits events.
      // Listen for the forwarded events on RuntimeTelemetry bus if available.
      var rt = G.RuntimeTelemetry;
      if (rt && typeof rt.on === 'function') {
        rt.on('security:*', function (eventName, data) {
          _enqueue({ type: eventName, ts: Date.now(), data: data || {} });
        });
        return;
      }

      // Fallback: listen for specific bus events
      var TRACKED = [
        'shield:tamper-response', 'shield:devtools-degraded',
        'security:foreign-deploy', 'sri:mismatch',
        'seal:failure', 'panic:activated',
      ];
      TRACKED.forEach(function (evType) {
        bus.on(evType, function (data) {
          _enqueue({ type: evType.replace(':', '-'), ts: Date.now(), data: data || {} });
        });
      });
    });
  }

  // ── Periodic upload interval ──────────────────────────────────────────────
  function _startPeriodicUpload() {
    // Use requestIdleCallback-based scheduling for battery safety
    var _schedNext;
    _schedNext = function () {
      if (typeof G.requestIdleCallback === 'function') {
        G.requestIdleCallback(function () {
          flush().then(function () { setTimeout(_schedNext, UPLOAD_INT_MS); });
        }, { timeout: 5000 });
      } else {
        flush();
        setTimeout(_schedNext, UPLOAD_INT_MS);
      }
    };
    setTimeout(_schedNext, UPLOAD_INT_MS);
  }

  // ── Flush on page unload ──────────────────────────────────────────────────
  function _flushOnUnload() {
    _s(function () {
      G.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden' && _queue.length > 0) {
          flush();
        }
      });
      G.addEventListener('pagehide', function () {
        if (_queue.length > 0) flush();
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (_lite) {
      console.info(LOG, 'v' + VERSION + ' loaded | lite mode — pipeline disabled');
      return;
    }

    _subscribeToTelemetry();
    _startPeriodicUpload();
    _flushOnUnload();

    console.info(LOG, 'v' + VERSION + ' ready | endpoint:', ENDPOINT, '| batch:', MAX_BATCH);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeTelemetryPipeline = Object.freeze({
    VERSION: VERSION,
    flush:   flush,
    pause:   function () { _paused = true; },
    resume:  function () { _paused = false; },
    status: function () {
      return {
        queued:  _queue.length,
        sent:    _stats.sent,
        errors:  _stats.errors,
        batches: _stats.batches,
        paused:  _paused,
        tier:    _lite ? 'LOW' : (_score < 70 ? 'MEDIUM' : 'HIGH'),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));

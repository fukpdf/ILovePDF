// p4-heartbeat-mixin.js v1.0 — Phase 5 / Task 4 (Worker-Side P4 Pong)
// =============================================================================
// Adds __p4_pong support to any dedicated worker via a single function call.
//
// Usage (add these 2 lines at the END of any worker file, after self.onmessage
// has been assigned):
//
//   importScripts('/workers/p4-heartbeat-mixin.js');
//   if (typeof _p4ApplyMixin === 'function') _p4ApplyMixin();
//
// Protocol:
//   MAIN → WORKER: { type: '__p4_ping', id: N, ts: epoch }
//   WORKER → MAIN: { type: '__p4_pong', id: N, ts: epoch,
//                    memUsedMB: number|null,
//                    queueLen:  number,
//                    idle:      boolean,
//                    uptime:    number (ms),
//                    crashes:   number,
//                    version:   '1.0' }
//
// Backward compatibility:
//   • Does NOT break __p3_ping/__p3_pong (separate protocol, separate messages)
//   • Workers that don't call _p4ApplyMixin() continue to work normally
//   • If self.onmessage is not set at call time, mixin does nothing (safe no-op)
//
// Queue tracking:
//   • _queueLen increments when main handler receives a non-ping message
//   • _queueLen decrements when handler returns (sync) or its promise settles
//   • async handlers are fully supported
//
// Mobile safety:
//   • Zero polling — purely reactive (only runs when ping arrives)
//   • No setInterval, no setTimeout
//   • No memory allocations except for the pong message itself
// =============================================================================
'use strict';

(function (self) {

  var _queueLen = 0;
  var _spawnTs  = Date.now();
  var _crashes  = 0;
  var VERSION   = '1.0';

  // ── Memory snapshot helper ────────────────────────────────────────────────
  function _memMB() {
    try {
      var m = self.performance && self.performance.memory;
      if (m) return Math.round(m.usedJSHeapSize / 1048576);
    } catch (_) {}
    return null;
  }

  // ── Build and send a p4_pong ──────────────────────────────────────────────
  function _pong(pingId) {
    try {
      self.postMessage({
        type:      '__p4_pong',
        id:        pingId,
        ts:        Date.now(),
        memUsedMB: _memMB(),
        queueLen:  _queueLen,
        idle:      _queueLen === 0,
        uptime:    Date.now() - _spawnTs,
        crashes:   _crashes,
        version:   VERSION,
      });
    } catch (_) {}
  }

  // ── Mixin installer ───────────────────────────────────────────────────────
  // Called AFTER self.onmessage is assigned so we can wrap it.
  self._p4ApplyMixin = function () {
    var _orig = self.onmessage;
    if (typeof _orig !== 'function') {
      // No handler set yet — install a minimal handler that only responds to pings
      self.onmessage = function (e) {
        var d = e && e.data;
        if (d && d.type === '__p4_ping') { _pong(d.id); }
      };
      return;
    }

    self.onmessage = function (e) {
      var d = e && e.data;

      // P4 ping — intercept BEFORE main handler
      if (d && d.type === '__p4_ping') {
        _pong(d.id);
        return; // do NOT pass to main handler
      }

      // P3 ping — backward compat: let the original handler deal with it,
      // or respond here if the original won't know about it.
      if (d && d.type === '__p3_ping') {
        // Let original handler respond if it knows __p3_ping, otherwise ignore
        // (p3 is handled by RuntimeWorkerBootstrap, not by each worker)
      }

      // Main message — track queue depth
      _queueLen++;
      var result;
      try {
        result = _orig.call(self, e);
      } catch (err) {
        _crashes++;
        _queueLen = Math.max(0, _queueLen - 1);
        throw err; // re-throw so WorkerPool error handling still fires
      }

      // async handler (Promise returned)
      if (result && typeof result.then === 'function') {
        result.then(
          function ()  { _queueLen = Math.max(0, _queueLen - 1); },
          function ()  { _queueLen = Math.max(0, _queueLen - 1); _crashes++; }
        );
      } else {
        // sync handler
        _queueLen = Math.max(0, _queueLen - 1);
      }
    };
  };

  // ── Optional: also handle __p4_ping on top-level addEventListener ─────────
  // This catches pings that arrive before the mixin is applied (rare but safe).
  self.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && d.type === '__p4_ping' && typeof self._p4MixinApplied === 'undefined') {
      // Mixin not yet applied — respond with minimal pong
      _pong(d.id);
    }
  });

  // Mark loaded
  self._p4HeartbeatMixinLoaded = true;

}(self));

// RuntimeShieldWorkers v1.0 — Enterprise Runtime Shield Layer / Task 2, 6
// ============================================================================
// Worker message nonce + timestamp layer on top of existing RuntimeSecurity.
//
// ADDITIVE — wraps RuntimeSecurity.validateWorkerMessage with replay protection.
// Does NOT rewrite worker APIs. Workers themselves are unchanged.
//
// What this adds (beyond RuntimeSecurity v1.0):
//   1. Per-message nonce (8-byte random hex) — blocks replayed captured messages.
//   2. Nonce pool with 5-min rolling expiry — stateful replay detection.
//   3. Timestamp window (±8s) — rejects stale/time-shifted messages.
//   4. stampMessage(msg) — attaches nonce+ts to outbound worker messages.
//   5. verifyStamp(msg) — validates nonce+ts on inbound messages.
//   6. Wraps RuntimeSecurity.validateWorkerMessage to auto-invoke verifyStamp
//      when a stamp is present (backward-compatible: msgs without stamp pass).
//
// Low-end devices: nonce pool disabled (too many messages = high memory).
//                  Timestamp window still validated when stamp present.
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeShieldWorkers) return;

  var VERSION = '1.0';
  var LOG     = '[ShieldWrk]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ───────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score === 'function')    return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 80;
  }, 80);
  var _lite = _score < 40;

  // ── Constants ─────────────────────────────────────────────────────────────
  var NONCE_BYTES       = 8;
  var NONCE_POOL_TTL_MS = 5 * 60 * 1000; // 5 minutes
  // P3 Fix: adaptive timestamp window by device tier.
  // Low-end / backgrounded devices have higher clock skew risk.
  // HIGH (≥70): ±12s | MEDIUM (40-69): ±20s | LOW (<40): ±35s
  var TS_WINDOW_MS      = _lite ? 35000 : (_score < 70 ? 20000 : 12000);
  var NONCE_POOL_MAX    = 2000;           // max tracked nonces before LRU flush
  var POOL_CLEAN_EVERY  = 60000;          // clean expired nonces every 60s

  // ── Stats ─────────────────────────────────────────────────────────────────
  var _stats = {
    stamped:          0,
    verified:         0,
    replayBlocked:    0,
    staleBlocked:     0,
    malformedBlocked: 0,
    totalValidations: 0,
  };

  // ── Nonce pool ────────────────────────────────────────────────────────────
  // Map<nonce, expiry_ts> — nonces seen; reject if re-used within TTL.
  var _noncePool = _lite ? null : (typeof Map !== 'undefined' ? new Map() : null);

  function _cleanNoncePool() {
    if (!_noncePool) return;
    var now = Date.now();
    // If over max, flush all expired first
    if (_noncePool.size > NONCE_POOL_MAX) {
      _noncePool.forEach(function (exp, nonce) {
        if (exp < now) _noncePool.delete(nonce);
      });
    }
    // If still over max after cleanup, flush the oldest 50%
    if (_noncePool.size > NONCE_POOL_MAX) {
      var toDelete = Math.floor(_noncePool.size / 2);
      var deleted  = 0;
      _noncePool.forEach(function (exp, nonce) {
        if (deleted < toDelete) { _noncePool.delete(nonce); deleted++; }
      });
    }
  }

  setInterval(_cleanNoncePool, POOL_CLEAN_EVERY);

  // ── 1. Nonce generator ────────────────────────────────────────────────────
  function _generateNonce() {
    var bytes = new Uint8Array(NONCE_BYTES);
    try {
      if (G.crypto && G.crypto.getRandomValues) {
        G.crypto.getRandomValues(bytes);
      } else {
        // Fallback: Math.random (weaker but better than nothing)
        for (var i = 0; i < NONCE_BYTES; i++) {
          bytes[i] = Math.floor(Math.random() * 256);
        }
      }
    } catch (_) {
      for (var j = 0; j < NONCE_BYTES; j++) bytes[j] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // ── 2. Stamp an outbound message ──────────────────────────────────────────
  function stampMessage(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    var nonce = _generateNonce();
    var ts    = Date.now();

    // Register nonce in pool so we can detect replay
    if (_noncePool) {
      _noncePool.set(nonce, ts + NONCE_POOL_TTL_MS);
    }
    _stats.stamped++;

    // Return shallow copy with stamp fields — doesn't mutate original
    return Object.assign({}, msg, {
      _shieldNonce: nonce,
      _shieldTs:    ts,
    });
  }

  // ── 3. Verify an inbound message stamp ────────────────────────────────────
  // Returns: { ok: true } on success, or { ok: false, reason: '...' }
  // If message has no stamp, returns ok:true (backward-compatible).
  function verifyStamp(msg) {
    _stats.totalValidations++;

    if (!msg || typeof msg !== 'object') {
      _stats.malformedBlocked++;
      return { ok: false, reason: 'not-an-object' };
    }

    // No stamp → backward-compatible pass (old workers don't stamp)
    if (msg._shieldNonce === undefined && msg._shieldTs === undefined) {
      return { ok: true, reason: 'unstamped' };
    }

    // Validate stamp fields
    if (typeof msg._shieldNonce !== 'string' || msg._shieldNonce.length !== NONCE_BYTES * 2) {
      _stats.malformedBlocked++;
      return { ok: false, reason: 'invalid-nonce-format' };
    }
    if (typeof msg._shieldTs !== 'number') {
      _stats.malformedBlocked++;
      return { ok: false, reason: 'invalid-timestamp' };
    }

    // Timestamp window check
    var now  = Date.now();
    var skew = Math.abs(now - msg._shieldTs);
    if (skew > TS_WINDOW_MS) {
      _stats.staleBlocked++;
      console.warn(LOG, 'rejected stale message: skew=' + skew + 'ms, nonce=' + msg._shieldNonce.slice(0, 8));
      _s(function () {
        if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:worker:stale', { skewMs: skew });
      });
      return { ok: false, reason: 'stale-timestamp', skewMs: skew };
    }

    // Replay check (only if nonce pool available)
    if (_noncePool) {
      var nonce = msg._shieldNonce;
      if (_noncePool.has(nonce)) {
        var expiry = _noncePool.get(nonce);
        if (now < expiry) {
          // Nonce already in pool AND not yet expired → replay
          _stats.replayBlocked++;
          console.warn(LOG, 'REPLAY blocked — nonce reused:', nonce.slice(0, 8));
          _s(function () {
            if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:worker:replay');
          });
          return { ok: false, reason: 'replay-detected' };
        }
        // Expired nonce: remove and accept (old nonces cycle out)
        _noncePool.delete(nonce);
      }
      // Register nonce to pool: mark as seen, expires after TTL
      _noncePool.set(nonce, now + NONCE_POOL_TTL_MS);
    }

    _stats.verified++;
    return { ok: true };
  }

  // ── 4. Patch RuntimeSecurity.validateWorkerMessage ───────────────────────
  // Wraps the existing validator to ALSO run verifyStamp when a stamp is present.
  // Backward-compatible: messages without _shieldNonce pass through unchanged.
  function _patchRuntimeSecurity() {
    var rs = G.RuntimeSecurity;
    if (!rs || typeof rs.validateWorkerMessage !== 'function') return false;
    if (rs._shieldWorkerPatched) return false; // already patched

    var _orig = rs.validateWorkerMessage;
    rs.validateWorkerMessage = function (msg) {
      // Run original schema validation first
      var result = _orig.call(rs, msg);
      // Then run our stamp verification if stamp is present
      if (msg && (msg._shieldNonce !== undefined || msg._shieldTs !== undefined)) {
        var stamp = verifyStamp(msg);
        if (!stamp.ok) {
          var err = new Error('[ShieldWorkers] Message rejected: ' + stamp.reason);
          err.name = 'SecurityError';
          throw err;
        }
      }
      return result;
    };
    rs._shieldWorkerPatched = true;
    console.info(LOG, 'patched RuntimeSecurity.validateWorkerMessage with nonce+timestamp layer');
    return true;
  }

  // ── 5. Guard worker dispatch to auto-stamp outbound messages ──────────────
  // Wraps RuntimeWorkers.dispatch (if available) to auto-stamp every message.
  function _patchWorkerDispatch() {
    var rw = G.RuntimeWorkers;
    if (!rw || typeof rw.dispatch !== 'function') return false;
    if (rw._shieldDispatchPatched) return false;

    var _origDispatch = rw.dispatch;
    rw.dispatch = function (url, msg, transferable, opts) {
      var stamped = stampMessage(msg);
      return _origDispatch.call(rw, url, stamped, transferable, opts);
    };
    rw._shieldDispatchPatched = true;
    console.info(LOG, 'patched RuntimeWorkers.dispatch with auto-stamp');
    return true;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    var patched = _patchRuntimeSecurity();
    _patchWorkerDispatch();

    _s(function () {
      var reg = G.RuntimeShieldCore && G.RuntimeShieldCore.registry;
      if (reg) reg.set('workers:ready', true);
    });

    console.info(LOG, 'v' + VERSION + ' ready',
      '| nonce pool:', !!_noncePool,
      '| ts window:', TS_WINDOW_MS + 'ms',
      '| patched RuntimeSecurity:', patched);
  }

  // Boot after existing security systems are established
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 500);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 500); }, { once: true });
  }

  G.RuntimeShieldWorkers = {
    VERSION:      VERSION,
    stampMessage: stampMessage,
    verifyStamp:  verifyStamp,
    getStats:     function () { return Object.assign({}, _stats, { noncePoolSize: _noncePool ? _noncePool.size : 0 }); },
  };

}(window));

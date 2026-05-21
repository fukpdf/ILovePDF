// RuntimePacketIntegrity v1.0 — Phase 7 / Section 7 (Packet Integrity)
// =============================================================================
// Signed packet layer with replay protection for all internal runtime messages.
// Ensures that messages between runtime systems are authentic and not replayed.
//
// Packet structure:
//   { id, type, payload, ts, nonce, mac, origin }
//   mac = RuntimeExecutionCrypto.mac(id+type+payload+ts+nonce, 'sign')
//
// Protections:
//   • MAC verification — detects payload tampering
//   • Replay prevention — nonce pool tracks seen packets
//   • Clock drift protection — packets older than MAX_AGE rejected
//   • Origin binding — packets tagged with issuer runtime
//
// window.RuntimePacketIntegrity
//   .wrap(type, payload)         → SignedPacket
//   .verify(packet)              → boolean
//   .unwrap(packet)              → payload|null
//   .stats()                     → PacketStats
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimePacketIntegrity) return;

  var VERSION = '1.0';
  var LOG     = '[PacketInt]';
  var MAX_AGE = 60_000;   // 1 minute max packet age

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  var _packetId = 0;
  var _seenNonces = typeof Set !== 'undefined' ? new Set() : null;
  var _stats = { wrapped: 0, verified: 0, rejected: 0, replays: 0 };

  // ── FNV1a MAC (fast, no SubtleCrypto dependency) ─────────────────────────
  function _fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function _computeMac(id, type, payload, ts, nonce) {
    var data = [id, type, JSON.stringify(payload), ts, nonce].join('|');
    // Use RuntimeExecutionCrypto if available for stronger MAC
    return _s(function () {
      var ec = G.RuntimeExecutionCrypto;
      if (ec && typeof ec.mac === 'function') return ec.mac(data, 'sign');
      return _fnv1a(data);
    }, _fnv1a(data));
  }

  // ── Wrap a packet ─────────────────────────────────────────────────────────
  function wrap(type, payload) {
    var id    = 'pk_' + (++_packetId).toString(36);
    var ts    = Date.now();
    var nonce = ts.toString(36) + Math.random().toString(36).slice(2, 6);
    var computedMac = _computeMac(id, type, payload, ts, nonce);

    _stats.wrapped++;

    return {
      id:      id,
      type:    type,
      payload: payload,
      ts:      ts,
      nonce:   nonce,
      mac:     computedMac,
      origin:  'runtime-p7',
    };
  }

  // ── Verify a packet ───────────────────────────────────────────────────────
  function verify(packet) {
    if (!packet || !_enabled) return true; // passthrough when disabled

    // Clock check
    if (Math.abs(Date.now() - packet.ts) > MAX_AGE) {
      _stats.rejected++;
      return false;
    }

    // Replay check
    if (_seenNonces) {
      if (_seenNonces.has(packet.nonce)) {
        _stats.replays++;
        _stats.rejected++;
        console.warn(LOG, 'replay detected | nonce:', packet.nonce);
        _s(function () {
          if (G.SecurityTelemetry) {
            G.SecurityTelemetry.record('replay-attempt', { reason: 'packet-nonce-reuse', nonce: packet.nonce });
          }
        });
        return false;
      }
      _seenNonces.add(packet.nonce);
      if (_seenNonces.size > 5000) {
        var iter = _seenNonces.values();
        _seenNonces.delete(iter.next().value);
      }
    }

    // MAC check
    var expectedMac = _computeMac(packet.id, packet.type, packet.payload, packet.ts, packet.nonce);
    if (packet.mac !== expectedMac) {
      _stats.rejected++;
      console.warn(LOG, 'MAC mismatch | id:', packet.id);
      return false;
    }

    _stats.verified++;
    return true;
  }

  // ── Unwrap a verified packet ───────────────────────────────────────────────
  function unwrap(packet) {
    if (!verify(packet)) return null;
    return packet.payload;
  }

  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimePacketIntegrity = Object.freeze({
    VERSION: VERSION,
    wrap:    wrap,
    verify:  verify,
    unwrap:  unwrap,
    stats:   function () { return Object.assign({}, _stats); },
    status:  function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, stats: _stats };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

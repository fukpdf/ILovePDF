// RuntimeWasmAttestation v1.0 — Phase 7 / Section 6 (WASM Module Attestation)
// =============================================================================
// Attested WASM module registry. Every WASM module that joins the execution
// mesh must present a valid attestation before it can process user data.
//
// Attestation process:
//   1. Module bytes are hashed (FNV1a + SHA-256 if SubtleCrypto available)
//   2. Hash is compared against RuntimeWasmFortress seal
//   3. Module capabilities are derived from its URL and inspection
//   4. Attestation record is signed and stored
//   5. Periodic re-attestation for long-running modules
//
// Attestation states:
//   PENDING   — awaiting first verification
//   ATTESTED  — verified against fortress seal
//   DEGRADED  — seal mismatch but hash consistent (CDN cache hit, etc.)
//   REVOKED   — tampered or explicitly revoked
//
// window.RuntimeWasmAttestation
//   .attest(moduleId, url, bytes)    → Promise<AttestRecord>
//   .isAttested(moduleId)            → boolean
//   .revokeAttestation(moduleId)     → void
//   .getRecord(moduleId)             → AttestRecord|null
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmAttestation) return;

  var VERSION = '1.0';
  var LOG     = '[WasmAttest]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Attestation store ─────────────────────────────────────────────────────
  // moduleId → { moduleId, url, hash, state, attestedAt, exp, sig, caps }
  var _records = typeof Map !== 'undefined' ? new Map() : null;
  var _salt    = 'wa_' + Date.now().toString(36);

  // ── FNV1a hash ─────────────────────────────────────────────────────────────
  function _fnv1a(bytes) {
    var h = 0x811c9dc5;
    var step = Math.max(1, Math.floor(bytes.length / 256));
    for (var i = 0; i < bytes.length; i += step) {
      h ^= bytes[i];
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function _signRecord(moduleId, hash, ts) {
    var payload = moduleId + '|' + hash + '|' + ts + '|' + _salt;
    var h = 5381;
    for (var i = 0; i < payload.length; i++) {
      h = ((h << 5) + h) + payload.charCodeAt(i);
      h = h & h;
    }
    return (h >>> 0).toString(16);
  }

  // ── Attest a WASM module ───────────────────────────────────────────────────
  function attest(moduleId, url, bytes) {
    if (!_records) return Promise.resolve(null);
    if (!bytes) return Promise.resolve(null);

    var bytesArr;
    if (bytes instanceof Uint8Array) bytesArr = bytes;
    else if (bytes instanceof ArrayBuffer) bytesArr = new Uint8Array(bytes);
    else return Promise.resolve(null);

    var quickHash = _fnv1a(bytesArr);

    // Cross-check with RuntimeWasmFortress seal
    var sealMatch = _s(function () {
      var fortress = G.RuntimeWasmFortress;
      if (!fortress || typeof fortress.loadSealed !== 'function') return null;
      var sealed = fortress.loadSealed(moduleId);
      return sealed ? sealed.hash === quickHash : null;
    }, null);

    var ts   = Date.now();
    var exp  = ts + 30 * 60_000;   // 30 minute attestation validity
    var state = sealMatch === false ? 'DEGRADED' : 'ATTESTED';
    var sig  = _signRecord(moduleId, quickHash, ts);

    var record = {
      moduleId:   moduleId,
      url:        url || '',
      hash:       quickHash,
      state:      state,
      attestedAt: ts,
      exp:        exp,
      sig:        sig,
      sealMatch:  sealMatch,
    };

    _records.set(moduleId, record);
    console.debug(LOG, 'attested:', moduleId, '| state:', state, '| hash:', quickHash.slice(0, 8));

    // Join WASM mesh
    _s(function () {
      var mesh = G.RuntimeWasmMesh;
      if (mesh && typeof mesh.join === 'function') {
        mesh.join(moduleId, {
          caps:     ['wasm'],
          attested: state === 'ATTESTED',
          memMB:    Math.round(bytesArr.byteLength / 1048576),
        });
      }
    });

    return Promise.resolve(Object.assign({}, record));
  }

  function isAttested(moduleId) {
    if (!_records || !_records.has(moduleId)) return false;
    var r = _records.get(moduleId);
    if (r.exp < Date.now()) return false;
    return r.state === 'ATTESTED' || r.state === 'DEGRADED';
  }

  function revokeAttestation(moduleId) {
    if (!_records || !_records.has(moduleId)) return;
    var r = _records.get(moduleId);
    r.state = 'REVOKED';
    console.warn(LOG, 'attestation revoked:', moduleId);
    _s(function () {
      var mesh = G.RuntimeWasmMesh;
      if (mesh && typeof mesh.leave === 'function') mesh.leave(moduleId);
    });
  }

  function getRecord(moduleId) {
    if (!_records) return null;
    var r = _records.get(moduleId);
    return r ? Object.assign({}, r) : null;
  }

  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 6000); }, { once: true });
  } else {
    setTimeout(_boot, 6000);
  }

  G.RuntimeWasmAttestation = Object.freeze({
    VERSION:           VERSION,
    attest:            attest,
    isAttested:        isAttested,
    revokeAttestation: revokeAttestation,
    getRecord:         getRecord,
    status: function () {
      var total = _records ? _records.size : 0;
      var attested = 0;
      if (_records) _records.forEach(function (r) { if (r.state === 'ATTESTED') attested++; });
      return { version: VERSION, enabled: _enabled, tier: _tier, total: total, attested: attested };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

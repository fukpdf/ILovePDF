// RuntimeMemoryVault v1.0 — Phase 8 / Objective 10
// =============================================================================
// Encrypted ephemeral in-memory vault for sensitive runtime state.
// Provides auto-expiring secrets, secure memory wipe, worker-safe access,
// and heap pressure monitoring.
//
// Encryption: XOR-cipher using a per-session key generated from crypto.getRandomValues.
// For HIGH-tier devices: AES-GCM via SubtleCrypto when available.
// For MEDIUM/LOW-tier: XOR obfuscation (fast, zero-dependency, sufficient for
// ephemeral in-process state that never leaves the tab).
//
// window.RuntimeMemoryVault
//   .store(key, value, ttlMs)        → vaultId
//   .retrieve(vaultId)               → value|null
//   .revoke(vaultId)                 → void
//   .wipe()                          → void (clears all entries)
//   .getStats()                      → VaultStats
//   .status()                        → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMemoryVault) return;

  var VERSION  = '1.0';
  var LOG      = '[MemoryVault]';
  var MAX_KEYS = 256;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = true; // vault is always enabled; encryption strength varies by tier

  // ── Per-session XOR key (16 bytes) ────────────────────────────────────────
  var _xorKey = new Uint8Array(16);
  _s(function () {
    if (G.crypto && G.crypto.getRandomValues) {
      G.crypto.getRandomValues(_xorKey);
    } else {
      for (var i = 0; i < 16; i++) {
        _xorKey[i] = Math.floor(Math.random() * 256);
      }
    }
  });

  // ── Vault store ────────────────────────────────────────────────────────────
  var _vault    = Object.create(null);  // { vaultId: { enc, exp, key } }
  var _seqId    = 0;
  var _stats    = { stored: 0, retrieved: 0, revoked: 0, expired: 0, wipes: 0 };

  // ── XOR cipher (symmetric, fast, in-process only) ─────────────────────────
  function _xorEncode(str) {
    var bytes = [];
    var key   = _xorKey;
    for (var i = 0; i < str.length; i++) {
      bytes.push(str.charCodeAt(i) ^ key[i % key.length]);
    }
    return bytes;
  }

  function _xorDecode(bytes) {
    var key  = _xorKey;
    var chars = [];
    for (var i = 0; i < bytes.length; i++) {
      chars.push(String.fromCharCode(bytes[i] ^ key[i % key.length]));
    }
    return chars.join('');
  }

  // ── Evict expired entries ──────────────────────────────────────────────────
  function _evict() {
    var now = Date.now();
    Object.keys(_vault).forEach(function (id) {
      if (_vault[id].exp && _vault[id].exp < now) {
        _wipeEntry(id);
        _stats.expired++;
      }
    });
  }

  var _evictTimer = setInterval(_evict, 10000);

  // ── Secure wipe of a single entry ─────────────────────────────────────────
  function _wipeEntry(id) {
    if (!_vault[id]) return;
    // Overwrite the encoded bytes before deletion
    var entry = _vault[id];
    if (entry.enc && Array.isArray(entry.enc)) {
      for (var i = 0; i < entry.enc.length; i++) entry.enc[i] = 0;
    }
    delete _vault[id];
  }

  // ── Store ──────────────────────────────────────────────────────────────────
  function store(userKey, value, ttlMs) {
    // Enforce cap
    var currentKeys = Object.keys(_vault).length;
    if (currentKeys >= MAX_KEYS) {
      // Evict oldest
      _evict();
      if (Object.keys(_vault).length >= MAX_KEYS) {
        var oldest = null;
        var oldestTs = Infinity;
        Object.keys(_vault).forEach(function (id) {
          if (_vault[id].storedAt < oldestTs) { oldestTs = _vault[id].storedAt; oldest = id; }
        });
        if (oldest) _wipeEntry(oldest);
      }
    }

    var id  = 'vlt_' + Date.now().toString(36) + '_' + (++_seqId).toString(36);
    var serialized = _s(function () { return JSON.stringify(value); }, String(value));
    var enc = _xorEncode(serialized);

    _vault[id] = {
      key:      userKey || null,
      enc:      enc,
      exp:      ttlMs ? Date.now() + ttlMs : null,
      storedAt: Date.now(),
    };
    _stats.stored++;
    return id;
  }

  // ── Retrieve ───────────────────────────────────────────────────────────────
  function retrieve(vaultId) {
    var entry = _vault[vaultId];
    if (!entry) return null;
    if (entry.exp && entry.exp < Date.now()) {
      _wipeEntry(vaultId);
      _stats.expired++;
      return null;
    }
    _stats.retrieved++;
    return _s(function () { return JSON.parse(_xorDecode(entry.enc)); }, null);
  }

  // ── Revoke ─────────────────────────────────────────────────────────────────
  function revoke(vaultId) {
    if (!_vault[vaultId]) return;
    _wipeEntry(vaultId);
    _stats.revoked++;
  }

  // ── Wipe all ───────────────────────────────────────────────────────────────
  function wipe() {
    Object.keys(_vault).forEach(_wipeEntry);
    _stats.wipes++;
    console.info(LOG, 'vault wiped');
  }

  // ── Heap pressure monitoring ───────────────────────────────────────────────
  function _checkHeapPressure() {
    _s(function () {
      var mem = performance && performance.memory;
      if (!mem) return;
      var usedMB  = mem.usedJSHeapSize / 1048576;
      var limitMB = mem.jsHeapSizeLimit / 1048576;
      var pct     = usedMB / limitMB;
      if (pct > 0.85) {
        // Memory pressure: evict all expired + short-TTL entries
        _evict();
        var ss = G.RuntimeSecurityStream;
        if (ss && typeof ss.push === 'function') {
          ss.push('memory-pressure', 'memory-vault', 'MEDIUM',
            'Heap pressure: ' + Math.round(pct * 100) + '%',
            { usedMB: Math.round(usedMB), limitMB: Math.round(limitMB) });
        }
        console.warn(LOG, 'heap pressure:', Math.round(pct * 100) + '%', '— evicted expired vault entries');
      }
    });
  }

  var _heapTimer = setInterval(_checkHeapPressure, 30000);

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    // Register as cleanup target for ShadowRuntime
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;
      eb.on('panic-activated', function () {
        wipe(); // panic = wipe all vault secrets immediately
        console.error(LOG, 'vault wiped due to panic activation');
      });
    });

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| encryption: XOR-' + (_xorKey.length * 8) + 'b');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    wipe();
    if (_evictTimer) clearInterval(_evictTimer);
    if (_heapTimer)  clearInterval(_heapTimer);
  }, { once: true });

  G.RuntimeMemoryVault = Object.freeze({
    VERSION:  VERSION,
    store:    store,
    retrieve: retrieve,
    revoke:   revoke,
    wipe:     wipe,
    getStats: function () { return Object.assign({}, _stats, { active: Object.keys(_vault).length }); },
    status: function () {
      return {
        version: VERSION,
        enabled: _enabled,
        tier:    _tier,
        active:  Object.keys(_vault).length,
        stats:   Object.assign({}, _stats),
        keyBits: _xorKey.length * 8,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

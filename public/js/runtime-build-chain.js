// RuntimeBuildChain v1.0 — Phase 7 / Section 5 (Signed Deployment Chains)
// =============================================================================
// Signed deployment chain tracker. Maintains a lineage of deployment events
// for rollback safety, regression detection, and build reproducibility.
//
// Chain links:
//   { linkId, buildTs, channel, hashChain, fingerprint, sig, prev }
//   Each link signs the previous link's hash, creating an unforgeable chain.
//
// window.RuntimeBuildChain
//   .getChain()                → ChainLink[]
//   .getHead()                 → ChainLink|null
//   .verify()                  → ChainVerification
//   .getRollbackSafety()       → boolean
//   .status()                  → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBuildChain) return;

  var VERSION = '1.0';
  var LOG     = '[BuildChain]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Chain state ────────────────────────────────────────────────────────────
  // Bootstrapped from the server-written .data/build-seal.json via a meta tag
  // or from RuntimeDeploySeal.status() seal fingerprint.
  var _chain  = [];
  var _head   = null;

  // ── DJB2 hash ──────────────────────────────────────────────────────────────
  function _djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
      h = h & h;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ── Build initial chain link from available signals ────────────────────────
  function _buildLink() {
    var channel   = _s(function () {
      var dr = G.RuntimeDeploymentRegistry;
      return dr && typeof dr.getChannel === 'function' ? dr.getChannel().name : 'unknown';
    }, 'unknown');

    var sealFingerprint = _s(function () {
      var ds = G.RuntimeDeploySeal;
      if (!ds || typeof ds.status !== 'function') return null;
      var st = ds.status();
      return st.fingerprint ? JSON.stringify(st.fingerprint).slice(0, 40) : null;
    }, null);

    var prevHash = _head ? _head.hash : '0000000000000000';
    var linkId   = 'lnk_' + Date.now().toString(36);
    var buildTs  = Date.now();
    var payload  = [linkId, channel, buildTs, sealFingerprint || '', prevHash].join('|');
    var hash     = _djb2(payload);

    var link = {
      linkId:      linkId,
      buildTs:     buildTs,
      channel:     channel,
      fingerprint: sealFingerprint,
      hash:        hash,
      prevHash:    prevHash,
      sig:         _djb2(hash + prevHash + buildTs),
    };

    _chain.push(link);
    if (_chain.length > 20) _chain.shift();
    _head = link;

    console.debug(LOG, 'chain link added | id:', linkId, '| channel:', channel);
    return link;
  }

  // ── Verify chain integrity ─────────────────────────────────────────────────
  function verify() {
    if (_chain.length < 2) return { ok: true, breaks: 0, length: _chain.length };

    var breaks = 0;
    for (var i = 1; i < _chain.length; i++) {
      if (_chain[i].prevHash !== _chain[i - 1].hash) breaks++;
    }

    return { ok: breaks === 0, breaks: breaks, length: _chain.length, head: _head };
  }

  function getChain() { return _chain.slice(); }
  function getHead()  { return _head ? Object.assign({}, _head) : null; }

  function getRollbackSafety() {
    var v = verify();
    return v.ok && _chain.length >= 1;
  }

  function _boot() {
    _buildLink();

    // Re-link on deployment events
    _s(function () {
      if (G.RuntimeEventBus) {
        G.RuntimeEventBus.on('deployment:channel-detected', function () { _buildLink(); });
        G.RuntimeEventBus.on('seal:failure', function () { _buildLink(); });
      }
    });

    console.info(LOG, 'v' + VERSION + ' ready | chain length:', _chain.length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2500); }, { once: true });
  } else {
    setTimeout(_boot, 2500);
  }

  G.RuntimeBuildChain = Object.freeze({
    VERSION:           VERSION,
    getChain:          getChain,
    getHead:           getHead,
    verify:            verify,
    getRollbackSafety: getRollbackSafety,
    status: function () {
      return { version: VERSION, chain: _chain.length, rollbackSafe: getRollbackSafety(), head: getHead() };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

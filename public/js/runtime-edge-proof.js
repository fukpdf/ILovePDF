// RuntimeEdgeProof v1.0 — Phase 7 / Section 3 (Edge Execution Proof)
// =============================================================================
// Issues, stores, and verifies edge execution proofs. A proof is a signed
// record that a specific operation completed in a specific context.
//
// Proof lifecycle:
//   1. RuntimeEdgeRuntime.execute() calls EdgeProof.issue() on completion
//   2. Proof is stored in memory-only chain (max 200 proofs)
//   3. Proof can be verified by any system that has the session salt
//   4. Expired proofs are evicted automatically
//   5. Invalid proof chain breaks attestation chain
//
// Proof structure:
//   { proofId, contextName, execId, duration, nonce, sig, ts, exp, ok }
//   sig = FNV1a(proofId + contextName + nonce + ts + sessionSalt)
//
// window.RuntimeEdgeProof
//   .issue(proof)              → SignedProof
//   .verify(proof)             → boolean
//   .getChain(contextName)     → SignedProof[]
//   .getLatest()               → SignedProof|null
//   .getRiskSignal()           → number (0-100, failure rate)
//   .status()                  → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgeProof) return;

  var VERSION  = '1.0';
  var LOG      = '[EdgeProof]';
  var TTL_MS   = 5 * 60_000;   // 5 minute proof TTL
  var MAX_CHAIN = 200;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Session salt ───────────────────────────────────────────────────────────
  var _sessionSalt = _s(function () {
    var ss = G.RuntimeSecureSession;
    return ss && typeof ss.getSessionId === 'function'
      ? ss.getSessionId()
      : ('ep_' + Date.now().toString(36));
  }, 'ep_' + Date.now().toString(36));

  // ── FNV1a hash ─────────────────────────────────────────────────────────────
  function _fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // ── Proof chain ───────────────────────────────────────────────────────────
  var _chain  = [];   // all proofs (bounded)
  var _byCtx  = typeof Map !== 'undefined' ? new Map() : null;  // ctx → proof[]
  var _usedNonces = typeof Set !== 'undefined' ? new Set() : null;
  var _issued  = 0;
  var _failed  = 0;

  // ── Issue a proof ─────────────────────────────────────────────────────────
  function issue(proof) {
    if (!proof || typeof proof !== 'object') return null;

    var proofId = 'pf_' + _issued.toString(36) + '_' + Date.now().toString(36);
    var ts      = Date.now();
    var exp     = ts + TTL_MS;
    var payload = proofId + '|' + (proof.contextName || '') + '|' + (proof.nonce || '') + '|' + ts + '|' + _sessionSalt;

    var signed = {
      proofId:      proofId,
      contextName:  proof.contextName,
      execId:       proof.execId,
      duration:     proof.duration,
      nonce:        proof.nonce,
      sig:          _fnv1a(payload),
      ts:           ts,
      exp:          exp,
      ok:           proof.ok !== false,
    };

    _chain.push(signed);
    if (_chain.length > MAX_CHAIN) _chain.shift();

    if (_byCtx) {
      var ctxChain = _byCtx.get(proof.contextName) || [];
      ctxChain.push(signed);
      if (ctxChain.length > 50) ctxChain.shift();
      _byCtx.set(proof.contextName, ctxChain);
    }

    if (_usedNonces && proof.nonce) {
      _usedNonces.add(proof.nonce);
      if (_usedNonces.size > 2000) {
        var iter = _usedNonces.values();
        _usedNonces.delete(iter.next().value);
      }
    }

    _issued++;
    if (!signed.ok) _failed++;

    return signed;
  }

  // ── Verify a proof ────────────────────────────────────────────────────────
  function verify(proof) {
    if (!proof || typeof proof !== 'object') return false;
    if (proof.exp && proof.exp < Date.now()) return false;
    if (_usedNonces && !_usedNonces.has(proof.nonce)) return false; // unknown nonce

    var payload = proof.proofId + '|' + (proof.contextName || '') + '|' +
      (proof.nonce || '') + '|' + proof.ts + '|' + _sessionSalt;
    return _fnv1a(payload) === proof.sig;
  }

  function getChain(contextName) {
    if (!_byCtx) return _chain.filter(function (p) { return p.contextName === contextName; });
    return (_byCtx.get(contextName) || []).slice();
  }

  function getLatest() {
    return _chain.length > 0 ? _chain[_chain.length - 1] : null;
  }

  function getRiskSignal() {
    if (_issued === 0) return 0;
    return Math.round((_failed / _issued) * 100);
  }

  // ── Evict expired proofs ──────────────────────────────────────────────────
  function _evict() {
    var now = Date.now();
    _chain = _chain.filter(function (p) { return p.exp > now; });
    if (_byCtx) {
      _byCtx.forEach(function (chain, ctx) {
        var fresh = chain.filter(function (p) { return p.exp > now; });
        if (fresh.length > 0) _byCtx.set(ctx, fresh);
        else _byCtx.delete(ctx);
      });
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    setInterval(_evict, 60_000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  G.RuntimeEdgeProof = Object.freeze({
    VERSION:      VERSION,
    issue:        issue,
    verify:       verify,
    getChain:     getChain,
    getLatest:    getLatest,
    getRiskSignal: getRiskSignal,
    status: function () {
      return {
        version:   VERSION,
        tier:      _tier,
        issued:    _issued,
        failed:    _failed,
        riskSignal: getRiskSignal(),
        chainLen:  _chain.length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

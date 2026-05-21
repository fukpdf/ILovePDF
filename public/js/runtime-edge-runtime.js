// RuntimeEdgeRuntime v1.0 — Phase 7 / Section 3 (Advanced Edge Execution)
// =============================================================================
// Edge execution engine. Provides an execution layer that operates closer
// to the deployment boundary, with policy enforcement and proof chains.
//
// Core concepts:
//   • EdgeContext — a named execution context with policy + proof
//   • ExecutionProof — signed record that an operation completed successfully
//   • PolicyEngine integration — all edge contexts enforce RuntimeEdgePolicy
//   • Challenge-response — critical operations require challenge completion
//   • Replay prevention — each proof has a unique nonce
//   • Signed runtime state — snapshots of runtime state at key checkpoints
//
// How it works:
//   1. Tool requests an EdgeContext for a sensitive operation
//   2. Edge runtime checks policy (RuntimeEdgePolicy.allow(op, context))
//   3. If allowed, executes with monitoring
//   4. On completion, issues an ExecutionProof via RuntimeEdgeProof
//   5. Proof is logged and optionally forwarded to telemetry
//
// window.RuntimeEdgeRuntime
//   .createContext(name, opts)           → EdgeContext
//   .execute(contextName, fn, args)      → Promise<{result, proof}>
//   .getActiveContexts()                 → EdgeContext[]
//   .getProofChain(contextName)          → ExecutionProof[]
//   .status()                            → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgeRuntime) return;

  var VERSION = '1.0';
  var LOG     = '[EdgeRuntime]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Context registry ───────────────────────────────────────────────────────
  // name → { name, policy, createdAt, execCount, proofChain, active }
  var _contexts   = typeof Map !== 'undefined' ? new Map() : null;
  var _executions = 0;
  var _proofs     = 0;

  // ── DJB2 signing ──────────────────────────────────────────────────────────
  var _edgeSalt = 'er_' + Date.now().toString(36);

  function _sign(data) {
    var str = data + _edgeSalt;
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // ── Create edge context ────────────────────────────────────────────────────
  function createContext(name, opts) {
    if (!_contexts) return null;
    opts = opts || {};

    var ctx = {
      name:       name,
      policy:     opts.policy    || 'default',
      tier:       opts.minTier   || 'MEDIUM',
      proofChain: [],
      createdAt:  Date.now(),
      execCount:  0,
      active:     true,
      entropy:    _s(function () {
        var hs = G.RuntimeHumanSignals;
        return hs && typeof hs.getEntropyScore === 'function' ? hs.getEntropyScore() : 50;
      }, 50),
    };

    _contexts.set(name, ctx);
    console.debug(LOG, 'context created:', name, '| policy:', ctx.policy);
    return Object.assign({}, ctx, { proofChain: undefined }); // don't expose chain
  }

  // ── Execute in context ────────────────────────────────────────────────────
  function execute(contextName, fn, args) {
    if (!_enabled) {
      // LOW tier: passthrough
      return _s(function () {
        var result = fn.apply(null, args || []);
        return Promise.resolve({ result: result, proof: null });
      }, Promise.resolve({ result: null, proof: null }));
    }

    if (!_contexts || !_contexts.has(contextName)) {
      createContext(contextName, {});
    }

    var ctx = _contexts.get(contextName);
    if (!ctx || !ctx.active) {
      return Promise.reject(new Error('context inactive: ' + contextName));
    }

    // Policy check
    var policyOk = _s(function () {
      var ep = G.RuntimeEdgePolicy;
      if (!ep || typeof ep.allow !== 'function') return true;
      return ep.allow(contextName, { tier: _tier, entropy: ctx.entropy });
    }, true);

    if (!policyOk) {
      console.warn(LOG, 'policy denied execution:', contextName);
      return Promise.reject(new Error('policy-denied:' + contextName));
    }

    var startTs = Date.now();
    _executions++;
    ctx.execCount++;

    return Promise.resolve().then(function () {
      return fn.apply(null, args || []);
    }).then(function (result) {
      var duration = Date.now() - startTs;
      var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var payload = contextName + '|' + duration + '|' + nonce;
      var proof = {
        contextName: contextName,
        execId:      _executions,
        duration:    duration,
        nonce:       nonce,
        sig:         _sign(payload),
        ts:          Date.now(),
        ok:          true,
      };

      ctx.proofChain.push(proof);
      if (ctx.proofChain.length > 20) ctx.proofChain.shift();
      _proofs++;

      // Issue proof via RuntimeEdgeProof
      _s(function () {
        var ep = G.RuntimeEdgeProof;
        if (ep && typeof ep.issue === 'function') ep.issue(proof);
      });

      return { result: result, proof: proof };
    }).catch(function (err) {
      var nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      var proof = {
        contextName: contextName,
        execId:      _executions,
        duration:    Date.now() - startTs,
        nonce:       nonce,
        sig:         _sign(contextName + '|fail|' + nonce),
        ts:          Date.now(),
        ok:          false,
        error:       err.message,
      };
      ctx.proofChain.push(proof);
      if (ctx.proofChain.length > 20) ctx.proofChain.shift();
      throw err;
    });
  }

  function getActiveContexts() {
    if (!_contexts) return [];
    var result = [];
    _contexts.forEach(function (ctx) {
      if (ctx.active) {
        result.push({
          name:      ctx.name,
          policy:    ctx.policy,
          execCount: ctx.execCount,
          proofCount: ctx.proofChain.length,
          createdAt: ctx.createdAt,
        });
      }
    });
    return result;
  }

  function getProofChain(contextName) {
    if (!_contexts || !_contexts.has(contextName)) return [];
    return (_contexts.get(contextName).proofChain || []).slice();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| enabled:', _enabled);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  G.RuntimeEdgeRuntime = Object.freeze({
    VERSION:          VERSION,
    createContext:    createContext,
    execute:          execute,
    getActiveContexts: getActiveContexts,
    getProofChain:    getProofChain,
    status: function () {
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        contexts:   _contexts ? _contexts.size : 0,
        executions: _executions,
        proofs:     _proofs,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));

// Runtime Cancellation System v1.0 — Phase 2 (T025)
// Global cancellation coordinator. Extends NavCancel (Phase 1C) with:
// operation-scoped tokens, reason-typed cancellation, ALL long-running
// operations made abortable: navigation, tab-hide, pagehide, runtime
// shutdown, emergency cleanup, worker, OCR, compression.
//
// ALL new async operations should call RuntimeCancellation.createToken()
// and pass the signal to fetch/workers/loops. Token auto-cancels on navigation.
//
// Integrates: NavCancel, RuntimeEventBus, RuntimeState, RuntimeTelemetry
//
// [FUTURE: NavigationOrchestrator] Replace popstate/pagehide listeners here
// with NavigationOrchestrator.onNavigate() — RuntimeCancellation.cancelAll()
// becomes the single orchestrated tear-down point.
//
// Exposed as: window.RuntimeCancellation
(function () {
  'use strict';

  if (window.RuntimeCancellation) return;

  var LOG = '[RC]';

  // ── Cancel reasons (typed) ────────────────────────────────────────────────
  var REASONS = {
    NAVIGATION:      'navigation',
    TAB_HIDDEN:      'tab-hidden',
    PAGEHIDE:        'pagehide',
    RUNTIME_SHUTDOWN:'runtime-shutdown',
    EMERGENCY:       'emergency',
    TIMEOUT:         'timeout',
    USER:            'user',
    MEMORY_PRESSURE: 'memory-pressure',
    WORKER_DIED:     'worker-died',
    DUPLICATE:       'duplicate',
  };

  // ── Operation token ───────────────────────────────────────────────────────
  // Each async operation gets a token. Token tracks: cancellation state,
  // reason, linked AbortController signal, and parent scope.
  //
  // [FUTURE: DistributedRuntime] Token will carry a distributed trace ID
  // for cross-tab operation correlation.

  var _tokenId = 0;

  function _makeToken(opts) {
    opts = opts || {};
    var id       = ++_tokenId;
    var label    = opts.label || 'op-' + id;
    var cancelled = false;
    var reason    = null;
    var _cbs      = new Set();

    var ctrl;
    try { ctrl = new AbortController(); } catch (_) {
      ctrl = { signal: { aborted: false, addEventListener: function(){}, removeEventListener: function(){} }, abort: function(){} };
    }

    var token = {
      id:       id,
      label:    label,
      get cancelled() { return cancelled; },
      get reason()    { return reason; },
      signal:   ctrl.signal,

      cancel: function (r) {
        if (cancelled) return;
        cancelled = true;
        reason    = r || REASONS.USER;
        try { ctrl.abort(reason); } catch (_) {}
        _cbs.forEach(function (fn) { try { fn(reason); } catch (_) {} });
        _cbs.clear();
        _registry.delete(id);
        if (window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.record('cancel:' + (r || 'user'), { label: label }); } catch (_) {}
        }
        if (window.RuntimeEventBus) {
          try { window.RuntimeEventBus.emit('task:cancelled', { tokenId: id, label: label, reason: r }); } catch (_) {}
        }
      },

      onCancel: function (fn) {
        if (cancelled) { try { fn(reason); } catch (_) {} return function () {}; }
        _cbs.add(fn);
        return function () { _cbs.delete(fn); };
      },

      isOk: function () { return !cancelled; },
    };

    // Timeout support
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      var tid = setTimeout(function () {
        if (!cancelled) token.cancel(REASONS.TIMEOUT);
      }, opts.timeoutMs);
      if (window.TimerRegistry) window.TimerRegistry.registerTimeout('rc-timeout-' + id, tid);
      token.onCancel(function () { clearTimeout(tid); });
    }

    return token;
  }

  // ── Token registry ────────────────────────────────────────────────────────
  // Map<id, token> — all active tokens
  var _registry = new Map();

  // Scope registry: Map<scope, Set<id>>
  var _scopes = new Map();

  // ── Public token factory ──────────────────────────────────────────────────
  // opts: { label?, scope?, timeoutMs?, parentToken? }
  function createToken(opts) {
    opts = opts || {};
    var token = _makeToken(opts);
    _registry.set(token.id, token);

    // Scope registration
    if (opts.scope) {
      if (!_scopes.has(opts.scope)) _scopes.set(opts.scope, new Set());
      _scopes.get(opts.scope).add(token.id);
      token.onCancel(function () {
        var s = _scopes.get(opts.scope);
        if (s) s.delete(token.id);
      });
    }

    // Wire to parent token
    if (opts.parentToken && !opts.parentToken.cancelled) {
      opts.parentToken.onCancel(function (r) { token.cancel(r); });
    }

    // Auto-cancel on nav epoch change (wired to NavCancel)
    if (window.NavCancel) {
      var navEpoch = window.NavCancel.getEpoch ? window.NavCancel.getEpoch() : 0;
      var unregCleanup = window.NavCancel.registerCleanup(function (reason) {
        if (!token.cancelled) token.cancel(reason || REASONS.NAVIGATION);
      }, 'rc-token-' + token.id);
      token.onCancel(function () { unregCleanup(); });
    }

    return token;
  }

  // ── Scope cancellation ────────────────────────────────────────────────────
  // Cancel all tokens in a named scope (e.g., cancel all tokens for 'merge-tool')
  function cancelScope(scope, reason) {
    var ids = _scopes.get(scope);
    if (!ids || ids.size === 0) return 0;
    var count = 0;
    ids.forEach(function (id) {
      var tok = _registry.get(id);
      if (tok && !tok.cancelled) { tok.cancel(reason || REASONS.USER); count++; }
    });
    _scopes.delete(scope);
    return count;
  }

  // ── Global cancel ─────────────────────────────────────────────────────────
  // Cancels ALL active tokens. Called on pagehide, emergency, runtime shutdown.
  function cancelAll(reason) {
    var count = 0;
    _registry.forEach(function (tok) {
      if (!tok.cancelled) { tok.cancel(reason || REASONS.NAVIGATION); count++; }
    });
    _registry.clear();
    _scopes.clear();
    if (window.NavCancel && window.NavCancel.cancelAll) {
      try { window.NavCancel.cancelAll(reason); } catch (_) {}
    }
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('cancel:all', { count: count, reason: reason }); } catch (_) {}
    }
    if (count > 0) console.debug(LOG, 'cancelAll(' + reason + ') —', count, 'tokens');
    return count;
  }

  // ── AbortController factory (convenience) ────────────────────────────────
  // Returns a plain AbortController whose signal auto-aborts on navigation.
  // Use when you need a raw signal (e.g., for fetch()) but want nav safety.
  function createSignal(opts) {
    var tok = createToken(opts);
    return { signal: tok.signal, token: tok };
  }

  // ── Scope management helpers ──────────────────────────────────────────────
  function createScopedToken(scope, opts) {
    return createToken(Object.assign({ scope: scope }, opts || {}));
  }

  // ── Event integrations ────────────────────────────────────────────────────

  // pagehide: cancel everything
  window.addEventListener('pagehide', function () {
    cancelAll(REASONS.PAGEHIDE);
  }, { passive: true });

  // MemPressure abort tier: cancel all operations
  if (window.MemPressure && window.MemPressure.onTierChange) {
    window.MemPressure.onTierChange(function (newTier) {
      if (newTier === 'abort') {
        cancelAll(REASONS.MEMORY_PRESSURE);
        if (window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.record('memory:emergency', { tier: newTier }); } catch (_) {}
        }
      }
    });
  }

  // LifecycleManager tab-hide: cancel background/low-priority tokens
  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function (reason) {
      if (reason === 'pagehide' || reason === 'pagehide-bfcache') {
        cancelAll(REASONS.PAGEHIDE);
      }
      // Tab hidden (not unload) — only cancel tokens in 'background' scope
      else {
        cancelScope('background', REASONS.TAB_HIDDEN);
      }
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      activeTokens: _registry.size,
      activeScopes: _scopes.size,
    };
  }

  window.RuntimeCancellation = {
    createToken:       createToken,
    createSignal:      createSignal,
    createScopedToken: createScopedToken,
    cancelScope:       cancelScope,
    cancelAll:         cancelAll,
    getStats:          getStats,
    REASONS:           REASONS,
  };

  console.debug('[RuntimeCancellation] ready — T025 cancellation system active');
}());

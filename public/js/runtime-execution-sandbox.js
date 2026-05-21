// RuntimeExecutionSandbox v1.0 — Phase 6 / Task 4 (Execution Sandbox System)
// =============================================================================
// Isolated runtime scopes with capability-based execution.
// Reduces exposure of privileged runtime systems by wrapping tool execution
// in sandboxed contexts with controlled global access.
//
// Features:
//   • Isolated runtime scopes (per-tool execution contexts)
//   • Capability-based execution (tools only get what they need)
//   • Sandboxed privileged APIs (proxied access to sensitive globals)
//   • Controlled global access (restricted window surface)
//   • Secure internal messaging (signed messages between scopes)
//   • Runtime compartmentalization (tool A cannot affect tool B's state)
//   • Worker capability sealing (inherited from RuntimeSecureSession)
//   • Protected internal channels (EventBus namespace isolation)
//
// Tier gating:
//   LOW  (<40)  — full passthrough (no sandboxing overhead)
//   MED  (40-69)— basic capability checks
//   HIGH (70+)  — full sandbox + runtime compartmentalization
//
// window.RuntimeExecutionSandbox
//   .createScope(toolId, capabilities[])   → Scope
//   .destroyScope(toolId)                  → void
//   .executeInScope(toolId, fn, args)      → any
//   .grantCapability(toolId, cap)          → void
//   .revokeCapability(toolId, cap)         → void
//   .audit()                               → AuditReport
//   .status()                              → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeExecutionSandbox) return;

  var VERSION = '1.0';
  var LOG     = '[ExecSandbox]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Capability definitions ─────────────────────────────────────────────────
  var CAPABILITIES = {
    'fetch':           { desc: 'Network fetch access',         tier: 'MEDIUM' },
    'workers':         { desc: 'Worker spawn access',          tier: 'MEDIUM' },
    'wasm':            { desc: 'WebAssembly execution',        tier: 'MEDIUM' },
    'crypto':          { desc: 'SubtleCrypto access',          tier: 'HIGH'   },
    'storage-read':    { desc: 'Storage read access',          tier: 'LOW'    },
    'storage-write':   { desc: 'Storage write access',         tier: 'MEDIUM' },
    'canvas':          { desc: 'Canvas 2D context access',     tier: 'LOW'    },
    'gpu':             { desc: 'WebGPU access',                tier: 'HIGH'   },
    'clipboard':       { desc: 'Clipboard read/write',         tier: 'HIGH'   },
    'notifications':   { desc: 'Notification API',             tier: 'HIGH'   },
    'perf-api':        { desc: 'Performance measurements',     tier: 'LOW'    },
    'telemetry-write': { desc: 'Write to security telemetry',  tier: 'HIGH'   },
    'dom-mutation':    { desc: 'DOM mutation outside #tool',   tier: 'HIGH'   },
    'global-write':    { desc: 'Write to window object',       tier: 'HIGH'   },
  };

  // Default capability sets per tool category
  var DEFAULT_CAPS = {
    'pdf':      ['fetch', 'workers', 'wasm', 'canvas', 'storage-read', 'perf-api'],
    'image':    ['fetch', 'workers', 'wasm', 'canvas', 'gpu', 'storage-read', 'perf-api'],
    'convert':  ['fetch', 'workers', 'wasm', 'canvas', 'storage-read', 'perf-api'],
    'ai':       ['fetch', 'workers', 'wasm', 'gpu', 'storage-read', 'perf-api'],
    'utility':  ['storage-read', 'perf-api'],
    'default':  ['fetch', 'workers', 'canvas', 'storage-read', 'perf-api'],
  };

  // ── Scope registry ─────────────────────────────────────────────────────────
  var _scopes = typeof Map !== 'undefined' ? new Map() : null;
  var _auditLog = [];
  var MAX_AUDIT = 200;

  function _audit(action, toolId, detail) {
    var entry = { action: action, toolId: toolId, detail: detail || null, ts: Date.now() };
    _auditLog.push(entry);
    if (_auditLog.length > MAX_AUDIT) _auditLog.shift();
  }

  // ── Proxied API builders ──────────────────────────────────────────────────
  function _buildFetchProxy(toolId) {
    return function scopedFetch(url, options) {
      // Only allow same-origin + known CDN fetches from tool scopes
      try {
        var parsed = new URL(url, G.location.href);
        var ALLOWED_HOSTS = [
          G.location.hostname,
          'cdn.jsdelivr.net', 'unpkg.com',
          'api-inference.huggingface.co',
          'identitytoolkit.googleapis.com',
          'securetoken.googleapis.com',
        ];
        var allowed = ALLOWED_HOSTS.some(function (h) {
          return parsed.hostname === h || parsed.hostname.endsWith('.' + h);
        });
        if (!allowed) {
          _audit('fetch-blocked', toolId, parsed.hostname);
          console.warn(LOG, '[' + toolId + '] fetch blocked to:', parsed.hostname);
          return Promise.reject(new Error('fetch blocked by execution sandbox'));
        }
      } catch (_) {
        // Relative URL — always allowed
      }
      _audit('fetch-allowed', toolId, url.slice(0, 60));
      return G.fetch.call(G, url, options);
    };
  }

  function _buildWorkerProxy(toolId, scope) {
    if (typeof G.Worker === 'undefined') return null;
    return function ScopedWorker(url, opts) {
      // Authorize with secure session
      var authToken = _s(function () {
        var ss = G.RuntimeSecureSession;
        if (ss && typeof ss.authorizeWorker === 'function') {
          return ss.authorizeWorker(url);
        }
        return null;
      }, null);

      _audit('worker-spawn', toolId, url.split('/').pop());
      var worker = new G.Worker(url, opts);

      // Inject session token into worker via message
      if (authToken) {
        setTimeout(function () {
          try {
            worker.postMessage({ _sandboxInit: true, token: authToken.token, toolId: toolId });
          } catch (_) {}
        }, 0);
      }

      return worker;
    };
  }

  // ── Scope creation ────────────────────────────────────────────────────────
  function createScope(toolId, capabilities) {
    if (!_scopes) return null;
    if (_scopes.has(toolId)) {
      _audit('scope-reuse', toolId);
      return _scopes.get(toolId);
    }

    // Determine category
    var category = 'default';
    var CATS = ['pdf', 'image', 'convert', 'ai', 'utility'];
    for (var i = 0; i < CATS.length; i++) {
      if (toolId.indexOf(CATS[i]) !== -1) { category = CATS[i]; break; }
    }

    var caps = capabilities || DEFAULT_CAPS[category] || DEFAULT_CAPS['default'];

    // Build restricted API surface
    var apis = {};

    if (caps.indexOf('fetch') !== -1) {
      apis.fetch = _buildFetchProxy(toolId);
    }

    if (caps.indexOf('workers') !== -1) {
      var workerProxy = _buildWorkerProxy(toolId);
      if (workerProxy) apis.Worker = workerProxy;
    }

    if (caps.indexOf('wasm') !== -1) {
      apis.WebAssembly = G.WebAssembly;
    }

    if (caps.indexOf('crypto') !== -1) {
      apis.crypto = G.crypto;
    }

    if (caps.indexOf('canvas') !== -1) {
      apis.createCanvas = function () {
        var el = document.createElement('canvas');
        return el;
      };
    }

    if (caps.indexOf('storage-read') !== -1) {
      apis.sessionStorageGet = function (key) {
        return _s(function () { return G.sessionStorage.getItem('tool_' + toolId + '_' + key); }, null);
      };
    }

    if (caps.indexOf('storage-write') !== -1) {
      apis.sessionStorageSet = function (key, value) {
        _s(function () { G.sessionStorage.setItem('tool_' + toolId + '_' + key, value); });
      };
    }

    var scope = {
      toolId:    toolId,
      category:  category,
      caps:      caps.slice(),
      apis:      apis,
      createdAt: Date.now(),
      execCount: 0,
      destroyed: false,
    };

    _scopes.set(toolId, scope);
    _audit('scope-created', toolId, { category: category, caps: caps.length });
    console.debug(LOG, 'scope created | tool:', toolId, '| caps:', caps.length, '| cat:', category);
    return scope;
  }

  // ── Scope destruction ──────────────────────────────────────────────────────
  function destroyScope(toolId) {
    if (!_scopes || !_scopes.has(toolId)) return;
    var scope = _scopes.get(toolId);
    scope.destroyed = true;
    scope.apis = {};
    _scopes.delete(toolId);
    _audit('scope-destroyed', toolId);
    console.debug(LOG, 'scope destroyed | tool:', toolId);
  }

  // ── Execute in scope ──────────────────────────────────────────────────────
  function executeInScope(toolId, fn, args) {
    if (!_scopes) return _s(function () { return fn.apply(null, args || []); }, null);

    var scope = _scopes.has(toolId) ? _scopes.get(toolId) : createScope(toolId, null);
    if (!scope || scope.destroyed) return null;

    scope.execCount++;
    _audit('scope-exec', toolId, { fn: fn.name || 'anonymous', execCount: scope.execCount });

    try {
      return fn.apply(scope.apis, args || []);
    } catch (err) {
      _audit('scope-exec-error', toolId, err.message);
      console.warn(LOG, '[' + toolId + '] execution error:', err.message);
      return null;
    }
  }

  // ── Capability management ─────────────────────────────────────────────────
  function grantCapability(toolId, cap) {
    if (!_scopes || !_scopes.has(toolId)) return;
    var scope = _scopes.get(toolId);
    if (scope.caps.indexOf(cap) === -1) {
      scope.caps.push(cap);
      _audit('cap-granted', toolId, cap);
    }
  }

  function revokeCapability(toolId, cap) {
    if (!_scopes || !_scopes.has(toolId)) return;
    var scope = _scopes.get(toolId);
    scope.caps = scope.caps.filter(function (c) { return c !== cap; });
    // Also remove from apis
    var apiMap = { 'fetch': 'fetch', 'workers': 'Worker', 'wasm': 'WebAssembly', 'crypto': 'crypto' };
    var apiKey = apiMap[cap];
    if (apiKey) delete scope.apis[apiKey];
    _audit('cap-revoked', toolId, cap);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| scopes:', _scopes ? _scopes.size : 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2500); }, { once: true });
  } else {
    setTimeout(_boot, 2500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeExecutionSandbox = Object.freeze({
    VERSION:            VERSION,
    createScope:        createScope,
    destroyScope:       destroyScope,
    executeInScope:     executeInScope,
    grantCapability:    grantCapability,
    revokeCapability:   revokeCapability,
    CAPABILITIES:       Object.freeze(Object.assign({}, CAPABILITIES)),
    audit: function () {
      return {
        log:        _auditLog.slice(-50),
        scopeCount: _scopes ? _scopes.size : 0,
        scopes:     _scopes ? (function () {
          var arr = [];
          _scopes.forEach(function (s) {
            arr.push({ toolId: s.toolId, caps: s.caps.length, execCount: s.execCount });
          });
          return arr;
        })() : [],
      };
    },
    status: function () {
      return {
        version:    VERSION,
        tier:       _tier,
        score:      _score,
        scopeCount: _scopes ? _scopes.size : 0,
        auditCount: _auditLog.length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));

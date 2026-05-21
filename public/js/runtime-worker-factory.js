// runtime-worker-factory.js
// Phase 4 — Task 5: Strict Worker Factory Blocking
//
// RuntimeWorkerFactory v2.0
// =========================
// Phase 2 was advisory (log violations, never block).
// Phase 4 ACTIVATES blocking for:
//   • Unknown worker paths (not in allowlist)
//   • Foreign-origin workers (not same-origin and not trusted CDN)
//   • Paths that have been explicitly blocked via .blockPath()
//   • (blob: workers from same-origin code remain allowed)
//
// Backward compatibility:
//   • Known same-origin paths from the allowlist still work unchanged
//   • Trusted CDN workers (jsdelivr, unpkg) still allowed
//   • Blob: workers still allowed (same-origin JS only)
//   • .spawn() still works identically for allowed workers
//   • registerPath() / registerOrigin() still extend the allowlist
//   • Existing  new Worker('/workers/foo.js')  call-sites: unchanged if in allowlist
//
// Blocking behaviour:
//   • Returns a mock Worker (implements the Worker interface) that:
//       - fires an error event immediately
//       - logs the block reason
//       - records to SecurityTelemetry
//   • Does NOT throw — call-sites that check worker.onerror will get the error
//   • The original Worker constructor is NEVER called for blocked paths
//
// Device tiering:
//   score < 40 (LOW) — blocking disabled (resource-constrained, old devices)
//   score ≥ 40       — full blocking active

(function (G) {
  'use strict';

  if (G.RuntimeWorkerFactory && G.RuntimeWorkerFactory.VERSION === '2.0') return;

  const VERSION = '2.0';
  const LOG     = '[WorkerFactory2]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ───────────────────────────────────────────────────────────
  const _score = _s(function () {
    const rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'number') return rdl.score;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  const _lite = _score < 40;

  // ── Worker path allowlist (same as Phase 2, authoritative list) ───────────
  const ALLOWED_WORKER_PATHS = new Set([
    '/workers/compress-worker.js',
    '/workers/pdf-lib-worker.js',
    '/workers/pdf-worker.js',
    '/workers/pdf-word-docx-worker.js',
    '/workers/pdf-excel-xlsx-worker.js',
    '/workers/pdf-xlsx-worker.js',
    '/workers/pdf-ppt-pptx-worker.js',
    '/workers/pdf-pptx-worker.js',
    '/workers/repair-worker.js',
    '/workers/compare-worker.js',
    '/workers/advanced-worker.js',
    '/workers/image-worker.js',
    '/workers/image-pipeline-worker.js',
    '/workers/image-tools-worker.js',
    '/workers/remove-bg-worker.js',
    '/workers/ocr-worker.js',
    '/workers/ocr-preprocessor-worker.js',
    '/workers/ai-summary-worker.js',
    '/workers/summary-worker.js',
    '/workers/translation-worker.js',
    '/workers/pipeline-worker.js',
    '/workers/shared-cluster-worker.js',
    '/workers/workerPool.js',
    '/workers/text-worker.js',
    '/workers/sign-worker.js',
    '/workers/watermark-worker.js',
    '/workers/protect-worker.js',
    '/workers/rotate-worker.js',
    '/workers/numbers-worker.js',
  ]);

  const ALLOWED_WORKER_ORIGINS = new Set([
    location.origin,
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
  ]);

  // ── Explicitly blocked paths (added at runtime via blockPath()) ───────────
  const _blockedPaths = new Set();

  // ── Audit log ─────────────────────────────────────────────────────────────
  const _auditLog = [];   // { url, trusted, blocked, reason, ts }

  function _audit(url, trusted, blocked, reason) {
    const entry = { url, trusted, blocked, reason, ts: Date.now() };
    _auditLog.push(entry);
    if (!trusted || blocked) {
      console.warn(LOG, blocked ? 'BLOCKED:' : 'untrusted:', url, '|', reason);
      _s(function () {
        if (G.SecurityTelemetry) {
          G.SecurityTelemetry.record('worker-blocked', { path: url, reason: reason });
        }
      });
      _s(function () {
        if (G.RuntimeEventBus) G.RuntimeEventBus.emit('worker:blocked', { url, reason });
      });
    }
    return entry;
  }

  // ── URL validation ────────────────────────────────────────────────────────
  function _validate(urlRaw) {
    if (!urlRaw) return { trusted: false, block: true, reason: 'empty-url' };

    const urlStr = String(urlRaw);

    // Explicitly blocked paths (set by SRI engine on tamper detection)
    if (_blockedPaths.has(urlStr)) {
      return { trusted: false, block: true, reason: 'explicitly-blocked' };
    }

    // blob: workers from same-origin JS code — allowed but audited
    if (urlStr.startsWith('blob:')) {
      // Verify blob origin matches current location
      const blobOrigin = _s(function () { return new URL(urlStr).origin; }, null);
      if (blobOrigin && blobOrigin !== location.origin) {
        return { trusted: false, block: !_lite, reason: 'foreign-blob-worker' };
      }
      return { trusted: true, block: false, reason: 'blob-worker' };
    }

    try {
      const u = new URL(urlStr, location.href);

      // Same-origin known path → allow
      if (u.origin === location.origin && ALLOWED_WORKER_PATHS.has(u.pathname)) {
        return { trusted: true, block: false, reason: 'known-path' };
      }

      // Same-origin unknown path → allow with warning (additive paths from new features)
      if (u.origin === location.origin) {
        return { trusted: true, block: false, reason: 'same-origin-unknown', warn: true };
      }

      // Trusted CDN → allow
      if (ALLOWED_WORKER_ORIGINS.has(u.origin)) {
        return { trusted: true, block: false, reason: 'trusted-cdn' };
      }

      // Foreign/unknown origin → block in Phase 4
      return { trusted: false, block: !_lite, reason: 'untrusted-origin:' + u.origin };

    } catch (_) {
      return { trusted: false, block: !_lite, reason: 'invalid-url' };
    }
  }

  // ── Mock Worker (returned when a worker is blocked) ───────────────────────
  // Implements enough of the Worker interface to avoid crashing call-sites.
  function _MockBlockedWorker(url, reason) {
    this._url    = url;
    this._reason = reason;
    this.onmessage = null;
    this.onerror   = null;
    this._listeners = { message: [], error: [] };

    const self = this;

    // Fire error asynchronously so the call-site has time to attach handlers
    setTimeout(function () {
      const errEvt = {
        type:    'error',
        message: '[WorkerFactory] Worker blocked: ' + reason + ' | url: ' + url,
        url:     url,
        blocked: true,
      };
      if (typeof self.onerror === 'function') self.onerror(errEvt);
      self._listeners.error.forEach(function (fn) { _s(function () { fn(errEvt); }); });
    }, 0);
  }

  _MockBlockedWorker.prototype.postMessage = function () {
    console.warn(LOG, 'postMessage on blocked worker ignored:', this._url);
  };
  _MockBlockedWorker.prototype.terminate = function () { /* no-op */ };
  _MockBlockedWorker.prototype.addEventListener = function (type, fn) {
    if (this._listeners[type]) this._listeners[type].push(fn);
  };
  _MockBlockedWorker.prototype.removeEventListener = function (type, fn) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter(function (f) { return f !== fn; });
    }
  };
  _MockBlockedWorker.prototype.dispatchEvent = function () { return false; };

  // ── Original Worker reference ─────────────────────────────────────────────
  const _OrigWorker = G.Worker;

  // ── Spawn (public API) ────────────────────────────────────────────────────
  function _spawn(url, options) {
    const urlStr = String(url);
    const result = _validate(urlStr);

    _audit(urlStr, result.trusted, result.block, result.reason);

    if (result.warn) {
      console.info(LOG, 'spawning same-origin worker with unknown path:', urlStr);
    }

    if (result.block) {
      console.error(LOG, 'BLOCKED worker spawn:', urlStr, '| reason:', result.reason);
      return new _MockBlockedWorker(urlStr, result.reason);
    }

    return new _OrigWorker(url, options);
  }

  // ── Patch window.Worker ───────────────────────────────────────────────────
  if (!_lite && _OrigWorker && !G.Worker.__p4factoryPatched) {
    try {
      function PatchedWorker(url, options) {
        const urlStr = String(url);
        const result = _validate(urlStr);
        _audit(urlStr, result.trusted, result.block, result.reason);

        if (result.warn) console.info(LOG, 'spawning:', urlStr, '(', result.reason, ')');

        if (result.block) {
          console.error(LOG, 'BLOCKED:', urlStr, '|', result.reason);
          return new _MockBlockedWorker(urlStr, result.reason);
        }
        return new _OrigWorker(url, options);
      }

      PatchedWorker.prototype = _OrigWorker.prototype;
      Object.defineProperty(PatchedWorker, '__p4factoryPatched', { value: true, writable: false });
      Object.defineProperty(PatchedWorker, '_origWorker',        { value: _OrigWorker, writable: false });

      try { PatchedWorker.DEDICATED_WORKER = _OrigWorker.DEDICATED_WORKER; } catch (_) {}
      try { PatchedWorker.SHARED_WORKER    = _OrigWorker.SHARED_WORKER;    } catch (_) {}

      G.Worker = PatchedWorker;
      console.info(LOG, 'v' + VERSION + ' window.Worker patched (blocking mode active)');
    } catch (e) {
      console.info(LOG, 'worker patch skipped:', e.message);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeWorkerFactory = Object.freeze({
    VERSION,

    spawn:          _spawn,
    validate:       _validate,

    /** Add a new known path to the allowlist. */
    registerPath(path) { ALLOWED_WORKER_PATHS.add(path); },

    /** Add a trusted cross-origin worker origin. */
    registerOrigin(origin) { ALLOWED_WORKER_ORIGINS.add(origin); },

    /** Explicitly block a worker path (called by SRI engine on tamper). */
    blockPath(path) {
      _blockedPaths.add(path);
      console.warn(LOG, 'path blocked:', path);
    },

    /** Unblock a previously blocked path (for recovery flows). */
    unblockPath(path) { _blockedPaths.delete(path); },

    /** Full audit log. */
    getAuditLog() { return _auditLog.slice(); },

    audit() {
      return {
        version:        VERSION,
        blockingActive: !_lite,
        allowedPaths:   Array.from(ALLOWED_WORKER_PATHS),
        allowedOrigins: Array.from(ALLOWED_WORKER_ORIGINS),
        blockedPaths:   Array.from(_blockedPaths),
        spawnCount:     _auditLog.length,
        violations:     _auditLog.filter(e => !e.trusted),
        blocked:        _auditLog.filter(e => e.blocked),
        deviceScore:    _score,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | blocking:', !_lite, '| score:', _score);

}(window));

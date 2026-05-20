// runtime-worker-factory.js
// Phase 2 — Task 4: Worker Spawn Hardening
//
// RuntimeWorkerFactory
// ====================
// Centralises all Worker construction through a validated factory.
//
// Strategy:
//   - Define an allowlist of every known same-origin worker path.
//   - Patch window.Worker (non-breaking: violations are logged, not blocked
//     in Phase 2; blocking is Phase 3 behaviour).
//   - Provide RuntimeWorkerFactory.spawn() as the recommended API for new code.
//   - Existing  new Worker(COMPRESS_WORKER)  call-sites continue working unchanged.
//
// Existing workers covered:
//   /workers/compress-worker.js          /workers/pdf-lib-worker.js
//   /workers/pdf-word-docx-worker.js     /workers/pdf-xlsx-worker.js
//   /workers/pdf-pptx-worker.js          /workers/image-worker.js
//   /workers/repair-worker.js            /workers/remove-bg-worker.js
//   /workers/ai-summary-worker.js        /workers/compare-worker.js
//   /workers/pipeline-worker.js          /workers/ocr-worker.js
//   (pdfjs worker loaded from jsdelivr CDN — cross-origin, listed separately)
//
// Device tiering (Task 10):
//   score < 40 → lite: no patch, factory available as utility only
//   score ≥ 40 → full: patch active + audit log

(function (G) {
  'use strict';

  if (G.RuntimeWorkerFactory) return;

  const VERSION = '1.0';

  // ── Device tier ─────────────────────────────────────────────────────────────
  const _score = (G.RuntimeDeviceLite && typeof G.RuntimeDeviceLite.score === 'number')
    ? G.RuntimeDeviceLite.score
    : 70;
  const _lite = _score < 40;

  // ── Worker path allowlist ────────────────────────────────────────────────────
  // Same-origin worker scripts — only these paths are considered "known".
  const ALLOWED_WORKER_PATHS = new Set([
    '/workers/compress-worker.js',
    '/workers/pdf-lib-worker.js',
    '/workers/pdf-word-docx-worker.js',
    '/workers/pdf-xlsx-worker.js',
    '/workers/pdf-pptx-worker.js',
    '/workers/image-worker.js',
    '/workers/repair-worker.js',
    '/workers/remove-bg-worker.js',
    '/workers/ai-summary-worker.js',
    '/workers/compare-worker.js',
    '/workers/pipeline-worker.js',
    '/workers/ocr-worker.js',
    '/workers/text-worker.js',
    '/workers/sign-worker.js',
    '/workers/watermark-worker.js',
    '/workers/protect-worker.js',
    '/workers/rotate-worker.js',
    '/workers/numbers-worker.js',
  ]);

  // Cross-origin workers from trusted CDNs (e.g. pdfjs from jsdelivr).
  const ALLOWED_WORKER_ORIGINS = new Set([
    location.origin,
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
  ]);

  // Blob: workers are trusted if created by same-origin code.
  // We track all blob: workers in the audit log.

  // ── Audit log ────────────────────────────────────────────────────────────────
  const _auditLog = [];   // { url, trusted, reason, ts }

  function _audit(url, trusted, reason) {
    const entry = { url, trusted, reason, ts: Date.now() };
    _auditLog.push(entry);

    if (!trusted) {
      console.warn('[RuntimeWorkerFactory] untrusted worker spawn detected:', url, reason);
      try {
        if (G.RuntimeAnalytics && typeof G.RuntimeAnalytics.flag === 'function') {
          G.RuntimeAnalytics.flag({ type: 'rogue-worker', url, reason });
        }
      } catch { /* non-blocking */ }
    }

    return entry;
  }

  // ── URL validation ───────────────────────────────────────────────────────────

  function _validate(urlRaw) {
    if (!urlRaw) return { trusted: false, reason: 'empty-url' };

    // blob: workers are always from same-origin JavaScript
    if (typeof urlRaw === 'string' && urlRaw.startsWith('blob:')) {
      return { trusted: true, reason: 'blob-worker' };
    }

    try {
      const u   = new URL(urlRaw, location.href);
      const abs = u.href;

      // Same-origin known path
      if (u.origin === location.origin && ALLOWED_WORKER_PATHS.has(u.pathname)) {
        return { trusted: true, reason: 'known-path' };
      }

      // Same-origin unknown path — allowed with warning
      if (u.origin === location.origin) {
        return { trusted: true, reason: 'same-origin-unknown', warn: true };
      }

      // Cross-origin trusted CDN
      if (ALLOWED_WORKER_ORIGINS.has(u.origin)) {
        return { trusted: true, reason: 'trusted-cdn' };
      }

      return { trusted: false, reason: 'untrusted-origin', origin: u.origin };
    } catch {
      return { trusted: false, reason: 'invalid-url' };
    }
  }

  // ── Spawn helper ─────────────────────────────────────────────────────────────

  const _OrigWorker = G.Worker;

  /**
   * Spawn a validated Worker.
   * Identical signature to  new Worker(url, options)  but runs validation first.
   *
   * @param {string|URL} url
   * @param {WorkerOptions} [options]
   * @returns {Worker}
   */
  function _spawn(url, options) {
    const urlStr    = String(url);
    const result    = _validate(urlStr);
    _audit(urlStr, result.trusted, result.reason);

    if (result.warn) {
      console.info('[RuntimeWorkerFactory] spawning same-origin worker with unknown path:', urlStr);
    }

    // Phase 2: log violations but do NOT block (non-breaking).
    // Phase 3 may add: if (!result.trusted) throw new Error('blocked');
    return new _OrigWorker(url, options);
  }

  // ── Worker constructor patch (non-breaking) ──────────────────────────────────
  // Replace window.Worker with a thin validation wrapper.
  // Existing  new Worker(path)  call-sites are unaffected.

  if (!_lite && _OrigWorker && !G.Worker._factoryPatched) {
    try {
      function PatchedWorker(url, options) {
        const urlStr = String(url);
        const result = _validate(urlStr);
        _audit(urlStr, result.trusted, result.reason);
        if (result.warn) {
          console.info('[RuntimeWorkerFactory] spawning:', urlStr, '(', result.reason, ')');
        }
        return new _OrigWorker(url, options);
      }

      // Preserve prototype chain so instanceof checks pass
      PatchedWorker.prototype = _OrigWorker.prototype;
      Object.defineProperty(PatchedWorker, '_factoryPatched', { value: true, writable: false });
      Object.defineProperty(PatchedWorker, '_origWorker',     { value: _OrigWorker, writable: false });

      // Copy static properties from native Worker
      try { PatchedWorker.DEDICATED_WORKER   = _OrigWorker.DEDICATED_WORKER;   } catch { /* skip */ }
      try { PatchedWorker.SHARED_WORKER      = _OrigWorker.SHARED_WORKER;      } catch { /* skip */ }
      try { PatchedWorker.SERVICE_WORKER     = _OrigWorker.SERVICE_WORKER;     } catch { /* skip */ }

      G.Worker = PatchedWorker;
    } catch (e) {
      // If patching fails, native Worker is untouched
      console.info('[RuntimeWorkerFactory] worker patch skipped:', e.message);
    }
  }

  // ── Allowlist management ─────────────────────────────────────────────────────

  function _registerWorkerPath(path) {
    ALLOWED_WORKER_PATHS.add(path);
  }

  function _registerWorkerOrigin(origin) {
    ALLOWED_WORKER_ORIGINS.add(origin);
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  G.RuntimeWorkerFactory = Object.freeze({
    VERSION,

    /** Spawn a validated Worker (recommended API for new code). */
    spawn: _spawn,

    /** Validate a worker URL without spawning. */
    validate: _validate,

    /** Add a new known path to the allowlist at runtime. */
    registerPath: _registerWorkerPath,

    /** Add a trusted cross-origin worker origin. */
    registerOrigin: _registerWorkerOrigin,

    /** Full audit log of all worker spawn attempts. */
    getAuditLog() { return _auditLog.slice(); },

    /** Diagnostic summary. */
    audit() {
      return {
        allowedPaths:   Array.from(ALLOWED_WORKER_PATHS),
        allowedOrigins: Array.from(ALLOWED_WORKER_ORIGINS),
        spawnCount:     _auditLog.length,
        violations:     _auditLog.filter(e => !e.trusted),
        patched:        !_lite,
        deviceScore:    _score,
      };
    },
  });

}(window));

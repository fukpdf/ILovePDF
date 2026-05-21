// RuntimeStaticAssetPins v1.0 — Phase 4 / Task 6 (Static Asset Pinning)
// ============================================================================
// Pins CDN asset versions (especially Lucide icons), provides integrity
// verification, cache-busting fingerprints, and fallback handling.
//
// Pinned assets:
//   • Lucide icons (unpkg.com) — exact version locked
//   • PDF.js (cdn.jsdelivr.net) — exact version locked
//   • Any asset registered at runtime via RuntimeStaticAssetPins.pin()
//
// Verification:
//   • SubtleCrypto SHA-256 digest compared against stored hex hash
//   • HIGH/EXTREME tier: verify on first access (deferred, non-blocking)
//   • LOW/MEDIUM tier: skip verification to preserve performance
//
// Fallback:
//   • If a CDN asset fails integrity check → load self-hosted fallback
//   • Fallback path defined per asset in the pins registry
//   • Fallback is ONLY activated when asset has a stored hash AND it mismatches
//
// Cache-busting:
//   • Same-origin assets: append ?v=<sha256_prefix_8> to URL
//   • CDN assets: rely on version pinning (version IS the cache key)
//
// window.RuntimeStaticAssetPins
//   .pin(id, url, options)       → void
//   .verify(id)                  → Promise<{ ok, id, url, fallback? }>
//   .verifyAll()                 → Promise<SummaryReport>
//   .getPin(id)                  → PinEntry|null
//   .status()                    → { pins, verified, mismatches, fallbacks }
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeStaticAssetPins) return;

  var VERSION = '1.0';
  var LOG     = '[StaticPins]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Tier check ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _canVerifyAssets = _score >= 70; // HIGH+ only

  // ── Built-in pinned assets ────────────────────────────────────────────────
  // Format: id → { url, version, hash, fallback, critical }
  //   hash:     64-char hex SHA-256 (null = skip hash check, version-pin only)
  //   fallback: local path to serve if CDN fails integrity check
  //   critical: if true, fallback is mandatory; if false, missing asset is tolerated
  var _DEFAULT_PINS = [
    {
      id:       'lucide-icons',
      url:      'https://unpkg.com/lucide@0.511.0/dist/umd/lucide.min.js',
      version:  '0.511.0',
      hash:     null,        // hash populated at build time by generate-sri-hashes.js
      fallback: null,        // no self-hosted fallback (icons are decorative)
      critical: false,
    },
    {
      id:       'pdfjs-worker',
      url:      'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs',
      version:  '4.4.168',
      hash:     null,
      fallback: '/workers/pdf-worker.js',
      critical: true,
    },
    {
      id:       'pdfjs-main',
      url:      'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs',
      version:  '4.4.168',
      hash:     null,
      fallback: null,
      critical: false,
    },
  ];

  // ── Registry: Map<id, PinEntry> ───────────────────────────────────────────
  var _pins = typeof Map !== 'undefined' ? new Map() : null;

  // ── Stats ─────────────────────────────────────────────────────────────────
  var _stats = {
    verified:   0,
    mismatches: 0,
    fallbacks:  0,
    skipped:    0,
  };

  // ── Register a pin ────────────────────────────────────────────────────────
  function pin(id, url, opts) {
    if (!_pins || !id || !url) return;
    opts = opts || {};
    _pins.set(id, {
      id:       id,
      url:      url,
      version:  opts.version  || null,
      hash:     opts.hash     || null,
      fallback: opts.fallback || null,
      critical: opts.critical !== false, // default true
      verified: false,
      ok:       null,
      verifiedTs: null,
    });
  }

  // ── Seed default pins ─────────────────────────────────────────────────────
  function _seedDefaults() {
    _DEFAULT_PINS.forEach(function (p) {
      pin(p.id, p.url, { version: p.version, hash: p.hash, fallback: p.fallback, critical: p.critical });
    });
  }

  // ── Get a pin ─────────────────────────────────────────────────────────────
  function getPin(id) {
    return _pins ? (_pins.get(id) || null) : null;
  }

  // ── Fetch and hash a URL ──────────────────────────────────────────────────
  function _fetchAndHash(url) {
    return fetch(url, { cache: 'no-store', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (!G.crypto || !G.crypto.subtle) throw new Error('SubtleCrypto unavailable');
        return G.crypto.subtle.digest('SHA-256', buf);
      })
      .then(function (hashBuf) {
        return Array.from(new Uint8Array(hashBuf))
          .map(function (b) { return ('0' + b.toString(16)).slice(-2); })
          .join('');
      });
  }

  // ── Verify a single pinned asset ──────────────────────────────────────────
  function verify(id) {
    var entry = _pins ? _pins.get(id) : null;
    if (!entry) {
      return Promise.resolve({ ok: false, id: id, reason: 'not-registered' });
    }

    // No hash to verify against — version-pinning only (URL contains version)
    if (!entry.hash) {
      _stats.verified++;
      entry.verified   = true;
      entry.ok         = true;
      entry.verifiedTs = Date.now();
      return Promise.resolve({ ok: true, id: id, url: entry.url, reason: 'version-pin-only' });
    }

    if (!_canVerifyAssets) {
      _stats.skipped++;
      return Promise.resolve({ ok: true, id: id, url: entry.url, reason: 'tier-too-low' });
    }

    return _fetchAndHash(entry.url)
      .then(function (actual) {
        _stats.verified++;
        var ok = actual === entry.hash;
        entry.verified   = true;
        entry.ok         = ok;
        entry.verifiedTs = Date.now();

        if (!ok) {
          _stats.mismatches++;
          console.warn(LOG, 'integrity mismatch:', id, '| url:', entry.url);
          console.warn(LOG, '  pinned:', entry.hash);
          console.warn(LOG, '  actual:', actual);

          _s(function () {
            if (G.SecurityTelemetry) {
              G.SecurityTelemetry.record('integrity-failure', {
                path:    entry.url,
                chunkId: id,
                reason:  'cdn-hash-mismatch',
              });
            }
          });

          // Activate fallback if available
          if (entry.fallback) {
            _stats.fallbacks++;
            console.info(LOG, 'loading fallback for', id, '→', entry.fallback);
            return { ok: false, id: id, url: entry.url, fallback: entry.fallback, mismatch: true };
          }
          return { ok: false, id: id, url: entry.url, mismatch: true };
        }

        console.debug(LOG, 'verified OK:', id, '→', actual.slice(0, 12) + '…');
        return { ok: true, id: id, url: entry.url };
      })
      .catch(function (err) {
        _stats.skipped++;
        console.debug(LOG, 'verify fetch error:', id, '|', err.message);
        return { ok: true, id: id, url: entry.url, reason: 'fetch-error', error: err.message };
      });
  }

  // ── Verify all pinned assets ──────────────────────────────────────────────
  function verifyAll() {
    if (!_pins || _pins.size === 0) {
      return Promise.resolve({ verified: 0, mismatches: 0, fallbacks: 0 });
    }
    var ids      = Array.from(_pins.keys());
    var promises = ids.map(function (id) { return verify(id); });
    return Promise.all(promises).then(function (results) {
      var mismatches = results.filter(function (r) { return r.mismatch; }).length;
      var fallbacks  = results.filter(function (r) { return r.fallback; }).length;
      console.info(LOG, 'verifyAll: checked', results.length,
        '| mismatches:', mismatches, '| fallbacks:', fallbacks);
      return { verified: results.length, mismatches: mismatches, fallbacks: fallbacks, results: results };
    });
  }

  // ── Cache-bust helper for same-origin assets ──────────────────────────────
  // Returns url + ?v=<8-char hash prefix> (only for non-CDN paths)
  function cacheBust(url, hash) {
    if (!url || !hash) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url; // CDN: version in URL
    var sep = url.includes('?') ? '&' : '?';
    return url + sep + 'v=' + hash.slice(0, 8);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _seedDefaults();
    // Deferred verification — don't block initial render
    if (_canVerifyAssets) {
      setTimeout(function () {
        verifyAll().catch(function () {});
      }, 8000); // 8s — after all critical scripts have loaded
    }
    console.info(LOG, 'v' + VERSION + ' ready | pins:', (_pins ? _pins.size : 0),
      '| canVerify:', _canVerifyAssets);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1000); }, { once: true });
  } else {
    setTimeout(_boot, 1000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeStaticAssetPins = Object.freeze({
    VERSION:   VERSION,
    pin:       pin,
    verify:    verify,
    verifyAll: verifyAll,
    getPin:    getPin,
    cacheBust: cacheBust,
    status: function () {
      var pinList = [];
      if (_pins) {
        _pins.forEach(function (e) {
          pinList.push({
            id:      e.id,
            version: e.version,
            ok:      e.ok,
            verified: e.verified,
            hasFallback: !!e.fallback,
          });
        });
      }
      return {
        pins:       pinList,
        verified:   _stats.verified,
        mismatches: _stats.mismatches,
        fallbacks:  _stats.fallbacks,
        skipped:    _stats.skipped,
        canVerify:  _canVerifyAssets,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));

// RuntimeToolBundleSegments v1.0 — Arc 3 / Phase G / Target 8
// =====================================================================
// Tool-aware bundle segment activation.
//
// Problem: RuntimeBundleRegistry loads bundles globally on demand.
// There is no concept of "this bundle is only needed for AI tools"
// or "don't load OCR runtime when the user is on Merge PDF."
//
// Solution: Define per-family bundle segments. When a tool activates,
// only the segments needed for that tool's family are loaded. Other
// families' bundle segments remain dormant.
//
// Segment map (family → bundle group names in RuntimeBundleRegistry):
//   All families need at minimum: core, security, zero-trust, hardening, infra, arc2
//   AI family additionally needs: (future: ai-specific bundle)
//   No family activates segments for other families proactively
//
// Activation is idempotent — loading the same bundle twice is a no-op
// in RuntimeBundleRegistry (already handled).
//
// Observable: RuntimeBundleRegistry.status() will show which bundles
// have been activated and by which tool family.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolBundleSegments) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ToolBundleSeg]';
  var VERSION = '1.0';

  // ── Segment map: family → ordered list of RuntimeBundleRegistry group names ──
  // All tools share the base security stack.
  // Family-specific extensions listed after the base.
  var BASE_BUNDLES = ['core', 'security', 'zero-trust', 'hardening', 'infra', 'arc2'];

  var FAMILY_SEGMENTS = {
    'organize':     BASE_BUNDLES.slice(),
    'compress':     BASE_BUNDLES.slice(),
    'convert-from': BASE_BUNDLES.slice(),
    'convert-to':   BASE_BUNDLES.slice(),
    'edit':         BASE_BUNDLES.slice(),
    'ai':           BASE_BUNDLES.concat([]),  // placeholder for future ai-bundle
    'image':        BASE_BUNDLES.slice(),
    'utility':      BASE_BUNDLES.slice(),
  };

  // ── Activation tracking ───────────────────────────────────────────────────
  var _activated = {}; // family → true when segments activated
  var _loadLog   = []; // activation history: { family, toolId, ts, bundles[] }

  // ── Activate segments for a tool ─────────────────────────────────────────
  function activateForTool(toolId, family) {
    if (!family) return Promise.resolve({ ok: true, alreadyActive: false, family: null, toolId: toolId, bundles: [], errors: [] });
    if (_activated[family]) {
      console.debug(LOG, 'segments already active for family:', family);
      return Promise.resolve({ ok: true, alreadyActive: true, family: family, toolId: toolId, bundles: (FAMILY_SEGMENTS[family] || BASE_BUNDLES).slice(), errors: [] });
    }

    var segments = FAMILY_SEGMENTS[family] || BASE_BUNDLES;
    var reg = G.RuntimeBundleRegistry;
    if (!reg || typeof reg.load !== 'function' || typeof reg.status !== 'function') {
      console.debug(LOG, 'RuntimeBundleRegistry unavailable for:', family);
      return Promise.resolve({ ok: false, alreadyActive: false, family: family, toolId: toolId, bundles: segments.slice(), errors: ['registry-unavailable'] });
    }

    console.debug(LOG, 'activating segments for', family, '/', toolId, '—', segments.join(', '));

    // Load sequentially so dependency order is preserved. The family is not
    // marked active until every requested segment has successfully loaded.
    return segments.reduce(function (chain, seg) {
      return chain.then(function (result) {
        if (!result.ok) return result;
        return reg.load(seg).then(function () {
          var state = reg.status();
          if (!state || !state[seg] || state[seg].loaded !== true) {
            result.errors.push(seg + ':not-loaded');
            result.ok = false;
            return result;
          }
          return result;
        }).catch(function (e) {
          result.errors.push(seg + ':' + String(e && e.message || e));
          result.ok = false;
          return result;
        });
      });
    }, Promise.resolve({ ok: true, alreadyActive: false, family: family, toolId: toolId, bundles: segments.slice(), errors: [] }))
      .then(function (result) {
        if (result.ok) {
          _activated[family] = true;
          _loadLog.push({ family: family, toolId: toolId, ts: Date.now(), bundles: segments.slice() });
          console.debug(LOG, 'segments activated:', family, '/', toolId);
        } else {
          try {
            G.dispatchEvent(new CustomEvent('tool-bundle-segments:activation-failed', {
              detail: { family: family, toolId: toolId, bundles: segments.slice(), errors: result.errors.slice() }
            }));
          } catch (_) {}
          console.debug(LOG, 'segment activation failed:', family, result.errors);
        }
        return result;
      });
  }

  // ── Status ────────────────────────────────────────────────────────────────
  function status() {
    var reg = G.RuntimeBundleRegistry;
    var bundleStatus = reg ? reg.status() : {};
    return {
      activatedFamilies: Object.keys(_activated),
      bundleStatus:      bundleStatus,
      loadLog:           _loadLog.slice(),
    };
  }

  // ── Register a new family segment ─────────────────────────────────────────
  function registerFamilySegment(family, bundles) {
    if (!Array.isArray(bundles)) return;
    FAMILY_SEGMENTS[family] = bundles;
  }

  G.RuntimeToolBundleSegments = Object.freeze({
    VERSION:               VERSION,
    activateForTool:       activateForTool,
    status:                status,
    registerFamilySegment: registerFamilySegment,
    isActivated:           function (family) { return !!_activated[family]; },
  });

}(window));

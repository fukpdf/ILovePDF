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
    if (!family) return;
    if (_activated[family]) {
      console.debug(LOG, 'segments already active for family:', family);
      return;
    }

    var segments = FAMILY_SEGMENTS[family] || BASE_BUNDLES;
    _activated[family] = true;
    _loadLog.push({ family: family, toolId: toolId, ts: Date.now(), bundles: segments.slice() });

    console.debug(LOG, 'activating segments for', family, '/', toolId, '—', segments.join(', '));

    // Load each segment in dependency order
    var reg = G.RuntimeBundleRegistry;
    if (!reg) {
      console.debug(LOG, 'RuntimeBundleRegistry not available — segments queued');
      // Queue for later: retry after 2 seconds
      setTimeout(function () {
        var r = G.RuntimeBundleRegistry;
        if (r) {
          segments.forEach(function (seg) {
            r.load(seg).catch(function (e) {
              console.debug(LOG, 'segment load error:', seg, e && e.message || e);
            });
          });
        }
      }, 2000);
      return;
    }

    // Load sequentially to preserve dependency order
    segments.reduce(function (chain, seg) {
      return chain.then(function () {
        return reg.load(seg).catch(function (e) {
          // Non-fatal: segment may already be loaded via script tags
          console.debug(LOG, 'segment load note:', seg, e && e.message || e);
        });
      });
    }, Promise.resolve());
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

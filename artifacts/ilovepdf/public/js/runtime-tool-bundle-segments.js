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

  // tool.html already loads these source modules individually before DOMContentLoaded.
  // Reuse them instead of fetching a second concatenated copy of the same code.
  var SOURCE_FILES = {
    "core": [
      "runtime-shadow-runtime.js"
    ],
    "security": [
      "runtime-secure-session.js",
      "runtime-edge-attestation.js",
      "runtime-hybrid-execution.js",
      "runtime-capability-manager.js",
      "runtime-execution-sandbox.js",
      "runtime-wasm-fortress.js",
      "runtime-wasm-isolation.js",
      "runtime-wasm-encrypted-loader.js",
      "runtime-encrypted-chunks.js",
      "runtime-tokenized-loader.js",
      "runtime-threat-correlation.js",
      "runtime-anomaly-engine.js"
    ],
    "zero-trust": [
      "runtime-human-signals.js",
      "runtime-automation-detection.js",
      "runtime-behavior-analysis.js",
      "runtime-worker-mesh.js",
      "runtime-worker-auth.js",
      "runtime-worker-encryption.js",
      "runtime-worker-routing.js",
      "runtime-edge-policy.js",
      "runtime-edge-proof.js",
      "runtime-edge-runtime.js",
      "runtime-deployment-registry.js",
      "runtime-build-chain.js",
      "runtime-release-channel.js",
      "runtime-session-keys.js",
      "runtime-execution-crypto.js",
      "runtime-packet-integrity.js",
      "runtime-wasm-mesh.js",
      "runtime-wasm-scheduler.js",
      "runtime-wasm-attestation.js",
      "runtime-incident-engine.js",
      "runtime-forensics.js",
      "runtime-session-recorder.js",
      "runtime-security-stream.js",
      "runtime-security-visualizer.js"
    ],
    "hardening": [
      "runtime-session-persistence.js",
      "runtime-forensics-replay.js",
      "runtime-csp-enforcer.js",
      "runtime-threat-intel.js",
      "runtime-tab-mesh.js",
      "runtime-memory-vault.js"
    ],
    "infra": [
      "runtime-network-state.js",
      "runtime-memory-recovery.js",
      "runtime-lazy-engine-loader.js",
      "runtime-performance-monitor.js",
      "runtime-stream-pipeline.js",
      "runtime-worker-prewarm.js"
    ],
    "arc2": [
      "runtime-deploy-sync.js",
      "runtime-html-version-guard.js",
      "runtime-hydration-scheduler.js",
      "runtime-crash-telemetry.js",
      "runtime-bundle-registry.js",
      "runtime-offline-processor.js",
      "runtime-worker-coordinator.js",
      "runtime-edge-hints.js",
      "runtime-health-analytics.js"
    ]
  };

  function _hasSourceFiles(files) {
    if (!files || !files.length || !document.scripts) return false;
    var sources = Array.prototype.map.call(document.scripts, function (script) {
      return String(script.getAttribute('src') || '').split('?')[0];
    });
    return files.every(function (file) {
      var expected = '/js/' + file;
      return sources.some(function (src) { return src === expected || src.slice(-expected.length) === expected; });
    });
  }

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
        // All six base bundle source sets are already included individually
        // in tool.html and execute before DOMContentLoaded. Reuse those modules
        // rather than fetching and executing a duplicate bundle.
        if (SOURCE_FILES[seg] && _hasSourceFiles(SOURCE_FILES[seg]) &&
            typeof reg.markSourceBacked === 'function' && reg.markSourceBacked(seg)) {
          var sourceState = reg.status();
          if (sourceState && sourceState[seg] && sourceState[seg].loaded === true &&
              sourceState[seg].sourceBacked === true) {
            return result;
          }
        }

        return reg.load(seg).then(function () {
          // Require the activation result itself to remain explicitly successful before
          // accepting the registry's loaded-state verification below.
          if (result.ok !== true) return result;
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

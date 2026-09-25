// RepairPdfApp v2.0 — Phase 5 Unit 7
// Thin tool-owned lifecycle adapter. Processing is delegated to the authoritative
// BrowserTools shared worker runtime; this file no longer owns a dedicated worker,
// CDN dependency, artificial timeout, or main-thread fallback.
(function (G) {
  'use strict';

  var _mounted = false;
  var _inFlight = false;
  var _runs = 0;
  var _failures = 0;

  async function process(files, opts) {
    if (_inFlight) throw new Error('Repair already in progress');
    if (!G.BrowserTools || typeof G.BrowserTools.process !== 'function') {
      throw new Error('Repair browser worker runtime unavailable');
    }
    _inFlight = true;
    _runs++;
    try {
      return await G.BrowserTools.process('repair', files, opts || {});
    } catch (err) {
      _failures++;
      throw err;
    } finally {
      _inFlight = false;
    }
  }

  function mount() { _mounted = true; }
  function unmount() { _mounted = false; _inFlight = false; }
  function reset() { _inFlight = false; }
  function recover() { _inFlight = false; }
  function destroy() { _mounted = false; _inFlight = false; }
  function getState() {
    return { mounted: _mounted, inFlight: _inFlight, scheduler: { runs: _runs, failures: _failures } };
  }

  function _register() {
    if (!G.ToolAppManager) return;
    G.ToolAppManager.registerTool('repair', function () {
      return { process, mount, unmount, reset, recover, destroy, getState };
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _register);
  else _register();

  G.RepairScheduler = {
    canRun: function () { return !_inFlight; },
    stats: function () { return { runs: _runs, failures: _failures }; },
  };
  G.RepairMemoryManager = Object.freeze({});
  G.RepairRecoveryManager = Object.freeze({ recover: recover });
  G.RepairTelemetry = Object.freeze({});
}(window));

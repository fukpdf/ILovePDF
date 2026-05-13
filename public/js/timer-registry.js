// Timer Registry — centralized lifecycle management for setInterval / setTimeout.
// Prevents orphan timers on pagehide by tracking all registered timers by owner ID.
// Hooked automatically into pagehide (emergency clear) and into LifecycleManager
// if present.
//
// API (window.TimerRegistry):
//   registerInterval(owner, id) → id
//   registerTimeout(owner, id)  → id
//   clearOwner(owner)
//   emergencyClearAll()
//   stats() → { owners, intervals, timeouts }
(function () {
  'use strict';

  var _intervals = {}; // owner → [intervalId, ...]
  var _timeouts  = {}; // owner → [timeoutId, ...]

  function registerInterval(owner, id) {
    if (!_intervals[owner]) _intervals[owner] = [];
    _intervals[owner].push(id);
    return id;
  }

  function registerTimeout(owner, id) {
    if (!_timeouts[owner]) _timeouts[owner] = [];
    _timeouts[owner].push(id);
    return id;
  }

  function clearOwner(owner) {
    var ivs = _intervals[owner] || [];
    var tos = _timeouts[owner]  || [];
    ivs.forEach(function (id) { try { clearInterval(id);  } catch (_) {} });
    tos.forEach(function (id) { try { clearTimeout(id); } catch (_) {} });
    delete _intervals[owner];
    delete _timeouts[owner];
  }

  function emergencyClearAll() {
    Object.keys(_intervals).forEach(function (owner) {
      (_intervals[owner] || []).forEach(function (id) {
        try { clearInterval(id); } catch (_) {}
      });
    });
    Object.keys(_timeouts).forEach(function (owner) {
      (_timeouts[owner] || []).forEach(function (id) {
        try { clearTimeout(id); } catch (_) {}
      });
    });
    _intervals = {};
    _timeouts  = {};
  }

  function stats() {
    var totalIv = 0, totalTo = 0;
    Object.keys(_intervals).forEach(function (o) { totalIv += _intervals[o].length; });
    Object.keys(_timeouts).forEach(function (o)  { totalTo += _timeouts[o].length;  });
    return { owners: Object.keys(_intervals).length + Object.keys(_timeouts).length, intervals: totalIv, timeouts: totalTo };
  }

  // Automatic pagehide hook — runs before LifecycleManager (loaded later).
  window.addEventListener('pagehide', function () {
    emergencyClearAll();
  }, { passive: true });

  window.TimerRegistry = { registerInterval, registerTimeout, clearOwner, emergencyClearAll, stats };
}());

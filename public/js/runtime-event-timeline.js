// RuntimeEventTimeline v1.0 — Arc 8 / Phase D
// =====================================================================
// Centralized runtime event timeline. Captures ALL runtime CustomEvents
// into a searchable, bounded ring buffer with compression and grouping.
//
// Coverage: worker, hydration, bundle, recovery, panic, predictive,
//   deploy, offline, task, control plane, extreme mode events.
//
// Features:
//   - Searchable by keyword, family, processor, workerDomain
//   - Grouped views by tool family / processor / worker domain
//   - Bounded ring buffer (2000 events, configurable)
//   - Burst compression: identical events within 50ms collapsed to count
//   - Timeline snapshots (frozen copy at a moment in time)
//   - window.getEventTimeline() for console/dashboard access
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeEventTimeline) return;

  var LOG     = '[EventTimeline]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_EVENTS   = 2000;
  var COMPRESS_MS  = 50;   // collapse duplicate events within this window

  // ── Storage ───────────────────────────────────────────────────────
  var _events  = [];  // { id, ts, type, family, processor, workerDomain, data, count }
  var _seq     = 0;
  var _metrics = { captured: 0, compressed: 0, dropped: 0 };

  function _genId() { return ++_seq; }

  // ── Capture an event ──────────────────────────────────────────────
  function capture(type, data, tags) {
    tags = tags || {};
    var now = Date.now();

    // Burst compression: check last event
    if (_events.length > 0) {
      var last = _events[_events.length - 1];
      if (last.type === type && (now - last.ts) <= COMPRESS_MS &&
          last.family === (tags.family || null) &&
          last.processor === (tags.processor || null)) {
        last.count = (last.count || 1) + 1;
        last.tsLast = now;
        _metrics.compressed++;
        return last.id;
      }
    }

    var ev = {
      id:          _genId(),
      ts:          now,
      type:        type,
      family:      tags.family       || null,
      processor:   tags.processor    || null,
      workerDomain: tags.workerDomain || null,
      data:        data  ? Object.assign({}, data) : null,
      count:       1,
      tsLast:      now,
    };

    _events.push(ev);
    _metrics.captured++;
    if (_events.length > MAX_EVENTS) {
      _events.shift();
      _metrics.dropped++;
    }
    return ev.id;
  }

  // ── Listen to all runtime events ──────────────────────────────────
  var CAPTURE_MAP = [
    // Arc 7 streaming
    { ev: 'streaming-hydration:viewport',      family: null,      tags: function (d) { return { family: null, processor: null, workerDomain: null }; } },
    { ev: 'predictive-loader:preload',         family: 'predict', tags: function (d) { return { family: d && d.family }; } },
    { ev: 'stream-workers:progress',           family: null,      tags: function (d) { return { workerDomain: d && d.token }; } },
    { ev: 'self-optimizer:adapt',              family: null,      tags: function () { return {}; } },
    { ev: 'extreme-mode:activate',             family: null,      tags: function () { return {}; } },
    { ev: 'extreme-mode:deactivate',           family: null,      tags: function () { return {}; } },
    // Arc 8
    { ev: 'arc8:command',                      family: null,      tags: function (d) { return { processor: d && d.cmd }; } },
    { ev: 'arc8:incident',                     family: null,      tags: function (d) { return { family: d && d.category }; } },
    { ev: 'arc8:snapshot',                     family: null,      tags: function () { return {}; } },
    // Memory
    { ev: 'processor-memory:panic',            family: null,      tags: function (d) { return { family: d && d.family }; } },
    { ev: 'memory-firewall:budget-exceeded',   family: null,      tags: function (d) { return { processor: d && d.toolId }; } },
    // Workers
    { ev: 'processor-workers:isolated',        family: null,      tags: function (d) { return { family: d && d.family }; } },
    { ev: 'tool:worker-crash',                 family: null,      tags: function (d) { return { processor: d && d.toolId }; } },
    // Hydration
    { ev: 'processor-hydration:activated',     family: null,      tags: function (d) { return { processor: d && d.toolId }; } },
    { ev: 'arc7:streaming-hydration-ready',    family: null,      tags: function () { return {}; } },
    // Deploy
    { ev: 'deploy:sync-ready',                 family: 'deploy',  tags: function (d) { return { workerDomain: d && d.buildId }; } },
    // Mobile
    { ev: 'mobile:battery-save',               family: 'mobile',  tags: function () { return {}; } },
    // Offline
    { ev: 'offline:queued',                    family: 'offline', tags: function (d) { return { processor: d && d.toolId }; } },
    { ev: 'offline:replayed',                  family: 'offline', tags: function (d) { return { processor: d && d.toolId }; } },
    // Recovery
    { ev: 'recovery:escalated',                family: 'recovery', tags: function (d) { return { processor: d && d.toolId }; } },
    // Task
    { ev: 'task-orchestrator:throttled',       family: 'task',    tags: function () { return {}; } },
  ];

  CAPTURE_MAP.forEach(function (spec) {
    G.addEventListener(spec.ev, function (evt) {
      try {
        var d    = evt && evt.detail;
        var tags = spec.tags(d);
        capture(spec.ev, d, tags);
      } catch (_) {}
    });
  });

  // ── Query / search ────────────────────────────────────────────────
  function search(opts) {
    opts = opts || {};
    var result = _events.slice();
    if (opts.keyword) {
      var kw = String(opts.keyword).toLowerCase();
      result = result.filter(function (e) {
        return e.type.toLowerCase().includes(kw) ||
          (e.family && e.family.toLowerCase().includes(kw)) ||
          (e.processor && String(e.processor).toLowerCase().includes(kw));
      });
    }
    if (opts.family)      result = result.filter(function (e) { return e.family === opts.family; });
    if (opts.processor)   result = result.filter(function (e) { return e.processor === opts.processor; });
    if (opts.workerDomain) result = result.filter(function (e) { return e.workerDomain === opts.workerDomain; });
    if (opts.since)       result = result.filter(function (e) { return e.ts >= opts.since; });
    if (opts.limit)       result = result.slice(-opts.limit);
    return result;
  }

  // ── Grouped view ──────────────────────────────────────────────────
  function groupBy(field) {
    var groups = {};
    _events.forEach(function (e) {
      var key = e[field] || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    });
    return groups;
  }

  // ── Snapshot ──────────────────────────────────────────────────────
  function snapshot() {
    var snap = Object.freeze({
      ts:     Date.now(),
      count:  _events.length,
      events: _events.slice().map(Object.freeze),
      metrics: Object.assign({}, _metrics),
    });
    try {
      G.dispatchEvent(new CustomEvent('arc8:snapshot', { detail: { type: 'timeline', count: snap.count } }));
    } catch (_) {}
    return snap;
  }

  // ── Export ────────────────────────────────────────────────────────
  G.getEventTimeline = function (opts) { return search(opts || {}); };

  G.RuntimeEventTimeline = Object.freeze({
    VERSION:  VERSION,
    capture:  capture,
    search:   search,
    groupBy:  groupBy,
    snapshot: snapshot,
    getMetrics: function () { return Object.assign({}, _metrics); },
    getCount:   function () { return _events.length; },
    clear:      function () { _events = []; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — listening to', CAPTURE_MAP.length, 'event types | window.getEventTimeline()');

}(window));

// DebugTrace — in-memory per-session audit log for tool processing.
// Stores up to 500 entries; accessible as window.DebugTrace.
// UI never shows these logs — internal diagnostic only.
// Usage: DebugTrace.log(step, meta), DebugTrace.error(step, err), DebugTrace.result(step, output)
(function () {
  'use strict';

  var MAX_ENTRIES = 500;
  var _logs = [];

  function _push(type, step, data) {
    if (_logs.length >= MAX_ENTRIES) _logs.shift();
    var entry = {
      t:    Date.now(),
      type: type,
      step: String(step || ''),
      data: data !== undefined ? data : null,
    };
    _logs.push(entry);
  }

  function _safeData(d) {
    if (d === null || d === undefined) return null;
    if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') return d;
    if (d instanceof Error) return { message: d.message, stack: (d.stack || '').slice(0, 300) };
    try { return JSON.parse(JSON.stringify(d)); } catch (_) { return String(d); }
  }

  var DebugTrace = {
    log: function (step, meta) {
      _push('log', step, _safeData(meta));
    },

    error: function (step, err) {
      _push('error', step, _safeData(err));
    },

    result: function (step, output) {
      _push('result', step, _safeData(output));
    },

    getLogs: function () {
      return _logs.slice();
    },

    last: function (n) {
      return _logs.slice(-(Math.max(1, n || 20)));
    },

    clear: function () {
      _logs = [];
    },

    // Produce a readable report string for console inspection
    report: function () {
      if (!_logs.length) return 'DebugTrace: (no entries)';
      var lines = ['=== DebugTrace Report (' + _logs.length + ' entries) ==='];
      _logs.forEach(function (e) {
        var ts  = new Date(e.t).toISOString().slice(11, 23);
        var tag = e.type === 'error' ? '[ERR]' : e.type === 'result' ? '[RES]' : '[LOG]';
        var d   = e.data !== null ? ' ' + JSON.stringify(e.data) : '';
        lines.push(ts + ' ' + tag + ' ' + e.step + d);
      });
      return lines.join('\n');
    },

    // dump to console (call DebugTrace.dump() in DevTools)
    dump: function () {
      /* eslint-disable no-console */
      console.group('DebugTrace');
      _logs.forEach(function (e) {
        var fn = e.type === 'error' ? console.error : e.type === 'result' ? console.info : console.log;
        fn('[' + e.step + ']', e.data !== null ? e.data : '');
      });
      console.groupEnd();
    },
  };

  window.DebugTrace = DebugTrace;
}());

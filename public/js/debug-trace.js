// DebugTrace v2 — in-memory per-session audit log for tool processing.
// Stores up to 500 entries; accessible as window.DebugTrace.
// UI never shows these logs — internal diagnostic + quality tracking only.
// Usage: DebugTrace.log(step, meta) | error(step, err) | result(step, out) | validate(step, data)
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

    // Phase 12: quality + content validation events
    // result: { toolId, issues?, score?, chars?, paras?, ... }
    validate: function (step, result) {
      _push('validate', step, _safeData(result));
    },

    getLogs: function () {
      return _logs.slice();
    },

    // Filter logs by type
    getByType: function (type) {
      return _logs.filter(function (e) { return e.type === type; });
    },

    last: function (n) {
      return _logs.slice(-(Math.max(1, n || 20)));
    },

    clear: function () {
      _logs = [];
    },

    // Quality summary — aggregate all validate events into a score
    qualitySummary: function () {
      var validates = _logs.filter(function (e) { return e.type === 'validate'; });
      var errors    = _logs.filter(function (e) { return e.type === 'error'; });
      var results   = _logs.filter(function (e) { return e.type === 'result'; });
      var issues    = [];
      validates.forEach(function (e) {
        if (e.data && e.data.issues && e.data.issues.length) {
          issues = issues.concat(e.data.issues);
        }
      });
      var latestQuality = null;
      for (var i = validates.length - 1; i >= 0; i--) {
        if (validates[i].data && validates[i].data.score !== undefined) {
          latestQuality = validates[i].data;
          break;
        }
      }
      return {
        totalEntries:  _logs.length,
        errors:        errors.length,
        results:       results.length,
        validates:     validates.length,
        issues:        issues,
        qualityScore:  latestQuality ? latestQuality.score : null,
        ocrUsed:       validates.some(function (e) { return e.data && e.data.ocrUsed; }),
      };
    },

    // Produce a readable report string for console inspection
    report: function () {
      if (!_logs.length) return 'DebugTrace: (no entries)';
      var lines = ['=== DebugTrace v2 Report (' + _logs.length + ' entries) ==='];
      _logs.forEach(function (e) {
        var ts  = new Date(e.t).toISOString().slice(11, 23);
        var tag = e.type === 'error'    ? '[ERR]' :
                  e.type === 'result'   ? '[RES]' :
                  e.type === 'validate' ? '[VAL]' : '[LOG]';
        var d   = e.data !== null ? ' ' + JSON.stringify(e.data) : '';
        lines.push(ts + ' ' + tag + ' ' + e.step + d);
      });
      var qs = this.qualitySummary();
      lines.push('');
      lines.push('Quality: score=' + qs.qualityScore + ' issues=' + JSON.stringify(qs.issues) + ' ocrUsed=' + qs.ocrUsed);
      return lines.join('\n');
    },

    // dump to console (call DebugTrace.dump() in DevTools)
    dump: function () {
      /* eslint-disable no-console */
      console.group('DebugTrace v2');
      _logs.forEach(function (e) {
        var fn = e.type === 'error'    ? console.error :
                 e.type === 'result'   ? console.info  :
                 e.type === 'validate' ? console.warn  : console.log;
        fn('[' + e.step + ']', e.data !== null ? e.data : '');
      });
      console.groupEnd();
      console.log('Quality Summary:', this.qualitySummary());
    },
  };

  window.DebugTrace = DebugTrace;
}());

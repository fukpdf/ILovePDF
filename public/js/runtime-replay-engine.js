// RuntimeReplayEngine v1.0 — Arc 8 / Phase H
// =====================================================================
// Runtime event replay. Replays events from RuntimeEventTimeline for
// debugging, post-mortem analysis, and stepped execution review.
//
// Distinct from RuntimeForensicsReplay (security attack forensics) —
// this replays OPERATIONAL runtime events for performance debugging.
//
// Features:
//   - Load events from RuntimeEventTimeline or injected dataset
//   - Scrubber: position 0.0–1.0 across event timeline
//   - Playback controls: play / pause / step / setSpeed
//   - Event-by-event debug stepping
//   - Event filtering: by type, family, processor, severity
//   - Playback speed: 0.25x / 0.5x / 1x / 2x / 4x / 10x
//   - Replay export: returns filtered event list as JSON
//   - Emits replay:event on each replayed step for UI integration
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeReplayEngine) return;

  var LOG     = '[ReplayEngine]';
  var VERSION = '1.0';

  // ── State ─────────────────────────────────────────────────────────
  var _dataset   = [];    // loaded events
  var _position  = 0;    // current index
  var _playing   = false;
  var _speed     = 1.0;  // playback speed multiplier
  var _timer     = null;
  var _sessions  = {};   // sessionId → { dataset, position, created }
  var _sessionSeq = 0;
  var _metrics   = { played: 0, stepped: 0, loads: 0, exports: 0 };

  // ── Load events ───────────────────────────────────────────────────
  function load(events, opts) {
    opts    = opts || {};
    var src = events || [];

    // Filter if opts provided
    if (opts.type)    src = src.filter(function (e) { return e.type === opts.type; });
    if (opts.family)  src = src.filter(function (e) { return e.family === opts.family; });
    if (opts.since)   src = src.filter(function (e) { return e.ts >= opts.since; });
    if (opts.until)   src = src.filter(function (e) { return e.ts <= opts.until; });
    if (opts.keyword) {
      var kw = String(opts.keyword).toLowerCase();
      src = src.filter(function (e) {
        return (e.type && e.type.includes(kw)) ||
               (e.family && e.family.includes(kw)) ||
               (e.processor && String(e.processor).includes(kw));
      });
    }

    // Sort by timestamp
    src = src.slice().sort(function (a, b) { return a.ts - b.ts; });
    _dataset  = src;
    _position = 0;
    _playing  = false;
    clearInterval(_timer);
    _timer = null;
    _metrics.loads++;

    console.debug(LOG, 'loaded', src.length, 'events');
    return src.length;
  }

  // ── Load from RuntimeEventTimeline (most common case) ─────────────
  function loadFromTimeline(opts) {
    try {
      var et = G.RuntimeEventTimeline;
      if (!et) { console.warn(LOG, 'RuntimeEventTimeline not available'); return 0; }
      var events = et.search(opts || {});
      return load(events, {});
    } catch (e) {
      console.warn(LOG, 'load-from-timeline error:', e.message);
      return 0;
    }
  }

  // ── Scrub to position ─────────────────────────────────────────────
  function seek(pct) {
    pct = Math.max(0, Math.min(1, pct));
    _position = Math.round(pct * Math.max(0, _dataset.length - 1));
    _emitCurrent();
  }

  function _emitCurrent() {
    var ev = _dataset[_position];
    if (!ev) return;
    try {
      G.dispatchEvent(new CustomEvent('replay:event', {
        detail: { index: _position, total: _dataset.length, event: ev,
                  pct: _dataset.length > 1 ? _position / (_dataset.length - 1) : 1 },
      }));
    } catch (_) {}
    return ev;
  }

  // ── Step forward one event ────────────────────────────────────────
  function step() {
    if (_position < _dataset.length - 1) {
      _position++;
      _metrics.stepped++;
      return _emitCurrent();
    }
    return null;
  }

  // ── Step backward one event ───────────────────────────────────────
  function stepBack() {
    if (_position > 0) {
      _position--;
      _metrics.stepped++;
      return _emitCurrent();
    }
    return null;
  }

  // ── Play ──────────────────────────────────────────────────────────
  function play() {
    if (!_dataset.length || _playing) return;
    _playing = true;

    // Compute interval between events scaled by speed
    function _scheduleNext() {
      if (!_playing || _position >= _dataset.length - 1) {
        _playing = false;
        try { G.dispatchEvent(new CustomEvent('replay:complete', { detail: { count: _dataset.length } })); } catch (_) {}
        console.debug(LOG, 'replay complete —', _dataset.length, 'events');
        return;
      }
      var curr = _dataset[_position];
      var next = _dataset[_position + 1];
      var gap  = next ? Math.max(0, next.ts - curr.ts) : 100;
      var delay = Math.round(gap / _speed);
      delay = Math.max(10, Math.min(delay, 5000)); // clamp 10ms–5s

      _timer = setTimeout(function () {
        if (!_playing) return;
        _position++;
        _metrics.played++;
        _emitCurrent();
        _scheduleNext();
      }, delay);
    }

    _emitCurrent();
    _scheduleNext();
    console.debug(LOG, 'play — speed:', _speed + 'x | events:', _dataset.length, '| from index:', _position);
  }

  // ── Pause ─────────────────────────────────────────────────────────
  function pause() {
    _playing = false;
    clearTimeout(_timer);
    _timer = null;
    console.debug(LOG, 'paused at index:', _position, '/', _dataset.length - 1);
  }

  // ── Speed ─────────────────────────────────────────────────────────
  function setSpeed(s) {
    _speed = Math.max(0.25, Math.min(10, s || 1));
    console.debug(LOG, 'speed set to', _speed + 'x');
  }

  // ── Named sessions ────────────────────────────────────────────────
  function saveSession(label) {
    var id = 'replay_' + (++_sessionSeq);
    _sessions[id] = { id: id, label: label || id, dataset: _dataset.slice(), position: _position, created: Date.now() };
    return id;
  }

  function restoreSession(id) {
    var s = _sessions[id];
    if (!s) return false;
    _dataset  = s.dataset.slice();
    _position = s.position;
    _playing  = false;
    clearTimeout(_timer);
    return true;
  }

  // ── Export ────────────────────────────────────────────────────────
  function exportReplay(opts) {
    _metrics.exports++;
    var data = { version: VERSION, ts: Date.now(), events: _dataset, position: _position };
    var json = JSON.stringify(data, null, 2);
    try {
      var blob = new Blob([json], { type: 'application/json' });
      return { url: URL.createObjectURL(blob), count: _dataset.length, json: json };
    } catch (_) {
      return { url: null, count: _dataset.length, json: json };
    }
  }

  // ── Current state ─────────────────────────────────────────────────
  function getState() {
    return {
      loaded:   _dataset.length,
      position: _position,
      pct:      _dataset.length > 1 ? _position / (_dataset.length - 1) : 0,
      playing:  _playing,
      speed:    _speed,
      current:  _dataset[_position] || null,
    };
  }

  G.RuntimeReplayEngine = Object.freeze({
    VERSION:          VERSION,
    load:             load,
    loadFromTimeline: loadFromTimeline,
    seek:             seek,
    step:             step,
    stepBack:         stepBack,
    play:             play,
    pause:            pause,
    setSpeed:         setSpeed,
    saveSession:      saveSession,
    restoreSession:   restoreSession,
    export:           exportReplay,
    getState:         getState,
    getMetrics:       function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — replay engine initialized');

}(window));

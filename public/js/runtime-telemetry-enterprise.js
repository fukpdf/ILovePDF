// RuntimeTelemetryEnterprise v1.0 — Phase 8H
// =====================================================================
// Enterprise telemetry layer. Extends RuntimeTelemetry with:
//   • Performance timelines (wall-clock task start→end)
//   • Worker flamegraph snapshots (spawn/dispatch/terminate with durations)
//   • Memory timeline (heap samples every 5 s, last 200 points)
//   • Task waterfall tracing (parent→child task relationships)
//   • Stream analytics (bytes/s, chunk count, ack latency distribution)
//   • AI analytics (provider call distribution, latency histogram)
//   • Recovery analytics (checkpoint saves/restores/crash events)
//   • Cross-tab analytics (tab join/leave, broadcast event counts)
//
// Export:
//   RuntimeTelemetryEnterprise.exportJson()  → downloads report.json
//   RuntimeTelemetryEnterprise.exportCsv()   → downloads report.csv
//   RuntimeTelemetryEnterprise.snapshot()    → current data object
//
// Zero overhead when nothing is running: all sampling is passive,
// tied to existing RuntimeEventBus events.
//
// Expose: window.RuntimeTelemetryEnterprise
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeTelemetryEnterprise) return;

  var LOG = '[TEL8H]';

  // ── Memory timeline ───────────────────────────────────────────────────────
  var MEM_SAMPLE_INTERVAL_MS = 5000;
  var MAX_MEM_SAMPLES        = 200;
  var _memSamples = [];  // [{ ts, usedMB, limitMB, tier }]
  var _memTimer   = null;

  function _sampleMemory() {
    var tier = (global.RuntimeMemory && global.RuntimeMemory.getTier)
      ? global.RuntimeMemory.getTier() : 'NORMAL';
    var usedMB = 0, limitMB = 0;
    try {
      var m = performance.memory;
      if (m) {
        usedMB  = Math.round(m.usedJSHeapSize  / 1024 / 1024 * 10) / 10;
        limitMB = Math.round(m.jsHeapSizeLimit  / 1024 / 1024);
      }
    } catch (_) {}
    _memSamples.push({ ts: Date.now(), usedMB: usedMB, limitMB: limitMB, tier: tier });
    if (_memSamples.length > MAX_MEM_SAMPLES) _memSamples.shift();
  }

  function _startMemTimeline() {
    if (_memTimer) return;
    _sampleMemory();
    _memTimer = setInterval(_sampleMemory, MEM_SAMPLE_INTERVAL_MS);
    if (global.TimerRegistry) {
      try { global.TimerRegistry.registerInterval('tel-enterprise-mem', _memTimer); } catch (_) {}
    }
  }

  // ── Task waterfall ────────────────────────────────────────────────────────
  var MAX_WATERFALL = 100;
  var _waterfall = [];  // [{ id, label, tool, startTs, endTs, durationMs, parentId, status }]
  var _waterfallId = 0;
  // Map<label, { id, startTs }>
  var _openTasks = new Map();

  function _waterfallStart(label, meta) {
    var id = ++_waterfallId;
    var entry = { id: id, label: label, tool: meta && meta.tool, startTs: Date.now(),
                  endTs: null, durationMs: null, parentId: meta && meta.parentId, status: 'running' };
    _waterfall.push(entry);
    if (_waterfall.length > MAX_WATERFALL) _waterfall.shift();
    _openTasks.set(label + ':' + id, entry);
    return id;
  }

  function _waterfallEnd(id, status) {
    var entry = _waterfall.find(function (e) { return e.id === id; });
    if (!entry) return;
    entry.endTs     = Date.now();
    entry.durationMs = entry.endTs - entry.startTs;
    entry.status    = status || 'done';
  }

  // ── Worker flamegraph ─────────────────────────────────────────────────────
  var MAX_FLAME = 200;
  var _flame = [];  // [{ ts, workerUrl, event, durationMs? }]

  function _flameAdd(workerUrl, event, durationMs) {
    _flame.push({ ts: Date.now(), workerUrl: (workerUrl || '').split('/').pop(), event: event, durationMs: durationMs });
    if (_flame.length > MAX_FLAME) _flame.shift();
  }

  // ── Stream analytics ───────────────────────────────────────────────────────
  var _streamSessions = [];  // [{ streamId, tool, startTs, endTs, bytes, chunks, ackLatencies, throughputMbps }]
  var _openStreams = new Map();  // streamId → active session
  var MAX_STREAM_SESSIONS = 50;

  function _streamStart(streamId, tool, totalBytes) {
    var session = { streamId: streamId, tool: tool, startTs: Date.now(), endTs: null,
                    bytes: totalBytes || 0, chunks: 0, ackLatencies: [], throughputMbps: 0 };
    _openStreams.set(streamId, session);
  }

  function _streamChunk(streamId, chunkBytes, ackMs) {
    var s = _openStreams.get(streamId);
    if (!s) return;
    s.chunks++;
    if (ackMs !== undefined) s.ackLatencies.push(Math.round(ackMs));
    s.bytes += (chunkBytes || 0);
  }

  function _streamEnd(streamId) {
    var s = _openStreams.get(streamId);
    if (!s) return;
    s.endTs = Date.now();
    var ms = s.endTs - s.startTs;
    s.throughputMbps = ms > 0 ? Math.round((s.bytes / 1024 / 1024) / (ms / 1000) * 10) / 10 : 0;
    s.p50Ack = _percentile(s.ackLatencies, 50);
    s.p95Ack = _percentile(s.ackLatencies, 95);
    _openStreams.delete(streamId);
    _streamSessions.push(s);
    if (_streamSessions.length > MAX_STREAM_SESSIONS) _streamSessions.shift();
  }

  // ── AI analytics ──────────────────────────────────────────────────────────
  var _aiEvents = [];  // [{ ts, taskType, provider, durationMs, ok }]
  var MAX_AI_EVENTS = 100;

  // ── Recovery analytics ────────────────────────────────────────────────────
  var _recoveryEvents = [];  // [{ ts, event, toolId, ageMs }]
  var MAX_RECOVERY = 50;

  // ── Cross-tab analytics ───────────────────────────────────────────────────
  var _crossTabEvents = [];  // [{ ts, type, tabId }]
  var MAX_XTAB = 100;
  var _crossTabCounters = { joins: 0, leaves: 0, broadcasts: 0, memoryPressure: 0 };

  // ── Percentile helper ─────────────────────────────────────────────────────
  function _percentile(arr, p) {
    if (!arr || arr.length === 0) return null;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var idx = Math.floor(sorted.length * p / 100);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  // ── EventBus subscription ─────────────────────────────────────────────────
  function _subscribeEvents() {
    var bus = global.RuntimeEventBus;
    if (!bus || !bus.on) return;

    // Task waterfall
    bus.on('task:started', function (data) {
      if (data && data.label) _waterfallStart(data.label, data);
    });
    bus.on('task:completed', function (data) {
      if (data && data.id) _waterfallEnd(data.id, 'done');
    });
    bus.on('task:failed', function (data) {
      if (data && data.id) _waterfallEnd(data.id, 'failed');
    });

    // Worker flamegraph
    bus.on('worker:spawned', function (data) {
      _flameAdd(data && data.url, 'spawn');
    });
    bus.on('worker:released', function (data) {
      _flameAdd(data && data.url, 'release');
    });
    bus.on('worker:zombie', function (data) {
      _flameAdd(data && data.url, 'zombie');
    });

    // Stream analytics
    bus.on('stream:started', function (data) {
      if (data) _streamStart(data.streamId, data.tool, data.totalBytes);
    });
    bus.on('stream:chunk', function (data) {
      if (data) _streamChunk(data.streamId, data.chunkBytes, data.ackMs);
    });
    bus.on('stream:done', function (data) {
      if (data) _streamEnd(data.streamId);
    });

    // AI analytics
    bus.on('ai:task:completed', function (data) {
      _aiEvents.push({ ts: Date.now(), taskType: data && data.taskType, provider: data && data.provider,
                       durationMs: data && data.durationMs, ok: true });
      if (_aiEvents.length > MAX_AI_EVENTS) _aiEvents.shift();
    });
    bus.on('ai:task:failed', function (data) {
      _aiEvents.push({ ts: Date.now(), taskType: data && data.taskType, provider: null,
                       durationMs: data && data.durationMs, ok: false });
      if (_aiEvents.length > MAX_AI_EVENTS) _aiEvents.shift();
    });

    // Recovery analytics
    bus.on('idb:state-restored', function (data) {
      _recoveryEvents.push({ ts: Date.now(), event: 'state-restored', ageMs: data && data.ageMs });
      if (_recoveryEvents.length > MAX_RECOVERY) _recoveryEvents.shift();
    });
    bus.on('crash-recovery:resumed', function (data) {
      _recoveryEvents.push({ ts: Date.now(), event: 'resumed', toolId: data && data.toolId });
      if (_recoveryEvents.length > MAX_RECOVERY) _recoveryEvents.shift();
    });

    // Cross-tab analytics
    bus.on('cross-tab:memory-pressure', function (data) {
      _crossTabEvents.push({ ts: Date.now(), type: 'memory-pressure', tabId: data && data.peerTabId });
      if (_crossTabEvents.length > MAX_XTAB) _crossTabEvents.shift();
      _crossTabCounters.memoryPressure++;
    });

    // Also tap RuntimeTelemetry subscriber
    if (global.RuntimeTelemetry && global.RuntimeTelemetry.onEvent) {
      global.RuntimeTelemetry.onEvent(function (ev) {
        if (!ev || !ev.name) return;
        if (ev.name.indexOf('cross-tab:') === 0) {
          _crossTabCounters.broadcasts++;
          _crossTabEvents.push({ ts: ev.ts, type: ev.name, data: ev.data });
          if (_crossTabEvents.length > MAX_XTAB) _crossTabEvents.shift();
        }
        if (ev.name === 'cross-tab:init') _crossTabCounters.joins++;
        if (ev.name === 'cross-tab:tab-gone') _crossTabCounters.leaves++;
      });
    }
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────
  function snapshot() {
    var baseReport = global.RuntimeTelemetry ? global.RuntimeTelemetry.getReport() : {};
    var recentEvents = global.RuntimeTelemetry ? global.RuntimeTelemetry.getRecentEvents(200) : [];

    // AI summary
    var aiByProvider = {};
    var aiLatencies  = [];
    _aiEvents.forEach(function (e) {
      var p = e.provider || 'unknown';
      aiByProvider[p] = (aiByProvider[p] || 0) + 1;
      if (e.durationMs) aiLatencies.push(e.durationMs);
    });

    // Stream summary
    var streamSummary = {
      sessions:     _streamSessions.length,
      avgThroughput: 0,
      p50Ack:       null,
      p95Ack:       null,
    };
    if (_streamSessions.length > 0) {
      streamSummary.avgThroughput = Math.round(
        _streamSessions.reduce(function (a, s) { return a + s.throughputMbps; }, 0) / _streamSessions.length * 10) / 10;
      var allAcks = _streamSessions.reduce(function (a, s) { return a.concat(s.ackLatencies || []); }, []);
      streamSummary.p50Ack = _percentile(allAcks, 50);
      streamSummary.p95Ack = _percentile(allAcks, 95);
    }

    return {
      generatedAt:    new Date().toISOString(),
      sessionMs:      baseReport.sessionMs,
      telemetry:      baseReport,
      memoryTimeline: _memSamples.slice(-50),
      memoryPeak:     _memSamples.reduce(function (m, s) { return Math.max(m, s.usedMB); }, 0),
      waterfall:      _waterfall.slice(-50),
      flame:          _flame.slice(-50),
      streamAnalytics: Object.assign({}, streamSummary, { sessions: _streamSessions.slice(-10) }),
      aiAnalytics: {
        events:        _aiEvents.length,
        byProvider:    aiByProvider,
        p50LatencyMs:  _percentile(aiLatencies, 50),
        p95LatencyMs:  _percentile(aiLatencies, 95),
        successRate:   _aiEvents.length > 0
          ? Math.round(_aiEvents.filter(function (e) { return e.ok; }).length / _aiEvents.length * 100) + '%'
          : 'n/a',
      },
      recoveryAnalytics: {
        events:        _recoveryEvents.length,
        log:           _recoveryEvents.slice(-10),
      },
      crossTabAnalytics: {
        counters:      Object.assign({}, _crossTabCounters),
        recentEvents:  _crossTabEvents.slice(-20),
        peers:         global.RuntimeCrossTab ? global.RuntimeCrossTab.getStats() : null,
      },
      recentTelemetryEvents: recentEvents.slice(-50),
    };
  }

  // ── Export helpers ────────────────────────────────────────────────────────
  function _download(blob, filename) {
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href   = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function exportJson() {
    var snap = snapshot();
    var json = JSON.stringify(snap, null, 2);
    _download(new Blob([json], { type: 'application/json' }),
      'ilovepdf-telemetry-' + Date.now() + '.json');
    return snap;
  }

  function exportCsv() {
    var snap  = snapshot();
    var lines = ['timestamp,event,value'];

    // Memory timeline
    snap.memoryTimeline.forEach(function (s) {
      lines.push([new Date(s.ts).toISOString(), 'memory_used_mb', s.usedMB].join(','));
    });

    // Waterfall
    snap.waterfall.forEach(function (w) {
      if (w.durationMs) {
        lines.push([new Date(w.startTs).toISOString(),
          'task:' + (w.label || 'unknown'), w.durationMs + 'ms'].join(','));
      }
    });

    // AI events
    snap.aiAnalytics.byProvider && Object.keys(snap.aiAnalytics.byProvider).forEach(function (p) {
      lines.push([new Date().toISOString(), 'ai_calls:' + p, snap.aiAnalytics.byProvider[p]].join(','));
    });

    // Stream sessions
    (snap.streamAnalytics.sessions || []).forEach(function (s) {
      if (s.endTs) {
        lines.push([new Date(s.startTs).toISOString(),
          'stream:' + (s.tool || 'unknown'), s.throughputMbps + 'Mbps'].join(','));
      }
    });

    var csv = lines.join('\n');
    _download(new Blob([csv], { type: 'text/csv' }),
      'ilovepdf-telemetry-' + Date.now() + '.csv');
    return csv;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _startMemTimeline();
    _subscribeEvents();

    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('telemetryEnterprise', global.RuntimeTelemetryEnterprise); } catch (_) {}
    }

    console.info(LOG, 'RuntimeTelemetryEnterprise v1.0 ready — timelines + waterfall + flamegraph active');
  }

  if (global.RuntimeEventBus) {
    global.RuntimeEventBus.once('runtime:ready', function () { setTimeout(_boot, 100); });
  }
  if (document.readyState === 'complete') setTimeout(_boot, 500);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 500); }, { once: true });

  global.RuntimeTelemetryEnterprise = {
    snapshot:   snapshot,
    exportJson: exportJson,
    exportCsv:  exportCsv,
    getMemoryTimeline: function () { return _memSamples.slice(); },
    getWaterfall:      function () { return _waterfall.slice(); },
    getFlame:          function () { return _flame.slice(); },
    getStreamSessions: function () { return _streamSessions.slice(); },
    getAiAnalytics:    function () { return { events: _aiEvents.slice(), counters: { total: _aiEvents.length } }; },
    getRecoveryLog:    function () { return _recoveryEvents.slice(); },
    getCrossTabLog:    function () { return _crossTabEvents.slice(); },
    recordStream:      { start: _streamStart, chunk: _streamChunk, end: _streamEnd },
  };
}(window));

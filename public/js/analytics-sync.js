// analytics-sync.js — Phase 6.3: Analytics Sync Layer
// =====================================================================
// Provider-agnostic analytics sync layer. Sits between AnalyticsEngine
// and any future analytics backend (Firebase, Cloudflare, GA4, Clarity,
// self-hosted). In this phase: NO network calls. Everything is queued,
// batched, and exported locally. Activating a provider requires only
// implementing its adapter — zero changes to this file or AnalyticsEngine.
//
// ADDITIVE ONLY. Never modifies:
//   AnalyticsEngine, BrowserTools, Workers, Security, RuntimeLoader,
//   RuntimeSessionIntel, RuntimeToolEngagement, RuntimeAnalytics,
//   AdManager, Firebase auth, Upload flow, Download flow
//
// Storage keys (NEW — never conflict with existing analytics keys):
//   'ilpdf_sync_v1'    — event queue (persisted on pagehide)
//   'ilpdf_batches_v1' — completed/pending batches
//   'ilpdf_retry_v1'   — dead-letter queue + retry stats
//
// Existing keys this module READS:
//   none (backfill reads AnalyticsEngine.export() which reads LS internally)
//
// Performance contract:
//   • Boot deferred via requestIdleCallback (3s timeout fallback)
//   • Zero blocking on first paint, upload, preview, download, processing
//   • Batch building uses setInterval (idle-friendly, no RAF)
//   • All localStorage writes happen on pagehide/visibilitychange only
//   • In-memory operations only during active session
//
// window.AnalyticsSync API:
//   .ingest(event, data?, ts?) — manually ingest an event
//   .flush()                   — force batch-build + persist all state
//   .export()                  — download queue + stats as JSON blob
//   .exportNDJSON()            — download queue as newline-delimited JSON
//   .compressedPayload()       — return compact summary object (no download)
//   .debug()                   — return full internal state (queue/batches/providers/stats)
//   .getQueue()                — return copy of current event queue
//   .getStats()                — return current stats snapshot
//   .config()                  — return current configuration
//   .providers                 — frozen map of all 5 provider adapter stubs
//
// Provider interface (all disabled — no network calls):
//   { connect(), disconnect(), send(batch), flush(), status() }
//
// Future activation path (Phase 6.4+):
//   Replace the provider stub's send() with a real fetch() call and set
//   provider.enabled = true. AnalyticsSync will route batches to it
//   automatically. Zero changes to AnalyticsEngine or any other module.
// =====================================================================
(function (G) {
  'use strict';

  if (G.AnalyticsSync) return;

  // ── Crawler suppression ───────────────────────────────────────────────────
  var CRAWLER_RE = /googlebot|bingbot|slurp|duckduckbot|baidu|yandexbot|sogou|exabot|ia_archiver|facebot|twitterbot|linkedinbot|semrush|ahrefs|bot|crawler|spider|scraper/i;
  if (CRAWLER_RE.test(navigator.userAgent || '')) return;

  var LOG = '[AS]';

  // ── Configuration ─────────────────────────────────────────────────────────
  var CFG = {
    MAX_QUEUE:          200,    // max events held in queue (oldest dropped when full)
    MAX_BATCHES:        20,     // max completed batches stored in localStorage
    MAX_DLQ:            50,     // max dead-letter queue entries
    BATCH_SIZE:         10,     // events per batch
    BATCH_INTERVAL_MS:  30000,  // 30 s auto-flush interval
    MAX_RETRIES:        5,      // max retry attempts per batch before DLQ
    DEDUP_WINDOW_MS:    200,    // events with same name in same 200 ms window = duplicate
    BACKFILL_EVENTS:    20,     // recent AE events to ingest on boot (one-time)
  };

  // ── New localStorage keys (never overlap existing analytics keys) ──────────
  var KEY_QUEUE   = 'ilpdf_sync_v1';
  var KEY_BATCHES = 'ilpdf_batches_v1';
  var KEY_RETRY   = 'ilpdf_retry_v1';

  // ── Safe helpers ───────────────────────────────────────────────────────────
  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }
  function _lsGet(k)   { return _s(function () { return JSON.parse(localStorage.getItem(k)); }); }
  function _lsSet(k,v) { _s(function () { localStorage.setItem(k, JSON.stringify(v)); }); }
  function _uid()      { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function _dateStr()  { return new Date().toISOString().slice(0, 10); }

  // ── Session ID — reuse AE's session if available ──────────────────────────
  function _sessionId() {
    if (G.AnalyticsEngine) {
      return _s(function () { return G.AnalyticsEngine.getSessionSummary().sessionId; }) || _uid();
    }
    return _uid();
  }
  var _sid = null; // cached on first call after boot

  // ── In-memory state ────────────────────────────────────────────────────────
  var _queue      = [];  // [{id, event, ts, sessionId, data, priority, batchId, retryCount, enqueuedAt}]
  var _batches    = [];  // [{id, events:[], eventCount, createdAt, status, avgProcessTimeMs}]
  var _dlq        = [];  // [{event, movedAt, reason}]
  var _dedupCache = {};  // {key: true} — pruned when > 500 entries
  var _stats = {
    totalEnqueued:  0,
    totalDropped:   0,
    totalBatched:   0,
    totalRetried:   0,
    lastFlushAt:    null,
    lastBatchAt:    null,
    batchTimes:     [],  // last 10 batch processing times in ms (for avg)
  };
  var _booted = false;

  // ── Load persisted queue ───────────────────────────────────────────────────
  function _loadQueue() {
    var raw = _lsGet(KEY_QUEUE);
    if (raw && raw.v === 1 && Array.isArray(raw.events)) {
      _queue = raw.events.slice(0, CFG.MAX_QUEUE);
      _stats.totalEnqueued = raw.totalEnqueued || 0;
      _stats.totalDropped  = raw.droppedCount  || 0;
    }
  }

  function _loadBatches() {
    var raw = _lsGet(KEY_BATCHES);
    if (raw && raw.v === 1 && Array.isArray(raw.batches)) {
      _batches = raw.batches.slice(0, CFG.MAX_BATCHES);
      if (_batches.length) {
        _stats.lastBatchAt = _batches[_batches.length - 1].createdAt || null;
      }
    }
  }

  function _loadRetry() {
    var raw = _lsGet(KEY_RETRY);
    if (raw && raw.v === 1) {
      _dlq                = (Array.isArray(raw.dlq) ? raw.dlq : []).slice(0, CFG.MAX_DLQ);
      _stats.totalRetried = (raw.stats && raw.stats.totalRetried) || 0;
    }
  }

  // ── Persist state ──────────────────────────────────────────────────────────
  function _persistQueue() {
    _lsSet(KEY_QUEUE, {
      v:             1,
      events:        _queue,
      droppedCount:  _stats.totalDropped,
      totalEnqueued: _stats.totalEnqueued,
      savedAt:       Date.now(),
    });
  }

  function _persistBatches() {
    _lsSet(KEY_BATCHES, {
      v:       1,
      batches: _batches.slice(-CFG.MAX_BATCHES),
      savedAt: Date.now(),
    });
  }

  function _persistRetry() {
    _lsSet(KEY_RETRY, {
      v:   1,
      dlq: _dlq.slice(-CFG.MAX_DLQ),
      stats: {
        totalRetried: _stats.totalRetried,
        totalDropped: _stats.totalDropped,
        lastRetryAt:  _stats.lastFlushAt,
      },
      savedAt: Date.now(),
    });
  }

  // ── Deduplication ──────────────────────────────────────────────────────────
  function _dedupeKey(event, ts) {
    // Same event name within the same DEDUP_WINDOW_MS slot = duplicate
    return event + ':' + Math.floor((ts || Date.now()) / CFG.DEDUP_WINDOW_MS);
  }

  function _isDuplicate(event, ts) {
    var key = _dedupeKey(event, ts);
    if (_dedupCache[key]) return true;
    _dedupCache[key] = true;
    // Prune oldest half when cache grows large
    var keys = Object.keys(_dedupCache);
    if (keys.length > 500) {
      keys.slice(0, 250).forEach(function (k) { delete _dedupCache[k]; });
    }
    return false;
  }

  // ── Priority assignment ────────────────────────────────────────────────────
  var _HIGH_PRIORITY   = ['SESSION_STARTED', 'SESSION_ENDED'];
  var _MEDIUM_PRIORITY = ['TOOL_COMPLETED', 'FILE_UPLOAD'];

  function _priority(event) {
    if (_HIGH_PRIORITY.indexOf(event) !== -1)   return 2;
    if (_MEDIUM_PRIORITY.indexOf(event) !== -1) return 1;
    return 0;
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────
  function _enqueue(event, data, ts) {
    ts = ts || Date.now();
    if (_isDuplicate(event, ts)) return;

    if (!_sid) _sid = _sessionId();

    var entry = {
      id:         _uid(),
      event:      event,
      ts:         ts,
      sessionId:  _sid,
      data:       data || null,
      priority:   _priority(event),
      batchId:    null,
      retryCount: 0,
      enqueuedAt: Date.now(),
    };

    _queue.push(entry);
    _stats.totalEnqueued++;

    // Enforce max: FIFO — drop oldest when over limit
    if (_queue.length > CFG.MAX_QUEUE) {
      _queue.shift();
      _stats.totalDropped++;
    }

    // Auto-build batch when BATCH_SIZE unbatched events accumulate
    var unbatched = _queue.filter(function (e) { return !e.batchId; });
    if (unbatched.length >= CFG.BATCH_SIZE) {
      _buildBatch();
    }
  }

  // ── Public ingest ──────────────────────────────────────────────────────────
  function ingest(event, data, ts) {
    if (!event || typeof event !== 'string') return;
    _enqueue(event, data, ts);
  }

  // ── Batch builder ──────────────────────────────────────────────────────────
  function _buildBatch() {
    var unbatched = _queue.filter(function (e) { return !e.batchId; });
    if (!unbatched.length) return;

    var batchEvents = unbatched.slice(0, CFG.BATCH_SIZE);
    var batchId     = 'batch-' + _uid();
    var startTs     = Date.now();

    batchEvents.forEach(function (e) { e.batchId = batchId; });

    var batch = {
      id:               batchId,
      eventIds:         batchEvents.map(function (e) { return e.id; }),
      eventCount:       batchEvents.length,
      createdAt:        Date.now(),
      status:           'pending',
      avgProcessTimeMs: 0,
    };

    _batches.push(batch);
    if (_batches.length > CFG.MAX_BATCHES) _batches.shift();

    _stats.totalBatched += batchEvents.length;
    _stats.lastBatchAt   = batch.createdAt;

    _simulateSend(batch, batchEvents, startTs);
  }

  // ── Simulate send — no network; console.debug + local state only ──────────
  function _simulateSend(batch, events, startTs) {
    var elapsed = Date.now() - startTs;
    batch.status           = 'simulated';
    batch.avgProcessTimeMs = elapsed;

    _stats.batchTimes.push(elapsed);
    if (_stats.batchTimes.length > 10) _stats.batchTimes.shift();
    _stats.lastFlushAt = Date.now();

    console.debug(LOG, 'Batch ' + batch.id + ' — ' + events.length + ' events — ' + elapsed + 'ms — no provider enabled (Phase 6.3 simulation)');
  }

  // ── Provider adapter stubs (5 providers — all disabled, no network calls) ──
  // To activate a provider in Phase 6.4+:
  //   1. Replace its send() with a real fetch() call
  //   2. Set provider.enabled = true
  //   No changes needed anywhere else.
  var _PROVIDERS = (function () {
    function _stub(id, name) {
      return {
        id:         id,
        name:       name,
        enabled:    false,
        connected:  false,
        connect:    function () {},
        disconnect: function () {},
        send:       function () { return Promise.resolve({ ok: false, reason: 'disabled' }); },
        flush:      function () {},
        status:     function () { return { id: id, name: name, enabled: false, connected: false }; },
      };
    }
    return {
      firebase:    _stub('firebase',    'Firebase Analytics'),
      cloudflare:  _stub('cloudflare',  'Cloudflare Worker'),
      ga4:         _stub('ga4',         'Google Analytics 4'),
      clarity:     _stub('clarity',     'Microsoft Clarity'),
      selfhosted:  _stub('selfhosted',  'Self-hosted Endpoint'),
    };
  }());

  // ── Retry engine ───────────────────────────────────────────────────────────
  // Simulated in Phase 6.3. Full retry activates when a real provider is wired.
  // Backoff: 2^n seconds (n = retryCount), max 32 s.
  function _retryBatch(batchId) {
    var batch = null;
    for (var i = 0; i < _batches.length; i++) {
      if (_batches[i].id === batchId) { batch = _batches[i]; break; }
    }
    if (!batch) return;

    var batchEvents = _queue.filter(function (e) { return e.batchId === batchId; });
    batchEvents.forEach(function (e) {
      e.retryCount++;
      if (e.retryCount >= CFG.MAX_RETRIES) {
        _dlq.push({ event: e, movedAt: Date.now(), reason: 'max_retries_exceeded' });
        if (_dlq.length > CFG.MAX_DLQ) _dlq.shift();
        _stats.totalDropped++;
      }
    });

    _stats.totalRetried++;
    var delay = Math.min(Math.pow(2, Math.min((batchEvents[0] && batchEvents[0].retryCount) || 1, 5)) * 1000, 32000);
    console.debug(LOG, 'Retry scheduled — batch:', batchId, 'delay:', delay + 'ms (simulation)');
  }

  // ── Flush ──────────────────────────────────────────────────────────────────
  function flush() {
    _buildBatch();
    _persistQueue();
    _persistBatches();
    _persistRetry();
    console.debug(LOG, 'Flush — queue:', _queue.length, '| batches:', _batches.length, '| DLQ:', _dlq.length);
  }

  // ── Ingestion: DOM event listeners (same events as AnalyticsEngine) ───────
  function _wireDOMListeners() {
    // ilpdf:step → FILE_UPLOAD, PREVIEW_REACHED, DOWNLOAD_REACHED
    var _stepMap = { upload: 'FILE_UPLOAD', preview: 'PREVIEW_REACHED', download: 'DOWNLOAD_REACHED' };
    G.addEventListener('ilpdf:step', function (e) {
      var step = e && e.detail && e.detail.step;
      var evt  = step && _stepMap[step];
      if (evt) _enqueue(evt, { source: 'ilpdf:step', step: step });
    }, { passive: true });

    // download:triggered → TOOL_COMPLETED
    document.addEventListener('download:triggered', function (e) {
      var slug = e && e.detail && e.detail.slug;
      _enqueue('TOOL_COMPLETED', { slug: slug || null, source: 'download:triggered' });
    }, { passive: true });

    // PAGE_VIEW + TOOL_OPEN on load
    var path = _s(function () { return G.location.pathname; }, '/');
    _enqueue('PAGE_VIEW', { path: path });
    var slug = _s(function () {
      var p = path.replace(/^\//, '').split('/')[0];
      return (p && p !== '' && p !== 'index.html') ? p : null;
    });
    if (slug) _enqueue('TOOL_OPEN', { slug: slug, path: path });

    // Flush on session end
    G.addEventListener('pagehide',        flush, { passive: true });
    G.addEventListener('beforeunload',    flush);
    G.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    }, { passive: true });
  }

  // ── One-time backfill from AnalyticsEngine ────────────────────────────────
  // Reads AE's recent event log (already in memory) to seed the sync queue.
  // Only done once on boot; subsequent events arrive via DOM listeners.
  function _backfillFromAE() {
    if (!G.AnalyticsEngine) return;
    _s(function () {
      var exported = G.AnalyticsEngine.export();
      var recent   = (exported && Array.isArray(exported.recentEvents)) ? exported.recentEvents : [];
      var toIngest = recent.slice(-CFG.BACKFILL_EVENTS);
      toIngest.forEach(function (e) { _enqueue(e.event, e.data, e.ts); });
      if (toIngest.length) {
        console.debug(LOG, 'Backfilled', toIngest.length, 'events from AnalyticsEngine');
      }
    });
  }

  // ── SESSION_STARTED / SESSION_ENDED tracking ──────────────────────────────
  function _trackSessionLifecycle() {
    _enqueue('SESSION_STARTED', { source: 'analytics-sync', bootTs: Date.now() });
    G.addEventListener('pagehide', function () {
      _enqueue('SESSION_ENDED', { source: 'analytics-sync', endTs: Date.now() });
    }, { passive: true, once: true });
  }

  // ── Periodic batch interval ────────────────────────────────────────────────
  function _startBatchInterval() {
    setInterval(function () {
      var pending = _queue.filter(function (e) { return !e.batchId; });
      if (pending.length) _buildBatch();
    }, CFG.BATCH_INTERVAL_MS);
  }

  // ── Export: JSON blob download ─────────────────────────────────────────────
  function exportJSON() {
    var payload = {
      exportedAt:   new Date().toISOString(),
      config:       CFG,
      queue:        _queue,
      batches:      _batches,
      dlq:          _dlq,
      stats:        getStats(),
      providers:    Object.keys(_PROVIDERS).map(function (k) { return _PROVIDERS[k].status(); }),
    };
    _blob(JSON.stringify(payload, null, 2), 'ilpdf-sync-' + _dateStr() + '.json', 'application/json');
    return payload;
  }

  // ── Export: NDJSON blob download ───────────────────────────────────────────
  function exportNDJSON() {
    var lines = _queue.map(function (e) { return JSON.stringify(e); }).join('\n');
    _blob(lines || '{}', 'ilpdf-sync-' + _dateStr() + '.ndjson', 'application/x-ndjson');
    return _queue.length;
  }

  // ── Compressed payload (no download — returns compact summary object) ──────
  // Groups events by type into a compact key-value map. No external lib.
  function compressedPayload() {
    var _ABV = {
      PAGE_VIEW:           'PV',  TOOL_OPEN:          'TO',
      FILE_UPLOAD:         'FU',  PREVIEW_REACHED:    'PR',
      DOWNLOAD_REACHED:    'DR',  TOOL_COMPLETED:     'TC',
      SESSION_STARTED:     'SS',  SESSION_ENDED:      'SE',
      RETURN_VISIT:        'RV',  AD_SLOT_VIEWABLE:   'AV',
      UPLOAD_AD_VISIBLE:   'UA',  PREVIEW_AD_VISIBLE: 'PA',
      DOWNLOAD_AD_VISIBLE: 'DA',  MOBILE_STICKY_VISIBLE: 'MS',
    };
    var byType = {};
    _queue.forEach(function (e) { byType[e.event] = (byType[e.event] || 0) + 1; });
    var compact = Object.keys(byType).map(function (k) {
      return (_ABV[k] || k.slice(0, 3)) + ':' + byType[k];
    }).join(',');
    return {
      v:         1,
      ts:        Date.now(),
      queueSize: _queue.length,
      summary:   byType,
      compact:   compact || '(empty)',
      batches:   _batches.length,
      dlq:       _dlq.length,
    };
  }

  // ── Getters ────────────────────────────────────────────────────────────────
  function getQueue() { return _queue.slice(); }

  function getStats() {
    var pending  = _queue.filter(function (e) { return !e.batchId; }).length;
    var avgBatch = 0;
    if (_stats.batchTimes.length) {
      avgBatch = Math.round(_stats.batchTimes.reduce(function (a, b) { return a + b; }, 0) / _stats.batchTimes.length);
    }
    return {
      queueSize:          _queue.length,
      pendingEvents:      pending,
      batchCount:         _batches.length,
      dlqSize:            _dlq.length,
      totalEnqueued:      _stats.totalEnqueued,
      totalDropped:       _stats.totalDropped,
      totalBatched:       _stats.totalBatched,
      totalRetried:       _stats.totalRetried,
      avgBatchTimeMs:     avgBatch,
      providersEnabled:   0,
      providersConnected: 0,
      syncStatus:         _queue.length ? 'active' : 'idle',
      lastFlushAt:        _stats.lastFlushAt ? new Date(_stats.lastFlushAt).toISOString() : null,
      lastBatchAt:        _stats.lastBatchAt ? new Date(_stats.lastBatchAt).toISOString() : null,
    };
  }

  function getConfig() { return Object.assign({}, CFG); }

  // ── Debug ──────────────────────────────────────────────────────────────────
  function debug() {
    var memEst = _s(function () {
      var qSize = JSON.stringify(_queue).length;
      var bSize = JSON.stringify(_batches).length;
      var dSize = JSON.stringify(_dlq).length;
      return { queueBytes: qSize, batchBytes: bSize, dlqBytes: dSize, totalKB: Math.round((qSize + bSize + dSize) / 102.4) / 10 };
    }, { queueBytes: 0, batchBytes: 0, dlqBytes: 0, totalKB: 0 });

    return {
      queue:    _queue.slice(),
      batches:  _batches.slice(),
      dlq:      _dlq.slice(),
      providers: Object.keys(_PROVIDERS).map(function (k) { return _PROVIDERS[k].status(); }),
      stats:    getStats(),
      config:   getConfig(),
      memory:   memEst,
      retryState: {
        dlqSize:    _dlq.length,
        totalRetried: _stats.totalRetried,
        maxRetries:   CFG.MAX_RETRIES,
        backoffFormula: '2^n seconds (n = retryCount, max 32 s)',
      },
      storageKeys: { queue: KEY_QUEUE, batches: KEY_BATCHES, retry: KEY_RETRY },
    };
  }

  // ── Blob download helper ───────────────────────────────────────────────────
  function _blob(content, filename, mime) {
    _s(function () {
      var b = new Blob([content], { type: mime });
      var u = URL.createObjectURL(b);
      var a = document.createElement('a');
      a.href = u; a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(u); }, 1000);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (_booted) return;
    _booted = true;

    _sid = _sessionId(); // cache session ID once

    _loadQueue();
    _loadBatches();
    _loadRetry();

    _wireDOMListeners();
    _backfillFromAE();
    _trackSessionLifecycle();
    _startBatchInterval();

    console.debug(LOG, 'AnalyticsSync v1.0 ready — queue:', _queue.length, '| batches:', _batches.length, '| DLQ:', _dlq.length, '| providers: 0 enabled');
  }

  // ── Deferred boot via requestIdleCallback ─────────────────────────────────
  function _deferredBoot() {
    if (G.requestIdleCallback) {
      G.requestIdleCallback(_boot, { timeout: 3000 });
    } else {
      setTimeout(_boot, 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _deferredBoot, { once: true });
  } else {
    _deferredBoot();
  }

  // ── Expose frozen API ─────────────────────────────────────────────────────
  G.AnalyticsSync = Object.freeze({
    ingest:            ingest,
    flush:             flush,
    export:            exportJSON,
    exportNDJSON:      exportNDJSON,
    compressedPayload: compressedPayload,
    debug:             debug,
    getQueue:          getQueue,
    getStats:          getStats,
    config:            getConfig,
    providers: Object.freeze({
      firebase:   Object.freeze(_PROVIDERS.firebase),
      cloudflare: Object.freeze(_PROVIDERS.cloudflare),
      ga4:        Object.freeze(_PROVIDERS.ga4),
      clarity:    Object.freeze(_PROVIDERS.clarity),
      selfhosted: Object.freeze(_PROVIDERS.selfhosted),
    }),
  });

}(window));

// RuntimeIDBCoalescer v1.0 — Phase 7F
// =====================================================================
// IDB Write Coalescing Layer — eliminates write storms to IndexedDB.
//
// Problem:  RuntimeIDB.archiveHealth() fires on every RuntimeHealth tick
//           (every 30 s) and every health-change event (can be rapid-fire
//           during memory pressure). Each call opens a transaction, does
//           a _put(), then scans all records for a rolling trim. At scale
//           this creates: IDB lock contention, WAL pressure, and battery drain.
//
// Solution: A WAL-style pending queue with two flush policies:
//
//   TELEMETRY / HEALTH  (importance: 'background'):
//     • Max 1 write per COALESCE_INTERVAL_MS  (default 10 s)
//     • Duplicate keys are collapsed — only the newest value is written
//     • Queue drains on idle (requestIdleCallback or setTimeout fallback)
//
//   CRASH CHECKPOINT    (importance: 'critical'):
//     • Immediate flush (bypasses debounce, written synchronously-ish)
//     • Always the latest value; cancels any pending queue item for same key
//
//   STATE PERSISTENCE   (importance: 'normal'):
//     • Debounced 3 s — multiple rapid updates coalesce to single write
//
// API: window.RuntimeIDBCoalescer
//   .schedule(store, record, opts)   → void  (queue a write)
//   .flush()                         → Promise  (drain queue immediately)
//   .getStats()                      → { pending, flushed, collapsed, immediate }
//
// opts: { importance: 'critical'|'normal'|'background', key: string }
//   importance defaults to 'normal'
//   key is used for deduplication (same key → newer value wins)
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeIDBCoalescer) return;

  var LOG = '[RIDB-C]';

  // Flush intervals by importance tier
  var INTERVALS = {
    background: 10000,  // 10 s — health/telemetry archives
    normal:      3000,  //  3 s — state persistence
    critical:       0,  //  0 ms — crash checkpoints, immediate
  };

  // ── Queue ──────────────────────────────────────────────────────────────────
  // Map<store+key → { store, record, importance, ts, flushAfter }>
  var _queue    = new Map();
  var _timers   = {};  // store → timer handle
  var _flushPromise = null;

  // ── Stats ──────────────────────────────────────────────────────────────────
  var _stats = { pending: 0, flushed: 0, collapsed: 0, immediate: 0 };

  // ── Flush executor: calls RuntimeIDB directly ──────────────────────────────
  // Store name → method mapping uses the real IDB store constants from runtime-idb.js:
  //   'checkpoints'       → saveCheckpoint()
  //   'health_history'    → _archiveHealthDirect() (includes rolling trim)
  //   'runtime_state'     → persistState()
  //   everything else     → _putDirect(store, record) generic write
  function _doFlush(entries) {
    if (!entries || entries.length === 0) return Promise.resolve();
    if (!global.RuntimeIDB) return Promise.resolve();

    var promises = entries.map(function (entry) {
      try {
        if (entry.store === 'health_history') {
          // Use the direct internal archiver which includes rolling trim (max 20 records)
          return global.RuntimeIDB._archiveHealthDirect
            ? global.RuntimeIDB._archiveHealthDirect(entry.record)
            : (global.RuntimeIDB._putDirect
                ? global.RuntimeIDB._putDirect(entry.store, entry.record)
                : Promise.resolve());
        }
        if (entry.store === 'checkpoints') {
          return global.RuntimeIDB.saveCheckpoint
            ? Promise.resolve(global.RuntimeIDB.saveCheckpoint(entry.record))
            : Promise.resolve();
        }
        if (entry.store === 'runtime_state') {
          return global.RuntimeIDB.persistState
            ? Promise.resolve(global.RuntimeIDB.persistState())
            : Promise.resolve();
        }
        // Generic path: raw IDB put (for telemetry_summary or future stores)
        if (global.RuntimeIDB._putDirect) {
          return global.RuntimeIDB._putDirect(entry.store, entry.record);
        }
      } catch (_) {}
      return Promise.resolve();
    });

    return Promise.all(promises).then(function () {
      _stats.flushed += entries.length;
    }).catch(function () {});
  }

  // ── Drain a single importance tier from the queue ──────────────────────────
  function _drain(importance) {
    var toFlush = [];
    _queue.forEach(function (entry, qkey) {
      if (entry.importance === importance) {
        toFlush.push(entry);
        _queue.delete(qkey);
        _stats.pending = Math.max(0, _stats.pending - 1);
      }
    });
    if (toFlush.length === 0) return Promise.resolve();
    return _doFlush(toFlush);
  }

  // ── Schedule a deferred drain via idle callback ────────────────────────────
  function _scheduleDrain(importance, delayMs) {
    if (_timers[importance]) {
      clearTimeout(_timers[importance]);
      _timers[importance] = null;
    }
    if (delayMs <= 0) {
      // Immediate — drain synchronously in next microtask
      Promise.resolve().then(function () { return _drain(importance); });
      return;
    }

    _timers[importance] = setTimeout(function () {
      _timers[importance] = null;
      if (global.requestIdleCallback) {
        global.requestIdleCallback(function () { _drain(importance); }, { timeout: delayMs * 2 });
      } else {
        _drain(importance);
      }
    }, delayMs);
  }

  // ── PUBLIC: schedule ───────────────────────────────────────────────────────
  // store:      IDB store name ('checkpoints', 'health', 'state', 'telemetry')
  // record:     object to persist (must be JSON-serialisable)
  // opts.importance: 'critical' | 'normal' | 'background'
  // opts.key:   dedup key within this store (defaults to store + JSON.stringify(record.key || record.toolId || record.ts))
  function schedule(store, record, opts) {
    opts       = opts || {};
    var importance = opts.importance || 'normal';
    var dedupKey   = store + ':' + (opts.key || record.key || record.toolId || record.ts || Math.random());

    // Collapse: newer value overwrites pending older value for same key
    if (_queue.has(dedupKey)) {
      _stats.collapsed++;
    } else {
      _stats.pending++;
    }

    var delay = INTERVALS[importance] != null ? INTERVALS[importance] : INTERVALS.normal;

    _queue.set(dedupKey, {
      store:      store,
      record:     record,
      importance: importance,
      ts:         Date.now(),
      flushAfter: Date.now() + delay,
    });

    if (importance === 'critical') {
      // Immediate flush, bypasses all debounce
      _stats.immediate++;
      _scheduleDrain('critical', 0);
    } else {
      _scheduleDrain(importance, delay);
    }
  }

  // ── PUBLIC: flush ──────────────────────────────────────────────────────────
  // Drain ALL pending entries regardless of their flush time.
  function flush() {
    if (_flushPromise) return _flushPromise;
    var toFlush = [];
    _queue.forEach(function (entry, qkey) {
      toFlush.push(entry);
      _queue.delete(qkey);
    });
    _stats.pending = 0;
    _flushPromise  = _doFlush(toFlush).then(function () {
      _flushPromise = null;
    });
    return _flushPromise;
  }

  // ── PUBLIC: getStats ───────────────────────────────────────────────────────
  function getStats() {
    return Object.assign({}, _stats, { pending: _queue.size });
  }

  // ── Flush on pagehide to avoid losing pending writes ──────────────────────
  global.addEventListener('pagehide', function () {
    // Synchronous best-effort: start the flush but cannot await in pagehide
    flush().catch(function () {});
  }, { passive: true });

  global.RuntimeIDBCoalescer = {
    schedule: schedule,
    flush:    flush,
    getStats: getStats,
  };

  console.info(LOG, 'RuntimeIDBCoalescer v1.0 ready — intervals: background=10s normal=3s critical=0ms');
}(window));

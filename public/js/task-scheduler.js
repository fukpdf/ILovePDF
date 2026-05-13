// Task Scheduler — global slot-based concurrency control for heavy operations.
// Prevents task storms when PDF rendering, AI inference, and OCR overlap.
//
// Slot tiers:
//   RENDER     — PDF rendering, thumbnail generation
//   AI         — ONNX inference, background removal
//   BACKGROUND — cleanup, cache warming, indexing
//
// Mobile: 1 slot per tier (half of desktop).
// MemPressure-adaptive: effective limits shrink automatically under memory stress.
// Pause/resume: integrates with LifecycleManager (tab hide / freeze).
//
// API (window.TaskScheduler):
//   acquireSlot(tier)          → Promise (resolves when a slot is available)
//   releaseSlot(tier)          → void
//   schedule(fn, tier)         → Promise<result> (acquire → run → release)
//   pause() / resume()
//   cancelQueued(tier)         → number of cancelled waiters
//   stats()                    → per-tier { active, queued, limit }
(function () {
  'use strict';

  var _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  var _BASE = {
    RENDER:     _isMobile ? 1 : 2,
    AI:         _isMobile ? 1 : 2,
    BACKGROUND: 1,
  };

  // Each slot: { active, queue: [resolveFn, ...], baseLimit }
  var _slots = {};
  Object.keys(_BASE).forEach(function (tier) {
    _slots[tier] = { active: 0, queue: [], baseLimit: _BASE[tier] };
  });

  var _paused = false;

  // Effective limit shrinks under memory pressure
  function _effectiveLimit(tier) {
    var base = (_slots[tier] || {}).baseLimit || 1;
    if (!window.MemPressure) return base;
    var t = window.MemPressure.tier();
    if (t === 'abort' || t === 'critical') return 1;
    if (t === 'low')    return Math.max(1, Math.floor(base * 0.5));
    if (t === 'reduce') return Math.max(1, Math.ceil(base * 0.75));
    return base;
  }

  function _drain(tier) {
    if (_paused) return;
    var slot  = _slots[tier];
    if (!slot) return;
    var limit = _effectiveLimit(tier);
    while (slot.active < limit && slot.queue.length > 0) {
      slot.active++;
      slot.queue.shift()();
    }
  }

  // Acquire a concurrency slot. Resolves immediately if a slot is free,
  // otherwise waits in the FIFO queue until one is released.
  function acquireSlot(tier) {
    var slot = _slots[tier];
    if (!slot) return Promise.resolve();
    if (!_paused && slot.active < _effectiveLimit(tier)) {
      slot.active++;
      return Promise.resolve();
    }
    return new Promise(function (resolve) { slot.queue.push(resolve); });
  }

  // Release a previously acquired slot and dispatch the next waiter if any.
  function releaseSlot(tier) {
    var slot = _slots[tier];
    if (!slot) return;
    if (slot.queue.length > 0 && !_paused) {
      // Hand the slot directly to the next waiter (active count unchanged)
      slot.queue.shift()();
    } else {
      slot.active = Math.max(0, slot.active - 1);
      _drain(tier);
    }
  }

  // Convenience wrapper: acquire → run fn → release → return result.
  async function schedule(fn, tier) {
    tier = tier || 'BACKGROUND';
    await acquireSlot(tier);
    try {
      return await fn();
    } finally {
      releaseSlot(tier);
    }
  }

  // Pause: stop dispatching new work. Running tasks complete normally.
  function pause() {
    _paused = true;
  }

  // Resume: re-enable dispatching and drain all queues up to current limits.
  function resume() {
    _paused = false;
    Object.keys(_slots).forEach(_drain);
  }

  // Cancel all queued (waiting) tasks for a tier. Running tasks are unaffected.
  // Queued resolve() calls fire immediately so callers can unblock and check
  // their own cancellation flags.
  function cancelQueued(tier) {
    var slot = _slots[tier];
    if (!slot) return 0;
    var count = slot.queue.length;
    slot.queue.forEach(function (res) { try { res(); } catch (_) {} });
    slot.queue   = [];
    slot.active  = Math.max(0, slot.active - count);
    return count;
  }

  function stats() {
    var out = { paused: _paused };
    Object.keys(_slots).forEach(function (tier) {
      var s = _slots[tier];
      out[tier] = { active: s.active, queued: s.queue.length, limit: _effectiveLimit(tier) };
    });
    return out;
  }

  window.TaskScheduler = { acquireSlot, releaseSlot, schedule, pause, resume, cancelQueued, stats };
}());

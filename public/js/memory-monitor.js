// Memory Monitor — tracks JS heap usage and warns when under pressure.
// Uses performance.memory (Chrome/Edge) when available; estimates from
// file sizes on other browsers using a conservative 4× multiplier.
//
// Usage:
//   window.MemoryMonitor.isUnderPressure()          → boolean
//   window.MemoryMonitor.wouldExceedLimit(fileBytes) → boolean
//   window.MemoryMonitor.snapshot()                  → { used, limit, available, pressure }
(function () {
  const LIMIT_BYTES   = 800 * 1024 * 1024; // 800 MB — matches browser-tools guard
  const SAFETY_FACTOR = 4;                  // PDF ops typically need 4× file size in RAM

  function heapUsed() {
    try {
      const m = performance && performance.memory;
      if (m && m.usedJSHeapSize) return m.usedJSHeapSize;
    } catch (_) {}
    return 0;
  }

  function heapLimit() {
    try {
      const m = performance && performance.memory;
      if (m && m.jsHeapSizeLimit) return m.jsHeapSizeLimit;
    } catch (_) {}
    return LIMIT_BYTES * 2; // assume 1.6 GB if unknown
  }

  // Returns true when the JS heap already exceeds the safety ceiling.
  function isUnderPressure() {
    return heapUsed() > LIMIT_BYTES;
  }

  // Returns true when processing a file of fileBytes would likely push the
  // heap above the limit (using the SAFETY_FACTOR heuristic).
  function wouldExceedLimit(fileBytes) {
    const estimatedNeed = (fileBytes || 0) * SAFETY_FACTOR;
    const available     = Math.max(0, heapLimit() - heapUsed());
    return estimatedNeed > available;
  }

  // Returns a snapshot of the current memory state (bytes).
  function snapshot() {
    const used  = heapUsed();
    const limit = heapLimit();
    return {
      used,
      limit,
      available: Math.max(0, limit - used),
      pressure:  used > LIMIT_BYTES,
    };
  }

  window.MemoryMonitor = { isUnderPressure, wouldExceedLimit, snapshot, LIMIT_BYTES };
})();

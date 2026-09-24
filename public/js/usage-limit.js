// Usage tracking compatibility shim.
// PDF processing is intentionally not capped by arbitrary daily quotas.
(function () {
  'use strict';
  let count = 0;
  function canUse() { return true; }
  function record(n = 1) { count += Math.max(0, Number(n) || 0); }
  function limit() { return Infinity; }
  function getCount() { return count; }
  function showLimitModal() { /* No artificial processing limit. */ }
  window.UsageLimit = { canUse, record, limit, getCount, showLimitModal };
})();

/* Client file lifecycle — browser-only resource hygiene. */
(function (G) {
  'use strict';
  if (G.ClientFileLifecycle) return;
  const VERSION = '1.1.0';
  const urls = new Set();
  const buffers = new Set();
  function trackObjectURL(url) { if (typeof url === 'string' && url.startsWith('blob:')) urls.add(url); return url; }
  function revokeObjectURL(url) { if (!url) return; try { URL.revokeObjectURL(url); } catch (_) {} urls.delete(url); }
  function trackBuffer(buffer) { if (buffer instanceof ArrayBuffer) buffers.add(buffer); return buffer; }
  function releaseBuffer(buffer) { if (buffer instanceof ArrayBuffer) buffers.delete(buffer); return null; }
  function trackResult(result) {
    if (!result) return result;
    if (result.blob instanceof Blob) return result;
    if (result instanceof Blob) return result;
    return result;
  }
  function releaseResult(result) {
    if (!result) return null;
    if (result.url) revokeObjectURL(result.url);
    if (result.buffer instanceof ArrayBuffer) releaseBuffer(result.buffer);
    if (result.blob && result.blob instanceof Blob && result.blob.__clientLifecycleUrl) {
      revokeObjectURL(result.blob.__clientLifecycleUrl);
    }
    return null;
  }
  function cleanupObjectURLs() { urls.forEach(function (url) { try { URL.revokeObjectURL(url); } catch (_) {} }); urls.clear(); }
  function stats() { return { version: VERSION, trackedObjectURLs: urls.size, trackedBuffers: buffers.size }; }
  function cleanup() { cleanupObjectURLs(); buffers.clear(); }
  G.addEventListener('pagehide', cleanup, { once: true });
  G.addEventListener('beforeunload', cleanup, { once: true });
  G.ClientFileLifecycle = Object.freeze({ VERSION, trackObjectURL, revokeObjectURL, trackBuffer, releaseBuffer, trackResult, releaseResult, cleanupObjectURLs, cleanup, stats });
}(window));

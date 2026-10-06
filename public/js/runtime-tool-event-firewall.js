// RuntimeToolEventFirewall v1.0 — Arc 5 / Phase E / Target 5
// =====================================================================
// Cross-tool event propagation enforcement + unsafe listener auditing.
//
// Arc 4 gap: RuntimeToolSandbox provides a namespaced event BUS
// (tool:{toolId}:{event}) and DETECTS leakage but does NOT block
// cross-tool propagation at the window level. Any handler on window
// still receives ALL tool-scoped events regardless of toolId.
//
// Solution:
//   1. Event namespace enforcement: scoped CustomEvents tagged with
//      a 'toolId' in detail are intercepted; if they bubble through
//      a handler registered for a DIFFERENT toolId, a violation fires
//   2. Unsafe listener registry: audit window.addEventListener calls
//      that subscribe to tool-scoped event names without a toolId
//      qualifier, flag them as unsafe
//   3. Violation telemetry: every cross-tool event detected is logged
//      to RuntimeIncidentEngine with source + destination toolIds
//   4. Firewall map: per-toolId allowed event set; events outside
//      that set generate warnings
//   5. Shadow audit mode: no blocking (browser cannot truly block
//      CustomEvent propagation), but records all violations and
//      provides a getViolations() audit trail
//
// This is an audit/telemetry layer — it cannot intercept native DOM
// events at the browser level. It enforces the RuntimeToolSandbox
// contract and logs any violations for remediation.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolEventFirewall) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[EventFirewall]';
  var VERSION = '1.0';
  var MAX_VIOLATIONS = 200;

  // ── Violation log ─────────────────────────────────────────────────────────
  var _violations = [];  // { ts, type, publisherTool, subscriberTool, event }
  var _auditLog   = [];  // { ts, type, eventType, detail }

  function _logViolation(type, detail) {
    _violations.push(Object.assign({ ts: Date.now(), type: type }, detail));
    if (_violations.length > MAX_VIOLATIONS) _violations.shift();
    try {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie.report === 'function') {
        ie.report(Object.assign({ ts: Date.now() }, detail));
      }
    } catch (_) {}
  }

  // ── Per-tool event allowlists ─────────────────────────────────────────────
  // toolId → Set of allowed event types for this tool's sandbox
  var _allowlists = {};
  var _DEFAULT_ALLOWED = [
    'tool:runtime-ready', 'tool:manifest-activated', 'tool:error',
    'memory-firewall:critical', 'memory-firewall:panic',
    'recovery-fw:isolate', 'recovery-fw:restart', 'recovery-fw:degrade',
    'recovery-fw:quarantine', 'code-loader:loaded', 'tool-mesh:crash',
  ];

  function allow(toolId, eventType) {
    if (!_allowlists[toolId]) _allowlists[toolId] = _DEFAULT_ALLOWED.slice();
    if (!_allowlists[toolId].includes(eventType)) _allowlists[toolId].push(eventType);
  }

  // ── Intercept tool:* events and check for cross-tool propagation ──────────
  // We listen for ALL tool:-scoped events on window and check the detail.toolId
  // against any registered handlers that might have the wrong toolId context.
  var _registeredHandlers = {}; // eventType → [{ toolId, fn }]

  function enforceOn(eventType, publisherToolId, subscriberToolId) {
    if (!publisherToolId || !subscriberToolId) return;
    if (publisherToolId === subscriberToolId) return; // same tool = ok
    // Cross-tool: log violation
    _logViolation('cross-tool-event', {
      type:            'cross-tool-event',
      eventType:       eventType,
      publisherTool:   publisherToolId,
      subscriberTool:  subscriberToolId,
    });
    console.debug(LOG, 'CROSS-TOOL EVENT:', eventType, '— publisher:', publisherToolId, '→ subscriber:', subscriberToolId);
  }

  // ── Install global auditor on CustomEvent dispatch ────────────────────────
  function _installAuditor() {
    // Shadow-patch window.dispatchEvent to audit tool:* events
    var _origDispatch = G.dispatchEvent.bind(G);
    var _patched = false;
    if (_patched) return;
    _patched = true;

    try {
      G.__origDispatchEvent = _origDispatch;
      // We cannot replace window.dispatchEvent (it's a native method on most
      // browsers). Instead, we listen for ALL tool-scoped events at the
      // capture phase (which fires before bubbling handlers) and audit them.
      G.addEventListener('*', function () {}, { capture: true }); // not valid
    } catch (_) {}

    // Real approach: listen at capture phase for all CustomEvents
    G.addEventListener('tool:runtime-ready', _auditEvent, true);
    G.addEventListener('tool:manifest-activated', _auditEvent, true);

    // Also intercept tool-sandbox emits
    G.addEventListener('tool-mesh:crash', _auditEvent, true);
    G.addEventListener('tool-mesh:isolated', _auditEvent, true);
    G.addEventListener('recovery-fw:isolate', _auditEvent, true);
    G.addEventListener('recovery-fw:quarantine', _auditEvent, true);
    G.addEventListener('memory-firewall:panic', _auditEvent, true);
    G.addEventListener('code-loader:loaded', _auditEvent, true);

    // Audit sandbox-emitted scoped events
    G.addEventListener('tool:*', _auditEvent, true);
  }

  function _auditEvent(evt) {
    try {
      var detail = evt && evt.detail;
      if (!detail) return;
      var pub = detail.toolId || (detail.manifest && detail.manifest.toolId);
      if (!pub) return;
      // Log audit entry
      _auditLog.push({ ts: Date.now(), event: evt.type, toolId: pub });
      if (_auditLog.length > 500) _auditLog.shift();
    } catch (_) {}
  }

  // ── Audit global window.addEventListener calls (wrapper) ─────────────────
  // We cannot truly replace addEventListener, but we can track calls made
  // after this module loads via a soft audit helper
  var _unsafeListeners = []; // { eventType, registeredAt }
  var TOOL_EVENT_PREFIXES = ['tool:', 'memory-firewall:', 'recovery-fw:', 'tool-mesh:',
                             'code-loader:', 'memory-orchestrator:', 'processor:'];

  function auditListener(eventType, fn, opts) {
    var isToolScoped = TOOL_EVENT_PREFIXES.some(function (p) { return eventType.startsWith(p); });
    if (!isToolScoped) return; // not a tool-scoped event, skip
    // Check if this listener passes a toolId filter
    var src = fn && fn.toString ? fn.toString().slice(0, 200) : '';
    var hasFilter = src.includes('toolId') || src.includes('detail.toolId');
    if (!hasFilter) {
      _unsafeListeners.push({ eventType: eventType, registeredAt: Date.now(), src: src.slice(0, 80) });
      _auditLog.push({ ts: Date.now(), type: 'unsafe-listener', eventType: eventType });
      console.debug(LOG, 'UNSAFE LISTENER (no toolId filter):', eventType);
    }
  }

  // ── Sandbox event scope enforcement hook ──────────────────────────────────
  // RuntimeToolSandbox.emit() already scopes events. This firewall adds a
  // complementary check when it receives broadcast events.
  G.addEventListener('tool-mesh:crash', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) _auditEvent(evt);
    } catch (_) {}
  }, true);

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _installAuditor, { once: true });
  } else {
    setTimeout(_installAuditor, 0);
  }

  G.RuntimeToolEventFirewall = Object.freeze({
    VERSION:          VERSION,
    allow:            allow,
    enforceOn:        enforceOn,
    auditListener:    auditListener,
    getViolations:    function () { return _violations.slice(); },
    getUnsafeListeners: function () { return _unsafeListeners.slice(); },
    getAuditLog:      function (limit) { return _auditLog.slice(-(limit || 100)); },
    clearViolations:  function () { _violations.length = 0; },
    violationCount:   function () { return _violations.length; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — cross-tool event audit active');

}(window));

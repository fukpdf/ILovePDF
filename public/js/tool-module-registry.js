// ToolModuleRegistry v1 — Phase 1 / independent tool boundary
// Derives one logical module contract per configured tool without loading
// processors eagerly. A module owns its tool id, accepted input contract,
// execution manifest, and lifecycle hooks; processor code remains lazy.
(function (G) {
  'use strict';
  if (G.ToolModuleRegistry) return;

  var _modules = Object.create(null);

  function _copyAccepted(tool) {
    return String(tool && tool.acceptedFiles || '')
      .split(',').map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
  }

  function _build(tool) {
    if (!tool || !tool.id) return null;
    var browser = G.BrowserTools;
    var execution = browser && typeof browser.getToolExecutionManifest === 'function'
      ? browser.getToolExecutionManifest(tool.id) : null;
    var special = !!(G.SLUG_MAP && Object.keys(G.SLUG_MAP).some(function (slug) {
      var m = G.SLUG_MAP[slug];
      return m && m.id === tool.id && m.special;
    }));
    return Object.freeze({
      version: 1,
      moduleId: 'tool:' + tool.id,
      toolId: tool.id,
      category: tool.category || null,
      group: tool.group || null,
      entry: special ? 'special-route' : 'tool-page',
      processor: execution ? execution.processor : null,
      execution: execution ? execution.execution : 'unavailable',
      lazyLoad: true,
      independent: true,
      acceptedFiles: _copyAccepted(tool),
      multipleFiles: tool.multipleFiles !== false,
      working: tool.working !== false,
      validationVersion: execution && execution.validation ? execution.validation.version : null,
    });
  }

  function register(tool) {
    var m = _build(tool);
    if (!m) return null;
    _modules[m.toolId] = m;
    return m;
  }

  function get(toolId) {
    return _modules[toolId] || null;
  }

  function registerAll(tools) {
    var list = Array.isArray(tools) ? tools : [];
    list.forEach(register);
    return Object.keys(_modules).length;
  }

  function activate(toolId) {
    var m = get(toolId);
    if (!m) return { ok: false, code: 'UNKNOWN_TOOL_MODULE' };
    try {
      G.dispatchEvent(new CustomEvent('tool:module-activated', { detail: { module: m } }));
    } catch (_) {}
    return { ok: true, module: m };
  }

  function getAll() {
    return Object.keys(_modules).map(function (id) { return _modules[id]; });
  }

  G.ToolModuleRegistry = Object.freeze({
    VERSION: '1.0',
    register: register,
    registerAll: registerAll,
    get: get,
    getAll: getAll,
    activate: activate,
  });

  // Register only metadata. No processor/engine is loaded here.
  setTimeout(function () {
    try { registerAll(G.TOOLS || []); } catch (_) {}
  }, 0);
}(window));

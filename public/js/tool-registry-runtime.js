/* Phase 4 Unit 2 — browser runtime tool registry.
 * The JSON registry is authoritative for tool identity and execution metadata.
 * Legacy TOOLS remains the UI/detail compatibility layer during migration.
 */
(function (G) {
  'use strict';
  const ENDPOINT = '/config/tool-registry.json';
  let registry = null;
  let loadError = null;
  let loading = null;

  function freezeEntry(tool) {
    const entry = { ...tool };
    if (Array.isArray(entry.dependencies)) entry.dependencies = Object.freeze(entry.dependencies.slice());
    if (entry.capabilities && typeof entry.capabilities === 'object') {
      entry.capabilities = Object.freeze({ ...entry.capabilities });
    }
    return Object.freeze(entry);
  }

  function normalize(data) {
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.tools)) {
      throw new Error('Invalid tool registry payload');
    }
    const byId = new Map();
    const bySlug = new Map();
    const frozenTools = [];
    for (const tool of data.tools) {
      if (!tool || typeof tool.id !== 'string' || typeof tool.slug !== 'string') {
        throw new Error('Invalid tool registry entry');
      }
      if (byId.has(tool.id) || bySlug.has(tool.slug)) throw new Error('Duplicate tool registry identity');
      const entry = freezeEntry(tool);
      frozenTools.push(entry);
      byId.set(entry.id, entry);
      bySlug.set(entry.slug, entry);
    }
    return Object.freeze({ schemaVersion: data.schemaVersion, generatedFrom: data.generatedFrom, tools: Object.freeze(frozenTools), byId, bySlug });
  }

  function health() {
    return {
      ready: !!registry,
      endpoint: ENDPOINT,
      toolCount: registry ? registry.tools.length : 0,
      schemaVersion: registry ? registry.schemaVersion : null,
      error: loadError ? String(loadError.message || loadError) : null
    };
  }

  function get(id) { return registry ? registry.byId.get(id) || null : null; }
  function getBySlug(slug) { return registry ? registry.bySlug.get(slug) || null : null; }
  function list() { return registry ? registry.tools.slice() : []; }
  function isReady() { return !!registry; }
  function error() { return loadError; }

  function mergeLegacy(legacy) {
    if (!legacy || !registry) return legacy || null;
    const meta = get(legacy.id);
    if (!meta) return legacy;
    return Object.assign({}, legacy, meta, {
      url: legacy.url,
      icon: legacy.icon,
      description: legacy.description,
      apiEndpoint: legacy.apiEndpoint,
      acceptedFiles: legacy.acceptedFiles,
      multipleFiles: legacy.multipleFiles,
      clientSide: legacy.clientSide,
      options: legacy.options
    });
  }

  const api = Object.freeze({ load, get, getBySlug, list, isReady, error, health, mergeLegacy, endpoint: ENDPOINT });
  G.ToolRegistry = api;
  G.ToolRegistryReady = load().catch(function () { return null; });
})(window);

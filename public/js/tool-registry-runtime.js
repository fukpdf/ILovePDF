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

  function normalize(data) {
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.tools)) {
      throw new Error('Invalid tool registry payload');
    }
    const byId = new Map();
    const bySlug = new Map();
    for (const tool of data.tools) {
      if (!tool || typeof tool.id !== 'string' || typeof tool.slug !== 'string') {
        throw new Error('Invalid tool registry entry');
      }
      if (byId.has(tool.id) || bySlug.has(tool.slug)) throw new Error('Duplicate tool registry identity');
      byId.set(tool.id, Object.freeze({ ...tool }));
      bySlug.set(tool.slug, Object.freeze({ ...tool }));
    }
    return Object.freeze({ schemaVersion: data.schemaVersion, generatedFrom: data.generatedFrom, tools: Object.freeze(data.tools.slice()), byId, bySlug });
  }

  async function load() {
    if (registry) return registry;
    if (loading) return loading;
    loading = fetch(ENDPOINT, { credentials: 'omit', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Tool registry HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        registry = normalize(data);
        G.ToolRegistry = api;
        G.dispatchEvent(new CustomEvent('ilovepdf:tool-registry-ready'));
        // Unit 3: activate the registry-driven execution policy only after
        // the authoritative registry is valid. BrowserTools remains the
        // processor implementation; policy owns the allowed execution mode.
        try {
          if (!document.querySelector('script[data-tool-execution-policy]')) {
            const s = document.createElement('script');
            s.src = '/js/tool-execution-policy.js';
            s.async = true;
            s.dataset.toolExecutionPolicy = '1';
            document.head.appendChild(s);
          }
        } catch (_) {}
        return registry;
      })
      .catch(function (error) {
        loadError = error;
        throw error;
      });
    return loading;
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

  const api = Object.freeze({ load, get, getBySlug, list, isReady, error, mergeLegacy, endpoint: ENDPOINT });
  G.ToolRegistry = api;
  G.ToolRegistryReady = load().catch(function () { return null; });
})(window);

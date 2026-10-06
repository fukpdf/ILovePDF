/**
 * PHASE 2 — LABA MEMORY SYSTEM
 * window.LabaMemorySystem
 *
 * Unified persistent memory coordinator.
 * Short-term (in-memory) + Long-term (IDB) + Cross-session context.
 * Purely additive. Degrades gracefully. No external deps.
 */
(function () {
  'use strict';

  if (window.LabaMemorySystem) return;

  var VERSION = '2.0';
  var LOG     = '[LMS]';
  var DB_NAME = 'lms_v2';
  var TTL_SHORT  = 2  * 60 * 60 * 1000;  // 2 h
  var TTL_LONG   = 30 * 24 * 60 * 60 * 1000; // 30 days
  var MAX_SHORT  = 50;
  var MAX_LONG   = 200;

  function log()  { var a = [].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = [].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function uid()  { return 'lms_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  function now()  { return Date.now(); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  IDB STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var IDB = (function () {
    var _db = null;

    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          ['short_term', 'long_term', 'file_context', 'preferences', 'summaries'].forEach(function (name) {
            if (!db.objectStoreNames.contains(name)) {
              var os = db.createObjectStore(name, { keyPath: 'id' });
              if (name === 'short_term' || name === 'long_term') {
                os.createIndex('type',    'type',    { unique: false });
                os.createIndex('ts',      'ts',      { unique: false });
              }
            }
          });
        };
        req.onsuccess = function (e) { _db = e.target.result; res(_db); };
        req.onerror   = function ()  { rej(req.error); };
      });
    }

    function put(store, obj) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(obj);
          tx.oncomplete = res; tx.onerror = res;
        });
      }).catch(function () {});
    }

    function get(store, id) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var req = db.transaction(store, 'readonly').objectStore(store).get(id);
          req.onsuccess = function () { res(req.result || null); };
          req.onerror   = function () { res(null); };
        });
      }).catch(function () { return null; });
    }

    function getAll(store) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var req = db.transaction(store, 'readonly').objectStore(store).getAll();
          req.onsuccess = function () { res(req.result || []); };
          req.onerror   = function () { res([]); };
        });
      }).catch(function () { return []; });
    }

    function del(store, id) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).delete(id);
          tx.oncomplete = res; tx.onerror = res;
        });
      }).catch(function () {});
    }

    function clear(store) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).clear();
          tx.oncomplete = res; tx.onerror = res;
        });
      }).catch(function () {});
    }

    return { put: put, get: get, getAll: getAll, del: del, clear: clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  SHORT-TERM MEMORY (in-memory, IDB-backed)
  // ═══════════════════════════════════════════════════════════════════════════
  var ShortTermMemory = (function () {
    var _mem = []; // [{id, type, key, value, ts, expiresAt}]

    function _evict() {
      var t = now();
      _mem = _mem.filter(function (m) { return m.expiresAt > t; });
      if (_mem.length > MAX_SHORT) _mem = _mem.slice(_mem.length - MAX_SHORT);
    }

    function store(type, key, value) {
      _evict();
      var existing = _mem.findIndex(function (m) { return m.type === type && m.key === key; });
      var entry = { id: uid(), type: type, key: key, value: value, ts: now(), expiresAt: now() + TTL_SHORT };
      if (existing >= 0) { entry.id = _mem[existing].id; _mem[existing] = entry; }
      else               { _mem.push(entry); }
      IDB.put('short_term', entry);
    }

    function recall(type, key) {
      _evict();
      var entry = _mem.find(function (m) { return m.type === type && (!key || m.key === key); });
      return entry ? entry.value : null;
    }

    function recallAll(type) {
      _evict();
      return _mem.filter(function (m) { return !type || m.type === type; }).map(function (m) { return m.value; });
    }

    function forget(type, key) {
      var entry = _mem.find(function (m) { return m.type === type && m.key === key; });
      if (entry) { IDB.del('short_term', entry.id); }
      _mem = _mem.filter(function (m) { return !(m.type === type && m.key === key); });
    }

    async function restore() {
      try {
        var rows = await IDB.getAll('short_term');
        var t = now();
        _mem = rows.filter(function (r) { return r.expiresAt > t; });
        log('short-term restored:', _mem.length, 'entries');
      } catch (e) { warn('short-term restore failed:', e.message); }
    }

    return { store: store, recall: recall, recallAll: recallAll, forget: forget, restore: restore };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  LONG-TERM MEMORY (IDB-backed, persisted across sessions)
  // ═══════════════════════════════════════════════════════════════════════════
  var LongTermMemory = (function () {
    var _cache = new Map(); // key → entry

    async function store(type, key, value, tags) {
      var id      = type + '::' + key;
      var entry   = { id: id, type: type, key: key, value: value, tags: tags || [], ts: now(), expiresAt: now() + TTL_LONG, hits: 0 };
      var existing = await IDB.get('long_term', id);
      if (existing) { entry.hits = (existing.hits || 0) + 1; entry.ts = now(); }
      _cache.set(id, entry);
      await IDB.put('long_term', entry);
    }

    async function recall(type, key) {
      var id    = type + '::' + key;
      var entry = _cache.get(id) || await IDB.get('long_term', id);
      if (!entry || entry.expiresAt < now()) return null;
      entry.hits++;
      _cache.set(id, entry);
      IDB.put('long_term', entry);
      return entry.value;
    }

    async function recallAll(type) {
      var rows  = await IDB.getAll('long_term');
      var t     = now();
      return rows.filter(function (r) { return (!type || r.type === type) && r.expiresAt > t; })
                 .sort(function (a, b) { return b.hits - a.hits; })
                 .map(function (r) { return r.value; });
    }

    async function forget(type, key) {
      var id = type + '::' + key;
      _cache.delete(id);
      await IDB.del('long_term', id);
    }

    async function sweep() {
      var rows  = await IDB.getAll('long_term');
      var t     = now();
      var stale = rows.filter(function (r) { return r.expiresAt <= t; });
      stale.forEach(function (r) { _cache.delete(r.id); IDB.del('long_term', r.id); });
      if (stale.length) log('swept', stale.length, 'stale long-term entries');
    }

    async function restore() {
      try {
        var rows = await IDB.getAll('long_term');
        var t = now();
        rows.filter(function (r) { return r.expiresAt > t; })
            .forEach(function (r) { _cache.set(r.id, r); });
        log('long-term restored:', _cache.size, 'entries');
      } catch (e) { warn('long-term restore failed:', e.message); }
    }

    return { store: store, recall: recall, recallAll: recallAll, forget: forget, sweep: sweep, restore: restore };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  FILE CONTEXT MEMORY
  // ═══════════════════════════════════════════════════════════════════════════
  var FileContextMemory = (function () {
    var _files = new Map(); // fileId → context

    function _makeId(file) {
      return (file.name || 'file') + '_' + (file.size || 0);
    }

    async function remember(file, meta) {
      var id  = _makeId(file);
      var ctx = {
        id:        id,
        name:      file.name,
        size:      file.size,
        type:      file.type,
        ts:        now(),
        expiresAt: now() + TTL_SHORT,
        ocrText:   meta && meta.ocrText   ? meta.ocrText.slice(0, 4000) : null,
        summary:   meta && meta.summary   ? meta.summary.slice(0, 800)  : null,
        outputUrl: meta && meta.outputUrl ? meta.outputUrl : null,
        toolsRun:  meta && meta.toolsRun  ? meta.toolsRun : [],
        lastTool:  meta && meta.lastTool  ? meta.lastTool : null,
      };
      _files.set(id, ctx);
      await IDB.put('file_context', ctx);
      return id;
    }

    async function update(fileId, patch) {
      var ctx = _files.get(fileId) || await IDB.get('file_context', fileId);
      if (!ctx) return;
      Object.assign(ctx, patch);
      ctx.ts = now();
      _files.set(fileId, ctx);
      await IDB.put('file_context', ctx);
    }

    async function recall(fileId) {
      return _files.get(fileId) || await IDB.get('file_context', fileId);
    }

    async function recallByName(name) {
      var rows = await IDB.getAll('file_context');
      return rows.filter(function (r) { return r.name === name && r.expiresAt > now(); });
    }

    async function recallRecent(limit) {
      var rows = await IDB.getAll('file_context');
      var t = now();
      return rows.filter(function (r) { return r.expiresAt > t; })
                 .sort(function (a, b) { return b.ts - a.ts; })
                 .slice(0, limit || 5);
    }

    async function restore() {
      try {
        var rows = await IDB.getAll('file_context');
        var t = now();
        rows.filter(function (r) { return r.expiresAt > t; })
            .forEach(function (r) { _files.set(r.id, r); });
        log('file context restored:', _files.size, 'files');
      } catch (e) { warn('file context restore failed:', e.message); }
    }

    return { remember: remember, update: update, recall: recall, recallByName: recallByName, recallRecent: recallRecent, restore: restore };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  USER PREFERENCES
  // ═══════════════════════════════════════════════════════════════════════════
  var PreferencesMemory = (function () {
    var _prefs = {};

    async function set(key, value) {
      _prefs[key] = value;
      await IDB.put('preferences', { id: key, key: key, value: value, ts: now() });
    }

    async function get(key, def) {
      if (key in _prefs) return _prefs[key];
      var row = await IDB.get('preferences', key);
      if (row) { _prefs[key] = row.value; return row.value; }
      return def !== undefined ? def : null;
    }

    async function restore() {
      try {
        var rows = await IDB.getAll('preferences');
        rows.forEach(function (r) { _prefs[r.key] = r.value; });
        log('preferences restored:', Object.keys(_prefs).length, 'keys');
      } catch (e) { warn('preferences restore failed:', e.message); }
    }

    return { set: set, get: get, restore: restore };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  TOOL USAGE TRACKER (long-term learning)
  // ═══════════════════════════════════════════════════════════════════════════
  var ToolUsageTracker = (function () {
    var _counts = {};

    async function record(toolId, success) {
      _counts[toolId] = (_counts[toolId] || 0) + 1;
      var existing = await LongTermMemory.recall('tool_usage', toolId);
      var entry = existing || { id: toolId, uses: 0, successes: 0 };
      entry.uses++;
      if (success) entry.successes++;
      entry.lastUsed = now();
      _counts[toolId] = entry.uses;
      await LongTermMemory.store('tool_usage', toolId, entry);
    }

    async function getTopTools(limit) {
      var all = await LongTermMemory.recallAll('tool_usage');
      return all.sort(function (a, b) { return b.uses - a.uses; }).slice(0, limit || 5);
    }

    async function getMostRecent() {
      var all = await LongTermMemory.recallAll('tool_usage');
      return all.sort(function (a, b) { return b.lastUsed - a.lastUsed; }).slice(0, 3);
    }

    return { record: record, getTopTools: getTopTools, getMostRecent: getMostRecent };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  CONVERSATION SUMMARY STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var SummaryStore = (function () {
    async function save(sessionId, summary) {
      await IDB.put('summaries', { id: sessionId, sessionId: sessionId, summary: summary, ts: now() });
    }

    async function load(sessionId) {
      var row = await IDB.get('summaries', sessionId);
      return row ? row.summary : null;
    }

    async function loadRecent(limit) {
      var rows = await IDB.getAll('summaries');
      return rows.sort(function (a, b) { return b.ts - a.ts; }).slice(0, limit || 3);
    }

    return { save: save, load: load, loadRecent: loadRecent };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 8  CROSS-SESSION CONTEXT BRIDGE
  // Exposes a compact context string for use in AI prompts.
  // ═══════════════════════════════════════════════════════════════════════════
  var ContextBridge = (function () {
    async function buildPromptContext(sessionId, query) {
      var parts = [];

      // Recent files
      var recentFiles = await FileContextMemory.recallRecent(3);
      if (recentFiles.length) {
        parts.push('Recent files: ' + recentFiles.map(function (f) {
          return f.name + (f.lastTool ? ' [' + f.lastTool + ']' : '');
        }).join(', ') + '.');
      }

      // Top tools
      var topTools = await ToolUsageTracker.getTopTools(3);
      if (topTools.length) {
        parts.push('Frequently used tools: ' + topTools.map(function (t) { return t.id; }).join(', ') + '.');
      }

      // Session summary
      if (sessionId) {
        var summary = await SummaryStore.load(sessionId);
        if (summary) parts.push('Previous conversation: ' + summary.slice(0, 300));
      }

      // Active task from short-term
      var activeTask = ShortTermMemory.recall('task', 'current');
      if (activeTask) parts.push('Current task: ' + activeTask);

      return parts.join(' ');
    }

    return { buildPromptContext: buildPromptContext };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 9  CLEANUP SCHEDULER
  // ═══════════════════════════════════════════════════════════════════════════
  function _scheduleCleanup() {
    setInterval(function () {
      LongTermMemory.sweep();
    }, 60 * 60 * 1000); // every hour
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 10  INIT
  // ═══════════════════════════════════════════════════════════════════════════
  async function _init() {
    try {
      await Promise.all([
        ShortTermMemory.restore(),
        LongTermMemory.restore(),
        FileContextMemory.restore(),
        PreferencesMemory.restore(),
      ]);
      _scheduleCleanup();
      log('v' + VERSION + ' ready — short/long/file/prefs restored');
    } catch (e) {
      warn('init error:', e.message);
    }
  }

  _init();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 11  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.LabaMemorySystem = {
    version: VERSION,

    // Short-term
    storeShort:  function (type, key, value) { ShortTermMemory.store(type, key, value); },
    recallShort: function (type, key)        { return ShortTermMemory.recall(type, key); },
    recallAllShort: function (type)          { return ShortTermMemory.recallAll(type); },
    forgetShort: function (type, key)        { ShortTermMemory.forget(type, key); },

    // Long-term
    storeLong:    function (type, key, value, tags) { return LongTermMemory.store(type, key, value, tags); },
    recallLong:   function (type, key)               { return LongTermMemory.recall(type, key); },
    recallAllLong: function (type)                   { return LongTermMemory.recallAll(type); },
    forgetLong:   function (type, key)               { return LongTermMemory.forget(type, key); },

    // Files
    rememberFile:    function (file, meta) { return FileContextMemory.remember(file, meta); },
    updateFile:      function (id, patch)  { return FileContextMemory.update(id, patch); },
    recallFile:      function (id)         { return FileContextMemory.recall(id); },
    recallFileByName: function (name)      { return FileContextMemory.recallByName(name); },
    recallRecentFiles: function (n)        { return FileContextMemory.recallRecent(n); },

    // Preferences
    setPref:  function (k, v)    { return PreferencesMemory.set(k, v); },
    getPref:  function (k, def)  { return PreferencesMemory.get(k, def); },

    // Tool usage
    recordTool:    function (id, ok) { return ToolUsageTracker.record(id, ok); },
    topTools:      function (n)      { return ToolUsageTracker.getTopTools(n); },
    recentTools:   function ()       { return ToolUsageTracker.getMostRecent(); },

    // Summaries
    saveSummary:       function (sid, s) { return SummaryStore.save(sid, s); },
    loadSummary:       function (sid)    { return SummaryStore.load(sid); },
    loadRecentSummaries: function (n)    { return SummaryStore.loadRecent(n); },

    // Context for AI prompt
    buildPromptContext: function (sid, q) { return ContextBridge.buildPromptContext(sid, q); },

    // Convenience: set active task
    setTask:    function (t)  { ShortTermMemory.store('task', 'current', t); },
    getTask:    function ()   { return ShortTermMemory.recall('task', 'current'); },
    clearTask:  function ()   { ShortTermMemory.forget('task', 'current'); },

    // Active file (most recently uploaded)
    setActiveFile: function (fileId) { ShortTermMemory.store('active_file', 'id', fileId); },
    getActiveFile: function ()        { return ShortTermMemory.recall('active_file', 'id'); },

    audit: function () {
      return {
        version: VERSION,
        shortTerm: ShortTermMemory.recallAll().length,
      };
    },
  };

  log('LabaMemorySystem v' + VERSION + ' ready');
}());

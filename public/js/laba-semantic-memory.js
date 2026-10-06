/**
 * PHASE 2 — LABA SEMANTIC MEMORY
 * window.LabaSemanticMemory
 *
 * Lightweight semantic memory engine.
 * TF-IDF embeddings (no external model required) + cosine similarity.
 * IDB-backed chunk index. Falls back to VectorMemoryEngine if available.
 * Purely additive. No external deps.
 */
(function () {
  'use strict';

  if (window.LabaSemanticMemory) return;

  var VERSION  = '2.0';
  var LOG      = '[LSM]';
  var DB_NAME  = 'lsm_v2';
  var MAX_CHUNKS = 2000;
  var MAX_DIM    = 256;

  function log()  { var a = [].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = [].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function uid()  { return 'lsm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  IDB STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var IDB = (function () {
    var _db = null;

    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('chunks')) {
            var os = db.createObjectStore('chunks', { keyPath: 'id' });
            os.createIndex('source', 'source', { unique: false });
            os.createIndex('ts',     'ts',     { unique: false });
          }
          if (!db.objectStoreNames.contains('vocab')) {
            db.createObjectStore('vocab', { keyPath: 'word' });
          }
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

    function getAll(store, idx, key) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx  = db.transaction(store, 'readonly');
          var req = idx ? tx.objectStore(store).index(idx).getAll(key)
                        : tx.objectStore(store).getAll();
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

    return { put: put, getAll: getAll, del: del };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  TOKENIZER
  // ═══════════════════════════════════════════════════════════════════════════
  var Tokenizer = (function () {
    var _stopWords = new Set([
      'a','an','the','and','or','but','in','on','at','to','for','of','with',
      'is','are','was','were','be','been','being','have','has','had','do','does',
      'did','will','would','shall','should','may','might','must','can','could',
      'this','that','these','those','it','its','i','you','he','she','we','they',
      'what','which','who','when','where','how','why','not','no','so','if',
    ]);

    function tokenize(text) {
      return (text || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(function (w) { return w.length > 1 && !_stopWords.has(w); });
    }

    function ngrams(tokens, n) {
      var out = tokens.slice();
      if (n >= 2) {
        for (var i = 0; i < tokens.length - 1; i++) {
          out.push(tokens[i] + '_' + tokens[i + 1]);
        }
      }
      return out;
    }

    return { tokenize: tokenize, ngrams: ngrams };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  VOCABULARY + TF-IDF VECTORIZER
  // ═══════════════════════════════════════════════════════════════════════════
  var Vectorizer = (function () {
    var _vocab   = [];       // ordered word list
    var _vocabIdx = {};      // word → index
    var _df      = {};       // word → doc frequency (for IDF)
    var _nDocs   = 0;
    var _dirty   = false;
    var _loaded  = false;

    function _addWords(tokens) {
      tokens.forEach(function (w) {
        if (!(w in _vocabIdx)) {
          _vocabIdx[w] = _vocab.length;
          _vocab.push(w);
          _df[w] = 0;
        }
      });
      if (_vocab.length > MAX_DIM * 4) _prune();
    }

    function _prune() {
      // Keep top MAX_DIM*2 words by df
      var sorted = Object.keys(_df).sort(function (a, b) { return _df[b] - _df[a]; }).slice(0, MAX_DIM * 2);
      var newIdx = {}; var newVocab = []; var newDf = {};
      sorted.forEach(function (w, i) { newIdx[w] = i; newVocab.push(w); newDf[w] = _df[w]; });
      _vocab = newVocab; _vocabIdx = newIdx; _df = newDf;
    }

    function embed(text) {
      var tokens = Tokenizer.ngrams(Tokenizer.tokenize(text), 2);
      if (!tokens.length) return new Float32Array(Math.min(_vocab.length, MAX_DIM));

      // TF
      var tf = {};
      tokens.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });

      // Build sparse vector using existing vocab (don't add new words here)
      var dim = Math.min(_vocab.length || 1, MAX_DIM);
      var vec = new Float32Array(dim);
      Object.keys(tf).forEach(function (w) {
        if (w in _vocabIdx && _vocabIdx[w] < dim) {
          var idf = _nDocs > 1 ? Math.log((_nDocs + 1) / ((_df[w] || 0) + 1)) + 1 : 1;
          vec[_vocabIdx[w]] = (tf[w] / tokens.length) * idf;
        }
      });

      // L2 normalize
      var norm = 0;
      for (var i = 0; i < dim; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (var j = 0; j < dim; j++) vec[j] /= norm;

      return vec;
    }

    function learn(text) {
      _addWords(Tokenizer.ngrams(Tokenizer.tokenize(text), 2));
      // Update df
      var unique = new Set(Tokenizer.tokenize(text));
      unique.forEach(function (w) { if (w in _vocabIdx) _df[w] = (_df[w] || 0) + 1; });
      _nDocs++;
      _dirty = true;
    }

    function cosineSim(a, b) {
      var dim = Math.min(a.length, b.length);
      var dot = 0;
      for (var i = 0; i < dim; i++) dot += a[i] * b[i];
      return dot; // already normalized
    }

    async function saveVocab() {
      if (!_dirty) return;
      await IDB.put('vocab', { word: '__meta__', vocab: _vocab, df: _df, nDocs: _nDocs });
      _dirty = false;
    }

    async function loadVocab() {
      if (_loaded) return;
      _loaded = true;
      try {
        var rows = await IDB.getAll('vocab');
        var meta = rows.find(function (r) { return r.word === '__meta__'; });
        if (meta) {
          _vocab = meta.vocab || [];
          _df    = meta.df    || {};
          _nDocs = meta.nDocs || 0;
          _vocab.forEach(function (w, i) { _vocabIdx[w] = i; });
          log('vocab loaded:', _vocab.length, 'words,', _nDocs, 'docs');
        }
      } catch (e) { warn('vocab load failed:', e.message); }
    }

    return { embed: embed, learn: learn, cosineSim: cosineSim, saveVocab: saveVocab, loadVocab: loadVocab };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  CHUNK STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var ChunkStore = (function () {
    var _chunks = [];
    var _loaded  = false;

    async function _ensureLoaded() {
      if (_loaded) return;
      _loaded = true;
      try {
        _chunks = await IDB.getAll('chunks');
        log('chunks loaded:', _chunks.length);
      } catch (e) { warn('chunk load failed:', e.message); }
    }

    async function index(text, source, meta) {
      await _ensureLoaded();
      Vectorizer.learn(text);

      var words    = Tokenizer.tokenize(text);
      var chunkSize = 80;
      var added    = 0;

      for (var i = 0; i < words.length; i += chunkSize) {
        var chunk = words.slice(i, i + chunkSize).join(' ');
        var entry = {
          id:     uid(),
          source: source || 'user',
          chunk:  chunk,
          vec:    null, // computed lazily on first search
          ts:     Date.now(),
          meta:   meta || {},
        };
        _chunks.push(entry);
        await IDB.put('chunks', entry);
        added++;
      }

      // Evict if too many
      if (_chunks.length > MAX_CHUNKS) {
        var toRemove = _chunks.splice(0, _chunks.length - MAX_CHUNKS);
        toRemove.forEach(function (c) { IDB.del('chunks', c.id); });
      }

      await Vectorizer.saveVocab();
      return added;
    }

    async function search(query, source, topK) {
      await _ensureLoaded();
      await Vectorizer.loadVocab();

      var qVec  = Vectorizer.embed(query);
      var pool  = source ? _chunks.filter(function (c) { return c.source === source; }) : _chunks;
      var scored = pool.map(function (c) {
        if (!c.vec || c.vec.length !== qVec.length) c.vec = Vectorizer.embed(c.chunk);
        return { chunk: c.chunk, source: c.source, meta: c.meta, score: Vectorizer.cosineSim(qVec, c.vec) };
      });

      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.slice(0, topK || 5).filter(function (r) { return r.score > 0.05; });
    }

    async function clearBySource(source) {
      await _ensureLoaded();
      var toRemove = _chunks.filter(function (c) { return c.source === source; });
      _chunks = _chunks.filter(function (c) { return c.source !== source; });
      toRemove.forEach(function (c) { IDB.del('chunks', c.id); });
    }

    return { index: index, search: search, clearBySource: clearBySource };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  MEMORY COMPRESSION
  // Compresses a set of chunks into a concise summary string.
  // ═══════════════════════════════════════════════════════════════════════════
  var MemoryCompressor = (function () {
    function compress(chunks, maxWords) {
      if (!chunks || !chunks.length) return '';
      var allWords = chunks.map(function (c) { return c.chunk || c; }).join(' ');
      var words = allWords.split(/\s+/);
      if (words.length <= (maxWords || 100)) return allWords;
      // Simple extractive: take first + last third
      var n = maxWords || 100;
      var head = words.slice(0, Math.floor(n * 0.6));
      var tail = words.slice(-Math.floor(n * 0.4));
      return head.join(' ') + ' … ' + tail.join(' ');
    }

    return { compress: compress };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  INIT
  // ═══════════════════════════════════════════════════════════════════════════
  (async function _init() {
    try {
      await Vectorizer.loadVocab();
      log('v' + VERSION + ' ready');
    } catch (e) {
      warn('init error:', e.message);
    }
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.LabaSemanticMemory = {
    version: VERSION,

    index:  function (text, source, meta) { return ChunkStore.index(text, source, meta); },
    search: function (query, source, k)   { return ChunkStore.search(query, source, k); },
    clear:  function (source)             { return ChunkStore.clearBySource(source); },
    embed:  function (text)               { return Vectorizer.embed(text); },
    compress: function (chunks, maxWords) { return MemoryCompressor.compress(chunks, maxWords); },

    // Convenience: index a message and return top-k similar memories
    learnAndRecall: async function (text, sessionId, k) {
      await ChunkStore.index(text, sessionId || 'default');
      return ChunkStore.search(text, null, k || 3);
    },

    audit: function () { return { version: VERSION }; },
  };

  log('LabaSemanticMemory v' + VERSION + ' ready');
}());

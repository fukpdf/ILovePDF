/**
 * PHASE 2 — LABA WORKFLOW ENGINE
 * window.LabaWorkflowEngine
 *
 * Chat-native DAG workflow engine.
 * Builds workflows from natural language, shows progress cards,
 * supports checkpoint/resume. Wraps WorkflowChainEngine when available.
 * Purely additive. No external deps.
 */
(function () {
  'use strict';

  if (window.LabaWorkflowEngine) return;

  var VERSION = '2.0';
  var LOG     = '[LWE]';
  var DB_NAME = 'lwe_v2';

  function log()  { var a = [].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = [].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function uid()  { return 'wf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  function sys(n) { return window[n] || null; }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  IDB WORKFLOW STORE (checkpoint/resume)
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkflowStore = (function () {
    var _db = null;

    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('workflows')) {
            db.createObjectStore('workflows', { keyPath: 'id' });
          }
        };
        req.onsuccess = function (e) { _db = e.target.result; res(_db); };
        req.onerror   = function ()  { rej(req.error); };
      });
    }

    function save(wf) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction('workflows', 'readwrite');
          tx.objectStore('workflows').put(wf);
          tx.oncomplete = res; tx.onerror = res;
        });
      }).catch(function () {});
    }

    function load(id) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var req = db.transaction('workflows', 'readonly').objectStore('workflows').get(id);
          req.onsuccess = function () { res(req.result || null); };
          req.onerror   = function () { res(null); };
        });
      }).catch(function () { return null; });
    }

    function listAll() {
      return open().then(function (db) {
        return new Promise(function (res) {
          var req = db.transaction('workflows', 'readonly').objectStore('workflows').getAll();
          req.onsuccess = function () { res(req.result || []); };
          req.onerror   = function () { res([]); };
        });
      }).catch(function () { return []; });
    }

    function remove(id) {
      return open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction('workflows', 'readwrite');
          tx.objectStore('workflows').delete(id);
          tx.oncomplete = res; tx.onerror = res;
        });
      }).catch(function () {});
    }

    return { save: save, load: load, listAll: listAll, remove: remove };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  WORKFLOW BUILDER
  // Constructs a serialisable workflow object from steps.
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkflowBuilder = (function () {

    // Known step dependencies (output of A → input of B)
    var STEP_DEPS = {
      'translate':  ['ocr'],
      'summarize':  ['ocr', 'translate'],
      'compress':   [],
      'merge':      [],
      'watermark':  [],
      'sign':       [],
      'protect':    [],
    };

    function create(name, steps, files) {
      var wf = {
        id:          uid(),
        name:        name || 'Workflow',
        steps:       steps.map(function (s, i) {
          return {
            id:       s.id || uid(),
            index:    i,
            type:     s.type,
            label:    s.label || s.type,
            options:  s.options || {},
            deps:     STEP_DEPS[s.type] || [],
            status:   'pending',
            result:   null,
            retries:  0,
          };
        }),
        files:       (files || []).map(function (f) { return { name: f.name, size: f.size, type: f.type }; }),
        status:      'idle',
        currentStep: -1,
        createdAt:   Date.now(),
        updatedAt:   Date.now(),
      };
      return wf;
    }

    function describe(wf) {
      if (!wf || !wf.steps || !wf.steps.length) return 'Empty workflow';
      return wf.steps.map(function (s) { return s.type; }).join(' → ');
    }

    return { create: create, describe: describe };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  PROGRESS CARD RENDERER
  // ═══════════════════════════════════════════════════════════════════════════
  var ProgressCardRenderer = (function () {
    function _injectStyles() {
      if (document.getElementById('lwe-styles')) return;
      var s = document.createElement('style');
      s.id  = 'lwe-styles';
      s.textContent = [
        '.lwe-card{background:#f8f7ff;border:1px solid #ddd6fe;border-radius:12px;padding:12px 14px;margin:6px 0;font-size:12px;}',
        '.lwe-card-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;}',
        '.lwe-card-icon{font-size:16px;}',
        '.lwe-card-title{font-weight:700;color:#4f46e5;flex:1;}',
        '.lwe-card-badge{font-size:10px;background:#4f46e5;color:#fff;border-radius:10px;padding:1px 7px;}',
        '.lwe-steps-list{display:flex;flex-direction:column;gap:4px;}',
        '.lwe-step-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;}',
        '.lwe-step-row.pending{color:#9ca3af;}',
        '.lwe-step-row.running{background:#ede9fe;color:#4f46e5;}',
        '.lwe-step-row.done{color:#16a34a;}',
        '.lwe-step-row.error{color:#dc2626;}',
        '.lwe-step-icon{font-size:13px;width:16px;text-align:center;}',
        '.lwe-step-name{flex:1;}',
        '.lwe-step-msg{font-size:10px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;}',
        '.lwe-progress-bar{height:3px;background:#e5e7eb;border-radius:2px;margin-top:8px;overflow:hidden;}',
        '.lwe-progress-fill{height:100%;background:linear-gradient(90deg,#4f46e5,#7c3aed);border-radius:2px;transition:width .3s;}',
        '.lwe-result-row{margin-top:8px;padding-top:8px;border-top:1px solid #ede9fe;}',
        '.lwe-dl{display:inline-flex;align-items:center;gap:5px;background:#4f46e5;color:#fff;border:none;border-radius:7px;padding:5px 12px;font-size:11px;cursor:pointer;text-decoration:none;}',
        '.lwe-dl:hover{background:#4338ca;}',
      ].join('');
      document.head.appendChild(s);
    }
    _injectStyles();

    function _statusIcon(status) {
      return { pending: '⬜', running: '⏳', done: '✅', error: '❌', skipped: '⏩' }[status] || '⬜';
    }

    function render(wf, el) {
      if (!el) return;
      var done    = wf.steps.filter(function (s) { return s.status === 'done'; }).length;
      var total   = wf.steps.length;
      var pct     = total > 0 ? Math.round((done / total) * 100) : 0;
      var isError = wf.status === 'error';
      var isDone  = wf.status === 'done';

      var html = [
        '<div class="lwe-card">',
        '<div class="lwe-card-header">',
        '<span class="lwe-card-icon">' + (isDone ? '✅' : isError ? '❌' : '🤖') + '</span>',
        '<span class="lwe-card-title">' + (wf.name || 'Workflow') + '</span>',
        '<span class="lwe-card-badge">' + done + '/' + total + '</span>',
        '</div>',
        '<div class="lwe-steps-list">',
      ];

      wf.steps.forEach(function (step) {
        html.push(
          '<div class="lwe-step-row ' + step.status + '">',
          '<span class="lwe-step-icon">' + _statusIcon(step.status) + '</span>',
          '<span class="lwe-step-name">' + step.type + '</span>',
          step.message ? '<span class="lwe-step-msg">' + step.message + '</span>' : '',
          '</div>'
        );
      });

      html.push('</div>');

      // Progress bar
      html.push(
        '<div class="lwe-progress-bar">',
        '<div class="lwe-progress-fill" style="width:' + pct + '%"></div>',
        '</div>'
      );

      // Download button for last result
      if (isDone) {
        var lastDone = wf.steps.slice().reverse().find(function (s) {
          return s.status === 'done' && s.result && s.result.ok &&
                 s.result.result && s.result.result.type === 'file';
        });
        if (lastDone) {
          var r  = lastDone.result.result;
          var url = URL.createObjectURL(r.blob);
          html.push(
            '<div class="lwe-result-row">',
            '<a class="lwe-dl" href="' + url + '" download="' + (r.filename || 'output') + '">',
            '⬇ Download ' + (r.filename || 'result'),
            '</a>',
            '</div>'
          );
        }
      }

      html.push('</div>');
      el.innerHTML = html.join('');
    }

    return { render: render };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  WORKFLOW EXECUTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkflowExecutor = (function () {

    async function execute(wf, files, onUpdate) {
      wf.status     = 'running';
      wf.updatedAt  = Date.now();
      await WorkflowStore.save(wf);

      // Use existing WorkflowChainEngine if available for step adapters
      var WCE = sys('WorkflowChainEngine');
      var sharedCtx = WCE && WCE.SharedDocumentContext
        ? WCE.SharedDocumentContext.create(wf.id, files)
        : { files: files, ocrText: null, translated: null, summary: null };

      var lastFiles = files ? files.slice() : [];

      for (var i = 0; i < wf.steps.length; i++) {
        var step = wf.steps[i];
        step.status  = 'running';
        wf.currentStep = i;
        wf.updatedAt = Date.now();
        await WorkflowStore.save(wf);
        onUpdate && onUpdate(wf, i);

        var ok = false;
        var stepResult = null;

        // Try WorkflowChainEngine adapters first
        if (WCE && WCE.executeStep) {
          try {
            stepResult = await WCE.executeStep(step.type, sharedCtx, step.options);
            ok = !!stepResult;
          } catch (e) { warn('WCE adapter failed for', step.type, ':', e.message); }
        }

        // Use LabaAgentSystem StepExecutor if available
        if (!ok) {
          var LAS = sys('LabaAgentSystem');
          if (LAS && LAS.run) {
            // Build a mini plan with a single step
            var miniTask = await LAS.runSteps([step], lastFiles,
              function (update) {
                step.message = update.message;
                onUpdate && onUpdate(wf, i);
              },
              function () {}
            );
            if (miniTask && miniTask.results && miniTask.results[0]) {
              stepResult = miniTask.results[0].result;
              ok = stepResult && stepResult.ok;
            }
          }
        }

        step.status  = ok ? 'done' : 'error';
        step.result  = stepResult;
        step.message = ok ? 'Done' : 'Failed';

        // Carry output file forward
        if (ok && stepResult && stepResult.result && stepResult.result.type === 'file') {
          var b = stepResult.result.blob;
          var f = new File([b], stepResult.result.filename || 'output.bin', { type: b.type });
          lastFiles = [f];
          sharedCtx.files = lastFiles;
        } else if (ok && stepResult && stepResult.text) {
          sharedCtx.ocrText = sharedCtx.ocrText || stepResult.text;
        } else if (ok && stepResult && stepResult.summary) {
          sharedCtx.summary = stepResult.summary;
        }

        wf.updatedAt = Date.now();
        await WorkflowStore.save(wf);
        onUpdate && onUpdate(wf, i);

        if (!ok) { wf.status = 'error'; break; }
        await new Promise(function (r) { setTimeout(r, 0); });
      }

      if (wf.status !== 'error') wf.status = 'done';
      wf.completedAt = Date.now();
      wf.updatedAt   = Date.now();
      await WorkflowStore.save(wf);
      onUpdate && onUpdate(wf, -1);

      return wf;
    }

    return { execute: execute };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  RESUMED WORKFLOW DETECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var ResumeDetector = (function () {
    async function findInterrupted() {
      var all = await WorkflowStore.listAll();
      var cutoff = Date.now() - 24 * 60 * 60 * 1000; // within 24h
      return all.filter(function (wf) {
        return wf.status === 'running' && wf.updatedAt > cutoff;
      });
    }

    return { findInterrupted: findInterrupted };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  CHAT INTEGRATION
  // Runs a named workflow and renders a live progress card into the chat.
  // ═══════════════════════════════════════════════════════════════════════════
  async function runInChat(name, steps, files, sessionId) {
    var wf = WorkflowBuilder.create(name, steps, files);

    // Find the messages container in the chat panel
    var msgEl   = document.getElementById('lac-messages');
    var cardWrap = null;
    var cardEl  = null;

    if (msgEl) {
      cardWrap = document.createElement('div');
      cardWrap.className = 'lac-msg assistant';
      cardWrap.innerHTML = '<div class="lac-avatar">✦</div><div class="lwe-card-host"></div>';
      msgEl.appendChild(cardWrap);
      cardEl = cardWrap.querySelector('.lwe-card-host');
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    function _onUpdate(wf) {
      if (cardEl) {
        ProgressCardRenderer.render(wf, cardEl);
        if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
      }
    }

    _onUpdate(wf);
    var result = await WorkflowExecutor.execute(wf, files, _onUpdate);

    // Trigger smart suggestions
    var SS = sys('LabaSmartSuggestions');
    if (SS) {
      var lastStep = result.steps && result.steps.slice().reverse().find(function (s) { return s.status === 'done'; });
      if (lastStep) SS.showForTool(lastStep.type, sessionId);
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.LabaWorkflowEngine = {
    version: VERSION,

    create: function (name, steps, files) {
      return WorkflowBuilder.create(name, steps, files);
    },

    describe: function (wf) {
      return WorkflowBuilder.describe(wf);
    },

    execute: function (wf, files, onUpdate) {
      return WorkflowExecutor.execute(wf, files, onUpdate);
    },

    runInChat: runInChat,

    renderCard: function (wf, el) {
      ProgressCardRenderer.render(wf, el);
    },

    save:   function (wf)  { return WorkflowStore.save(wf); },
    load:   function (id)  { return WorkflowStore.load(id); },
    listAll: function ()   { return WorkflowStore.listAll(); },
    remove: function (id)  { return WorkflowStore.remove(id); },

    findInterrupted: function () { return ResumeDetector.findInterrupted(); },

    audit: function () { return { version: VERSION }; },
  };

  log('LabaWorkflowEngine v' + VERSION + ' ready');
}());

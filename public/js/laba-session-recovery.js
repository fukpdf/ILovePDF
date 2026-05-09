/**
 * PHASE 2 — LABA SESSION RECOVERY
 * window.LabaSessionRecovery
 *
 * On-page-load recovery of interrupted workflows, file contexts, and tasks.
 * Offers to resume in the chat panel. Purely additive. No external deps.
 */
(function () {
  'use strict';

  if (window.LabaSessionRecovery) return;

  var VERSION = '2.0';
  var LOG     = '[LSR]';
  var RECOVERY_KEY = 'lsr_last_session';

  function log()  { var a = [].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = [].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  SESSION SNAPSHOT (saved just before unload)
  // ═══════════════════════════════════════════════════════════════════════════
  var SessionSnapshot = (function () {
    function save(data) {
      try {
        var payload = JSON.stringify({ ts: Date.now(), data: data });
        sessionStorage.setItem(RECOVERY_KEY, payload);
        localStorage.setItem(RECOVERY_KEY, payload); // also persist across tabs
      } catch (e) { warn('snapshot save failed:', e.message); }
    }

    function load() {
      try {
        var raw = sessionStorage.getItem(RECOVERY_KEY) || localStorage.getItem(RECOVERY_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        // Only recover within 4 hours
        if (Date.now() - parsed.ts > 4 * 60 * 60 * 1000) return null;
        return parsed.data;
      } catch (e) { return null; }
    }

    function clear() {
      try {
        sessionStorage.removeItem(RECOVERY_KEY);
        localStorage.removeItem(RECOVERY_KEY);
      } catch (e) {}
    }

    return { save: save, load: load, clear: clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  UNLOAD LISTENER (saves state just before page unload)
  // ═══════════════════════════════════════════════════════════════════════════
  function _bindUnloadSave() {
    window.addEventListener('beforeunload', function () {
      try {
        var MEM  = sys('LabaMemorySystem');
        var task = MEM ? MEM.getTask() : null;
        if (!task) return; // nothing to recover

        var snap = {
          task:       task,
          activeFile: MEM ? MEM.getActiveFile() : null,
          ts:         Date.now(),
        };
        SessionSnapshot.save(snap);
      } catch (e) { warn('unload save failed:', e.message); }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  WORKFLOW RECOVERY
  // ═══════════════════════════════════════════════════════════════════════════
  async function _checkInterruptedWorkflows() {
    var LWE = sys('LabaWorkflowEngine');
    if (!LWE) return [];
    try {
      return await LWE.findInterrupted();
    } catch (e) { return []; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  RECOVERY UI INJECTION
  // Shows a restore banner in the chat panel if recovery data is found.
  // ═══════════════════════════════════════════════════════════════════════════
  function _injectStyles() {
    if (document.getElementById('lsr-styles')) return;
    var s = document.createElement('style');
    s.id  = 'lsr-styles';
    s.textContent = [
      '.lsr-banner{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;margin:6px 0;font-size:12px;}',
      '.lsr-banner-title{font-weight:700;color:#92400e;margin-bottom:4px;}',
      '.lsr-banner-body{color:#78350f;margin-bottom:8px;line-height:1.5;}',
      '.lsr-btns{display:flex;gap:6px;}',
      '.lsr-btn{border:none;border-radius:7px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600;}',
      '.lsr-btn.primary{background:#4f46e5;color:#fff;}',
      '.lsr-btn.primary:hover{background:#4338ca;}',
      '.lsr-btn.secondary{background:#f3f4f6;color:#374151;}',
      '.lsr-btn.secondary:hover{background:#e5e7eb;}',
    ].join('');
    document.head.appendChild(s);
  }

  function _appendToChat(html) {
    var msgEl = document.getElementById('lac-messages');
    if (!msgEl) return;
    var wrap = document.createElement('div');
    wrap.className = 'lac-msg assistant';
    wrap.innerHTML = '<div class="lac-avatar">✦</div><div class="lsr-host">' + html + '</div>';
    msgEl.appendChild(wrap);
    msgEl.scrollTop = msgEl.scrollHeight;
    return wrap;
  }

  function _offerSessionRestore(snap) {
    if (!snap || !snap.task) return;
    _injectStyles();

    var html = [
      '<div class="lsr-banner">',
      '<div class="lsr-banner-title">🔄 Resume previous session?</div>',
      '<div class="lsr-banner-body">',
      'Your last session was interrupted.<br>',
      'Active task: <strong>' + snap.task + '</strong>',
      snap.activeFile ? '<br>File context available.' : '',
      '</div>',
      '<div class="lsr-btns">',
      '<button class="lsr-btn primary" id="lsr-resume-btn">Resume</button>',
      '<button class="lsr-btn secondary" id="lsr-dismiss-btn">Dismiss</button>',
      '</div>',
      '</div>',
    ].join('');

    var row = _appendToChat(html);
    if (!row) return;

    var resumeBtn  = row.querySelector('#lsr-resume-btn');
    var dismissBtn = row.querySelector('#lsr-dismiss-btn');

    if (resumeBtn) {
      resumeBtn.addEventListener('click', function () {
        row.remove();
        SessionSnapshot.clear();
        // Inject a "continue where we left off" message into the chat
        var LAC = sys('LabaAiChat');
        if (LAC && LAC.send) LAC.send('Continue where we left off');
      });
    }

    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        row.remove();
        SessionSnapshot.clear();
      });
    }
  }

  function _offerWorkflowResume(workflows) {
    if (!workflows || !workflows.length) return;
    _injectStyles();

    workflows.slice(0, 2).forEach(function (wf) {
      var html = [
        '<div class="lsr-banner">',
        '<div class="lsr-banner-title">⚡ Interrupted workflow found</div>',
        '<div class="lsr-banner-body">',
        '"' + (wf.name || 'Untitled') + '" was interrupted at step ' + ((wf.currentStep || 0) + 1) + '/' + (wf.steps ? wf.steps.length : '?') + '.',
        '<br>Would you like to resume it?',
        '</div>',
        '<div class="lsr-btns">',
        '<button class="lsr-btn primary" data-wfid="' + wf.id + '" id="lsr-wf-resume-' + wf.id + '">Resume</button>',
        '<button class="lsr-btn secondary" data-wfid="' + wf.id + '" id="lsr-wf-dismiss-' + wf.id + '">Dismiss</button>',
        '</div>',
        '</div>',
      ].join('');

      var row = _appendToChat(html);
      if (!row) return;

      var resumeBtn  = row.querySelector('[id^="lsr-wf-resume-"]');
      var dismissBtn = row.querySelector('[id^="lsr-wf-dismiss-"]');

      if (resumeBtn) {
        resumeBtn.addEventListener('click', function () {
          row.remove();
          var LWE = sys('LabaWorkflowEngine');
          if (LWE) LWE.execute(wf, [], function () {});
          else {
            var LAC = sys('LabaAiChat');
            if (LAC && LAC.send) LAC.send('Resume the interrupted workflow "' + wf.name + '"');
          }
        });
      }

      if (dismissBtn) {
        dismissBtn.addEventListener('click', function () {
          row.remove();
          var LWE = sys('LabaWorkflowEngine');
          if (LWE) LWE.remove(wf.id);
        });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  RECENT FILE MEMORY RESTORE
  // After recovery, seeds LabaMemorySystem with any persisted file contexts.
  // ═══════════════════════════════════════════════════════════════════════════
  async function _restoreFileContexts() {
    var MEM = sys('LabaMemorySystem');
    if (!MEM) return;
    try {
      var recentFiles = await MEM.recallRecentFiles(5);
      if (recentFiles.length) {
        log('file contexts available:', recentFiles.map(function (f) { return f.name; }).join(', '));
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  INIT
  // ═══════════════════════════════════════════════════════════════════════════
  async function _init() {
    _bindUnloadSave();

    // Delay so the chat panel has time to render
    await new Promise(function (r) { setTimeout(r, 1200); });

    try {
      // 1. Check for session snapshot
      var snap = SessionSnapshot.load();
      if (snap) _offerSessionRestore(snap);

      // 2. Check for interrupted workflows
      var interrupted = await _checkInterruptedWorkflows();
      if (interrupted.length) _offerWorkflowResume(interrupted);

      // 3. Restore file context metadata
      await _restoreFileContexts();

      log('v' + VERSION + ' recovery check complete');
    } catch (e) {
      warn('recovery check failed:', e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    setTimeout(_init, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.LabaSessionRecovery = {
    version: VERSION,

    saveSnapshot: function (data)   { SessionSnapshot.save(data); },
    loadSnapshot: function ()       { return SessionSnapshot.load(); },
    clearSnapshot: function ()      { SessionSnapshot.clear(); },

    findInterruptedWorkflows: function () { return _checkInterruptedWorkflows(); },

    offerRestore: function (snap)   { _offerSessionRestore(snap); },
    offerResume:  function (wfs)    { _offerWorkflowResume(wfs); },

    audit: function () { return { version: VERSION, hasSnapshot: !!SessionSnapshot.load() }; },
  };

  log('LabaSessionRecovery v' + VERSION + ' ready');
}());

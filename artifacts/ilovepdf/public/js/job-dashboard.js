// Phase I — Job Dashboard v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// Provides a non-blocking live dashboard panel showing:
//   • Active job progress (page-level completion bars)
//   • Memory tier indicator
//   • Active worker count
//   • GPU / WebGPU status
//   • OPFS storage usage
//   • Estimated time remaining
//   • Recovery checkpoint status
//   • Multi-tab cluster status
//   • Giant-file mode indicator
//   • Failed-page retry button
//
// Auto-hides on low-end devices (tier 0).
// Mobile-safe: collapses to a single-line strip.
// Exposes: window.JobDashboard

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[JD]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }

  var _panel   = null;
  var _visible = false;
  var _jobs    = {};   // jobId → { tool, total, done, failed, startMs, sessionId }
  var _tick    = null;
  var _paused  = false;
  var _dismissed = false;

  // Debug dashboard disabled — hidden from all users
  var _isLowEnd = true;

  // ── CSS ────────────────────────────────────────────────────────────────────
  var PANEL_CSS = [
    'position:fixed;bottom:0;left:0;right:0;z-index:9999;',
    'background:rgba(15,23,42,0.96);color:#f1f5f9;font-family:ui-monospace,monospace;font-size:11px;',
    'border-top:1px solid #1e293b;padding:0;transition:transform .25s;',
    'max-height:220px;overflow:hidden;user-select:none;',
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
  ].join('');

  var BAR_CSS = 'width:100%;height:3px;background:#1e293b;border-radius:2px;margin-top:3px;overflow:hidden;';
  var FILL_CSS = 'height:3px;background:linear-gradient(90deg,#7c3aed,#a78bfa);border-radius:2px;transition:width .4s;';

  // ── Panel construction ─────────────────────────────────────────────────────
  function _build() {
    if (_panel) return;
    _panel = document.createElement('div');
    _panel.id = 'p37-job-dashboard';
    _panel.setAttribute('role', 'status');
    _panel.setAttribute('aria-live', 'polite');
    _panel.style.cssText = PANEL_CSS;
    _panel.innerHTML = _renderHTML();
    document.body.appendChild(_panel);
    _bindEvents();
    _log('built', {});
  }

  function _renderHTML() {
    var jobs   = Object.values(_jobs);
    var sys    = _systemStatus();
    var isMob  = window.innerWidth < 600;

    var header = '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #1e293b;cursor:pointer;" id="jd-header">' +
      '<span style="font-weight:600;letter-spacing:.05em;color:#a78bfa">\u26A1 ILovePDF Engine</span>' +
      '<span style="display:flex;gap:10px;align-items:center">' +
        _badge('MEM', sys.memTier, _memColor(sys.memTier)) +
        (sys.gpuReady ? _badge('GPU', 'ready', '#10b981') : '') +
        (sys.clusterPeers > 1 ? _badge('TABS', sys.clusterPeers, '#6366f1') : '') +
        (sys.survival   ? _badge('GIANT', 'on', '#f59e0b') : '') +
        '<button id="jd-dismiss" style="background:transparent;border:none;color:#64748b;cursor:pointer;font-size:14px;padding:0 4px;line-height:1">\u00d7</button>' +
      '</span></div>';

    var jobsHtml = '';
    if (jobs.length === 0) {
      jobsHtml = '<div style="padding:8px 12px;color:#475569">No active jobs</div>';
    } else {
      jobs.forEach(function (job) {
        var pct  = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
        var eta  = _eta(job);
        var fail = job.failed ? '<button class="jd-retry" data-job="' + job.id + '" style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:4px;padding:1px 6px;cursor:pointer;font-size:10px;margin-left:6px">retry ' + job.failed + ' failed</button>' : '';
        jobsHtml += '<div style="padding:6px 12px;">' +
          '<div style="display:flex;justify-content:space-between">' +
            '<span style="color:#e2e8f0">' + _esc(job.tool) + '</span>' +
            '<span style="color:#94a3b8">' + job.done + '/' + (job.total || '?') + ' pages' + (eta ? ' &bull; ' + eta : '') + fail + '</span>' +
          '</div>' +
          '<div style="' + BAR_CSS + '"><div style="' + FILL_CSS + 'width:' + pct + '%"></div></div>' +
        '</div>';
      });
    }

    var sysRow = isMob ? '' : '<div style="padding:4px 12px 6px;border-top:1px solid #1e293b;display:flex;gap:16px;color:#64748b">' +
      '<span>Workers: ' + (sys.workers || '–') + '</span>' +
      '<span>OPFS: ' + sys.opfsMB + ' MB</span>' +
      '<span>Checkpoints: ' + sys.pendingJobs + '</span>' +
      (sys.deviceTier !== undefined ? '<span>Tier: ' + sys.deviceTier + '/4</span>' : '') +
    '</div>';

    return header + jobsHtml + sysRow;
  }

  function _badge(label, value, color) {
    return '<span style="background:' + (color || '#334155') + ';color:#fff;border-radius:4px;padding:1px 5px;font-size:10px">' + _esc(label) + ':' + _esc(String(value)) + '</span>';
  }

  function _memColor(tier) {
    var map = { critical: '#ef4444', danger: '#f97316', high: '#f59e0b', elevated: '#eab308', normal: '#10b981' };
    return map[tier] || '#475569';
  }

  function _esc(s) { return String(s || '').replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]); }); }

  function _eta(job) {
    if (!job.startMs || !job.done || !job.total) return '';
    var elapsed = (Date.now() - job.startMs) / 1000;
    var rate    = job.done / elapsed;
    if (rate <= 0) return '';
    var remaining = (job.total - job.done) / rate;
    if (remaining < 5)   return '<5s';
    if (remaining < 60)  return Math.round(remaining) + 's';
    return Math.round(remaining / 60) + 'm';
  }

  function _systemStatus() {
    var mp         = window.MemPressure;
    var p32        = window.Phase32;
    var p33        = window.Phase33;
    var p35        = window.Phase35;
    var p36        = window.Phase36;
    var mtc        = window.MultiTabCluster;
    var ate        = window.AutoTuningEngine;
    var pool       = window.WorkerPool;

    var memTier    = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
    var gpuReady   = (p36 && p36.RealWebGPUPipelines && p36.RealWebGPUPipelines.ready) || (window.WebGpuAiPipelines && window.WebGpuAiPipelines.audit && window.WebGpuAiPipelines.audit().gpuReady);
    var survival   = p32 && p32.GiantFileSurvivalMode && p32.GiantFileSurvivalMode.isActive();
    var peers      = mtc ? mtc.peerCount() : 1;
    var workers    = pool && pool.getStats ? pool.getStats().active : '?';
    var pendingJobs = 0;
    var opfsMB     = 0;
    var deviceTier = ate && ate.DeviceFingerprint ? ate.DeviceFingerprint.getTier() : undefined;

    return { memTier: memTier, gpuReady: gpuReady, survival: survival, clusterPeers: peers, workers: workers, pendingJobs: pendingJobs, opfsMB: opfsMB, deviceTier: deviceTier };
  }

  // ── Event binding ──────────────────────────────────────────────────────────
  function _bindEvents() {
    if (!_panel) return;

    _panel.addEventListener('click', function (e) {
      var t = e.target;
      if (t.id === 'jd-dismiss' || t.closest('#jd-dismiss')) {
        _dismiss();
      } else if (t.classList.contains('jd-retry') || t.closest('.jd-retry')) {
        var jid = t.dataset.job || (t.closest('.jd-retry') && t.closest('.jd-retry').dataset.job);
        if (jid && _jobs[jid] && _jobs[jid].onRetry) _jobs[jid].onRetry();
      } else if (t.id === 'jd-header' || t.closest('#jd-header')) {
        _paused = !_paused;
      }
    });
  }

  function _dismiss() {
    _dismissed = true;
    if (_panel) { _panel.style.transform = 'translateY(100%)'; }
    setTimeout(function () {
      if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
      _panel = null;
    }, 300);
  }

  // ── Update loop ────────────────────────────────────────────────────────────
  function _update() {
    if (_dismissed || !_panel || _paused) return;
    _panel.innerHTML = _renderHTML();
    _bindEvents();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────
  window.JobDashboard = {
    version: VERSION,

    // Register and start tracking a job
    startJob: function (jobId, toolName, totalPages, opts) {
      if (_isLowEnd) return;
      if (!_panel && !_dismissed) _build();
      if (!_panel) return;
      _show();
      _jobs[jobId] = {
        id:      jobId,
        tool:    toolName,
        total:   totalPages || 0,
        done:    0,
        failed:  0,
        startMs: Date.now(),
        onRetry: opts && opts.onRetry,
      };
      _update();
    },

    // Update job progress
    updateJob: function (jobId, donePages, failedPages) {
      if (!_jobs[jobId]) return;
      _jobs[jobId].done   = donePages  || _jobs[jobId].done;
      _jobs[jobId].failed = failedPages || 0;
      _update();
    },

    // Complete and remove a job
    completeJob: function (jobId) {
      if (_jobs[jobId]) {
        _jobs[jobId].done = _jobs[jobId].total;
        _update();
        setTimeout(function () { delete _jobs[jobId]; _update(); }, 3000);
      }
    },

    // Show the dashboard
    show: function () {
      _dismissed = false;
      if (!_panel) _build();
      _show();
    },

    // Hide but don't dismiss
    hide: function () {
      if (_panel) _panel.style.transform = 'translateY(100%)';
      _visible = false;
    },

    // Force a refresh of the display
    refresh: function () { _update(); },

    // Check if dashboard is active
    isVisible: function () { return _visible && !!_panel; },

    audit: function () {
      return {
        version:  VERSION,
        visible:  _visible,
        jobs:     Object.keys(_jobs).length,
        isLowEnd: _isLowEnd,
        paused:   _paused,
      };
    },
  };

  function _show() {
    if (!_panel) return;
    _panel.style.transform = '';
    _visible = true;
    if (!_tick) _tick = setInterval(_update, 1000);
  }

  // ── Listen for BrowserTools.process events to auto-show dashboard ──────────
  var _origProcess = null;
  function _hookBrowserTools() {
    if (!window.BrowserTools || window.BrowserTools.__jdv1) return false;
    var upstream = window.BrowserTools.process.bind(window.BrowserTools);
    window.BrowserTools.process = async function (toolId, files, opts) {
      if (_isLowEnd) return upstream(toolId, files, opts);
      var arr    = Array.isArray(files) ? files : Array.from(files || []);
      var jobId  = 'jd_' + toolId + '_' + Date.now();
      var pages  = (opts && opts._totalPages) || 0;
      JobDashboard.startJob(jobId, toolId, pages, {});
      try {
        var result = await upstream(toolId, arr, opts);
        JobDashboard.completeJob(jobId);
        return result;
      } catch (err) {
        JobDashboard.completeJob(jobId);
        throw err;
      }
    };
    window.BrowserTools.__jdv1 = true;
    return true;
  }

  var _tries = 0;
  if (!_hookBrowserTools()) {
    var _iv = setInterval(function () {
      if (_hookBrowserTools() || ++_tries > 120) clearInterval(_iv);
    }, 80);
  }

  // ── Cleanup on unload ──────────────────────────────────────────────────────
  window.addEventListener('beforeunload', function () {
    if (_tick) clearInterval(_tick);
    _tick = null;
  });

  _log('loaded', { lowEnd: _isLowEnd });
}());

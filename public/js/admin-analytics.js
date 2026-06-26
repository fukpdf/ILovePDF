// admin-analytics.js — Phase 6.2: Admin Analytics Dashboard Engine
// =====================================================================
// Browser-side ONLY. Reads directly from localStorage (same origin).
// Exposes: window.AdminAnalytics
//
// Data sources (read-only, never written):
//   'ilpdf_ae_v1'         — visitor profile (Phase 6.1 AnalyticsEngine)
//   'iplv_tool_pop_v2'    — tool opens per slug (RuntimeSessionIntel)
//   'iplv_engagement_v2'  — per-tool p/d/f/r stats (RuntimeToolEngagement)
//   'ilpdf_visits_v1'     — simple visit counter (AdResponsiveEngine)
//
// Performance: all rendering is deferred via requestIdleCallback.
// Security: read-only. Zero localStorage writes. Zero external calls.
// =====================================================================
(function (G) {
  'use strict';
  if (G.AdminAnalytics) return;

  var LOG = '[AA]';

  // ── Known tool slug → display name map ───────────────────────────────────
  var TOOL_NAMES = {
    'merge-pdf':        'Merge PDF',
    'split-pdf':        'Split PDF',
    'rotate-pdf':       'Rotate PDF',
    'crop-pdf':         'Crop PDF',
    'organize-pdf':     'Organize PDF',
    'compress-pdf':     'Compress PDF',
    'protect-pdf':      'Protect PDF',
    'unlock-pdf':       'Unlock PDF',
    'crop-image':       'Crop Image',
    'resize-image':     'Resize Image',
    'image-filters':    'Image Filters',
    'image-compressor': 'Image Compressor',
    'image-converter':  'Image Converter',
    'background-remover':'Background Remover',
    'watermark-pdf':    'Watermark PDF',
    'add-page-numbers': 'Add Page Numbers',
    'edit-pdf':         'Edit PDF',
    'sign-pdf':         'Sign PDF',
    'redact-pdf':       'Redact PDF',
    'jpg-to-pdf':       'JPG to PDF',
    'pdf-to-jpg':       'PDF to JPG',
    'pdf-to-png':       'PDF to PNG',
    'pdf-to-word':      'PDF to Word',
    'pdf-to-excel':     'PDF to Excel',
    'pdf-to-ppt':       'PDF to PPT',
    'word-to-pdf':      'Word to PDF',
    'excel-to-pdf':     'Excel to PDF',
    'ppt-to-pdf':       'PPT to PDF',
    'html-to-pdf':      'HTML to PDF',
    'ocr-pdf':          'OCR PDF',
    'repair-pdf':       'Repair PDF',
    'compare-pdf':      'Compare PDF',
    'ai-summarizer':    'AI Summarizer',
    'translate-pdf':    'Translate PDF',
  };

  // ── Safe helpers ──────────────────────────────────────────────────────────
  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }
  function _lsGet(k) { return _s(function () { return JSON.parse(localStorage.getItem(k)); }); }
  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function pct(num, den) {
    if (!den || den === 0) return 0;
    return Math.min(100, Math.round((num / den) * 100));
  }
  function fmtNum(n) {
    return (n || 0).toLocaleString();
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function toolName(slug) {
    return TOOL_NAMES[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  // ── Load all data from localStorage ──────────────────────────────────────
  function loadData() {
    var profile  = _lsGet('ilpdf_ae_v1') || {};
    var popRaw   = _lsGet('iplv_tool_pop_v2') || {};
    var engRaw   = _lsGet('iplv_engagement_v2') || {};
    var visits   = _lsGet('ilpdf_visits_v1') || {};

    // Merge tool slugs from both sources
    var allSlugs = {};
    Object.keys(popRaw).forEach(function (s) { allSlugs[s] = 1; });
    Object.keys(engRaw).forEach(function (s) { allSlugs[s] = 1; });

    var tools = Object.keys(allSlugs).map(function (slug) {
      var e = engRaw[slug] || {};
      var opens      = popRaw[slug] || 0;
      var processed  = e.p || 0;
      var downloaded = e.d || 0;
      var failed     = e.f || 0;
      var retries    = e.r || 0;
      var complRate  = processed > 0 ? pct(downloaded, processed) : 0;
      return {
        slug:       slug,
        name:       toolName(slug),
        opens:      opens,
        processed:  processed,
        downloaded: downloaded,
        failed:     failed,
        retries:    retries,
        complRate:  complRate,
        lastSeen:   e.ts || null,
      };
    });

    // Aggregate totals
    var totalOpens     = tools.reduce(function (s, t) { return s + t.opens; }, 0);
    var totalProcessed = tools.reduce(function (s, t) { return s + t.processed; }, 0);
    var totalDownloaded= tools.reduce(function (s, t) { return s + t.downloaded; }, 0);
    var totalFailed    = tools.reduce(function (s, t) { return s + t.failed; }, 0);
    var totalRetries   = tools.reduce(function (s, t) { return s + t.retries; }, 0);

    var visitCount  = profile.visitCount || visits.count || 0;
    var totalUploads = profile.totalUploads || 0;
    var totalDLs     = profile.totalDownloads || 0;

    var overallCompl = totalProcessed > 0 ? pct(totalDownloaded, totalProcessed) : 0;

    // Abandonment analysis
    // Opens → Processed: abandoned before processing
    var abandonUpload   = Math.max(0, totalOpens - totalProcessed);
    // Processed → Downloaded: abandoned before download
    var abandonDownload = Math.max(0, totalProcessed - totalDownloaded);
    // Downloaded but not "completed" (approximated by failures + diff)
    var abandonComplete = totalFailed;

    // Device detection (current device only — no persistent breakdown)
    var ua = navigator.userAgent || '';
    var deviceType = 'desktop';
    if (/iPad/.test(ua)) deviceType = 'tablet';
    else if (/iPhone|iPod/.test(ua)) deviceType = 'mobile';
    else if (/Android/.test(ua) && /Mobile/.test(ua)) deviceType = 'mobile';
    else if (/Android/.test(ua)) deviceType = 'tablet';
    else if (/Tablet/.test(ua)) deviceType = 'tablet';
    var orientation = (window.innerWidth > window.innerHeight) ? 'landscape' : 'portrait';

    return {
      profile:         profile,
      tools:           tools,
      totalOpens:      totalOpens,
      totalProcessed:  totalProcessed,
      totalDownloaded: totalDownloaded,
      totalFailed:     totalFailed,
      totalRetries:    totalRetries,
      totalUploads:    totalUploads,
      totalDLs:        totalDLs,
      visitCount:      visitCount,
      overallCompl:    overallCompl,
      abandonUpload:   abandonUpload,
      abandonDownload: abandonDownload,
      abandonComplete: abandonComplete,
      deviceType:      deviceType,
      orientation:     orientation,
      isReturning:     visitCount > 1,
      firstVisit:      profile.firstVisit || null,
      lastVisit:       profile.lastVisit || null,
    };
  }

  // ── Sort state for tool table ─────────────────────────────────────────────
  var _sortCol = 'downloaded';
  var _sortAsc = false;

  // ── Render: overview metric cards ─────────────────────────────────────────
  function renderMetrics(d) {
    var el = document.getElementById('aa-metrics');
    if (!el) return;

    var sessionDurNote = d.profile.sessionCount ? '~' + d.profile.sessionCount + ' sessions' : 'First visit';

    el.innerHTML = [
      metricCard('Sessions', fmtNum(d.visitCount), sessionDurNote, 'muted', 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'),
      metricCard('Tool Opens', fmtNum(d.totalOpens), d.tools.filter(function(t){return t.opens>0;}).length + ' tools used', 'muted', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'),
      metricCard('Uploads', fmtNum(d.totalUploads || d.totalProcessed), '', 'muted', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'),
      metricCard('Downloads', fmtNum(d.totalDLs || d.totalDownloaded), '', 'muted', 'M12 15V3m0 12l-4-4m4 4l4-4'),
      metricCard('Completed Jobs', fmtNum(d.totalDownloaded), '', 'muted', 'M22 11.08V12a10 10 0 1 1-5.93-9.14'),
      metricCard('Returning Users', d.isReturning ? 'Yes' : 'New User', d.visitCount > 1 ? d.visitCount + ' visits' : 'First visit ever', d.isReturning ? '' : 'warn', 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'),
      metricCard('Completion Rate', d.overallCompl + '%', 'Process → Download', d.overallCompl >= 60 ? '' : (d.overallCompl >= 30 ? 'warn' : 'warn'), 'M18 20V10'),
      metricCard('Failures', fmtNum(d.totalFailed), d.totalRetries + ' retries', d.totalFailed > 0 ? 'warn' : 'muted', 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z'),
    ].join('');
  }

  function metricCard(label, value, sub, subClass, path) {
    return '<div class="aa-metric-card">' +
      '<div class="aa-metric-icon"><svg viewBox="0 0 24 24"><path d="' + path + '"/></svg></div>' +
      '<div class="aa-metric-value">' + esc(value) + '</div>' +
      '<div class="aa-metric-label">' + esc(label) + '</div>' +
      (sub ? '<div class="aa-metric-sub ' + subClass + '">' + esc(sub) + '</div>' : '') +
    '</div>';
  }

  // ── Render: tool performance table ────────────────────────────────────────
  function renderToolTable(tools) {
    var el = document.getElementById('aa-tool-table-body');
    var thead = document.getElementById('aa-tool-table-head');
    if (!el) return;

    // Update header sort indicators
    if (thead) {
      thead.querySelectorAll('th[data-col]').forEach(function (th) {
        th.classList.remove('sorted', 'asc');
        if (th.dataset.col === _sortCol) {
          th.classList.add('sorted');
          if (_sortAsc) th.classList.add('asc');
        }
      });
    }

    var sorted = tools.slice().sort(function (a, b) {
      var va = a[_sortCol] !== undefined ? a[_sortCol] : 0;
      var vb = b[_sortCol] !== undefined ? b[_sortCol] : 0;
      return _sortAsc ? va - vb : vb - va;
    });

    if (!sorted.length) {
      el.innerHTML = '<tr><td colspan="7"><div class="aa-empty">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
        'No tool usage data yet. Use a tool on the main site first.' +
        '</div></td></tr>';
      return;
    }

    el.innerHTML = sorted.map(function (t) {
      var rateClass = t.complRate >= 60 ? 'aa-cell-success' : (t.complRate >= 30 ? 'aa-cell-warn' : (t.complRate > 0 ? 'aa-cell-danger' : 'aa-cell-muted'));
      var barClass  = t.complRate >= 60 ? '' : (t.complRate >= 30 ? 'warn' : 'danger');
      return '<tr>' +
        '<td class="aa-cell-name">' + esc(t.name) + '</td>' +
        '<td>' + fmtNum(t.opens) + '</td>' +
        '<td>' + fmtNum(t.processed) + '</td>' +
        '<td>' + fmtNum(t.downloaded) + '</td>' +
        '<td>' +
          '<div class="aa-bar-wrap">' +
            '<div class="aa-bar-bg"><div class="aa-bar-fill ' + barClass + '" style="width:' + t.complRate + '%"></div></div>' +
            '<span class="' + rateClass + '">' + t.complRate + '%</span>' +
          '</div>' +
        '</td>' +
        '<td class="' + (t.failed > 0 ? 'aa-cell-warn' : 'aa-cell-muted') + '">' + fmtNum(t.failed) + '</td>' +
        '<td class="aa-cell-muted">' + fmtNum(t.retries) + '</td>' +
      '</tr>';
    }).join('');
  }

  // ── Render: funnel ────────────────────────────────────────────────────────
  function renderFunnel(d) {
    var el = document.getElementById('aa-funnel');
    if (!el) return;

    var steps = [
      { label: 'Sessions / Visits', count: d.visitCount,      color: '#6366f1' },
      { label: 'Tool Opens',        count: d.totalOpens,       color: '#3b82f6' },
      { label: 'Files Processed',   count: d.totalProcessed,   color: '#8b5cf6' },
      { label: 'Downloads Reached', count: d.totalDownloaded,  color: '#10b981' },
      { label: 'Completed Jobs',    count: d.totalDownloaded,  color: '#059669' },
    ];

    var html = '';
    steps.forEach(function (step, i) {
      html += '<div class="aa-funnel-step">' +
        '<div class="aa-funnel-dot" style="background:' + step.color + '"></div>' +
        '<div class="aa-funnel-label">' + esc(step.label) + '</div>' +
        '<div class="aa-funnel-count">' + fmtNum(step.count) + '</div>' +
        '<div class="aa-funnel-pct">' + (i === 0 ? '100%' : pct(step.count, steps[0].count) + '%') + '</div>' +
      '</div>';

      if (i < steps.length - 1) {
        var nextCount = steps[i + 1].count;
        var drop = step.count > 0 ? pct(step.count - nextCount, step.count) : 0;
        if (drop > 0) {
          html += '<div class="aa-funnel-connector">└ <span class="drop">−' + drop + '% drop-off</span></div>';
        } else {
          html += '<div class="aa-funnel-connector">↓</div>';
        }
      }
    });

    el.innerHTML = html || '<div class="aa-empty">No funnel data yet.</div>';
  }

  // ── Render: device breakdown ──────────────────────────────────────────────
  function renderDevice(d) {
    var el = document.getElementById('aa-device');
    if (!el) return;

    // We show current-session device (no persistent breakdown in this build)
    // Future: RuntimeSessionIntel persists aggregate counts via RuntimeAnalytics flush
    var rows = [
      { label: 'Desktop',   value: d.deviceType === 'desktop' ? 1 : 0, color: 'color-desktop' },
      { label: 'Tablet',    value: d.deviceType === 'tablet'  ? 1 : 0, color: 'color-tablet'  },
      { label: 'Mobile',    value: (d.deviceType === 'mobile' || d.deviceType === 'ios' || d.deviceType === 'android') ? 1 : 0, color: 'color-mobile' },
      { label: 'Portrait',  value: d.orientation === 'portrait'  ? 1 : 0, color: 'color-portrait' },
      { label: 'Landscape', value: d.orientation === 'landscape' ? 1 : 0, color: 'color-landscape' },
    ];

    var active = rows.filter(function (r) { return r.value; });
    if (!active.length) active = [rows[0]]; // default desktop

    el.innerHTML = '<div class="aa-device-list">' +
      rows.map(function (r) {
        return '<div class="aa-device-row">' +
          '<div class="aa-device-label">' + esc(r.label) + '</div>' +
          '<div class="aa-device-bar-bg"><div class="aa-device-bar-fill ' + r.color + '" style="width:' + (r.value * 100) + '%"></div></div>' +
          '<div class="aa-device-count">' + (r.value ? 'Yes' : '—') + '</div>' +
        '</div>';
      }).join('') +
    '</div>' +
    '<div class="aa-updated">Current session: <strong>' + esc(d.deviceType) + ' · ' + esc(d.orientation) + '</strong>. Aggregate breakdown accumulates with RuntimeSessionIntel over multiple sessions.</div>';
  }

  // ── Render: return visitor analytics ─────────────────────────────────────
  function renderVisitors(d) {
    var el = document.getElementById('aa-visitors');
    if (!el) return;

    var returningPct = d.visitCount > 1 ? Math.min(99, Math.round((1 - 1/d.visitCount) * 100)) : 0;
    var newPct = 100 - returningPct;

    el.innerHTML =
      '<div class="aa-visitor-grid">' +
        '<div class="aa-visitor-stat"><div class="aa-visitor-stat-value">' + fmtNum(d.visitCount) + '</div><div class="aa-visitor-stat-label">Total Visits</div></div>' +
        '<div class="aa-visitor-stat"><div class="aa-visitor-stat-value">' + returningPct + '%</div><div class="aa-visitor-stat-label">Returning Rate</div></div>' +
        '<div class="aa-visitor-stat"><div class="aa-visitor-stat-value">' + esc(fmtDate(d.firstVisit)) + '</div><div class="aa-visitor-stat-label">First Visit</div></div>' +
        '<div class="aa-visitor-stat"><div class="aa-visitor-stat-value">' + esc(fmtDate(d.lastVisit)) + '</div><div class="aa-visitor-stat-label">Last Visit</div></div>' +
      '</div>' +
      '<div class="aa-donut-row">' +
        '<canvas id="aa-visitor-chart" width="80" height="80"></canvas>' +
        '<div class="aa-donut-legend">' +
          '<div class="aa-legend-item"><div class="aa-legend-dot" style="background:#6366f1"></div> Returning: ' + returningPct + '%</div>' +
          '<div class="aa-legend-item"><div class="aa-legend-dot" style="background:#e2e8f0"></div> New: ' + newPct + '%</div>' +
        '</div>' +
      '</div>';

    // Draw simple donut on canvas
    setTimeout(function () {
      var cv = document.getElementById('aa-visitor-chart');
      if (!cv) return;
      var ctx = cv.getContext('2d');
      var cx = 40, cy = 40, r = 32, lw = 12;
      var retAngle = (returningPct / 100) * Math.PI * 2;
      ctx.clearRect(0, 0, 80, 80);
      // background arc
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = lw; ctx.stroke();
      // returning arc
      if (returningPct > 0) {
        ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + retAngle);
        ctx.strokeStyle = '#6366f1'; ctx.lineWidth = lw; ctx.stroke();
      }
      // center text
      ctx.fillStyle = '#0f172a'; ctx.font = 'bold 14px Inter,system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(returningPct + '%', cx, cy);
    }, 50);
  }

  // ── Render: ad opportunity ────────────────────────────────────────────────
  function renderAds(d) {
    var el = document.getElementById('aa-ads');
    if (!el) return;

    // Ad opportunities are estimated from tool usage events:
    // Each upload = potential UPLOAD_AD_VISIBLE
    // Each processed = potential PREVIEW_AD_VISIBLE
    // Each downloaded = potential DOWNLOAD_AD_VISIBLE
    // Mobile sessions = MOBILE_STICKY_VISIBLE (estimated ~all if mobile)
    var isMobile = d.deviceType !== 'desktop';

    var slots = [
      { id: 'Upload Banner (Ezoic 201)', count: d.totalProcessed, badge: d.totalProcessed > 0 ? 'good' : 'none', badgeLabel: d.totalProcessed > 0 ? 'Active' : 'No data' },
      { id: 'Preview Banner (Ezoic 202)', count: d.totalDownloaded, badge: d.totalDownloaded > 0 ? 'good' : 'none', badgeLabel: d.totalDownloaded > 0 ? 'Active' : 'No data' },
      { id: 'Download Banner (Ezoic 104)', count: d.totalDownloaded, badge: d.totalDownloaded > 0 ? 'good' : 'none', badgeLabel: d.totalDownloaded > 0 ? 'Active' : 'No data' },
      { id: 'Mobile Sticky (Ezoic 106)', count: isMobile ? d.totalOpens : 0, badge: isMobile ? 'good' : 'warn', badgeLabel: isMobile ? 'Mobile active' : 'Desktop session' },
      { id: 'Home Hero (Ezoic 101)', count: d.visitCount, badge: d.visitCount > 0 ? 'good' : 'none', badgeLabel: d.visitCount > 0 ? 'Active' : 'No data' },
    ];

    el.innerHTML = '<div class="aa-ad-grid">' +
      slots.map(function (s) {
        return '<div class="aa-ad-row">' +
          '<div class="aa-ad-slot">' + esc(s.id) + '</div>' +
          '<div class="aa-ad-count">' + fmtNum(s.count) + '</div>' +
          '<div class="aa-ad-badge ' + s.badge + '">' + esc(s.badgeLabel) + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // ── Render: top tools ─────────────────────────────────────────────────────
  function renderTopTools(tools, mode) {
    var elId = { downloads: 'aa-top-dl', complRate: 'aa-top-compl', opens: 'aa-top-opens' };
    var el = document.getElementById(elId[mode]);
    if (!el) return;

    var sorted = tools.slice()
      .filter(function (t) { return t[mode] > 0; })
      .sort(function (a, b) { return b[mode] - a[mode]; })
      .slice(0, 10);

    if (!sorted.length) { el.innerHTML = '<div class="aa-empty">No data yet.</div>'; return; }

    var maxVal = sorted[0][mode] || 1;
    el.innerHTML = '<div class="aa-top-list">' +
      sorted.map(function (t, i) {
        return '<div class="aa-top-row">' +
          '<div class="aa-top-rank">#' + (i + 1) + '</div>' +
          '<div class="aa-top-name" title="' + esc(t.name) + '">' + esc(t.name) + '</div>' +
          '<div class="aa-top-bar-bg"><div class="aa-top-bar-fill" style="width:' + pct(t[mode], maxVal) + '%"></div></div>' +
          '<div class="aa-top-val">' + (mode === 'complRate' ? t[mode] + '%' : fmtNum(t[mode])) + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // ── Render: abandonment analysis ─────────────────────────────────────────
  function renderAbandonment(d) {
    var el = document.getElementById('aa-abandonment');
    if (!el) return;

    var stages = [
      {
        label: 'Opened tool → No processing',
        count: d.abandonUpload,
        total: d.totalOpens,
        desc: 'Users who opened a tool page but never processed a file',
      },
      {
        label: 'Processed → No download',
        count: d.abandonDownload,
        total: d.totalProcessed,
        desc: 'Files processed but user never reached the download step',
      },
      {
        label: 'Processing failures',
        count: d.abandonComplete,
        total: d.totalProcessed,
        desc: 'Jobs that ended in an error or failure',
      },
    ];

    el.innerHTML = '<div class="aa-abandon-list">' +
      stages.map(function (s) {
        var p = pct(s.count, s.total);
        return '<div class="aa-abandon-row" title="' + esc(s.desc) + '">' +
          '<div class="aa-abandon-stage">' + esc(s.label) + '</div>' +
          '<div class="aa-abandon-count">' + fmtNum(s.count) + '</div>' +
          '<div class="aa-abandon-pct">' + (s.total > 0 ? p + '%' : '—') + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // ── Sort handler wiring ───────────────────────────────────────────────────
  function wireSortHeaders(tools) {
    var thead = document.getElementById('aa-tool-table-head');
    if (!thead) return;
    thead.querySelectorAll('th[data-col]').forEach(function (th) {
      th.addEventListener('click', function () {
        var col = th.dataset.col;
        if (_sortCol === col) { _sortAsc = !_sortAsc; }
        else { _sortCol = col; _sortAsc = false; }
        renderToolTable(tools);
      });
    });
  }

  // ── Export: JSON ──────────────────────────────────────────────────────────
  function exportJSON() {
    var d = loadData();
    var payload = {
      exportedAt:   new Date().toISOString(),
      overview: {
        sessions:       d.visitCount,
        toolOpens:      d.totalOpens,
        uploads:        d.totalUploads || d.totalProcessed,
        downloads:      d.totalDLs || d.totalDownloaded,
        completedJobs:  d.totalDownloaded,
        failures:       d.totalFailed,
        retries:        d.totalRetries,
        completionRate: d.overallCompl + '%',
        isReturning:    d.isReturning,
      },
      visitorProfile: {
        visitCount:  d.visitCount,
        firstVisit:  fmtDate(d.firstVisit),
        lastVisit:   fmtDate(d.lastVisit),
        deviceType:  d.deviceType,
        orientation: d.orientation,
      },
      tools:    d.tools,
      abandonment: {
        abandonedAtUpload:    d.abandonUpload,
        abandonedAtDownload:  d.abandonDownload,
        failedJobs:           d.abandonComplete,
      },
    };
    _downloadFile(
      JSON.stringify(payload, null, 2),
      'ilpdf-analytics-' + new Date().toISOString().slice(0, 10) + '.json',
      'application/json'
    );
  }

  // ── Export: CSV ───────────────────────────────────────────────────────────
  function exportCSV() {
    var d = loadData();
    var rows = [
      ['Tool', 'Opens', 'Processed', 'Downloaded', 'Completion %', 'Failed', 'Retries'],
    ];
    d.tools.forEach(function (t) {
      rows.push([t.name, t.opens, t.processed, t.downloaded, t.complRate, t.failed, t.retries]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    _downloadFile(
      csv,
      'ilpdf-tools-' + new Date().toISOString().slice(0, 10) + '.csv',
      'text/csv'
    );
  }

  function _downloadFile(content, filename, mime) {
    var blob = new Blob([content], { type: mime });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  // ── Render: Analytics Sync Layer panel (Phase 6.3) ───────────────────────
  // Reads ilpdf_sync_v1, ilpdf_batches_v1, ilpdf_retry_v1 from localStorage.
  // Does NOT require window.AnalyticsSync to be loaded (same pattern as all
  // other widgets — data source is localStorage, never a runtime dependency).
  function syncMetricCard(label, value, sub, subClass) {
    return '<div class="aa-sync-metric">' +
      '<div class="aa-sync-metric-value">' + esc(value) + '</div>' +
      '<div class="aa-sync-metric-label">' + esc(label) + '</div>' +
      (sub ? '<div class="aa-metric-sub ' + (subClass || 'muted') + '">' + esc(sub) + '</div>' : '') +
    '</div>';
  }

  function renderSync() {
    var el = document.getElementById('aa-sync-panel');
    if (!el) return;

    var queueRaw   = _lsGet('ilpdf_sync_v1')   || {};
    var batchesRaw = _lsGet('ilpdf_batches_v1') || {};
    var retryRaw   = _lsGet('ilpdf_retry_v1')   || {};

    var events     = Array.isArray(queueRaw.events)     ? queueRaw.events     : [];
    var batches    = Array.isArray(batchesRaw.batches)  ? batchesRaw.batches  : [];
    var dlq        = Array.isArray(retryRaw.dlq)        ? retryRaw.dlq        : [];

    var queueSize    = events.length;
    var dropped      = queueRaw.droppedCount  || 0;
    var totalEnq     = queueRaw.totalEnqueued || 0;
    var retried      = (retryRaw.stats && retryRaw.stats.totalRetried) || 0;
    var dlqSize      = dlq.length;
    var batchCount   = batches.length;
    var pendingEvents= events.filter(function(e){ return !e.batchId; }).length;

    var lastFlushStr = '—';
    if (batchesRaw.savedAt) {
      lastFlushStr = new Date(batchesRaw.savedAt).toLocaleTimeString();
    }

    var lastBatchStr = '—';
    var avgBatchMs   = '—';
    if (batches.length) {
      var last = batches[batches.length - 1];
      if (last && last.createdAt) lastBatchStr = new Date(last.createdAt).toLocaleTimeString();
      var times = batches.map(function(b){ return b.avgProcessTimeMs || 0; });
      avgBatchMs = Math.round(times.reduce(function(a,b){ return a + b; }, 0) / times.length) + 'ms';
    }

    var syncStatus = totalEnq > 0 ? 'active' : 'idle';
    var syncStatusClass = syncStatus === 'active' ? '' : 'muted';

    var providerNames = ['Firebase Analytics','Cloudflare Worker','Google Analytics 4','Microsoft Clarity','Self-hosted Endpoint'];

    el.innerHTML =
      '<div class="aa-sync-grid">' +
        syncMetricCard('Queue Size',      fmtNum(queueSize),   'Max 200 events',           queueSize > 150 ? 'warn' : 'muted') +
        syncMetricCard('Pending Events',  fmtNum(pendingEvents),'Awaiting batching',        pendingEvents > 50 ? 'warn' : 'muted') +
        syncMetricCard('Dropped Events',  fmtNum(dropped),     'FIFO drops (over limit)',   dropped > 0 ? 'warn' : 'muted') +
        syncMetricCard('Retry Count',     fmtNum(retried),     'DLQ size: ' + dlqSize,      retried > 0 ? 'warn' : 'muted') +
        syncMetricCard('Batches Formed',  fmtNum(batchCount),  'Last: ' + lastBatchStr,     'muted') +
        syncMetricCard('Avg Batch Time',  avgBatchMs,          'Simulation only',            'muted') +
        syncMetricCard('Last Flush',      lastFlushStr,        'pagehide / interval',        'muted') +
        syncMetricCard('Sync Status',     syncStatus,          fmtNum(totalEnq) + ' lifetime events', syncStatusClass) +
      '</div>' +
      '<div class="aa-sync-providers">' +
        '<div class="aa-sync-provider-title">Provider Status (all disabled — Phase 6.3 simulation)</div>' +
        '<div class="aa-sync-provider-grid">' +
          providerNames.map(function(name) {
            return '<div class="aa-sync-provider-row">' +
              '<div class="aa-sync-provider-name">' + esc(name) + '</div>' +
              '<div class="aa-sync-provider-badge">Disabled</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="aa-updated">Data from <code>ilpdf_sync_v1</code>, <code>ilpdf_batches_v1</code>, <code>ilpdf_retry_v1</code>. ' +
      'Populated by <code>window.AnalyticsSync</code> on tool pages. Activate a provider in Phase 6.4 to enable real sync.</div>';
  }

  // ── Full render ───────────────────────────────────────────────────────────
  function render() {
    var d = loadData();
    renderMetrics(d);
    renderToolTable(d.tools);
    renderFunnel(d);
    renderDevice(d);
    renderVisitors(d);
    renderAds(d);
    renderTopTools(d.tools, 'downloads');
    renderTopTools(d.tools, 'complRate');
    renderTopTools(d.tools, 'opens');
    renderAbandonment(d);
    renderSync();
    wireSortHeaders(d.tools);

    var ts = document.getElementById('aa-refresh-ts');
    if (ts) ts.textContent = 'Updated ' + new Date().toLocaleTimeString();

    console.debug(LOG, 'Dashboard rendered —', d.tools.length, 'tools,', d.totalOpens, 'total opens');
    return d;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _boot, { once: true });
    } else {
      _boot();
    }
  }

  function _scrollTo(id) {
    var el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function _boot() {
    var doRender = function () { render(); };
    if (G.requestIdleCallback) {
      G.requestIdleCallback(doRender, { timeout: 1500 });
    } else {
      setTimeout(doRender, 0);
    }

    // Wire header export + refresh buttons
    var btnJson    = document.getElementById('aa-export-json');
    var btnCsv     = document.getElementById('aa-export-csv');
    var btnRefresh = document.getElementById('aa-refresh-btn');
    if (btnJson)    btnJson.addEventListener('click', exportJSON);
    if (btnCsv)     btnCsv.addEventListener('click',  exportCSV);
    if (btnRefresh) btnRefresh.addEventListener('click', function () { render(); });

    // Wire sidebar export shortcuts
    var sjBtn = document.getElementById('sidebar-export-json');
    var scBtn = document.getElementById('sidebar-export-csv');
    if (sjBtn) sjBtn.addEventListener('click', exportJSON);
    if (scBtn) scBtn.addEventListener('click',  exportCSV);

    // Wire [data-scroll] nav items — smooth-scroll to sections
    document.querySelectorAll('[data-scroll]').forEach(function (el) {
      el.addEventListener('click', function () { _scrollTo(el.dataset.scroll); });
      el.style.cursor = 'pointer';
    });
  }

  init();

  // ── Expose ────────────────────────────────────────────────────────────────
  G.AdminAnalytics = Object.freeze({
    render:     render,
    loadData:   loadData,
    exportJSON: exportJSON,
    exportCSV:  exportCSV,
  });

  console.debug(LOG, 'AdminAnalytics ready');

}(window));

// analytics-engine.js — Phase 6.1: Analytics Foundation + User Behavior Tracking
// =====================================================================
// Provider-agnostic analytics facade. Aggregates data from existing runtime
// analytics modules (RuntimeSessionIntel, RuntimeToolEngagement) and fills
// the gaps those modules don't cover:
//   • FILE_UPLOAD, PREVIEW_REACHED tracking via Phase 5 ilpdf:step events
//   • Visitor profile (firstVisit, lastVisit, daysSince, isReturning)
//   • ClarityBridge + GABridge placeholder objects (no external calls)
//   • Ad analytics events (UPLOAD_AD_VISIBLE, PREVIEW_AD_VISIBLE, etc.)
//   • Unified export() that reads localStorage directly (works on tool pages
//     where RuntimeSessionIntel/RuntimeToolEngagement are not loaded)
//
// ADDITIVE ONLY. Never modifies:
//   BrowserTools, Workers, Security, Arc, RuntimeSessionIntel,
//   RuntimeToolEngagement, RuntimeAnalytics, SessionPersist, AdManager
//
// Storage key (DO NOT CONFLICT):
//   'ilpdf_ae_v1' — visitor profile only; session data stays in memory
//
// Existing keys this module READS (but never writes):
//   'iplv_tool_pop_v2'   — RuntimeSessionIntel tool popularity
//   'iplv_engagement_v2' — RuntimeToolEngagement per-tool stats
//   'ilpdf_visits_v1'    — AdResponsiveEngine visit counter
//
// Performance contract:
//   • Boot deferred via requestIdleCallback (2s timeout fallback)
//   • AdManager hooks deferred 500ms to allow AdManager to initialize
//   • DOM step detection runs once after boot
//   • All writes throttled (no per-click localStorage writes)
//   • Zero blocking on first paint, upload UI, preview UI, download UI
//
// window.AnalyticsEngine API:
//   .EVENTS              — frozen event name constants
//   .track(event, data?) — record an analytics event
//   .export()            — unified dashboard snapshot (JSON)
//   .getSessionSummary() — current session stats
//   .getVisitorProfile() — firstVisit, lastVisit, visitCount, isReturning
//
// window.ClarityBridge (frozen placeholder, no external calls):
//   .trackPage(path)  .trackTool(slug)  .trackUpload(slug)  .trackDownload(slug)
//
// window.GABridge (frozen placeholder, no external calls):
//   .trackPage(path)  .trackTool(slug)  .trackUpload(slug)  .trackDownload(slug)
//
// Events tracked:
//   PAGE_VIEW            — on page load (every page)
//   TOOL_OPEN            — on tool page load
//   FILE_UPLOAD          — on ilpdf:step { step:'upload' }
//   PREVIEW_REACHED      — on ilpdf:step { step:'preview' }
//   DOWNLOAD_REACHED     — on ilpdf:step { step:'download' }
//   TOOL_COMPLETED       — on download:triggered event
//   SESSION_STARTED      — on boot
//   SESSION_ENDED        — on pagehide
//   RETURN_VISIT         — if visitCount > 1 this session
//   AD_SLOT_VIEWABLE     — when any ad slot enters viewport
//   UPLOAD_AD_VISIBLE    — when upload slot (Ezoic 201) enters viewport
//   PREVIEW_AD_VISIBLE   — when preview slot (Ezoic 202) enters viewport
//   DOWNLOAD_AD_VISIBLE  — when download slot (Ezoic 104) enters viewport
//   MOBILE_STICKY_VISIBLE — when sticky footer (Ezoic 106) enters viewport
// =====================================================================
(function (G) {
  'use strict';

  if (G.AnalyticsEngine) return;

  // ── Crawler suppression ───────────────────────────────────────────────────
  var CRAWLER_RE = /googlebot|bingbot|slurp|duckduckbot|baidu|yandexbot|sogou|bot|crawler|spider/i;
  if (CRAWLER_RE.test((navigator.userAgent) || '')) return;

  var LOG         = '[AE]';
  var AE_KEY      = 'ilpdf_ae_v1';
  var MAX_LOG     = 100;
  var SESSION_GAP = 30 * 60 * 1000; // 30 min = new session

  // ── Event name constants ───────────────────────────────────────────────────
  var EVENTS = Object.freeze({
    PAGE_VIEW:            'PAGE_VIEW',
    TOOL_OPEN:            'TOOL_OPEN',
    FILE_UPLOAD:          'FILE_UPLOAD',
    PREVIEW_REACHED:      'PREVIEW_REACHED',
    DOWNLOAD_REACHED:     'DOWNLOAD_REACHED',
    TOOL_COMPLETED:       'TOOL_COMPLETED',
    SESSION_STARTED:      'SESSION_STARTED',
    SESSION_ENDED:        'SESSION_ENDED',
    RETURN_VISIT:         'RETURN_VISIT',
    AD_SLOT_VIEWABLE:     'AD_SLOT_VIEWABLE',
    UPLOAD_AD_VISIBLE:    'UPLOAD_AD_VISIBLE',
    PREVIEW_AD_VISIBLE:   'PREVIEW_AD_VISIBLE',
    DOWNLOAD_AD_VISIBLE:  'DOWNLOAD_AD_VISIBLE',
    MOBILE_STICKY_VISIBLE:'MOBILE_STICKY_VISIBLE',
  });

  // ── Safe helpers ───────────────────────────────────────────────────────────
  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }
  function _lsGet(k) {
    return _s(function () { return JSON.parse(localStorage.getItem(k)); });
  }
  function _lsSet(k, v) {
    _s(function () { localStorage.setItem(k, JSON.stringify(v)); });
  }
  function _currentSlug() {
    return _s(function () {
      var p = (G.location && G.location.pathname || '/').replace(/^\//, '').split('/')[0];
      return (p && p !== '' && p !== 'index.html') ? p : null;
    });
  }
  function _daysSince(ts) {
    if (!ts) return null;
    return Math.floor((Date.now() - ts) / (24 * 3600 * 1000));
  }

  // ── In-memory session state (never persisted) ──────────────────────────────
  var _session = {
    id:           Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    startTs:      Date.now(),
    endTs:        null,
    pageViews:    0,
    toolsVisited: [],
    uploads:      0,
    downloads:    0,
    previews:     0,
    adViewable:   0,
  };

  var _eventLog = [];  // capped at MAX_LOG

  // ── Visitor profile (persisted in ilpdf_ae_v1) ────────────────────────────
  var _profile = null;

  function _loadProfile() {
    var raw = _lsGet(AE_KEY);
    if (raw && raw.v === 1 && typeof raw.visitCount === 'number') {
      _profile = raw;
    } else {
      _profile = {
        v:              1,
        firstVisit:     null,
        lastVisit:      null,
        visitCount:     0,
        sessionCount:   0,
        totalDownloads: 0,
        totalUploads:   0,
      };
    }
  }

  function _saveProfile() {
    _lsSet(AE_KEY, _profile);
  }

  function _initVisitorProfile() {
    _loadProfile();
    var now          = Date.now();
    var prevLastVisit = _profile.lastVisit;
    var isNewSession = (now - (prevLastVisit || 0)) > SESSION_GAP;

    if (isNewSession) {
      if (_profile.visitCount === 0) {
        // Truly first visit — set firstVisit
        _profile.firstVisit = now;
      }
      _profile.visitCount++;
      _profile.sessionCount++;
      _profile.lastVisit = now;
      _saveProfile();
    }

    // Fire RETURN_VISIT for any non-first-time visitor
    if (_profile.visitCount > 1) {
      _track(EVENTS.RETURN_VISIT, {
        visitCount:       _profile.visitCount,
        daysSinceFirst:   _daysSince(_profile.firstVisit),
        daysSinceLast:    _daysSince(prevLastVisit),
        isNewSession:     isNewSession,
      });
    }
  }

  // ── Core event tracker ─────────────────────────────────────────────────────
  function _track(event, data) {
    var entry = { event: event, ts: Date.now(), data: data || null };
    _eventLog.push(entry);
    if (_eventLog.length > MAX_LOG) _eventLog.shift();

    // Forward to RuntimeAnalytics (non-blocking — silently skips if unavailable)
    if (G.RuntimeAnalytics) {
      _s(function () {
        G.RuntimeAnalytics.track('ae:' + event.toLowerCase().replace(/_/g, ':'), {
          tool_id: (data && data.slug) || null,
          extra:   data || {},
        });
      });
    }

    // Forward to provider bridges (no external calls — bridges queue for future)
    _forwardToBridges(event, data);
  }

  // Public track — allow callers to emit custom events
  function track(event, data) {
    if (!event) return;
    _track(event, data);
  }

  // ── Bridge forwarding (placeholders — no network calls) ───────────────────
  // Bridges log intent locally. When a real provider (Clarity, GA4) is loaded,
  // set bridge._connected = true and replace the functions with real gtag calls.
  var _clarityQueue = [];
  var _gaQueue      = [];

  function _forwardToBridges(event, data) {
    var slug = (data && data.slug) || null;
    var path = (G.location && G.location.pathname) || '/';

    // Buffer in local queues for future provider connection
    var item = { event: event, slug: slug, path: path, ts: Date.now() };
    if (_clarityQueue.length < 50) _clarityQueue.push(item);
    if (_gaQueue.length < 50)      _gaQueue.push(item);
  }

  // ── ClarityBridge — Microsoft Clarity (placeholder, no external calls) ────
  // To activate: load Clarity script, set ClarityBridge._connected = true,
  // and override the functions to call window.clarity('set', ...) or
  // window.clarity('event', ...) as appropriate.
  G.ClarityBridge = Object.freeze({
    _provider:  'clarity',
    _connected: false,
    trackPage:     function (path)  { _track('CLARITY:PAGE',     { path:  path }); },
    trackTool:     function (slug)  { _track('CLARITY:TOOL',     { slug:  slug }); },
    trackUpload:   function (slug)  { _track('CLARITY:UPLOAD',   { slug:  slug }); },
    trackDownload: function (slug)  { _track('CLARITY:DOWNLOAD', { slug:  slug }); },
    getQueue:      function ()      { return _clarityQueue.slice(); },
  });

  // ── GABridge — Google Analytics 4 (placeholder, no external calls) ────────
  // To activate: load GA4 (gtag.js), set GABridge._connected = true,
  // and override the functions to call gtag('event', ...) as appropriate.
  G.GABridge = Object.freeze({
    _provider:  'ga4',
    _connected: false,
    trackPage:     function (path)  { _track('GA4:PAGE',     { path:  path }); },
    trackTool:     function (slug)  { _track('GA4:TOOL',     { slug:  slug }); },
    trackUpload:   function (slug)  { _track('GA4:UPLOAD',   { slug:  slug }); },
    trackDownload: function (slug)  { _track('GA4:DOWNLOAD', { slug:  slug }); },
    getQueue:      function ()      { return _gaQueue.slice(); },
  });

  // ── Page view + tool open tracking ────────────────────────────────────────
  function _trackPageView() {
    _session.pageViews++;
    var path = (G.location && G.location.pathname) || '/';
    _track(EVENTS.PAGE_VIEW, { path: path });

    var slug = _currentSlug();
    if (slug) {
      _track(EVENTS.TOOL_OPEN, { slug: slug, path: path });
      if (_session.toolsVisited.indexOf(slug) === -1) {
        _session.toolsVisited.push(slug);
      }
    }
  }

  // ── DOM detection: catch steps that rendered before engine loaded ──────────
  // The idle loader may run after renderUploadStep() has already fired.
  // This catches the current DOM state so we don't miss the event.
  function _detectCurrentDomStep() {
    var content = document.getElementById('tool-content');
    if (!content) return;
    var slug = _currentSlug();

    if (content.querySelector('.upload-step') && _session.uploads === 0) {
      _session.uploads++;
      _track(EVENTS.FILE_UPLOAD, { slug: slug, source: 'dom-detect' });
    }
    if (content.querySelector('.ew-preview-workspace') && _session.previews === 0) {
      _session.previews++;
      _track(EVENTS.PREVIEW_REACHED, { slug: slug, source: 'dom-detect' });
    }
    if (content.querySelector('.download-step') && _session.downloads === 0) {
      _session.downloads++;
      _track(EVENTS.DOWNLOAD_REACHED, { slug: slug, source: 'dom-detect' });
    }
  }

  // ── Step event listener (Phase 5 ilpdf:step events) ───────────────────────
  function _listenStepEvents() {
    G.addEventListener('ilpdf:step', function (e) {
      var step = e && e.detail && e.detail.step;
      var slug = _currentSlug();

      if (step === 'upload') {
        _session.uploads++;
        _track(EVENTS.FILE_UPLOAD, { slug: slug });
        _profile.totalUploads = (_profile.totalUploads || 0) + 1;
        _saveProfile();
        // Forward to bridges
        G.ClarityBridge.trackUpload(slug || '');
        G.GABridge.trackUpload(slug || '');

      } else if (step === 'preview') {
        _session.previews++;
        _track(EVENTS.PREVIEW_REACHED, { slug: slug });

      } else if (step === 'download') {
        _session.downloads++;
        _track(EVENTS.DOWNLOAD_REACHED, { slug: slug });
      }
    });
  }

  // ── Download completion listener ───────────────────────────────────────────
  // download:triggered = user clicked the Download button (TOOL_COMPLETED)
  // This is different from DOWNLOAD_REACHED (= reached the download step)
  function _listenDownloads() {
    document.addEventListener('download:triggered', function (e) {
      var slug = (e.detail && e.detail.slug) || _currentSlug();
      _track(EVENTS.TOOL_COMPLETED, { slug: slug });
      _profile.totalDownloads = (_profile.totalDownloads || 0) + 1;
      _saveProfile();
      G.ClarityBridge.trackDownload(slug || '');
      G.GABridge.trackDownload(slug || '');
    }, { passive: true });

    // Also hook DownloadManager if present (deduplication via flag)
    if (G.DownloadManager && G.DownloadManager.onDownload) {
      _s(function () {
        G.DownloadManager.onDownload(function (d) {
          var slug = (d && d.toolId) || _currentSlug();
          _track(EVENTS.TOOL_COMPLETED, { slug: slug, source: 'download-manager' });
        });
      });
    }
  }

  // ── Ad analytics events (zero impact on ad rendering) ─────────────────────
  // Named slot → named event mapping. Fires AD_SLOT_VIEWABLE + specific event.
  var _AD_SLOT_MAP = {
    'upload-banner':  EVENTS.UPLOAD_AD_VISIBLE,
    'preview-banner': EVENTS.PREVIEW_AD_VISIBLE,
    'download-banner': EVENTS.DOWNLOAD_AD_VISIBLE,
    'sticky-footer':  EVENTS.MOBILE_STICKY_VISIBLE,
    'home-hero':      EVENTS.AD_SLOT_VIEWABLE,
    'home-mid':       EVENTS.AD_SLOT_VIEWABLE,
  };

  function _hookAdViewable() {
    if (!G.AdManager) return;
    _s(function () {
      // Discover all slots so AdManager knows about dynamically injected ones
      G.AdManager.discoverSlots();

      // Hook each named slot
      Object.keys(_AD_SLOT_MAP).forEach(function (slotId) {
        G.AdManager.onViewable(slotId, function () {
          _session.adViewable++;
          var specificEvent = _AD_SLOT_MAP[slotId];
          if (specificEvent !== EVENTS.AD_SLOT_VIEWABLE) {
            _track(specificEvent, { slotId: slotId });
          }
          _track(EVENTS.AD_SLOT_VIEWABLE, { slotId: slotId, event: specificEvent });
        });
      });
    });
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────
  function _startSession() {
    _track(EVENTS.SESSION_STARTED, {
      sessionId:  _session.id,
      slug:       _currentSlug(),
      returning:  _profile ? _profile.visitCount > 1 : false,
      visitCount: _profile ? _profile.visitCount : 1,
    });
  }

  function _endSession() {
    if (_session.endTs) return; // prevent double-fire
    _session.endTs = Date.now();
    var dur = _session.endTs - _session.startTs;
    _track(EVENTS.SESSION_ENDED, {
      sessionId:   _session.id,
      durationMs:  dur,
      durationSec: Math.round(dur / 1000),
      pageViews:   _session.pageViews,
      uploads:     _session.uploads,
      downloads:   _session.downloads,
      previews:    _session.previews,
      toolCount:   _session.toolsVisited.length,
      tools:       _session.toolsVisited.join(','),
      adViewable:  _session.adViewable,
    });
  }

  // ── Public: getSessionSummary ──────────────────────────────────────────────
  function getSessionSummary() {
    return {
      sessionId:     _session.id,
      startTs:       _session.startTs,
      durationMs:    Date.now() - _session.startTs,
      pageViews:     _session.pageViews,
      toolsVisited:  _session.toolsVisited.slice(),
      uploads:       _session.uploads,
      downloads:     _session.downloads,
      previews:      _session.previews,
      adViewable:    _session.adViewable,
    };
  }

  // ── Public: getVisitorProfile ──────────────────────────────────────────────
  function getVisitorProfile() {
    if (!_profile) _loadProfile();

    // Prefer AdResponsiveEngine's visit count when available (more accurate)
    var vc = _profile.visitCount || 0;
    if (G.AdResponsiveEngine) {
      vc = G.AdResponsiveEngine.getVisits() || vc;
    }

    return {
      visitCount:           vc,
      sessionCount:         _profile.sessionCount || vc,
      firstVisit:           _profile.firstVisit || null,
      lastVisit:            _profile.lastVisit || null,
      daysSinceFirstVisit:  _daysSince(_profile.firstVisit),
      daysSinceLastVisit:   _daysSince(_profile.lastVisit),
      isReturningUser:      vc > 1,
      totalDownloads:       _profile.totalDownloads || 0,
      totalUploads:         _profile.totalUploads || 0,
    };
  }

  // ── Public: export() — unified dashboard snapshot ─────────────────────────
  // Reads localStorage directly so it works on tool pages where
  // RuntimeSessionIntel and RuntimeToolEngagement may not be loaded.
  function exportDashboard() {
    var session = getSessionSummary();
    var visitor = getVisitorProfile();

    // ── Tool engagement data (from iplv_engagement_v2) ──────────────────────
    var toolUsage = {};
    var engData = _s(function () {
      var raw = JSON.parse(localStorage.getItem('iplv_engagement_v2') || '{}');
      return (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    }, {});

    Object.keys(engData).forEach(function (slug) {
      var e = engData[slug];
      if (!e) return;
      toolUsage[slug] = {
        opens:          0,  // filled below from popularity data
        uploads:        0,  // not separately tracked by RTE, estimated from uploads session
        processed:      e.p || 0,
        downloaded:     e.d || 0,
        failed:         e.f || 0,
        retries:        e.r || 0,
        completionRate: (e.p && e.p > 0) ? +(Math.min(1, (e.d || 0) / e.p)).toFixed(3) : 0,
      };
    });

    // ── Tool popularity data (from iplv_tool_pop_v2) ─────────────────────────
    var topTools = [];
    if (G.RuntimeSessionIntel) {
      _s(function () { topTools = G.RuntimeSessionIntel.getTopTools(30); });
    } else {
      var popData = _s(function () {
        var raw = JSON.parse(localStorage.getItem('iplv_tool_pop_v2') || '{}');
        return (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      }, {});
      topTools = Object.keys(popData)
        .map(function (slug) { return { slug: slug, count: popData[slug] || 0 }; })
        .sort(function (a, b) { return b.count - a.count; })
        .slice(0, 30);
    }

    topTools.forEach(function (t) {
      if (!toolUsage[t.slug]) {
        toolUsage[t.slug] = { opens: 0, processed: 0, downloaded: 0, failed: 0, retries: 0, completionRate: 0 };
      }
      toolUsage[t.slug].opens = t.count;
    });

    // ── Device breakdown ─────────────────────────────────────────────────────
    var deviceBreakdown = null;
    if (G.RuntimeSessionIntel) {
      _s(function () { deviceBreakdown = G.RuntimeSessionIntel.getDeviceProfile(); });
    }
    if (!deviceBreakdown) {
      // Build minimal device profile from UA if RuntimeSessionIntel not loaded
      var ua = navigator.userAgent || '';
      var dt = 'desktop';
      if (/iPhone|iPad/.test(ua)) dt = 'ios';
      else if (/Android/.test(ua)) dt = 'android';
      else if (/Mobile|Tablet/.test(ua)) dt = 'mobile';
      var bp = G.AdResponsiveEngine ? G.AdResponsiveEngine.getBreakpoint() : 'unknown';
      deviceBreakdown = {
        deviceType: dt,
        breakpoint: bp,
        screenW:    (G.screen && G.screen.width)  || 0,
        screenH:    (G.screen && G.screen.height) || 0,
        orientation: (G.innerWidth > G.innerHeight) ? 'landscape' : 'portrait',
      };
    }

    return {
      exportedAt:      new Date().toISOString(),
      sessions:        {
        count:       visitor.visitCount,
        sessionCount: visitor.sessionCount,
        current:     session,
      },
      pageViews:       session.pageViews,
      toolUsage:       toolUsage,
      downloads:       visitor.totalDownloads,
      uploads:         visitor.totalUploads,
      deviceBreakdown: deviceBreakdown,
      returnUsers:     {
        visitCount:          visitor.visitCount,
        firstVisit:          visitor.firstVisit ? new Date(visitor.firstVisit).toISOString() : null,
        lastVisit:           visitor.lastVisit  ? new Date(visitor.lastVisit).toISOString()  : null,
        daysSinceFirstVisit: visitor.daysSinceFirstVisit,
        daysSinceLastVisit:  visitor.daysSinceLastVisit,
        isReturningUser:     visitor.isReturningUser,
        totalDownloads:      visitor.totalDownloads,
        totalUploads:        visitor.totalUploads,
      },
      recentEvents:    _eventLog.slice(-20),
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _initVisitorProfile();
    _trackPageView();
    _startSession();
    _listenStepEvents();
    _listenDownloads();
    _detectCurrentDomStep();

    // Ad hooks deferred to allow AdManager + AdResponsiveEngine to initialize
    setTimeout(_hookAdViewable, 500);

    // Session end on page hide / unload
    G.addEventListener('pagehide',       _endSession, { passive: true });
    G.addEventListener('beforeunload',   _endSession);
    G.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') _endSession();
    }, { passive: true });
  }

  // ── Deferred boot via requestIdleCallback ─────────────────────────────────
  // Never blocks first paint. Falls back to setTimeout if rIC unavailable.
  function _deferredBoot() {
    if (G.requestIdleCallback) {
      G.requestIdleCallback(_boot, { timeout: 2000 });
    } else {
      setTimeout(_boot, 0);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _deferredBoot, { once: true });
  } else {
    _deferredBoot();
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  G.AnalyticsEngine = Object.freeze({
    EVENTS:            EVENTS,
    track:             track,
    export:            exportDashboard,
    getSessionSummary: getSessionSummary,
    getVisitorProfile: getVisitorProfile,
  });

  console.debug(LOG, 'AnalyticsEngine ready — call window.AnalyticsEngine.export() to inspect');

}(window));

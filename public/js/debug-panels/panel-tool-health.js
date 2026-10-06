// PanelToolHealth — Arc 12 debug panel
// Shows live health scores, failure rates, crash counts, and recovery frequency per tool.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolHealth) return;

  var STYLES = [
    '.pth-bar{height:8px;border-radius:4px;background:#1e2030;overflow:hidden;margin-top:3px}',
    '.pth-bar-fill{height:100%;border-radius:4px;transition:width .4s}',
    '.pth-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:12px}',
    '.pth-card{background:#1e2030;border-radius:8px;padding:10px;border:1px solid #2d3150}',
    '.pth-card-id{font-family:monospace;font-size:11px;color:#818cf8;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pth-card-score{font-size:24px;font-weight:700;margin-bottom:2px}',
    '.pth-card-level{font-size:11px;font-weight:600;margin-bottom:6px}',
    '.pth-card-stats{font-size:11px;color:#9ca3af;display:flex;gap:8px;flex-wrap:wrap}',
    '.pth-filter{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}',
    '.pth-filter-btn{padding:3px 10px;border-radius:4px;border:1px solid #374151;background:transparent;color:#9ca3af;cursor:pointer;font-size:12px}',
    '.pth-filter-btn.active{background:#3730a3;border-color:#6366f1;color:#fff}',
  ].join('');

  var LEVEL_COLORS = {
    EXCELLENT: '#86efac',
    GOOD:      '#93c5fd',
    DEGRADED:  '#fcd34d',
    CRITICAL:  '#fca5a5',
  };

  function PanelToolHealth(el) {
    this._el     = el;
    this._filter = 'ALL';
    this._styleInjected = false;
  }

  PanelToolHealth.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolHealth.prototype.refresh = function () {
    var self  = this;
    var hlth  = G.RuntimeToolHealth;
    var reg   = G.RuntimeToolRegistry;

    if (!hlth || !reg) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolHealth not loaded</p>';
      return;
    }

    var levels = hlth.getAllHealthLevels();
    var tools  = reg.getAllTools();
    var summary = hlth.getHealthSummary();

    // Filter buttons
    var html = '<div class="pth-filter">';
    ['ALL','EXCELLENT','GOOD','DEGRADED','CRITICAL'].forEach(function (f) {
      html += '<button class="pth-filter-btn' + (self._filter === f ? ' active' : '')
            + '" data-filter="' + f + '">' + f
            + (f !== 'ALL' ? ' (' + (summary.counts[f] || 0) + ')' : ' (' + tools.length + ')')
            + '</button>';
    });
    html += '</div>';

    // Cards
    html += '<div class="pth-grid">';
    tools
      .filter(function (t) {
        if (self._filter === 'ALL') return true;
        var l = (levels[t.id] && levels[t.id].level) || 'GOOD';
        return l === self._filter;
      })
      .sort(function (a, b) {
        var sa = (levels[a.id] && levels[a.id].score) || 100;
        var sb = (levels[b.id] && levels[b.id].score) || 100;
        return sa - sb;  // worst first
      })
      .forEach(function (t) {
        var h    = levels[t.id] || { score: 100, level: 'GOOD' };
        var color = LEVEL_COLORS[h.level] || '#93c5fd';
        var pct  = h.score + '%';
        html += '<div class="pth-card">'
          + '<div class="pth-card-id">' + t.id + '</div>'
          + '<div class="pth-card-score" style="color:' + color + '">' + h.score + '</div>'
          + '<div class="pth-card-level" style="color:' + color + '">' + h.level + '</div>'
          + '<div class="pth-bar"><div class="pth-bar-fill" style="width:' + pct + ';background:' + color + '"></div></div>'
          + '<div class="pth-card-stats" style="margin-top:6px">'
          + '<span>💥 ' + t.crashCount + ' crashes</span>'
          + '<span>❌ ' + t.failures + ' fails</span>'
          + '<span>🚀 ' + t.launches + ' runs</span>'
          + '</div></div>';
      });
    html += '</div>';

    this._el.innerHTML = html;

    // Filter button event delegation
    this._el.querySelectorAll('.pth-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        self._filter = this.dataset.filter;
        self.refresh();
      });
    });
  };

  G.PanelToolHealth = PanelToolHealth;

}(typeof window !== 'undefined' ? window : this));

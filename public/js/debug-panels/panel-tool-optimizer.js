// PanelToolOptimizer — Arc 12 debug panel
// Shows tool startup optimization: preloaded tools, dormant tools, and estimated savings.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolOptimizer) return;

  var STYLES = [
    '.pto-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:14px}',
    '.pto-stat{background:#1e2030;border-radius:8px;padding:12px;border:1px solid #2d3150;text-align:center}',
    '.pto-stat-val{font-size:28px;font-weight:700;color:#818cf8}',
    '.pto-stat-label{font-size:12px;color:#9ca3af;margin-top:2px}',
    '.pto-tiers{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}',
    '.pto-tier{background:#1e2030;border-radius:8px;padding:10px;border:1px solid #2d3150}',
    '.pto-tier h4{margin:0 0 6px;font-size:12px;font-weight:600}',
    '.pto-tier-hot h4{color:#f97316}',
    '.pto-tier-warm h4{color:#facc15}',
    '.pto-tier-cold h4{color:#60a5fa}',
    '.pto-tier-dormant h4{color:#9ca3af}',
    '.pto-list{font-size:11px;font-family:monospace;color:#e5e7eb;line-height:1.8}',
    '.pto-list .empty{color:#6b7280}',
    '.pto-savings{background:#0f2d1f;border:1px solid #16a34a;border-radius:8px;padding:12px;margin-bottom:12px}',
    '.pto-savings-val{font-size:22px;font-weight:700;color:#86efac}',
    '.pto-savings-label{font-size:12px;color:#4ade80}',
  ].join('');

  var TIER_LABELS = {
    hot:     '🔥 Hot (Preloaded)',
    warm:    '♨️ Warm (Predicted)',
    cold:    '❄️ Cold (On-demand)',
    dormant: '💤 Dormant (Unloading)',
  };

  function PanelToolOptimizer(el) {
    this._el = el;
    this._styleInjected = false;
  }

  PanelToolOptimizer.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolOptimizer.prototype.refresh = function () {
    var opt = G.RuntimeToolOptimizer;
    var reg = G.RuntimeToolRegistry;

    if (!opt) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolOptimizer not loaded</p>';
      return;
    }

    var classes   = opt.getClassifications();
    var preloaded = opt.getPreloaded();
    var metrics   = opt.getMetrics();
    var savings   = opt.estimateSavingsMs();

    var hot     = opt.getByTier('hot');
    var warm    = opt.getByTier('warm');
    var cold    = opt.getByTier('cold');
    var dormant = opt.getByTier('dormant');
    var total   = Object.keys(classes).length;

    // Summary stats
    var html = '<div class="pto-grid">'
      + _stat(total,           'Total Tools',        '#818cf8')
      + _stat(hot.length,      '🔥 Hot',             '#f97316')
      + _stat(warm.length,     '♨️ Warm',            '#facc15')
      + _stat(dormant.length,  '💤 Dormant',         '#9ca3af')
      + _stat(preloaded.length,'Preloaded',           '#86efac')
      + '</div>';

    // Savings
    var savingsSec = (savings / 1000).toFixed(1);
    html += '<div class="pto-savings">'
      + '<div class="pto-savings-val">' + savingsSec + 's</div>'
      + '<div class="pto-savings-label">Estimated total startup savings (hot tool preloading)</div>'
      + '</div>';

    // Tier breakdown
    html += '<div class="pto-tiers">';
    [
      { tier: 'hot',     tools: hot,     cls: 'pto-tier-hot'     },
      { tier: 'warm',    tools: warm,    cls: 'pto-tier-warm'    },
      { tier: 'cold',    tools: cold,    cls: 'pto-tier-cold'    },
      { tier: 'dormant', tools: dormant, cls: 'pto-tier-dormant' },
    ].forEach(function (group) {
      html += '<div class="pto-tier ' + group.cls + '"><h4>' + TIER_LABELS[group.tier] + ' (' + group.tools.length + ')</h4>'
        + '<div class="pto-list">';
      if (!group.tools.length) {
        html += '<span class="empty">none</span>';
      } else {
        group.tools.slice(0, 8).forEach(function (id) {
          html += id + '<br>';
        });
        if (group.tools.length > 8) html += '<span style="color:#6b7280">… +' + (group.tools.length - 8) + ' more</span>';
      }
      html += '</div></div>';
    });
    html += '</div>';

    // Metrics
    html += '<p style="font-size:11px;color:#6b7280">Preloaded: ' + metrics.preloaded
      + ' | Unloaded: ' + metrics.unloaded
      + ' | Warmed: '   + metrics.warmed
      + ' | Classified: ' + metrics.classified
      + '</p>';

    this._el.innerHTML = html;
  };

  function _stat(val, label, color) {
    return '<div class="pto-stat">'
      + '<div class="pto-stat-val" style="color:' + (color || '#818cf8') + '">' + val + '</div>'
      + '<div class="pto-stat-label">' + label + '</div>'
      + '</div>';
  }

  G.PanelToolOptimizer = PanelToolOptimizer;

}(typeof window !== 'undefined' ? window : this));

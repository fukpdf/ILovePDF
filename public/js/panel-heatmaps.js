(function (G) {
  'use strict';
  if (G.PanelHeatmaps) return;

  var _el = null;

  var LEVEL_COLORS = { GREEN: '#2ecc71', YELLOW: '#f1c40f', ORANGE: '#e67e22', RED: '#e74c3c' };
  var LEVEL_BG     = { GREEN: '#1a3a2a', YELLOW: '#3a3010', ORANGE: '#3a2010', RED: '#3a1020' };

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var hm = G.RuntimeHeatmaps;
    if (!hm) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeHeatmaps not loaded</p>'; return; }

    var curr  = hm.getCurrent();
    var tools = hm.getToolHeatmap();

    function cell(label, data, subLabel) {
      var d = data || { level: 'GREEN', pct: null, active: null, maxScore: null };
      var color = LEVEL_COLORS[d.level] || '#aaa';
      var bg    = LEVEL_BG[d.level]    || '#111';
      var val   = d.pct != null ? d.pct + '%' : d.active != null ? d.active : d.maxScore != null ? d.maxScore : d.violations != null ? d.violations : d.open != null ? d.open : '—';
      return '<div style="background:' + bg + ';border:1px solid ' + color + ';border-radius:6px;padding:10px;text-align:center">' +
        '<div style="font-size:11px;color:#aaa">' + label + '</div>' +
        '<div style="font-size:24px;font-weight:bold;color:' + color + '">' + val + '</div>' +
        (subLabel ? '<div style="font-size:10px;color:' + color + '">' + d.level + '</div>' : '') +
        '</div>';
    }

    var systemCells = curr ? [
      cell('Memory', curr.memory, true),
      cell('Workers', curr.workers, true),
      cell('Thermal', curr.thermal, true),
      cell('Failures', curr.failures, true),
      cell('Incidents', curr.incidents, true),
      cell('SLA Viols', curr.sla, true),
      cell('CB Open', curr.circuitBreakers, true),
    ].join('') : '<p style="color:#aaa">No data yet</p>';

    var toolCells = tools.slice(0, 30).map(function (t) {
      var color = LEVEL_COLORS[t.level] || '#aaa';
      return '<div style="background:#1a1a2e;border:1px solid ' + color + ';border-radius:3px;padding:4px;text-align:center;font-size:10px" title="' + t.toolId + '">' +
        '<div style="color:' + color + ';font-weight:bold">' + t.score + '</div>' +
        '<div style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px">' +
        t.toolId.replace(/^rt-/, '').slice(0, 8) + '</div></div>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px">' + systemCells + '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin-bottom:6px">Tool Health Heatmap (' + tools.length + ' tools)</summary>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:4px">' + (toolCells || '<span style="color:#aaa;font-size:11px">No tools registered</span>') + '</div></details>' +
      '<div style="margin-top:8px">' +
        '<button onclick="G&&G.RuntimeHeatmaps&&G.RuntimeHeatmaps.refresh()" style="padding:4px 10px;cursor:pointer">🔄 Refresh Heatmap</button>' +
      '</div>' +
      '</div>';
  }

  G.PanelHeatmaps = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));

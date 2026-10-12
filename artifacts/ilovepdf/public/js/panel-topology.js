(function (G) {
  'use strict';
  if (G.PanelTopology) return;

  var _el = null;

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var topo = G.RuntimeTopology;
    if (!topo) { _el.innerHTML = '<p style="color:#e74c3c">RuntimeTopology not loaded</p>'; return; }

    var graph  = topo.getGraph();
    var health = topo.getClusterHealth();
    var nodes  = graph.nodes;
    var edges  = graph.edges;

    var clusterHtml = graph.clusters.map(function (c) {
      var h = health[c.id] || {};
      var pct = h.pct || 0;
      var bar = '<div style="height:6px;background:#333;border-radius:3px;margin-top:4px">' +
        '<div style="height:100%;width:' + pct + '%;background:' + c.color + ';border-radius:3px"></div></div>';
      return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:8px;margin:4px 0">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px">' +
          '<span style="color:' + c.color + ';font-weight:bold">' + c.label + '</span>' +
          '<span style="color:#aaa">' + (h.present || 0) + '/' + (h.total || 0) + ' loaded</span>' +
        '</div>' + bar + '</div>';
    }).join('');

    var activeEdges = edges.filter(function (e) { return e.active; }).length;
    var nodesByCluster = {};
    nodes.forEach(function (n) {
      if (!nodesByCluster[n.cluster]) nodesByCluster[n.cluster] = [];
      nodesByCluster[n.cluster].push(n);
    });

    var nodeTable = '<table style="width:100%;border-collapse:collapse;font-size:11px">' +
      '<tr style="color:#aaa"><th style="text-align:left;padding:2px 4px">Node</th>' +
      '<th style="padding:2px 4px">Arc</th><th style="padding:2px 4px">Status</th></tr>' +
      nodes.map(function (n) {
        var dot = n.present ? '🟢' : '⚫';
        return '<tr><td style="padding:2px 4px">' + dot + ' ' + n.label + '</td>' +
          '<td style="padding:2px 4px;text-align:center;color:#aaa">' + n.cluster + '</td>' +
          '<td style="padding:2px 4px;text-align:center;font-size:10px;color:' + (n.present ? '#2ecc71' : '#666') + '">' +
          (n.present ? 'loaded' : 'absent') + '</td></tr>';
      }).join('') + '</table>';

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px">' +
        _kpi('Total Nodes', nodes.length, '#3498db') +
        _kpi('Active Edges', activeEdges + '/' + edges.length, '#2ecc71') +
        _kpi('Clusters', graph.clusters.length, '#9b59b6') +
      '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;margin-bottom:6px">Cluster Health</summary>' + clusterHtml + '</details>' +
      '<details><summary style="cursor:pointer;font-weight:bold;margin:6px 0">All Nodes (' + nodes.length + ')</summary>' + nodeTable + '</details>' +
      '</div>';
  }

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:8px;text-align:center">' +
      '<div style="font-size:11px;color:#aaa">' + label + '</div>' +
      '<div style="font-size:20px;font-weight:bold;color:' + color + '">' + value + '</div></div>';
  }

  G.PanelTopology = Object.freeze({ render: render, refresh: refresh });

}(typeof window !== 'undefined' ? window : this));

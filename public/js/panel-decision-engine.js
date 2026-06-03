(function (G) {
  'use strict';
  if (G.PanelDecisionEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _bar(pct, color) {
    return '<div style="height:6px;background:#111;border-radius:3px;width:100%;margin-top:3px">' +
      '<div style="height:6px;background:' + color + ';border-radius:3px;width:' + Math.min(100, pct) + '%"></div></div>';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var de = G.RuntimeDecisionEngine;
    if (!de) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeDecisionEngine not loaded</p>'; return; }

    var m       = de.getMetrics();
    var history = de.getHistory(15);

    var avgConf = history.length ? Math.round(history.reduce(function (s, d) { return s + d.confidence; }, 0) / history.length) : 0;
    var avgRisk = history.length ? Math.round(history.reduce(function (s, d) { return s + d.risk; }, 0) / history.length) : 0;

    var confColor = avgConf >= 80 ? '#2ecc71' : avgConf >= 60 ? '#f39c12' : '#e74c3c';
    var riskColor = avgRisk >= 70 ? '#e74c3c' : avgRisk >= 40 ? '#f39c12' : '#2ecc71';

    var histRows = history.map(function (d) {
      var cCol = d.confidence >= 80 ? '#2ecc71' : d.confidence >= 60 ? '#f39c12' : '#e74c3c';
      var rCol = d.risk >= 70 ? '#e74c3c' : d.risk >= 40 ? '#f39c12' : '#2ecc71';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:3px 8px;font-size:11px">' + (d.action || '—') + '</td>' +
        '<td style="padding:3px 6px;min-width:80px">' +
          '<div style="font-size:11px;color:' + cCol + '">' + d.confidence + '%</div>' +
          _bar(d.confidence, cCol) +
        '</td>' +
        '<td style="padding:3px 6px;min-width:80px">' +
          '<div style="font-size:11px;color:' + rCol + '">' + d.risk + '%</div>' +
          _bar(d.risk, rCol) +
        '</td>' +
        '<td style="padding:3px 6px;font-size:10px;color:#888">' + (d.source || '—') + '</td>' +
        '<td style="padding:3px 6px;font-size:10px;color:#555">' + new Date(d.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    var lastDec = history[0];
    var signalSummary = '';
    if (lastDec && lastDec.signals) {
      var sig = lastDec.signals;
      signalSummary =
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-bottom:12px">' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">FORECAST</div>' +
            '<div style="font-size:11px;color:#f39c12">risk: ' + (sig.forecast && sig.forecast.risk || 0) + '%</div>' +
            (sig.forecast && sig.forecast.criticals ? '<div style="font-size:10px;color:#e74c3c">' + sig.forecast.criticals + ' critical</div>' : '') +
          '</div>' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">GOVERNANCE</div>' +
            '<div style="font-size:11px;color:' + (sig.governance && sig.governance.compliant ? '#2ecc71' : '#e74c3c') + '">' +
              (sig.governance && sig.governance.compliant ? 'Compliant' : sig.governance && sig.governance.violations + ' violations') + '</div>' +
          '</div>' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">MEMORY REC.</div>' +
            '<div style="font-size:11px;color:#9b59b6">' + (sig.memory && sig.memory.action || 'unknown') + '</div>' +
            '<div style="font-size:10px;color:#666">conf: ' + (sig.memory && sig.memory.confidence || 0) + '%</div>' +
          '</div>' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">ADAPTIVE AI</div>' +
            '<div style="font-size:11px;color:#3498db">' + (sig.adaptiveAI && sig.adaptiveAI.conservative ? 'Conservative' : 'Normal') + '</div>' +
          '</div>' +
        '</div>';
    }

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Decisions', m.decisions, '#3498db') +
        _kpi('Avg Confidence', avgConf + '%', confColor) +
        _kpi('Avg Risk', avgRisk + '%', riskColor) +
        _kpi('High Risk', m.highRisk, m.highRisk > 0 ? '#e74c3c' : '#888') +
      '</div>' +
      (signalSummary ? '<div style="font-size:10px;color:#888;margin-bottom:4px;font-weight:bold">LAST DECISION SIGNALS</div>' + signalSummary : '') +
      '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px">Decision History (' + history.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th style="text-align:left">Action</th><th>Confidence</th><th>Risk</th><th>Source</th><th>Time</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' +
      '<div style="margin-top:10px">' +
        '<button onclick="try{var d=window.RuntimeDecisionEngine;if(d)d.decide({source:\'panel-test\'});}catch(e){}" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Run Decision</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'decisions\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelDecisionEngine = Object.freeze({ render: render, refresh: refresh });
}(window));

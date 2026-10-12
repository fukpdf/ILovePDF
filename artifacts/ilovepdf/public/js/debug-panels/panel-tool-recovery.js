// PanelToolRecovery — Arc 12 debug panel
// Shows per-tool recovery history, success rates, and best recovery strategy per tool.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolRecovery) return;

  var STYLES = [
    '.ptr2-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px}',
    '.ptr2-table th,.ptr2-table td{padding:5px 8px;text-align:left;border-bottom:1px solid #333}',
    '.ptr2-table th{background:#1e2030;color:#aaa;font-weight:600}',
    '.ptr2-table tr:hover td{background:#1a1e2e}',
    '.ptr2-hist{max-height:200px;overflow-y:auto;background:#111827;border-radius:6px;padding:8px;font-size:11px;font-family:monospace;margin-top:8px}',
    '.ptr2-hist-row{padding:2px 0;border-bottom:1px solid #1f2937;display:flex;gap:8px}',
    '.ptr2-ok{color:#86efac}',
    '.ptr2-fail{color:#fca5a5}',
    '.ptr2-section{background:#1e2030;border-radius:8px;padding:12px;border:1px solid #2d3150;margin-bottom:10px}',
    '.ptr2-section h4{margin:0 0 8px;font-size:13px;color:#818cf8}',
    '.ptr2-rate-bar{height:6px;border-radius:3px;background:#374151;overflow:hidden;margin-top:2px;width:100px;display:inline-block;vertical-align:middle}',
    '.ptr2-rate-fill{height:100%;border-radius:3px;background:#22c55e}',
  ].join('');

  function PanelToolRecovery(el) {
    this._el = el;
    this._selected = null;
    this._styleInjected = false;
  }

  PanelToolRecovery.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolRecovery.prototype.refresh = function () {
    var self  = this;
    var rec   = G.RuntimeToolRecovery;
    var reg   = G.RuntimeToolRegistry;

    if (!rec) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolRecovery not loaded</p>';
      return;
    }

    var allHistory = rec.getAllHistory();
    var tools      = Object.keys(allHistory);
    var metrics    = rec.getMetrics();

    var html = '<div class="ptr2-section"><h4>🔧 Per-Tool Best Recovery Strategy</h4>';

    if (!tools.length) {
      html += '<p style="color:#6b7280;font-size:12px">No recovery records yet.</p>';
    } else {
      html += '<table class="ptr2-table"><thead><tr>'
        + '<th>Tool ID</th><th>Attempts</th><th>Success Rate</th><th>Best Strategy</th>'
        + '</tr></thead><tbody>';

      tools.forEach(function (toolId) {
        var rate = rec.getSuccessRate(toolId);
        var best = rec.getBestRecovery(toolId, null);
        var pct  = rate ? Math.round(rate.rate * 100) : 0;
        html += '<tr style="cursor:pointer" data-tool="' + toolId + '">'
          + '<td style="font-family:monospace;color:#c4b5fd">' + toolId + '</td>'
          + '<td>' + (rate ? rate.total : 0) + '</td>'
          + '<td>'
          + '<div class="ptr2-rate-bar"><div class="ptr2-rate-fill" style="width:' + pct + '%"></div></div>'
          + ' <span style="color:' + (pct >= 70 ? '#86efac' : pct >= 40 ? '#fcd34d' : '#fca5a5') + '">' + pct + '%</span>'
          + '</td>'
          + '<td style="font-family:monospace;font-size:11px;color:#93c5fd">'
          + (best ? best.strategy : '—') + ' <span style="color:#6b7280">(' + (best ? best.source : '') + ')</span>'
          + '</td>'
          + '</tr>';
      });

      html += '</tbody></table>';
    }
    html += '</div>';

    // Recent entries for selected tool or all
    var displayTool = this._selected && allHistory[this._selected] ? this._selected : (tools[0] || null);
    if (displayTool) {
      var entries = allHistory[displayTool] || [];
      html += '<div class="ptr2-section"><h4>📜 Recovery Log — ' + displayTool + '</h4>'
        + '<div class="ptr2-hist">';
      if (!entries.length) {
        html += '<span style="color:#6b7280">No entries</span>';
      } else {
        entries.slice().reverse().slice(0, 20).forEach(function (e) {
          html += '<div class="ptr2-hist-row">'
            + '<span class="' + (e.success ? 'ptr2-ok' : 'ptr2-fail') + '">'
            + (e.success ? '✓' : '✗') + '</span>'
            + '<span style="color:#818cf8">' + e.failureType + '</span>'
            + '<span style="color:#e5e7eb">' + e.recoveryUsed + '</span>'
            + '<span style="color:#6b7280">' + e.durationMs + 'ms</span>'
            + '</div>';
        });
      }
      html += '</div></div>';
    }

    html += '<p style="font-size:11px;color:#6b7280">Recorded: ' + metrics.recorded + ' | Recommended: ' + metrics.recommended + '</p>';
    this._el.innerHTML = html;

    // Row click to select tool
    this._el.querySelectorAll('tr[data-tool]').forEach(function (row) {
      row.addEventListener('click', function () {
        self._selected = this.dataset.tool;
        self.refresh();
      });
    });
  };

  G.PanelToolRecovery = PanelToolRecovery;

}(typeof window !== 'undefined' ? window : this));

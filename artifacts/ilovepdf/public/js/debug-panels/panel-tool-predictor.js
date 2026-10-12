// PanelToolPredictor — Arc 12 debug panel
// Shows learned tool-to-tool transition sequences and next-tool prediction results.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolPredictor) return;

  var STYLES = [
    '.ptp-two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}',
    '.ptp-section{background:#1e2030;border-radius:8px;padding:12px;border:1px solid #2d3150}',
    '.ptp-section h4{margin:0 0 8px;font-size:13px;color:#818cf8}',
    '.ptp-seq-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #2d3150;font-size:12px}',
    '.ptp-seq-from{font-family:monospace;color:#c4b5fd;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ptp-seq-to{font-family:monospace;color:#86efac;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ptp-seq-count{color:#6b7280;font-size:11px;white-space:nowrap}',
    '.ptp-pred-input{display:flex;gap:6px;margin-bottom:8px}',
    '.ptp-pred-input input{flex:1;background:#111827;border:1px solid #374151;color:#e5e7eb;padding:4px 8px;border-radius:4px;font-size:12px}',
    '.ptp-pred-input button{padding:4px 10px;background:#3730a3;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:12px}',
    '.ptp-pred-result{font-size:12px}',
    '.ptp-pred-item{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #2d3150}',
    '.ptp-pred-tool{font-family:monospace;color:#93c5fd}',
    '.ptp-pred-src{color:#6b7280;font-size:11px}',
    '.ptp-hist{font-size:12px;color:#9ca3af;font-family:monospace;line-height:2}',
  ].join('');

  function PanelToolPredictor(el) {
    this._el = el;
    this._queryTool = '';
    this._queryResult = null;
    this._styleInjected = false;
  }

  PanelToolPredictor.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolPredictor.prototype.refresh = function () {
    var self  = this;
    var pred  = G.RuntimeToolPredictor;

    if (!pred) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolPredictor not loaded</p>';
      return;
    }

    var sequences = pred.getTopSequences(15);
    var history   = pred.getHistory();
    var metrics   = pred.getMetrics();

    var html = '<div class="ptp-two-col">';

    // Left: top sequences
    html += '<div class="ptp-section"><h4>📊 Top Learned Sequences</h4>';
    if (sequences.length === 0) {
      html += '<p style="color:#6b7280;font-size:12px">No sequences recorded yet</p>';
    } else {
      sequences.forEach(function (s) {
        html += '<div class="ptp-seq-row">'
          + '<span class="ptp-seq-from">' + s.from + '</span>'
          + '<span style="color:#6b7280">→</span>'
          + '<span class="ptp-seq-to">' + s.to + '</span>'
          + '<span class="ptp-seq-count">×' + s.count + '</span>'
          + '</div>';
      });
    }
    html += '</div>';

    // Right: prediction query
    html += '<div class="ptp-section"><h4>🔮 Predict Next Tool</h4>';
    html += '<div class="ptp-pred-input">'
      + '<input id="ptp-query-input" type="text" placeholder="e.g. merge-pdf" value="' + this._queryTool + '">'
      + '<button id="ptp-query-btn">Predict</button>'
      + '</div>';

    if (this._queryResult && this._queryResult.length > 0) {
      html += '<div class="ptp-pred-result">';
      this._queryResult.forEach(function (p) {
        html += '<div class="ptp-pred-item">'
          + '<span class="ptp-pred-tool">' + p.toolId + '</span>'
          + '<span><span class="ptp-pred-src">' + p.source + '</span>'
          + ' <span style="color:#818cf8">score:' + p.score + '</span></span>'
          + '</div>';
      });
      html += '</div>';
    } else if (this._queryResult) {
      html += '<p style="color:#6b7280;font-size:12px">No predictions for "' + this._queryTool + '"</p>';
    }
    html += '</div>';

    html += '</div>';  // two-col

    // Recent history
    html += '<div class="ptp-section"><h4>🕐 Recent Tool History</h4>'
      + '<div class="ptp-hist">'
      + (history.length ? history.join(' → ') : '<span style="color:#6b7280">No history yet</span>')
      + '</div></div>';

    html += '<p style="font-size:11px;color:#6b7280;margin-top:8px">Recorded: '
      + metrics.recorded + ' | Predicted: ' + metrics.predicted + '</p>';

    this._el.innerHTML = html;

    // Wire predict button
    var btn   = this._el.querySelector('#ptp-query-btn');
    var input = this._el.querySelector('#ptp-query-input');
    if (btn && input) {
      btn.addEventListener('click', function () {
        self._queryTool   = input.value.trim();
        self._queryResult = pred.predictNextTool(self._queryTool);
        self.refresh();
      });
    }
  };

  G.PanelToolPredictor = PanelToolPredictor;

}(typeof window !== 'undefined' ? window : this));

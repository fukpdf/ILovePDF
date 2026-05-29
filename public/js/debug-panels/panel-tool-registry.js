// PanelToolRegistry — Arc 12 debug panel
// Shows all registered tools with category, launch count, health level, and isolation state.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolRegistry) return;

  var STYLES = [
    '.ptr-table{width:100%;border-collapse:collapse;font-size:12px}',
    '.ptr-table th,.ptr-table td{padding:4px 8px;text-align:left;border-bottom:1px solid #333}',
    '.ptr-table th{background:#1e2030;color:#aaa;font-weight:600}',
    '.ptr-table tr:hover td{background:#1a1e2e}',
    '.ptr-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600}',
    '.ptr-badge.EXCELLENT{background:#14532d;color:#86efac}',
    '.ptr-badge.GOOD{background:#1e3a5f;color:#93c5fd}',
    '.ptr-badge.DEGRADED{background:#78350f;color:#fcd34d}',
    '.ptr-badge.CRITICAL{background:#7f1d1d;color:#fca5a5}',
    '.ptr-badge.isolated{background:#3b0764;color:#e9d5ff}',
    '.ptr-summary{display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap}',
    '.ptr-stat{background:#1e2030;border-radius:6px;padding:6px 12px;font-size:12px}',
    '.ptr-stat-val{font-size:20px;font-weight:700;color:#818cf8}',
  ].join('');

  function PanelToolRegistry(el) {
    this._el = el;
    this._styleInjected = false;
  }

  PanelToolRegistry.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolRegistry.prototype.refresh = function () {
    var reg  = G.RuntimeToolRegistry;
    var hlth = G.RuntimeToolHealth;
    var iso  = G.RuntimeToolIsolation;

    if (!reg) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolRegistry not loaded</p>';
      return;
    }

    var tools  = reg.getAllTools();
    var levels = hlth ? hlth.getAllHealthLevels() : {};
    var isolated = iso ? iso.getIsolated() : {};
    var regM   = reg.getMetrics();

    // Summary
    var counts = { EXCELLENT: 0, GOOD: 0, DEGRADED: 0, CRITICAL: 0 };
    tools.forEach(function (t) {
      var l = (levels[t.id] && levels[t.id].level) || 'GOOD';
      counts[l] = (counts[l] || 0) + 1;
    });

    var html = '<div class="ptr-summary">'
      + '<div class="ptr-stat"><div class="ptr-stat-val">' + tools.length + '</div>Tools</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#86efac">' + counts.EXCELLENT + '</div>Excellent</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#93c5fd">' + counts.GOOD + '</div>Good</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#fcd34d">' + counts.DEGRADED + '</div>Degraded</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#fca5a5">' + counts.CRITICAL + '</div>Critical</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#e9d5ff">' + Object.keys(isolated).length + '</div>Isolated</div>'
      + '</div>';

    // Table
    html += '<table class="ptr-table"><thead><tr>'
      + '<th>ID</th><th>Category</th><th>Launches</th><th>Failures</th>'
      + '<th>Crashes</th><th>Health</th><th>Startup ms</th><th>Status</th>'
      + '</tr></thead><tbody>';

    tools.sort(function (a, b) { return b.launches - a.launches; }).forEach(function (t) {
      var lvl  = (levels[t.id] && levels[t.id].level) || 'GOOD';
      var sc   = (levels[t.id] && levels[t.id].score !== undefined) ? levels[t.id].score : '—';
      var isol = !!isolated['tool:' + t.id] || !!isolated[t.id];
      html += '<tr>'
        + '<td style="font-family:monospace">' + t.id + '</td>'
        + '<td>' + t.category + '</td>'
        + '<td>' + t.launches + '</td>'
        + '<td>' + t.failures + '</td>'
        + '<td>' + t.crashCount + '</td>'
        + '<td><span class="ptr-badge ' + lvl + '">' + sc + ' ' + lvl + '</span></td>'
        + '<td>' + (t.startupMs || '—') + '</td>'
        + '<td>' + (isol ? '<span class="ptr-badge isolated">ISOLATED</span>' : '<span style="color:#6b7280">active</span>') + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    html += '<p style="font-size:11px;color:#6b7280;margin-top:8px">Registered: ' + regM.registered + ' | Updated: ' + regM.updated + ' | Lookups: ' + regM.lookups + '</p>';
    this._el.innerHTML = html;
  };

  G.PanelToolRegistry = PanelToolRegistry;

}(typeof window !== 'undefined' ? window : this));

(function (G) {
  'use strict';
  if (G.RuntimeToolDiscovery) return;

  var LOG = '[Arc13:Discovery]';

  // Sequence observation
  // _counts[fromTool][toTool] = { occurrences, total, confidence }
  var _counts     = {};   // co-occurrence counts
  var _totals     = {};   // total transitions from each tool
  var _discovered = [];   // { fromTool, toTool, confidence, addedAt }
  var _lastTool   = null;
  var _metrics    = { observed: 0, discovered: 0, promoted: 0 };

  var CONFIDENCE_THRESH = 0.80;   // 80% confidence to add dependency
  var MIN_OBSERVATIONS  = 5;      // need at least 5 transitions to evaluate

  function _observe(toTool) {
    if (!_lastTool || _lastTool === toTool) { _lastTool = toTool; return; }
    var from = _lastTool;
    _lastTool = toTool;
    _metrics.observed++;

    if (!_counts[from])      _counts[from]       = {};
    if (!_counts[from][toTool]) _counts[from][toTool] = 0;
    if (!_totals[from])      _totals[from]        = 0;

    _counts[from][toTool]++;
    _totals[from]++;

    // Evaluate confidence
    var occ   = _counts[from][toTool];
    var total = _totals[from];
    if (total < MIN_OBSERVATIONS) return;
    var conf  = occ / total;

    if (conf >= CONFIDENCE_THRESH) {
      _promote(from, toTool, conf);
    }
  }

  function _promote(fromTool, toTool, confidence) {
    // Already promoted?
    var exists = _discovered.some(function (d) {
      return d.fromTool === fromTool && d.toTool === toTool;
    });
    if (exists) {
      // Update confidence
      _discovered.forEach(function (d) {
        if (d.fromTool === fromTool && d.toTool === toTool) {
          d.confidence = confidence;
          d.updatedAt  = Date.now();
        }
      });
      return;
    }

    var entry = { fromTool: fromTool, toTool: toTool, confidence: confidence, addedAt: Date.now() };
    _discovered.push(entry);
    _metrics.discovered++;
    console.debug(LOG, 'discovered dependency:', fromTool, '→', toTool,
      '(' + Math.round(confidence * 100) + '% confidence)');

    // Add to RuntimeToolDependencies
    var dep = G.RuntimeToolDependencies;
    if (dep && dep.addDependency) {
      try {
        dep.addDependency(fromTool, toTool);
        _metrics.promoted++;
        G.dispatchEvent(new CustomEvent('arc13:dependency-discovered', {
          detail: { fromTool: fromTool, toTool: toTool, confidence: confidence },
        }));
      } catch (_) {}
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getSequences() {
    var result = [];
    Object.keys(_counts).forEach(function (from) {
      Object.keys(_counts[from]).forEach(function (to) {
        var occ  = _counts[from][to];
        var total = _totals[from] || 1;
        result.push({
          fromTool:     from,
          toTool:       to,
          occurrences:  occ,
          total:        total,
          confidence:   occ / total,
        });
      });
    });
    return result.sort(function (a, b) { return b.confidence - a.confidence; });
  }

  function getConfidence(fromTool, toTool) {
    var occ   = (_counts[fromTool] && _counts[fromTool][toTool]) || 0;
    var total = _totals[fromTool] || 0;
    return total > 0 ? occ / total : 0;
  }

  function getDiscovered() { return _discovered.slice(); }

  function getMetrics() { return Object.assign({}, _metrics); }

  // ── Listen to arc9:tool-recorded ─────────────────────────────────────────────
  G.addEventListener('arc9:tool-recorded', function (e) {
    var toolId = e && e.detail && e.detail.toolId;
    if (toolId) _observe(toolId);
  });

  G.RuntimeToolDiscovery = Object.freeze({
    getSequences:    getSequences,
    getConfidence:   getConfidence,
    getDiscovered:   getDiscovered,
    getMetrics:      getMetrics,
    CONFIDENCE_THRESH: CONFIDENCE_THRESH,
  });

}(typeof window !== 'undefined' ? window : this));

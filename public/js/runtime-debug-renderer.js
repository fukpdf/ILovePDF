(function (G) {
  'use strict';
  if (G.RuntimeDebugRenderer) return;

  var VERSION = '10.0.0';
  var LOG     = '[DebugRenderer]';

  // ── Incremental DOM helpers ───────────────────────────────────────────────────

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'cls') { e.className = attrs[k]; }
        else if (k === 'style') { e.style.cssText = attrs[k]; }
        else if (k === 'html') { e.innerHTML = attrs[k]; }
        else if (k === 'text') { e.textContent = attrs[k]; }
        else { e.setAttribute(k, attrs[k]); }
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      });
    }
    return e;
  }

  function text(str) { return document.createTextNode(String(str)); }

  // ── Incremental update: only patch changed fields ─────────────────────────────
  function patchText(selector, newVal, container) {
    var scope = container || document;
    var node  = scope.querySelector(selector);
    if (node && node.textContent !== String(newVal)) {
      node.textContent = String(newVal);
    }
  }

  function patchHtml(selector, newHtml, container) {
    var scope = container || document;
    var node  = scope.querySelector(selector);
    if (node && node.innerHTML !== newHtml) {
      node.innerHTML = newHtml;
    }
  }

  // ── Virtual list (render only visible rows) ───────────────────────────────────
  function VirtualList(container, rowHeight, renderRow) {
    this._c        = container;
    this._rh       = rowHeight;
    this._render   = renderRow;
    this._items    = [];
    this._startIdx = 0;
    this._endIdx   = 0;
    container.style.overflowY   = 'auto';
    container.style.position    = 'relative';
    var self = this;
    container.addEventListener('scroll', function () { self._paint(); });
  }

  VirtualList.prototype.setItems = function (items) {
    this._items = items;
    this._c.style.height = (items.length * this._rh) + 'px';
    this._paint();
  };

  VirtualList.prototype._paint = function () {
    var scrollTop  = this._c.scrollTop;
    var viewHeight = this._c.clientHeight || 400;
    var start = Math.max(0, Math.floor(scrollTop / this._rh) - 5);
    var end   = Math.min(this._items.length, Math.ceil((scrollTop + viewHeight) / this._rh) + 5);
    if (start === this._startIdx && end === this._endIdx) return;
    this._startIdx = start;
    this._endIdx   = end;
    var frag = document.createDocumentFragment();
    var spacer = document.createElement('div');
    spacer.style.height = (start * this._rh) + 'px';
    frag.appendChild(spacer);
    for (var i = start; i < end; i++) {
      frag.appendChild(this._render(this._items[i], i));
    }
    this._c.innerHTML = '';
    this._c.appendChild(frag);
  };

  // ── Severity badge ────────────────────────────────────────────────────────────
  var SEV_COLORS = { 0: '#f44', 1: '#f84', 2: '#fa0', 3: '#8af' };
  var SEV_LABELS = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };

  function badge(sev) {
    return el('span', {
      cls:   'sev-badge',
      style: 'background:' + (SEV_COLORS[sev] || '#aaa') + ';color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:700;',
      text:  SEV_LABELS[sev] !== undefined ? SEV_LABELS[sev] : String(sev),
    });
  }

  // ── Sparkline (canvas mini-chart) ─────────────────────────────────────────────
  function sparkline(values, width, height, color) {
    var c = document.createElement('canvas');
    c.width  = width  || 120;
    c.height = height || 32;
    var ctx = c.getContext('2d');
    if (!ctx || !values.length) return c;
    var max = Math.max.apply(null, values) || 1;
    var min = Math.min.apply(null, values);
    var range = max - min || 1;
    var w = c.width / (values.length - 1 || 1);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = color || '#4af';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    values.forEach(function (v, i) {
      var x = i * w;
      var y = c.height - ((v - min) / range) * c.height;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    return c;
  }

  // ── Timestamp formatter ───────────────────────────────────────────────────────
  function fmtTs(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function fmtAge(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  G.RuntimeDebugRenderer = Object.freeze({
    VERSION:     VERSION,
    el:          el,
    text:        text,
    patchText:   patchText,
    patchHtml:   patchHtml,
    VirtualList: VirtualList,
    badge:       badge,
    sparkline:   sparkline,
    fmtTs:       fmtTs,
    fmtAge:      fmtAge,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — incremental DOM + virtual list ready');

}(window));

(function (G) {
  'use strict';
  if (G.PanelControl) return;

  var VERSION = '10.0.0';
  var LOG     = '[PanelControl]';

  function PanelControl(container) {
    this._c     = container;
    this._built = false;
  }

  PanelControl.prototype.init = function () {
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;
    var self = this;

    var toolbar = Ren.el('div', { cls: 'panel-toolbar' }, [
      Ren.el('span', { cls: 'panel-title', text: '🎛️ Control Plane & Governance' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'ctrl-sweep',  text: 'Run Governance Sweep' }),
      Ren.el('button', { cls: 'dbg-btn', id: 'ctrl-export', text: 'Export Flags & Audit' }),
    ]);

    // Flags
    var flagsTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Runtime Flags' });
    var flagsList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-flags', style: 'max-height:200px;overflow-y:auto;' });

    // Protected flags
    var protTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Protected Flags (Governance)' });
    var protList  = Ren.el('div', { cls: 'panel-metrics', id: 'ctrl-protected' });

    // Quarantine
    var quarTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Quarantine Registry' });
    var quarList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-quarantine', style: 'max-height:120px;overflow-y:auto;' });

    // Command audit trail
    var auditTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Command Audit Trail (last 20)' });
    var auditList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-audit', style: 'max-height:200px;overflow-y:auto;' });

    // Safe command executor
    var execTitle  = Ren.el('div', { cls: 'panel-subtitle', text: 'Execute Safe Command' });
    var execSec    = G.RuntimeDebugSecurity;
    var execRow    = Ren.el('div', { cls: 'panel-metrics', style: 'flex-wrap:wrap;gap:6px;' });
    if (execSec) {
      execSec.SAFE_COMMANDS.forEach(function (cmd) {
        var btn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: cmd });
        btn.addEventListener('click', function () {
          var CP = G.RuntimeControlPlane;
          if (!CP) { alert('RuntimeControlPlane not available'); return; }
          if (!execSec.checkRate('command', 20)) { alert('Rate limit: max 20 commands/min'); return; }
          var result = CP.execute(cmd, {});
          alert(cmd + ': ' + JSON.stringify(result && result.ok !== undefined ? { ok: result.ok } : result));
        });
        execRow.appendChild(btn);
      });
    }

    // Governance policies
    var policiesTitle = Ren.el('div', { cls: 'panel-subtitle', text: 'Governance Policies' });
    var policiesList  = Ren.el('div', { cls: 'panel-list-wrap', id: 'ctrl-policies', style: 'max-height:160px;overflow-y:auto;' });

    this._c.appendChild(toolbar);
    this._c.appendChild(flagsTitle);
    this._c.appendChild(flagsList);
    this._c.appendChild(protTitle);
    this._c.appendChild(protList);
    this._c.appendChild(quarTitle);
    this._c.appendChild(quarList);
    this._c.appendChild(auditTitle);
    this._c.appendChild(auditList);
    this._c.appendChild(execTitle);
    this._c.appendChild(execRow);
    this._c.appendChild(policiesTitle);
    this._c.appendChild(policiesList);

    toolbar.querySelector('#ctrl-sweep').addEventListener('click', function () {
      var Gov = G.RuntimeGovernance;
      if (!Gov) { alert('RuntimeGovernance not available'); return; }
      Gov.sweep();
      self.refresh();
    });

    toolbar.querySelector('#ctrl-export').addEventListener('click', function () {
      var CP  = G.RuntimeControlPlane;
      var Gov = G.RuntimeGovernance;
      var Ex  = G.RuntimeDebugExport;
      if (!Ex) return;
      Ex.exportJson({
        flags:      CP  ? CP.getFlags()     : {},
        audit:      CP  ? CP.getAudit()     : [],
        violations: Gov ? Gov.getViolations() : [],
        quarantine: Gov ? Gov.getQuarantined() : {},
      }, 'control-plane-snapshot');
    });

    this._built = true;
  };

  PanelControl.prototype.refresh = function () {
    if (!this._built) return;
    var CP  = G.RuntimeControlPlane;
    var Gov = G.RuntimeGovernance;
    var Ren = G.RuntimeDebugRenderer;
    if (!Ren) return;

    // Flags
    var flagsEl = this._c.querySelector('#ctrl-flags');
    if (flagsEl && CP) {
      flagsEl.innerHTML = '';
      var flags = CP.getFlags();
      var keys  = Object.keys(flags);
      if (!keys.length) {
        flagsEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No flags registered.' }));
      } else {
        keys.forEach(function (k) {
          var val = flags[k];
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-type', text: k }),
            Ren.el('span', { cls: val ? 'metric-chip' : 'chip-warn', text: String(val) }),
          ]);
          // Toggle button (only for non-protected flags)
          var prot = Gov ? Gov.getProtectedFlags() : [];
          var isProtected = prot.some(function (p) {
            return typeof p === 'object' ? k.indexOf(p.flag || '') !== -1 : false;
          });
          if (!isProtected) {
            var tBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Toggle' });
            tBtn.addEventListener('click', function () {
              CP.setFlag(k, !CP.getFlag(k));
            });
            row.appendChild(tBtn);
          } else {
            row.appendChild(Ren.el('span', { cls: 'chip-warn', text: '🔒 Protected' }));
          }
          flagsEl.appendChild(row);
        });
      }
    }

    // Protected flags
    var protEl = this._c.querySelector('#ctrl-protected');
    if (protEl && Gov) {
      protEl.innerHTML = '';
      Gov.getProtectedFlags().forEach(function (p) {
        var label = typeof p === 'object' ? (p.flag || JSON.stringify(p)) : String(p);
        protEl.appendChild(Ren.el('span', { cls: 'metric-chip', text: '🔒 ' + label }));
      });
    }

    // Quarantine
    var quarEl = this._c.querySelector('#ctrl-quarantine');
    if (quarEl && Gov) {
      quarEl.innerHTML = '';
      var q = Gov.getQuarantined();
      var qKeys = Object.keys(q);
      if (!qKeys.length) {
        quarEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No quarantined subsystems.' }));
      } else {
        qKeys.forEach(function (id) {
          var row = Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'chip-warn', text: '🚫 ' + id }),
            Ren.el('span', { text: ' — ' + (q[id] || '') }),
          ]);
          var liftBtn = Ren.el('button', { cls: 'dbg-btn dbg-btn-sm', text: 'Lift' });
          liftBtn.addEventListener('click', function () { Gov.lift(id); });
          row.appendChild(liftBtn);
          quarEl.appendChild(row);
        });
      }
    }

    // Audit trail
    var auditEl = this._c.querySelector('#ctrl-audit');
    if (auditEl && CP) {
      auditEl.innerHTML = '';
      var audits = CP.getAudit().slice(-20).reverse();
      if (!audits.length) {
        auditEl.appendChild(Ren.el('div', { cls: 'empty-state', text: 'No commands executed yet.' }));
      } else {
        audits.forEach(function (a) {
          auditEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
            Ren.el('span', { cls: 'tl-ts',   text: Ren.fmtTs(a.ts) }),
            Ren.el('span', { cls: 'tl-type', text: a.cmd || '—' }),
            Ren.el('span', { cls: a.ok ? 'metric-chip' : 'chip-warn', text: a.ok ? '✓' : '✗' }),
          ]));
        });
      }
    }

    // Governance policies
    var polEl = this._c.querySelector('#ctrl-policies');
    if (polEl && Gov) {
      polEl.innerHTML = '';
      Gov.getPolicies().forEach(function (p) {
        polEl.appendChild(Ren.el('div', { cls: 'tl-row' }, [
          Ren.el('span', { cls: 'tl-type', text: p.id }),
          Ren.el('span', { text: ' — ' + p.desc }),
        ]));
      });
    }
  };

  G.PanelControl = PanelControl;
  console.debug(LOG, 'v' + VERSION + ' ready');

}(window));

// pdf-excel-xlsx-worker.js — Dedicated XLSX builder for PdfToExcelApp (Phase 2B)
// Terminate-after-job: PdfToExcelApp spawns this worker FRESH per conversion job
// and terminates it the moment a response is received (or on error/timeout).
// This worker does NOT share the global WorkerPool slot — completely isolated.
//
// Protocol:
//   IN  { op: 'build-xlsx', sheets: Array<SheetObj>, jobId: string }
//   OUT { buffer: ArrayBuffer, jobId: string }  (transferable)
//   ERR { __error: string, jobId: string }
//
// SheetObj: { name: string, rows: Array<Array<string|number>> }

var _xlsxLoaded = false;

function _ensureXlsx() {
  if (!_xlsxLoaded) {
    importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    _xlsxLoaded = true;
  }
}

function _coerceCell(cell) {
  if (cell === null || cell === undefined) return '';
  var s = String(cell).trim();
  if (!s) return '';
  var num = parseFloat(s.replace(/[$,%\s]/g, ''));
  return (!isNaN(num) && /^-?[\d,.$% ]+$/.test(s)) ? num : s;
}

function _sanitizeSheetName(name) {
  return (name || 'Sheet')
    .replace(/[\\\/\?\*\[\]:]/g, '_')
    .slice(0, 31);
}

function buildXlsx(sheets) {
  _ensureXlsx();
  var wb = self.XLSX.utils.book_new();

  for (var i = 0; i < sheets.length; i++) {
    var s         = sheets[i];
    var rows      = (s.rows && s.rows.length) ? s.rows : [['(empty)']];
    var coerced   = rows.map(function (r) {
      return r.map(function (c) { return _coerceCell(c); });
    });

    var ws = self.XLSX.utils.aoa_to_sheet(coerced);

    var maxCol = 0;
    coerced.forEach(function (r) { maxCol = Math.max(maxCol, r.length); });

    var colWidths = [];
    for (var ci = 0; ci < maxCol; ci++) {
      var maxLen = 8;
      for (var ri = 0; ri < coerced.length; ri++) {
        var v = coerced[ri][ci];
        var len = (v === undefined || v === null) ? 0 : String(v).length;
        if (len > maxLen) maxLen = len;
      }
      colWidths.push({ wch: Math.min(60, Math.ceil(maxLen * 1.1)) });
    }
    ws['!cols'] = colWidths;

    if (coerced.length > 1) {
      ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };
    }

    self.XLSX.utils.book_append_sheet(wb, ws, _sanitizeSheetName(s.name));
  }

  var arr = self.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(arr).buffer;
}

self.onmessage = function (ev) {
  var jobId = (ev.data && ev.data.jobId) || '';
  try {
    var data = ev.data || {};
    if (data.op !== 'build-xlsx') throw new Error('Unknown op: ' + data.op);
    if (!data.sheets || !data.sheets.length) throw new Error('No sheets provided');
    var buf = buildXlsx(data.sheets);
    self.postMessage({ buffer: buf, jobId: jobId }, [buf]);
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || 'XLSX build error', jobId: jobId });
  }
};

self.onmessageerror = function () {
  self.postMessage({ __error: 'Message deserialization error', jobId: '' });
};

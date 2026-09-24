// Browser-only XLS/XLSX -> PDF worker boundary.
// Keeps XLSX parsing and PDF generation off the main thread.
importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

self.onmessage = async function (event) {
  const data = event.data || {};
  if (data.type !== 'spreadsheet-to-pdf') return;
  try {
    if (!(data.buffer instanceof ArrayBuffer)) throw new Error('Invalid spreadsheet buffer');
    const XLSX = self.XLSX;
    const PDFLib = self.PDFLib;
    if (!XLSX || !PDFLib) throw new Error('Spreadsheet/PDF engines unavailable');

    const wb = XLSX.read(new Uint8Array(data.buffer), { type: 'array', cellDates: true });
    if (!wb.SheetNames.length) throw new Error('No sheets found in spreadsheet');

    const pageSize = String(data.pageSize || 'A4');
    const sizes = { A4: [595, 842], Letter: [612, 792], A3: [842, 1191] };
    const base = sizes[pageSize] || sizes.A4;
    const margin = data.margins === 'none' ? 10 : data.margins === 'narrow' ? 25 : 40;
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const fontSize = 8;
    const lineHeight = 11;

    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      if (!rows.length) continue;
      const maxCols = Math.max(1, ...rows.map(r => r.length));
      const landscape = String(data.orientation || '') === 'landscape' || (!data.orientation && maxCols > 6);
      const [PW, PH] = landscape ? [base[1], base[0]] : base;
      const usableW = PW - margin * 2;
      const colW = Math.max(28, Math.min(usableW / maxCols, 120));
      const rowsPerPage = Math.max(1, Math.floor((PH - margin * 2 - 30) / lineHeight));

      for (let start = 0; start < rows.length; start += rowsPerPage) {
        const page = doc.addPage([PW, PH]);
        let y = PH - margin;
        const chunk = rows.slice(start, start + rowsPerPage);
        chunk.forEach((row, ri) => {
          const isHeader = start === 0 && ri === 0;
          const values = Array.from({ length: maxCols }, (_, ci) => String(row[ci] == null ? '' : row[ci]));
          values.forEach((value, ci) => {
            const x = margin + ci * colW;
            const clipped = value.length > 24 ? value.slice(0, 23) + '…' : value;
            if (isHeader) page.drawRectangle({ x, y: y - lineHeight + 2, width: colW, height: lineHeight, color: PDFLib.rgb(0.93, 0.95, 0.97) });
            page.drawText(clipped, { x: x + 2, y: y - 8, size: fontSize, font: isHeader ? bold : font, color: PDFLib.rgb(0.08, 0.1, 0.13), maxWidth: Math.max(10, colW - 4) });
            page.drawRectangle({ x, y: y - lineHeight + 2, width: colW, height: lineHeight, borderColor: PDFLib.rgb(0.75, 0.78, 0.82), borderWidth: 0.35 });
          });
          y -= lineHeight;
        });
        page.drawText(String(sheetName), { x: margin, y: 8, size: 6, font, color: PDFLib.rgb(0.4, 0.42, 0.45) });
      }
    }

    const output = await doc.save({ useObjectStreams: true });
    const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    self.postMessage({ type: 'spreadsheet-to-pdf-done', buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ type: 'spreadsheet-to-pdf-error', message: error && error.message ? error.message : String(error) });
  }
};

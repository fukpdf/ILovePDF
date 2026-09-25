// pdf-word-extract-worker.js — PDF.js text extraction worker for PDF→Word.
// Protocol: {op:'extract-text',buffer:ArrayBuffer,jobId} -> {pages:[{pageNum,items}],jobId}
var PDFJS_URL='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
var PDFJS_WORKER='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
function normSym(t){return (t||'').replace(/[☑✓✔☒✗✘]/g,'[x]').replace(/[☐□\u2610]/g,'[ ]').replace(/[\u2611\u2612]/g,'[x]');}
function isSignLine(t){var s=(t||'').trim();return /^[_]{6,}$/.test(s)||/^[-]{8,}$/.test(s)||/^[=]{8,}$/.test(s)||/^\.{8,}$/.test(s)||/^_{3,}\s*(Date|Sign|Name|Title|Signature|Witness)[:\s]*_{0,}$/i.test(s);}
function isFormLine(t){return /^[A-Za-z\u0600-\u06FF\s]{2,40}:\s*\S/.test(t)||/^[A-Za-z\u0600-\u06FF\s]{2,40}[.]{5,}\s*\S/.test(t);}
var LIST_RE=/^\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb]\s/;
var NUMLIST_RE=/^\s*(?:\d+|[a-zA-Z])[.)]\s+\S/;
var SECTION_RE=/^(CHAPTER|SECTION|PART|ARTICLE|APPENDIX)\s+[\d\w]/i;

function structureParagraphs(items) {
    if (!items || !items.length) return [];

    var validItems = items.filter(function (it) { return it.str && it.str.trim() && it.transform; });
    if (!validItems.length) return [];

    // Font-height stats
    var heights = validItems.map(function (it) { return Math.abs(it.transform[3]); }).filter(function (h) { return h > 0; });
    heights.sort(function (a, b) { return a - b; });
    var medH = heights[Math.floor(heights.length / 2)] || 10;
    var maxH = heights[heights.length - 1] || 10;
    var yBkt = Math.max(2, Math.min(8, Math.round(medH * 0.35)));

    // Group into y-buckets
    var lineMap = {};
    validItems.forEach(function (it) {
      var yk = Math.round(it.transform[5] / yBkt) * yBkt;
      if (!lineMap[yk]) lineMap[yk] = [];
      lineMap[yk].push(it);
    });

    var ys  = Object.keys(lineMap).map(Number).sort(function (a, b) { return b - a; });
    var out = [];
    var lastY = null, lastText = '', lastH = medH;

    ys.forEach(function (y) {
      var row   = lineMap[y].sort(function (a, b) { return a.transform[4] - b.transform[4]; });
      var txt   = '';
      for (var i = 0; i < row.length; i++) {
        var s = row[i].str || '';
        if (!s) continue;
        if (txt && !txt.endsWith(' ') && !s.startsWith(' ')) {
          // Insert space if there is a visual gap between glyphs
          var prevRight = i > 0 ? (row[i - 1].transform[4] + (row[i - 1].width || 0)) : 0;
          if (prevRight > 0 && (row[i].transform[4] - prevRight) > medH * 0.25) txt += ' ';
        }
        txt += s;
      }
      txt = normSym(txt.trim());
      if (!txt) return;

      var lineH    = Math.max.apply(null, row.map(function (it) { return Math.abs(it.transform[3]); }));
      var lineBold = row.some(function (it) { return it.fontName && /bold/i.test(it.fontName); });
      var lineItal = row.some(function (it) { return it.fontName && /italic|oblique/i.test(it.fontName); });

      if (isSignLine(txt)) {
        out.push({ text: txt, isHeading: false, isList: false, isNumList: false, isSignature: true, fontSize: lineH });
        lastY = y; lastText = txt; lastH = lineH; return;
      }

      var isList    = LIST_RE.test(txt);
      var isNumList = NUMLIST_RE.test(txt);
      var isSection = SECTION_RE.test(txt.trim());
      var isForm    = !isList && !isNumList && isFormLine(txt);
      var isHeading = !isList && !isForm && (
        lineH > medH * 1.3 || (lineBold && lineH >= medH) || isSection ||
        (txt.length >= 2 && txt.length < 90 && txt === txt.toUpperCase() && /[A-Z]/.test(txt))
      );
      var level = 0;
      if (isHeading) {
        level = lineH >= maxH * 0.85 ? 1 : lineH >= medH * 1.5 ? 2 : lineH >= medH * 1.2 ? 3 : 4;
      }

      var gap      = lastY !== null ? lastY - y : 0;
      var newBlock = gap > medH * 2.0 || isHeading || isForm || isSection;
      var sentEnd  = lastText ? /[.!?:;)\]"'\u2019\u201d]$/.test(lastText.trim()) : true;
      var merge    = !newBlock && !sentEnd && gap > 0 && gap < medH * 1.8 &&
                     Math.abs(lineH - lastH) < medH * 0.3 && lastY !== null && !isForm;

      if (merge && out.length) {
        var last = out[out.length - 1];
        if (last && !last.isHeading && !last.isSignature && !last.isForm) {
          last.text = last.text.trim().endsWith('-')
            ? last.text.trim().slice(0, -1) + txt
            : last.text + ' ' + txt;
          last.bold   = last.bold   || lineBold;
          last.italic = last.italic || lineItal;
          lastY = y; lastText = txt; lastH = lineH; return;
        }
      }
      var xs = row.map(function (it) { return it.transform[4]; }).filter(function (x) { return x > 0; });
      out.push({
        text: txt, isHeading: isHeading, isList: isList, isNumList: isNumList,
        isSection: isSection, isForm: isForm, bold: lineBold, italic: lineItal,
        level: level, fontSize: lineH,
        xPositions: xs.length > 1 ? xs : undefined, pageWidth: 612,
      });
      lastY = y; lastText = txt; lastH = lineH;
    });

    // Remove consecutive duplicates (scanning artefacts)
    return out.filter(function (p, i) {
      return i === 0 || p.text.trim().toLowerCase() !== out[i - 1].text.trim().toLowerCase();
    });
  }
var _libPromise=null;
async function loadPdfJs(){if(_libPromise)return _libPromise;_libPromise=import(PDFJS_URL).then(function(m){var lib=m.default||m;lib.GlobalWorkerOptions.workerSrc=PDFJS_WORKER;return lib;});return _libPromise;}
self.onmessage=async function(ev){var d=ev.data||{};if(d.op!=='extract-text')return;var pdf=null;try{if(!d.buffer)throw new Error('Missing PDF buffer');var lib=await loadPdfJs();pdf=await lib.getDocument({data:d.buffer,isEvalSupported:false}).promise;var pages=[];for(var i=1;i<=pdf.numPages;i++){var page=await pdf.getPage(i),content=await page.getTextContent();pages.push({pageNum:i,paragraphs:structureParagraphs(content.items.map(function(it){return {str:it.str||'',transform:it.transform||null,width:it.width||0,height:it.height||0,fontName:it.fontName||''};}))});page.cleanup();self.postMessage({op:'progress',jobId:d.jobId,page:i,total:pdf.numPages});}await pdf.destroy();pdf=null;self.postMessage({op:'result',jobId:d.jobId,pages:pages});}catch(e){try{if(pdf)await pdf.destroy();}catch(_){}self.postMessage({op:'error',jobId:d.jobId,error:String(e&&e.message||e)});}};

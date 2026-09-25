// pdf-word-ocr-worker.js — Tesseract recognition + OCR text structuring boundary for PDF→Word.
var TESS_URL='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';
var TESS_WORKER_URL='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
var TESS_LANG_PATH='https://tessdata.projectnaptha.com/4.0.0';
var _tesseractPromise=null;
var _active=null;
var LIST_RE=/^\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb]\s/;
var NUMLIST_RE=/^\s*(?:\d+|[a-zA-Z])[.)]\s+\S/;
function normSym(t){return (t||'').replace(/[☑✓✔☒✗✘]/g,'[x]').replace(/[☐□\u2610]/g,'[ ]').replace(/[\u2611\u2612]/g,'[x]');}
function structureOcrText(text){
  var lines=(text||'').split(/\r?\n/).filter(function(l){return l.trim();});
  var paras=lines.map(function(line){
    var t=normSym(line.trim()); if(!t)return null;
    var isList=LIST_RE.test(t), isNumList=NUMLIST_RE.test(t);
    var isHeading=!isList && t.length>=2 && t.length<90 && t===t.toUpperCase() && /[A-Z]/.test(t);
    return {text:t,isHeading:isHeading,isList:isList,isNumList:isNumList,level:isHeading?1:0};
  }).filter(Boolean);
  if(!paras.length)paras=[{text:'(no content)',isHeading:false}];
  return paras;
}
async function loadTesseract(){if(_tesseractPromise)return _tesseractPromise;_tesseractPromise=import(TESS_URL).then(function(m){return m.default||m;});return _tesseractPromise;}
self.onmessage=async function(ev){
  var d=ev.data||{}; if(d.op!=='recognize')return;
  try{
    if(!d.buffer)throw new Error('Missing OCR image buffer');
    var T=await loadTesseract(), lang=d.lang||'eng';
    _active=await T.createWorker(lang,1,{workerPath:TESS_WORKER_URL,langPath:TESS_LANG_PATH,workerBlobURL:false,logger:function(){}});
    var blob=new Blob([d.buffer],{type:'image/png'});
    var ret=await _active.recognize(blob);
    var text=ret&&ret.data&&typeof ret.data.text==='string'?ret.data.text:'';
    var paragraphs=structureOcrText(text);
    await _active.terminate();_active=null;
    var charCount=text.length;
    self.postMessage({op:'result',text:text,paragraphs:paragraphs,charCount:charCount,readable:charCount>=10,jobId:d.jobId});
  }catch(e){
    try{if(_active)await _active.terminate();}catch(_){}
    _active=null;
    self.postMessage({op:'error',jobId:d.jobId,error:String(e&&e.message||e)});
  }
};

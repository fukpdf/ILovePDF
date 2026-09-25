// pdf-word-ocr-worker.js — Tesseract recognition boundary for PDF→Word OCR.
// The outer worker is managed by WorkerPool. Tesseract.js then creates its own
// documented browser worker inside this isolated boundary.
var TESS_URL='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';
var TESS_WORKER_URL='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
var TESS_LANG_PATH='https://tessdata.projectnaptha.com/4.0.0';
var _tesseractPromise=null;
var _active=null;
async function loadTesseract(){
  if(_tesseractPromise)return _tesseractPromise;
  _tesseractPromise=import(TESS_URL).then(function(m){return m.default||m;});
  return _tesseractPromise;
}
self.onmessage=async function(ev){
  var d=ev.data||{};
  if(d.op!=='recognize')return;
  try{
    if(!d.buffer)throw new Error('Missing OCR image buffer');
    var T=await loadTesseract();
    var lang=d.lang||'eng';
    _active=await T.createWorker(lang,1,{workerPath:TESS_WORKER_URL,langPath:TESS_LANG_PATH,workerBlobURL:false,logger:function(){}});
    var blob=new Blob([d.buffer],{type:'image/png'});
    var ret=await _active.recognize(blob);
    var text=ret&&ret.data&&typeof ret.data.text==='string'?ret.data.text:'';
    await _active.terminate();_active=null;
    self.postMessage({op:'result',text:text,jobId:d.jobId});
  }catch(e){
    try{if(_active)await _active.terminate();}catch(_){}
    _active=null;
    self.postMessage({op:'error',jobId:d.jobId,error:String(e&&e.message||e)});
  }
};

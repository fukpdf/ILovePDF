// pdf-word-render-worker.js — isolated PDF page rasteriser for PDF→Word OCR.
// Protocol: {op:'render-page',buffer:ArrayBuffer,pageNum:number,scale:number,jobId:string}
// -> {op:'result',pageNum,width,height,mimeType,buffer:ArrayBuffer,jobId:string}
// The worker owns PDF.js parsing and OffscreenCanvas rendering; Tesseract remains
// outside this worker until its nested-worker/browser contract is independently verified.
var PDFJS_URL='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
var PDFJS_WORKER='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
var _libPromise=null;
async function loadPdfJs(){
  if(_libPromise)return _libPromise;
  _libPromise=import(PDFJS_URL).then(function(m){
    var lib=m.default||m;
    lib.GlobalWorkerOptions.workerSrc=PDFJS_WORKER;
    return lib;
  });
  return _libPromise;
}
self.onmessage=async function(ev){
  var d=ev.data||{};
  if(d.op!=='render-page')return;
  var pdf=null;
  try{
    if(!d.buffer)throw new Error('Missing PDF buffer');
    if(typeof OffscreenCanvas==='undefined')throw new Error('OffscreenCanvas unavailable');
    var pageNum=Math.max(1,Number(d.pageNum)||1);
    var scale=Math.max(0.75,Math.min(2.5,Number(d.scale)||1.5));
    var lib=await loadPdfJs();
    pdf=await lib.getDocument({data:d.buffer,isEvalSupported:false}).promise;
    if(pageNum>pdf.numPages)throw new Error('Requested page exceeds PDF page count');
    var page=await pdf.getPage(pageNum);
    var viewport=page.getViewport({scale:scale});
    var canvas=new OffscreenCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    var ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
    if(!ctx)throw new Error('OffscreenCanvas 2D context unavailable');
    await page.render({canvasContext:ctx,viewport:viewport}).promise;
    var blob=await canvas.convertToBlob({type:'image/png'});
    var buffer=await blob.arrayBuffer();
    page.cleanup();
    canvas.width=1;canvas.height=1;
    await pdf.destroy();pdf=null;
    self.postMessage({op:'result',pageNum:pageNum,width:Math.ceil(viewport.width),height:Math.ceil(viewport.height),mimeType:'image/png',buffer:buffer,jobId:d.jobId},[buffer]);
  }catch(e){
    try{if(pdf)await pdf.destroy();}catch(_){}
    self.postMessage({op:'error',pageNum:d.pageNum,jobId:d.jobId,error:String(e&&e.message||e)});
  }
};

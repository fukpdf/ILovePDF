// Shared native PDF content extraction worker.
// Extracts PDF.js text items only; layout reconstruction remains in each tool because
// Word and PowerPoint have different fidelity rules. One worker job per conversion.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
self.onmessage = async function (event) {
  const d = event.data || {};
  if (d.type !== 'extract-pdf-content') return;
  try {
    if (!(d.buffer instanceof ArrayBuffer)) throw new Error('Invalid PDF buffer');
    const pdf = await self.pdfjsLib.getDocument({data:new Uint8Array(d.buffer),isEvalSupported:false,disableWorker:true}).promise;
    try {
      for (let i=1;i<=pdf.numPages;i++) {
        const page=await pdf.getPage(i);
        const content=await page.getTextContent();
        const items=content.items.map(it=>({str:it.str||'',transform:Array.isArray(it.transform)?it.transform.slice(0,6):null,width:Number(it.width)||0,fontName:it.fontName||''}));
        self.postMessage({type:'pdf-content-page',pageNum:i,totalPages:pdf.numPages,items});
        page.cleanup();
      }
      self.postMessage({type:'pdf-content-done'});
    } finally { try{await pdf.destroy();}catch(_){} }
  } catch (error) { self.postMessage({type:'pdf-content-error',message:error&&error.message?error.message:String(error)}); }
};

// PDF text/table extraction worker. Native text path only; OCR remains a separate capability.
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');

function buildColumnRows(items) {
  const valid = (items || []).filter(it => it && it.str && it.str.trim() && it.transform);
  if (!valid.length) return [];
  const xs = valid.map(it => Math.round(it.transform[4])).sort((a,b) => a-b);
  const xRange = xs.length > 1 ? xs[xs.length - 1] - xs[0] : 100;
  const minGap = Math.max(20, xRange * 0.06);
  const splits = [0];
  for (let i=1;i<xs.length;i++) if (xs[i]-xs[i-1] > minGap) splits.push((xs[i-1]+xs[i])/2);
  splits.push(Infinity);
  if (splits.length <= 2) return [];
  function col(x){ for(let i=0;i<splits.length-1;i++) if(x>=splits[i]&&x<splits[i+1]) return i; return 0; }
  const cells = {}; let maxCol = 0;
  valid.forEach(it => { const y=Math.round(it.transform[5]/6)*6; const c=col(Math.round(it.transform[4])); maxCol=Math.max(maxCol,c); if(!cells[y])cells[y]={}; cells[y][c]=(cells[y][c] ? cells[y][c]+' ' : '')+it.str.trim(); });
  if(maxCol===0) return [];
  return Object.keys(cells).map(Number).sort((a,b)=>b-a).map(y=>{const row=[];for(let c=0;c<=maxCol;c++)row.push(cells[y][c]||'');return row;});
}

self.onmessage = async function(event){
  const data=event.data||{};
  if(data.type!=='extract-pdf-text') return;
  try{
    if(!(data.buffer instanceof ArrayBuffer)) throw new Error('Invalid PDF buffer');
    const pdf=await self.pdfjsLib.getDocument({data:new Uint8Array(data.buffer),isEvalSupported:false,disableWorker:true}).promise;
    const sheets=[];
    try{
      for(let i=1;i<=pdf.numPages;i++){
        const page=await pdf.getPage(i);
        const content=await page.getTextContent();
        const hasText=content.items.some(it=>it.str&&it.str.trim());
        const rows=hasText?buildColumnRows(content.items):[];
        const rawText=content.items.map(it=>it.str||'').join(' ').trim();
        sheets.push({name:'Page '+i,rows:rows.length?rows:[['(empty)']],text:rawText});
        page.cleanup();
      }
    } finally { try{await pdf.destroy();}catch(_){} }
    self.postMessage({type:'extract-pdf-text-done',sheets});
  }catch(error){self.postMessage({type:'extract-pdf-text-error',message:error&&error.message?error.message:String(error)});}
};

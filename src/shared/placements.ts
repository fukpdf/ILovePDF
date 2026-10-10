export interface ImagePlacement { name: string; widthPt: number; heightPt: number; }

type Matrix = [number,number,number,number,number,number];
const IDENTITY: Matrix = [1,0,0,1,0,0];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1],
    a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3],
    a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5],
  ];
}
function tokens(source: string): string[] {
  const out: string[] = [];
  for (let i=0;i<source.length;) {
    const ch=source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "%") { while(i<source.length && source[i] !== "\n" && source[i] !== "\r") i++; continue; }
    if (ch === "(") {
      i++; let depth=1;
      while(i<source.length && depth) {
        if(source[i] === "\\") { i += 2; continue; }
        if(source[i] === "(") depth++;
        else if(source[i] === ")") depth--;
        i++;
      }
      out.push("<string>"); continue;
    }
    if (ch === "<" && source[i+1] === "<") { out.push("<<"); i+=2; continue; }
    if (ch === ">" && source[i+1] === ">") { out.push(">>"); i+=2; continue; }
    if (ch === "<") { i++; while(i<source.length && source[i]!==">") i++; i++; out.push("<hex>"); continue; }
    if (ch === "/" ) {
      let j=++i; while(i<source.length && !/[\s()[\]{}<>/%]/.test(source[i])) i++;
      out.push("/"+source.slice(j,i)); continue;
    }
    if ("[]{}".includes(ch)) { out.push(ch); i++; continue; }
    let j=i; while(i<source.length && !/[\s()[\]{}<>/%]/.test(source[i])) i++;
    if (j===i) { i++; continue; }
    out.push(source.slice(j,i));
  }
  return out;
}

/** Parse image Do placements while tracking q/Q and concatenated cm transforms. */
export function parsePlacements(source: string): ImagePlacement[] {
  const ts=tokens(source), result: ImagePlacement[]=[];
  let ctm: Matrix=[...IDENTITY], stack: Matrix[]=[];
  let operands: string[]=[];
  for(let i=0;i<ts.length;i++) {
    const t=ts[i];
    if(t==="BI") {
      // Inline image data is opaque; skip to ID and then the next delimiter EI.
      while(i<ts.length && ts[i]!=="ID") i++;
      while(i<ts.length && ts[i]!=="EI") i++;
      operands=[]; continue;
    }
    if(t==="q") { stack.push([...ctm]); operands=[]; continue; }
    if(t==="Q") { ctm=stack.pop() ?? [...IDENTITY]; operands=[]; continue; }
    if(t==="cm" && operands.length>=6) {
      const v=operands.slice(-6).map(Number);
      if(v.every(Number.isFinite)) ctm=multiply(ctm,v as Matrix);
      operands=[]; continue;
    }
    if(t==="Do") {
      const name=operands[operands.length-1];
      if(name?.startsWith("/") && name.length>1) {
        const width=Math.hypot(ctm[0],ctm[1]), height=Math.hypot(ctm[2],ctm[3]);
        if(width>0 && height>0) result.push({name:name.slice(1),widthPt:width,heightPt:height});
      }
      operands=[]; continue;
    }
    if(["BT","ET","Tf","Tj","TJ","Td","TD","Tm","T*","gs","w","J","j","M","d","ri","i","m","l","c","v","y","h","re","S","s","f","F","f*","B","B*","b","b*","n","W","W*","Do","BI","ID","EI"].includes(t)) {
      operands=[]; continue;
    }
    operands.push(t);
  }
  return result;
}

import test from "node:test";
import assert from "node:assert/strict";
import { psnr, sharpness, pickSamplePages, judgeSample, textCheck, type GateReport } from "../src/shared/quality";
import { buildGsArgs, buildQpdfArgs } from "../src/shared/gsParams";
import { MODE_POLICY } from "../src/shared/policy";
const rep=():GateReport=>({passed:false,pagesIn:1,pagesOut:1,textCharsIn:0,textCharsOut:0,samples:[],failures:[],notes:[]});
function checker(w:number,h:number,soft=false):Uint8Array{
  const px=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)px[y*w+x]=soft?128+((((x>>1)+(y>>1))%2)?20:-20):((x+y)%2?255:0);
  return px;
}
test("identical renders pass PSNR and sharpness",()=>{
  const a=checker(40,40),r=rep();
  judgeSample(1,{w:40,h:40,px:a},{w:40,h:40,px:a},32,.85,r);
  assert.equal(r.failures.length,0);assert.equal(r.samples[0].psnrDb,99);
});
test("blurrier render fails the sharpness gate",()=>{
  const r=rep();
  judgeSample(1,{w:40,h:40,px:checker(40,40)},{w:40,h:40,px:checker(40,40,true)},5,.85,r);
  assert.ok(r.failures.some(f=>/blurrier/.test(f)),r.failures.join(","));
  assert.ok(sharpness(checker(40,40),40,40)>sharpness(checker(40,40,true),40,40));
});
test("different render sizes and lost text fail closed",()=>{
  const r=rep();judgeSample(2,{w:10,h:10,px:new Uint8Array(100)},{w:11,h:10,px:new Uint8Array(110)},30,.8,r);
  assert.ok(r.failures[0].includes("different size"));
  const failures:string[]=[],notes:string[]=[];textCheck(1000,500,failures,notes);assert.equal(failures.length,1);
  textCheck(10,0,[],notes);assert.equal(notes.length,1);
});
test("sample pages are spread across the document",()=>{
  assert.deepEqual(pickSamplePages(1),[1]);assert.deepEqual(pickSamplePages(100,3),[1,50,100]);
});
test("PSNR decreases with pixel noise",()=>{
  const a=new Uint8Array(1000).fill(100),b=new Uint8Array(1000).fill(110);
  assert.ok(psnr(a,b)<30);assert.equal(psnr(a,a),99);
});
test("Ghostscript args protect mono, colour, annotations and chroma",()=>{
  for(const mode of ["recommended","extreme","custom"] as const){
    const a=buildGsArgs(mode,.5,"in.pdf","out.pdf").join(" ");
    assert.ok(a.includes("-dDownsampleMonoImages=false"));
    assert.ok(a.includes("/CCITTFaxEncode")&&!/jbig2/i.test(a));
    assert.ok(a.includes("/LeaveColorUnchanged"));
    assert.ok(a.includes("/HSamples [1 1 1 1]"));
    assert.ok(a.includes("-dEmbedAllFonts=true")&&a.includes("-dPreserveAnnots=true"));
    assert.ok(!/webp|avif/i.test(a));
    assert.ok(Number(/-dColorImageResolution=(\d+)/.exec(a)?.[1]??0)>=MODE_POLICY[mode].floorDpi);
  }
  assert.ok(buildQpdfArgs("a","b").includes("--linearize"));
});

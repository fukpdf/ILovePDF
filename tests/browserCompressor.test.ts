import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import * as jpeg from "jpeg-js";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, StandardFonts } from "pdf-lib";
import { compressInBrowser } from "../src/browser/browserCompressor";

const GRAY_JPEG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/wAALCABAAIABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAAAwcI/8QAFxAAAwEAAAAAAAAAAAAAAAAAAAIEYf/aAAgBAQAAPwDOCT4Ok+CpOOk+DJPgyT4Mk+DJPgyT4Mk+DJPgyT4Mk+DJPgyTjJPg6T4Mk+DJPhOknwZJ8GSfBknwZJ8GSfBknwZJ8GSfBknwdJ8GSfBknwZJ8GSfBknwnKT4Ok+DJPgyT4Mk+DJPgyT4Mk+DJPgyT4Mk+DpPgyT4Mk+DJPgyT4TpJ8GSfBknwZJ8GSfBknwZJxknwZJ8GSfBknwdJ8GSfBknwZJ8GSfCdJPgyT4Mk+DJPgyT4Mk+DJPgyT4Mk+DJPg6T4Mk+DJPgyT4Mk+DJPhOknwZJ8GSfBknwZJ8GSfBknwZJ8GScdJ8GSfBknwZJxknGSfBknwnST4Mk+DJPgyT4Mk+DJPg6T4Mk+DJPgyT4Mk+DJPgyT4Mk+DJPgyT4TpJ8GSfBknwZJ8GSfBknwZJ8GSfB0nwZJ8GSfBknwZJ8GSfBknwZJ8P//Z";
const CMYK_JPEG_B64 = "/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwAFAwQEBAMFBAQEBQUFBgcMCAcHBwcPCwsJDBEPEhIRDxERExYcFxMUGhURERghGBodHR8fHxMXIiQiHiQcHh8e/8AAFAgAQACABEMRAE0RAFkRAEsRAP/EABoAAQEBAAMBAAAAAAAAAAAAAAADBQYHCQj/xAAaEAEAAgMBAAAAAAAAAAAAAAAAAgQUQWJh/9oADgRDAE0AWQBLAAA/APmmu+acLx1RCD7LaVbRheLwgNKtowvFoQGlW0YXi0IDSraMLxeEBpVzC8WhAaVbRheLwgNKtowvFoQGlW0YXi0IDSraMLxeEBpVzC8WhAaVbRheLwgNGtowvFoQGlW0YXi0IDSraMLxeEBpVzC8WhAeeVdyTC5dUQgNKtowuV4QGlW0YXK0IDSraMLlaEBpVtGFyvCA0q5hcrQgNKtowuV4QGlW0YXK0IDSraMLlaEBpVtGFyvCA0q5hcrQgNKtowuV4QGjW0YXK0IDSraMLlaEBpVtGFyvCA0q5hcrQgPPKu5JhcuqIQGlW0YXK0IDSraMLleEBpVtGFytCA0q2jC5XhAaVcwuVoQGlW0YXK0IDSraMLleEBpVtGFytCA0q2jC5XhAaVcwuVoQGlW0YXK8IDRraMLlaEBpVtGFytCA0q2jC5XhAaVcwuVoQHnlXckwvHVEIDSraMLxaEBpVtGF4vCA0q2jC8WhAaVbRheLwgNKuYXi0IDSraMLxaEBpVtGF4vCA0q2jC8WhAaVbRheLwgNKuYXi0IDSraMLxeEBo1tGF4tCA0q2jC8WhAaVbRheLwgNKuYXi0IDzyruSYXLqiEBpVtGFytCA0q2jC5XhAaVbRhcrQgNKtowuV4QGlXMLlaEBpVtGFytCA0q2jC5XhAaVbRhcrQgNKtowuV4QGlXMLlaEBpVtGFytCA0a2jC5XhAaVbRhcrQgNKtowuV4QGlXMLlaEB55V3I8Lx1RCA0q2jC8WhAaVbRheLwgNKtowvFoQGlW0YXi8IDSrmF4tCA0q2jC8WhAaVbRheLwgNKtowvFoQGlW0YXi8IDSrmF4tCA0q2jC8WhAaNbRheLwgNKtowvFoQGlW0YXi8IDSrmF4tCA88q7kmFy6ohAaVbRhcrQgNKtowuV4QGlW0YXK0IDSraMLleEBpVzC5WhAaVbRhcrQgNKtowuV4QGlW0YXK0IDSraMLleEBpVzC5WhAaVbRhcrQgNGtowuV4QGlW0YXK0IDSraMLleEBpVzC5WhAeeVdyTC5dUQgNKtowuVoQGlW0YXK8IDSraMLlaEBpVtGFyvCA0q5hcrQgNKtowuVoQGlW0YXK8IDSraMLlaEBpVtGFyvCA0q5hcrQgNKtowuVoQGjW0YXK8IDSraMLlaEBpVtGFyvCA0q5hcrQgP/Z";
const CCITT_G4_B64 = "MxTMUzFMxTMUzFMxTMX//////////////////yaimYpmKZimYpmKZimYv///////////////////5mKZimYpmKZimYpmKZi//////////////////+TUUzFMxTMUzFMxTMUzF////////////////////MxTMUzFMxTMUzFMxTMX//////////////////yaimYpmKZimYpmKZimYv///////////////////5mKZimYpmKZimYpmKZi//////////////////+TUUzFMxTMUzFMxTMUzF////////////////////ABABA=";
const ALPHA_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZ0lEQVR42u3QQREAIBAAodW54Ea3h/KgAKtOU/tf065/CRAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQICAF1wxEiN01ib7sAAAAABJRU5ErkJggg==";

async function makePdfWithJpeg(bytes: Uint8Array, placements: Array<{ x: number; y: number; width: number; height: number }> = [{x:30,y:300,width:120,height:60}]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const image = await doc.embedJpg(bytes);
  for (const box of placements) page.drawImage(image, box);
  return new Uint8Array(await doc.save({ useObjectStreams: false, updateMetadata: false }));
}
async function makeRgbPhoto(): Promise<Uint8Array> {
  const width=800,height=400,rgba=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++){
    const i=(y*width+x)*4, noise=((x*37+y*71+(x*y)%97)%19)-9;
    rgba[i]=Math.max(0,Math.min(255,40+Math.floor(x*.22)+noise));
    rgba[i+1]=Math.max(0,Math.min(255,35+Math.floor(y*.4)+noise));
    rgba[i+2]=Math.max(0,Math.min(255,85+Math.floor(x*.08+y*.12)+noise));
    rgba[i+3]=255;
  }
  return new Uint8Array(jpeg.encode({data:rgba,width,height},92).data);
}
function imageStreams(doc: PDFDocument): Array<{ref: PDFRef; stream: PDFRawStream}> {
  return doc.context.enumerateIndirectObjects().flatMap(([ref,obj]) =>
    obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of("Subtype"))?.toString()==="/Image"
      ? [{ref,stream:obj}] : []);
}
function streamBytes(doc: PDFDocument, key: string): Uint8Array {
  const found=imageStreams(doc).find(({stream})=>stream.dict.lookup(PDFName.of("ColorSpace"))?.toString()===key);
  assert.ok(found, `expected image with ColorSpace ${key}`);
  return found.stream.contents;
}
async function forceFlateTextStream(bytes: Uint8Array): Promise<Uint8Array> {
  const doc=await PDFDocument.load(bytes,{updateMetadata:false}),page=doc.getPage(0),contents=page.node.Contents();
  const first=contents instanceof PDFArray?contents.get(0):contents;
  assert.ok(first instanceof PDFRef);
  const stream=doc.context.lookup(first);
  assert.ok(stream instanceof PDFRawStream);
  const decoded=decodePDFRawStream(stream).decode(),compressed=new Uint8Array(deflateSync(decoded));
  const dict=doc.context.obj({Filter:PDFName.of("FlateDecode"),Length:PDFNumber.of(compressed.length)}) as PDFDict;
  doc.context.assign(first,PDFRawStream.of(dict,compressed));
  return new Uint8Array(await doc.save({useObjectStreams:false,updateMetadata:false}));
}
async function decodedPageHashes(bytes: Uint8Array): Promise<string[]> {
  const doc=await PDFDocument.load(bytes,{updateMetadata:false}), page=doc.getPage(0), contents=page.node.Contents();
  const refs=contents instanceof PDFArray?Array.from({length:contents.size()},(_,i)=>contents.get(i)):contents?[contents]:[];
  return refs.map(item=>{
    const obj=item instanceof PDFRef?doc.context.lookup(item):item;
    assert.ok(obj instanceof PDFRawStream);
    return createHash("sha256").update(decodePDFRawStream(obj).decode()).digest("hex");
  });
}
async function makeCcittPdf(): Promise<Uint8Array> {
  const doc=await PDFDocument.create(),page=doc.addPage([612,792]);
  const dict=doc.context.obj({
    Type:PDFName.of("XObject"),Subtype:PDFName.of("Image"),Width:PDFNumber.of(128),Height:PDFNumber.of(64),
    ColorSpace:PDFName.of("DeviceGray"),BitsPerComponent:PDFNumber.of(1),Filter:PDFName.of("CCITTFaxDecode"),
    DecodeParms:doc.context.obj({K:PDFNumber.of(-1),Columns:PDFNumber.of(128),Rows:PDFNumber.of(64)}),
  }) as PDFDict;
  const imageRef=doc.context.register(PDFRawStream.of(dict,Buffer.from(CCITT_G4_B64,"base64")));
  const xobjects=doc.context.obj({Scan:imageRef}) as PDFDict;
  const resources=doc.context.obj({XObject:xobjects}) as PDFDict;
  page.node.set(PDFName.of("Resources"),resources);
  const contents=doc.context.register(PDFRawStream.of(doc.context.obj({}) as PDFDict,new TextEncoder().encode("q 128 0 0 64 0 0 cm /Scan Do Q")));
  page.node.set(PDFName.of("Contents"),contents);
  return new Uint8Array(await doc.save({useObjectStreams:false,updateMetadata:false}));
}

test("RGB photo uses a uniform downscale and a lower-or-equal JPEG quality", async()=>{
  const jpg=await makeRgbPhoto(), input=await makePdfWithJpeg(jpg,[{x:30,y:300,width:120,height:60},{x:250,y:300,width:180,height:100}]);
  const result=await compressInBrowser(input,{mode:"recommended"});
  assert.equal(result.ok,true);
  assert.ok(result.bytes.length<=input.length,"compression must never return a larger file");
  const changed=result.images.find(x=>x.action==="recompressed");
  assert.ok(result.bytes.length<input.length,"the eligible RGB photo fixture must compress");
  if(result.bytes.length<input.length){
    assert.ok(changed,"a smaller RGB photo output must report the changed image");
    assert.ok(changed!.newWidth! / changed!.newHeight! > 1.99 && changed!.newWidth! / changed!.newHeight! < 2.01,"aspect ratio must remain uniform");
    assert.ok((changed!.newWidth! / (180/72)) >= 149,"placed image horizontal resolution must not fall below the 150 DPI floor");
    assert.ok((changed!.newHeight! / (100/72)) >= 149,"placed image vertical resolution must not fall below the 150 DPI floor");
  }
  const beforeHashes=await decodedPageHashes(input),afterHashes=await decodedPageHashes(result.bytes);
  assert.deepEqual(afterHashes,beforeHashes,"decoded page content streams must remain byte-identical by SHA-256");
});

test("dedupe requires exact image dictionary and bytes and redirects references safely",async()=>{
  const jpg=await makeRgbPhoto(),doc=await PDFDocument.create(),page=doc.addPage([612,792]);
  const first=await doc.embedJpg(jpg),second=await doc.embedJpg(jpg);
  page.drawImage(first,{x:30,y:300,width:120,height:60});
  page.drawImage(second,{x:250,y:300,width:180,height:90});
  const input=new Uint8Array(await doc.save({useObjectStreams:false,updateMetadata:false}));
  const before=await PDFDocument.load(input,{updateMetadata:false});
  assert.ok(imageStreams(before).length>=2,"fixture must contain two distinct image objects");
  const result=await compressInBrowser(input,{mode:"recommended"});
  assert.ok(result.bytes.length<input.length,"duplicate image elimination should reduce this fixture");
  assert.ok(result.images.some(image=>image.action==="deduplicated"),"dedupe should be visible in the report");
  const after=await PDFDocument.load(result.bytes,{updateMetadata:false});
  assert.equal(imageStreams(after).length,1,"unreferenced duplicate object should be removed");
  assert.deepEqual(await decodedPageHashes(result.bytes),await decodedPageHashes(input));
});

test("real grayscale and CMYK JPEG streams are not re-encoded by the light engine",async()=>{
  for(const [b64,colorSpace] of [[GRAY_JPEG_B64,"/DeviceGray"],[CMYK_JPEG_B64,"/DeviceCMYK"]] as const){
    const input=await makePdfWithJpeg(Buffer.from(b64,"base64"),[{x:30,y:300,width:120,height:60}]);
    const before=await PDFDocument.load(input,{updateMetadata:false}),beforeImage=imageStreams(before).find(x=>x.stream.dict.lookup(PDFName.of("ColorSpace"))?.toString()===colorSpace);
    assert.ok(beforeImage,`fixture must be a valid ${colorSpace} JPEG`);
    const result=await compressInBrowser(input,{mode:"extreme"});
    assert.ok(result.bytes.length<=input.length);
    const after=await PDFDocument.load(result.bytes,{updateMetadata:false}),afterImage=imageStreams(after).find(x=>x.stream.dict.lookup(PDFName.of("ColorSpace"))?.toString()===colorSpace);
    assert.ok(afterImage);
    assert.deepEqual(Array.from(afterImage!.stream.contents),Array.from(beforeImage!.stream.contents),`${colorSpace} JPEG bytes must remain identical`);
    assert.equal(afterImage!.stream.dict.lookup(PDFName.of("ColorSpace"))?.toString(),colorSpace);
  }
});

test("SMask image streams are left untouched",async()=>{
  const doc=await PDFDocument.create(),page=doc.addPage([612,792]);
  const image=await doc.embedPng(Buffer.from(ALPHA_PNG_B64,"base64"));
  page.drawImage(image,{x:40,y:300,width:64,height:64});
  const input=new Uint8Array(await doc.save({useObjectStreams:false,updateMetadata:false}));
  const before=await PDFDocument.load(input,{updateMetadata:false});
  const masked=imageStreams(before).find(x=>x.stream.dict.has(PDFName.of("SMask")));
  assert.ok(masked,"transparent PNG should produce a PDF soft mask");
  const result=await compressInBrowser(input,{mode:"recommended"});
  const after=await PDFDocument.load(result.bytes,{updateMetadata:false});
  const maskedAfter=imageStreams(after).find(x=>x.stream.dict.has(PDFName.of("SMask")));
  assert.ok(maskedAfter);
  assert.deepEqual(Array.from(maskedAfter!.stream.contents),Array.from(masked!.stream.contents));
});

test("1-bit CCITT Group 4 scans are never resampled or re-encoded",async()=>{
  const input=await makeCcittPdf(),before=await PDFDocument.load(input,{updateMetadata:false});
  const imageBefore=imageStreams(before).find(x=>x.stream.dict.lookup(PDFName.of("Filter"))?.toString()==="/CCITTFaxDecode");
  assert.ok(imageBefore);
  assert.equal(imageBefore!.stream.dict.lookup(PDFName.of("BitsPerComponent"))?.toString(),"1");
  const result=await compressInBrowser(input,{mode:"extreme"});
  assert.ok(result.bytes.length<=input.length);
  const after=await PDFDocument.load(result.bytes,{updateMetadata:false});
  const imageAfter=imageStreams(after).find(x=>x.stream.dict.lookup(PDFName.of("Filter"))?.toString()==="/CCITTFaxDecode");
  assert.ok(imageAfter);
  assert.deepEqual(Array.from(imageAfter!.stream.contents),Array.from(imageBefore!.stream.contents));
  assert.equal(imageAfter!.stream.dict.lookup(PDFName.of("Width"))?.toString(),"128");
  assert.equal(imageAfter!.stream.dict.lookup(PDFName.of("Height"))?.toString(),"64");
});

test("Flate-compressed text PDF keeps decoded page-content SHA-256 and native text",async()=>{
  const doc=await PDFDocument.create(),page=doc.addPage([612,792]),font=await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Native searchable text, vectors, annotations and links stay in PDF objects.",{x:45,y:700,size:16,font});
  page.drawLine({start:{x:45,y:680},end:{x:400,y:680},thickness:2});
  const initial=new Uint8Array(await doc.save({useObjectStreams:false,updateMetadata:false}));
  const input=await forceFlateTextStream(initial);
  const beforeDoc=await PDFDocument.load(input,{updateMetadata:false});
  const contentValue=beforeDoc.getPage(0).node.Contents();
  const contentRef=contentValue instanceof PDFArray?contentValue.get(0):contentValue;
  assert.ok(contentRef instanceof PDFRef);
  const contentObj=beforeDoc.context.lookup(contentRef);
  assert.ok(contentObj instanceof PDFRawStream);
  assert.equal(contentObj.dict.lookup(PDFName.of("Filter"))?.toString(),"/FlateDecode");
  const beforeHashes=await decodedPageHashes(input);
  const result=await compressInBrowser(input,{mode:"recommended"});
  assert.ok(result.bytes.length<=input.length);
  assert.deepEqual(await decodedPageHashes(result.bytes),beforeHashes);
  const after=await PDFDocument.load(result.bytes,{updateMetadata:false});
  assert.equal(after.getPageCount(),1);
  assert.ok(after.getPage(0).node.Contents());
});

test("signature marker is a fail-closed no-op",async()=>{
  const doc=await PDFDocument.create();doc.addPage([612,792]);
  const input=new Uint8Array(await doc.save({useObjectStreams:false,updateMetadata:false}));
  const marker=Buffer.from("/ByteRange [0 1 2 3]\n","ascii");
  const original=Buffer.concat([Buffer.from(input),marker,Buffer.from("%%EOF\n","ascii")]);
  const result=await compressInBrowser(new Uint8Array(original),{mode:"recommended"});
  assert.deepEqual(Array.from(result.bytes),Array.from(original));
  assert.equal(result.keptOriginal,true);
});

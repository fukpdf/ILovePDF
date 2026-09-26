#!/usr/bin/env node
'use strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(__dirname,'..');
const BRIDGE=fs.readFileSync(path.join(ROOT,'public/js/special-page-i18n.js'),'utf8');
const LOCALES=['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];
const PAGES=[['n2w','public/n2w.html'],['currency-converter','public/currency-converter.html'],['qr-code-generator','public/qr-code-generator.html'],['barcode-generator','public/barcode-generator.html'],['image-compressor','public/image-compressor.html'],['image-converter','public/image-converter.html'],['zip-builder','public/zip-builder.html']];
const TAG_RE=/<(h1|h2|h3|h4|h5|h6|label|legend|p|button|summary|option|figcaption|a)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ATTR_RE=/<(?:input|textarea|select|button|summary|a)\b[^>]*(?:aria-label|title|placeholder)=(['"])(.*?)\1[^>]*>/gi;
function clean(raw){return raw.replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]+>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi,m=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[m.toLowerCase()]||' ')).replace(/\s+/g,' ').trim();}
function likelyVisible(t){return t&&t.length>=2&&!/^[\d\s.,:%+\-–—/()]+$/.test(t)&&!/^(JPG|PNG|WebP|JPEG|SVG|URL|SSID|ZIP|PDF)$/i.test(t)&&/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(t);}
function collect(html){const out=new Set();let m;TAG_RE.lastIndex=0;while((m=TAG_RE.exec(html))){const t=clean(m[2]);if(likelyVisible(t))out.add(t);}ATTR_RE.lastIndex=0;while((m=ATTR_RE.exec(html))){const t=clean(m[2]);if(likelyVisible(t))out.add(t);}return [...out];}
const exposed=['PAGE_TEXT','SECONDARY_TEXT','FAQ_TEXT','BODY_TEXT','LONG_TEXT','INSTRUCTION_TEXT','PARAGRAPH_TEXT','UI_TEXT','PAGE_TITLES'];
let src=BRIDGE.replace(/\}\)\(\);\s*$/,'G.__AUDIT={EXT:EXT,'+exposed.map(n=>n+':(typeof '+n+'!=="undefined"?'+n+':null)').join(',')+'};})();');
const sandbox={window:{},document:{readyState:'loading',addEventListener(){},querySelectorAll(){return[]}},console:{log(){}}};
sandbox.window.addEventListener=function(){};sandbox.window.RuntimeI18n=null;
vm.runInNewContext(src,sandbox,{timeout:10000});
const audit=sandbox.window.__AUDIT;if(!audit||!audit.EXT)throw new Error('Could not evaluate special-page bridge');
const maps=exposed.map(n=>audit[n]).filter(Boolean);const mapping=new Map();
function autoKey(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return 'special.auto_'+(h>>>0).toString(36);}
function keyFor(text){return mapping.get(text)||autoKey(text);}

for(const map of maps)for(const [text,key] of Object.entries(map))if(typeof text==='string'&&typeof key==='string'&&!mapping.has(text))mapping.set(text,key);
function translated(key){return LOCALES.slice(1).every(lang=>audit.EXT[lang]&&Object.prototype.hasOwnProperty.call(audit.EXT[lang],key));}
let total=0,mapped=0,autoMapped=0,translatedCount=0,fallback=0,unmapped=0;
console.log('Special-page i18n coverage audit');
console.log('Auto semantic coverage is fallback-first and is not counted as reviewed translation.');
console.log('Status: reviewed-mapped / auto-mapped / translated-all-locales / English-fallback / unmapped');
console.log('');
for(const [name,rel] of PAGES){const candidates=collect(fs.readFileSync(path.join(ROOT,rel),'utf8'));let a=0,b=0,c=0,d=0;for(const text of candidates){const key=keyFor(text);a++;if(key.startsWith('special.auto_')){c++;}else if(translated(key)){b++;}else c++;}total+=candidates.length;mapped+=candidates.filter(t=>mapping.has(t)).length;autoMapped+=candidates.filter(t=>!mapping.has(t)).length;translatedCount+=b;fallback+=c;unmapped+=d;console.log(name+': candidates='+candidates.length+' reviewed-mapped='+candidates.filter(t=>mapping.has(t)).length+' auto-mapped='+candidates.filter(t=>!mapping.has(t)).length+' translated-all-locales='+b+' english-fallback='+c+' unmapped='+d);}
console.log('');
console.log('TOTAL: candidates='+total+' reviewed-mapped='+mapped+' auto-mapped='+autoMapped+' translated-all-locales='+translatedCount+' english-fallback='+fallback+' unmapped='+unmapped);
console.log('English-fallback means a semantic key exists but at least one non-English locale has no explicit override. This is not counted as translated.');
if (process.env.SPECIAL_I18N_VERBOSE === '1') {
  for (const [name, rel] of PAGES) {
    const candidates=collect(fs.readFileSync(path.join(ROOT,rel),'utf8'));
    const unmapped=candidates.filter(t=>!mapping.has(t));
    const fallback=candidates.filter(t=>mapping.has(t)&&!translated(mapping.get(t))).concat(candidates.filter(t=>!mapping.has(t)));
    console.log('\\n['+name+'] unmapped:'); unmapped.forEach(t=>console.log('- '+t));
    console.log('['+name+'] english-fallback:'); fallback.forEach(t=>console.log('- '+t+' => '+mapping.get(t)));
  }
}
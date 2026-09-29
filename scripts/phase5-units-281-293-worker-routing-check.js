#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';

const file='public/js/runtime-worker-routing.js';
const source=fs.readFileSync(file,'utf8');
const failures=[];
function check(name,ok,detail=''){console.log((ok?'PASS':'FAIL')+' '+name+(detail?' — '+detail:''));if(!ok)failures.push(name+(detail?': '+detail:''));}
try{new vm.Script(source,{filename:file});check('routing syntax',true);}catch(e){check('routing syntax',false,e.message);process.exit(1);}

function makeWindow(){
  const listeners={};
  const eb={handlers:Object.create(null),on(name,fn){this.handlers[name]=fn;}};
  const win={
    RuntimeDeviceLite:{score:()=>90},
    RuntimeEventBus:eb,
    WorkerPool:{getStats:()=>({})},
    RuntimeWorkerMesh:null,
    document:{readyState:'complete',addEventListener(){}},
    setTimeout:(fn)=>{fn();return 0},
    console,
    addEventListener(name,fn){(listeners[name]??=[]).push(fn);},
    dispatchEvent(evt){(listeners[evt.type]||[]).forEach(fn=>fn(evt));return true;},
  };
  win.window=win;
  return win;
}
const window=makeWindow();
vm.runInNewContext(source,{window,document:window.document,console,setTimeout,Map,Set,Array,Object,Number,String,Date,Math,isFinite});
const r=window.RuntimeWorkerRouting;
check('version exposed',r.VERSION==='1.1');
check('valid registration',r.registerCapability('worker-a',['PDF','wasm','pdf', '']));
check('capability normalization',r.getCapableWorkers('pdf').length===1);
check('duplicate registration replacement',r.registerCapability('worker-a',['ocr']) && r.getCapableWorkers('pdf').length===0 && r.getCapableWorkers('ocr').length===1);
check('malformed registration rejected',r.registerCapability('', ['pdf'])===false && r.registerCapability('worker-b',null)===true);
check('invalid route capability rejected',r.route('')===null && r.route(null)===null);
check('route selects capable worker',r.route('OCR')==='worker-a');
const table=r.getRoutingTable();
check('prototype-safe routing table',Object.getPrototypeOf(table)===null);
check('routing table is snapshot',table.ocr.length===1 && table.ocr[0]==='worker-a');
check('public unregister contract',r.unregisterCapability('worker-a')===true && r.getCapableWorkers('ocr').length===0);
check('unregister unknown worker rejected',r.unregisterCapability('missing-worker')===false);
r.registerCapability('worker-a',['ocr']);
check('reregister after unregister',r.getCapableWorkers('ocr').includes('worker-a'));
check('lifecycle API remains idempotent',r.unregisterCapability('worker-a')===true && r.unregisterCapability('worker-a')===false);
r.registerCapability('worker-a',['ocr']);
window.RuntimeWorkerMesh={getTrustScore:()=>{throw new Error('mesh failure')}};
check('trust lookup failure fails closed',r.route('ocr')===null);
if(failures.length){console.error('\nPhase 5 Units 281-293 audit FAILED:');failures.forEach(x=>console.error(' - '+x));process.exit(1);}
console.log('\nPhase 5 Units 281-293 audit PASSED.');

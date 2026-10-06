(function(){
'use strict';
var G=window;
function fmtBytes(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB';}
function prepare(files,done){
  var list=(files||[]).filter(Boolean); if(!list.length){if(done)done();return;}
  var dz=document.querySelector('.ilpdf-special-dropzone');
  if(!dz){if(done)done();return;}
  var old=dz.querySelector('.ilpdf-special-prep'); if(old)old.remove();
  var total=list.reduce(function(s,f){return s+(f.size||0);},0);
  var box=document.createElement('div'); box.className='ilpdf-special-prep';
  box.setAttribute('role','status'); box.setAttribute('aria-live','polite');
  box.innerHTML='<div class="ilpdf-special-prep-inner"><div class="ilpdf-special-prep-icon" aria-hidden="true">⚙️</div><div class="ilpdf-special-prep-title">Preparing your files</div><div class="ilpdf-special-prep-meta">'+list.length+' file'+(list.length===1?'':'s')+' · '+fmtBytes(total)+' · processing stays on your device</div><div class="ilpdf-special-prep-track"><div class="ilpdf-special-prep-bar"></div></div><div class="ilpdf-special-prep-percent">0%</div></div>';
  dz.appendChild(box);
  var bar=box.querySelector('.ilpdf-special-prep-bar'), pct=box.querySelector('.ilpdf-special-prep-percent');
  var start=performance.now(), min=900, timer=setInterval(function(){
    var p=Math.min(100,Math.round(((performance.now()-start)/min)*100));
    bar.style.width=p+'%'; pct.textContent=p+'%';
    if(p>=100){clearInterval(timer);setTimeout(function(){box.remove();if(done)done();},120);}
  },30);
}
G.SharedSpecialUpload=Object.freeze({prepare:prepare});
})();
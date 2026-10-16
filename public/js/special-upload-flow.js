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
var previewLoadPromise=null;
function mountPreview(toolId,files,host,options){
  if(!host)return Promise.resolve(false);
  var list=(files||[]).filter(Boolean);
  if(!list.length){
    if(G.SharedFilePreview)G.SharedFilePreview.mount(toolId,[],host,options||{});
    host.innerHTML='';
    G.document.body.classList.remove('has-shared-file-preview');
    return Promise.resolve(true);
  }
  function mount(){
    if(!G.SharedFilePreview)return false;
    G.document.body.classList.add('has-shared-file-preview');
    return G.SharedFilePreview.mount(toolId,list,host,options||{});
  }
  if(G.SharedFilePreview)return Promise.resolve(mount());
  if(!previewLoadPromise){
    previewLoadPromise=new Promise(function(resolve){
      var existing=G.document.querySelector('script[data-shared-file-preview]');
      if(existing){
        if(existing.dataset.sharedLoaded==='1'){resolve(!!G.SharedFilePreview);return;}
        existing.addEventListener('load',function(){resolve(!!G.SharedFilePreview);},{once:true});
        existing.addEventListener('error',function(){resolve(false);},{once:true});
        return;
      }
      var script=G.document.createElement('script');
      script.src='/js/shared-file-preview.js?v=20261016-shared-preview-v1';
      script.async=true;script.dataset.sharedFilePreview='1';
      script.onload=function(){script.dataset.sharedLoaded='1';resolve(!!G.SharedFilePreview);};
      script.onerror=function(){previewLoadPromise=null;resolve(false);};
      G.document.head.appendChild(script);
    });
  }
  return previewLoadPromise.then(function(ready){return ready?mount():false;});
}
G.SharedSpecialUpload=Object.freeze({prepare:prepare,mountPreview:mountPreview});
})();
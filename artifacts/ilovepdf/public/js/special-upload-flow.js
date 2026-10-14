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
function renderSharedDropzones(){
  var mounts=document.querySelectorAll('[data-special-upload-mount]');
  mounts.forEach(function(mount){
    if(mount.getAttribute('data-rendered')==='true') return;
    var cfg={
      zoneId:mount.getAttribute('data-zone-id'),
      inputId:mount.getAttribute('data-input-id'),
      browseId:mount.getAttribute('data-browse-id'),
      icon:mount.getAttribute('data-icon')||'upload-cloud',
      title:mount.getAttribute('data-title')||'Drop files here',
      description:mount.getAttribute('data-description')||'or click to browse',
      browseLabel:mount.getAttribute('data-browse-label')||'Browse files',
      accept:mount.getAttribute('data-accept')||'',
      multiple:mount.getAttribute('data-multiple')==='true'
    };
    if(!cfg.zoneId||!cfg.inputId||!cfg.browseId) return;
    var zone=document.createElement('div');
    zone.id=cfg.zoneId;
    zone.className='ilpdf-special-dropzone';
    zone.tabIndex=0;
    zone.setAttribute('role','group');
    zone.setAttribute('aria-label',cfg.title);
    var icon=document.createElement('i');
    icon.setAttribute('data-lucide',cfg.icon);
    icon.setAttribute('aria-hidden','true');
    var copy=document.createElement('p');
    copy.className='ilpdf-special-dropzone-title';
    copy.textContent=cfg.title;
    var detail=document.createElement('p');
    detail.className='ilpdf-special-dropzone-description';
    detail.textContent=cfg.description;
    var browse=document.createElement('button');
    browse.type='button';
    browse.id=cfg.browseId;
    browse.className='calc-btn ilpdf-special-select';
    browse.textContent=cfg.browseLabel;
    var input=document.createElement('input');
    input.id=cfg.inputId;
    input.type='file';
    input.hidden=true;
    input.setAttribute('aria-label',cfg.browseLabel);
    if(cfg.accept) input.accept=cfg.accept;
    if(cfg.multiple) input.multiple=true;
    zone.appendChild(icon);
    zone.appendChild(copy);
    zone.appendChild(detail);
    zone.appendChild(browse);
    zone.appendChild(input);
    zone.addEventListener('keydown',function(event){
      if(event.target===zone&&(event.key==='Enter'||event.key===' ')){
        event.preventDefault();
        input.click();
      }
    });
    mount.replaceWith(zone);
  });
  if(mounts.length && G.lucide && typeof G.lucide.createIcons==='function') G.lucide.createIcons();
}
renderSharedDropzones();
G.SharedSpecialUpload=Object.freeze({prepare:prepare,render:renderSharedDropzones});
})();
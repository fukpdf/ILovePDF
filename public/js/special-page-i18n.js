/* Shared special-page i18n bridge. Page engines remain independent. */
(function(){
  'use strict';
  var G=window;
  function patch(){
    if(G.RuntimeI18n && typeof G.RuntimeI18n.patch==='function') G.RuntimeI18n.patch(document);
  }
  function start(){
    patch();
    G.addEventListener('i18n:change', patch);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
  G.SpecialPageI18n=Object.freeze({patch:patch});
})();

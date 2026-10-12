// OCR Worker Adapter v1.0 — canonical boundary for DOM/Tesseract-dependent OCR.
// Tesseract remains an isolated browser Worker; PDF.js/canvas stay in the tool app
// because they require browser/DOM APIs. RuntimeScheduler owns admission/lifecycle.
(function(G){'use strict';if(G.OCRWorkerAdapter)return;var active=null;var TIMEOUT_MS=0;
function key(file,opts){var o=opts||{};return ['ocr',file&&file.name||'',file&&file.size||0,file&&file.lastModified||0,o.language||'auto'].join(':');}
async function dispatch(file,opts,onProgress,token){if(!file)throw new Error('No PDF file provided');if(!G.__OCRToolEngine||typeof G.__OCRToolEngine.process!=='function')throw new Error('OCR engine is unavailable');if(active)throw new Error('OCR is already processing');active={token:token||null,key:key(file,opts)};try{if(active.token&&active.token.cancelled)throw new Error('OCR cancelled');return await G.__OCRToolEngine.process([file],opts||{},onProgress,active.token);}finally{active=null;}}
function cancel(reason){if(!active)return false;if(active.token&&typeof active.token.cancel==='function')active.token.cancel(reason||'cancelled');if(G.__OCRToolEngine&&typeof G.__OCRToolEngine.cancel==='function')G.__OCRToolEngine.cancel(reason||'cancelled');return true;}
G.OCRWorkerAdapter={dispatch:dispatch,cancel:cancel,dedupeKey:key,TIMEOUT_MS:TIMEOUT_MS};}(window));
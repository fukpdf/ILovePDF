/* Phase 4 Unit 3/7 — registry-driven execution and capability policy.
 * The registry decides the allowed execution mode and advertised runtime
 * capabilities. BrowserTools remains the implementation layer; this policy
 * prevents silent capability drift between metadata and the processor.
 */
(function (G) {
  'use strict';
  var installed = false;
  function registryReady() { return G.ToolRegistryReady ? G.ToolRegistryReady : Promise.resolve(null); }
  function entryFor(toolId) { return G.ToolRegistry && G.ToolRegistry.isReady() ? G.ToolRegistry.get(toolId) : null; }
  function manifestFor(toolId) {
    if (!G.BrowserTools || typeof G.BrowserTools.getToolExecutionManifest !== 'function') return null;
    return G.BrowserTools.getToolExecutionManifest(toolId);
  }
  function get(toolId) {
    var entry=entryFor(toolId), manifest=manifestFor(toolId);
    if (!entry) return {ok:false,code:'TOOL_REGISTRY_MISSING',toolId:toolId};
    if (!manifest) return {ok:false,code:'PROCESSOR_CAPABILITY_MISSING',toolId:toolId};
    var expected=entry.execution, actual=manifest.execution, processor=manifest.processor;
    if (expected==='browser-worker') {
      if (actual!=='worker-pool' || processor!=='browser-tools') return {ok:false,code:'EXECUTION_POLICY_MISMATCH',toolId:toolId,expected:expected,actual:actual};
    } else if (expected==='browser') {
      if (actual!=='main-thread' || processor!=='browser-tools') return {ok:false,code:'EXECUTION_POLICY_MISMATCH',toolId:toolId,expected:expected,actual:actual};
    } else if (expected==='special-page') {
      return {ok:false,code:'SPECIAL_PAGE_ONLY',toolId:toolId,expected:expected,actual:actual};
    } else {
      return {ok:false,code:'UNKNOWN_EXECUTION_POLICY',toolId:toolId,expected:expected};
    }

    var caps=entry.capabilities || {};
    var expectedLazy=caps.lazyLoad !== false;
    var expectedPool=caps.workerPool === true;
    var expectedStreaming=caps.streaming === 'adaptive-worker';
    var actualLazy=manifest.lazyLoad !== false;
    var actualPool=manifest.workerSafe === true && manifest.execution === 'worker-pool';
    var actualStreaming=manifest.streaming === 'adaptive-worker';
    if (actualLazy!==expectedLazy || actualPool!==expectedPool || actualStreaming!==expectedStreaming) {
      return {
        ok:false, code:'CAPABILITY_CONTRACT_MISMATCH', toolId:toolId,
        expected:{lazyLoad:expectedLazy,workerPool:expectedPool,streaming:caps.streaming||'not-applicable'},
        actual:{lazyLoad:actualLazy,workerPool:actualPool,streaming:manifest.streaming||false}
      };
    }
    if (caps.fileSizePolicy && caps.fileSizePolicy !== 'unlimited') {
      return {ok:false,code:'FILE_SIZE_POLICY_UNSUPPORTED',toolId:toolId,policy:caps.fileSizePolicy};
    }
    return {
      ok:true,toolId:toolId,module:entry.module,execution:expected,processor:processor,
      workerSafe:manifest.workerSafe===true,lazyLoad:actualLazy,streaming:manifest.streaming||false,
      validation:manifest.validation||null,capabilities:{lazyLoad:actualLazy,workerPool:actualPool,streaming:manifest.streaming||'not-applicable',fileSizePolicy:caps.fileSizePolicy||'unlimited'}
    };
  }
  async function authorize(toolId) { await registryReady(); return get(toolId); }
  async function install() {
    if (installed || !G.BrowserTools || typeof G.BrowserTools.process !== 'function') return;
    var original=G.BrowserTools.process;
    G.BrowserTools.process=async function(toolId,files,options) {
      var policy=await authorize(toolId);
      if (!policy.ok) throw new Error(policy.code);
      return original.call(G.BrowserTools,toolId,files,options);
    };
    installed=true;
    G.dispatchEvent(new CustomEvent('ilovepdf:tool-execution-policy-ready'));
  }
  G.ToolExecutionPolicy=Object.freeze({get:get,authorize:authorize,install:install,isInstalled:function(){return installed;}});
  registryReady().then(install).catch(function(){});
})(window);

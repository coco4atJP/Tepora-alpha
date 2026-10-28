/** Optional installed-Chrome check. Synthetic offline preview only: no accounts, keys or model calls.
 * Run: node tests/browser-provider-settings.mjs
 */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
import {browserBundle} from '../core/frontend.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),temp=await mkdtemp(path.join(os.tmpdir(),'tepora-provider-ui-'));
const browser=new Browser({executable:findBrowser(process.env.CHROMIUM_PATH),profileDir:path.join(temp,'profile'),headless:true});
const failures=[],errors=[],checks=[];
try{
 const page=await browser.page('provider-settings');
 browser.conn.on(message=>{if(message.sessionId===page.sessionId&&message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);});
 await page.send('Network.enable');await page.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
 const code=(await browserBundle(path.join(root,'web'),{preview:true})).replace('\n})().catch(fail)','\nwindow.providerUITest={get state(){return state;},actions,bridge,providerSettings};window.providerUIRequests=[];const originalProviderUIRequest=bridge.request;bridge.request=async(...args)=>{providerUIRequests.push({path:args[0],method:args[1]||"GET"});return originalProviderUIRequest(...args);};\n})().catch(fail)');
 const css=(await readFile(path.join(root,'web/styles.css'),'utf8'))+'\n'+await readFile(path.join(root,'web/avatar.css'),'utf8');
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>AI settings fixture</title><style>${css}</style></head><body><div id="app"></div><div id="overlay"></div><div id="toast" role="status"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 const evaluate=expression=>page.eval(expression,{awaitPromise:true});
 const wait=async expression=>{const end=Date.now()+8000;do{if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<end);throw Error('Timed out: '+expression);};
 const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await settle();};
 const input=async(selector,value,event='input')=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);await settle();};
 const check=async(name,run)=>{try{await run();checks.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:error.message});console.error('FAIL '+name+': '+error.message);}};
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:940,deviceScaleFactor:1,mobile:false});
 const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
 await wait('!!window.providerUITest&&!!document.querySelector("#clock-display")?.textContent');
 await click('.nav [data-view=settings]');await click('.settings-nav [data-id=ai]');await click('[data-action=providers-launch]');
 await wait('!!document.querySelector(".connection-methods")');
 await check('first connection shows three plain choices before network and legacy settings',async()=>{
  assert.equal(await evaluate('document.querySelector("#modal-title").textContent'),'AIの接続');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".connection-method h3")].map(el=>el.textContent)'),['アカウントでログイン','APIキーを使う','このPCのAIを使う']);
  assert.equal(await evaluate('document.querySelector(".connection-network").open'),false);
  assert.equal(await evaluate('document.querySelector(".connection-legacy").open'),false);
 });
 await check('preview can inspect account login but cannot authenticate',async()=>{
  await click('[data-action=pi-auth-open]');await wait('!!document.querySelector("#pi-auth-panel")');
  assert.equal(await evaluate('document.querySelector("#pi-auth-provider").value'),'openai-codex');
  assert.equal(await evaluate('document.querySelector("#pi-auth-start [type=submit]").disabled'),true);
  await evaluate('document.querySelector("#pi-auth-start").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await settle();
  assert.equal(await evaluate('providerUIRequests.some(r=>r.path.startsWith("/api/pi/auth")&&r.method!=="GET")'),false);
  await click('[data-action=pi-back]');await wait('!!document.querySelector(".connection-methods")');
 });
 await check('model search, back navigation and sample registration retain clear states',async()=>{
  await click('[data-action=pi-open]');await wait('!!document.querySelector("#pi-profile-form")');
  assert.equal(await evaluate('document.querySelector("#pi-profile-form .connection-advanced").open'),false);
  await click('[data-action=pi-back]');await wait('!!document.querySelector(".connection-methods")');
  assert.equal(await evaluate('!!document.querySelector(".discard-bar")'),false,'programmatic defaults do not count as unsaved user edits');
  await click('[data-action=pi-open]');await wait('!!document.querySelector("#pi-profile-form")');
  assert.ok(await evaluate('document.querySelector("#pi-model-search").getBoundingClientRect().height>=40'));
  await input('#pi-model-search','no-matching-model');
  assert.equal(await evaluate('document.querySelector("#pi-profile-form [type=submit]").disabled'),true);
  await input('#pi-model-search','');await input('#pi-profile-form [name=name]','設定例のAI');
  await click('[data-action=pi-back]');assert.equal(await evaluate('!!document.querySelector(".discard-bar")'),true);
  await click('[data-action=discard-cancel]');assert.equal(await evaluate('document.querySelector("#pi-profile-form [name=name]").value'),'設定例のAI');
  await evaluate('document.querySelector("#pi-profile-form").requestSubmit()');await wait('!!document.querySelector("#provider-key-form")');
  assert.equal(await evaluate('document.querySelector("#provider-key-form [name=key]").disabled'),true);
  assert.equal(await evaluate('document.querySelector("#provider-key-form [type=submit]").disabled'),true);
  await wait('document.activeElement.id==="modal-title"');
  await click('[data-action=providers-open]');await wait('!!document.querySelector(".connection-profiles")');
  assert.equal(await evaluate('document.querySelector(".connection-state").textContent'),'APIキー未設定');
 });
 await evaluate(`(async()=>{document.querySelector('[data-action=close]').click();const old=await providerUITest.bridge.request('/api/providers');const profile=(id,domain='device',vision=true)=>({id,name:'名前 '+id,model:'fixture-'+id,protocol:'chat-completions',baseUrl:domain==='device'?'http://127.0.0.1:9/v1':'https://example.invalid/v1',domain,enabled:true,capabilities:{tools:true,vision},maxParallel:2,reasoningEffort:'high'});await providerUITest.bridge.request('/api/providers','PUT',{expectedRevision:old.revision,config:{profiles:[profile('local-main'),profile('local-backup'),profile('vision'),profile('cloud','cloud',null)],routes:{main:{primary:'local-main',fallbacks:[]}}}});await providerUITest.providerSettings().open();})()`);
 await check('named fallbacks save in order without exposing IDs for manual entry',async()=>{
  await click('.connection-role-options summary');
  assert.equal(await evaluate('[...document.querySelector("select[name=vision]").options].some(o=>o.value==="cloud")'),false);
  await evaluate('document.querySelector("[data-fallback-role=main]").closest("details").querySelector("summary").click()');
  await click('[data-action=route-fallback-add][data-role=main]');
  await input('[data-fallback-role=main] select','local-backup','change');
  assert.equal(await evaluate('document.activeElement.dataset.action'),'route-fallback-select');
  await click('[data-action=route-fallback-add][data-role=main]');
  await input('[data-fallback-role=main] li:last-child select','vision','change');
  await click('[data-action=route-fallback-up][data-role=main][data-index="1"]');
  assert.equal(await evaluate('document.querySelector("[name=main-fallbacks]").value'),'vision, local-backup');
  assert.equal(await evaluate('document.querySelector("[name=main-fallbacks]").type'),'hidden');
  await evaluate('window.savedRouteForm=document.querySelector("#route-form")');
  await click('.connection-network summary');await click('[data-action=network-mode][data-mode=offline]');
  assert.equal(await evaluate('document.querySelector("#route-form")===savedRouteForm'),true,'network updates preserve unsaved route controls');
  assert.equal(await evaluate('document.querySelector("[name=main-fallbacks]").value'),'vision, local-backup');
  await click('[data-action=network-mode][data-mode=online]');
  await evaluate('document.querySelector("#route-form").requestSubmit()');await wait('document.querySelector("#route-form")!==savedRouteForm');
  assert.deepEqual(await evaluate('providerUITest.state.providers.routes.main.fallbacks'),['vision','local-backup']);
  assert.equal(await evaluate('providerUITest.state.providers.profiles[0].reasoningEffort'),'high');
 });
 await check('existing role-specific routes save without silently assigning a default AI',async()=>{
  await evaluate(`(async()=>{const config=await providerUITest.bridge.request('/api/providers');await providerUITest.bridge.request('/api/providers','PUT',{expectedRevision:config.revision,config:{profiles:config.profiles,routes:{chat:{primary:'local-main',fallbacks:['local-backup']}}}});await providerUITest.providerSettings().open();window.oldRoleOnlyForm=document.querySelector('#route-form');})()`);
  assert.equal(await evaluate('document.querySelector("select[name=main]").value'),'');
  await evaluate('document.querySelector("#route-form").requestSubmit()');await wait('document.querySelector("#route-form")!==oldRoleOnlyForm');
  assert.equal(await evaluate('Object.hasOwn(providerUITest.state.providers.routes,"main")'),false);
  assert.deepEqual(await evaluate('providerUITest.state.providers.routes.chat'),{primary:'local-main',fallbacks:['local-backup']});
 });
 await check('connection screens fit 320–1440px and 160% text without moving the shell',async()=>{
  for(const width of [1440,390,320]){
   await page.send('Emulation.setDeviceMetricsOverride',{width,height:940,deviceScaleFactor:1,mobile:false});
   for(const scale of [1,1.6]){
    await evaluate(`providerUITest.actions['scale-set']({dataset:{value:'${scale}'}})`);await settle();
    const actual=await evaluate('(()=>{const modal=document.querySelector(".modal"),body=document.querySelector(".modal-body"),r=modal.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,body:body.clientWidth,scroll:body.scrollWidth,shell:document.querySelector(".shell").scrollTop};})()');
    assert.ok(actual.left>=-1&&actual.right<=actual.width+1&&actual.scroll<=actual.body+1,JSON.stringify({scale,...actual}));
    assert.equal(actual.shell,0);
   }
  }
 });
 assert.equal(await evaluate('providerUIRequests.some(r=>(r.path.startsWith("/api/pi/")&&r.method!=="GET")||r.path.endsWith("/probe")||r.path.endsWith("/key"))'),false,'no authentication, secret save or model inference requests');
 assert.deepEqual(errors,[],'no browser runtime exceptions');
 console.log(JSON.stringify({checks,failures,errors,realAccounts:false,realModels:false},null,2));assert.equal(failures.length,0);
}finally{await browser.close();await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}

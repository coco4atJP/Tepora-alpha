/** Optional installed-Chrome login UI check. Synthetic attempts; no real browser handoff or accounts. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),temp=await mkdtemp(path.join(os.tmpdir(),'tepora-auth-ui-'));
const browser=new Browser({executable:findBrowser(process.env.CHROMIUM_PATH),profileDir:path.join(temp,'profile'),headless:true});
const errors=[],checks=[];
try{
 const page=await browser.page('auth');
 browser.conn.on(m=>{if(m.sessionId===page.sessionId&&m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
 await page.send('Network.enable');await page.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
 const modules=await Promise.all(['status','markdown','ui','provider-presets','auth-browser','pi-settings','provider-settings'].map(async name=>(await readFile(path.join(root,'web',name+'.mjs'),'utf8')).replace(/^import .+ from '.+?';\r?\n/gm,'').replace(/^export /gm,'')));
 const harness=`
 const fixture={requests:[],state:{supported:true,accounts:[],pending:null},legacy:{supported:true,note:'Synthetic login',accounts:[],pending:null},count:0,fail:false,hold:false,release:null};
 const copy=value=>JSON.parse(JSON.stringify(value));
 const bridge={async request(url,method='GET',body){
  fixture.requests.push({url,method,body});
  if(url==='/api/providers')return {revision:0,profiles:[],routes:{}};
  if(url==='/api/network')return {revision:0,mode:'online',internetTools:true};
  if(url==='/api/pi/providers')return {providers:[{id:'fixture',name:'Fixture service',available:true,oauth:{name:'アカウントでログイン'}},{id:'other',name:'Other service',available:true,oauth:{name:'アカウントでログイン'}}]};
  if(url==='/api/pi/auth')return copy(fixture.state);
  if(url==='/api/pi/auth/start'){
   fixture.state.pending={id:'pi-'+(++fixture.count),status:'pending',provider:'fixture',prompt:{id:1,type:'manual',message:'確認コードを入力'},event:null};
   if(fixture.hold)await new Promise(resolve=>{fixture.release=resolve;});return copy(fixture.state);
  }
  if(url==='/api/pi/auth/cancel'){if(fixture.cancelFail)throw Error('Synthetic cancellation failure');fixture.state.pending.status='cancelled';fixture.state.pending.prompt=null;fixture.state.pending.event=null;return copy(fixture.state);}
  if(url==='/api/provider-auth')return copy(fixture.legacy);
  if(url==='/api/provider-auth/start'){fixture.legacy.pending={id:'legacy-'+(++fixture.count),status:'pending',canOpenBrowser:true};return {id:fixture.legacy.pending.id};}
  if(url==='/api/provider-auth/cancel'){fixture.legacy.pending.status='cancelled';fixture.legacy.pending.canOpenBrowser=false;return copy(fixture.legacy);}
  if(url.endsWith('/auth/open')||url==='/api/provider-auth/open'){if(fixture.fail)throw Error('Synthetic launcher failure');return {opened:true};}
  throw Error('Unexpected fixture request '+url);
 }};
 const overlay=document.querySelector('#overlay');
 function openSheet(title,html,kind){overlay.innerHTML='<section class="modal" data-kind="'+kind+'"><header class="modal-header"><h2>'+title+'</h2></header><div class="modal-body">'+html+'</div></section>';registerForms(overlay);}
 const controller=createProviderSettings({bridge,openSheet,closeSheet:()=>overlay.replaceChildren(),notice:message=>{document.querySelector('#notice').textContent=message;},previewMode:false,legacySettings:()=>({})});
 window.open=()=>{throw Error('Authentication must not open a WebView popup');};
 window.fixture=fixture;window.controller=controller;await controller.open();`;
 const css=await readFile(path.join(root,'web/styles.css'),'utf8');
 const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><style>${css}</style><body><div id="overlay"></div><p id="notice" role="status"></p><script>(async()=>{${modules.join('\n')}\n${harness}})().catch(error=>{document.querySelector('#notice').textContent=error.message;});</script></body></html>`;
 const evaluate=expression=>page.eval(expression,{awaitPromise:true});
 const wait=async expression=>{const end=Date.now()+8000;do{if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<end);throw Error('Timed out: '+expression);};
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const openCount=endpoint=>evaluate(`fixture.requests.filter(r=>r.url===${JSON.stringify(endpoint)}).length`);
 const start=async()=>{await evaluate('document.querySelector("#pi-auth-start [name=consent]").checked=true;document.querySelector("#pi-auth-start").requestSubmit()');await wait('!!document.querySelector("#pi-auth-prompt")');};
 const check=async(name,run)=>{await run();checks.push(name);console.log('PASS '+name);};
 const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
 await wait('!!window.controller&&!!document.querySelector(".connection-methods")');
 await click('[data-action=pi-auth-open]');await wait('!!document.querySelector("#pi-auth-start")');await start();
 await check('a delayed auth URL auto-opens once while preserving the live manual-code field',async()=>{
  await evaluate('window.codeInput=document.querySelector("#pi-auth-prompt input");codeInput.value="UNSENT-CODE";fixture.state.pending.event={type:"auth_url",url:"https://login.example.test/authorize?state=fixture"}');
  await wait('fixture.requests.some(r=>r.url==="/api/pi/auth/open")');await wait('document.querySelector("#pi-auth-browser [role=status]").textContent.includes("既定")');
  assert.equal(await evaluate('document.querySelector("#pi-auth-prompt input")===codeInput&&codeInput.value==="UNSENT-CODE"'),true);
  assert.deepEqual(await evaluate('fixture.requests.find(r=>r.url==="/api/pi/auth/open").body'),{id:'pi-1'});
  assert.equal(await evaluate('document.querySelectorAll("#pi-auth-panel a[target=_blank]").length'),0);
  await evaluate('fixture.state.pending.event.message="updated"');await new Promise(r=>setTimeout(r,900));assert.equal(await openCount('/api/pi/auth/open'),1);
 });
 await check('launcher and cancellation failures allow explicit retry while preserving typed code',async()=>{
  await evaluate('fixture.fail=true');await click('[data-action=pi-auth-browser]');await wait('document.querySelector("#pi-auth-browser [role=status]").textContent.includes("開けませんでした")');
  await evaluate('fixture.state.pending.event.message="another update"');await new Promise(r=>setTimeout(r,900));assert.equal(await openCount('/api/pi/auth/open'),2);
  await evaluate('fixture.fail=false');await click('[data-action=pi-auth-browser]');await wait('document.querySelector("#pi-auth-browser [role=status]").textContent.includes("既定")');
  assert.equal(await openCount('/api/pi/auth/open'),3);assert.equal(await evaluate('codeInput.value'),'UNSENT-CODE');
  await evaluate('fixture.cancelFail=true');await click('[data-action=pi-auth-cancel]');await wait('document.querySelector("#notice").textContent.includes("cancellation failure")');
  await click('[data-action=pi-auth-browser]');await wait('fixture.requests.filter(r=>r.url==="/api/pi/auth/open").length===4');
  await evaluate('fixture.cancelFail=false;document.querySelector("#notice").textContent=""');
 });
 await check('returning to an existing attempt requires a click and cancellation removes the opener',async()=>{
  await evaluate('fixture.state.pending.provider="other";controller.open()');await click('[data-action=pi-auth-open]');await wait('!!document.querySelector("#pi-auth-browser button")');await new Promise(r=>setTimeout(r,900));
  assert.equal(await evaluate('document.querySelector("#pi-auth-provider").value'),'other','the pending service remains selected');
  assert.equal(await openCount('/api/pi/auth/open'),4);await click('[data-action=pi-auth-browser]');await wait('fixture.requests.filter(r=>r.url==="/api/pi/auth/open").length===5');
  await click('[data-action=pi-auth-cancel]');await wait('!!document.querySelector("#pi-auth-start")');assert.equal(await evaluate('!!document.querySelector("#pi-auth-browser button")'),false);
 });
 await check('closing the auth view before Start returns cannot open a browser or restore the sheet',async()=>{
  await evaluate('fixture.hold=true;document.querySelector("#pi-auth-start [name=consent]").checked=true;document.querySelector("#pi-auth-start").requestSubmit()');await wait('!!fixture.release');
  await evaluate('document.querySelector("#overlay").replaceChildren();fixture.release()');await new Promise(r=>setTimeout(r,900));
  assert.equal(await openCount('/api/pi/auth/open'),5);assert.equal(await evaluate('!!document.querySelector("#pi-auth-panel")'),false);
 });
 await check('legacy ChatGPT login uses the same default-browser handoff and supports reopening a pending attempt',async()=>{
  await evaluate('controller.open()');await click('[data-action=provider-auth-open]');await wait('!!document.querySelector("#provider-auth-panel")');await click('[data-action=provider-auth-start]');
  await wait('fixture.requests.some(r=>r.url==="/api/provider-auth/open")');assert.deepEqual(await evaluate('fixture.requests.find(r=>r.url==="/api/provider-auth/open").body'),{id:'legacy-3'});
  await evaluate('controller.open()');await click('[data-action=provider-auth-open]');await wait('!!document.querySelector("#provider-auth-browser button")');await new Promise(r=>setTimeout(r,1600));
  assert.equal(await openCount('/api/provider-auth/open'),1);await click('[data-action=provider-auth-browser]');await wait('fixture.requests.filter(r=>r.url==="/api/provider-auth/open").length===2');
  await click('[data-action=provider-auth-cancel]');await wait('!!document.querySelector("[data-action=provider-auth-start]")');assert.equal(await evaluate('!!document.querySelector("#provider-auth-browser button")'),false);
 });
 assert.deepEqual(errors,[]);assert.equal(await evaluate('document.querySelector("#notice").textContent'),'');
 console.log(JSON.stringify({checks,errors,realAccounts:false,realBrowserHandoff:false},null,2));
}finally{await browser.close();await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}

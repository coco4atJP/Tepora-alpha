/** Optional installed-Chrome regressions for monitor controls and bounded DOM updates.
 * Run: node tests/browser-monitor.mjs. Synthetic offline data, temporary profile, no external providers.
 */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
import {browserBundle} from '../core/frontend.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),temp=await mkdtemp(path.join(os.tmpdir(),'tepora-monitor-'));
const browser=new Browser({executable:findBrowser(process.env.CHROMIUM_PATH),profileDir:path.join(temp,'profile'),headless:true});
const failures=[],errors=[];
try{
 assert.ok(browser.executable,'Install Chrome/Chromium or set CHROMIUM_PATH.');
 const page=await browser.page('monitor');
 browser.conn.on(m=>{if(m.sessionId===page.sessionId&&m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
 await page.send('Network.enable');await page.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 const code=(await browserBundle(path.join(root,'web'),{preview:true})).replace('\n})().catch(fail)','\nwindow.monitorTest={state,render,actions,tick};\n})().catch(fail)');
 const css=await readFile(path.join(root,'web/styles.css'),'utf8'),avatarCss=await readFile(path.join(root,'web/avatar.css'),'utf8');
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}\n${avatarCss}</style></head><body><div id="app"></div><div id="overlay"></div><div id="toast" role="status"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
 const evaluate=expression=>page.eval(expression,{awaitPromise:true});
 for(let i=0;i<100&&!await evaluate('!!window.monitorTest');i++)await new Promise(r=>setTimeout(r,50));
 assert.ok(await evaluate('!!window.monitorTest'),'preview boots');
 const check=async(name,run)=>{try{await run();console.log('PASS '+name);}catch(error){failures.push({name,error:error.message});console.error('FAIL '+name+': '+error.message);}};
 await evaluate(`window.monitorClock=Date.now();window.realNow=Date.now;Date.now=()=>window.monitorClock;
 const s=monitorTest.state;s.jobs=[{id:'monitor-job',title:'Synthetic task',kind:'work',status:'running'}];s.routines=[{id:'routine',title:'Synthetic routine',enabled:true,schedule:'Daily'}];
 s.display={...s.display,widgets:['clock','companion','focus','work','schedule','system'],pinnedWidgets:['focus','work','schedule','system'],layout:'dashboard-bento',focusMinutes:25};monitorTest.render();`);
 await check('focus time follows elapsed time, not render count, and delayed callbacks complete once',async()=>{
  const actual=await evaluate(`(()=>{monitorTest.actions['focus-reset']();monitorTest.actions['focus-toggle']();for(let i=0;i<20;i++)monitorTest.render();const same=document.querySelector('.focus-time').textContent;monitorClock+=3200;monitorTest.tick();const elapsed=document.querySelector('.focus-time').textContent;monitorClock+=1500000;monitorTest.tick();monitorTest.tick();return {same,elapsed,meta:document.querySelector('.focus-meta').textContent};})()`);
  assert.equal(actual.same,'25:00');assert.equal(actual.elapsed,'24:57');assert.equal(actual.meta,'待機中 · 今日 1回');
 });
 await check('timer ticks preserve every pinned card and the focused work/timer button',async()=>{
  const actual=await evaluate(`(()=>{monitorTest.actions['focus-reset']();monitorTest.actions['focus-toggle']();const cards=[...document.querySelectorAll('.pinned-card')],work=document.querySelector('[data-card="work"] [data-action="task"]');work.focus();monitorClock+=1000;monitorTest.tick();const workFocused=document.activeElement===work;const toggle=document.querySelector('[data-card="focus"] [data-action="focus-toggle"]');toggle.focus();monitorClock+=1000;monitorTest.tick();return {workFocused,timerFocused:document.activeElement===toggle,cardsKept:cards.every((c,i)=>c===document.querySelectorAll('.pinned-card')[i]),time:document.querySelector('.focus-time').textContent};})()`);
  assert.deepEqual(actual,{workFocused:true,timerFocused:true,cardsKept:true,time:'24:58'});
 });
 await check('unchanged renders preserve the customizer controls without replacing its body',async()=>{
  const actual=await evaluate(`(()=>{monitorTest.actions['stage-customize']();const panel=document.querySelector('#panel .panel-body'),control=panel.querySelector('.scene-card');control.focus();const observer=new MutationObserver(()=>{});observer.observe(panel,{childList:true,subtree:true});for(let i=0;i<10;i++)monitorTest.render();const mutations=observer.takeRecords().length;observer.disconnect();return {mutations,connected:control.isConnected,focused:document.activeElement===control};})()`);
  assert.deepEqual(actual,{mutations:0,connected:true,focused:true});
 });
 await check('repeated keyboard changes keep the exact customizer checkbox and pin button focused',async()=>{
  const waitForReplacement=async()=>{
   for(let i=0;i<100&&await evaluate('window.previousMonitorControl.isConnected');i++)await new Promise(r=>setTimeout(r,50));
   assert.equal(await evaluate('window.previousMonitorControl.isConnected'),false,'changed control is redrawn');
  };
  const beforeWidgets=await evaluate('[...monitorTest.state.display.widgets].sort()');
  await evaluate(`window.previousMonitorControl=document.querySelector('#panel [data-action="widget-toggle"][value="focus"]');previousMonitorControl.focus()`);
  for(const enabled of [false,true]){
   await page.key('Space');await waitForReplacement();
   const actual=await evaluate(`({action:document.activeElement.dataset.action,value:document.activeElement.value,checked:document.activeElement.checked,widgets:[...monitorTest.state.display.widgets].sort()})`);
   assert.deepEqual(actual,{action:'widget-toggle',value:'focus',checked:enabled,widgets:enabled?beforeWidgets:beforeWidgets.filter(w=>w!=='focus')});
   await evaluate('window.previousMonitorControl=document.activeElement');
  }
  let expectedPinned=await evaluate('[...monitorTest.state.display.pinnedWidgets]');
  const wasPinned=expectedPinned.includes('memo');
  await evaluate(`window.previousMonitorControl=document.querySelector('#panel [data-action="toggle-pin-widget"][data-widget="memo"]');previousMonitorControl.focus()`);
  for(const pinned of [!wasPinned,wasPinned]){
   await page.key('Enter');await waitForReplacement();
   const actual=await evaluate(`({action:document.activeElement.dataset.action,widget:document.activeElement.dataset.widget,pressed:document.activeElement.getAttribute('aria-pressed'),pinned:[...monitorTest.state.display.pinnedWidgets].sort()})`);
   expectedPinned=pinned?[...expectedPinned,'memo'].slice(-4):expectedPinned.filter(w=>w!=='memo');
   assert.deepEqual(actual,{action:'toggle-pin-widget',widget:'memo',pressed:String(pinned),pinned:[...expectedPinned].sort()});
   await evaluate('window.previousMonitorControl=document.activeElement');
  }
 });
 await check('standby-clock leaves an accessible inbox entry even when companion remains enabled',async()=>{
  const actual=await evaluate(`(()=>{monitorTest.actions['close-panel']();monitorTest.state.approvals=[{id:'synthetic-approval',jobId:'monitor-job',name:'run_command',args:{executable:'node',args:[]},status:'pending'}];monitorTest.state.display.layout='standby-clock';monitorTest.render();const button=document.querySelector('#inbox-button');return {hidden:button.hidden,width:button.getBoundingClientRect().width};})()`);
  assert.equal(actual.hidden,false);assert.ok(actual.width>0);
  await evaluate('monitorTest.state.approvals=[];monitorTest.state.display.layout="dashboard-bento";monitorTest.render()');
 });
 await check('a generated image can be unpinned using its own card button',async()=>{
  await evaluate(`monitorTest.actions['focus-reset']();monitorTest.state.mediaJobs=[{status:'ready',asset:{id:'synthetic-image',mime:'image/png'},title:'Synthetic image'}];monitorTest.state.display.widgets=['clock','companion','artifact'];monitorTest.state.display.pinnedWidgets=['artifact'];monitorTest.render();`);
  assert.equal(await evaluate('document.querySelector(".card-pin-btn").dataset.widget'),'artifact');
  await evaluate('monitorTest.actions["toggle-pin-widget"](document.querySelector(".card-pin-btn"))');
  assert.deepEqual(await evaluate('monitorTest.state.display.pinnedWidgets'),[]);
 });
 await check('all four layouts keep controls inside the viewport at desktop and phone widths',async()=>{
  const overflow=[];
  for(const width of [1440,390]){
   await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   for(const layout of ['companion-split','dashboard-bento','center-stage','standby-clock']){
    await evaluate(`Object.assign(monitorTest.state.display,{layout:${JSON.stringify(layout)},widgets:['clock','companion','focus','work','schedule','system'],pinnedWidgets:['focus','work','schedule','system'],clockSize:'hero',clockSeconds:true});monitorTest.render()`);
    const bad=await evaluate('(()=>{const s=document.querySelector("#stage"),r=s.getBoundingClientRect();return [...s.querySelectorAll("button,a,time,.focus-time")].filter(el=>{const b=el.getBoundingClientRect();return b.width>0&&(b.right>r.right+1||b.left<r.left-1);}).map(el=>({tag:el.tagName,class:el.className}));})()');
    if(bad.length)overflow.push({width,layout,bad});
   }
  }
  assert.deepEqual(overflow,[]);
 });
 assert.deepEqual(errors,[],'no browser runtime exceptions');
 console.log(JSON.stringify({failures,errors,externalProviders:false},null,2));
 assert.equal(failures.length,0,'monitor regressions failed');
}finally{await browser.close();await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}

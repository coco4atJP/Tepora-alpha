/** Optional real-browser UI regression check. Run: node tests/browser-ui-layout.mjs
 * Uses an installed Chromium-family browser, an isolated temporary profile and synthetic preview data.
 * No Python/Playwright dependency, external providers, user data or sandbox bypasses.
 */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
import {browserBundle} from '../core/frontend.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),executable=findBrowser(process.env.CHROMIUM_PATH);
assert.ok(executable,'Install Chrome/Chromium or set CHROMIUM_PATH before running this optional check.');
const temp=await mkdtemp(path.join(os.tmpdir(),'tepora-ui-'));
const browser=new Browser({executable,profileDir:path.join(temp,'profile'),headless:true});
const checks=[],failures=[],errors=[];
try{
 const page=await browser.page('ui-layout');
 browser.conn.on(message=>{if(message.sessionId===page.sessionId&&message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);});
 await page.send('Network.enable');await page.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
 const code=(await browserBundle(path.join(root,'web'),{preview:true})).replace('\n})().catch(fail)',
  '\nwindow.uiTest={state,paintSpeech,openPanel,closePanel,render,actions,notice,setAmbient};\n})().catch(fail)');
 const css=await readFile(path.join(root,'web/styles.css'),'utf8'),avatarCss=await readFile(path.join(root,'web/avatar.css'),'utf8');
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}\n${avatarCss}</style></head><body><div id="app"></div><div id="overlay"></div><div id="toast" role="status"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 const evaluate=expression=>page.eval(expression,{awaitPromise:true});
 const wait=async expression=>{const end=Date.now()+8000;do{if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<end);throw Error(`Timed out: ${expression}`);};
 const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const viewport=async(width,height=900)=>{await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await settle();};
 const nav=async view=>{await evaluate(`document.querySelector('.nav [data-view="${view}"]').click()`);await settle();};
 const visible=selector=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return !!el&&getComputedStyle(el).display!=='none'&&el.getClientRects().length>0;})()`);
 const check=async(name,run)=>{try{await run();checks.push(name);console.log(`PASS ${name}`);}catch(error){failures.push({name,error:error.message});console.error(`FAIL ${name}: ${error.message}`);}};
 await viewport(1440);
 const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
 await wait('!!window.uiTest&&!!document.querySelector("#clock-display")?.textContent');
 await check('home boots; a sample artifact reaches revision 3 and approval needs a deliberate hold',async()=>{
  assert.equal(await visible('#composer-input'),true);
  await nav('workspace');await evaluate('document.querySelector("[data-action=demo]").click()');
  await wait('document.querySelector(".version-button")?.textContent.includes("3")&&!!document.querySelector(".workbench .approval-card")');
  assert.equal(await evaluate('document.querySelector("#artifact-preview iframe").srcdoc.includes("余白から")'),true);
  await evaluate('uiTest.actions.inbox()');await settle();
  const pos=await evaluate('(()=>{const r=document.querySelector("#panel .seal").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  const mouse=type=>page.send('Input.dispatchMouseEvent',{type,...pos,button:'left',clickCount:1});
  await mouse('mousePressed');await new Promise(resolve=>setTimeout(resolve,150));await mouse('mouseReleased');
  assert.equal(await evaluate('!!document.querySelector("#panel .slip.is-sealed")'),false);
  await mouse('mousePressed');
  try{await wait('!!document.querySelector("#panel .slip.is-sealed")');}finally{await mouse('mouseReleased');}
  await wait('uiTest.state.approvals.every(a=>a.status!=="pending")');
  await evaluate('uiTest.closePanel()');
 });
 await check('memory and widget grids fit inside their own containers at 320–1440px',async()=>{
  await evaluate('uiTest.state.memories=[{id:"layout-memory",title:"確認用の記憶",content:"確認用の本文",confirmed:true,shared:false}]');
  const overflow=[];
  for(const width of [1440,1100,900,768,600,390,375,360,320]){
   await viewport(width);
   for(const view of ['home','workspace','memory','settings']){
    await nav(view);
    if(view==='settings')await evaluate('(()=>{uiTest.actions["settings-jump"]({dataset:{id:"home"}});const summary=document.querySelector("[data-action=settings-disclosure][data-id=widgets]");if(!summary.closest("details").open)summary.click();})()');
    const bad=await evaluate('(()=>{const s=document.querySelector("#surface");return [...s.querySelectorAll(".memory-grid,.widget-order")].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>({class:el.className,width:el.clientWidth,scroll:el.scrollWidth}));})()');
    if(bad.length)overflow.push({width,view,bad});
   }
  }
  assert.deepEqual(overflow,[]);
 });
 await check('speech caching preserves nodes while clipping updates on same-breakpoint resize',async()=>{
  await viewport(1440);await nav('home');
  const wide=await evaluate(`(()=>{
   const reply={id:"layout-reply",role:"assistant",at:new Date().toISOString(),content:""};
   uiTest.state.dialogue.messages=[reply];
   const measure=length=>{
    reply.content="あ".repeat(length);uiTest.paintSpeech();
    const body=document.querySelector(".speech-text");
    return {contentLength:length,clientWidth:body.clientWidth,clientHeight:body.clientHeight,scrollHeight:body.scrollHeight,actual:body.scrollHeight>body.clientHeight+2};
   };
   // Font metrics vary by platform. Find the longest unclipped caption with at most 10 search probes and one final measurement.
   let low=0,high=513;
   while(high-low>1){const mid=Math.floor((low+high)/2);if(measure(mid).actual)high=mid;else low=mid;}
   const measured=measure(low);window.savedSpeech=document.querySelector(".speech-text");return measured;
  })()`);
  assert.ok(wide.contentLength>0&&wide.clientWidth>0&&wide.clientHeight>0,`wide fixture must contain visible text: ${JSON.stringify(wide)}`);
  assert.equal(wide.actual,false,`wide fixture must start unclipped: ${JSON.stringify(wide)}`);
  let clippedAtWide;
  for(const width of [1440,920,1440]){
   await viewport(width);
   const actual=await evaluate('(()=>{const el=document.querySelector("#speech"),body=el.querySelector(".speech-text");return {cached:body===window.savedSpeech,clipped:el.classList.contains("is-clipped"),clientWidth:body.clientWidth,clientHeight:body.clientHeight,scrollHeight:body.scrollHeight,actual:body.scrollHeight>body.clientHeight+2};})()');
   const dimensions=JSON.stringify({width,contentLength:wide.contentLength,wide,actual});
   assert.equal(actual.cached,true,'unchanged speech must not replace DOM');
   assert.equal(actual.clipped,actual.actual,`clipping at ${width}px: ${dimensions}`);
   if(width===920)assert.notEqual(actual.actual,clippedAtWide,`fixture must cross the clipping boundary: ${dimensions}`);
   else{assert.equal(actual.actual,wide.actual,`wide clipping must be restored: ${dimensions}`);clippedAtWide=actual.actual;}
  }
 });
 await check('only a panel containing the focused job approvals hides duplicate bench controls',async()=>{
  await viewport(1440);await nav('workspace');
  await evaluate('uiTest.state.jobs=[{id:"layout-job",title:"確認する仕事",kind:"work",status:"waiting_approval"},{id:"other-job",title:"別の仕事",kind:"work",status:"paused"}];uiTest.state.companion.focusJobId="layout-job";uiTest.state.approvals=[{id:"layout-approval",jobId:"layout-job",name:"run_command",args:{executable:"node",args:["fixture.js"]},status:"pending"}];uiTest.render()');
  assert.equal(await visible('.workbench .approval-card'),true);
  await evaluate('uiTest.openPanel("別の生成機能","<p>ここに承認はありません</p>","creative")');
  assert.equal(await visible('.workbench .approval-card'),true,'creative panel must not hide approvals');
  await evaluate('uiTest.actions.task({dataset:{id:"other-job"}})');
  assert.equal(await visible('.workbench .approval-card'),true,'unrelated task must not hide approvals');
  await evaluate('uiTest.actions.task({dataset:{id:"layout-job"}})');
  assert.equal(await visible('.workbench .approval-card'),false);
  assert.equal(await visible('#panel .approval-card'),true);
  await evaluate('uiTest.actions.inbox()');assert.equal(await visible('.workbench .approval-card'),false);
  await evaluate('uiTest.closePanel()');assert.equal(await visible('.workbench .approval-card'),true);
  assert.equal(await evaluate('document.querySelector("#panel").hasAttribute("data-kind")'),false);
 });
 await check('settings shows one category, remembers it on re-entry and resets its scroll position',async()=>{
  await viewport(1440);await nav('settings');
  const current=()=>evaluate('document.querySelector(".settings-nav [aria-current=true]")?.dataset.id');
  await evaluate('document.querySelector(".settings-nav [data-id=character]").click()');await settle();
  assert.equal(await current(),'character');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".settings-section:not([hidden])")].map(s=>s.dataset.category)'),['character']);
  assert.equal(await evaluate('document.activeElement.id'),'settings-character-title');
  await evaluate('document.querySelector(".settings-nav [data-id=home]").click()');await settle();
  await evaluate('document.querySelector("#surface").scrollTop=1e6');await settle();
  assert.equal(await current(),'home','scrolling must not switch the category');
  await nav('home');await nav('settings');
  assert.equal(await evaluate('document.querySelector("#surface").scrollTop'),0);
  assert.equal(await current(),'home','re-entering settings remembers the chosen category');
 });
 await check('settings jumps and keyboard focus keep the shell and header in place',async()=>{
  const chrome=()=>evaluate('(()=>{const shell=document.querySelector(".shell"),layout=document.querySelector("#layout"),surface=document.querySelector("#surface");return {window:scrollY,shell:shell.scrollTop,layout:layout.scrollTop,headerTop:document.querySelector(".topbar").getBoundingClientRect().top,surfaceBottom:surface.getBoundingClientRect().bottom};})()');
  for(const [width,talk] of [[1440,false],[1440,true],[1180,true],[390,false]]){
   await viewport(width);await nav('home');await nav('settings');
   await evaluate(`uiTest.actions['talk-close']();${talk?"uiTest.actions['talk-open']();":''}`);await settle();
   const before=await chrome(),ids=await evaluate('[...document.querySelectorAll(".settings-nav a")].map(a=>a.dataset.id)');
   assert.equal(before.headerTop,0);
   for(const id of [...ids,...ids.toReversed(),...ids]){
    await evaluate(`(()=>{const select=document.querySelector('#settings-category-select');if(getComputedStyle(select.parentElement).display!=='none'){select.value='${id}';select.dispatchEvent(new Event('change',{bubbles:true}));}else document.querySelector('.settings-nav [data-id="${id}"]').click();})()`);await settle();
    assert.equal(await evaluate('document.querySelector("#surface").scrollTop'),0);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".settings-section:not([hidden])")].map(s=>s.dataset.category)'),[id]);
    assert.deepEqual(await chrome(),before,`jump to ${id} at ${width}px, conversation ${talk}`);
   }
   await evaluate('document.querySelector("#settings-search").focus({preventScroll:true})');
   for(let i=0;i<70;i++)await page.key('Tab');
   assert.deepEqual(await chrome(),before,`Tab traversal at ${width}px, conversation ${talk}`);
  }
  await viewport(1440);await nav('home');
  await evaluate('document.querySelector("[data-action=display]").click()');
  await wait('document.querySelector("#surface").scrollTop===0&&document.querySelector(".settings-nav [aria-current=true]")?.dataset.id==="home"');
  const actual=await chrome();assert.equal(actual.shell,0);assert.equal(actual.headerTop,0);assert.equal(actual.surfaceBottom,900);
 });
 await check('settings search finds aliases across categories, clears safely and preserves edits and focus',async()=>{
  await viewport(1440);await nav('settings');
  const search=async value=>{await evaluate(`(()=>{const input=document.querySelector('#settings-search');input.focus();input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await settle();};
  const results=()=>evaluate('[...document.querySelectorAll(".settings-section:not([hidden]) .settings-entry:not([hidden]) .setting-text h3")].map(el=>el.textContent)');
  await search('マイク');assert.deepEqual(await results(),['マイク・音声入力']);
  assert.equal(await evaluate('document.activeElement.id'),'settings-search');
  assert.equal(await evaluate('document.querySelector("#settings-search-status").textContent'),'1件の設定が見つかりました');
  await search('ｔｈｅｍｅ');assert.deepEqual(await results(),['テーマ']);
  await evaluate('document.querySelector("[data-action=theme-set][data-value=light]").focus();document.activeElement.click()');
  await wait('document.body.dataset.theme==="light"');
  assert.equal(await evaluate('document.querySelector("#settings-search").value'),'ｔｈｅｍｅ');
  assert.deepEqual(await results(),['テーマ']);
  assert.equal(await evaluate('document.activeElement.dataset.value'),'light');
  await search('タイマー');assert.deepEqual(await results(),['ウィジェット']);
  assert.equal(await evaluate('document.querySelector(".settings-disclosure[data-id=widgets]").open'),true);
  await search('<script>missing</script>');assert.deepEqual(await results(),[]);
  assert.equal(await visible('#settings-empty'),true);
  assert.equal(await evaluate('document.querySelector("#settings-empty-query").textContent'),'<script>missing</script>');
  await page.key('Escape');await settle();
  assert.equal(await evaluate('document.querySelector("#settings-search").value'),'');
  assert.equal(await visible('#settings-empty'),false);
  await evaluate('document.querySelector(".settings-nav [data-id=home]").click();const summary=document.querySelector(".settings-disclosure[data-id=widgets] summary");if(!summary.closest("details").open)summary.click();document.querySelector("[data-action=widget-toggle][value=focus]").focus()');
  await page.key('Space');await wait('uiTest.state.display.widgets.includes("focus")');
  assert.equal(await evaluate('document.querySelector(".settings-disclosure[data-id=widgets]").open'),true,'expanded controls stay expanded after saving');
  assert.equal(await evaluate('document.activeElement.value'),'focus');
 });
 await check('docked panels fill the layout height even when the home composer takes its own row',async()=>{
  for(const width of [1440,1180]){
   await viewport(width);await nav('home');
   await evaluate('uiTest.openPanel("確認用のパネル","<p>パネルの内容</p>","creative")');await settle();
   const rects=await evaluate('(()=>{const p=document.querySelector("#panel").getBoundingClientRect(),l=document.querySelector("#layout").getBoundingClientRect();return {panel:{top:p.top,bottom:p.bottom,height:p.height},layout:{top:l.top,bottom:l.bottom}};})()');
   assert.ok(Math.abs(rects.panel.top-rects.layout.top)<=1&&Math.abs(rects.panel.bottom-rects.layout.bottom)<=1,JSON.stringify({width,...rects}));
   await evaluate('uiTest.closePanel()');
  }
 });
 await check('settings adapt to the remaining surface width with conversation and a docked panel open',async()=>{
  await viewport(1440);await nav('settings');
  await evaluate('uiTest.actions["talk-open"]();uiTest.openPanel("確認用のパネル","<p>パネルの内容</p>","creative")');await settle();
  const layout=await evaluate('(()=>{const s=document.querySelector("#surface"),g=document.querySelector(".settings-grid");return {width:s.clientWidth,scrollWidth:s.scrollWidth,columns:getComputedStyle(g).gridTemplateColumns};})()');
  assert.ok(layout.width<1024,JSON.stringify(layout));
  assert.ok(layout.scrollWidth<=layout.width+1,JSON.stringify(layout));
  assert.equal(layout.columns.split(" ").length,1,'settings navigation must stack above narrow content');
  await evaluate('uiTest.closePanel();uiTest.actions["talk-close"]()');
 });
 await check('toast can be dismissed, and navigation clears it; dark mode and idle mode still work',async()=>{
  await evaluate('uiTest.notice("確認用のお知らせ")');assert.equal(await evaluate('document.querySelector("#toast").classList.contains("show")'),true);
  await evaluate('document.querySelector("#toast").click()');assert.equal(await evaluate('document.querySelector("#toast").classList.contains("show")'),false);
  await evaluate('uiTest.notice("移動前のお知らせ")');await nav('settings');assert.equal(await evaluate('document.querySelector("#toast").classList.contains("show")'),false);
  await evaluate('document.querySelector(".settings-nav [data-id=general]").click()');
  await evaluate('document.querySelector("[data-action=theme-set][data-value=dark]").click()');await wait('document.body.dataset.theme==="dark"');
  await evaluate('uiTest.setAmbient(true)');assert.equal(await evaluate('document.body.classList.contains("is-ambient")'),true);
  await evaluate('uiTest.setAmbient(false,{restore:true})');assert.equal(await evaluate('document.body.dataset.view'), 'settings');
 });
 assert.deepEqual(errors,[],'no browser runtime exceptions');
 console.log(JSON.stringify({checks,failures,errors,realModels:false,transport:'offline preview; HTTP regression suite is separate'},null,2));
 assert.equal(failures.length,0,'UI regression checks failed');
}finally{await browser.close();await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}

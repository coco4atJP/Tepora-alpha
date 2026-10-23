/** Optional offline Chromium regression: node tests/browser-dialogue.mjs
 * Uses the real bundle and DOM, isolated synthetic data and no sandbox bypass.
 */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
import {browserBundle} from '../core/frontend.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),temp=await mkdtemp(path.join(os.tmpdir(),'tepora-dialogue-'));
const browser=new Browser({executable:findBrowser(process.env.CHROMIUM_PATH),profileDir:temp,headless:true});
const checks=[],failures=[],errors=[];
try{
 const page=await browser.page('dialogue');
 browser.conn.on(m=>{if(m.sessionId===page.sessionId){
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);
  if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type))errors.push(m.params.args.map(a=>a.value||a.description).join(' '));
 }});
 await page.send('Network.enable');await page.send('Network.setBlockedURLs',{urls:['http://*','https://*']});
 const code=(await browserBundle(path.join(root,'web'),{preview:true})).replace('\n})().catch(fail)',
  '\nwindow.dialogueTest={state,showDialogue,render,actions,openSheet,closeSheet,openPanel,closePanel,emit:dispatch};\n})().catch(fail)');
 const css=await readFile(path.join(root,'web/styles.css'),'utf8'),avatarCss=await readFile(path.join(root,'web/avatar.css'),'utf8');
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tepora dialogue regression</title><style>${css}\n${avatarCss}</style></head><body><div id="app"></div><div id="overlay"></div><div id="toast" role="status"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 const ev=expression=>page.eval(expression,{awaitPromise:true});
 const settle=()=>ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const wait=async expression=>{const end=Date.now()+8000;do{if(await ev(expression))return;await new Promise(r=>setTimeout(r,25));}while(Date.now()<end);throw Error(`Timed out: ${expression}`);};
 const viewport=async width=>{await page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});await settle();};
 const check=async(name,run)=>{try{await run();checks.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:error.stack});console.error('FAIL '+name+': '+error.message);}};
 await viewport(1440);
 const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
 await wait('!!window.dialogueTest');
 await check('correct page and meaningful empty conversation, with no error overlay',async()=>{
  assert.equal(await ev('location.href'),'about:blank');assert.equal(await ev('document.title'),'Tepora dialogue regression');
  await ev('dialogueTest.actions["talk-open"]()');
  assert.equal(await ev('!!document.querySelector(".dialogue-welcome")'),true);
  assert.equal(await ev('!!document.querySelector(".fatal, vite-error-overlay")'),false);
 });
 await ev(`dialogueTest.state.jobs=[{id:'question-job',title:'地域を確認',status:'paused',revision:1,pendingQuestionId:'q1'},{id:'unrelated',title:'別の仕事',status:'running',revision:1}];
  dialogueTest.state.dialogue.messages=Array.from({length:80},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',at:new Date(Date.UTC(2026,9,23,0,0,i)).toISOString(),content:('会話 '+i+' **読み返している文章**。\\n\\n').repeat(4)}));
  dialogueTest.state.dialogue.messages.push({id:'question',kind:'worker-question',role:'tool',jobId:'question-job',jobRevision:1,questionId:'q1',questionStatus:'pending',content:'どの地域を調べますか？',at:'2026-10-23T01:00:00Z'});dialogueTest.showDialogue();`);
 await check('unrelated work updates preserve message nodes, selection and focused answers',async()=>{
  await ev(`window.firstMessage=document.querySelector('[data-message-id="m0"]');window.answer=document.querySelector('[data-action="reply-worker-question"]');answer.focus();
   const range=document.createRange();range.selectNodeContents(firstMessage.querySelector('.msg-bubble'));getSelection().removeAllRanges();getSelection().addRange(range);window.selectedText=getSelection().toString();
   dialogueTest.emit({type:'job.updated',data:{...dialogueTest.state.jobs[1],revision:2}});`);
  await ev('new Promise(r=>setTimeout(r,120))');
  assert.equal(await ev('firstMessage===document.querySelector("[data-message-id=m0]")'),true);
  assert.equal(await ev('getSelection().toString()===selectedText'),true);
  assert.equal(await ev('document.activeElement===answer'),true);
 });
 await check('answered questions replace only their row and keep focus on its context',async()=>{
  await ev(`dialogueTest.state.jobs[0]={...dialogueTest.state.jobs[0],revision:2,pendingQuestionId:null};dialogueTest.state.dialogue.messages.at(-1).questionStatus='answered';dialogueTest.showDialogue()`);
  assert.equal(await ev('!!document.querySelector("[data-action=reply-worker-question]")'),false);
  assert.equal(await ev('document.activeElement.dataset.messageId'),'question');
  assert.equal(await ev('firstMessage===document.querySelector("[data-message-id=m0]")'),true);
 });
 await check('reading position survives appends and streams; latest control returns focus to the log',async()=>{
  await ev(`const host=document.querySelector('#dialogue-transcript');host.scrollTop=300;window.readingTop=host.scrollTop;
   dialogueTest.emit({type:'dialogue.message',data:{id:'new-message',role:'assistant',content:'新しい返事',at:'2026-10-23T01:01:00Z'}});
   dialogueTest.emit({type:'dialogue.delta',data:{text:'届いている途中の返事'.repeat(100)}});`);await settle();
  assert.equal(await ev('document.querySelector("#dialogue-transcript").scrollTop===readingTop'),true);
  assert.match(await ev('document.querySelector("#dialogue-latest").textContent'),/新しいメッセージ/);
  await ev('document.querySelector("#dialogue-latest").click()');
  await wait('document.querySelector("#dialogue-latest").hidden');
  assert.equal(await ev('document.activeElement.id'),'dialogue-transcript');
 });
 await check('stream bursts paint once, retain the latest text and cannot return after stop or commit',async()=>{
  const result=await ev(`(async()=>{const body=document.querySelector('#dialogue-live .msg-bubble');let writes=0;
   const observer=new MutationObserver(records=>{writes+=records.filter(r=>r.target===body).length});observer.observe(body,{childList:true});
   for(let i=0;i<120;i++)dialogueTest.emit({type:'dialogue.delta',data:{text:'返事 '+i}});
   const before=writes;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));observer.disconnect();return {before,writes,text:body.textContent};})()`);
  assert.deepEqual(result,{before:0,writes:1,text:'返事 119'});
  await ev(`dialogueTest.emit({type:'dialogue.delta',data:{text:'停止前の古い返事'}});dialogueTest.emit({type:'session.updated',data:{kind:'main',status:'idle'}})`);await settle();
  assert.equal(await ev('document.querySelector("#dialogue-live").hidden'),true);
  await ev(`dialogueTest.emit({type:'dialogue.delta',data:{text:'確定前の下書き'}});dialogueTest.emit({type:'dialogue.message',data:{id:'committed',role:'assistant',content:'確定した返事',at:'2026-10-23T01:02:00Z'}})`);await settle();
  assert.equal(await ev('document.querySelector("#dialogue-live").hidden'),true);
  assert.equal(await ev('document.querySelector("#dialogue-transcript").textContent.includes("確定前の下書き")'),false);
 });
 await check('shared view evicts private DOM and pending stream; repeated toggles restore one history',async()=>{
  for(let i=0;i<3;i++){
   await ev(`dialogueTest.emit({type:'dialogue.delta',data:{text:'非公開のストリーム'}});dialogueTest.actions.share()`);await settle();
   assert.equal(await ev('document.querySelector("#dialogue-transcript").querySelectorAll(".msg").length'),0);
   assert.equal(await ev('document.querySelector("#dialogue-transcript").textContent.includes("非公開のストリーム")'),false);
   await ev('dialogueTest.actions.share()');await settle();
   assert.equal(await ev('document.querySelectorAll("[data-message-id=committed]").length'),1);
  }
  await ev(`dialogueTest.emit({type:'session.updated',data:{kind:'main',status:'idle'}})`);
 });
 await check('320–1440px, light/dark and live reduced-motion changes retain usable controls',async()=>{
  for(const width of [320,390,768,1440]){
   await viewport(width);await ev(`dialogueTest.actions.view({dataset:{view:${JSON.stringify(width<900?'talk':'home')}}});dialogueTest.actions['talk-open']()`);await settle();
   for(const theme of ['light','dark']){
    await ev(`document.body.dataset.theme=${JSON.stringify(theme)}`);
    const result=await ev(`(()=>{const host=document.querySelector('#dialogue-transcript'),input=document.querySelector('#composer-input'),r=input.getBoundingClientRect();return {overflow:host.scrollWidth>host.clientWidth+1,visible:r.width>40&&r.top>=0&&r.bottom<=innerHeight,nav:[...document.querySelectorAll('.nav button')].filter(n=>n.getClientRects().length).every(n=>n.getBoundingClientRect().bottom<=innerHeight+1)}})()`);
    assert.deepEqual(result,{overflow:false,visible:true,nav:true},JSON.stringify({width,theme,result}));
   }
  }
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await settle();
  await ev(`document.querySelector('#dialogue-transcript').scrollTop=1e9;dialogueTest.emit({type:'dialogue.message',data:{id:'reduced',role:'assistant',content:'静かな新着',at:'2026-10-23T01:03:00Z'}})`);
  assert.ok(parseFloat(await ev('getComputedStyle(document.querySelector("[data-message-id=reduced]")).animationDuration'))<.001);
 });
 await check('repeated navigation retains drafts; modal cancel/discard and panel close restore focus',async()=>{
  await ev(`const input=document.querySelector('#composer-input');input.value='送信前の下書き';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  for(let i=0;i<3;i++)for(const view of ['settings','memory','workspace','home'])await ev(`dialogueTest.actions.view({dataset:{view:'${view}'}})`);
  assert.equal(await ev('document.querySelector("#composer-input").value'),'送信前の下書き');
  await ev(`document.querySelector('#composer-input').focus();dialogueTest.actions.personas()`);await settle();
  await ev(`const field=document.querySelector('#personas-form [name=characterName]');field.value='未保存';field.dispatchEvent(new Event('input',{bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await ev('!!document.querySelector(".discard-bar")'),true);
  await ev('document.querySelector("[data-action=discard-cancel]").click()');assert.equal(await ev('!!document.querySelector(".discard-bar")'),false);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('[data-action=discard-close]').click()`);
  assert.equal(await ev('document.activeElement.id'),'composer-input');
  for(let i=0;i<3;i++){
   await ev(`document.querySelector('#composer-input').focus();dialogueTest.openPanel('確認','<p>閉じても下書きを保ちます。</p>','test')`);await settle();
   await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
   assert.equal(await ev('document.activeElement.id'),'composer-input');
  }
 });
 assert.deepEqual(errors,[],'browser console and runtime must stay clean');
 console.log(JSON.stringify({checks,failures,errors,realModels:false,transport:'offline bundled UI; HTTP/native acceptance is separate'},null,2));
 if(failures.length)process.exitCode=1;
}finally{await browser.close();await rm(temp,{recursive:true,force:true});}

/** Optional installed-Chromium hands-free UI regression.
 * node tests/browser-handsfree.mjs [evidence-directory]
 * All audio, models, worker responses and conversation replies are synthetic.
 * Like existing Python browser fixtures, this cloud-only harness uses Chromium
 * --no-sandbox, an isolated temporary profile and blocked external requests.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
import {browserBundle} from '../core/frontend.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const temp=await mkdtemp(path.join(os.tmpdir(),'tepora-handsfree-ui-'));
const evidence=path.resolve(process.argv[2]||path.join(os.tmpdir(),'tepora-handsfree-evidence'));
await mkdir(evidence,{recursive:true});
const browser=new Browser({executable:findBrowser(process.env.CHROMIUM_PATH),profileDir:path.join(temp,'profile'),headless:true},{spawnProcess:(executable,args,options)=>spawn(executable,['--no-sandbox',...args],options)});
const errors=[],consoleErrors=[],checks=[],failures=[];
const originServer=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Synthetic QA origin</title>');});
await new Promise(resolve=>originServer.listen(0,'127.0.0.1',resolve));originServer.unref();
const fixture=`
 const uiFixture={calls:[],audios:[],wakeNext:false,media:[],replyId:0};
 const fixtureConfig={schema:1,revision:0,profiles:[{id:'synthetic-local-tts',identity:'synthetic-identity',name:'合成ローカル音声',role:'tts',domain:'device',enabled:true,model:'fake'}],routes:{tts:'synthetic-local-tts'}};
 bridge.init=async()=>({...structuredClone(previewState),preview:false,setup:{dismissed:true},settings:{...previewState.settings,asrStreamUrl:'http://127.0.0.1:8768',voiceEnabled:true,dictationEditing:false},capabilities:fixtureConfig,providers:{...previewState.providers,profiles:[{id:'synthetic-local-model',enabled:true,model:'synthetic'}]},dialogue:{...previewState.dialogue,status:'idle'}});
 bridge.request=async(route,method='GET',body)=>{
  uiFixture.calls.push({route,method,body});
  if(route==='/api/voice/wake/start'||route==='/api/voice/start'||route==='/api/voice/barge/start')return {id:'synthetic-'+uiFixture.calls.length};
  if(route==='/api/voice/cancel')return {};
  if(route==='/api/voice/chunk'){const detected=uiFixture.wakeNext;uiFixture.wakeNext=false;return {detected,text:'合成の途中音声'};}
  if(route==='/api/voice/finish')return {text:'合成の発話です'};
  if(route==='/api/capabilities')return fixtureConfig;
  if(route==='/api/media/jobs'&&method==='POST'){const job={id:'synthetic-media-'+uiFixture.media.length,kind:'tts',title:'合成音声',status:'running'};uiFixture.media.push(job);return job;}
  if(route==='/api/media/jobs')return {jobs:uiFixture.media};
  if(route==='/api/agent/input'){setTimeout(()=>{const reply={id:'synthetic-reply-'+(++uiFixture.replyId),role:'assistant',content:'合成の返答です',at:new Date().toISOString()};state.dialogue.messages.push(reply);state.dialogue.status='idle';dispatch({type:'fixture.reply',data:reply});},50);return {};}
  if(route.endsWith('/stop')){state.dialogue.status='paused';return {stopped:true};}
  if(route==='/api/presence')return {};
  throw Error('Unexpected synthetic request: '+route);
 };
 handsFreeVoice.audioFactory=()=>{const audio={closed:0,attached:0,released:0,retired:0,async start(onFrame,onError){this.emit=onFrame;this.onError=onError;if(!uiFixture.virtual)this.timer=setInterval(()=>onFrame(new Float32Array(3200)),200);},attachOutput(output){this.output=output;this.attached++;return true;},releaseOutput(){this.output=null;this.released++;},retireOutput(){this.output=null;this.retired++;},close(){this.closed++;clearInterval(this.timer);}};uiFixture.audios.push(audio);return audio;};
 uiFixture.useVirtualBarge=()=>{
  uiFixture.virtual=true;uiFixture.clock=0;uiFixture.timerId=0;uiFixture.timers=new Map();uiFixture.handles=[];
  handsFreeVoice.now=()=>uiFixture.clock;
  handsFreeVoice.setTimer=(fn,ms)=>{const id=++uiFixture.timerId;uiFixture.timers.set(id,{fn,at:uiFixture.clock+ms});return id;};
  handsFreeVoice.clearTimer=id=>uiFixture.timers.delete(id);
  uiFixture.advance=async ms=>{const target=uiFixture.clock+ms;for(let i=0;i<10000;i++){const next=[...uiFixture.timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;uiFixture.clock=next[1].at;uiFixture.timers.delete(next[0]);next[1].fn();for(let j=0;j<80;j++)await Promise.resolve();}uiFixture.clock=target;};
  const originalStop=handsFreeVoice.stopOutput;handsFreeVoice.stopOutput=()=>{if(uiFixture.output)uiFixture.output.paused=true;uiFixture.output=null;originalStop();};
  handsFreeVoice.pauseOutput=()=>{const output=uiFixture.output;if(!output||output.paused||output.muted||output.ended)return null;let live=true;
   const handle={resumes:0,cancels:0,async resume(){if(!live||uiFixture.output!==output||output.muted||output.ended)return false;live=false;this.resumes++;output.paused=false;handsFreeVoice.setSpeaking(true,output);return true;},cancel(){if(!live||uiFixture.output!==output)return;live=false;this.cancels++;output.paused=true;uiFixture.output=null;handsFreeVoice.setSpeaking(false);}};
   uiFixture.handles.push(handle);output.paused=true;handsFreeVoice.setSpeaking(false);return handle;
  };
  uiFixture.playOutput=()=>{uiFixture.output={paused:false,muted:false,ended:false,volume:1};handsFreeVoice.setSpeaking(true,uiFixture.output);};
 };

`;
try{
 const page=await browser.page('hands-free');
 browser.conn.on(message=>{if(message.sessionId!==page.sessionId)return;if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')consoleErrors.push(message.params.args.map(a=>a.value||a.description).join(' '));});
 await page.send('Network.enable');await page.send('Page.navigate',{url:`http://127.0.0.1:${originServer.address().port}`});
 const evaluate=expression=>page.eval(expression,{awaitPromise:true});
 const wait=async expression=>{const end=Date.now()+8000;do{if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<end);throw Error('Timed out: '+expression);};
 const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const viewport=async width=>{await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await settle();};
 const screenshot=async name=>{const {data}=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(evidence,name+'.png'),Buffer.from(data,'base64'));};
 const check=async(name,run)=>{try{await run();checks.push(name);console.log('PASS '+name);}catch(error){const diagnostics=await evaluate('({state:handsFreeTest?.handsFreeVoice.state,toast:document.querySelector("#toast")?.textContent,calls:handsFreeTest?.uiFixture.calls.slice(-8).map(c=>({...c,body:c.body?.pcm?{...c.body,pcm:"[synthetic PCM]"}:c.body}))})').catch(()=>null);failures.push({name,error:error.message,diagnostics});console.error('FAIL '+name+': '+error.message+' '+JSON.stringify(diagnostics));await screenshot('failure-'+failures.length);}};
 const emit=async(value=0)=>{await evaluate(`handsFreeTest.uiFixture.audios.at(-1).emit(new Float32Array(3200).fill(${value}))`);await settle();};
 const start=async(readout=false,barge=false)=>{await evaluate(`handsFreeTest.actions['voice-settings']();document.querySelector('#hands-free-readout').checked=${readout};document.querySelector('#hands-free-barge').checked=${barge};document.querySelector('[data-action="hands-free-start"]').click()`);await wait('handsFreeTest.handsFreeVoice.state==="idle"');};
 const speakTurn=async()=>{await evaluate('handsFreeTest.uiFixture.wakeNext=true');await emit(.03);await wait('handsFreeTest.handsFreeVoice.state==="listening"');await emit(.03);await emit(.03);for(let i=0;i<4;i++)await emit();};
 let code=await browserBundle(path.join(root,'web'),{preview:false});const boot='try{\n state=await bridge.init()';assert.ok(code.includes(boot));code=code.replace(boot,fixture+'\n'+boot).replace('\n})().catch(fail)','\nwindow.handsFreeTest={state,actions,render,abilities,handsFreeVoice,uiFixture};\n})().catch(fail)');
 const css=(await readFile(path.join(root,'web/styles.css'),'utf8'))+'\n'+(await readFile(path.join(root,'web/avatar.css'),'utf8'));
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tepora hands-free synthetic QA</title><style>${css}</style></head><body><div id="app"></div><div id="overlay"></div><div id="toast" role="status"></div><script>${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
 await wait('location.protocol==="http:"&&isSecureContext');await page.send('Network.setBlockedURLs',{urls:['http://*','https://*']});await viewport(1440);const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html});await wait('!!window.handsFreeTest&&!!document.querySelector("#clock-display")?.textContent');
 await check('live-mode production bundle boots without runtime errors or microphone opt-in',async()=>{assert.equal(await evaluate('document.title'),'Tepora hands-free synthetic QA');assert.equal(await evaluate('document.querySelectorAll(".fatal").length'),0);assert.equal(await evaluate('handsFreeTest.uiFixture.audios.length'),0);assert.equal(await evaluate('handsFreeTest.abilities()===handsFreeTest.abilities()'),true);assert.equal(await evaluate('document.querySelector("#hands-free-status").hidden'),true);await screenshot('01-desktop-home');});
 await check('settings exposes start, mute and unchecked readout opt-in',async()=>{await evaluate('document.querySelector(".nav [data-view=settings]").click();document.querySelector("[data-action=voice-settings]").click()');assert.equal(await evaluate('document.querySelector("#hands-free-readout").checked'),false);assert.deepEqual(await evaluate('({checked:document.querySelector("#hands-free-barge").checked,value:document.querySelector("#hands-free-echo-tail").value,min:document.querySelector("#hands-free-echo-tail").min,max:document.querySelector("#hands-free-echo-tail").max})'),{checked:false,value:'1200',min:'800',max:'3000'});assert.equal(await evaluate('!!document.querySelector("[data-action=hands-free-start]")&&!!document.querySelector("[data-action=hands-free-mute]")'),true);await screenshot('02-voice-settings');});
 await check('explicit start opens one synthetic microphone and shows the live mute status',async()=>{await start(false);assert.equal(await evaluate('handsFreeTest.uiFixture.audios.length'),1);assert.equal(await evaluate('document.querySelector("#hands-free-status").textContent'),'呼びかけ待ち');assert.equal(await evaluate('document.querySelector("#hands-free-status").hidden'),false);await screenshot('03-desktop-listening');});
 await check('active topbar mute control fits desktop and phone widths',async()=>{const bad=[];for(const width of [1440,390,320]){await viewport(width);const value=await evaluate('(()=>{const r=document.querySelector("#hands-free-status").getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth,bodyWidth:document.documentElement.scrollWidth};})()');if(value.width<=0||value.left<0||value.right>width+1||value.bodyWidth>width+1)bad.push({width,...value});await screenshot('04-active-'+width);}assert.deepEqual(bad,[]);await viewport(1440);});
 await check('wake, endpoint and auto-send use current dialogue without unrequested readout',async()=>{await speakTurn();await wait('handsFreeTest.handsFreeVoice.state==="idle"');assert.equal(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/agent/input").length'),1);assert.equal(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/media/jobs"&&c.method==="POST").length'),0);});
 await check('readout opt-in gates capture while synthetic local voice is prepared',async()=>{await evaluate('handsFreeTest.actions["hands-free-mute"]()');await start(true);await speakTurn();await wait('handsFreeTest.handsFreeVoice.state==="speaking"');assert.equal(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/media/jobs"&&c.method==="POST").length'),1);assert.equal(await evaluate('document.querySelector("#hands-free-status").textContent'),'読み上げ中');await screenshot('05-readout-speaking');});
 await check('mute during speaking releases capture and preserves an independent worker',async()=>{await evaluate('handsFreeTest.state.jobs=[{id:"independent-worker",status:"running",title:"独立した合成作業"}];document.querySelector("#hands-free-status").click()');await wait('!handsFreeTest.handsFreeVoice.active');assert.equal(await evaluate('handsFreeTest.uiFixture.audios.at(-1).closed'),1);assert.equal(await evaluate('handsFreeTest.state.jobs[0].status'),'running');assert.equal(await evaluate('handsFreeTest.uiFixture.calls.some(c=>c.route==="/api/stop")'),false);});
 await check('mute during processing stops only the current main session',async()=>{await start(false);await evaluate('handsFreeTest.state.dialogue.status="running";handsFreeTest.handsFreeVoice.stateTo("processing");document.querySelector("#hands-free-status").click()');await wait('!handsFreeTest.handsFreeVoice.active');assert.deepEqual(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route.endsWith("/stop")).map(c=>c.route)'),['/api/agent/sessions/preview-dialogue/stop']);assert.equal(await evaluate('handsFreeTest.state.jobs[0].status'),'running');await screenshot('06-interrupted-worker-preserved');});
 const advance=async ms=>{await evaluate(`handsFreeTest.uiFixture.advance(${ms})`);await settle();};
 const duplex=async(detected=false)=>{await evaluate(`handsFreeTest.uiFixture.wakeNext=${detected};handsFreeTest.uiFixture.audios.at(-1).emit(new Float32Array(3200).fill(.03),new Float32Array(3200).fill(.02))`);await settle();};
 const bargeStart=async()=>{await start(false,true);await evaluate('handsFreeTest.uiFixture.playOutput()');await advance(0);await wait('handsFreeTest.handsFreeVoice.state==="barge-listening"');};
 const mute=async()=>{await evaluate('document.querySelector("#hands-free-status").click()');await wait('!handsFreeTest.handsFreeVoice.active');};
 await check('experimental barge opt-in validates the acoustic-tail bounds before acquiring a microphone',async()=>{
  await evaluate('handsFreeTest.state.dialogue.status="idle";handsFreeTest.uiFixture.useVirtualBarge()');const before=await evaluate('handsFreeTest.uiFixture.audios.length');
  for(const value of [799,3001]){await evaluate(`handsFreeTest.actions['voice-settings']();document.querySelector('#hands-free-barge').checked=true;document.querySelector('#hands-free-echo-tail').value=${value};document.querySelector('[data-action="hands-free-start"]').click()`);await settle();assert.equal(await evaluate('handsFreeTest.handsFreeVoice.active'),false);assert.equal(await evaluate('handsFreeTest.uiFixture.audios.length'),before);}
 });
 await check('barge playback echo with no learned detection never pauses output',async()=>{
  await bargeStart();const before=await evaluate('handsFreeTest.uiFixture.handles.length');for(let i=0;i<3;i++)await duplex(false);
  assert.equal(await evaluate('handsFreeTest.uiFixture.handles.length'),before);assert.equal(await evaluate('handsFreeTest.uiFixture.output.paused'),false);assert.equal(await evaluate('handsFreeTest.uiFixture.audios.at(-1).attached'),1);assert.equal(await evaluate('document.querySelector("#hands-free-status").textContent'),'読み上げ中・呼びかけ可');await screenshot('07-barge-listening');
 });
 await check('candidate pauses exact output, waits 1200ms and shows fresh-wake confirmation at 320px',async()=>{
  const asr=await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/start").length');await duplex(true);await wait('handsFreeTest.handsFreeVoice.state==="barge-quiet"');assert.equal(await evaluate('handsFreeTest.uiFixture.output.paused'),true);
  await advance(1199);assert.equal(await evaluate('handsFreeTest.handsFreeVoice.state'),'barge-quiet');await advance(1);await wait('handsFreeTest.handsFreeVoice.state==="barge-confirm"');assert.equal(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/start").length'),asr);
  await viewport(320);const bounds=await evaluate('(()=>{const e=document.querySelector("#hands-free-status"),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,body:document.documentElement.scrollWidth,text:e.textContent,scroll:e.scrollWidth,client:e.clientWidth};})()');assert.ok(bounds.width>0&&bounds.left>=0&&bounds.right<=321&&bounds.body<=321&&bounds.scroll<=bounds.client+1&&bounds.top>=0&&bounds.bottom<=52,JSON.stringify(bounds));assert.equal(bounds.text,'もう一度呼びかけ');assert.equal(await evaluate('document.querySelector("#hands-free-status").getAttribute("aria-label")'),'中断するならもう一度呼びかけてください。押すと直ちにミュートして音声会話を中断');await screenshot('08-barge-confirm-320');await viewport(1440);
  await duplex(false);assert.equal(await evaluate('handsFreeTest.handsFreeVoice.state'),'barge-confirm');await duplex(true);await wait('handsFreeTest.handsFreeVoice.state==="listening"');assert.equal(await evaluate('handsFreeTest.uiFixture.handles.at(-1).cancels'),1);assert.equal(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/start").length'),asr+1);await screenshot('09-barge-confirmed-asr');await mute();
 });
 await check('missing second wake resumes owned output at the confirmation deadline without ASR',async()=>{
  await bargeStart();const asr=await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/start").length');await duplex(true);await advance(1200);await wait('handsFreeTest.handsFreeVoice.state==="barge-confirm"');await emit();await advance(4999);assert.equal(await evaluate('handsFreeTest.uiFixture.output.paused'),true);await emit();await advance(1);await wait('handsFreeTest.handsFreeVoice.state==="barge-listening"');assert.equal(await evaluate('handsFreeTest.uiFixture.handles.at(-1).resumes'),1);assert.equal(await evaluate('handsFreeTest.uiFixture.output.paused'),false);assert.equal(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/start").length'),asr);await screenshot('10-barge-timeout-resumed');await mute();
 });
 await check('topbar mute during confirmation immediately closes capture and prevents later resume',async()=>{
  await bargeStart();await duplex(true);await advance(1200);await wait('handsFreeTest.handsFreeVoice.state==="barge-confirm"');const asr=await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/start").length');await mute();assert.equal(await evaluate('handsFreeTest.uiFixture.audios.at(-1).closed'),1);await advance(6000);assert.equal(await evaluate('handsFreeTest.uiFixture.handles.at(-1).resumes'),0);assert.equal(await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/start").length'),asr);assert.equal(await evaluate('handsFreeTest.uiFixture.timers.size'),0);assert.equal(await evaluate('handsFreeTest.state.jobs[0].status'),'running');await screenshot('11-barge-confirm-muted');
 });
 assert.deepEqual(errors,[],'no browser runtime exceptions');assert.deepEqual(consoleErrors,[],'no console errors');
 const result={checks,failures,errors,consoleErrors,evidence,browserPlugin:'unavailable',harness:'installed Chromium, --no-sandbox, isolated profile, blocked external HTTP(S)',actualAudio:false,actualMicrophone:false,actualModels:false,syntheticMicrophones:await evaluate('handsFreeTest.uiFixture.audios.length'),syntheticMicrophonesClosed:await evaluate('handsFreeTest.uiFixture.audios.filter(a=>a.closed===1).length'),syntheticBargeWorkers:await evaluate('handsFreeTest.uiFixture.calls.filter(c=>c.route==="/api/voice/barge/start").length'),syntheticPauseHandles:await evaluate('handsFreeTest.uiFixture.handles.length'),externalProviders:false};await writeFile(path.join(evidence,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));assert.equal(failures.length,0,'hands-free UI regression');
}finally{await browser.close();await new Promise(resolve=>originServer.close(resolve));await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}

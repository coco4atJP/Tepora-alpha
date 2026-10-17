/** Real HTMLAudioElement pending-play ownership with gated loopback WAV delivery.
 * node tests/browser-pending-play.mjs [evidence-directory]
 * Optional TEPORA_CAPABILITY_UI_SNAPSHOT selects saved pre-fix capability source.
 * Synthetic mic/workers, silent WAV, isolated muted Chromium; no real inference.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Browser,findBrowser} from '../core/computer/browser.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),temp=await mkdtemp(path.join(os.tmpdir(),'tepora-pending-play-'));
const evidence=path.resolve(process.argv[2]||'/tmp/tepora-pending-play');await mkdir(evidence,{recursive:true});
const wav=Buffer.alloc(44+16000*2*12);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
const held=new Map(),released=new Set(),requests=[];
const sendWav=res=>{if(res.destroyed)return;res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':wav.length,'Cache-Control':'no-store'});res.end(wav);};
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname.startsWith('/audio/')){
  const id=url.pathname.slice(7);requests.push(id);
  if(url.searchParams.has('hold')&&!released.has(id)){if(!held.has(id))held.set(id,[]);held.get(id).push(res);}else sendWav(res);
 }else if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();}
 else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Tepora pending play QA</title>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();const origin=`http://127.0.0.1:${server.address().port}`;
const release=id=>{released.add(id);for(const res of held.get(id)||[])sendWav(res);held.delete(id);};
const browser=new Browser({executable:findBrowser(process.env.CHROMIUM_PATH),profileDir:path.join(temp,'profile'),headless:true},{spawnProcess:(exe,args,options)=>spawn(exe,['--no-sandbox','--mute-audio','--autoplay-policy=no-user-gesture-required',...args],options)});
const checks=[],failures=[],runtimeErrors=[],consoleErrors=[],blocked=[];
async function waitUntil(check,label){const end=Date.now()+5000;do{if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<end);throw Error('Timed out: '+label);}
const fixture=`
 const f={calls:[],events:[],plays:[],notices:[],errors:[],timers:new Map(),time:0,timerId:0,media:0,nextDetected:false,mics:[]};
 const profile={id:'synthetic-voice',identity:'synthetic',name:'Synthetic voice',role:'tts',domain:'device',enabled:true};
 const bridge={on(){},async request(route,method='GET',body){f.calls.push({route,method,body});if(route==='/api/capabilities')return {profiles:[profile],routes:{tts:profile.id}};if(route==='/api/media/jobs'&&method==='POST')return {id:'job-'+(++f.media)};if(route==='/api/media/jobs')return {jobs:[{id:'job-'+f.media,kind:'tts',title:'Silent local audio',status:'ready',asset:{id:'asset-'+f.media,mime:'audio/wav'}}]};if(route.endsWith('/start'))return {id:'worker-'+f.calls.length};if(route.endsWith('/cancel'))return {};if(route.endsWith('/chunk')){const detected=f.nextDetected;f.nextDetected=false;return {detected};}throw Error('Unexpected fixture route '+route);}};
 let capabilities;
 const voice=new HandsFreeVoice({bridge,now:()=>f.time,setTimer(fn,ms){const id=++f.timerId;f.timers.set(id,{fn,at:f.time+ms});return id;},clearTimer:id=>f.timers.delete(id),onState:state=>document.querySelector('#state').textContent=state,onError:error=>f.errors.push(error.message),stopOutput:()=>capabilities?.stopPlayback(),pauseOutput:()=>capabilities.pauseForBarge(),audioFactory(){const mic={closed:0,async start(emit){this.emit=emit;},attachOutput:audio=>audio instanceof HTMLAudioElement,releaseOutput(){},retireOutput(){},close(){this.closed++;}};f.mics.push(mic);return mic;}});
 capabilities=createCapabilityUI({bridge,openSheet(){},closeSheet(){},notice:message=>f.notices.push(message),isPrivate:()=>true,isOpen:()=>false,latestReply:()=> 'Synthetic local reply',onPlayback(active,audio){
  if(audio&&!audio.dataset.fixture){audio.dataset.fixture='true';audio.src=${JSON.stringify(origin)}+'/audio/'+audio.dataset.mediaId+(f.delayed?'?hold=1':'');audio.loop=true;f.audio=audio;
   const play=audio.play.bind(audio);audio.play=()=>{const attempt={asset:audio.dataset.mediaId,settled:false};f.plays.push(attempt);const promise=play();promise.then(()=>{attempt.settled=true;attempt.result='fulfilled';},error=>{attempt.settled=true;attempt.result=error.name;});return promise;};
   for(const type of ['play','playing','pause','ended','error'])audio.addEventListener(type,()=>f.events.push({type,asset:audio.dataset.mediaId,readyState:audio.readyState,paused:audio.paused}));
  }voice.setSpeaking(active,audio);
 }});
 f.voice=voice;f.capabilities=capabilities;
 f.advance=async ms=>{const target=f.time+ms;for(let i=0;i<10000;i++){const next=[...f.timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;f.time=next[1].at;f.timers.delete(next[0]);next[1].fn();for(let j=0;j<80;j++)await Promise.resolve();}f.time=target;};
 f.emit=async detected=>{f.nextDetected=detected;f.mics.at(-1).emit(new Float32Array(3200).fill(.03),new Float32Array(3200).fill(.02));for(let j=0;j<80;j++)await Promise.resolve();};
 f.reset=async delayed=>{await voice.disable();f.time=0;f.delayed=delayed;f.events=[];f.plays=[];f.notices=[];await voice.enable({bargeIn:true,echoTailMs:1200,confirmationMs:5000});await capabilities.readReply();};
 window.pendingPlay=f;
`;
try{
 const page=await browser.page('pending-play');await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 browser.conn.on(message=>{
  if(message.sessionId!==page.sessionId)return;
  if(message.method==='Runtime.exceptionThrown')runtimeErrors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
  if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')consoleErrors.push(message.params.args.map(a=>a.value||a.description).join(' '));
  if(message.method==='Fetch.requestPaused'){
   const {requestId,request}=message.params,allowed=new URL(request.url).origin===origin;if(!allowed)blocked.push(request.url);
   void page.send(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId}:{requestId,errorReason:'BlockedByClient'}).catch(error=>runtimeErrors.push(error.message));
  }
 });
 await page.send('Page.navigate',{url:origin});
 const evaluate=expression=>page.eval(expression,{awaitPromise:true}),settle=()=>evaluate('new Promise(resolve=>setTimeout(resolve,0))');
 const wait=expression=>waitUntil(()=>evaluate(expression),expression);
 await wait('location.origin==='+JSON.stringify(origin)+'&&isSecureContext');
 await page.send('Fetch.enable',{patterns:[{urlPattern:'http://*'},{urlPattern:'https://*'}]});
 const sources=await Promise.all(['status','markdown','ui','hands-free-voice','capability-ui'].map(name=>readFile(name==='capability-ui'&&process.env.TEPORA_CAPABILITY_UI_SNAPSHOT?process.env.TEPORA_CAPABILITY_UI_SNAPSHOT:path.join(root,'web',name+'.mjs'),'utf8')));
 const code=sources.map(s=>s.replace(/^import .+ from '.+?';\r?\n/gm,'').replace(/^export (?=(?:async )?function\s|class\s|const\s|let\s)/gm,'')).join('\n');
 const {frameTree}=await page.send('Page.getFrameTree');await page.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html:'<!doctype html><title>Tepora pending play QA</title><h1>Native pending play ownership</h1><p>Silent synthetic audio; no microphone or model.</p><output id="state">off</output><section class="input-region"></section><script>'+code+'\n'+fixture+'</script>'});await wait('!!window.pendingPlay');
 assert.equal(await evaluate('document.title'),'Tepora pending play QA');assert.match(await evaluate('document.body.innerText'),/Native pending play ownership/);assert.equal(await evaluate('!!document.querySelector(".fatal, vite-error-overlay, nextjs-portal")'),false);
 const screenshot=async name=>{const {data}=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(evidence,name+'.png'),Buffer.from(data,'base64'));};
 const diagnostics=()=>evaluate('({state:pendingPlay.voice.state,output:pendingPlay.voice.output,paused:pendingPlay.audio?.paused,readyState:pendingPlay.audio?.readyState,plays:pendingPlay.plays,notices:pendingPlay.notices,events:pendingPlay.events,errors:pendingPlay.errors})');
 const check=async(name,run)=>{try{await run();checks.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:error.message,diagnostics:await diagnostics()});await screenshot('failure-'+failures.length);console.error('FAIL '+name+': '+error.message);}finally{await evaluate('pendingPlay.voice.disable()');for(const id of held.keys())release(id);await settle();}};
 for(const delayed of [true,false])await check(delayed?'pending native play AbortError retains ownership through timeout and resumes':'already-playing native audio retains ownership through timeout and resumes',async()=>{
  await evaluate('pendingPlay.reset('+delayed+')');await wait('!pendingPlay.audio.paused&&pendingPlay.events.some(e=>e.type==="play")');
  if(delayed){assert.equal(await evaluate('pendingPlay.audio.readyState'),0);assert.equal(await evaluate('pendingPlay.plays[0].settled'),false);await screenshot('01-pending-play');}
  else await wait('pendingPlay.audio.readyState===4&&pendingPlay.plays[0].result==="fulfilled"&&pendingPlay.events.some(e=>e.type==="playing")');
  const id=await evaluate('pendingPlay.audio.dataset.mediaId');await waitUntil(()=>requests.includes(id),'loopback WAV request '+id);
  await evaluate('pendingPlay.advance(0)');await wait('pendingPlay.voice.state==="barge-listening"');await evaluate('pendingPlay.saved=pendingPlay.audio;pendingPlay.emit(true)');await wait('pendingPlay.audio.paused&&pendingPlay.events.some(e=>e.type==="pause")');
  if(delayed)await wait('pendingPlay.plays[0].result==="AbortError"');
  await evaluate('pendingPlay.advance(1200)');await wait('pendingPlay.voice.state==="barge-confirm"');release(id);await wait('pendingPlay.audio.readyState===4');
  await evaluate('pendingPlay.emit(false)');await evaluate('pendingPlay.advance(5000)');await wait('!pendingPlay.audio.paused&&pendingPlay.plays.at(-1).result==="fulfilled"');await settle();await evaluate('pendingPlay.advance(100)');await wait('pendingPlay.voice.state==="barge-listening"');
  assert.equal(await evaluate('pendingPlay.audio===pendingPlay.saved'),true);assert.equal(await evaluate('pendingPlay.calls.filter(c=>c.route==="/api/voice/start").length'),0);assert.deepEqual(await evaluate('pendingPlay.notices'),[]);assert.deepEqual(await evaluate('pendingPlay.errors'),[]);await screenshot(delayed?'02-pending-resumed':'03-playing-resumed');
 });
 assert.deepEqual(runtimeErrors,[]);assert.deepEqual(consoleErrors,[]);
 const result={checks,failures,runtimeErrors,consoleErrors,blocked,evidence,sourceSnapshot:process.env.TEPORA_CAPABILITY_UI_SNAPSHOT||null,origin,page:await evaluate('({url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight}})'),nativeMediaElement:true,gatedLoopbackWav:true,actualMicrophone:false,actualModels:false,externalProviders:false,microphones:await evaluate('pendingPlay.mics.length'),microphonesClosed:await evaluate('pendingPlay.mics.filter(m=>m.closed===1).length')};
 await writeFile(path.join(evidence,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));assert.equal(failures.length,0,'native pending play regressions');
}finally{await browser.close();for(const id of held.keys())release(id);await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}

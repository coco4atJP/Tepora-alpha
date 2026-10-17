import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechStream} from '../core/speech-stream.mjs';
import {DEFAULT_SETTINGS} from '../core/policy.mjs';
const store={settings:{...DEFAULT_SETTINGS,asrStreamUrl:'http://127.0.0.1:8768'}};
function samples(value=0.1){
 const bytes=Buffer.alloc(3200*4);for(let i=0;i<3200;i++)bytes.writeFloatLE(value,i*4);return bytes.toString('base64');
}
function fixture(){
 let chunks=0;
 const speech=new SpeechStream(store,async(url,options)=>{
  const body=JSON.parse(options.body);
  if(url.endsWith('/api/start'))return Response.json({session_id:'worker'});
  if(url.endsWith('/api/chunk')){chunks++;return Response.json({text:`partial ${chunks}`});}
  if(url.endsWith('/api/finish'))return Response.json({text:'日本語の最終結果'});
  if(url.endsWith('/api/cancel'))return Response.json({cancelled:true});
  throw new Error('Unexpected endpoint');
 });
 return {speech,count:()=>chunks};
}
test('VO01: ordered PCM returns partials and an unsubmitted final transcript',async t=>{
 const {speech}=fixture();t.after(()=>speech.close());const {id}=await speech.start();
 assert.equal((await speech.chunk({id,sequence:0,pcm:samples()})).final,false);
 const done=await speech.finish(id);assert.equal(done.final,true);assert.equal(done.submitted,false);
 assert.equal(speech.sessions.size,0);
});
test('VO01: duplicate audio is acknowledged without appending it twice',async t=>{
 const {speech,count}=fixture();t.after(()=>speech.close());const {id}=await speech.start();
 const packet={id,sequence:0,pcm:samples()};
 assert.deepEqual(await speech.chunk(packet),await speech.chunk(packet));assert.equal(count(),1);
 await assert.rejects(speech.chunk({...packet,pcm:samples(.2)}),/different content/);
});
test('VO01: out-of-order and concurrent microphone sessions are refused',async t=>{
 const {speech}=fixture();t.after(()=>speech.close());const {id}=await speech.start();
 await assert.rejects(speech.start(),/already active/);
 await assert.rejects(speech.chunk({id,sequence:2,pcm:samples()}),/Out-of-order/);
 await speech.cancel(id);assert.equal(speech.sessions.size,0);
});
for(const value of [NaN,Infinity,-Infinity,2,-2])
 test(`VO01: non-finite or invalid sample ${value} is rejected`,async t=>{
  const {speech}=fixture();t.after(()=>speech.close());const {id}=await speech.start();
  await assert.rejects(speech.chunk({id,sequence:0,pcm:samples(value)}),/Invalid audio/);
 });
test('VO01: disabled microphone cannot be opened through the service API',async()=>{
 const speech=new SpeechStream({settings:{...store.settings,voiceEnabled:false}},()=>{throw new Error('must not call');});
 await assert.rejects(speech.start(),/disabled/);
});
test('VO01: a missing worker does not quietly change to a remote speech service',async()=>{
 let calls=0;
 const speech=new SpeechStream(store,async()=>{calls++;return new Response('missing',{status:503});});
 await assert.rejects(speech.start(),/503/);assert.equal(calls,1);assert.equal(speech.sessions.size,0);
});
function wakeEndpoint(t,url='http://127.0.0.1:8769'){
 const previous=process.env.TEPORA_WAKE_URL;process.env.TEPORA_WAKE_URL=url;
 t.after(()=>{if(previous===undefined)delete process.env.TEPORA_WAKE_URL;else process.env.TEPORA_WAKE_URL=previous;});
}
test('wake: dedicated endpoint shares the microphone slot and never marks text submitted',async t=>{
 wakeEndpoint(t);const calls=[];
 const speech=new SpeechStream(store,async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  return Response.json(url.endsWith('/api/start')?{session_id:'wake-worker'}:url.endsWith('/api/chunk')?{text:'synthetic wake phrase',detected:true}:url.endsWith('/api/finish')?{text:'synthetic wake phrase'}:{cancelled:true});
 });t.after(()=>speech.close());
 const {id}=await speech.start(true);await assert.rejects(speech.start(),{status:409});
 const packet={id,sequence:0,pcm:samples()},part=await speech.chunk(packet);
 assert.equal(part.detected,true);assert.equal(part.final,false);assert.equal(part.submitted,undefined);
 assert.deepEqual(await speech.chunk(packet),part);
 assert.deepEqual(await speech.finish(id),{id,text:'synthetic wake phrase',final:true,submitted:false});
 assert.equal(calls.length,3);assert.ok(calls.every(c=>c.url.startsWith('http://127.0.0.1:8769/api/')));
 const asr=await speech.start();assert.equal(calls.at(-1).url,'http://127.0.0.1:8768/api/start');
 await assert.rejects(speech.start(true),{status:409});await speech.cancel(asr.id);
});
test('wake: detected must be a strict boolean and rejected chunks do not advance sequence',async t=>{
 wakeEndpoint(t);let reply={text:''};let chunks=0;
 const speech=new SpeechStream(store,async(url)=>{
  if(url.endsWith('/api/start'))return Response.json({session_id:'worker'});
  if(url.endsWith('/api/chunk')){chunks++;return Response.json(reply);}
  return Response.json({cancelled:true});
 });t.after(()=>speech.close());const {id}=await speech.start(true),packet={id,sequence:0,pcm:samples()};
 for(const detected of [undefined,null,0,1,'true',[],{}]){
  reply={text:'',...(detected===undefined?{}:{detected})};
  await assert.rejects(speech.chunk(packet),{status:502,message:'Invalid wake detection'});
 }
 reply={text:'',detected:false};const first=await speech.chunk(packet);assert.equal(first.detected,false);
 assert.deepEqual(await speech.chunk(packet),first);assert.equal(chunks,8);
 reply={text:'',detected:true};assert.equal((await speech.chunk({...packet,sequence:1})).detected,true);
 await speech.cancel(id);
 const asr=await speech.start();reply={text:'ordinary ASR',detected:'not a boolean'};
 assert.equal((await speech.chunk({...packet,id:asr.id})).detected,undefined);
});
test('wake: loopback endpoint admission precedes all worker requests even with cloud consent',async t=>{
 wakeEndpoint(t);let calls=0;
 const speech=new SpeechStream({settings:{...store.settings,allowCloud:true}},async()=>{calls++;throw Error('unexpected worker request');});
 for(const url of ['https://example.invalid','http://192.168.1.2:8769','http://127.0.0.1:8769?secret=synthetic','http://user:synthetic@127.0.0.1:8769','file:///tmp/wake']){
  process.env.TEPORA_WAKE_URL=url;await assert.rejects(speech.start(true));
 }
 assert.equal(calls,0);assert.equal(speech.sessions.size,0);
});
test('wake: disabled microphone rejects before contacting the wake worker',async t=>{
 wakeEndpoint(t);const speech=new SpeechStream({settings:{...store.settings,voiceEnabled:false}},()=>{throw Error('unexpected worker request');});
 await assert.rejects(speech.start(true),{status:403});
});
for(const route of ['start','chunk','finish'])test(`wake: close invalidates pending ${route} before a late detection can escape`,async t=>{
 wakeEndpoint(t);let release,entered;
 const waiting=new Promise(resolve=>{entered=resolve;});
 const speech=new SpeechStream(store,async(url,options)=>{
  if(url.endsWith('/api/'+route))return new Promise(resolve=>{release=()=>resolve(Response.json(route==='start'?{session_id:'late'}:{text:'late wake',detected:true}));entered();});
  return Response.json(url.endsWith('/api/start')?{session_id:'worker'}:{cancelled:true});
 });t.after(()=>speech.close());
 const session=route==='start'?null:await speech.start(true);
 const pending=route==='start'?speech.start(true):route==='chunk'?speech.chunk({id:session.id,sequence:0,pcm:samples()}):speech.finish(session.id);
 const rejected=assert.rejects(pending,{status:499});await waiting;
 const closed=speech.close();release();await closed;await rejected;assert.equal(speech.sessions.size,0);
});
test('wake: cancelling a worker response body reports cancellation before detection escapes',async t=>{
 wakeEndpoint(t);let entered;const waiting=new Promise(resolve=>{entered=resolve;});
 const speech=new SpeechStream(store,async(url,options)=>{
  if(url.endsWith('/api/chunk'))return {ok:true,json:()=>new Promise((resolve,reject)=>{
   options.signal.addEventListener('abort',()=>reject(new DOMException('The operation was aborted','AbortError')),{once:true});entered();
  })};
  return Response.json(url.endsWith('/api/start')?{session_id:'worker'}:{cancelled:true});
 });t.after(()=>speech.close());const {id}=await speech.start(true);
 const pending=speech.chunk({id,sequence:0,pcm:samples()}),rejected=assert.rejects(pending,{status:499});
 await waiting;await speech.cancel(id);await rejected;assert.equal(speech.sessions.size,0);
});
test('barge: interleaved microphone and reference share the slot and budget by frame',async t=>{
 wakeEndpoint(t);const calls=[];
 const speech=new SpeechStream(store,async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  return Response.json(url.endsWith('/api/start')?{session_id:'barge-worker'}:url.endsWith('/api/chunk')?{text:'',detected:false}:{cancelled:true});
 });t.after(()=>speech.close());
 const {id}=await speech.start(true,2);
 assert.deepEqual(calls[0],{url:'http://127.0.0.1:8769/api/start',body:{sample_rate:16000,channels:2}});
 await assert.rejects(speech.start(),{status:409});await assert.rejects(speech.start(true),{status:409});
 await assert.rejects(speech.chunk({id,sequence:0,pcm:Buffer.alloc(3*4).toString('base64')}),{status:400,message:'Incomplete audio channel pair'});
 assert.equal(calls.length,1);
 const pcm=Buffer.alloc(16000*4).toString('base64');
 for(let sequence=0;sequence<240;sequence++)assert.equal((await speech.chunk({id,sequence,pcm})).detected,false);
 await assert.rejects(speech.chunk({id,sequence:240,pcm:Buffer.alloc(2*4).toString('base64')}),{status:413});
 assert.equal(calls.length,241);
 await speech.cancel(id);assert.equal(calls.at(-1).url,'http://127.0.0.1:8769/api/cancel');
 assert.equal(speech.sessions.size,0);
});

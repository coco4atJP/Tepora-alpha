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

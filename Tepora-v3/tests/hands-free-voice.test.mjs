import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {HandsFreeMicrophone,HandsFreeVoice} from '../web/hands-free-voice.mjs';

// Synthetic PCM, in-memory transport and a virtual clock: no microphone, model,
// network, provider credential, cloud service or wall-clock timeout is used.
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle(){for(let i=0;i<35;i++)await Promise.resolve();}
async function until(check){for(let i=0;i<100;i++){if(check())return;await Promise.resolve();}assert.ok(check(),'async checkpoint was not reached');}
const frame=(value=0,length=3200)=>new Float32Array(length).fill(value);
function fixture(options={}){
 const calls=[],plans=new Map(),audios=[],states=[],partials=[],utterances=[],errors=[],timers=new Map();let time=0,timerId=0,remoteId=0,inFlight=0,maxInFlight=0,stops=0;
 const bridge={request(path,method,body,headers,requestOptions){
  const call={route:path.replace('/api/voice/',''),method,body,options:requestOptions};calls.push(call);inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
  const planned=plans.get(call.route)?.shift();let result;
  try{result=planned?typeof planned==='function'?planned(call):planned.promise??planned:call.route.endsWith('start')?{id:`remote-${++remoteId}`} :call.route==='chunk'?{detected:false,text:`partial-${body.sequence}`} :call.route==='finish'?{text:'こんにちは'}:{};}catch(error){result=Promise.reject(error);}
  return Promise.resolve(result).finally(()=>inFlight--);
 }};
 const voice=new HandsFreeVoice({bridge,audioFactory(){const audio={closed:0,starts:0,async start(onFrame,onError){this.starts++;this.emit=onFrame;this.fail=onError;},close(){this.closed++;}};audios.push(audio);return audio;},
  now:()=>time,setTimer(fn,ms){const id=++timerId;timers.set(id,{at:time+ms,fn});return id;},clearTimer:id=>timers.delete(id),onState:state=>states.push(state),onPartial:text=>partials.push(text),onUtterance:async(text,signal)=>utterances.push({text,signal}),onError:error=>errors.push(error),stopOutput:()=>stops++,...options});
 const f={voice,calls,plans,audios,states,partials,utterances,errors,timers,
  plan(route,value){const queue=plans.get(route)||[];queue.push(value);plans.set(route,queue);},for:route=>calls.filter(c=>c.route===route),
  async emit(pcm=frame()){audios.at(-1).emit(pcm);await settle();},
  async wake(){f.plan('chunk',{detected:true});await f.emit(frame(.03));assert.equal(voice.state,'listening');},
  async tick(ms){const target=time+ms;while(true){const entry=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;time=Math.max(time,entry[1].at);timers.delete(entry[0]);entry[1].fn();await settle();}time=target;await settle();},
  jump(ms){time+=ms;},get maxInFlight(){return maxInFlight;},get stops(){return stops;}};
 return f;
}
async function enabled(t,options){const f=fixture(options);t.after(()=>f.voice.disable());await f.voice.enable();return f;}

test('hands-free is opt-in and starts the local wake worker before acquiring audio',async t=>{
 const f=fixture(),opening=deferred();f.plan('wake/start',opening);t.after(()=>f.voice.disable());
 assert.equal(f.voice.active,false);assert.equal(f.calls.length,0);assert.equal(f.audios.length,0);
 const start=f.voice.enable();await until(()=>f.for('wake/start').length===1);assert.equal(f.audios.length,0);assert.equal(f.voice.state,'starting');
 await f.voice.enable();assert.equal(f.for('wake/start').length,1);
 opening.resolve({id:'wake-only'});await start;assert.equal(f.voice.state,'idle');assert.equal(f.audios.length,1);assert.equal(f.for('start').length,0);
 await f.voice.disable();assert.equal(f.audios[0].closed,1);assert.deepEqual(f.for('cancel').map(c=>c.body.id),['wake-only']);assert.equal(f.timers.size,0);
});

test('wake PCM preserves Float32 view bytes and uses contiguous sequence numbers',async t=>{
 const f=await enabled(t),storage=Float32Array.from([.8,.1,-.2,.3,.9]),pcm=storage.subarray(1,4);
 await f.emit(pcm);await f.emit(pcm);
 const chunks=f.for('chunk');assert.deepEqual(chunks.map(c=>c.body.sequence),[0,1]);assert.ok(chunks.every(c=>c.body.id==='remote-1'));
 assert.deepEqual(Buffer.from(chunks[0].body.pcm,'base64'),Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength));assert.equal(f.for('start').length,0);assert.equal(f.maxInFlight,1);
});

test('wake detection closes wake inference before ASR and resets ASR sequence',async t=>{
 const f=await enabled(t);await f.emit();await f.wake();
 assert.deepEqual(f.calls.map(c=>c.route),['wake/start','chunk','chunk','cancel','start']);assert.equal(f.for('cancel')[0].body.id,'remote-1');
 await f.emit(frame(.03));assert.equal(f.for('chunk').at(-1).body.id,'remote-2');assert.equal(f.for('chunk').at(-1).body.sequence,0);assert.deepEqual(f.partials,['partial-0']);assert.equal(f.voice.stats.wakes,1);
});

test('a rejected latched wake rearms a fresh detector without opening ASR',async t=>{
 let wakes=0;const f=await enabled(t,{onWake:()=>{wakes++;return false;}});f.plan('chunk',{detected:true});await f.emit();
 assert.equal(wakes,1);assert.equal(f.voice.state,'idle');assert.equal(f.for('start').length,0);assert.equal(f.for('cancel').length,1);assert.equal(f.for('wake/start').length,2);assert.equal(f.voice.stats.wakes,0);
 await f.emit();assert.equal(wakes,1,'a fresh phrase is required after rejecting a detection');
});

test('chunks are serialized and bounded backpressure immediately releases the microphone',async t=>{
 const f=await enabled(t),pending=deferred();f.plan('chunk',pending);await f.emit();
 for(let i=0;i<10;i++)f.audios[0].emit(frame());await settle();assert.equal(f.for('chunk').length,1);assert.equal(f.voice.stats.maxQueued,10);assert.equal(f.voice.active,true);
 f.audios[0].emit(frame());assert.equal(f.voice.state,'error');assert.equal(f.voice.active,false);assert.equal(f.audios[0].closed,1);assert.equal(f.errors.length,1);assert.equal(f.voice.stats.overflows,1);
 assert.equal(f.for('chunk')[0].options.signal.aborted,true);pending.resolve({detected:true});await settle();assert.equal(f.for('start').length,0);assert.equal(f.timers.size,0);
});

test('queued chunks drain serially when inference catches up',async t=>{
 const f=await enabled(t),pending=deferred();f.plan('chunk',pending);await f.emit();for(let i=0;i<4;i++)f.audios[0].emit(frame());await settle();
 assert.equal(f.for('chunk').length,1);pending.resolve({detected:false});await settle();assert.equal(f.for('chunk').length,5);assert.deepEqual(f.for('chunk').map(c=>c.body.sequence),[0,1,2,3,4]);assert.equal(f.maxInFlight,1);
});

for(const [label,pcm] of [['plain array',[0]],['empty',new Float32Array()],['oversized',frame(0,4001)],['NaN',Float32Array.of(NaN)],['infinite',Float32Array.of(Infinity)],['out of range',Float32Array.of(1.1)]])test(`invalid ${label} PCM fails closed`,async t=>{
 const f=await enabled(t);await f.emit(pcm);assert.equal(f.voice.state,'error');assert.equal(f.voice.active,false);assert.equal(f.audios[0].closed,1);assert.equal(f.for('chunk').length,0);assert.equal(f.errors.length,1);
});

test('300ms voiced audio and 800ms trailing silence endpoint exactly once then rearm',async t=>{
 const f=await enabled(t);await f.wake();await f.emit(frame(.03));await f.emit(frame(.03,1600));
 for(let i=0;i<3;i++)await f.emit();assert.equal(f.for('finish').length,0);await f.emit();
 assert.equal(f.for('finish').length,1);assert.equal(f.utterances.length,1);assert.equal(f.utterances[0].text,'こんにちは');assert.equal(f.utterances[0].signal.aborted,false);assert.equal(f.voice.state,'idle');assert.equal(f.for('wake/start').length,2);assert.equal(f.voice.stats.utterances,1);
});

test('below-threshold audio is abandoned after six seconds without transcription submission',async t=>{
 const f=await enabled(t);await f.wake();for(let i=0;i<29;i++)await f.emit(frame(.011));assert.equal(f.voice.state,'listening');await f.emit(frame(.011));
 assert.equal(f.voice.state,'idle');assert.equal(f.for('finish').length,0);assert.equal(f.utterances.length,0);assert.equal(f.for('cancel').at(-1).body.id,'remote-2');assert.equal(f.for('wake/start').length,2);
});

test('a new voiced frame resets the silence endpoint counter',async t=>{
 const f=await enabled(t);await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<3;i++)await f.emit();await f.emit(frame(.03));
 for(let i=0;i<3;i++)await f.emit();assert.equal(f.for('finish').length,0);await f.emit();assert.equal(f.for('finish').length,1);
});

test('continuous speech reaches the twenty-second hard endpoint',async t=>{
 const f=await enabled(t);await f.wake();for(let i=0;i<99;i++)await f.emit(frame(.03));assert.equal(f.for('finish').length,0);await f.emit(frame(.03));assert.equal(f.for('finish').length,1);assert.equal(f.voice.state,'idle');
});

test('final processing is awaited and PCM during processing is not queued',async t=>{
 const processing=deferred(),received=[];const f=await enabled(t,{onUtterance:(text,signal)=>{received.push({text,signal});return processing.promise;}});await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<4;i++)await f.emit();
 assert.equal(f.voice.state,'processing');assert.equal(received.length,1);const chunks=f.for('chunk').length;for(let i=0;i<20;i++)await f.emit(frame(.03));assert.equal(f.for('chunk').length,chunks);assert.equal(f.for('wake/start').length,1);
 processing.resolve();await settle();assert.equal(f.voice.state,'idle');assert.equal(f.for('wake/start').length,2);
});

for(const text of ['', '   '])test(`empty final ${JSON.stringify(text)} rearms without submitting a turn`,async t=>{
 const f=await enabled(t);f.plan('finish',{text});await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<4;i++)await f.emit();assert.equal(f.utterances.length,0);assert.equal(f.voice.state,'idle');
});

for(const bad of [{detected:'true'},{}])test('invalid local wake result fails closed',async t=>{
 const f=await enabled(t);f.plan('chunk',bad);await f.emit();assert.equal(f.voice.state,'error');assert.equal(f.audios[0].closed,1);assert.equal(f.errors.length,1);assert.equal(f.for('start').length,0);
});

for(const result of [{text:42},{text:'x'.repeat(32001)}])test('invalid final transcript fails closed without publishing text',async t=>{
 const f=await enabled(t);f.plan('finish',result);await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<4;i++)await f.emit();assert.equal(f.voice.state,'error');assert.equal(f.utterances.length,0);assert.equal(f.errors.length,1);assert.equal(f.audios[0].closed,1);
});

test('worker failure releases local audio and reports the original error',async t=>{
 const f=await enabled(t),error=Error('synthetic worker disconnected');f.plan('chunk',()=>Promise.reject(error));await f.emit();assert.equal(f.voice.state,'error');assert.equal(f.errors[0],error);assert.equal(f.audios[0].closed,1);assert.equal(f.timers.size,0);
});

test('device failure and explicit interruption release microphone and disable rearming',async t=>{
 const f=await enabled(t);f.audios[0].fail(Error('device removed'));await settle();assert.equal(f.voice.state,'error');assert.equal(f.audios[0].closed,1);
 await f.voice.enable();await f.voice.interrupt();assert.equal(f.voice.state,'interrupted');assert.equal(f.audios[1].closed,1);await f.tick(120000);assert.equal(f.for('wake/start').length,2);assert.equal(f.timers.size,0);
});

test('output gates PCM and rearms only after the full 800ms acoustic cooldown',async t=>{
 const f=await enabled(t);f.voice.setSpeaking(true);assert.equal(f.voice.state,'speaking');for(let i=0;i<20;i++)await f.emit();assert.equal(f.for('chunk').length,0);
 f.voice.setSpeaking(false);assert.equal(f.voice.state,'cooldown');await f.emit(frame(.03));await f.tick(799);assert.equal(f.for('wake/start').length,1);await f.tick(1);assert.equal(f.voice.state,'idle');assert.equal(f.for('wake/start').length,2);assert.equal(f.for('cancel')[0].body.id,'remote-1');
});

test('output starting during an in-flight wake chunk discards its detection',async t=>{
 const f=await enabled(t),pending=deferred();f.plan('chunk',pending);await f.emit();f.voice.setSpeaking(true);pending.resolve({detected:true});await settle();assert.equal(f.voice.state,'speaking');assert.equal(f.for('start').length,0);assert.equal(f.voice.stats.wakes,0);
 f.voice.setSpeaking(false);await f.tick(800);assert.equal(f.voice.state,'idle');
});

for(const stopDuringOpen of [false,true])test(`ASR opening preserves ${stopDuringOpen?'cooldown':'speaking'} when output interrupts wake transition`,async t=>{
 const f=await enabled(t),pending=deferred();f.plan('start',pending);f.plan('chunk',{detected:true});await f.emit(frame(.03));assert.equal(f.voice.state,'waking');
 f.voice.setSpeaking(true);if(stopDuringOpen)f.voice.setSpeaking(false);pending.resolve({id:'late-asr'});await settle();assert.equal(f.voice.state,stopDuringOpen?'cooldown':'speaking');
 const chunks=f.for('chunk').length;await f.emit(frame(.03));assert.equal(f.for('chunk').length,chunks);
 if(!stopDuringOpen)f.voice.setSpeaking(false);await f.tick(799);assert.equal(f.for('wake/start').length,1);await f.tick(1);assert.equal(f.voice.state,'idle');assert.equal(f.for('wake/start').length,2);
});

for(const stopped of [false,true])test(`microphone startup preserves ${stopped?'cooldown':'speaking'} when output interrupts permission`,async t=>{
 const pending=deferred(),audio={closed:0,start(){return pending.promise;},close(){this.closed++;}},f=fixture({audioFactory:()=>audio});t.after(()=>f.voice.disable());const started=f.voice.enable();await until(()=>f.voice.session?.audio===audio);f.voice.setSpeaking(true);if(stopped)f.voice.setSpeaking(false);pending.resolve();await started;assert.equal(f.voice.state,stopped?'cooldown':'speaking');if(!stopped)f.voice.setSpeaking(false);await f.tick(800);assert.equal(f.voice.state,'idle');
});

for(const stopDuringOpen of [false,true])test(`wake rearming preserves ${stopDuringOpen?'cooldown':'speaking'} when output interrupts its worker start`,async t=>{
 const f=await enabled(t),pending=deferred();f.voice.setSpeaking(true);f.voice.setSpeaking(false);f.plan('wake/start',pending);await f.tick(800);assert.equal(f.voice.state,'starting');
 f.voice.setSpeaking(true);if(stopDuringOpen)f.voice.setSpeaking(false);pending.resolve({id:'late-rearm'});await settle();assert.equal(f.voice.state,stopDuringOpen?'cooldown':'speaking');
 const chunks=f.for('chunk').length;await f.emit(frame(.03));assert.equal(f.for('chunk').length,chunks);
 if(!stopDuringOpen)f.voice.setSpeaking(false);await f.tick(800);assert.equal(f.voice.state,'idle');
});

test('a wake callback can disable the controller without starting ASR',async t=>{
 let f;f=await enabled(t,{onWake:()=>{void f.voice.disable();return true;}});f.plan('chunk',{detected:true});await f.emit();assert.equal(f.voice.state,'off');assert.equal(f.for('start').length,0);assert.equal(f.voice.stats.wakes,0);assert.equal(f.audios[0].closed,1);
});

test('a partial callback can disable the controller at an endpoint without finishing stale audio',async t=>{
 let f,disable=false;f=await enabled(t,{onPartial:()=>{if(disable)void f.voice.disable();}});await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<3;i++)await f.emit();disable=true;await f.emit();assert.equal(f.voice.state,'off');assert.equal(f.for('finish').length,0);assert.equal(f.utterances.length,0);assert.equal(f.timers.size,0);
});

test('a late ASR chunk cannot publish or endpoint during output cooldown',async t=>{
 const f=await enabled(t),pending=deferred();await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<3;i++)await f.emit();f.plan('chunk',pending);await f.emit();const partialCount=f.partials.length;
 f.voice.setSpeaking(true);f.voice.setSpeaking(false);pending.resolve({text:'stale partial'});await settle();assert.equal(f.voice.state,'cooldown');assert.equal(f.partials.length,partialCount);assert.equal(f.for('finish').length,0);assert.equal(f.utterances.length,0);await f.tick(800);assert.equal(f.voice.state,'idle');
});

test('late final response after disable cannot publish into a replacement',async t=>{
 const f=await enabled(t),pending=deferred();f.plan('finish',pending);await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<4;i++)await f.emit();assert.equal(f.voice.state,'endpointing');
 await f.voice.disable();await f.voice.enable();const current=f.voice.session;pending.resolve({text:'stale final'});await settle();assert.equal(f.voice.session,current);assert.equal(f.voice.state,'idle');assert.equal(f.utterances.length,0);assert.equal(f.audios[1].closed,0);assert.equal(f.errors.length,0);
});

for(const stopped of [false,true])test(`late final response cannot publish after output ${stopped?'enters cooldown':'starts'}`,async t=>{
 const f=await enabled(t),pending=deferred();f.plan('finish',pending);await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<4;i++)await f.emit();assert.equal(f.voice.state,'endpointing');f.voice.setSpeaking(true);if(stopped)f.voice.setSpeaking(false);pending.resolve({text:'interrupted final'});await settle();assert.equal(f.utterances.length,0);assert.equal(f.voice.state,stopped?'cooldown':'speaking');if(!stopped)f.voice.setSpeaking(false);await f.tick(800);assert.equal(f.voice.state,'idle');
});

test('failed turn processing releases microphone instead of silently rearming',async t=>{
 const error=Error('synthetic turn rejection'),f=await enabled(t,{onUtterance:async()=>{throw error;}});await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<4;i++)await f.emit();assert.equal(f.voice.state,'error');assert.equal(f.errors[0],error);assert.equal(f.audios[0].closed,1);assert.equal(f.for('wake/start').length,1);
});

test('an idle false output notification cannot create a new cooldown or worker',async t=>{
 const f=await enabled(t);f.voice.setSpeaking(false);await f.tick(800);assert.equal(f.voice.state,'idle');assert.equal(f.for('wake/start').length,1);assert.equal(f.for('cancel').length,0);
});

test('watchdog releases a missing microphone stream after five seconds',async t=>{
 const f=await enabled(t);await f.tick(5000);assert.equal(f.voice.active,true);await f.tick(1000);assert.equal(f.voice.state,'suspended');assert.equal(f.voice.active,false);assert.equal(f.audios[0].closed,1);assert.equal(f.timers.size,0);
});

test('a suspended event loop fails closed even if a fresh frame just arrived',async t=>{
 const f=await enabled(t);f.jump(11000);await f.emit();await f.tick(0);assert.equal(f.voice.state,'suspended');assert.equal(f.audios[0].closed,1);
});

test('idle wake session renews at 110 seconds while live audio continues',async t=>{
 const f=await enabled(t);for(let i=0;i<109;i++){await f.emit();await f.tick(1000);}assert.equal(f.for('wake/start').length,1);await f.emit();await f.tick(1000);assert.equal(f.for('wake/start').length,2);assert.equal(f.for('cancel')[0].body.id,'remote-1');assert.equal(f.voice.state,'idle');assert.equal(f.maxInFlight,1);
});

test('utterance watchdog mutes a stalled worker even while frames remain live',async t=>{
 const f=await enabled(t),pending=deferred();await f.wake();f.plan('chunk',pending);await f.emit(frame(.03));
 // Frames that arrive while output is gated keep the device heartbeat alive
 // without growing the inference queue; the outstanding utterance stays bounded.
 f.voice.setSpeaking(true);for(let i=0;i<22;i++){await f.emit();await f.tick(1000);}assert.equal(f.voice.state,'error');assert.equal(f.audios[0].closed,1);assert.equal(f.errors.length,1);pending.resolve({text:'late'});await settle();assert.equal(f.voice.active,false);
});

test('worker startup failure never requests microphone permission',async t=>{
 const f=fixture(),error=Error('synthetic wake unavailable');t.after(()=>f.voice.disable());f.plan('wake/start',()=>Promise.reject(error));await f.voice.enable();assert.equal(f.voice.state,'error');assert.equal(f.audios.length,0);assert.equal(f.errors[0],error);assert.equal(f.timers.size,0);
});

test('default browser timers preserve the Window receiver',async t=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,timers=new Map();let id=0;
 globalThis.setTimeout=function(fn,ms){assert.equal(this,globalThis,'Window.setTimeout requires its Window receiver');const key=++id;timers.set(key,{fn,ms});return key;};
 globalThis.clearTimeout=function(key){assert.equal(this,globalThis,'Window.clearTimeout requires its Window receiver');timers.delete(key);};
 t.after(()=>{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;});
 const audio={closed:0,async start(){},close(){this.closed++;}},errors=[],voice=new HandsFreeVoice({bridge:{async request(route){return route.endsWith('start')?{id:'synthetic-wake'}:{};}},audioFactory:()=>audio,onError:error=>errors.push(error)});await voice.enable();assert.equal(voice.state,'idle');assert.equal(errors.length,0);assert.equal(timers.size,2);await voice.disable();assert.equal(timers.size,0);assert.equal(audio.closed,1);
});

test('microphone startup failure cancels the already acquired wake worker',async t=>{
 const error=Error('synthetic permission denied');const audio={closed:0,async start(){throw error;},close(){this.closed++;}};const f=fixture({audioFactory:()=>audio});t.after(()=>f.voice.disable());await f.voice.enable();await settle();assert.equal(f.voice.state,'error');assert.equal(audio.closed,1);assert.equal(f.errors[0],error);assert.deepEqual(f.for('cancel').map(c=>c.body.id),['remote-1']);
});

test('late wake start owns and cancels its remote ID without opening a microphone',async t=>{
 const f=fixture(),pending=deferred();t.after(()=>f.voice.disable());f.plan('wake/start',pending);const start=f.voice.enable();await until(()=>f.for('wake/start').length===1);await f.voice.disable();await f.voice.enable();const replacement=f.voice.session;
 pending.resolve({id:'late-wake'});await start;assert.equal(f.voice.session,replacement);assert.equal(f.voice.state,'idle');assert.equal(f.audios.length,1);assert.deepEqual(f.for('cancel').map(c=>c.body.id),['late-wake']);assert.equal(f.audios[0].closed,0);
});

test('stale chunk, audio, error and timer callbacks cannot modify a replacement',async t=>{
 const f=await enabled(t),pending=deferred();f.plan('chunk',pending);await f.emit();const oldAudio=f.audios[0],oldTimers=[...f.timers.values()].map(v=>v.fn);await f.voice.disable();await f.voice.enable();const current=f.voice.session;
 oldAudio.emit(frame(.03));oldAudio.fail(Error('stale device'));for(const fn of oldTimers)fn();pending.resolve({detected:true});await settle();assert.equal(f.voice.session,current);assert.equal(f.voice.state,'idle');assert.equal(f.audios[1].closed,0);assert.equal(f.errors.length,0);assert.equal(f.for('start').length,0);
});

test('disable during final processing aborts the turn and cannot rearm a replacement',async t=>{
 const processing=deferred(),received=[];const f=await enabled(t,{onUtterance:(text,signal)=>{received.push({text,signal});return processing.promise;}});await f.wake();await f.emit(frame(.03));await f.emit(frame(.03));for(let i=0;i<4;i++)await f.emit();
 assert.equal(f.voice.state,'processing');await f.voice.disable();assert.equal(received[0].signal.aborted,true);await f.voice.enable();const current=f.voice.session;processing.resolve();await settle();assert.equal(f.voice.session,current);assert.equal(f.voice.state,'idle');assert.equal(f.for('wake/start').length,2);
});

function mediaFixture(t){
 const env={streams:[],contexts:[],nodes:[],permissions:[],modules:[],resumes:[]};
 function replace(key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);}
 function stream(){const listeners=new Map(),track={stops:0,stop(){this.stops++;},addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type,fn){if(listeners.get(type)===fn)listeners.delete(type);},emit:type=>listeners.get(type)?.(),listeners};const result={track,getTracks:()=>[track],getAudioTracks:()=>[track]};env.streams.push(result);return result;}
 const node=()=>({disconnects:0,connect(){},disconnect(){this.disconnects++;}});
 replace('navigator',{mediaDevices:{getUserMedia(){const pending=env.permissions.shift();return pending?pending.promise:Promise.resolve(stream());}}});
 replace('AudioContext',class{constructor(){this.state='running';this.destination={};this.graph=[];this.closes=0;this.audioWorklet={addModule:()=>env.modules.shift()?.promise||Promise.resolve()};env.contexts.push(this);}resume(){return env.resumes.shift()?.promise||Promise.resolve();}close(){this.closes++;this.state='closed';return Promise.resolve();}createMediaStreamSource(){const n=node();this.graph.push(n);return n;}createGain(){const n={...node(),gain:{value:1}};this.graph.push(n);return n;}});
 replace('AudioWorkletNode',class{constructor(context,name,options){Object.assign(this,node());this.context=context;this.name=name;this.options=options;this.messages=[];this.port={onmessage:null,postMessage:data=>this.messages.push(data)};env.nodes.push(this);}});env.stream=stream;
 env.released=index=>{const context=env.contexts[index];assert.equal(context.closes,1);for(const n of [...context.graph,...env.nodes.filter(n=>n.context===context)])assert.equal(n.disconnects,1);assert.equal(env.streams[index].track.stops,1);assert.equal(env.streams[index].track.listeners.size,0);};return env;
}

test('microphone releases a permission result that arrives after cancellation',async t=>{
 const env=mediaFixture(t),pending=deferred(),mic=new HandsFreeMicrophone();env.permissions.push(pending);const start=assert.rejects(mic.start(()=>{},()=>{}),{name:'AbortError'});mic.close();const late=env.stream();pending.resolve(late);await start;assert.equal(late.track.stops,1);assert.equal(env.contexts.length,0);
});

for(const phase of ['module','resume'])test(`microphone cancellation during ${phase} cannot resurrect its graph`,async t=>{
 const env=mediaFixture(t),pending=deferred(),mic=new HandsFreeMicrophone();env[phase==='module'?'modules':'resumes'].push(pending);const start=assert.rejects(mic.start(()=>{},()=>{}),{name:'AbortError'});await until(()=>phase==='module'?env.contexts.length===1:env.nodes.length===1);mic.close();pending.resolve();await start;env.released(0);assert.equal(mic.context,null);assert.equal(mic.stream,null);
});

test('microphone forwards PCM, reports device suspension, and closes idempotently',async t=>{
 const env=mediaFixture(t),mic=new HandsFreeMicrophone(),frames=[],errors=[];await mic.start(pcm=>frames.push(pcm),error=>errors.push(error));const node=env.nodes[0],oldCallback=node.port.onmessage,context=env.contexts[0],stream=env.streams[0],pcm=frame();assert.equal(context.graph[1].gain.value,0);
 oldCallback({data:{pcm}});assert.equal(frames[0],pcm);stream.track.emit('mute');stream.track.emit('ended');context.state='suspended';context.onstatechange();assert.equal(errors.length,3);
 mic.close();mic.close();oldCallback({data:{pcm}});assert.equal(frames.length,1);assert.equal(node.port.onmessage,null);assert.equal(context.onstatechange,null);env.released(0);
});

test('microphone worklet failure releases resources and preserves its error',async t=>{
 const env=mediaFixture(t),pending=deferred(),mic=new HandsFreeMicrophone(),error=Error('synthetic worklet failure');env.modules.push(pending);const start=assert.rejects(mic.start(()=>{},()=>{}),error);await until(()=>env.contexts.length===1);pending.reject(error);await start;env.released(0);
});

test('hands-free microphone opts into bounded worklet delivery and ACKs before the frame callback',async t=>{
 const env=mediaFixture(t),mic=new HandsFreeMicrophone(),delivered=[];await mic.start(pcm=>{assert.equal(env.nodes[0].messages.at(-1)?.ack,true);delivered.push(pcm);},error=>assert.fail(error));t.after(()=>mic.close());const node=env.nodes[0];assert.deepEqual(node.options,{processorOptions:{bounded:true}});assert.equal(node.name,'tepora-stream-pcm');
 const pcm=frame(.03);node.port.onmessage({data:{pcm}});assert.equal(delivered[0],pcm);assert.deepEqual(node.messages,[{ack:true}]);node.port.onmessage({data:{flushed:true}});assert.equal(node.messages.length,1);
});

test('worklet overflow closes the microphone before reporting once and rejects late PCM',async t=>{
 const env=mediaFixture(t),mic=new HandsFreeMicrophone(),frames=[],errors=[];await mic.start(pcm=>frames.push(pcm),error=>{assert.equal(mic.closed,true);errors.push(error);});const node=env.nodes[0],oldMessage=node.port.onmessage;
 oldMessage({data:{overflow:true}});assert.equal(errors.length,1);assert.match(errors[0].message,/ミュート/);assert.equal(frames.length,0);assert.equal(node.messages.length,0);env.released(0);oldMessage({data:{pcm:frame(.03)}});oldMessage({data:{overflow:true}});assert.equal(errors.length,1);assert.equal(frames.length,0);assert.equal(node.messages.length,0);
});

test('worklet overflow propagates to controller cancellation and remote cleanup',async t=>{
 const env=mediaFixture(t),f=fixture({audioFactory:()=>new HandsFreeMicrophone()});t.after(()=>f.voice.disable());await f.voice.enable();env.nodes[0].port.onmessage({data:{overflow:true}});await settle();assert.equal(f.voice.active,false);assert.equal(f.voice.state,'error');assert.equal(f.errors.length,1);assert.equal(f.for('chunk').length,0);assert.deepEqual(f.for('cancel').map(c=>c.body.id),['remote-1']);assert.equal(f.timers.size,0);env.released(0);
});

const workletSource=await readFile(new URL('../web/pcm-worklet.js',import.meta.url),'utf8');
function worklet(rate,options){let Processor;const messages=[];vm.runInNewContext(workletSource,{sampleRate:rate,Float32Array,AudioWorkletProcessor:class{constructor(){this.port={onmessage:null,postMessage:data=>messages.push(data)};}},registerProcessor(name,type){assert.equal(name,'tepora-stream-pcm');Processor=type;}});return {processor:new Processor(options),messages};}
for(const rate of [16000,44100,48000,96000])test(`PCM worklet conserves one second at ${rate}Hz across arbitrary render blocks`,()=>{
 const {processor,messages}=worklet(rate);let supplied=0;
 while(supplied<rate){const length=Math.min(128,rate-supplied);assert.equal(processor.process([[frame(.25,length)]]),true);supplied+=length;}
 assert.equal(messages.length,5);for(const message of messages){assert.equal(message.pcm.length,3200);assert.ok(message.pcm.every(value=>Math.abs(value-.25)<1e-6));}
 processor.port.onmessage({data:{flush:true}});assert.equal(messages.length,6);assert.equal(messages.at(-1).flushed,true);
});

test('PCM worklet averages native samples, clamps output, and flushes a short tail once',()=>{
 const {processor,messages}=worklet(48000);const input=Float32Array.from([0,.3,.6,2,2,2,-2,-2,-2]);processor.process([[input]]);assert.equal(messages.length,0);processor.port.onmessage({data:{flush:true}});
 assert.equal(messages.length,2);assert.equal(messages[0].pcm.length,3);assert.ok(Math.abs(messages[0].pcm[0]-.3)<1e-6);assert.equal(messages[0].pcm[1],1);assert.equal(messages[0].pcm[2],-1);
 processor.port.onmessage({data:{flush:true}});assert.equal(messages.length,3);assert.equal(messages.filter(m=>m.pcm).length,1);assert.equal(processor.process([]),true);
});

test('44.1kHz worklet preserves a varying signal integral across irregular block boundaries',()=>{
 const {processor,messages}=worklet(44100);let inputSum=0,supplied=0;
 while(supplied<44100){const length=Math.min([17,128,53,256][supplied%4],44100-supplied),input=new Float32Array(length);for(let i=0;i<length;i++){input[i]=Math.sin((supplied+i)*.07)*.5;inputSum+=input[i];}processor.process([[input]]);supplied+=length;}
 const output=messages.flatMap(m=>Array.from(m.pcm));assert.equal(output.length,16000);const outputSum=output.reduce((sum,value)=>sum+value,0);assert.ok(Math.abs(outputSum-inputSum/(44100/16000))<1e-4,'resampling must preserve weighted signal area');
});

for(const rate of [16000,44100,48000,96000])test(`bounded ${rate}Hz worklet stops at two queued PCM buffers and one overflow notification without ACKs`,()=>{
 const {processor,messages}=worklet(rate,{processorOptions:{bounded:true}});let stopped=false;
 // Simulate a full minute with the main thread completely stalled. The worklet
 // retains one fixed buffer and transfers at most two 200ms buffers (25.6 kB).
 for(let i=0;i<60*rate;i+=128)if(!processor.process([[frame(.25,128)]]))stopped=true;
 assert.equal(stopped,true);assert.equal(messages.length,3);assert.equal(messages.filter(m=>m.pcm).length,2);assert.equal(messages.filter(m=>m.overflow).length,1);assert.equal(messages.reduce((bytes,m)=>bytes+(m.pcm?.byteLength||0),0),25600);assert.equal(processor.frames,0);assert.equal(processor.buffer.byteLength,12800);
 for(let i=0;i<5;i++){processor.port.onmessage({data:{ack:true}});processor.port.onmessage({data:{flush:true}});assert.equal(processor.process([[frame(.03)]]),false);}assert.equal(messages.length,3,'overflow latches until the owning graph closes');
});

for(const rate of [16000,44100,48000,96000])test(`ACKs sustain healthy bounded delivery at ${rate}Hz without losing samples`,()=>{
 const {processor,messages}=worklet(rate,{processorOptions:{bounded:true}});let acknowledged=0,supplied=0;
 while(supplied<rate){const length=Math.min(128,rate-supplied);assert.equal(processor.process([[frame(.25,length)]]),true);supplied+=length;while(acknowledged<messages.length){assert.equal(messages[acknowledged].pcm.length,3200);assert.ok(messages[acknowledged].pcm.every(value=>Math.abs(value-.25)<1e-6));processor.port.onmessage({data:{ack:true}});acknowledged++;}}
 assert.equal(messages.length,5);assert.equal(messages.some(m=>m.overflow),false);assert.equal(processor.outstanding,0);
});

test('bounded worklet ACK returns one credit and duplicate idle ACKs do not raise its two-message limit',()=>{
 const {processor,messages}=worklet(16000,{processorOptions:{bounded:true}});for(let i=0;i<5;i++)processor.port.onmessage({data:{ack:true}});processor.process([[frame(.1)]]);processor.process([[frame(.2)]]);assert.equal(messages.length,2);processor.port.onmessage({data:{ack:true}});assert.equal(processor.process([[frame(.3)]]),true);assert.equal(messages.length,3);assert.equal(processor.process([[frame(.4)]]),false);assert.equal(messages.length,4);assert.equal(messages.at(-1).overflow,true);
});

test('bounded tail flush obeys credits and overflow is never reported as a successful flush',()=>{
 const {processor,messages}=worklet(16000,{processorOptions:{bounded:true}});processor.process([[frame(.1)]]);processor.process([[frame(.2)]]);processor.process([[frame(.3,128)]]);processor.port.onmessage({data:{flush:true}});assert.equal(messages.length,3);assert.equal(messages.at(-1).overflow,true);assert.equal(messages.some(m=>m.flushed),false);processor.port.onmessage({data:{flush:true}});assert.equal(messages.length,3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceCapture} from '../web/voice.mjs';
import {RealtimeVoiceCapture} from '../web/realtime-voice.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(predicate){for(let i=0;i<50;i++){if(predicate())return;await Promise.resolve();}assert.ok(predicate(),'expected async checkpoint');}
function fakeStream(){
 const listeners=new Set();
 const track={stops:0,stop(){this.stops++;},addEventListener(type,fn){if(type==='ended')listeners.add(fn);},removeEventListener(type,fn){if(type==='ended')listeners.delete(fn);},end(){for(const fn of listeners)fn();}};
 return {track,getTracks:()=>[track],getAudioTracks:()=>[track]};
}
function fakeAudio(t){
 const env={streams:[],contexts:[],nodes:[],gum:[],plans:[],gumCalls:0,timers:new Map(),urls:[],revoked:[]};let timerId=0;
 function replace(target,key,value){const old=Object.getOwnPropertyDescriptor(target,key);Object.defineProperty(target,key,{configurable:true,writable:true,value});t.after(()=>{if(old)Object.defineProperty(target,key,old);else delete target[key];});}
 function graphNode(){return {disconnects:0,connect(){},disconnect(){this.disconnects++;}};}
 replace(globalThis,'navigator',{mediaDevices:{getUserMedia(){env.gumCalls++;const pending=env.gum.shift();if(pending)return pending.promise;const stream=fakeStream();env.streams.push(stream);return Promise.resolve(stream);}}});
 replace(globalThis,'AudioContext',class{
  constructor(){this.plan=env.plans.shift()||{};this.state='running';this.sampleRate=1000;this.destination={};this.closes=0;this.resumes=0;this.modules=0;this.graph=[];this.audioWorklet={addModule:()=>{this.modules++;return this.plan.module?.promise||Promise.resolve();}};env.contexts.push(this);}
  resume(){this.resumes++;return this.plan.resume?.promise||Promise.resolve();}
  close(){this.closes++;return (this.plan.close?.promise||Promise.resolve()).then(()=>{this.state='closed';});}
  createMediaStreamSource(){const node=graphNode();this.graph.push(node);return node;}
  createGain(){const node={...graphNode(),gain:{value:1}};this.graph.push(node);return node;}
 });
 replace(globalThis,'AudioWorkletNode',class{
  constructor(context){assert.notEqual(context.state,'closed');Object.assign(this,graphNode());this.context=context;this.messages=[];this.port={onmessage:null,postMessage:data=>{this.messages.push(data);if(data.flush&&context.plan.autoFlush!==false){if(context.plan.tail)this.port.onmessage?.({data:{pcm:context.plan.tail}});this.port.onmessage?.({data:{flushed:true}});}}};env.nodes.push(this);}
 });
 replace(globalThis,'setTimeout',(fn,ms)=>{const id=++timerId;env.timers.set(id,{fn,ms});return id;});
 replace(globalThis,'clearTimeout',id=>env.timers.delete(id));
 replace(URL,'createObjectURL',()=>{const url=`blob:voice-${env.urls.length}`;env.urls.push(url);return url;});
 replace(URL,'revokeObjectURL',url=>env.revoked.push(url));
 env.emit=(node,data)=>node.port.onmessage?.({data});
 env.assertReleased=(index)=>{const context=env.contexts[index];assert.equal(context.closes,1);for(const node of context.graph)assert.equal(node.disconnects,1);for(const node of env.nodes.filter(n=>n.context===context))assert.equal(node.disconnects,1);};
 return env;
}
function fakeBridge(){
 const calls=[],responses=new Map();let nextId=0;
 return {calls,enqueue(path,response){const queue=responses.get(path)||[];queue.push(response);responses.set(path,queue);},request(path,method,body){calls.push({path,method,body});const response=responses.get(path)?.shift();if(response)return response.promise;if(path.endsWith('/start'))return Promise.resolve({id:`session-${++nextId}`});if(path.endsWith('/chunk'))return Promise.resolve({text:`partial-${body.sequence}`});if(path.endsWith('/finish'))return Promise.resolve({text:'finished'});return Promise.resolve({});},for(path){return calls.filter(call=>call.path===`/api/voice/${path}`);}};
}
const pcm=new Float32Array([.25,-.5,1]);

// Every test uses fake media, transport, timers and worklets. No microphone, server,
// provider, network connection or paid API is used.
test('PCM cancellation releases late permission results without touching a replacement',async t=>{
 const env=fakeAudio(t),voice=new VoiceCapture(),permission=deferred();env.gum.push(permission);
 const oldStart=assert.rejects(voice.start(),{name:'AbortError'});
 await assert.rejects(voice.start(),/録音中/);assert.equal(env.gumCalls,1);
 await voice.cancel();await voice.start();const current=voice.stream;
 const late=fakeStream();permission.resolve(late);await oldStart;
 assert.equal(late.track.stops,1);assert.equal(voice.stream,current);assert.equal(current.track.stops,0);assert.equal(env.contexts.length,1);
 await voice.cancel();env.assertReleased(0);assert.equal(env.timers.size,0);
});

for(const phase of ['resume','module'])test(`PCM cancellation during ${phase} cannot resurrect audio`,async t=>{
 const env=fakeAudio(t),voice=new VoiceCapture(),pending=deferred();env.plans.push({[phase]:pending});
 const oldStart=assert.rejects(voice.start(),{name:'AbortError'});
 await until(()=>env.contexts[0]?.[phase==='resume'?'resumes':'modules']===1);
 await voice.cancel();await voice.start();const current=voice.stream;
 pending.resolve();await oldStart;
 assert.equal(voice.stream,current);assert.equal(env.streams[0].track.stops,1);env.assertReleased(0);
 assert.equal(env.nodes.length,1);assert.equal(new Set(env.revoked).size,env.revoked.length);
 await voice.cancel();env.assertReleased(1);assert.equal(env.timers.size,0);
});

test('PCM stop owns its frames and closes once when cancelled during close',async t=>{
 const env=fakeAudio(t),voice=new VoiceCapture(),closing=deferred();env.plans.push({close:closing});let limits=0;
 await voice.start(()=>limits++);const oldNode=voice.node,oldMessage=oldNode.port.onmessage,oldTimer=[...env.timers.values()][0].fn;
 env.emit(oldNode,new Float32Array(250).fill(.5));
 const stopping=assert.rejects(voice.stop(),{name:'AbortError'}),cancelling=voice.cancel();
 await voice.start();const current=voice.stream;
 oldMessage({data:new Float32Array(500)});oldTimer();assert.equal(voice.frames.length,0);assert.equal(limits,0);
 closing.resolve();await Promise.all([stopping,cancelling]);
 assert.equal(voice.stream,current);assert.equal(env.streams[0].track.stops,1);env.assertReleased(0);
 await voice.cancel();env.assertReleased(1);
});

test('PCM stop keeps WAV format and subsequent recordings have fresh frames',async t=>{
 const env=fakeAudio(t),voice=new VoiceCapture();await voice.start();
 const samples=new Float32Array(250);samples.set([-2,2,.5]);env.emit(voice.node,samples);
 const [wav,again]=await Promise.all([voice.stop(),voice.stop()]);assert.equal(wav,again);assert.equal(wav.type,'audio/wav');
 const data=new DataView(await wav.arrayBuffer());assert.equal(data.byteLength,544);assert.equal(data.getUint32(24,true),1000);assert.equal(data.getUint32(40,true),500);assert.equal(data.getInt16(44,true),-32768);assert.equal(data.getInt16(46,true),32767);
 env.assertReleased(0);assert.equal(env.streams[0].track.stops,1);
 await voice.start();assert.equal(voice.frames.length,0);await assert.rejects(voice.stop(),/短すぎ/);env.assertReleased(1);assert.equal(env.timers.size,0);
});

test('PCM startup failure closes resources and preserves the original error',async t=>{
 const env=fakeAudio(t),voice=new VoiceCapture(),module=deferred();env.plans.push({module});
 const error=new Error('worklet failed'),started=assert.rejects(voice.start(),error);
 await until(()=>env.contexts[0]?.modules===1);module.reject(error);await started;
 env.assertReleased(0);assert.equal(env.streams[0].track.stops,1);assert.deepEqual(env.urls,env.revoked);
 await voice.start();await voice.cancel();env.assertReleased(1);
});

test('realtime late start response cancels only its own remote session',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),remote=deferred();bridge.enqueue('/api/voice/start',remote);
 const started=assert.rejects(voice.start(),{name:'AbortError'});
 await assert.rejects(voice.start(),/既に/);await voice.cancel();await voice.start();const currentId=voice.id,current=voice.stream;
 remote.resolve({id:'late-session'});await started;
 assert.equal(env.gumCalls,1);assert.deepEqual(bridge.for('cancel').map(c=>c.body.id),['late-session']);assert.equal(voice.id,currentId);assert.equal(voice.stream,current);assert.equal(voice.running,true);
 await voice.cancel();env.assertReleased(0);
});

for(const phase of ['permission','module','resume'])test(`realtime cancellation during ${phase} cannot affect a replacement`,async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),pending=deferred();
 if(phase==='permission')env.gum.push(pending);else env.plans.push({[phase]:pending});
 const started=assert.rejects(voice.start(),{name:'AbortError'});
 await until(()=>phase==='permission'?env.gumCalls===1:env.contexts[0]?.[phase==='resume'?'resumes':'modules']===1);
 await voice.cancel();await voice.start();const current=voice.stream,currentId=voice.id;
 const late=phase==='permission'?fakeStream():undefined;pending.resolve(late);await started;
 assert.equal(voice.stream,current);assert.equal(voice.id,currentId);assert.equal(voice.running,true);assert.deepEqual(bridge.for('cancel').map(c=>c.body.id),['session-1']);
 if(late)assert.equal(late.track.stops,1);else{env.assertReleased(0);assert.equal(env.streams[0].track.stops,1);}
 await voice.cancel();assert.equal(env.timers.size,0);
 for(let i=0;i<env.contexts.length;i++)env.assertReleased(i);
});

test('realtime late chunk and worklet callbacks cannot enter a new session',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),chunk=deferred(),oldPartials=[],newPartials=[];
 bridge.enqueue('/api/voice/chunk',chunk);await voice.start({onPartial:text=>oldPartials.push(text)});
 const oldMessage=voice.node.port.onmessage;env.emit(voice.node,{pcm});const oldPump=voice.pumping;
 await voice.cancel();await voice.start({onPartial:text=>newPartials.push(text)});const generation=voice.generation,current=voice.stream;
 oldMessage({data:{pcm}});env.emit(voice.node,{pcm});await voice.pumping;
 assert.equal(voice.generation,generation);assert.deepEqual(newPartials,['partial-0']);assert.equal(voice.sequence,1);
 chunk.resolve({text:'stale partial'});await oldPump;
 assert.deepEqual(oldPartials,[]);assert.deepEqual(newPartials,['partial-0']);assert.equal(voice.stream,current);assert.equal(voice.generation,generation);assert.equal(voice.sequence,1);
 env.emit(voice.node,{pcm});await voice.pumping;assert.deepEqual(newPartials,['partial-0','partial-1']);assert.equal(voice.generation,generation);
 assert.deepEqual(bridge.for('chunk').map(c=>[c.body.id,c.body.sequence]),[['session-1',0],['session-2',0],['session-2',1]]);
 await voice.cancel();env.assertReleased(0);env.assertReleased(1);
});

test('realtime cancelled finish cannot publish a final or clean a replacement',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),finish=deferred(),finals=[];bridge.enqueue('/api/voice/finish',finish);
 await voice.start({onFinal:text=>finals.push(text)});const stopping=voice.stop();await until(()=>bridge.for('finish').length===1);
 await voice.cancel();await voice.start({onFinal:text=>finals.push(`new:${text}`)});const current=voice.stream,currentId=voice.id;
 finish.resolve({text:'stale final'});await stopping;
 assert.deepEqual(finals,[]);assert.equal(voice.stream,current);assert.equal(voice.id,currentId);assert.equal(current.track.stops,0);env.assertReleased(0);
 await voice.stop();assert.deepEqual(finals,['new:finished']);env.assertReleased(1);assert.equal(env.timers.size,0);
});

test('realtime stop flushes the tail once, resets state, and has idempotent cleanup',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),finals=[];env.plans.push({tail:pcm});
 await voice.start({onFinal:text=>finals.push(text)});const generation=voice.generation,node=voice.node;
 await Promise.all([voice.stop(),voice.stop()]);assert.deepEqual(finals,['finished']);assert.equal(node.messages.length,1);assert.equal(bridge.for('chunk').length,1);assert.equal(bridge.for('finish').length,1);assert.equal(bridge.for('cancel').length,0);assert.equal(voice.generation,generation);assert.equal(voice.running,false);
 env.assertReleased(0);assert.equal(env.streams[0].track.stops,1);
 await voice.start();assert.equal(voice.sequence,0);assert.equal(voice.stopping,false);assert.equal(voice.failing,false);
 await voice.cancel();env.assertReleased(1);assert.equal(env.timers.size,0);
});

test('realtime cancellation releases an unacknowledged flush immediately',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge);env.plans.push({autoFlush:false});
 await voice.start();const stopping=voice.stop();assert.equal(env.timers.size,1);
 await voice.cancel();await stopping;assert.equal(bridge.for('finish').length,0);assert.equal(env.timers.size,0);env.assertReleased(0);
});

test('realtime cancellation during failure suppresses stale onError',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),closing=deferred(),errors=[];env.plans.push({close:closing});
 await voice.start({onError:error=>errors.push(error.message)});const failed=voice.fail(new Error('old error'));
 const cancelled=voice.cancel();await voice.start({onError:error=>errors.push(`new:${error.message}`)});const current=voice.stream;
 closing.resolve();await Promise.all([failed,cancelled]);
 assert.deepEqual(errors,[]);assert.equal(voice.stream,current);assert.equal(voice.running,true);env.assertReleased(0);
 await voice.fail(new Error('current error'));assert.deepEqual(errors,['new:current error']);env.assertReleased(1);assert.deepEqual(bridge.for('cancel').map(c=>c.body.id),['session-1','session-2']);
});

test('realtime chunk failure reports once, cleans resources, and allows restart',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),chunk=deferred(),errors=[];bridge.enqueue('/api/voice/chunk',chunk);
 await voice.start({onError:error=>errors.push(error.message)});env.emit(voice.node,{pcm});const pumping=voice.pumping;chunk.reject(new Error('local recognizer failed'));await pumping;
 assert.deepEqual(errors,['local recognizer failed']);assert.equal(voice.running,false);assert.equal(voice.id,null);env.assertReleased(0);assert.equal(bridge.for('cancel').length,1);
 await voice.start();await voice.cancel();env.assertReleased(1);assert.equal(env.timers.size,0);
});

test('realtime queue overflow cancels the session and ignores its pending partial',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),chunk=deferred(),errors=[],partials=[];bridge.enqueue('/api/voice/chunk',chunk);
 await voice.start({onError:error=>errors.push(error.message),onPartial:text=>partials.push(text)});const node=voice.node;env.emit(node,{pcm});const pumping=voice.pumping;
 for(let i=0;i<26;i++)env.emit(node,{pcm});await until(()=>errors.length===1);
 assert.equal(voice.running,false);assert.equal(voice.queue.length,0);assert.equal(bridge.for('cancel').length,1);env.assertReleased(0);
 chunk.resolve({text:'too late'});await pumping;assert.deepEqual(partials,[]);assert.equal(errors.length,1);assert.equal(env.timers.size,0);
});

test('realtime flush timeout finishes normally and stale capture timers do nothing',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),finals=[];env.plans.push({autoFlush:false});
 await voice.start({onFinal:text=>finals.push(text)});const oldTimer=[...env.timers.values()].find(timer=>timer.ms===118000).fn;
 const stopping=voice.stop();[...env.timers.values()].find(timer=>timer.ms===1000).fn();await stopping;
 assert.deepEqual(finals,['finished']);env.assertReleased(0);
 await voice.start();oldTimer();assert.equal(voice.stopping,false);assert.equal(bridge.for('finish').length,1);
 await voice.cancel();env.assertReleased(1);assert.equal(env.timers.size,0);
});

test('realtime finish and flush errors cancel once and report the original error',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),finish=deferred(),errors=[];bridge.enqueue('/api/voice/finish',finish);
 await voice.start({onError:error=>errors.push(error.message)});const stopped=assert.rejects(voice.stop(),/finish failed/);
 await until(()=>bridge.for('finish').length===1);finish.reject(new Error('finish failed'));await stopped;
 assert.deepEqual(errors,['finish failed']);assert.equal(bridge.for('cancel').length,1);env.assertReleased(0);
 await voice.start({onError:error=>errors.push(error.message)});voice.node.port.postMessage=()=>{throw new Error('flush failed');};
 await assert.rejects(voice.stop(),/flush failed/);assert.deepEqual(errors,['finish failed','flush failed']);assert.equal(bridge.for('cancel').length,2);assert.equal(bridge.for('finish').length,1);env.assertReleased(1);assert.equal(env.timers.size,0);
});

test('realtime failure cancelled during remote cleanup cannot emit an old error',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),remote=deferred(),errors=[];bridge.enqueue('/api/voice/cancel',remote);
 await voice.start({onError:error=>errors.push(error.message)});const failed=voice.fail(new Error('stale error'));await until(()=>bridge.for('cancel').length===1);
 const cancelled=voice.cancel();await voice.start({onError:error=>errors.push(`new:${error.message}`)});const current=voice.stream;
 remote.resolve({});await Promise.all([failed,cancelled]);assert.deepEqual(errors,[]);assert.equal(voice.stream,current);assert.equal(current.track.stops,0);assert.equal(bridge.for('cancel').length,1);
 await voice.cancel();env.assertReleased(0);env.assertReleased(1);
});

test('realtime start failures close local audio and cancel only the failed session',async t=>{
 const env=fakeAudio(t),bridge=fakeBridge(),voice=new RealtimeVoiceCapture(bridge),resume=deferred();env.plans.push({resume});
 const started=assert.rejects(voice.start(),/resume failed/);await until(()=>env.contexts[0]?.resumes===1);resume.reject(new Error('resume failed'));await started;
 assert.equal(voice.running,false);assert.equal(voice.id,null);env.assertReleased(0);assert.equal(env.streams[0].track.stops,1);assert.deepEqual(bridge.for('cancel').map(c=>c.body.id),['session-1']);
 await voice.start();await voice.cancel();env.assertReleased(1);assert.equal(env.timers.size,0);
});

/** Independent safe-interruption race tests. Fake worker transport, playback,
 * microphone and timers only; no media hardware, provider or model execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {HandsFreeVoice} from '../web/hands-free-voice.mjs';
import {createCapabilityUI} from '../web/capability-ui.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const frame=value=>new Float32Array(3200).fill(value);
function fixture(t){
 const calls=[],plans=new Map(),mics=[],handles=[],timers=new Map(),errors=[];let now=0,timerId=0,workerId=0,output=null;
 const f={calls,mics,handles,timers,errors,resumeGate:null,
  plan(route,value){const list=plans.get(route)||[];list.push(value);plans.set(route,list);},
  for:route=>calls.filter(call=>call.route===route),
  speak(audio={paused:false,muted:false,volume:1,ended:false}){output=audio;voice.setSpeaking(true,audio);return audio;},
  async emit(value=.03,reference=.02){mics.at(-1).emit(frame(value),reference===undefined?undefined:frame(reference));await settle();},
  async fire(key){const id=voice.session?.timers.get(key),timer=timers.get(id);assert.ok(timer,'expected live '+key+' timer');now=Math.max(now,timer.at);timers.delete(id);timer.fn();await settle();},
  get output(){return output;},
 };
 const voice=new HandsFreeVoice({
  bridge:{request(path,method,body){const route=path.replace('/api/voice/','');calls.push({route,body});const planned=plans.get(route)?.shift();try{return Promise.resolve(typeof planned==='function'?planned(body):planned?.promise??planned??(route.endsWith('start')?{id:'worker-'+(++workerId)}:route==='chunk'?{detected:false}:{}));}catch(error){return Promise.reject(error);}}},
  audioFactory(){const mic={closed:0,attached:[],async start(onFrame,onError){this.emit=onFrame;this.fail=onError;},attachOutput(audio){this.attached.push(audio);return true;},releaseOutput(){},close(){this.closed++;}};mics.push(mic);return mic;},
  now:()=>now,setTimer(fn,ms){const id=++timerId;timers.set(id,{fn,at:now+ms});return id;},clearTimer:id=>timers.delete(id),onError:error=>errors.push(error),
  stopOutput(){if(output)output.paused=true;output=null;},
  pauseOutput(){const owned=output;if(!owned||owned.paused||owned.muted||owned.ended||!owned.volume)return null;const gate=f.resumeGate;f.resumeGate=null;
   const handle={resumes:0,cancels:0,valid:true,async resume(){this.resumes++;if(gate)await gate.promise;if(!this.valid||output!==owned||owned.muted||owned.ended||!owned.volume)return false;owned.paused=false;voice.setSpeaking(true,owned);return true;},cancel(){this.cancels++;this.valid=false;if(output===owned){output=null;voice.setSpeaking(false);}}};handles.push(handle);owned.paused=true;voice.setSpeaking(false);return handle;
  }
 });f.voice=voice;t.after(()=>voice.disable());return f;
}
async function confirming(t,{resumeGate}={}){
 const f=fixture(t);f.resumeGate=resumeGate;await f.voice.enable({bargeIn:true,echoTailMs:1200,confirmationMs:5000});f.speak();await f.fire('barge-start');assert.equal(f.voice.state,'barge-listening');f.plan('chunk',{detected:true});await f.emit();assert.equal(f.voice.state,'barge-quiet');await f.fire('barge-tail');assert.equal(f.voice.state,'barge-confirm');return f;
}

test('replacement output during confirmation-worker close retains its own acoustic gate',async t=>{
 const f=await confirming(t),closing=deferred();f.plan('cancel',closing);await f.fire('barge-confirm');assert.equal(f.handles[0].resumes,0);const starts=f.for('wake/start').length,replacement=f.speak();
 closing.resolve({});await settle();assert.equal(replacement.paused,false);assert.equal(f.voice.output,true,'old confirmation cleanup cannot mark replacement playback quiet');assert.equal(f.voice.session.outputAudio,replacement);assert.equal(f.for('wake/start').length,starts,'mono wake cannot reopen while replacement audio is audible');await f.fire('barge-start');assert.equal(f.voice.state,'barge-listening');assert.deepEqual(f.errors,[]);
});

test('a safely rejected delayed resume cannot clear replacement output ownership',async t=>{
 const resuming=deferred(),f=await confirming(t,{resumeGate:resuming});await f.fire('barge-confirm');assert.equal(f.handles[0].resumes,1);const starts=f.for('wake/start').length,replacement=f.speak();
 resuming.resolve();await settle();assert.equal(replacement.paused,false);assert.equal(f.voice.output,true,'old resume failure belongs to the old playback');assert.equal(f.voice.session.outputAudio,replacement);assert.equal(f.for('wake/start').length,starts);await f.fire('barge-start');assert.equal(f.voice.state,'barge-listening');
});

test('manual hands-free mute during a delayed resume cannot restore output or inference',async t=>{
 const resuming=deferred(),f=await confirming(t,{resumeGate:resuming});await f.fire('barge-confirm');assert.equal(f.handles[0].resumes,1);const starts=f.for('wake/start').length;await f.voice.interrupt();resuming.resolve();await settle();assert.equal(f.voice.active,false);assert.equal(f.voice.state,'interrupted');assert.equal(f.voice.output,false);assert.equal(f.output,null);assert.equal(f.mics[0].closed,1);assert.equal(f.for('wake/start').length,starts);assert.equal(f.timers.size,0);
});

test('replacement session survives an old delayed resume failure',async t=>{
 const resuming=deferred(),f=await confirming(t,{resumeGate:resuming});await f.fire('barge-confirm');await f.voice.disable();await f.voice.enable({bargeIn:true});const session=f.voice.session,replacement=f.speak();await f.fire('barge-start');resuming.resolve();await settle();assert.equal(f.voice.session,session);assert.equal(f.voice.output,true);assert.equal(f.voice.state,'barge-listening');assert.equal(f.voice.session.outputAudio,replacement);assert.equal(f.mics[1].closed,0);assert.deepEqual(f.errors,[]);
});

test('repeated quiet notifications during confirmation never auto-resume manually muted audio',async t=>{
 const f=await confirming(t);f.output.muted=true;f.handles[0].valid=false;for(let i=0;i<20;i++)f.voice.setSpeaking(false,f.output);await f.fire('barge-confirm');assert.equal(f.voice.state,'idle');assert.equal(f.voice.output,false);assert.equal(f.output.paused,true);assert.equal(f.handles[0].resumes,1);assert.equal(f.handles[0].cancels,0);assert.equal(f.for('start').length,0);
});

function capabilityPlayer(t,f,{queuedPause=false}={}){
 const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document'),oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout,nodes=new Map(),audios=[],subscribers=[],capTimers=new Map();let capTimer=0,job=0;
 const p={audios,pauseEvents:[],nextPlay:null,reply:'Synthetic audible reply',async flushPause(){for(const event of this.pauseEvents.splice(0))event();await settle();}};
 function element(tag){
  const node={tagName:tag.toUpperCase(),isConnected:false,querySelector:selector=>selector==='audio'?node.audio:null,querySelectorAll:()=>[],prepend(child){child.isConnected=true;nodes.set('#'+child.id,child);},remove(){this.isConnected=false;if(this.audio)this.audio.isConnected=false;nodes.delete('#'+this.id);}};
  Object.defineProperty(node,'innerHTML',{get:()=>node.html||'',set(html){node.html=html;if(!html.includes('<audio'))return;const listeners=new Map();
   const audio={tagName:'AUDIO',dataset:{mediaId:html.match(/data-media-id="([^"]+)"/)?.[1]},isConnected:true,paused:true,ended:false,error:null,muted:false,volume:1,
    addEventListener(name,fn){const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list);},emit(name){if(name==='play')this.paused=false;if(name==='pause')this.paused=true;this['on'+name]?.({target:this});for(const fn of listeners.get(name)||[])fn({target:this});},
    play(){const gate=p.nextPlay;p.nextPlay=null;this.emit('play');return gate?.promise||Promise.resolve();},pause(){if(this.paused)return;this.paused=true;if(queuedPause)p.pauseEvents.push(()=>this.emit('pause'));else this.emit('pause');}};node.audio=audio;audios.push(audio);
  }});return node;
 }
 nodes.set('.input-region',element('section'));
 Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:{hidden:false,querySelector:selector=>nodes.get(selector)||null,querySelectorAll:selector=>selector.includes('audio')?audios.filter(a=>a.isConnected):[],createElement:element,addEventListener(){}}});
 globalThis.setTimeout=(fn,ms)=>{const id=++capTimer;capTimers.set(id,{fn,ms});return id;};globalThis.clearTimeout=id=>capTimers.delete(id);
 const profile={id:'local-voice',identity:'synthetic-voice',name:'Synthetic local voice',role:'tts',domain:'device',enabled:true};
 const bridge={on:fn=>{subscribers.push(fn);return()=>{};},async request(route,method='GET'){
  if(route==='/api/capabilities')return {revision:1,profiles:[profile],routes:{tts:profile.id}};
  if(route==='/api/media/jobs'&&method==='POST')return {id:'tts-'+(++job),status:'running'};
  if(route==='/api/media/jobs')return {jobs:[{id:'tts-'+job,kind:'tts',title:'Synthetic reply',status:'ready',asset:{id:'asset-'+job,mime:'audio/wav'}}]};
  throw Error('Unexpected capability fixture route '+route);
 }};
 p.ui=createCapabilityUI({bridge,previewMode:false,isPrivate:()=>true,isOpen:()=>false,attached:()=>[],latestReply:()=>p.reply,onPlayback:(active,audio)=>f.voice.setSpeaking(active,audio),notice:()=>{},openSheet:()=>{},closeSheet:()=>{}});
 f.voice.pauseOutput=()=>p.ui.pauseForBarge();f.voice.stopOutput=()=>p.ui.stopPlayback();
 t.after(()=>{p.ui.stop();globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete globalThis.document;});return p;
}

async function queuedPauseCandidate(t,{closing}={}){
 const f=fixture(t),p=capabilityPlayer(t,f,{queuedPause:true});await f.voice.enable({bargeIn:true});await p.ui.readReply({automatic:true});await f.fire('barge-start');
 if(closing)f.plan('cancel',closing);f.plan('chunk',{detected:true});await f.emit();assert.equal(p.audios[0].paused,true);assert.equal(p.pauseEvents.length,1,'pause event remains queued after the paused flag changes');return {f,p};
}

test('queued capability pause event cannot stall confirmation after immediate worker cancellation',async t=>{
 const {f,p}=await queuedPauseCandidate(t);assert.equal(f.voice.output,false,'synchronous paused flag establishes quiet ownership before the event');assert.ok(f.voice.session.timers.has('barge-tail'));
 await p.flushPause();await f.fire('barge-tail');assert.equal(f.voice.state,'barge-confirm');f.plan('chunk',{detected:true});await f.emit();assert.equal(f.voice.state,'listening');assert.equal(f.for('start').length,1);assert.deepEqual(f.errors,[]);
});

test('queued old pause and delayed cancellation cannot mute replacement output',async t=>{
 const closing=deferred(),{f,p}=await queuedPauseCandidate(t,{closing}),old=p.audios[0];p.reply='Replacement during candidate';await p.ui.readReply({automatic:true});const replacement=p.audios[1];
 closing.resolve({});await p.flushPause();assert.equal(old.paused,true);assert.equal(replacement.paused,false);assert.equal(f.voice.output,true);assert.equal(f.voice.session.outputAudio,replacement);await f.fire('barge-start');assert.equal(f.voice.state,'barge-listening');assert.equal(f.for('start').length,0);assert.deepEqual(f.errors,[]);
});

test('hands-free mute before queued pause delivery prevents any confirmation or resume',async t=>{
 const {f,p}=await queuedPauseCandidate(t);await f.voice.interrupt();await p.flushPause();assert.equal(f.voice.state,'interrupted');assert.equal(f.voice.active,false);assert.equal(f.voice.output,false);assert.equal(f.timers.size,0);assert.equal(f.mics[0].closed,1);assert.equal(f.for('start').length,0);assert.deepEqual(f.errors,[]);
});

async function integratedConfirmation(t){
 const f=fixture(t),p=capabilityPlayer(t,f);await f.voice.enable({bargeIn:true});await p.ui.readReply({automatic:true});await f.fire('barge-start');assert.equal(f.voice.state,'barge-listening');f.plan('chunk',{detected:true});await f.emit();assert.equal(f.voice.state,'barge-quiet');assert.equal(p.audios[0].paused,true);await f.fire('barge-tail');assert.equal(f.voice.state,'barge-confirm');return {f,p};
}

test('actual capability pause handle resumes through onplay and restores paired barge capture',async t=>{
 const {f,p}=await integratedConfirmation(t),audio=p.audios[0];await f.fire('barge-confirm');assert.equal(audio.paused,false);assert.equal(f.voice.output,true);assert.equal(f.voice.session.outputAudio,audio);await f.fire('barge-start');assert.equal(f.voice.state,'barge-listening');assert.equal(f.mics[0].attached.at(-1),audio);assert.equal(f.for('start').length,0);assert.deepEqual(f.errors,[]);
});

test('actual capability pending play cannot revive capture after hands-free mute',async t=>{
 const {f,p}=await integratedConfirmation(t),playing=deferred();p.nextPlay=playing;await f.fire('barge-confirm');const audio=p.audios[0];assert.equal(audio.paused,false);assert.equal(f.voice.output,true);await f.voice.interrupt();playing.resolve();await settle();assert.equal(audio.paused,true);assert.equal(f.voice.active,false);assert.equal(f.voice.state,'interrupted');assert.equal(f.voice.output,false);assert.equal(f.for('start').length,0);assert.equal(f.mics[0].closed,1);assert.equal(f.timers.size,0);assert.deepEqual(f.errors,[]);
});

test('actual capability replacement player survives an old pending play promise and quiet callback',async t=>{
 const {f,p}=await integratedConfirmation(t),playing=deferred();p.nextPlay=playing;await f.fire('barge-confirm');const old=p.audios[0];p.reply='Replacement synthetic reply';await p.ui.readReply({automatic:true});const replacement=p.audios[1];assert.equal(replacement.paused,false);playing.resolve();await settle();old.emit('pause');assert.equal(f.voice.output,true);assert.equal(f.voice.session.outputAudio,replacement);assert.equal(replacement.paused,false);await f.fire('barge-start');assert.equal(f.voice.state,'barge-listening');assert.equal(f.mics[0].attached.at(-1),replacement);assert.equal(f.for('start').length,0);assert.deepEqual(f.errors,[]);
});

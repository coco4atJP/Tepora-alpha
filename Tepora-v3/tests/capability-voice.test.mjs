import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapabilityUI} from '../web/capability-ui.mjs';

// Production controller with inert DOM/media and an in-memory bridge. No audio,
// browser, provider, model, account, or persistent generated asset is used.
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function until(check){for(let i=0;i<50;i++){if(check())return;await Promise.resolve();}assert.fail('Expected fixture transition did not occur');}

function fixture(t,{domain='device',previewMode=false,reply='今回の返事です。'}={}){
 const previous={document:globalThis.document,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
 const listeners=new Map(),nodes=new Map(),timers=new Map(),timerHistory=[],calls=[],notices=[],sheets=[],audios=[],playback=[],playbackRefs=[],plans=new Map(),subscribers=[];
 let nextTimer=0,privateView=true,playing=false;
 const f={calls,notices,sheets,audios,playback,playbackRefs,timers,timerHistory,reply,jobs:[],
  profile:{id:'voice',identity:'voice-v1',name:'Fixture voice',role:'tts',domain,model:'fixture',baseUrl:domain==='device'?'http://127.0.0.1:8880/v1':'https://voice.invalid/v1',enabled:true},
  plan(path,method,value){const key=method+' '+path;if(!plans.has(key))plans.set(key,[]);plans.get(key).push(value);},
  get speaking(){return playing;},
  posts:()=>calls.filter(c=>c.path==='/api/media/jobs'&&c.method==='POST'),
  emit(data){for(const callback of subscribers)callback({type:'media.updated',data});},
  deleted(id){for(const callback of subscribers)callback({type:'media.deleted',data:{id}});},
  setPrivate(value){privateView=value;},
  event(name){for(const callback of listeners.get(name)||[])callback({});},
  fire(timer){timers.delete(timer.id);timer.callback(...timer.args);}
 };
 function element(tag){
  const node={tagName:tag.toUpperCase(),dataset:{},isConnected:false,
   querySelector(selector){return selector==='audio'?this.audio||null:null;},querySelectorAll:()=>[],
   remove(){this.isConnected=false;if(this.audio)this.audio.isConnected=false;nodes.delete('#'+this.id);},
   prepend(child){child.isConnected=true;nodes.set('#'+child.id,child);}
  };
  Object.defineProperty(node,'innerHTML',{set(html){this.html=html;
   if(/<audio\b/.test(html)){
    const callbacks=new Map(),audio={tagName:'AUDIO',dataset:{mediaId:html.match(/data-media-id="([^"]+)"/)?.[1]},isConnected:true,paused:true,ended:false,muted:false,volume:1,
     addEventListener(name,callback){if(!callbacks.has(name))callbacks.set(name,[]);callbacks.get(name).push(callback);},
     emit(name){if(name==='play'){this.paused=false;this.ended=false;}if(name==='pause')this.paused=true;if(name==='ended'){this.paused=true;this.ended=true;}
      this['on'+name]?.({target:this});for(const callback of callbacks.get(name)||[])callback({target:this});},
     play(){if(f.playStarts!==false)this.emit('play');return f.nextPlay?.promise||Promise.resolve();},pause(){if(!this.paused)this.emit('pause');}
    };this.audio=audio;audios.push(audio);
   }
  },get(){return this.html||'';}});
  return node;
 }
 nodes.set('.input-region',element('section'));
 globalThis.document={hidden:false,querySelector:selector=>nodes.get(selector)||null,
  querySelectorAll:selector=>selector.includes('audio')?audios.filter(a=>a.isConnected):[],
  createElement:element,addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);}};
 globalThis.setTimeout=(callback,delay,...args)=>{const timer={id:++nextTimer,callback,delay,args};timers.set(timer.id,timer);timerHistory.push(timer);return timer.id;};
 globalThis.clearTimeout=id=>timers.delete(id);
 const bridge={on:callback=>subscribers.push(callback),async request(path,method='GET',body){
  calls.push({path,method,body});const queue=plans.get(method+' '+path);
  if(queue?.length){const result=queue.shift();return typeof result==='function'?result(body):result.promise||result;}
  if(path==='/api/capabilities')return {revision:1,profiles:f.profile?[f.profile]:[],routes:f.profile?{tts:f.profile.id}:{}};
  if(path==='/api/media/jobs'&&method==='GET')return {jobs:f.jobs};
  if(path==='/api/media/jobs'&&method==='POST')return {id:'tts-'+f.posts().length,status:'running'};
  throw Error('Unexpected fixture request '+method+' '+path);
 }};
 f.ui=createCapabilityUI({bridge,previewMode,isPrivate:()=>privateView,isOpen:()=>false,
  attached:()=>[],latestReply:()=>f.reply,notice:message=>notices.push(message),closeSheet:()=>{},
  openSheet:(title,body,kind)=>sheets.push({title,body,kind}),onPlayback:(value,audio)=>{playing=value;playback.push(value);playbackRefs.push({active:value,audio});}});
 t.after(()=>{f.ui.stop();Object.assign(globalThis,previous);});
 return f;
}

const ready=(id='tts-1',asset='asset-1')=>({id,kind:'tts',title:'Fixture reply',status:'ready',asset:{id:asset,mime:'audio/wav'}});

for(const domain of ['cloud','lan'])test(`automatic readout skips ${domain} without a generation or confirmation`,async t=>{
  const f=fixture(t,{domain});await f.ui.readReply({automatic:true});
  assert.equal(f.posts().length,0);assert.equal(f.sheets.length,0);assert.equal(f.speaking,false);assert.equal(f.playback.includes(true),false);
});

for(const setting of ['missing','disabled'])test(`automatic readout skips a ${setting} local profile without opening settings`,async t=>{
 const f=fixture(t);if(setting==='missing')f.profile=null;else f.profile.enabled=false;
 await f.ui.readReply({automatic:true});assert.equal(f.posts().length,0);assert.equal(f.sheets.length,0);assert.equal(f.playback.includes(true),false);
});

test('automatic readout skips oversized replies while explicit remote readout shows consent',async t=>{
 const f=fixture(t,{domain:'cloud',reply:'x'.repeat(4097)});await f.ui.readReply({automatic:true});assert.equal(f.calls.length,0);
 f.reply='A bounded reply';await f.ui.readReply();assert.equal(f.posts().length,0);assert.equal(f.speaking,false);
 assert.equal(f.sheets.at(-1).kind,'creative-compose');assert.match(f.sheets.at(-1).body,/A bounded reply/);assert.match(f.sheets.at(-1).body,/Fixture voice/);
});

test('preview readout never submits generation or reserves the output gate',async t=>{
 const f=fixture(t,{previewMode:true});await assert.rejects(f.ui.readReply({automatic:true}),/プレビュー/);
 assert.equal(f.posts().length,0);assert.equal(f.playback.includes(true),false);assert.equal(f.speaking,false);assert.equal(f.timers.size,0);
});

test('automatic local readout gates pending generation and plays only the exact reply',async t=>{
 const f=fixture(t),generation=deferred();f.plan('/api/media/jobs','POST',generation);
 const reading=f.ui.readReply({automatic:true});await until(()=>f.posts().length===1);
 assert.equal(f.speaking,true);assert.equal(f.audios.length,0);assert.equal(f.sheets.length,0);
 assert.deepEqual({...f.posts()[0].body,requestId:'opaque'},{kind:'tts',prompt:f.reply,requestId:'opaque',profileIdentity:'voice-v1',consent:true});
 f.jobs=[ready()];generation.resolve({id:'tts-1',status:'running'});await reading;
 assert.equal(f.audios.length,1);assert.equal(f.audios[0].dataset.mediaId,'asset-1');assert.equal(f.speaking,true);assert.equal(f.timers.size,0);
});

test('pause, resume, end and playback errors report the output lifecycle',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0];
 for(const [event,speaking] of [['pause',false],['play',true],['ended',false],['play',true],['error',false]]){
  audio.emit(event);assert.equal(f.speaking,speaking,event);
 }
});

test('muting or zero volume releases playback and audible resume gates it again',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0];
 audio.muted=true;audio.emit('volumechange');assert.equal(f.speaking,false,'muted playback');
 audio.muted=false;audio.emit('volumechange');assert.equal(f.speaking,true,'unmuted playback');
 audio.volume=0;audio.emit('volumechange');assert.equal(f.speaking,false,'zero volume');
 audio.volume=1;audio.emit('volumechange');assert.equal(f.speaking,true,'audible volume');
 audio.emit('pause');audio.muted=true;audio.emit('volumechange');audio.muted=false;audio.emit('volumechange');assert.equal(f.speaking,false,'unmuting a paused player');
});

test('a rejected audio play promise releases the gate',async t=>{
 const f=fixture(t),play=deferred();f.nextPlay=play;f.jobs=[ready()];await f.ui.readReply();assert.equal(f.speaking,true);
 play.reject(Error('synthetic autoplay refusal'));await settle();assert.equal(f.speaking,false);assert.equal(f.timers.size,0);
});

test('generation failures release pending output and allow another readout',async t=>{
 const f=fixture(t);f.plan('/api/media/jobs','POST',()=>Promise.reject(Error('synthetic generation failure')));
 await assert.rejects(f.ui.readReply(),/generation failure/);assert.equal(f.speaking,false);assert.equal(f.timers.size,0);
 await f.ui.readReply();assert.equal(f.posts().length,2);assert.equal(f.speaking,true);
});

test('failed job refresh releases output instead of leaving an unknown pending gate',async t=>{
 const f=fixture(t);f.plan('/api/media/jobs','GET',()=>Promise.reject(Error('synthetic snapshot failure')));
 await assert.rejects(f.ui.readReply(),/snapshot failure/);assert.equal(f.speaking,false);assert.equal(f.timers.size,0);
 f.emit(ready());assert.equal(f.audios.length,0,'failure must invalidate late ready output');
});

test('terminal job events release pending output and ignore later readiness',async t=>{
 const f=fixture(t);
 for(const status of ['failed','cancelled','paused']){
  await f.ui.readReply();const id='tts-'+f.posts().length;assert.equal(f.speaking,true);
  f.emit({id,kind:'tts',title:'Fixture reply',status});assert.equal(f.speaking,false,status);assert.equal(f.timers.size,0);
  f.emit(ready(id));assert.equal(f.audios.length,0,'terminal job cannot autoplay later');
 }
});

test('terminal job snapshots release output even when no terminal event arrives',async t=>{
 const f=fixture(t);
 for(const status of ['failed','cancelled','paused']){
  const id='tts-'+(f.posts().length+1);f.jobs=[{id,kind:'tts',title:'Fixture reply',status}];await f.ui.readReply();
  assert.equal(f.speaking,false,status);assert.equal(f.timers.size,0);assert.equal(f.audios.length,0);
 }
});

test('terminal failure during a pending snapshot permits replacement and fences the old snapshot',async t=>{
 const f=fixture(t),snapshot=deferred();f.plan('/api/media/jobs','GET',snapshot);
 const first=f.ui.readReply();await until(()=>f.calls.some(c=>c.path==='/api/media/jobs'&&c.method==='GET'));
 f.emit({id:'tts-1',kind:'tts',status:'failed',title:'Failed job'});assert.equal(f.speaking,false);
 f.reply='Replacement';await f.ui.readReply();assert.equal(f.posts().length,2);assert.equal(f.speaking,true);
 snapshot.resolve({jobs:[ready()]});await first;assert.equal(f.audios.length,0);assert.equal(f.speaking,true);
 f.emit(ready('tts-2','replacement'));assert.equal(f.audios.length,1);assert.equal(f.audios[0].dataset.mediaId,'replacement');
});

test('privacy change during a pending snapshot releases output without autoplay',async t=>{
 const f=fixture(t),snapshot=deferred();f.plan('/api/media/jobs','GET',snapshot);
 const reading=f.ui.readReply();await until(()=>f.calls.some(c=>c.path==='/api/media/jobs'&&c.method==='GET'));
 f.setPrivate(false);snapshot.resolve({jobs:[ready()]});await reading;
 assert.equal(f.speaking,false);assert.equal(f.timers.size,0);assert.equal(f.audios.length,0);
 f.setPrivate(true);f.emit(ready());assert.equal(f.audios.length,0);
});

test('stop while generation is pending discards a late job response and event',async t=>{
 const f=fixture(t),generation=deferred();f.plan('/api/media/jobs','POST',generation);
 const reading=f.ui.readReply();await until(()=>f.posts().length===1);f.ui.stopPlayback();assert.equal(f.speaking,false);assert.equal(f.timers.size,0);
 generation.resolve({id:'tts-1'});await reading;f.emit(ready());assert.equal(f.audios.length,0);assert.equal(f.speaking,false);
});

test('stopped pending generation cannot block or release a replacement readout',async t=>{
 const f=fixture(t),old=deferred(),replacement=deferred();f.plan('/api/media/jobs','POST',old);f.plan('/api/media/jobs','POST',replacement);
 const first=f.ui.readReply();await until(()=>f.posts().length===1);f.ui.stopPlayback();f.reply='The replacement reply';
 const second=f.ui.readReply();await until(()=>f.posts().length===2);assert.equal(f.speaking,true);
 old.reject(Error('stale generation failure'));await assert.rejects(first,/stale generation failure/);
 assert.equal(f.speaking,true,'old finally must not release the new reservation');
 f.jobs=[ready('tts-2','replacement-asset')];replacement.resolve({id:'tts-2'});await second;
 assert.equal(f.audios.length,1);assert.equal(f.audios[0].dataset.mediaId,'replacement-asset');assert.equal(f.speaking,true);
 f.emit(ready('tts-1','stale-asset'));assert.equal(f.audios.length,1);
});

test('late callbacks and play rejection from the replaced player preserve current output',async t=>{
 const f=fixture(t),oldPlay=deferred();f.nextPlay=oldPlay;f.jobs=[ready()];await f.ui.readReply();const old=f.audios[0];
 f.nextPlay=null;f.reply='Second reply';f.jobs=[ready('tts-2','second-asset')];await f.ui.readReply();assert.equal(f.speaking,true);
 for(const event of ['pause','ended','error','play']){old.emit(event);assert.equal(f.speaking,true,event);}
 oldPlay.reject(Error('late old player refusal'));await settle();assert.equal(f.speaking,true);
 f.audios[1].emit('ended');assert.equal(f.speaking,false);
});

test('pending generation timeout releases output and ignores late readiness',async t=>{
 const f=fixture(t);await f.ui.readReply();assert.equal(f.speaking,true);assert.equal(f.timers.size,1);
 f.fire([...f.timers.values()][0]);assert.equal(f.speaking,false);assert.equal(f.timers.size,0);
 f.emit(ready());assert.equal(f.audios.length,0);
});

test('timeout while creation is unresolved fences its late response and snapshot',async t=>{
 const f=fixture(t),generation=deferred();f.plan('/api/media/jobs','POST',generation);
 const reading=f.ui.readReply();await until(()=>f.posts().length===1);f.fire([...f.timers.values()][0]);
 assert.equal(f.speaking,false);f.jobs=[ready()];generation.resolve({id:'tts-1'});await reading;
 assert.equal(f.audios.length,0);assert.equal(f.speaking,false);assert.equal(f.calls.filter(c=>c.path==='/api/media/jobs'&&c.method==='GET').length,0);
});

test('terminal event received before creation response is retained without autoplay',async t=>{
 const f=fixture(t),generation=deferred();f.plan('/api/media/jobs','POST',generation);
 const reading=f.ui.readReply();await until(()=>f.posts().length===1);
 f.emit({id:'tts-1',kind:'tts',status:'cancelled',title:'Cancelled reply'});generation.resolve({id:'tts-1'});await reading;
 assert.equal(f.speaking,false);assert.equal(f.timers.size,0);assert.equal(f.audios.length,0);
 f.emit(ready());assert.equal(f.audios.length,0);
});

test('unrelated media deletion preserves pending output; deleting its own job releases it',async t=>{
 const f=fixture(t);await f.ui.readReply();assert.equal(f.speaking,true);
 f.emit({id:'unrelated',kind:'image',status:'failed',title:'Other job'});f.deleted('unrelated');assert.equal(f.speaking,true);
 f.deleted('absent');assert.equal(f.speaking,true);assert.equal(f.timers.size,1);
 f.deleted('tts-1');assert.equal(f.speaking,false);assert.equal(f.timers.size,0);f.emit(ready());assert.equal(f.audios.length,0);
});

test('a stale timeout cannot clear a replacement output reservation',async t=>{
 const f=fixture(t);await f.ui.readReply();const oldTimer=[...f.timers.values()][0];f.ui.stopPlayback();f.reply='New pending reply';await f.ui.readReply();assert.equal(f.speaking,true);
 f.fire(oldTimer);assert.equal(f.speaking,true);f.emit(ready('tts-2','new-asset'));assert.equal(f.audios.length,1);assert.equal(f.speaking,true);
});

test('hiding the document stops output and suppresses pending autoplay',async t=>{
 const f=fixture(t);await f.ui.readReply();globalThis.document.hidden=true;f.event('visibilitychange');assert.equal(f.speaking,false);assert.equal(f.timers.size,0);
 f.emit(ready());assert.equal(f.audios.length,0);
});


test('playback callbacks distinguish pending generation from its exact media reference',async t=>{
 const f=fixture(t),generation=deferred();f.plan('/api/media/jobs','POST',generation);
 const reading=f.ui.readReply();await until(()=>f.posts().length===1);
 assert.deepEqual(f.playbackRefs.at(-1),{active:true,audio:null});assert.equal(f.ui.pauseForBarge(),null);
 f.jobs=[ready()];generation.resolve({id:'tts-1'});await reading;const audio=f.audios[0];
 assert.deepEqual(f.playbackRefs.at(-1),{active:true,audio});
 audio.emit('pause');assert.deepEqual(f.playbackRefs.at(-1),{active:false,audio});
 audio.emit('play');assert.deepEqual(f.playbackRefs.at(-1),{active:true,audio});
 f.ui.stopPlayback();assert.deepEqual(f.playbackRefs.at(-1),{active:false,audio:null});
});

test('barge pause resumes the same audio without generating another request',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0],handle=f.ui.pauseForBarge();
 assert.ok(handle);assert.equal(audio.paused,true);assert.equal(f.speaking,false);
 assert.equal(await handle.resume(),true);assert.equal(audio.paused,false);assert.equal(f.speaking,true);assert.equal(f.audios.length,1);assert.equal(f.posts().length,1);
 assert.equal(await handle.resume(),false);handle.cancel();assert.equal(audio.paused,false,'consumed handle cannot stop resumed audio');
});

test('barge cancellation stops only its owned output and ignores later ready events',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const handle=f.ui.pauseForBarge();handle.cancel();
 assert.equal(f.speaking,false);assert.equal(await handle.resume(),false);f.emit(ready());assert.equal(f.audios.length,1);
});

test('stale barge handles cannot resume or stop a replacement player',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const old=f.audios[0],handle=f.ui.pauseForBarge();
 f.reply='Replacement reply';f.jobs=[ready('tts-2','replacement')];await f.ui.readReply();const replacement=f.audios[1];
 assert.equal(await handle.resume(),false);handle.cancel();assert.equal(old.paused,true);assert.equal(replacement.paused,false);assert.equal(f.speaking,true);
});

for(const mode of ['paused','muted','zero-volume','ended','error','disconnected','hidden','shared'])test(`barge pause refuses ${mode} output`,async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0];
 if(mode==='paused')audio.emit('pause');if(mode==='muted')audio.muted=true;if(mode==='zero-volume')audio.volume=0;if(mode==='ended')audio.ended=true;if(mode==='error')audio.error={code:3};if(mode==='disconnected')audio.isConnected=false;if(mode==='hidden')document.hidden=true;if(mode==='shared')f.setPrivate(false);
 assert.equal(f.ui.pauseForBarge(),null);
});

for(const change of ['volumechange','ended','error','seeking','ratechange','pointerdown','keydown','input','change','pause','play'])test(`media ${change} invalidates a barge resume`,async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0],handle=f.ui.pauseForBarge();audio.emit(change);
 assert.equal(await handle.resume(),false);const paused=audio.paused;handle.cancel();assert.equal(audio.paused,paused,'invalidated handle cannot stop manually controlled audio');
});

for(const change of ['muted','zero-volume','private','hidden','deleted','stopped'])test(`barge resume cannot autoplay after output becomes ${change}`,async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0],handle=f.ui.pauseForBarge();
 if(change==='muted')audio.muted=true;if(change==='zero-volume')audio.volume=0;if(change==='private')f.setPrivate(false);if(change==='hidden'){document.hidden=true;f.event('visibilitychange');}if(change==='deleted')f.deleted('tts-1');if(change==='stopped')f.ui.stopPlayback();
 assert.equal(await handle.resume(),false);assert.equal(audio.paused,true);audio.muted=false;audio.volume=1;f.setPrivate(true);document.hidden=false;assert.equal(await handle.resume(),false,'an invalid handle stays invalid');
});

test('a rejected barge resume stays paused and releases its handle',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0],handle=f.ui.pauseForBarge(),play=deferred();f.nextPlay=play;
 const resuming=handle.resume();play.reject(Error('synthetic autoplay refusal'));assert.equal(await resuming,false);assert.equal(audio.paused,true);assert.equal(f.speaking,false);assert.equal(await handle.resume(),false);
});

for(const change of ['muted','volumechange','replacement','hidden'])test(`pending barge resume is fenced after ${change}`,async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0],handle=f.ui.pauseForBarge(),play=deferred();f.nextPlay=play;
 const resuming=handle.resume();
 if(change==='muted'){audio.muted=true;audio.emit('volumechange');}if(change==='volumechange')audio.emit('volumechange');if(change==='hidden'){document.hidden=true;f.event('visibilitychange');}
 if(change==='replacement'){f.nextPlay=null;f.reply='Replacement';f.jobs=[ready('tts-2','replacement')];await f.ui.readReply();}
 audio.emit('play');assert.equal(audio.paused,true,'a late play event cannot revive invalid output');play.resolve();assert.equal(await resuming,false);assert.equal(audio.paused,true);
 if(change==='replacement'){assert.equal(f.audios[1].paused,false);assert.equal(f.speaking,true);}
});


test('a player awaiting autoplay cannot provide a barge pause handle',async t=>{
 const f=fixture(t),play=deferred();f.playStarts=false;f.nextPlay=play;f.jobs=[ready()];await f.ui.readReply();
 assert.equal(f.audios[0].paused,true);assert.equal(f.ui.pauseForBarge(),null);
 play.reject(Error('synthetic autoplay refusal'));await settle();assert.equal(f.speaking,false);
});

test('cancel during a pending resume fences a delayed play event',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0],handle=f.ui.pauseForBarge(),play=deferred();f.playStarts=false;f.nextPlay=play;
 const resuming=handle.resume();handle.cancel();audio.emit('play');assert.equal(audio.paused,true);play.resolve();assert.equal(await resuming,false);assert.equal(f.speaking,false);
});

test('a player permits only one pending resume and releases that slot after settlement',async t=>{
 const f=fixture(t);f.jobs=[ready()];await f.ui.readReply();const audio=f.audios[0],handle=f.ui.pauseForBarge(),play=deferred();f.nextPlay=play;
 const resuming=handle.resume();assert.equal(audio.paused,false);assert.equal(f.ui.pauseForBarge(),null,'pending play cannot accumulate another owned resume');
 play.resolve();assert.equal(await resuming,true);const next=f.ui.pauseForBarge();assert.ok(next,'settled play releases its per-element slot');next.cancel();assert.equal(audio.paused,true);
});

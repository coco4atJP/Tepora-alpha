import test from 'node:test';
import assert from 'node:assert/strict';
import {HandsFreeVoice} from '../web/hands-free-voice.mjs';

// In-memory workers, synthetic aligned PCM and a virtual render clock only.
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const frame=(value=.03,length=3200)=>new Float32Array(length).fill(value);
function fixture(t,{attach=true}={}){
 const calls=[],plans=new Map(),timers=new Map(),states=[],errors=[],mics=[],handles=[];
 let time=0,serial=0,remote=0,inFlight=0,maxInFlight=0,output=null,stops=0;
 const f={calls,timers,states,errors,mics,handles,
  plan(route,value){const queue=plans.get(route)||[];queue.push(value);plans.set(route,queue);},
  for:route=>calls.filter(c=>c.route===route),
  async emit(pcm=frame(),reference=frame(.02)){mics.at(-1).emit(pcm,reference);await settle();},
  async tick(ms){const target=time+ms;for(let steps=0;steps<10000;steps++){const entry=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;time=entry[1].at;timers.delete(entry[0]);entry[1].fn();await settle();}time=target;await settle();},
  speak(audio={paused:false,muted:false,volume:1,ended:false}){output=audio;voice.setSpeaking(true,audio);return audio;},
  end(){if(output)output.ended=true;voice.setSpeaking(false);},
  timer(key){return timers.get(voice.session?.timers.get(key));},
  get maxInFlight(){return maxInFlight;},get stops(){return stops;},get output(){return output;}
 };
 const voice=new HandsFreeVoice({
  bridge:{request(path,method,body,headers,options){const route=path.replace('/api/voice/','');calls.push({route,body,options});inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);let result;
   try{const planned=plans.get(route)?.shift();result=typeof planned==='function'?planned(body):planned?.promise??planned??(route.endsWith('start')?{id:`remote-${++remote}`} :route==='chunk'?{detected:false}:{});}catch(error){result=Promise.reject(error);}
   return Promise.resolve(result).finally(()=>inFlight--);
  }},
  audioFactory(options){const mic={options,closed:0,attached:[],retired:[],released:0,async start(emit,fail){this.emit=emit;this.fail=fail;},attachOutput(audio){this.attached.push(audio);return attach;},retireOutput(audio){this.retired.push(audio);},releaseOutput(){this.released++;},close(){this.closed++;}};mics.push(mic);return mic;},
  now:()=>time,setTimer(fn,ms){const id=++serial;timers.set(id,{fn,at:time+ms});return id;},clearTimer:id=>timers.delete(id),
  onState:state=>states.push(state),onError:error=>errors.push(error),stopOutput(){stops++;if(output)output.paused=true;},
  pauseOutput(){const owned=output;if(!owned||owned.paused||owned.muted||owned.volume===0||owned.ended)return null;
   const handle={audio:owned,resumes:0,cancels:0,async resume(){this.resumes++;if(output!==owned||owned.muted||!owned.volume||owned.ended)return false;owned.paused=false;voice.setSpeaking(true,owned);return true;},cancel(){this.cancels++;if(output===owned){owned.paused=true;output=null;voice.setSpeaking(false);}}};
   handles.push(handle);owned.paused=true;voice.setSpeaking(false);return handle;
  }
 });f.voice=voice;t.after(()=>voice.disable());return f;
}
async function enabled(t,options){const f=fixture(t,options);await f.voice.enable({bargeIn:true,echoTailMs:1200,confirmationMs:5000});return f;}
async function speaking(t,options){const f=await enabled(t,options);f.speak();await f.tick(0);assert.equal(f.voice.state,'barge-listening');return f;}
async function candidate(f){f.plan('chunk',{detected:true});await f.emit();assert.equal(f.voice.state,'barge-quiet');}
async function confirming(f){await candidate(f);await f.tick(1200);assert.equal(f.voice.state,'barge-confirm');}


test('barge mode attaches the exact output before opening a separate worker',async t=>{
 const f=await enabled(t);assert.equal(f.mics[0].options.bargeIn,true);const audio=f.speak();assert.equal(f.for('barge/start').length,0);
 await f.tick(0);assert.equal(f.voice.state,'barge-listening');assert.deepEqual(f.mics[0].attached,[audio]);assert.equal(f.for('cancel')[0].body.id,'remote-1');assert.equal(f.for('start').length,0);assert.equal(f.maxInFlight,1);
});

test('aligned duplex views become contiguous interleaved Float32 stereo PCM',async t=>{
 const f=await speaking(t),mic=Float32Array.from([.9,.1,.2,.3,.9]).subarray(1,4),reference=Float32Array.from([.8,-.1,-.2,-.3,.8]).subarray(1,4);
 await f.emit(mic,reference);await f.emit();const chunks=f.for('chunk'),bytes=Buffer.from(chunks[0].body.pcm,'base64');
 const actual=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);assert.deepEqual([...actual],[mic[0],reference[0],mic[1],reference[1],mic[2],reference[2]]);
 assert.deepEqual(chunks.map(c=>c.body.sequence),[0,1]);assert.equal(chunks[1].body.id,chunks[0].body.id);assert.equal(Buffer.from(chunks[1].body.pcm,'base64').byteLength,6400*4);
});

test('playback echo and arbitrarily loud energy never pause without learned detection',async t=>{
 const f=await speaking(t);for(let i=0;i<8;i++)await f.emit(frame(1),frame(1));
 assert.equal(f.handles.length,0);assert.equal(f.output.paused,false);assert.equal(f.voice.state,'barge-listening');assert.equal(f.for('start').length,0);assert.equal(f.voice.stats.bargeCandidates,0);
});

test('near-end candidate pauses output, drains the tail, then requires fresh mono wake evidence',async t=>{
 const f=await speaking(t),owned=f.output;await candidate(f);assert.equal(f.output.paused,true);assert.equal(f.handles.length,1);assert.equal(f.for('wake/start').length,1);assert.equal(f.mics[0].released,1);assert.deepEqual(f.mics[0].retired,[]);
 const chunks=f.for('chunk').length;await f.emit(frame(1),frame(1));assert.equal(f.for('chunk').length,chunks);
 await f.tick(1199);assert.equal(f.voice.state,'barge-quiet');await f.tick(1);assert.equal(f.voice.state,'barge-confirm');assert.equal(f.for('wake/start').length,2);
 await f.emit(frame(1),frame(1));assert.equal(Buffer.from(f.for('chunk').at(-1).body.pcm,'base64').byteLength,3200*4);assert.equal(f.handles[0].cancels,0);assert.equal(f.for('start').length,0);
 f.plan('chunk',{detected:true});await f.emit();assert.equal(f.handles[0].cancels,1);assert.equal(f.voice.state,'listening');assert.equal(f.for('start').length,1);assert.equal(f.voice.stats.bargeConfirmed,1);assert.equal(f.maxInFlight,1);assert.deepEqual(f.mics[0].retired,[owned]);
});

test('confirmation deadline resumes its owned output without starting ASR',async t=>{
 const f=await speaking(t);await confirming(f);await f.emit();await f.tick(4999);assert.equal(f.handles[0].resumes,0);await f.emit();await f.tick(1);
 assert.equal(f.handles[0].resumes,1);assert.equal(f.handles[0].cancels,0);assert.equal(f.output.paused,false);assert.equal(f.voice.state,'barge-listening');assert.equal(f.for('start').length,0);assert.equal(f.for('barge/start').length,2);assert.deepEqual(f.mics[0].retired,[]);
});

test('a candidate without a pause handle cannot open ASR or confirmation',async t=>{
 const f=await speaking(t);f.output.muted=true;f.plan('chunk',{detected:true});await f.emit();await f.tick(0);assert.equal(f.handles.length,0);assert.equal(f.for('start').length,0);assert.equal(f.for('wake/start').length,1);assert.equal(f.voice.state,'barge-listening');
});

for(const phase of ['candidate','confirmation'])test(`late ${phase} detection cannot interrupt replacement output`,async t=>{
 const f=await speaking(t);if(phase==='confirmation')await confirming(f);const pending=deferred();f.plan('chunk',pending);await f.emit();
 const old=f.output,replacement=f.speak();pending.resolve({detected:true});await settle();await f.tick(100);
 assert.equal(f.output,replacement);assert.equal(replacement.paused,false);assert.equal(old.paused,phase==='confirmation');assert.equal(f.handles.length,phase==='confirmation'?1:0);assert.equal(f.for('start').length,0);assert.equal(f.voice.state,'barge-listening');
});

test('output ending during a candidate request discards the candidate and rearms mono',async t=>{
 const f=await speaking(t),pending=deferred(),owned=f.output;f.plan('chunk',pending);await f.emit();f.end();pending.resolve({detected:true});await settle();await f.tick(800);
 assert.equal(f.handles.length,0);assert.equal(f.voice.state,'idle');assert.equal(f.for('start').length,0);assert.equal(f.for('wake/start').length,2);assert.deepEqual(f.mics[0].retired,[owned]);
});

for(const fault of ['muted','zero-volume','ended'])test(`confirmation cannot automatically resume ${fault} output`,async t=>{
 const f=await speaking(t);await confirming(f);if(fault==='muted')f.output.muted=true;if(fault==='zero-volume')f.output.volume=0;if(fault==='ended')f.output.ended=true;
 await f.emit();await f.tick(5000);assert.equal(f.output.paused,true);assert.equal(f.voice.state,'idle');assert.equal(f.for('start').length,0);assert.equal(f.handles[0].cancels,0);
});

test('device loss during confirmation closes everything and prevents delayed resume',async t=>{
 const f=await speaking(t);await confirming(f);const timeout=f.timer('barge-confirm').fn;f.mics[0].fail(Error('device removed'));await settle();timeout();await f.tick(5000);
 assert.equal(f.voice.state,'error');assert.equal(f.voice.active,false);assert.equal(f.mics[0].closed,1);assert.equal(f.handles[0].resumes,0);assert.equal(f.handles[0].cancels,0);assert.equal(f.for('start').length,0);assert.equal(f.timers.size,0);
});

for(const reference of [null,new Float32Array(1),frame(NaN),frame(1.1)])test(`invalid aligned reference ${reference===null?'null':reference[0]} fails closed`,async t=>{
 const f=await speaking(t);await f.emit(frame(.03),reference);assert.equal(f.voice.state,'error');assert.equal(f.mics[0].closed,1);assert.equal(f.handles.length,0);assert.equal(f.errors.length,1);
});

test('a pre-reference ADC frame is ignored without sending mono bytes to the barge worker',async t=>{
 const f=await speaking(t);f.mics[0].emit(frame(.03));await settle();assert.equal(f.for('chunk').length,0);assert.equal(f.voice.state,'barge-listening');assert.equal(f.handles.length,0);
});

test('duplex backlog holds ten queued frames and fails closed on the eleventh',async t=>{
 const f=await speaking(t),pending=deferred();f.plan('chunk',pending);await f.emit();for(let i=0;i<10;i++)await f.emit();assert.equal(f.voice.stats.maxQueued,10);assert.equal(f.voice.state,'barge-listening');assert.equal(f.for('chunk').length,1);
 await f.emit();assert.equal(f.voice.state,'error');assert.equal(f.voice.stats.overflows,1);assert.equal(f.mics[0].closed,1);pending.resolve({detected:true});await settle();assert.equal(f.handles.length,0);assert.equal(f.for('start').length,0);
});

test('live duplex inference renews its worker lease at 110 seconds',async t=>{
 const f=await speaking(t);for(let i=0;i<109;i++){await f.emit();await f.tick(1000);}assert.equal(f.for('barge/start').length,1);await f.emit();await f.tick(1000);
 assert.equal(f.for('barge/start').length,2);assert.equal(f.voice.state,'barge-listening');assert.equal(f.for('start').length,0);assert.equal(f.handles.length,0);assert.equal(f.maxInFlight,1);
});

test('failed output reference attachment closes local resources without opening a barge worker',async t=>{
 const f=await enabled(t,{attach:false});f.speak();await f.tick(0);assert.equal(f.voice.state,'error');assert.equal(f.mics[0].closed,1);assert.equal(f.for('barge/start').length,0);assert.equal(f.errors.length,1);assert.equal(f.handles.length,0);
});

test('disable during a busy candidate ignores late detection and stale timers',async t=>{
 const f=await speaking(t),pending=deferred();f.plan('chunk',pending);await f.emit();const callbacks=[...f.timers.values()].map(v=>v.fn);await f.voice.disable();await f.voice.enable({bargeIn:true});const current=f.voice.session;
 pending.resolve({detected:true});for(const fn of callbacks)fn();await settle();assert.equal(f.voice.session,current);assert.equal(f.voice.state,'idle');assert.equal(f.handles.length,0);assert.equal(f.mics[1].closed,0);assert.equal(f.for('start').length,0);assert.equal(f.errors.length,0);
});

test('late barge start after disable releases its acquired worker id',async t=>{
 const f=await enabled(t),pending=deferred();f.plan('barge/start',pending);f.speak();await f.tick(0);assert.equal(f.for('barge/start').length,1);await f.voice.disable();pending.resolve({id:'late-barge'});await settle();
 assert.ok(f.for('cancel').some(c=>c.body.id==='late-barge'));assert.equal(f.voice.state,'off');assert.equal(f.handles.length,0);assert.equal(f.timers.size,0);
});

test('speaking while a mono chunk is busy serializes barge start behind it',async t=>{
 const f=await enabled(t),pending=deferred();f.plan('chunk',pending);await f.emit();f.speak();await f.tick(0);assert.equal(f.for('barge/start').length,0);pending.resolve({detected:true});await settle();await f.tick(100);
 assert.equal(f.voice.state,'barge-listening');assert.equal(f.for('start').length,0);assert.equal(f.handles.length,0);assert.equal(f.maxInFlight,1);
});

test('a stale confirmation deadline cannot resume a replacement candidate',async t=>{
 const f=await speaking(t);await confirming(f);const oldTimeout=f.timer('barge-confirm').fn;f.speak();await f.tick(0);await confirming(f);const replacement=f.handles[1];
 oldTimeout();await settle();assert.equal(replacement.resumes,0);assert.equal(f.voice.state,'barge-confirm');assert.equal(f.for('start').length,0);
});

test('output replacement while confirmation worker opens preserves the replacement owner',async t=>{
 const f=await speaking(t);await candidate(f);const pending=deferred();f.plan('wake/start',pending);await f.tick(1200);assert.equal(f.voice.state,'barge-quiet');const replacement=f.speak();
 pending.resolve({id:'old-confirmation'});await settle();await f.tick(100);assert.equal(f.output,replacement);assert.equal(replacement.paused,false);assert.equal(f.voice.state,'barge-listening');assert.equal(f.handles[0].resumes,0);assert.equal(f.handles[0].cancels,0);assert.equal(f.for('start').length,0);assert.ok(f.for('cancel').some(c=>c.body.id==='old-confirmation'));assert.equal(f.maxInFlight,1);
});

test('disable during a pending confirmation request cannot publish a wake into a new session',async t=>{
 const f=await speaking(t);await confirming(f);const pending=deferred();f.plan('chunk',pending);await f.emit();await f.voice.disable();await f.voice.enable({bargeIn:true});const current=f.voice.session;
 pending.resolve({detected:true});await settle();assert.equal(f.voice.session,current);assert.equal(f.voice.state,'idle');assert.equal(f.handles[0].cancels,0);assert.equal(f.handles[0].resumes,0);assert.equal(f.for('start').length,0);assert.equal(f.errors.length,0);
});

test('manual mute notification during confirmation cannot create ASR or restore playback',async t=>{
 const f=await speaking(t);await confirming(f);f.output.muted=true;f.voice.setSpeaking(false);await f.emit();await f.tick(5000);assert.equal(f.output.paused,true);assert.equal(f.voice.state,'idle');assert.equal(f.for('start').length,0);assert.equal(f.handles[0].cancels,0);
});

for(const phase of ['candidate','confirmation'])test(`invalid ${phase} detection response fails closed`,async t=>{
 const f=await speaking(t);if(phase==='confirmation')await confirming(f);f.plan('chunk',{detected:'true'});await f.emit();assert.equal(f.voice.state,'error');assert.equal(f.mics[0].closed,1);assert.equal(f.for('start').length,0);assert.equal(f.errors.length,1);assert.equal(f.handles[0]?.cancels||0,0);
});

test('frames concurrent with near-end detection are discarded before fresh confirmation',async t=>{
 const f=await speaking(t),pending=deferred();f.plan('chunk',pending);await f.emit();for(let i=0;i<8;i++)await f.emit(frame(.9),frame(.7));pending.resolve({detected:true});await settle();
 assert.equal(f.voice.state,'barge-quiet');assert.equal(f.for('chunk').length,1);await f.tick(1200);assert.equal(f.voice.state,'barge-confirm');assert.equal(f.for('chunk').length,1);assert.equal(f.for('start').length,0);
 f.plan('chunk',{detected:true});await f.emit();assert.equal(f.voice.state,'listening');assert.equal(f.for('start').length,1);
});

test('a stale acoustic tail cannot open confirmation before a replacement tail ends',async t=>{
 const f=await speaking(t);await candidate(f);const oldTail=f.timer('barge-tail').fn;f.speak();await f.tick(0);await candidate(f);const starts=f.for('wake/start').length;
 oldTail();await settle();assert.equal(f.for('wake/start').length,starts);assert.equal(f.voice.state,'barge-quiet');await f.tick(1200);assert.equal(f.voice.state,'barge-confirm');
});

/** Black-box regressions for Rust runtime admission and lifecycle control.
 * Real native Store/approvals/receipts, deterministic inner steps, no network,
 * external processes, model servers, paid APIs or production timer waits. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry} from '../core/provider-registry.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';
import {NOTICE} from '../core/agent/prompts.mjs';

const realSetTimeout=globalThis.setTimeout;
const delay=ms=>new Promise(resolve=>realSetTimeout(resolve,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(predicate,label='condition',timeout=3000){
 const start=Date.now();
 for(;;){const result=predicate();if(result)return result;if(Date.now()-start>=timeout)throw new Error('Timed out waiting for '+label);await delay(5);}
}
async function settles(promise,label){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=realSetTimeout(()=>reject(new Error('Timed out waiting for '+label)),3000);})]);}
 finally{clearTimeout(timer);}
}

/** Capture long retry callbacks, including cleared callbacks already queued by
 * the host. Short yields remain real, so async scheduling stays representative. */
function retryTimers(t,clock){
 const records=[],originalClear=globalThis.clearTimeout;
 t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
  if(ms<1000)return realSetTimeout(callback,ms,...args);
  const timer={ms,deadline:clock.now+ms,cleared:false,fired:false,unref(){return this;},ref(){return this;}};
  timer.fire=()=>{timer.fired=true;callback(...args);};records.push(timer);return timer;
 });
 t.mock.method(globalThis,'clearTimeout',timer=>{if(records.includes(timer))timer.cleared=true;else originalClear(timer);});
 return {records,advanceTo(timer){clock.now=timer.deadline;timer.fire();}};
}

async function fixture(t,{settings={},timers=false}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-rust-runtime-'));
 const clock={now:Date.now()},gates=[],events=[];
 const f={dir,clock,events,gate(){const gate=deferred();gates.push(gate);return gate;}};
 if(timers)f.timers=retryTimers(t,clock);
 function open(){
  const store=new Store(dir),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network);
  if(!store.value('agent-settings'))store.value('agent-settings',{verifyCompletion:'off',metacognition:false,dream:false,delegationGuard:false,heartbeat:{enabled:false},...settings});
  registry.invoke=async()=>{throw new Error('A runtime fixture must not invoke a provider');};
  const rt=new AgentRuntime(store,{registry,network,workRoot:path.join(dir,'work'),clock:()=>clock.now,autoStart:false});
  rt.decisions.available=()=>false;
  rt.decisions.yes=async()=>{throw new Error('Unexpected decision invocation');};
  store.listeners.add(event=>events.push(event));Object.assign(f,{rt,store,network,registry});
 }
 open();
 f.reopen=async()=>{await f.rt.close();f.registry.close();f.network.close();f.store.close();open();};
 f.session=({kind='worker',task='Complete the fixture task',extra={},...fields}={})=>{
  const s=f.rt.sessions.create({kind,title:'Runtime fixture',cwd:dir,toolset:kind==='main'?'main':'lean',...fields,extra});
  if(task)f.rt.sessions.append(s.id,'input',{text:task,kind:'task',from:'user'});
  return s;
 };
 t.after(async()=>{
  // Resolve fixture barriers even after an assertion fails; cleanup must not
  // turn a useful failure into a hung test process.
  for(const gate of gates)gate.resolve();f.rt.policy.cancelAll();
  await settles(f.rt.close(),'fixture shutdown');
  f.registry.close();f.network.close();f.store.close();await rm(dir,{recursive:true,force:true});
 });
 return f;
}
function answer(rt,id,text='fixture complete'){
 const s=rt.sessions.get(id);
 rt.sessions.append(id,'assistant',{content:text,toolCalls:[]});
 rt.sessions.update(id,{stats:{...s.stats,steps:(s.stats?.steps||0)+1}});
 return {turnEnded:true,text};
}
const results=(rt,id)=>rt.sessions.entries(id,{types:['tool']});
const finished=(f,id)=>f.events.filter(e=>e.type==='agent.finished'&&e.data.sessionId===id);
const replies=(f,id)=>f.events.filter(e=>e.type==='agent.reply'&&e.data.sessionId===id);
const idle=rt=>!rt.runs.size;
const call=(id,name,args={})=>({id,name,arguments:JSON.stringify(args)});
function tool(rt,name,run,extra={}){rt.tools.register({name,description:'Runtime lifecycle fixture',parameters:{type:'object',properties:{}},run,...extra});}

test('Rust runtime: duplicate wakes reserve workers exactly once and leave a main lane at capacity 0/1/N',async t=>{
 for(const capacity of [0,1,3])await t.test('capacity '+capacity,async t=>{
  const f=await fixture(t,{settings:{concurrency:capacity}}),{rt}=f;
  const workers=Array.from({length:4},()=>f.session()),main=f.session({kind:'main'}),started=[],gates=new Map();
  rt.loop.step=async(id,signal)=>{started.push(id);const gate=f.gate();gates.set(id,gate);await gate.promise;signal.throwIfAborted();return answer(rt,id);};
  for(const s of [...workers,main]){rt.wake(s.id);rt.wake(s.id);rt.wake(s.id);}
  assert.equal(rt.runs.size,capacity+1,'slots are reserved before wake returns');
  await until(()=>started.length===capacity+1,'initial admitted steps');
  assert.equal(new Set(started).size,started.length);assert.ok(started.includes(main.id));
  assert.equal(workers.filter(s=>rt.sessions.get(s.id).status==='waiting').length,4-capacity);
  gates.get(main.id).resolve();await until(()=>!rt.runs.has(main.id),'main release');
  assert.equal(started.length,capacity+1,'releasing the main lane does not create a worker slot');
  if(capacity===0){rt.configure({concurrency:1});await until(()=>started.length===2,'capacity settings admit waiting work');}
  while(workers.some(s=>rt.sessions.get(s.id).status!=='done')){
   const current=workers.find(s=>rt.runs.has(s.id));assert.ok(current,'an eligible worker owns the next slot');
   const expected=rt.sessions.list({status:'waiting'}).filter(s=>workers.some(w=>w.id===s.id)).map(s=>s.id),before=started.length;
   await until(()=>gates.has(current.id),'admitted worker enters its step');gates.get(current.id).resolve();await until(()=>!rt.runs.has(current.id),'worker release');
   if(expected.length){await until(()=>started.length>before,'next deferred admission');assert.equal(started[before],expected[0],'deferred work follows the current catalog order');}
  }
  await until(()=>idle(rt),'all leases drain');
  assert.equal(started.length,workers.length+1);assert.equal(new Set(started).size,started.length);
  for(const s of workers)assert.equal(finished(f,s.id).length,1);
 });
});

test('Rust runtime: needsStep preserves passive/event/checkpoint/clear and last-twelve semantics',async t=>{
 const f=await fixture(t),{rt}=f;
 const cases=[
  ['empty',[],false],
  ['input',[['input',{text:'hello'}]],true],
  ['answer',[['input',{text:'hello'}],['assistant',{content:'done'}]],false],
  ['tool calls',[['assistant',{toolCalls:[call('x','read')]}]],true],
  ['truncation',[['assistant',{content:'partial',truncated:true}]],true],
  ['tool receipt',[['tool',{callId:'x',content:'result'}]],true],
  ['notice',[['notice',{text:'continue'}]],true],
  ['passive only',[['input',{text:'context only',passive:true}]],false],
  ['ignored after answer',[['assistant',{content:'done'}],['event',{}],['checkpoint',{}],['clear',{}],['input',{text:'passive',passive:true}]],false],
  ['ignored after input',[['input',{text:'continue'}],['event',{}],['checkpoint',{}],['clear',{}],['input',{text:'passive',passive:true}]],true],
  ['twelve-record boundary',[['input',{text:'outside tail'}],...Array.from({length:12},()=>['event',{}])],false]
 ];
 for(const [label,entries,expected] of cases){const s=f.session({task:null});for(const [type,body] of entries)rt.sessions.append(s.id,type,body);assert.equal(rt.needsStep(s.id),expected,label);}
});

test('Rust runtime: session and daily budgets retry once per token and resume on a raised limit',async t=>{
 for(const kind of ['sessionUsd','dailyUsd'])await t.test(kind,async t=>{
  const f=await fixture(t,{settings:{budget:{[kind]:1}},timers:true}),{rt}=f,s=f.session();let steps=0;
  if(kind==='sessionUsd')rt.sessions.update(s.id,{stats:{...s.stats,cost:1}});
  else f.store.value('agent-usage:'+new Date(f.clock.now).toISOString().slice(0,10),{cost:1});
  rt.loop.step=async id=>{steps++;return answer(rt,id);};rt.wake(s.id);
  await until(()=>rt.timers.has(s.id)&&!rt.runs.has(s.id),'budget release');
  const first=rt.timers.get(s.id);assert.equal(first.ms,600000);assert.equal(steps,0);
  assert.equal(rt.sessions.get(s.id).status,'waiting');assert.equal(rt.sessions.get(s.id).retryAt,null);
  f.timers.advanceTo(first);await until(()=>rt.timers.has(s.id)&&rt.timers.get(s.id)!==first&&!rt.runs.has(s.id),'budget recheck');
  const second=rt.timers.get(s.id);assert.equal(second.ms,600000);assert.equal(steps,0);
  rt.configure({budget:{[kind]:2}});await until(()=>rt.sessions.get(s.id).status==='done'&&!rt.runs.has(s.id),'raised budget continuation');
  assert.equal(second.cleared,true);assert.equal(steps,1);assert.equal(rt.timers.has(s.id),false);
  first.fire();second.fire();await delay(20);assert.equal(steps,1);assert.equal(finished(f,s.id).length,1);
 });
});

test('Rust runtime: replaced, stopped and closed provider-retry callbacks cannot admit work',async t=>{
 const f=await fixture(t,{timers:true}),{rt}=f,s=f.session();let steps=0;
 rt.loop.step=async id=>{steps++;return steps<3?{wait:steps===1?5000:9000,note:'provider unavailable'}:answer(rt,id);};
 rt.wake(s.id);await until(()=>rt.timers.has(s.id)&&!rt.runs.has(s.id),'first retry');const old=rt.timers.get(s.id);
 assert.equal(rt.sessions.get(s.id).retryAt,new Date(f.clock.now+5000).toISOString());
 rt.wake(s.id);await until(()=>rt.timers.has(s.id)&&rt.timers.get(s.id)!==old&&!rt.runs.has(s.id),'replacement retry');const current=rt.timers.get(s.id);
 assert.equal(old.cleared,true);old.fire();await delay(20);assert.equal(steps,2);assert.equal(rt.timers.get(s.id),current);
 rt.stop(s.id,'cancel retry');current.fire();await delay(20);assert.equal(steps,2);assert.equal(rt.sessions.get(s.id).status,'stopped');assert.equal(rt.timers.has(s.id),false);
 await rt.close();old.fire();current.fire();rt.wake(s.id);rt.resume(s.id);await delay(20);assert.equal(steps,2);assert.equal(rt.runs.size,0);
});

test('Rust runtime: stop withdraws approval and retains its worker slot until receipt and cleanup drain',async t=>{
 const f=await fixture(t,{settings:{concurrency:1,policy:{rules:[{tool:'runtime_write',action:'ask'}]}}}),{rt}=f;
 const stopped=f.session(),waiting=f.session(),drain=f.gate(),started=[];let writes=0,innerSettled=false;
 tool(rt,'runtime_write',async()=>{writes++;return 'unexpected';});
 rt.loop.step=async(id,signal)=>{
  started.push(id);if(id===waiting.id)return answer(rt,id);
  const calls=[call('approval','runtime_write')];rt.sessions.append(id,'assistant',{content:'',toolCalls:calls});
  try{await rt.loop.runTools(rt.sessions.get(id),calls,{signal,B:12000});}
  finally{innerSettled=true;await drain.promise;}
  signal.throwIfAborted();return {turnEnded:true,text:'unexpected'};
 };
 rt.wake(stopped.id);rt.wake(waiting.id);
 const approval=await until(()=>rt.policy.list().find(a=>a.status==='pending'),'pending approval'),old=rt.runs.get(stopped.id);
 rt.stop(stopped.id,'user stopped');
 assert.equal(old.controller.signal.aborted,true);assert.equal(rt.sessions.get(stopped.id).status,'stopped');assert.equal(rt.sessions.get(stopped.id).note,'user stopped');
 assert.equal(rt.policy.list().find(a=>a.id===approval.id).status,'withdrawn');
 await until(()=>innerSettled&&results(rt,stopped.id).length===1,'interrupted receipt');
 assert.equal(rt.runs.get(stopped.id),old,'cleanup still owns the old handle');assert.deepEqual(started,[stopped.id]);
 const receipt=results(rt,stopped.id)[0];assert.equal(receipt.notExecuted,true);assert.equal(receipt.interrupted,true);assert.equal(writes,0);
 drain.resolve();await until(()=>rt.sessions.get(waiting.id).status==='done'&&idle(rt),'next worker after drain');
 assert.equal(rt.sessions.get(stopped.id).note,'user stopped');assert.equal(finished(f,stopped.id).length,0);assert.deepEqual(started,[stopped.id,waiting.id]);
});

test('Rust runtime: synchronous Stop from approval publication cannot strand its promise or restore a waiting note',async t=>{
 const f=await fixture(t,{settings:{policy:{rules:[{tool:'runtime_write',action:'ask'}]}}}),{rt}=f,s=f.session();let approvalId=null,writes=0;
 tool(rt,'runtime_write',async()=>{writes++;return 'unexpected';});
 const listener=event=>{if(event.type==='approval.updated'&&event.data.sessionId===s.id&&event.data.status==='pending'){approvalId=event.data.id;rt.stop(s.id,'stopped by approval listener');}};
 f.store.listeners.add(listener);t.after(()=>f.store.listeners.delete(listener));
 rt.loop.step=async(id,signal)=>{const calls=[call('reentrant','runtime_write')];rt.sessions.append(id,'assistant',{content:'',toolCalls:calls});await rt.loop.runTools(rt.sessions.get(id),calls,{signal,B:12000});return {};};
 rt.wake(s.id);await until(()=>approvalId&&idle(rt),'synchronous approval cancellation drains');
 assert.equal(rt.policy.pending.size,0);assert.equal(f.store.get('approval',approvalId).status,'withdrawn');assert.equal(writes,0);
 assert.equal(rt.sessions.get(s.id).status,'stopped');assert.equal(rt.sessions.get(s.id).note,'stopped by approval listener');
 const receipts=results(rt,s.id);assert.equal(receipts.length,1);assert.equal(receipts[0].notExecuted,true);assert.equal(receipts[0].interrupted,true);assert.equal(finished(f,s.id).length,0);
});

test('Rust runtime: sessions_spawn cannot create a child when provider limits resolve after its caller stops',async t=>{
 const f=await fixture(t),{rt}=f,s=f.session({kind:'main'}),limits=f.gate();let limitCalls=0;
 f.registry.chain=()=>[{id:'fixture',identity:'fixture'}];f.registry.limits=async()=>{limitCalls++;return limits.promise;};
 rt.loop.step=async(id,signal)=>{const calls=[call('spawn','sessions_spawn',{task:'child must not start'})];rt.sessions.append(id,'assistant',{content:'',toolCalls:calls});await rt.loop.runTools(rt.sessions.get(id),calls,{signal,B:12000});return {};};
 rt.wake(s.id);await until(()=>limitCalls===1,'spawn awaits provider limits');const old=rt.runs.get(s.id);
 rt.stop(s.id,'cancel spawning');assert.equal(old.controller.signal.aborted,true);assert.equal(rt.sessions.list({parentId:s.id}).length,0);
 limits.resolve({context:32000,source:'config'});await until(()=>idle(rt),'late spawn resolution drains');
 assert.equal(rt.sessions.list({parentId:s.id}).length,0);assert.equal(rt.sessions.list().length,1);assert.equal(rt.sessions.get(s.id).note,'cancel spawning');
 const receipts=results(rt,s.id);assert.equal(receipts.length,1);assert.equal(receipts[0].callId,'spawn');assert.equal(receipts[0].interrupted,true);assert.equal(replies(f,s.id).length,0);
});

test('Rust runtime: repeated explicit resume during drain creates one fresh run and ignores an old wait result',async t=>{
 const f=await fixture(t,{settings:{concurrency:1},timers:true}),{rt}=f,s=f.session(),oldGate=f.gate(),newGate=f.gate(),signals=[];let active=0,maxActive=0;
 rt.loop.step=async(id,signal)=>{
  signals.push(signal);active++;maxActive=Math.max(maxActive,active);
  try{if(signals.length===1){await oldGate.promise;return {wait:10000,note:'obsolete provider error'};}await newGate.promise;signal.throwIfAborted();return answer(rt,id,'new run complete');}
  finally{active--;}
 };
 rt.wake(s.id);await until(()=>signals.length===1,'old run');const old=rt.runs.get(s.id);
 rt.stop(s.id,'stop old');rt.resume(s.id);rt.resume(s.id);rt.resume(s.id);
 assert.equal(rt.runs.get(s.id),old);await delay(20);assert.equal(signals.length,1);
 oldGate.resolve();await until(()=>signals.length===2,'resumed run after drain');const current=rt.runs.get(s.id);
 assert.notEqual(current,old);assert.notEqual(current.controller,old.controller);assert.equal(maxActive,1);
 await old.promise;await delay(20);assert.equal(rt.runs.get(s.id),current,'the old finalizer cannot delete a newer handle');assert.equal(rt.timers.has(s.id),false);
 assert.equal(rt.sessions.get(s.id).status,'running');assert.notEqual(rt.sessions.get(s.id).note,'obsolete provider error');
 newGate.resolve();await until(()=>idle(rt),'new run release');assert.equal(signals.length,2);assert.equal(rt.sessions.get(s.id).result,'new run complete');assert.equal(finished(f,s.id).length,1);
});

test('Rust runtime: resume from an abort-driven stream event survives the enclosing Stop and waits for its old lease',async t=>{
 const f=await fixture(t),{rt}=f,s=f.session(),oldStep=f.gate(),newStep=f.gate();let steps=0,resumes=0,active=0,maxActive=0;
 const listener=event=>{
  if(event.type==='agent.delta'&&event.data.sessionId===s.id&&event.data.done&&resumes===0){resumes++;rt.resume(s.id);}
 };
 f.store.listeners.add(listener);t.after(()=>f.store.listeners.delete(listener));
 rt.loop.step=async(id,signal)=>{
  steps++;active++;maxActive=Math.max(maxActive,active);
  try{
   if(steps===1){rt.stream(id,'text','buffered before stop');await oldStep.promise;return {turnEnded:true,text:'stale stopped report'};}
   await newStep.promise;signal.throwIfAborted();return answer(rt,id,'resumed report');
  }finally{active--;}
 };
 rt.wake(s.id);await until(()=>steps===1,'old streamed step');const old=rt.runs.get(s.id);
 rt.stop(s.id,'stop with reentrant resume');assert.equal(resumes,1);assert.equal(old.controller.signal.aborted,true);
 assert.equal(rt.sessions.get(s.id).status,'idle','the queued explicit resume applies after all stopped-state actions');assert.equal(rt.runs.get(s.id),old);
 await delay(20);assert.equal(steps,1,'the resume cannot reuse a draining lease');
 oldStep.resolve();await until(()=>steps===2,'resumed step after old drain');const current=rt.runs.get(s.id);
 assert.notEqual(current,old);await settles(old.promise,'old streamed lease release');assert.equal(rt.runs.get(s.id),current);assert.equal(rt.sessions.get(s.id).status,'running');assert.equal(maxActive,1);
 newStep.resolve();await until(()=>idle(rt),'resumed streamed turn completion');assert.equal(steps,2);assert.equal(finished(f,s.id).length,1);assert.equal(rt.sessions.get(s.id).result,'resumed report');
});

test('Rust runtime: explicit user input from an abort listener survives Stop and runs once after the old drain',async t=>{
 const f=await fixture(t),{rt}=f,s=f.session(),oldStep=f.gate(),newStep=f.gate();let steps=0,sends=0,active=0,maxActive=0;
 const listener=event=>{
  if(event.type==='agent.delta'&&event.data.sessionId===s.id&&event.data.done&&sends===0){sends++;rt.send(s.id,{text:'New instruction during Stop',from:'user'});}
 };
 f.store.listeners.add(listener);t.after(()=>f.store.listeners.delete(listener));
 rt.loop.step=async(id,signal)=>{
  steps++;active++;maxActive=Math.max(maxActive,active);
  try{
   if(steps===1){rt.stream(id,'text','cancelled partial response');await oldStep.promise;return {turnEnded:true,text:'obsolete report'};}
   await newStep.promise;signal.throwIfAborted();return answer(rt,id,'new instruction completed');
  }finally{active--;}
 };
 rt.wake(s.id);await until(()=>steps===1,'old step before reentrant input');const old=rt.runs.get(s.id);
 rt.stop(s.id,'stop before new input');assert.equal(sends,1);assert.equal(rt.sessions.get(s.id).status,'idle');assert.equal(rt.runs.get(s.id),old);
 assert.equal(rt.sessions.pending(s.id).filter(e=>e.text==='New instruction during Stop').length,1);await delay(20);assert.equal(steps,1);
 oldStep.resolve();await until(()=>steps===2,'new instruction admitted after old drain');const current=rt.runs.get(s.id);
 assert.notEqual(current,old);await settles(old.promise,'old lease after reentrant user input');assert.equal(rt.runs.get(s.id),current);assert.equal(maxActive,1);
 newStep.resolve();await until(()=>idle(rt),'reentrant user instruction completion');
 assert.equal(steps,2);assert.equal(finished(f,s.id).length,1);assert.equal(rt.sessions.get(s.id).result,'new instruction completed');
 assert.equal(rt.sessions.pending(s.id).length,0);assert.equal(rt.sessions.entries(s.id,{types:['input']}).filter(e=>e.text==='New instruction during Stop').length,1);
});

test('Rust runtime: child input and unspecified wake from an abort listener cannot revive stopped work',async t=>{
 for(const source of ['child','unspecified'])await t.test(source,async t=>{
  const f=await fixture(t),{rt}=f,s=f.session(),oldStep=f.gate();let steps=0,wakes=0;
  const listener=event=>{
   if(event.type==='agent.delta'&&event.data.sessionId===s.id&&event.data.done&&wakes===0){
    wakes++;if(source==='child')rt.send(s.id,{text:'Ordinary child report',from:'child:fixture',kind:'report'});else rt.wake(s.id);
   }
  };
  f.store.listeners.add(listener);t.after(()=>f.store.listeners.delete(listener));
  rt.loop.step=async id=>{steps++;rt.stream(id,'text','stopped partial response');await oldStep.promise;return {turnEnded:true,text:'must not publish'};};
  rt.wake(s.id);await until(()=>steps===1,'old step before untrusted wake');const old=rt.runs.get(s.id);
  rt.stop(s.id,'stay stopped');assert.equal(wakes,1);assert.equal(rt.sessions.get(s.id).status,'stopped');assert.equal(rt.sessions.get(s.id).note,'stay stopped');
  oldStep.resolve();await settles(old.promise,'unresumed old lease');await until(()=>idle(rt),'stopped lease drains');rt.wake(s.id);await delay(20);
  assert.equal(steps,1);assert.equal(rt.sessions.get(s.id).status,'stopped');assert.equal(finished(f,s.id).length,0);assert.equal(rt.sessions.pending(s.id).length,source==='child'?1:0);
 });
});

test('Rust runtime: main rearm does not restart a cancelled turn but accepts the next user message',async t=>{
 const f=await fixture(t),{rt}=f,s=f.session({kind:'main'}),gate=f.gate();let steps=0;
 rt.loop.step=async(id,signal)=>{steps++;if(steps===1){await gate.promise;return {turnEnded:true,text:'obsolete answer'};}signal.throwIfAborted();return answer(rt,id,'fresh answer');};
 rt.wake(s.id);await until(()=>steps===1,'main step');rt.stop(s.id,'cancel main');rt.resume(s.id,{mode:'rearm'});
 assert.equal(rt.sessions.get(s.id).status,'idle');gate.resolve();await until(()=>idle(rt),'cancelled main drain');
 await delay(20);assert.equal(steps,1);assert.equal(replies(f,s.id).length,0);assert.equal(rt.sessions.get(s.id).status,'idle');
 rt.send(s.id,{text:'A new message',from:'user'});await until(()=>steps===2&&idle(rt),'fresh main message');
 assert.deepEqual(replies(f,s.id).map(e=>e.data.text),['fresh answer']);assert.equal(rt.sessions.pending(s.id).length,0);
});

test('Rust runtime: stop cascades through eligible worker children but leaves specialists and completed children alone',async t=>{
 const f=await fixture(t),{rt}=f,parent=f.session({kind:'main'});
 const children=['running','waiting','idle'].map(status=>f.session({parentId:parent.id,extra:{status}}));
 const grandchild=f.session({parentId:children[1].id}),done=f.session({parentId:parent.id,extra:{status:'done',result:'saved'}});
 const specialist=f.session({kind:'specialist',parentId:parent.id,extra:{status:'running'}});
 rt.stop(parent.id,'stop family');assert.equal(rt.sessions.get(parent.id).note,'stop family');
 for(const s of [...children,grandchild]){assert.equal(rt.sessions.get(s.id).status,'stopped');assert.equal(rt.sessions.get(s.id).note,'parent stopped');}
 assert.equal(rt.sessions.get(done.id).status,'done');assert.equal(rt.sessions.get(done.id).result,'saved');assert.equal(rt.sessions.get(specialist.id).status,'running');
});

test('Rust runtime: a late completion verdict cannot publish or append a verify notice after stop',async t=>{
 const f=await fixture(t,{settings:{verifyCompletion:'auto'}}),{rt}=f,s=f.session({extra:{stats:{steps:0,toolCalls:1}}}),verdict=f.gate();let decisions=0;
 rt.decisions.available=()=>true;rt.decisions.yes=async()=>{decisions++;return verdict.promise;};
 rt.loop.step=async id=>answer(rt,id,'proposed report');rt.wake(s.id);await until(()=>decisions===1,'completion decision');
 rt.stop(s.id,'stop verification');const before=rt.sessions.entries(s.id);verdict.resolve(0);
 await until(()=>idle(rt),'old decision drain');assert.equal(rt.sessions.get(s.id).status,'stopped');assert.equal(rt.sessions.get(s.id).note,'stop verification');
 assert.deepEqual(rt.sessions.entries(s.id),before);assert.equal(finished(f,s.id).length,0);assert.equal(rt.sessions.get(s.id).result,null);
});

test('Rust runtime: a late main route verdict cannot delegate or reply after stop and rearm',async t=>{
 const f=await fixture(t,{settings:{delegationGuard:true}}),{rt}=f,s=f.session({kind:'main',task:null}),verdict=f.gate();let decisions=0,steps=0,spawned=0;
 rt.decisions.available=()=>true;rt.decisions.yes=async()=>{decisions++;return verdict.promise;};
 rt.spawn=async()=>{spawned++;throw new Error('A stale route must not spawn');};
 rt.loop.step=async id=>{steps++;return answer(rt,id,'obsolete response');};rt.send(s.id,{text:'Perform this fixture task',from:'user'});
 await until(()=>decisions===1&&steps===1,'held main reply');rt.stop(s.id,'stop route');rt.resume(s.id,{mode:'rearm'});
 const before=rt.sessions.entries(s.id);verdict.resolve(1);await until(()=>idle(rt),'route decision drain');await delay(20);
 assert.equal(spawned,0);assert.equal(replies(f,s.id).length,0);assert.equal(steps,1);assert.deepEqual(rt.sessions.entries(s.id),before);
});

test('Rust runtime: close cancels every approval before awaiting drains and keeps Store open for receipts',async t=>{
 const f=await fixture(t,{settings:{concurrency:2,policy:{rules:[{tool:'runtime_write',action:'ask'}]}}}),{rt}=f;
 const sessions=[f.session(),f.session()],drain=f.gate();let cancelled=0,receipts=0,closeResolved=false;
 rt.loop.step=async(id,signal)=>{
  const result=await rt.policy.check(rt.sessions.get(id),'runtime_write',{}, {signal});
  assert.equal(result,'declined');assert.equal(signal.aborted,true);cancelled++;await drain.promise;
  rt.sessions.append(id,'tool',{callId:'cancelled-'+id,name:'runtime_write',content:'not dispatched',error:true,notExecuted:true,interrupted:true});receipts++;
  signal.throwIfAborted();return {};
 };
 for(const s of sessions)rt.wake(s.id);await until(()=>rt.policy.list().filter(a=>a.status==='pending').length===2,'two pending approvals');
 const closing=rt.close().then(()=>{closeResolved=true;});
 await until(()=>cancelled===2,'close cancels approvals without waiting on their promises');
 assert.equal(rt.policy.list().filter(a=>a.status==='pending').length,0);assert.ok(rt.policy.list().every(a=>a.status==='withdrawn'));
 assert.equal(closeResolved,false);assert.equal(receipts,0);
 for(const s of sessions){assert.notEqual(rt.sessions.get(s.id).status,'stopped','shutdown preserves recoverable session state');rt.wake(s.id);}
 drain.resolve();await settles(closing,'close drains receipt writes');assert.equal(receipts,2);assert.equal(rt.runs.size,0);
 for(const s of sessions)assert.equal(results(rt,s.id).length,1);
 const after=f.session();rt.wake(after.id);await delay(20);assert.equal(rt.runs.size,0);assert.equal(results(rt,after.id).length,0);
});

test('Rust runtime: close retains completed sibling tool receipts while withdrawing an approval',async t=>{
 const f=await fixture(t,{settings:{policy:{rules:[{tool:'runtime_ask',action:'ask'}]}}}),{rt}=f,s=f.session();let siblingCompleted=false,writes=0;
 tool(rt,'runtime_read',async()=>{siblingCompleted=true;return {text:'completed sibling',data:{proof:'kept'}};},{readOnly:true});
 tool(rt,'runtime_ask',async()=>{writes++;return 'unexpected';},{readOnly:true});
 rt.loop.step=async(id,signal)=>{const calls=[call('read','runtime_read'),call('ask','runtime_ask')];rt.sessions.append(id,'assistant',{content:'',toolCalls:calls});await rt.loop.runTools(rt.sessions.get(id),calls,{signal,B:12000});return {};};
 rt.wake(s.id);await until(()=>siblingCompleted&&rt.policy.list().some(a=>a.status==='pending'),'completed sibling and approval');
 await settles(rt.close(),'close with pending native tool group');
 const receipts=results(rt,s.id);assert.deepEqual(receipts.map(r=>r.callId),['read','ask']);assert.equal(receipts[0].error,false);assert.deepEqual(receipts[0].data,{proof:'kept'});
 assert.equal(receipts[1].notExecuted,true);assert.equal(writes,0);assert.equal(rt.policy.list()[0].status,'withdrawn');assert.equal(finished(f,s.id).length,0);
});

test('Rust runtime: idle compaction reserves before its first await and queues incoming work until release',async t=>{
 const f=await fixture(t,{settings:{idleCompactSeconds:0}}),{rt}=f,s=f.session({kind:'main',task:null}),budget=f.gate(),compact=f.gate(),step=f.gate();
 rt.sessions.append(s.id,'assistant',{content:'prior answer'});f.clock.now+=60000;
 let budgets=0,compacting=0,steps=0,overlap=false;
 rt.loop.prompt=session=>({...session,tools:session.tools||[]});
 rt.loop.budget=async()=>{budgets++;await budget.promise;return {chain:[{}],B:5000,ratio:1};};
 rt.assembler.build=()=>({});rt.compactor.plan=()=>({action:'compact'});
 rt.loop.compact=async()=>{compacting++;try{await compact.promise;}finally{compacting--;}};
 rt.loop.step=async(id,signal)=>{steps++;if(compacting)overlap=true;await step.promise;signal.throwIfAborted();return answer(rt,id);};
 const first=rt.idleCompact(s.id),second=rt.idleCompact(s.id);
 await until(()=>budgets===1,'one auxiliary lease');rt.send(s.id,{text:'Arrived during compaction',from:'user'});await delay(20);
 assert.equal(budgets,1);assert.equal(steps,0,'normal work cannot overlap the asynchronous budget phase');
 budget.resolve();compact.resolve();await Promise.all([first,second]);await until(()=>steps===1,'input resumes after auxiliary release');
 assert.equal(overlap,false);const current=rt.runs.get(s.id);assert.ok(current);await delay(20);assert.equal(rt.runs.get(s.id),current);
 step.resolve();await until(()=>idle(rt),'main release');assert.equal(steps,1);assert.equal(rt.sessions.pending(s.id).length,0);
});

test('Rust runtime: inbox arriving synchronously during finish is delivered and each result reports once',async t=>{
 const f=await fixture(t),{rt}=f,parent=f.session({kind:'main',task:null,extra:{status:'stopped'}}),s=f.session({parentId:parent.id});let steps=0,sent=false;
 rt.loop.step=async id=>{steps++;return answer(rt,id,'report '+steps);};
 const listener=event=>{if(event.type==='agent.finished'&&event.data.sessionId===s.id&&!sent){sent=true;rt.send(s.id,{text:'One more item',from:'user'});rt.send(s.id,{text:'For reference only',from:'system',mode:'notify'});}};
 f.store.listeners.add(listener);t.after(()=>f.store.listeners.delete(listener));rt.wake(s.id);
 await until(()=>steps===2&&idle(rt),'followup received while finishing');
 assert.equal(rt.sessions.get(s.id).result,'report 2');assert.equal(rt.sessions.pending(s.id).length,0);assert.equal(finished(f,s.id).length,2);
 const inputs=rt.sessions.entries(s.id,{types:['input']});assert.equal(inputs.filter(e=>e.text==='One more item').length,1);assert.equal(inputs.find(e=>e.text==='For reference only').passive,true);
 const reports=rt.sessions.pending(parent.id).filter(e=>e.kind==='report');assert.deepEqual(reports.map(e=>e.text),['report 1','report 2']);
 rt.send(s.id,{text:'Passive after completion',mode:'notify'});await delay(20);assert.equal(steps,2);assert.equal(rt.sessions.get(s.id).status,'done');
});

test('Rust runtime: startup records uncertainty for missing calls before admission without replaying saved operations',async t=>{
 const f=await fixture(t),sessions=['running','waiting','stopped'].map(status=>f.session({extra:{status}}));
 for(const s of sessions){
  f.rt.sessions.append(s.id,'assistant',{content:'',toolCalls:[call('already','runtime_saved'),call('missing','runtime_saved')]});
  f.rt.sessions.append(s.id,'tool',{callId:'already',name:'runtime_saved',content:'known result',error:false});
 }
 f.rt.sessions.enqueue(sessions[2].id,{text:'queued before crash',from:'system',mode:'followup'});
 f.store.put('approval',{id:'saved-approval',sessionId:sessions[0].id,tool:'runtime_saved',args:{},status:'pending'});
 await f.reopen();const {rt}=f,started=[];let executions=0;
 tool(rt,'runtime_saved',async()=>{executions++;return 'must not replay';});
 rt.loop.step=async id=>{
  started.push(id);const receipts=results(rt,id);assert.deepEqual(receipts.map(r=>r.callId),['already','missing']);assert.equal(receipts[0].content,'known result');
  assert.equal(receipts[1].error,true);assert.match(receipts[1].errorText,/restart/);return answer(rt,id,'recovered without replay');
 };
 rt.start();await until(()=>started.length===2&&idle(rt),'recover eligible sessions');
 assert.equal(executions,0);assert.deepEqual(new Set(started),new Set(sessions.slice(0,2).map(s=>s.id)));assert.equal(f.store.get('approval','saved-approval').status,'withdrawn');
 for(const s of sessions){const receipts=results(rt,s.id);assert.equal(receipts.filter(r=>r.callId==='missing').length,1);assert.equal(receipts[1].error,true);assert.match(receipts[1].errorText,/restart/);}
 assert.equal(rt.sessions.get(sessions[2].id).status,'stopped');assert.equal(rt.sessions.pending(sessions[2].id).length,1);
});

test('Rust runtime: completion preserves todo, claimed-file, hook and decision precedence with bounded retries',async t=>{
 const f=await fixture(t,{settings:{verifyCompletion:'auto'}}),{rt}=f;
 const s=f.session({task:'Create missing.txt',toolset:'worker',extra:{todo:[{text:'unfinished item',status:'pending'}],stats:{steps:0,toolCalls:1}}});
 let steps=0,hooks=0,decisions=0;
 rt.loop.step=async id=>{steps++;return answer(rt,id,'Saved missing.txt');};
 rt.tools.addHooks({turnEnd:()=>{hooks++;return {continue:'fixture hook asks for another pass'};}});
 rt.decisions.available=()=>true;rt.decisions.yes=async()=>{decisions++;return 0;};rt.wake(s.id);
 await until(()=>rt.sessions.get(s.id).status==='done'&&idle(rt),'bounded completion checks');
 const notices=rt.sessions.entries(s.id,{types:['notice']}).map(e=>e.text);
 assert.deepEqual(notices,[NOTICE.unfinished('- unfinished item'),NOTICE.unfinished('- unfinished item'),NOTICE.missingFiles(['missing.txt'],false),NOTICE.missingFiles(['missing.txt'],false),'fixture hook asks for another pass',NOTICE.verify('Create missing.txt','the report does not clearly show that every part is done')]);
 assert.equal(steps,7);assert.equal(hooks,3);assert.equal(decisions,1);assert.equal(finished(f,s.id).length,1);
 rt.send(s.id,{text:'Check it again',from:'user',kind:'task'});await until(()=>finished(f,s.id).length===2&&idle(rt),'followup reuses verification and claimed-file counters');
 assert.equal(decisions,1);assert.equal(f.events.filter(e=>e.type==='agent.event'&&e.data.type==='missing-files').length,2);
});

test('Rust runtime: no-work retry precedes plugin continuation and shares its three-nudge limit',async t=>{
 const f=await fixture(t),{rt}=f,s=f.session({toolset:'worker'});let steps=0,hooks=0;
 rt.loop.step=async id=>{steps++;return answer(rt,id);};rt.tools.addHooks({turnEnd:()=>{hooks++;return {continue:'hook continuation'};}});rt.wake(s.id);
 await until(()=>rt.sessions.get(s.id).status==='done'&&idle(rt),'no-work and hook limit');
 assert.deepEqual(rt.sessions.entries(s.id,{types:['notice']}).map(e=>e.text),[NOTICE.noWork(),'hook continuation','hook continuation']);assert.equal(steps,4);assert.equal(hooks,3);
});

test('Rust runtime: continued steps emit progress before a single maxSteps report',async t=>{
 const f=await fixture(t,{settings:{maxSteps:1,progressEvery:1}}),{rt}=f,parent=f.session({kind:'main',task:null,extra:{status:'stopped'}}),s=f.session({parentId:parent.id});let steps=0;
 rt.loop.step=async id=>{steps++;const current=rt.sessions.get(id);rt.sessions.update(id,{stats:{...current.stats,steps:1}});rt.sessions.append(id,'tool',{callId:'partial',name:'fixture',content:'partial work'});return {};};
 rt.wake(s.id);await until(()=>idle(rt)&&rt.sessions.get(s.id).status==='done','partial report at maxSteps');
 assert.equal(steps,1);assert.equal(finished(f,s.id).length,1);assert.match(rt.sessions.get(s.id).result,/ステップ上限 1/);
 const progress=rt.sessions.entries(parent.id,{types:['input']}).filter(e=>e.kind==='report');assert.equal(progress.length,1);assert.equal(progress[0].passive,true);assert.match(progress[0].text,/1 steps/);
 assert.equal(rt.sessions.pending(parent.id).filter(e=>e.kind==='report').length,1);
});

test('Rust runtime: a reentrant followup during maxSteps finish settles the old lease without removing the new one',async t=>{
 const f=await fixture(t,{settings:{maxSteps:1}}),{rt}=f,s=f.session(),newStep=f.gate();let steps=0,sent=false;
 rt.loop.step=async(id,signal)=>{
  steps++;
  if(steps===1){const current=rt.sessions.get(id);rt.sessions.update(id,{stats:{...current.stats,steps:1}});rt.sessions.append(id,'tool',{callId:'partial',name:'fixture',content:'partial work'});return {};}
  await newStep.promise;signal.throwIfAborted();return answer(rt,id,'followup result');
 };
 const listener=event=>{if(event.type==='agent.finished'&&event.data.sessionId===s.id&&!sent){sent=true;rt.send(s.id,{text:'Continue with this new item',from:'user'});}};
 f.store.listeners.add(listener);t.after(()=>f.store.listeners.delete(listener));rt.wake(s.id);const old=rt.runs.get(s.id);
 await until(()=>steps===2,'followup admitted during maxSteps publication');const current=rt.runs.get(s.id);assert.notEqual(current,old);
 await settles(old.promise,'old maxSteps lease release');assert.equal(rt.runs.get(s.id),current,'old release leaves the replacement handle intact');
 newStep.resolve();await until(()=>idle(rt),'followup completion');assert.equal(rt.sessions.get(s.id).result,'followup result');assert.equal(finished(f,s.id).length,2);assert.equal(steps,2);
});

test('Rust runtime: wait and turn-ended outcomes bypass progress and maxSteps branches',async t=>{
 const f=await fixture(t,{settings:{maxSteps:1,progressEvery:1},timers:true}),{rt}=f,parent=f.session({kind:'main',task:null,extra:{status:'stopped'}}),s=f.session({parentId:parent.id});let steps=0;
 rt.loop.step=async id=>{steps++;if(steps===1){const current=rt.sessions.get(id);rt.sessions.update(id,{stats:{...current.stats,steps:7}});return {wait:5000,note:'fixture retry'};}return answer(rt,id,'normal completed result');};
 rt.wake(s.id);await until(()=>rt.timers.has(s.id)&&!rt.runs.has(s.id),'wait despite maxSteps');
 assert.equal(finished(f,s.id).length,0);assert.equal(rt.sessions.pending(parent.id).length,0);assert.equal(rt.sessions.entries(parent.id,{types:['input']}).length,0);
 f.timers.advanceTo(rt.timers.get(s.id));await until(()=>idle(rt)&&rt.sessions.get(s.id).status==='done','turn-ended result despite maxSteps');
 assert.equal(rt.sessions.get(s.id).result,'normal completed result');assert.equal(finished(f,s.id).length,1);assert.equal(rt.sessions.entries(parent.id,{types:['input']}).length,0);
});

test('Rust runtime: a completed specialist becomes idle and an ordinary wake does not duplicate its report',async t=>{
 const f=await fixture(t),{rt}=f,s=f.session({kind:'specialist'});let steps=0;
 rt.loop.step=async id=>{steps++;return answer(rt,id,'specialist ready');};rt.wake(s.id);
 await until(()=>idle(rt)&&finished(f,s.id).length===1,'specialist completion');assert.equal(rt.sessions.get(s.id).status,'idle');assert.equal(rt.sessions.get(s.id).result,'specialist ready');
 rt.wake(s.id);await until(()=>idle(rt),'specialist no-op wake');assert.equal(steps,1);assert.equal(finished(f,s.id).length,1);
});

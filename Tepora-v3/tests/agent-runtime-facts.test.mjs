/** Scheduling-fact projection differential tests against the previous full
 * snapshot. Real Rust controllers, synthetic data; no providers or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RuntimeHost} from '../core/agent/runtime-host.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';
import {nativeCore} from '../core/native-state.mjs';
import {Store} from '../core/store.mjs';
import {budgetCost} from '../core/model-usage.mjs';

// Deliberately retain the old complete boundary as the differential oracle.
function legacyFacts(rt){const nowMs=rt.clock(),day=new Date(nowMs).toISOString().slice(0,10);return {nowMs,settings:rt.settings(),dailyCost:budgetCost(rt.store.value('agent-usage:'+day)?.cost||0,rt.store.value('model-usage:'+day)),decisionAvailable:rt.decisions.available(),hasHooks:!!rt.tools.hooks.length,sessions:rt.sessions.list().map(session=>{const tail=rt.sessions.tail(session.id,12);return {session,tail,pending:rt.sessions.pending(session.id),lastAtMs:Date.parse(tail.at(-1)?.at)||0};})};}
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(count=1){
 const sessions=Array.from({length:count},(_,i)=>({id:i?'worker-'+i:'main',kind:i?'worker':'main',title:'Synthetic session '+i,status:'idle',role:i?'work':'chat',toolset:'lean',stats:{steps:0,cost:0},system:'Synthetic prompt',tools:['read']}));
 const tails=new Map(sessions.map(s=>[s.id,[]])),inboxes=new Map(sessions.map(s=>[s.id,[]]));
 const values=new Map(),clock={now:1792230000000},settings={concurrency:2,budget:{},idleCompactSeconds:20,verifyCompletion:'off',delegationGuard:false,progressEvery:50,maxSteps:0};
 const rt={clock:()=>clock.now,settings:()=>settings,store:{value:key=>values.get(key)},decisions:{available:()=>false},tools:{hooks:[]},sessions:{list:()=>sessions,tail:(id,limit)=>tails.get(id).slice(-limit),pending:id=>inboxes.get(id)}};
 return {rt,host:new RuntimeHost(rt),sessions,tails,inboxes,values,clock,settings};
}
const entry=(type,fields={})=>({type,at:'2026-10-17T09:00:00.000Z',...fields});
function pair(f){
 const old=new nativeCore.RuntimeCore(),next=new nativeCore.RuntimeCore(),trace=[];
 return {trace,dispatch(event){const before=JSON.parse(old.dispatch(JSON.stringify(event),JSON.stringify(legacyFacts(f.rt)))),after=JSON.parse(next.dispatch(JSON.stringify(event),JSON.stringify(f.host.facts())));assert.deepEqual(after,before,'native action/command ordering changed for '+JSON.stringify(event));trace.push({event,before,after});return after;}};
}

test('scheduling facts retain exact Rust flags and omit transcript bodies and inbox text',()=>{
 const f=fixture(),calls=[{id:'c',name:'read',arguments:'{"path":"synthetic.txt"}'}];
 f.tails.set('main',[entry('input',{text:'SYNTHETIC_INPUT_BODY',passive:[]}),entry('tool',{content:'SYNTHETIC_TOOL_BODY',error:false}),entry('assistant',{content:'SYNTHETIC_ASSISTANT_BODY',reasoning:'SYNTHETIC_REASONING_BODY',toolCalls:calls,truncated:'yes'})]);
 f.inboxes.set('main',[{id:'queued-1',text:'SYNTHETIC_QUEUED_BODY',from:'user',mode:'followup'},{id:'queued-2',text:'SYNTHETIC_QUEUED_BODY',from:'child:worker-1',kind:'report'}]);
 const raw=legacyFacts(f.rt),projected=f.host.facts(),observed=projected.sessions[0];assert.deepEqual(projected.settings,raw.settings);assert.deepEqual(observed.session,raw.sessions[0].session);assert.equal(observed.pending,2);assert.equal(observed.lastAtMs,raw.sessions[0].lastAtMs);
 assert.deepEqual(clone(observed.tail),[{type:'input',passive:[]},{type:'tool'},{type:'assistant',toolCalls:calls,truncated:'yes'}]);
 assert.doesNotMatch(JSON.stringify(projected),/SYNTHETIC_(INPUT|TOOL|ASSISTANT|REASONING|QUEUED)_BODY/);assert.match(JSON.stringify(raw),/SYNTHETIC_TOOL_BODY/);assert.equal(f.inboxes.get('main').length,2);assert.equal(f.tails.get('main')[1].content,'SYNTHETIC_TOOL_BODY');
});

test('projection preserves native needsStep over seeded histories and JSON truthiness edge cases',()=>{
 const f=fixture(),truthy=[undefined,null,false,true,0,-0,1,-1,'','0',[],{},[null]],calls=[undefined,null,false,0,[],[null],[{id:'c',name:'read',arguments:'{}'}],'','x',{}, {length:0},{length:1},{length:false},{length:true},{length:''},{length:[]},{length:{}}],types=['input','assistant','tool','notice','event','clear','checkpoint','unknown'];
 let seed=0x73510;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 for(let sample=0;sample<800;sample++){
  const tail=Array.from({length:random(20)},()=>entry(types[random(types.length)],{content:'Irrelevant synthetic body '.repeat(30),text:'Synthetic input',passive:truthy[random(truthy.length)],truncated:truthy[random(truthy.length)],toolCalls:calls[random(calls.length)]}));f.tails.set('main',tail);
  const raw=legacyFacts(f.rt).sessions[0].tail,projected=f.host.facts().sessions[0].tail;
  const before=f.host.query('needsStep',{tail:raw}),after=f.host.query('needsStep',{tail:projected});assert.equal(after,before,'seeded history '+sample);assert.equal(raw.length,projected.length);
 }
});

test('native admission, followups and auxiliary eligibility match full facts for every status and pending combination',()=>{
 const tails=[[],[entry('input',{text:'Synthetic request'})],[entry('input',{passive:true,text:'Passive report'})],[entry('assistant',{content:'Answer',toolCalls:[]})],[entry('assistant',{toolCalls:[{id:'c',name:'read',arguments:'{}'}]})],[entry('assistant',{truncated:true})],[entry('tool',{content:'Synthetic result'})],[entry('input'),...Array.from({length:12},()=>entry('event'))]];
 let cases=0;
 for(const kind of ['main','worker'])for(const status of ['idle','running','waiting','done','stopped'])for(const pending of [0,2])for(const tail of tails)for(const eventType of ['initialize','wake','auxiliary']){
  const f=fixture();Object.assign(f.sessions[0],{kind,status});f.tails.set('main',tail);f.inboxes.set('main',Array.from({length:pending},(_,i)=>({id:String(i),text:'Synthetic queued request',mode:'followup'})));const p=pair(f);p.dispatch({type:eventType,sessionId:'main',from:'user',kind:'idleCompaction'});cases++;
 }
 assert.equal(cases,480);
});

test('foreground admission and worker command order remain identical through saturation, retry, stop, resume and drain',()=>{
 const f=fixture(5);for(const s of f.sessions)f.tails.set(s.id,[entry('input',{text:'Synthetic task'})]);const p=pair(f),pending=[];
 function dispatch(event){const response=p.dispatch(event);for(const action of response.actions){const s=f.sessions.find(s=>s.id===action.sessionId);if(action.kind==='updateSession')Object.assign(s,action.patch);if(action.kind==='finish')Object.assign(s,{status:action.status||'done',result:action.text});}pending.push(...response.commands);return response;}
 const first=dispatch({type:'initialize'});assert.deepEqual(first.commands.map(c=>c.sessionId),['main','worker-1','worker-2'],'main retains its independent lane at worker capacity');assert.ok(f.sessions.slice(3).every(s=>s.status==='waiting'));
 const delivering=pending.splice(0);for(const command of delivering)dispatch({type:'resolved',sessionId:command.sessionId,runEpoch:command.runEpoch,operationId:command.operationId,value:{delivered:0}});
 const steps=pending.splice(0);assert.equal(steps.length,3);const mainStep=steps.find(c=>c.sessionId==='main'),workerStep=steps.find(c=>c.sessionId==='worker-1');
 dispatch({type:'resolved',sessionId:workerStep.sessionId,runEpoch:workerStep.runEpoch,operationId:workerStep.operationId,value:{wait:1000,note:'Synthetic retry'}});
 dispatch({type:'stop',sessionId:'worker-2',reason:'Synthetic interruption'});dispatch({type:'resume',sessionId:'worker-2',mode:'continue'});
 // A cancelled step drains without publishing into its replacement lease.
 const stopped=steps.find(c=>c.sessionId==='worker-2');dispatch({type:'resolved',sessionId:stopped.sessionId,runEpoch:stopped.runEpoch,operationId:stopped.operationId,value:{turnEnded:true,text:'Stale synthetic worker output'}});
 f.tails.get('main').push(entry('assistant',{content:'Synthetic foreground answer',toolCalls:[]}));dispatch({type:'resolved',sessionId:'main',runEpoch:mainStep.runEpoch,operationId:mainStep.operationId,value:{turnEnded:true,text:'Synthetic foreground answer'}});
 const mainTurn=pending.find(c=>c.sessionId==='main'&&c.kind==='mainTurn');assert.ok(mainTurn);const answered=dispatch({type:'resolved',sessionId:'main',runEpoch:mainTurn.runEpoch,operationId:mainTurn.operationId,value:{delegated:false}});assert.ok(answered.actions.some(a=>a.kind==='reply'&&a.text==='Synthetic foreground answer'));
 const finalDeliver=answered.commands.find(c=>c.sessionId==='main'&&c.kind==='deliver');assert.ok(finalDeliver);const released=dispatch({type:'resolved',sessionId:'main',runEpoch:finalDeliver.runEpoch,operationId:finalDeliver.operationId,value:{delivered:0}});assert.ok(released.actions.some(a=>a.kind==='releaseRun'&&a.sessionId==='main'));
 f.clock.now+=1000;const retry=p.trace.flatMap(t=>t.after.actions).find(a=>a.kind==='armTimer'&&a.sessionId==='worker-1');assert.ok(retry);dispatch({type:'timerFired',sessionId:'worker-1',timerToken:retry.timerToken});assert.ok(p.trace.length>10);
});

test('facts are fresh after inbox, transcript, budget and session mutations without a cache',()=>{
 const f=fixture(),empty=f.host.facts();assert.equal(empty.sessions[0].pending,0);assert.equal(empty.sessions[0].tail.length,0);
 f.inboxes.get('main').push({id:'i',text:'Synthetic request'});f.tails.get('main').push(entry('assistant',{truncated:true,at:'invalid timestamp'}));f.sessions[0].status='waiting';f.settings.concurrency=4;f.values.set('agent-usage:'+new Date(f.clock.now).toISOString().slice(0,10),{cost:1.25});
 const next=f.host.facts();assert.equal(next.sessions[0].pending,1);assert.equal(next.sessions[0].tail[0].truncated,true);assert.equal(next.sessions[0].lastAtMs,0);assert.equal(next.sessions[0].session.status,'waiting');assert.equal(next.settings.concurrency,4);assert.equal(next.dailyCost,1.25);
 f.inboxes.get('main').splice(0);f.tails.get('main').push(entry('assistant',{content:'Completed synthetic answer',toolCalls:[]}));assert.equal(f.host.facts().sessions[0].pending,0);assert.equal(f.host.query('needsStep',{tail:f.host.facts().sessions[0].tail}),false);
});

test('real Rust storage keeps full transcript and inbox payloads after projected scheduling facts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-runtime-facts-')),store=new Store(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});const f=fixture();f.rt.store=store;f.rt.sessions=new SessionStore(store);const s=f.rt.sessions.create({kind:'main',title:'Synthetic persisted conversation'}),content='Full synthetic tool output '.repeat(1000),queued='Full synthetic queued input '.repeat(1000);
 const saved=f.rt.sessions.append(s.id,'tool',{content,name:'read',callId:'synthetic-call'});f.rt.sessions.enqueue(s.id,{text:queued,mode:'followup',from:'user'});const facts=f.host.facts();assert.equal(facts.sessions[0].pending,1);assert.doesNotMatch(JSON.stringify(facts),/Full synthetic/);assert.equal(f.rt.sessions.entry(s.id,saved.seq).content,content);assert.equal(f.rt.sessions.pending(s.id)[0].text,queued);
});

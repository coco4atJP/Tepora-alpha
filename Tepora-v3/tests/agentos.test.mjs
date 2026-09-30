import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../core/store.mjs';
import {Harness} from '../core/harness.mjs';
import {Connectors} from '../core/connectors.mjs';
import {Routines,validateSchedule,nextOccurrence} from '../core/routines.mjs';
import {Plans,validatePlan} from '../core/plans.mjs';
import {verifyJob,validateChecks} from '../core/verification.mjs';
import {workingContext,destination} from '../core/context.mjs';
import {proposeSkill} from '../core/learning.mjs';
import {probeRuntime} from '../core/probe.mjs';
import {editDictation} from '../core/dictation.mjs';
import {CodexAgent} from '../core/agents/codex.mjs';
import {AgentRPC} from '../core/agents/rpc.mjs';
import {DEFAULT_SETTINGS} from '../core/policy.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){for(let n=0;n<500;n++){if(f())return;await sleep(10);}throw new Error('Condition timed out');}
async function fixture(t,runtime={chat:async()=>({role:'assistant',content:'done'})}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-five-')),store=new Store(dir),h=new Harness(store,new Connectors(store),{runtimeFactory:()=>runtime});
 const routines=new Routines(store,h),plans=new Plans(store,h);h.routines=routines;h.plans=plans;
 t.after(async()=>{routines.close();plans.close();h.close();await until(()=>!h.active.size);store.close();await rm(dir,{recursive:true,force:true});});
 return {dir,store,h,routines,plans};
}
const msg=(id,name,args)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const done={role:'assistant',content:'done'};
const codexFixture=fileURLToPath(new URL('./fixtures/codex-server.mjs',import.meta.url));
function codex(t,mode='normal',extra={}){
 const a=new CodexAgent({command:process.execPath,args:[codexFixture],cwd:os.tmpdir(),
  rpcFactory:opts=>new AgentRPC({...opts,env:{TEPORA_CODEX_FIXTURE:mode}}),...extra});t.after(()=>a.close());return a;
}
test('Codex: handshake, isolated thread, streamed items and completion use a real child process',async t=>{
 const a=codex(t),events=[],sessions=[];a.onUpdate=e=>events.push(e);a.onSession=s=>sessions.push(s);
 const r=await a.run('make a file');assert.equal(r.output,'finished');assert.equal(r.session.status,'completed');
 assert.equal(sessions[0].status,'starting');assert.equal(events[0].type,'output');
});
test('Codex: account probe does not expose credentials or enumerate history',async t=>{
 const a=codex(t);assert.deepEqual(await a.account(),{connected:true,authenticated:true,requiresOpenaiAuth:true});
});
test('Codex: notifications before turn/start reply are preserved',async t=>{
 const a=codex(t,'early');assert.equal((await a.run('x')).output,'early finished');
});
test('Codex: an approval arriving before the start reply is scoped and passed through',async t=>{
 let asked=0;const a=codex(t,'approval',{onApproval:async q=>{asked++;assert.equal(q.command,'echo safe');return true;}});
 assert.match((await a.run('x')).output,/accept/);assert.equal(asked,1);
});
test('Codex: denied approval is not escalated to session-wide permission',async t=>{
 const a=codex(t,'approval',{onApproval:async()=>false});assert.match((await a.run('x')).output,/decline/);
});
test('Codex: steering uses expectedTurnId and preserves the external thread',async t=>{
 const a=codex(t,'steer'),running=a.run('old');await until(()=>a.turnId);await a.steer('new instruction');
 assert.match((await running).output,/new instruction/);
});
test('Codex: abort sends interrupt and records interrupted instead of completed',async t=>{
 const a=codex(t,'hang'),c=new AbortController(),running=a.run('old',c.signal);running.catch(()=>{});
 await until(()=>a.turnId);c.abort(new Error('cancelled'));await assert.rejects(running,/interrupted|cancelled/);
 assert.equal(a.session.status,'interrupted');
});
test('Codex: transport death never becomes a successful answer',async t=>{
 const a=codex(t,'disconnect');await assert.rejects(a.run('x'),/disconnected/);
});
test('Codex: only a recorded thread is resumed, no thread list import',async t=>{
 const a=codex(t,'normal',{session:{threadId:'thread-owned',status:'completed'}});assert.equal((await a.run('continue')).session.threadId,'thread-owned');
});
for(const schedule of [{type:'interval',minutes:0},{type:'interval',minutes:1.2},{type:'daily',time:'25:12',timezone:'Asia/Tokyo'},{type:'daily',time:'09:00',timezone:'Fake/Zone'},{type:'once',at:'2026-09-27 03:00'},{type:'shell',command:'x'}]){
 test('routines reject invalid schedules '+JSON.stringify(schedule),()=>assert.throws(()=>validateSchedule(schedule)));
}
test('daily schedules use the named timezone and DST missing times are not guessed',()=>{
 const tokyo=validateSchedule({type:'daily',time:'09:00',timezone:'Asia/Tokyo'});
 assert.equal(new Date(nextOccurrence(tokyo,Date.parse('2026-09-26T23:59:00Z'))).toISOString(),'2026-09-27T00:00:00.000Z');
 const dst=validateSchedule({type:'daily',time:'02:30',timezone:'America/New_York'});
 assert.equal(new Date(nextOccurrence(dst,Date.parse('2026-03-08T06:00:00Z'))).toISOString(),'2026-03-09T06:30:00.000Z');
});
test('a proposed routine does not run; enabling binds a destination and creates only one due job',async t=>{
 const f=await fixture(t);let now=Date.parse('2026-09-27T00:00:00Z');f.routines.clock=()=>now;
 let r=f.routines.save({title:'routine',input:'do something',schedule:{type:'interval',minutes:5}});
 now+=300000;f.routines.tick();assert.equal(f.store.list('job').length,0);
 r=f.routines.enable(r.id,true,r.revision);now+=300000;f.routines.tick();f.routines.tick();
 await until(()=>!f.h.active.size);assert.equal(f.store.list('job').length,1);assert.ok(f.store.get('routine',r.id).lastJobId);
});
test('routine catch-up coalesces many intervals, while stopped work blocks a new run',async t=>{
 const f=await fixture(t);let now=Date.now();f.routines.clock=()=>now;
 let r=f.routines.save({title:'r',input:'x',schedule:{type:'interval',minutes:5}});f.routines.enable(r.id,true,r.revision);
 now+=60*60000;f.routines.tick();await until(()=>!f.h.active.size);assert.equal(f.store.list('job').length,1);
 const j=f.store.list('job')[0];f.store.put('job',{...j,status:'paused'});now+=300000;f.routines.tick();assert.equal(f.store.list('job').length,1);
});
test('routine replay after a submission-state crash reuses the persisted deterministic job id',async t=>{
 const f=await fixture(t);let now=Date.now();f.routines.clock=()=>now;
 let r=f.routines.save({title:'r',input:'x',schedule:{type:'interval',minutes:5}});r=f.routines.enable(r.id,true,r.revision);
 const before=structuredClone(r);now+=300000;f.routines.tick();await until(()=>!f.h.active.size);
 f.store.put('routine',before);f.routines.tick();assert.equal(f.store.list('job').length,1);
});
test('routine never silently changes provider after consent',async t=>{
 const f=await fixture(t);let now=Date.now();f.routines.clock=()=>now;
 let r=f.routines.save({title:'r',input:'secret',schedule:{type:'interval',minutes:5}});r=f.routines.enable(r.id,true,r.revision);
 f.store.settings={...f.store.settings,baseUrl:'http://localhost:9999/v1'};now+=300000;f.routines.tick();
 assert.equal(f.store.list('job').length,0);assert.equal(f.store.get('routine',r.id).status,'needs-consent');
});
test('one-shot missed past its grace window is not executed late',async t=>{
 const f=await fixture(t);let now=Date.now();f.routines.clock=()=>now;
 let r=f.routines.save({title:'r',input:'x',schedule:{type:'once',at:new Date(now+60000).toISOString()},graceMs:60000});r=f.routines.enable(r.id,true,r.revision);
 now+=180000;f.routines.tick();assert.equal(f.store.list('job').length,0);assert.equal(f.store.get('routine',r.id).status,'missed');
});
for(const nodes of [[],[{key:'a',input:'x',dependsOn:['b']}],[{key:'a',input:'x',dependsOn:['b']},{key:'b',input:'y',dependsOn:['a']}],[{key:'a',input:'x'},{key:'a',input:'y'}]]){
 test('plan rejects invalid dependency graph '+JSON.stringify(nodes),()=>assert.throws(()=>validatePlan({title:'p',nodes})));
}
test('plan starts independent stages and waits for explicit dependency gates',async t=>{
 const f=await fixture(t),p=f.plans.create({title:'pipeline',nodes:[
  {key:'one',input:'make source',gate:'accepted'},
  {key:'two',input:'independent'},
  {key:'three',input:'combine',dependsOn:['one','two']}
 ]});
 assert.equal(f.store.list('job').length,0);f.plans.activate(p.id,p.revision);await until(()=>f.store.list('job').length===2&&!f.h.active.size);
 let state=f.store.get('plan',p.id);const one=f.h.live(state.jobs.one);
 f.h.update(one,{status:'completed'});await until(()=>f.store.list('job').length===3&&!f.h.active.size);
 state=f.store.get('plan',p.id);assert.equal(state.status,'review');assert.equal(f.store.get('job',state.jobs.three).dependencies.length,2);
});
test('failing prerequisite does not release dependent work',async t=>{
 const f=await fixture(t,{chat:async()=>{throw new Error('fixture failure');}});
 const p=f.plans.create({title:'p',nodes:[{key:'a',input:'first'},{key:'b',input:'next',dependsOn:['a']}]});
 f.plans.activate(p.id,p.revision);await until(()=>!f.h.active.size);await sleep(20);
 assert.equal(f.store.list('job').length,1);assert.match(f.store.get('plan',p.id).note,/停止/);
});
test('verification failure re-enters the model loop to repair the real file',async t=>{
 let n=0;const f=await fixture(t,{chat:async messages=>{
  n++;if(n===1)return msg('first','workspace_write',{path:'result.json',content:'{}'});
  if(n===2)return done;
  if(n===3){assert.match(messages.at(-1).content,/Acceptance checks failed/);return msg('repair','workspace_write',{path:'result.json',content:'{"answer":42}'});}
  return done;
 }});
 const j=f.h.submit('make valid JSON','work',{checks:[{type:'json',path:'result.json',keys:['answer']}]});
 await until(()=>!f.h.active.size);assert.equal(n,4);assert.equal(f.store.get('job',j.id).verification.checks.passed,true);
 assert.equal(JSON.parse(await readFile(path.join(f.dir,'workspace','tasks',j.id,'result.json'))).answer,42);
});
test('a model cannot skip failed acceptance checks by repeating done',async t=>{
 const f=await fixture(t);const j=f.h.submit('missing file','work',{checks:[{type:'file',path:'absent.txt'}]});
 await until(()=>!f.h.active.size);assert.equal(f.store.get('job',j.id).status,'review');assert.equal(f.store.get('job',j.id).verification.checks.status,'checks-failed');
});
test('declarative checks reject executable JavaScript and path escapes',()=>{
 for(const c of [{type:'eval',code:'process.exit()'},{type:'file',path:'../secret'},{type:'json',path:'x',keys:[{}]}])assert.throws(()=>validateChecks([c]));
});
test('conversation lane rejects a hallucinated host command, even though work lane knows that tool',async t=>{
 let n=0;const f=await fixture(t,{chat:async()=>++n===1?msg('bad','run_command',{executable:'never-run',args:[]}):done});
 const j=f.h.submit('hello','chat');await until(()=>!f.h.active.size);
 assert.equal(f.store.list('effect').length,0);assert.equal(f.h.approvals.size,0);
 assert.match(f.store.get('checkpoint',j.id).messages.find(m=>m.role==='tool').content,/not available/);
});
test('priority changes select the urgent queued task without starving the conversation lane',async t=>{
 let release;const started=[];const f=await fixture(t,{chat:async messages=>{started.push(messages.at(-1).content);if(started.length===1)await new Promise(r=>{release=r;});return done;}});
 f.store.settings={...f.store.settings,concurrency:1};f.h.submit('first');await until(()=>release);
 f.h.submit('ordinary');const urgent=f.h.submit('urgent');f.h.priority(urgent.id,5);release();await until(()=>!f.h.active.size);
 assert.deepEqual(started,['first','urgent','ordinary']);
});
test('working context bounds old tool turns while keeping constraints and references',async t=>{
 const f=await fixture(t),job={id:'job',input:'Keep the deadline on Tuesday',instructions:[{content:'Do not send the email'}]};
 const messages=[{role:'system',content:'system'},{role:'user',content:job.input}];
 for(let i=0;i<30;i++){messages.push(msg(String(i),'fake',{x:'x'}));messages.push({role:'tool',tool_call_id:String(i),content:'long '.repeat(500)});}
 const compact=workingContext(messages,{store:f.store,job,maxChars:18000});
 assert.ok(JSON.stringify(compact).length<18000);assert.match(compact[1].content,/Do not send/);assert.equal(messages.length,62);
 for(let i=0;i<compact.length;i++)if(compact[i].role==='tool')assert.ok(compact.slice(0,i).some(m=>m.tool_calls?.some(c=>c.id===compact[i].tool_call_id)));
});
test('cloud destinations do not receive each other’s old conversations',async t=>{
 const seen=[];const f=await fixture(t,{chat:async m=>{seen.push(m);return done;}});
 f.store.settings={...f.store.settings,allowCloud:true,baseUrl:'https://first.example/v1',model:'m'};
 const a=f.h.submit('private first provider','chat');await until(()=>!f.h.active.size);
 f.store.settings={...f.store.settings,baseUrl:'https://second.example/v1'};f.h.submit('second request','chat');await until(()=>!f.h.active.size);
 assert.ok(!JSON.stringify(seen[1]).includes('private first provider'));
});
test('multilingual FTS indexes overlapping Japanese terms and deletion removes hits',async t=>{
 const f=await fixture(t),m=f.store.memory('来週の研究発表は横浜で行います');
 assert.equal(f.store.recall('研究発表')[0].id,m.id);
 f.store.remove('memory',m.id);assert.equal(f.store.recall('研究発表').length,0);
 assert.deepEqual(f.store.recall('" OR 1=1 --'),[]);
});
test('reusable skills have provenance and remain disabled',async t=>{
 const f=await fixture(t),job=f.h.submit('complete example');await until(()=>!f.h.active.size);
 const s=proposeSkill(f.store,{jobId:job.id,name:'Repeated task',description:'Use when asked',content:'# Steps\n1. Inspect input'});
 assert.equal(s.enabled,false);assert.equal(s.sourceJobId,job.id);assert.equal(s.validation,'user-review-required');
});
test('capability probe requires model tool call AND consumption of the tool receipt',async()=>{
 let step=0;const runtime={chat:async messages=>{
  step++;if(step===1)return msg('probe','tepora_probe',{challenge:messages[1].content.slice('Challenge: '.length)});
  return {role:'assistant',content:JSON.parse(messages.at(-1).content).receipt};
 }};
 assert.equal((await probeRuntime(runtime,DEFAULT_SETTINGS)).passed,true);
 await assert.rejects(probeRuntime({chat:async()=>done},DEFAULT_SETTINGS),/required tool call/);
});
test('local dictation is an exact versioned edit; cloud and execution responses are refused',async()=>{
 const runtime={chat:async()=>msg('edit','propose_draft_edit',{start:3,end:6,expectedText:'火曜日',replacement:'水曜日',summary:'曜日を訂正'})};
 const request={draft:'会議は火曜日です',spoken:'火曜日を水曜日にして',utteranceId:'voice-1',baseRevision:2};
 const result=await editDictation(runtime,DEFAULT_SETTINGS,request);
 assert.equal(result.preview,'会議は水曜日です');assert.equal(result.execution,false);assert.equal(result.baseRevision,2);
 await assert.rejects(editDictation(runtime,{...DEFAULT_SETTINGS,baseUrl:'https://provider.example/v1',allowCloud:true},request),/External/);
 await assert.rejects(editDictation({chat:async()=>msg('bad','run_command',{})},DEFAULT_SETTINGS,request),/did not return/);
});
test('local edit rejects offsets whose expected text does not match',async()=>{
 await assert.rejects(editDictation({chat:async()=>msg('edit','propose_draft_edit',{start:0,end:1,expectedText:'different',replacement:'x'})},DEFAULT_SETTINGS,
  {draft:'abc',spoken:'edit',baseRevision:0,utteranceId:'u'}),/did not match/);
});

test('command check detects a file modified after a successful approved test',async t=>{
 let n=0;const f=await fixture(t,{chat:async()=>++n===1?msg('cmd','run_command',{executable:process.execPath,args:['-e',"require('fs').writeFileSync('tested.txt','ok')"]}):done});
 const j=f.h.submit('test files','work',{checks:[{type:'command',executable:process.execPath,args:['-e',"require('fs').writeFileSync('tested.txt','ok')"]}]});
 await until(()=>f.store.get('job',j.id).approval);f.h.approve(f.store.get('job',j.id).approval.id,true);await until(()=>!f.h.active.size);
 assert.equal((await verifyJob(f.store,f.store.get('job',j.id))).passed,true);
 await writeFile(path.join(f.dir,'workspace','tasks',j.id,'tested.txt'),'changed');
 assert.equal((await verifyJob(f.store,f.store.get('job',j.id))).passed,false);
});

test('daily latest catch-up chooses today rather than replaying stale days',async t=>{
 const f=await fixture(t);let now=Date.parse('2026-09-24T23:00:00Z');f.routines.clock=()=>now;
 let r=f.routines.save({title:'daily',input:'x',schedule:{type:'daily',time:'09:00',timezone:'Asia/Tokyo'}});r=f.routines.enable(r.id,true,r.revision);
 now=Date.parse('2026-09-27T01:00:00Z');f.routines.tick();await until(()=>!f.h.active.size);
 assert.equal(f.store.list('job').length,1);assert.equal(f.store.get('routine',r.id).lastOccurrence,Date.parse('2026-09-27T00:00:00Z'));
});


test('command checks refuse unobserved deep source trees instead of certifying a partial snapshot',async t=>{
 const f=await fixture(t),j=f.h.submit('inspect deep tree');await until(()=>!f.h.active.size);
 const nested=path.join(f.dir,'workspace','tasks',j.id,...Array(8).fill('level'));
 await mkdir(nested,{recursive:true});await writeFile(path.join(nested,'deep.txt'),'unobserved source');
 const {listWorkspace,workspaceFingerprint}=await import('../core/workspace.mjs');
 const files=await listWorkspace(f.store,j.id);
 assert.equal(files.depthLimited,true);assert.equal(files.truncated,true);
 await assert.rejects(workspaceFingerprint(f.store,j.id),/snapshot scope/);
});
test('verification reports the receipt that actually matches the current source fingerprint',async t=>{
 const f=await fixture(t),j=f.h.submit('receipt evidence');await until(()=>!f.h.active.size);
 const {workspaceFingerprint}=await import('../core/workspace.mjs');
 const fingerprint=await workspaceFingerprint(f.store,j.id);
 const receipt={jobId:j.id,revision:0,name:'run_command',status:'succeeded',args:{executable:'checker',args:[]}};
 f.store.put('effect',{...receipt,id:'matching',result:{exitCode:0,workspaceFingerprint:fingerprint}});
 f.store.put('effect',{...receipt,id:'stale-newer',result:{exitCode:0,workspaceFingerprint:'stale'}});
 const checked=await verifyJob(f.store,{...j,checks:[{type:'command',executable:'checker',args:[]}]});
 assert.equal(checked.results[0].receiptId,'matching');assert.match(checked.results[0].scope,/excluded/);
});
test('Codex: bounded evidence refuses an overflowing turn rather than silently dropping audit records',async t=>{
 const a=codex(t,'normal',{maxItems:0});
 await assert.rejects(a.run('bounded task'),/evidence budget/);
 assert.equal(a.session.status,'unknown');
});
test('Codex: a failing approval handler still explicitly declines and cleans pending state',async t=>{
 const a=codex(t,'approval',{onApproval:async()=>{throw new Error('UI unavailable');}});
 const result=await a.run('do not approve without the person');
 assert.match(result.output,/decline/);assert.equal(a.pendingApprovals.size,0);
});

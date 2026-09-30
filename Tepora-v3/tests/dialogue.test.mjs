import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../core/store.mjs';
import {Harness} from '../core/harness.mjs';
import {Requests} from '../core/requests.mjs';
import {Dialogue} from '../core/dialogue.mjs';
import {Connectors} from '../core/connectors.mjs';
import {Companion} from '../core/companion.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await sleep(5);}throw Error('Fixture did not finish');}
const answer=content=>({role:'assistant',content});
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const tool=(id,name,args)=>({role:'assistant',content:null,tool_calls:[call(id,name,args)]});
const profile=(id,port)=>({id,name:id,protocol:'chat-completions',baseUrl:`http://127.0.0.1:${port}/v1`,model:id,domain:'device',capabilities:{text:true,tools:true}});
async function fixture(t,{run=false,routes=false}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-dialogue-'));let store,h,d;let respond=async()=>answer('character answer');const calls=[];
 const open=()=>{store=new Store(dir);store.settings={...store.settings,model:'fixture-model'};h=new Harness(store,new Connectors(store),{runtimeFactory:()=>({chat:async(messages,opts)=>{calls.push({messages:structuredClone(messages),tools:opts.tools});return respond(messages,opts);}})});if(!run)h.pump=()=>{};h.registry.clientFactory=p=>({chat:async(messages,opts)=>{calls.push({profile:p.id,messages:structuredClone(messages),tools:opts.tools});return respond(messages,opts,p);}});d=new Dialogue(store,h,new Requests(store,h));};open();
 if(routes)h.registry.save({profiles:[profile('character',9401),profile('worker',9402)],routes:{main:{primary:'worker',fallbacks:[]},chat:{primary:'character',fallbacks:[]},work:{primary:'worker',fallbacks:[]}}},0);
 t.after(async()=>{d.close();h.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {get store(){return store;},get h(){return h;},get d(){return d;},dir,calls,setRespond:fn=>respond=fn,
  body(input='hello',extra={}){const s=d.session();return {requestId:randomUUID(),input,sessionId:s.id,sessionRevision:s.revision,contextConsent:d.context().id,attachmentIds:[],...extra};},
  reopen(){d.close();h.close();store.close();open();}};
}
async function worker(f,input='make a report',args={}){const parent=f.d.submit(f.body(input)).job;f.h.update(parent,{status:'running'});const result=await f.d.delegate(parent,{input:'Write the requested report',...args});return f.h.live(result.jobId);}
function question(f,job,content='Which format?'){f.h.update(job,{status:'running'});const result=f.d.ask(job,{question:content},'ask-fixture');f.h.update(job,{status:'paused',pendingQuestionId:result.questionId});return f.store.get('worker-question',result.questionId);}
const reply=(f,q,extra={})=>({requestId:randomUUID(),sessionId:f.d.session().id,jobId:q.jobId,jobRevision:q.jobRevision,questionId:q.id,input:'Use plain text',...extra});

test('persistent character identity and history are independent of detail focus',async t=>{
 const f=await fixture(t),first=f.d.submit(f.body('first utterance')).job;f.h.update(first,{status:'completed',output:'first answer',endedAt:new Date().toISOString()});
 const session=f.d.session();new Companion(f.store).focus(first.id,{expectedRevision:0});new Companion(f.store).back(1);assert.deepEqual(f.d.session(),session);
 const second=f.d.submit(f.body('second utterance')).job;assert.notEqual(second.id,first.id);assert.deepEqual(f.d.history(second).map(m=>m.content),['first utterance','first answer']);
 f.reopen();assert.deepEqual(f.d.session(),session);assert.equal(f.d.snapshot().messages.filter(m=>m.kind==='character').length,1);
});
test('submit receipt precedes stale guards and atomically persists exactly once',async t=>{
 const f=await fixture(t),body=f.body(),first=f.d.submit(body);f.d.configure({expectedRevision:0,character:{name:'new character',instructions:'kind'}});
 assert.equal(f.d.submit(body).duplicate,true);assert.equal(f.d.submit(body).job.id,first.job.id);assert.equal(f.store.list('dialogue-message').length,1);
 assert.throws(()=>f.d.submit({...body,input:'different'}),/同じ送信番号/);
});
test('failed atomic receipt never persists job, message or sequence and never dispatches',async t=>{
 const f=await fixture(t),put=f.store.put.bind(f.store);let dispatched=0;f.h.enqueue=()=>{dispatched++;};f.store.put=(kind,doc)=>{if(kind==='request')throw Error('disk fault');return put(kind,doc);};
 assert.throws(()=>f.d.submit(f.body()),/disk fault/);assert.equal(f.store.list('job').length,0);assert.equal(f.store.list('dialogue-message').length,0);assert.equal(f.store.value('dialogue-session').nextSequence,0);assert.equal(dispatched,0);
});
test('personas are independently editable, inherited name migrates, live jobs stay pinned',async t=>{
 const f=await fixture(t);assert.equal(f.d.personas().character.name,'Tepora');const first=f.d.submit(f.body()).job;
 const p=f.d.configure({expectedRevision:0,character:{name:'Koharu',instructions:'Speak warmly'},worker:{name:'Evidence worker',instructions:'Cite checks'}});
 assert.equal(p.worker.name,'Evidence worker');assert.equal(first.personaSnapshot.character.name,'Tepora');assert.equal(f.d.submit(f.body()).job.personaSnapshot.character.name,'Koharu');assert.throws(()=>f.d.configure({expectedRevision:0,character:p.character}),/変更/);
});
test('context changes with route, persona or consent epoch and never uses detail focus',async t=>{
 const f=await fixture(t),context=f.d.context(),body=f.body();f.store.value('consent-epoch',1);assert.notEqual(f.d.context().id,context.id);assert.throws(()=>f.d.submit(body),/共有範囲/);
});
test('revoked and reenabled same recipient never receives old character history',async t=>{
 const f=await fixture(t),first=f.d.submit(f.body('PRIVATE OLD WORDS')).job;f.h.update(first,{status:'completed',output:'PRIVATE OLD ANSWER'});
 f.store.value('consent-epoch',1);const fresh=f.d.submit(f.body('hello again')).job;assert.deepEqual(f.d.history(fresh),[]);
});
test('worker handoff carries only current utterance and no global memories or other jobs',async t=>{
 const f=await fixture(t,{routes:true});f.store.memory('PRIVATE MEMORY',{confirmed:true});const old=f.d.submit(f.body('PRIVATE PREVIOUS DIALOGUE')).job;f.h.update(old,{status:'completed',output:'PRIVATE RESPONSE'});
 const w=await worker(f,'CURRENT REQUEST',{input:'PRIVATE PREVIOUS DIALOGUE',checks:[{type:'artifact',label:'PRIVATE CHECK',any:true}]});
 assert.equal(w.input,'CURRENT REQUEST');assert.equal(w.isolated,true);assert.ok(!JSON.stringify(w.handoff).includes('PRIVATE'));assert.deepEqual(w.checks,[]);assert.equal(w.routeSnapshot.role,'work');assert.equal(w.inputDestination,w.routeSnapshot.id);assert.equal(w.personaSnapshot.worker.name,'Tepora Worker');
 const tools=f.h.toolsFor(w).map(t=>t.function.name);for(const name of ['history_search','memory_search','memory_propose','skill_read','skill_propose','task_submit'])assert.ok(!tools.includes(name));
 await assert.rejects(f.h.tool(w,'memory_search',{query:'PRIVATE'},{signal:new AbortController().signal,settings:w.runtime,cloud:false,clients:new Map()}),/not available/);
});
test('late cancelled or permission-revoked character cannot dispatch worker',async t=>{
 const f=await fixture(t),p=f.d.submit(f.body()).job;f.h.update(p,{status:'running'});f.store.value('consent-epoch',1);await assert.rejects(f.d.delegate(p,{input:'x'}),/権限/);assert.equal(f.store.list('job').length,1);
});
test('foreground tool schema excludes slow and effectful work',async t=>{
 const f=await fixture(t),p=f.d.submit(f.body()).job;assert.deepEqual(f.h.toolsFor(p).map(t=>t.function.name).sort(),['display_read','task_submit','worker_status']);
});
test('worker event replay and restart insert one deterministic message per revision/status',async t=>{
 const f=await fixture(t),w=await worker(f);f.h.update(w,{status:'review',output:'real result',verification:{status:'needs-review'},endedAt:new Date().toISOString()});
 const before=f.d.snapshot().messages.filter(m=>m.jobId===w.id);f.store.emit('job.updated',{...w,status:'running'});f.d.reconcile();assert.equal(f.d.snapshot().messages.filter(m=>m.jobId===w.id).length,before.length);
 f.reopen();assert.equal(f.d.snapshot().messages.filter(m=>m.jobId===w.id&&m.status==='review').length,1);assert.equal(f.d.snapshot().messages.find(m=>m.jobId===w.id&&m.status==='review').untrusted,true);
});
test('question reply steers same worker once and rejects altered duplicate',async t=>{
 const f=await fixture(t),w=await worker(f),q=question(f,w),body=reply(f,q),r=f.d.reply(body);assert.equal(r.job.id,w.id);assert.equal(r.job.revision,1);assert.equal(r.resumeRequired,false);assert.equal(f.d.reply(body).duplicate,true);assert.equal(f.h.live(w.id).instructions.length,1);assert.throws(()=>f.d.reply({...body,input:'different'}),/同じ送信番号/);assert.equal(f.store.get('worker-question',q.id).status,'answered');
});
for(const mutation of ['cancel','steer','epoch'])test('question reply rejects '+mutation,async t=>{
 const f=await fixture(t),w=await worker(f),q=question(f,w);if(mutation==='cancel')f.h.cancel(w.id);if(mutation==='steer')f.h.steer(w.id,'new scope');if(mutation==='epoch')f.store.value('consent-epoch',1);assert.throws(()=>f.d.reply(reply(f,q)));assert.equal(f.h.live(w.id).instructions.length,mutation==='steer'?1:0);
});
test('unknown effects retain reply durably but block worker resumption',async t=>{
 const f=await fixture(t),w=await worker(f),q=question(f,w);f.store.put('effect',{id:'unknown-fixture',jobId:w.id,status:'unknown'});const body=reply(f,q),r=f.d.reply(body);assert.equal(r.resumeRequired,true);assert.equal(r.job.status,'paused');assert.equal(f.d.reply(body).resumeRequired,true);assert.equal(f.h.live(w.id).instructions.length,1);
});
test('question survives restart and cannot be bypassed by ordinary resume',async t=>{
 const f=await fixture(t),w=await worker(f),q=question(f,w);f.reopen();assert.equal(f.store.get('worker-question',q.id).status,'pending');assert.throws(()=>f.h.resume(w.id),/質問/);assert.equal(f.d.reply(reply(f,q)).job.id,w.id);
});
test('crash between question commit and pause recovers waiting state without executing',async t=>{
 const f=await fixture(t),w=await worker(f);f.h.update(w,{status:'running'});const q=f.d.ask(w,{question:'Saved before crash'},'crash-call');f.reopen();const recovered=f.store.get('job',w.id);assert.equal(recovered.status,'paused');assert.equal(recovered.pendingQuestionId,q.questionId);assert.equal(f.h.active.size,0);
});
test('same-recipient grounded followup sees bounded sourced result, never unrelated workers',async t=>{
 const f=await fixture(t),w=await worker(f);f.h.update(w,{status:'review',output:'ACTUAL WORKER RESULT '+'.'.repeat(8000),verification:{status:'needs-review',checks:{status:'checks-passed'}}});const follow=f.d.submit(f.body('How did it go?')).job;
 const status=f.d.workerStatus(follow).workers[0];assert.equal(status.id,w.id);assert.ok(status.output.startsWith('ACTUAL WORKER RESULT'));assert.equal(status.output.length,6000);assert.equal(status.untrusted,true);assert.equal(status.verificationStatus,'needs-review');assert.ok(!JSON.stringify(f.d.history(follow)).includes('ACTUAL WORKER RESULT'));
});
test('cross-recipient output requires exact explicit relay and new revisions revoke grant',async t=>{
 const f=await fixture(t,{routes:true}),w=await worker(f);f.h.update(w,{status:'review',output:'SENSITIVE WORKER RESULT',verification:{status:'needs-review'}});let follow=f.d.submit(f.body('How did it go?')).job;
 assert.equal(f.d.workerStatus(follow).workers[0].output,undefined);const preview=f.d.relayPreview(w.id);assert.equal(preview.excerpt,'SENSITIVE WORKER RESULT');assert.throws(()=>f.d.relay({...preview,consent:false}),/許可/);assert.throws(()=>f.d.relay({...preview,excerptHash:'changed',consent:true}),/変更/);
 assert.equal(f.d.relay({...preview,consent:true}).duplicate,false);assert.equal(f.d.relay({...preview,consent:true}).duplicate,true);assert.equal(f.d.workerStatus(follow).workers[0].output,'SENSITIVE WORKER RESULT');
 f.h.update(w,{revision:1,output:'NEW RESULT'});assert.equal(f.d.workerStatus(follow).workers[0].output,undefined);assert.throws(()=>f.d.relay({...preview,consent:true}),/変更/);
});
test('consent epoch revocation blocks same-recipient results and relay grants',async t=>{
 const f=await fixture(t),w=await worker(f);f.h.update(w,{status:'review',output:'PRIVATE'});const p=f.d.submit(f.body()).job;f.store.value('consent-epoch',1);assert.equal(f.d.workerStatus(p).workers[0].output,undefined);
});
test('execution asks and pauses before later effects; reply does not replay old tail',async t=>{
 const f=await fixture(t,{run:true});let workerCalls=0;
 f.setRespond(async(messages,{tools})=>{if(tools.some(t=>t.function.name==='task_submit'))return messages.some(m=>m.role==='tool')?answer('I delegated it'):tool('delegate','task_submit',{input:'Do the current task'});
  workerCalls++;if(workerCalls===1)return {role:'assistant',content:null,tool_calls:[call('ask','ask_user',{question:'Which format?'}),call('old-effect','artifact_publish',{title:'MUST NOT RUN',kind:'text',content:'old effect'})]};
  assert.ok(messages.some(m=>m.role==='user'&&m.content.includes('plain text')));assert.ok(messages.some(m=>m.role==='tool'&&m.tool_call_id==='old-effect'&&m.content.includes('notExecuted')));return answer('VERIFIED FIXTURE RESULT');});
 const parent=f.d.submit(f.body('Make the report')).job;await until(()=>!f.h.active.size&&!f.h.queue.length);const w=f.store.list('job').find(j=>j.parentJobId===parent.id),q=f.store.list('worker-question')[0];assert.equal(w.status,'paused');assert.equal(f.store.list('artifact').length,0);assert.equal(f.store.get('job',parent.id).status,'completed');
 f.d.reply(reply(f,q));await until(()=>!f.h.active.size&&!f.h.queue.length);assert.equal(f.store.get('job',w.id).status,'review');assert.equal(f.store.list('artifact').length,0);assert.equal(workerCalls,2);
});
test('actual next character model call retrieves grounded worker result through scoped tool',async t=>{
 const f=await fixture(t,{run:true});let retrieved=false;
 f.setRespond(async(messages,{tools})=>{if(!tools.some(t=>t.function.name==='task_submit'))return answer('THE ACTUAL FIXTURE OUTCOME');const input=messages.filter(m=>m.role==='user').at(-1).content;
  if(input==='How did it go?'){const status=messages.findLast(m=>m.role==='tool');if(!status)return tool('status','worker_status',{});retrieved=status.content.includes('THE ACTUAL FIXTURE OUTCOME');return answer('The worker produced the actual fixture outcome; it still needs review.');}
  return messages.some(m=>m.role==='tool')?answer('Delegated'):tool('delegate','task_submit',{input:'Do current request'});});
 f.d.submit(f.body('Make a report'));await until(()=>!f.h.active.size&&!f.h.queue.length);f.d.submit(f.body('How did it go?'));await until(()=>!f.h.active.size&&!f.h.queue.length);assert.equal(retrieved,true);
});
test('dialogue backup imports as readable inactive archive without grants or current-session identity',async t=>{
 const f=await fixture(t),job=f.d.submit(f.body('Archive me')).job;f.h.update(job,{status:'completed',output:'Archived answer'});const active=f.d.session(),bundle=f.store.export();assert.equal(bundle.dialogueArchive.messages.length,2);const imported=f.store.import(bundle);assert.ok(imported.dialogueArchiveId);assert.deepEqual(f.d.session(),active);assert.equal(f.d.snapshot().messages.length,2);const archive=f.store.get('dialogue-archive',imported.dialogueArchiveId);assert.equal(archive.readOnly,true);assert.deepEqual(archive.messages.map(m=>m.content),['Archive me','Archived answer']);assert.equal(f.store.list('dialogue-result-grant').length,0);assert.equal(f.store.list('job').find(j=>j.id!==job.id).characterSessionId,null);
});

test('new character turn stays available while delegated worker is still busy',async t=>{
 const f=await fixture(t,{run:true});let release,started=false;const held=new Promise(r=>{release=r;});
 f.setRespond(async(messages,{tools,signal})=>{if(!tools.some(t=>t.function.name==='task_submit')){started=true;await Promise.race([held,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);return answer('work completed');}
  const input=messages.filter(m=>m.role==='user').at(-1).content;if(input==='Meanwhile hello')return answer('I am here');return messages.some(m=>m.role==='tool')?answer('I delegated it'):tool('delegate','task_submit',{input:'Do current task'});});
 const first=f.d.submit(f.body('Do slow work')).job;await until(()=>started&&f.store.get('job',first.id).status==='completed');const second=f.d.submit(f.body('Meanwhile hello')).job;await until(()=>f.store.get('job',second.id).status==='completed');assert.equal(f.store.get('job',second.id).output,'I am here');assert.equal(f.store.list('job').find(j=>j.kind==='work').status,'running');release();await until(()=>!f.h.active.size);
});
test('isolated worker model prompt receives only its persona and no automatic memory',async t=>{
 const f=await fixture(t,{run:true});f.store.memory('TOP SECRET GLOBAL MEMORY',{confirmed:true});
 f.d.configure({expectedRevision:0,character:{name:'Character One',instructions:'Warm style'},worker:{name:'Worker Two',instructions:'Evidence-first style'}});
 f.setRespond(async(messages,{tools})=>{if(tools.some(t=>t.function.name==='task_submit'))return messages.some(m=>m.role==='tool')?answer('Delegated'):tool('delegate','task_submit',{input:'Do it'});const text=JSON.stringify(messages);assert.ok(!text.includes('TOP SECRET GLOBAL MEMORY'));assert.ok(messages[0].content.includes('You are Worker Two, a subordinate background worker'));assert.ok(messages[0].content.includes('Evidence-first style'));assert.ok(!messages[0].content.includes('Warm style'));return answer('done');});
 f.d.submit(f.body('Work now'));await until(()=>!f.h.active.size);assert.equal(f.store.list('job').find(j=>j.kind==='work').status,'review');
});
test('new submission requires explicit session revision',async t=>{
 const f=await fixture(t),body=f.body();delete body.sessionRevision;assert.throws(()=>f.d.submit(body),/設定番号/);assert.equal(f.store.list('job').length,0);
});
test('result grant after revocation cannot disclose new content into an older active turn',async t=>{
 const f=await fixture(t,{routes:true}),w=await worker(f);f.h.update(w,{status:'review',output:'PRIVATE RESULT'});const old=f.d.submit(f.body()).job;f.store.value('consent-epoch',1);const preview=f.d.relayPreview(w.id);f.d.relay({...preview,consent:true});assert.equal(f.d.workerStatus(old).workers[0].output,undefined);const fresh=f.d.submit(f.body()).job;assert.equal(f.d.workerStatus(fresh).workers[0].output,'PRIVATE RESULT');
});
test('dialogue re-export preserves previous read-only archives and malformed imports are atomic',async t=>{
 const f=await fixture(t);f.d.submit(f.body('Keep this forever'));f.store.import(f.store.export());const bundle=f.store.export(),before=f.store.list('dialogue-archive').length;assert.equal(bundle.dialogueArchive.archives.length,1);const imported=f.store.import(bundle);assert.equal(imported.dialogueArchiveIds.length,2);assert.equal(f.store.list('dialogue-archive').length,before+2);const bad=structuredClone(bundle);bad.dialogueArchive.messages[0].content='';const oldJobs=f.store.list('job').length;assert.throws(()=>f.store.import(bad));assert.equal(f.store.list('job').length,oldJobs);
});

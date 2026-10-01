import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../core/store.mjs';
import {Execution} from '../core/execution.mjs';
import {dockerArguments,processEnvelope,CONTAINER_RUNNER} from '../core/executor.mjs';
import {Harness} from '../core/harness.mjs';
import {Dialogue} from '../core/dialogue.mjs';
import {Requests} from '../core/requests.mjs';
import {Connectors} from '../core/connectors.mjs';
import {stageInputs} from '../core/input-files.mjs';
const image='node@sha256:'+'a'.repeat(64);
const fixtureExecutor=()=>({descriptor:()=>({kind:'test-process',isolation:'none',verified:false}),probe:async()=>({available:true,reason:'Protocol fixture only'}),execute:(p,o)=>processEnvelope(process.execPath,['--input-type=module','-e',CONTAINER_RUNNER],p,o)});
const args={code:"return {artifacts:[{title:'Report',content:'Fixture bytes',kind:'markdown'}],summary:'draft'};"};
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-execution-'));let store=new Store(dir),execution=new Execution(store,{executor:fixtureExecutor()});
 execution.configure({expectedRevision:0,mode:'protected',image,approveImage:true});const job={id:randomUUID(),input:'Make a report',revision:0,consentEpoch:0,status:'running',executionMode:'protected',executionConfigRevision:1,inputFiles:[],instructions:[],runtime:store.settings};store.put('job',job);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {get store(){return store;},get execution(){return execution;},job,dir,reopen(){store.close();store=new Store(dir);execution=new Execution(store,{executor:fixtureExecutor()});}};
}
test('container argv is digest-pinned with no host mounts, secrets, privileged mode or network',()=>{
 const a=dockerArguments(image,'tepora-'+randomUUID());for(const flag of ['--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534'])assert.ok(a.includes(flag));assert.ok(!a.some(x=>/^(--mount|--volume|--privileged|--env-file)/.test(x)));assert.throws(()=>dockerArguments('node:latest','tepora-'+randomUUID()));assert.throws(()=>dockerArguments(image,'--privileged'));
});
test('real child protocol stages copies; exact user promotion preserves previous version',async t=>{
 const f=await fixture(t);f.store.artifact('Original','KEEP ORIGINAL',{id:'source',kind:'text',jobId:f.job.id});
 const r=await f.execution.run(f.job,{code:"return {artifacts:[{artifactId:'source',title:'Revised',content:capsule.artifacts[0].content+' + revised',kind:'text'}]};",artifactIds:['source']},{callId:'copy'});
 assert.equal(f.store.get('artifact','source').content,'KEEP ORIGINAL');const c=r.candidates[0];assert.equal(c.content,undefined);assert.equal(r.pauseForPromotion,true);
 assert.equal(f.execution.promote(f.job,c.id,{expectedHash:c.sha256,expectedVersion:1}).version,2);assert.equal(f.store.get('revision','source:1').content,'KEEP ORIGINAL');assert.throws(()=>f.execution.promote(f.job,c.id,{expectedHash:c.sha256,expectedVersion:1}),/stale|promoted/);
});
test('capsule sends selected bytes and rejects changed content despite unchanged metadata',async t=>{
 const f=await fixture(t);f.store.memory('PRIVATE MEMORY');f.store.settings={...f.store.settings,apiKeyEnv:'SECRET_ENV'};const file=stageInputs(f.store,[{name:'source.txt',content:'source bytes'}])[0];f.job.inputFiles=[file];f.store.put('job',f.job);
 const c=f.execution.capsule(f.job,{inputIds:[file.id]});assert.equal(c.files[0].content,'source bytes');for(const secret of ['SECRET_ENV','PRIVATE MEMORY',f.dir])assert.ok(!JSON.stringify(c).includes(secret));f.store.put('input-file',{...f.store.get('input-file',file.id),content:'tampered'});assert.throws(()=>f.execution.capsule(f.job,{inputIds:[file.id]}),/selected/);
});
test('missing backend, paused job, stale revision and revoked consent fail closed',async t=>{
 const f=await fixture(t);for(const status of ['paused','interrupted','blocked','cancelled']){f.store.put('job',{...f.job,status});await assert.rejects(f.execution.run(f.job,args));}f.store.put('job',f.job);f.store.value('consent-epoch',1);await assert.rejects(f.execution.run(f.job,args),/scope/);f.store.value('consent-epoch',0);f.store.value('execution-config',{revision:2,mode:'protected',image:'',imageApproved:false});await assert.rejects(f.execution.run(f.job,args),/No host fallback/);
});
test('actual child abort + recreated executor retains core and never automatically replays',async t=>{
 const f=await fixture(t);f.store.memory('keep memory');const abort=new AbortController(),pending=f.execution.run(f.job,{code:'await new Promise(r=>setTimeout(r,10000)); return {artifacts:[]};'},{signal:abort.signal,callId:'crash'});setTimeout(()=>abort.abort(new Error('fixture crash')),100);await assert.rejects(pending,/fixture crash/);assert.equal(f.store.list('executor-run')[0].status,'unknown');f.reopen();assert.equal(f.store.list('memory')[0].content,'keep memory');assert.equal(f.store.list('execution-capsule').length,1);
 const live={...f.store.get('job',f.job.id),status:'running'};f.store.put('job',live);await assert.rejects(f.execution.run(live,args),/Previous execution/);f.store.put('job',{...live,status:'paused'});f.execution.reconcile(f.store.list('executor-run')[0].id,'stopped');f.store.put('job',live);assert.equal((await f.execution.run(live,args,{callId:'replacement'})).status,'staged');
});
test('late executor result cannot stage after pause',async t=>{const f=await fixture(t),pending=f.execution.run(f.job,{code:"await new Promise(r=>setTimeout(r,80)); return {artifacts:[{title:'x',content:'x',kind:'text'}]};"},{callId:'late'});f.store.put('job',{...f.job,status:'paused'});await assert.rejects(pending,/running/);assert.equal(f.store.list('execution-candidate').length,0);});
test('raw execution journal is immutable rather than overwritten by model projections',async t=>{const f=await fixture(t);f.execution.capsule(f.job);assert.throws(()=>f.store.db.exec('DELETE FROM execution_journal'),/immutable/);assert.throws(()=>f.store.db.exec("UPDATE execution_journal SET kind='changed'"),/immutable/);});
test('broker binds exact action/recipient/data/budget, blocks pause and records unknown outcomes',async t=>{
 const f=await fixture(t),payload={text:'exact data'},g=f.execution.grant(f.job,{action:'send',destination:'fixture',payload},true);let calls=0;const req={id:'op',action:'send',destination:'fixture',payload},perform=async()=>{calls++;return {accepted:true};};await assert.rejects(f.execution.broker(f.job,g.id,{...req,destination:'other'},perform),/scope/);f.store.put('job',{...f.job,status:'paused'});await assert.rejects(f.execution.broker(f.job,g.id,req,perform),/running/);f.store.put('job',f.job);await f.execution.broker(f.job,g.id,req,perform);assert.equal(calls,1);await assert.rejects(f.execution.broker(f.job,g.id,{...req,id:'again'},perform),/budget/);
 const g2=f.execution.grant(f.job,{action:'send',destination:'fixture',payload},true);await assert.rejects(f.execution.broker(f.job,g2.id,{...req,id:'unknown'},async()=>{throw Object.assign(new Error('after send'),{status:409});}));assert.equal(f.store.get('effect',`broker:${f.job.id}:unknown`).status,'unknown');
});
test('dialogue -> actual protocol child -> staged review -> explicit promotion -> same character',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-executor-flow-')),store=new Store(dir);store.settings={...store.settings,model:'fixture'};
 const call=(id,name,args)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const h=new Harness(store,new Connectors(store),{executionOptions:{executor:fixtureExecutor()},runtimeFactory:()=>({chat:async(messages,{tools})=>{if(tools.some(t=>t.function.name==='task_submit'))return messages.some(m=>m.role==='tool')?{role:'assistant',content:'Working in background'}:call('delegate','task_submit',{input:'Make the report'});assert.ok(!tools.some(t=>t.function.name==='executor_promote'));return call('execute','executor_run',args);}})});
 h.execution.configure({expectedRevision:0,mode:'protected',image,approveImage:true});const d=new Dialogue(store,h,new Requests(store,h));t.after(async()=>{d.close();h.close();while(h.active.size)await new Promise(r=>setTimeout(r,5));store.close();await rm(dir,{recursive:true,force:true});});
 d.submit({requestId:randomUUID(),input:'Make a report',sessionId:d.session().id,sessionRevision:d.session().revision,contextConsent:d.context().id,attachmentIds:[]});for(let i=0;i<400&&(!store.list('execution-candidate').length||h.active.size);i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(store.list('artifact').length,0);const candidate=store.list('execution-candidate')[0];assert.ok(candidate);const job=h.live(candidate.jobId);assert.equal(job.status,'review');h.execution.promote(job,candidate.id,{expectedHash:candidate.sha256,expectedVersion:0});assert.equal(store.list('artifact')[0].content,'Fixture bytes');assert.equal(store.list('executor-run')[0].isolation.isolation,'none');assert.ok(d.snapshot().messages.some(m=>m.jobId===job.id&&m.role==='tool'));
});

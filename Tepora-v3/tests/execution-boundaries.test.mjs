import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {Execution} from '../core/execution.mjs';
import {stageInputs} from '../core/input-files.mjs';
import {Harness} from '../core/harness.mjs';
import {Connectors} from '../core/connectors.mjs';
import {DockerExecutor,dockerArguments} from '../core/executor.mjs';

// Independent review: execution-boundaries.test.mjs
{
const image='node@sha256:'+'a'.repeat(64);
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-independent-beta11-'));
 const store=new Store(dir);let calls=0;
 const ex=new Execution(store,{executor:{descriptor:()=>({kind:'test-fixture',verified:false}),execute:async()=>{calls++;return {protocol:'tepora-executor-v1',result:{artifacts:[{title:'Fixture',kind:'text',content:'fixture output'}]}};}}});
 ex.configure({expectedRevision:0,mode:'protected',image,approveImage:true});
 const job={id:'fixture-job',revision:0,consentEpoch:0,status:'running',input:'Produce a text artifact',runtime:store.settings,executionConfigRevision:1};store.put('job',job);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {store,ex,job,calls:()=>calls};
}
test('modified source bytes cannot impersonate the approved attachment hash',async t=>{
 const f=await fixture(t),meta=stageInputs(f.store,[{name:'input.txt',content:'approved original'}])[0];
 f.job.inputFiles=[meta];f.store.put('job',f.job);const input=f.store.get('input-file',meta.id);f.store.put('input-file',{...input,content:'changed source bytes'});
 assert.throws(()=>f.ex.capsule(f.job,{inputIds:[meta.id]}));
});
test('paused job cannot start a fresh disposable executor',async t=>{
 const f=await fixture(t);f.job.status='paused';f.store.put('job',f.job);
 await assert.rejects(f.ex.run(f.job,{code:'return {}'},{callId:'paused-call'}));assert.equal(f.calls(),0);
});
test('promotion source revision conflict preserves the latest artifact',async t=>{
 const f=await fixture(t),a=f.store.artifact('Original','v1',{jobId:f.job.id,kind:'text'});
 const mock=f.ex.executor;mock.execute=async()=>({protocol:'tepora-executor-v1',result:{artifacts:[{artifactId:a.id,title:'Worker',kind:'text',content:'worker replacement'}]}});
 const run=await f.ex.run(f.job,{code:'return {}',artifactIds:[a.id]},{callId:'version-call'}),c=run.candidates[0];
 f.store.artifact('Human','human edit',{id:a.id,jobId:f.job.id,kind:'text',expectedVersion:1});
 assert.throws(()=>f.ex.promote(f.job,c.id,{expectedHash:c.sha256,expectedVersion:1}));assert.equal(f.store.get('artifact',a.id).content,'human edit');
});
test('duplicate broker id does not repeat a scoped effect',async t=>{
 const f=await fixture(t),request={id:'effect-one',action:'fixture',destination:'local-fixture',payload:{text:'ok'}};
 const g=f.ex.grant(f.job,{...request,maxUses:2},true);let calls=0;await f.ex.broker(f.job,g.id,request,async()=>{calls++;return 'ok';});
 await assert.rejects(f.ex.broker(f.job,g.id,request,async()=>{calls++;return 'wrong';}));assert.equal(calls,1);
});
test('paused job cannot spend a previously approved broker grant',async t=>{
 const f=await fixture(t),request={id:'paused-effect',action:'fixture',destination:'local-fixture',payload:{text:'ok'}};
 const g=f.ex.grant(f.job,request,true);f.job.status='paused';f.store.put('job',f.job);let calls=0;
 await assert.rejects(f.ex.broker(f.job,g.id,request,async()=>{calls++;return 'wrong';}));assert.equal(calls,0);
});
test('promotion database failure rolls back both artifact and candidate state',async t=>{
 const f=await fixture(t),run=await f.ex.run(f.job,{code:'return {}'},{callId:'atomic-call'}),c=run.candidates[0],original=f.ex.journal.bind(f.ex);
 f.ex.journal=(kind,body)=>{if(kind==='artifact-promoted')throw Error('simulated journal write failure');return original(kind,body);};
 assert.throws(()=>f.ex.promote(f.job,c.id,{expectedHash:c.sha256,expectedVersion:0}),/simulated/);
 assert.equal(f.store.get('artifact',c.artifactId),null);assert.equal(f.store.get('execution-candidate',c.id).status,'staged');
});
test('post-dispatch failure leaves unknown run and forbids replay',async t=>{
 const f=await fixture(t);let calls=0;f.ex.executor.execute=async()=>{calls++;throw Error('fixture disconnected after dispatch');};
 await assert.rejects(f.ex.run(f.job,{code:'return {}'},{callId:'unknown-call'}));
 assert.equal(f.store.list('executor-run')[0].status,'unknown');await assert.rejects(f.ex.run(f.job,{code:'return {}'},{callId:'new-call'}));assert.equal(calls,1);
});
test('revoked consent rejects a staged result without publishing',async t=>{
 const f=await fixture(t),run=await f.ex.run(f.job,{code:'return {}'},{callId:'revoked-call'}),c=run.candidates[0];f.store.value('consent-epoch',1);
 assert.throws(()=>f.ex.promote(f.job,c.id,{expectedHash:c.sha256,expectedVersion:0}));assert.equal(f.store.get('artifact',c.artifactId),null);
});
}

// Independent review: host-paths.test.mjs
{
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-host-path-fixture-')),s=new Store(dir);s.settings={...s.settings,model:'fixture',allowNetwork:true};const h=new Harness(s,new Connectors(s));h.pump=()=>{};t.after(async()=>{h.close();s.close();await rm(dir,{recursive:true,force:true});});return {s,h};}
test('protected tool list omits all unsupported host execution paths',async t=>{
 const {s,h}=await fixture(t),job=h.submit('fixture','work'),tools=h.toolsFor(job).map(x=>x.function.name);
 for(const name of ['run_command','mcp_call','mcp_tools','code_compute','computer_open','computer_action','computer_decision_step'])assert.ok(!tools.includes(name),name+' must not be offered in protected profile');
});
test('protected mode prevents stdio tool discovery before client creation',async t=>{
 const {s,h}=await fixture(t);let spawned=0;h.toolHub.clientFactory=()=>{spawned++;return {connect:async()=>{},request:async()=>({tools:[]}),close(){}};};
 s.put('mcp',{id:'fixture-stdio',name:'Fixture',transport:'stdio',command:'never-executed',args:[],enabled:true,envRefs:{},secretNames:[]});
 await assert.rejects(h.toolHub.discover('fixture-stdio',new AbortController().signal));assert.equal(spawned,0);
});
test('protected compute denies before invoking host RPC factory',async t=>{
 const {s,h}=await fixture(t);let spawned=0;s.value('computer-config',{...h.computer.config(),enabled:true});h.computer.rpcFactory=()=>{spawned++;return {start(){return this;},request:async()=>({result:'fixture'}),close(){}};};
 await assert.rejects(h.computer.compute({code:'return 1'},new AbortController().signal));assert.equal(spawned,0);
});
}

// Independent review: docker-contract.test.mjs
{
const image='node@sha256:'+'a'.repeat(64),name='tepora-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
test('container command is pinned and has no host mount, root or network grants',()=>{
 const args=dockerArguments(image,name);for(const expected of ['--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534','--memory=256m','--pids-limit=64'])assert.ok(args.includes(expected));
 for(const forbidden of ['--privileged','--network=host','--pid=host','-v','--volume','--mount','--env-file'])assert.ok(!args.some(a=>a===forbidden||a.startsWith(forbidden+'=')));
 assert.equal(args.filter(a=>a.startsWith('--env=')).length,1);assert.ok(args.includes('--env=HOME=/tmp'));
});
test('image/container names cannot add docker command-line options',()=>{
 for(const bad of ['node:latest','--privileged',image+' --privileged','node@sha256:xyz'])assert.throws(()=>dockerArguments(bad,name));
 assert.throws(()=>dockerArguments(image,'--privileged'));
});
test('successful execution preserves unconfirmed cleanup as explicit false',async()=>{
 const calls=[],ex=new DockerExecutor({run:async(exe,args,payload,opts)=>{calls.push({exe,args,payload,opts});if(args[0]==='rm')return {exitCode:1,stderr:'daemon disconnected'};return {protocol:'tepora-executor-v1',result:{artifacts:[]}};}});
 const result=await ex.execute({code:'return {}'},{image,containerName:name});assert.equal(result.cleanupConfirmed,false);assert.equal(calls.length,2);assert.equal(calls[1].opts.raw,true);
});
test('failed execution attempts cleanup and never returns a successful envelope',async()=>{
 let cleanup=false;const ex=new DockerExecutor({run:async(exe,args)=>{if(args[0]==='rm'){cleanup=true;return {exitCode:0,stdout:name};}throw Error('fixture lost after dispatch');}});
 await assert.rejects(ex.execute({code:'return {}'},{image,containerName:name}),e=>e.message==='fixture lost after dispatch'&&e.cleanupConfirmed===true);assert.equal(cleanup,true);
});
}

// Inert protected rendering is verified at the real local HTTP response boundary.
test('protected artifact render escapes navigation and script payloads',async t=>{
 const {startServer}=await import('../core/server.mjs');
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-inert-render-fixture-'));
 const app=await startServer({dir,runtimeFactory:()=>({chat:async()=>{throw Error('No model calls allowed');}})});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const payload='<meta http-equiv="refresh" content="0;url=https://example.invalid/"><script>location="https://example.invalid/"</script>';
 const a=app.store.artifact('Synthetic fixture',payload,{kind:'html'});
 const r=await fetch(app.origin+'/render/'+a.id,{headers:{Cookie:cookie}}),body=await r.text(),csp=r.headers.get('content-security-policy');
 assert.equal(r.status,200);assert.match(csp,/script-src 'none'/);assert.match(csp,/sandbox(?:;|$)/);assert.ok(!csp.includes('allow-scripts'));
 assert.ok(!body.includes('<script>'));assert.ok(!body.includes('<meta http-equiv='));assert.ok(body.includes('&lt;script&gt;'));
});

test('execution mode change rechecks active work after the request body arrives',async t=>{
 const {startServer}=await import('../core/server.mjs'),http=await import('node:http');
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-mode-race-fixture-'));
 const app=await startServer({dir,runtimeFactory:()=>({chat:async()=>{throw Error('No model calls allowed');}})});
 t.after(async()=>{app.harness.active.delete('synthetic-active');await app.close();await rm(dir,{recursive:true,force:true});});
 const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const body=JSON.stringify({expectedRevision:0,mode:'protected',image:''});
 let request;const response=new Promise((resolve,reject)=>{request=http.request(app.origin+'/api/execution',{method:'PUT',headers:{Cookie:cookie,'X-Tepora-CSRF':boot.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});request.on('error',reject);});
 const began=new Promise(resolve=>app.server.once('request',resolve));request.write(body.slice(0,1));await began;
 app.harness.active.set('synthetic-active',{fixture:true});request.end(body.slice(1));
 assert.equal(await response,409);assert.equal(app.harness.execution.config().revision,0);app.harness.active.delete('synthetic-active');
});

test('unknown effects and executor runs block mode changes without reconciliation',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-unknown-mode-fixture-')),store=new Store(dir),execution=new Execution(store);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 store.put('effect',{id:'unknown-effect',jobId:'inactive-job',status:'unknown'});
 assert.throws(()=>execution.configure({expectedRevision:0,mode:'legacy-host',acknowledgeHostRisk:true}));
 assert.equal(store.get('effect','unknown-effect').status,'unknown');assert.equal(execution.config().revision,0);
 store.put('effect',{id:'unknown-effect',jobId:'inactive-job',status:'reconciled'});store.put('executor-run',{id:'unknown-run',jobId:'inactive-job',status:'unknown'});
 assert.throws(()=>execution.configure({expectedRevision:0,mode:'legacy-host',acknowledgeHostRisk:true}));
 assert.equal(store.get('executor-run','unknown-run').status,'unknown');assert.equal(execution.config().revision,0);
});

test('protected mode refuses host model startup before spawning',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-model-guard-fixture-')),store=new Store(dir),connectors=new Connectors(store);
 t.after(async()=>{connectors.close();store.close();await rm(dir,{recursive:true,force:true});});
 assert.throws(()=>connectors.startRuntime(),/legacy-host/);assert.equal(connectors.processes.size,0);
});

test('Codex login rechecks execution mode after a delayed body without launching a process',async t=>{
 const {startServer}=await import('../core/server.mjs'),http=await import('node:http');
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-login-mode-race-fixture-'));
 const app=await startServer({dir,runtimeFactory:()=>({chat:async()=>{throw Error('No model calls allowed');}})});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 app.harness.execution.configure({expectedRevision:0,mode:'legacy-host',acknowledgeHostRisk:true});let launches=0;app.login.start=async()=>{launches++;return {fixture:true};};
 const body=JSON.stringify({fixture:true});let request;
 const response=new Promise((resolve,reject)=>{request=http.request(app.origin+'/api/codex/login',{method:'POST',headers:{Cookie:cookie,'X-Tepora-CSRF':boot.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});request.on('error',reject);});
 const began=new Promise(resolve=>app.server.once('request',resolve));request.write(body.slice(0,1));await began;
 app.harness.execution.configure({expectedRevision:1,mode:'protected'});request.end(body.slice(1));
 assert.equal(await response,403);assert.equal(launches,0);
});

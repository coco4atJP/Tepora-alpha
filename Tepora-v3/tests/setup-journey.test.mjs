import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../core/server.mjs';
import {Store} from '../core/store.mjs';
import {SetupManager,pullPackets} from '../core/setup.mjs';
import {Runtime} from '../core/runtime.mjs';
import {DEFAULT_SETTINGS} from '../core/policy.mjs';
import {stageInputs,readInput,resolveInputs,removeStagedInput} from '../core/input-files.mjs';
import {workspaceRoot,publishWorkspaceDocuments} from '../core/workspace.mjs';
import {Requests} from '../core/requests.mjs';
import {destination} from '../core/context.mjs';
import {installerURL} from '../core/platform-links.mjs';
import {createFixtureProvider} from './fixtures/local-provider.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await sleep(10);}throw new Error('Timed out');}
async function setupFixture(t,{models=[],mode='normal'}={}){
 const provider=await createFixtureProvider({models,mode});
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-journey-'));
 const app=await startServer({dir,setupOptions:{providers:[{id:'ollama',name:'Ollama fixture',url:provider.url+'/v1'}]}});
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const headers={Cookie:cookie};const bootstrap=await(await fetch(app.origin+'/api/bootstrap',{headers})).json();
 const request=(p,method='GET',data)=>fetch(app.origin+p,{method,headers:{...headers,'X-Tepora-CSRF':bootstrap.csrf,'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});
 t.after(async()=>{await app.close();await provider.close();await rm(dir,{recursive:true,force:true});});
 return {...app,provider,request,dir};
}
async function storeFixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-input-')),store=new Store(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return store;}

test('first-run: no runtime receives a call merely by opening bootstrap',async t=>{
 const app=await setupFixture(t);assert.equal(app.provider.requests.length,0);
 const status=await(await app.request('/api/setup')).json();assert.equal(status.stage,'connect');assert.equal(status.verified,false);assert.equal(app.provider.requests.length,0);
});
test('download -> probe -> select -> attach -> real HTTP tool loop -> artifact -> acknowledgement',async t=>{
 const app=await setupFixture(t);
 const found=await(await app.request('/api/setup/scan','POST',{})).json();assert.equal(found.candidates.length,0);assert.equal(found.engines.length,1);
 assert.equal((await app.request('/api/setup/install','POST',{engineId:found.engines[0].id,catalogId:'compact'})).status,403);
 const install=await app.request('/api/setup/install','POST',{engineId:found.engines[0].id,catalogId:'compact',consentDownload:true});assert.equal(install.status,202);
 await until(()=>app.setup.snapshot().transfer?.status==='downloaded');await until(()=>app.setup.active===null);
 const candidate=app.setup.snapshot().candidates[0];assert.ok(candidate);
 assert.equal((await app.request('/api/setup/select','POST',{candidateId:candidate.id,consentTest:true})).status,200);
 assert.equal(app.setup.snapshot().verified,true);assert.equal(app.harness.key,'');
 const source='10月4日14時に打合せ。見積書はまだ承認前です。';
 const upload=await(await app.request('/api/inputs','POST',{files:[{name:'メモ.md',content:source}]})).json();
 assert.equal(app.provider.requests.some(r=>JSON.stringify(r).includes(source)),false,'merely staging a file must not contact the model');
 const body={requestId:randomUUID(),input:'このメモを使って確認事項をまとめて',attachmentIds:[upload.files[0].id]};
 const sent=await(await app.request('/api/requests','POST',body)).json();assert.ok(sent.job?.id);
 const again=await(await app.request('/api/requests','POST',body)).json();assert.equal(again.job.id,sent.job.id);assert.equal(again.duplicate,true);
 await until(()=>app.store.get('job',sent.job.id).status==='review');
 const artifacts=app.store.list('artifact');assert.equal(artifacts.length,1);assert.match(artifacts[0].content,/まだ承認前/);
 assert.equal(app.store.get('job',sent.job.id).verification.checks.passed,true);
 assert.equal(app.store.list('job').length,1);
 assert.equal(app.setup.snapshot().stage,'connected','sample/production must not mean user acceptance');
 assert.equal((await app.request(`/api/jobs/${sent.job.id}/accept`,'POST',{expectedRevision:0})).status,200);
 assert.equal(app.setup.snapshot().stage,'first-result');
 assert.equal((await app.request('/api/requests','POST',{...body,input:'different'})).status,409);
});
test('failed model protocol probe never replaces the working configuration',async t=>{
 const app=await setupFixture(t,{models:['fixture-local'],mode:'bad-probe'});app.harness.key='key-for-previous-runtime';
 const before=JSON.stringify(app.store.settings),scan=await app.setup.scan();
 await assert.rejects(app.setup.select(scan.candidates[0].id,{consentTest:true}));
 assert.equal(JSON.stringify(app.store.settings),before);assert.equal(app.harness.key,'key-for-previous-runtime');
 assert.ok(!JSON.stringify(app.provider.requests).includes('key-for-previous-runtime'));
});
test('cancelled download remains resumable, never pretends to be verified',async t=>{
 const app=await setupFixture(t,{mode:'slow-pull'}),found=await app.setup.scan();
 app.setup.install({engineId:found.engines[0].id,catalogId:'compact',consentDownload:true});
 await until(()=>app.provider.requests.some(r=>r.path==='/api/pull'));app.setup.stop();await app.setup.running;
 assert.equal(app.setup.snapshot().transfer.status,'interrupted');assert.equal(app.setup.snapshot().verified,false);
 assert.equal(app.store.settings.model,'');
});
test('Ollama error inside a successful HTTP response fails installation',async t=>{
 const app=await setupFixture(t,{mode:'error-pull'}),found=await app.setup.scan();
 app.setup.install({engineId:found.engines[0].id,catalogId:'compact',consentDownload:true});await app.setup.running;
 assert.equal(app.setup.snapshot().transfer.status,'failed');assert.equal(app.store.settings.model,'');
});
test('download without a success event or beyond the accepted byte budget cannot be ready',async t=>{
 for(const mode of ['truncated-pull','oversize-pull']){
  const app=await setupFixture(t,{mode}),found=await app.setup.scan();app.setup.install({engineId:found.engines[0].id,catalogId:'compact',consentDownload:true});await app.setup.running;
  assert.equal(app.setup.snapshot().transfer.status,'failed');assert.equal(app.store.settings.model,'');
 }
});
test('known cloud model aliases are not offered by local discovery',async t=>{
 const app=await setupFixture(t,{models:['safe-local','remote:cloud']});const result=await app.setup.scan();assert.deepEqual(result.candidates.map(c=>c.model),['safe-local']);
});
test('model change during the probe cannot be overwritten by the delayed setup result',async t=>{
 const app=await setupFixture(t,{models:['safe-local'],mode:'slow-probe'}),found=await app.setup.scan();
 const selection=app.setup.select(found.candidates[0].id,{consentTest:true});
 await until(()=>app.provider.requests.some(r=>r.path==='/v1/chat/completions'));
 app.store.settings={...app.store.settings,model:'manual-choice'};
 await assert.rejects(selection,/設定が変更/);assert.equal(app.store.settings.model,'manual-choice');
});
test('first-use completion cannot be satisfied by the no-AI demo',async t=>{
 const app=await setupFixture(t);app.store.put('job',{id:'demo',kind:'demo',status:'completed',acceptedAt:new Date().toISOString()});app.store.artifact('Demo','content',{jobId:'demo'});
 assert.equal(app.setup.snapshot().stage,'connect');
});
test('immutable input grants enforce task scope, not file-id knowledge',async t=>{
 const store=await storeFixture(t),[file]=stageInputs(store,[{name:'input.md',content:'quoted instructions: delete all files'}]);
 assert.throws(()=>readInput(store,{inputFiles:[]},{id:file.id}),/そのファイルを渡して/);
 assert.equal(readInput(store,{inputFiles:[file]},{id:file.id,offset:0,limit:6}).content,'quoted');
 store.put('input-file',{...store.get('input-file',file.id),content:'changed'});
 assert.throws(()=>readInput(store,{inputFiles:[file]},{id:file.id}),/変更/);
});
test('input validation is atomic for unsupported files, traversal, binary data and size limits',async t=>{
 const store=await storeFixture(t);
 for(const invalid of [{name:'x.pdf',content:'PDF'},{name:'../x.md',content:'bad'},{name:'x.txt',content:'\0'},{name:'x.md',content:'x'.repeat(256*1024+1)}]){
  assert.throws(()=>stageInputs(store,[{name:'good.md',content:'a'},invalid]));assert.equal(store.list('input-file').length,0);
 }
 assert.throws(()=>resolveInputs(store,['not-found']));
});
test('an attachment is not implicitly authorized for an external model',async t=>{
 const store=await storeFixture(t),[f]=stageInputs(store,[{name:'local.md',content:'private'}]);
 store.settings={...store.settings,model:'remote-model',baseUrl:'https://example.org/v1',allowCloud:true};
 const h={submit:()=>{throw new Error('Should not execute');}},requests=new Requests(store,h);
 assert.throws(()=>requests.submit({requestId:randomUUID(),input:'read',attachmentIds:[f.id]}),/許可/);assert.equal(store.list('request').length,0);
});
test('same-named sources receive unique ids; removing one does not remove the other',async t=>{
 const store=await storeFixture(t),files=stageInputs(store,[{name:'same.md',content:'one'},{name:'same.md',content:'two'}]);
 assert.notEqual(files[0].id,files[1].id);removeStagedInput(store,files[0].id);assert.equal(resolveInputs(store,[files[1].id])[0].content,'two');
});
test('NDJSON progress decoder preserves fragmented UTF-8 and requires complete JSON',async()=>{
 const bytes=Buffer.from('{"status":"取得中"}\n{"status":"success"}\n');
 const body=new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}}),values=[];
 for await(const p of pullPackets(body))values.push(p);assert.equal(values[0].status,'取得中');assert.equal(values.length,2);
 await assert.rejects(async()=>{for await(const p of pullPackets(new Response('{"bad":').body))void p;});
});
test('vendor installation help never accepts arbitrary urls or commands',()=>{
 assert.equal(installerURL('win32'),'https://ollama.com/download/windows');assert.equal(installerURL('darwin'),'https://ollama.com/download/mac');
});
// Found by the user-journey review: non-streaming responses were not checked for truncation.
test('non-streaming output cut at token limit must not be accepted as completed',async()=>{
 const runtime=new Runtime({...DEFAULT_SETTINGS,model:'test'},'',async()=>Response.json({choices:[{finish_reason:'length',message:{role:'assistant',content:'half a file'}}]}));
 await assert.rejects(runtime.chat([]),/truncated/);
});

test('normal JSON errors and oversize outputs cannot become a completed assistant turn',async()=>{
 for(const payload of [
  {choices:[{finish_reason:'content_filter',message:{content:'filtered'}}]},
  {choices:[{message:{content:'x'.repeat(200001)}}]},
  {choices:[{message:{content:null,tool_calls:[{id:'x',function:{name:'tool',arguments:{not:'a string'}}}]}}]}
 ]){
  const rt=new Runtime({...DEFAULT_SETTINGS,model:'test'},'',async()=>Response.json(payload));await assert.rejects(rt.chat([]));
 }
});
test('multi-line SSE frames are bounded rather than accumulating unlimited data lines',async()=>{
 const text=('data: '+ 'x'.repeat(1000)+'\n').repeat(2100);
 const rt=new Runtime({...DEFAULT_SETTINGS,model:'test'},'',async()=>new Response(text,{headers:{'Content-Type':'text/event-stream'}}));
 await assert.rejects(rt.chat([]),/frame is too large/);
});
test('closing during a connection test cancels it without writing to a closed store',async t=>{
 const app=await setupFixture(t,{models:['safe-local'],mode:'slow-probe'}),found=await app.setup.scan();
 const task=app.setup.select(found.candidates[0].id,{consentTest:true});
 const rejected=assert.rejects(task);
 await until(()=>app.provider.requests.some(r=>r.path==='/v1/chat/completions'));
 await app.setup.close();await rejected;assert.equal(app.setup.probing,null);
});

test('external model permission can actually be revoked while its URL remains configured',async t=>{
 const app=await setupFixture(t);
 assert.equal((await app.request('/api/settings','PATCH',{baseUrl:'https://example.org/v1',model:'remote',allowCloud:true})).status,200);
 app.store.value('model-probe',{passed:true,destination:destination(app.store.settings),checkedAt:new Date().toISOString()});assert.equal(app.setup.snapshot().verified,true);
 const revoked=await app.request('/api/settings','PATCH',{allowCloud:false});assert.equal(revoked.status,200);
 assert.equal(app.store.settings.allowCloud,false);assert.equal(app.store.settings.baseUrl,'https://example.org/v1');assert.equal(app.setup.snapshot().verified,false);
 const rt=new Runtime(app.store.settings,'',()=>{throw new Error('Must not send a request');});await assert.rejects(rt.chat([]),/External connections/);
});
test('feed permission can be revoked without first erasing its saved URL',async t=>{
 const app=await setupFixture(t);
 assert.equal((await app.request('/api/settings','PATCH',{newsUrl:'https://example.org/rss',allowNetwork:true})).status,200);
 assert.equal((await app.request('/api/settings','PATCH',{allowNetwork:false})).status,200);
 assert.equal(app.store.settings.allowNetwork,false);
});

test('source files copied for external agents must not masquerade as produced artifacts',async t=>{
 const store=await storeFixture(t),job={id:randomUUID(),status:'running',inputFiles:[{id:'source'}]};store.put('job',job);
 const root=workspaceRoot(store,job.id);await mkdir(path.join(root,'inputs'),{recursive:true});
 await writeFile(path.join(root,'inputs','source.md'),'This is input, not a deliverable.');
 assert.deepEqual(await publishWorkspaceDocuments(store,job),[]);
 await writeFile(path.join(root,'summary.md'),'Actual newly produced result.');
 const published=await publishWorkspaceDocuments(store,job);
 assert.equal(published.length,1);assert.equal(published[0].title,'summary.md');
});

import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startServer} from '../core/server.mjs';
async function service(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-http-'));const app=await startServer({dir,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'actual test response'})})});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});const launch=await fetch(app.launchUrl,{redirect:'manual'});assert.equal(launch.status,303);const cookie=launch.headers.get('set-cookie').split(';')[0];const bootstrap=await (await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();const request=(p,method='GET',data,headers={})=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,'Content-Type':'application/json',...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});return {...app,request,cookie,bootstrap};}
test('HTTP bootstrap requires session cookie, all mutations require CSRF and origin checks',async t=>{
 const app=await service(t);assert.equal((await fetch(app.origin+'/api/bootstrap')).status,401);assert.equal((await fetch(app.origin+'/api/jobs',{method:'POST',headers:{Cookie:app.cookie,'Content-Type':'application/json'},body:'{"input":"x"}'})).status,403);assert.equal((await app.request('/api/jobs','POST',{input:'x'},{Origin:'https://evil.example'})).status,403);const hostStatus=await new Promise((resolve,reject)=>{const r=http.request(app.origin+'/api/bootstrap',{headers:{Host:'evil.example',Cookie:app.cookie}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});assert.equal(hostStatus,403);
 const result=await app.request('/api/jobs','POST',{input:'hello',kind:'chat'});assert.equal(result.status,202);const job=await result.json();await new Promise(r=>setTimeout(r,30));assert.equal(app.store.get('job',job.id).status,'completed');
});
test('secrets are ephemeral; cloud consent is explicit; context imports stay pending and private',async t=>{
 const app=await service(t);const secret='session-secret-do-not-persist';assert.equal((await app.request('/api/settings','PATCH',{sessionKey:secret})).status,200);assert.equal(app.harness.key,secret);assert.ok(!JSON.stringify(app.store.settings).includes(secret));assert.ok(!JSON.stringify(app.store.export()).includes(secret));assert.equal((await app.request('/api/settings','PATCH',{baseUrl:'https://example.org/v1'})).status,403);
 const old=app.store.list('memory').length;const bad=await app.request('/api/context/import','POST',{format:'tepora-v3-context',version:1,memories:[{content:'valid'},{content:''}]});assert.equal(bad.status,400);assert.equal(app.store.list('memory').length,old);
 const good=await app.request('/api/context/import','POST',{format:'tepora-v3-context',version:1,memories:[{content:'Remember this',scope:'shared',confirmed:true}],skills:[{content:'untrusted executable'}]});assert.equal(good.status,200);assert.equal(app.store.list('memory')[0].confirmed,false);assert.equal(app.store.list('memory')[0].scope,'private');assert.equal(app.store.list('skill').length,1);
});
test('artifact scripts receive a separate restrictive response; app frame navigation is self-only',async t=>{
 const app=await service(t);app.store.value('execution-config',{revision:1,mode:'legacy-host',image:'',imageApproved:false}); // Explicit legacy-host opt-in for this host-path regression fixture.
const a=app.store.artifact('HTML','<h1>Test</h1><script>document.body.dataset.ok="yes"</script>');const r=await app.request('/render/'+a.id);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.match(r.headers.get('content-security-policy'),/connect-src 'none'/);assert.equal(r.headers.get('x-frame-options'),null);
 const main=await app.request('/');assert.equal(main.status,200);assert.match(main.headers.get('content-security-policy'),/frame-src 'self';/);assert.doesNotMatch(main.headers.get('content-security-policy'),/youtube/);
 const invalid=await app.request('/api/media/embed','POST',{id:'<script>'});assert.equal(invalid.status,400);await app.request('/api/network','PATCH',{expectedRevision:0,patch:{internetTools:true}});const media=await (await app.request('/api/media/embed','POST',{id:'abcdefghijk'})).json();assert.match(media.path,/^\/media-view\/[a-f0-9]{64}$/);const wrapper=await app.request(media.path);assert.equal(wrapper.status,200);assert.match(await wrapper.text(),/youtube-nocookie/);
});
test('SSE replays committed events with monotonically increasing event ids',async t=>{
 const app=await service(t);app.store.memory('SSE marker');const controller=new AbortController();const response=await fetch(app.origin+'/api/events?since=0',{headers:{Cookie:app.cookie},signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader();const chunk=await reader.read();const value=new TextDecoder().decode(chunk.value);assert.match(value,/id: \d+/);assert.match(value,/memory.updated/);controller.abort();await reader.cancel().catch(()=>{});
});
test('local API validates MCP registration and does not launch on save',async t=>{
 const app=await service(t);const r=await app.request('/api/mcp','POST',{name:'Hub',transport:'stdio',command:'not-running-now',args:['serve'],enabled:true});assert.equal(r.status,201);assert.equal(app.store.list('mcp')[0].command,'not-running-now');assert.equal(app.harness.active.size,0);const invalid=await app.request('/api/mcp','POST',{name:'x',transport:'stdio',command:'node',args:'-e code'});assert.equal(invalid.status,400);
});

test('SSE reconnect honors Last-Event-ID over the original URL cursor',async t=>{
 const app=await service(t);app.store.memory('first replay marker');const cursor=app.store.seq;app.store.memory('new replay marker');const controller=new AbortController();const response=await fetch(app.origin+'/api/events?since=0',{headers:{Cookie:app.cookie,'Last-Event-ID':String(cursor)},signal:controller.signal});const reader=response.body.getReader();const chunk=await reader.read();const value=new TextDecoder().decode(chunk.value);assert.ok(!value.includes('first replay marker'));assert.ok(value.includes('new replay marker'));controller.abort();await reader.cancel().catch(()=>{});
});

test('display state is revisioned, preset-only, and independent from permissions',async t=>{
 const app=await service(t),settings=JSON.stringify(app.store.settings);
 const current=await(await app.request('/api/display')).json();
 const changed=await app.request('/api/display','PATCH',{expectedRevision:current.revision,patch:{theme:'dark',widgets:['clock','work']}});
 assert.equal(changed.status,200);
 assert.equal((await app.request('/api/display','PATCH',{expectedRevision:0,patch:{theme:'light'}})).status,409);
 assert.equal((await app.request('/api/display/import','POST',{expectedRevision:1,preset:{format:'tepora-display',version:1,settings:{allowCloud:true}}})).status,400);
 assert.equal(JSON.stringify(app.store.settings),settings);
 const undo=await(await app.request('/api/display/undo','POST',{expectedRevision:1})).json();
 assert.equal(undo.theme,'system');
});
test('an artifact edit is compare-and-swap, and pinned render URLs return the actual old version',async t=>{
 const app=await service(t),doc=app.store.artifact('A document','first',{id:'versioned',kind:'text'});
 const edit=await app.request('/api/artifacts/versioned','PATCH',{content:'human change',expectedVersion:doc.version});
 assert.equal(edit.status,200);
 assert.equal((await app.request('/api/artifacts/versioned','PATCH',{content:'late model',expectedVersion:1})).status,409);
 assert.match(await(await app.request('/render/versioned?v=1')).text(),/first/);
 assert.match(await(await app.request('/render/versioned?v=2')).text(),/human change/);
 assert.equal((await app.request('/render/versioned?v=999')).status,404);
});
test('acceptance requires the current job revision; a model response is not user acceptance',async t=>{
 const app=await service(t);
 app.store.put('job',{id:'review',kind:'work',input:'original',revision:2,status:'review',verification:{status:'needs-review'}});
 assert.equal((await app.request('/api/jobs/review/accept','POST',{expectedRevision:1})).status,409);
 assert.equal((await app.request('/api/jobs/review/accept','POST',{expectedRevision:2})).status,200);
 assert.equal(app.store.get('job','review').verification.status,'accepted-by-user');
});
test('revoked permissions invalidate saved-context resumption instead of retransmitting it',async t=>{
 const app=await service(t);
 await app.request('/api/settings','PATCH',{allowCloud:true});
 app.store.put('job',{id:'paused-cloud',kind:'work',input:'private',status:'paused',revision:0,consentEpoch:0});
 await app.request('/api/settings','PATCH',{allowCloud:false});
 assert.equal(app.store.value('consent-epoch'),1);
 assert.equal((await app.request('/api/jobs/paused-cloud/resume','POST',{})).status,409);
});
test('voice and Laya endpoints cannot become remote through the general cloud toggle',async t=>{
 const app=await service(t);
 for(const field of ['asrUrl','asrStreamUrl','decisionUrl'])
  assert.equal((await app.request('/api/settings','PATCH',{allowCloud:true,[field]:'https://example.org/worker'})).status,403);
});
test('shared skill discovery requires a distinct explicit action',async t=>{
 const app=await service(t);
 assert.equal((await app.request('/api/shared/scan','POST',{})).status,403);
});

test('beta5: routines remain proposals until explicit enable, and stop also suspends future work',async t=>{
 const app=await service(t);
 const result=await app.request('/api/routines','POST',{title:'daily check',input:'Check the local work',schedule:{type:'daily',time:'09:00',timezone:'Asia/Tokyo'}});
 assert.equal(result.status,201);const r=await result.json();assert.equal(r.enabled,false);
 assert.equal((await app.request(`/api/routines/${r.id}/enable`,'POST',{enabled:true,expectedRevision:r.revision})).status,200);
 await app.request('/api/stop','POST',{});assert.equal(app.store.get('routine',r.id).enabled,false);
});
test('beta5: plans reject cycles over HTTP and never run on save',async t=>{
 const app=await service(t);
 assert.equal((await app.request('/api/plans','POST',{title:'bad',nodes:[{key:'a',input:'a',dependsOn:['a']}]})).status,400);
 const response=await app.request('/api/plans','POST',{title:'good',nodes:[{key:'a',input:'first'},{key:'b',input:'second',dependsOn:['a']}]});
 assert.equal(response.status,201);assert.equal(app.store.list('job').length,0);
});
test('beta5: Codex remains opt-in and cannot launch via an unapproved request',async t=>{
 const app=await service(t);
 assert.equal((await app.request('/api/codex/check','POST',{})).status,403);
 assert.equal((await app.request('/api/jobs','POST',{input:'run',engine:'codex'})).status,403);
});
test('beta5: explicit local dictation editing permission is checked independently',async t=>{
 const app=await service(t);
 assert.equal((await app.request('/api/voice/edit','POST',{draft:'x',spoken:'fix'})).status,403);
});
test('beta5: workspace download is task-scoped and rejects path traversal',async t=>{
 const app=await service(t);app.store.put('job',{id:'files',input:'x',kind:'work',status:'review'});
 assert.equal((await app.request('/api/jobs/files/files')).status,200);
 assert.equal((await app.request('/api/jobs/files/download?path=..%2Foutside')).status,400);
 assert.equal((await app.request('/api/jobs/unknown/files')).status,404);
});
test('beta5: accepting a result does not bypass failed checks silently',async t=>{
 const app=await service(t);app.store.put('job',{id:'bad-check',input:'x',status:'review',revision:0,checks:[{type:'file',label:'deliverable',path:'missing'}]});
 assert.equal((await app.request('/api/jobs/bad-check/accept','POST',{expectedRevision:0})).status,409);
 const override=await app.request('/api/jobs/bad-check/accept','POST',{expectedRevision:0,acceptUnmet:true});
 assert.equal(override.status,200);assert.equal(app.store.get('job','bad-check').verification.status,'accepted-with-unmet-checks');
});

test('companion focus API is CSRF-protected, durable and navigation-only',async t=>{
 const app=await service(t);app.store.put('job',{id:'focus-http',input:'saved',status:'paused',kind:'chat',engine:'builtin',revision:0,consentEpoch:0});
 assert.equal((await fetch(app.origin+'/api/companion/focus',{method:'POST',headers:{Cookie:app.cookie,'Content-Type':'application/json'},body:JSON.stringify({jobId:'focus-http',expectedRevision:0})})).status,403);
 const focused=await app.request('/api/companion/focus','POST',{jobId:'focus-http',expectedRevision:0});assert.equal(focused.status,200);assert.equal(app.store.get('job','focus-http').status,'paused');assert.equal((await(await app.request('/api/bootstrap')).json()).companion.focusJobId,'focus-http');assert.equal((await app.request('/api/companion/return','POST',{expectedRevision:0})).status,409);
});
test('continuation context uses pinned model instead of newly configured model',async t=>{
 const app=await service(t);app.store.put('job',{id:'context-http',runtime:{...app.store.settings,model:'original'},engine:'builtin'});app.store.settings={...app.store.settings,model:'new-model'};const r=await(await app.request('/api/requests/context?role=chat&targetJobId=context-http')).json();assert.match(r.label,/original/);assert.doesNotMatch(r.label,/new-model/);
});
test('companion first send, same-job correction, side lane and return through HTTP',async t=>{
 const app=await service(t);app.store.settings={...app.store.settings,model:'fake'};app.harness.pump=()=>{};
 const first=await(await app.request('/api/requests','POST',{requestId:'http-first-00000001',input:'main task',intent:'new',companionRevision:0})).json();assert.equal(first.companion.focusJobId,first.job.id);
 const next=await(await app.request('/api/requests','POST',{requestId:'http-next-000000001',input:'correct that',intent:'continue',targetJobId:first.job.id,expectedRevision:0,companionRevision:1})).json();assert.equal(next.job.id,first.job.id);assert.equal(next.job.instructions.length,1);
 const sideBody={requestId:'http-side-000000001',input:'temporary task',intent:'side',targetJobId:first.job.id,expectedRevision:1,companionRevision:1};const side=await(await app.request('/api/requests','POST',sideBody)).json();assert.equal(side.job.sideOfJobId,first.job.id);assert.equal(side.companion.focusJobId,side.job.id);
 const back=await(await app.request('/api/companion/return','POST',{expectedRevision:2})).json();assert.equal(back.focusJobId,first.job.id);assert.equal((await(await app.request('/api/requests','POST',sideBody)).json()).duplicate,true);assert.equal((await(await app.request('/api/companion')).json()).focusJobId,first.job.id);
});

import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startServer} from '../core/server.mjs';
async function service(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-http-'));const app=await startServer({dir,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'actual test response'})})});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});const launch=await fetch(app.launchUrl,{redirect:'manual'});assert.equal(launch.status,303);const cookie=launch.headers.get('set-cookie').split(';')[0];const bootstrap=await (await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();const request=(p,method='GET',data,headers={})=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,'Content-Type':'application/json',...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});return {...app,request,cookie,bootstrap};}
test('HTTP bootstrap requires session cookie, all mutations require CSRF and origin checks',async t=>{
 const app=await service(t);assert.equal((await fetch(app.origin+'/api/bootstrap')).status,401);assert.equal((await fetch(app.origin+'/api/agent/input',{method:'POST',headers:{Cookie:app.cookie,'Content-Type':'application/json'},body:'{"text":"x"}'})).status,403);assert.equal((await app.request('/api/agent/input','POST',{text:'x'},{Origin:'https://evil.example'})).status,403);const hostStatus=await new Promise((resolve,reject)=>{const r=http.request(app.origin+'/api/bootstrap',{headers:{Host:'evil.example',Cookie:app.cookie}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});assert.equal(hostStatus,403);
 assert.equal((await app.request('/api/agent/input','POST',{text:'hello'})).status,409,'with CSRF and origin the request reaches the agent (which first needs a model)');
});
test('secrets are ephemeral; cloud consent is explicit; context imports stay pending and private',async t=>{
 const app=await service(t);assert.equal((await app.request('/api/settings','PATCH',{baseUrl:'https://example.org/v1'})).status,403);
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
 const app=await service(t);const r=await app.request('/api/mcp','POST',{name:'Hub',transport:'stdio',command:'not-running-now',args:['serve'],enabled:true});assert.equal(r.status,201);assert.equal(app.store.list('mcp')[0].command,'not-running-now');assert.equal(app.agent.runs.size,0);const invalid=await app.request('/api/mcp','POST',{name:'x',transport:'stdio',command:'node',args:'-e code'});assert.equal(invalid.status,400);
});

test('SSE reconnect (Last-Event-ID) gets one fresh snapshot instead of a partial replay',async t=>{
 const app=await service(t);app.store.memory('first replay marker');const cursor=app.store.seq;app.store.memory('new replay marker');const controller=new AbortController();const response=await fetch(app.origin+'/api/events?since=0',{headers:{Cookie:app.cookie,'Last-Event-ID':String(cursor)},signal:controller.signal});const reader=response.body.getReader();const chunk=await reader.read();const value=new TextDecoder().decode(chunk.value);assert.match(value,/"type":"snapshot"/);assert.ok(value.includes('new replay marker'));controller.abort();await reader.cancel().catch(()=>{});
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
test('voice and Laya endpoints cannot become remote through the general cloud toggle',async t=>{
 const app=await service(t);
 for(const field of ['asrUrl','asrStreamUrl','decisionUrl'])
  assert.equal((await app.request('/api/settings','PATCH',{allowCloud:true,[field]:'https://example.org/worker'})).status,403);
});
test('shared skill discovery requires a distinct explicit action',async t=>{
 const app=await service(t);
 assert.equal((await app.request('/api/shared/scan','POST',{})).status,403);
});

test('beta5: explicit local dictation editing permission is checked independently',async t=>{
 const app=await service(t);
 assert.equal((await app.request('/api/voice/edit','POST',{draft:'x',spoken:'fix'})).status,403);
});

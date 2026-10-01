import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '../core/store.mjs';
import {NetworkPolicy,ipDomain,NetworkBlocked} from '../core/network-policy.mjs';
import {ProviderRegistry,ResourceGate,validateProfile} from '../core/provider-registry.mjs';
import {encodeRequest,decodeResponse,ProviderError} from '../core/provider-protocols.mjs';

async function fixture(t,options={}){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-route-')),store=new Store(dir),network=new NetworkPolicy(store,options);t.after(async()=>{network.close();store.close();await rm(dir,{recursive:true,force:true});});return {store,network};}
const local=(id='local',extra={})=>({id,name:id,protocol:'chat-completions',baseUrl:'http://127.0.0.1:11434/v1',model:'test',domain:'device',capabilities:{text:true,tools:true,vision:true},...extra});
const cloud=(id='cloud',extra={})=>local(id,{baseUrl:'https://models.example/v1',domain:'cloud',...extra});
const response={role:'assistant',content:'checked'};
for(const [ip,wanted] of [['127.0.0.1','device'],['::1','device'],['10.0.0.4','lan'],['172.31.2.4','lan'],['192.168.10.2','lan'],['fd00::10','lan'],['169.254.169.254','reserved'],['::ffff:127.0.0.1','reserved'],['8.8.8.8','cloud'],['2001:4860:4860::8888','cloud'],['224.0.0.1','reserved']])
 test(`IP domain ${ip}`,()=>assert.equal(ipDomain(ip),wanted));
test('offline rejects internet and LAN before any DNS or transport; loopback still works',async t=>{
 let dns=0,io=0;const {network}=await fixture(t,{lookup:async()=>{dns++;return [{address:'8.8.8.8'}];},transport:async()=>{io++;return Response.json({ok:true});}});
 network.change({mode:'offline'},0);
 await assert.rejects(network.request('https://models.example/v1',{}, {profile:validateProfile(cloud())}),NetworkBlocked);
 await assert.rejects(network.request('http://192.168.1.2/v1',{}, {profile:validateProfile(local('lan',{domain:'lan',baseUrl:'http://192.168.1.2/v1',pinnedAddress:'192.168.1.2',allowPlainHttp:true}))}),NetworkBlocked);
 assert.equal(dns,0);assert.equal(io,0);const r=await network.request('http://localhost:1234/v1');assert.equal((await r.json()).ok,true);assert.equal(io,1);
});
test('trusted LAN pins only one inference origin/path; it is not permission for RFC1918 browsing',async t=>{
 let target;const {network}=await fixture(t,{lookup:async()=>{throw new Error('DNS must not be used for a pinned LAN host');},transport:async(a)=>{target=a;return Response.json({ok:true});}});
 network.change({mode:'trusted-lan'},0);
 const p=validateProfile(local('gpu',{baseUrl:'http://gpu.lan:8000/v1',domain:'lan',pinnedAddress:'192.168.1.50',allowPlainHttp:true}));
 await (await network.request(p.baseUrl+'/chat/completions',{}, {profile:p})).json();assert.equal(target.address,p.pinnedAddress);
 for(const u of ['http://gpu.lan:8001/v1/chat/completions','http://gpu.lan:8000/admin','http://192.168.1.51:8000/v1'])await assert.rejects(network.request(u,{}, {profile:p}),NetworkBlocked);
 await assert.rejects(network.request('http://gpu.lan:8000/v1',{}, {profile:p,purpose:'web'}),NetworkBlocked);
});
test('public URL cannot resolve to metadata, mixed public/private, or rebinding private address',async t=>{
 const {network}=await fixture(t,{lookup:async()=>[{address:'8.8.8.8'},{address:'127.0.0.1'}]});
 await assert.rejects(network.authorize('https://models.example/v1',{profile:validateProfile(cloud())}),/DNS/);
});
test('redirect responses never forward credentials to another destination',async t=>{
 const {network}=await fixture(t,{transport:async()=>new Response(null,{status:302,headers:{location:'https://elsewhere.example'}})});
 await assert.rejects(network.request('http://127.0.0.1:9999/v1'),/リダイレクト/);
});
test('request reads are bounded and release their active-policy handles',async t=>{
 const {network}=await fixture(t,{transport:async()=>new Response('1234567890')});
 const r=await network.request('http://127.0.0.1:1/v1',{}, {maxBytes:5});await assert.rejects(r.text(),/budget/);assert.equal(network.active.size,0);
});
test('policy change aborts cloud requests but not simultaneous loopback requests',async t=>{
 const handles=[];const {network}=await fixture(t,{lookup:async()=>[{address:'8.8.8.8'}],transport:async(a,init)=>{
  handles.push({a,signal:init.signal});return new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(init.signal.reason),{once:true});}}));}});
 const a=await network.request('https://models.example/v1',{}, {profile:validateProfile(cloud())}),b=await network.request('http://127.0.0.1:1/v1');
 const reading=a.text();network.change({mode:'offline'},0);await assert.rejects(reading);
 assert.equal(handles[0].signal.aborted,true);assert.equal(handles[1].signal.aborted,false);await b.body.cancel();
});
test('real Node socket transport works and honors same-origin endpoint scope',async t=>{
 const server=http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({path:q.url,host:q.headers.host}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const {network}=await fixture(t);const p=validateProfile(local('cpu',{baseUrl:`http://localhost:${server.address().port}/v1`}));
 const body=await(await network.request(p.baseUrl+'/models',{}, {profile:p})).json();assert.equal(body.path,'/v1/models');
});
test('fallback credentials never cross providers and selection is observable',async t=>{
 const {store,network}=await fixture(t);const used=[],events=[];store.listeners.add(e=>{if(e.type==='route.selected')events.push(e.data);});
 const r=new ProviderRegistry(store,network,{clientFactory:(p,k)=>({chat:async()=>{used.push({id:p.id,key:k});if(p.id==='cloud')throw new ProviderError(429);return response;}})});
 r.save({profiles:[cloud(),local()],routes:{main:{primary:'cloud',fallbacks:['local']}}},0);
 for(const p of r.get().profiles)r.setKey(p.id,`${p.id}-secret`,p.identity);
 const out=await r.invoke(r.pin(),[{role:'user',content:'data'}]);assert.equal(out.content,'checked');
 assert.deepEqual(used,[{id:'cloud',key:'cloud-secret'},{id:'local',key:'local-secret'}]);assert.deepEqual(events.map(e=>e.profileId),['cloud','local']);assert.ok(!JSON.stringify(r.publicSnapshot()).includes('secret'));
});
test('offline routes prefer the prepared local floor without testing cloud DNS',async t=>{
 const {store,network}=await fixture(t);const used=[];const r=new ProviderRegistry(store,network,{clientFactory:p=>({chat:async()=>{used.push(p.id);return response;}})});
 r.save({profiles:[cloud(),local()],routes:{main:{primary:'cloud',fallbacks:['local']}}},0);network.change({mode:'offline'},0);
 await r.invoke(r.pin(),[]);assert.deepEqual(used,['local']);assert.equal(r.offlineFloor().configured,true);assert.equal(r.offlineFloor().verified,false);
});
test('unknown vision capability is not silently treated as supported',()=>{
 const p=validateProfile(local('unknown',{capabilities:{text:true}}));assert.equal(p.capabilities.vision,null);
});
test('authentication/refusal/schema failures do not trigger an unrelated-provider fallback',async t=>{
 const {store,network}=await fixture(t);const used=[];const r=new ProviderRegistry(store,network,{clientFactory:p=>({chat:async()=>{used.push(p.id);throw new ProviderError(401);}})});
 r.save({profiles:[cloud(),local()],routes:{main:{primary:'cloud',fallbacks:['local']}}},0);await assert.rejects(r.invoke(r.pin(),[]),ProviderError);assert.deepEqual(used,['cloud']);
});
test('repeated failure has one shared cooldown across main and auxiliary routing',async t=>{
 const {store,network}=await fixture(t);const used=[];const r=new ProviderRegistry(store,network,{clientFactory:p=>({chat:async()=>{used.push(p.id);if(p.id==='cloud')throw new ProviderError(503);return response;}})});
 r.save({profiles:[cloud(),local()],routes:{main:{primary:'cloud',fallbacks:['local']},vision:{primary:'cloud',fallbacks:['local']}}},0);
 await r.invoke(r.pin(),[]);await r.invoke(r.pin('vision'),[],{requirement:'vision'});assert.deepEqual(used,['cloud','local','local']);
});
test('retargeting a named provider clears its session credential and invalidates old routes',async t=>{
 const {store,network}=await fixture(t);const r=new ProviderRegistry(store,network);const c={profiles:[cloud()],routes:{main:{primary:'cloud',fallbacks:[]}}};r.save(c,0);const old=r.pin();r.setKey('cloud','secret',r.get().profiles[0].identity);
 r.save({...c,profiles:[cloud('cloud',{baseUrl:'https://new.example/v1'})]},1);assert.equal(r.keyFor(r.get().profiles[0]),'');await assert.rejects(r.invoke(old,[]),/モデル/);
});
test('resource gate prioritizes conversation, cleans aborted waiters and does not over-admit',async()=>{
 const gate=new ResourceGate(),release=await gate.acquire('gpu',1),order=[],c=new AbortController();
 const a=gate.acquire('gpu',1,{priority:0}).then(r=>{order.push('work');r();});
 const b=gate.acquire('gpu',1,{priority:10}).then(r=>{order.push('chat');r();});
 const cancelled=gate.acquire('gpu',1,{signal:c.signal});c.abort(new Error('stop'));await assert.rejects(cancelled,/stop/);release();await Promise.all([a,b]);assert.deepEqual(order,['chat','work']);gate.close();
});
const canon=[{role:'system',content:'instructions'},{role:'user',content:'hello'},{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'echo',arguments:'{"a":1}'}}]},{role:'tool',tool_call_id:'c1',content:'{"result":2}'}];
const tool={type:'function',function:{name:'echo',parameters:{type:'object',properties:{a:{type:'number'}}}}};
for(const protocol of ['responses','anthropic','gemini','chat-completions'])test(`canonical tool roundtrip encoding for ${protocol}`,()=>{
 const p=validateProfile(local('test',{protocol})),body=encodeRequest(p,canon,{tools:[tool]});assert.ok(JSON.stringify(body).includes('echo'));
 if(protocol==='responses')assert.equal(body.store,false);
 if(protocol==='anthropic')assert.equal(body.messages.at(-1).content[0].tool_use_id,'c1');
 if(protocol==='gemini')assert.equal(body.contents.at(-1).parts[0].functionResponse.name,'echo');
});
for(const [protocol,body] of [
 ['responses',{status:'completed',output:[{type:'function_call',call_id:'c1',name:'echo',arguments:'{"a":1}'}]}],
 ['anthropic',{stop_reason:'tool_use',content:[{type:'tool_use',id:'c1',name:'echo',input:{a:1}}]}],
 ['gemini',{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'echo',args:{a:1}},thoughtSignature:'signed'}]}}]}],
 ['chat-completions',{choices:[{finish_reason:'tool_calls',message:canon[2]}]}]
])test(`decode typed tool call and preserve native signatures: ${protocol}`,()=>{
 const p=validateProfile(local('test',{protocol})),out=decodeResponse(p,body);assert.equal(out.tool_calls[0].function.name,'echo');assert.deepEqual(JSON.parse(out.tool_calls[0].function.arguments),{a:1});
 if(protocol==='gemini'){const same=encodeRequest(p,[...canon.slice(0,2),out]);assert.ok(JSON.stringify(same).includes('signed'));const other=encodeRequest({...p,identity:'different'},[...canon.slice(0,2),out]);assert.ok(!JSON.stringify(other).includes('signed'));}
});
for(const [protocol,body] of [['responses',{status:'incomplete',output:[]}],['anthropic',{stop_reason:'max_tokens',content:[]}],['gemini',{candidates:[{finishReason:'MAX_TOKENS'}]}],['chat-completions',{choices:[{finish_reason:'content_filter',message:{content:'partial'}}]}]])test(`refuse incomplete ${protocol} response`,()=>assert.throws(()=>decodeResponse(validateProfile(local('p',{protocol})),body)));

test('encoded API path traversal cannot escape a pinned inference prefix',async t=>{
 const {network}=await fixture(t);const p=validateProfile(local('lan',{domain:'lan',baseUrl:'http://gpu.lan:8000/v1',pinnedAddress:'192.168.1.9',allowPlainHttp:true}));
 for(const suffix of ['/%2e%2e%2fadmin','/%252e%252e%252fadmin','/..%5cadmin'])await assert.rejects(network.authorize(p.baseUrl+suffix,{profile:p}),/範囲外/);
});
test('dictation primary and fallbacks must remain on the same PC',async t=>{
 const {store,network}=await fixture(t),r=new ProviderRegistry(store,network);
 assert.throws(()=>r.save({profiles:[local(),cloud()],routes:{main:{primary:'local',fallbacks:[]},dictation:{primary:'local',fallbacks:['cloud']}}},0),/this PC/);
 assert.equal(r.get().profiles.length,0);
});

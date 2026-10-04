import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {Store} from '../core/store.mjs';
import {NetworkPolicy,NetworkBlocked} from '../core/network-policy.mjs';
import {fetchWeb} from '../core/web-tools.mjs';
import {Connectors} from '../core/connectors.mjs';
import {ToolHub} from '../core/tool-hub.mjs';
import {Harness} from '../core/harness.mjs';
import {Routines} from '../core/routines.mjs';
import * as ui from '../web/ui.mjs';

async function fixture(t,options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-boundary-')),store=new Store(dir),network=new NetworkPolicy(store,options),closers=[];
 t.after(async()=>{for(const close of closers.reverse())await close();network.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {store,network,closers};
}
const loopbacks=['localhost','localhost.','127.0.0.1','127.1','2130706433','0x7f000001','0177.0.0.1','[::1]','[::ffff:127.0.0.1]'];
for(const host of loopbacks)test(`public web fetch rejects loopback spelling ${host}`,async t=>{
 let io=0;const {network}=await fixture(t,{lookup:async()=>[{address:'127.0.0.1'}],transport:async()=>{io++;return new Response('local fixture');}});
 network.change({mode:'online',internetTools:true},0);
 await assert.rejects(fetchWeb(network,{url:`https://${host}/private?q=1`}),NetworkBlocked);assert.equal(io,0);
});
for(const mode of ['online','trusted-lan','offline'])test(`public web fetch requires online internet consent (${mode})`,async t=>{
 let dns=0,io=0;const {network}=await fixture(t,{lookup:async()=>{dns++;return [{address:'8.8.8.8'}];},transport:async()=>{io++;return new Response('fixture');}});
 network.change({mode,internetTools:mode!=='online'},0);
 for(const url of ['http://127.0.0.1/private','https://public.example/search?q=1'])await assert.rejects(fetchWeb(network,{url}),NetworkBlocked);
 assert.equal(dns,0);assert.equal(io,0);
});
for(const addresses of [['127.0.0.1'],['192.168.1.3'],['169.254.169.254'],['8.8.8.8','10.0.0.3']])test(`public web fetch rejects private DNS answers ${addresses.join(',')}`,async t=>{
 let io=0;const {network}=await fixture(t,{lookup:async()=>addresses.map(address=>({address})),transport:async()=>{io++;return new Response('fixture');}});
 network.change({internetTools:true},0);await assert.rejects(fetchWeb(network,{url:'https://public.example/?q=1'}),NetworkBlocked);assert.equal(io,0);
});
test('public web fetch pins public HTTPS with queries and keeps its bounded untrusted result',async t=>{
 let dns=0,target;const {network}=await fixture(t,{lookup:async()=>{dns++;return [{address:'8.8.8.8'}];},transport:async admitted=>{target=admitted;return new Response('<script>discard</script><p>'+('a'.repeat(110))+'</p>',{headers:{'Content-Type':'text/html'}});}});
 network.change({internetTools:true},0);const result=await fetchWeb(network,{url:'https://public.example/search?q=hello',maxChars:100});
 assert.equal(target.address,'8.8.8.8');assert.equal(target.url.search,'?q=hello');assert.equal(dns,1);assert.equal(result.content,'a'.repeat(100));assert.equal(result.truncated,true);assert.match(result.trust,/untrusted/);assert.equal(network.active.size,0);
});
test('public web DNS cannot rebind on the next request',async t=>{
 let dns=0,io=0;const {network}=await fixture(t,{lookup:async()=>[{address:++dns===1?'8.8.8.8':'127.0.0.1'}],transport:async()=>{io++;return new Response('public fixture');}});
 network.change({internetTools:true},0);await fetchWeb(network,{url:'https://public.example/'});await assert.rejects(fetchWeb(network,{url:'https://public.example/'}),NetworkBlocked);assert.equal(io,1);
});
test('revoking internet tools aborts public fetch while the local model continues',async t=>{
 const handles=[];const {network}=await fixture(t,{lookup:async()=>[{address:'8.8.8.8'}],transport:async(a,init)=>{handles.push({a,signal:init.signal});return new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(init.signal.reason),{once:true});}}),{headers:{'Content-Type':'text/plain'}});}});
 network.change({internetTools:true},0);const fetching=fetchWeb(network,{url:'https://public.example/'});
 while(handles.length<1)await new Promise(r=>setImmediate(r));
 const local=await network.request('http://localhost:1234/v1',{},{purpose:'model'});
 network.change({internetTools:false},1);await assert.rejects(fetching,NetworkBlocked);
 assert.equal(handles[0].signal.aborted,true);assert.equal(handles[1].signal.aborted,false);await local.body.cancel();
});
test('explicit local inference, HTTP MCP and configured RSS still work offline',async t=>{
 const targets=[];const {store,network}=await fixture(t,{lookup:async()=>{throw Error('No DNS for local controls');},transport:async a=>{targets.push(a);return new Response(a.purpose==='feed'?'<rss><item><title>Fixture news</title><link>https://public.example/news</link></item></rss>':'local fixture');}});
 network.change({mode:'offline'},0);
 for(const purpose of ['model','vision','worker'])assert.equal(await(await network.request('http://localhost:1234/v1',{},{purpose})).text(),'local fixture');
 store.value('execution-config',{mode:'legacy-host'});
 const hub=new ToolHub(store,network,{clientFactory:(c,_allow,fetch)=>({connect:async()=>{assert.equal(await(await fetch(c.url)).text(),'local fixture');}})});t.after(()=>hub.close());
 await hub.open({id:'local-mcp',name:'Local fixture',transport:'http',url:'http://localhost:1234/mcp',enabled:true}).connect();
 store.settings={...store.settings,allowNetwork:true,newsUrl:'http://localhost:1234/rss'};
 const news=await new Connectors(store,network).news();assert.equal(news.items[0].title,'Fixture news');assert.deepEqual(targets.map(x=>x.purpose),['model','vision','worker','web','feed']);
});
test('protected worker tool dispatch cannot fetch a local HTTP service',async t=>{
 let io=0;const {store,network,closers}=await fixture(t,{transport:async()=>{io++;return new Response('local fixture');}});
 const h=new Harness(store,new Connectors(store,network),{network,runtimeFactory:()=>({})});closers.push(()=>h.close());
 await assert.rejects(h.tool({id:'isolated-fixture',revision:1},'web_fetch',{url:'http://127.0.0.1/private'},{signal:new AbortController().signal,settings:store.settings,cloud:false,clients:new Map()}),NetworkBlocked);assert.equal(io,0);
});

const routine=(lastJobId,extra={})=>({id:'old-routine',title:'Imported routine',input:'A fixture',schedule:{type:'interval',minutes:60},lastJobId,...extra});
const bundle=collections=>({format:'tepora-v3-context',version:2,collections});
const markup='x"><form id="runtime-form"><button type="submit">marker</button></form><button data-id="x';
test('import remaps the last job reference and preserves safe disabled routine state',async t=>{
 const {store}=await fixture(t);store.import(bundle({routine:[routine('old-job',{enabled:true,runtime:{model:'untrusted'},destination:'untrusted'})],job:[{id:'old-job',status:'completed'}]}));
 const r=store.list('routine')[0],j=store.list('job')[0];assert.notEqual(r.id,'old-routine');assert.equal(r.lastJobId,j.id);assert.notEqual(j.id,'old-job');assert.equal(r.enabled,false);assert.equal(r.runtime,null);assert.equal(r.destination,null);assert.equal(j.resumeBlocked,true);
});
test('explicitly re-enabling an imported routine starts future work without resuming archived jobs',async t=>{
 const {store}=await fixture(t);store.import(bundle({routine:[routine('old-job',{revision:1,enabled:true})],job:[{id:'old-job',status:'completed'}]}));
 const imported=store.list('routine')[0],archived=store.list('job')[0],submitted=[];let now=1_000_000;
 const routines=new Routines(store,{submit:(input,kind,meta)=>{submitted.push({input,kind,meta});store.put('job',{id:meta.id,status:'queued'});}},{clock:()=>now});
 const enabled=routines.enable(imported.id,true,imported.revision);assert.equal(submitted.length,0);
 now=enabled.nextAt;routines.tick();assert.equal(submitted.length,1);assert.equal(store.get('routine',imported.id).status,'submitted');assert.notEqual(submitted[0].meta.id,archived.id);assert.equal(store.get('job',archived.id).resumeBlocked,true);assert.equal(store.get('job',archived.id).status,'interrupted');
});
test('re-enabling a normal routine still waits for its unfinished previous job',async t=>{
 const {store}=await fixture(t);store.put('job',{id:'active-job',status:'interrupted'});store.put('routine',routine('active-job',{revision:1,enabled:false}));let now=1_000_000,submitted=0;
 const routines=new Routines(store,{submit:()=>submitted++},{clock:()=>now});const enabled=routines.enable('old-routine',true,1);
 assert.equal(enabled.lastJobId,'active-job');now=enabled.nextAt;routines.tick();assert.equal(submitted,0);assert.equal(store.get('routine','old-routine').status,'previous-job-pending');
});
test('import clears malicious, dangling, host-existing and absent last job references',async t=>{
 const {store}=await fixture(t);store.put('job',{id:'host-job',status:'completed'});
 store.import(bundle({routine:[markup,'missing-job','host-job',null,undefined].map((id,n)=>routine(id,{id:`routine-${n}`}))}));
 for(const r of store.list('routine'))assert.equal(r.lastJobId,null);
});
test('invalid last job types reject the entire import before any write',async t=>{
 const {store}=await fixture(t);store.memory('existing fixture');const before=store.export(),seq=store.seq;
 for(const lastJobId of [true,1,{},['old-job']]){
  assert.throws(()=>store.import(bundle({memory:[{id:'new-memory',content:'must not persist'}],routine:[routine(lastJobId)]})),/last job/i);
  assert.deepEqual(store.export().collections,before.collections);assert.equal(store.seq,seq);
 }
});
const appSource=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');
const from=appSource.indexOf('function routineCard('),to=appSource.indexOf('\nfunction ',from+1);
const renderRoutine=vm.runInNewContext(appSource.slice(from,to)+'\nroutineCard',{escape:ui.escape,btn:ui.btn});
test('persisted routine last job values stay inside escaped attributes',()=>{
 const html=renderRoutine(routine(markup));assert.ok(!html.includes('<form'));assert.ok(html.includes(`data-id="${ui.escape(markup)}"`));
 const ordinary=renderRoutine(routine('valid-job-id'));assert.ok(ordinary.includes('data-action="task" data-id="valid-job-id"'));
});
test('form authority uses element identity, live ownership and no ID-based grants',()=>{
 const form={id:'runtime-form',isConnected:true},forged={id:'runtime-form',isConnected:true};let children=[form];
 const owner={querySelectorAll:()=>children,contains:f=>children.includes(f)};
 ui.registerForms(owner);assert.equal(ui.isTrustedForm(form),true);assert.equal(ui.isTrustedForm(forged),false);
 children.push(forged);assert.equal(ui.isTrustedForm(forged),false);
 form.isConnected=false;assert.equal(ui.isTrustedForm(form),false);form.isConnected=true;children=[forged];assert.equal(ui.isTrustedForm(form),false);
});

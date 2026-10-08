import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry} from '../core/provider-registry.mjs';
import {Capabilities} from '../core/capabilities.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';
import {Compactor} from '../core/agent/compaction.mjs';
import {SUMMARY_HEADINGS} from '../core/agent/prompts.mjs';
import {ModelDispatch,drainModelCalls,estimateModelUsage,modelUsageSnapshot} from '../core/model-usage.mjs';
import {startServer} from '../core/server.mjs';

// All provider traffic terminates in this process, after real network admission.
const profile=(extra={})=>({id:'p',protocol:'chat-completions',baseUrl:'https://api.example.invalid/v1',model:'m',domain:'cloud',...extra});
const prices={input:2,output:8,cache_read:0.5,cache_write:3};
const messages=[{role:'user',content:'synthetic prompt marker'}];
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const chat=(usage={prompt_tokens:100,completion_tokens:20},content='synthetic response marker')=>json({choices:[{message:{role:'assistant',content},finish_reason:'stop'}],...(usage===null?{}:{usage})});
const frame=body=>new TextEncoder().encode(`data: ${typeof body==='string'?body:JSON.stringify(body)}\n\n`);
const sse=frames=>new Response(new ReadableStream({start(c){for(const f of frames)c.enqueue(frame(f));c.close();}}),{headers:{'content-type':'text/event-stream'}});
const lookup=async()=>[{address:'93.184.216.34',family:4}];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=8000){const started=Date.now();for(;;){const value=await fn();if(value)return value;if(Date.now()-started>timeout)throw new Error('Model accounting fixture timed out');await wait(10);}}
function receipts(store){
 if(!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='native_model_receipts'").get())return [];
 return store.db.prepare('SELECT receipt FROM native_model_receipts ORDER BY seq').all().map(row=>JSON.parse(row.receipt));
}
function catalog(store,entries=[{modelId:'m',cost:prices}]){store.put('catalog',{id:'models.dev',entries});}
async function fixture(t,respond=()=>chat(),{profiles=[profile()],routes={main:{primary:'p'}},resolve=lookup}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-model-usage-')),store=new Store(dir),sent=[];
 const network=new NetworkPolicy(store,{lookup:resolve,transport:async(admitted,init)=>{const request={admitted,init,body:JSON.parse(init.body),index:sent.length};sent.push(request);return respond(request);}});
 const registry=new ProviderRegistry(store,network,{detectLimits:false});registry.save({profiles,routes},0);catalog(store);
 const sessions=new SessionStore(store);
 t.after(async()=>{network.close();registry.close();await drainModelCalls(store);store.close();await rm(dir,{recursive:true,force:true});});
 return {store,network,registry,sessions,sent};
}
function assertCost(actual,expected){assert.ok(Math.abs(actual-expected)<1e-12,`${actual} should equal ${expected}`);}

test('one streamed dispatch commits once, after decoding, with cache-aware estimated cost',async t=>{
 const f=await fixture(t,()=>sse([
  {type:'message_start',message:{usage:{input_tokens:60,cache_read_input_tokens:30,cache_creation_input_tokens:10,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'first'}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:' second'}},
  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20}},{type:'message_stop'}
 ]),{profiles:[profile({protocol:'anthropic'})]});
 const session=f.sessions.create({kind:'worker',title:'Synthetic accounting'}),writes=[];
 const call=f.store.db.call.bind(f.store.db);f.store.db.call=(op,payload)=>{if(op==='model.record')writes.push(payload.receipt);return call(op,payload);};
 const answer=await f.registry.invoke('work',messages,{accountingSessionId:session.id,onDelta:()=>assert.equal(writes.length,0,'token deltas must not persist receipts')});
 const [r]=receipts(f.store);assert.equal(writes.length,1);assert.equal(f.sent.length,1);assert.equal(answer.content,'first second');
 assert.deepEqual(r.usage,{input:100,output:20,cacheRead:30,cacheWrite:10});assert.equal(r.usageStatus.status,'complete');assert.equal(r.costStatus,'estimated');assertCost(r.cost,0.000325);
 assert.equal(r.sessionId,session.id);assert.equal(r.outcome,'completed');assert.equal(r.attempt,1);assert.equal(r.retry,false);assert.ok(r.elapsedMs>=0);
 assert.equal(f.sessions.get(session.id).stats.modelUsage.calls,1);assert.equal(f.sessions.get(session.id).stats.steps,0);
 assert.equal(f.store.value('agent-usage:'+r.at.slice(0,10)),null,'all-call accounting must not write normal-turn budgets');
});

test('partial, missing, and explicitly zero usage stay distinguishable in receipts and totals',async t=>{
 const cases=[{usage:{prompt_tokens:9},status:'partial',cost:null},{usage:null,status:'missing',cost:null},{usage:{prompt_tokens:0,completion_tokens:0},status:'complete',cost:0}];
 const f=await fixture(t,({index})=>chat(cases[index].usage));
 for(const expected of cases){await f.registry.invoke('work',messages);const r=receipts(f.store).at(-1);assert.equal(r.usageStatus.status,expected.status);assert.equal(r.cost,expected.cost);assert.equal(r.costStatus,expected.cost===null?'unknown-usage':'estimated');}
 const total=f.store.value('model-usage-total');assert.equal(total.calls,3);assert.equal(total.input,9);assert.equal(total.cost,0);assert.equal(total.unknownUsageCalls,2);assert.equal(total.unknownCostCalls,2);assert.equal(total.costStatus,'incomplete');
 const r=receipts(f.store).at(-1),day=r.at.slice(0,10),snapshot=modelUsageSnapshot(f.store,[day],day);assert.deepEqual(snapshot.today,total);assert.deepEqual(snapshot.total,total);
});

test('catalog ambiguity and missing cache rates remain unknown while explicit cache categories price once',async t=>{
 const f=await fixture(t),p=f.registry.get().profiles[0];
 catalog(f.store,[]);assert.equal(f.registry.price(p),null);
 catalog(f.store,[{modelId:'one/m',cost:{input:2,output:8}},{modelId:'two/m',cost:{input:3,output:8}}]);assert.equal(f.registry.price(p),null);
 catalog(f.store,[{modelId:'one/m',cost:{input:2,output:8}},{modelId:'two/m',cost:{input:3,output:8}},{modelId:'m',cost:prices}]);assert.deepEqual(f.registry.price(p),prices,'exact catalog IDs win over aliases');
 assert.equal(f.registry.price({...p,domain:'device'}),null,'local models are not assumed free');
 const answer={usage:{input:100,output:20,cacheRead:30,cacheWrite:10},usageStatus:{status:'complete',input:'reported',output:'reported'}};
 assert.deepEqual(estimateModelUsage(answer,{input:2,output:8}),{cost:null,costStatus:'unknown-price'});
 assertCost(estimateModelUsage(answer,prices).cost,0.000325);
 assertCost(estimateModelUsage({...answer,usage:{...answer.usage,input:60,uncachedOnly:true}},prices).cost,0.000325);
 assert.deepEqual(estimateModelUsage({...answer,usage:{input:1,output:0,cacheRead:2}},prices),{cost:null,costStatus:'unknown-usage'});
 catalog(f.store,[]);await f.registry.invoke('work',messages);assert.equal(receipts(f.store)[0].costStatus,'unknown-price');assert.equal(f.store.value('model-usage-total').unknownUsageCalls,0);
});

test('rejected admission and a cancelled resource queue never create a dispatch receipt',async t=>{
 const denied=await fixture(t,()=>assert.fail('DNS-rejected request reached transport'),{resolve:async()=>[{address:'127.0.0.1',family:4}]});
 await assert.rejects(denied.registry.invoke('work',messages));assert.equal(denied.sent.length,0);assert.deepEqual(receipts(denied.store),[]);assert.equal(denied.store.value('model-usage-total'),null);
 const queued=await fixture(t),p=queued.registry.get().profiles[0],release=await queued.registry.gate.acquire(p.resource,1);
 const controller=new AbortController();
 // Use a one-slot profile so the manually held lease keeps the invocation queued.
 queued.registry.save({profiles:[profile({maxParallel:1})],routes:{main:{primary:'p'}}},queued.registry.get().revision);
 const request=queued.registry.invoke('work',messages,{signal:controller.signal});const rejection=assert.rejects(request,/synthetic queued cancellation/);
 await until(()=>queued.registry.gate.snapshot().some(g=>g.queued===1));controller.abort(new Error('synthetic queued cancellation'));release();await rejection;
 assert.equal(queued.sent.length,0);assert.deepEqual(receipts(queued.store),[]);
});

test('parameter retries and provider fallback each record their own dispatched attempt',async t=>{
 const f=await fixture(t,({index})=>index===0?json({error:{message:'Unknown field: stream_options'}},400):index===1?json({error:{message:'synthetic rejected credentials'}},401):chat(),
  {profiles:[profile(),profile({id:'fallback'})],routes:{main:{primary:'p',fallbacks:['fallback']}}});
 const answer=await f.registry.invoke('work',messages),rows=receipts(f.store);
 assert.equal(answer.route.profileId,'fallback');assert.equal(f.sent.length,3);
 assert.deepEqual(rows.map(r=>[r.profileId,r.attempt,r.retry,r.outcome]),[['p',1,false,'error'],['p',2,true,'error'],['fallback',3,true,'completed']]);
 assert.equal(rows[0].cost,null);assert.equal(rows[1].usageStatus.status,'missing');assert.equal(f.store.value('model-usage-total').failedCalls,2);assert.equal(f.store.value('model-usage-total').retryCalls,2);
 assert.ok(!Object.hasOwn(f.sent[1].body,'stream_options'));
});

test('a failed Responses decoder preserves reported usage without pricing an incomplete answer',async t=>{
 const f=await fixture(t,()=>sse([{type:'response.output_text.delta',delta:'synthetic partial reply'},{type:'response.failed',response:{usage:{input_tokens:7},error:{code:'rate_limit_exceeded',message:'synthetic error body'}}}]),{profiles:[profile({protocol:'responses'})]});
 await assert.rejects(f.registry.invoke('work',messages));const [r]=receipts(f.store);
 assert.equal(f.sent.length,1);assert.equal(r.outcome,'error');assert.equal(r.usage.input,7);assert.equal(r.usageStatus.status,'partial');assert.equal(r.usageStatus.input,'reported');assert.equal(r.usageStatus.output,'missing');assert.equal(r.cost,null);assert.equal(r.costStatus,'unknown-usage');
 assert.equal(f.store.value('model-usage-total').input,7);assert.doesNotMatch(JSON.stringify(r),/synthetic partial reply|synthetic error body/);
});

test('cancelling an admitted stream records one partial receipt and drains before storage closes',async t=>{
 const controller=new AbortController();
 const f=await fixture(t,({init})=>new Response(new ReadableStream({start(c){
  init.signal.addEventListener('abort',()=>c.error(init.signal.reason),{once:true});
  c.enqueue(frame({choices:[],usage:{prompt_tokens:11}}));c.enqueue(frame({choices:[{delta:{content:'cancel now'}}]}));
 }}),{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(f.registry.invoke('work',messages,{signal:controller.signal,onDelta:()=>controller.abort(new Error('synthetic in-flight cancellation'))}),/synthetic in-flight cancellation/);
 await drainModelCalls(f.store);const rows=receipts(f.store);assert.equal(rows.length,1);assert.equal(f.sent.length,1);assert.equal(rows[0].outcome,'cancelled');assert.equal(rows[0].usage.input,11);assert.equal(rows[0].usageStatus.status,'partial');assert.equal(rows[0].cost,null);
});

test('the real compactor attributes summary retries to the session without changing normal budgets',async t=>{
 const summary=SUMMARY_HEADINGS.map(h=>`## ${h}\n- Synthetic saved fact for the next turn`).join('\n');
 const f=await fixture(t,({index})=>chat({prompt_tokens:5,completion_tokens:4},index===0?'invalid summary':summary));
 const session=f.sessions.create({kind:'worker',title:'Summary accounting'});
 const first=f.sessions.append(session.id,'input',{kind:'task',from:'user',text:'Synthetic task'}),last=f.sessions.append(session.id,'assistant',{content:'Synthetic earlier result',toolCalls:[]});
 const built={messages,view:{checkpoint:null,clearUpTo:0},tokens:200,rendered:[first,last].map(entry=>({entry,tokens:100,message:{role:entry.type==='input'?'user':'assistant',content:entry.text||entry.content}}))};
 const compactor=new Compactor({sessions:f.sessions,registry:f.registry});
 const checkpoint=await compactor.compact(session,{built,B:8000,ratio:1,toolDefs:[],chain:f.registry.chain('work'),signal:new AbortController().signal});
 assert.equal(checkpoint.method,'in-context');const rows=receipts(f.store);assert.equal(rows.length,2);
 assert.deepEqual(rows.map(r=>[r.purpose,r.attempt,r.retry,r.sessionId]),[['summary',1,false,session.id],['summary',2,true,session.id]]);
 const stats=f.sessions.get(session.id).stats;assert.equal(stats.modelUsage.byPurpose.summary,2);assert.equal(stats.modelUsage.calls,2);assert.equal(stats.steps,0);assert.equal(stats.compactions,1);assert.equal(f.store.value('agent-usage:'+rows[0].at.slice(0,10)),null);
});

test('typed decisions record transport completion with missing usage and no invented session',async t=>{
 const f=await fixture(t,({index})=>index===0?json({answers:{q:{type:'noul',noul:0.75}}}):index===1?json({answers:{}}):json({data:[{index:0,embedding:[1,2]}]}));
 const caps=new Capabilities(f.store,f.network);t.after(()=>caps.close());
 caps.save({profiles:[{id:'d',protocol:'system-one',baseUrl:'http://127.0.0.1/v1',model:'synthetic-decision',domain:'device'},{id:'e',protocol:'openai-embeddings',baseUrl:'http://127.0.0.1/v1',model:'synthetic-embedding',domain:'device'}],routes:{decision:'d',embedding:'e'}},0);
 const session=f.sessions.create({kind:'worker',title:'Unrelated session'}),questions={q:{type:'noul',instructions:'Synthetic yes/no'}};
 assert.equal((await caps.decide('synthetic private decision state',questions)).answers.q.noul,0.75);
 await assert.rejects(caps.decide('synthetic invalid decision',questions),/Invalid decision answer/);
 await caps.embed(['synthetic embedding']);const rows=receipts(f.store);assert.equal(rows.length,2,'other modalities remain excluded');
 for(const r of rows){assert.equal(r.purpose,'decision');assert.equal(r.sessionId,null);assert.equal(r.outcome,'completed');assert.equal(r.usageStatus.status,'missing');assert.equal(r.cost,null);}
 assert.equal(f.store.value('model-usage-total').byPurpose.decision,2);assert.equal(f.sessions.get(session.id).stats.modelUsage,undefined);assert.doesNotMatch(JSON.stringify(rows),/synthetic private decision state|synthetic invalid decision/);
});

test('typed decision HTTP failure and in-flight cancellation each record one missing-usage receipt',async t=>{
 const f=await fixture(t,({index,init})=>index===0?json({error:'synthetic rejected decision'},503):new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(init.signal.reason),{once:true});}})));
 const caps=new Capabilities(f.store,f.network);t.after(()=>caps.close());
 caps.save({profiles:[{id:'d',protocol:'system-one',baseUrl:'http://127.0.0.1/v1',model:'synthetic-decision',domain:'device'}],routes:{decision:'d'}},0);
 const questions={q:{type:'noul',instructions:'Synthetic yes/no'}};
 await assert.rejects(caps.decide('synthetic rejected state',questions),error=>error.upstreamStatus===503);
 const controller=new AbortController(),pending=caps.decide('synthetic cancelled state',questions,controller.signal),rejection=assert.rejects(pending,/synthetic decision cancellation/);
 await until(()=>f.sent.length===2);controller.abort(new Error('synthetic decision cancellation'));await rejection;await drainModelCalls(f.store);
 const rows=receipts(f.store);assert.equal(f.sent.length,2);assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.outcome),['error','cancelled']);
 for(const r of rows){assert.equal(r.purpose,'decision');assert.equal(r.sessionId,null);assert.equal(r.usageStatus.status,'missing');assert.equal(r.cost,null);assert.equal(r.costStatus,'unknown-usage');}
 assert.equal(f.store.value('model-usage-total').failedCalls,2);
});

test('a failed atomic accounting write surfaces a safe error without resending completed inference',async t=>{
 const f=await fixture(t);f.store.db.exec("CREATE TRIGGER reject_accounting BEFORE INSERT ON kv WHEN NEW.key='model-usage-total' BEGIN SELECT RAISE(ABORT,'synthetic private disk error'); END;");
 await assert.rejects(f.registry.invoke('work',messages),error=>{assert.equal(error.kind,'accounting');assert.equal(error.message,'Model dispatch accounting could not be persisted');return true;});
 assert.equal(f.sent.length,1);assert.deepEqual(receipts(f.store),[]);assert.equal(f.store.value('model-usage-total'),null);
 f.store.db.exec('DROP TRIGGER reject_accounting');await drainModelCalls(f.store);assert.equal(f.sent.length,1,'local recovery must not issue a second model request');
});

test('receipt lifecycle is idempotent and bounds metadata while excluding prompt, output, errors and keys',async t=>{
 const f=await fixture(t),p={id:'p'.repeat(500),model:'m'.repeat(1000),protocol:'x'.repeat(100),apiKey:'secret-key-marker',baseUrl:'https://private-endpoint.invalid'};
 const unused=new ModelDispatch(f.store,p);unused.finish(null,'error');assert.deepEqual(receipts(f.store),[]);
 const d=new ModelDispatch(f.store,p,{sessionId:'s'.repeat(500),purpose:'untrusted-purpose',attempt:0,price:prices});
 d.start();d.start();d.observe({content:'private-output-marker',error:'private-error-marker',usage:{input:4,output:2,arbitrary:'private-usage-marker'},usageStatus:{status:'complete',input:'reported',output:'reported',private:'private-status-marker'}});d.finish(null,'cancelled');d.finish(null,'error');await drainModelCalls(f.store);
 const rows=receipts(f.store),[r]=rows,encoded=JSON.stringify(r);assert.equal(rows.length,1);assert.equal(r.profileId.length,128);assert.equal(r.model.length,256);assert.equal(r.protocol.length,40);assert.equal(r.sessionId.length,128);assert.equal(r.purpose,'normal');assert.equal(r.attempt,1);assert.ok(Buffer.byteLength(encoded)<=4096);assert.equal(r.usageStatus.status,'partial');assert.equal(r.cost,null);
 assert.deepEqual(Object.keys(r.usage).sort(),['cacheRead','cacheWrite','input','output']);assert.deepEqual(Object.keys(r.usageStatus).sort(),['input','output','status']);assert.doesNotMatch(encoded,/private-|secret-key|baseUrl|apiKey|content|arbitrary|untrusted-purpose/);
});

test('normal budgets price reported uncached counters without charging inferred cache usage',async t=>{
 const f=await fixture(t),rt=new AgentRuntime(f.store,{registry:f.registry,network:f.network,autoStart:false,workRoot:path.join(f.store.dir,'work')});
 try{
  const session=rt.sessions.create({kind:'worker',title:'Raw usage accounting'}),reportedUsage={input:20,output:2,uncachedOnly:true};
  rt.account(session.id,{route:f.registry.get().profiles[0],usage:{input:220,output:2,cacheRead:200,uncachedOnly:true,estimated:true},usageStatus:{status:'complete',input:'reported',output:'reported'}},1,reportedUsage);
  const stats=rt.sessions.get(session.id).stats;assertCost(stats.cost,0.000056);assert.equal(stats.input,220);assert.equal(stats.cacheRead,200);assert.equal(stats.unknownCostCalls,0);
  assertCost(rt.usage().today.cost,0.000056);assert.equal(rt.usage().today.input,220);assert.equal(rt.usage().modelCalls.total,null,'legacy budget projection does not fabricate a dispatched receipt');
 }finally{await rt.close();}
});

test('ordinary Node server and agent expose the shared receipts through the public usage snapshot',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-model-http-')),sent=[];
 const app=await startServer({dir,networkOptions:{lookup,transport:async(admitted,init)=>{assert.ok(admitted.url.pathname.endsWith('/chat/completions'),'only synthetic model traffic is expected');sent.push(JSON.parse(init.body));return chat({prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:30}});}},registryOptions:{detectLimits:false}});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});catalog(app.store);
 const launch=await fetch(app.launchUrl,{redirect:'manual'});assert.equal(launch.status,303);const cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',body)=>fetch(app.origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await request('/api/providers','PUT',{expectedRevision:0,config:{profiles:[profile()],routes:{main:{primary:'p'}}}})).status,200);
 const admitted=await request('/api/agent/input','POST',{text:'Synthetic ordinary chat',requestId:'model-usage-smoke'});assert.equal(admitted.status,202);const {sessionId}=await admitted.json();
 await until(()=>!app.agent.runs.has(sessionId)&&app.agent.sessions.entries(sessionId,{types:['assistant']}).length===1);
 const response=await request('/api/agent');assert.equal(response.status,200);const publicState=await response.json(),usage=publicState.agent.usage;
 assert.equal(sent.length,1);const [r]=receipts(app.store);assert.equal(r.sessionId,sessionId);assert.equal(r.purpose,'normal');assertCost(r.cost,0.000315);
 assert.equal(usage.modelCalls.today.calls,1);assert.deepEqual(usage.modelCalls.total,app.store.value('model-usage-total'));assert.equal(usage.modelCalls.receiptRetention,512);assert.equal(usage.modelCalls.dayRetention,90);
 assert.equal(usage.today.calls,1);assertCost(usage.today.cost,r.cost);const stats=app.agent.sessions.get(sessionId).stats;assert.equal(stats.steps,1);assert.equal(stats.modelUsage.calls,1);assertCost(stats.cost,r.cost);
 // A completed second turn whose receipt cannot commit must not arm a provider retry.
 app.store.db.exec("CREATE TRIGGER reject_agent_accounting BEFORE INSERT ON kv WHEN NEW.key='model-usage-total' BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END;");
 assert.equal((await request('/api/agent/input','POST',{text:'Synthetic accounting failure',requestId:'model-usage-fault'})).status,202);
 await until(()=>sent.length===2&&!app.agent.runs.has(sessionId));
 assert.equal(app.agent.timers.has(sessionId),false,'local accounting failure must not schedule the 30-second provider retry');assert.notEqual(app.agent.sessions.get(sessionId).status,'waiting');assert.equal(app.agent.sessions.get(sessionId).retryAt??null,null);
 assert.equal(sent.length,2,'the failed turn dispatched exactly once');assert.equal(receipts(app.store).length,1);assert.equal(app.agent.usage().today.calls,1);
 app.store.db.exec('DROP TRIGGER reject_agent_accounting');
});

test('service close drains an independently dispatched stream before closing the sole SQLite owner',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-model-close-'));let sent=0,observed=false;
 const app=await startServer({dir,networkOptions:{lookup,transport:async(_admitted,init)=>{
  sent++;return new Response(new ReadableStream({start(c){
   init.signal.addEventListener('abort',()=>c.error(init.signal.reason),{once:true});
   c.enqueue(frame({choices:[],usage:{prompt_tokens:17}}));c.enqueue(frame({choices:[{delta:{content:'synthetic pending stream'}}]}));
  }}),{headers:{'content-type':'text/event-stream'}});
 }},registryOptions:{detectLimits:false}});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});catalog(app.store);
 app.registry.save({profiles:[profile()],routes:{main:{primary:'p'}}},0);const sessionId=app.agent.main().id;
 // This call is outside AgentRuntime.runs, so the server's model drain owns it.
 const pending=app.registry.invoke('work',messages,{accountingSessionId:sessionId,onDelta:()=>{observed=true;}}),rejection=assert.rejects(pending);
 await until(()=>observed);assert.deepEqual(receipts(app.store),[]);await app.close();await rejection;assert.equal(app.store.closed,true);assert.equal(sent,1);
 const reopened=new Store(dir);
 try{const [r]=receipts(reopened);assert.equal(receipts(reopened).length,1);assert.equal(r.outcome,'error');assert.equal(r.sessionId,sessionId);assert.equal(r.usage.input,17);assert.equal(r.usageStatus.status,'partial');assert.equal(r.cost,null);assert.equal(reopened.value('model-usage-total').calls,1);assert.equal(reopened.get('session',sessionId).stats.modelUsage.calls,1);}
 finally{reopened.close();}
});

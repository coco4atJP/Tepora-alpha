/** Rust execution control with the real store and JS plugin adapter. Fixtures
 * perform no network requests, shell commands, real-model calls or paid work. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry} from '../core/provider-registry.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(predicate,message='condition',timeout=3000){
 const start=Date.now();for(;;){const result=predicate();if(result)return result;if(Date.now()-start>timeout)throw new Error('Timed out waiting for '+message);await delay(5);}
}
async function bare(t,{settings={}}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-rust-execution-'));
 const store=new Store(dir),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network);
 store.value('agent-settings',{verifyCompletion:'off',metacognition:false,dream:false,...settings});
 const rt=new AgentRuntime(store,{registry,network,workRoot:path.join(dir,'work'),autoStart:false});
 const events=[];store.listeners.add(event=>events.push(event));
 const session=rt.sessions.create({kind:'worker',title:'Native execution fixture',cwd:dir});
 t.after(async()=>{await rt.close();registry.close();network.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {rt,store,registry,session,events};
}
function tool(rt,name,run,extra={}){
 return rt.tools.register({name,description:'Deterministic execution fixture '+name,parameters:{type:'object',properties:{label:{type:'string'},path:{type:'string'}}},run,...extra});
}
const call=(id,name,args={})=>({id,name,arguments:JSON.stringify(args)});
function batch(rt,session,calls,controller=new AbortController()){
 rt.sessions.append(session.id,'assistant',{content:'',toolCalls:calls});
 const promise=rt.loop.runTools(rt.sessions.get(session.id),calls,{signal:controller.signal,B:12000});
 const run={kind:session.kind,controller,promise};rt.runs.set(session.id,run);
 const clear=()=>{if(rt.runs.get(session.id)===run)rt.runs.delete(session.id);};promise.then(clear,clear);
 return promise;
}
const receipts=(rt,session)=>rt.sessions.entries(session.id,{types:['tool']});
function localModel(registry,invoke){
 const profile={id:'fixture',identity:'fixture',model:'fixture',maxTokens:2000,capabilities:{tools:true}};
 registry.chain=()=>[profile];registry.permitted=()=>true;registry.limits=async()=>({context:32000,source:'config'});registry.visionAllowed=()=>false;registry.invoke=invoke;registry.price=()=>null;
 return profile;
}

test('Rust execution: consecutive reads overlap, writes separate groups, receipts keep model order',async t=>{
 const {rt,session}=await bare(t),started=[],gates=Object.fromEntries(['a','b','c','d'].map(id=>[id,deferred()]));
 tool(rt,'probe_read',async args=>{started.push(args.label);await gates[args.label].promise;return {text:'result '+args.label};},{readOnly:true});
 tool(rt,'probe_write',async args=>{started.push(args.label);return {text:'result '+args.label};});
 const calls=[call('a','probe_read',{label:'a'}),call('b','probe_read',{label:'b'}),call('w','probe_write',{label:'w'}),call('c','probe_read',{label:'c'}),call('d','probe_read',{label:'d'})];
 const running=batch(rt,session,calls);
 try{
  await until(()=>started.length===2,'first parallel read group');assert.deepEqual(started,['a','b']);
  gates.b.resolve();await delay(20);assert.equal(receipts(rt,session).length,0,'a group is recorded only after every call settles');assert.deepEqual(started,['a','b']);
  gates.a.resolve();await until(()=>started.length===5,'write and second parallel group');assert.deepEqual(started,['a','b','w','c','d']);assert.deepEqual(receipts(rt,session).map(r=>r.callId),['a','b','w']);
  gates.d.resolve();await delay(20);assert.equal(receipts(rt,session).length,3);gates.c.resolve();await running;
  assert.deepEqual(receipts(rt,session).map(r=>r.callId),['a','b','w','c','d']);assert.deepEqual(receipts(rt,session).map(r=>r.content),['result a','result b','result w','result c','result d']);
 }finally{for(const g of Object.values(gates))g.resolve();await running.catch(()=>{});}
});

test('Rust execution: tools_call stays serial even when its inner tool is read-only',async t=>{
 const {rt,session}=await bare(t),started=[],first=deferred(),second=deferred();
 tool(rt,'inner_read',async args=>{started.push(args.label);await (args.label==='first'?first:second).promise;return args.label;},{readOnly:true});
 const running=batch(rt,session,[call('first','tools_call',{name:'inner_read',arguments:{label:'first'}}),call('second','tools_call',{name:'inner_read',arguments:{label:'second'}})]);
 try{
  await until(()=>started.length===1,'first wrapper');await delay(20);assert.deepEqual(started,['first']);first.resolve();await until(()=>started.length===2,'second wrapper');assert.deepEqual(receipts(rt,session).map(r=>r.callId),['first']);
  second.resolve();await running;assert.deepEqual(receipts(rt,session).map(r=>r.name),['inner_read','inner_read']);
 }finally{first.resolve();second.resolve();await running.catch(()=>{});}
});

test('Rust execution: MCP hook-rewritten arguments are the exact approved and executed arguments',async t=>{
 const target='mcp:fixture/get',rewritten={path:'approved/path'},executed=[];
 const {rt,session}=await bare(t,{settings:{policy:{rules:[{tool:target,action:'ask'}]}}});
 rt.tools.addHooks({beforeTool:({name})=>name===target?{args:rewritten}:null});rt.mcp.call=async(name,args)=>{executed.push({name,args});return {text:'MCP fixture result'};};
 const running=batch(rt,session,[call('mcp','tools_call',{name:target,arguments:{path:'original/path'}})]);
 const approval=await until(()=>rt.policy.list().find(a=>a.status==='pending'),'MCP approval');assert.deepEqual(approval.args,rewritten);assert.equal(executed.length,0);
 rt.policy.decide(approval.id,true);await running;assert.equal(executed.length,1);assert.equal(executed[0].name,target);assert.equal(executed[0].args,rewritten,'opaque argument identity reaches MCP');
 assert.deepEqual(receipts(rt,session)[0].args,approval.args);assert.equal(receipts(rt,session)[0].name,target);
});

test('Rust execution: mutating plugin-held arguments while approval waits prevents dispatch',async t=>{
 const rewritten={path:'reviewed/path'};let executed=0;const {rt,session}=await bare(t,{settings:{policy:{rules:[{tool:'probe_write',action:'ask'}]}}});
 tool(rt,'probe_write',async()=>{executed++;return 'unexpected';});rt.tools.addHooks({beforeTool:()=>({args:rewritten})});
 const running=batch(rt,session,[call('mutation','probe_write',{path:'original/path'})]);const approval=await until(()=>rt.policy.list().find(a=>a.status==='pending'),'mutation approval');
 assert.deepEqual(approval.args,{path:'reviewed/path'});rewritten.path='unapproved/path';rt.policy.decide(approval.id,true);await running;
 const result=receipts(rt,session)[0];assert.equal(executed,0);assert.equal(result.error,true);assert.equal(result.notExecuted,true);assert.match(result.content,/not executed/);assert.match(result.errorText,/Approved tool arguments changed before execution/);
 assert.deepEqual(rt.policy.list().find(a=>a.id===approval.id).args,{path:'reviewed/path'},'persisted approval remains the reviewed snapshot');
});

test('Rust execution: abort drains completed siblings and records later groups as not executed',async t=>{
 const {rt,session}=await bare(t);const controller=new AbortController();let slowStarted=false,fastFinished=false,writes=0;
 tool(rt,'probe_slow',async(_,ctx)=>{slowStarted=true;return new Promise((resolve,reject)=>{ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true});});},{readOnly:true});
 tool(rt,'probe_fast',async()=>({text:'successful sibling',data:{proof:'retained'}}),{readOnly:true});tool(rt,'probe_write',async()=>{writes++;return 'unexpected';});
 rt.tools.addHooks({afterTool:({name})=>{if(name==='probe_fast')fastFinished=true;return null;}});
 const running=batch(rt,session,[call('slow','probe_slow'),call('fast','probe_fast'),call('write','probe_write')],controller);
 await until(()=>slowStarted&&fastFinished,'both read siblings');controller.abort(new Error('Stopped by test'));await assert.rejects(running,/Stopped by test/);
 const results=receipts(rt,session);assert.deepEqual(results.map(r=>r.callId),['slow','fast','write']);assert.equal(writes,0);assert.equal(results[0].interrupted,true);assert.equal(results[1].interrupted,true);assert.equal(results[1].error,false);
 assert.match(results[1].content,/successful sibling/);assert.deepEqual(results[1].data,{proof:'retained'});assert.equal(results[2].notExecuted,true);assert.match(results[2].content,/not executed/);
});

test('Rust execution: stopping pending approval keeps the stopped note and never dispatches',async t=>{
 const {rt,session}=await bare(t,{settings:{policy:{rules:[{tool:'probe_write',action:'ask'}]}}});const controller=new AbortController();let writes=0;
 rt.sessions.update(session.id,{status:'running',note:'previous running note'});tool(rt,'probe_write',async()=>{writes++;return 'unexpected';});
 const running=batch(rt,session,[call('ask','probe_write')],controller);rt.runs.set(session.id,{kind:'worker',controller,promise:running});
 try{
  const approval=await until(()=>rt.policy.list().find(a=>a.status==='pending'),'approval before stop');assert.match(rt.sessions.get(session.id).note,/承認待ち/);rt.stop(session.id,'user stopped');
  await assert.rejects(running,/user stopped/);assert.equal(writes,0);assert.equal(rt.sessions.get(session.id).status,'stopped');assert.equal(rt.sessions.get(session.id).note,'user stopped');assert.equal(rt.policy.list().find(a=>a.id===approval.id).status,'withdrawn');assert.equal(receipts(rt,session)[0].notExecuted,true);
 }finally{controller.abort(new Error('test cleanup'));await running.catch(()=>{});rt.runs.delete(session.id);}
});

test('Rust execution: late model success and buffered deltas cannot mutate a stopped run',async t=>{
 const {rt,registry,session,events}=await bare(t),model=deferred();const controller=new AbortController();let invoked=false;
 localModel(registry,async(chain,messages,options)=>{
  invoked=true;options.onDelta('before stop');await model.promise;options.onDelta('late text');options.onReasoning('late reasoning');options.onProgress({total:100,processed:80});options.onRoute({identity:'late-route'});
  return {content:'late answer',tool_calls:[],usage:{input:42,output:7},route:{identity:'fixture'}};
 });
 rt.sessions.update(session.id,{status:'running'});const running=rt.loop.step(session.id,controller.signal);running.catch(()=>{});rt.runs.set(session.id,{kind:'worker',controller,promise:running});
 try{
  await until(()=>invoked,'model invocation');const before=rt.sessions.entries(session.id);rt.stop(session.id,'stop model');const eventCut=events.length;
  await delay(90);assert.equal(events.slice(eventCut).filter(e=>e.type==='agent.delta'&&e.data.text).length,0,'the buffered60ms stream timer must be discarded on stop');model.resolve();await assert.rejects(running,/stop model/);
  assert.deepEqual(rt.sessions.entries(session.id),before);assert.equal(rt.sessions.get(session.id).stats.steps,0);assert.notEqual(rt.sessions.get(session.id).route?.identity,'late-route');assert.equal(events.slice(eventCut).filter(e=>e.type==='agent.delta'&&(e.data.text||e.data.reasoning)).length,0);
 }finally{model.resolve();controller.abort(new Error('test cleanup'));await running.catch(()=>{});rt.runs.delete(session.id);}
});

test('Rust execution: opaque custom plugin result objects survive through stub callbacks',async t=>{
 const {rt,session}=await bare(t);const marker=Symbol('plugin-private');let stubResult,callbackArgs;
 const result={text:'plugin-visible result',data:{ok:true},privateValue:17,[marker]:'symbol survives',custom(){return this.privateValue*2;}};
 tool(rt,'custom_result',async args=>{callbackArgs=args;return result;},{stub:(args,value)=>{stubResult=value;assert.equal(args,callbackArgs);assert.equal(value[marker],'symbol survives');return 'custom '+value.custom();},ephemeral:true,ephemeralKey:args=>'plugin:'+args.label});
 await batch(rt,session,[call('plugin','custom_result',{label:'scope'})]);const entry=receipts(rt,session)[0];assert.equal(stubResult,result);assert.equal(entry.stub,'custom 34');assert.equal(entry.content,'plugin-visible result');assert.equal(entry.ephemeralKey,'plugin:scope');assert.deepEqual(entry.data,{ok:true});
});

test('Rust execution: lean fallback recalculates definitions before deciding the window is too small',async t=>{
 const {rt,registry,session}=await bare(t),seen=[];const profile=localModel(registry,async()=>({content:'ready',tool_calls:[],usage:{input:0,output:1},route:{identity:'fixture'}}));
 rt.loop.budget=async(s,defs)=>{const names=defs.map(d=>d.function.name);seen.push(names);return {chain:[profile],profile,limits:{context:16000,source:'config'},ratio:1,B:names.includes('tools_search')?900:5000,reserve:2000};};
 const outcome=await rt.loop.step(session.id,new AbortController().signal);assert.equal(outcome.turnEnded,true);assert.equal(outcome.text,'ready');assert.equal(rt.sessions.get(session.id).toolset,'lean');assert.equal(seen.length,2);assert.ok(seen[0].includes('tools_search'));assert.ok(!seen[1].includes('tools_search'),'lean rebudget must use the refreshed tool definitions');
});

test('Rust execution: custom thrown plugin error fields cannot strand the controller or lose its receipt',async t=>{
 const {rt,session}=await bare(t);
 tool(rt,'throws_private',async()=>{const error=new Error('plugin failed cleanly');error.body={owner:error};error.limit={circular:error};Object.defineProperty(error,'retryAfterMs',{get(){throw new Error('private error accessor must not escape');}});throw error;});
 tool(rt,'recovers_private',async()=>({text:'the next call runs'}));await batch(rt,session,[call('failed','throws_private')]);
 let results=receipts(rt,session);assert.equal(results.length,1);assert.equal(results[0].error,true);assert.match(results[0].errorText,/plugin failed cleanly/);assert.equal(JSON.parse(rt.loop.engine.state(session.id)).active,false);
 await batch(rt,session,[call('recovered','recovers_private')]);results=receipts(rt,session);assert.deepEqual(results.map(r=>r.callId),['failed','recovered']);assert.equal(results[1].error,false);assert.equal(results[1].content,'the next call runs');
});

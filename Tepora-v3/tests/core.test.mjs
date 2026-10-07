import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,symlink,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {endpoint,validateSettings,DEFAULT_SETTINGS,workspacePath} from '../core/policy.mjs';
import {Runtime} from '../core/runtime.mjs';
import {runProcess} from '../core/connectors.mjs';
import {MCPClient} from '../core/mcp.mjs';
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-test-'));const store=new Store(dir),cleanup=[];t.after(async()=>{for(const fn of cleanup.reverse())await fn();try{store.close();}catch{}await rm(dir,{recursive:true,force:true});});return {dir,store,cleanup};}
function streamResponse(text){const bytes=new TextEncoder().encode(text);return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),{headers:{'content-type':'text/event-stream'}});}
function packet(delta,finish=null){return `data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\r\n\r\n`;}
test('endpoint consent blocks remote, embedded credentials, cleartext and query strings',()=>{
 assert.equal(endpoint('http://127.0.0.1:8080/v1').hostname,'127.0.0.1');
 for(const u of ['https://example.org/v1','http://evil.example/v1','http://user:pass@127.0.0.1:80','http://127.0.0.1:80/?key=secret','file:///etc/passwd'])assert.throws(()=>endpoint(u));
 assert.equal(endpoint('https://example.org/v1',true).protocol,'https:');
 assert.throws(()=>validateSettings({concurrency:100},DEFAULT_SETTINGS));
 assert.throws(()=>validateSettings({apiKeyEnv:'SOME;COMMAND'},DEFAULT_SETTINGS));
});
test('workspace rejects traversal and symbolic links',async t=>{
 const {dir}=await fixture(t);for(const p of ['../escape','a/../../b','/tmp/outside','C:\\test','a\\b','x:stream',''])await assert.rejects(workspacePath(dir,p,true));
 const inside=await workspacePath(dir,'safe/note.txt',true);assert.equal(inside,path.join(await realpath(dir),'safe','note.txt'));
 await mkdir(path.join(dir,'target'));try{await symlink(path.join(dir,'target'),path.join(dir,'link'),process.platform==='win32'?'junction':'dir');}catch(e){if(e.code==='EPERM'){t.diagnostic('Symlink privilege unavailable on this runner');return;}throw e;}
 await assert.rejects(workspacePath(dir,'link/escape.txt',true));
});
test('memory confirmation and explicit per-memory cloud sharing are both enforced',async t=>{
 const {store}=await fixture(t);const privateDoc=store.memory('tea preference private');store.memory('tea preference proposed',{confirmed:false});const shared=store.memory('tea preference shareable',{scope:'shared'});
 assert.equal(store.recall('tea preference').length,2);
 assert.equal(store.recall('tea preference',{cloud:true}).length,0);
 assert.deepEqual(store.recall('tea preference',{cloud:true,share:true}).map(m=>m.id),[shared.id]);
 store.remove('memory',privateDoc.id);assert.equal(store.list('memory').length,2);
});
test('SQLite artifact versions and restart interrupted-state survive reopening',async t=>{
 const {dir,store,cleanup}=await fixture(t);store.artifact('Test','first',{id:'a'});store.artifact('Test','second',{id:'a'});store.put('job',{id:'inflight',status:'running'});store.close();const reopened=new Store(dir);cleanup.push(()=>reopened.close());assert.equal(reopened.get('artifact','a').version,2);assert.equal(reopened.get('revision','a:1').content,'first');assert.equal(reopened.get('job','inflight').status,'interrupted');
});
test('stream parser preserves fragmented UTF-8 and tool call arguments',async()=>{
 let seen='';const source=packet({content:'こんにちは'})+packet({tool_calls:[{index:0,id:'call1',function:{name:'artifact_publish',arguments:'{"title":"'}}]})+packet({tool_calls:[{index:0,function:{arguments:'見出し","content":"x","kind":"text"}'}}]},'tool_calls')+'data: [DONE]\n\n';
 const rt=new Runtime({...DEFAULT_SETTINGS,model:'test'},'',async()=>streamResponse(source));const answer=await rt.chat([],{onDelta:c=>seen+=c});assert.equal(seen,'こんにちは');assert.equal(answer.tool_calls[0].function.name,'artifact_publish');assert.equal(JSON.parse(answer.tool_calls[0].function.arguments).title,'見出し');
});
test('truncated or disconnected model output is not silently called complete',async()=>{
 const rt=new Runtime({...DEFAULT_SETTINGS,model:'test'},'',async()=>streamResponse(packet({content:'partial'})));await assert.rejects(rt.chat([]),/before the model completed/);
 const limited=new Runtime({...DEFAULT_SETTINGS,model:'test'},'',async()=>streamResponse(packet({content:'partial'},'length')+'data: [DONE]\n\n'));await assert.rejects(limited.chat([]),/truncated/);
});
test('Jev-like adapter sends actual System One question criteria and treats it as advisory',async()=>{
 let sent;const rt=new Runtime({...DEFAULT_SETTINGS,decisionUrl:'http://127.0.0.1:8011/v1/systemone'},'',async(u,o)=>{sent=JSON.parse(o.body);return Response.json({answers:{intent:{type:'choice',choice:'artifact',confidence:.7,probabilities:{conversation:.1,artifact:.7,computer:.1,research:.1}}}});});
 const decision=await rt.decide('Create a document');assert.equal(decision.choice,'artifact');assert.equal(sent.questions.intent.type,'choice');assert.ok(sent.questions.intent.criteria.computer);assert.match(sent.questions.intent.instructions,/NOT a security authorization/);
});
test('running process can be cancelled without waiting for natural exit',async()=>{
 const c=new AbortController();const task=runProcess(process.execPath,['-e','setTimeout(()=>{},30000)'],{cwd:os.tmpdir(),signal:c.signal});setTimeout(()=>c.abort(new Error('test stop')),80);await assert.rejects(task,/test stop/);
});
test('MCP stdio initialize, tools/list, tools/call and teardown',async()=>{
 const script=`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{let q=JSON.parse(line);if(!q.id)return;let result=q.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:q.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify(q.params.arguments)}]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`;
 const c=new MCPClient({transport:'stdio',command:process.execPath,args:['-e',script]},false);try{await c.connect();assert.equal((await c.request('tools/list',{})).tools[0].name,'echo');assert.match((await c.request('tools/call',{name:'echo',arguments:{hello:'world'}})).content[0].text,/world/);}finally{c.close();}
});

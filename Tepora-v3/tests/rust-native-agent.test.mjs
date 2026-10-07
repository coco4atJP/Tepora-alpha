/** Opt-in native agent acceptance through real HTTP, authentication and sockets.
 * Node runs only this fixture and its loopback scripted model. The service starts
 * by absolute Rust binary path with an empty PATH and isolated home/data. No
 * injected Rust transport, external model, credentials, or compatibility worker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserBundle} from '../core/frontend.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const web=path.join(root,'web');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let bundled;
function deadline(promise,label,ms=20000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
async function until(label,read,{timeout=15000}={}){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await read();if(last)return last;await delay(15);}throw new Error(`${label} did not settle; last=${JSON.stringify(last)}`);}
function parsed(response,status=200){assert.equal(response.status,status,response.text);assert.match(response.headers['content-type']||'',/^application\/json/);return JSON.parse(response.text);}
function request(origin,pathname,{method='GET',headers={},body}={}){
 const bytes=body===undefined?null:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
 return deadline(new Promise((resolve,reject)=>{
  const req=http.request(origin,{path:pathname,method,agent:false,headers:{...headers,...(bytes?{'Content-Length':bytes.length}:{})}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));
  });req.on('error',reject);req.end(bytes);
 }),`HTTP ${method} ${pathname} timed out`);
}
const answer=text=>({json:{choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:123,completion_tokens:7}}});
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const calls=items=>({json:{choices:[{message:{role:'assistant',content:'',tool_calls:items},finish_reason:'tool_calls'}],usage:{prompt_tokens:123,completion_tokens:11}}});
const streamed=chunks=>({sse:[...chunks.map(text=>({choices:[{delta:{content:text},finish_reason:null}]})),{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:123,completion_tokens:7}},'[DONE]']});

async function modelServer(t,script){
 const requests=[],allRequests=[],failures=[],sockets=new Set(),counts=new Map(),live=new Set();
 const server=http.createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):null;
   allRequests.push({path:req.url,method:req.method,body,headers:req.headers});
   if(req.method==='GET'&&req.url==='/props'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({default_generation_settings:{n_ctx:65536},total_slots:4}));return;}
   if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end('{}');return;}
   const model=body.model,index=counts.get(model)||0;counts.set(model,index+1);
   const record={model,index,body,headers:req.headers,path:req.url,closed:false};requests.push(record);live.add(record);res.once('close',()=>{record.closed=true;live.delete(record);});
   const reply=await script(model,index,body,record);
   if(reply?.hold)return;
   if(reply?.sse){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    for(const packet of reply.sse){
     const frame=Buffer.from(`data: ${typeof packet==='string'?packet:JSON.stringify(packet)}\r\n\r\n`);
     // Force an actual network split inside every UTF-8 scalar at least once.
     const scalar=frame.findIndex(byte=>byte>=0x80),cut=scalar>=0?scalar+1:frame.length-3;
     for(const chunk of [frame.subarray(0,cut),frame.subarray(cut)]){if(!res.destroyed)res.write(chunk);await delay(2);}
    }res.end();return;
   }
   res.writeHead(reply?.status||200,{'Content-Type':'application/json',...reply?.headers});res.end(JSON.stringify(reply?.json||{}));
  }catch(error){failures.push(error);if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});if(!res.destroyed)res.end(JSON.stringify({error:{message:String(error.message)}}));}
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const model={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,requests,allRequests,failures,live,async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));},assertHealthy(){assert.deepEqual(failures.map(e=>e.message),[]);}};
 t.after(async()=>{await model.close();model.assertHealthy();});return model;
}
async function fixture(t){
 await access(binary,constants.X_OK).catch(()=>{throw new Error(`Build native service before this test: ${binary}`);});
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-agent-')),data=path.join(dir,'data'),emptyPath=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');
 await mkdir(data);await mkdir(emptyPath);await writeFile(bundle,await(bundled??=browserBundle(web)));
 const apps=[],streams=[],children=[];const f={dir,data,emptyPath,bundle,apps,streams};
 f.start=async()=>{
  const env={PATH:emptyPath,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
  const args=['--dev-native','--agent','--sidecar','--port','0','--data-dir',data,'--web-dir',web,'--bundle',bundle];
  const child=spawn(binary,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child);let stderr='';const lines=[];
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-64000);});child.stdin.on('error',()=>{});
  const exited=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',(code,signal)=>resolve({code,signal}));});let ended=false;exited.then(()=>{ended=true;});
  const reader=createInterface({input:child.stdout});
  const ready=await deadline(new Promise((resolve,reject)=>{
   reader.on('line',line=>{lines.push(line);try{const value=JSON.parse(line);if(value.type==='ready')resolve(value);else reject(new Error(`Unexpected stdout: ${line}`));}catch(error){reject(error);}});
   exited.then(result=>reject(new Error(`Service exited before ready: ${JSON.stringify(result)} ${stderr}`)));
  }),'Native agent did not become ready');
  assert.equal(ready.mode,'native-agent-development');assert.equal(ready.version,'3.0.0-beta.11');const url=new URL(ready.url);assert.equal(url.hostname,'127.0.0.1');
  const exchange=await request(url.origin,url.pathname+url.search);assert.equal(exchange.status,303);const cookie=exchange.headers['set-cookie'][0].split(';')[0];
  const headers={Cookie:cookie,'Content-Type':'application/json'};const bootstrap=parsed(await request(url.origin,'/api/bootstrap',{headers}));headers['X-Tepora-CSRF']=bootstrap.csrf;
  const app={child,env,args,origin:url.origin,cookie,headers,bootstrap,lines,exited,get stderr(){return stderr;},request:(pathname,method='GET',body)=>request(url.origin,pathname,{method,headers,body}),async close(command='shutdown'){
   if(!ended){if(command==='eof')child.stdin.end();else if(command==='SIGINT'||command==='SIGTERM')child.kill(command);else child.stdin.write(command+'\n');
    try{const result=await deadline(exited,`Native agent shutdown stalled: ${stderr}`,10000);assert.equal(result.code,0,stderr);}catch(error){child.kill('SIGKILL');await exited;throw error;}}
   reader.close();
  }};apps.push(app);return app;
 };
 t.after(async()=>{for(const stream of streams)stream.close();for(const app of apps.reverse())await app.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});});
 return f;
}
async function configure(app,model,{offline=true}={}){
 const snapshot=parsed(await app.request('/api/providers'));assert.equal(snapshot.revision,0);
 const base={protocol:'chat-completions',baseUrl:model.baseUrl,domain:'device',contextTokens:65536,maxTokens:2048,maxParallel:4,sessionHeader:'x-fixture-session'};
 const config={profiles:[{...base,id:'main-fixture',model:'main'},{...base,id:'work-fixture',model:'worker'}],routes:{main:{primary:'main-fixture'},work:{primary:'work-fixture'}}};
 const saved=parsed(await app.request('/api/providers','PUT',{config,expectedRevision:0}));assert.equal(saved.revision,1);assert.equal(saved.profiles.length,2);
 assert.deepEqual(parsed(await app.request('/api/providers/main-fixture/key','POST',{key:'fixture-secret-key'})),{id:'main-fixture',keyPresent:true});
 if(offline){const changed=parsed(await app.request('/api/network','PATCH',{patch:{mode:'offline',internetTools:false},expectedRevision:0.0}));assert.equal(changed.mode,'offline');}
 return config;
}
async function transcript(app,id){return parsed(await app.request(`/api/agent/sessions/${id}`));}
async function waitAnswer(app,id,text){return until(`assistant ${text}`,async()=>{const state=await transcript(app,id);return state.entries.some(entry=>entry.type==='assistant'&&entry.content===text)&&state;});}
async function openEvents(f,app){
 const packets=[];let buffer='',response;
 const req=http.request(app.origin,{path:'/api/events?since=0',agent:false,headers:{Cookie:app.cookie,'Last-Event-ID':'0'}});
 await deadline(new Promise((resolve,reject)=>{req.on('error',reject);req.on('response',res=>{
  response=res;assert.equal(res.statusCode,200);res.setEncoding('utf8');res.on('error',()=>{});res.on('data',chunk=>{
   buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data)packets.push({raw,event:JSON.parse(data)});}
  });resolve();});req.end();}),'SSE did not connect');
 const stream={packets,close(){response?.destroy();req.destroy();}};f.streams.push(stream);return stream;
}

 test('Rust native agent: authenticated configuration, real SSE inference and input dedup without Node',async t=>{
 const model=await modelServer(t,()=>streamed(['Hello ','native 日本😀'])),f=await fixture(t),app=await f.start();
 assert.equal(app.env.PATH,f.emptyPath);assert.equal(app.bootstrap.nativeHost.agentExecution,true);assert.equal(app.bootstrap.nativeHost.nodeRequired,false);
 const unauth=await request(app.origin,'/api/providers');assert.equal(unauth.status,401);
 const noCsrf=await request(app.origin,'/api/providers',{method:'PUT',headers:{Cookie:app.cookie,'Content-Type':'application/json'},body:{}});assert.equal(noCsrf.status,403);
 await configure(app,model);const stream=await openEvents(f,app),id=app.bootstrap.dialogue.session.id;
 const receipts=await Promise.all([app.request('/api/agent/input','POST',{text:'Say hello once',requestId:'native-request-1'}),app.request('/api/agent/input','POST',{text:'Say hello once',requestId:'native-request-1'})]);
 assert.deepEqual(parsed(receipts[0],202),parsed(receipts[1],202));assert.deepEqual(parsed(receipts[0],202),{accepted:true,sessionId:id,requestId:'native-request-1'});
 const state=await waitAnswer(app,id,'Hello native 日本😀');assert.equal(state.entries.filter(e=>e.type==='input').length,1);assert.equal(state.entries.filter(e=>e.type==='assistant').length,1);
 await until('projected SSE final delta',()=>stream.packets.find(p=>p.event.type==='dialogue.delta'&&p.event.data.done&&p.event.data.text==='Hello native 日本😀'));
 const hidden=['session.entry','session.inbox','agent.delta','agent.event','agent.reply','agent.finished'];assert.ok(stream.packets.every(p=>!hidden.includes(p.event.type)));
 await delay(100);assert.equal(model.requests.length,1);const sent=model.requests[0];assert.equal(sent.headers['user-agent'],'Tepora/3.0 (local agent harness)');assert.equal(sent.headers.authorization,'Bearer fixture-secret-key');assert.match(sent.headers['x-fixture-session'],/^tepora-[0-9a-f]{32}$/);
 assert.equal(sent.body.messages[0].role,'system');assert.match(sent.body.messages[0].content,/Native availability/);assert.ok(sent.body.tools.some(t=>t.function.name==='sessions_spawn'));assert.ok(!sent.body.tools.some(t=>t.function.name==='exec'));
 assert.ok(model.allRequests.some(r=>r.path==='/props'));assert.ok(state.session.stats.input>0);assert.equal(state.session.stats.cost,0);
 assert.ok(!JSON.stringify(parsed(await app.request('/api/providers'))).includes('fixture-secret-key'));
 if(process.platform==='linux'){const children=await readFile(`/proc/${app.child.pid}/task/${app.child.pid}/children`,'utf8').catch(()=>null);if(children!==null)assert.equal(children.trim(),'');}
 });

 test('Rust native agent: main delegation executes file tools, artifact and exactly one parent report',async t=>{
 const model=await modelServer(t,(name,index,body)=>{
  if(name==='main')return index===0?calls([call('spawn-1','sessions_spawn',{task:'Write result.md, read it, edit before to after, read back, and publish a verified Markdown artifact.',title:'File worker'})]):answer(JSON.stringify(body.messages).includes('WORKER_DONE')?'PARENT_CONFIRMED':'The worker is running');
  assert.equal(name,'worker');if(index===0)return calls([
   call('write-1','write',{path:'result.md',content:'before\n'}),call('read-1','read',{path:'result.md'}),call('edit-1','edit',{path:'result.md',old_string:'before',new_string:'after'}),call('read-2','read',{path:'result.md'}),
   call('artifact-1','artifact',{action:'publish',title:'Verified result',kind:'markdown',content:'after\n'}),call('todo-1','todo',{items:[{text:'Write, edit, read and publish result.md',status:'done'}]}),call('reflect-1','reflect',{verified:['Read result.md after editing'],confidence:1,next:'Report the result'})]);
  return answer('WORKER_DONE: result.md is written and verified, and the artifact is published');
 }),f=await fixture(t),app=await f.start();await configure(app,model);const main=app.bootstrap.dialogue.session.id;
 parsed(await app.request('/api/agent/input','POST',{text:'Delegate the result file and artifact'}),202);await waitAnswer(app,main,'PARENT_CONFIRMED');
 const sessions=parsed(await app.request('/api/agent/sessions'));const workers=sessions.filter(s=>s.kind==='worker');assert.equal(workers.length,1);const worker=workers[0];assert.equal(worker.parentId,main);assert.equal(worker.status,'done');
 assert.equal(await readFile(path.join(worker.cwd,'result.md'),'utf8'),'after\n');const state=await transcript(app,worker.id);const receipts=state.entries.filter(e=>e.type==='tool');assert.deepEqual(receipts.map(e=>e.callId),['write-1','read-1','edit-1','read-2','artifact-1','todo-1','reflect-1']);assert.ok(receipts.every(e=>!e.error));
 assert.equal(state.session.todo[0].status,'done');assert.equal(state.session.reflection.confidence,1);const artifacts=parsed(await app.request('/api/artifacts'));const artifact=artifacts.find(a=>a.jobId===worker.id);assert.equal(artifact.content,'after\n');assert.equal(artifact.version,1);
 const parent=await transcript(app,main);assert.equal(parent.entries.filter(e=>e.type==='input'&&e.from==='child:'+worker.id&&e.kind==='report').length,1);
 });

 test('Rust native agent: Stop cancels a real model socket, rearms main and persists across restart',async t=>{
 const model=await modelServer(t,(_,index)=>index===0?{hold:true}:answer(index===1?'AFTER_STOP':'AFTER_RESTART')),f=await fixture(t);let app=await f.start();await configure(app,model);const id=app.bootstrap.dialogue.session.id;
 parsed(await app.request('/api/agent/input','POST',{text:'Wait indefinitely'}),202);await until('first model request',()=>model.requests.length===1);
 assert.deepEqual(parsed(await app.request(`/api/agent/sessions/${id}/stop`,'POST',{})),{stopped:true});await until('cancelled socket closes',()=>model.requests[0].closed);
 parsed(await app.request('/api/agent/input','POST',{text:'Continue on a fresh turn'}),202);const state=await waitAnswer(app,id,'AFTER_STOP');assert.equal(state.entries.filter(e=>e.type==='assistant').length,1);
 await app.close();assert.equal(model.live.size,0);app=await f.start();assert.equal(app.bootstrap.dialogue.session.id,id);assert.equal(parsed(await app.request('/api/providers')).revision,1);assert.equal(parsed(await app.request('/api/network')).mode,'offline');
 await delay(100);assert.equal(model.requests.length,2,'restart must not replay settled or cancelled inference');assert.ok((await transcript(app,id)).entries.some(e=>e.content==='AFTER_STOP'));
 parsed(await app.request('/api/agent/input','POST',{text:'One more turn'}),202);await waitAnswer(app,id,'AFTER_RESTART');assert.equal(model.requests.length,3);
 });

 test('Rust native agent: exact approval can be stopped, rejected late, then granted on fresh work',async t=>{
 const model=await modelServer(t,(name,index,body)=>name==='main'?answer('APPROVAL_PARENT'):body.messages.some(message=>message.role==='tool')?answer('WRITE_DONE'):calls([call('write-'+index,'write',{path:'approved.txt',content:'authorized bytes'})])),f=await fixture(t),app=await f.start();await configure(app,model);
 parsed(await app.request('/api/agent/settings','PATCH',{policy:{rules:[{tool:'write',action:'ask',note:'Confirm exact write'}]}}));
 const job=parsed(await app.request('/api/agent/spawn','POST',{task:'Write approved.txt',title:'Approval worker'}),202);
 const approval=await until('write approval',async()=>parsed(await app.request('/api/agent/approvals')).approvals.find(a=>a.status==='pending'));
 assert.equal(approval.name,'write');assert.deepEqual(approval.args,{path:'approved.txt',content:'authorized bytes'});
 const worker=(await transcript(app,job.id)).session;await assert.rejects(access(path.join(worker.cwd,'approved.txt')));
 parsed(await app.request(`/api/agent/sessions/${job.id}/stop`,'POST',{}));await until('approval withdrawn',async()=>!parsed(await app.request('/api/agent/approvals')).approvals.some(a=>a.id===approval.id&&a.status==='pending'));
 parsed(await app.request('/api/agent/approvals/'+approval.id,'POST',{allow:true}),409);await assert.rejects(access(path.join(worker.cwd,'approved.txt')));
 // A separate task is a new operation and cannot inherit the previous approval.
 const fresh=parsed(await app.request('/api/agent/spawn','POST',{task:'Write approved.txt again',title:'Approved worker'}),202);
 const next=await until('new exact approval',async()=>parsed(await app.request('/api/agent/approvals')).approvals.find(a=>a.status==='pending'&&a.id!==approval.id));
 const decided=parsed(await app.request('/api/agent/approvals','POST',{ids:[next.id,'not-an-approval'],allow:true}));assert.deepEqual(decided.results.map(r=>r.ok),[true,false]);
 await until('authorized file written',async()=>{const current=(await transcript(app,fresh.id)).session;try{return await readFile(path.join(current.cwd,'approved.txt'),'utf8')==='authorized bytes';}catch{return false;}});await waitAnswer(app,fresh.id,'WRITE_DONE');
 });

 test('Rust native agent: stopping all cancels an HTTP provider probe without disabling later inference',async t=>{
 const model=await modelServer(t,(_,index,body)=>String(body.messages?.[0]?.content).includes('safe tool protocol test')?{hold:true}:answer('AFTER_PROBE_STOP')),f=await fixture(t),app=await f.start();await configure(app,model);
 const probing=app.request('/api/providers/main-fixture/probe','POST',{});await until('probe model request',()=>model.requests.length===1);
 assert.deepEqual(parsed(await app.request('/api/stop','POST',{})),{stopped:true});const cancelled=await probing;assert.notEqual(cancelled.status,200,cancelled.text);assert.match(parsed(cancelled,cancelled.status).error,/cancel|stop/i);await until('probe socket closes',()=>model.requests[0].closed);
 parsed(await app.request('/api/agent/input','POST',{text:'Continue after probe stop'}),202);await waitAnswer(app,app.bootstrap.dialogue.session.id,'AFTER_PROBE_STOP');
 });

 test('Rust native agent: shutdown cancels a hanging HTTP probe before drain and releases the restart lease',async t=>{
 const model=await modelServer(t,(_,index,body)=>String(body.messages?.[0]?.content).includes('safe tool protocol test')?{hold:true}:answer('AFTER_SHUTDOWN')),f=await fixture(t);let app=await f.start();await configure(app,model);
 // The response may be a cancellation JSON error or a closed HTTP connection,
 // depending on the graceful-shutdown race. Either must settle without success.
 const probing=app.request('/api/providers/main-fixture/probe','POST',{}).catch(error=>({error}));await until('hanging shutdown probe reaches server',()=>model.requests.length===1);
 const started=Date.now();await app.close();assert.ok(Date.now()-started<6000,'shutdown must cancel the probe before its 90-second timeout');
 await until('shutdown aborts provider socket',()=>model.requests[0].closed,{timeout:3000});const result=await probing;if(!result.error)assert.notEqual(result.status,200,result.text);
 app=await f.start();assert.equal(parsed(await app.request('/api/providers')).revision,1);assert.equal(parsed(await app.request('/api/network')).mode,'offline');
 parsed(await app.request('/api/agent/input','POST',{text:'Use the released workspace after shutdown'}),202);await waitAnswer(app,app.bootstrap.dialogue.session.id,'AFTER_SHUTDOWN');assert.equal(model.requests.length,2);
 });

 test('Rust native agent: saturated probe admission leaves Stop responsive and shutdown drains queued requests',async t=>{
 const model=await modelServer(t,(_,index,body)=>String(body.messages?.[0]?.content).includes('safe tool protocol test')?{hold:true}:answer('AFTER_SATURATED_SHUTDOWN')),f=await fixture(t);let app=await f.start();await configure(app,model);
 // Twelve HTTP requests exceed both the four-probe admission limit and the
 // service's eight shared blocking workers. Pending admissions must not occupy
 // those workers or become abandoned native effects after the HTTP future ends.
 const pending=Array.from({length:12},()=>app.request('/api/providers/main-fixture/probe','POST',{}).then(response=>({response}),error=>({error})));
 await until('saturated model requests',()=>model.requests.length>=3);
 const acceptedBeforeStop=model.requests.length;
 const beforeStop=Date.now();assert.deepEqual(parsed(await deadline(app.request('/api/stop','POST',{}),'Stop was starved by probe requests',3000)),{stopped:true});assert.ok(Date.now()-beforeStop<3000);
 const settled=await deadline(Promise.all(pending),'queued HTTP probes survived Stop',3000);assert.equal(settled.length,12);for(const result of settled)if(result.response)assert.notEqual(result.response.status,200,result.response.text);
 await until('all accepted model sockets closed after Stop',()=>model.live.size===0,{timeout:3000});await delay(50);assert.equal(model.requests.length,acceptedBeforeStop,'queued old probes must not dispatch when Stop frees permits');
 const fresh=app.request('/api/providers/main-fixture/probe','POST',{}).catch(error=>({error}));await until('fresh probe after HTTP Stop',()=>model.requests.length===acceptedBeforeStop+1);
 app.child.stdin.write('stop\n');const sidecarStopped=await deadline(fresh,'sidecar Stop did not cancel fresh probe',3000);if(!sidecarStopped.error)assert.notEqual(sidecarStopped.status,200,sidecarStopped.text);assert.equal((await app.request('/health')).status,200);
 const finalProbe=app.request('/api/providers/main-fixture/probe','POST',{}).catch(error=>({error}));await until('fresh probe after sidecar Stop',()=>model.requests.length===acceptedBeforeStop+2);
 const beforeClose=Date.now();await app.close();assert.ok(Date.now()-beforeClose<6000,'shutdown must not queue behind saturated probes');await deadline(finalProbe,'probe survived shutdown',3000);
 await until('all accepted model sockets closed',()=>model.live.size===0,{timeout:3000});const count=model.requests.length;
 app=await f.start();await delay(100);assert.equal(model.requests.length,count,'pending HTTP admissions must not replay after restart');
 parsed(await app.request('/api/agent/input','POST',{text:'Continue after saturated shutdown'}),202);await waitAnswer(app,app.bootstrap.dialogue.session.id,'AFTER_SATURATED_SHUTDOWN');assert.equal(model.requests.length,count+1);
 });

 test('Rust native agent: tray Stop preserves the resident main socket and completed workers',async t=>{
 let releaseMain;const mainReply=new Promise(resolve=>{releaseMain=resolve;});
 const model=await modelServer(t,(name,index,body)=>{
  if(String(body.messages?.[0]?.content).includes('safe tool protocol test'))return {hold:true};
  const text=JSON.stringify(body.messages);
  if(name==='main'){
   if(text.includes('NEXT_MAIN_INPUT'))return answer('NEXT_MAIN_TURN');
   if(text.includes('KEEP_MAIN_RUNNING'))return mainReply;
   return answer('PREVIOUS_WORKER_REPORT');
  }
  if(text.includes('IDLE_FIXTURE'))return body.messages.some(message=>message.role==='tool')?answer('IDLE_DONE'):calls([call('idle-reflect','reflect',{understanding:'A completed fixture task',verified:['No external action was requested'],confidence:1})]);
  assert.ok(text.includes('BLOCK_WORKER'));return {hold:true};
 }),f=await fixture(t),app=await f.start();await configure(app,model);const main=app.bootstrap.dialogue.session.id;
 const completed=parsed(await app.request('/api/agent/spawn','POST',{task:'IDLE_FIXTURE: reflect and finish this task',title:'Completed fixture'}),202);
 await until('completed worker settles',async()=>{const state=await transcript(app,completed.id);return state.session.status==='done';});await waitAnswer(app,main,'PREVIOUS_WORKER_REPORT');
 parsed(await app.request('/api/agent/input','POST',{text:'KEEP_MAIN_RUNNING'}),202);
 const mainRequest=await until('resident main socket blocks',()=>model.requests.find(record=>record.model==='main'&&JSON.stringify(record.body.messages).includes('KEEP_MAIN_RUNNING')));
 const worker=parsed(await app.request('/api/agent/spawn','POST',{task:'BLOCK_WORKER: wait for cancellation',title:'Active fixture'}),202);
 const workerRequest=await until('worker socket blocks',()=>model.requests.find(record=>record.model==='worker'&&JSON.stringify(record.body.messages).includes('BLOCK_WORKER')));
 const probing=app.request('/api/providers/main-fixture/probe','POST',{}).catch(error=>({error}));
 const probeRequest=await until('HTTP probe socket blocks',()=>model.requests.find(record=>String(record.body.messages?.[0]?.content).includes('safe tool protocol test')));
 app.child.stdin.write('stop\n');
 await until('tray cancels worker and probe sockets',()=>workerRequest.closed&&probeRequest.closed,{timeout:3000});const probeResult=await probing;if(!probeResult.error)assert.notEqual(probeResult.status,200,probeResult.text);
 await until('active worker stops',async()=>(await transcript(app,worker.id)).session.status==='stopped');await delay(50);
 assert.equal(mainRequest.closed,false,'tray Stop must leave the actual resident upstream request open');assert.equal((await transcript(app,main)).session.status,'running');assert.equal((await transcript(app,completed.id)).session.status,'done','tray Stop must not rewrite completed workers');
 releaseMain(answer('MAIN_SURVIVED_TRAY_STOP'));await waitAnswer(app,main,'MAIN_SURVIVED_TRAY_STOP');
 parsed(await app.request('/api/agent/input','POST',{text:'NEXT_MAIN_INPUT'}),202);await waitAnswer(app,main,'NEXT_MAIN_TURN');
 });

 test('Rust native agent: real shell exec works without Node and yields custom receipts',async t=>{
 const model=await modelServer(t,(name,index,body)=>{
  if(name==='main')return answer('PROCESS_PARENT');
  if(index===0)return calls([call('exec-real','exec',{command:'echo NATIVE_EXEC_OK',yield:2,timeout:10})]);
  assert.match(JSON.stringify(body.messages),/NATIVE_EXEC_OK/);
  return answer('PROCESS_VERIFIED');
 }),f=await fixture(t),app=await f.start();await configure(app,model);
 parsed(await app.request('/api/agent/settings','PATCH',{verifyCompletion:'off'}));
 const job=parsed(await app.request('/api/agent/spawn','POST',{task:'Run the shell echo command and report its actual output.',title:'Native process'}),202);
 await waitAnswer(app,job.id,'PROCESS_VERIFIED');const state=await transcript(app,job.id);
 const receipt=state.entries.find(e=>e.type==='tool'&&e.callId==='exec-real');assert.ok(receipt);assert.ok(!receipt.error);assert.match(receipt.content,/NATIVE_EXEC_OK/);assert.match(receipt.stub,/exec/);
 const childRequest=model.requests.find(r=>r.model==='worker');assert.ok(childRequest.body.tools.some(t=>t.function.name==='exec'));assert.ok(childRequest.body.tools.some(t=>t.function.name==='process'));
 assert.equal(app.env.PATH,f.emptyPath);assert.ok(Array.isArray(state.processes));
 });

 test('Rust native agent: search credentials require authentication and stay out of public snapshots',async t=>{
 const f=await fixture(t),app=await f.start();
 const route='/api/agent/search-key';
 assert.equal((await request(app.origin,route,{method:'PUT',body:{provider:'brave',key:'fixture-web-secret'}})).status,401);
 assert.equal((await request(app.origin,route,{method:'PUT',headers:{Cookie:app.cookie,'Content-Type':'application/json'},body:{provider:'brave',key:'fixture-web-secret'}})).status,403);
 for(const body of [{provider:'other',key:'x'},{provider:'brave',key:4},{provider:'brave',key:'x'.repeat(501)}])assert.equal((await app.request(route,'PUT',body)).status,400);
 const stream=await openEvents(f,app);
 assert.deepEqual(parsed(await app.request(route,'PUT',{provider:'brave',key:'fixture-web-secret'})),{provider:'brave',keyPresent:true});
 const settings=parsed(await app.request('/api/agent/settings','PATCH',{webSearch:{provider:'searxng',searxngUrl:'http://127.0.0.1:17777/search',braveKeyEnv:'TEPORA_ABSENT_WEB_FIXTURE'}}));
 assert.equal(settings.webSearch.provider,'searxng');
 const bootstrap=parsed(await app.request('/api/bootstrap'));
 assert.ok(!bootstrap.nativeHost.unavailable.includes('web tools'));
 assert.ok(bootstrap.nativeHost.unavailable.includes('browser rendering'));
 assert.ok(!JSON.stringify([bootstrap,settings,parsed(await app.request('/api/agent/settings'))]).includes('fixture-web-secret'));
 await delay(50);assert.ok(!JSON.stringify(stream.packets).includes('fixture-web-secret'));
 assert.deepEqual(parsed(await app.request(route,'PUT',{provider:'brave',key:''})),{provider:'brave',keyPresent:false});
 });

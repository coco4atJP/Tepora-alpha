import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../core/server.mjs';
import {checkedRequest,NetworkBlocked} from '../core/network-policy.mjs';
import {ProviderError} from '../core/provider-protocols.mjs';
import {stageInputs} from '../core/input-files.mjs';
import {Computer} from '../core/computer.mjs';
import {Runtime} from '../core/runtime.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await sleep(10);}throw new Error('Condition timed out');}
const tool=(id,name,args)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const done={role:'assistant',content:'実行記録と成果物を確認してください。'};
const jsonAnswer=m=>Response.json({choices:[{finish_reason:m.tool_calls?'tool_calls':'stop',message:m}]});
const profile=(id,url,overrides={})=>({id,name:id,protocol:'chat-completions',baseUrl:url,model:id,domain:'device',capabilities:{text:true,tools:true,vision:false},...overrides});
// Valid 1x1 PNG. Pixel content is a test fixture, not a model accuracy claim.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
async function modelServer(t,respond){
 const requests=[];const s=http.createServer(async(req,res)=>{try{let bytes='';for await(const chunk of req)bytes+=chunk;
  const b=bytes?JSON.parse(bytes):{};requests.push({path:req.url,body:b,headers:req.headers});const value=await respond(b,req);
  res.writeHead(value.status||200,{'content-type':'application/json'});res.end(JSON.stringify(value.body||{choices:[{finish_reason:value.tool_calls?'tool_calls':'stop',message:value}]}));
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
 return {url:`http://127.0.0.1:${s.address().port}/v1`,requests};
}
async function service(t,options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-routing-'));const a=await startServer({dir,...options});
 t.after(async()=>{await a.close();await rm(dir,{recursive:true,force:true});});
 const launch=await fetch(a.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(a.origin+'/api/bootstrap',{headers:{cookie}})).json();
 const req=async(p,method='GET',data)=>{const response=await fetch(a.origin+p,{method,headers:{cookie,'content-type':'application/json','x-tepora-csrf':boot.csrf},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,body:await response.json()};};
 return {...a,req,dir};
}
test('real HTTP: offline provider completes a file/artifact job without DNS, downloads or external model calls',async t=>{
 let n=0,dns=0;const server=await modelServer(t,async()=>{n++;return n===1?tool('write','workspace_write',{path:'offline.json',content:'{"ok":true}'}):n===2?tool('art','artifact_publish',{title:'オフラインの成果物',content:'通信なしで作成した文書',kind:'text'}):done;});
 const a=await service(t,{networkOptions:{lookup:async()=>{dns++;throw new Error('Unexpected DNS');}}});
 await a.req('/api/providers','PUT',{expectedRevision:0,config:{profiles:[profile('cpu',server.url)],routes:{main:{primary:'cpu',fallbacks:[]}}}});
 await a.req('/api/network','PATCH',{expectedRevision:0,patch:{mode:'offline'}});
 const files=(await a.req('/api/inputs','POST',{files:[{name:'notes.txt',content:'必要な内容はok:true'}]})).body.files;
 const accepted=await a.req('/api/requests','POST',{requestId:randomUUID(),input:'オフラインでJSONと成果物を作って',attachmentIds:[files[0].id]});
 assert.equal(accepted.status,202);const j=accepted.body.job;
 await until(()=>!a.harness.active.size);
 assert.equal(a.store.get('job',j.id).status,'review');assert.equal(dns,0);
 assert.deepEqual(JSON.parse(await readFile(path.join(a.dir,'workspace','tasks',j.id,'offline.json'),'utf8')),{ok:true});
 assert.equal(a.store.list('artifact').find(x=>x.jobId===j.id).content,'通信なしで作成した文書');
 assert.equal(a.network.active.size,0);assert.equal(a.registry.gate.snapshot().every(g=>g.active===0&&g.queued===0),true);
});
test('real HTTP: named native Responses provider preserves tool result and store:false',async t=>{
 let n=0,receipt=false;
 const server=await modelServer(t,async b=>{assert.equal(b.store,false);n++;
  if(n===1)return {body:{status:'completed',output:[{type:'function_call',call_id:'r1',name:'artifact_publish',arguments:JSON.stringify({title:'Responses artifact',content:'native result',kind:'text'})}]}};
  receipt=b.input.some(x=>x.type==='function_call_output'&&x.call_id==='r1');return {body:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}]}};
 });
 const a=await service(t);a.registry.save({profiles:[profile('responses',server.url,{protocol:'responses'})],routes:{main:{primary:'responses',fallbacks:[]}}},0);
 const j=a.harness.submit('make artifact');await until(()=>!a.harness.active.size);
 assert.equal(a.store.get('job',j.id).status,'review');assert.equal(receipt,true);assert.ok(server.requests.every(r=>r.path==='/v1/responses'));
});
test('mid-stream mode change cancels cloud and uses only the approved local fallback; stale partial output is cleared',async t=>{
 let cloudStarted=false,cloudAborted=false,externalRequests=0;const local=await modelServer(t,async()=>({role:'assistant',content:'LOCAL-ANSWER'}));
 const a=await service(t,{networkOptions:{lookup:async()=>[{address:'8.8.8.8'}],transport:async(admit,init,scope)=>{
  if(admit.domain==='device')return checkedRequest(admit,init,scope);externalRequests++;cloudStarted=true;
  return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'STALE-CLOUD'},finish_reason:null}]})+'\n\n'));init.signal.addEventListener('abort',()=>{cloudAborted=true;c.error(init.signal.reason);},{once:true});}}),{headers:{'content-type':'text/event-stream'}});
 }}});
 a.registry.save({profiles:[profile('remote','https://cloud.example/v1',{domain:'cloud'}),profile('cpu',local.url)],routes:{main:{primary:'remote',fallbacks:['cpu']}}},0);
 const j=a.harness.submit('say hello','chat');await until(()=>cloudStarted);await sleep(25);a.network.change({mode:'offline'},0);await until(()=>!a.harness.active.size);
 assert.equal(cloudAborted,true);assert.equal(externalRequests,1);assert.equal(a.store.get('job',j.id).output,'LOCAL-ANSWER');
 assert.deepEqual(a.store.get('job',j.id).routeHistory.map(x=>x.profileId),['remote','cpu']);assert.equal(a.store.get('job',j.id).status,'completed');
 assert.equal(a.network.active.size,0);
});
test('role routing: chat delegates to its pinned work route, not a route edited in the meantime',async t=>{
 const used=[];let release;const hold=new Promise(resolve=>{release=resolve;});
 const a=await service(t,{registryOptions:{clientFactory:p=>({chat:async messages=>{
  used.push(p.id);if(p.id==='chat'&&!messages.some(m=>m.role==='tool')){await hold;return tool('delegate','task_submit',{input:'make a report'});}return done;
 }})}});
 a.registry.save({profiles:[profile('chat','http://127.0.0.1:9010/v1'),profile('worker','http://127.0.0.1:9011/v1'),profile('replacement','http://127.0.0.1:9012/v1')],routes:{main:{primary:'worker',fallbacks:[]},chat:{primary:'chat',fallbacks:[]},work:{primary:'worker',fallbacks:[]}}},0);
 const accepted=await a.req('/api/requests','POST',{input:'仕事を任せる',requestId:randomUUID()});assert.equal(accepted.status,202);
 const c=a.registry.get();const {validateProfile}=await import('../core/provider-registry.mjs');
 const profiles=c.profiles.map(({identity,...p})=>p);
 a.registry.save({profiles,routes:{...c.routes,work:{primary:'replacement',fallbacks:[]}}},1);release();
 await until(()=>!a.harness.active.size);const jobs=a.store.list('job'),parent=jobs.find(x=>x.kind==='chat'),child=jobs.find(x=>x.parentJobId===parent.id);
 assert.equal(parent.routeSnapshot.role,'chat');assert.equal(child.routeSnapshot.role,'work');assert.deepEqual(child.routeSnapshot.profiles.map(p=>p.id),['worker']);assert.deepEqual(used.sort(),['chat','chat','worker']);
});
test('real HTTP VLM fixture + simulated cloud text: pixels stay local; only consented, sourced, lossy text returns to main',async t=>{
 let pixelsSeen=false,cloudSawDerived=false;const v=await modelServer(t,async b=>{
  const image=b.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(p=>p.type==='image_url');pixelsSeen=image.image_url.url==='data:image/png;base64,'+png;
  return {role:'assistant',content:'入力画像には明るい1ピクセルが見えます。テスト用の観測です。'};
 });
 let imageId,calls=0;const a=await service(t,{networkOptions:{lookup:async()=>[{address:'8.8.8.8'}],transport:async(admit,init,scope)=>{
  if(admit.domain==='device')return checkedRequest(admit,init,scope);
  const b=JSON.parse(init.body);assert.ok(!init.body.includes(png));assert.ok(!init.body.includes('data:image/'));
  calls++;if(calls===1)return jsonAnswer(tool('see','image_analyze',{id:imageId,question:'画像に何が見える？'}));
  const result=b.messages.find(m=>m.role==='tool');cloudSawDerived=!!result?.content.includes('入力画像');
  return calls===2?jsonAnswer(tool('out','artifact_publish',{title:'観測結果',content:'出所付き画像観測',kind:'text'})):jsonAnswer(done);
 }}});
 a.registry.save({profiles:[profile('cloud','https://cloud.example/v1',{domain:'cloud',capabilities:{text:true,tools:true,vision:false}}),profile('vision',v.url,{capabilities:{text:true,tools:false,vision:true}})],routes:{main:{primary:'cloud',fallbacks:[]},vision:{primary:'vision',fallbacks:[]}}},0);
 const image=(await a.req('/api/inputs','POST',{files:[{name:'pixel.png',base64:png}]})).body.files[0];imageId=image.id;
 const denied=await a.req('/api/requests','POST',{requestId:randomUUID(),input:'画像の説明を書いて',attachmentIds:[imageId]});assert.equal(denied.status,403);assert.equal(calls,0);
 const context=(await a.req('/api/requests/context')).body;
 const accepted=await a.req('/api/requests','POST',{requestId:randomUUID(),input:'画像の説明を書いて',attachmentIds:[imageId],attachmentConsent:context.id});
 assert.equal(accepted.status,202);await until(()=>!a.harness.active.size);
 assert.equal(pixelsSeen,true);assert.equal(cloudSawDerived,true);assert.equal(v.requests.length,1);
 assert.equal(a.store.get('job',accepted.body.job.id).verification.checks.status,'checks-passed');
 const evidence=a.store.list('evidence').find(e=>e.name==='image_analyze');const result=JSON.parse(evidence.content);assert.equal(result.source.profileId,'vision');assert.match(result.trust,/lossy/);assert.ok(!JSON.stringify(a.store.events()).includes(png));
});
test('unknown Vision blocks a task rather than guessing image content or sending it elsewhere',async t=>{
 const a=await service(t,{registryOptions:{clientFactory:()=>({chat:async()=>done})}});
 a.registry.save({profiles:[profile('text','http://127.0.0.1:9000/v1',{capabilities:{text:true,tools:true,vision:null}})],routes:{main:{primary:'text',fallbacks:[]}}},0);
 const [image]=stageInputs(a.store,[{name:'pixel.png',base64:png}]);
 const job={id:'j',inputFiles:[image],routeSnapshot:a.registry.pin()};await assert.rejects(a.harness.vision.read(job,{id:image.id}),/Vision/);
});
test('offline does not open host CLI, MCP or Codex, but independent work still completes',async t=>{
 let n=0;const a=await service(t,{runtimeFactory:()=>({chat:async messages=>{
  if(messages.some(m=>m.content==='external operation'))return tool('command','run_command',{executable:process.execPath,args:['-e','throw new Error("must not start")']});return done;
 }})});a.store.value('execution-config',{revision:1,mode:'legacy-host',image:'',imageApproved:false}); // Explicit legacy-host opt-in for this host-path regression fixture.
a.network.change({mode:'offline'},0);
 const blocked=a.harness.submit('external operation'),local=a.harness.submit('plain explanation','chat');await until(()=>!a.harness.active.size);
 assert.equal(a.store.get('job',blocked.id).status,'blocked');assert.equal(a.store.get('job',local.id).status,'completed');assert.equal(a.harness.approvals.size,0);
 assert.equal(a.store.list('effect').length,0);
 for(const tool of ['run_command','mcp_tools','mcp_call'])assert.throws(()=>a.harness.guardTool(tool),NetworkBlocked);
});
test('verified unknown tool capability becomes usable, unknown vision does not',async t=>{
 const model=await modelServer(t,async b=>{const toolResult=b.messages.find(x=>x.role==='tool');
  if(toolResult)return {role:'assistant',content:JSON.parse(toolResult.content).receipt};
  return tool('probe','tepora_probe',{challenge:b.messages.at(-1).content.replace('Challenge: ','')});
 });const a=await service(t);a.registry.save({profiles:[profile('probe',model.url,{capabilities:{text:true,tools:null,vision:null}})],routes:{main:{primary:'probe',fallbacks:[]}}},0);
 assert.equal(a.registry.offlineFloor().configured,false);const result=await a.req('/api/providers/probe/probe','POST',{consent:true});assert.equal(result.status,200);assert.equal(result.body.ok,true);
 assert.equal(a.registry.offlineFloor().verified,true);assert.equal(a.registry.capable(a.registry.get().profiles[0],'vision'),false);
});
test('DNS stall respects caller cancellation and never reaches the socket transport',async t=>{
 let io=0;const a=await service(t,{networkOptions:{lookup:()=>new Promise(()=>{}),transport:()=>{io++;}}});const c=new AbortController();
 const pending=a.network.request('https://example.org', {signal:c.signal},{purpose:'model',allowCloud:true});c.abort(new Error('cancel-dns'));
 await assert.rejects(pending,/cancel-dns/);assert.equal(io,0);assert.equal(a.network.active.size,0);
});
test('ChatCompletions streamed refusals cannot carry an executable tool',async()=>{
 const data='data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:'content_filter'}]})+'\n\ndata: [DONE]\n\n';
 const runtime=new Runtime({baseUrl:'http://127.0.0.1:1/v1',model:'x'},'',async()=>new Response(data,{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(runtime.chat([]),/refused|filtered/);
});
// The original fixture owns directory deletion. A restarted service must release
// SQLite and its HTTP listener before control returns to that fixture's after hook.
async function withRestartedService(original,check){
 await original.close();const reopened=await startServer({dir:original.dir});
 try{return await check(reopened);}finally{await reopened.close();}
}
test('saved network policy survives service restart without widening the allowed route',async t=>{
 const a=await service(t);a.network.change({mode:'offline'},0);let reopened;
 await withRestartedService(a,b=>{reopened=b;assert.equal(b.network.get().mode,'offline');assert.equal(b.network.permitted('cloud','model'),false);});
 assert.equal(reopened.store.closed,true);assert.equal(reopened.server.listening,false);
});
test('restart fixture closes SQLite and HTTP before directory removal even when its assertion fails',async t=>{
 const a=await service(t);let reopened;const failure=new assert.AssertionError({message:'intentional fixture assertion failure'});
 await assert.rejects(withRestartedService(a,b=>{reopened=b;throw failure;}),error=>error===failure);
 // Enforce Windows' close-before-unlink requirement on every platform. Do not
 // retry or suppress EBUSY: a live store/listener is a real teardown failure.
 assert.equal(reopened.store.closed,true);assert.equal(reopened.server.listening,false);
 await rm(a.dir,{recursive:true,force:true});
});

test('provider recovery resumes only pinned safe requests, within a persisted retry budget',async t=>{
 let fail=true,now=Date.now();const a=await service(t,{registryOptions:{clock:()=>now,clientFactory:()=>({chat:async()=>{if(fail)throw new ProviderError(503);return done;}})}});
 a.registry.save({profiles:[profile('cpu','http://127.0.0.1:9981/v1')],routes:{main:{primary:'cpu',fallbacks:[]}}},0);
 const j=a.harness.submit('recover after temporary model outage','chat');await until(()=>!a.harness.active.size);
 assert.equal(a.store.get('job',j.id).blockedReason,'provider-unavailable');assert.equal(a.harness.recoverReady(),0);
 fail=false;now+=60000;assert.equal(a.harness.recoverReady(now),1);await until(()=>!a.harness.active.size);
 assert.equal(a.store.get('job',j.id).status,'completed');assert.equal(a.store.get('job',j.id).recoveryAttempts,1);
 a.store.put('job',{...a.store.get('job',j.id),status:'blocked',blockedReason:'provider-unavailable',recoveryAttempts:5,retryAfter:0});
 assert.equal(a.harness.recoverReady(Date.now()+60000),0);
});

test('offline attachments pin only currently permitted recipients; returning online does not add cloud consent',async t=>{
 let release;const hold=new Promise(r=>{release=r;});const used=[];
 const a=await service(t,{registryOptions:{clientFactory:p=>({chat:async()=>{used.push(p.id);await hold;return done;}})}});
 a.registry.save({profiles:[profile('cloud','https://cloud.example/v1',{domain:'cloud'}),profile('local','http://127.0.0.1:8811/v1')],routes:{main:{primary:'cloud',fallbacks:['local']}}},0);a.network.change({mode:'offline'},0);
 const ctx=(await a.req('/api/requests/context')).body;assert.equal(ctx.remote,false);assert.deepEqual(ctx.route.profiles.map(p=>p.id),['local']);
 const inputs=stageInputs(a.store,[{name:'private.txt',content:'private text'}]);
 const r=await a.req('/api/requests','POST',{requestId:randomUUID(),input:'explain',attachmentIds:[inputs[0].id]});assert.equal(r.status,202);
 a.network.change({mode:'online'},1);release();await until(()=>!a.harness.active.size);
 assert.ok(used.length&&used.every(id=>id==='local'));assert.deepEqual(a.store.get('job',r.body.job.id).routeSnapshot.profiles.map(p=>p.id),['local']);
});
test('explicit paused-job rebind preserves canonical checkpoint and requires current consent fingerprint',async t=>{
 let n=0,sawHistory=false;const a=await service(t,{registryOptions:{clientFactory:p=>({chat:async messages=>{
  if(p.id==='first')return tool('write','workspace_write',{path:'one.txt',content:'saved'});
  sawHistory=messages.some(m=>m.role==='tool'&&m.content.includes('written'));return done;
 }})}});a.store.settings={...a.store.settings,maxSteps:1};
 const ps=[profile('first','http://127.0.0.1:9001/v1'),profile('second','http://127.0.0.1:9002/v1')];
 a.registry.save({profiles:ps,routes:{main:{primary:'first',fallbacks:[]}}},0);
 const j=a.harness.submit('keep purpose and file');await until(()=>!a.harness.active.size);assert.equal(a.store.get('job',j.id).status,'paused');
 a.registry.save({profiles:ps,routes:{main:{primary:'second',fallbacks:[]}}},1);
 const proposal=(await a.req(`/api/jobs/${j.id}/route`)).body;
 assert.equal((await a.req(`/api/jobs/${j.id}/route`,'POST',{...proposal,consent:false})).status,403);
 assert.equal((await a.req(`/api/jobs/${j.id}/route`,'POST',{...proposal,routeId:'stale',consent:true})).status,409);
 assert.equal((await a.req(`/api/jobs/${j.id}/route`,'POST',{...proposal,consent:true})).status,200);
 await a.req(`/api/jobs/${j.id}/resume`,'POST',{});await until(()=>!a.harness.active.size);
 assert.equal(sawHistory,true);assert.equal(a.store.get('job',j.id).status,'review');assert.equal(a.store.list('effect').length,1);
});
test('model switching cannot waive an uncertain external action receipt',async t=>{
 const a=await service(t,{registryOptions:{clientFactory:()=>({chat:async()=>done})}});
 a.registry.save({profiles:[profile('cpu','http://127.0.0.1:9000/v1')],routes:{main:{primary:'cpu',fallbacks:[]}}},0);
 const j=a.harness.submit('work');await until(()=>!a.harness.active.size);
 a.store.put('effect',{id:'uncertain',jobId:j.id,status:'unknown'});
 const proposal=(await a.req(`/api/jobs/${j.id}/route`)).body;
 assert.equal((await a.req(`/api/jobs/${j.id}/route`,'POST',{...proposal,consent:true})).status,409);
});
test('raw Computer Use broker refuses unselected origin and state-changing background traffic',async t=>{
 const a=await service(t);a.network.change({internetTools:true},0);
 const s={jobId:'j',localDocument:false,controller:new AbortController(),config:{allowedOrigins:['https://example.org']}};
 a.harness.computer.session=s;
 await assert.rejects(a.harness.computer.browserRequest(s,{url:'https://other.example/',method:'GET'}),/origin/);
 await assert.rejects(a.harness.computer.browserRequest(s,{url:'https://example.org/',method:'POST',body:''}),/background/);
 a.harness.computer.session=null;
});

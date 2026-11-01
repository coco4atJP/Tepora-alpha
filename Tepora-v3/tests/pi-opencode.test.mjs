import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

test('OpenCode Go login and explicit refresh retain current IDs; real Pi SDK carries key, session and reasoning replay',async t=>{
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-pi-go-'))),requests=[];
 const app=cleanup.service(await startServer({dir,agentOptions:{autoStart:false},registryOptions:{detectLimits:false},networkOptions:{lookup:async()=>[{address:'8.8.8.8',family:4}],transport:async({url},init)=>{
  const h=new Headers(init.headers),b=JSON.parse(Buffer.from(init.body).toString());requests.push(b);
  const responses=b.model==='muse-spark-1.3-contributor';assert.equal(url.href,'https://opencode.ai/inference/go/openai/v1/'+(responses?'responses':'chat/completions'));assert.equal(h.get('authorization'),'Bearer synthetic-opencode-key');assert.match(h.get('user-agent'),/^Tepora\//);assert.match(h.get('x-opencode-session'),/^tepora-/);
  const n=requests.filter(x=>x.model===b.model).length;
  if(responses){
   if(n===2){assert.ok(b.input.some(x=>x.type==='function_call'&&x.call_id==='echo'));assert.ok(b.input.some(x=>x.type==='function_call_output'&&x.call_id==='echo'));assert.ok(b.input.some(x=>x.type==='reasoning'&&x.encrypted_content==='fixture-reasoning'));}
   const output=n===1?[{id:'rs_fixture',type:'reasoning',summary:[{type:'summary_text',text:'Synthetic reasoning'}],encrypted_content:'fixture-reasoning'},{id:'fc_echo',type:'function_call',call_id:'echo',name:'echo',arguments:'{"value":"proof"}',status:'completed'}]:[{id:'msg_verified',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'verified',annotations:[]}]}];
   const response={id:'resp_fixture_'+n,model:b.model,status:'completed',output,usage:{input_tokens:12,output_tokens:5,input_tokens_details:{cached_tokens:0}}};
   const events=[{type:'response.created',response:{...response,output:[],status:'in_progress'}},...output.flatMap((item,output_index)=>[{type:'response.output_item.added',output_index,item},{type:'response.output_item.done',output_index,item}]),{type:'response.completed',response}];
   return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  }
  if(n===1)return new Response('data: '+JSON.stringify({choices:[{delta:{role:'assistant',reasoning_content:'Synthetic reasoning',tool_calls:[{index:0,id:'echo',type:'function',function:{name:'echo',arguments:'{"value":"proof"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  if(b.model!=='mimo-v2.6-flash')assert.ok(b.messages.some(m=>m.reasoning_content==='Synthetic reasoning'));assert.equal(b.messages.at(-1).role,'tool');
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'verified'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:1}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }}}));
 const launch=await fetch(app.launchUrl,{redirect:'manual'});await launch.text();const cookie=launch.headers.get('set-cookie').split(';')[0];
 const api=async(url,method='GET',data)=>{const r=await fetch(app.origin+url,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':app.csrf,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});assert.equal(r.status,200);return r.json();};
 const a=await api('/api/pi/auth/start','POST',{provider:'opencode-go',type:'api_key',consent:true});
 const end=Date.now()+8000;while(!app.pi.snapshot().pending?.prompt){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,20));}
 const p=app.pi.snapshot().pending;await api('/api/pi/auth/respond','POST',{id:p.id,promptId:p.prompt.id,value:'synthetic-opencode-key'});await app.pi.pending.task;
 const catalog=await api('/api/pi/models/refresh','POST',{provider:'opencode-go',accountId:a.pending.accountId,consent:true});
 for(const id of ['deepseek-v4.1-flash','minimax-m3.1-flash-free','step-5-preview','mimo-v2.6-flash','muse-spark-1.3-contributor']){
  const m=catalog.models.find(m=>m.id===id);assert.ok(m,id);assert.equal(m.protocol,id==='muse-spark-1.3-contributor'?'responses':'chat-completions');
  const old=await api('/api/providers');await api('/api/providers','PUT',{expectedRevision:old.revision,config:{profiles:[{id:'go',engine:'pi-ai',piProvider:'opencode-go',authMode:'pi-key',accountId:a.pending.accountId,model:id,protocol:m.protocol,baseUrl:m.baseUrl,domain:'cloud',maxTokens:512,capabilities:{tools:true}}],routes:{main:{primary:'go'}}}});
  const tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{value:{type:'string'}}}}}],user={role:'user',content:'Echo proof'};
  const r=await app.registry.invoke('main',[user],{tools,cacheKey:'fixture-'+id});assert.equal(r._native.engine,'pi-ai');assert.equal(r.tool_calls[0].function.name,'echo');
  const next=await app.registry.invoke('main',[user,{role:'assistant',content:r.content,tool_calls:r.tool_calls,_native:r._native},{role:'tool',tool_call_id:r.tool_calls[0].id,content:'proof'}],{tools,cacheKey:'fixture-'+id});assert.equal(next.content,'verified');
 }
 assert.equal(requests.length,10);assert.doesNotMatch(JSON.stringify(await api('/api/providers')),/synthetic-opencode-key/);
});

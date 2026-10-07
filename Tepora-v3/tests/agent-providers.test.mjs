import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry,validateProfile} from '../core/provider-registry.mjs';
import {ProtocolClient,encodeRequest,ThinkSplitter,classifyResponse,overflowLimit} from '../core/provider-protocols.mjs';

const profile=(protocol,extra={})=>validateProfile({id:'p',protocol,baseUrl:'https://api.example.com/v1',model:'m',domain:'cloud',...extra});
const sse=frames=>new Response(new ReadableStream({start(c){const e=new TextEncoder();for(const f of frames){const s=`data: ${typeof f==='string'?f:JSON.stringify(f)}\n\n`;for(let i=0;i<s.length;i+=5)c.enqueue(e.encode(s.slice(i,i+5)));}c.close();}}),{headers:{'content-type':'text/event-stream'}});
const client=(p,response,seen)=>new ProtocolClient(p,'k',async(url,init)=>{seen?.push({url,body:JSON.parse(init.body)});return typeof response==='function'?response():response;});

test('chat completions: streamed text, reasoning, split tool arguments and usage',async()=>{
 const deltas=[];
 const r=await client(profile('chat-completions'),sse([{choices:[{delta:{reasoning_content:'考え中'}}]},{choices:[{delta:{content:'こん'}}]},{choices:[{delta:{content:'にちは'}}]},
  {choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'write',arguments:'{"pa'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'th":"a"}'}}]}}]},
  {choices:[{delta:{},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:120,completion_tokens:9,prompt_tokens_details:{cached_tokens:100}}},'[DONE]'])).chat([{role:'user',content:'hi'}],{onDelta:t=>deltas.push(t)});
 assert.equal(r.content,'こんにちは');assert.equal(r.reasoning,'考え中');assert.deepEqual(deltas,['こん','にちは']);
 assert.equal(r.tool_calls[0].function.arguments,'{"path":"a"}');assert.equal(r.finish,'tool_calls');
 assert.deepEqual(r.usage,{input:120,output:9,cacheRead:100,cacheWrite:0});
});
test('a leading <think> block is separated from the answer, even split across chunks',()=>{
 const text=[],reasoning=[];const s=new ThinkSplitter(t=>text.push(t),t=>reasoning.push(t));
 for(const c of ['<th','ink>まず','考える</th','ink>\n\n答え','です'])s.push(c);s.end();
 assert.equal(s.text,'答えです');assert.equal(s.reasoning,'まず考える');assert.equal(text.join(''),'答えです');
 const plain=new ThinkSplitter();plain.push('<b>bold</b> text');plain.end();assert.equal(plain.text,'<b>bold</b> text');
});
test('truncation is reported as finish "length" instead of throwing',async()=>{
 const r=await client(profile('chat-completions'),sse([{choices:[{delta:{tool_calls:[{index:0,id:'c',function:{name:'write',arguments:'{"content":"aaa'}}]}}]},{choices:[{delta:{},finish_reason:'length'}]}])).chat([{role:'user',content:'x'}]);
 assert.equal(r.finish,'length');assert.equal(r.tool_calls[0].function.arguments,'{"content":"aaa');
});
test('anthropic: streamed blocks, thinking signature kept for replay, cache breakpoints placed',async()=>{
 const seen=[],p=profile('anthropic');
 const r=await client(p,sse([{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:900,cache_creation_input_tokens:50,output_tokens:1}}},
  {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'hmm'}},{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'sig'}},
  {type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Hi'}},
  {type:'content_block_start',index:2,content_block:{type:'tool_use',id:'t1',name:'read',input:{}}},{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"path":'}},{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'"x"}'}},
  {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:30}},{type:'message_stop'}]),seen)
  .chat([{role:'system',content:'S'},{role:'user',content:'<checkpoint>',cache:true},{role:'assistant',content:'a'},{role:'user',content:'go',cache:true}],{tools:[{type:'function',function:{name:'read',description:'r',parameters:{type:'object',properties:{}}}}]});
 assert.equal(r.content,'Hi');assert.equal(r.reasoning,'hmm');assert.equal(r.tool_calls[0].function.arguments,'{"path":"x"}');
 assert.equal(r._native.items[0].signature,'sig');assert.deepEqual(r._native.items[2].input,{path:'x'});
 assert.deepEqual(r.usage,{input:960,output:30,cacheRead:900,cacheWrite:50});
 const body=seen[0].body;assert.equal(body.system[0].cache_control.type,'ephemeral');
 assert.equal(body.messages[0].content.at(-1).cache_control.type,'ephemeral');assert.equal(body.messages.at(-1).content.at(-1).cache_control.type,'ephemeral');
 assert.equal(JSON.stringify(body).match(/cache_control/g).length,3);
});
test('responses and gemini streams decode to the same canonical answer',async()=>{
 const rp=profile('responses');
 const r=await client(rp,sse([{type:'response.output_text.delta',delta:'Hel'},{type:'response.output_text.delta',delta:'lo'},{type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Hello'}]},{type:'function_call',call_id:'f1',name:'exec',arguments:'{"command":"ls"}'}],usage:{input_tokens:50,output_tokens:5,input_tokens_details:{cached_tokens:40}}}}])).chat([{role:'user',content:'x'}],{cacheKey:'session-1'});
 assert.equal(r.content,'Hello');assert.equal(r.tool_calls[0].function.name,'exec');assert.equal(r.finish,'tool_calls');assert.equal(r.usage.cacheRead,40);
 const gp=profile('gemini',{baseUrl:'https://generativelanguage.googleapis.com/v1beta'});
 const g=await client(gp,sse([{candidates:[{content:{parts:[{text:'think',thought:true},{text:'Ans'}]}}]},{candidates:[{content:{parts:[{functionCall:{name:'read',args:{path:'a'}},thoughtSignature:'s'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:4}}])).chat([{role:'user',content:'x'}]);
 assert.equal(g.content,'Ans');assert.equal(g.reasoning,'think');assert.equal(g.tool_calls[0].function.arguments,'{"path":"a"}');assert.equal(g._native.items.at(-1).thoughtSignature,'s');
 assert.equal(encodeRequest(rp,[{role:'user',content:'x'}],{cacheKey:'k'}).prompt_cache_key,'k');
 assert.equal(encodeRequest(gp,[{role:'user',content:'x'}],{tools:[{type:'function',function:{name:'a',description:'b',parameters:{type:'object'}}}],toolChoice:'none'}).toolConfig.functionCallingConfig.mode,'NONE');
});
test('HTTP failures are classified for recovery',async()=>{
 const res=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers});
 assert.equal((await classifyResponse(res(401,{error:{message:'bad key'}}))).kind,'auth');
 const rate=await classifyResponse(res(429,{error:{message:'slow down'}},{'retry-after':'7'}));assert.equal(rate.kind,'rate');assert.equal(rate.retryAfterMs,7000);
 const over=await classifyResponse(res(400,{error:{message:"This model's maximum context length is 32768 tokens"}}));assert.equal(over.kind,'overflow');assert.equal(over.limit,32768);
 assert.equal((await classifyResponse(res(400,{error:'the request exceeds the available context size, try increasing it'}))).kind,'overflow');
 assert.equal((await classifyResponse(res(503,{}))).kind,'transient');
 const bad=await classifyResponse(res(400,{error:{message:"Unrecognized request argument supplied: stream_options"}}),['stream_options','tool_choice']);assert.equal(bad.kind,'bad-request');assert.equal(bad.param,'stream_options');
 assert.equal(overflowLimit('n_ctx_slot = 8192, task requires 9001'),8192);
});

async function local(handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${server.address().port}`,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};}
async function registryFixture(t,url,extra={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-reg-'));const store=new Store(dir),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network);
 registry.save({profiles:[{id:'local',protocol:'chat-completions',baseUrl:url+'/v1',model:'m',domain:'device',capabilities:{tools:true},...extra}],routes:{main:{primary:'local'}}},0);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {store,registry};
}
test('a slow but steady stream is never cut off; a silent server is',async t=>{
 const s=await local((req,res)=>{
  if(req.url==='/props'){res.writeHead(404);return res.end();}
  req.resume();req.on('end',()=>{
   if(!req.url.endsWith('/chat/completions')){res.writeHead(404);return res.end();}
   if(req.url.includes('silent')){res.writeHead(200,{'Content-Type':'text/event-stream'});return;}
   res.writeHead(200,{'Content-Type':'text/event-stream'});let i=0;
   const timer=setInterval(()=>{if(i++<12)res.write(`data: ${JSON.stringify({choices:[{delta:{content:'字'}}]})}\n\n`);else{clearInterval(timer);res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}},150);
  });
 });
 t.after(()=>s.close());
 const {registry}=await registryFixture(t,s.url,{firstByteTimeoutMs:5000,idleTimeoutMs:5000});
 const started=Date.now();const a=await registry.invoke('work',[{role:'user',content:'go'}]);
 assert.equal(a.content,'字'.repeat(12));assert.ok(Date.now()-started>1500,'the whole stream took longer than any single wait');
 const {registry:quiet}=await registryFixture(t,s.url+'/silent',{firstByteTimeoutMs:1000,idleTimeoutMs:1000});
 quiet.get().profiles[0];
 const q=await quiet.invoke('work',[{role:'user',content:'go'}]).catch(e=>e);
 assert.ok(q.retryAfterMs!==undefined||q.kind,'a silent server becomes a retryable unavailability');
});
test('an optional parameter a strict server rejects is dropped and remembered',async t=>{
 const seen=[];
 const s=await local(async(req,res)=>{
  let body='';for await(const b of req)body+=b;
  if(!req.url.endsWith('/chat/completions')){res.writeHead(404);return res.end();}
  const j=JSON.parse(body);seen.push(Object.keys(j));
  if(j.stream_options){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'Unknown field: stream_options'}}));}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));
 });
 t.after(()=>s.close());
 const {registry}=await registryFixture(t,s.url);
 assert.equal((await registry.invoke('work',[{role:'user',content:'x'}])).content,'ok');
 assert.equal((await registry.invoke('work',[{role:'user',content:'x'}])).content,'ok');
 assert.equal(seen.length,3);assert.ok(!seen[2].includes('stream_options'));
 assert.deepEqual(registry.compat(registry.get().profiles[0]).drop,['stream_options']);
});
test('context windows are detected from llama.cpp, Ollama (/api/show, the window Tepora asks for) and vLLM, with llama.cpp slots used for cache locality',async t=>{
 const servers={
  llama:await local((req,res)=>{if(req.url==='/props'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({default_generation_settings:{n_ctx:16384},total_slots:4}));}res.writeHead(404);res.end();}),
  ollama:await local((req,res)=>{res.writeHead(req.url==='/props'?404:200,{'Content-Type':'application/json'});if(req.url==='/api/version')return res.end(JSON.stringify({version:'0.12.0'}));if(req.url==='/api/show')return res.end(JSON.stringify({model_info:{'qwen3.context_length':8192}}));res.end('{}');}),
  vllm:await local((req,res)=>{if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({data:[{id:'m',max_model_len:65536}]}));}res.writeHead(404);res.end('{}');})
 };
 t.after(async()=>{for(const s of Object.values(servers))await s.close();});
 const expect={llama:[16384,'llama.cpp'],ollama:[8192,'ollama'],vllm:[65536,'vllm']};
 for(const [name,s] of Object.entries(servers)){const {registry}=await registryFixture(t,s.url);const l=await registry.limits(registry.get().profiles[0]);assert.deepEqual([l.context,l.server],expect[name],name);}
 const {registry}=await registryFixture(t,servers.llama.url);const l=await registry.limits(registry.get().profiles[0]);assert.equal(l.slots,4);
 const body=encodeRequest({...registry.get().profiles[0],server:'llama.cpp'},[{role:'user',content:'x'}],{slot:2});assert.equal(body.cache_prompt,true);assert.equal(body.id_slot,2);assert.equal(body.return_progress,true);
});

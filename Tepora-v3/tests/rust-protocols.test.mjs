import test from 'node:test';
import assert from 'node:assert/strict';
import * as current from '../core/provider-protocols.mjs';
import * as baseline from './helpers/rust-baseline/provider-protocols.mjs';

// Synthetic data only. All decoding runs through unchanged public JS APIs.
// Generated call IDs and additive usage-status metadata are asserted separately.
// The two intentional Anthropic usage corrections are explicit fixture exceptions.
const clone=value=>structuredClone(value);
const protocols=['chat-completions','responses','anthropic','gemini'];
const profile=(protocol,extra={})=>({protocol,id:'fixture',identity:'provider:model:fixture',model:'models/model 日本語',baseUrl:'https://provider.example.test/v1/',domain:'cloud',...extra});
const call=(id='provider-call',args='{}',name='read')=>({id,type:'function',function:{name,arguments:args}});
const image={type:'image_url',image_url:{url:'data:image/png;base64,AAEC'}};
const tool={type:'function',function:{name:'read',description:'読む 🪷',parameters:{type:'object',properties:{path:{type:'string'},'10':{default:1e21},'2':{default:1e-7}},required:['path']}}};
const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);assert.equal(JSON.stringify(actual),JSON.stringify(expected),`${label}: exact JSON bytes/key order`);};
const errorShape=error=>({name:error.name,message:error.message,...Object.fromEntries(Object.entries(error))});
const capture=fn=>{try{return {value:fn()};}catch(error){return {error:errorShape(error)};}};
async function captureAsync(fn){try{return {value:await fn()};}catch(error){return {error:errorShape(error)};}}
function bytes(text,size=7){const encoded=new TextEncoder().encode(text),chunks=[];for(let i=0;i<encoded.length;i+=size)chunks.push(encoded.slice(i,i+size));return chunks;}
function body(chunks){return new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});}
function response(fixture){
 if(fixture.json!==undefined)return new Response(JSON.stringify(fixture.json),{status:fixture.status||200,headers:{'content-type':'application/json',...fixture.headers}});
 const raw=fixture.raw??fixture.frames.map(frame=>`data: ${typeof frame==='string'?frame:JSON.stringify(frame)}\r\n\r\n`).join('');
 return new Response(body(bytes(raw,fixture.chunkSize||7)),{status:fixture.status||200,headers:{'content-type':fixture.ndjson?'application/x-ndjson':'text/event-stream',...fixture.headers}});
}
function normalizeGenerated(outcome,fixture,label){
 if(outcome.error||!fixture.generated?.length)return outcome;
 const value=clone(outcome.value),calls=value.tool_calls||[];
 const generatedIds=[];
 for(const index of fixture.generated){
  assert.ok(calls[index],`${label}: generated call ${index} exists`);
  const id=calls[index].id;
  assert.match(id,new RegExp(`^${fixture.prefix||'call'}_[a-f0-9-]{12}_[0-9]+$`),`${label}: fresh ID shape`);
  assert.ok(!(fixture.suppliedIds||[]).includes(id),`${label}: fresh ID must not reuse a supplied ID`);
  generatedIds.push(id);calls[index].id=`<generated-call-${index}>`;
 }
 assert.equal(new Set(generatedIds).size,generatedIds.length,`${label}: fresh IDs are unique`);
 for(const id of fixture.suppliedIds||[])assert.ok(calls.some(c=>c.id===id),`${label}: provider-supplied ID stays exact`);
 return {value};
}
const usageStatuses={
 complete:{status:'complete',input:'reported',output:'reported'},
 missing:{status:'missing',input:'missing',output:'missing'},
 inputOnly:{status:'partial',input:'reported',output:'missing'},
 outputOnly:{status:'partial',input:'missing',output:'reported'},
};
function assertAndSeparateUsageStatus(outcome,expected,label){
 if(outcome.error)return outcome;
 assert.ok(Object.hasOwn(usageStatuses,expected),`${label}: known usage-status expectation`);
 equal(outcome.value.usageStatus,usageStatuses[expected],`${label}: provider-reported usage status`);
 const legacy=clone(outcome);
 delete legacy.value.usageStatus;
 return legacy;
}
async function compareStream(fixture){
 const run=async implementation=>{
  const events=[],requests=[],p=profile(fixture.protocol,fixture.profile);
  const client=new implementation.ProtocolClient(p,'test-key',async(url,init)=>{
   requests.push({url,method:init.method,redirect:init.redirect,headers:init.headers,body:init.body});
   if(fixture.fetchError)throw fixture.fetchError;
   return response(fixture);
  });
  const outcome=await captureAsync(()=>client.chat(fixture.messages||[{role:'user',content:'hello 日本語 🪷'}],{
   ...fixture.options,onDelta:value=>events.push(['text',value]),onReasoning:value=>events.push(['reasoning',value]),onProgress:value=>events.push(['progress',value]),
  }));
  return {outcome:normalizeGenerated(outcome,fixture,fixture.name),events,requests};
 };
 const expected=await run(baseline),actual=await run(current);
 const legacyActual=clone(actual);
 legacyActual.outcome=assertAndSeparateUsageStatus(actual.outcome,fixture.expectedUsage||'missing',fixture.name);
 if(fixture.anthropicCacheWriteCorrection){
  assert.equal(fixture.protocol,'anthropic');assert.ok(fixture.json);
  assert.equal(expected.outcome.value.usage.cacheWrite,0,'frozen baseline omitted nonstreaming cache writes');
  assert.equal(actual.outcome.value.usage.cacheWrite,fixture.json.usage.cache_creation_input_tokens,'cache writes are now preserved');
  assert.equal(actual.outcome.value.usage.input,9,'total input already includes the cache writes exactly once');
  expected.outcome.value.usage.cacheWrite=fixture.json.usage.cache_creation_input_tokens;
 }
 if(fixture.anthropicZeroOutputCorrection){
  assert.equal(fixture.protocol,'anthropic');
  assert.equal(expected.outcome.value.usage.output,9,'frozen baseline ignored the final zero');
  assert.equal(actual.outcome.value.usage.output,0,'provider-reported final zero replaces the earlier count');
  expected.outcome.value.usage.output=0;
 }
 equal(legacyActual,expected,fixture.name);
 return actual;
}

test('Rust protocols: all request encoders preserve cache drops, sampling, tools and exact numeric/object serialization',()=>{
 const messages=[{role:'system',content:'S 日本語'},{role:'system',content:[{type:'text',text:'second'}]},
  {role:'user',content:[{type:'text',text:'look'},image],cache:true},
  {role:'assistant',content:null,tool_calls:[call('a','{"10":"ten","2":"two","small":1e-7,"large":1e21}'),call('b','{malformed')]},
  {role:'tool',tool_call_id:'a',content:'{"ok":true,"10":10,"2":2}',cache:true},
  {role:'tool',tool_call_id:'b',content:''},{role:'user',content:'continue',cache:true}];
 const drops=[[],['max_tokens'],['max_tokens','max_completion_tokens'],['stream_options','tool_choice','temperature','top_p','top_k'],
  ['prompt_cache_key','prompt_cache_retention','thinkingConfig','reasoning','reasoning_effort','thinking','include'],['cache_prompt','id_slot','return_progress']];
 for(const protocol of protocols)for(const domain of ['cloud','device'])for(const [i,drop] of drops.entries()){
  const p=profile(protocol,{domain,server:i%2?'llama.cpp':undefined,reasoningEffort:i%2?'high':undefined,thinkingBudget:i%3===0?1024:undefined,cache:i!==4});
  const options={tools:[tool],maxTokens:1234,toolChoice:['auto','none','required'][i%3],cacheKey:'session-secret',cacheRetention:i%2?'long':'short',slot:i,
   sampling:{temperature:0,top_p:0.9,top_k:41,min_p:0.01,presence_penalty:0,frequency_penalty:-0.5,repeat_penalty:1.1,seed:7},compat:{drop}};
  const before=clone(messages);
  equal(capture(()=>current.encodeRequest(p,clone(messages),clone(options))),capture(()=>baseline.encodeRequest(p,clone(messages),clone(options))),`${protocol}/${domain}/drop${i}`);
  equal(messages,before,'encoder inputs unchanged');
 }
 for(const protocol of protocols)for(const options of [{},{tools:[]},{maxTokens:0,sampling:{temperature:null,top_p:null}},{cacheRetention:'long'}]){
  equal(capture(()=>current.encodeRequest(profile(protocol),[],options)),capture(()=>baseline.encodeRequest(profile(protocol),[],options)),`${protocol}/empty`);
 }
 equal(capture(()=>current.encodeRequest(profile('unsupported'),[])),capture(()=>baseline.encodeRequest(profile('unsupported'),[])),'invalid protocol');
});

test('Rust protocols: opaque native replay and signatures stay same-provider-only with cache breakpoint limits',()=>{
 const nativeByProtocol={
  'chat-completions':[{opaque:{'2':'two','1':'one'},signature:'chat'}],
  responses:[{type:'reasoning',id:'r1',encrypted_content:'opaque==',summary:[{type:'summary_text',text:'思考'}]},{type:'function_call',call_id:'native-call',name:'read',arguments:'{"path":"x"}'}],
  anthropic:[{type:'thinking',thinking:'考える',signature:'exact-signature'},{type:'redacted_thinking',data:'opaque=='},{type:'tool_use',id:'native-call',name:'read',input:{path:'x'}}],
  gemini:[{text:'thought',thought:true,thoughtSignature:'signature'},{functionCall:{name:'read',args:{path:'x'}},thoughtSignature:'opaque'}],
 };
 for(const protocol of protocols)for(const identity of ['provider:model:fixture','other-provider']){
  const messages=[{role:'system',content:'system'},{role:'user',content:'u0',cache:true}];
  for(let i=0;i<7;i++)messages.push({role:'assistant',content:'canonical fallback '+i,tool_calls:[call('canonical-'+i)],cache:true,
   _native:{identity,items:clone(nativeByProtocol[protocol])}},{role:'user',content:'u'+i,cache:true});
  const p=profile(protocol),before=clone(messages);
  equal(current.encodeRequest(p,messages,{tools:[tool],cacheRetention:'long'}),baseline.encodeRequest(p,clone(messages),{tools:[tool],cacheRetention:'long'}),`${protocol} native=${identity}`);
  equal(messages,before,'native cache placement cannot mutate replay data');
 }
});

test('Rust protocols: image/content validation preserves historical acceptance and exact errors',()=>{
 const invalid=[{},42,false,Array.from({length:41},()=>({type:'text',text:'a'})),[null],[[]],[{type:'audio'}],
  [{type:'image_url',image_url:{url:'https://example.test/image.png'}}],[{type:'image_url',image_url:{url:'data:image/svg+xml;base64,AAEC'}}],
  [{type:'image_url',image_url:{url:'data:image/png;base64,'}}],[{type:'image_url',image_url:{url:'data:image/png;base64,A A'}}]];
 for(const protocol of protocols)for(const [i,content] of invalid.entries()){
  const args=[profile(protocol),[{role:'user',content}],{}];
  equal(capture(()=>current.encodeRequest(...clone(args))),capture(()=>baseline.encodeRequest(...clone(args))),`${protocol} invalid ${i}`);
 }
 const valid=[null,'',[],[{type:'text',text:0}],[{type:'text',text:null}],[{type:'image_url',image_url:{url:'data:image/gif;base64,AA=='}}],Array.from({length:40},()=>image)];
 for(const protocol of protocols)for(const content of valid){
  equal(capture(()=>current.encodeRequest(profile(protocol),[{role:'user',content}])),capture(()=>baseline.encodeRequest(profile(protocol),[{role:'user',content}])),'valid content boundary');
 }
});

test('Rust protocols: Ollama encoding preserves tool names, image bytes, argument fallbacks, context and think controls',()=>{
 const messages=[{role:'system',content:['not valid array content']},{role:'user',content:'hello'}];
 equal(capture(()=>current.encodeOllama(profile('chat-completions'),messages)),capture(()=>baseline.encodeOllama(profile('chat-completions'),messages)),'Ollama validates system');
 const valid=[{role:'system',content:'system'},{role:'user',content:[{type:'text',text:'hello'},image,{type:'text',text:'end'}]},
  {role:'assistant',content:null,tool_calls:[call('a','{"10":10,"2":2,"n":1e-7}'),call('b','[1,2]'),call('c','broken')]},
  {role:'tool',tool_call_id:'a',content:0},{role:'tool',tool_call_id:'orphan',content:null}];
 for(const effort of [undefined,'minimal','low','high'])for(const drop of [[],['think'],['keep_alive'],['think','keep_alive']])for(const numCtx of [null,0,8192]){
  const p=profile('chat-completions',{server:'ollama',reasoningEffort:effort}),options={tools:[tool],maxTokens:72,numCtx,compat:{drop},sampling:{temperature:0,top_p:null,top_k:12,seed:0}};
  equal(current.encodeOllama(p,clone(valid),clone(options)),baseline.encodeOllama(p,clone(valid),clone(options)),`Ollama ${effort}/${drop}/${numCtx}`);
 }
});

test('Rust protocols: Chat streams preserve interleaved sparse indices, malformed fragments, callbacks and usage',async()=>{
 const fixtures=[
  {name:'chat interleaved indices and split think',expectedUsage:'complete',protocol:'chat-completions',chunkSize:1,suppliedIds:['call_12345678-abcd_0'],generated:[1,2],frames:[
   {prompt_progress:{total:10,cached:4}},{choices:[{delta:{content:'<th'}}]},
   {choices:[{delta:{content:'ink>考える🪷</think>\n答',reasoning_content:'native reasoning'}}]},
   {choices:[{delta:{content:'え',tool_calls:[{index:5,id:'call_12345678-abcd_0',function:{name:'wr',arguments:'{"con'}},{index:0,function:{name:'read',arguments:'{"2":2,'}}]}}]},
   {choices:[{delta:{tool_calls:[{index:5,function:{name:'ite',arguments:'tent":"a"}'}},{index:0,function:{arguments:'"10":10}'}},{index:7,function:{name:'broken',arguments:'{"x":'}}]}}]},
   {choices:[{delta:{},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:123,completion_tokens:9,prompt_tokens_details:{cached_tokens:100}}},'[DONE]',
   {choices:[{delta:{content:'must ignore after done'}}]},
  ]},
  {name:'chat object args fallback, unnamed ignored and timings',expectedUsage:'complete',protocol:'chat-completions',generated:[0,1],frames:[
   'malformed JSON',{timings:{prompt_n:30,cache_n:70,predicted_n:4},choices:[{delta:{tool_calls:[{function:{name:'object',arguments:{'10':10,'2':2,n:1e-7}}},{function:{name:'array',arguments:[1,true,null]}},{function:{arguments:'ignored'}}]}}]},
   {choices:[{delta:{reasoning:'r',refusal:'blocked'},finish_reason:'length'}]},
  ]},
  {name:'chat JSON response',expectedUsage:'complete',protocol:'chat-completions',suppliedIds:['upstream-exact'],json:{choices:[{message:{content:'plain 🦊',reasoning:'r',tool_calls:[{id:'upstream-exact',function:{name:'f',arguments:'broken'}}]},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2,cache_read_input_tokens:12}}},
  {name:'chat empty stream',protocol:'chat-completions',frames:[]},
  {name:'chat content filter',protocol:'chat-completions',frames:[{choices:[{delta:{content:'partial'},finish_reason:'content_filter'}]}]},
  {name:'chat overflow event',protocol:'chat-completions',frames:[{choices:[{delta:{content:'first'}}]},{error:{message:'maximum context length is 8192'}}]},
  {name:'chat argument limit',protocol:'chat-completions',chunkSize:32768,frames:[{choices:[{delta:{tool_calls:[{index:0,function:{name:'large',arguments:'a'.repeat(1_000_000)}}]}}]}]},
 ];
 for(const fixture of fixtures)await compareStream(fixture);
});

test('Rust protocols: Responses terminal state, encrypted replay, refusal and missing completion errors are exact',async()=>{
 const done={status:'completed',output:[{type:'reasoning',id:'r',encrypted_content:'opaque==',summary:[{text:'reason one'},{text:'reason two'}]},
  {type:'message',content:[{type:'output_text',text:'final 🪷'}]},{type:'function_call',call_id:'f',name:'read',arguments:{'10':10,'2':2,n:1e-7}}],usage:{input_tokens:35,output_tokens:6,input_tokens_details:{cached_tokens:30}}};
 for(const fixture of [
  {name:'Responses terminal payload authoritative',expectedUsage:'complete',frames:[{type:'response.reasoning_summary_text.delta',delta:'r1'},{type:'response.output_text.delta',delta:'streamed '},{type:'response.reasoning_text.delta',delta:'r2'},{type:'response.output_text.delta',delta:'🪷'},{type:'response.completed',response:done}],chunkSize:1},
  {name:'Responses nonstreamed callbacks',expectedUsage:'complete',json:done},
  {name:'Responses fallback to streamed text',frames:[{type:'response.output_text.delta',delta:'fallback'},{type:'response.completed',response:{status:'completed',output:[]}}]},
  {name:'Responses refusal incomplete',frames:[{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'content_filter'},output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}}]},
  {name:'Responses truncated',frames:[{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:done.output}}]},
  {name:'Responses missing terminal',frames:['not json',{type:'response.output_text.delta',delta:'partial'},'[DONE]']},
  {name:'Responses failed rate',frames:[{type:'response.failed',response:{error:{code:'rate_limit_exceeded',message:'rate exceeded'}}}]},
  {name:'Responses error overflow',frames:[{type:'error',error:{message:'input is too long'}}]},
 ])await compareStream({protocol:'responses',...fixture});
});

test('Rust protocols: Anthropic sparse blocks retain signatures, malformed raw JSON and callback order',async()=>{
 const frames=[{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:40,cache_creation_input_tokens:15,output_tokens:1}}},
  {type:'content_block_delta',index:99,delta:{type:'text_delta',text:'orphan'}},
  {type:'content_block_start',index:5,content_block:{type:'tool_use',id:'tool-five',name:'write',input:{seed:'discard when streaming'}}},
  {type:'content_block_start',index:2,content_block:{type:'thinking',thinking:'seed ',signature:'start'}},
  {type:'content_block_delta',index:2,delta:{type:'thinking_delta',thinking:'考える🪷'}},
  {type:'content_block_delta',index:2,delta:{type:'signature_delta',signature:'-sig'}},
  {type:'content_block_start',index:7,content_block:{type:'text',text:'initial '}},
  {type:'content_block_delta',index:5,delta:{type:'input_json_delta',partial_json:'{"10":10,'}},
  {type:'content_block_delta',index:7,delta:{type:'text_delta',text:'答え'}},
  {type:'content_block_delta',index:5,delta:{type:'input_json_delta',partial_json:'"2":2}'}},
  {type:'content_block_start',index:11,content_block:{type:'redacted_thinking',data:'opaque=='}},
  {type:'content_block_start',index:12,content_block:{type:'tool_use',id:'broken',name:'broken',input:{}}},
  {type:'content_block_delta',index:12,delta:{type:'input_json_delta',partial_json:'{"incomplete":'}},
  {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:9}},{type:'message_delta',usage:{output_tokens:0}},{type:'message_stop'}];
 for(const fixture of [
  {name:'Anthropic sparse indices',expectedUsage:'complete',anthropicZeroOutputCorrection:true,frames,chunkSize:1},
  {name:'Anthropic nonstreamed cache write correction',expectedUsage:'complete',anthropicCacheWriteCorrection:true,json:{stop_reason:'end_turn',content:[{type:'text',text:'hello'},{type:'thinking',thinking:'reason',signature:'sig'},{type:'tool_use',id:'a',name:'read',input:{'10':10,'2':2}}],usage:{input_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4,output_tokens:5}}},
  {name:'Anthropic max tokens',frames:[{type:'message_delta',delta:{stop_reason:'max_tokens'}}]},
  {name:'Anthropic refusal',frames:[{type:'message_delta',delta:{stop_reason:'refusal'}}]},
  {name:'Anthropic overloaded',frames:[{type:'error',error:{type:'overloaded_error',message:'busy'}}]},
  {name:'Anthropic rate',frames:[{type:'error',error:{type:'rate_limit_error',message:'slow'}}]},
  {name:'Anthropic overflow',frames:[{type:'error',error:{type:'invalid_request_error',message:'prompt too long'}}]},
 ])await compareStream({protocol:'anthropic',...fixture});
});

test('Rust protocols: Gemini thought tokens, safety finishes, native signatures and supplied IDs are preserved',async()=>{
 const parts=[{text:'thinking 🪷',thought:true,thoughtSignature:'sig-one'},{text:'answer'},
  {functionCall:{id:'g_12345678-abcd_0',name:'read',args:{'10':10,'2':2,n:1e-7}},thoughtSignature:'sig-two'},
  {functionCall:{name:'write',args:{path:'x'}},thoughtSignature:'sig-three'},
  {functionCall:{name:'third',args:null}},{inlineData:{mimeType:'image/png',data:'opaque'}}];
 await compareStream({name:'Gemini thoughts and calls',expectedUsage:'complete',protocol:'gemini',generated:[1,2],suppliedIds:['g_12345678-abcd_0'],prefix:'g',chunkSize:1,frames:[
  {candidates:[{content:{parts:parts.slice(0,2)}}]},
  {candidates:[{content:{parts:parts.slice(2)},finishReason:'STOP'}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:3,thoughtsTokenCount:7,cachedContentTokenCount:25}},
 ]});
 for(const finishReason of ['STOP','MAX_TOKENS','SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','UNKNOWN']){
  await compareStream({name:`Gemini finish ${finishReason}`,protocol:'gemini',json:[{candidates:[{content:{parts:[{text:'A'}]}}]},{candidates:[{content:{parts:[{text:'B',thought:true}]},finishReason}],usageMetadata:{thoughtsTokenCount:2}}]});
 }
 await compareStream({name:'Gemini prompt feedback block',protocol:'gemini',frames:[{promptFeedback:{blockReason:'SAFETY'}}]});
 await compareStream({name:'Gemini stream error',protocol:'gemini',frames:[{error:{message:'maximum context length is 32768'}}]});
});

test('Rust protocols: Ollama NDJSON tracks done, uncached-only usage, leading think and tool IDs',async()=>{
 const packets=[{message:{thinking:'native ',content:'<thi'}},{message:{content:'nk>wrapped 🪷</think>\nanswer',tool_calls:[
  {id:'provider-ollama',function:{name:'first',arguments:{'10':10,'2':2}}},{function:{name:'second',arguments:'broken'}},{function:{name:'third',arguments:{n:1e-7}}}]}},
  {done:true,done_reason:'stop',prompt_eval_count:20,eval_count:6}];
 await compareStream({name:'Ollama done and tools',expectedUsage:'complete',protocol:'chat-completions',profile:{server:'ollama'},ndjson:true,raw:packets.map(x=>JSON.stringify(x)).join('\n'),chunkSize:1,generated:[1,2],suppliedIds:['provider-ollama']});
 for(const fixture of [
  {name:'Ollama without done',raw:JSON.stringify({message:{content:'partial'}})},
  {name:'Ollama length',expectedUsage:'complete',raw:JSON.stringify({done:true,done_reason:'length',prompt_eval_count:0,eval_count:1})+'\n'},
  {name:'Ollama malformed packet',raw:'{broken}\n'},
  {name:'Ollama error',raw:JSON.stringify({error:'context window exceeded'})+'\n'},
 ])await compareStream({protocol:'chat-completions',profile:{server:'ollama'},ndjson:true,...fixture});
});

test('Rust protocols: usage status separates missing and partial counts from genuine reported zero',async()=>{
 for(const [kind,input,output] of [
  ['chat-completions','prompt_tokens','completion_tokens'],['responses','input_tokens','output_tokens'],
  ['anthropic','input_tokens','output_tokens'],['gemini','promptTokenCount','candidatesTokenCount'],
  ['ollama','prompt_eval_count','eval_count'],
 ]){
  for(const [name,counts,expectedUsage] of [
   ['missing',null,'missing'],['empty',{},'missing'],
   ['zero',{input:0,output:0},'complete'],['input zero',{input:0},'inputOnly'],
   ['output zero',{output:0},'outputOnly'],['invalid',{input:-1,output:null},'missing'],
  ]){
   const usage=counts&&Object.fromEntries(Object.entries(counts).map(([key,value])=>[key==='input'?input:output,value]));
   const packet=kind==='responses'?{status:'completed',output:[]}:kind==='anthropic'?{stop_reason:'end_turn',content:[]}:kind==='ollama'?{done:true}:{};
   if(usage){if(kind==='ollama')Object.assign(packet,usage);else packet[kind==='gemini'?'usageMetadata':'usage']=usage;}
   const fixture=kind==='ollama'?{protocol:'chat-completions',profile:{server:'ollama'},ndjson:true,raw:JSON.stringify(packet)+'\n'}:{protocol:kind,json:packet};
   const actual=await compareStream({name:`${kind} usage ${name}`,expectedUsage,...fixture});
   if(name==='zero')equal(actual.outcome.value.usage,{input:0,output:0,cacheRead:0,cacheWrite:0,...(kind==='ollama'?{uncachedOnly:true}:{})},`${kind}: numeric zero contract`);
  }
 }
});

test('Rust protocols: invalid cache counts and truncated stream usage remain incomplete',async()=>{
 for(const [protocol,json] of [
  ['chat-completions',{usage:{prompt_tokens:7,completion_tokens:2,prompt_tokens_details:{cached_tokens:-5}}}],
  ['chat-completions',{usage:{prompt_tokens:7,completion_tokens:2,cache_read_input_tokens:null}}],
  ['responses',{status:'completed',output:[],usage:{input_tokens:7,output_tokens:2,input_tokens_details:{cached_tokens:-5}}}],
  ['anthropic',{stop_reason:'end_turn',content:[],usage:{input_tokens:7,output_tokens:2,cache_read_input_tokens:-5}}],
  ['gemini',{usageMetadata:{promptTokenCount:7,candidatesTokenCount:2,cachedContentTokenCount:-5}}],
 ])await compareStream({name:`${protocol} invalid cache`,protocol,json,expectedUsage:'outputOnly'});
 for(const [protocol,frames] of [
  ['chat-completions',[{choices:[{delta:{content:'partial answer'}}],usage:{prompt_tokens:7,completion_tokens:0}}]],
  ['anthropic',[{type:'message_start',message:{usage:{input_tokens:7,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:'partial answer'}}]],
  ['gemini',[{candidates:[{content:{parts:[{text:'partial answer'}]}}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:0}}]],
 ]){
  const actual=await compareStream({name:`${protocol} cleanly truncated usage`,protocol,frames,expectedUsage:'inputOnly'});
  assert.equal(actual.outcome.value.content,'partial answer');
  assert.equal(actual.outcome.value.usage.output,0);
 }
});

test('Rust protocols: SSE UTF-8 byte boundaries, multiline data, comments, CRLF and final unterminated data',async()=>{
 const fixtures=[': comment\r\nevent: x\r\ndata: 日本語🪷\r\ndata:   line two\r\n\r\ndata: last',
  'data: a\n\ndata: b\n\n','data: \n\n',': no data\n\n','data: one\ndata: two','data: 日本語\r\n',
  'data: '+ 'x'.repeat(4_000_000)+'\n\n'];
 for(const [i,raw] of fixtures.entries())for(const size of (i===fixtures.length-1?[131072]:[1,2,3,7,4096])){
  const collect=async implementation=>{const output=[];try{for await(const item of implementation.sseData(body(bytes(raw,size))))output.push(item);return {output};}catch(error){return {output,error:errorShape(error)};}};
  equal(await collect(current),await collect(baseline),`SSE fixture ${i}, byte chunks ${size}`);
 }
});

test('Rust protocols: ThinkSplitter matches callbacks at every UTF-16 split, including incomplete tags and lone surrogates',()=>{
 const cases=['','plain','<b>bold</b>','<think>reason</think>\n\nanswer','  \t<think>考える🪷</think> 答え🦊',
  '<think>never closed','<think></think>answer','<think>thinking</think>','<thi','  ','\uFEFF<think>r</think>\u3000a',
  '<think>1234567🪷after</think>x','\ud800plain\udfff','<think>\ud800reason\udfff</think>\ud800answer'];
 const run=(implementation,chunks)=>{const events=[],split=new implementation.ThinkSplitter(value=>events.push(['text',value]),value=>events.push(['reasoning',value]));for(const chunk of chunks)split.push(chunk);split.end();return {text:split.text,reasoning:split.reasoning,events};};
 for(const value of cases){
  for(let cut=0;cut<=value.length;cut++)equal(run(current,[value.slice(0,cut),value.slice(cut)]),run(baseline,[value.slice(0,cut),value.slice(cut)]),`ThinkSplitter cut ${cut} ${JSON.stringify(value)}`);
  for(const width of [1,2,3,8]){const chunks=[];for(let i=0;i<value.length;i+=width)chunks.push(value.slice(i,i+width));equal(run(current,chunks),run(baseline,chunks),`ThinkSplitter chunks ${width}`);}
 }
});

test('Rust protocols: HTTP and network errors, headers and paths retain exact recovery metadata',async()=>{
 for(const protocol of protocols){
  for(const sessionKey of [null,'session','日本語🪷',123])for(const key of ['', 'secret']){
   const p=profile(protocol,{sessionHeader:'X-Session'});
   equal(current.requestHeaders(p,key,{sessionKey}),baseline.requestHeaders(p,key,{sessionKey}),'headers');
   equal(current.requestPath(p),baseline.requestPath(p),'request path');
  }
 }
 for(const [status,body_,headers] of [[401,{error:{message:'bad key'}},{}],[403,{},{}],[429,{error:'slow'},{'retry-after':'7'}],
  [429,{error:'slow'},{'retry-after-ms':'8000000'}],[400,{error:{message:'Unknown parameter: stream_options'}},{}],
  [413,{error:'maximum context length is 32768'},{}],[422,{message:'n_ctx_slot = 8192 task requires 9000'},{}],
  [408,{},{}],[409,{detail:'conflict'},{}],[503,{error:'busy'},{}],[418,{message:'teapot'},{}]]){
  await compareStream({name:`HTTP ${status}`,protocol:'chat-completions',json:body_,status,headers});
 }
 for(const error of [new Error('connection reset'),Object.assign(new Error('idle'),{idle:true}),Object.assign(new Error('blocked'),{blocked:true})]){
  await compareStream({name:`network ${error.message}`,protocol:'chat-completions',frames:[],fetchError:error});
 }
});

test('Rust protocols: deterministic coercion matrix preserves JSON number spelling, false/empty tool results and scalar args',()=>{
 const argumentValues=[null,false,0,'plain',[1,true],{'2':'two','10':'ten',tiny:1e-7,small:1e-6,large:1e20,huge:1e21,negative:-0,precise:1.2345678901234567},JSON.parse('{"__proto__":{"x":1},"constructor":2}')];
 for(const protocol of protocols)for(const [i,args] of argumentValues.entries()){
  const messages=[{role:'system',content:'system'},{role:'assistant',content:'',tool_calls:[call('a',JSON.stringify(args))]},
   {role:'tool',tool_call_id:'a',content:[null,false,0,'','{}','null','[1,2]'][i]},
   {role:'user',content:'first',cache:true},{role:'user',content:'second',cache:true}];
  equal(capture(()=>current.encodeRequest(profile(protocol),clone(messages),{sampling:{temperature:null,top_p:0}})),
   capture(()=>baseline.encodeRequest(profile(protocol),clone(messages),{sampling:{temperature:null,top_p:0}})),`${protocol} coercion ${i}`);
 }
});

test('Rust protocols: public one-shot decoding preserves callbacks and terminal result contract',async()=>{
 const fixtures=[
  {protocol:'chat-completions',json:{choices:[{message:{content:'<think>r</think>a',tool_calls:[{id:'public-chat-id',function:{name:'f',arguments:'{}'}}]},finish_reason:'stop'}]}},
  {protocol:'responses',json:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'one shot'}]}]}},
  {protocol:'anthropic',json:{stop_reason:'end_turn',content:[{type:'text',text:'text'},{type:'thinking',thinking:'reason',signature:'sig'}]}},
  {protocol:'gemini',json:{candidates:[{content:{parts:[{text:'r',thought:true},{text:'a'},{functionCall:{id:'public-gemini-id',name:'f',args:{'2':2,'1':1}}}]},finishReason:'STOP'}]}},
 ];
 for(const fixture of fixtures){
  const run=async implementation=>{const events=[];const outcome=await captureAsync(()=>implementation.decodeResponse(profile(fixture.protocol),clone(fixture.json),{onDelta:x=>events.push(['text',x]),onReasoning:x=>events.push(['reasoning',x])}));return {outcome,events};};
  const actual=await run(current),expected=await run(baseline);
  actual.outcome=assertAndSeparateUsageStatus(actual.outcome,'missing',`public decode ${fixture.protocol}`);
  equal(actual,expected,`public decode ${fixture.protocol}`);
 }
});

/** Canonical text/image/tool messages over four wire protocols, always streamed.
 * Nothing here throws on a truncated answer or a malformed tool call: the agent loop repairs those.
 * Vendor-native state (reasoning signatures, opaque items) is replayed only to the same provider.
 */
import {randomUUID} from 'node:crypto';
import {invariant} from './policy.mjs';

export const PROTOCOLS=['chat-completions','responses','anthropic','gemini'];
const record=x=>x&&typeof x==='object'&&!Array.isArray(x);

export class ProviderError extends Error{
 /** kind: overflow | auth | rate | transient | bad-request | unavailable | invalid-output */
 constructor(kind,message,{status=null,retryAfterMs=null,limit=null,param=null,body=''}={}){
  super(message);this.name='ProviderError';this.kind=kind;this.upstreamStatus=status;this.status=kind==='auth'?401:502;
  this.retryAfterMs=retryAfterMs;this.limit=limit;this.param=param;this.body=body;this.retryable=['transient','rate','unavailable'].includes(kind);
 }
}
const OVERFLOW=/context[_ -]?(length|window|size)|maximum context|too many tokens|prompt is too long|prompt too long|input is too long|exceeds? (the )?(available |model'?s? )?context|n_ctx|reduce the length|longer than the model|too large for model|context limit/i;
export function overflowLimit(text){
 for(const re of [/maximum context length is (\d+)/i,/context (?:length|window|size)(?: of| is| =|:)? ?(\d{3,7})/i,/n_ctx(?:_slot)?\D{0,12}(\d{3,7})/i,/limit(?: of| is)? (\d{3,7}) tokens/i,/> ?(\d{3,7}) maximum/i])
  {const m=re.exec(text);if(m)return Number(m[1]);}
 return null;
}
export function retryAfter(headers){
 const ms=Number(headers?.get?.('retry-after-ms'));if(Number.isFinite(ms)&&ms>0)return Math.min(ms,3600000);
 const v=headers?.get?.('retry-after');if(!v)return null;
 const s=Number(v);if(Number.isFinite(s))return Math.min(s*1000,3600000);
 const at=Date.parse(v);return Number.isFinite(at)?Math.max(0,Math.min(at-Date.now(),3600000)):null;
}
const OPTIONAL_PARAMS=['stream_options','prompt_cache_key','prompt_cache_retention','cache_prompt','id_slot','return_progress','tool_choice','parallel_tool_calls','temperature','top_p','top_k','min_p','presence_penalty','frequency_penalty','repeat_penalty','seed','max_completion_tokens','max_tokens','reasoning','reasoning_effort','thinking','thinkingConfig','include','think','keep_alive'];
/** Map an HTTP failure to a recovery kind. `sent` lists optional parameters that a strict server may reject. */
export async function classifyResponse(response,sent=[]){
 let body='';try{body=(await response.text()).slice(0,8000);}catch{}
 const status=response.status,message=messageOf(body)||`HTTP ${status}`;
 if(status===401||status===403)return new ProviderError('auth',`認証に失敗しました（HTTP ${status}）。APIキーと接続先を確認してください。`,{status,body});
 if(status===429)return new ProviderError('rate',`利用上限に達しました（HTTP 429）。${message}`.slice(0,400),{status,retryAfterMs:retryAfter(response.headers)??15000,body});
 if(OVERFLOW.test(body)&&[400,413,422,500].includes(status))return new ProviderError('overflow','Context window exceeded: '+message.slice(0,300),{status,limit:overflowLimit(body),body});
 if(status===408||status===409||status>=500)return new ProviderError('transient',`Model server error (HTTP ${status}): ${message}`.slice(0,400),{status,retryAfterMs:retryAfter(response.headers),body});
 const param=sent.find(p=>new RegExp(`\\b${p}\\b`).test(body))||null;
 return new ProviderError('bad-request',`Model request rejected (HTTP ${status}): ${message}`.slice(0,500),{status,param,body});
}
function messageOf(body){try{const j=JSON.parse(body);return String(j.error?.message||j.error||j.message||j.detail||'').slice(0,500);}catch{return body.slice(0,300);}}
/** A failure the caller did not ask for (idle timeout, reset, refused connection) is transient. */
export function networkError(e,signal){
 if(signal?.aborted)return signal.reason??e;
 if(e instanceof ProviderError||e?.blocked)return e;
 const why=e?.cause?.message||e?.message||e;
 const err=new ProviderError('transient',`Model connection failed: ${String(why).slice(0,200)}`);
 // The stream went silent past the idle limit: the caller may learn a longer wait for this model.
 if(e?.idle||e?.cause?.idle)err.idle=true;
 return err;
}

export async function* sseData(body){
 const decoder=new TextDecoder();let buffer='',data=[],frame=0;
 for await(const chunk of body){
  buffer+=decoder.decode(chunk,{stream:true});let i;
  while((i=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);
   if(!line){if(data.length){yield data.join('\n');data=[];frame=0;}}
   else if(line.startsWith('data:')){frame+=line.length;invariant(frame<4_000_000,'Upstream stream frame is too large',502);data.push(line.slice(5).trimStart());}
  }
  invariant(buffer.length<4_000_000,'Upstream stream frame is too large',502);
 }
 buffer+=decoder.decode();if(buffer.startsWith('data:'))data.push(buffer.slice(5).trim());
 if(data.length)yield data.join('\n');
}

/* ---------- content helpers ---------- */
function contentParts(value){
 if(typeof value==='string')return value?[{type:'text',text:value}]:[];
 if(value==null)return [];
 invariant(Array.isArray(value)&&value.length<=40,'Invalid canonical content');
 return value.map(p=>{
  invariant(record(p),'Invalid content part');
  if(p.type==='text')return {type:'text',text:String(p.text)};
  invariant(p.type==='image_url'&&/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(p.image_url?.url||''),'Only inlined images are allowed');
  return p;
 });
}
const asText=value=>contentParts(value).map(p=>p.type==='text'?p.text:'[image]').join('\n');
function imagePart(p,protocol){
 const [,mime,data]=p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
 if(protocol==='anthropic')return {type:'image',source:{type:'base64',media_type:mime,data}};
 if(protocol==='gemini')return {inlineData:{mimeType:mime,data}};
 return {type:'input_image',image_url:p.image_url.url};
}
function parseArgs(text){try{const v=JSON.parse(text||'{}');return record(v)?v:{};}catch{return {};}}
const sameNative=(m,p)=>m._native?.identity===p.identity&&Array.isArray(m._native.items);

/* ---------- request encoding ---------- */
/** options: tools, maxTokens, toolChoice ('auto'|'none'|'required'), cacheKey, cacheRetention ('short'|'long'),
 * sampling, compat (dropped params), slot */
export function encodeRequest(profile,messages,{tools=[],maxTokens=4096,toolChoice='auto',cacheKey=null,cacheRetention='short',sampling={},compat={},slot=null}={}){
 invariant(PROTOCOLS.includes(profile.protocol),'Unsupported provider protocol');
 const drop=new Set(compat.drop||[]),defs=tools.map(t=>t.function),key=profile.protocol;
 const put=(o,k,v)=>{if(v!==undefined&&v!==null&&!drop.has(k))o[k]=v;return o;};
 const systems=messages.filter(m=>m.role==='system').map(m=>asText(m.content)).join('\n\n');
 const sample={temperature:sampling.temperature,top_p:sampling.top_p};
 if(key==='chat-completions'){
  const body={model:profile.model,stream:true,messages:messages.map(m=>({role:m.role,
   content:Array.isArray(m.content)?contentParts(m.content):m.content??(m.tool_calls?null:''),
   ...(m.tool_calls?{tool_calls:m.tool_calls.map(c=>({id:c.id,type:'function',function:{name:c.function.name,arguments:c.function.arguments}}))}:{}),
   ...(m.tool_call_id?{tool_call_id:m.tool_call_id}:{})}))};
  put(body,drop.has('max_tokens')?'max_completion_tokens':'max_tokens',maxTokens);
  if(tools.length){body.tools=tools;put(body,'tool_choice',toolChoice);}
  put(body,'stream_options',{include_usage:true});
  for(const [k,v] of Object.entries({...sample,top_k:sampling.top_k,min_p:sampling.min_p,presence_penalty:sampling.presence_penalty,frequency_penalty:sampling.frequency_penalty,repeat_penalty:sampling.repeat_penalty,seed:sampling.seed}))put(body,k,v);
  if(cacheKey&&profile.domain==='cloud')put(body,'prompt_cache_key',cacheKey);
  if(cacheRetention==='long'&&profile.domain==='cloud')put(body,'prompt_cache_retention','24h');
  // Prompt-processing progress keeps a long local prompt from looking like a dead connection.
  if(profile.server==='llama.cpp'){put(body,'cache_prompt',true);put(body,'return_progress',true);if(Number.isInteger(slot))put(body,'id_slot',slot);}
  if(profile.reasoningEffort)put(body,'reasoning_effort',profile.reasoningEffort);
  return body;
 }
 if(key==='responses'){
  const input=[];
  for(const m of messages){
   if(m.role==='system')continue;
   if(m.role==='assistant'&&sameNative(m,profile)){input.push(...m._native.items);continue;}
   if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.tool_call_id,output:String(m.content)});continue;}
   if(m.content)input.push({role:m.role,content:m.role==='assistant'?asText(m.content):contentParts(m.content).map(p=>p.type==='text'?{type:'input_text',text:p.text}:imagePart(p,key))});
   for(const c of m.tool_calls||[])input.push({type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments});
  }
  const body={model:profile.model,store:false,stream:true,input,instructions:systems};
  put(body,'max_output_tokens',maxTokens);put(body,'include',['reasoning.encrypted_content']);
  if(tools.length){body.tools=defs.map(f=>({type:'function',name:f.name,description:f.description,parameters:f.parameters,strict:false}));put(body,'tool_choice',toolChoice);}
  // A reasoning summary streams while the model thinks, so a long think is not mistaken for a dead stream.
  if(profile.reasoningEffort)put(body,'reasoning',{effort:profile.reasoningEffort,summary:'auto'});
  for(const [k,v] of Object.entries(sample))put(body,k,v);
  if(cacheKey)put(body,'prompt_cache_key',cacheKey);
  if(cacheRetention==='long')put(body,'prompt_cache_retention','24h');
  return body;
 }
 const names=new Map();for(const m of messages)for(const c of m.tool_calls||[])names.set(c.id,c.function.name);
 if(key==='anthropic'){
  const out=[],cacheOn=profile.cache!==false;let marks=0;
  const append=(role,blocks,mark)=>{if(!blocks.length)return;const prev=out.at(-1);if(prev?.role===role)prev.content.push(...blocks);else out.push({role,content:blocks});if(mark)out.at(-1).mark=true;};
  for(const m of messages){
   if(m.role==='system')continue;
   if(m.role==='tool'){append('user',[{type:'tool_result',tool_use_id:m.tool_call_id,content:String(m.content||'(empty)')}],m.cache);continue;}
   if(m.role==='assistant'&&sameNative(m,profile)){append('assistant',structuredClone(m._native.items),m.cache);continue;}
   const blocks=contentParts(m.content).map(p=>p.type==='text'?{type:'text',text:p.text}:imagePart(p,key)).filter(b=>b.type!=='text'||b.text);
   for(const c of m.tool_calls||[])blocks.push({type:'tool_use',id:c.id,name:c.function.name,input:parseArgs(c.function.arguments)});
   append(m.role==='assistant'?'assistant':'user',blocks,m.cache);
  }
  // Breakpoints: tools+system (one mark on the system block), then flagged messages, newest last. At most four.
  // Long retention (the resident session) asks for the one-hour cache on every breakpoint.
  const system=systems?[{type:'text',text:systems}]:[],control={type:'ephemeral',...(cacheRetention==='long'?{ttl:'1h'}:{})};
  if(cacheOn&&system.length){system[0].cache_control={...control};marks++;}
  if(cacheOn)for(const m of out.filter(m=>m.mark).slice(-3)){const last=m.content.at(-1);if(last&&marks<4){last.cache_control={...control};marks++;}}
  for(const m of out)delete m.mark;
  const body={model:profile.model,messages:out,max_tokens:maxTokens,stream:true,...(system.length?{system}:{})};
  if(tools.length){body.tools=defs.map(f=>({name:f.name,description:f.description,input_schema:f.parameters}));put(body,'tool_choice',{type:toolChoice==='required'?'any':toolChoice});}
  if(profile.thinkingBudget)put(body,'thinking',{type:'enabled',budget_tokens:profile.thinkingBudget});
  else for(const [k,v] of Object.entries({...sample,top_k:sampling.top_k}))put(body,k,v);
  return body;
 }
 const contents=[];
 const append=(role,parts)=>{if(!parts.length)return;const prev=contents.at(-1);if(prev?.role===role)prev.parts.push(...parts);else contents.push({role,parts});};
 for(const m of messages){
  if(m.role==='system')continue;
  if(m.role==='tool'){let result;try{result=JSON.parse(m.content);}catch{result=m.content;}append('user',[{functionResponse:{name:names.get(m.tool_call_id)||'tool',response:{result}}}]);continue;}
  if(m.role==='assistant'&&sameNative(m,profile)){append('model',structuredClone(m._native.items));continue;}
  const parts=contentParts(m.content).map(p=>p.type==='text'?{text:p.text}:imagePart(p,key)).filter(p=>p.text!=='');
  for(const c of m.tool_calls||[])parts.push({functionCall:{name:c.function.name,args:parseArgs(c.function.arguments)}});
  append(m.role==='assistant'?'model':'user',parts);
 }
 const generationConfig={maxOutputTokens:maxTokens};
 if(sample.temperature!==undefined)generationConfig.temperature=sample.temperature;if(sample.top_p!==undefined)generationConfig.topP=sample.top_p;
 // Thought summaries stream while Gemini thinks (keeping the stream alive) and show as reasoning.
 if((profile.thinkingBudget||profile.reasoningEffort)&&!drop.has('thinkingConfig'))generationConfig.thinkingConfig={includeThoughts:true,...(profile.thinkingBudget?{thinkingBudget:profile.thinkingBudget}:{})};
 return {contents,...(systems?{systemInstruction:{parts:[{text:systems}]}}:{}),generationConfig,
  ...(tools.length?{tools:[{functionDeclarations:defs.map(f=>({name:f.name,description:f.description,parametersJsonSchema:f.parameters}))}],
   toolConfig:{functionCallingConfig:{mode:toolChoice==='none'?'NONE':toolChoice==='required'?'ANY':'AUTO'}}}:{})};
}

/** Ollama's native chat API. Unlike its OpenAI-compatible endpoint it takes num_ctx per request, so the window
 * is the one Tepora budgets for instead of a small default that silently cuts the conversation's beginning. */
export function encodeOllama(profile,messages,{tools=[],maxTokens=4096,sampling={},compat={},numCtx=null}={}){
 const drop=new Set(compat.drop||[]),names=new Map();
 for(const m of messages)for(const c of m.tool_calls||[])names.set(c.id,c.function.name);
 const out=messages.map(m=>{
  if(m.role==='system')return {role:'system',content:asText(m.content)};
  if(m.role==='tool')return {role:'tool',content:String(m.content??''),...(names.has(m.tool_call_id)?{tool_name:names.get(m.tool_call_id)}:{})};
  const parts=contentParts(m.content),images=parts.filter(p=>p.type==='image_url').map(p=>p.image_url.url.replace(/^data:[^;]+;base64,/,''));
  return {role:m.role==='assistant'?'assistant':'user',content:parts.filter(p=>p.type==='text').map(p=>p.text).join('\n'),...(images.length?{images}:{}),
   ...(m.tool_calls?.length?{tool_calls:m.tool_calls.map(c=>({function:{name:c.function.name,arguments:parseArgs(c.function.arguments)}}))}:{})};
 });
 const options={num_predict:maxTokens,...(numCtx?{num_ctx:numCtx}:{})};
 for(const k of ['temperature','top_p','top_k','min_p','repeat_penalty','seed','presence_penalty','frequency_penalty'])if(sampling[k]!==undefined)options[k]=sampling[k];
 const body={model:profile.model,messages:out,stream:true,options};
 if(!drop.has('keep_alive'))body.keep_alive='30m';
 if(tools.length)body.tools=tools;
 if(profile.reasoningEffort&&!drop.has('think'))body.think=profile.reasoningEffort==='minimal'?false:profile.reasoningEffort;
 return body;
}
async function decodeOllama(profile,response,{onDelta,onReasoning}){
 const split=new ThinkSplitter(onDelta,onReasoning),calls=[],usage=emptyUsage();let reasoning='',finish=null;
 const take=p=>{
  if(p.error)throw new ProviderError(OVERFLOW.test(String(p.error))?'overflow':'transient',String(p.error).slice(0,300));
  const m=p.message||{};
  if(typeof m.thinking==='string'&&m.thinking){reasoning+=m.thinking;onReasoning?.(m.thinking);}
  if(typeof m.content==='string'&&m.content)split.push(m.content);
  for(const c of m.tool_calls||[])calls.push({id:c.id||`call_${randomUUID().slice(0,12)}_${calls.length}`,type:'function',function:{name:String(c.function?.name||''),arguments:typeof c.function?.arguments==='string'?c.function.arguments:JSON.stringify(c.function?.arguments||{})}});
  // prompt_eval_count leaves out the cached prefix, so it is not a prompt size: no calibration from it.
  if(p.done){finish=p.done_reason||'stop';usage.input=p.prompt_eval_count||0;usage.output=p.eval_count||0;usage.uncachedOnly=true;}
 };
 const decoder=new TextDecoder();let buffer='';
 for await(const chunk of response.body){
  buffer+=decoder.decode(chunk,{stream:true});let i;
  while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line)take(JSON.parse(line));}
  invariant(buffer.length<4_000_000,'Upstream stream frame is too large',502);
 }
 buffer+=decoder.decode();if(buffer.trim())take(JSON.parse(buffer.trim()));
 split.end();
 const list=calls.filter(c=>c.function.name);
 return result({content:split.text,reasoning:reasoning+split.reasoning,calls:list,finish:finish==='length'?'length':list.length?'tool_calls':finish?'stop':'other',usage,profile});
}

/* ---------- streaming decoders ---------- */
/** Splits a leading <think>…</think> block out of streamed text (servers without a reasoning parser). */
export class ThinkSplitter{
 constructor(onText,onReasoning){this.onText=onText;this.onReasoning=onReasoning;this.mode='detect';this.buffer='';this.text='';this.reasoning='';}
 push(chunk){
  this.buffer+=chunk;
  for(;;){
   if(this.mode==='detect'){
    const t=this.buffer.trimStart();
    if(t.length<7&&'<think>'.startsWith(t))return;
    if(t.startsWith('<think>')){this.mode='think';this.buffer=t.slice(7);continue;}
    this.mode='text';continue;
   }
   if(this.mode==='think'){
    const i=this.buffer.indexOf('</think>');
    if(i<0){const keep=Math.max(0,this.buffer.length-8);this.emitReasoning(this.buffer.slice(0,keep));this.buffer=this.buffer.slice(keep);return;}
    this.emitReasoning(this.buffer.slice(0,i));this.buffer=this.buffer.slice(i+8).replace(/^\s+/,'');this.mode='text';continue;
   }
   if(this.buffer){this.text+=this.buffer;this.onText?.(this.buffer);this.buffer='';}
   return;
  }
 }
 emitReasoning(s){if(s){this.reasoning+=s;this.onReasoning?.(s);}}
 end(){if(this.mode==='think'){this.emitReasoning(this.buffer);}else if(this.buffer){this.text+=this.buffer;this.onText?.(this.buffer);}this.buffer='';}
}
const emptyUsage=()=>({input:0,output:0,cacheRead:0,cacheWrite:0});
function result({content,reasoning,calls,finish,usage,native,profile}){
 return {role:'assistant',content:content||null,reasoning:reasoning||null,...(calls.length?{tool_calls:calls}:{}),finish,usage,
  ...(native?.length?{_native:{identity:profile.identity,items:native}}:{})};
}
async function decodeChat(profile,response,{onDelta,onReasoning,onProgress}){
 const split=new ThinkSplitter(onDelta,onReasoning);let reasoning='',finish=null;const calls=new Map(),usage=emptyUsage();
 const take=packet=>{
  if(packet.error)throw new ProviderError(OVERFLOW.test(JSON.stringify(packet.error))?'overflow':'transient',String(packet.error.message||packet.error).slice(0,300));
  if(packet.prompt_progress)onProgress?.(packet.prompt_progress);
  if(packet.usage){usage.input=packet.usage.prompt_tokens||0;usage.output=packet.usage.completion_tokens||0;usage.cacheRead=packet.usage.prompt_tokens_details?.cached_tokens||packet.usage.cache_read_input_tokens||0;}
  else if(packet.timings?.prompt_n!==undefined){usage.input=(packet.timings.prompt_n||0)+(packet.timings.cache_n||0);usage.output=packet.timings.predicted_n||0;usage.cacheRead=packet.timings.cache_n||0;}
  const choice=packet.choices?.[0];if(!choice)return;
  const delta=choice.delta||choice.message||{};
  if(typeof delta.content==='string')split.push(delta.content);
  const r=delta.reasoning_content??delta.reasoning;if(typeof r==='string'&&r){reasoning+=r;onReasoning?.(r);}
  if(delta.refusal)finish='refusal';
  for(const c of delta.tool_calls||[]){
   const index=Number.isSafeInteger(c.index)?c.index:calls.size;const item=calls.get(index)||{id:'',type:'function',function:{name:'',arguments:''}};
   if(c.id)item.id=c.id;if(c.function?.name)item.function.name+=c.function.name;
   if(c.function?.arguments!==undefined)item.function.arguments+=typeof c.function.arguments==='string'?c.function.arguments:JSON.stringify(c.function.arguments);
   invariant(item.function.arguments.length<1_000_000,'Tool arguments exceeded limit',502);calls.set(index,item);
  }
  if(choice.finish_reason)finish=choice.finish_reason;
 };
 if((response.headers.get('content-type')||'').includes('text/event-stream')){
  for await(const data of sseData(response.body)){if(data==='[DONE]')break;let packet;try{packet=JSON.parse(data);}catch{continue;}take(packet);}
 }else take(await response.json());
 split.end();
 const list=[...calls.values()].filter(c=>c.function.name).map((c,i)=>({...c,id:c.id||`call_${randomUUID().slice(0,12)}_${i}`}));
 const kind=finish==='length'?'length':finish==='content_filter'||finish==='refusal'?'refusal':list.length?'tool_calls':finish?'stop':'other';
 return result({content:split.text,reasoning:reasoning+split.reasoning,calls:list,finish:kind,usage,profile});
}
async function decodeResponses(profile,response,{onDelta,onReasoning}){
 let done=null,finish='other',content='';const usage=emptyUsage();
 const take=e=>{
  if(e.type==='response.output_text.delta'){content+=e.delta;onDelta?.(e.delta);}
  else if(e.type==='response.reasoning_summary_text.delta'||e.type==='response.reasoning_text.delta')onReasoning?.(e.delta);
  else if(['response.completed','response.incomplete'].includes(e.type)){done=e.response;finish=e.type==='response.completed'?'stop':e.response?.incomplete_details?.reason==='content_filter'?'refusal':'length';}
  else if(e.type==='response.failed'||e.type==='error'){const err=e.response?.error||e.error||e;throw new ProviderError(OVERFLOW.test(JSON.stringify(err))?'overflow':err?.code==='rate_limit_exceeded'?'rate':'transient',String(err?.message||'Responses stream failed').slice(0,300));}
 };
 if((response.headers.get('content-type')||'').includes('text/event-stream')){for await(const frame of sseData(response.body)){if(frame==='[DONE]')break;let e;try{e=JSON.parse(frame);}catch{continue;}take(e);}}
 else{const body=await response.json();done=body;finish=body.status==='completed'?'stop':body.incomplete_details?.reason==='content_filter'?'refusal':'length';}
 if(!done)throw new ProviderError('transient','Responses stream ended before completion');
 const calls=[],native=Array.isArray(done.output)?done.output:[];let text='',reasoning='';
 for(const item of native){
  if(item.type==='message')for(const part of item.content||[]){if(part.type==='output_text')text+=part.text;if(part.type==='refusal')finish='refusal';}
  if(item.type==='reasoning')reasoning+=(item.summary||[]).map(s=>s.text||'').join('\n');
  if(item.type==='function_call')calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:typeof item.arguments==='string'?item.arguments:JSON.stringify(item.arguments||{})}});
 }
 if(!text&&content)text=content;else if(text&&!content)onDelta?.(text);
 const u=done.usage||{};usage.input=u.input_tokens||0;usage.output=u.output_tokens||0;usage.cacheRead=u.input_tokens_details?.cached_tokens||0;
 return result({content:text,reasoning,calls,finish:finish==='stop'&&calls.length?'tool_calls':finish,usage,native,profile});
}
async function decodeAnthropic(profile,response,{onDelta,onReasoning}){
 const blocks=[],json=new Map(),usage=emptyUsage();let stop=null;
 const take=e=>{
  if(e.type==='message_start'){const u=e.message?.usage||{};usage.input=(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);usage.cacheRead=u.cache_read_input_tokens||0;usage.cacheWrite=u.cache_creation_input_tokens||0;usage.output=u.output_tokens||0;}
  else if(e.type==='content_block_start'){blocks[e.index]=structuredClone(e.content_block);if(e.content_block.type==='tool_use')json.set(e.index,'');}
  else if(e.type==='content_block_delta'){
   const b=blocks[e.index],d=e.delta||{};if(!b)return;
   if(d.type==='text_delta'){b.text=(b.text||'')+d.text;onDelta?.(d.text);}
   else if(d.type==='input_json_delta')json.set(e.index,json.get(e.index)+d.partial_json);
   else if(d.type==='thinking_delta'){b.thinking=(b.thinking||'')+d.thinking;onReasoning?.(d.thinking);}
   else if(d.type==='signature_delta')b.signature=(b.signature||'')+d.signature;
  }
  else if(e.type==='message_delta'){if(e.delta?.stop_reason)stop=e.delta.stop_reason;if(e.usage?.output_tokens)usage.output=e.usage.output_tokens;}
  else if(e.type==='error'){const err=e.error||{};throw new ProviderError(err.type==='overloaded_error'?'transient':err.type==='rate_limit_error'?'rate':OVERFLOW.test(err.message||'')?'overflow':'transient',String(err.message||'Anthropic stream error').slice(0,300));}
 };
 if((response.headers.get('content-type')||'').includes('text/event-stream')){for await(const frame of sseData(response.body)){let e;try{e=JSON.parse(frame);}catch{continue;}take(e);}}
 else{const body=await response.json();stop=body.stop_reason;(body.content||[]).forEach((b,i)=>{blocks[i]=b;if(b.type==='text')onDelta?.(b.text);});const u=body.usage||{};usage.input=(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);usage.cacheRead=u.cache_read_input_tokens||0;usage.output=u.output_tokens||0;}
 const calls=[];let text='',reasoning='';
 const native=blocks.filter(Boolean).map((b,i)=>{
  if(b.type==='tool_use'){
   const raw=json.has(blocks.indexOf(b))?json.get(blocks.indexOf(b)):JSON.stringify(b.input||{});
   let input={};try{input=raw?JSON.parse(raw):{};}catch{}
   calls.push({id:b.id,type:'function',function:{name:b.name,arguments:raw||'{}'}});return {...b,input};
  }
  if(b.type==='text')text+=b.text||'';if(b.type==='thinking')reasoning+=b.thinking||'';return b;
 });
 const finish=stop==='max_tokens'?'length':stop==='refusal'?'refusal':stop==='tool_use'||calls.length?'tool_calls':stop?'stop':'other';
 return result({content:text,reasoning,calls,finish,usage,native,profile});
}
async function decodeGemini(profile,response,{onDelta,onReasoning}){
 const native=[],usage=emptyUsage();let reason=null,text='',reasoning='',blocked=false;
 const take=body=>{
  if(body.promptFeedback?.blockReason)blocked=true;
  const c=body.candidates?.[0];
  for(const part of c?.content?.parts||[]){
   native.push(part);
   if(typeof part.text==='string'){if(part.thought){reasoning+=part.text;onReasoning?.(part.text);}else{text+=part.text;onDelta?.(part.text);}}
  }
  if(c?.finishReason)reason=c.finishReason;
  const u=body.usageMetadata;if(u){usage.input=u.promptTokenCount||0;usage.output=(u.candidatesTokenCount||0)+(u.thoughtsTokenCount||0);usage.cacheRead=u.cachedContentTokenCount||0;}
 };
 if((response.headers.get('content-type')||'').includes('text/event-stream')){for await(const frame of sseData(response.body)){let e;try{e=JSON.parse(frame);}catch{continue;}if(e.error)throw new ProviderError(OVERFLOW.test(e.error.message||'')?'overflow':'transient',String(e.error.message).slice(0,300));take(e);}}
 else{const body=await response.json();(Array.isArray(body)?body:[body]).forEach(take);}
 const calls=native.filter(p=>p.functionCall).map((p,i)=>({id:p.functionCall.id||`g_${randomUUID().slice(0,12)}_${i}`,type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})}}));
 const finish=blocked||['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII'].includes(reason)?'refusal':reason==='MAX_TOKENS'?'length':calls.length?'tool_calls':reason==='STOP'?'stop':'other';
 return result({content:text,reasoning,calls,finish,usage,native,profile});
}
export function requestPath(profile){
 if(profile.protocol==='responses')return 'responses';
 if(profile.protocol==='anthropic')return 'messages';
 if(profile.protocol==='gemini')return `models/${encodeURIComponent(profile.model.replace(/^models\//,''))}:streamGenerateContent?alt=sse`;
 return 'chat/completions';
}
export function requestHeaders(profile,key){
 const common={'Content-Type':'application/json',Accept:'text/event-stream, application/json'};
 if(profile.protocol==='anthropic')return {...common,'anthropic-version':'2023-06-01',...(key?{'x-api-key':key}:{})};
 if(profile.protocol==='gemini')return {...common,...(key?{'x-goog-api-key':key}:{})};
 return {...common,...(key?{Authorization:`Bearer ${key}`}:{})};
}
/** Decodes a complete (non-streamed) response body, for tests and one-shot callers. */
export async function decodeResponse(profile,body,options={}){
 const response=new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 const decode=profile.protocol==='responses'?decodeResponses:profile.protocol==='anthropic'?decodeAnthropic:profile.protocol==='gemini'?decodeGemini:decodeChat;
 return decode(profile,response,options);
}
/** One streamed model call. Throws ProviderError for HTTP/stream failures only. */
export class ProtocolClient{
 constructor(profile,key='',fetchImpl=fetch){this.profile=profile;this.key=key;this.fetch=fetchImpl;}
 async chat(messages,options={}){
  const p=this.profile,ollama=p.protocol==='chat-completions'&&p.server==='ollama';
  const body=ollama?encodeOllama(p,messages,options):encodeRequest(p,messages,options);
  const sent=OPTIONAL_PARAMS.filter(k=>k in body||k in (body.generationConfig||{}));
  const url=ollama?new URL(p.baseUrl).origin+'/api/chat':`${p.baseUrl.replace(/\/$/,'')}/${requestPath(p)}`;
  let response;
  try{response=await this.fetch(url,{method:'POST',redirect:'error',headers:requestHeaders(p,this.key),signal:options.signal,body:JSON.stringify(body)});}
  catch(e){throw networkError(e,options.signal);}
  if(!response.ok)throw await classifyResponse(response,sent);
  const decode=ollama?decodeOllama:p.protocol==='responses'?decodeResponses:p.protocol==='anthropic'?decodeAnthropic:p.protocol==='gemini'?decodeGemini:decodeChat;
  try{return await decode(p,response,options);}
  catch(e){throw networkError(e,options.signal);}
 }
}

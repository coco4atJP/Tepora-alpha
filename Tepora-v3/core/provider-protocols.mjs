/** Canonical text/image/tool messages over four wire protocols, always streamed.
 * Nothing here throws on a truncated answer or a malformed tool call: the agent loop repairs those.
 * Vendor-native state (reasoning signatures, opaque items) is replayed only to the same provider.
 */
import {randomUUID,createHash} from 'node:crypto';
import {invariant} from './policy.mjs';
import {nativeCore} from './native-state.mjs';

export const PROTOCOLS=['chat-completions','responses','anthropic','gemini'];

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

/* ---------- Rust request and response core ---------- */
// Network admission, fetch, cancellation and UTF-8 framing remain in this host.
// The Rust core owns wire encoding and every provider response state machine.
function nativeProtocol(run){
 try{return JSON.parse(run());}
 catch(error){
  if(error.message?.startsWith('[provider]')){
   const info=JSON.parse(error.message.slice(10));throw new ProviderError(info.kind,info.message);
  }
  const match=/^\[(\d{3})\]\s*(.*)$/s.exec(error.message||'');
  if(match){error.status=Number(match[1]);error.message=match[2];delete error.code;}
  throw error;
 }
}
const encoderOptions=options=>Object.fromEntries(['tools','maxTokens','toolChoice','cacheKey','cacheRetention','sampling','compat','slot','numCtx'].filter(k=>options[k]!==undefined).map(k=>[k,options[k]]));
export function encodeRequest(profile,messages,options={}){
 return nativeProtocol(()=>nativeCore.encodeProtocolRequest(JSON.stringify({profile,messages,options:encoderOptions(options),ollama:false})));
}
export function encodeOllama(profile,messages,options={}){
 return nativeProtocol(()=>nativeCore.encodeProtocolRequest(JSON.stringify({profile,messages,options:encoderOptions(options),ollama:true})));
}
function emitEvents(events,{onDelta,onReasoning,onProgress}={}){
 for(const event of events){if(event.type==='text')onDelta?.(event.value);else if(event.type==='reasoning')onReasoning?.(event.value);else if(event.type==='progress')onProgress?.(event.value);}
}
export class ThinkSplitter{
 constructor(onText,onReasoning){this.onText=onText;this.onReasoning=onReasoning;this.core=new nativeCore.ThinkSplitterCore();this.text='';this.reasoning='';}
 accept(state){this.text=state.text;this.reasoning=state.reasoning;emitEvents(state.events,{onDelta:this.onText,onReasoning:this.onReasoning});}
 push(chunk){this.accept(nativeProtocol(()=>this.core.push(JSON.stringify(chunk))));}
 end(){this.accept(nativeProtocol(()=>this.core.finish()));}
}
async function decodeWire(kind,profile,response,options={}){
 const decoder=new nativeCore.ProtocolDecoderCore(JSON.stringify(profile),kind,randomUUID().slice(0,12));
 const take=(packet,streamed=true)=>emitEvents(nativeProtocol(()=>decoder.push(JSON.stringify(packet),streamed)),options);
 try{
 if(kind==='ollama'){
  const utf8=new TextDecoder();let buffer='';
  for await(const chunk of response.body){
   buffer+=utf8.decode(chunk,{stream:true});let i;
   while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line)take(JSON.parse(line));}
   invariant(buffer.length<4_000_000,'Upstream stream frame is too large',502);
  }
  buffer+=utf8.decode();if(buffer.trim())take(JSON.parse(buffer.trim()));
 }else if((response.headers.get('content-type')||'').includes('text/event-stream')){
  for await(const data of sseData(response.body)){
   if((kind==='chat-completions'||kind==='responses')&&data==='[DONE]')break;
   let packet;try{packet=JSON.parse(data);}catch{continue;}take(packet);
  }
 }else take(await response.json(),false);
 const finished=nativeProtocol(()=>decoder.finish());emitEvents(finished.events,options);return finished.result;
 }catch(error){
  // Read only on termination, never once per token. Do not copy response content.
  options.onUsageSnapshot?.(nativeProtocol(()=>decoder.usageSnapshot()));
  throw error;
 }
}
const decodeChat=(profile,response,options)=>decodeWire('chat-completions',profile,response,options);
const decodeResponses=(profile,response,options)=>decodeWire('responses',profile,response,options);
const decodeAnthropic=(profile,response,options)=>decodeWire('anthropic',profile,response,options);
const decodeGemini=(profile,response,options)=>decodeWire('gemini',profile,response,options);
const decodeOllama=(profile,response,options)=>decodeWire('ollama',profile,response,options);
export function requestPath(profile){
 if(profile.protocol==='responses')return 'responses';
 if(profile.protocol==='anthropic')return 'messages';
 if(profile.protocol==='gemini')return `models/${encodeURIComponent(profile.model.replace(/^models\//,''))}:streamGenerateContent?alt=sse`;
 return 'chat/completions';
}
/** Tepora names itself (gateways such as OpenCode Go reject generic HTTP-library agents), and with a profile's
 * session header sends a stable, opaque id per conversation so the gateway routes it to a warm prompt cache. */
export const USER_AGENT='Tepora/3.0 (local agent harness)';
export function requestHeaders(profile,key,{sessionKey=null}={}){
 const common={'Content-Type':'application/json',Accept:'text/event-stream, application/json','User-Agent':USER_AGENT,
  ...(profile.sessionHeader&&sessionKey?{[profile.sessionHeader]:'tepora-'+createHash('sha256').update(String(sessionKey)).digest('hex').slice(0,32)}:{})};
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
  try{response=await this.fetch(url,{method:'POST',redirect:'error',headers:requestHeaders(p,this.key,{sessionKey:options.cacheKey}),signal:options.signal,body:JSON.stringify(body)});}
  catch(e){throw networkError(e,options.signal);}
  if(!response.ok)throw await classifyResponse(response,sent);
  const decode=ollama?decodeOllama:p.protocol==='responses'?decodeResponses:p.protocol==='anthropic'?decodeAnthropic:p.protocol==='gemini'?decodeGemini:decodeChat;
  try{return await decode(p,response,options);}
  catch(e){throw networkError(e,options.signal);}
 }
}

/** Canonical text/image/tool messages, with lossless same-provider opaque continuation.
 * Vendor-native state is NEVER forwarded to a different provider. No SDK executes tools.
 */
import {randomUUID} from 'node:crypto';
import {boundedJSON} from './transport.mjs';
import {Runtime,sseData} from './runtime.mjs';
import {invariant} from './policy.mjs';

export const PROTOCOLS=['chat-completions','responses','anthropic','gemini'];
export class ProviderError extends Error {
 constructor(status,message='Model request failed') {super(`${message} (HTTP ${status})`);this.name='ProviderError';this.status=502;this.upstreamStatus=status;this.retryable=[408,429,500,502,503,504].includes(status);}
}
const record=x=>x&&typeof x==='object'&&!Array.isArray(x);
function contentParts(value) {
 if(typeof value==='string')return [{type:'text',text:value}];
 if(value==null)return [];
 invariant(Array.isArray(value)&&value.length<=20,'Invalid canonical content');
 return value.map(p=>{
  invariant(record(p),'Invalid content part');
  if(p.type==='text'){invariant(typeof p.text==='string','Invalid text content');return {type:'text',text:p.text};}
  invariant(p.type==='image_url'&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(p.image_url?.url||''),'Only inlined PNG/JPEG pixels are allowed');
  return p;
 });
}
const asText=value=>contentParts(value).map(p=>p.type==='text'?p.text:'[image input]').join('\n');
function imageParts(p,protocol) {
 if(p.type==='text')return {type:protocol==='responses'?'input_text':'text',text:p.text};
 const url=p.image_url.url,[,mime,data]=url.match(/^data:([^;]+);base64,(.+)$/);
 if(protocol==='anthropic')return {type:'image',source:{type:'base64',media_type:mime,data}};
 if(protocol==='gemini')return {inlineData:{mimeType:mime,data}};
 return {type:'input_image',image_url:url};
}
function toolIndex(messages) {
 const map=new Map();for(const m of messages)for(const c of m.tool_calls||[])map.set(c.id,c.function.name);return map;
}
function parseResult(content){try{return JSON.parse(content);}catch{return content;}}
const sameNative=(m,p)=>m._native?.identity===p.identity&&Array.isArray(m._native.items);
export function encodeRequest(profile,messages,{tools=[],maxTokens=2048,stream=false}={}) {
 invariant(PROTOCOLS.includes(profile.protocol),'Unsupported provider protocol');
 const common={model:profile.model},defs=tools.map(t=>t.function);
 const systems=messages.filter(m=>m.role==='system').map(m=>asText(m.content)).join('\n\n');
 const key=profile.protocol;
 if(key==='chat-completions')return {...common,stream,messages:messages.map(m=>({role:m.role,content:m.content??null,
  ...(m.tool_calls?{tool_calls:m.tool_calls.map(c=>({id:c.id,type:'function',function:c.function}))}:{}),...(m.tool_call_id?{tool_call_id:m.tool_call_id}:{})})),
  max_tokens:maxTokens,...(tools.length?{tools,tool_choice:'auto'}:{})};
 if(key==='responses') {
  const input=[];
  for(const m of messages){
   if(m.role==='system')continue;
   if(m.role==='assistant'&&sameNative(m,profile)){input.push(...m._native.items);continue;}
   if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.tool_call_id,output:String(m.content)});continue;}
   if(m.content) input.push({role:m.role,content:m.role==='assistant'?asText(m.content):contentParts(m.content).map(p=>imageParts(p,key))});
   for(const c of m.tool_calls||[])input.push({type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments});
  }
  return {...common,store:false,stream,input,instructions:systems,max_output_tokens:maxTokens,include:['reasoning.encrypted_content'],
   ...(tools.length?{tools:defs.map(f=>({type:'function',name:f.name,description:f.description,parameters:f.parameters,strict:false}))}:{}),
   ...(profile.reasoningEffort?{reasoning:{effort:profile.reasoningEffort}}:{})};
 }
 const lookup=toolIndex(messages);
 if(key==='anthropic') {
  const output=[];
  const append=(role,blocks)=>{if(!blocks.length)return;const prev=output.at(-1);if(prev?.role===role)prev.content.push(...blocks);else output.push({role,content:blocks});};
  for(const m of messages){
   if(m.role==='system')continue;
   if(m.role==='tool'){append('user',[{type:'tool_result',tool_use_id:m.tool_call_id,content:String(m.content)}]);continue;}
   if(m.role==='assistant'&&sameNative(m,profile)){append('assistant',m._native.items);continue;}
   const blocks=contentParts(m.content).map(p=>imageParts(p,key));
   for(const c of m.tool_calls||[])blocks.push({type:'tool_use',id:c.id,name:c.function.name,input:JSON.parse(c.function.arguments)});
   append(m.role==='assistant'?'assistant':'user',blocks);
  }
  return {...common,messages:output,max_tokens:maxTokens,stream,system:systems,
   ...(tools.length?{tools:defs.map(f=>({name:f.name,description:f.description,input_schema:f.parameters}))}: {})};
 }
 const contents=[];
 const append=(role,parts)=>{if(!parts.length)return;const prev=contents.at(-1);if(prev?.role===role)prev.parts.push(...parts);else contents.push({role,parts});};
 for(const m of messages){
  if(m.role==='system')continue;
  if(m.role==='tool'){invariant(lookup.has(m.tool_call_id),'Orphaned Gemini tool result');append('user',[{functionResponse:{name:lookup.get(m.tool_call_id),response:{result:parseResult(m.content)}}}]);continue;}
  if(m.role==='assistant'&&sameNative(m,profile)){append('model',m._native.items);continue;}
  const parts=contentParts(m.content).map(p=>p.type==='text'?{text:p.text}:imageParts(p,key));
  for(const c of m.tool_calls||[])parts.push({functionCall:{name:c.function.name,args:JSON.parse(c.function.arguments)}});
  append(m.role==='assistant'?'model':'user',parts);
 }
 return {contents,systemInstruction:{parts:[{text:systems}]},generationConfig:{maxOutputTokens:maxTokens},
  ...(tools.length?{tools:[{functionDeclarations:defs.map(f=>({name:f.name,description:f.description,parametersJsonSchema:f.parameters}))}]}:{})};
}
export function decodeResponse(profile,body) {
 let content='',calls=[],native=[];
 const fail=(reason)=>{throw Object.assign(new Error(reason),{status:502,invalidModelOutput:true});};
 if(!record(body))fail('Invalid provider response');
 if(profile.protocol==='responses') {
  if(body.status!=='completed'||body.error||body.incomplete_details)fail('Responses request did not complete');
  if(!Array.isArray(body.output))fail('Missing Responses output');
  native=body.output;
  for(const item of native){
   if(item.type==='message')for(const part of item.content||[]){if(part.type==='refusal')fail('Provider refused this request');if(part.type==='output_text')content+=part.text;}
   if(item.type==='function_call')calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});
  }
 } else if(profile.protocol==='anthropic') {
  if(!['end_turn','tool_use','stop_sequence'].includes(body.stop_reason))fail('Anthropic response was truncated or incomplete');
  if(!Array.isArray(body.content))fail('Missing Anthropic content');native=body.content;
  for(const block of native){if(block.type==='text')content+=block.text;if(block.type==='tool_use')calls.push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input)}});}
 } else if(profile.protocol==='gemini') {
  const candidate=body.candidates?.[0];if(candidate?.finishReason!=='STOP'||body.promptFeedback?.blockReason)fail('Gemini response was blocked, truncated or incomplete');
  native=candidate.content?.parts;if(!Array.isArray(native))fail('Missing Gemini content');
  for(const part of native){if(typeof part.text==='string'&&!part.thought)content+=part.text;if(part.functionCall)calls.push({id:part.functionCall.id||'g_'+randomUUID(),type:'function',function:{name:part.functionCall.name,arguments:JSON.stringify(part.functionCall.args||{})}});}
 } else {
  const c=body.choices?.[0],m=c?.message;
  if(!m||!['stop','tool_calls','function_call',undefined,null].includes(c.finish_reason))fail('Chat response was blocked, truncated or incomplete');
  if(m.refusal)fail('Provider refused this request');content=m.content||'';calls=m.tool_calls||[];
 }
 if(typeof content!=='string'||content.length>200000||!Array.isArray(calls)||calls.length>16)fail('Provider output exceeds limits');
 const ids=new Set();for(const c of calls){
  if(typeof c.id!=='string'||!c.id||c.id.length>200||ids.has(c.id)||!/^[-\w]{1,100}$/.test(c.function?.name||'')||typeof c.function?.arguments!=='string'||c.function.arguments.length>220000)fail('Invalid or duplicate tool-call metadata');
  ids.add(c.id);let args;try{args=JSON.parse(c.function.arguments);}catch{fail('Malformed tool JSON');}if(!record(args))fail('Tool arguments must be an object');
 }
 if(!content.trim()&&!calls.length)fail('Provider returned no usable answer');
 return {role:'assistant',content:content||null,...(calls.length?{tool_calls:calls}:{}),
  ...(native.length?{_native:{identity:profile.identity,items:native}}:{}),
  usage:body.usage||body.usageMetadata||null};
}
export class ProtocolClient {
 constructor(profile,key='',fetchImpl=fetch) {this.profile=profile;this.key=key;this.fetch=fetchImpl;}
 headers(){const common={'Content-Type':'application/json'};
  if(this.profile.protocol==='anthropic')return {...common,'anthropic-version':'2023-06-01',...(this.key?{'x-api-key':this.key}:{})};
  if(this.profile.protocol==='gemini')return {...common,...(this.key?{'x-goog-api-key':this.key}:{})};
  return {...common,...(this.key?{Authorization:`Bearer ${this.key}`}:{})};
 }
 async chat(messages,options={}) {
  const p=this.profile;
  // Existing streaming Chat Completions parser stays in use, behind the same scoped transport.
  if(p.protocol==='chat-completions') {
   const rt=new Runtime({baseUrl:p.baseUrl,model:p.model,allowCloud:p.domain!=='device',maxTokens:p.maxTokens||2048},this.key,async(url,init)=>{
    const response=await this.fetch(url,init);if(!response.ok){await response.body?.cancel();throw new ProviderError(response.status);}return response;
   });
   // LAN plaintext is validated by the egress policy, not the legacy URL consent helper.
   rt.url=suffix=>`${p.baseUrl.replace(/\/$/,'')}/${suffix}`;
   const canonical=messages.map(m=>({role:m.role,content:m.content??null,...(m.tool_calls?{tool_calls:m.tool_calls}:{}),...(m.tool_call_id?{tool_call_id:m.tool_call_id}:{})}));
   const answer=await rt.chat(canonical,options);
   return decodeResponse(p,{choices:[{finish_reason:answer.tool_calls?.length?'tool_calls':'stop',message:answer}]});
  }
  const suffix=p.protocol==='responses'?'responses':p.protocol==='anthropic'?'messages':`models/${encodeURIComponent(p.model.replace(/^models\//,''))}:generateContent`;
  const stream=p.protocol==='responses';
  const response=await this.fetch(`${p.baseUrl.replace(/\/$/,'')}/${suffix}`,{method:'POST',redirect:'error',headers:this.headers(),
   signal:AbortSignal.any([options.signal||new AbortController().signal,AbortSignal.timeout(p.timeoutMs||180000)]),
   body:JSON.stringify(encodeRequest(p,messages,{...options,stream,maxTokens:options.maxTokens||p.maxTokens||2048}))});
  if(!response.ok){await response.body?.cancel();throw new ProviderError(response.status);}
  if(stream&&(response.headers.get('content-type')||'').includes('text/event-stream')) {
   let completed=null;
   for await(const frame of sseData(response.body)){
    if(frame==='[DONE]')break;const e=JSON.parse(frame);
    if(e.type==='response.output_text.delta')options.onDelta?.(e.delta);
    if(e.type==='response.completed')completed=e.response;
    if(['response.failed','response.incomplete','error'].includes(e.type))throw Object.assign(new Error('Responses stream failed or was incomplete'),{status:502});
   }
   return decodeResponse(p,completed);
  }
  const answer=decodeResponse(p,await boundedJSON(response));if(answer.content)options.onDelta?.(answer.content);return answer;
 }
}

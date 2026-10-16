/** Lossless Pi replay is bound to the exact Tepora profile identity, never another account. */
const zero=()=>({input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const text=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'';
function blocks(value){
 if(typeof value==='string')return [{type:'text',text:value}];
 return (value||[]).map(b=>{
  if(b.type==='text')return {type:'text',text:String(b.text||'')};
  if(b.type==='image_url'){
   const m=/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(b.image_url?.url||'');
   if(!m)throw new Error('Pi image inputs must be locally prepared data URLs.');
   return {type:'image',mimeType:m[1],data:m[2]};
  }
  throw new Error('Unsupported Pi input block: '+b.type);
 });
}
export function toPiContext(messages,tools,model,identity){
 const names=new Map();
 const converted=messages.map(m=>{
  const timestamp=Number.isFinite(m.timestamp)?m.timestamp:0;
  if(m.role==='system')return {role:'system',content:text(m.content),timestamp};
  if(m.role==='user')return {role:'user',content:blocks(m.content),timestamp};
  if(m.role==='tool')return {role:'toolResult',toolCallId:m.tool_call_id,toolName:m.name||names.get(m.tool_call_id)||'tool',content:blocks(m.content),isError:!!m.error,timestamp};
  if(m.role!=='assistant')throw new Error('Unsupported Pi message role: '+m.role);
  for(const call of m.tool_calls||[])names.set(call.id,call.function.name);
  if(m._native?.engine==='pi-ai'&&m._native.identity===identity&&Array.isArray(m._native.items)){
   // Rust's compactor recursively bounds old arguments inside `items`.
   return {...m._native.meta,role:'assistant',content:m._native.items,usage:zero(),timestamp};
  }
  const content=blocks(m.content);
  for(const call of m.tool_calls||[]){let args;try{args=JSON.parse(call.function.arguments);}catch{args={};}
   content.push({type:'toolCall',id:call.id,name:call.function.name,arguments:args});}
  return {role:'assistant',content,provider:'tepora-canonical',model:'unknown',api:model.api,usage:zero(),stopReason:content.some(b=>b.type==='toolCall')?'toolUse':'stop',timestamp};
 });
 return {messages:converted,tools:tools.map(t=>({name:t.function.name,description:t.function.description||'',parameters:t.function.parameters||{type:'object',properties:{}}}))};
}
export function fromPiMessage(message,identity,{input=false,output=false}={}){
 const u=message.usage||zero(),reported=v=>Number.isFinite(v)&&v>=0;
 const inputKnown=input&&reported(u.input),outputKnown=output&&reported(u.output);
 const out={content:message.content.filter(b=>b.type==='text').map(b=>b.text).join(''),reasoning:message.content.filter(b=>b.type==='thinking').map(b=>b.thinking).join(''),
  tool_calls:message.content.filter(b=>b.type==='toolCall').map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:b.argumentsError?'[invalid tool arguments]':JSON.stringify(b.arguments)}})),
  finish:message.stopReason==='toolUse'?'tool_calls':message.stopReason==='length'?'length':'stop',
  usage:{input:inputKnown?u.input+(u.cacheRead||0)+(u.cacheWrite||0):null,output:outputKnown?u.output:null,cacheRead:u.cacheRead||0,cacheWrite:u.cacheWrite||0},
  usageStatus:{status:inputKnown&&outputKnown?'complete':inputKnown||outputKnown?'partial':'missing',input:inputKnown?'reported':'missing',output:outputKnown?'reported':'missing'}};
 out._native={engine:'pi-ai',identity,items:message.content,meta:{api:message.api,provider:message.provider,model:message.model,stopReason:message.stopReason,...(message.responseId?{responseId:message.responseId}:{})}};
 return out;
}
/** Pi initializes unknown usage as zero. Only wire-reported counters establish accounting evidence. */
export function observePiUsage(event,seen){
 const u=event?.usage||event?.response?.usage||event?.message?.usage||event?.usageMetadata;
 if(!u)return;
 const has=k=>Object.hasOwn(u,k)&&Number.isFinite(u[k])&&u[k]>=0;
 if(['input_tokens','prompt_tokens','promptTokenCount','input'].some(has))seen.input=true;
 if(['output_tokens','completion_tokens','candidatesTokenCount','output'].some(has))seen.output=true;
}

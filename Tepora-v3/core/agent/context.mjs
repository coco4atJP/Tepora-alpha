import {messageTokens,rawTokens} from './tokens.mjs';
import {oneLine} from '../tools/format.mjs';

/** Builds what is sent to the model from the append-only log.
 * Order: system, [checkpoint], live entries. Rendering is a pure function of the log, so a restart
 * reproduces the same bytes and provider-side caches keep hitting.
 *
 * Nothing earlier in the transcript changes between two requests except at a `clear` (a batch watermark)
 * or a checkpoint. At a clear, everything at or below the watermark is shrunk at once:
 *  - tool results become one-line stubs (small ones are kept),
 *  - a superseded ephemeral result (an older todo list, process poll, screenshot) becomes a stub,
 *  - a worker report the main session has already handled becomes one line,
 *  - long string arguments of old tool calls (a written file's content) are cut to a preview.
 * Everything stays exactly retrievable with recall("#n"). */
export const SMALL_RESULT_TOKENS=300;
export const LONG_ARG_CHARS=400;
export function stubText(e){return `[result cleared to save context: ${e.stub||e.name}${e.images?.length?` (${e.images.length} image${e.images.length>1?'s':''})`:''} — recall("#${e.seq}") reads it in full]`;}
export function reportStub(e){return `${e.header?e.header+'\n':''}[report from "${e.title||e.from||''}" cleared to save context. It began: ${oneLine(e.text,200)} — recall("#${e.seq}") reads it in full]`;}
const clearableInput=e=>e.type==='input'&&(e.kind==='report'||e.kind==='heartbeat');
/** Long strings inside an old call's arguments, cut to a preview. Pure: the same input gives the same bytes. */
export function shrinkValue(v,ref){
 if(typeof v==='string')return v.length>LONG_ARG_CHARS?`${v.slice(0,120)}… [${v.length.toLocaleString('en-US')} characters omitted from this old call; recall("${ref}") shows it]`:v;
 if(Array.isArray(v))return v.map(x=>shrinkValue(x,ref));
 if(v&&typeof v==='object'){const o={};for(const [k,x] of Object.entries(v))o[k]=shrinkValue(x,ref);return o;}
 return v;
}
export function shrinkArgs(json,ref){
 if(typeof json!=='string'||json.length<=LONG_ARG_CHARS)return json;
 try{const v=JSON.parse(json);return v&&typeof v==='object'?JSON.stringify(shrinkValue(v,ref)):json;}catch{return json;}
}
/** The same shrinking for provider-native replay items (Anthropic tool_use, Responses function_call, Gemini functionCall). */
function shrinkNative(native,ref){
 return {...native,items:native.items.map(it=>{
  if(it?.type==='tool_use'&&it.input)return {...it,input:shrinkValue(it.input,ref)};
  if(it?.type==='function_call'&&typeof it.arguments==='string')return {...it,arguments:shrinkArgs(it.arguments,ref)};
  if(it?.functionCall?.args)return {...it,functionCall:{...it.functionCall,args:shrinkValue(it.functionCall.args,ref)}};
  return it;
 })};
}
const imagePart=i=>({type:'image_url',image_url:{url:`data:${i.mime};base64,${i.base64}`}});
const imageNote=(images,why)=>`[${images.length} image${images.length>1?'s':''} (${images.map(i=>i.name||`${i.width}×${i.height}`).join(', ')}) not shown: ${why}]`;
function inputMessage(e,{vision=true}={}){
 const text=e.header?`${e.header}\n${e.text}`:e.text;
 if(!e.images?.length)return {role:'user',content:text};
 if(!vision)return {role:'user',content:`${text}\n${imageNote(e.images,'this model cannot see images; a work agent can describe them')}`};
 return {role:'user',content:[{type:'text',text},...e.images.map(imagePart)]};
}
export class ContextAssembler{
 constructor(sessions){this.sessions=sessions;}
 /** The live part of a session: latest checkpoint and the entries after it. */
 view(id){
  const checkpoint=this.sessions.latest(id,'checkpoint');
  const from=checkpoint?checkpoint.upTo+1:1;
  const all=this.sessions.entries(id,{from});
  const clears=all.filter(e=>e.type==='clear');
  const clearUpTo=clears.reduce((m,e)=>Math.max(m,e.upTo),0);
  const entries=all.filter(e=>['input','notice','assistant','tool'].includes(e.type)&&e.seq>(checkpoint?.upTo||0));
  return {checkpoint,entries,clearUpTo};
 }
 isCleared(e,view,latest){
  if(clearableInput(e))return e.seq<=view.clearUpTo;
  if(e.type!=='tool')return false;
  const superseded=!!e.ephemeralKey&&latest.get(e.ephemeralKey)!==e.seq;
  if(e.ephemeralKey&&!superseded)return false;
  return e.seq<=view.clearUpTo&&(superseded||!e.keep);
 }
 /** Renders entries to canonical messages, with per-entry token counts for planning. Images returned by a tool
  * follow all results of their step as one user message, since a tool message cannot carry images everywhere. */
 renderEntries(view,{clearUpTo=view.clearUpTo,vision=true}={}){
  const latest=new Map();for(const e of view.entries)if(e.type==='tool'&&e.ephemeralKey)latest.set(e.ephemeralKey,e.seq);
  const v={...view,clearUpTo},out=[];let pending=[];
  const flush=()=>{for(const p of pending){const m={role:'user',content:[{type:'text',text:`[image${p.images.length>1?'s':''} returned by ${p.name} #${p.seq}]`},...p.images.map(imagePart)]};out.push({entry:p.entry,message:m,tokens:messageTokens(m)});}pending=[];};
  for(const e of view.entries){
   if(e.type!=='tool')flush();
   let m;
   if(e.type==='input')m=this.isCleared(e,v,latest)?{role:'user',content:e.kind==='report'?reportStub(e):`${e.header?e.header+' ':''}[check-in cleared]`}:inputMessage(e,{vision});
   else if(e.type==='notice')m={role:'user',content:e.text};
   else if(e.type==='assistant'){
    const old=e.seq<=clearUpTo,ref='#'+e.seq;
    m={role:'assistant',content:e.content||null,...(e.toolCalls?.length?{tool_calls:e.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:old?shrinkArgs(c.arguments,ref):c.arguments}}))}:{}),
     ...(e.native?{_native:old?shrinkNative(e.native,ref):e.native}:{})};
   }
   else{
    const cleared=this.isCleared(e,v,latest);
    m={role:'tool',tool_call_id:e.callId,content:cleared?stubText(e):e.images?.length&&!vision?`${e.content}\n${imageNote(e.images,'this model cannot see images')}`:e.content};
    if(!cleared&&vision&&e.images?.length)pending.push({entry:e,images:e.images,name:e.name,seq:e.seq});
   }
   out.push({entry:e,message:m,tokens:messageTokens(m)});
  }
  flush();
  return out;
 }
 /** Cache breakpoints (for providers that take them): the checkpoint, the end of the previous request, and the
  * newest message. The previous request's end matters when one step added many blocks: Anthropic looks back
  * only 20 blocks from a breakpoint, so without it a step with ten parallel calls would miss everything. */
 build(id,{system,clearUpTo,vision=true}={}){
  const view=this.view(id),rendered=this.renderEntries(view,{clearUpTo,vision});
  const messages=[{role:'system',content:system}];
  if(view.checkpoint)messages.push({role:'user',content:view.checkpoint.text,cache:true});
  const first=messages.length;
  messages.push(...repairSequence(rendered.map(r=>r.message)));
  const lastAssistant=messages.findLastIndex(m=>m.role==='assistant');
  if(lastAssistant-1>=first&&messages[lastAssistant-1].role!=='assistant')messages[lastAssistant-1]={...messages[lastAssistant-1],cache:true};
  if(messages.length>1)messages[messages.length-1]={...messages.at(-1),cache:true};
  const tokens=messages.reduce((n,m)=>n+messageTokens(m),0);
  return {messages,tokens,view,rendered,vision,checkpointTokens:view.checkpoint?rawTokens(view.checkpoint.text):0};
 }
}
/** Every tool call needs a result before the next turn, and no result may lack its call. */
export function repairSequence(messages){
 const out=[];let open=null;
 const close=()=>{if(open){for(const id of open)out.push({role:'tool',tool_call_id:id,content:'(no result was recorded for this call)'});open=null;}};
 for(const m of messages){
  if(m.role==='tool'){if(open?.has(m.tool_call_id)){open.delete(m.tool_call_id);out.push(m);if(!open.size)open=null;}continue;}
  close();out.push(m);
  if(m.role==='assistant'&&m.tool_calls?.length)open=new Set(m.tool_calls.map(c=>c.id));
 }
 close();return out;
}

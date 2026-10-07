import {createHash} from 'node:crypto';
import {nativeCore} from '../native-state.mjs';
import {rawTokens,toolsTokens} from './tokens.mjs';
import {SMALL_RESULT_TOKENS} from './context.mjs';
import {NOTICE,systemPrompt} from './prompts.mjs';
import {toText,fitTokens,defaultStub,checkArgs,parseArgs,argsLabel,oneLine} from '../tools/format.mjs';
import {personaForPrompt} from '../persona.mjs';
import {selfFacts,selfCheckDue,noteSelfCheck,renderSelfCheck} from './metacog.mjs';

const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex').slice(0,16);
/** A system prompt in its "# Heading" sections (the text before the first heading is one section too). */
const sections=text=>String(text||'').split(/\n(?=# )/).map(x=>x.trim()).filter(Boolean);
const boundedArgs=a=>{if(!a||typeof a!=='object')return a;const o={};for(const [k,v] of Object.entries(a))o[k]=typeof v==='string'&&v.length>600?v.slice(0,600)+'…':v;return o;};
/** One step: deliver input, keep the context in budget, call the model, run tools, record everything.
 * Returns an outcome for the runtime; only an abort escapes as an exception. */
export class AgentLoop{
 constructor(runtime){this.rt=runtime;this.memory=new Map();this.signals=new Map();this.engine=new nativeCore.ExecutionCore();}
 state(id){if(!this.memory.has(id))this.memory.set(id,{calls:[],errorStreak:0,warned:new Set(),overflows:0,badRequests:0,empties:0,nudges:0,healthy:0});return this.memory.get(id);}
 forget(id){this.engine.forget(id);this.memory.delete(id);}
 /** Static per session: computed once and stored, refreshed only at a checkpoint (when the cache resets anyway). */
 prompt(session,{refresh=false}={}){
  const rt=this.rt;
  if(session.system&&!refresh)return session;
  const tools=session.tools?.length&&!refresh?session.tools:rt.tools.toolset(session.toolset,{exclude:rt.excludedTools(session)});
  return rt.sessions.update(session.id,{system:this.render(session,tools),tools,promptAt:new Date().toISOString(),promptStale:false,announced:null});
 }
 render(session,tools){
  const rt=this.rt,persona=session.kind==='main'?personaForPrompt(rt.personas().character):personaForPrompt(session.persona||rt.personas().worker);
  return systemPrompt(session,{tools,sandbox:rt.sandboxPolicy(),persona,computer:rt.computerInfo?.(),skills:rt.skillIndex?.(session)});
 }
 /** Settings, persona or tools changed while a session lives. Rewriting the system prompt would throw away the
  * whole cached prefix, so the changed instructions are appended to the transcript instead (DeepSeek Harness does
  * the same) and the prompt itself is replaced at the next checkpoint, where the cache starts over anyway. */
 update(session){
  const rt=this.rt;if(!session?.system)return false;
  // Compared with what the session was last told (an earlier update, or its system prompt), so nothing repeats.
  const told=session.announced||{system:session.system,tools:session.tools||[]};
  const declared=session.tools||[],available=rt.tools.toolset(session.toolset,{exclude:rt.excludedTools(session)});
  const next=this.render(session,declared),old=new Set(sections(told.system));
  const changed=sections(next).filter(x=>!old.has(x)),added=available.filter(n=>!told.tools.includes(n)),removed=told.tools.filter(n=>!available.includes(n));
  if(!changed.length&&!added.length&&!removed.length)return false;
  rt.sessions.append(session.id,'notice',{text:NOTICE.instructionsUpdated({sections:changed,added,removed}),promptUpdate:true});
  rt.sessions.update(session.id,{promptStale:true,announced:{system:next,tools:available}});return true;
 }
 async budget(session,toolDefs,signal){
  const rt=this.rt,chain=rt.registry.chain(session.role).filter(p=>rt.registry.permitted(p));
  if(!chain.length)return {chain:[],B:0};
  const p=chain[0],limits=await rt.registry.limits(p,signal),ratio=rt.calibration.ratio(p.identity);
  const reserve=Math.min(p.maxTokens,Math.floor(limits.context*0.25));
  const B=Math.floor((limits.context-reserve)*0.95-toolsTokens(toolDefs)*ratio);
  return {chain,profile:p,limits,ratio,B,reserve};
 }
 async step(id,signal){
  signal||=new AbortController().signal;this.signals.set(id,signal);
  return this.drive(JSON.parse(this.engine.begin(JSON.stringify(this.rt.sessions.get(id)),'{}')),signal);
 }
 /** Rust owns phase selection. This host executes correlated effects and holds
  * opaque plugin objects only for the lifetime of this step. */
 async drive(initial,signal){
  const rt=this.rt,id=initial.sessionId,generation=initial.generation;
  const ctx={id,generation,signal,handles:new Map(),args:new Map(),results:new Map(),errors:new Map(),next:0,started:0,closed:false};
  const pending=new Map(),queue=[];let terminal=null;
  const accept=state=>{
   if(state.status==='stale')return;
   queue.push(...state.commands);if(state.status==='finished')terminal=state.outcome||{};
   const current=JSON.parse(this.engine.state(id));
   if(current){const mem=this.state(id);for(const key of ['overflows','badRequests','empties','forceCompact'])mem[key]=current[key];}
  };
  const abortError=(notExecuted=false)=>Object.assign(new Error(String(signal.reason?.message||signal.reason||'Aborted')),{name:signal.reason?.name||'AbortError',stopped:signal.reason?.stopped,notExecuted});
  const serializeError=(error,operationId)=>{
   ctx.errors.set(operationId,error);
   const read=key=>{try{return error?.[key];}catch{return undefined;}};
   const text=key=>{const value=read(key);return typeof value==='string'?value:undefined;};
   const finite=key=>{const value=read(key);return Number.isFinite(value)?value:undefined;};
   let message;try{message=String(read('message')||error);}catch{message='Host effect failed';}
   return {effectId:operationId,name:text('name')||'Error',message,kind:text('kind'),body:text('body'),limit:finite('limit'),retryAfterMs:finite('retryAfterMs'),notExecuted:read('notExecuted')===true};
  };
  const stop=()=>{
   accept(JSON.parse(this.engine.stop(JSON.stringify({sessionId:id,generation,reason:String(signal.reason?.message||signal.reason||'Aborted')}))));
   rt.policy.cancel(id);rt.streamEnd(id,{discard:true});
  };
  accept(initial);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  try{
   while(!terminal||pending.size){
    while(queue.length){
     const command=queue.shift();
     const promise=Promise.resolve().then(()=>{
      if(signal.aborted&&!['recordTools','afterTool'].includes(command.kind))throw abortError(command.kind==='executeTool');
      return this.effect(command,ctx);
     }).then(value=>({command,type:'resolved',value}),error=>({command,type:'rejected',error}));
     pending.set(command.operationId,promise);
    }
    if(!pending.size){if(terminal)break;throw new Error('Rust execution controller stalled without a pending effect');}
    const settled=await Promise.race(pending.values()),command=settled.command;pending.delete(command.operationId);
    const error=settled.type==='rejected'?serializeError(settled.error,command.operationId):undefined;
    const handle=ctx.handles.get(command.prepared?.definitionKey)||ctx.handles.get('index:'+command.index);
    const facts={...(command.kind==='invoke'?{elapsedMs:ctx.started?Date.now()-ctx.started:0}:{}),...(handle&&command.kind!=='prepareTool'?{toolMs:Date.now()-handle.started}:{})};
    const event={sessionId:id,generation,operationId:command.operationId,type:settled.type,value:settled.value,error,aborted:signal.aborted};
    let eventJSON;try{eventJSON=JSON.stringify(event);}catch(failure){eventJSON=JSON.stringify({sessionId:id,generation,operationId:command.operationId,type:'rejected',error:serializeError(failure,command.operationId),aborted:signal.aborted});}
    accept(JSON.parse(this.engine.advance(eventJSON,JSON.stringify(facts))));
   }
   if(terminal?.aborted)throw signal.reason??abortError();
   if(terminal?.error)throw ctx.errors.get(terminal.error.effectId)||Object.assign(new Error(terminal.error.message),terminal.error);
   return terminal||{};
  }finally{
   ctx.closed=true;signal.removeEventListener('abort',stop);
   if(this.signals.get(id)===signal)this.signals.delete(id);
   ctx.handles.clear();ctx.args.clear();ctx.results.clear();ctx.errors.clear();
  }
 }
 hold(map,value,ctx,kind){const ref=`${ctx.generation}:${kind}:${++ctx.next}`;map.set(ref,value);return {hostRef:ref};}
 held(map,value){if(value&&typeof value.hostRef==='string'&&map.has(value.hostRef))return map.get(value.hostRef);return value;}
 async effect(c,ctx){
  const rt=this.rt,{id,signal}=ctx;
  const active=()=>!ctx.closed&&!signal.aborted&&JSON.parse(this.engine.state(id))?.generation===ctx.generation;
  const prepared=c.prepared,handle=prepared&&ctx.handles.get(prepared.definitionKey),args=prepared?this.held(ctx.args,prepared.args):undefined;
  switch(c.kind){
   case 'prompt':return this.prompt(c.session,{refresh:!!c.refresh});
   case 'budget':{
    const session=c.overflow?rt.sessions.get(id):c.session,toolDefs=c.toolDefs||rt.tools.definitions(session.tools),budget=await this.budget(session,toolDefs,signal);
    return {...budget,toolDefs,toolsTokens:toolsTokens(toolDefs),vision:budget.profile?rt.registry.visionAllowed(budget.profile):false};
   }
   case 'context':{const built=rt.assembler.build(id,{system:c.session.system,vision:c.vision});return {built,...(c.plan?{plan:rt.compactor.plan(built,c.budget.B,c.budget.ratio,{force:c.force})}:{})};}
   case 'clear':rt.compactor.clear(c.session,c.upTo);return null;
   case 'compact':{
    const session=c.overflow?rt.sessions.get(id):c.session;
    await this.compact(session,{built:c.built,B:c.budget.B,ratio:c.budget.ratio,toolDefs:c.budget.toolDefs,chain:c.budget.chain,signal,reason:c.reason==='budget'?undefined:c.reason,tailShare:c.tailShare});
    const next=c.overflow?rt.sessions.get(id):this.prompt(rt.sessions.get(id));return {session:next,toolDefs:c.overflow?c.budget.toolDefs:rt.tools.definitions(next.tools)};
   }
   case 'beforeRequest':{ctx.started=Date.now();const h=rt.tools.hooks.length?await rt.tools.hook('beforeRequest',{session:c.session,messages:c.messages}):{};return {messages:h.messages||c.messages};}
   case 'invoke':return rt.registry.invoke(c.chain,c.messages,{tools:c.toolDefs,signal,cacheKey:c.cacheKey,slotKey:c.slotKey,priority:c.priority,cacheRetention:rt.cacheRetention(c.session),onDelta:text=>{if(active())rt.stream(id,'text',text);},onReasoning:text=>{if(active())rt.stream(id,'reasoning',text);},onProgress:progress=>{if(active())rt.loadingNote(id,progress);},onRoute:route=>{if(active())rt.sessions.update(id,{route});}});
   case 'account':rt.account(id,c.answer,c.elapsedMs);return null;
   case 'commit':{
    let session;
    for(const a of c.actions){
     if(signal.aborted)signal.throwIfAborted();
     switch(a.kind){
      case 'event':rt.event(id,a.event,a.data);break;
      case 'streamEnd':rt.streamEnd(id,{discard:!!a.discard});break;
      case 'append':rt.sessions.append(id,a.type,a.body);break;
      case 'notice':rt.sessions.append(id,'notice',{text:NOTICE[a.notice](...(a.args||[]))});break;
      case 'learnNoVision':rt.registry.learnNoVision(a.profile);break;
      case 'learnLimit':rt.registry.learnLimit(a.profile,a.limit);break;
      case 'calibrate':rt.calibration.observe(a.identity,a.sentRaw,a.reported);break;
      case 'lean':session=this.prompt(rt.sessions.update(id,{toolset:'lean'}),{refresh:true});rt.event(id,'lean-tools',{context:a.context});break;
      default:throw new Error('Unknown Rust commit action: '+a.kind);
     }
    }
    return session?{session}:null;
   }
   case 'toolCatalog':return {session:rt.sessions.get(id),tools:Object.fromEntries(c.calls.map(call=>[call.name,{readOnly:rt.tools.get(call.name)?.readOnly===true}]))};
   case 'prepareTool':return this.prepareTool(c,ctx);
   case 'beforeTool':{const h=rt.tools.hooks.length?await rt.tools.hook('beforeTool',{session:c.session,name:prepared.name,args}):{};return {...(h.block?{block:String(h.block)}:{}),...(h.args&&typeof h.args==='object'?{args:this.hold(ctx.args,h.args,ctx,'args')}:{})};}
   case 'authorizeTool':{
    const approvedJSON=JSON.stringify(args),snapshot=JSON.parse(approvedJSON),decision=await rt.policy.check(c.session,prepared.name,snapshot,{signal});
    if(handle&&decision==='allow')handle.approvedJSON=approvedJSON;return {decision};
   }
   case 'executeTool':{
    if(!handle)throw Object.assign(new Error('Prepared tool handle is missing'),{notExecuted:true});
    if(JSON.stringify(args)!==handle.approvedJSON)throw Object.assign(new Error('Approved tool arguments changed before execution'),{notExecuted:true});
    rt.sessions.update(id,{note:handle.def?.summarize?oneLine(handle.def.summarize(args),100):prepared.name});
    const result=handle.mcp?await rt.mcp.call(prepared.name,args,{signal}):await handle.def.run(args,rt.toolContext(c.session,signal));
    return {result:this.hold(ctx.results,result,ctx,'result')};
   }
   case 'afterTool':{
    let result=this.held(ctx.results,c.result);
    if(!signal.aborted&&rt.tools.hooks.length){const a=await rt.tools.hook('afterTool',{session:c.session,name:prepared.name,args,text:toText(result?.text??result)});if(typeof a.text==='string')result={...(result&&typeof result==='object'?result:{}),text:a.text};}
    return {result:this.hold(ctx.results,result,ctx,'result')};
   }
   case 'recordTools':{
    for(let i=0;i<c.calls.length;i++){const out=c.outputs[i],h=ctx.handles.get(out.definitionKey);this.record(c.session,c.calls[i],{...out,args:this.held(ctx.args,out.args),result:this.held(ctx.results,out.result),def:h?.def,...(signal.aborted?{interrupted:true}:{})},c.B);}return null;
   }
   case 'afterTools':{const mem=this.state(id);this.watch(id,mem);this.selfCheck(id,mem,{built:c.built,B:c.budget.B,ratio:c.budget.ratio,profile:c.budget.profile});return null;}
   default:throw new Error('Unknown Rust execution effect: '+c.kind);
  }
 }
 async compact(session,{built,B,ratio,toolDefs,chain,signal,reason,tailShare}){
  const rt=this.rt;
  const live={sessions:Object.fromEntries(rt.sessions.list({parentId:session.id}).map(s=>[s.id,s.status])),processes:Object.fromEntries(rt.processes.list(session.id).map(p=>[p.id,p.status+(p.exitCode!==null?' '+p.exitCode:'')]))};
  rt.sessions.update(session.id,{note:'文脈を整理しています'});
  const cp=await rt.compactor.compact(session,{built,B,ratio,system:session.system,toolDefs,chain,signal,reason,tailShare,todo:session.todo||null,reflection:session.reflection||null,live,cacheRetention:rt.cacheRetention(session)});
  // The checkpoint resets the cache anyway: refresh the system prompt and tool set now if settings changed.
  if(cp){this.prompt(rt.sessions.get(session.id),{refresh:true});this.state(session.id).selfCheckContext=false;}
  return cp;
 }
 async runTools(session,calls,{signal,B}){
  signal||=new AbortController().signal;this.signals.set(session.id,signal);
  await this.drive(JSON.parse(this.engine.beginTools(JSON.stringify(session),JSON.stringify(calls),JSON.stringify({B}))),signal);
 }
 prepareTool(c,ctx){
  const rt=this.rt,{session,call,index}=c,started=Date.now(),parsed=parseArgs(call.arguments);
  if(parsed.error)return {error:`${parsed.error}. Send the call again with valid JSON arguments.`,ms:0};
  let name=call.name,args=parsed.args,def=rt.tools.get(name),mcp=false;
  if(name==='tools_call'){
   name=String(args.name||'');args=args.arguments||{};
   if(name.startsWith('mcp:'))mcp=true;
   else{def=rt.tools.get(name);if(!def)return {error:`Unknown tool "${name}". Use tools_search to find available tools.`,ms:0};}
  }
  if(!mcp&&!def){const near=[...rt.tools.tools.keys()].filter(n=>n.includes(name.split('_')[0])||name.includes(n)).slice(0,5);return {error:`Unknown tool "${name}".${near.length?' Did you mean: '+near.join(', ')+'?':''} Available: ${session.tools.join(', ')}.`,ms:0};}
  const definitionKey=`${ctx.generation}:tool:${index}`,handle={started,def:mcp?null:def,mcp};ctx.handles.set(definitionKey,handle);ctx.handles.set('index:'+index,handle);
  if(!mcp){const invalid=checkArgs(def.parameters,args);if(invalid)return {error:`Invalid arguments for ${name}: ${invalid}.`,ms:0,definitionKey};}
  return {name,args:this.hold(ctx.args,args,ctx,'args'),definitionKey,repaired:parsed.repaired,ms:0};
 }
 /** Shapes a result once and appends it. The visible text, its one-line stub and the evidence are fixed here. */
 record(session,call,out,B){
  const rt=this.rt,id=session.id,seq=rt.sessions.seq(id),ref='#'+seq,def=out.def||rt.tools.get(out.name||call.name);
  const name=out.name||call.name,args=out.args;
  let text=out.error?`Error: ${out.error}`:toText(out.result?.text??out.result);
  const images=!out.error&&Array.isArray(out.result?.images)&&out.result.images.length?out.result.images.slice(0,8).map(i=>({mime:i.mime,base64:i.base64,width:i.width||0,height:i.height||0,name:i.name||''})):null;
  if(out.repaired)text='(note: your arguments were not valid JSON and were repaired automatically)\n'+text;
  if(out.notExecuted)text='[not executed: this call was not dispatched.]\n'+text;
  else if(out.interrupted)text='[interrupted: the session was stopped or the service shut down while this ran, so it was terminated early. Check the actual state before retrying.]\n'+text;
  const budget=Math.round(Math.min(10000,Math.max(600,B*0.1)));
  const fitted=fitTokens(text,budget,ref);
  let evidenceId=null;if(fitted.truncated){evidenceId=`${id}#${seq}`;rt.sessions.putEvidence(evidenceId,id,seq,name,text);}
  const stub=out.error?defaultStub(name,args,text,{error:out.error}):(def?.stub?.(args||{},out.result)??defaultStub(name,args||{},text));
  const ephemeralKey=def?.ephemeral?(def.ephemeralKey?def.ephemeralKey(args||{}):name):null;
  rt.sessions.append(id,'tool',{callId:call.id,name,args:boundedArgs(args),content:fitted.text,stub:oneLine(stub,200),error:!!out.error,errorText:out.error?oneLine(out.error,300):undefined,
   data:out.result?.data,...(out.notExecuted?{notExecuted:true}:{}),...(out.interrupted?{interrupted:true}:{}),...(images?{images}:{}),ephemeralKey,keep:!images&&rawTokens(fitted.text)<SMALL_RESULT_TOKENS&&!ephemeralKey,evidenceId,chars:text.length,ms:out.ms});
  const mem=this.state(id);mem.calls.push({sig:hash([name,args]),outcome:hash(text),label:`${name}(${argsLabel(args)})`,error:!!out.error});if(mem.calls.length>12)mem.calls.shift();
  const d=out.result?.data;if(name==='read'&&d?.readKey){mem.reads||=new Map();mem.reads.set(d.readKey,{seq,mtimeMs:d.mtimeMs,size:d.size});if(mem.reads.size>300)mem.reads.delete(mem.reads.keys().next().value);}
  mem.errorStreak=out.error?mem.errorStreak+1:0;
  if(name==='todo'&&!out.error)mem.todoStep=rt.sessions.get(id).stats?.steps||0;
  const s=rt.sessions.get(id);rt.sessions.update(id,{stats:{...s.stats,toolCalls:(s.stats?.toolCalls||0)+1,toolErrors:(s.stats?.toolErrors||0)+(out.error?1:0)}});
 }
 /** Metacognition: when something worth noticing happened (context filling up, failures piling up, a checklist
  * that stopped moving, no stated understanding, low confidence, or simply a long stretch), the measured facts of
  * the run are appended for the model to judge its own approach by. Appended, so the cached prefix is untouched. */
 selfCheck(id,mem,ctx){
  const rt=this.rt,s=rt.sessions.get(id);
  if(!s||rt.settings().metacognition===false)return;
  const f=selfFacts(rt,s,mem,ctx),why=selfCheckDue(s,mem,f);
  if(!why.length)return;
  noteSelfCheck(mem,f,why);
  rt.sessions.append(id,'notice',{text:renderSelfCheck(f,why,{kind:s.kind}),selfCheck:why});
  rt.event(id,'self-check',{why,steps:f.steps,context:f.context?Math.round(f.context.share*100):null,confidence:f.reflection?.confidence??null});
 }
 /** Repetition and error streaks: nudge first, then a stronger model, then tell the requester. */
 watch(id,mem){
  const rt=this.rt,last=mem.calls.at(-1);if(!last)return;
  const same=mem.calls.filter(c=>c.sig===last.sig&&c.outcome===last.outcome).length;
  if(same>=3&&!mem.warned.has(last.sig+last.outcome)){mem.warned.add(last.sig+last.outcome);rt.sessions.append(id,'notice',{text:NOTICE.repeated(last.label,same)});}
  if(mem.errorStreak===5)rt.sessions.append(id,'notice',{text:NOTICE.errorStreak(5)});
  if(mem.errorStreak===10||same===6)rt.escalate(id,mem.errorStreak>=10?'repeated errors':'repetition');
  // Healthy steps on an escalated session: no error and no repetition. Eight in a row hand the work back.
  if(!last.error&&same<2)mem.healthy++;else mem.healthy=0;
  if(mem.healthy>=8&&rt.sessions.get(id)?.role==='escalation'){mem.healthy=0;rt.deescalate(id);}
 }
}

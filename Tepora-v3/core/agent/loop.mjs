import {createHash} from 'node:crypto';
import {rawTokens,toolsTokens} from './tokens.mjs';
import {SMALL_RESULT_TOKENS} from './context.mjs';
import {COMPACTION} from './compaction.mjs';
import {NOTICE,systemPrompt} from './prompts.mjs';
import {toText,fitTokens,defaultStub,checkArgs,parseArgs,argsLabel,oneLine} from '../tools/format.mjs';
import {RouteUnavailable} from '../provider-registry.mjs';
import {personaForPrompt} from '../persona.mjs';

const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex').slice(0,16);
/** A system prompt in its "# Heading" sections (the text before the first heading is one section too). */
const sections=text=>String(text||'').split(/\n(?=# )/).map(x=>x.trim()).filter(Boolean);
const hasImages=messages=>messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
const boundedArgs=a=>{if(!a||typeof a!=='object')return a;const o={};for(const [k,v] of Object.entries(a))o[k]=typeof v==='string'&&v.length>600?v.slice(0,600)+'…':v;return o;};
/** One step: deliver input, keep the context in budget, call the model, run tools, record everything.
 * Returns an outcome for the runtime; only an abort escapes as an exception. */
export class AgentLoop{
 constructor(runtime){this.rt=runtime;this.memory=new Map();this.signals=new Map();}
 state(id){if(!this.memory.has(id))this.memory.set(id,{calls:[],errorStreak:0,warned:new Set(),overflows:0,badRequests:0,empties:0,nudges:0,healthy:0});return this.memory.get(id);}
 forget(id){this.memory.delete(id);}
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
  const rt=this.rt,mem=this.state(id);this.signals.set(id,signal);
  let session=this.prompt(rt.sessions.get(id));
  let toolDefs=rt.tools.definitions(session.tools);
  let {chain,profile,ratio,B,limits}=await this.budget(session,toolDefs,signal);
  if(!chain.length){const e=new RouteUnavailable('会話・作業に使うモデルを「AIとの接続」で登録してください。',{kind:'unconfigured',retryAfterMs:60000});return {wait:e.retryAfterMs,note:e.message};}
  // A window too small for the full tool set: fall back to the lean set before giving up.
  if(B<1200&&session.toolset==='worker'){session=this.prompt(rt.sessions.update(id,{toolset:'lean'}),{refresh:true});rt.event(id,'lean-tools',{context:limits.context});toolDefs=rt.tools.definitions(session.tools);({chain,profile,ratio,B,limits}=await this.budget(session,toolDefs,signal));}
  if(B<1200)return {wait:300000,note:`モデルの文脈の窓（${limits.context}トークン）が小さすぎて作業できません。サーバーの文脈長（llama.cppの-c、Ollamaのnum_ctxなど）を増やしてください。`};
  // Keep the context inside the budget. Clearing and compaction are the only moments the prefix changes.
  const vision=rt.registry.visionAllowed(profile);
  let built=rt.assembler.build(id,{system:session.system,vision});
  const plan=rt.compactor.plan(built,B,ratio,{force:mem.forceCompact});mem.forceCompact=false;
  if(plan.action==='clear'){rt.compactor.clear(session,plan.upTo);built=rt.assembler.build(id,{system:session.system,vision});}
  else if(plan.action==='compact'){await this.compact(session,{built,B,ratio,toolDefs,chain,signal});session=this.prompt(rt.sessions.get(id));toolDefs=rt.tools.definitions(session.tools);built=rt.assembler.build(id,{system:session.system,vision});}
  // Call the model.
  let answer;const started=Date.now(),messages=rt.tools.hooks.length?(await rt.tools.hook('beforeRequest',{session,messages:built.messages})).messages||built.messages:built.messages;
  try{
   answer=await rt.registry.invoke(chain,messages,{tools:toolDefs,signal,cacheKey:id,slotKey:id,priority:session.kind==='main'?10:0,cacheRetention:rt.cacheRetention(session),
    onDelta:t=>rt.stream(id,'text',t),onReasoning:t=>rt.stream(id,'reasoning',t),onProgress:p=>rt.loadingNote(id,p),onRoute:r=>rt.sessions.update(id,{route:r})});
  }catch(e){
   if(signal.aborted)throw e;
   rt.streamEnd(id,{discard:true});
   if(e.kind==='overflow'){
    mem.overflows++;rt.event(id,'overflow',{limit:e.limit,message:oneLine(e.message,200)});
    const fresh=await this.budget(rt.sessions.get(id),toolDefs,signal);
    const b2=rt.assembler.build(id,{system:session.system,vision});
    await this.compact(rt.sessions.get(id),{built:b2,B:fresh.B,ratio:fresh.ratio,toolDefs,chain,signal,reason:'overflow',tailShare:mem.overflows>1?0.1:COMPACTION.tail});
    return mem.overflows>3?{wait:60000,note:'文脈の溢れが続いています。'}:{continue:true};
   }
   if(e.kind==='auth')return {wait:300000,note:e.message};
   // A model that turns out not to see images: remember it, and send placeholders from now on.
   if(e.kind==='bad-request'&&vision&&hasImages(built.messages)&&/image|vision|multimodal|modalit/i.test(e.message+' '+(e.body||''))){rt.registry.learnNoVision(profile);rt.event(id,'no-vision',{model:profile.model});return {continue:true};}
   if(e.kind==='bad-request'){mem.badRequests++;rt.event(id,'bad-request',{message:oneLine(e.message,300)});return {wait:Math.min(600000,15000*2**Math.min(mem.badRequests,5)),note:'モデルが依頼を受け付けませんでした: '+oneLine(e.message,160)};}
   return {wait:e.retryAfterMs||30000,note:e.message||'モデルに接続できません。'};
  }
  mem.overflows=0;mem.badRequests=0;
  rt.account(id,answer,Date.now()-started);
  // The server counted far fewer prompt tokens than were sent. With a window that was only assumed (nothing
  // reported it), that is a server silently cutting the conversation's beginning to its real window: the answer
  // saw a beheaded context, so drop it, learn the window, compact and ask again. A detected window is trusted;
  // the sample is then only kept out of the calibration.
  const sentRaw=built.tokens+toolsTokens(toolDefs),estimated=sentRaw*ratio,reported=answer.usage?.input||0;
  const anomaly=reported>0&&!answer.usage.uncachedOnly&&estimated>4000&&reported<estimated*0.5;
  if(anomaly&&['default','guess'].includes(limits.source)&&answer.route?.identity===profile.identity){
   rt.streamEnd(id,{discard:true});rt.registry.learnLimit(profile,Math.max(2048,Math.round(reported*1.02)));mem.forceCompact=true;
   rt.event(id,'input-truncated',{reported,estimated:Math.round(estimated),assumedContext:limits.context});
   return {continue:true};
  }
  if(!anomaly&&!answer.usage?.uncachedOnly)rt.calibration.observe(answer.route?.identity,sentRaw,reported);
  rt.streamEnd(id);
  // Truncated replies are kept (minus any half-written tool call) and continued.
  if(answer.finish==='length'){
   const partial=answer.tool_calls?.length;
   rt.sessions.append(id,'assistant',{content:answer.content||'',reasoning:answer.reasoning||null,toolCalls:[],truncated:true,droppedCalls:partial?answer.tool_calls.map(c=>c.function.name):undefined,usage:answer.usage,route:answer.route});
   rt.sessions.append(id,'notice',{text:partial?NOTICE.truncatedCall(answer.route?.maxTokens):NOTICE.truncatedText(answer.route?.maxTokens)});
   return {continue:true};
  }
  if(answer.finish==='refusal'&&!answer.tool_calls?.length){
   rt.sessions.append(id,'assistant',{content:answer.content||'',toolCalls:[],refused:true,usage:answer.usage,route:answer.route});
   if(mem.empties++<1){rt.sessions.append(id,'notice',{text:NOTICE.refusal()});return {continue:true};}
   return {turnEnded:true,text:answer.content||'（応答が提供元に止められました）'};
  }
  const calls=(answer.tool_calls||[]).map(c=>({id:c.id,name:c.function.name,arguments:c.function.arguments||'{}'}));
  rt.sessions.append(id,'assistant',{content:answer.content||'',reasoning:answer.reasoning||null,toolCalls:calls,native:answer._native||null,usage:answer.usage,route:answer.route,finish:answer.finish});
  if(!calls.length){
   if(!String(answer.content||'').trim()){if(mem.empties++<2){rt.sessions.append(id,'notice',{text:NOTICE.empty()});return {continue:true};}return {turnEnded:true,text:''};}
   mem.empties=0;return {turnEnded:true,text:answer.content};
  }
  mem.empties=0;
  await this.runTools(rt.sessions.get(id),calls,{signal,B});
  this.watch(id,mem);
  return {continue:true};
 }
 async compact(session,{built,B,ratio,toolDefs,chain,signal,reason,tailShare}){
  const rt=this.rt;
  const live={sessions:Object.fromEntries(rt.sessions.list({parentId:session.id}).map(s=>[s.id,s.status])),processes:Object.fromEntries(rt.processes.list(session.id).map(p=>[p.id,p.status+(p.exitCode!==null?' '+p.exitCode:'')]))};
  rt.sessions.update(session.id,{note:'文脈を整理しています'});
  const cp=await rt.compactor.compact(session,{built,B,ratio,system:session.system,toolDefs,chain,signal,reason,tailShare,todo:session.todo||null,live,cacheRetention:rt.cacheRetention(session)});
  // The checkpoint resets the cache anyway: refresh the system prompt and tool set now if settings changed.
  if(cp)this.prompt(rt.sessions.get(session.id),{refresh:true});
  return cp;
 }
 async runTools(session,calls,{signal,B}){
  const groups=[];for(const c of calls){const def=this.rt.tools.get(c.name);const ro=def?.readOnly===true;if(ro&&groups.at(-1)?.ro)groups.at(-1).items.push(c);else groups.push({ro,items:[c]});}
  for(const g of groups){
   signal.throwIfAborted();
   const results=await Promise.all(g.items.map(c=>this.runOne(session,c,{signal})));
   for(let i=0;i<g.items.length;i++)this.record(session,g.items[i],signal.aborted?{...results[i],interrupted:true}:results[i],B);
   signal.throwIfAborted();
  }
 }
 async runOne(session,call,{signal}){
  const rt=this.rt,started=Date.now();
  let name=call.name,def=rt.tools.get(name);
  const parsed=parseArgs(call.arguments);
  if(parsed.error)return {error:`${parsed.error}. Send the call again with valid JSON arguments.`,ms:0};
  let args=parsed.args;
  if(name==='tools_call'){
   const inner=String(args.name||'');
   if(inner.startsWith('mcp:'))return this.guarded(session,{name:inner,args:args.arguments||{},run:()=>rt.mcp.call(inner,args.arguments||{},{signal})},started,parsed.repaired);
   def=rt.tools.get(inner);if(!def)return {error:`Unknown tool "${inner}". Use tools_search to find available tools.`,ms:0};
   name=inner;args=args.arguments||{};
  }
  if(!def){const near=[...rt.tools.tools.keys()].filter(n=>n.includes(name.split('_')[0])||name.includes(n)).slice(0,5);return {error:`Unknown tool "${name}".${near.length?' Did you mean: '+near.join(', ')+'?':''} Available: ${session.tools.join(', ')}.`,ms:0};}
  const invalid=checkArgs(def.parameters,args);if(invalid)return {error:`Invalid arguments for ${name}: ${invalid}.`,ms:0,def};
  return this.guarded(session,{name,args,def,run:()=>def.run(args,rt.toolContext(session,signal))},started,parsed.repaired);
 }
 async guarded(session,{name,args,def,run},started,repaired){
  const rt=this.rt;
  const hooked=rt.tools.hooks.length?await rt.tools.hook('beforeTool',{session,name,args}):{};
  if(hooked.block)return {error:`A plugin refused this call: ${oneLine(hooked.block,300)}`,ms:Date.now()-started,def,name,args};
  if(hooked.args&&typeof hooked.args==='object'){args=hooked.args;if(def)run=()=>def.run(args,rt.toolContext(session,this.signals.get(session.id)));}
  const decision=await rt.policy.check(session,name,args);
  if(decision!=='allow')return {error:decision==='deny'?`The user's rules do not allow ${name} here.`:`The user declined this ${name} call.`,ms:Date.now()-started,def,name,args};
  try{
   rt.sessions.update(session.id,{note:def?.summarize?oneLine(def.summarize(args),100):name});
   let result=await run();
   if(rt.tools.hooks.length){const after=await rt.tools.hook('afterTool',{session,name,args,text:toText(result?.text??result)});if(typeof after.text==='string')result={...(result&&typeof result==='object'?result:{}),text:after.text};}
   return {result,ms:Date.now()-started,def,name,args,repaired};
  }catch(e){
   if(e?.name==='AbortError'&&session&&rt.aborted(session.id))throw e;
   return {error:String(e?.message||e).slice(0,2000),ms:Date.now()-started,def,name,args};
  }
 }
 /** Shapes a result once and appends it. The visible text, its one-line stub and the evidence are fixed here. */
 record(session,call,out,B){
  const rt=this.rt,id=session.id,seq=rt.sessions.seq(id),ref='#'+seq,def=out.def||rt.tools.get(out.name||call.name);
  const name=out.name||call.name,args=out.args;
  let text=out.error?`Error: ${out.error}`:toText(out.result?.text??out.result);
  const images=!out.error&&Array.isArray(out.result?.images)&&out.result.images.length?out.result.images.slice(0,8).map(i=>({mime:i.mime,base64:i.base64,width:i.width||0,height:i.height||0,name:i.name||''})):null;
  if(out.repaired)text='(note: your arguments were not valid JSON and were repaired automatically)\n'+text;
  if(out.interrupted)text='[interrupted: the session was stopped or the service shut down while this ran, so it was terminated early. Check the actual state before retrying.]\n'+text;
  const budget=Math.round(Math.min(10000,Math.max(600,B*0.1)));
  const fitted=fitTokens(text,budget,ref);
  let evidenceId=null;if(fitted.truncated){evidenceId=`${id}#${seq}`;rt.sessions.putEvidence(evidenceId,id,seq,name,text);}
  const stub=out.error?defaultStub(name,args,text,{error:out.error}):(def?.stub?.(args||{},out.result)??defaultStub(name,args||{},text));
  const ephemeralKey=def?.ephemeral?(def.ephemeralKey?def.ephemeralKey(args||{}):name):null;
  rt.sessions.append(id,'tool',{callId:call.id,name,args:boundedArgs(args),content:fitted.text,stub:oneLine(stub,200),error:!!out.error,errorText:out.error?oneLine(out.error,300):undefined,
   data:out.result?.data,...(images?{images}:{}),ephemeralKey,keep:!images&&rawTokens(fitted.text)<SMALL_RESULT_TOKENS&&!ephemeralKey,evidenceId,chars:text.length,ms:out.ms});
  const mem=this.state(id);mem.calls.push({sig:hash([name,args]),outcome:hash(text),label:`${name}(${argsLabel(args)})`,error:!!out.error});if(mem.calls.length>12)mem.calls.shift();
  const d=out.result?.data;if(name==='read'&&d?.readKey){mem.reads||=new Map();mem.reads.set(d.readKey,{seq,mtimeMs:d.mtimeMs,size:d.size});if(mem.reads.size>300)mem.reads.delete(mem.reads.keys().next().value);}
  mem.errorStreak=out.error?mem.errorStreak+1:0;
  const s=rt.sessions.get(id);rt.sessions.update(id,{stats:{...s.stats,toolCalls:(s.stats?.toolCalls||0)+1,toolErrors:(s.stats?.toolErrors||0)+(out.error?1:0)}});
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

import {oneLine} from '../tools/format.mjs';
import {COMPACTION} from './compaction.mjs';

/** Metacognition: the agent's picture of itself, kept in two parts.
 *  - Facts the harness measures (steps, time, context use, tool errors, checklist movement, model, cost) arrive as a
 *    "[harness] Self-check" message when something worth noticing happened. Facts come from the harness, never from
 *    the model, so a confused model cannot talk itself into a false picture of its own run.
 *  - Beliefs only the model can state (how it understands the task, its plan, what is verified and what is only
 *    assumed, confidence, open questions) live in the `reflect` tool. They are kept verbatim in the checkpoint ledger,
 *    so compaction never blurs what was checked into what was assumed.
 * Both are appended to the transcript like any other message: the cached prefix never changes for them. */
export const SELF_CHECK={every:15,minGap:5,context:0.6,errorWindow:6,errors:3,stalled:12,unreflected:10,lowConfidence:0.5};

/** Measured facts about a session's run. `built`/`B`/`ratio` describe the request that was just sent. */
export function selfFacts(rt,session,mem,{built,B,ratio,profile}={}){
 const st=session.stats||{},steps=st.steps||0,todo=session.todo||[],r=session.reflection||null;
 const recent=mem.calls.slice(-SELF_CHECK.errorWindow);
 const sigs=new Set(mem.calls.map(c=>c.sig)).size;
 const used=built&&B?Math.round(built.tokens*(ratio||1)):null;
 const team=session.kind==='main'?rt.sessions.list({parentId:session.id}).filter(s=>['running','waiting'].includes(s.status)):[];
 return {
  steps,minutes:Math.max(0,Math.round((Date.now()-Date.parse(session.createdAt||session.created||new Date().toISOString()))/60000)),
  context:used&&B?{used,budget:B,share:used/B}:null,
  calls:st.toolCalls||0,errors:st.toolErrors||0,recentErrors:recent.filter(c=>c.error).length,recentCalls:recent.length,
  variety:mem.calls.length?sigs/mem.calls.length:1,
  todo:todo.length?{done:todo.filter(t=>t.status==='done').length,total:todo.length,blocked:todo.filter(t=>t.status==='blocked').length,open:todo.filter(t=>!['done','blocked'].includes(t.status)).length,still:steps-(mem.todoStep??steps)}:null,
  reflection:r?{step:r.step??0,confidence:r.confidence??null,assumptions:(r.assumptions||[]).length,questions:(r.open_questions||[]).length,age:steps-(r.step??steps)}:null,
  model:profile?.model||session.route?.model||null,escalated:session.role==='escalation',
  cost:st.cost||0,team:team.map(s=>`"${oneLine(s.title,40)}" ${s.status}`)
 };
}
/** Why a self-check is due now, or [] when it is not. Each trigger fires once per occasion. */
export function selfCheckDue(session,mem,f,{every=SELF_CHECK.every}={}){
 const last=mem.selfCheckStep??0,gap=f.steps-last,why=[];
 if(f.context&&f.context.share>=SELF_CHECK.context&&!mem.selfCheckContext){mem.selfCheckContext=true;why.push('context');}
 if(gap<SELF_CHECK.minGap&&!why.length)return [];
 if(f.recentCalls>=SELF_CHECK.errorWindow&&f.recentErrors>=SELF_CHECK.errors&&mem.selfCheckErrors!==f.calls)why.push('errors');
 if(f.todo?.open&&f.todo.still>=SELF_CHECK.stalled&&mem.selfCheckStalled!==mem.todoStep)why.push('stalled');
 if(session.kind!=='main'&&!f.reflection&&f.calls>=SELF_CHECK.unreflected&&!mem.selfCheckAskedReflect)why.push('unreflected');
 if(f.reflection&&f.reflection.confidence!==null&&f.reflection.confidence<SELF_CHECK.lowConfidence&&f.reflection.age>=SELF_CHECK.minGap&&mem.selfCheckLowAt!==f.reflection.step)why.push('low-confidence');
 if(session.kind!=='main'&&every&&gap>=every)why.push('interval');
 return why;
}
/** Records that a self-check was sent, so the same occasion does not trigger again. */
export function noteSelfCheck(mem,f,why){
 mem.selfCheckStep=f.steps;
 if(why.includes('errors'))mem.selfCheckErrors=f.calls;
 if(why.includes('stalled'))mem.selfCheckStalled=mem.todoStep;
 if(why.includes('unreflected'))mem.selfCheckAskedReflect=true;
 if(why.includes('low-confidence'))mem.selfCheckLowAt=f.reflection.step;
}
const pct=x=>`${Math.round(x*100)}%`;
/** The self-check message: measured facts first, then one question per trigger. */
export function renderSelfCheck(f,why,{kind='worker'}={}){
 const lines=[`- Run: ${f.steps} steps, ${f.minutes} min${f.model?`, model ${f.model}${f.escalated?' (stronger model, after stalling)':''}`:''}${f.cost?`, cost so far $${f.cost.toFixed(4)}`:''}.`];
 if(f.context)lines.push(`- Context: ${pct(f.context.share)} of the working budget (${f.context.used.toLocaleString()} of ${f.context.budget.toLocaleString()} tokens). Old tool results are cleared at ${pct(COMPACTION.softClear)}; the conversation is compacted at ${pct(COMPACTION.hard)}.`);
 lines.push(`- Tools: ${f.calls} calls, ${f.errors} failed${f.recentCalls?` (${f.recentErrors} of the last ${f.recentCalls})`:''}${f.variety<0.5&&f.recentCalls>=6?'; many calls repeat earlier ones':''}.`);
 if(f.todo)lines.push(`- Checklist: ${f.todo.done}/${f.todo.total} done${f.todo.blocked?`, ${f.todo.blocked} blocked`:''}${f.todo.open&&f.todo.still>=5?`; unchanged for ${f.todo.still} steps`:''}.`);
 if(f.reflection)lines.push(`- Your reflect notes: confidence ${f.reflection.confidence??'not given'}, ${f.reflection.assumptions} unverified assumption${f.reflection.assumptions===1?'':'s'}, ${f.reflection.questions} open question${f.reflection.questions===1?'':'s'}; updated ${f.reflection.age} steps ago.`);
 else lines.push('- Your reflect notes: none yet.');
 if(f.team.length)lines.push(`- Work agents running: ${f.team.join(', ')}.`);
 const ask={
  context:'Context is filling up. Make sure the checklist and your reflect notes hold everything you would need after compaction (goal, verified results, open points).',
  errors:'Several recent calls failed. Is your picture of the environment wrong (path, version, permissions, API)? Check the assumption behind the failing calls before trying again.',
  stalled:'The checklist has not moved for a while. Are you making real progress or circling? If the current approach is not working, change it, or report what blocks you.',
  unreflected:'You have done substantial work without stating your understanding. Write reflect notes: the task as you understand it, your plan, what is verified, what is only assumed, and your confidence.',
  'low-confidence':'Your confidence is low. Find the cheapest check that would raise or lower it (read, run, open, search), or ask your requester if the decision is theirs.',
  interval:'Step back for a moment: does the work still serve the goal, and is the remaining plan the shortest path to it?'
 };
 return `[harness] Self-check (measured by the harness, not a message from the user):\n${lines.join('\n')}\n\n${why.map(w=>ask[w]).filter(Boolean).join(' ')}\n${kind==='main'?'Do not mention this check to the user; carry on with the conversation.':'Update reflect if your understanding, plan or confidence changed, then go on. There is nothing to answer here: text without tool calls ends the task, so write text only when it is your final report.'}`;
}
/** The reflect notes as the model and the ledger see them. */
export function renderReflection(r){
 if(!r)return '';
 const list=(t,a)=>a?.length?`${t}:\n${a.map(x=>'- '+x).join('\n')}`:'';
 return [r.understanding?`Understanding: ${r.understanding}`:'',r.plan?`Plan: ${r.plan}`:'',list('Verified',r.verified),list('Assumed, not yet verified',r.assumptions),list('Open questions',r.open_questions),
  r.confidence!==undefined&&r.confidence!==null?`Confidence: ${r.confidence}`:'',r.next?`Next: ${r.next}`:''].filter(Boolean).join('\n');
}
const listField={type:'array',maxItems:20,items:{type:'string'}};
/** The model's own statement of its state. Fields given replace the stored ones; others are kept. */
export function reflectTool(sessions){
 return {
  name:'reflect',group:'core',ephemeral:true,ephemeralKey:()=>'reflect',
  description:'Keep an honest picture of your own state: how you understand the task, your plan, what you have verified (with how), what you only assume, open questions, your confidence (0–1) and the next step. Fields you send replace the stored ones; others stay. Update it when the plan changes, after a surprise or failure, when a self-check asks, and before reporting. It survives compaction word for word.',
  parameters:{type:'object',additionalProperties:false,properties:{understanding:{type:'string'},plan:{type:'string'},verified:listField,assumptions:listField,open_questions:listField,confidence:{type:'number',minimum:0,maximum:1},next:{type:'string'}}},
  summarize:a=>`reflect${a.confidence!==undefined?' '+a.confidence:''}`,
  async run(a,ctx){
   const s=sessions.get(ctx.session.id),prev=s.reflection||{},clean=v=>Array.isArray(v)?v.map(x=>oneLine(x,300)).filter(Boolean):typeof v==='string'?oneLine(v,600):v;
   const next={...prev};for(const [k,v] of Object.entries(a))if(v!==undefined)next[k]=clean(v);
   next.step=s.stats?.steps||0;next.at=new Date().toISOString();
   sessions.update(s.id,{reflection:next});
   return {text:`Reflect notes updated.\n${renderReflection(next)}`,data:{reflection:next}};
  }
 };
}

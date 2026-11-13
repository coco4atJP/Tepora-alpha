import {nativeCompute} from '../native-state.mjs';
import {oneLine,fitTokens} from '../tools/format.mjs';
import {transcriptText} from './compaction.mjs';

/** The character's long-term memory of the conversation, in two kinds of record (both hosts share the Rust
 * harness.memory.* operations, so Node and the native service label, render and consolidate identically):
 *  - Episodes: every transcript entry of the main session belongs to one episode (a topic). Labels are written
 *    after the fact, at the idle handoff, by the model in the cached context. An episode can pause and resume, so
 *    its ranges need not be contiguous; at most MAX_OPEN (7) stay open and are listed in the handoff. A card holds
 *    title, period, state, summary, entities, ranges #a-#b and the work agents started for it, and is searchable
 *    (full text, plus meaning when a local embedding model is connected). Finished work agents are archived under
 *    their episode, so the session list the runtime enumerates stays small.
 *  - Core memory: facts about the user and how to engage with them, rewritten only by Dreaming from the episodes
 *    and the saved memories, within caps derived from the context window. With the skill index it forms the
 *    <memory> block of the context, which changes only at a handoff. */
const STATE='episodes',CORE='memory-core';
export const memoryOp=(op,payload)=>nativeCompute('harness.memory.'+op,payload);
const byLast=(a,b)=>String(a.last||'').localeCompare(String(b.last||''))||Number(a.id.slice(1))-Number(b.id.slice(1));
/** The user's calendar day of a stored (UTC) time: a date search means the day as the user lived it. */
const localDay=at=>{const d=new Date(at||NaN);return Number.isNaN(d.getTime())?'':`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const LABEL_TYPES=['input','assistant','tool','notice'];
export class Episodes{
 constructor(rt){this.rt=rt;this.store=rt.store;this.sessions=rt.sessions;}
 state(){return {next:1,revision:0,labeled:{},...this.store.value(STATE)};}
 core(){return this.store.value(CORE)||null;}
 cards(sessionId){return this.store.list('episode').filter(c=>!sessionId||c.sessionId===sessionId);}
 /** Open and recently paused episodes: what the labeler may continue. */
 known(sessionId){const all=this.cards(sessionId).filter(c=>c.state!=='done').sort(byLast);return [...all.filter(c=>c.state==='open'),...all.filter(c=>c.state==='paused').slice(-8)];}
 /** The <memory> block: the skill index and Dreaming's core memory, read when the prompt is (re)built, i.e. at a
  * handoff. No clock, fixed order. */
 layers(){const core=this.core();return memoryOp('layers',{skills:this.rt.skillIndex(),core:core||{},contextTokens:core?.contextTokens||32000});}
 topics(sessionId){return memoryOp('topics',{cards:this.cards(sessionId)});}
 /** A card as the model reads it; the period in the user's calendar days, the ones a date search takes. */
 card(c){return memoryOp('card',{card:{...c,first:localDay(c.first)||c.first,last:localDay(c.last)||c.last}});}
 /** Entries not labeled yet, with a transcript of the part already out of view (before the latest handoff). */
 unlabeled(session,built){
  const from=(this.state().labeled[session.id]||0)+1,entries=this.sessions.entries(session.id,{from}).filter(e=>LABEL_TYPES.includes(e.type));
  const upTo=built.view.checkpoint?.upTo||0,hidden=entries.filter(e=>e.seq<=upTo);
  return {from,entries,transcript:hidden.length?fitTokens(transcriptText(hidden,built.view.clearUpTo),4000,'#'+hidden[0].seq).text:''};
 }
 /** Label the unlabeled stretch in context (same prefix as the next call, so it is read from cache). */
 async label(session,{built,chain,toolDefs,signal}){
  const {from,entries,transcript}=this.unlabeled(session,built);if(!entries.length)return null;
  const to=entries.at(-1).seq,known=this.known(session.id);let text='';
  try{
   const content=memoryOp('labelRequest',{cards:known,from,to,transcript});
   const answer=await this.rt.registry.invoke(chain,[...built.messages,{role:'user',content}],{accountingSessionId:session.id,accountingPurpose:'summary',tools:toolDefs,toolChoice:'none',maxTokens:1500,signal,cacheKey:session.id,slotKey:session.id,cacheRetention:this.rt.cacheRetention(session),priority:5});
   if((answer.finish==null||answer.finish==='stop')&&typeof answer.content==='string')text=answer.content;
  }catch(e){if(e.kind==='accounting'||signal?.aborted)throw e;}
  signal?.throwIfAborted();
  return this.apply(session.id,{text,entries,known});
 }
 apply(sessionId,{text,entries,known=this.known(sessionId)}){
  const st=this.state(),revision=st.revision+1,to=entries.at(-1).seq;
  const seqs=entries.map(e=>({seq:e.seq,at:e.at,...(e.type==='tool'&&e.name==='sessions_spawn'&&e.data?.sessionId?{spawned:e.data.sessionId}:{})}));
  const r=memoryOp('applyLabels',{text,cards:known,seqs,nextId:st.next,revision,sessionId,fallbackTitle:oneLine(entries.find(e=>e.type==='input')?.text||'',60)});
  for(const c of r.cards)this.store.put('episode',c);
  this.store.db.call('session.label',{id:sessionId,labels:r.labels});
  this.store.value(STATE,{...st,next:r.nextId,revision,labeled:{...st.labeled,[sessionId]:to}});
  this.archive(sessionId);
  this.store.emit('agent.episodes',{sessionId,cards:r.cards.map(c=>c.id),fallback:r.fallback});
  return r;
 }
 /** Finished work agents (with everything they started) move under their episode, out of the live session list. */
 archive(sessionId){
  const live=this.sessions.list(),cards=this.cards(sessionId),owner=new Map();
  for(const c of cards)for(const id of c.children||[])owner.set(id,c.id);
  const settled=s=>['done','stopped'].includes(s.status)&&!this.rt.runs.has(s.id)&&!this.sessions.pending(s.id).length;
  const subtree=id=>{const out=[id];for(let i=0;i<out.length;i++)for(const s of live)if(s.parentId===out[i])out.push(s.id);return out;};
  let n=0;
  for(const s of live){
   const episode=owner.get(s.id);if(!episode||s.parentId!==sessionId)continue;
   const tree=subtree(s.id).map(id=>live.find(x=>x.id===id));
   if(!tree.every(settled))continue;
   for(const x of tree){this.sessions.archive(x.id,episode);this.rt.loop.forget(x.id);n++;}
  }
  return n;
 }
 /** Card search: full text and, with a local embedding model, meaning (reciprocal-rank fused); or one day's list. */
 async search(sessionId,{query='',date='',limit=5,signal}={}){
  const all=this.cards(sessionId).sort(byLast),day=String(date||'').trim();
  let pool=day?all.filter(c=>{const first=localDay(c.first);return first&&first<=day&&day<=localDay(c.last||c.first);}):all;
  const q=String(query||'').trim();
  if(!q)return day?pool.slice(0,30):pool.slice(-limit).reverse();
  const allowed=new Set(pool.map(c=>c.id));
  const lexical=this.store.search('episode',q,{limit:24,filter:c=>allowed.has(c.id)&&(!sessionId||c.sessionId===sessionId)});
  const scores=new Map(),add=(list)=>list.forEach((c,i)=>scores.set(c.id,(scores.get(c.id)||0)+1/(60+i)));
  add(lexical);
  const candidates=[...new Map([...lexical,...pool.slice(-24).reverse()].map(c=>[c.id,c])).values()].slice(0,24);
  const profile=this.localEmbedding();
  if(profile&&candidates.length){
   try{const ranked=await this.rt.semantic.rank(q,candidates.map(c=>this.card(c).slice(0,4000)),{signal,profile});add(ranked.filter(r=>r.similarity>0).map(r=>candidates[r.index]));}
   catch{signal?.throwIfAborted();}
  }
  const byId=new Map(pool.map(c=>[c.id,c]));
  return [...scores].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([id])=>byId.get(id)).filter(Boolean);
 }
 /** Conversation text goes only to an embedding model on this computer. */
 localEmbedding(){
  if(!this.rt.semantic||!this.rt.capabilities?.get().routes?.embedding)return null;
  try{const p=this.rt.capabilities.pin('embedding');return p?.domain==='device'?p:null;}catch{return null;}
 }
 /** Dreaming is due when episodes changed since the last consolidation. */
 dreamDue(){return this.state().revision>(this.core()?.revision||0)&&Date.now()-(this.failedAt||0)>30*60000;}
 /** Consolidate: facts from the changed episodes are added to, merged into or corrected in the saved memories
  * (the user's own entries are never touched; the cards stay), then core memory is rewritten within its caps. */
 async dream({B,signal}){
  const st=this.state(),core=this.core()||{},since=core.revision||0;
  const cards=this.cards().filter(c=>(c.revision||0)>since).sort(byLast).slice(-12);
  const memories=this.store.list('memory').filter(m=>m.confirmed).sort((a,b)=>String(a.updatedAt||a.createdAt||'').localeCompare(String(b.updatedAt||b.createdAt||''))).slice(-80);
  const request=memoryOp('dreamRequest',{cards,memories,core,contextTokens:B});
  let answer;
  try{answer=await this.rt.registry.invoke('compaction',[{role:'system',content:request.system},{role:'user',content:request.prompt}],{accountingPurpose:'summary',maxTokens:3000,signal,priority:0});}
  catch(e){if(e.kind==='accounting'||signal?.aborted)throw e;this.failedAt=Date.now();return null;}
  signal?.throwIfAborted();
  if(!(answer.finish==null||answer.finish==='stop')||typeof answer.content!=='string'){this.failedAt=Date.now();return null;}
  const r=memoryOp('dreamApply',{text:answer.content,memories,core,contextTokens:B});
  for(const content of r.add)this.store.memory(content,{source:'dream',confirmed:true});
  for(const u of r.update)this.store.domain('store.memoryPatch',{id:u.id,patch:{content:u.content}});
  for(const id of r.remove)this.store.domain('store.memoryDelete',{id});
  const next={facts:r.core.facts,engagement:r.core.engagement,revision:st.revision,contextTokens:B,dreamedAt:new Date().toISOString()};
  this.store.value(CORE,next);
  if(r.add.length+r.update.length&&this.rt.semantic&&this.rt.capabilities?.get().routes?.embedding)this.rt.semantic.index().catch(()=>{});
  this.store.emit('agent.memory',{added:r.add.length,updated:r.update.length,removed:r.remove.length,episodes:cards.map(c=>c.id)});
  return {...r,core:next};
 }
}

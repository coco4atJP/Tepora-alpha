import {createHash} from 'node:crypto';
import {invariant,text} from './policy.mjs';
import {searchTokens} from './search.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function cosine(a,b){
 invariant(a.length===b.length&&a.length>0,'Incompatible embedding spaces');let dot=0,aa=0,bb=0;
 for(let i=0;i<a.length;i++){invariant(Number.isFinite(a[i])&&Number.isFinite(b[i]),'Invalid vector');dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
 invariant(aa>0&&bb>0,'Zero embedding');return dot/Math.sqrt(aa*bb);
}
/** Opt-in local semantic memory. Originals and consent remain authoritative, never the vector cache. */
export class SemanticMemory{
 constructor(store,capabilities){Object.assign(this,{store,capabilities});this.busy=false;}
 allowed({recipientPrivate=true,share=false}={}){return this.store.list('memory').filter(m=>m.confirmed&&(recipientPrivate||share&&m.scope==='shared'));}
 async index({signal,allowExternal=false,recipientPrivate=true,share=false}={}){
  invariant(!this.busy,'意味検索の索引を更新中です。',429);const p=this.capabilities.pin('embedding');
  invariant(p.domain==='device'||allowExternal===true,'埋め込み先へ記憶を送る許可が必要です。',403);
  let docs=this.allowed({recipientPrivate,share});if(p.domain!=='device')docs=docs.filter(m=>m.scope==='shared');
  const pending=docs.filter(d=>{const e=this.store.get('memory-vector',d.id);return !e||e.identity!==p.identity||e.contentHash!==hash(d.content);});
  const batch=pending.slice(0,24);if(!batch.length)return {indexed:docs.length,remaining:0};
  this.busy=true;
  try{
   const result=await this.capabilities.embed(batch.map(d=>d.content.slice(0,12000)),{signal,profile:p});
   let added=0;
   for(let i=0;i<batch.length;i++){
    const before=batch[i],now=this.store.get('memory',before.id);
    if(!now?.confirmed||now.content!==before.content||now.scope!==before.scope)continue;
    this.store.put('memory-vector',{id:now.id,identity:p.identity,contentHash:hash(now.content),vector:result.vectors[i],dimensions:result.dimensions});added++;
   }
   return {added,indexed:docs.filter(d=>this.store.get('memory-vector',d.id)?.identity===p.identity).length,remaining:Math.max(0,pending.length-added),truncatedDocuments:batch.filter(d=>d.content.length>12000).length};
  }finally{this.busy=false;}
 }
 async search(query,{signal,recipientPrivate=true,share=false,allowExternal=false,limit=8}={}){
  text(query,'query',4000);invariant(Number.isInteger(limit)&&limit>=1&&limit<=30,'Invalid search limit');
  let docs=this.allowed({recipientPrivate,share}),terms=searchTokens(query,40);
  const lexical=docs.map(d=>({d,score:terms.filter(t=>d.content.normalize('NFKC').toLowerCase().includes(t)).length})).filter(x=>x.score).sort((a,b)=>b.score-a.score);
  let p;try{p=this.capabilities.pin('embedding');}catch{}
  let semantic=[],note='キーワード検索',indexed=0;
  if(p&&(p.domain==='device'||allowExternal)){
   try{
    const r=await this.capabilities.embed([query],{signal,profile:p});
    semantic=docs.filter(d=>p.domain==='device'||d.scope==='shared').map(d=>{
     const e=this.store.get('memory-vector',d.id);if(e?.identity!==p.identity||e.contentHash!==hash(d.content)||e.dimensions!==r.dimensions)return null;
     return {d,score:cosine(r.vectors[0],e.vector)};
    }).filter(Boolean).sort((a,b)=>b.score-a.score);indexed=semantic.length;note='意味＋キーワード検索';
   }catch(e){signal?.throwIfAborted();note='意味検索の接続が使えないため、キーワード検索で続けています。';}
  }
  // RRF, not a claim that similarity is calibrated truth or a memory's authority.
  const scores=new Map();for(const ranking of [lexical,semantic.filter(x=>x.score>0)])ranking.slice(0,60).forEach(({d},i)=>scores.set(d.id,(scores.get(d.id)||0)+1/(60+i)));
  const hits=[...scores].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([id])=>docs.find(d=>d.id===id)).filter(d=>{const current=this.store.get('memory',d.id);return current?.confirmed&&current.content===d.content&&(recipientPrivate||share&&current.scope==='shared');});
  return {hits,note,indexed,total:docs.length,coverageComplete:indexed===docs.length,automaticLearning:false};
 }
 async rank(query,candidates,{signal,profile=this.capabilities.pin('embedding')}={}){
  text(query,'query',4000);invariant(Array.isArray(candidates)&&candidates.length>0&&candidates.length<=24&&candidates.every(c=>typeof c==='string'&&c.length>0&&c.length<=4000),'Rank 1–24 short candidates');
  const {vectors}=await this.capabilities.embed([query,...candidates],{signal,profile});
  return candidates.map((_,index)=>({index,similarity:cosine(vectors[0],vectors[index+1])})).sort((a,b)=>b.similarity-a.similarity);
 }
}

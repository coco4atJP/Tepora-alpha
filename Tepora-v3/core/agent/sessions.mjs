import {randomUUID} from 'node:crypto';
import {invariant} from '../policy.mjs';
import {searchTokens,matchExpression} from '../search.mjs';

const now=()=>new Date().toISOString();
export const SESSION_KINDS=['main','worker','specialist'];
export const SESSION_STATUSES=['idle','running','waiting','done','stopped'];
/** Log entry types. Entries are append-only; `clear` and `checkpoint` change how earlier ones render. */
export const ENTRY_TYPES=['input','assistant','tool','notice','checkpoint','clear','event'];

/** A session as listeners see it: without the cached system prompt and tool list, which change rarely and are large.
 * Updates are broadcast, not stored as events: a reconnecting screen gets a fresh snapshot anyway. */
export const publicSession=({system,tools,...rest})=>rest;
/** Sessions are documents; their transcripts are an append-only table, never rewritten. */
export class SessionStore{
 constructor(store){
  this.store=store;this.db=store.db;
 }
 create(fields){
  invariant(SESSION_KINDS.includes(fields.kind),'Unknown session kind');
  const s={id:fields.id||randomUUID(),kind:fields.kind,title:String(fields.title||'').slice(0,120),parentId:fields.parentId||null,
   rootId:fields.rootId||fields.parentId||null,depth:fields.depth||0,status:'idle',role:fields.role||(fields.kind==='main'?'chat':'work'),
   toolset:fields.toolset||(fields.kind==='main'?'main':'worker'),persona:fields.persona||null,cwd:fields.cwd||null,
   task:fields.task||null,label:fields.label||null,result:null,note:'',stats:{steps:0,input:0,output:0,cacheRead:0,cacheWrite:0,compactions:0,clears:0},
   createdAt:now(),updatedAt:now(),...fields.extra};
  this.store.put('session',s);this.store.broadcast('session.updated',publicSession(s));return s;
 }
 get(id){return this.store.get('session',id);}
 list({kind,parentId,status}={}){return this.store.list('session').filter(s=>(!kind||s.kind===kind)&&(parentId===undefined||s.parentId===parentId)&&(!status||s.status===status));}
 update(id,patch){
  const s=this.get(id);invariant(s,'Session not found',404);
  const next={...s,...patch,updatedAt:now()};this.store.put('session',next);this.store.broadcast('session.updated',publicSession(next));return next;
 }
 seq(id){return this.db.call('session.seq',{id});}
 append(id,type,body){
  invariant(ENTRY_TYPES.includes(type),'Unknown log entry type');
  const at=now(),saved=this.db.call('session.append',{id,type,body,at,terms:indexable(type,body)});
  const entry={seq:saved.seq,type,at,...body};
  this.store.broadcast('session.entry',{sessionId:id,entry});
  return entry;
 }
 entries(id,{from=1,to=Number.MAX_SAFE_INTEGER,types}={}){return this.db.call('session.entries',{id,from,to,types});}
 /** Annotate UI flags without rewriting other transcript fields. */
 patch(id,seq,fields){
  const entry=this.db.call('session.patch',{id,seq,fields,removeKeys:Object.keys(fields).filter(k=>fields[k]===undefined)});
  return entry?{...entry,...fields}:null;
 }
 entry(id,seq){return this.db.call('session.entry',{id,seq});}
 latest(id,type){return this.db.call('session.latest',{id,type});}
 tail(id,limit=50){return this.db.call('session.tail',{id,limit});}
 putEvidence(id,sessionId,seq,tool,content){return this.db.call('evidence.put',{id,sessionId,seq,tool,content,at:now()});}
 evidence(id){return this.db.call('evidence.get',{id});}
 search(query,{sessionIds,limit=10}={}){
  const expression=matchExpression(query);if(!expression)return [];
  return this.db.call('session.search',{expression,sessionIds,limit});
 }
 /** Pending input waits here until the session reaches a step boundary. */
 enqueue(id,input){
  const item={id:randomUUID(),...input,at:input.at||now()};
  this.db.call('inbox.enqueue',{sessionId:id,item});
  this.store.broadcast('session.inbox',{sessionId:id,count:this.pending(id).length,item});return item;
 }
 pending(id){return this.db.call('inbox.pending',{id});}
 take(id){return this.db.call('inbox.take',{id});}
 /** Consume one answer only, leaving other pending messages in their original order. */
 takeItem(id,itemId){return this.db.call('inbox.takeItem',{id,itemId});}
 inboxSessions(){return this.db.call('inbox.sessions');}
 remove(id){this.db.call('session.remove',{id});}
}
function indexable(type,body){
 if(type==='input'||type==='notice')return terms(body.text);
 if(type==='assistant')return terms([body.content,...(body.toolCalls||[]).map(c=>c.name+' '+c.arguments)].join('\n'));
 if(type==='tool')return terms(body.name+' '+(body.stub||'')+'\n'+String(body.content||'').slice(0,20000));
 if(type==='checkpoint')return terms(body.summary);
 return '';
}
const terms=value=>searchTokens(String(value||'').slice(0,40000)).join(' ');

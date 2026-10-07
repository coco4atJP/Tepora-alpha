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
  this.db.exec(`CREATE TABLE IF NOT EXISTS session_log(session_id TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(session_id,seq));
   CREATE TABLE IF NOT EXISTS evidence_store(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,seq INTEGER NOT NULL,tool TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS evidence_by_session ON evidence_store(session_id,seq);
   CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(session_id UNINDEXED,seq UNINDEXED,terms,tokenize='unicode61');
   CREATE TABLE IF NOT EXISTS session_inbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS inbox_by_session ON session_inbox(session_id,at);`);
  this.next=new Map();
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
 seq(id){
  if(!this.next.has(id))this.next.set(id,(this.db.prepare('SELECT MAX(seq) AS m FROM session_log WHERE session_id=?').get(id)?.m??0)+1);
  return this.next.get(id);
 }
 append(id,type,body){
  invariant(ENTRY_TYPES.includes(type),'Unknown log entry type');
  const seq=this.seq(id),at=now();
  this.db.prepare('INSERT INTO session_log(session_id,seq,type,body,at) VALUES(?,?,?,?,?)').run(id,seq,type,JSON.stringify(body),at);
  this.next.set(id,seq+1);
  const terms=indexable(type,body);
  if(terms)this.db.prepare('INSERT INTO session_search(session_id,seq,terms) VALUES(?,?,?)').run(id,seq,terms);
  const entry={seq,type,at,...body};
  this.store.broadcast('session.entry',{sessionId:id,entry});
  return entry;
 }
 entries(id,{from=1,to=Number.MAX_SAFE_INTEGER,types}={}){
  const rows=this.db.prepare('SELECT seq,type,body,at FROM session_log WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq').all(id,from,to);
  const out=[];for(const r of rows){if(types&&!types.includes(r.type))continue;out.push({seq:r.seq,type:r.type,at:r.at,...JSON.parse(r.body)});}
  return out;
 }
 entry(id,seq){const r=this.db.prepare('SELECT seq,type,body,at FROM session_log WHERE session_id=? AND seq=?').get(id,seq);return r?{seq:r.seq,type:r.type,at:r.at,...JSON.parse(r.body)}:null;}
 /** The newest entry of one type, e.g. the latest checkpoint. */
 latest(id,type){const r=this.db.prepare('SELECT seq,type,body,at FROM session_log WHERE session_id=? AND type=? ORDER BY seq DESC LIMIT 1').get(id,type);return r?{seq:r.seq,type:r.type,at:r.at,...JSON.parse(r.body)}:null;}
 tail(id,limit=50){return this.db.prepare('SELECT seq,type,body,at FROM session_log WHERE session_id=? ORDER BY seq DESC LIMIT ?').all(id,limit).reverse().map(r=>({seq:r.seq,type:r.type,at:r.at,...JSON.parse(r.body)}));}
 putEvidence(id,sessionId,seq,tool,content){
  this.db.prepare('INSERT OR REPLACE INTO evidence_store(id,session_id,seq,tool,body,at) VALUES(?,?,?,?,?,?)').run(id,sessionId,seq,tool,content,now());return id;
 }
 evidence(id){const r=this.db.prepare('SELECT id,session_id,seq,tool,body,at FROM evidence_store WHERE id=?').get(id);return r?{id:r.id,sessionId:r.session_id,seq:r.seq,tool:r.tool,content:r.body,at:r.at}:null;}
 search(query,{sessionIds,limit=10}={}){
  const expression=matchExpression(query);if(!expression)return [];
  const rows=this.db.prepare('SELECT session_id,seq FROM session_search WHERE session_search MATCH ? ORDER BY bm25(session_search) LIMIT 400').all(expression);
  const out=[];
  for(const r of rows){if(sessionIds&&!sessionIds.includes(r.session_id))continue;const e=this.entry(r.session_id,r.seq);if(e)out.push({sessionId:r.session_id,...e});if(out.length>=limit)break;}
  return out;
 }
 /** Pending input waits here until the session reaches a step boundary. */
 enqueue(id,input){const item={id:randomUUID(),...input,at:input.at||now()};this.db.prepare('INSERT INTO session_inbox(id,session_id,body,at) VALUES(?,?,?,?)').run(item.id,id,JSON.stringify(item),item.at);this.store.broadcast('session.inbox',{sessionId:id,count:this.pending(id).length,item});return item;}
 pending(id){return this.db.prepare('SELECT body FROM session_inbox WHERE session_id=? ORDER BY at,rowid').all(id).map(r=>JSON.parse(r.body));}
 take(id){const items=this.pending(id);if(items.length)this.db.prepare('DELETE FROM session_inbox WHERE session_id=?').run(id);return items;}
 /** Removes one pending item (an answer consumed by a waiting tool call), so it is not delivered twice. */
 takeItem(id,itemId){return this.db.prepare('DELETE FROM session_inbox WHERE session_id=? AND id=?').run(id,itemId).changes>0;}
 inboxSessions(){return this.db.prepare('SELECT DISTINCT session_id AS id FROM session_inbox').all().map(r=>r.id);}
 remove(id){
  this.db.prepare('DELETE FROM session_inbox WHERE session_id=?').run(id);
  this.db.prepare('DELETE FROM session_log WHERE session_id=?').run(id);this.db.prepare('DELETE FROM evidence_store WHERE session_id=?').run(id);
  this.db.prepare('DELETE FROM session_search WHERE session_id=?').run(id);this.store.remove('session',id);this.next.delete(id);
 }
}
function indexable(type,body){
 if(type==='input'||type==='notice')return terms(body.text);
 if(type==='assistant')return terms([body.content,...(body.toolCalls||[]).map(c=>c.name+' '+c.arguments)].join('\n'));
 if(type==='tool')return terms(body.name+' '+(body.stub||'')+'\n'+String(body.content||'').slice(0,20000));
 if(type==='checkpoint')return terms(body.summary);
 return '';
}
const terms=value=>searchTokens(String(value||'').slice(0,40000)).join(' ');

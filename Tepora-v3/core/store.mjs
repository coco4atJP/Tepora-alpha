import {indexedText,matchExpression} from './search.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS, invariant, text, LIMITS } from './policy.mjs';

const EXPORT_KINDS = ['memory','artifact','revision','skill','job','message','checkpoint','effect','asset','note','evidence','routine','plan'];
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
};

/** Owns only Tepora's database. Shared skills and external runtimes are never deleted. */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.owner = randomUUID();
    this.listeners = new Set();
    this.closed = false;
    mkdirSync(dir, {recursive:true});
    this.db = new DatabaseSync(path.join(dir, 'tepora-v3.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE VIRTUAL TABLE IF NOT EXISTS content_search USING fts5(kind UNINDEXED, id UNINDEXED, terms, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);`);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const lease = this.value('service-owner');
      invariant(!lease || !alive(lease.pid), 'Tepora is already using this data directory.', 409);
      this.value('service-owner', {id:this.owner, pid:process.pid});
      if(!this.value('search-schema-v1')){
        for(const kind of ['memory','job'])for(const doc of this.list(kind))this.index(kind,doc);
        this.value('search-schema-v1',true);
      }
      for (const job of this.list('job')) {
        if(!Object.hasOwn(job,'revision')&&job.kind!=='demo'&&job.step>0&&!this.get('checkpoint',job.id))
          this.put('job',Object.assign(job,{resumeBlocked:true,note:'以前の版の実行記録を確認できないため、自動再開しません。'}));
        // A parked job holds only stacked approvals (nothing in flight), so it survives a restart.
        if (['running','queued','waiting_approval'].includes(job.status)&&!(job.status==='waiting_approval'&&job.parked)) {
          this.put('job', {...job, status:'interrupted', approval:null,
            note:'前回の仕事を保存しています。結果不明の操作を確認してから再開できます。'});
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.db.close();
      throw e;
    }
  }
  value(key, value) {
    if (arguments.length > 1) {
      this.db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES (?,?)').run(key, JSON.stringify(value));
      return value;
    }
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  get settings() { return {...DEFAULT_SETTINGS, ...(this.value('settings') || {})}; }
  set settings(value) { this.value('settings',value); }

  /** Pagination is optional; display limits must never truncate exports or retrieval. */
  list(kind, {limit,offset=0}={}) {
    invariant(Number.isSafeInteger(offset) && offset >= 0, 'Invalid offset');
    invariant(limit === undefined || Number.isSafeInteger(limit) && limit > 0, 'Invalid limit');
    const suffix = limit === undefined ? '' : ' LIMIT ? OFFSET ?';
    return this.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC'+suffix)
      .all(...(limit === undefined ? [kind] : [kind,limit,offset])).map(r=>JSON.parse(r.body));
  }
  get(kind,id) {
    const row=this.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind,id);
    return row ? JSON.parse(row.body) : null;
  }
  index(kind,doc){
    this.db.prepare('DELETE FROM content_search WHERE kind=? AND id=?').run(kind,doc.id);
    this.db.prepare('INSERT INTO content_search(kind,id,terms) VALUES(?,?,?)').run(kind,doc.id,indexedText(doc));
  }
  put(kind,doc) {
    invariant(typeof doc.id==='string' && doc.id.length>0 && doc.id.length<=300,'Document id required');
    this.db.prepare(`INSERT INTO documents(kind,id,body) VALUES (?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body`).run(kind,doc.id,JSON.stringify(doc));
    if(['memory','job'].includes(kind))this.index(kind,doc);
    return doc;
  }
  remove(kind,id) {
    if(['memory','job'].includes(kind))this.db.prepare('DELETE FROM content_search WHERE kind=? AND id=?').run(kind,id);
    const result=this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id);
    if(kind==='memory') {
      this.db.prepare("DELETE FROM documents WHERE kind='memory-vector' AND id=?").run(id);
      // Logical deletion of memory events, including legacy events that contained full text.
      this.db.prepare("DELETE FROM events WHERE type LIKE 'memory.%' AND json_extract(body,'$.id')=?").run(id);
    }
    return result;
  }
  emit(type,data) {
    const at=new Date().toISOString();
    const durable=type.startsWith('memory.') ? {id:data.id} : data;
    const result=this.db.prepare('INSERT INTO events(type,body,at) VALUES(?,?,?)')
      .run(type,JSON.stringify(durable),at);
    const event={seq:Number(result.lastInsertRowid),type,data,at};
    if(event.seq%100===0) this.db.prepare('DELETE FROM events WHERE seq < ?').run(event.seq-LIMITS.events);
    for(const fn of this.listeners) { try {fn(event);} catch {this.listeners.delete(fn);} }
    return event;
  }
  broadcast(type,data) {
    for(const fn of this.listeners) {
      try {fn({seq:null,type,data,at:new Date().toISOString()});} catch {this.listeners.delete(fn);}
    }
  }
  events(since=0) {
    return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 5000').all(since)
      .map(r=>{
        let data=JSON.parse(r.body),type=r.type;
        if(type==='memory.updated') {
          data=this.get('memory',data.id);
          if(!data) {type='memory.deleted';data={id:JSON.parse(r.body).id};}
        }
        return {seq:r.seq,type,data,at:r.at};
      });
  }
  get seq() {
    return Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq||0);
  }
  memory(content,{source='user',confirmed=true,scope='private',title=''}={}) {
    const doc={id:randomUUID(),content:text(content,'memory',32000),title:title.slice(0,160),
      source,confirmed,scope:scope==='shared'?'shared':'private',createdAt:new Date().toISOString()};
    this.put('memory',doc);this.emit('memory.updated',doc);return doc;
  }
  search(kind,query,{limit=20,filter=()=>true}={}) {
    invariant(['memory','job'].includes(kind),'Unknown search collection');
    const expression=matchExpression(query);if(!expression)return [];
    const rows=this.db.prepare(`SELECT d.body FROM content_search f JOIN documents d ON d.kind=f.kind AND d.id=f.id
      WHERE content_search MATCH ? AND f.kind=? ORDER BY bm25(content_search)`).iterate(expression,kind);
    const result=[];
    for(const row of rows){const doc=JSON.parse(row.body);if(filter(doc))result.push(doc);if(result.length>=limit)break;}
    return result;
  }
  recall(query,{cloud=false,share=false,limit=6}={}) {
    return this.search('memory',query,{limit,filter:m=>m.confirmed&&(!cloud||(share&&m.scope==='shared'))});
  }
  artifact(title,content,{id=randomUUID(),kind='html',jobId=null,expectedVersion}={}) {
    text(content,'artifact',200000);text(title,'title',160);
    invariant(['html','markdown','text'].includes(kind),'Unsupported artifact type');
    const previous=this.get('artifact',id);
    invariant(expectedVersion===undefined || (previous?.version||0)===expectedVersion,
      'Artifact changed. Read its latest version before editing.',409);
    const doc={id,title,content,kind,jobId,version:(previous?.version||0)+1,updatedAt:new Date().toISOString()};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(previous) this.put('revision',{...previous,id:`${id}:${previous.version}`,artifactId:id});
      this.put('artifact',doc);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    this.emit('artifact.updated',doc);return doc;
  }
  snapshot() {
    return {dialogueArchives:this.list('dialogue-archive'),companion:this.value('companion')||{revision:0,focusJobId:null,returnStack:[]},seq:this.seq,jobs:this.list('job'),artifacts:this.list('artifact'),
      display:this.value('display'),skills:this.list('skill'),mcp:this.list('mcp'),routines:this.list('routine'),plans:this.list('plan'),
      memories:this.list('memory'),messages:this.list('message').reverse(),settings:this.settings};
  }
  export() {
    const collections=Object.fromEntries(EXPORT_KINDS.map(k=>[k,this.list(k).filter(d=>k!=='skill'||d.source!=='shared')]));
    const sharedReferences=this.list('skill').filter(d=>d.source==='shared').map(d=>({name:d.name,sourcePath:d.sourcePath,sha256:d.sha256}));
    return {format:'tepora-v3-context',version:2,exportedAt:new Date().toISOString(),collections,sharedReferences,
      display:this.value('display'),
      dialogueArchive:{version:1,session:this.value('dialogue-session'),personas:this.value('dialogue-personas'),messages:this.list('dialogue-message').reverse(),questions:this.list('worker-question'),archives:this.list('dialogue-archive')},
      // Compatibility for readers of beta.1; collections is the authoritative v2 payload.
      memories:collections.memory,artifacts:collections.artifact,skills:collections.skill};
  }
  import(bundle) {
    invariant(bundle?.format==='tepora-v3-context' && [1,2].includes(bundle.version),'Invalid context format');
    const collections=bundle.version===2 ? bundle.collections : {
      memory:bundle.memories||[]};
    invariant(collections && typeof collections==='object' && !Array.isArray(collections),'Invalid collections');
    const ids=new Map(),prepared=[];
    // Dialogue backups are readable archives only. Never restore active identities, jobs,
    // question routing, provider grants or result-sharing permissions from imported content.
    const dialogueArchives=[];
    if(bundle.dialogueArchive){
      const archive=bundle.dialogueArchive;
      invariant(archive&&archive.version===1&&Array.isArray(archive.messages)&&Array.isArray(archive.archives||[])&&(archive.archives||[]).length<=1000,'Invalid dialogue archive');
      for(const source of [archive,...(archive.archives||[])]){
        invariant(source&&Array.isArray(source.messages)&&source.messages.length<=100000,'Invalid dialogue archive');
        const messages=source.messages.map(m=>{
          invariant(m&&['user','assistant','tool','system'].includes(m.role),'Invalid archived dialogue role');
          text(m.content,'archived dialogue content',100000);
          return {role:m.role,content:m.content,kind:String(m.kind||'archive').slice(0,80),at:String(m.at||'').slice(0,100),sourceJobId:typeof (m.jobId||m.sourceJobId)==='string'?(m.jobId||m.sourceJobId).slice(0,300):null,sourceQuestionId:typeof (m.questionId||m.sourceQuestionId)==='string'?(m.questionId||m.sourceQuestionId).slice(0,300):null,readOnly:true};
        });
        const personas={};for(const role of ['character','worker'])if(source.personas?.[role]){const p=source.personas[role];personas[role]={name:text(p.name,'archived persona name',80),instructions:typeof p.instructions==='string'&&p.instructions.length<=8000?p.instructions:''};}
        const sourceSessionId=source.session?.id||source.sourceSessionId;
        dialogueArchives.push({id:randomUUID(),sourceSessionId:typeof sourceSessionId==='string'?sourceSessionId.slice(0,300):null,personas,messages,importedAt:new Date().toISOString(),readOnly:true,note:'Imported dialogue archive. No live session, question, execution or sharing permission was restored.'});
      }
    }
    for(const kind of EXPORT_KINDS) {
      const docs=collections[kind]||[];
      invariant(Array.isArray(docs)&&docs.length<=100000,'Too many documents');
      for(const raw of docs) {
        invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid document');
        const d=structuredClone(raw),old=d.id||randomUUID();
        invariant(typeof old==='string'&&!ids.has(`${kind}:${old}`),'Duplicate id in import');
        d.id=randomUUID();ids.set(`${kind}:${old}`,d.id);
        if(['memory','artifact','revision','skill','message'].includes(kind))
          text(d.content,'content',kind==='memory'?32000:200000);
        if(['artifact','revision'].includes(kind)) {
          invariant(['text','markdown','html'].includes(d.kind),'Invalid artifact kind');
          text(d.title,'title',160);
          invariant(Number.isSafeInteger(d.version)&&d.version>0,'Invalid artifact version');
        }
        if(kind==='memory') Object.assign(d,{confirmed:false,scope:'private',source:'import'});
        if(kind==='skill') Object.assign(d,{enabled:false,source:'import'});
        if(kind==='routine'){
          invariant(d.lastJobId==null||typeof d.lastJobId==='string','Invalid routine last job reference');
          Object.assign(d,{enabled:false,status:'proposed',runtime:null,destination:null,nextAt:null});
        }
        if(kind==='plan')Object.assign(d,{status:'proposed',jobs:{},runtime:null,destination:null});
        if(kind==='job') Object.assign(d,{status:'interrupted',approval:null,resumeBlocked:true,characterSessionId:null,dialogueSequence:0,pendingQuestionId:null,
          note:'移行した仕事です。外部操作の状態を確認するまで自動再開しません。'});
        prepared.push({kind,d,old});
      }
    }
    for(const {kind,d,old} of prepared) {
      if(d.jobId) d.jobId=ids.get(`job:${d.jobId}`)||null;
      if(d.artifactId) d.artifactId=ids.get(`artifact:${d.artifactId}`)||null;
      if(kind==='routine')d.lastJobId=typeof d.lastJobId==='string'?ids.get(`job:${d.lastJobId}`)||null:null;
      if(kind==='revision') d.id=`${d.artifactId}:${d.version}`;
      if(kind==='checkpoint') {d.id=ids.get(`job:${old}`)||d.id; d.imported=true;}
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const {kind,d} of prepared) this.put(kind,d);
      for(const archive of dialogueArchives)this.put('dialogue-archive',archive);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    this.emit('snapshot',this.snapshot());
    return {imported:prepared.length,dialogueArchiveId:dialogueArchives[0]?.id||null,dialogueArchiveIds:dialogueArchives.map(a=>a.id),counts:Object.fromEntries(EXPORT_KINDS.map(k=>[k,prepared.filter(x=>x.kind===k).length])),
      note:'記憶は未確認・非共有、スキルは無効、仕事は中断状態で復元しました。接続先・認証・共通資産は変更しません。'};
  }
  close() {
    if(this.closed) return;
    this.closed=true;
    if(this.value('service-owner')?.id===this.owner)
      this.db.prepare('DELETE FROM kv WHERE key=?').run('service-owner');
    this.db.close();
  }
}

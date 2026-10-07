import {indexedText,matchExpression} from './search.mjs';
import { NativeState } from './native-state.mjs';
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
    this.db = new NativeState(path.join(dir, 'tepora-v3.sqlite'));
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
    if(arguments.length>1){this.db.call('kv.set',{key,value});return value;}
    return this.db.call('kv.get',{key});
  }
  get settings() { return {...DEFAULT_SETTINGS, ...(this.value('settings') || {})}; }
  set settings(value) { this.value('settings',value); }

  /** Pagination is optional; display limits must never truncate exports or retrieval. */
  list(kind, {limit,offset=0}={}) {
    invariant(Number.isSafeInteger(offset) && offset >= 0, 'Invalid offset');
    invariant(limit === undefined || Number.isSafeInteger(limit) && limit > 0, 'Invalid limit');
    return this.db.call('document.list',{kind,limit,offset});
  }
  get(kind,id) { return this.db.call('document.get',{kind,id}); }
  index(kind,doc){this.db.call('document.index',{kind,id:doc.id,terms:indexedText(doc)});}
  put(kind,doc) {
    invariant(typeof doc.id==='string' && doc.id.length>0 && doc.id.length<=300,'Document id required');
    this.db.call('document.put',{kind,doc,...(['memory','job'].includes(kind)?{terms:indexedText(doc)}:{})});
    return doc;
  }
  remove(kind,id) { return this.db.call('document.remove',{kind,id}); }
  emit(type,data) {
    const event=this.db.call('event.append',{type,data,at:new Date().toISOString(),retention:LIMITS.events});
    event.data=data;
    for(const fn of this.listeners) { try {fn(event);} catch {this.listeners.delete(fn);} }
    return event;
  }
  broadcast(type,data) {
    for(const fn of this.listeners) {
      try {fn({seq:null,type,data,at:new Date().toISOString()});} catch {this.listeners.delete(fn);}
    }
  }
  events(since=0) { return this.db.call('event.replay',{since}); }
  get seq() { return this.db.call('event.seq'); }
  memory(content,{source='user',confirmed=true,scope='private',title=''}={}) {
    const doc={id:randomUUID(),content:text(content,'memory',32000),title:title.slice(0,160),
      source,confirmed,scope:scope==='shared'?'shared':'private',createdAt:new Date().toISOString()};
    this.put('memory',doc);this.emit('memory.updated',doc);return doc;
  }
  search(kind,query,{limit=20,filter=()=>true}={}) {
    invariant(['memory','job'].includes(kind),'Unknown search collection');
    const expression=matchExpression(query);if(!expression)return [];
    // Keep recall bounded even with a large archive; consent filters stay in JS.
    const result=[],pageSize=32;
    for(let offset=0;;offset+=pageSize){
      const rows=this.db.call('document.search',{kind,expression,limit:pageSize,offset});
      for(const doc of rows){if(filter(doc))result.push(doc);if(result.length>=limit)return result;}
      if(rows.length<pageSize)return result;
    }
  }
  recall(query,{cloud=false,share=false,limit=6}={}) {
    const expression=matchExpression(query);if(!expression)return [];
    return this.db.call('memory.recall',{expression,cloud:!!cloud,share:!!share,limit});
  }
  artifact(title,content,{id=randomUUID(),kind='html',jobId=null,expectedVersion}={}) {
    text(content,'artifact',200000);text(title,'title',160);
    invariant(['html','markdown','text'].includes(kind),'Unsupported artifact type');
    const doc=this.db.call('artifact.put',{doc:{id,title,content,kind,jobId,updatedAt:new Date().toISOString()},expectedVersion});
    this.emit('artifact.updated',doc);return doc;
  }
  snapshot() {
    return {seq:this.seq,artifacts:this.list('artifact'),display:this.value('display'),skills:this.list('skill'),mcp:this.list('mcp'),
      memories:this.list('memory'),settings:this.settings};
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
      this.db.call('kv.delete',{key:'service-owner'});
    this.db.close();
  }
}

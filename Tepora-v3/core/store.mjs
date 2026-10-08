import {indexedText,matchExpression} from './search.mjs';
import { NativeState } from './native-state.mjs';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS, invariant, LIMITS } from './policy.mjs';

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
  /** Rust persists the domain and events together; only live JS callbacks stay here. */
  domain(operation,payload={}) {
    const {value,events}=this.db.call(operation,{...payload,unicodeVersion:process.versions.unicode});
    for(const event of events) {
      // Preserve the original live document identity shared by listeners and caller.
      if(['memory.updated','artifact.updated'].includes(event.type))event.data=value;
      for(const fn of this.listeners) {try {fn(event);} catch {this.listeners.delete(fn);}}
    }
    return value;
  }
  memory(content,{source='user',confirmed=true,scope='private',title=''}={}) {
    return this.domain('store.memory',{content,options:{source,confirmed,scope,title}});
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
  artifact(title,content,{id,kind='html',jobId=null,expectedVersion}={}) {
    return this.domain('store.artifact',{title,content,options:{id,kind,jobId,expectedVersion}});
  }
  snapshot() { return this.domain('store.snapshot'); }
  export() {
    const value=this.domain('store.export');
    // Restore JS-only aliases/undefined slots that cannot cross a JSON transport.
    value.memories=value.collections.memory;value.artifacts=value.collections.artifact;value.skills=value.collections.skill;
    value.sharedReferences=value.sharedReferences.map(({name,sourcePath,sha256})=>({name,sourcePath,sha256}));
    return value;
  }
  import(bundle) { return this.domain('store.import',{bundle}); }
  close() {
    if(this.closed) return;
    this.closed=true;
    if(this.value('service-owner')?.id===this.owner)
      this.db.call('kv.delete',{key:'service-owner'});
    this.db.close();
  }
}

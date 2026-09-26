import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS, invariant, text, LIMITS } from './policy.mjs';
export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, {recursive:true});
    this.db = new DatabaseSync(path.join(dir, 'tepora-v3.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);`);
    this.listeners = new Set();
    // Never blindly rerun an action whose side effects may already have happened.
    for (const job of this.list('job')) if (['running','queued','waiting_approval'].includes(job.status)) this.put('job', {...job, status:'interrupted', note:'アプリが再起動しました。実行済みの操作を確認してから再依頼してください。', endedAt:new Date().toISOString()});
  }
  get settings() { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get('settings'); return {...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {})}; }
  set settings(value) { this.db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES (?,?)').run('settings', JSON.stringify(value)); }
  list(kind) { return this.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC LIMIT 1000').all(kind).map(r => JSON.parse(r.body)); }
  get(kind,id) { const r = this.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind,id); return r ? JSON.parse(r.body) : null; }
  put(kind, doc) { invariant(typeof doc.id === 'string', 'Document id required'); this.db.prepare('INSERT OR REPLACE INTO documents(kind,id,body) VALUES (?,?,?)').run(kind,doc.id,JSON.stringify(doc)); return doc; }
  remove(kind,id) { return this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id); }
  emit(type, data) {
    const at = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(type,body,at) VALUES(?,?,?)').run(type,JSON.stringify(data),at);
    const event = {seq:Number(result.lastInsertRowid), type, data, at};
    if (event.seq % 100 === 0) this.db.prepare('DELETE FROM events WHERE seq < ?').run(event.seq - LIMITS.events);
    for (const fn of this.listeners) { try { fn(event); } catch { this.listeners.delete(fn); } }
    return event;
  }
  broadcast(type,data){const event={seq:null,type,data,at:new Date().toISOString()};for(const fn of this.listeners){try{fn(event);}catch{this.listeners.delete(fn);}}}
  events(since = 0) { return this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 5000').all(since).map(r=>({seq:r.seq,type:r.type,data:JSON.parse(r.body),at:r.at})); }
  get seq() { return Number(this.db.prepare('SELECT MAX(seq) AS seq FROM events').get().seq || 0); }
  memory(content, {source='user', confirmed=true, scope='private', title=''} = {}) {
    const doc = {id:randomUUID(), content:text(content,'memory',32000), title:title.slice(0,160), source, confirmed, scope:scope === 'shared' ? 'shared' : 'private', createdAt:new Date().toISOString()};
    this.put('memory',doc); this.emit('memory.updated',doc); return doc;
  }
  recall(query, {cloud=false, share=false, limit=6} = {}) {
    const terms = new Set((query.toLowerCase().match(/[a-z0-9_]{2,}|[\u3040-\u9fff]{1,3}/g)||[]));
    return this.list('memory').filter(m=>m.confirmed && (!cloud || (share && m.scope === 'shared'))).map(m=>({m, score:[...terms].filter(t=>m.content.toLowerCase().includes(t)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.m);
  }
  artifact(title, content, {id=randomUUID(), kind='html', jobId=null}={}) {
    text(content,'artifact',200000); text(title,'title',160);
    invariant(['html','markdown','text'].includes(kind), 'Unsupported artifact type');
    const previous = this.get('artifact',id);
    const doc = {id, title, content, kind, jobId, version:(previous?.version||0)+1, updatedAt:new Date().toISOString()};
    if(previous) this.put('revision',{...previous,id:`${id}:${previous.version}`,artifactId:id});
    this.put('artifact',doc); this.emit('artifact.updated',doc); return doc;
  }
  snapshot() { return {seq:this.seq, jobs:this.list('job'), artifacts:this.list('artifact'), memories:this.list('memory'), messages:this.list('message').reverse(), settings:this.settings}; }
  export() { return {format:'tepora-v3-context',version:1,exportedAt:new Date().toISOString(),memories:this.list('memory'),artifacts:this.list('artifact'),skills:this.list('skill')}; }
  close() { this.db.close(); }
}

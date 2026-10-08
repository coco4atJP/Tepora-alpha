import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {NativeState} from '../core/native-state.mjs';
const put=(s,id,step=0,terms='same')=>s.call('document.put',{kind:'job',doc:{id,title:'same',step},terms});
const rows=s=>s.prepare('SELECT rowid,id,terms FROM content_search ORDER BY rowid').all();
const search=s=>s.call('document.search',{kind:'job',expression:'same'}).map(d=>d.id);
function fixture(fn){const dir=mkdtempSync(path.join(tmpdir(),'tepora-write-test-')),file=path.join(dir,'state.sqlite'),s=new NativeState(file);try{fn(s,file);}finally{s.close();rmSync(dir,{recursive:true,force:true});}}
test('identical KV values append no WAL frames or logical row changes',()=>fixture((s,file)=>{
 s.call('kv.set',{key:'settings',value:{enabled:true}});put(s,'a');put(s,'b');
 s.call('document.put',{kind:'session',doc:{id:'session',status:'idle'}});
 s.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 const changes=s.prepare('SELECT total_changes() AS n').get().n;
 for(let i=0;i<100;i++)s.call('kv.set',{key:'settings',value:{enabled:true}});
 assert.equal(statSync(file+'-wal').size,0);
 assert.equal(s.prepare('SELECT total_changes() AS n').get().n,changes);
 assert.deepEqual(s.call('kv.get',{key:'settings'}),{enabled:true});assert.deepEqual(search(s),['a','b']);
}));
test('older identical indexed documents retain delete-insert tie ordering',()=>fixture(s=>{
 put(s,'a');put(s,'b');assert.deepEqual(search(s),['a','b']);put(s,'a');assert.deepEqual(search(s),['b','a']);
 assert.deepEqual(rows(s).map(r=>r.rowid),[2,3]);put(s,'a');assert.deepEqual(search(s),['b','a']);
}));
test('progress body and search terms retain existing behavior',()=>fixture(s=>{
 put(s,'a');const before=rows(s);put(s,'a',7);assert.deepEqual(rows(s),before);assert.equal(s.call('document.get',{kind:'job',id:'a'}).step,7);
 put(s,'a',8,'different');assert.deepEqual(search(s),[]);assert.equal(rows(s)[0].terms,'different');
}));
test('missing and duplicated index rows are repaired',()=>fixture(s=>{
 put(s,'a');s.exec('DELETE FROM content_search');put(s,'a');assert.equal(rows(s).length,1);
 s.prepare('INSERT INTO content_search(kind,id,terms) VALUES(?,?,?)').run('job','a','same');put(s,'a');assert.equal(rows(s).length,1);
}));
test('outer rollback retains both document and index atomically',()=>fixture(s=>{
 put(s,'a');s.exec('BEGIN');put(s,'a',9,'new');s.call('kv.set',{key:'settings',value:false});s.exec('ROLLBACK');
 assert.equal(s.call('document.get',{kind:'job',id:'a'}).step,0);assert.deepEqual(search(s),['a']);assert.equal(s.call('kv.get',{key:'settings'}),null);
}));
test('all progress, final and error events remain durable and ordered',()=>fixture(s=>{
 for(const type of ['job.progress','job.progress','job.finished','job.error'])s.call('event.append',{type,data:{id:'a'},at:'2026-01-01'});
 const events=s.call('event.replay');assert.deepEqual(events.map(e=>e.type),['job.progress','job.progress','job.finished','job.error']);assert.deepEqual(events.map(e=>e.seq),[1,2,3,4]);
}));
test('ordinary abrupt process exit recovers committed state and rolls back unfinished state',{skip:process.platform==='win32'},()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'tepora-write-crash-')),file=path.join(dir,'state.sqlite');
 try{
  const module=new URL('../core/native-state.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {NativeState} from ${JSON.stringify(module)};const s=new NativeState(${JSON.stringify(file)});s.call('kv.set',{key:'durable',value:42});s.call('event.append',{type:'job.error',data:{message:'retained'},at:'2026-01-01'});s.call('document.put',{kind:'job',doc:{id:'crash',step:1},terms:'durable'});s.exec('BEGIN');s.call('document.put',{kind:'job',doc:{id:'crash',step:2},terms:'uncommitted'});s.call('kv.set',{key:'durable',value:99});process.kill(process.pid,'SIGKILL');`],{timeout:10000});
  assert.equal(child.signal,'SIGKILL');const s=new NativeState(file);try{assert.equal(s.call('kv.get',{key:'durable'}),42);assert.equal(s.call('document.get',{kind:'job',id:'crash'}).step,1);assert.equal(s.call('document.search',{kind:'job',expression:'durable'}).length,1);assert.equal(s.call('document.search',{kind:'job',expression:'uncommitted'}).length,0);assert.equal(s.call('event.replay')[0].data.message,'retained');assert.equal(s.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{s.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('changed KV and document values are immediately visible after reopening',()=>fixture((s,file)=>{
 s.call('kv.set',{key:'settings',value:{enabled:true}});s.call('kv.set',{key:'settings',value:{enabled:false}});put(s,'a',11);
 const reopened=new NativeState(file);try{assert.deepEqual(reopened.call('kv.get',{key:'settings'}),{enabled:false});assert.equal(reopened.call('document.get',{kind:'job',id:'a'}).step,11);}finally{reopened.close();}
}));

test('KV upsert creates missing keys and preserves JSON null and binary exact text',()=>fixture(s=>{
 s.call('kv.set',{key:'nullable',value:null});assert.equal(s.prepare('SELECT COUNT(*) AS n FROM kv WHERE key=?').get('nullable').n,1);
 let changes=s.prepare('SELECT total_changes() AS n').get().n;s.call('kv.set',{key:'nullable',value:null});assert.equal(s.prepare('SELECT total_changes() AS n').get().n,changes);
 s.call('kv.set',{key:'case',value:'A'});s.call('kv.set',{key:'case',value:'a'});assert.equal(s.call('kv.get',{key:'case'}),'a');
 s.call('kv.set',{key:'ordered',value:{a:1,b:2}});changes=s.prepare('SELECT total_changes() AS n').get().n;s.call('kv.set',{key:'ordered',value:{b:2,a:1}});assert.equal(s.prepare('SELECT total_changes() AS n').get().n,changes+1);
 assert.deepEqual(Object.keys(s.call('kv.get',{key:'ordered'})),['b','a']);
}));

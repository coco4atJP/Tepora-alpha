import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';

// node:sqlite is used only as an independent legacy-file producer/reader. All
// application operations below go through the production Store/SessionStore.
async function fixture(t,{open=true}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-rust-state-')),stores=[];
 const f={dir,open(){const store=new Store(dir);stores.push(store);return store;}};
 t.after(async()=>{try{for(const store of stores.reverse())store.close();}finally{await rm(dir,{recursive:true,force:true});}});
 if(open)f.store=f.open();
 return f;
}
const ids=docs=>docs.map(d=>d.id);
const at='2026-10-07T00:00:00.000Z';

test('Rust state: committed WAL data and interrupted-work recovery survive a process restart',async t=>{
 const f=await fixture(t,{open:false});
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {Store} from ${JSON.stringify(new URL('../core/store.mjs',import.meta.url).href)};
  import {SessionStore} from ${JSON.stringify(new URL('../core/agent/sessions.mjs',import.meta.url).href)};
  const store=new Store(process.argv[1]),sessions=new SessionStore(store);
  store.value('restart-payload',{text:'再起動しても残る 🦊 𠮷',nested:[null,false,0]});
  store.settings={companion:'しろ 🐈',allowCloud:false};
  for(const status of ['running','queued','waiting_approval'])store.put('job',{id:status,status,revision:2,approval:{id:'old'}});
  store.put('job',{id:'parked',status:'waiting_approval',parked:true,revision:2,approval:{id:'keep'}});
  store.put('job',{id:'legacy',status:'done',kind:'worker',step:1});
  store.artifact('再起動','first',{id:'restart-artifact',kind:'text'});
  store.artifact('再起動','second',{id:'restart-artifact',kind:'text',expectedVersion:1});
  sessions.create({id:'restart-session',kind:'main',title:'対話'});
  sessions.append('restart-session','input',{text:'保存する 🪷'});
  sessions.putEvidence('restart-evidence','restart-session',1,'read','証拠\\n𠮷');
  sessions.enqueue('restart-session',{id:'restart-input',text:'続けて',mode:'steer'});
  // Intentionally omit close: the next process must recover the dead lease and WAL.
 `,f.dir],{encoding:'utf8',timeout:20000});
 assert.equal(child.error,undefined);
 assert.equal(child.status,0,child.stderr);
 const store=f.open(),sessions=new SessionStore(store);
 assert.deepEqual(store.value('restart-payload'),{text:'再起動しても残る 🦊 𠮷',nested:[null,false,0]});
 assert.equal(store.settings.companion,'しろ 🐈');
 for(const id of ['running','queued','waiting_approval']){
  assert.equal(store.get('job',id).status,'interrupted');
  assert.equal(store.get('job',id).approval,null);
 }
 assert.equal(store.get('job','parked').status,'waiting_approval');
 assert.deepEqual(store.get('job','parked').approval,{id:'keep'});
 assert.equal(store.get('job','legacy').resumeBlocked,true);
 assert.equal(store.get('artifact','restart-artifact').version,2);
 assert.equal(store.get('revision','restart-artifact:1').content,'first');
 assert.equal(sessions.append('restart-session','assistant',{content:'復帰'}).seq,2);
 assert.equal(sessions.evidence('restart-evidence').content,'証拠\n𠮷');
 assert.deepEqual(ids(sessions.take('restart-session')),['restart-input']);
});

test('Rust state: opens existing Node SQLite files in place and preserves unrelated data',async t=>{
 const f=await fixture(t,{open:false}),file=path.join(f.dir,'tepora-v3.sqlite');
 const backup=path.join(f.dir,'user-backup.sqlite');
 await writeFile(backup,'untouched backup');
 const legacy=new DatabaseSync(file);
 const memory={id:'legacy-memory',content:'以前の茶会の記録 legacyneedle 🦊',confirmed:true,scope:'private'};
 const session={id:'legacy-session',kind:'main',status:'idle',title:'以前の会話'};
 try{
  legacy.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE documents(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
   CREATE VIRTUAL TABLE content_search USING fts5(kind UNINDEXED,id UNINDEXED,terms,tokenize='unicode61');
   CREATE TABLE session_log(session_id TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(session_id,seq));
   CREATE TABLE evidence_store(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,seq INTEGER NOT NULL,tool TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
   CREATE INDEX evidence_by_session ON evidence_store(session_id,seq);
   CREATE VIRTUAL TABLE session_search USING fts5(session_id UNINDEXED,seq UNINDEXED,terms,tokenize='unicode61');
   CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
   CREATE INDEX inbox_by_session ON session_inbox(session_id,at);
   CREATE TABLE unrelated_extension(key TEXT PRIMARY KEY,body BLOB);`);
  legacy.prepare('INSERT INTO kv VALUES(?,?)').run('settings',JSON.stringify({companion:'旧設定',allowCloud:false}));
  legacy.prepare('INSERT INTO documents VALUES(?,?,?)').run('memory',memory.id,JSON.stringify(memory));
  legacy.prepare('INSERT INTO documents VALUES(?,?,?)').run('session',session.id,JSON.stringify(session));
  legacy.prepare('INSERT INTO events(seq,type,body,at) VALUES(?,?,?,?)').run(41,'legacy.event',JSON.stringify({text:'残す'}),at);
  legacy.prepare('INSERT INTO session_log VALUES(?,?,?,?,?)').run(session.id,7,'input',JSON.stringify({text:'oldsessionneedle 昔の会話 🪷'}),at);
  legacy.prepare('INSERT INTO session_search VALUES(?,?,?)').run(session.id,7,'oldsessionneedle 昔の の会 会話');
  legacy.prepare('INSERT INTO evidence_store VALUES(?,?,?,?,?,?)').run('legacy-evidence',session.id,7,'read','生の証拠\n🪷',at);
  legacy.prepare('INSERT INTO session_inbox VALUES(?,?,?,?)').run('legacy-pending',session.id,JSON.stringify({id:'legacy-pending',text:'未処理',mode:'followup',at}),at);
  legacy.prepare('INSERT INTO unrelated_extension VALUES(?,?)').run('retain',Buffer.from([0,255,127,42]));
 }finally{legacy.close();}
 const store=f.open(),sessions=new SessionStore(store);
 assert.deepEqual(store.get('memory',memory.id),memory);
 assert.equal(store.settings.companion,'旧設定');
 assert.deepEqual(ids(store.recall('legacyneedle')),[memory.id]);
 assert.deepEqual(ids(store.recall('茶会')),[memory.id]);
 assert.equal(store.seq,41);
 assert.deepEqual(store.events(40),[{seq:41,type:'legacy.event',data:{text:'残す'},at}]);
 assert.equal(store.emit('native.event',{text:'新しい 🪷'}).seq,42);
 assert.equal(sessions.search('oldsessionneedle')[0].seq,7);
 assert.equal(sessions.append(session.id,'assistant',{content:'次の返事'}).seq,8);
 assert.equal(sessions.evidence('legacy-evidence').content,'生の証拠\n🪷');
 assert.deepEqual(ids(sessions.take(session.id)),['legacy-pending']);
 store.close();
 const reader=new DatabaseSync(file);
 try{
  assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(Buffer.from(reader.prepare('SELECT body FROM unrelated_extension WHERE key=?').get('retain').body),Buffer.from([0,255,127,42]));
  assert.equal(reader.prepare('SELECT MAX(seq) AS seq FROM session_log WHERE session_id=?').get(session.id).seq,8);
  assert.equal(reader.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('events').seq,42);
 }finally{reader.close();}
 assert.equal(await readFile(backup,'utf8'),'untouched backup');
});

test('Rust state: session append sequences stay unique across instances, removal, and reopen',async t=>{
 const f=await fixture(t),a=new SessionStore(f.store),b=new SessionStore(f.store);
 a.create({id:'shared',kind:'main'});
 assert.equal(a.seq('shared'),1);
 assert.equal(b.seq('shared'),1);
 assert.equal(a.append('shared','input',{text:'one'}).seq,1);
 assert.equal(b.append('shared','assistant',{content:'two'}).seq,2);
 assert.equal(a.append('shared','checkpoint',{summary:'three'}).seq,3);
 assert.equal(b.append('shared','notice',{text:'four'}).seq,4);
 assert.deepEqual(a.entries('shared',{from:2,to:3}).map(e=>e.seq),[2,3]);
 assert.deepEqual(b.entries('shared',{types:['input','notice']}).map(e=>e.seq),[1,4]);
 assert.deepEqual(a.tail('shared',2).map(e=>e.seq),[3,4]);
 assert.equal(a.latest('shared','checkpoint').seq,3);
 assert.equal(a.patch('shared',2,{withdrawn:true}).withdrawn,true);
 assert.equal(b.entry('shared',2).content,'two');
 assert.equal(b.entry('shared',2).withdrawn,true);
 assert.equal(a.patch('shared',99,{withdrawn:true}),null);
 f.store.close();
 const reopened=f.open(),c=new SessionStore(reopened);
 assert.equal(c.append('shared','assistant',{content:'five'}).seq,5);
 assert.deepEqual(c.entries('shared').map(e=>e.seq),[1,2,3,4,5]);
 c.remove('shared');
 c.create({id:'shared',kind:'main'});
 assert.equal(c.append('shared','input',{text:'new incarnation'}).seq,1);
});

test('Rust state: forgetting memory erases legacy events, vectors, and search without resetting event sequence',async t=>{
 const {store}=await fixture(t),seen=[];
 store.listeners.add(e=>seen.push(e));
 const forgotten=store.memory('privateerase 茶会 🦊'),retained=store.memory('retainedmarker');
 store.put('memory-vector',{id:forgotten.id,vector:[0.1,0.2],sourceText:forgotten.content});
 const durable=store.db.prepare('SELECT body FROM events WHERE type=? ORDER BY seq LIMIT 1').get('memory.updated');
 assert.deepEqual(JSON.parse(durable.body),{id:forgotten.id});
 assert.equal(seen[0].data.content,forgotten.content);
 store.db.prepare('INSERT INTO events(type,body,at) VALUES(?,?,?)').run('memory.updated',JSON.stringify(forgotten),at);
 store.db.prepare('INSERT INTO events(type,body,at) VALUES(?,?,?)').run('memory.deleted',JSON.stringify({id:forgotten.id,content:forgotten.content}),at);
 store.emit('unrelated.event',{id:forgotten.id,keep:true});
 const seq=store.seq;
 assert.equal(store.remove('memory',forgotten.id).changes,1);
 assert.equal(store.get('memory',forgotten.id),null);
 assert.equal(store.get('memory-vector',forgotten.id),null);
 assert.deepEqual(store.search('memory','privateerase'),[]);
 assert.deepEqual(store.db.prepare("SELECT body FROM events WHERE type LIKE 'memory.%' AND json_extract(body,'$.id')=?").all(forgotten.id),[]);
 assert.deepEqual(store.events().filter(e=>e.type==='memory.updated').map(e=>e.data.id),[retained.id]);
 assert.equal(store.events().at(-1).type,'unrelated.event');
 assert.equal(store.seq,seq);
 assert.equal(store.emit('after.erase',{}).seq,seq+1);
 assert.equal(store.remove('memory',forgotten.id).changes,0);
});

test('Rust state: artifact revisions are atomic and stale writes leave both history and events unchanged',async t=>{
 const {store}=await fixture(t);
 const first=store.artifact('文書 🪷','original',{id:'atomic-artifact',kind:'text'}),seq=store.seq;
 // An actual SQLite write failure occurs after revision creation, not in validation.
 store.db.exec(`CREATE TRIGGER reject_artifact_update BEFORE UPDATE ON documents
  WHEN NEW.kind='artifact' AND NEW.id='atomic-artifact'
  BEGIN SELECT RAISE(ABORT,'injected artifact failure'); END;`);
 assert.throws(()=>store.artifact('文書 🪷','failed',{id:first.id,kind:'text',expectedVersion:1}),/injected artifact failure/);
 assert.deepEqual(store.get('artifact',first.id),first);
 assert.equal(store.get('revision',`${first.id}:1`),null);
 assert.equal(store.seq,seq);
 store.db.exec('DROP TRIGGER reject_artifact_update');
 const second=store.artifact('文書 🪷','committed',{id:first.id,kind:'text',expectedVersion:1});
 assert.equal(second.version,2);
 assert.equal(store.get('revision',`${first.id}:1`).content,'original');
 const committedSeq=store.seq;
 assert.throws(()=>store.artifact('文書','stale',{id:first.id,kind:'text',expectedVersion:1}),e=>e.status===409);
 assert.deepEqual(store.get('artifact',first.id),second);
 assert.equal(store.list('revision').length,1);
 assert.equal(store.seq,committedSeq);
});

test('Rust state: a late import failure rolls back documents, search entries, and event emission',async t=>{
 const {store}=await fixture(t),existing=store.memory('existinganchor'),seq=store.seq;
 store.db.exec(`CREATE TRIGGER reject_imported_artifact BEFORE INSERT ON documents
  WHEN NEW.kind='artifact' BEGIN SELECT RAISE(ABORT,'injected import failure'); END;`);
 const bundle={format:'tepora-v3-context',version:2,collections:{
  memory:[{id:'import-memory',content:'rollbackneedle',confirmed:true,scope:'shared'}],
  artifact:[{id:'import-artifact',title:'Import',content:'body',kind:'text',version:1}]
 }};
 assert.throws(()=>store.import(bundle),/injected import failure/);
 assert.deepEqual(store.list('memory'),[existing]);
 assert.deepEqual(store.list('artifact'),[]);
 assert.deepEqual(store.search('memory','rollbackneedle'),[]);
 assert.equal(store.seq,seq);
 store.db.exec('DROP TRIGGER reject_imported_artifact');
 assert.equal(store.import(bundle).imported,2);
 const imported=store.search('memory','rollbackneedle')[0];
 assert.ok(imported);
 assert.equal(imported.confirmed,false);
 assert.equal(imported.scope,'private');
 assert.equal(imported.source,'import');
 assert.notEqual(imported.id,'import-memory');
 assert.deepEqual(store.recall('rollbackneedle'),[]);
});

test('Rust state: ordered steer/followup inbox delivery is exactly once and session scoped',async t=>{
 const {store}=await fixture(t),sessions=new SessionStore(store);
 sessions.create({id:'inbox-a',kind:'main'});
 sessions.create({id:'inbox-b',kind:'worker'});
 sessions.enqueue('inbox-a',{id:'late',text:'later',mode:'followup',at:'2026-10-07T00:00:03.000Z'});
 sessions.enqueue('inbox-a',{id:'steer',text:'方針を変更 🦊',mode:'steer',at});
 sessions.enqueue('inbox-a',{id:'same-time',text:'then',mode:'followup',at});
 sessions.enqueue('inbox-a',{id:'answer',text:'tool answer',mode:'notify',at:'2026-10-07T00:00:01.000Z'});
 sessions.enqueue('inbox-b',{id:'other-session',text:'retain',at});
 assert.deepEqual(ids(sessions.pending('inbox-a')),['steer','same-time','answer','late']);
 assert.equal(sessions.takeItem('inbox-b','answer'),false);
 assert.equal(sessions.takeItem('inbox-a','answer'),true);
 assert.equal(sessions.takeItem('inbox-a','answer'),false);
 assert.deepEqual(new Set(sessions.inboxSessions()),new Set(['inbox-a','inbox-b']));
 const batch=sessions.take('inbox-a');
 assert.deepEqual(ids(batch),['steer','same-time','late']);
 assert.equal(batch[0].mode,'steer');
 assert.equal(batch[0].text,'方針を変更 🦊');
 assert.deepEqual(sessions.take('inbox-a'),[]);
 assert.deepEqual(ids(sessions.pending('inbox-b')),['other-session']);
 assert.deepEqual(sessions.inboxSessions(),['inbox-b']);
});

test('Rust state: failed inbox take leaves the complete ordered batch available for retry',async t=>{
 const {store}=await fixture(t),sessions=new SessionStore(store);
 sessions.create({id:'retry-inbox',kind:'main'});
 for(const id of ['first','blocked','last'])sessions.enqueue('retry-inbox',{id,text:id,mode:'steer',at});
 const original=sessions.pending('retry-inbox');
 store.db.exec(`CREATE TRIGGER fail_inbox_take BEFORE DELETE ON session_inbox
  WHEN OLD.id='blocked' BEGIN SELECT RAISE(ABORT,'injected take failure'); END;`);
 assert.throws(()=>sessions.take('retry-inbox'),/injected take failure/);
 assert.deepEqual(sessions.pending('retry-inbox'),original);
 store.db.exec('DROP TRIGGER fail_inbox_take');
 assert.deepEqual(sessions.take('retry-inbox'),original);
 assert.deepEqual(sessions.pending('retry-inbox'),[]);
});

test('Rust state: native operations participate in caller rollback without committing unrelated writes',async t=>{
 const {store}=await fixture(t),sessions=new SessionStore(store);
 const original=store.memory('outeranchor'),artifact=store.artifact('Original','preserve',{id:'outer-artifact',kind:'text'});
 sessions.create({id:'outer-session',kind:'main'});
 sessions.append('outer-session','input',{text:'original entry'});
 sessions.enqueue('outer-session',{id:'outer-pending',text:'keep queued',at});
 store.value('outer-setting',{keep:true});
 const seq=store.seq;
 store.db.exec('BEGIN IMMEDIATE');
 try{
  store.value('outer-setting',{keep:false});
  store.remove('memory',original.id);
  store.memory('rolledbackmarker');
  store.artifact('Changed','discard',{id:artifact.id,kind:'text',expectedVersion:1});
  sessions.append('outer-session','assistant',{content:'discard entry'});
  sessions.putEvidence('rolledback-evidence','outer-session',2,'read','discard evidence');
  assert.equal(sessions.take('outer-session').length,1);
 }finally{store.db.exec('ROLLBACK');}
 assert.deepEqual(store.value('outer-setting'),{keep:true});
 assert.deepEqual(store.get('memory',original.id),original);
 assert.deepEqual(ids(store.search('memory','outeranchor')),[original.id]);
 assert.deepEqual(store.search('memory','rolledbackmarker'),[]);
 assert.deepEqual(store.get('artifact',artifact.id),artifact);
 assert.equal(store.get('revision',`${artifact.id}:1`),null);
 assert.equal(store.seq,seq);
 assert.deepEqual(sessions.entries('outer-session').map(e=>e.seq),[1]);
 assert.equal(sessions.evidence('rolledback-evidence'),null);
 assert.deepEqual(ids(sessions.pending('outer-session')),['outer-pending']);
 assert.equal(sessions.append('outer-session','assistant',{content:'committed retry'}).seq,2);
});

test('Rust state: Unicode, JSON values, JavaScript length limits, and lexical privacy survive the bridge',async t=>{
 const {store}=await fixture(t),sessions=new SessionStore(store);
 const payload={text:'𠮷野家で茶会 🦊 café\u0000終',array:[null,true,false,0,-1,1.25],nested:{key:'日本語'},
  numbers:[51.248178375505404,-93.31137037688033,2.0030397744267762e-253,7.101215824554616e260,Number.MIN_VALUE,Number.MAX_VALUE]};
 store.value('unicode-json',payload);
 assert.deepEqual(store.value('unicode-json'),payload);
 store.put('note',{id:'numeric-payload',payload});
 assert.deepEqual(store.get('note','numeric-payload').payload,payload);
 const privateMemory=store.memory('privatelex 茶会 ＡＢＣ café 🦊');
 const shared=store.memory('sharedlex 茶会',{scope:'shared'});
 store.memory('unconfirmedlex 茶会',{confirmed:false,scope:'shared'});
 assert.deepEqual(ids(store.search('memory','abc')),[privateMemory.id]);
 assert.deepEqual(ids(store.search('memory','cafe')),[privateMemory.id]);
 assert.deepEqual(new Set(ids(store.recall('茶会'))),new Set([privateMemory.id,shared.id]));
 assert.deepEqual(store.recall('茶会',{cloud:true}),[]);
 assert.deepEqual(ids(store.recall('茶会',{cloud:true,share:true})),[shared.id]);
 assert.deepEqual(store.search('memory','" OR * --'),[]);
 const long=store.memory('🦊'.repeat(16000));
 assert.equal(store.get('memory',long.id).content.length,32000);
 assert.throws(()=>store.memory('🦊'.repeat(16001)),e=>e.status===400);
 assert.equal(store.artifact('🦊'.repeat(80),'valid',{id:'unicode-title',kind:'text'}).title.length,160);
 assert.throws(()=>store.artifact('🦊'.repeat(81),'invalid',{kind:'text'}),e=>e.status===400);
 store.put('note',{id:'🦊'.repeat(150),content:payload.text});
 assert.equal(store.get('note','🦊'.repeat(150)).content,payload.text);
 assert.throws(()=>store.put('note',{id:'🦊'.repeat(151),content:'invalid'}),e=>e.status===400);
 sessions.create({id:'unicode-session',kind:'main'});
 sessions.append('unicode-session','input',{text:payload.text,payload});
 sessions.putEvidence('unicode-evidence','unicode-session',1,'read',payload.text);
 assert.equal(sessions.entry('unicode-session',1).text,payload.text);
 assert.deepEqual(sessions.entry('unicode-session',1).payload,payload);
 assert.equal(sessions.evidence('unicode-evidence').content,payload.text);
 assert.equal(sessions.search('茶会',{sessionIds:['unicode-session']})[0].sessionId,'unicode-session');
});

test('Rust state: UTF-16 truncation and literal private-use characters round-trip without normalization',async t=>{
 const f=await fixture(t),sessions=new SessionStore(f.store);
 const title='a'+'🦊'.repeat(80),sessionTitle='b'+'🦊'.repeat(60);
 const text='切れた文字 '+('𠮷'.slice(0,1))+' / \uDC00 / literal \uE000 \uE000D800 \uE000\uE000 \uE000\uE100 / 🦊';
 const payload={text,['key\uD800']:['\uD800','\uDC00','\uE000','\uE000D800','\uE000\uE100','\\ud800']};
 f.store.value('utf16-payload',payload);
 const memory=f.store.memory(text,{title});
 assert.equal(memory.title,title.slice(0,160));
 assert.equal(memory.title.charCodeAt(159),0xD83E);
 const session=sessions.create({id:'utf16-session',kind:'main',title:sessionTitle});
 assert.equal(session.title,sessionTitle.slice(0,120));
 assert.equal(session.title.charCodeAt(119),0xD83E);
 sessions.append(session.id,'input',{text,payload});
 const evidence=JSON.stringify(payload);
 sessions.putEvidence('utf16-evidence',session.id,1,'read',evidence);
 f.store.close();
 const reopened=f.open(),restored=new SessionStore(reopened);
 assert.deepEqual(reopened.value('utf16-payload'),payload);
 assert.deepEqual(reopened.get('memory',memory.id),memory);
 assert.equal(restored.get(session.id).title,sessionTitle.slice(0,120));
 assert.equal(restored.entry(session.id,1).text,text);
 assert.deepEqual(restored.entry(session.id,1).payload,payload);
 assert.equal(restored.evidence('utf16-evidence').content,evidence);
});

test('Rust state: legacy JSON with lone surrogates and U+E000 remains readable and byte-value compatible',async t=>{
 const f=await fixture(t);
 f.store.close();
 const payload={text:'legacy \uD800 / \uDC00 / \uE000 / \uE000D800 / \uE000\uE000 / \uE000\uE100 / 🦊',
  ['legacy\uD800']:{literal:'\\ud800',privateUse:'\uE000'}};
 const memory={id:'legacy-utf16-memory',content:payload.text,title:'old\uD800',confirmed:true,scope:'private'};
 const legacy=new DatabaseSync(path.join(f.dir,'tepora-v3.sqlite'));
 try{
  legacy.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run('legacy-utf16-payload',JSON.stringify(payload));
  legacy.prepare('INSERT INTO documents(kind,id,body) VALUES(?,?,?)').run('memory',memory.id,JSON.stringify(memory));
  legacy.prepare('INSERT INTO documents(kind,id,body) VALUES(?,?,?)').run('job','legacy-utf16-job',JSON.stringify({id:'legacy-utf16-job',status:'done',revision:1,title:payload.text}));
  legacy.prepare('INSERT INTO session_log(session_id,seq,type,body,at) VALUES(?,?,?,?,?)').run('legacy-utf16-session',1,'input',JSON.stringify({text:payload.text,payload}),at);
  legacy.prepare('INSERT INTO events(type,body,at) VALUES(?,?,?)').run('legacy.utf16',JSON.stringify(payload),at);
  legacy.prepare('DELETE FROM kv WHERE key=?').run('search-schema-v1');
 }finally{legacy.close();}
 const reopened=f.open(),sessions=new SessionStore(reopened);
 assert.deepEqual(reopened.value('legacy-utf16-payload'),payload);
 assert.deepEqual(reopened.get('memory',memory.id),memory);
 assert.equal(reopened.get('job','legacy-utf16-job').title,payload.text);
 assert.deepEqual(reopened.events().find(e=>e.type==='legacy.utf16').data,payload);
 assert.equal(sessions.entry('legacy-utf16-session',1).text,payload.text);
 assert.deepEqual(sessions.entry('legacy-utf16-session',1).payload,payload);
 assert.deepEqual(ids(reopened.search('memory','legacy')),[memory.id]);
 reopened.value('legacy-utf16-payload',payload);
 reopened.put('memory',{...memory,confirmed:false});
 sessions.patch('legacy-utf16-session',1,{payload});
 reopened.close();
 const reader=new DatabaseSync(path.join(f.dir,'tepora-v3.sqlite'));
 try{
  assert.deepEqual(JSON.parse(reader.prepare('SELECT value FROM kv WHERE key=?').get('legacy-utf16-payload').value),payload);
  assert.deepEqual(JSON.parse(reader.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get('memory',memory.id).body),{...memory,confirmed:false});
  assert.deepEqual(JSON.parse(reader.prepare('SELECT body FROM session_log WHERE session_id=? AND seq=1').get('legacy-utf16-session').body).payload,payload);
 }finally{reader.close();}
});

test('Rust state: document ordering, search replacement, and session removal leave no stale records',async t=>{
 const {store}=await fixture(t),sessions=new SessionStore(store);
 for(const id of ['one','two','three'])store.put('note',{id,content:id});
 store.put('note',{id:'one',content:'updated oldest'});
 assert.deepEqual(ids(store.list('note')),['three','two','one']);
 assert.deepEqual(ids(store.list('note',{limit:1,offset:1})),['two']);
 assert.throws(()=>store.list('note',{offset:-1}),e=>e.status===400);
 assert.throws(()=>store.list('note',{limit:0}),e=>e.status===400);
 const memory=store.memory('oldsearchmarker');
 store.put('memory',{...memory,content:'newsearchmarker'});
 assert.deepEqual(store.search('memory','oldsearchmarker'),[]);
 assert.deepEqual(ids(store.search('memory','newsearchmarker')),[memory.id]);
 for(const id of ['remove-session','keep-session']){
  sessions.create({id,kind:'worker'});
  sessions.append(id,'assistant',{content:'transcriptmarker'});
  sessions.putEvidence(`${id}-evidence`,id,1,'read','evidence');
  sessions.enqueue(id,{id:`${id}-pending`,text:'input',at});
 }
 sessions.remove('remove-session');
 assert.equal(sessions.get('remove-session'),null);
 assert.deepEqual(sessions.entries('remove-session'),[]);
 assert.equal(sessions.evidence('remove-session-evidence'),null);
 assert.deepEqual(sessions.pending('remove-session'),[]);
 assert.deepEqual(sessions.search('transcriptmarker').map(e=>e.sessionId),['keep-session']);
 assert.equal(sessions.evidence('keep-session-evidence').content,'evidence');
});

test('Rust state: a rejected second owner and repeated close never release another live lease',async t=>{
 const f=await fixture(t),first=f.store;
 first.put('job',{id:'owned-job',status:'running',revision:1});
 assert.throws(()=>f.open(),e=>e.status===409&&/already using/.test(e.message));
 assert.equal(first.get('job','owned-job').status,'running');
 first.close();
 assert.doesNotThrow(()=>first.close());
 const second=f.open();
 assert.equal(second.get('job','owned-job').status,'interrupted');
 assert.doesNotThrow(()=>first.close());
 assert.throws(()=>f.open(),e=>e.status===409);
 second.value('still-open',{valid:true});
 assert.deepEqual(second.value('still-open'),{valid:true});
 second.close();
 assert.doesNotThrow(()=>second.close());
});

test('Rust state: live callbacks preserve shallow values and undefined patches erase stored flags',async t=>{
 const {store}=await fixture(t),sessions=new SessionStore(store),nested={answer:42};
 assert.equal(store.value('same-reference',nested),nested);
 const doc={id:'same-reference',nested};assert.equal(store.put('note',doc),doc);
 sessions.create({id:'live',kind:'main'});
 let broadcast;store.listeners.add(event=>{if(event.type==='session.entry')broadcast=event.data.entry;});
 const entry=sessions.append('live','input',{text:'hi',nested,optional:undefined,flag:true});
 assert.equal(entry.nested,nested);assert.equal(broadcast,entry);assert.equal(Object.hasOwn(entry,'optional'),true);
 const patched=sessions.patch('live',entry.seq,{flag:undefined,nested});
 assert.equal(patched.nested,nested);assert.equal(Object.hasOwn(patched,'flag'),true);assert.equal(patched.flag,undefined);
 assert.equal(Object.hasOwn(sessions.entry('live',entry.seq),'flag'),false);
});

test('Rust state: large unconfirmed imports do not truncate recall or widen cloud sharing',async t=>{
 const {store}=await fixture(t);
 for(let i=0;i<150;i++)store.put('memory',{id:`unconfirmed-${i}`,content:'sharedneedle',confirmed:false,scope:'shared'});
 store.put('memory',{id:'private-confirmed',content:'sharedneedle',confirmed:true,scope:'private'});
 store.put('memory',{id:'shared-confirmed',content:'sharedneedle',confirmed:true,scope:'shared'});
 assert.deepEqual(new Set(ids(store.recall('sharedneedle'))),new Set(['private-confirmed','shared-confirmed']));
 assert.deepEqual(store.recall('sharedneedle',{cloud:true,share:false}),[]);
 assert.deepEqual(ids(store.recall('sharedneedle',{cloud:true,share:true})),['shared-confirmed']);
 assert.equal(store.recall('sharedneedle',{limit:1}).length,1);
 assert.deepEqual(ids(store.search('memory','sharedneedle',{limit:1,filter:d=>d.id==='shared-confirmed'})),['shared-confirmed']);
});

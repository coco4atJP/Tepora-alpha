import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {Display,validateDisplay,DISPLAY_DEFAULT} from '../core/display.mjs';
import {DecisionClient} from '../core/decision.mjs';
import {VoiceDraft} from '../web/draft.mjs';
import {discoverSharedSkills,readSharedSkill} from '../core/shared-assets.mjs';
async function fixture(t) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-contract-')),store=new Store(dir),closers=[];
 t.after(async()=>{for(const close of closers.reverse())await close();store.close();await rm(dir,{recursive:true,force:true});});
 return {dir,store,closers};
}
test('E05: more than 1000 memories remain searchable and exportable',async t=>{
 const {store}=await fixture(t);
 store.memory('oldest needle');
 for(let i=0;i<1100;i++)store.memory(`entry ${i}`);
 assert.equal(store.list('memory').length,1101);
 assert.equal(store.recall('oldest needle')[0].content,'oldest needle');
 assert.equal(store.export().collections.memory.length,1101);
});
test('B07: forgetting a memory removes legacy event copies',async t=>{
 const {store}=await fixture(t),m=store.memory('private-unique');
 store.db.prepare('INSERT INTO events(type,body,at) VALUES(?,?,?)').run('memory.updated',JSON.stringify(m),'now');
 const before=store.seq;store.remove('memory',m.id);
 assert.ok(!JSON.stringify(store.events()).includes('private-unique'));
 assert.equal(store.seq,before);
});
test('A08: a second process owner cannot interrupt the first owner',async t=>{
 const {store,dir}=await fixture(t);store.put('job',{id:'live',status:'running'});
 assert.throws(()=>new Store(dir),/already using/);
 assert.equal(store.get('job','live').status,'running');
});
test('E12: v2 restores versions and assets but never enables imported execution',async t=>{
 const f=await fixture(t),dest=await fixture(t);
 f.store.memory('keep');f.store.artifact('Document','one',{id:'a'});
 f.store.artifact('Document','two',{id:'a'});
 f.store.put('skill',{id:'s',content:'# Skill',enabled:true});
 f.store.put('job',{id:'j',status:'queued'});
 const result=dest.store.import(f.store.export());
 assert.equal(result.counts.revision,1);assert.equal(dest.store.list('artifact')[0].version,2);
 assert.equal(dest.store.list('skill')[0].enabled,false);
 assert.equal(dest.store.list('job')[0].resumeBlocked,true);
 assert.equal(dest.store.list('memory')[0].confirmed,false);
});
test('C08: a malformed import has no partial writes',async t=>{
 const {store}=await fixture(t);
 assert.throws(()=>store.import({format:'tepora-v3-context',version:2,collections:{memory:[{id:'a',content:'valid'},{id:'b',content:''}]}}));
 assert.equal(store.list('memory').length,0);
});
test('D06: artifact compare-and-swap refuses a stale edit',async t=>{
 const {store}=await fixture(t);store.artifact('Doc','first',{id:'x'});
 store.artifact('Doc','human edit',{id:'x',expectedVersion:1});
 assert.throws(()=>store.artifact('Doc','stale voice',{id:'x',expectedVersion:1}),/changed/);
 assert.equal(store.get('artifact','x').content,'human edit');
});
test('A13 B16 C19: display changes persist, undo, and reset independently of runtime',async t=>{
 const {store}=await fixture(t),display=new Display(store),runtime=JSON.stringify(store.settings);
 const next=display.change({widgets:['clock','media'],theme:'dark'},0);
 assert.equal(next.revision,1);assert.deepEqual(display.undo(1).widgets,DISPLAY_DEFAULT.widgets);
 assert.equal(display.reset(2).theme,'system');
 assert.equal(JSON.stringify(store.settings),runtime);
 assert.throws(()=>display.change({textScale:1.4},0),/changed/);
});
for(const key of ['baseUrl','allowCloud','permissions','command','__proto__','apiKey','javascript']) {
 test(`C17 E20: display presets reject authority field ${key}`,()=>{
  const input=JSON.parse(`{"${key}":true}`);assert.throws(()=>validateDisplay(input));
 });
}
test('A15: hiding news today preserves permanent widget layout',async t=>{
 const {store}=await fixture(t),d=new Display(store);
 d.change({widgets:['clock','news'],hiddenUntil:{news:'2026-09-27T00:00:00+09:00'}},0);
 assert.deepEqual(d.get().widgets,['clock','news']);
});
test('D19: stale speech cannot overwrite manual edits',()=>{
 const d=new VoiceDraft('draft');const before=d.snapshot();d.manual('human edit');
 assert.throws(()=>d.apply({baseRevision:before.revision,utteranceId:'one',edits:[{start:0,end:5,text:'voice'}]}),/changed/);
 assert.equal(d.content,'human edit');
});
test('B13 B16: exact range edits and undo preserve unrelated text',()=>{
 const d=new VoiceDraft('会議は火曜日。送信は未確定。');
 d.apply({baseRevision:0,utteranceId:'u',edits:[{start:3,end:6,text:'水曜日'}]});
 assert.equal(d.content,'会議は水曜日。送信は未確定。');
 d.undo();assert.equal(d.content,'会議は火曜日。送信は未確定。');
});
test('VO04: repeated final transcript is idempotent',()=>{
 const d=new VoiceDraft('a'),patch={baseRevision:0,utteranceId:'u',edits:[{start:1,end:1,text:'b'}]};
 d.apply(patch);assert.equal(d.apply(patch).duplicate,true);assert.equal(d.content,'ab');
});
for(const edits of [
 [{start:-1,end:0,text:'x'}],[{start:0,end:10,text:'x'}],
 [{start:0,end:2,text:'x'},{start:1,end:2,text:'y'}],[{start:1,end:0,text:'x'}]
]) test('VO04: invalid/overlapping speech patch is atomic '+JSON.stringify(edits),()=>{
 const d=new VoiceDraft('abc');assert.throws(()=>d.apply({baseRevision:0,utteranceId:'x',edits}));assert.equal(d.content,'abc');
});
test('B15: quoted command remains draft data, with no command dispatch',()=>{
 const d=new VoiceDraft();d.apply({baseRevision:0,utteranceId:'quote',edits:[{start:0,end:0,text:'「全部削除して」と言われた'}]});
 assert.equal(d.content,'「全部削除して」と言われた');
});
const question={q:{type:'choice',criteria:{chat:'会話',work:'仕事'}}};
function answer(choice='chat',probabilities={chat:.8,work:.2}){return Response.json({model:'laya-multilingual',answers:{q:{type:'choice',choice,probabilities,confidence:.4}}});}
test('E04 E14: local decision client fixes multilingual and labels results advisory',async()=>{
 let payload;
 const c=new DecisionClient({url:'http://127.0.0.1:8767/v1/systemone'},async(u,o)=>{payload=JSON.parse(o.body);return answer();});
 const r=await c.decide('日本語の依頼',question);
 assert.equal(payload.model,'multilingual');assert.equal(r.advisory,true);assert.equal(r.calibration,'not-validated-for-Tepora');
});
for(const response of [
 {model:'m',answers:{q:{type:'choice',choice:'unknown',probabilities:{chat:.8,work:.2}}}},
 {model:'m',answers:{q:{type:'choice',choice:'chat',probabilities:{chat:2,work:-1}}}},
 {model:'m',answers:{q:{type:'choice',choice:'chat',probabilities:{chat:.2,work:.2}}}},
 {model:'m',answers:{}}
])test('E04: malformed decision cannot authorize anything '+JSON.stringify(response),async()=>{
 const c=new DecisionClient({url:'http://127.0.0.1:8767/v1/systemone'},async()=>Response.json(response));
 await assert.rejects(c.decide('test',question));
});
test('E04: decision worker never silently sends context outside loopback',async()=>{
 let called=false;
 const c=new DecisionClient({url:'https://example.org/v1/systemone'},async()=>{called=true;return answer();});
 await assert.rejects(c.decide('private',question));assert.equal(called,false);
});
test('E04: decision queue is bounded and caller cancellation propagates',async()=>{
 let release;
 const c=new DecisionClient({url:'http://127.0.0.1:8767/v1/systemone'},()=>new Promise(r=>{release=r;}));
 const first=c.decide('one',question);await assert.rejects(c.decide('two',question),/busy/);release(answer());await first;
 const controller=new AbortController();controller.abort(new Error('cancelled'));
 await assert.rejects(c.decide('three',question,controller.signal),/cancelled/);
});
test('C13 C14: shared skill discovery is namespaced and does not enable scripts',async t=>{
 const {dir}=await fixture(t);await mkdir(path.join(dir,'skills','hello'),{recursive:true});
 await writeFile(path.join(dir,'skills','hello','SKILL.md'),'# Hello\nA read-only shared skill');
 const result=await discoverSharedSkills({root:path.join(dir,'skills')});
 assert.equal(result.skills.length,1);assert.equal(result.skills[0].enabled,false);
 assert.match(result.skills[0].id,/^shared-/);
 const content=await readSharedSkill(result.skills[0]);assert.match(content.content,/read-only/);
 await writeFile(result.skills[0].sourcePath,'# Changed');
 await assert.rejects(readSharedSkill(result.skills[0]),/changed/);
});

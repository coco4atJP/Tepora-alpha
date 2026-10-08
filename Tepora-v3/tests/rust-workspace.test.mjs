import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NativeState} from '../core/native-state.mjs';
import {DEFAULT_SETTINGS} from '../core/policy.mjs';
import {indexedText} from '../core/search.mjs';
import {WorkspaceOracle} from './helpers/workspace-oracle.mjs';

const at='2026-10-07T00:00:00.000Z';
const kinds=['memory','artifact','revision','skill','job','message','checkpoint','effect','asset','note','evidence','routine','plan'];
const bundle=collections=>({format:'tepora-v3-context',version:2,collections});
async function fixture(t,Class=Store) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-rust-workspace-')),store=new Class(dir);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 return store;
}
function stable(value) {
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,value])=>[key,['createdAt','updatedAt','importedAt','exportedAt','at'].includes(key)&&typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)?at:stable(value)]));
 return value;
}
function normalize(store,value) {
 const replacements=new Map();
 for(const kind of [...kinds,'dialogue-archive'])for(const [i,doc] of store.list(kind).entries())if(!replacements.has(doc.id))replacements.set(doc.id,`${kind}/${i}`);
 function rewrite(value) {
  if(typeof value==='string')return replacements.get(value)??value;
  if(Array.isArray(value))return value.map(rewrite);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,value])=>[replacements.get(key)??key,rewrite(value)]));
  return value;
 }
 return stable(rewrite(value));
}
function comparableMemory(doc){const {id,createdAt,...rest}=doc;return rest;}
function readTerms(store,kind,id){return store.db.prepare('SELECT terms FROM content_search WHERE kind=? AND id=?').get(kind,id).terms;}

// The oracle below is the original JS domain, frozen before this migration. It
// uses the same already-migrated Rust SQLite layer, isolating domain differences.
test('Rust workspace: memory facade matches source defaults, UTF-16 slicing, trimming and listener identity',async t=>{
 const native=await fixture(t),oracle=await fixture(t,WorkspaceOracle);
 const values=[
  ['  茶会 ＡＢＣ ΟΣ café \ufeff ',{}],
  ['x',{source:{custom:true},confirmed:0,scope:'other',title:'a'+'🦊'.repeat(80)}],
  ['\ud800 \ue000\ue100 \udfff',{title:['a','b'],scope:'shared',confirmed:false}],
  ['\u0085',{}],
  ['x',{source:null,confirmed:null,title:''}]
 ];
 for(const [content,options] of values){
  const actual=native.memory(content,options),expected=oracle.memory(content,options);
  assert.deepEqual(comparableMemory(actual),comparableMemory(expected));
  assert.equal(readTerms(native,'memory',actual.id),readTerms(oracle,'memory',expected.id));
  assert.match(actual.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(actual.createdAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
 }
 const seen=[];const fail=()=>{throw Error('listener closes')};native.listeners.add(fail);
 native.listeners.add(event=>{event.data.observed=true;seen.push(event);});
 const result=native.memory('identity');
 assert.equal(seen[0].data,result);assert.equal(result.observed,true);assert.equal(native.listeners.has(fail),false);
 assert.equal(native.get('memory',result.id).observed,undefined);
});

test('Rust workspace: invalid memory/artifact inputs preserve validation and leave no state',async t=>{
 const native=await fixture(t),oracle=await fixture(t,WorkspaceOracle);
 const cases=[
  s=>s.memory(''),s=>s.memory('\ufeff\u2000'),s=>s.memory('🦊'.repeat(16001)),s=>s.memory(1),s=>s.memory('',{title:null}),s=>s.memory('x',{title:null}),s=>s.memory('x',{title:2}),
  s=>s.artifact('x',''),s=>s.artifact('🦊'.repeat(81),'body'),s=>s.artifact('x','x',{kind:'script'}),
  s=>s.artifact('x','x',{id:'🦊'.repeat(151)}),s=>s.artifact('x','x',{expectedVersion:1}),
 ];
 for(const f of cases){let a,b;try{f(native);}catch(e){a=e;}try{f(oracle);}catch(e){b=e;}
  assert.ok(a);assert.ok(b);assert.equal(a.message,b.message);assert.equal(a.status,b.status);
 }
 assert.equal(native.seq,0);assert.deepEqual(native.list('memory'),[]);assert.deepEqual(native.list('artifact'),[]);
});

test('Rust workspace: native artifact domain keeps whitespace, arbitrary revisions, CAS and events',async t=>{
 const native=await fixture(t),oracle=await fixture(t,WorkspaceOracle);
 for(const store of [native,oracle]){
  store.artifact(' title ',' first ',{id:'a',kind:'text',jobId:'j'});
  const doc=store.get('artifact','a');doc.future={keep:true};store.put('artifact',doc);
  store.artifact('next',' second ',{id:'a',kind:'markdown',expectedVersion:1});
 }
 assert.deepEqual(stable(native.list('artifact')),stable(oracle.list('artifact')));
 assert.deepEqual(stable(native.list('revision')),stable(oracle.list('revision')));
 assert.deepEqual(stable(native.events()),stable(oracle.events()));
 const before=native.seq;
 assert.throws(()=>native.artifact('stale','bad',{id:'a',expectedVersion:1}),e=>e.status===409);
 assert.equal(native.seq,before);assert.equal(native.get('revision','a:1').future.keep,true);
});

test('Rust workspace: snapshot defaults, settings spreads and complete export match JS source',async t=>{
 const native=await fixture(t),oracle=await fixture(t,WorkspaceOracle);
 for(const store of [native,oracle]){
  store.settings={companion:'保存',future:{arbitrary:true},allowCloud:false};
  store.value('display',{revision:12,unknown:[1]});
  store.put('skill',{id:'shared',name:'Shared',source:'shared',sourcePath:'/shared',sha256:'hash',content:'must stay reference'});
  store.put('skill',{id:'missing',source:'shared'});
  store.put('skill',{id:'local',name:'Local',content:'body',future:3});
  for(const kind of kinds.filter(k=>k!=='skill'))store.put(kind,{id:kind,content:'body',future:{preserved:[true,null]}});
  store.put('dialogue-message',{id:'first',role:'user',content:'older'});store.put('dialogue-message',{id:'second',role:'assistant',content:'newer'});
  store.value('dialogue-session',{id:'session',grant:'local'});store.value('dialogue-personas',{character:{name:'person'}});
  store.put('worker-question',{id:'question',future:'keep'});store.put('dialogue-archive',{id:'archive',messages:[]});
  store.put('mcp',{id:'mcp',enabled:true});
 }
 assert.deepEqual(native.snapshot(),oracle.snapshot());
 assert.equal(JSON.stringify(native.snapshot()),JSON.stringify(oracle.snapshot()));
 assert.deepEqual(stable(native.export()),stable(oracle.export()));
 assert.equal(JSON.stringify(stable(native.export())),JSON.stringify(stable(oracle.export())));
 assert.deepEqual(native.db.call('store.settings').value,native.settings);
 const blank=new NativeState(':memory:');try{assert.deepEqual(blank.call('store.settings').value,DEFAULT_SETTINGS);}finally{blank.close();}
 const exported=native.export();assert.equal(exported.memories,exported.collections.memory);assert.equal(exported.artifacts,exported.collections.artifact);assert.equal(exported.skills,exported.collections.skill);
 for(const setting of [null,false,7,['a','b'],'a🦊\ud800\ue000']){
  native.settings=setting;oracle.settings=setting;
  assert.deepEqual(native.snapshot().settings,oracle.snapshot().settings);
 }
});

test('Rust workspace: imports preserve unknown fields, remap each collection and revoke imported authority',async t=>{
 const native=await fixture(t),oracle=await fixture(t,WorkspaceOracle);
 const collections={
  memory:[{id:'same',content:' original whitespace ',confirmed:true,scope:'shared',future:{grant:'data'}}],
  artifact:[{id:'same',content:'v2',kind:'text',title:'a',version:2,jobId:'same',future:[1]}],
  revision:[{id:'previous',content:'v1',kind:'text',title:'a',version:1,artifactId:'same',jobId:'same'}],
  skill:[{id:'same',content:'skill',source:'shared',enabled:true,future:1}],
  job:[{id:'same',status:'running',approval:{approved:true},characterSessionId:'live',dialogueSequence:7,pendingQuestionId:'question',future:{keep:'yes'}}],
  message:[{id:'same',content:'message',jobId:'same',artifactId:'same'}],
  checkpoint:[{id:'same',future:'checkpoint'}],effect:[{id:'same',jobId:'same',future:'effect'}],
  asset:[{id:'same',artifactId:'missing',future:'asset'}],note:[{id:'same',jobId:'missing',future:'note'}],evidence:[{id:'same',jobId:0,future:'evidence'}],
  routine:[{id:'same',lastJobId:'same',enabled:true,status:'enabled',runtime:{live:true},destination:'remote',nextAt:1}],
  plan:[{id:'same',status:'active',jobs:{same:true},runtime:'live',destination:'remote'}]
 };
 const input={...bundle(collections),display:{theme:'unsafe'},settings:{allowCloud:true},dialogueArchive:{version:1,session:{id:'old-session'},messages:[{role:'user',content:' keep ',kind:12,at:false,jobId:'same',sourceQuestionId:'question',grant:'drop'}],personas:{character:{name:' Person ',instructions:' text ',authority:'drop'}},questions:[{id:'live',grant:'drop'}],archives:[{sourceSessionId:'prior',messages:[{role:'tool',content:'old',jobId:12,sourceJobId:'fallback-ignored'}]}]}};
 let a,b;
 for(const store of [native,oracle]){store.settings={allowCloud:false};store.value('display',{keep:true});const result=store.import(input);if(store===native)a=result;else b=result;}
 assert.deepEqual(normalize(native,a),normalize(oracle,b));
 assert.deepEqual(normalize(native,native.export()),normalize(oracle,oracle.export()));
 assert.deepEqual(normalize(native,native.events()),normalize(oracle,oracle.events()));
 assert.equal(JSON.stringify(normalize(native,native.export())),JSON.stringify(normalize(oracle,oracle.export())));
 assert.equal(native.get('job','same'),null);assert.equal(native.value('dialogue-session'),null);
 assert.equal(native.value('display').keep,true);assert.equal(native.settings.allowCloud,false);
 assert.equal(native.events()[0].data.seq,0);assert.equal(native.events()[0].seq,1);
 assert.equal(native.list('checkpoint')[0].id,native.list('job')[0].id);
 assert.equal(native.list('routine')[0].lastJobId,native.list('job')[0].id);
 assert.equal(native.list('dialogue-archive').length,2);
});

test('Rust workspace: legacy and missing import IDs match source truthiness and reference coercion',async t=>{
 for(const input of [
  {format:'tepora-v3-context',version:1,memories:[{content:'legacy',future:1}],artifacts:[{content:'ignored'}]},
  bundle({memory:[{id:0,content:'zero'},{id:'',content:'empty'},{id:null,content:'null'},{content:'missing'}],note:[{id:'object',jobId:['job']}],job:[{id:'job'}],revision:[{content:'body',title:'title',kind:'text',version:1}]}),
  bundle({memory:false,artifact:0,skill:'',note:null}),
 ]){
  const native=await fixture(t),oracle=await fixture(t,WorkspaceOracle);
  assert.deepEqual(normalize(native,native.import(input)),normalize(oracle,oracle.import(input)));
  assert.deepEqual(normalize(native,native.export()),normalize(oracle,oracle.export()));
 }
});

test('Rust workspace: all import validation happens before writes, including archives and references',async t=>{
 const native=await fixture(t),oracle=await fixture(t,WorkspaceOracle);
 const bad=[null,{}, {format:'tepora-v3-context',version:'2',collections:{}},bundle([]),
  bundle({memory:[null]}),bundle({memory:[[]]}),bundle({memory:[{id:1,content:'a'}]}),bundle({memory:[{id:'x',content:'a'},{id:'x',content:'b'}]}),
  bundle({memory:[{content:''}]}),bundle({artifact:[{content:'a',title:'a',kind:'script',version:1}]}),bundle({artifact:[{content:'a',title:'a',kind:'text',version:1.5}]}),
  bundle({routine:[{id:'r',lastJobId:7}]}),bundle({note:{}}),
  {...bundle({}),dialogueArchive:{version:1,messages:[{role:'bad',content:'x'}]}},
  {...bundle({}),dialogueArchive:{version:1,messages:[{role:'user',content:''}]}},
  {...bundle({}),dialogueArchive:{version:1,messages:[],personas:{character:{name:''}}}},
  {...bundle({}),dialogueArchive:{version:1,messages:[],archives:[{messages:null}]}},
 ];
 for(const input of bad){let actual,expected;try{native.import(input);}catch(e){actual=e;}try{oracle.import(input);}catch(e){expected=e;}
  assert.ok(actual,JSON.stringify(input));assert.ok(expected,JSON.stringify(input));assert.equal(actual.message,expected.message);assert.equal(actual.status,expected.status);
 }
 assert.equal(native.seq,0);assert.equal(native.export().memories.length,0);
});

test('Rust workspace: injected document/event failures roll back complete domain and search state',async t=>{
 const store=await fixture(t);const memory=store.memory('existing');const before=store.seq;
 store.db.exec("CREATE TRIGGER reject_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected event failure'); END;");
 for(const run of [()=>store.memory('rollbackmarker'),()=>store.artifact('title','content',{id:'a'}),()=>store.import(bundle({memory:[{content:'rollbackmarker'}]}))])assert.throws(run,/injected event failure/);
 assert.deepEqual(store.list('memory'),[memory]);assert.deepEqual(store.list('artifact'),[]);assert.deepEqual(store.search('memory','rollbackmarker'),[]);assert.equal(store.seq,before);
 store.db.exec('DROP TRIGGER reject_events; BEGIN IMMEDIATE');store.memory('outerrollback');store.import(bundle({note:[{id:'n'}]}));store.db.exec('ROLLBACK');
 assert.deepEqual(store.list('memory'),[memory]);assert.deepEqual(store.list('note'),[]);assert.equal(store.seq,before);
});

test('Rust workspace: native patch/delete retain fields, ignore grants, clean vectors/events and reindex',async t=>{
 const store=await fixture(t);const doc=store.memory('oldmarker');store.put('memory',{...doc,future:{preserve:true}});store.put('memory-vector',{id:doc.id,vector:[1]});
 const patched=store.db.call('store.memoryPatch',{id:doc.id,patch:{content:' newmarker ',title:'new',confirmed:false,scope:'shared',source:'unsafe',grant:true}});
 assert.equal(patched.value.source,'user');assert.equal(patched.value.grant,undefined);assert.equal(patched.value.future.preserve,true);
 assert.equal(patched.value.content,'newmarker');assert.deepEqual(store.search('memory','oldmarker'),[]);assert.equal(store.search('memory','newmarker').length,1);
 for(const patch of [{title:1},{title:'a'.repeat(161)},{confirmed:1},{scope:'external'},{content:' '}])assert.throws(()=>store.db.call('store.memoryPatch',{id:doc.id,patch}),e=>e.status===400);
 const deleted=store.db.call('store.memoryDelete',{id:doc.id});assert.deepEqual(deleted.value,{deleted:true});assert.equal(deleted.events[0].type,'memory.deleted');
 assert.equal(store.get('memory-vector',doc.id),null);assert.deepEqual(store.events().map(e=>e.type),['memory.deleted']);assert.equal(store.get('memory',doc.id),null);
 assert.throws(()=>store.db.call('store.memoryDelete',{id:doc.id}),e=>e.status===404);
});

test('Rust workspace: full import/search indexing matches Unicode oracle and never truncates exports',async t=>{
 const store=await fixture(t);
 const texts=['ＡＢＣ ﬁ Ⅷ café e\u0301 ΟΣ I İ ı','漢字ひらがなカタカナabc茶会１２３','가 \u{323b0}a \ud800literal\ue000\ue100','\u{11f04} \u{1c89} \u{1e6c0}',...Array.from({length:35},(_,n)=>`row${n} ${String.fromCodePoint(0x10000+n*1373)} mixed_123`)];
 for(const [index,content] of texts.entries()){
  const doc={id:`j${index}`,content,title:['prefix',null,2],input:{data:'value'},output:false};store.import(bundle({job:[doc]}));
  const imported=store.list('job')[0];assert.equal(readTerms(store,'job',imported.id),indexedText(imported),content);
 }
 const memories=Array.from({length:1100},(_,n)=>({id:`m${n}`,content:`entry ${n}`}));store.import(bundle({memory:memories}));
 assert.equal(store.export().memories.length,1100);assert.equal(store.search('memory','entry').length,20);
 const terms='漢'.repeat(32000);const long=store.memory(terms);assert.equal(readTerms(store,'memory',long.id),indexedText(long));
});


test('Rust workspace: collection, archive and UTF-16 import bounds reject atomically',async t=>{
 const store=await fixture(t);
 const bad=[
  bundle({note:Array(100001).fill({})}),
  bundle({memory:[{content:'a'.repeat(32001)}]}),
  bundle({artifact:[{content:'a'.repeat(200001),title:'a',kind:'text',version:1}]}),
  bundle({artifact:[{content:'a',title:'a',kind:'text',version:Number.MAX_SAFE_INTEGER+1}]}),
  {...bundle({}),dialogueArchive:{version:1,messages:[],archives:Array(1001).fill({messages:[]})}},
  {...bundle({}),dialogueArchive:{version:1,messages:Array(100001).fill({role:'user',content:'x'})}},
  {...bundle({}),dialogueArchive:{version:1,messages:[{role:'user',content:'a'.repeat(100001)}]}},
 ];
 for(const input of bad)assert.throws(()=>store.import(input),e=>e.status===400);
 assert.equal(store.seq,0);assert.equal(store.export().memories.length,0);
});

test('Rust workspace: indexing agrees with JS across every Unicode code point',()=>{
 const db=new NativeState(':memory:');
 try{
  // Separating each scalar also covers lone UTF-16 surrogates. Batching stays
  // below normal memory limits; no providers, external data or files are used.
  for(let start=0;start<0x110000;start+=2048){
   const chars=[];for(let cp=start;cp<Math.min(start+2048,0x110000);cp++)chars.push(String.fromCodePoint(cp));
   const doc=db.call('store.memory',{content:chars.join(' '),unicodeVersion:process.versions.unicode}).value;
   const terms=db.prepare('SELECT terms FROM content_search WHERE kind=? AND id=?').get('memory',doc.id).terms;
   assert.equal(terms,indexedText(doc),`Unicode batch U+${start.toString(16)}`);
  }
 }finally{db.close();}
});

/** Differential projection contracts against the frozen stage4 JavaScript
 * oracle. All facts are local fixtures; no models, browsers or external I/O. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as current from '../core/agent/ui-model.mjs';
import * as baseline from './helpers/rust-baseline/ui-model.mjs';
import {nativeCompute} from '../core/native-state.mjs';
import {Store} from '../core/store.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';

const clone=structuredClone;
const equal=(actual,expected,label)=>{
 assert.deepEqual(actual,expected,label);
 assert.equal(JSON.stringify(actual),JSON.stringify(expected),label+': wire bytes/key order');
};
const wire=value=>JSON.parse(JSON.stringify(value));
const main={id:'main',kind:'main',status:'idle',title:'住人',stats:{steps:0},note:''};
const worker={id:'worker',kind:'worker',status:'running',title:'調査 🦊',task:'調べる',parentId:'main',cwd:'/fixture',stats:{steps:3},note:'working',createdAt:'created'};

function fixture(Module,{sessions=[worker,main],approvals=[],entries=[],personas={revision:2,character:{name:'住人',voice:{pack:'polite'}},worker:{name:'Worker'}},settings={sandbox:{mode:'off'}},usage={today:null,days:{'2026-10-07':null}}}={}){
 const rows=clone(sessions),pending=clone(approvals),transcript=clone(entries),events=[];
 let seq=0,clock=0;
 const store={listeners:new Set(),list(kind){assert.equal(kind,'approval');return clone(pending);},
  emit(type,data){const event={seq:++seq,type,data,at:'event-'+(++clock)};for(const fn of this.listeners){try{fn(event);}catch{this.listeners.delete(fn);}}return event;},
  broadcast(type,data){for(const fn of this.listeners){try{fn({seq:null,type,data,at:'event-'+(++clock)});}catch{this.listeners.delete(fn);}}}};
 const rt={sessions:{list({kind}={}){return clone(rows.filter(s=>!kind||s.kind===kind));},tail(id,limit=50){assert.equal(id,rows.find(s=>s.kind==='main')?.id);return clone(limit<0?transcript:limit===0?[]:transcript.slice(-limit));}},
  main(){let s=rows.find(s=>s.kind==='main');if(!s){s=clone(main);rows.push(s);}return clone(s);},personas(){return clone(personas);},settings(){return clone(settings);},usage(){return clone(usage);}};
 const before=[];store.listeners.add(e=>before.push(clone(e)));
 const ui=new Module.AgentUIModel(store,rt);store.listeners.add(e=>events.push(clone(e)));
 return {ui,store,rt,rows,pending,transcript,events,before};
}

test('Rust projection: status precedence, fallback truthiness and public undefined own properties match',()=>{
 const statuses=[undefined,null,'running','waiting','idle','done','stopped','future'];
 const notes=[undefined,'','承認待ち: exec','空きを待っています','空きを待って 承認待ち',[false,'承認待ち'],{},false];
 for(const status of statuses)for(const note of notes)for(const accepted of [undefined,false,true,0,[],{}]){
  const session={...worker,status,note,accepted};
  equal(current.jobStatus(session),baseline.jobStatus(session),'job status');
  equal(current.jobOf(session,{approvals:2}),baseline.jobOf(session,{approvals:2}),'job projection');
 }
 for(const session of [{},{id:undefined,status:undefined,createdAt:null},{task:'a'.repeat(59)+'🦀tail'},
  {task:'\uE000'.repeat(59)+'🦀tail'},{title:[],stats:{steps:[]},result:{text:'future'},todo:{future:true},route:{}},
  {task:['array','slice'],depth:false,note:0,finishedAt:false,retryAt:0,stats:[]},
  {id:'x',stats:{steps:4,future:undefined},route:{profileId:'p',model:undefined},todo:[{text:'one',future:undefined}]}]){
  equal(current.jobOf(session),baseline.jobOf(session),'sparse/legacy job');
  assert.deepEqual(Object.keys(current.jobOf(session)),Object.keys(baseline.jobOf(session)));
 }
 for(const task of [true,10,{}]){assert.throws(()=>current.jobOf({task}));assert.throws(()=>baseline.jobOf({task}));}
});

test('Rust projection: approval shape, optional properties and borrowed argument references match',()=>{
 for(const approval of [{},{id:'a',sessionId:'w',tool:'exec',args:{command:'echo hello'},status:'pending',createdAt:'now'},
  {id:null,sessionTitle:[],args:{nested:undefined},note:0,decidedAt:false}]){
  equal(current.approvalOf(approval),baseline.approvalOf(approval),'approval');
  assert.equal(current.approvalOf(approval).args,approval.args);
 }
});

test('Rust projection: input/report/voice/hidden message branches preserve their distinct schemas',()=>{
 const titles=new Map([['worker','Worker from map'],['other','Other']]);
 for(const kind of [undefined,'message','report','heartbeat','event','reminder'])for(const passive of [undefined,false,true,0,[]])for(const from of [undefined,'user','voice','voice:microphone','timer','system','schedule','child:worker','other']){
  const entry={seq:2,type:'input',text:'入力 \ud83e',kind,passive,from,sessionId:'worker',at:'now',status:'done'};
  equal(current.messageOf(entry,main,{titles}),baseline.messageOf(entry,main,{titles}),'input branch');
 }
 for(const entry of [{type:'input'},{type:'input',seq:null,text:null},
  {type:'input',seq:1,text:{value:undefined},kind:'report',title:[],sessionId:'worker',status:'stuck'},
  {type:'input',seq:3,text:'report',from:'child:worker',source:'ignored'},
  {type:'input',seq:4,text:'report',kind:'report',passive:true,sessionId:'missing',status:'future'},
  {type:'input',seq:5,text:'direct',source:[]},{type:'event',content:'hidden'},{type:'notice',text:'hidden'}]){
  equal(current.messageOf(entry,{}, {titles}),baseline.messageOf(entry,{}, {titles}),'sparse message');
 }
 for(const from of [true,1,[],{}]){assert.throws(()=>current.messageOf({type:'input',from},main));assert.throws(()=>baseline.messageOf({type:'input',from},main));}
});

test('Rust projection: assistant coercion, JS whitespace, NO_REPLY boundaries, Unicode and delegated counts match',()=>{
 const contents=[undefined,null,false,0,true,14,1e21,[],[null,1,'two'],{},'', ' hello ', '\uFEFF\u00A0\u2028hello\u3000',
  '\u0085hello\u0085','NO_REPLY','no_reply!more','「**NO_REPLY」later','（[【<\t\nNO_REPLY','NO_REPLYING','NO_REPLY_1','NO_REPLY0','NO_REPLY日',
  '\u0085NO_REPLY','quoted NO_REPLY',' \ud83e ','\uE000\uE13e\ud800','🦊'];
 for(const content of contents)for(const withdrawn of [undefined,false,true,[],0])for(const truncated of [undefined,false,true,0,[]]){
  const entry={seq:3,type:'assistant',content,withdrawn,truncated,toolCalls:[{name:'sessions_spawn'},{name:'read'},{name:'sessions_spawn'}],at:'now'};
  equal(current.messageOf(entry,main),baseline.messageOf(entry,main),'assistant coercion/suppression');
 }
 for(const toolCalls of [undefined,null,false,0,[],[{name:'read'}]]){
  equal(current.messageOf({type:'assistant',content:'yes',toolCalls},{}),baseline.messageOf({type:'assistant',content:'yes',toolCalls},{}),'optional calls');
 }
 for(const toolCalls of [{},true,1,[null]]){assert.throws(()=>current.messageOf({type:'assistant',content:'yes',toolCalls},main));assert.throws(()=>baseline.messageOf({type:'assistant',content:'yes',toolCalls},main));}
});

test('Rust projection: continuation merging retains first seq/metadata, last id/at, identity and split pairs',()=>{
 const cases=[[],[{role:'user',content:'keep',extra:undefined}],
  [{role:'assistant',id:'a',seq:1,content:'one',truncated:true,delegated:2,extra:{keep:true}}, {role:'assistant',id:'b',seq:2,content:'two',truncated:true,delegated:0},{role:'assistant',id:'c',seq:3,content:'three',at:'last'}],
  [{role:'assistant',content:'\ud83e',truncated:true},{role:'assistant',content:'\udd80'}],
  [{role:'assistant',id:'old',at:'old',content:'old',truncated:true},{role:'assistant',content:'next',id:undefined,at:undefined}],
  [{role:'assistant',content:'first',truncated:true},{role:'user',content:'interruption'},{role:'assistant',content:'later'}],
  [{role:'assistant',content:'a',truncated:[]},{role:'assistant',content:12}],
 ];
 for(const messages of cases){
  const before=clone(messages),actual=current.mergeContinuations(messages),expected=baseline.mergeContinuations(messages);
  equal(actual,expected,'continuations');equal(messages,before,'input unchanged');
  if(messages.length===1)assert.equal(actual[0],messages[0]);
 }
 const raw=[{role:'assistant',content:'\ud83e',truncated:true},{role:'assistant',content:'\udd80'}];
 equal(nativeCompute('ui.merge',{messages:raw}),wire(baseline.mergeContinuations(raw)),'pure JSON merge');
});

test('Rust projection: dialogue tails raw entries before filtering and merging, including zero/negative limits',()=>{
 const entries=[{seq:1,type:'input',text:'first',from:'user'},
  {seq:2,type:'assistant',content:'part one',truncated:true,toolCalls:[{name:'sessions_spawn'}]},
  {seq:3,type:'notice',text:'hidden'}, {seq:4,type:'assistant',content:'part two',truncated:false},
  {seq:5,type:'input',text:'report',kind:'report',sessionId:'worker',status:'done'},
  {seq:6,type:'assistant',content:'NO_REPLY'}, {seq:7,type:'input',text:'hidden',passive:true},
  {seq:8,type:'tool',content:'hidden'},{seq:9,type:'checkpoint',summary:'hidden'}];
 for(const limit of [0,1,2,3,4,400,-1,-2]){
  const a=fixture(current,{entries}),b=fixture(baseline,{entries});
  equal(a.ui.dialogue({limit}),b.ui.dialogue({limit}),'dialogue limit '+limit);
 }
 const visible=Array.from({length:6},(_,i)=>({seq:i+1,type:'input',from:'user',text:'visible '+i}));
 for(const limit of ['1','2','0x2',true,false,null,[1],0.5,1.5,-0.5,-1.5]){
  equal(fixture(current,{entries:visible}).ui.dialogue({limit}),fixture(baseline,{entries:visible}).ui.dialogue({limit}),'slice coercion '+JSON.stringify(limit));
 }
 const sessions=[{...main,id:'new-main',title:'new'},{...worker},{...main,id:'old-main'}];
 const a=fixture(current,{sessions,entries:[]}),b=fixture(baseline,{sessions,entries:[]});
 equal(a.ui.dialogue(),b.ui.dialogue(),'first main uses catalog order');
 equal(fixture(current,{sessions:[]}).ui.dialogue(),fixture(baseline,{sessions:[]}).ui.dialogue(),'fresh main created by host');
});

test('Rust projection: snapshots preserve specialist order, full approvals, usage, settings and undefined shapes',()=>{
 const sessions=[{...worker,id:'special',kind:'specialist',status:'idle'},worker,{...main,system:'existing main field',tools:['read']},{id:'future',kind:'future',status:'future'}];
 const approvals=Array.from({length:215},(_,i)=>({id:'a'+i,sessionId:i%2?'worker':'special',status:i%3?'pending':'approved',tool:'read',args:{path:'x'}}));
 const options={sessions,approvals,entries:[{type:'assistant',seq:1,content:'answer',at:'now'}],usage:{today:{cost:51.248178375505404},days:{'2026-10-07':{cost:51.248178375505404}}}};
 const a=fixture(current,options),b=fixture(baseline,options);
 equal(a.ui.snapshot(),b.ui.snapshot(),'aggregate snapshot');
 equal(a.ui.jobs(),b.ui.jobs(),'jobs');equal(a.ui.approvals(),b.ui.approvals(),'full approval list');
 assert.equal(a.ui.approvals().length,215);
 equal(a.ui.job(a.rt.main()),b.ui.job(b.rt.main()),'public job method accepts main too');
 const facts={main:sessions.find(s=>s.kind==='main'),personas:a.rt.personas(),sessions,entries:options.entries,approvals,settings:a.rt.settings(),usage:a.rt.usage()};
 equal(nativeCompute('ui.snapshot',facts),wire(b.ui.snapshot()),'standalone JSON projection shape');
});

test('Rust projection: live derived events precede sources, remain ephemeral and never expose reasoning',()=>{
 const options={approvals:[{id:'approval',sessionId:'worker',status:'pending',tool:'exec'}]};
 const a=fixture(current,options),b=fixture(baseline,options);
 const events=[['session.updated',worker],['session.updated',main],
  ['session.entry',{sessionId:'main',entry:{type:'input',seq:1,text:'hi',at:'now'}}],
  ['session.entry',{sessionId:'main',entry:{type:'assistant',seq:2,content:'NO_REPLY'}}],
  ['session.entry',{sessionId:'worker',entry:{type:'assistant',seq:1,content:'worker'}}],
  ['agent.delta',{sessionId:'main',text:'full current text',reasoning:'NEVER PROJECT',done:0}],
  ['agent.delta',{sessionId:'unknown',text:'worker text',reasoning:'NEVER PROJECT',done:true}],
  ['approval.updated',options.approvals[0]],['agent.event',{sessionId:'main',text:'internal'}],
  ['agent.delta',{sessionId:'main'}],['session.removed',{id:'worker'}]];
 for(const [type,data] of events){a.store.emit(type,clone(data));b.store.emit(type,clone(data));}
 equal(a.events,b.events,'observer after UI');equal(a.before,b.before,'observer before UI');
 assert.deepEqual(a.events.slice(0,2).map(e=>e.type),['job.updated','session.updated']);
 const approvalAt=a.events.findIndex(e=>e.type==='approval.view');assert.equal(a.events[approvalAt+1].type,'approval.updated');
 const derived=a.events.filter(e=>e.seq===null);assert.ok(derived.length);assert.ok(!JSON.stringify(derived).includes('NEVER PROJECT'));
 assert.ok(a.store.listeners.has(a.ui.listener),'projection listener survives ordinary events');
 a.ui.close();b.ui.close();a.store.emit('session.updated',worker);b.store.emit('session.updated',worker);equal(a.events,b.events,'close detaches only UI listener');
 const noMain=fixture(current,{sessions:[]});noMain.store.emit('agent.delta',{sessionId:'missing',text:'out'});assert.equal(noMain.events[0].type,'job.output');
});

test('Rust projection: generated snapshots preserve deterministic legacy truthiness and Unicode',()=>{
 let seed=0x21436875;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 const texts=['hello','日本語 🦊','\ud800','\uE000\uE100','NO_REPLY!','NO_REPLYING','\uFEFF trim \u3000'];
 for(let i=0;i<60;i++){
  const sessions=[{...main,status:['idle','running','waiting'][random(3)]},...Array.from({length:4},(_,n)=>({...worker,id:'w'+n,status:['running','waiting','idle','done','stopped'][random(5)],accepted:random(2)===1,note:['','承認待ち','空きを待って'][random(3)],title:texts[random(texts.length)]}))];
  const entries=Array.from({length:35},(_,n)=>{const type=['input','assistant','notice','tool'][random(4)];return {seq:n+1,type,text:texts[random(texts.length)],content:texts[random(texts.length)],from:random(3)?'user':'child:w0',kind:random(5)?'message':'report',sessionId:'w0',truncated:random(3)===0,withdrawn:random(8)===0,at:'t'+n};});
  const approvals=Array.from({length:8},(_,n)=>({id:'a'+n,sessionId:'w'+random(4),tool:'read',status:random(3)?'pending':'denied',args:{path:'file'}}));
  equal(fixture(current,{sessions,entries,approvals}).ui.snapshot(),fixture(baseline,{sessions,entries,approvals}).ui.snapshot(),'generated snapshot '+i);
 }
});

test('Rust projection: real Rust-backed state preserves legacy text and event ordering without provider effects',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-projection-')),store=new Store(dir),sessions=new SessionStore(store);
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const m=sessions.create({id:'main',kind:'main',title:'main'}),w=sessions.create({id:'worker',kind:'worker',title:'worker'});
 const rt={sessions,main:()=>sessions.get(m.id),personas:()=>({revision:0,character:{name:'Character'}}),settings:()=>({sandbox:{mode:'off'}}),usage:()=>({today:null,days:{}})};
 const ui=new current.AgentUIModel(store,rt),events=[];store.listeners.add(e=>events.push(e));t.after(()=>ui.close());
 sessions.append(m.id,'assistant',{content:'\uFEFFold \ud83e \uE000\uE13e\u3000'});
 assert.equal(ui.dialogue().messages[0].content,'old \ud83e \uE000\uE13e');
 store.put('approval',{id:'a',sessionId:w.id,status:'pending',tool:'exec'});
 sessions.update(w.id,{status:'waiting',note:'承認待ち: exec'});
 assert.deepEqual(events.slice(-2).map(e=>e.type),['job.updated','session.updated']);
 assert.equal(events.at(-2).data.pendingApprovals,1);assert.equal(events.at(-2).data.status,'waiting_approval');
 store.emit('approval.updated',store.get('approval','a'));
 assert.deepEqual(events.slice(-2).map(e=>e.type),['approval.view','approval.updated']);
 assert.equal(events.at(-2).seq,null);assert.equal(typeof events.at(-1).seq,'number');
});

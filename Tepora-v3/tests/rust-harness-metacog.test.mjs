import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCompute} from '../core/native-state.mjs';
import * as baseline from './helpers/rust-harness-oracle/metacog.mjs';
import {NOTICE} from './helpers/rust-harness-oracle/prompts.mjs';

// All fixtures are synthetic and deterministic. The historical implementation
// is test-only; production must use the native boundary without a JS fallback.
const compute=(operation,payload)=>nativeCompute('harness.metacog.'+operation,payload);
const clone=value=>structuredClone(value);
const wire=value=>JSON.parse(JSON.stringify(value));
const equal=(actual,expected,label)=>{
 const transported=wire(expected);
 assert.deepEqual(actual,transported,label);
 assert.equal(JSON.stringify(actual),JSON.stringify(transported),`${label}: exact JSON bytes and key order`);
};
const NOW=Date.parse('2026-10-07T12:34:56.789Z');
const AT=new Date(NOW).toISOString();
async function fixedClock(work){
 const OriginalDate=globalThis.Date;
 globalThis.Date=class extends OriginalDate{
  constructor(...args){super(...(args.length?args:[NOW]));}
  static now(){return NOW;}
 };
 try{return await work();}finally{globalThis.Date=OriginalDate;}
}
const calls=(length,{errors=0,repeat=0}={})=>Array.from({length},(_,i)=>({
 sig:repeat?'sig-'+i%repeat:'sig-'+i,outcome:'out-'+(repeat?i%repeat:i),label:`read(path="${i}.txt")`,error:i>=length-errors
}));
const memory=(extra={})=>({calls:[],errorStreak:0,warned:[],overflows:0,badRequests:0,empties:0,nudges:0,healthy:0,...extra});
const facts=(extra={})=>({steps:20,minutes:3,context:null,calls:12,errors:0,recentErrors:0,recentCalls:6,variety:1,todo:null,
 reflection:{step:15,confidence:0.8,assumptions:0,questions:0,age:5},model:'m',escalated:false,cost:0,team:[],...extra});
const whyAll=['context','errors','stalled','unreflected','low-confidence','interval'];
const team=[
 {id:'a',title:'running 日本語 🦊',status:'running'},
 {id:'b',title:' waiting\n for\t input ',status:'waiting'},
 {id:'c',title:'completed',status:'done'},
 {id:'d',title:'x'.repeat(39)+'🪷'+'\ud800\ue000',status:'running'},
 {id:'e',title:null,status:'waiting'},
 {id:'f',title:'stopped',status:'error'},
];
function input(session,mem,ctx={}){
 return {session,mem,...ctx,nowMs:NOW,createdAtMs:Date.parse(session.createdAt||session.created||AT),team};
}
function measured(session,mem,ctx={}){
 return baseline.selfFacts({sessions:{list:options=>{
  assert.deepEqual(options,{parentId:session.id});return team;
 }}},session,mem,ctx);
}

test('Rust metacognition: measured facts preserve defaults, time rounding, context, tools, checklist, reflection and team',async()=>{
 await fixedClock(()=>{
  const sessions=[
   {id:'empty',kind:'worker'},
   {id:'main',kind:'main',stats:{steps:18,toolCalls:14,toolErrors:5,cost:0.03125},createdAt:new Date(NOW-150_000).toISOString(),route:{model:'fallback'},role:'escalation',
    todo:[{status:'done'},{status:'blocked'},{status:'running'},{status:'todo'},{}],
    reflection:{step:7,confidence:0.4,assumptions:['a'],open_questions:['q1','q2']}},
   {id:'worker',kind:'worker',stats:{steps:0,toolCalls:0,toolErrors:0,cost:0},created:'2026-10-07T12:34:26.789Z',reflection:{}},
   {id:'missing-step',kind:'worker',stats:{steps:23,toolCalls:10},todo:[{status:'blocked'}],reflection:{confidence:0,assumptions:[],open_questions:[]}},
   {id:'nullable',kind:'main',createdAt:'',created:'2026-10-07T12:34:26.790Z',stats:null,todo:null,reflection:null,route:{model:''}},
   {id:'future',kind:'worker',createdAt:new Date(NOW+120_000).toISOString(),stats:{steps:8},reflection:{step:null,confidence:null}},
   {id:'invalid-date',kind:'worker',createdAt:'not a timestamp',stats:{steps:1}},
   {id:'legacy-arrays',kind:'worker',stats:{steps:6},reflection:{step:0,confidence:false,assumptions:'abc🪷',open_questions:{length:4}}},
  ];
  const memories=[memory(),memory({calls:calls(1)}),memory({calls:calls(6,{errors:3}),todoStep:2}),
   memory({calls:calls(12,{errors:9,repeat:2}),todoStep:0}),memory({calls:calls(7,{errors:6,repeat:1}),todoStep:null}),
   memory({calls:[{error:true},{sig:null,error:false},{sig:'',error:1},{sig:'',error:false}]})];
  const contexts=[{}, {built:{tokens:6000},B:10000,ratio:1,profile:{model:'preferred 日本語'}},
   {built:{tokens:1},B:10000,ratio:0.1},{built:{tokens:0},B:10000,ratio:2},
   {built:{tokens:100.5},B:0,ratio:3},{built:{tokens:100.5},B:12345,ratio:0,profile:{model:''}},
   {built:null,B:10000,ratio:null}, {built:{tokens:14999.5},B:9999.125,ratio:1.3}];
  for(const [s,session] of sessions.entries())for(const [m,mem] of memories.entries())for(const [c,ctx] of contexts.entries()){
   const payload=input(session,mem,ctx),before=clone(payload);
   equal(compute('selfFacts',payload),measured(session,mem,ctx),`facts ${s}/${m}/${c}`);
   assert.deepEqual(payload,before,'pure operation does not change its input');
  }
 });
});

test('Rust metacognition: every trigger threshold, gap override and remembered occasion matches the frozen JS',()=>{
 const fixtures=[
  [facts({steps:3}),{}],
  [facts({steps:3,context:{used:6000,budget:10000,share:0.6},recentErrors:3}),{selfCheckStep:2}],
  [facts({steps:4,context:{used:5999,budget:10000,share:0.5999}}),{}],
  [facts({steps:16,recentErrors:3,recentCalls:6}),{selfCheckStep:10}],
  [facts({steps:16,recentErrors:3,recentCalls:5}),{selfCheckStep:10}],
  [facts({steps:16,recentErrors:2,recentCalls:6}),{selfCheckStep:10}],
  [facts({steps:16,todo:{done:1,total:4,blocked:0,open:3,still:12}}),{selfCheckStep:5,todoStep:4}],
  [facts({steps:16,todo:{done:1,total:4,blocked:3,open:0,still:12}}),{selfCheckStep:5,todoStep:4}],
  [facts({steps:16,todo:{done:1,total:4,blocked:0,open:3,still:12}}),{selfCheckStep:5}],
  [facts({steps:12,calls:10,reflection:null}),{selfCheckStep:5}],
  [facts({steps:12,calls:9,reflection:null}),{selfCheckStep:5}],
  [facts({steps:12,reflection:{step:5,confidence:0.4999,age:5}}),{selfCheckStep:5}],
  [facts({steps:12,reflection:{step:5,confidence:0.5,age:5}}),{selfCheckStep:5}],
  [facts({steps:12,reflection:{step:5,confidence:null,age:5}}),{selfCheckStep:5}],
  [facts({steps:12,reflection:{step:5,confidence:0.3,age:4}}),{selfCheckStep:5}],
  [facts({steps:20,context:{share:0.8},recentErrors:4,todo:{open:2,still:16},reflection:{step:2,confidence:0,age:18}}),{todoStep:4}],
 ];
 for(const kind of ['main','worker',undefined])for(const every of [undefined,0,1,15,99,null,false])for(const [index,[f,initial]] of fixtures.entries()){
  const session={...(kind===undefined?{}:{kind})},mem=clone(initial),options=every===undefined?{}:{every};
  const why=baseline.selfCheckDue(session,mem,f,options);
  const actual=compute('selfCheckDue',{session,mem:initial,f,...options});
  equal(actual,{why,mem},`due ${kind}/${every}/${index}`);
  if(!why.length)continue;
  baseline.noteSelfCheck(mem,f,why);
  const noted=compute('noteSelfCheck',{mem:actual.mem,f,why});
  equal(noted,{mem},`noted ${kind}/${every}/${index}`);
  const nextFacts={...clone(f),steps:f.steps+1};
  const nextWhy=baseline.selfCheckDue(session,mem,nextFacts,options);
  equal(compute('selfCheckDue',{session,mem:noted.mem,f:nextFacts,...options}),{why:nextWhy,mem},'same occasion is suppressed');
 }
 // An undefined assignment disappears at the JSON boundary instead of becoming null.
 for(const [mem,f,why] of [[{selfCheckStalled:3},{steps:4},['stalled']],[{selfCheckLowAt:9},{steps:20,reflection:{}},['low-confidence']]]){
  const updated=clone(mem);baseline.noteSelfCheck(updated,f,why);
  equal(compute('noteSelfCheck',{mem,f,why}),{mem:updated},'undefined memory property is omitted');
 }
});

test('Rust metacognition: rendered self-check text is byte-exact including rounding, pluralization and UTF-16',()=>{
 const variants=[facts(),facts({model:null,cost:0,recentCalls:0,reflection:null}),
  facts({model:'model \ud800\ue000 日本語 🪷',escalated:true,cost:0.03125,context:{share:0.605,used:12345.6789,budget:99999.9999},
   recentErrors:5,variety:0.4,todo:{done:1,total:4,blocked:1,open:2,still:5},reflection:{step:0,confidence:null,assumptions:1,questions:1,age:20},team:['"worker 🦊" running','"等待" waiting']}),
  facts({cost:-0.03125,context:{share:0,used:0,budget:1e21},todo:{done:2,total:2,blocked:0,open:0,still:30},reflection:{confidence:0,assumptions:0,questions:2,age:0}}),
  facts({cost:1e21,context:{share:1.2345,used:999.9999,budget:0.0005},variety:0.4999,recentCalls:5}),
  facts({cost:1.23445,reflection:{confidence:false,assumptions:'1',questions:1,age:3}}),
 ];
 for(const kind of [undefined,'main','worker','other',null])for(const why of [[],whyAll,['unknown','interval'],['context','context']])for(const [i,f] of variants.entries()){
  const options=kind===undefined?{}:{kind};
  equal(compute('renderSelfCheck',{f,why,...options}),baseline.renderSelfCheck(f,why,options),`self-check text ${kind}/${i}/${why}`);
 }
});

test('Rust metacognition: reflection rendering keeps the original field order and explicit confidence values',()=>{
 const variants=[null,false,{},[],{understanding:'',plan:'',confidence:null,next:''},
  {understanding:'理解\n変更',plan:'a → b',verified:['read #4','run passed'],assumptions:['UTF-8'],open_questions:['which branch?'],confidence:0,next:'read'},
  {understanding:'\ud800\ue000🦊',verified:[null,false,0,['a',null,'b'],{}],confidence:false,next:0},
  {confidence:1e-7,plan:true},{confidence:0},{confidence:'',next:'next'},
 ];
 for(const [i,reflection] of variants.entries())equal(compute('renderReflection',{reflection}),baseline.renderReflection(reflection),`reflection ${i}`);
});

test('Rust metacognition: reflect updates only supplied fields, cleans UTF-16 lengths, preserves metadata and records injected time',async()=>{
 await fixedClock(async()=>{
  const fixtures=[
   {session:{id:'new'},args:{}},
   {session:{id:'existing',stats:{steps:17},reflection:{understanding:'kept',plan:'old plan',verified:['kept proof'],confidence:0.8,step:2,at:'old'}},
    args:{plan:' new\n\t plan ',assumptions:[' A  B ',null,false,{},[],['a','b'],''],confidence:0,next:'do it'}},
   {session:{id:'long',stats:{steps:0},reflection:{open_questions:['keep']}},args:{understanding:'x'.repeat(598)+'🪷'+'y'.repeat(5),
    verified:['a'.repeat(298)+'🦊'+'b'.repeat(50),'\ud800'.repeat(350),'\ue000'.repeat(350),' \uFEFF\u00A0\u2028日\u3000文\t '],
    plan:'\ue000\udfff\ud800'.repeat(400)}},
   {session:{id:'clear',stats:{steps:9},reflection:{understanding:'erase',verified:['erase'],next:'erase'}},args:{understanding:'',verified:[],next:null,confidence:null}},
   {session:{id:'legacy',stats:null,reflection:{metadata:{keep:true},confidence:0.5}},args:{confidence:0.2}},
  ];
  for(const [i,{session,args}] of fixtures.entries()){
   let stored=clone(session);const updates=[];
   const sessions={get:id=>{assert.equal(id,session.id);return stored;},update:(id,body)=>{updates.push({id,body});stored={...stored,...body};return stored;}};
   const expected=await baseline.reflectTool(sessions).run(clone(args),{session:{id:session.id}});
   const before=clone({session,args});
   const actual=compute('reflect',{session,args,at:AT});
   equal(actual,expected,`reflect update ${i}`);
   equal({session,args},before,'reflect does not mutate supplied snapshots');
   equal(updates,[{id:session.id,body:{reflection:actual.data.reflection}}],'returned reflection is the exact session update');
  }
 });
});

// These two bodies are frozen from AgentLoop.watch/selfCheck before their
// migration. Fake hosts record effects; no live loop implementation is invoked.
function referenceWatch(session,mem){
 const actions=[];
 const rt={sessions:{get:()=>session,append:(_id,type,body)=>{assert.equal(type,'notice');actions.push({kind:'notice',...body});}},
  escalate:(_id,reason)=>actions.push({kind:'escalate',reason}),deescalate:()=>actions.push({kind:'deescalate'})};
 const id=session.id,last=mem.calls.at(-1);if(!last)return actions;
 const same=mem.calls.filter(c=>c.sig===last.sig&&c.outcome===last.outcome).length;
 if(same>=3&&!mem.warned.has(last.sig+last.outcome)){mem.warned.add(last.sig+last.outcome);rt.sessions.append(id,'notice',{text:NOTICE.repeated(last.label,same)});}
 if(mem.errorStreak===5)rt.sessions.append(id,'notice',{text:NOTICE.errorStreak(5)});
 if(mem.errorStreak===10||same===6)rt.escalate(id,mem.errorStreak>=10?'repeated errors':'repetition');
 if(!last.error&&same<2)mem.healthy++;else mem.healthy=0;
 if(mem.healthy>=8&&rt.sessions.get(id)?.role==='escalation'){mem.healthy=0;rt.deescalate(id);}
 return actions;
}
function referenceSelfCheck(payload,session,mem){
 const actions=[],rt={sessions:{list:()=>payload.team,append:(_id,type,body)=>{assert.equal(type,'notice');actions.push({kind:'notice',...body});}},
  event:(_id,event,data)=>actions.push({kind:'event',event,data})};
 if(!session||payload.metacognition===false)return actions;
 const f=baseline.selfFacts(rt,session,mem,payload),why=baseline.selfCheckDue(session,mem,f);
 if(!why.length)return actions;
 baseline.noteSelfCheck(mem,f,why);
 rt.sessions.append(session.id,'notice',{text:baseline.renderSelfCheck(f,why,{kind:session.kind}),selfCheck:why});
 rt.event(session.id,'self-check',{why,steps:f.steps,context:f.context?Math.round(f.context.share*100):null,confidence:f.reflection?.confidence??null});
 return actions;
}

test('Rust metacognition: watch emits ordered notices, suppresses repeats, escalates at exact thresholds and returns after eight healthy calls',()=>{
 for(const length of [0,1,2,3,5,6,7,12])for(const errorStreak of [0,4,5,6,9,10,11])for(const role of ['worker','escalation']){
  const session={id:'watch',role};
  const initial=memory({calls:calls(length,{repeat:length>1?1:0,errors:errorStreak?length:0}),errorStreak,healthy:7});
  const mem={...clone(initial),warned:new Set(initial.warned)};
  const actions=referenceWatch(session,mem);
  const actual=compute('watch',{session,mem:initial});
  equal(actual,{mem:{...mem,warned:[...mem.warned]},actions},`watch ${length}/${errorStreak}/${role}`);
  const repeatedActions=referenceWatch(session,mem);
  equal(compute('watch',{session,mem:actual.mem}),{mem:{...mem,warned:[...mem.warned]},actions:repeatedActions},'watch warned set persists');
 }
 // Equal signatures with different outcomes are healthy, rather than repeated.
 const session={id:'outcomes',role:'escalation'},initial=memory({calls:[{sig:'same',outcome:'first',error:false},{sig:'same',outcome:'second',error:false}],healthy:7});
 const mem={...clone(initial),warned:new Set()},actions=referenceWatch(session,mem);
 equal(compute('watch',{session,mem:initial}),{mem:{...mem,warned:[...mem.warned]},actions},'outcome participates in repetition identity');
});

test('Rust metacognition: self-check and combined post-tool plans match host effects and memory, including disabled checks',async()=>{
 await fixedClock(()=>{
  for(const kind of ['main','worker'])for(const enabled of [undefined,true,false])for(const steps of [0,4,5,15,20]){
   const session={id:'combined',kind,role:'worker',createdAt:new Date(NOW-90_000).toISOString(),stats:{steps,toolCalls:12,toolErrors:3,cost:0.03125},todo:[{status:'pending'}]};
   const initial=memory({calls:calls(6,{errors:3,repeat:2}),todoStep:0});
   const payload=input(session,initial,{built:{tokens:6500},B:10000,ratio:1,profile:{model:'test'},...(enabled===undefined?{}:{metacognition:enabled})});
   const mem=clone(initial),actions=referenceSelfCheck(payload,session,mem);
   equal(compute('selfCheck',payload),{mem,actions},`selfCheck ${kind}/${enabled}/${steps}`);
   const combinedMemory={...clone(initial),warned:new Set(initial.warned)};
   const combinedActions=referenceWatch(session,combinedMemory);
   combinedActions.push(...referenceSelfCheck(payload,session,combinedMemory));
   equal(compute('afterTools',payload),{mem:{...combinedMemory,warned:[...combinedMemory.warned]},actions:combinedActions},`afterTools ${kind}/${enabled}/${steps}`);
  }
  const session={id:'fresh',kind:'worker',role:'worker',stats:{steps:20,toolCalls:10},createdAt:AT};
  const initial=memory({calls:calls(6,{repeat:1})});
  const refreshed={...session,role:'escalation',route:{model:'stronger'}};
  const payload={...input(session,initial),afterWatchSession:refreshed};
  const mem={...clone(initial),warned:new Set(initial.warned)},actions=referenceWatch(session,mem);
  actions.push(...referenceSelfCheck(payload,refreshed,mem));
  equal(compute('afterTools',payload),{mem:{...mem,warned:[...mem.warned]},actions},'afterTools can use the host snapshot after watch effects');
 });
});

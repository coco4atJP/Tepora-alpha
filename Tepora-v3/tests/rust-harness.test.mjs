import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {nativeCompute} from '../core/native-state.mjs';
import * as fmt from './helpers/rust-harness-oracle/format.mjs';
import * as prompts from './helpers/rust-harness-oracle/prompts.mjs';
import * as compact from './helpers/rust-harness-oracle/compaction.mjs';
import * as persona from './helpers/rust-harness-oracle/persona.mjs';
import * as voice from './helpers/rust-harness-oracle/voice-lines.mjs';
import {ContextAssembler} from './helpers/rust-baseline/context.mjs';
const equal=(a,b,label='')=>{assert.deepEqual(a,b,label);assert.equal(JSON.stringify(a),JSON.stringify(b),label+' JSON bytes/key order');};
const native=(op,p={})=>nativeCompute('harness.'+op,p);
const environment={platform:process.platform,arch:os.arch(),username:os.userInfo().username,home:os.homedir(),shell:process.env.SHELL?.split('/').at(-1)||'bash'};
const wire=x=>JSON.parse(JSON.stringify(x));

test('Rust harness formats retain UTF-16, JSON ordering, coercions, token boundaries and full evidence references',()=>{
 const values=[undefined,null,'',true,false,1,1e21,{},[],{text:'hello',data:{x:2},images:[]},{text:'hello',other:2},' \u0085 \ufeff a\n  b 🦊 ', '\ud800\uE000'.repeat(300),JSON.parse('{"z":1,"10":2,"2":3,"__proto__":{"x":1}}')];
 for(const value of values){equal(native('format.toText',{result:value}),fmt.toText(value),'toText');for(const max of [0,1,20,90,200])equal(native('format.oneLine',{value,max}),fmt.oneLine(value,max),'oneLine');equal(native('format.argsLabel',{args:value}),fmt.argsLabel(value),'argsLabel');}
 for(const text of ['x'.repeat(5000),'日\ud800🪷\uE000'.repeat(500),'a'.repeat(99)+'🦊'+ 'b'.repeat(901),'tiny'])for(const maxTokens of [0,10,100,600,10000])equal(native('format.fitTokens',{text,maxTokens,ref:'#123'}),fmt.fitTokens(text,maxTokens,'#123'),'fitTokens');
 const args={path:'a'.repeat(59)+'🦊',a:null,b:'',c:[1,2],d:{v:1},bool:false,number:1e21};
 for(const error of [undefined,'','\t broken\n'.repeat(30)])equal(native('format.defaultStub',{name:'read',args,text:'\n \n  body\ntext',error}),fmt.defaultStub('read',args,'\n \n  body\ntext',{error}));
});

test('Rust harness schema subset deliberately preserves nullable fields and ignored maxItems',()=>{
 const schema={type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string'},n:{type:'integer',minimum:0,maximum:10},arr:{type:'array',maxItems:1,items:{type:'number'}},flag:{type:'boolean'},e:{enum:['a',null,2]},obj:{type:'object',required:['inside'],properties:{inside:{type:'string'}}}}};
 for(const args of [undefined,null,[],{}, {path:1},{path:null},{path:'x',n:1.1},{path:'x',n:-1},{path:'x',n:11},{path:'x',arr:[1,2,3]},{path:'x',arr:['x']},{path:'x',flag:'yes'},{path:'x',extra:1},{path:'x',obj:null},{path:'x',e:'bad'},{path:'x',e:null}])equal(native('format.checkArgs',{schema,args}),fmt.checkArgs(schema,args));
 for(const schema of [null,{}, {type:'array',items:{type:'object',additionalProperties:false}}, {enum:[{}]}, {enum:[[1]]}, {type:'object',properties:JSON.parse('{"z":{},"10":{},"2":{}}'),additionalProperties:false}])for(const args of [null,{},[],[{}],{x:1}])equal(native('format.checkArgs',{schema,args,path:'custom'}),fmt.checkArgs(schema,args,'custom'));
});

test('Rust harness JSON repair and unrepaired V8 feedback match frozen source',()=>{
 const raws=[undefined,null,'','  ','{}','{"x":2}', '[]','1','null','"x"','```json\n{"x":1,}\n```','before {"x":[1,2,]} after','{"x":1','{"x":"abc','{"x":[1,2','{"x":true,','{"x":"a,}",}', '{]', '{"x":}', '{a:1}', 'garbage','undefined','NaN','Infinity','[object Object]','{"a" 1}', '{"a":1 x}','{"x":"\\q"}','{"x":01}','{"x":1e}','{"x":tru}','{"a":-}','{"a":1.}','{"a":[1 x]}','{"a":"x\ny"}','{"longlonglonglong":"good",\n"bad":X}','{"🦊":\ud800}'];
 for(const raw of raws){equal(native('format.parseArgs',{raw}),fmt.parseArgs(raw),'parse '+JSON.stringify(raw));if(typeof raw==='string')equal(native('format.repairJSON',{text:raw}),fmt.repairJSON(raw),'repair '+raw);}
});

test('Rust harness prompts, all notices, personas and silent streaming detection preserve actual cached prefix',()=>{
 for(const kind of ['main','worker'])for(const tools of [[],['reflect','memory_search'],['exec','computer','skill','reflect','memory_search']])for(const p of [null,{name:'ユキ 🦊',instructions:'変えない\n\ud800',style:'short'},{name:'user',instructions:'instruction',voice:{tone:'casual',callName:' A\n B',proactive:'quiet'}}]){
  const session={kind,cwd:'/tmp/work'};const options={tools,persona:p,skills:[{name:'code',description:'test'}],sandbox:{mode:'off'},computer:{backend:'browser',headless:true,control:'decision'}};
  equal(native('prompts.systemPrompt',{session,...options,environment}),prompts.systemPrompt(session,options));
 }
 for(const name of Object.keys(prompts.NOTICE)){
  const cases=name==='instructionsUpdated'?[[{}],[{sections:['one','two'],added:['read'],removed:['exec']}]]:name==='missingFiles'?[[['x','y'],false],[['a'],true]]:name==='verify'?[['task'],['task','needs test']]:[['a',3]];
  for(const args of cases)equal(native('prompts.notice',{name,args}),prompts.NOTICE[name](...args),name);
 }
 for(const text of [undefined,null,'','N','NO_REP','no_reply','  "[NO_REPLY" trailing','NO_REPLYing','NO_REPLY_','NO_REPLY0','NO_REPLY🦊','\u0085NO_REPLY',' hello','【ＮＯ_REPLY']){equal(native('prompts.isSilentReply',{text}),prompts.isSilentReply(text));equal(native('prompts.mayBeSilent',{text}),prompts.mayBeSilent(text));}
 for(const tone of ['polite','soft','casual','terse','night','bad'])for(const proactive of ['quiet','normal','chatty']){const v={tone,proactive,callName:' name\u0000\t'+ '🦊'.repeat(20),lines:{secret:'not model visible'}};equal(native('prompts.voiceStyleForPrompt',{voice:v}),voice.voiceStyleForPrompt(v));const p={name:'P',instructions:'I',voice:v};equal(native('prompts.personaForPrompt',{persona:p}),persona.personaForPrompt(p));}
 for(const previous of [false,true]){const p={ledger:'ledger\nexact',previous,maxTokens:1200};equal(native('prompts.compactionInstruction',p),prompts.compactionInstruction(p));}
 for(const previous of ['', 'old summary']){const p={previous,ledger:'ledger',transcript:'transcript',maxTokens:900};equal(native('prompts.summarizerRequest',p),prompts.summarizerRequest(p));}
 equal(native('prompts.summarizerSystem'),prompts.SUMMARIZER_SYSTEM);equal(native('prompts.summaryHeadings'),prompts.SUMMARY_HEADINGS);
});

const log=()=>[
 {seq:1,type:'input',kind:'task',text:'Task /tmp/first.txt https://example.org/a',at:'2026-01-01'},
 ...Array.from({length:18},(_,i)=>({seq:i+2,type:'input',kind:'message',text:'instruction '+i+' 日本語'.repeat(30),from:i===3?'child:worker':'user',header:i===2?'[header]':'',at:'2026-01-01'})),
 {seq:20,type:'tool',name:'write',args:{path:'/tmp/a'},data:{path:'/tmp/a',op:'write',bytes:1024,sha:'123'},stub:'write a'},
 {seq:21,type:'tool',name:'read',args:{path:'/tmp/a'},stub:'read a'},
 {seq:22,type:'tool',name:'read',args:{path:'/tmp/b'},stub:'read b'},
 {seq:23,type:'tool',name:'web_fetch',args:{url:'https://example.org/a'},content:'# Example\nbody',stub:'page'},
 {seq:24,type:'tool',name:'web_search',args:{query:'"query" 日本'},stub:'search'},
 {seq:25,type:'tool',name:'sessions_spawn',data:{sessionId:'child',title:'Child'},stub:'spawn'},
 {seq:26,type:'input',kind:'report',sessionId:'child',title:'Child report',text:'report',status:'done'},
 {seq:27,type:'tool',name:'artifact',data:{id:'art',title:'Result',version:2},stub:'artifact'},
 {seq:28,type:'tool',name:'exec',args:{command:'cat file'},data:{processId:'process'},stub:'exec'},
 {seq:29,type:'tool',name:'read',error:true,content:'fail\n message',stub:'failed'},
 {seq:30,type:'notice',text:'notice'},
 {seq:31,type:'assistant',content:'https://example.org/other. Saved /tmp/second.txt',toolCalls:[{id:'call',name:'write',arguments:'{"path":"/tmp/third.txt","content":"done"}'}]},
 {seq:32,type:'tool',name:'write',content:'done',callId:'call',stub:'done',ephemeralKey:'file'},
 {seq:33,type:'assistant',content:'Finish.'},
];
function built(entries){return new ContextAssembler({latest:()=>null,entries:()=>entries}).build('s',{system:'system',vision:false});}

test('Rust harness ledger folding/rendering and permanent chapter provenance match oracle',()=>{
 for(const kind of ['main','worker'])for(const instructionTokens of [20,600,4000])for(const evidence of [0,2,40]){
  const entries=log();const p={kind,instructionTokens,evidence};const expected=compact.foldLedger(null,entries,p);const actual=native('compaction.foldLedger',{previous:null,entries,...p});equal(actual,wire(expected));
  for(const maxTokens of [10,500,1000,10000]){const opts={todo:[{text:'pending',status:'pending'},{text:'ongoing',status:'in_progress'}],reflection:{understanding:'exact',verified:['done'],assumptions:['open'],confidence:.5},live:{sessions:{child:'running'},processes:{process:'done'}},maxTokens};equal(native('compaction.renderLedger',{ledger:actual,...opts}),compact.renderLedger(expected,opts));}
 }
 const chapters=Array.from({length:12},(_,i)=>({from:i*10+1,upTo:i*10+10,at:'2026-01-02T03:04:05Z',digest:'chapter '+i+' 日本語'.repeat(10)}));for(const maxTokens of [0,100,400,10000])equal(native('compaction.renderChapters',{chapters,maxTokens}),compact.renderChapters(chapters,maxTokens));
 for(const B of [100,1000,7500,100000]){equal(native('compaction.ledgerLimits',{B}),compact.ledgerLimits(B));equal(native('compaction.summaryBudget',{B}),new compact.Compactor({}).summaryBudget(B));}
 equal(native('compaction.emptyLedger'),compact.emptyLedger());
});

test('Rust harness summary validation, digest extraction, exact identifiers, chunking and fallback transcript',()=>{
 const summaries=['short',prompts.SUMMARY_HEADINGS.map(h=>'## '+h+'\n- '+h+' content').join('\n'),'intro\n# CHAPTER DIGEST\n  exact\n  text\n## Next\nbody','# Chapter digest\nall digest','## Goal\n'+ 'x'.repeat(4000)];
 for(const summary of summaries){equal(native('compaction.takeDigest',{summary}),compact.takeDigest(summary));for(const maxTokens of [20,600,8000])equal(native('compaction.validSummary',{text:summary,maxTokens}),compact.validSummary(summary,maxTokens));}
 const entries=log();for(const clearUpTo of [0,20,100])equal(native('compaction.transcriptText',{entries,clearUpTo}),compact.transcriptText(entries,clearUpTo));
 for(const known of ['','https://example.org/a /tmp/first.txt'])for(const limit of [0,2,25])equal(native('compaction.missingIdentifiers',{entries,known,limit}),compact.missingIdentifiers(entries,known,limit));
 for(const maxTokens of [0,10,100,500]){const text='日本語\n'+ 'a'.repeat(200)+'\n\n'+ 'x\ny\nz\n'.repeat(30);equal(native('compaction.chunks',{text,maxTokens}),compact.chunks(text,maxTokens));}
 const cp={upTo:32,at:'2026-01-01',ledger:'ledger',summary:'summary',method:'rolling',chapters:'chapters'};equal(native('compaction.checkpointText',cp),compact.checkpointText(cp));equal(native('compaction.checkpointText',{...cp,chapters:''}),compact.checkpointText({...cp,chapters:''}));
});

test('Rust harness compaction hot window, .72/.8/.55 thresholds and tail turn boundaries match real assembler',()=>{
 const entries=log();for(let i=0;i<entries.length;i++)if(entries[i].type==='tool')entries[i]={...entries[i],content:'large result 日本語 '.repeat(500)};
 const b=built(entries),assembler=new ContextAssembler({}),oracle=new compact.Compactor({assembler});
 for(const B of [100,600,1000,10000,50000])for(const ratio of [.5,1,1.3]){
  const p={built:b,B,ratio};equal(native('compaction.clearCandidate',p),oracle.clearCandidate(b,ratio));
  for(const tailShare of [0,.15,.5,1])equal(native('compaction.boundary',{...p,tailShare}),oracle.boundary(b,B,ratio,tailShare));
  for(const idle of [false,true])for(const force of [false,true])equal(native('compaction.plan',{...p,idle,force}),oracle.plan(b,B,ratio,{idle,force}));
 }
 for(const entries of [[],[{seq:1,type:'input',text:'one'}],[{seq:1,type:'assistant',content:'a'},{seq:2,type:'tool',callId:'x',content:'b'}]]){const b=built(entries);equal(native('compaction.boundary',{built:b,B:500,ratio:1}),oracle.boundary(b,500,1));}
});

test('Rust harness compaction prepare/finalize drives genuine deterministic checkpoint identical to exhausted model fallback',async()=>{
 const entries=log();const b=built(entries);const session={id:'s',kind:'worker',stats:{}};const B=1000,ratio=1,at='2026-01-02T03:04:05.000Z';
 const prepared=native('compaction.prepare',{session,built:b,B,ratio,entries,reason:'overflow'});assert(prepared);assert.equal(prepared.inContextAttempts,0);
 const finished=native('compaction.finalize',{prepared,built:b,B,ratio,reason:'overflow',at});
 const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[at]));}static now(){return RealDate.parse(at)}};
 const appended=[];let seq=100;const compactor=new compact.Compactor({assembler:new ContextAssembler({}),sessions:{entries:(_,{from,to})=>entries.filter(e=>e.seq>=from&&e.seq<=to),append:(_,type,body)=>{const e={...body,seq:++seq,type};appended.push(e);return e;},get:()=>session,update:()=>{}},registry:{invoke:async()=>{throw new Error('fixture provider failure')}},emit:()=>{}});
 try{const cp=await compactor.compact(session,{built:b,B,ratio,reason:'overflow'});const {seq:ignored,type,...body}=cp;equal(finished.checkpoint,body);assert.equal(finished.notice,appended[1].text);}finally{globalThis.Date=RealDate;}
});

test('Rust harness JS diagnostics, half ties and Unicode line/case edge regressions',()=>{
 for(const raw of ['true false','t1','t-','nu"','x'.repeat(20),' '.repeat(10)+'X'+' '.repeat(12),'[t1🦊r},u[r a:🦊r]'])equal(native('format.parseArgs',{raw}),fmt.parseArgs(raw));
 let seed=17;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/2**32;};const alphabet=['{','}','[',']','"',':',',','1','t','r','u','e','n','a','l',' ','\\','\n','\ud800','🦊'];
 for(let i=0;i<1000;i++){const raw=Array.from({length:1+Math.floor(rand()*45)},()=>alphabet[Math.floor(rand()*alphabet.length)]).join('');equal(native('format.parseArgs',{raw}),fmt.parseArgs(raw),'malformed seeded case '+i);}
 for(const separator of ['\n','\r','\r\n','\u2028','\u2029']){
  const summary='prefix'+separator+'## Chapter digest\nwords'+separator+'## Later\nlater';equal(native('compaction.takeDigest',{summary}),compact.takeDigest(summary));
  const text=['A','B','C','D','E'].map(h=>'## '+h+'\n- enough meaningful body text to summarize').join(separator);equal(native('compaction.validSummary',{text,maxTokens:600}),compact.validSummary(text,600));
 }
 for(const bytes of [1280,2304,1310720,2359296]){const ledger={...compact.emptyLedger(),files:{a:{op:'write',bytes,sha:'x',seq:1}}};equal(native('compaction.renderLedger',{ledger}),compact.renderLedger(ledger));}
 for(const text of ['NO_REPLYſ','NO_REPLYß','no_replyı','NO_REPLYK']){equal(native('prompts.isSilentReply',{text}),prompts.isSilentReply(text));equal(native('prompts.mayBeSilent',{text}),prompts.mayBeSilent(text));}
 const entries=[{seq:1,type:'input',text:'https://x.test/\u0085x /tmp/a.txt日'},{seq:2,type:'input',text:'\u0085/tmp/b.txt'}];equal(native('compaction.missingIdentifiers',{entries,known:''}),compact.missingIdentifiers(entries,''));
});

test('Rust harness image clearing overrides the low-token threshold after six images',()=>{
 const entries=[{seq:1,type:'input',text:'look'}];for(let i=0;i<8;i++)entries.push({seq:2+i*2,type:'assistant',toolCalls:[{id:'c'+i,name:'capture',arguments:'{}'}]},{seq:3+i*2,type:'tool',callId:'c'+i,name:'capture',content:'image',stub:'old image',images:[{mime:'image/png',base64:'aGVsbG8='}]});
 const assembler=new ContextAssembler({latest:()=>null,entries:()=>entries}),b=assembler.build('s',{system:'system',vision:true}),oracle=new compact.Compactor({assembler});
 const p={built:b,B:1000000,ratio:1};equal(native('compaction.plan',p),oracle.plan(b,p.B,1));assert.equal(native('compaction.plan',p).action,'clear');
});

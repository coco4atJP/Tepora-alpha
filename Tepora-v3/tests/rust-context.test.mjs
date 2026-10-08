import test from 'node:test';
import assert from 'node:assert/strict';
import * as current from '../core/agent/context.mjs';
import * as baseline from './helpers/rust-baseline/context.mjs';
import * as tokens from '../core/agent/tokens.mjs';
import * as oldTokens from './helpers/rust-baseline/tokens.mjs';

// Public-facade differential tests against the immutable, test-only JS oracle.
// No provider calls, user files, wall-clock timestamps, or random inputs are used.
const clone=value=>structuredClone(value);
const equal=(actual,expected,label)=>{
 assert.deepEqual(actual,expected,label);
 assert.equal(JSON.stringify(actual),JSON.stringify(expected),`${label}: JSON bytes and key order`);
};
function png(width,height,name='fixture.png'){
 const bytes=Buffer.alloc(24);bytes.set([137,80,78,71]);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);
 return {mime:'image/png',base64:bytes.toString('base64'),width,height,name};
}
const images=[png(32,32),png(1600,900,'画面 🦊.png')];
const part=image=>({type:'image_url',image_url:{url:`data:${image.mime};base64,${image.base64}`}});
const call=(id='c1',arguments_='{}',name='read')=>({id,name,arguments:arguments_});
const canonicalCall=(id='c1',arguments_='{}',name='read')=>({id,type:'function',function:{name,arguments:arguments_}});
function sessions(entries){
 const observed=[];
 return {observed,latest(id,type){observed.push(['latest',id,type]);return entries.filter(e=>e.type===type).at(-1)??null;},
  entries(id,{from}){observed.push(['entries',id,{from}]);return entries.filter(e=>e.seq>=from);}};
}
function compareContext(entries,options,label){
 const original=clone(entries),a=sessions(clone(entries)),b=sessions(clone(entries));
 const actual=new current.ContextAssembler(a).build('fixture',clone(options));
 const expected=new baseline.ContextAssembler(b).build('fixture',clone(options));
 equal(actual,expected,label);equal(a.observed,b.observed,`${label}: session reads`);
 equal(entries,original,`${label}: input remains unchanged`);
 assert.equal(actual.tokens,tokens.messagesTokens(actual.messages),`${label}: total token accounting`);
 for(const row of actual.rendered)assert.equal(row.tokens,tokens.messageTokens(row.message),`${label}: entry token accounting`);
 return actual;
}

test('Rust context: constants, stubs, Unicode truncation and recursive argument shrinking match the historical oracle',()=>{
 assert.equal(current.SMALL_RESULT_TOKENS,baseline.SMALL_RESULT_TOKENS);
 assert.equal(current.LONG_ARG_CHARS,baseline.LONG_ARG_CHARS);
 for(const entry of [
  {seq:1,name:'read'}, {seq:2,name:'capture',stub:'screen',images},
  {seq:3,header:'報告',title:'worker',text:'  alpha\n beta\t gamma  '},
  {seq:4,from:'🦊',text:'a'.repeat(198)+'🪷'+'b'.repeat(50)},
  {seq:5,header:'',text:'\uFEFF\u00A0\u2028\u2029終\u3000'.repeat(100)},
 ]){
  equal(current.stubText(entry),baseline.stubText(entry),'result stub');
  equal(current.reportStub(entry),baseline.reportStub(entry),'report stub');
 }
 const numeric=JSON.parse('{"z":"last","10":"ten","2":"two","01":"leading","4294967295":"not-index","0":"zero","__proto__":{"lost":true}}');
 const values=[null,true,false,0,-0,1e-7,1e21,'short','a'.repeat(400),'a'.repeat(401),
  'a'.repeat(119)+'🦊'+'z'.repeat(1000),'\ud800'.repeat(401),'\udfff'.repeat(401),
  '\uE000🦊\uE000'.repeat(150),{...numeric,nested:['日'.repeat(1001),{tail:'🪷'.repeat(201)}]},
  JSON.parse('{"__proto__":"'+ 'x'.repeat(401)+'","constructor":"kept","10":"ten","2":"two"}')];
 for(const [i,value] of values.entries()){
  const before=clone(value);
  equal(current.shrinkValue(value,'#9'),baseline.shrinkValue(value,'#9'),`shrink value ${i}`);
  equal(value,before,`shrink input ${i}`);
  const raw=JSON.stringify(value);
  equal(current.shrinkArgs(raw,'#9'),baseline.shrinkArgs(raw,'#9'),`shrink args ${i}`);
 }
 for(const raw of [undefined,null,4,'','{','["'+ 'x'.repeat(500)+'"]','"'+ 'x'.repeat(500)+'"','{broken:'+ 'x'.repeat(500),' '.repeat(501)]){
  equal(current.shrinkArgs(raw,'#2'),baseline.shrinkArgs(raw,'#2'),'malformed/nonobject args stay exact');
 }
});

test('Rust context: checkpoint watermarks, clear overrides, keep and superseded ephemeral entries, native calls and image batching',()=>{
 const long='x'.repeat(119)+'🦊'+'日'.repeat(900),args=JSON.stringify({path:'a',content:long,'10':'ten','2':'two'});
 const native={identity:'same-provider',items:[
  {type:'thinking',thinking:'private',signature:'opaque-signature'},
  {type:'tool_use',id:'c1',name:'write',input:{content:long}},
  {type:'function_call',call_id:'c2',name:'write',arguments:args},
  {functionCall:{name:'write',args:{content:long}},thoughtSignature:'preserve'},
  {type:'opaque',data:'do not rewrite'},null,
 ]};
 const entries=[
  {seq:1,type:'input',text:'before checkpoint'},
  {seq:2,type:'assistant',content:'old'},
  {seq:3,type:'checkpoint',upTo:2,text:'要約 🪷'},
  {seq:4,type:'input',text:'look',header:'User',images},
  {seq:5,type:'assistant',content:'',toolCalls:[call('c1',args),call('c2',args)],native},
  {seq:6,type:'tool',callId:'c1',name:'capture',content:'old screen',ephemeralKey:'screen',keep:true,images},
  {seq:7,type:'tool',callId:'c2',name:'read',content:'long '.repeat(500),keep:true,images:[images[0]]},
  {seq:8,type:'input',kind:'report',title:'worker',header:'Result',text:'report\n'.repeat(100),images:[images[0]]},
  {seq:9,type:'input',kind:'heartbeat',header:'Tick',text:'check'},
  {seq:10,type:'assistant',content:'next',toolCalls:[call('c3')]},
  {seq:11,type:'tool',callId:'c3',name:'capture',content:'latest screen',ephemeralKey:'screen',images:[images[1]]},
  {seq:12,type:'tool',callId:'orphan',name:'read',content:'orphan image',images:[images[0]]},
  {seq:13,type:'clear',upTo:11},
  {seq:14,type:'notice',text:'notice'},
  {seq:15,type:'assistant',toolCalls:[call('missing')]},
  {seq:16,type:'input',text:'follow up'},
 ];
 for(const vision of [true,false])for(const clearUpTo of [undefined,0,5,8,20]){
  compareContext(entries,{system:'system\n日本語',vision,clearUpTo},`vision=${vision} clear=${clearUpTo}`);
 }
 compareContext([{seq:1,type:'input',text:String.fromCodePoint(0x323b0).repeat(4)}],{system:'Unicode release'},'Node runtime Unicode script version');
 compareContext([],{system:'empty'},'empty transcript');
 compareContext([{seq:1,type:'checkpoint',upTo:0,text:'checkpoint only'}],{system:''},'checkpoint only');
 compareContext([{seq:1,type:'input',text:''},{seq:2,type:'assistant',content:false}],{},'missing system and false assistant content');
});

test('Rust context: clearability truth table and sequence repair preserve missing results, duplicate IDs, and orphans',()=>{
 const assembler=new current.ContextAssembler(null),old=new baseline.ContextAssembler(null);
 for(const type of ['input','tool','assistant','notice'])for(const kind of ['report','heartbeat','user'])for(const keep of [undefined,false,true])for(const ephemeralKey of [undefined,'e'])for(const seq of [1,5,8]){
  const e={type,kind,keep,ephemeralKey,seq};
  for(const clearUpTo of [0,5,20])for(const latest of [new Map(),new Map([['e',seq]]),new Map([['e',99]])]){
   equal(assembler.isCleared(e,{clearUpTo},latest),old.isCleared(e,{clearUpTo},latest),'clearability');
  }
 }
 const m=(role,fields={})=>({role,content:role,...fields});
 const sequences=[[],[m('tool',{tool_call_id:'orphan'})],[m('assistant',{tool_calls:[canonicalCall('x'),canonicalCall('x'),canonicalCall('y')]})],
  [m('assistant',{tool_calls:[canonicalCall('x'),canonicalCall('y')]}),m('tool',{tool_call_id:'y'}),m('user'),m('tool',{tool_call_id:'x'})],
  [m('assistant',{tool_calls:[canonicalCall('x')]}),m('assistant',{tool_calls:[canonicalCall('y')]}),m('tool',{tool_call_id:'y'}),m('tool',{tool_call_id:'y'})]];
 for(const [i,messages] of sequences.entries())equal(current.repairSequence(messages),baseline.repairSequence(messages),`repair ${i}`);
});

test('Rust context: deterministic generated transcripts preserve render order, repair and cache breakpoints',()=>{
 let state=0x1a2b3c4d;
 const rand=max=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%max;};
 for(let n=0;n<48;n++){
  const entries=[];
  for(let seq=1;seq<=25;seq++){
   const type=rand(7),id='c'+rand(5);
   if(type===0)entries.push({seq,type:'input',text:['hello','日本語 🪷','', 'x'.repeat(402)][rand(4)],...(rand(3)===0?{images:[images[rand(2)]]}:{})});
   else if(type===1)entries.push({seq,type:'assistant',content:rand(2)?'answer':null,toolCalls:[call(id,JSON.stringify({content:'a'.repeat(rand(650))}))]});
   else if(type===2)entries.push({seq,type:'tool',callId:id,name:'read',content:'result '+seq,keep:rand(2)===0,ephemeralKey:rand(2)?'poll':undefined,...(rand(3)===0?{images:[images[rand(2)]]}:{})});
   else if(type===3)entries.push({seq,type:'clear',upTo:rand(seq+1)});
   else if(type===4)entries.push({seq,type:'notice',text:'notice '+seq});
   else if(type===5)entries.push({seq,type:'input',kind:rand(2)?'heartbeat':'report',title:'worker',text:'report '+seq});
   else entries.push({seq,type:'checkpoint',upTo:Math.max(0,seq-2),text:'checkpoint '+seq});
  }
  // Real SessionStore reads persisted JSON, so undefined properties do not survive.
  compareContext(JSON.parse(JSON.stringify(entries)),{system:'system',vision:n%2===0},`generated ${n}`);
 }
});

test('Rust token estimates: script ranges, astral and lone UTF-16 units, image dimensions and tool JSON bytes',()=>{
 const texts=[undefined,null,'',true,false,0,123,123n,-123n,Symbol('raw'),Infinity,-Infinity,NaN,{},[],['a','日本語'],'hello','日本語カタカナひらがな','한글한','中文𠮷𠀀',
  ...[0x16ff2,0x2b73a,0x2cea2,0x323b0,0x33479].map(cp=>String.fromCodePoint(cp).repeat(4)),
  '🦊🪷👩‍💻','\ud800','\udfff','\uE000','　、。＀Ａｶﾞ￯','e\u0301\n\r\t','a'.repeat(32),{'2':'two','1':'one'}];
 let seed=7;const alphabet=['a','中','あ','カ','한','ᄒ','𠮷','🪷','\ud800','\uE000',' '];
 for(let i=0;i<64;i++){let s='';for(let j=0;j<i;j++){seed=(Math.imul(seed,1103515245)+12345)>>>0;s+=alphabet[seed%alphabet.length];}texts.push(s);}
 for(const text of texts)equal(tokens.rawTokens(text),oldTokens.rawTokens(text),`raw ${String(text)}`);
 const messages=[{role:'user',content:''},{role:'assistant',content:null},{role:'user'},
  {role:'user',content:[{type:'text',text:'日本語'},...images.map(part)]},
  {role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}},{type:'unknown'},null]},
  {role:'assistant',tool_calls:[canonicalCall('c','{"10":1,"2":2,"x":0.0000001}','write')]}];
 for(const m of messages)equal(tokens.messageTokens(m),oldTokens.messageTokens(m),'message tokens');
 equal(tokens.messagesTokens(messages),oldTokens.messagesTokens(messages),'sum tokens');
 for(const tools of [undefined,null,[],[{type:'function',function:{name:'write',parameters:{type:'object',properties:{'10':{type:'number'},'2':{type:'string'},z:{default:1e-7}},required:['2']}}}]]){
  equal(tokens.toolsTokens(tools),oldTokens.toolsTokens(tools),'tool schema JSON token count');
 }
});

test('Rust token calibration: saved ratios, cache isolation, clipping and thresholds have exact persistence effects',t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-07T00:00:00.000Z')});
 const makeStore=()=>{const data=new Map([['token-ratio:saved',{ratio:1.7}],['token-ratio:invalid',{ratio:'1.2'}],['token-ratio:infinite',{ratio:Infinity}],['token-ratio:zero',{ratio:0}]]),effects=[];return {data,effects,value(key,...args){effects.push(args.length?['write',key,clone(args[0])]:['read',key]);if(args.length){data.set(key,clone(args[0]));return args[0];}return data.get(key);}};};
 const a=makeStore(),b=makeStore(),actual=new tokens.TokenCalibration(a),expected=new oldTokens.TokenCalibration(b);
 for(const id of ['',null,undefined,'saved','invalid','infinite','zero','fresh']){
  equal(actual.key(id),expected.key(id),'calibration key');
  equal(actual.ratio(id),expected.ratio(id),'saved ratio');
  for(const raw of [0,1,200,201,1234.5])equal(actual.estimate(id,raw),expected.estimate(id,raw),'calibrated estimate');
  for(const [estimated,real] of [[0,100],[200,100],[201,0],[201,1],[1000,10000],[1000,400],[1000,1100]])equal(actual.observe(id,estimated,real),expected.observe(id,estimated,real),'observe');
 }
 equal(a.effects,b.effects,'storage read/write order including fixed timestamp');
 equal([...a.data],[...b.data],'persisted ratios');
 a.data.set('token-ratio:saved',{ratio:99});b.data.set('token-ratio:saved',{ratio:99});
 equal(actual.ratio('saved'),expected.ratio('saved'),'cache ignores external changes');
 const detached=new tokens.TokenCalibration(),oldDetached=new oldTokens.TokenCalibration();
 equal(detached.observe('no-store',1000,500),oldDetached.observe('no-store',1000,500),'optional store');
});

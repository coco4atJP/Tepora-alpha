// Frozen test-only oracle for AgentLoop.record, without invoking any effect.
import {writeFileSync} from 'node:fs';
import {AgentLoop} from '../../core/agent/loop.mjs';
const cases=[];
function scenario(label,calls,outputs,{B=2000,defs={},session={id:'fixture',stats:{steps:7,toolCalls:2,toolErrors:1}},memory={calls:[],errorStreak:0,healthy:2,nudges:1},firstSeq=10}={}){
 const loop=Object.create(AgentLoop.prototype);loop.memory=new Map([[session.id,structuredClone(memory)]]);
 const current=structuredClone(session),receipts=[],evidence=[];let seq=firstSeq;
 const convert=d=>d?{...d,...('stub' in d?{stub:()=>d.stub}:{}),...('ephemeralKey' in d?{ephemeralKey:()=>d.ephemeralKey}:{})}:undefined;
 loop.rt={tools:{get:n=>convert(defs[n])},sessions:{
  seq:()=>seq,get:()=>current,update:(_id,patch)=>Object.assign(current,patch),
  putEvidence:(id,sessionId,seq,tool,content)=>evidence.push({id,sessionId,seq,tool,content}),
  append:(_id,type,body)=>receipts.push({seq:seq++,body}),
 }};
 for(let i=0;i<calls.length;i++)loop.record(session,calls[i],outputs[i],B);
 const mem=loop.memory.get(session.id),reads=mem.reads?[...mem.reads]:[];delete mem.reads;
 for(const receipt of receipts){receipt.evidence=evidence.find(e=>e.seq===receipt.seq)||null;const output=outputs[receipt.seq-firstSeq];const name=output.name||calls[receipt.seq-firstSeq].name;receipt.read_result=name==='read'&&output.result?.data?.readKey?output.result:null;}
 cases.push({label,session,calls,outputs,budget:B,definitions:defs,memory,firstSeq,expected:{receipts,stats:current.stats,memory:mem},reads});
}
scenario('basic final names and formatting',[{id:'call1',name:'tools_call'},{id:'call2',name:'read'},{id:'call3',name:'todo'}],[
 {name:'write',args:{path:'a',content:'hello'},result:{text:'Wrote hello',data:{path:'a',sha:'123'}},ms:12},
 {name:'read',args:{path:'a'},result:{text:'a (1 lines)\n    1\thello',data:{path:'a',readKey:'a:1:800',mtimeMs:12.5,size:5}},ms:3},
 {name:'todo',args:{items:[]},result:{text:'All done'},ms:1},
],{defs:{todo:{ephemeral:true,ephemeralKey:'todo'}}});
scenario('error prefixes preserve actual interruption',[{id:'a',name:'read'},{id:'b',name:'write'},{id:'c',name:'write'}],[
 {args:{path:'missing'},error:'not here\n detail',repaired:true,notExecuted:true,interrupted:true,ms:4},
 {args:{path:'a'},result:{text:'actually wrote it'},interrupted:true,ms:80},
 {args:{path:'a'},error:'failed','interrupted':true,ms:81},
]);
scenario('evidence exact limit and data',[{id:'a',name:'big'},{id:'b',name:'empty'}],[
 {name:'big',args:{long:'x'.repeat(599)+'😀'.repeat(10),deep:{keep:'y'.repeat(700)}},result:{text:('long evidence 日本語😀\n').repeat(500),data:{kept:true}},ms:100},
 {name:'empty',args:null,result:null,ms:0},
],{B:400,firstSeq:100,defs:{big:{stub:'custom\n stub '.repeat(30)}}});
scenario('images and false ephemeral key',[{id:'i',name:'vision'},{id:'s',name:'sessions_list'},{id:'e',name:'ephemeral'}],[
 {args:{},result:{text:'image',images:Array.from({length:10},(_,i)=>({mime:'image/png',base64:'test',width:i,height:i,name:i?'n':''}))}},
 {args:{},result:'short'},
 {args:{},result:{text:'key'}},
],{defs:{sessions_list:{ephemeral:false,ephemeralKey:'sessions_list'},ephemeral:{ephemeral:true,ephemeralKey:''}}});
scenario('missing args and primitive result',[{id:'a',name:'x'},{id:'b',name:'x'},{id:'c',name:'x'},{id:'d',name:'x'}],[
 {error:'bad JSON'}, {args:[1,'a'],result:{text:{nested:true},extra:1}}, {args:false,result:42}, {args:0,result:{arbitrary:['x',null]}}
]);
scenario('codec hashes strings and key ordering',[{id:'a',name:'x'},{id:'b',name:'x'}],[
 {name:'x',args:{'10':'ten','2':'two',z:'\ud800',a:'\ue000\ue100'},result:{text:'raw \ud800 \ue000\ue100😀'}},
 {name:'x',args:{x:'a'.repeat(599)+'😀'},result:{text:'other'},repaired:true},
]);
scenario('rolling calls and error streak',Array.from({length:17},(_,i)=>({id:'c'+i,name:'x'})),Array.from({length:17},(_,i)=>({args:{n:i},...(i<15?{error:'problem'}:{result:'healthy'})})),{memory:{calls:[],errorStreak:3,healthy:0},session:{id:'many',stats:{steps:3,toolCalls:0,toolErrors:0}},firstSeq:1});
scenario('string stats use original js addition',[{id:'x',name:'todo'},{id:'y',name:'x'}],[{args:{},result:'todo'},{args:{},error:'err'}],{session:{id:'strings',stats:{steps:9,toolCalls:'2',toolErrors:'1'}},memory:{calls:[],errorStreak:'3'},defs:{todo:{ephemeral:true}}});
writeFileSync(new URL('../src/agent/receipts/source-fixtures.json',import.meta.url),JSON.stringify(cases,null,2)+'\n');
console.log(`Wrote ${cases.length} receipt scenarios, ${cases.reduce((n,c)=>n+c.calls.length,0)} calls`);

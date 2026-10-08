// Test-only frozen source oracle. No production module imports these files.
import {writeFile} from 'node:fs/promises';
import {DEFAULT_SETTINGS,validateSettings} from './preferences-oracle/policy.mjs';
import {defaultPersonas,normalizePersonas} from './preferences-oracle/persona.mjs';
import {defaultVoice,validateVoice} from './preferences-oracle/voice-lines.mjs';
import {configurePersonas} from './preferences-oracle/configure-personas.mjs';
const cases=[];
function record(op,name,input,previous){
 const item={op,name,input};let fn;
 if(op==='voice'){item.previous=previous??defaultVoice();fn=()=>validateVoice(input,item.previous);}
 if(op==='settings'){item.previous=previous??DEFAULT_SETTINGS;fn=()=>validateSettings(input,item.previous);}
 if(op==='personas'){
  const settings={companion:'Tepora'},current=previous??defaultPersonas(settings.companion);item.current=normalizePersonas(current);
  let saved=current; const store={settings,value(_key,next){if(arguments.length>1)saved=next;return saved;}};
  fn=()=>configurePersonas(store,input);
 }
 try{item.expected={wire:JSON.stringify(fn())};}catch(e){item.expected={status:e.status||500,message:e.message};}
 cases.push(item);
}
const goodPersona={name:' Main ',instructions:' exact\n instructions '};
for(const input of [null,false,0,'',[],{}, {expectedRevision:'0'}, {expectedRevision:null}, {expectedRevision:1}, {expectedRevision:0}, {expectedRevision:-0}, {expectedRevision:0,unknown:'ignored'}, {expectedRevision:0,character:null}, {expectedRevision:0,character:[]}, {expectedRevision:0,character:{}}, {expectedRevision:0,character:{name:'x'}}, {expectedRevision:0,character:{name:'',instructions:''}}, {expectedRevision:0,character:{name:'\ufeff\u2003',instructions:''}}, {expectedRevision:0,character:goodPersona}, {expectedRevision:0,worker:{...goodPersona,voice:{tone:'invalid'},allowNetwork:true}}, {expectedRevision:0,character:{...goodPersona,allowNetwork:true,tools:['exec'],permission:'allow'}}, {expectedRevision:0,character:{...goodPersona,voice:null}}, {expectedRevision:0,character:{...goodPersona,voice:{tone:'casual',callName:' Mira ',lines:{waiting:'Custom {n}'}}}}])record('personas',`persona-${cases.length}`,input);
for(const n of [79,80,81])record('personas',`name-${n}`,{expectedRevision:0,character:{name:'x'.repeat(n),instructions:''}});
for(const n of [40,41])record('personas',`name-astral-${n}`,{expectedRevision:0,character:{name:'😀'.repeat(n),instructions:''}});
for(const n of [7999,8000,8001])record('personas',`instructions-${n}`,{expectedRevision:0,character:{name:'ok',instructions:'x'.repeat(n)}});
record('personas','isolated-surrogates',{expectedRevision:0,character:{name:'A\ud800\ue000',instructions:'raw\udfff\ue100'}});
record('personas','legacy-missing-voice',{expectedRevision:7,character:goodPersona},{revision:7,character:{name:'old',instructions:'old'},worker:{name:'worker',instructions:''}});
record('personas','preserve-old-voice',{expectedRevision:2,character:goodPersona},{...defaultPersonas('old'),revision:2,character:{name:'old',instructions:'old',voice:{tone:'night',callName:'old',proactive:'quiet',lines:{waiting:'old'}}}});
for(const input of [null,false,[],0,'',{}, {tone:'polite'}, {tone:'soft'}, {tone:'casual'}, {tone:'terse'}, {tone:'night'}, {tone:'unknown'}, {tone:null}, {tone:1}, {proactive:'quiet'}, {proactive:'normal'}, {proactive:'chatty'}, {proactive:'loud'}, {callName:null}, {callName:'  Mira\n\t\u0000\u007f  さん  '}, {callName:'\u0085A\u180eB\ufeff C\u2028D'}, {callName:'x'.repeat(48)}, {callName:'x'.repeat(49)}, {callName:'😀'.repeat(24)}, {callName:'😀'.repeat(25)}, {callName:'a'.repeat(23)+'😀'}, {lines:null}, {lines:[]}, {lines:{}}, {lines:{waiting:' hi\n\tthere {n} ' }}, {lines:{waiting:null}}, {lines:{unknown:'hi'}}, {lines:{waiting:'x'.repeat(200)}}, {lines:{waiting:'x'.repeat(201)}}, {lines:{waiting:'a'.repeat(99)+'😀'}}, {lines:{'opening.day':'x\ud800\ue000','back.hello':''}}, {permission:true}, {tone:'polite',allowNetwork:true}])record('voice',`voice-${cases.length}`,input);
record('voice','whole-lines-replacement',{lines:{waiting:'new'}},{tone:'soft',callName:'old',proactive:'chatty',lines:{'back.hello':'old',waiting:'old'}});
record('voice','missing-legacy-properties',{},{});
for(const input of [null,false,1,'',[],{}, {unknown:'ignored',permissions:'allow'}, {companion:'\ufeff Main \u00a0'}, {companion:1}, {companion:'x'.repeat(1999)}, {companion:'x'.repeat(2000)}, {companion:'😀'.repeat(999)}, {companion:'😀'.repeat(1000)}, {model:'x\ud800\ue000'}, {maxSteps:0}, {maxSteps:1}, {maxSteps:512}, {maxSteps:513}, {maxSteps:1.5}, {maxTokens:127}, {maxTokens:128}, {maxTokens:8192}, {maxTokens:8193}, {concurrency:0}, {concurrency:1}, {concurrency:32}, {concurrency:33}, {provider:'ollama'}, {provider:'unknown'}, {provider:null}, {apiKeyEnv:'_A1'}, {apiKeyEnv:'bad-name'}, {apiKeyEnv:'A'.repeat(101)}, {apiKeyEnv:'A'.repeat(102)}, {apiKeyEnv:'\n A \n'}])record('settings',`settings-${cases.length}`,input);
for(const field of ['dictationEditing','codexEnabled','codexNetwork','allowCloud','allowNetwork','shareMemory','voiceEnabled','autoAmbient'])for(const value of [true,false,0,'true',null])record('settings',`${field}-${String(value)}`,{[field]:value});
for(const field of ['baseUrl','asrUrl','asrStreamUrl','decisionUrl','newsUrl'])for(const url of ['', 'not a url','http://127.0.0.1:8080/v1','http://[::1]:8080/v1','http://localhost/v1','http://localhost./v1','http://0x7f000001/v1','https://model.invalid/v1','http://model.invalid/v1','https://u:p@model.invalid/v1','http://localhost/v1?x=1','http://localhost/v1#x','http://localhost/v1?','http://localhost/v1#','ftp://localhost/v1'])record('settings',`${field}-${url}`,{[field]:url});
record('settings','enable-cloud',{allowCloud:true,baseUrl:'https://model.invalid/v1'});
record('settings','revoke-cloud-with-saved-url',{allowCloud:false},{...DEFAULT_SETTINGS,allowCloud:true,baseUrl:'https://model.invalid/v1'});
record('settings','cannot-swap-cloud-after-revoke',{allowCloud:false,baseUrl:'https://other.invalid/v1'},{...DEFAULT_SETTINGS,allowCloud:true,baseUrl:'https://model.invalid/v1'});
record('settings','enable-news',{allowNetwork:true,newsUrl:'https://news.invalid/feed'});
record('settings','revoke-news-with-saved-url',{allowNetwork:false},{...DEFAULT_SETTINGS,allowNetwork:true,newsUrl:'https://news.invalid/feed'});
record('settings','cannot-swap-news-after-revoke',{allowNetwork:false,newsUrl:'https://other.invalid/feed'},{...DEFAULT_SETTINGS,allowNetwork:true,newsUrl:'https://news.invalid/feed'});
record('settings','preserve-unknown-saved-fields',{}, {...DEFAULT_SETTINGS,oldUnknown:{keep:true}});
for(const suffix of ['\n','\r','\r\n','\u2028','\u2029'])record('settings',`saved-env-line-terminator-${JSON.stringify(suffix)}`,{}, {...DEFAULT_SETTINGS,apiKeyEnv:'EXISTING_KEY'+suffix});
const output=new URL('../src/workspace/preferences/fixtures/source.json',import.meta.url);
await writeFile(output,JSON.stringify({schema:1,cases},null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,voice:cases.filter(x=>x.op==='voice').length,personas:cases.filter(x=>x.op==='personas').length,settings:cases.filter(x=>x.op==='settings').length}));

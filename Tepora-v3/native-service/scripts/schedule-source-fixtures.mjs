// Test-only source oracle. No real timers, reminders, models, or external calls.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
process.env.TZ='UTC';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=await readFile(path.join(root,'core/agent/schedule.mjs'),'utf8');
const runtime=await readFile(path.join(root,'core/agent/runtime.mjs'),'utf8');
const format=await readFile(path.join(root,'core/tools/format.mjs'),'utf8');
const oneLine=new Function(format.slice(format.indexOf('export function oneLine'),format.indexOf('export function argsLabel')).replace('export ','')+';return oneLine;')();
let serial=0;
const invariant=(ok,message,status=400)=>{if(!ok)throw Object.assign(new Error(message),{status});};
const {parseWhen,Scheduler,scheduleTool}=new Function('randomUUID','invariant','oneLine','setInterval','clearInterval',source.replace(/^import .*;\n/gm,'').replace(/export /g,'')+';return {parseWhen,Scheduler,scheduleTool};')(()=>String(++serial).padStart(8,'0')+'-fixture',invariant,oneLine,()=>({unref(){}}),()=>{});
const now=Date.parse('2026-10-07T12:34:56.789Z');
const dateInputs=['15:00','9:30','00:00','24:00','23:99','99:99','2026-10-07','2025-02-29','2026-02-30','2026-13-01','2026-00-01','2026-10-00','2026-10-32','2026-10-07T15:00','2026-10-07T15:00:12.345Z','2026-10-07T15:00:12.345678Z','2026-10-07T24:00:00Z','2026-10-07T24:01:00Z','2026-10-07T12:34:60Z','2026-10-07T15:00+09:00','2026-10-07T15:00-0730','2026-10-07t15:00z','2026-10-07Z','2026','2026-10','2026/10/7','10/7/2026','2026-1-2 3:04','0','1','12','31','49','50','Wed, 07 Oct 2026 15:00:00 GMT','Oct 7, 2026 15:00','7 Oct 2026 15:00','not a date','7 Oct 2026 3:00 PM GMT','2026-10-07 GMT','Oct 7 2026 15:00 GMT','+275760-09-13T00:00:00.000Z','-271821-04-20T00:00:00.000Z','+275760-09-13T00:00:00.001Z','+275760-09-13T00:00','-271821-04-20T00:00'];
const dates=dateInputs.map(input=>{const ms=parseWhen(input,now).getTime();return {input,ms:Number.isNaN(ms)?null:ms};});
function fixture(){
 const docs=new Map(),events=[],sent=[],spawned=[];
 const store={list:()=>[...docs.values()].map(d=>({...d})),get:(_,id)=>docs.get(id)||null,put:(_,doc)=>docs.set(doc.id,{...doc}),remove:(_,id)=>docs.delete(id),emit:(type,data)=>events.push({type,data:JSON.parse(JSON.stringify(data))})};
 const rt={store,clock:()=>now,main:()=>({id:'main',kind:'main'}),send:(id,body)=>sent.push({id,body}),spawn:async(parent,body)=>{spawned.push({parent:parent.id,body});},event:()=>{},closed:false};
 return {scheduler:new Scheduler(rt),docs,events,sent,spawned};
}
const additions=[];
for(const args of [{text:'  fixture  ',in_minutes:0},{text:'future boundary',at:'+275760-09-13T00:00:00.000Z'},{text:'past boundary',at:'-271821-04-20T00:00:00.000Z'},{text:'fraction',in_minutes:0.5,every_minutes:5},{text:'date',at:'2026-10-08'},{text:'roll',at:'00:00',mode:'task'},{text:'bad',in_minutes:-1},{text:'bad',in_minutes:'2'},{text:'bad',at:'invalid'},{text:'bad',in_minutes:0,every_minutes:4},{text:'bad',in_minutes:0,every_minutes:5.5},{text:'bad',in_minutes:0,mode:'unknown'},{text:'   ',in_minutes:0}]){
 const f=fixture();try{const doc=f.scheduler.add({...args,createdBy:'worker'});doc.id='<id>';additions.push({args,value:doc});}catch(error){additions.push({args,error:{status:error.status,message:error.message}});}
}
const f=fixture();
for(const args of [{text:'one shot',in_minutes:0},{text:'recurring',at:'2026-10-07T12:00:00Z',every_minutes:30},{text:'future',in_minutes:1},{text:'task fixture',in_minutes:0,mode:'task'}])f.scheduler.add(args);
f.events.length=0;const before=f.scheduler.list();f.scheduler.tick();await Promise.resolve();const first={remaining:f.scheduler.list(),events:[...f.events],sent:[...f.sent],spawned:[...f.spawned]};
f.events.length=0;f.sent.length=0;f.spawned.length=0;f.scheduler.tick();const second={remaining:f.scheduler.list(),events:f.events,sent:f.sent,spawned:f.spawned};
const heartbeatSource=runtime.slice(runtime.indexOf(' heartbeatState(){'),runtime.indexOf(' scheduleHeartbeat(){')).replace(' heartbeatState()','function heartbeatState()');
const heartbeatState=new Function('oneLine','createHash',heartbeatSource+';return heartbeatState;')(oneLine,createHash);
const heartbeat=[];
for(const scenario of [{sessions:[],approvals:[]},{sessions:[{id:'worker-111',kind:'worker',title:'Research',status:'running',note:'step one',stats:{steps:1}}],approvals:[]},{sessions:[{id:'worker-111',kind:'worker',title:'Research',status:'running',note:'step 100',stats:{steps:100}}],approvals:[]},{sessions:[{id:'worker-111',kind:'worker',title:'Research',status:'waiting',note:'Question\nfor user',stats:{steps:2}}],approvals:[]},{sessions:[{id:'worker-111',kind:'worker',title:'Done',status:'done',accepted:true}],approvals:[]},{sessions:[{id:'worker-111',kind:'worker',title:'Done',status:'done',accepted:false}],approvals:[{id:'a',status:'pending'},{id:'b',status:'pending'},{id:'c',status:'allowed'}]}])heartbeat.push({...scenario,value:heartbeatState.call({sessions:{list:()=>scenario.sessions},store:{list:()=>scenario.approvals}})});
const displays=[];
for(const at of ['0000-01-01T00:00:00Z','0001-01-01T00:00:00Z','0099-01-01T00:00:00Z','0999-01-01T00:00:00Z','+010000-01-01T00:00:00Z','+275760-09-13T00:00:00.000Z','-271821-04-20T00:00:00.000Z']) {
 const f=fixture();const doc=f.scheduler.add({text:'date display',at});
 displays.push({doc,text:(await scheduleTool(f.scheduler).run({action:'list'},{})).text});
}
const sorted=displays.map(d=>d.doc).sort((a,b)=>a.at.localeCompare(b.at)).map(d=>d.id);
// Isolated child processes keep TZ mutations out of the running test process.
const zones=[];
for(const [zone,at,nowText] of [
 ['America/New_York','02:30','2026-03-08T05:00:00Z'],
 ['America/New_York','01:30','2026-11-01T04:00:00Z'],
 ['Australia/Lord_Howe','02:15','2026-10-03T13:30:00Z'],
 ['Asia/Tokyo','2026-10-08','2026-10-07T12:34:56Z'],
 ['Asia/Tokyo','+275760-09-13T00:00','2026-10-07T12:34:56Z'],
 ['America/New_York','+275760-09-12T00:00','2026-10-07T12:34:56Z'],
]) {
 const code=`const parseWhen=${parseWhen.toString()}; process.stdout.write(String(parseWhen(${JSON.stringify(at)},Date.parse(${JSON.stringify(nowText)})).getTime()));`;
 const ms=Number(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TZ:zone},encoding:'utf8'}));
 zones.push({zone,at,now:Date.parse(nowText),ms});
}
const out=path.join(root,'native-service/src/agent/scheduler');await mkdir(out,{recursive:true});
await writeFile(path.join(out,'catalog.json'),JSON.stringify({readOnly:false,ephemeral:false,...scheduleTool(f.scheduler)},null,2)+'\n');
await writeFile(path.join(out,'fixtures.json'),JSON.stringify({now,dates,additions,tick:{before,first,second},heartbeat,zones,displays,sorted},null,2)+'\n');
await writeFile(path.join(out,'SOURCE-HASHES.txt'),[['core/agent/schedule.mjs',source],['core/agent/runtime.mjs',runtime],['core/tools/format.mjs',format]].map(([name,text])=>createHash('sha256').update(text).digest('hex')+'  '+name).join('\n')+'\n');

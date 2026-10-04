/** Stacked approvals: work continues while the person is away; only the exact approved action runs later. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {Harness} from '../core/harness.mjs';
import {Connectors} from '../core/connectors.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=4000){const start=Date.now();while(!fn()){if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(10);}}
const node=process.execPath;
const write=(file,text,append=false)=>JSON.stringify({executable:node,args:['-e',`require('fs').${append?'appendFileSync':'writeFileSync'}(${JSON.stringify(file)},${JSON.stringify(text)})`]});
const call=(id,name,args)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}}]});
const lastTool=messages=>[...messages].reverse().find(m=>m.role==='tool');
const userInput=messages=>messages.find(m=>m.role==='user')?.content||'';

async function fixture(t,{presence='away',windows}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-stack-')),stores=[new Store(dir)],harnesses=[];
 stores[0].value('execution-config',{revision:1,mode:'legacy-host',image:'',imageApproved:false}); // Explicit legacy-host opt-in for host command fixtures.
 stores[0].settings={...stores[0].settings,concurrency:1};
 const open=(store,model)=>{const h=new Harness(store,new Connectors(store),{runtimeFactory:()=>({decide:async()=>null,chat:async messages=>model(messages)}),approvalWindows:windows});h.presence=()=>presence;harnesses.push(h);return h;};
 t.after(async()=>{for(const h of harnesses){if(!h.closed)h.close();await until(()=>h.active.size===0);}for(const s of stores)try{s.close();}catch{}await rm(dir,{recursive:true,force:true});});
 return {dir,store:stores[0],open,reopen(){stores.at(-1).close();const s=new Store(dir);stores.push(s);return s;},file:(id,name)=>path.join(dir,'workspace','tasks',id,name)};
}
/** A deterministic worker: request the command, do independent work, then report what is waiting. */
function organizer(text='approved later'){
 return messages=>{
  if(userInput(messages)==='quick')return {role:'assistant',content:'Quick job done.'};
  const tool=lastTool(messages);
  if(!tool)return call('cmd','run_command',write('a.txt',text));
  if(tool.tool_call_id==='cmd')return call('notes','workspace_write',{path:'notes.txt',content:'independent work'});
  if(tool.tool_call_id==='notes')return {role:'assistant',content:'Notes are written; moving the files waits for approval.'};
  return {role:'assistant',content:tool.content.includes('"denied":true')?'Declined; nothing was moved.':'Everything is done.'};
 };
}

test('away: a stacked approval lets independent work finish, frees the worker slot and runs only after approval',async t=>{
 const f=await fixture(t),h=f.open(f.store,organizer());
 const a=h.submit('organize'),b=h.submit('quick');
 await until(()=>f.store.get('job',a.id).status==='waiting_approval'&&f.store.get('job',a.id).parked);
 await until(()=>f.store.get('job',b.id).status==='review');
 assert.equal(await readFile(f.file(a.id,'notes.txt'),'utf8'),'independent work');
 await assert.rejects(readFile(f.file(a.id,'a.txt')));
 const parked=f.store.get('job',a.id);
 assert.equal(parked.pendingApprovals,1);assert.equal(parked.approval.name,'run_command');assert.equal(parked.approval.stacked,true);assert.equal(h.active.size,0);
 const deferred=f.store.get('checkpoint',a.id).messages.find(m=>m.role==='tool'&&m.tool_call_id==='cmd');
 assert.match(deferred.content,/"deferred":true/);assert.match(deferred.content,/"notExecuted":true/);
 assert.equal(f.store.list('effect').filter(e=>e.jobId===a.id&&e.name==='run_command').length,0);
 assert.deepEqual(h.approvalList().filter(x=>x.status==='pending').map(x=>x.id),[parked.approval.id]);
 h.approve(parked.approval.id,true);
 await until(()=>f.store.get('job',a.id).status==='review');
 assert.equal(await readFile(f.file(a.id,'a.txt'),'utf8'),'approved later');
 const record=f.store.get('approval',parked.approval.id);
 assert.equal(record.status,'executed');assert.equal(record.outcome,'done');assert.equal(h.approvals.size,0);
 assert.equal(f.store.get('job',a.id).pendingApprovals,0);assert.equal(f.store.get('job',a.id).parked,false);
 assert.equal(f.store.list('effect').filter(e=>e.jobId===a.id&&e.name==='run_command'&&e.status==='succeeded').length,1);
});

test('a refusal made later is reported to the worker and nothing runs',async t=>{
 const f=await fixture(t),h=f.open(f.store,organizer());const a=h.submit('organize');
 await until(()=>f.store.get('job',a.id).parked);const id=f.store.get('job',a.id).approval.id;
 h.approve(id,false);await until(()=>f.store.get('job',a.id).status==='review');
 await assert.rejects(readFile(f.file(a.id,'a.txt')));
 assert.equal(f.store.get('approval',id).status,'denied');assert.equal(f.store.get('approval',id).outcome,'declined');
 assert.match(f.store.get('job',a.id).output,/Declined/);
 assert.equal(f.store.list('effect').filter(e=>e.name==='run_command').length,0);
});

test('the same pending action is stacked once and runs once',async t=>{
 const f=await fixture(t);let n=0;
 const h=f.open(f.store,messages=>{const tool=lastTool(messages);
  if(!tool){n++;return {role:'assistant',content:null,tool_calls:['x','y'].map(id=>({id,type:'function',function:{name:'run_command',arguments:write('count.txt','+',true)}}))};}
  return {role:'assistant',content:tool.tool_call_id.startsWith('approved-')?'Ran once.':'Waiting for approval.'};});
 const a=h.submit('append once');await until(()=>f.store.get('job',a.id).parked);
 assert.equal(f.store.list('approval').filter(x=>x.jobId===a.id).length,1);
 h.approve(f.store.get('job',a.id).approval.id,true);await until(()=>f.store.get('job',a.id).status==='review');
 assert.equal(await readFile(f.file(a.id,'count.txt'),'utf8'),'+');assert.equal(n,1);
});

test('steering a parked job invalidates its stacked approval and resumes with the new instruction',async t=>{
 const f=await fixture(t);
 const h=f.open(f.store,messages=>{const tool=lastTool(messages);if(messages.some(m=>m.role==='user'&&m.content.startsWith('追加指示')))return {role:'assistant',content:'Changed course; nothing was moved.'};
  return tool?{role:'assistant',content:'Waiting for approval.'}:call('cmd','run_command',write('a.txt','never'));});
 const a=h.submit('organize');await until(()=>f.store.get('job',a.id).parked);const id=f.store.get('job',a.id).approval.id;
 h.steer(a.id,'動かさずに一覧だけ作って');
 assert.throws(()=>h.approve(id,true),/no longer/);
 await until(()=>f.store.get('job',a.id).status==='review');
 assert.equal(f.store.get('approval',id).status,'stale');await assert.rejects(readFile(f.file(a.id,'a.txt')));
 assert.equal(f.store.list('effect').length,0);
});

test('cancelling or pausing a parked job withdraws its stacked approvals',async t=>{
 const f=await fixture(t),h=f.open(f.store,organizer());
 const a=h.submit('organize');await until(()=>f.store.get('job',a.id).parked);const first=f.store.get('job',a.id).approval.id;
 h.cancel(a.id);assert.equal(f.store.get('job',a.id).status,'cancelled');assert.equal(f.store.get('approval',first).status,'withdrawn');assert.equal(h.approvals.size,0);
 assert.throws(()=>h.approve(first,true),/no longer/);
 const b=h.submit('organize');await until(()=>f.store.get('job',b.id).parked);const second=f.store.get('job',b.id).approval.id;
 h.pause(b.id);assert.equal(f.store.get('job',b.id).status,'paused');assert.equal(f.store.get('approval',second).status,'withdrawn');
});

test('parked work and its stacked approvals survive a service restart',async t=>{
 const f=await fixture(t),h=f.open(f.store,organizer('after restart'));
 const a=h.submit('organize');await until(()=>f.store.get('job',a.id).parked);const id=f.store.get('job',a.id).approval.id;
 h.close();await until(()=>h.active.size===0);
 const store=f.reopen();assert.equal(store.get('job',a.id).status,'waiting_approval');assert.equal(store.get('job',a.id).parked,true);
 const next=f.open(store,organizer('after restart'));assert.equal(next.approvals.size,1);
 next.approve(id,true);await until(()=>store.get('job',a.id).status==='review');
 assert.equal(await readFile(f.file(a.id,'a.txt'),'utf8'),'after restart');assert.equal(store.get('approval',id).status,'executed');
});

test('a request decided while the worker is present runs inline without parking',async t=>{
 const f=await fixture(t,{presence:'present'}),h=f.open(f.store,organizer('inline'));
 f.store.listeners.add(e=>{if(e.type==='job.updated'&&e.data.approval&&!e.data.approval.stacked)queueMicrotask(()=>{try{h.approve(e.data.approval.id,true);}catch{/* already decided */}});});
 const a=h.submit('organize');await until(()=>f.store.get('job',a.id).status==='review');
 assert.equal(await readFile(f.file(a.id,'a.txt'),'utf8'),'inline');assert.notEqual(f.store.get('job',a.id).parked,true);
 assert.equal(f.store.list('approval').find(x=>x.jobId===a.id).status,'approved');
});

test('live screen approvals are never stacked; silence pauses the job instead of counting as refusal',async t=>{
 const f=await fixture(t,{windows:{live:{away:30}}});let seen=0;
 const h=f.open(f.store,messages=>{seen++;return lastTool(messages)?{role:'assistant',content:'unexpected'}:call('see','computer_see',{});});
 const a=h.submit('look at the screen');await until(()=>f.store.get('job',a.id).status==='paused');
 const record=f.store.list('approval').find(x=>x.jobId===a.id);
 assert.equal(record.mode,'live');assert.equal(record.status,'expired');assert.equal(seen,1);assert.match(f.store.get('job',a.id).note,/在席/);assert.equal(h.approvals.size,0);
});

test('a stacked media request inside an effectful tool is recorded as not executed, never unknown',async t=>{
 const f=await fixture(t);
 const h=f.open(f.store,messages=>lastTool(messages)?{role:'assistant',content:lastTool(messages).content.includes('"denied":true')?'Not generated.':'Waiting.'}:call('img','media_generate',{kind:'image',prompt:'A quiet morning',requestId:'image-request-1'}));
 h.capabilities.save({profiles:[{id:'img',name:'img',protocol:'openai-images',baseUrl:'http://127.0.0.1:9/v1',model:'fixture',domain:'device'}],routes:{image:'img'}},0);
 const a=h.submit('make a picture');await until(()=>f.store.get('job',a.id).parked);
 assert.equal(f.store.get('effect',`${a.id}:img`).status,'not_executed');assert.equal(f.store.get('job',a.id).approval.name,'generate_media');
 h.approve(f.store.get('job',a.id).approval.id,false);await until(()=>f.store.get('job',a.id).status==='review');
 assert.equal(h.media.list().length,0);
});

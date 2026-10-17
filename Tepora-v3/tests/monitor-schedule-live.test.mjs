import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {AgentUIModel} from '../core/agent/ui-model.mjs';
import {Scheduler} from '../core/agent/schedule.mjs';
import {startServer} from '../core/server.mjs';
import {ambientCards,applyScheduleView} from '../web/ambient.mjs';

test('real scheduler add/cancel/fire projects committed rows before receipts and survives reopen',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-monitor-schedules-'));
 let store=new Store(dir),now=Date.parse('2026-10-18T08:00:00Z');
 const delivered=[],rt={store,closed:false,clock:()=>now,main:()=>({id:'main'}),send:(_id,value)=>delivered.push(value)};
 const scheduler=new Scheduler(rt),ui=new AgentUIModel(store,rt),events=[];let projected=[];
 store.listeners.add(event=>{events.push(event);if(event.type==='schedule.view')projected=applyScheduleView(projected,event.data);});
 t.after(async()=>{scheduler.close();ui.close();store.close();await rm(dir,{recursive:true,force:true});});
 const rows=()=>projected;
 const cancelled=scheduler.add({text:'Cancel this',in_minutes:20});
 assert.deepEqual(rows(),[cancelled]);assert.deepEqual(events.slice(-2).map(e=>e.type),['schedule.view','schedule.updated']);
 assert.equal(events.at(-2).seq,null);assert.equal(typeof events.at(-1).seq,'number');
 scheduler.cancel(cancelled.id);assert.deepEqual(rows(),[]);
 const once=scheduler.add({text:'A real reminder <b>',in_minutes:0});
 const repeat=scheduler.add({text:'Recurring work',in_minutes:0,every_minutes:60});
 assert.equal(store.snapshot().schedules.length,2,'bootstrap uses the saved schedule collection');
 const html=ambientCards({widgets:['schedule'],schedule:{items:store.snapshot().schedules}})[0].html;
 assert.match(html,/A real reminder &lt;b&gt;/);assert.match(html,/Recurring work/);
 await scheduler.fire(once,now,new AbortController().signal);
 assert.equal(store.get('schedule',once.id),null);assert.deepEqual(rows().map(d=>d.id),[repeat.id]);
 assert.equal(events.at(-1).data.removed,undefined,'one-shot source receipt is not mistaken for a remaining row');
 await scheduler.fire(repeat,now,new AbortController().signal);
 assert.equal(rows()[0].at,'2026-10-18T09:00:00.000Z');assert.equal(rows()[0].fired,1);
 assert.equal(events.at(-1).data.at,repeat.at,'recurring source receipt still describes the old occurrence');
 assert.equal(delivered.length,2,'read-only projections do not deliver any extra work');
 const before=store.snapshot().schedules;
 ui.close();store.close();store=new Store(dir);
 assert.deepEqual(store.snapshot().schedules,before,'reload reads the same committed next occurrence');
});

async function firstEvent(app,since,extra={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
 let reader;
 try{
  const response=await fetch(app.origin+`/api/events?since=${since}`,{headers:{Cookie:app.cookie,...extra},signal:controller.signal});
  assert.equal(response.status,200);reader=response.body.getReader();
  let raw='';const decoder=new TextDecoder();
  while(!raw.includes('\n\n')){const chunk=await reader.read();assert.equal(chunk.done,false);raw+=decoder.decode(chunk.value,{stream:true});}
  return JSON.parse(raw.split('\n').find(line=>line.startsWith('data: ')).slice(6));
 }finally{clearTimeout(timer);controller.abort();await reader?.cancel().catch(()=>{});}
}
test('HTTP bootstrap, bootstrap-cursor schedule replay and reconnect use authoritative schedules',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-monitor-schedule-http-'));
 const app=await startServer({dir,agentOptions:{autoStart:false}});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const launch=await fetch(app.launchUrl,{redirect:'manual'});app.cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=async()=>{const response=await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:app.cookie}});assert.equal(response.status,200);return response.json();};
 const early=await bootstrap();assert.deepEqual(early.schedules,[]);
 const item=app.agent.scheduler.add({text:'Between bootstrap and subscription',in_minutes:60});
 const replay=await firstEvent(app,early.seq);
 assert.equal(replay.type,'snapshot');assert.deepEqual(replay.data.schedules,[item]);
 const boot=await bootstrap();assert.deepEqual(boot.schedules,[item]);
 app.agent.scheduler.cancel(item.id);
 const removed=await firstEvent(app,boot.seq);assert.equal(removed.type,'snapshot');assert.deepEqual(removed.data.schedules,[]);
 const reconnect=await firstEvent(app,0,{'Last-Event-ID':String(boot.seq)});
 assert.equal(reconnect.type,'snapshot');assert.deepEqual(reconnect.data.schedules,[]);
});

/** Ordinary custom-skill CRUD parity against both real HTTP hosts. Every skill
 * is synthetic inert text. No shared scan, file discovery, skill dispatch,
 * model/provider call, authentication probe or policy/security suite is run.
 * Build core and the exact native binary before running this file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startServer} from '../core/server.mjs';
import {Store} from '../core/store.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const inert={name:'Synthetic skill',description:'Synthetic metadata only',content:'Inert text. This fixture is never loaded or executed.'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label){for(let n=0;n<200;n++){const v=fn();if(v)return v;await pause(25);}throw new Error('Timed out: '+label);}
function deadline(promise,label,ms=15000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms);})]).finally(()=>clearTimeout(timer));}
function saved(data,read){const store=new Store(data);try{return read(store);}finally{store.close();}}
const skillEvents=store=>store.events().filter(e=>e.type==='skill.updated'||e.type==='skill.deleted');
async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-native-skills-'))),empty=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');
 await mkdir(empty);await writeFile(bundle,'// Inert custom-skill CRUD fixture\n');let serial=0;
 async function start(native,{agent=true,data=path.join(dir,`${native?'native':'node'}-${serial++}`),seed}={}){
  if(seed)saved(data,seed);
  let launchUrl,close;
  if(!native){const app=cleanup.service(await startServer({dir:data}));launchUrl=app.launchUrl;close=app.close;}
  else{
   const child=spawn(binary,['--dev-native',...(agent?['--agent']:[]),'--sidecar','--port','0','--data-dir',data,'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
   let stderr='',exit;child.stderr.on('data',value=>stderr=(stderr+value).slice(-20000));child.stdin.on('error',()=>{});
   const exited=new Promise(resolve=>{child.once('error',error=>{exit={error};resolve(exit);});child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);});});
   const lines=createInterface({input:child.stdout});
   const owner=cleanup.service({close:async()=>{
    if(!exit){child.stdin.write('shutdown\n');try{await deadline(exited,'native shutdown');}catch(error){child.kill('SIGKILL');await exited;throw error;}}
    lines.close();assert.equal(exit.code,0,stderr||String(exit.error||exit.signal));
   }});close=owner.close;
   const ready=await deadline(Promise.race([new Promise((resolve,reject)=>lines.once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}})),exited.then(()=>{throw new Error('Native startup: '+stderr+(exit.error?.message||''));})]),'native readiness');launchUrl=ready.url;
  }
  const launch=await fetch(launchUrl,{redirect:'manual'});assert.equal(launch.status,303);
  const cookie=launch.headers.get('set-cookie').split(';')[0],origin=new URL(launchUrl).origin;
  const bootstrap=await (await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
  const request=(route,method='GET',body)=>fetch(origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const json=async(route,method,body,status=200)=>{const response=await request(route,method,body),value=await response.json();assert.equal(response.status,status,`${method||'GET'} ${route}: ${JSON.stringify(value)}`);return value;};
  const stream=async()=>{
   const controller=new AbortController(),events=[];
   const response=await fetch(origin+'/api/events',{headers:{Cookie:cookie,'Last-Event-ID':'0'},signal:controller.signal});assert.equal(response.status,200);
   const reader=response.body.getReader(),decoder=new TextDecoder();
   const done=(async()=>{let pending='';try{while(true){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let index;while((index=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,index);pending=pending.slice(index+2);for(const line of block.split('\n'))if(line.startsWith('data: '))events.push(JSON.parse(line.slice(6)));}}}catch(error){if(!controller.signal.aborted)throw error;}})();
   await wait(()=>events.some(e=>e.type==='snapshot'),'initial event snapshot');
   const stop=async()=>{controller.abort();await done;};t.after(stop);return {events,stop};
  };
  return {request,json,data,close,stream};
 }
 return {start};
}

function assertCreated(doc,body){
 assert.deepEqual(Object.keys(doc),['id','name','description','content','enabled','createdAt']);
 assert.match(doc.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.match(doc.createdAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
 assert.deepEqual({...doc,id:null,createdAt:null},{id:null,name:body.name.trim(),description:body.description.trim(),content:body.content.trim(),enabled:body.enabled!==false,createdAt:null});
}

test('native skills: exact CRUD documents, enabled defaults, unknown metadata and stable list order',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const legacy={id:'synthetic%20id',...inert,source:'synthetic',enabled:true,extra:{order:['a','b']},createdAt:'2020-01-02T03:04:05.006Z'};
  const c=await f.start(native,{seed:store=>store.put('skill',legacy)}),ids=[];
  for(const enabled of [undefined,false,true,null,0,'',[],{}]){
   const body={...inert,name:' \ufeff合成🌸\ud800\ue000\u3000',description:'\t説明\u2029',content:' \udc00\ue000🌸 inert \n',...(enabled===undefined?{}:{enabled}),id:'ignored',source:'ignored',createdAt:'ignored'};
   const doc=await c.json('/api/skills','POST',body,201);assertCreated(doc,body);ids.unshift(doc.id);
  }
  const before=(await c.json('/api/bootstrap')).skills;
  const updated=await c.json('/api/skills/synthetic%20id','PATCH',{enabled:false,name:'ignored',extra:null});
  assert.deepEqual(updated,{...legacy,enabled:false});assert.deepEqual(Object.keys(updated),Object.keys(legacy));
  const after=(await c.json('/api/bootstrap')).skills;assert.deepEqual(after.map(s=>s.id),before.map(s=>s.id));assert.deepEqual(after.slice(0,ids.length).map(s=>s.id),ids);
  assert.deepEqual(await c.json('/api/skills/synthetic%20id','DELETE','{ignored'),{deleted:true});
  assert.deepEqual(await c.json('/api/skills/synthetic%20id','DELETE','null'),{deleted:true});
  assert.deepEqual(await c.json('/api/skills/synthetic%20id','PATCH',{enabled:true},400),{error:'Unknown skill or invalid enabled flag'});
  await c.close();const events=saved(c.data,skillEvents);assert.equal(events.length,11);assert.deepEqual(events.slice(-2).map(e=>({type:e.type,data:e.data})),[1,2].map(()=>({type:'skill.deleted',data:{id:legacy.id}})));
 }
});

test('native skills: exact validation order, UTF-16 limits, primitive bodies and errors without writes',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native),doc=await c.json('/api/skills','POST',inert,201),id=doc.id;
  const before=(await c.json('/api/bootstrap')).seq;
  const error=async(route,method,body,status,message)=>assert.deepEqual(await c.json(route,method,body,status),{error:message});
  for(const body of [{},[],42,true,'"inert"'])await error('/api/skills','POST',body,400,'name: 1–100 characters required');
  await error('/api/skills','POST',null,500,"Cannot read properties of null (reading 'name')");
  await error('/api/skills','POST','{',400,'Invalid JSON body');
  for(const [field,max,label] of [['name',100,'name'],['description',1024,'description'],['content',32000,'SKILL.md']]){
   for(const value of ['',null,42,[],{},'\ufeff \n\t\u2029\u3000','🌸'.repeat(max/2)+'x','x'.repeat(max)+' '])await error('/api/skills','POST',{...inert,[field]:value},400,`${label}: 1–${max} characters required`);
  }
  for(const body of [{},{enabled:null},{enabled:1},{enabled:'true'},[],false,'"inert"'])await error('/api/skills/'+id,'PATCH',body,400,'Unknown skill or invalid enabled flag');
  await error('/api/skills/'+id,'PATCH',null,500,"Cannot read properties of null (reading 'enabled')");
  await error('/api/skills/missing','PATCH',null,400,'Unknown skill or invalid enabled flag');
  assert.equal((await c.json('/api/bootstrap')).seq,before,'validation errors do not emit events');
  assert.deepEqual((await c.json('/api/bootstrap')).skills.find(s=>s.id===id),doc);
  for(const [field,max] of [['name',100],['description',1024],['content',32000]]){
   const body={...inert,[field]:'🌸'.repeat(max/2)},created=await c.json('/api/skills','POST',body,201);assertCreated(created,body);
  }
  const unusual={...inert,name:'\u0085',description:'\u200b',content:'\ud800\ue000'};assertCreated(await c.json('/api/skills','POST',unusual,201),unusual);
  await c.close();
 }
});

function seedCachedSessions(store){
 const sessions=new SessionStore(store);
 for(const [id,kind,status,system] of [['cached-main','main','idle','stable cached prefix'],['done-fixture','worker','done','stable'],['stopped-fixture','worker','stopped','stable'],['unprompted-fixture','worker','idle','']])sessions.create({id,kind,extra:{status,system,tools:[]}});
}
test('native skills: real refresh snapshots, cache preservation, SSE order and no repeated notice',{timeout:60000},async t=>{
 const f=await fixture(t);
 for(const native of [false,true]){
  const c=await f.start(native,{seed:seedCachedSessions}),stream=await c.stream();
  const body={...inert,name:'ACTIVE_SYNTHETIC_SKILL',description:'VISIBLE_INERT_METADATA',content:'NEVER_LOAD_OR_EXECUTE_THIS_CONTENT'},doc=await c.json('/api/skills','POST',body,201),route='/api/skills/'+doc.id;
  const snapshot=()=>c.json('/api/agent/sessions/cached-main');
  let current=await snapshot();assert.equal(current.session.promptStale,true);assert.ok(!current.session.announced.system.includes(body.name),'valid empty declared toolset has no skill index');assert.ok(!current.session.announced.system.includes(body.content));
  assert.deepEqual(current.session.tools,[]);
  if(native)assert.ok(!current.session.announced.tools.includes('skill'),'native content-loading tool remains unavailable');
  await wait(()=>stream.events.some(e=>e.type==='session.updated'&&e.data.id==='cached-main'&&e.data.promptStale),'refreshed session event');
  const changed=stream.events.findIndex(e=>e.type==='skill.updated'&&e.data.id===doc.id),refreshed=stream.events.findIndex(e=>e.type==='session.updated'&&e.data.id==='cached-main'&&e.data.promptStale);assert.ok(changed>=0&&changed<refreshed,'skill.updated precedes refresh projections');
  for(const enabled of [false,true]){await c.json(route,'PATCH',{enabled});current=await snapshot();assert.ok(!current.session.announced.system.includes(body.name));}
  await c.json(route,'DELETE');current=await snapshot();assert.ok(!current.session.announced.system.includes(body.name));
  const notices=current.entries.filter(e=>e.promptUpdate);assert.equal(notices.length,1,'without a declared skill tool, later metadata changes do not add notices');
  await c.json(route,'DELETE');await c.json('/api/skills/artifact-studio','PATCH',{enabled:true});assert.deepEqual((await snapshot()).entries.filter(e=>e.promptUpdate),notices);
  for(const id of ['done-fixture','stopped-fixture','unprompted-fixture'])assert.deepEqual((await c.json('/api/agent/sessions/'+id)).entries,[]);
  await stream.stop();await c.close();assert.equal(saved(c.data,store=>store.get('session','cached-main').system),'stable cached prefix');
 }
});

test('native skills: one SQLite owner and cross-host restart preserve documents and durable event order',{timeout:60000},async t=>{
 const f=await fixture(t);let c=await f.start(false);const data=c.data;
 const first=await c.json('/api/skills','POST',{...inert,name:'First'},201),second=await c.json('/api/skills','POST',{...inert,name:'Second'},201);await c.close();
 c=await f.start(true,{data});assert.deepEqual((await c.json('/api/bootstrap')).skills.slice(0,2),[second,first]);
 const disabled=await c.json('/api/skills/'+first.id,'PATCH',{enabled:false});await c.close();
 c=await f.start(false,{data});assert.deepEqual((await c.json('/api/bootstrap')).skills.slice(0,2),[second,disabled]);await c.close();
 c=await f.start(true,{data});await c.json('/api/skills/'+first.id,'DELETE');await c.close();
 c=await f.start(false,{data});assert.ok(!(await c.json('/api/bootstrap')).skills.some(s=>s.id===first.id));await c.json('/api/skills/'+first.id,'DELETE');await c.close();
 const events=saved(data,skillEvents);assert.deepEqual(events.map(e=>[e.type,e.data.id,e.data.enabled]),[['skill.updated',first.id,true],['skill.updated',second.id,true],['skill.updated',first.id,false],['skill.deleted',first.id,undefined],['skill.deleted',first.id,undefined]]);
 assert.ok(events.every((e,i)=>!i||e.seq>events[i-1].seq));
 c=await f.start(true,{data});await c.close();assert.deepEqual(saved(data,skillEvents),events,'restart never replays CRUD events');
});

test('native skills: workspace-only mode refuses all mutations before parsing a body',{timeout:30000},async t=>{
 const f=await fixture(t),c=await f.start(true,{agent:false}),before=await c.json('/api/bootstrap');
 for(const [method,route] of [['POST','/api/skills'],['PATCH','/api/skills/artifact-studio'],['DELETE','/api/skills/artifact-studio']])await c.json(route,method,'{invalid',503);
 assert.deepEqual((await c.json('/api/bootstrap')).skills,before.skills);assert.equal((await c.json('/api/bootstrap')).seq,before.seq);await c.close();
});

/** Authenticated HTTP admissions with real persistence and files. The model
 * boundary is synthetic; no provider account, tool or external network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-input-admission-')));
 const denyNetwork=()=>{throw new Error('External network is forbidden in input admission tests');};
 const app=cleanup.service(await startServer({dir,agentOptions:{autoStart:false},networkOptions:{lookup:denyNetwork,transport:denyNetwork},
  registryOptions:{detectLimits:false,clientFactory:()=>({chat:async()=>({content:'Fixture reply.',finish:'stop',tool_calls:[],usage:{input:1,output:1}})})}}));
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',body)=>fetch(app.origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':boot.csrf,'Content-Type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(route,method,body,status=200)=>{const response=await request(route,method,body),value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
 await json('/api/agent/settings','PATCH',{verifyCompletion:'off',metacognition:false,dream:false,delegationGuard:false});
 await json('/api/providers','PUT',{expectedRevision:boot.providers.revision,config:{profiles:[{id:'fixture',protocol:'chat-completions',baseUrl:'http://127.0.0.1:9/v1',model:'fixture',domain:'device',contextTokens:131072,maxTokens:2048,capabilities:{tools:true}}],routes:{main:{primary:'fixture'}}}});
 async function inputs(){
  const deadline=Date.now()+8000;
  for(;;){
   const value=await json('/api/agent/sessions/'+boot.dialogue.session.id);
   if(['idle','done'].includes(value.session.status)&&value.entries.some(e=>e.type==='input'))return value.entries.filter(e=>e.type==='input');
   assert.ok(Date.now()<deadline,'input delivery completes: '+JSON.stringify({status:value.session.status,note:value.session.note,entries:value.entries.map(e=>e.type)}));await new Promise(resolve=>setTimeout(resolve,5));
  }
 }
 return {...app,dir,boot,request,json,inputs};
}

test('parallel messages preserve every same-named attachment without overwriting another message',async t=>{
 const a=await fixture(t),contents=['First attachment','Second attachment','Third attachment','Fourth attachment','Fifth attachment','Sixth attachment'];
 const staged=await a.json('/api/inputs','POST',{files:contents.map(content=>({name:'shared-name.txt',content}))},201);
 await Promise.all(staged.files.map((file,i)=>a.json('/api/agent/input','POST',{requestId:'different-message-'+i,text:'attachment-'+i,attachmentIds:[file.id]},202)));
 const entries=await a.inputs();assert.equal(entries.length,contents.length);
 const paths=contents.map((_,i)=>entries.find(e=>e.text.startsWith('attachment-'+i+'\n')).attachments[0].path);
 assert.equal(new Set(paths).size,contents.length,'each message owns a separate saved file');
 assert.deepEqual(await Promise.all(paths.map(file=>readFile(file,'utf8'))),contents);
});

test('later same-named attachments preserve files already delivered to the character',async t=>{
 const a=await fixture(t),staged=await a.json('/api/inputs','POST',{files:[{name:'existing.txt',content:'Original attachment.'},{name:'existing.txt',content:'Later attachment.'}]},201);
 for(let i=0;i<2;i++)await a.json('/api/agent/input','POST',{requestId:'sequential-attachment-'+i,text:'sequential-'+i,attachmentIds:[staged.files[i].id]},202);
 const entries=await a.inputs();assert.equal(entries.length,2);
 const original=entries.find(e=>e.text.startsWith('sequential-0\n')).attachments[0].path,later=entries.find(e=>e.text.startsWith('sequential-1\n')).attachments[0].path;
 assert.notEqual(original,later);
 assert.equal(await readFile(original,'utf8'),'Original attachment.');assert.equal(await readFile(later,'utf8'),'Later attachment.');
});

test('concurrent retries of one attachment request share one receipt, input and saved file',async t=>{
 const a=await fixture(t),staged=await a.json('/api/inputs','POST',{files:[{name:'retry.txt',content:'Only one saved copy.'}]},201);
 const body={requestId:'concurrent-retry-0001',text:'One user message',attachmentIds:[staged.files[0].id]};
 const receipts=await Promise.all(Array.from({length:8},()=>a.json('/api/agent/input','POST',body,202)));
 for(const receipt of receipts)assert.deepEqual(receipt,receipts[0]);
 const entries=await a.inputs();assert.equal(entries.length,1,'one logical request delivers one input');
 const file=entries[0].attachments[0].path;
 assert.deepEqual(await readdir(path.dirname(file)),[path.basename(file)],'retries do not create unused attachment copies');
 assert.equal(await readFile(file,'utf8'),'Only one saved copy.');
 assert.deepEqual(await a.json('/api/agent/input','POST',body,202),receipts[0]);
 assert.equal((await a.inputs()).length,1,'a later retry remains deduplicated');
});

test('failed attachment preparation releases the request id so a repaired retry can succeed once',async t=>{
 const a=await fixture(t),staged=await a.json('/api/inputs','POST',{files:[{name:'retry-after-error.txt',content:'Retried attachment.'}]},201);
 await mkdir(a.agent.workRoot,{recursive:true});
 const blocker=path.join(a.agent.workRoot,'inbox');await writeFile(blocker,'Existing user file.');
 const body={requestId:'retry-after-file-error',text:'Retry after repair',attachmentIds:[staged.files[0].id]};
 const failures=await Promise.all(Array.from({length:8},()=>a.request('/api/agent/input','POST',body)));
 assert.ok(failures.every(response=>response.status===500),'every caller receives the preparation failure');
 assert.equal(await readFile(blocker,'utf8'),'Existing user file.');
 await rm(blocker);
 const receipts=await Promise.all(Array.from({length:8},()=>a.json('/api/agent/input','POST',body,202)));
 for(const receipt of receipts)assert.deepEqual(receipt,receipts[0]);
 const entries=await a.inputs();assert.equal(entries.length,1);
 assert.equal(await readFile(entries[0].attachments[0].path,'utf8'),'Retried attachment.');
});

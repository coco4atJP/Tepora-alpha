import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../core/server.mjs';

async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-dialogue-http-'));
 const app=await startServer({dir,runtimeFactory:()=>({chat:async()=>({role:'assistant',content:'fixture character reply'})})});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 app.store.settings={...app.store.settings,model:'fixture'};
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(p,method='GET',body)=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':boot.csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...app,request,boot,cookie};
}

test('character dialogue HTTP is authenticated and bootstrapped independently of detail focus',async t=>{
 const a=await fixture(t);
 assert.equal((await fetch(a.origin+'/api/dialogue')).status,401);
 assert.equal((await fetch(a.origin+'/api/dialogue',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 const snapshot=await(await a.request('/api/dialogue')).json();
 assert.equal(a.boot.dialogue.session.id,snapshot.session.id);
 const initial=JSON.stringify(snapshot.session);
 const focus=await(await a.request('/api/companion/focus','POST',{jobId:null,expectedRevision:0})).json();
 assert.equal(focus.revision,1);
 assert.equal(JSON.stringify((await(await a.request('/api/dialogue')).json()).session),initial);
 const context=await(await a.request('/api/dialogue/context')).json();
 assert.equal(typeof context.id,'string');assert.equal(typeof context.label,'string');
 const body={requestId:'http-dialogue-request-0001',input:'hello',sessionId:snapshot.session.id,sessionRevision:snapshot.session.revision,contextConsent:context.id,attachmentIds:[]};
 const accepted=await a.request('/api/dialogue','POST',body);assert.equal(accepted.status,202);
 const first=await accepted.json();assert.ok(first.job.id);
 const repeated=await(await a.request('/api/dialogue','POST',body)).json();assert.equal(repeated.job.id,first.job.id);assert.equal(repeated.duplicate,true);
 assert.equal((await a.request('/api/dialogue','POST',{...body,input:'different'})).status,409);
 assert.equal((await a.request('/api/companion')).status,200);
});

test('character persona endpoint keeps worker settings separate and rejects stale updates',async t=>{
 const a=await fixture(t),before=await(await a.request('/api/dialogue/personas')).json();
 const patch={expectedRevision:before.revision,character:{name:'Koharu',instructions:'Speak gently and concisely.'},worker:{name:'Research worker',instructions:'Gather evidence and report uncertainty.'}};
 const changed=await a.request('/api/dialogue/personas','PUT',patch);assert.equal(changed.status,200);
 const result=await changed.json();assert.equal(result.character.name,'Koharu');assert.equal(result.worker.name,'Research worker');
 assert.equal((await a.request('/api/dialogue/personas','PUT',patch)).status,409);
 assert.equal((await(await a.request('/health')).json()).version,'3.0.0-beta.11');
});

test('result relay HTTP confirms one exact excerpt, revision and character recipient',async t=>{
 const a=await fixture(t),session=a.dialogue.session();
 const worker={id:'relay-worker',kind:'work',status:'review',revision:3,input:'explicit task',runtime:{...a.store.settings,baseUrl:'http://127.0.0.1:9999/v1'},engine:'builtin',characterSessionId:session.id,dialogueSequence:1,output:'Bounded result, not independently accepted.',consentEpoch:0,verification:{status:'needs-review',checks:{status:'passed'}}};
 a.store.put('job',worker);
 const parent={id:'relay-character',kind:'chat',runtime:a.store.settings,characterSessionId:session.id,consentEpoch:0};
 assert.equal(a.dialogue.workerStatus(parent).workers[0].contentAvailable,false);
 const response=await a.request('/api/dialogue/relay?jobId=relay-worker');assert.equal(response.status,200);
 const preview=await response.json();assert.equal(preview.excerpt,worker.output);assert.equal(preview.jobRevision,3);
 const consent={jobId:preview.jobId,jobRevision:preview.jobRevision,sessionId:preview.sessionId,contextId:preview.contextId,excerptHash:preview.excerptHash,consent:true};
 assert.equal((await a.request('/api/dialogue/relay','POST',{...consent,consent:false})).status,403);
 assert.equal((await a.request('/api/dialogue/relay','POST',{...consent,excerptHash:'wrong'})).status,409);
 const granted=await a.request('/api/dialogue/relay','POST',consent);assert.equal(granted.status,200);
 const repeated=await(await a.request('/api/dialogue/relay','POST',consent)).json();assert.equal(repeated.duplicate,true);
 assert.equal(a.dialogue.workerStatus(parent).workers[0].output,worker.output);
 assert.equal(Object.hasOwn(a.dialogue.workerStatus(parent).workers[0],'title'),false,'cross-recipient grant must not disclose an unapproved task title');
 a.store.put('job',{...worker,revision:4,output:'Later output must not inherit a grant'});
 assert.equal((await a.request('/api/dialogue/relay','POST',consent)).status,409);
 assert.equal(a.dialogue.workerStatus(parent).workers[0].contentAvailable,false);
 assert.equal((await a.request('/api/dialogue/relay?jobId=unknown')).status,409);
});

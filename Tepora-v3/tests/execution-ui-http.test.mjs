import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../core/server.mjs';
import {digest} from '../core/execution.mjs';

test('execution UI API requires auth/CSRF and promotes only the exact preview without acceptance',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-execution-ui-http-'));const app=await startServer({dir,runtimeFactory:()=>({chat:async()=>{throw Error('No model calls allowed');}})});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0],boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(p,method='GET',body)=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':boot.csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const job={id:'ui-worker',kind:'work',status:'review',revision:2,input:'Make an artifact',runtime:app.store.settings,engine:'builtin',consentEpoch:0};app.store.put('job',job);
 const unsigned={id:'ui-candidate',jobId:job.id,jobRevision:2,consentEpoch:0,artifactId:'ui-artifact',expectedVersion:0,title:'Preview title',kind:'text',content:'Exact candidate content',status:'staged',capsuleId:'fixture-capsule',runId:'fixture-run'};const candidate={...unsigned,sha256:digest(unsigned)};app.store.put('execution-candidate',candidate);
 assert.equal((await fetch(app.origin+'/api/execution')).status,401);assert.equal((await fetch(app.origin+'/api/execution/candidates/ui-candidate')).status,401);
 const snapshot=await(await request('/api/execution')).json();assert.equal(snapshot.mode,'protected');assert.equal(snapshot.availability.available,false);assert.equal(snapshot.candidates[0].content,undefined);
 const preview=await(await request('/api/execution/candidates/ui-candidate')).json();assert.equal(preview.content,candidate.content);assert.equal(preview.sha256,candidate.sha256);
 const body={jobId:job.id,candidateId:candidate.id,expectedHash:preview.sha256,expectedVersion:preview.expectedVersion};
 assert.equal((await fetch(app.origin+'/api/execution/promote',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
 assert.equal((await request('/api/execution/promote','POST',{...body,expectedHash:'changed'})).status,409);assert.equal(app.store.list('artifact').length,0);
 assert.equal((await request('/api/jobs/'+job.id+'/accept','POST',{expectedRevision:job.revision})).status,409);
 const result=await request('/api/execution/promote','POST',body);assert.equal(result.status,200);const artifact=await result.json();assert.equal(artifact.content,candidate.content);assert.equal(artifact.version,1);assert.match(artifact.provenance.verification,/content-unverified/);assert.equal(app.store.get('job',job.id).status,'review');
 assert.equal((await request('/api/execution/promote','POST',body)).status,409);
});

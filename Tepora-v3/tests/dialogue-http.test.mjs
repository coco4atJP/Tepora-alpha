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

test('character dialogue HTTP is authenticated, bootstrapped and delivered once per request id',async t=>{
 const a=await fixture(t);
 assert.equal((await fetch(a.origin+'/api/agent/dialogue')).status,401);
 assert.equal((await fetch(a.origin+'/api/agent/input',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 const snapshot=await(await a.request('/api/agent/dialogue')).json();
 assert.equal(a.boot.dialogue.session.id,snapshot.session.id);
 const body={requestId:'http-dialogue-request-0001',text:'hello',attachmentIds:[]};
 assert.equal((await a.request('/api/agent/input','POST',body)).status,409,'without a model the input is refused with a hint, not queued');
 a.registry.save({profiles:[{id:'m',protocol:'chat-completions',baseUrl:'http://127.0.0.1:9/v1',model:'fixture',domain:'device'}],routes:{main:{primary:'m'}}},a.registry.get().revision);
 const accepted=await a.request('/api/agent/input','POST',body);assert.equal(accepted.status,202);
 const first=await accepted.json();assert.equal(first.accepted,true);assert.equal(first.sessionId,snapshot.session.id);
 assert.deepEqual(await(await a.request('/api/agent/input','POST',body)).json(),first);
 const seen=[...a.agent.sessions.entries(snapshot.session.id,{types:['input']}),...a.agent.sessions.pending(snapshot.session.id)].filter(e=>e.text==='hello');
 assert.equal(seen.length,1,'a resent request id is delivered once');
});

test('character persona endpoint keeps worker settings separate and rejects stale updates',async t=>{
 const a=await fixture(t),before=await(await a.request('/api/dialogue/personas')).json();
 const patch={expectedRevision:before.revision,character:{name:'Koharu',instructions:'Speak gently and concisely.'},worker:{name:'Research worker',instructions:'Gather evidence and report uncertainty.'}};
 const changed=await a.request('/api/dialogue/personas','PUT',patch);assert.equal(changed.status,200);
 const result=await changed.json();assert.equal(result.character.name,'Koharu');assert.equal(result.worker.name,'Research worker');
 assert.equal((await a.request('/api/dialogue/personas','PUT',patch)).status,409);
 assert.match((await(await a.request('/health')).json()).version,/^3\.0\.0-beta\.\d+$/);
});

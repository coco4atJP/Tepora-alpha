import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {startServer} from '../core/server.mjs';
async function until(predicate){const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw Error('HTTP fixture deadline');await new Promise(r=>setTimeout(r,20));}}
test('real HTTP host: Pi catalogs, CSRF, generic auth, scoped inference and logout',async t=>{
 let dispatches=0;const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-pi-http-'));
 const app=await startServer({dir,registryOptions:{detectLimits:false},networkOptions:{lookup:async()=>[{address:'8.8.8.8',family:4}],transport:async({url},init)=>{
  assert.equal(url.href,'https://api.groq.com/openai/v1/chat/completions');assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-http-pi-key');dispatches++;
  return new Response('data: '+JSON.stringify({choices:[{delta:{role:'assistant',content:'real SDK'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }}});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 let r=await fetch(app.origin+'/api/pi/providers');assert.equal(r.status,401);await r.text();
 const launch=await fetch(app.launchUrl,{redirect:'manual'});await launch.text();const cookie=launch.headers.get('set-cookie').split(';')[0];const bootstrap=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',data,headers={})=>fetch(app.origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,'Content-Type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const providers=await(await request('/api/pi/providers')).json();assert.equal(providers.providers.length,42);assert.equal(providers.providers.filter(p=>p.oauth).length,9);
 for(const headers of [{'X-Tepora-CSRF':'wrong'},{Origin:'https://attacker.invalid'}]){r=await request('/api/pi/auth/start','POST',{provider:'groq',type:'api_key',consent:true},headers);assert.equal(r.status,403);await r.text();}
 r=await request('/api/pi/auth/start','POST',{provider:'groq'});assert.equal(r.status,403);await r.text();
 r=await request('/api/pi/auth/start','POST',{provider:'groq',type:'api_key',consent:true});assert.equal(r.status,200);await r.json();await until(()=>app.pi.snapshot().pending?.prompt);
 const pending=app.pi.snapshot().pending;r=await request('/api/pi/auth/respond','POST',{id:pending.id,promptId:pending.prompt.id+1,value:'wrong'});assert.equal(r.status,409);await r.text();
 r=await request('/api/pi/auth/respond','POST',{id:pending.id,promptId:pending.prompt.id,value:'synthetic-http-pi-key'});assert.equal(r.status,200);await r.json();await app.pi.pending.task;
 const auth=await(await request('/api/pi/auth')).json();assert.equal(auth.accounts[0].connected,true);assert.equal(JSON.stringify(auth).includes('synthetic-http-pi-key'),false);
 const catalog=await(await request('/api/pi/models?provider=groq')).json();const m=catalog.models.find(m=>m.id==='llama-3.3-70b-versatile');
 const profile={id:'pi-http',name:'Fixture',engine:'pi-ai',piProvider:'groq',model:m.id,protocol:m.protocol,baseUrl:m.baseUrl,domain:'cloud',authMode:'pi-key',accountId:auth.accounts[0].id};
 r=await request('/api/providers','PUT',{expectedRevision:0,config:{profiles:[profile],routes:{main:{primary:profile.id,fallbacks:[]}}}});assert.equal(r.status,200);await r.json();
 const answer=await app.registry.invoke('main',[{role:'user',content:'Hello'}]);assert.equal(answer.content,'real SDK');assert.equal(answer._native.engine,'pi-ai');assert.equal(dispatches,1);
 r=await request('/api/context/export');assert.equal((await r.text()).includes('synthetic-http-pi-key'),false);
 r=await request('/api/pi/auth/disconnect','POST',{accountId:profile.accountId});assert.equal(r.status,200);assert.equal((await r.json()).accounts[0].connected,false);
 await assert.rejects(app.registry.invoke('main',[{role:'user',content:'must not dispatch'}]),/ログイン/);assert.equal(dispatches,1);
});

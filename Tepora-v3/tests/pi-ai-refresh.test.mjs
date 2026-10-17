import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {PiAIService} from '../core/pi-ai.mjs';
import {validateProfile} from '../core/provider-registry.mjs';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const complete=()=>new Response('data: '+JSON.stringify({choices:[{delta:{role:'assistant',content:'done'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const renewed=()=>json({access_token:'synthetic-renewed',refresh_token:'synthetic-rotated',expires_in:3600});
async function until(predicate,timeout=8000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('Refresh fixture deadline');await new Promise(r=>setTimeout(r,10));}}
async function fixture(t,transport,options){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-pi-refresh-')),store=new Store(dir),network=new NetworkPolicy(store,{lookup:async()=>[{address:'8.8.8.8'}],transport}),pi=new PiAIService(store,network,options);
 t.after(async()=>{await pi.close();network.close();store.close();await rm(dir,{recursive:true,force:true});});
 const id='pi-11111111-1111-4111-8111-111111111111';
 pi.vault.accounts[id]={id,provider:'kimi-coding',type:'oauth',label:'Synthetic fixture',credential:{type:'oauth',access:'synthetic-expired',refresh:'synthetic-old',expires:0}};pi.persist();
 const m=pi.models('kimi-coding').models[0],profile=validateProfile({id:'kimi-refresh',name:'Fixture',engine:'pi-ai',piProvider:'kimi-coding',protocol:m.protocol,baseUrl:m.baseUrl,model:m.id,domain:'cloud',authMode:'pi-oauth',accountId:id,maxTokens:512});
 return {dir,store,network,pi,id,profile};
}
const diskCredential=async f=>JSON.parse(await readFile(f.pi.file,'utf8')).accounts[f.id].credential;

test('caller cancellation returns promptly while a rotated OAuth credential is durably drained',async t=>{
 let releaseRefresh,refreshSignal,refreshes=0,inferences=0;
 const f=await fixture(t,async({url},init)=>{
  if(url.hostname==='auth.kimi.com'){refreshes++;refreshSignal=init.signal;return new Promise(resolve=>{releaseRefresh=()=>resolve(renewed());});}
  inferences++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-renewed');return complete();
 });
 const cancel=new AbortController(),reason=new Error('fixture caller cancelled');
 const call=f.pi.chat(f.profile,'',[{role:'user',content:'fixture'}],{signal:cancel.signal});
 await until(()=>releaseRefresh);const job=[...f.pi.jobs][0];cancel.abort(reason);
 await Promise.race([assert.rejects(call,e=>e===reason),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Caller cancellation waited for refresh')),1000);timer.unref?.();})]);
 assert.equal(refreshSignal.aborted,false);assert.equal(f.pi.jobs.size,1);assert.equal(inferences,0);
 releaseRefresh();await assert.rejects(job.done,e=>e===reason);
 assert.equal(f.pi.vault.accounts[f.id].credential.refresh,'synthetic-rotated');assert.equal((await diskCredential(f)).refresh,'synthetic-rotated');
 assert.equal(f.pi.jobs.size,0);assert.equal(f.pi.locks.size,0);assert.equal(inferences,0);
 const answer=await f.pi.chat(f.profile,'',[{role:'user',content:'next fixture'}]);assert.equal(answer.content,'done');assert.equal(refreshes,1);assert.equal(inferences,1);
});

test('a cancelled refresh drain is bounded and cannot commit after termination',async t=>{
 let releaseRefresh,refreshSignal;
 const f=await fixture(t,async({url},init)=>{assert.equal(url.hostname,'auth.kimi.com');refreshSignal=init.signal;return new Promise(resolve=>{releaseRefresh=()=>resolve(renewed());});},{refreshDrainMs:150});
 const cancel=new AbortController(),reason=new Error('bounded fixture cancellation');
 const call=f.pi.chat(f.profile,'',[{role:'user',content:'fixture'}],{signal:cancel.signal});await until(()=>releaseRefresh);cancel.abort(reason);
 await assert.rejects(call,e=>e===reason);await until(()=>f.pi.jobs.size===0,3000);assert.equal(refreshSignal.aborted,true);
 releaseRefresh();await new Promise(r=>setTimeout(r,30));
 assert.equal(f.pi.vault.accounts[f.id].credential.refresh,'synthetic-old');assert.equal((await diskCredential(f)).refresh,'synthetic-old');assert.equal(f.pi.locks.size,0);
});

for(const failure of ['http','timeout','persistence'])test(`OAuth refresh ${failure} failure releases its lease and never dispatches inference`,async t=>{
 let inferences=0;
 const f=await fixture(t,async({url})=>{
  if(url.hostname!=='auth.kimi.com'){inferences++;throw Error('Must not dispatch inference');}
  if(failure==='http')return new Response('{"error":"synthetic refusal"}',{status:401,headers:{'content-type':'application/json'}});
  if(failure==='timeout')throw Object.assign(new Error('synthetic checked transport timeout'),{name:'TimeoutError'});
  return renewed();
 });
 const persist=f.pi.persist.bind(f.pi);if(failure==='persistence')f.pi.persist=()=>{throw Error('synthetic disk write failure');};
 try{await assert.rejects(f.pi.chat(f.profile,'',[{role:'user',content:'fixture'}]));}finally{f.pi.persist=persist;}
 assert.equal(inferences,0);assert.equal(f.pi.jobs.size,0);assert.equal(f.pi.locks.size,0);assert.equal(f.pi.vault.accounts[f.id].credential.refresh,'synthetic-old');assert.equal((await diskCredential(f)).refresh,'synthetic-old');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../core/server.mjs';
import {Runtime} from '../core/runtime.mjs';
const tool=(id,name,args)=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
async function service(t,options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-routing-'));const a=await startServer({dir,...options});
 t.after(async()=>{await a.close();await rm(dir,{recursive:true,force:true});});
 const launch=await fetch(a.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(a.origin+'/api/bootstrap',{headers:{cookie}})).json();
 const req=async(p,method='GET',data)=>{const response=await fetch(a.origin+p,{method,headers:{cookie,'content-type':'application/json','x-tepora-csrf':boot.csrf},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,body:await response.json()};};
 return {...a,req,dir};
}
test('DNS stall respects caller cancellation and never reaches the socket transport',async t=>{
 let io=0;const a=await service(t,{networkOptions:{lookup:()=>new Promise(()=>{}),transport:()=>{io++;}}});const c=new AbortController();
 const pending=a.network.request('https://example.org', {signal:c.signal},{purpose:'model',allowCloud:true});c.abort(new Error('cancel-dns'));
 await assert.rejects(pending,/cancel-dns/);assert.equal(io,0);assert.equal(a.network.active.size,0);
});
test('ChatCompletions streamed refusals cannot carry an executable tool',async()=>{
 const data='data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:'content_filter'}]})+'\n\ndata: [DONE]\n\n';
 const runtime=new Runtime({baseUrl:'http://127.0.0.1:1/v1',model:'x'},'',async()=>new Response(data,{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(runtime.chat([]),/refused|filtered/);
});
// The original fixture owns directory deletion. A restarted service must release
// SQLite and its HTTP listener before control returns to that fixture's after hook.
async function withRestartedService(original,check){
 await original.close();const reopened=await startServer({dir:original.dir});
 try{return await check(reopened);}finally{await reopened.close();}
}
test('saved network policy survives service restart without widening the allowed route',async t=>{
 const a=await service(t);a.network.change({mode:'offline'},0);let reopened;
 await withRestartedService(a,b=>{reopened=b;assert.equal(b.network.get().mode,'offline');assert.equal(b.network.permitted('cloud','model'),false);});
 assert.equal(reopened.store.closed,true);assert.equal(reopened.server.listening,false);
});
test('restart fixture closes SQLite and HTTP before directory removal even when its assertion fails',async t=>{
 const a=await service(t);let reopened;const failure=new assert.AssertionError({message:'intentional fixture assertion failure'});
 await assert.rejects(withRestartedService(a,b=>{reopened=b;throw failure;}),error=>error===failure);
 // Enforce Windows' close-before-unlink requirement on every platform. Do not
 // retry or suppress EBUSY: a live store/listener is a real teardown failure.
 assert.equal(reopened.store.closed,true);assert.equal(reopened.server.listening,false);
 await rm(a.dir,{recursive:true,force:true});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {Computer,computerConfig} from '../core/computer.mjs';
const observation={revision:'a'.repeat(64),title:'owned',text:'Name',nodes:[{id:'el_0',name:'Name',role:'input',actions:['fill']}]};
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-cu-contract-')),store=new Store(dir),network=new NetworkPolicy(store),calls=[];
 class FakeRPC extends EventEmitter{
  start(){return this;}
  async request(method,params){calls.push({method,params});return method==='act'?{observation}:structuredClone(observation);}
  close(){this.emit('disconnect');}
 }
 const rpc=new FakeRPC(),computer=new Computer(store,network,{}, {rpcFactory:()=>rpc});
 computer.save({enabled:true,headless:true},0);store.artifact('owned','<button>local</button>',{id:'html',kind:'html',jobId:'job'});
 t.after(async()=>{computer.shutdown();network.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {store,network,computer,rpc,calls,job:{id:'job'}};
}
test('Computer Use configuration cannot grant arbitrary process arguments or whole-network access',()=>{
 for(const c of [{args:['arbitrary']},{allowedOrigins:['http://example.com']},{allowedOrigins:['https://example.com/secret']},{maxActions:100000}])assert.throws(()=>computerConfig(c));
});
test('offline document action grant stays within its owning job, current observation and control list',async t=>{
 const {network,computer,job,calls}=await fixture(t);network.change({mode:'offline'},0);
 await computer.open(job,{htmlArtifactId:'html'});assert.equal(computer.hasLocalActionGrant(job),true);
 assert.equal(computer.hasLocalActionGrant({id:'other'}),false);
 await assert.rejects(computer.act({id:'other'},{revision:observation.revision,target:'el_0',operation:'fill',value:'x'}));
 await assert.rejects(computer.act(job,{revision:'b'.repeat(64),target:'el_0',operation:'fill',value:'x'}),/更新/);
 await assert.rejects(computer.act(job,{revision:observation.revision,target:'el_0',operation:'click'}),/not available/);
 assert.equal(calls.filter(c=>c.method==='act').length,0);
 await computer.act(job,{revision:observation.revision,target:'el_0',operation:'fill',value:'x'});
 assert.equal(calls.filter(c=>c.method==='act').length,1);
});
test('releasing Computer Use cancels outstanding broker requests and drops the local action grant',async t=>{
 const {computer,job}=await fixture(t);await computer.open(job,{htmlArtifactId:'html'});const session=computer.session;
 computer.close(job.id);assert.equal(session.controller.signal.aborted,true);assert.equal(computer.hasLocalActionGrant(job),false);
 await assert.rejects(computer.observe(job));
});
test('worker disconnect cancels its network broker and releases session ownership',async t=>{
 const {computer,job,rpc}=await fixture(t);await computer.open(job,{htmlArtifactId:'html'});const session=computer.session;
 rpc.emit('disconnect');assert.equal(session.controller.signal.aborted,true);assert.equal(computer.session,null);
});
test('offline mode refuses native UIA execution before spawning the worker',async t=>{
 const {computer,network,job,calls}=await fixture(t);computer.save({backend:'windows-uia',windowHandle:7},1);network.change({mode:'offline'},0);
 await assert.rejects(computer.open(job,{}),/制限モード/);assert.equal(calls.length,0);
});
test('changing to offline closes an external browser session but not an owned offline document',async t=>{
 const {computer,network,job}=await fixture(t);computer.save({allowedOrigins:['https://example.com']},1);network.change({internetTools:true},0);
 await computer.open(job,{url:'https://example.com'});assert.equal(computer.hasLocalActionGrant(job),false);
 network.change({mode:'offline'},1);assert.equal(computer.session,null);
 await computer.open(job,{htmlArtifactId:'html'});network.change({internetTools:false},2);assert.ok(computer.session);
});

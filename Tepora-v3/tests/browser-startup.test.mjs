import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Browser} from '../core/computer/browser.mjs';

// Real startup lifecycle, injected process/transport/clock. No browser install,
// native addon, OS process, external network or wall-clock timeout is needed.
async function fixture(t,{connect}={}){
 const profileDir=await mkdtemp(path.join(os.tmpdir(),'tepora-browser-start-'));
 t.after(()=>rm(profileDir,{recursive:true,force:true}));
 const children=[],connections=[],timers=[];
 const browser=new Browser({executable:'fixture-browser',profileDir},{
  spawnProcess(executable,args,options){
   assert.equal(executable,'fixture-browser');
   assert.ok(args.includes(`--user-data-dir=${profileDir}`));
   assert.deepEqual(options.stdio,['ignore','ignore','pipe']);
   const proc=new EventEmitter();Object.assign(proc,{pid:100+children.length,exitCode:null,signalCode:null,stderr:new EventEmitter(),signals:[],autoExit:true});
   proc.finish=(code=0,signal=null)=>{proc.exitCode=code;proc.signalCode=signal;proc.emit('exit',code,signal);};
   proc.kill=signal=>{proc.signals.push(signal);if(proc.autoExit)queueMicrotask(()=>proc.finish(null,signal));return true;};
   children.push(proc);return proc;
  },
  connect(url){
   assert.equal(url,'ws://127.0.0.1:9222/devtools/browser/fixture');
   const conn=connect?.()||{ready:Promise.resolve(),closed:false,send:async()=>({}),on:()=>{},close(){this.closed=true;}};
   connections.push(conn);return conn;
  },
  schedule(callback,delay){const timer={callback,delay,cleared:false};timers.push(timer);return timer;},
  cancel(timer){if(timer)timer.cleared=true;},
 });
 const endpoint=proc=>proc.stderr.emit('data','DevTools listening on ws://127.0.0.1:9222/devtools/browser/fixture\n');
 return {browser,children,connections,timers,endpoint};
}

test('concurrent starts share a launch and remove endpoint listeners after fragmented readiness',async t=>{
 const f=await fixture(t),a=f.browser.start(),b=f.browser.start();
 assert.equal(f.children.length,1);
 const proc=f.children[0];
 proc.stderr.emit('data','DevTools list');
 proc.stderr.emit('data','ening on ws://127.0.0.1:9222/devtools/browser/fixture\n');
 assert.deepEqual(await Promise.all([a,b]),[f.browser,f.browser]);
 assert.equal(f.browser.alive,true);assert.equal(f.timers[0].cleared,true);
 assert.equal(proc.stderr.listenerCount('data'),0);
 proc.finish();assert.equal(f.connections[0].closed,true);assert.equal(f.browser.alive,false);assert.equal(f.browser.proc,null);
});

test('a timed-out launch is killed and reaped before either caller can retry its profile',async t=>{
 const f=await fixture(t),first=f.browser.start(),proc=f.children[0];
 proc.autoExit=false;
 const failed=assert.rejects(first,/did not start within 20 seconds/);
 assert.equal(f.timers[0].delay,20000);f.timers[0].callback();
 await Promise.resolve();await Promise.resolve();
 assert.deepEqual(proc.signals,['SIGKILL']);
 const second=f.browser.start(),alsoFailed=assert.rejects(second,/did not start within 20 seconds/);
 assert.equal(f.children.length,1,'no second process can take the profile while cleanup is pending');
 assert.equal(proc.stderr.listenerCount('data'),0);
 proc.finish(null,'SIGKILL');await Promise.all([failed,alsoFailed]);
 assert.equal(f.browser.proc,null);assert.equal(f.browser.starting,null);assert.equal(f.browser.conn,null);
 assert.equal(f.timers.every(timer=>timer.cleared),true);
 const retry=f.browser.start();f.endpoint(f.children[1]);await retry;
 assert.equal(f.children.length,2);assert.equal(f.browser.alive,true);
 f.children[1].finish();
});

test('an endpoint followed by a failed DevTools connection releases the owned process',async t=>{
 const f=await fixture(t,{connect:()=>({ready:Promise.reject(new Error('fixture handshake failed')),closed:false,close(){this.closed=true;}})});
 const failed=assert.rejects(f.browser.start(),/fixture handshake failed/);f.endpoint(f.children[0]);await failed;
 assert.deepEqual(f.children[0].signals,['SIGKILL']);assert.equal(f.connections[0].closed,true);
 assert.equal(f.browser.proc,null);assert.equal(f.browser.conn,null);assert.equal(f.browser.starting,null);
});

test('spawn errors and early exits retain their original error without leaking startup listeners',async t=>{
 for(const mode of ['spawn','exit']){
  const f=await fixture(t),procPromise=f.browser.start(),proc=f.children[0];
  const failed=assert.rejects(procPromise,mode==='spawn'?/fixture spawn failed/:/browser exited \(21\)/i);
  if(mode==='spawn'){proc.pid=undefined;proc.emit('error',new Error('fixture spawn failed'));}
  else proc.finish(21);
  await failed;
  assert.equal(f.browser.proc,null);assert.equal(proc.stderr.listenerCount('data'),0);assert.equal(f.timers[0].cleared,true);
  assert.deepEqual(proc.signals,[]);
 }
});

test('failed process termination retains ownership and blocks a new launch',async t=>{
 const f=await fixture(t),failed=assert.rejects(f.browser.start(),/previous browser process did not stop/),proc=f.children[0];
 proc.autoExit=false;f.timers[0].callback();await Promise.resolve();await Promise.resolve();
 assert.equal(f.timers[1].delay,5000);f.timers[1].callback();await failed;
 assert.equal(f.browser.proc,proc);
 const retry=f.browser.start();await Promise.resolve();
 assert.equal(f.children.length,1);
 proc.finish(null,'SIGKILL');await Promise.resolve();await Promise.resolve();
 f.endpoint(f.children[1]);await retry;f.children[1].finish();
});

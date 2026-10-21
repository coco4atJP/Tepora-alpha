import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Browser} from '../core/computer/browser.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));

// Real startup/shutdown lifecycle, injected process/transport/clock. No browser install,
// native addon, OS process, external network or wall-clock timeout is needed.
async function fixture(t,{connect}={}){
 const profileDir=await mkdtemp(path.join(os.tmpdir(),'tepora-browser-start-'));
 t.after(()=>rm(profileDir,{recursive:true,force:true}));
 const children=[],connections=[],timers=[],calls=[];
 const browser=new Browser({executable:'fixture-browser',profileDir},{
  spawnProcess(executable,args,options){
   assert.equal(executable,'fixture-browser');
   assert.ok(args.includes(`--user-data-dir=${profileDir}`));
   assert.deepEqual(options.stdio,['ignore','ignore','pipe']);
   const proc=new EventEmitter();Object.assign(proc,{pid:100+children.length,exitCode:null,signalCode:null,stderr:new EventEmitter(),signals:[],autoExit:true});
   proc.exit=(code=0,signal=null)=>{proc.exitCode=code;proc.signalCode=signal;proc.emit('exit',code,signal);};
   proc.finish=(code=0,signal=null)=>{proc.exit(code,signal);proc.emit('close',code,signal);};
   proc.kill=signal=>{proc.signals.push(signal);if(proc.autoExit)queueMicrotask(()=>proc.finish(null,signal));return true;};
   children.push(proc);return proc;
  },
  connect(url){
   assert.equal(url,'ws://127.0.0.1:9222/devtools/browser/fixture');
   const conn=connect?.()||{ready:Promise.resolve(),closed:false,send:async()=>({}),on:()=>{},close(){this.closed=true;}};
   if(conn.send){const send=conn.send.bind(conn);conn.send=(...args)=>{calls.push(args[0]);return send(...args);};}
   connections.push(conn);return conn;
  },
  schedule(callback,delay){const timer={callback,delay,cleared:false};timers.push(timer);return timer;},
  cancel(timer){if(timer)timer.cleared=true;},
 });
 const endpoint=proc=>proc.stderr.emit('data','DevTools listening on ws://127.0.0.1:9222/devtools/browser/fixture\n');
 return {browser,children,connections,timers,calls,endpoint};
}
async function launch(f){const started=f.browser.start(),proc=f.children.at(-1);f.endpoint(proc);await started;return proc;}

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
  if(mode==='spawn'){proc.pid=undefined;proc.emit('error',new Error('fixture spawn failed'));proc.emit('close',null);}
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
 proc.finish(null,'SIGKILL');await flush();
 f.endpoint(f.children[1]);await retry;f.children[1].finish();
});

test('shutdown waits for close when exit precedes the Browser.close response',async t=>{
 let f,respond;const response=new Promise(resolve=>{respond=resolve;});
 f=await fixture(t,{connect:()=>({ready:Promise.resolve(),closed:false,on:()=>{},close(){this.closed=true;},send:async method=>{
  if(method==='Browser.close'){f.children[0].exit();await response;}return {};
 }})});
 const proc=await launch(f);let done=false;
 const stopped=f.browser.close().then(()=>{done=true;});await flush();
 assert.equal(proc.exitCode,0);assert.equal(f.browser.proc,proc);assert.equal(done,false);
 respond();await flush();assert.equal(done,false,'an exit/response is not a closed child');
 proc.emit('close',0);await stopped;
 assert.equal(f.browser.proc,null);assert.equal(f.browser.conn,null);
 assert.deepEqual(proc.signals,[]);assert.equal(f.timers.every(timer=>timer.cleared),true);
});

test('a normally exited browser gets a bounded stdio drain without freeing its profile early',async t=>{
 let f;f=await fixture(t,{connect:()=>({ready:Promise.resolve(),closed:false,on:()=>{},close(){this.closed=true;},send:async method=>{
  if(method==='Browser.close')f.children[0].exit();return {};
 }})});
 const proc=await launch(f);let stopped=false;const closing=f.browser.close().then(()=>{stopped=true;});await flush();
 f.timers.at(-1).callback();
 assert.equal(f.timers.at(-1).delay,30000,'Chrome updater descendants can retain stderr after the browser exits');
 assert.equal(stopped,false);assert.equal(f.browser.proc,proc);assert.deepEqual(proc.signals,[]);
 proc.emit('close',0);await closing;assert.equal(stopped,true);assert.equal(f.browser.proc,null);
 assert.equal(f.timers.at(-1).cleared,true);
});

test('the post-exit stdio drain times out and keeps the profile owned until close',async t=>{
 let f;f=await fixture(t,{connect:()=>({ready:Promise.resolve(),closed:false,on:()=>{},close(){this.closed=true;},send:async method=>{
  if(method==='Browser.close')f.children[0].exit();return {};
 }})});
 const proc=await launch(f),failed=assert.rejects(f.browser.close(),/previous browser process did not stop/);await flush();
 f.timers.at(-1).callback();assert.equal(f.timers.at(-1).delay,30000);f.timers.at(-1).callback();await failed;
 assert.equal(f.browser.proc,proc);assert.deepEqual(proc.signals,[]);proc.emit('close',0);assert.equal(f.browser.proc,null);
});

test('shared shutdown blocks restart until close after SIGKILL, and stale callbacks cannot touch the replacement',async t=>{
 const f=await fixture(t),proc=await launch(f);proc.autoExit=false;
 let done=false;
 const a=f.browser.close().then(()=>{done=true;}),b=f.browser.close(),restart=f.browser.start();await flush();
 assert.equal(f.calls.filter(method=>method==='Browser.close').length,1);
 const grace=f.timers.at(-1);assert.equal(grace.delay,5000);grace.callback();
 assert.deepEqual(proc.signals,['SIGKILL']);assert.equal(done,false);
 proc.exit(null,'SIGKILL');await flush();
 assert.equal(done,false);assert.equal(f.children.length,1,'restart must still wait for closed stdio');
 proc.emit('close',null,'SIGKILL');await Promise.all([a,b]);await flush();
 assert.equal(f.children.length,2);f.endpoint(f.children[1]);await restart;
 const replacement=f.children[1],conn=f.connections[1];f.browser.pages.set('replacement',{});
 grace.callback();proc.emit('exit',0);proc.emit('close',0);await flush();
 assert.equal(f.browser.proc,replacement);assert.equal(conn.closed,false);assert.equal(f.browser.pages.has('replacement'),true);
 assert.deepEqual(replacement.signals,[]);replacement.finish();
});

test('shutdown timeout rejects and retains ownership instead of reporting a free profile',async t=>{
 const f=await fixture(t),proc=await launch(f);proc.autoExit=false;
 const failed=assert.rejects(f.browser.close(),/previous browser process did not stop/);await flush();
 f.timers.at(-1).callback();const reap=f.timers.at(-1);assert.equal(reap.delay,5000);reap.callback();await failed;
 assert.equal(f.browser.proc,proc);assert.equal(f.browser.closing,null);
 const retry=f.browser.start();await flush();assert.equal(f.children.length,1);
 proc.finish(null,'SIGKILL');await flush();f.endpoint(f.children[1]);await retry;f.children[1].finish();
});

test('shutdown cancels pending readiness and waits for the owned child to close',async t=>{
 const f=await fixture(t),starting=f.browser.start(),proc=f.children[0];proc.autoExit=false;
 const failed=assert.rejects(starting,/cancelled by shutdown/);let done=false;
 const stopped=f.browser.close().then(()=>{done=true;});await flush();
 assert.deepEqual(proc.signals,['SIGKILL']);f.endpoint(proc);await flush();
 assert.equal(done,false);assert.equal(f.connections.length,0,'late readiness cannot create a transport');
 proc.finish(null,'SIGKILL');await Promise.all([failed,stopped]);
 assert.equal(f.browser.proc,null);assert.equal(f.browser.starting,null);assert.equal(f.browser.closing,null);
});

test('shutdown cancels a hung handshake and ignores its later resolution',async t=>{
 let ready;const handshake=new Promise(resolve=>{ready=resolve;});
 const f=await fixture(t,{connect:()=>({ready:handshake,closed:false,on:()=>{},send:async()=>({}),close(){this.closed=true;}})});
 const starting=f.browser.start(),failed=assert.rejects(starting,/cancelled by shutdown/);f.endpoint(f.children[0]);await flush();
 await f.browser.close();await failed;ready();await flush();
 assert.equal(f.connections[0].closed,true);assert.equal(f.calls.includes('Target.setDiscoverTargets'),false);
 assert.equal(f.browser.proc,null);assert.equal(f.browser.conn,null);
});

test('a failed shutdown kill rejects and keeps the child owned until its real close',async t=>{
 const f=await fixture(t),proc=await launch(f);proc.kill=()=>{throw new Error('fixture kill failed');};
 const failed=assert.rejects(f.browser.close(),/fixture kill failed/);await flush();f.timers.at(-1).callback();await failed;
 assert.equal(f.browser.proc,proc);assert.equal(f.timers.at(-1).cleared,true);
 proc.finish();assert.equal(f.browser.proc,null);
});

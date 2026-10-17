import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {part} from './helpers/dialogue-ui-fixture.mjs';

function voiceReplyFixture(t){
 const listeners=new Set(),timers=new Set(),abort=new AbortController();
 const state={dialogue:{status:'running',messages:[{id:'old',role:'assistant',content:'previous reply'}]}};
 const context=vm.createContext({state,sending:false,signal:abort.signal,Error,queueMicrotask,
  bridge:{on(fn){listeners.add(fn);return()=>listeners.delete(fn);}},
  setTimeout(fn){timers.add(fn);return fn;},clearTimeout(fn){timers.delete(fn);}});
 vm.runInContext(part('function waitHandsFreeReply(','\nlet providerUI='),context);
 const pending=vm.runInContext("waitHandsFreeReply('old',signal)",context);
 t.after(()=>abort.abort());
 return {state,pending,abort,timers,listeners,emit(){for(const listener of listeners)listener({type:'synthetic'});}};
}
test('hands-free waits for a new foreground reply and releases listener/timer',async t=>{
 const f=voiceReplyFixture(t);let settled=false;f.pending.then(()=>{settled=true;});f.emit();await Promise.resolve();assert.equal(settled,false);
 f.state.dialogue.messages.push({id:'new',role:'assistant',content:'new reply'});f.emit();assert.equal(await f.pending,true);assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});
test('a failed or waiting main turn never reads the previous reply again',async t=>{
 const f=voiceReplyFixture(t);f.state.dialogue.status='waiting';f.emit();assert.equal(await f.pending,false);assert.equal(f.listeners.size,0);
});
test('worker reports cannot become the automatic foreground readout',async t=>{
 const f=voiceReplyFixture(t);f.state.dialogue.messages.push({id:'worker',role:'assistant',kind:'worker-report',content:'untrusted worker report'});f.state.dialogue.status='idle';f.emit();assert.equal(await f.pending,false);
});
test('immediate mute aborts reply wait without retaining an event listener',async t=>{
 const f=voiceReplyFixture(t),rejected=assert.rejects(f.pending,{name:'AbortError'});f.abort.abort();await rejected;assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});
test('reply timeout is bounded and releases the subscription',async t=>{
 const f=voiceReplyFixture(t),rejected=assert.rejects(f.pending,/待ち時間/);[...f.timers][0]();await rejected;assert.equal(f.listeners.size,0);assert.equal(f.timers.size,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

test('one fixture owner awaits every restarted service before deleting directories',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-cleanup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const hooks=[],context={after:fn=>hooks.push(fn)},owner=serviceCleanup(context),closed=[];
 assert.equal(serviceCleanup(context),owner);owner.directory(dir);
 const first=owner.service({close:async()=>{await stat(dir);closed.push('first');}});
 await first.close();
 owner.service({close:async()=>{await new Promise(r=>setTimeout(r,10));await stat(dir);closed.push('second');}});
 assert.equal(hooks.length,1);await hooks[0]();assert.deepEqual(closed,['first','second']);
 await assert.rejects(stat(dir),{code:'ENOENT'});
});

test('a failed close does not strand other services or delete a possibly open database',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-cleanup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let hook,otherClosed=false;const owner=serviceCleanup({after:fn=>{hook=fn;}});owner.directory(dir);
 owner.service({close:async()=>{throw new Error('close failed');}});
 owner.service({close:async()=>{otherClosed=true;}});
 await assert.rejects(hook(),e=>e instanceof AggregateError&&e.errors[0].message==='close failed');
 assert.equal(otherClosed,true);assert.ok((await stat(dir)).isDirectory());
});

test('overlapping fixture closes await the same operation',async()=>{
 let hook,calls=0,release;const owner=serviceCleanup({after:fn=>{hook=fn;}});
 const app=owner.service({close:()=>{calls++;return new Promise(r=>{release=r;});}});
 const a=app.close(),b=app.close();assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);release();await a;await hook();assert.equal(calls,1);
});

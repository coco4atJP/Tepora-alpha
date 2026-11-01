import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {policyScope,benchmarkGuard,blockedComputerOutcome,delegationFileTarget} from '../scripts/benchmark-scope.mjs';

test('a timed-out approval case restores baseline through a fresh cleanup signal before the next case',async()=>{
 const abort=new AbortController(),baseline={rules:[]},ask={rules:[{tool:'write',action:'ask'}]};let current=baseline;
 const set=async(policy,signal=abort.signal)=>{signal.throwIfAborted();current=policy;};
 await assert.rejects(policyScope(set,ask,baseline,async()=>{assert.equal(current,ask);abort.abort(new Error('case timeout'));abort.signal.throwIfAborted();}),/case timeout/);
 assert.equal(current,baseline,'the next case must not inherit the ask rule');
});
test('budget refusal and provider rejection are blocked before approval/attachment polling can time out',()=>{
 assert.throws(()=>benchmarkGuard({calls:[],blockedReason:'Benchmark dispatch budget exhausted'},0),e=>e.blocked&&/budget/.test(e.message));
 const meter={calls:[{status:200},{status:429,providerError:'Endpoint is unavailable'}]};
 assert.throws(()=>benchmarkGuard(meter,1),e=>e.blocked&&/429/.test(e.message));
 assert.doesNotThrow(()=>benchmarkGuard(meter,2),'a prior case does not poison a new case');
 assert.doesNotThrow(()=>benchmarkGuard(meter,undefined),'cleanup is independent of the failed case');
 assert.throws(()=>benchmarkGuard(meter,2,'使える接続先がありません。'),e=>e.blocked,'cached cooldown must also short-circuit a pending-approval poll');
});

test('blocked reservation permits completed input subgoals but rejects booking completion or an absent receipt oracle',()=>{
 const check='受付済み: 検証 / 午後',reservation={args:{checks:[{text_includes:check}]},data:{status:'blocked'}},partial={args:{goal:'Select the afternoon slot'},data:{status:'model_completed'}};
 assert.equal(blockedComputerOutcome([reservation,partial],check,null,'予約は操作不可'),true);
 assert.equal(blockedComputerOutcome([{...reservation,data:{status:'completed'}}],check,null,'操作不可'),false);
 assert.equal(blockedComputerOutcome([reservation,partial],check,{name:'unexpected'},'操作不可'),false);
 assert.equal(blockedComputerOutcome([reservation],check,undefined,'操作不可'),false);
 assert.equal(blockedComputerOutcome([reservation],check,null,'予約に成功しました'),false);
});

test('delegation accepts either assigned folder but requires worker write/read and rejects main-created or out-of-scope files',()=>{
 const parentCwd=path.resolve('bench/work'),childCwd=path.join(parentCwd,'sessions','worker'),expected='DELEGATE_PROOF',file='delegated.txt';
 const entries=dest=>[{type:'tool',name:'write',args:{path:dest,content:expected},content:'Written',error:false},{type:'tool',name:'read',args:{path:dest},content:expected,error:false}];
 const worker=dest=>({session:{kind:'worker',status:'done',cwd:childCwd},entries:entries(dest)}),check=(w,mainEntries=[])=>delegationFileTarget({worker:w,mainEntries,parentCwd,file,expected});
 assert.equal(check(worker(file)),path.join(childCwd,file));
 const shared=path.join(parentCwd,file);assert.equal(check(worker(shared)),shared);
 assert.equal(check(worker(shared),[entries(shared)[0]]),null,'a file made by the main session is not delegation');
 assert.equal(check(worker(path.resolve('outside',file))),null);
 const noWrite=worker(shared);noWrite.entries=noWrite.entries.slice(1);assert.equal(check(noWrite),null,'existing matching content is insufficient');
 const noRead=worker(shared);noRead.entries=noRead.entries.slice(0,1);assert.equal(check(noRead),null);
 const denied=worker(shared);denied.entries[0].error=true;assert.equal(check(denied),null);
});

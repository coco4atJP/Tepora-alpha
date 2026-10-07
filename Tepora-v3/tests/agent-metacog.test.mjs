import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {toolResults} from './helpers/scripted-model.mjs';
import {selfCheckDue,noteSelfCheck,renderSelfCheck,renderReflection,SELF_CHECK} from '../core/agent/metacog.mjs';
import {renderLedger} from '../core/agent/compaction.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
const facts=(x={})=>({steps:20,minutes:3,context:null,calls:12,errors:0,recentErrors:0,recentCalls:6,variety:1,todo:null,reflection:{step:15,confidence:0.8,assumptions:0,questions:0,age:5},model:'m',escalated:false,cost:0,team:[],...x});

test('self-check triggers: context once per stretch, failures, a stalled checklist, no stated understanding, low confidence, long stretches',()=>{
 const worker={kind:'worker'},main={kind:'main'};
 let mem={};assert.deepEqual(selfCheckDue(worker,mem,facts({steps:3})),[],'nothing worth saying early on');
 mem={};const ctx=facts({steps:3,context:{used:6500,budget:10000,share:0.65}});
 assert.deepEqual(selfCheckDue(worker,mem,ctx),['context']);noteSelfCheck(mem,ctx,['context']);
 assert.deepEqual(selfCheckDue(worker,mem,{...ctx,steps:4}),[],'the same occasion does not repeat');
 mem={selfCheckStep:10};assert.deepEqual(selfCheckDue(worker,mem,facts({steps:14,recentErrors:4})),[],'no more than one check per few steps');
 assert.deepEqual(selfCheckDue(worker,mem,facts({steps:16,recentErrors:4})),['errors']);
 mem={selfCheckStep:5,todoStep:2};assert.deepEqual(selfCheckDue(worker,mem,facts({steps:16,todo:{done:1,total:4,blocked:0,open:3,still:14}})),['stalled']);
 mem={selfCheckStep:5};assert.deepEqual(selfCheckDue(worker,mem,facts({steps:12,reflection:null})),['unreflected']);
 mem={selfCheckStep:5};const low=facts({steps:12,reflection:{step:5,confidence:0.3,assumptions:2,questions:1,age:7}});
 assert.deepEqual(selfCheckDue(worker,mem,low),['low-confidence']);noteSelfCheck(mem,low,['low-confidence']);
 assert.deepEqual(selfCheckDue(worker,mem,{...low,steps:18,reflection:{...low.reflection,age:13}}),[],'asked once per stated confidence');
 mem={selfCheckStep:0};assert.deepEqual(selfCheckDue(worker,mem,facts({steps:SELF_CHECK.every})),['interval']);
 assert.deepEqual(selfCheckDue(main,{selfCheckStep:0},facts({steps:40,reflection:null})),[],'the character is not interrupted on a schedule');
 const text=renderSelfCheck(facts({context:{used:6500,budget:10000,share:0.65},errors:3,recentErrors:3,todo:{done:1,total:4,blocked:1,open:2,still:6}}),['context','errors']);
 assert.match(text,/^\[harness\] Self-check \(measured by the harness, not a message from the user\)/);
 assert.match(text,/Context: 65% of the working budget/);assert.match(text,/Checklist: 1\/4 done, 1 blocked; unchanged for 6 steps/);
 assert.match(text,/text without tool calls ends the task, so write text only when it is your final report/);
 assert.match(renderSelfCheck(facts(),['context'],{kind:'main'}),/never|Do not mention this check to the user/);
});

test('reflect keeps the agent\'s own picture; the ledger carries it through compaction word for word',async t=>{
 const f=await agentFixture(t,body=>{
  const r=toolResults(body);
  if(r.length===0)return {calls:[{name:'reflect',args:{understanding:'集計してsum.txtに保存する',plan:'読む→足す→書く',assumptions:['入力はUTF-8'],confidence:0.4}}]};
  if(r.length===1)return {calls:[{name:'reflect',args:{verified:['入力はUTF-8（readで確認）'],assumptions:[],confidence:0.9}}]};
  return {content:'できました'};
 });
 const s=await f.rt.spawn(null,{task:'集計して'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});
 assert.equal(done.reflection.understanding,'集計してsum.txtに保存する','fields not sent are kept');
 assert.deepEqual(done.reflection.assumptions,[]);assert.equal(done.reflection.confidence,0.9);
 const sys=f.model.requests[0].messages[0].content;assert.match(sys,/Keep reflect notes/);assert.match(sys,/Self-check messages carry facts/);
 assert.ok(f.model.requests[0].tools.some(x=>x.function.name==='reflect'));
 const ledger=renderLedger({task:null,instructions:[],files:{},artifacts:{},sessions:{},processes:{},errors:[],evidence:[]},{reflection:done.reflection});
 assert.match(ledger,/### Self-assessment \(your reflect notes, verbatim\)\nUnderstanding: 集計してsum.txtに保存する\nPlan: 読む→足す→書く\nVerified:\n- 入力はUTF-8（readで確認）\nConfidence: 0.9/);
 assert.equal(renderReflection(null),'');
});

test('a self-check is appended after failures: facts from the harness, and the earlier prompt stays a cached prefix',async t=>{
 const f=await agentFixture(t,body=>{
  const r=toolResults(body);
  if(r.length<8)return {calls:[{name:'read',args:{path:`missing-${r.length}.txt`}}]};
  return {content:'読めませんでした'};
 });
 const s=await f.rt.spawn(null,{task:'ファイルを読む'});
 await until(()=>f.rt.sessions.get(s.id).status==='done');
 const checks=f.rt.sessions.entries(s.id,{types:['notice']}).filter(n=>n.selfCheck);
 assert.ok(checks.length>=1,'a self-check was sent');
 assert.ok(checks[0].selfCheck.includes('errors'),JSON.stringify(checks[0].selfCheck));
 assert.match(checks[0].text,/Tools: \d+ calls, \d+ failed \(\d+ of the last 6\)/);
 assert.match(checks[0].text,/Is your picture of the environment wrong/);
 // The notice was appended: every later request starts with the earlier one's messages unchanged.
 const reqs=f.model.requests,i=reqs.findIndex(b=>b.messages.some(m=>String(m.content).startsWith('[harness] Self-check')));
 assert.ok(i>0);
 const before=JSON.stringify(reqs[i-1].messages),after=JSON.stringify(reqs[i].messages.slice(0,reqs[i-1].messages.length));
 assert.equal(after,before,'the prefix of the previous request is byte-identical');
 assert.ok(f.rt.sessions.entries(s.id,{types:['event']}).some(e=>e.event==='self-check'));
});

test('metacognition can be switched off',async t=>{
 const f=await agentFixture(t,body=>{const r=toolResults(body);return r.length<8?{calls:[{name:'read',args:{path:`missing-${r.length}.txt`}}]}:{content:'終わり'};},{settings:{metacognition:false}});
 const s=await f.rt.spawn(null,{task:'読む'});
 await until(()=>f.rt.sessions.get(s.id).status==='done');
 assert.equal(f.rt.sessions.entries(s.id,{types:['notice']}).filter(n=>n.selfCheck).length,0);
});

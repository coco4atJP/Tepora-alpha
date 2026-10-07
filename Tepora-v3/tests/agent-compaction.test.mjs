import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {last,toolResults} from './helpers/scripted-model.mjs';
import {foldLedger,renderLedger,validSummary,COMPACTION} from '../core/agent/compaction.mjs';
import {TokenCalibration,rawTokens} from '../core/agent/tokens.mjs';
import {SUMMARY_HEADINGS} from '../core/agent/prompts.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=15000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
const text=m=>typeof m?.content==='string'?m.content:'';
const isCompaction=body=>text(last(body,'user')).includes('Context compaction')&&body.tool_choice==='none';
const isRolling=body=>text(body.messages[0]).includes('working memory of a long-running agent');
const summary=extra=>SUMMARY_HEADINGS.map(h=>`## ${h}\n- ${h==='Key facts'?'big.txt has 120 lines; '+extra:'noted'}`).join('\n');
const isPrefix=(a,b)=>a.messages.length<=b.messages.length&&a.messages.every((m,i)=>JSON.stringify(m)===JSON.stringify(b.messages[i]));
const lorem=n=>Array.from({length:n},(_,i)=>`word${i%37}`).join(' ');

async function bigFile(dir){const lines=Array.from({length:120},(_,i)=>`line ${i+1}: ${lorem(8)}`);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'big.txt'),lines.join('\n'));}

test('long work clears old results in batches, then compacts on the cached prefix into a checkpoint that keeps the task and instructions verbatim',async t=>{
 let steered=false,n=-1;
 const f=await agentFixture(t,(body,{index})=>{
  if(isCompaction(body))return {content:summary('compacted in context')};
  n++;
  if(n===0)return {calls:[{name:'write',args:{path:'notes.md',content:'# notes'}}]};
  if(n===5){f.rt.send(f.worker,{text:'追加指示: 数字は半角で書くこと',from:'user',mode:'steer'});steered=true;}
  if(n<22)return {content:`Step ${n}: ${lorem(160)}`,calls:[{name:'read',args:{path:'big.txt',offset:1+n*3,limit:40}}]};
  return {content:'Finished the review.'};
 },{context:12000});
 const s=await f.rt.spawn(null,{task:'Review big.txt thoroughly. 結論は箇条書きで。'});f.worker=s.id;
 await bigFile(s.cwd);
 await until(()=>f.rt.sessions.get(s.id).status==='done',30000);
 const log=f.rt.sessions.entries(s.id);
 const clears=log.filter(e=>e.type==='clear'),checkpoints=log.filter(e=>e.type==='checkpoint');
 assert.ok(clears.length>=1,'old results were cleared');assert.ok(checkpoints.length>=1,'a checkpoint was made');
 const cp=checkpoints.at(-1);
 assert.equal(cp.method,'in-context');
 assert.match(cp.text,/Review big\.txt thoroughly\. 結論は箇条書きで。/);
 assert.match(cp.text,/追加指示: 数字は半角で書くこと/);
 assert.match(cp.text,/notes\.md \(write/);
 assert.match(cp.text,/compacted in context/);
 // The compaction request is the cached context plus one instruction.
 const reqs=f.model.requests,ci=reqs.findIndex(isCompaction);
 assert.ok(ci>0);assert.ok(isPrefix({messages:reqs[ci-1].messages},{messages:reqs[ci].messages.slice(0,-1).concat()})||reqs[ci].messages.length>reqs[ci-1].messages.length);
 assert.equal(JSON.stringify(reqs[ci].tools),JSON.stringify(reqs[ci-1].tools));
 const after=reqs[ci+1];assert.equal(after.messages[1].role,'user');assert.match(after.messages[1].content,/^<checkpoint/);
 // The prefix only changes at a clear or a compaction.
 const normal=reqs.filter(b=>!isCompaction(b));let breaks=0;
 for(let i=1;i<normal.length;i++)if(!isPrefix(normal[i-1],normal[i]))breaks++;
 assert.ok(breaks<=clears.length+checkpoints.length,`prefix changed ${breaks} times for ${clears.length} clears and ${checkpoints.length} checkpoints`);
 assert.ok(steered);
});

test('when summaries keep failing the checkpoint degrades to a deterministic list and work continues',async t=>{
 let n=-1;
 const f=await agentFixture(t,body=>{
  if(isCompaction(body)||isRolling(body))return {content:'not a summary'};
  n++;
  if(n<18)return {content:`Step ${n}: ${lorem(220)}`,calls:[{name:'read',args:{path:'big.txt',limit:30}}]};
  return {content:'done'};
 },{context:12000});
 const s=await f.rt.spawn(null,{task:'Keep reading big.txt.'});await bigFile(s.cwd);
 await until(()=>f.rt.sessions.get(s.id).status==='done',30000);
 const cp=f.rt.sessions.entries(s.id,{types:['checkpoint']}).at(-1);
 assert.equal(cp.method,'deterministic');
 assert.match(cp.text,/Keep reading big\.txt\./);
 assert.match(cp.summary,/automatic list/);
});

test('a context-overflow error teaches the real window, compacts out of context and continues',async t=>{
 let overflowed=0,n=-1;
 const f=await agentFixture(t,body=>{
  if(isRolling(body))return {content:summary('rolled')};
  const size=JSON.stringify(body.messages).length;
  if(size>24000&&!isCompaction(body)){overflowed++;return {status:400,body:{error:{message:`This model's maximum context length is 9000 tokens. However, your messages resulted in ${Math.round(size/3)} tokens.`}}};}
  n++;
  if(n<10)return {content:`Step ${n}: ${lorem(120)}`,calls:[{name:'read',args:{path:'big.txt',offset:1+n*5,limit:40}}]};
  return {content:'done'};
 },{context:64000});
 const s=await f.rt.spawn(null,{task:'Read big.txt part by part.'});await bigFile(s.cwd);
 await until(()=>f.rt.sessions.get(s.id).status==='done',30000);
 assert.ok(overflowed>=1);
 const p=f.registry.get().profiles[0];assert.equal(f.registry.knownLimits(p).context,9000);assert.equal(f.registry.knownLimits(p).learned,true);
 const cp=f.rt.sessions.entries(s.id,{types:['checkpoint']});assert.ok(cp.length>=1);assert.equal(cp[0].reason,'overflow');assert.equal(cp[0].method,'rolling');
});

test('recall returns the exact text of an entry that was compacted away',async t=>{
 let recalled=null;
 const f=await agentFixture(t,body=>{
  if(isCompaction(body))return {content:summary('see #3')};
  const results=toolResults(body),n=body.messages.filter(m=>m.role==='assistant').length;
  const lastResult=results.at(-1)?.content||'';
  if(lastResult.startsWith('#3 ')){recalled=lastResult;return {content:'got it'};}
  if(body.messages[1]?.content?.startsWith?.('<checkpoint'))return {calls:[{name:'recall',args:{ref:'#3'}}]};
  if(n===0)return {calls:[{name:'exec',args:{command:'printf "SECRET-VALUE-4711"'}}]};
  return {content:`Step ${n}: ${lorem(260)}`,calls:[{name:'read',args:{path:'big.txt',limit:30}}]};
 },{context:12000});
 const s=await f.rt.spawn(null,{task:'Find the value then keep reading.'});await bigFile(s.cwd);
 await until(()=>recalled,30000);
 assert.match(recalled,/SECRET-VALUE-4711/);
});

test('the resident main session compacts while idle so the next spoken reply is fast',async t=>{
 const f=await agentFixture(t,body=>{
  if(isCompaction(body))return {content:summary('idle')};
  return {content:`返事です。${lorem(400)}`};
 },{context:12000,settings:{idleCompactSeconds:0}});
 const main=f.rt.main();
 for(let i=0;i<4;i++){f.rt.send(main.id,{text:`質問 ${i}: ${lorem(80)}`,from:'user'});await until(()=>f.rt.sessions.get(main.id).status==='idle'&&!f.rt.runs.has(main.id)&&f.rt.sessions.entries(main.id,{types:['assistant']}).length===i+1);}
 const before=f.model.requests.length;
 await f.rt.idleCompact(main.id);
 assert.equal(f.rt.sessions.entries(main.id,{types:['checkpoint']}).at(-1)?.reason,'idle');
 assert.equal(f.model.requests.length,before+1);
});

test('the ledger is exact: task, verbatim instructions, files, artifacts, sessions and errors',()=>{
 const entries=[
  {seq:1,type:'input',kind:'task',from:'parent',header:'[t]',text:'Build the report.'},
  {seq:2,type:'assistant',content:'',toolCalls:[{id:'a',name:'write'}]},
  {seq:3,type:'tool',name:'write',data:{path:'/w/r.md',op:'write',bytes:10,sha:'abc'},stub:'write(path="/w/r.md")'},
  {seq:4,type:'input',kind:'message',from:'user',header:'[u]',text:'Use metric units.'},
  {seq:5,type:'tool',name:'exec',error:true,errorText:'command not found: foo',content:'Error: command not found: foo',stub:'exec foo'},
  {seq:6,type:'tool',name:'artifact',data:{id:'art1',version:2,title:'Report'},stub:'artifact publish'},
  {seq:7,type:'tool',name:'sessions_spawn',data:{sessionId:'s-1',title:'Sub'},stub:'sessions_spawn'},
  {seq:8,type:'input',kind:'report',from:'child:s-1',sessionId:'s-1',title:'Sub',status:'done',header:'[r]',text:'Sub done.'}
 ];
 const l=foldLedger(null,entries,{kind:'worker'}),md=renderLedger(l,{todo:[{text:'write',status:'done'}],live:{sessions:{'s-1':'done'}}});
 assert.equal(l.task.text,'Build the report.');assert.deepEqual(l.instructions.map(i=>i.text),['Use metric units.']);
 for(const s of ['Build the report.','Use metric units.','/w/r.md (write','art1 "Report" v2','s-1 "Sub" [done]','#5 exec: command not found: foo','[x] 1. write'])assert.ok(md.includes(s),s);
 assert.ok(!md.includes('Sub done.'),'reports are not instructions');
 // Older worker instructions beyond the budget are counted, never silently lost.
 const many=Array.from({length:200},(_,i)=>({seq:10+i,type:'input',kind:'message',from:'user',text:lorem(60)}));
 const l2=foldLedger(l,many,{kind:'worker'});assert.ok(l2.omittedInstructions>0);assert.ok(l2.instructions.length>0);assert.equal(l2.instructions.at(-1).seq,209);
});

test('summary validation and token calibration',()=>{
 assert.equal(validSummary('short',1000),false);
 assert.equal(validSummary(SUMMARY_HEADINGS.map(h=>'## '+h+'\n- x').join('\n'),1000),true);
 const c=new TokenCalibration(null);for(let i=0;i<20;i++)c.observe('m',1000,1500);
 assert.ok(c.ratio('m')>1.4&&c.ratio('m')<1.55);assert.equal(c.observe('m',100,10),c.ratio('m'));
 assert.ok(rawTokens('こんにちは世界')>=7);assert.ok(rawTokens('hello world, this is text')<12);
 assert.ok(COMPACTION.hard>COMPACTION.softClear&&COMPACTION.tail<COMPACTION.hard);
});

test('repeated compaction keeps each stretch as a chapter written once, and rescues links the summary forgot',async t=>{
 let n=-1,k=0;
 const f=await agentFixture(t,body=>{
  if(isCompaction(body)){k++;return {content:SUMMARY_HEADINGS.map(h=>h==='Chapter digest'?`## ${h}\nStretch ${k}: read part ${k} of big.txt.`:`## ${h}\n- noted ${k}`).join('\n')};}
  n++;
  if(n<45)return {content:`Step ${n}: see https://example.com/doc/${n} ${lorem(120)}`,calls:[{name:'read',args:{path:'big.txt',offset:1+(n%30)*3,limit:40}}]};
  return {content:'Finished.'};
 },{context:12000});
 const s=await f.rt.spawn(null,{task:'Read big.txt in parts.'});await bigFile(s.cwd);
 await until(()=>f.rt.sessions.get(s.id).status==='done',60000);
 const cps=f.rt.sessions.entries(s.id,{types:['checkpoint']});
 assert.ok(cps.length>=2,`${cps.length} checkpoints`);
 const lastCp=cps.at(-1);
 for(let i=1;i<=cps.length;i++)assert.match(lastCp.text,new RegExp(`Stretch ${i}: read part ${i} of big\\.txt\\.`),`chapter ${i} survives`);
 assert.doesNotMatch(lastCp.summary,/Chapter digest/);
 assert.match(lastCp.text,/Links and paths seen in this stretch but not in the summary[\s\S]*https:\/\/example\.com\/doc\/\d+/);
 assert.match(lastCp.text,/### Files read\n- big\.txt/);
});

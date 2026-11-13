import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {last,toolResults} from './helpers/scripted-model.mjs';
import {foldLedger,renderLedger,validSummary,briefBudget,forkContext,COMPACTION,Compactor} from '../core/agent/compaction.mjs';
import {TokenCalibration,rawTokens} from '../core/agent/tokens.mjs';
import {SUMMARY_HEADINGS,MAIN_BRIEF_HEADINGS,headingsFor} from '../core/agent/prompts.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=15000,diagnose=()=>null){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out: '+JSON.stringify(diagnose()));await wait(15);}}
function progress(f,id){const session=f.rt.sessions.get(id);return {status:session?.status,stats:session?.stats,pending:f.rt.sessions.pending(id).length,requests:f.model.requests.length,tail:f.rt.sessions.entries(id).slice(-5).map(({type,event,name,errorText})=>({type,event,name,errorText}))};}

const text=m=>typeof m?.content==='string'?m.content:'';
const isHandoff=body=>text(last(body,'user')).startsWith('[harness] Handoff.')&&body.tool_choice==='none';
const isLabeling=body=>text(last(body,'user')).startsWith('[harness] Episode labeling.')&&body.tool_choice==='none';
const isCompaction=body=>(isHandoff(body)||text(last(body,'user')).includes('Context compaction'))&&body.tool_choice==='none';
const isRolling=body=>text(body.messages[0]).includes('working memory of a long-running agent');
const summary=(extra,kind='worker')=>headingsFor(kind).map(h=>`## ${h}\n- ${['Key facts','Verified facts'].includes(h)?'big.txt has 120 lines; '+extra:'noted'}`).join('\n');
const isPrefix=(a,b)=>a.messages.length<=b.messages.length&&a.messages.every((m,i)=>JSON.stringify(m)===JSON.stringify(b.messages[i]));
const lorem=n=>Array.from({length:n},(_,i)=>`word${i%37}`).join(' ');

async function bigFile(dir){const lines=Array.from({length:120},(_,i)=>`line ${i+1}: ${lorem(8)}`);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'big.txt'),lines.join('\n'));}

test('long work clears old results in batches, then hands off on the cached prefix to a fresh conversation of task, ledger and brief only',async t=>{
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
 await until(()=>f.rt.sessions.get(s.id).status==='done',30000,()=>progress(f,s.id));
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
 const after=reqs[ci+1];assert.equal(after.messages[1].role,'user');assert.match(after.messages[1].content,/^<handoff covers="#1–#\d+"[^>]*>/);
 assert.match(cp.text,/## Original task \(verbatim, #1\)\nReview big\.txt thoroughly\. 結論は箇条書きで。\n\n## Ledger \(exact, kept by the harness\)\n[\s\S]*## Brief \(written at the handoff\)\n## Objective/);
 assert.doesNotMatch(cp.text,/Recent conversation|Chapters/);
 // EoCC: nothing of the old conversation stays in view; the fresh conversation is the system prompt, the handoff and its notice.
 const said=reqs[ci].messages.filter(m=>m.role==='assistant').map(text).filter(Boolean);
 assert.ok(said.length>0);assert.ok(after.messages.every(m=>!said.includes(text(m))),'no earlier assistant turn survives the handoff');
 assert.ok(after.messages.every(m=>m.role!=='tool'),'no earlier tool result survives the handoff');
 assert.match(text(after.messages.at(-1)),/Fresh conversation/);
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
 await until(()=>f.rt.sessions.get(s.id).status==='done',30000,()=>progress(f,s.id));
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
 await until(()=>f.rt.sessions.get(s.id).status==='done',30000,()=>progress(f,s.id));
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
  if(body.messages[1]?.content?.startsWith?.('<handoff'))return {calls:[{name:'recall',args:{ref:'#3'}}]};
  if(n===0)return {calls:[{name:'exec',args:{command:'printf "SECRET-VALUE-4711"'}}]};
  return {content:`Step ${n}: ${lorem(260)}`,calls:[{name:'read',args:{path:'big.txt',limit:30}}]};
 },{context:12000});
 const s=await f.rt.spawn(null,{task:'Find the value then keep reading.'});await bigFile(s.cwd);
 await until(()=>recalled,30000);
 assert.match(recalled,/SECRET-VALUE-4711/);
});

test('while the user is quiet the main session hands off to a fresh conversation and keeps its last three exchanges verbatim',async t=>{
 let size=0;
 const f=await agentFixture(t,body=>{
  if(isHandoff(body))return {content:summary('idle','main')};
  if(isLabeling(body))return {content:'Enew | open | 質問の練習 | 短い質問が続いている | #1-#99 | 質問'};
  return {content:size?`返事です。${lorem(size)}`:'短い返事'};
 },{context:12000,settings:{idleCompactSeconds:0}});
 const main=f.rt.main();
 // One long exchange takes the conversation past the idle threshold (55% of B); the short ones after it stay below 90%.
 for(let i=0;i<5;i++){size=i===0?1200:0;f.rt.send(main.id,{text:`質問 ${i}`,from:'user'});await until(()=>f.rt.sessions.get(main.id).status==='idle'&&!f.rt.runs.has(main.id)&&f.rt.sessions.entries(main.id,{types:['assistant']}).length===i+1);}
 assert.equal(f.rt.sessions.entries(main.id,{types:['checkpoint']}).length,0,'no handoff during the turns');
 const before=f.model.requests.length;
 await f.rt.idle(main.id);
 // One idle lease: label the stretch into episodes, hand off, then warm the new prefix (a model on this computer).
 assert.equal(f.model.requests.length,before+3);
 assert.ok(isLabeling(f.model.requests[before]));assert.ok(isHandoff(f.model.requests[before+1]));
 assert.ok((f.model.requests[before+2].max_tokens??f.model.requests[before+2].max_completion_tokens)<=256,'warm-up only processes the prefix');
 assert.ok(isPrefix({messages:f.model.requests[before].messages.slice(0,-1)},f.model.requests[before+1]),'labeling shares the cached prefix of the handoff request');
 const cp=f.rt.sessions.entries(main.id,{types:['checkpoint']}).at(-1);
 assert.equal(cp.reason,'idle');assert.equal(cp.method,'in-context');
 assert.match(cp.text,/^<handoff covers="#1–#\d+" method="in-context" reason="idle">\nThis is a fresh conversation continuing your conversation with the user/);
 assert.doesNotMatch(cp.text,/made=|\d{4}-\d{2}-\d{2}T/,'no clock in the stable handoff block');
 assert.doesNotMatch(cp.text,/## Original task|Chapters|Recent conversation/);
 assert.match(cp.text,/## Ledger \(exact, kept by the harness\)\n[\s\S]*## Open topics \(episodes[^\n]*\n- E1 質問の練習 — 短い質問が続いている \(#1-#\d+\)\n\n## Brief \(written at the handoff\)\n## About the user\n/);
 const cards=f.rt.store.list('episode');assert.equal(cards.length,1);assert.equal(cards[0].state,'open');
 assert.ok(f.rt.sessions.entries(main.id,{types:['input','assistant']}).every(e=>e.episodeId==='E1'),'every entry is labeled');
 const instruction=text(last(f.model.requests[before+1],'user'));
 for(const h of MAIN_BRIEF_HEADINGS)assert.ok(instruction.includes('## '+h+'\n'),h);
 // The next turn starts from the handoff, then exactly the last three exchanges, then the new message.
 size=0;f.rt.send(main.id,{text:'次の質問',from:'user'});
 await until(()=>f.rt.sessions.entries(main.id,{types:['assistant']}).length===6);
 assert.equal(f.rt.sessions.entries(main.id).at(-1).type,'assistant','the handoff notice is not answered on its own; the next input is');
 const next=f.model.requests.at(-1).messages;
 assert.match(text(next[1]),/^<handoff/);
 const warmed=f.model.requests[before+2].messages;assert.deepEqual(next.slice(0,2),warmed.slice(0,2),'the warmed prefix is the next request\'s prefix');
 const view=next.slice(2).map(text).join('\n');

 for(const q of ['質問 2','質問 3','質問 4','次の質問'])assert.ok(view.includes(q),q);
 for(const q of ['質問 0','質問 1'])assert.ok(!view.includes(q),q+' left view');assert.ok(!view.includes('返事です。'),'the long reply left view');
 assert.match(view,/Fresh conversation\. Turns up to #\d+ are stored but out of view/);
 // The next idle lease has no handoff due, so it dreams: one consolidation call, outside the conversation's cache.
 const n=f.model.requests.length;await f.rt.idle(main.id);
 assert.equal(f.model.requests.length,n+1,'one job per idle lease');
 assert.match(text(f.model.requests.at(-1).messages[0]),/^You consolidate the long-term memory/);
 assert.equal(f.store.value('memory-core').revision,1,'core memory records the episodes it consolidated');
 await f.rt.idle(main.id);assert.equal(f.model.requests.length,n+1,'nothing more to do until something changes');
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
 assert.equal(validSummary(MAIN_BRIEF_HEADINGS.map(h=>'## '+h+'\n- x').join('\n'),1000,'main'),true);
 // The main brief is about the user and the relationship, not a story of what was said.
 // Open topics are the harness's episode list, not part of the brief.
 assert.deepEqual(MAIN_BRIEF_HEADINGS,['About the user','Commitments and pending items','Delegated work','Tone and relationship','Verified facts','Unverified guesses','Re-fetch pointers']);
 // The brief is forward-looking (App. G): what is left, how to tell it is done, and where things are; no narrative.
 for(const h of ['Current work','Remaining plan','Completion criteria','Artifact locations','Verified facts','Unverified assumptions','Dead ends','Re-fetch commands'])assert.ok(SUMMARY_HEADINGS.includes(h),h);
 assert.ok(!SUMMARY_HEADINGS.includes('Chapter digest')&&!SUMMARY_HEADINGS.includes('Progress'));
 const c=new TokenCalibration(null);for(let i=0;i<20;i++)c.observe('m',1000,1500);
 assert.ok(c.ratio('m')>1.4&&c.ratio('m')<1.55);assert.equal(c.observe('m',100,10),c.ratio('m'));
 assert.ok(rawTokens('こんにちは世界')>=7);assert.ok(rawTokens('hello world, this is text')<12);
 assert.ok(COMPACTION.hard>COMPACTION.softClear&&COMPACTION.tail<COMPACTION.hard);
});

test('repeated handoffs carry the brief forward, write no chapters, and rescue links the brief forgot',async t=>{
 let n=-1,k=0,second=null;
 const f=await agentFixture(t,body=>{
  if(isHandoff(body)){k++;if(k===2)second=text(last(body,'user'));return {content:SUMMARY_HEADINGS.map(h=>`## ${h}\n- noted ${k}`).join('\n')};}
  n++;
  if(n<45)return {content:`Step ${n}: see https://example.com/doc/${n} ${lorem(120)}`,calls:[{name:'read',args:{path:'big.txt',offset:1+(n%30)*3,limit:40}}]};
  return {content:'Finished.'};
 },{context:12000});
 const s=await f.rt.spawn(null,{task:'Read big.txt in parts.'});await bigFile(s.cwd);
 await until(()=>f.rt.sessions.get(s.id).status==='done',60000);
 const cps=f.rt.sessions.entries(s.id,{types:['checkpoint']});
 assert.ok(cps.length>=2,`${cps.length} handoffs`);
 const lastCp=cps.at(-1);
 assert.match(second,/An earlier <handoff> is part of the conversation above/);
 assert.equal(lastCp.chapters,undefined);assert.doesNotMatch(lastCp.text,/Chapters|Recent conversation/);
 assert.match(lastCp.text,new RegExp(`noted ${cps.length}`));assert.doesNotMatch(lastCp.text,/noted 1\n/);
 assert.match(lastCp.text,/## Original task \(verbatim, #1\)\nRead big\.txt in parts\./);
 assert.match(lastCp.text,/Links and paths seen in this stretch but not in the brief[\s\S]*https:\/\/example\.com\/doc\/\d+/);
 assert.match(lastCp.text,/### Files read\n- big\.txt/);
});

test('a work agent hands off to a fresh conversation after each finished checklist step, never after the last one',async t=>{
 let n=-1;const handoffs=[];
 const items=done=>['survey','draft','verify'].map((x,i)=>({text:x,status:i<done?'done':i===done?'in_progress':'pending'}));
 const f=await agentFixture(t,body=>{
  if(isHandoff(body)){handoffs.push(text(last(body,'user')));return {content:SUMMARY_HEADINGS.map(h=>`## ${h}\n- ${h==='Next move'?'start '+['','draft','verify'][handoffs.length]:'noted'}`).join('\n')};}
  n++;
  if(n===0)return {calls:[{name:'todo',args:{items:items(0)}}]};
  if(n<4)return {content:`Survey ${n}: ${lorem(1500)}`,calls:[{name:'read',args:{path:'big.txt',offset:1+n*10,limit:30}}]};
  if(n===4)return {calls:[{name:'todo',args:{items:items(1)}}]};
  if(n<8)return {content:`Draft ${n}: ${lorem(1500)}`,calls:[{name:'read',args:{path:'big.txt',offset:1+n*10,limit:30}}]};
  if(n===8)return {calls:[{name:'todo',args:{items:items(2)}}]};
  if(n===9)return {content:`Verify: ${lorem(300)}`,calls:[{name:'todo',args:{items:items(3)}}]};
  return {content:'All three steps are done.'};
 },{context:64000});
 const s=await f.rt.spawn(null,{task:'Survey, draft and verify big.txt.'});await bigFile(s.cwd);
 await until(()=>f.rt.sessions.get(s.id).status==='done',30000,()=>progress(f,s.id));
 const cps=f.rt.sessions.entries(s.id,{types:['checkpoint']});
 assert.deepEqual(cps.map(c=>[c.reason,c.stepsDone]),[['step',1],['step',2]],'one handoff per finished step, none after the last');
 assert.equal(handoffs.length,2);
 // Each fresh conversation starts from the handoff alone: none of the previous step's turns are in view.
 const reqs=f.model.requests.filter(b=>!isHandoff(b));
 const firstAfter=reqs.find(b=>text(b.messages[1]).startsWith('<handoff')&&/stepsDone|reason="step"/.test(text(b.messages[1])));
 assert.ok(firstAfter);assert.ok(firstAfter.messages.every(m=>!/^Survey \d+:/.test(text(m))),'the survey turns left view');
 assert.match(text(firstAfter.messages[1]),/## Original task \(verbatim, #1\)\nSurvey, draft and verify big\.txt\./);
 assert.match(text(firstAfter.messages[1]),/\[x\] 1\. survey\n\[>\] 2\. draft/);
 assert.match(text(firstAfter.messages[1]),/## Next move\n- start draft/);
 // A small step is not worth a brief: the guard keeps the trigger off when little would be dropped.
 const c=new Compactor({}),view={checkpoint:null},session={kind:'worker',todo:items(1)};
 assert.equal(c.plan({tokens:100,view,rendered:[{tokens:100,entry:{seq:1,type:'tool'},message:{role:'tool',content:'x'}}]},10000,1,{session}).action,'none');
 assert.equal(c.plan({tokens:2000,view,rendered:[{tokens:2000,entry:{seq:1,type:'tool'},message:{role:'tool',content:'x'}}]},10000,1,{session}).reason,'step');
 assert.equal(c.plan({tokens:2000,view,rendered:[{tokens:2000,entry:{seq:1,type:'tool'},message:{role:'tool',content:'x'}}]},10000,1,{session:{...session,kind:'main'}}).action,'none');
 assert.equal(c.plan({tokens:2000,view:{checkpoint:{stepsDone:1}},rendered:[{tokens:2000,entry:{seq:1,type:'tool'},message:{role:'tool',content:'x'}}]},10000,1,{session}).action,'none');
});

test('the handoff threshold and the brief cap follow the model window',()=>{
 // B is derived from the window; the brief is 6% of B within 400–4000 tokens, for workers and the main session alike.
 assert.equal(briefBudget(5000),400);assert.equal(briefBudget(20000),1200);assert.equal(briefBudget(1e6),4000);
 const c=new Compactor({}),view={checkpoint:null},rendered=[],main={kind:'main'};
 for(const B of [9000,90000]){
  assert.equal(c.plan({tokens:0.79*B,view,rendered},B,1).action,'none');assert.equal(c.plan({tokens:0.81*B,view,rendered},B,1).action,'compact');
  // The main session hands off between turns; inside a turn only an imminent overflow (90%) forces it.
  assert.equal(c.plan({tokens:0.85*B,view,rendered},B,1,{session:main}).action,'none');assert.equal(c.plan({tokens:0.91*B,view,rendered},B,1,{session:main}).action,'compact');
  assert.equal(c.plan({tokens:0.6*B,view,rendered},B,1,{session:main,idle:true}).action,'compact');
 }
});

test('fork hands a new agent its requester\'s ledger and brief in the handoff shape',async t=>{
 const ledgerEntries=[{seq:1,type:'input',kind:'task',text:'Plan the trip.'},{seq:2,type:'input',kind:'message',from:'user',text:'Budget is 80000 yen.'},{seq:3,type:'tool',name:'write',data:{path:'/w/plan.md',op:'write',bytes:5,sha:'x'},stub:'write'}];
 const ctx=forkContext({parentId:'p1',kind:'worker',checkpoint:{seq:9,upTo:3,summary:'## Objective\n- trip plan',ledger:foldLedger(null,ledgerEntries,{kind:'worker'})},entries:[{seq:10,type:'input',from:'user',text:'Prefer trains.'},{seq:11,type:'assistant',content:'Noted.'}],todo:[{text:'book',status:'pending'}]});
 assert.match(ctx,/^--- Context from your requester \(quoted, for reference; #n refers to its log: recall\("p1#n"\)\) ---\n## Requester's ledger\n/);
 for(const s of ['Plan the trip.','Budget is 80000 yen.','Prefer trains.','/w/plan.md (write','[ ] 1. book',"## Requester's brief (#9)\n## Objective\n- trip plan",'## Since the brief\n'])assert.ok(ctx.includes(s),s);
 let first=null;
 const f=await agentFixture(t,body=>{if(!first&&text(body.messages[1]).includes('Sub task'))first=text(body.messages[1]);return {content:'ok'};},{context:64000});
 const main=f.rt.main();f.rt.sessions.append(main.id,'input',{kind:'message',from:'user',text:'メインの指示: 日本語で'});
 await f.rt.spawn(f.rt.sessions.get(main.id),{task:'Sub task',context:'fork'});
 await until(()=>first);
 assert.match(first,new RegExp(`recall\\("${main.id}#n"\\)`));assert.match(first,/## Requester's ledger[\s\S]*メインの指示: 日本語で[\s\S]*## Requester's brief\n\(none yet\)/);
});

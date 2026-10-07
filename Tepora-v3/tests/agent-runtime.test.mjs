import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {last,toolResults} from './helpers/scripted-model.mjs';
import {agentFixture} from './helpers/agent-fixture.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
const isMain=body=>body.messages[0].content.includes('chief of staff');
const userText=m=>typeof m?.content==='string'?m.content:'';
const replies=events=>events.filter(e=>e.type==='agent.reply').map(e=>e.data.text);

test('the main session delegates, the worker writes a real file, and its report comes back to be told to the user',async t=>{
 const f=await agentFixture(t,body=>{
  const tools=toolResults(body);
  if(isMain(body)){
   const lastUser=userText(last(body,'user'));
   if(lastUser.includes('report from'))return {content:'メモができました。'};
   if(!tools.length)return {calls:[{name:'sessions_spawn',args:{task:'Write memo.txt containing exactly: 牛乳を買う',title:'メモ'}}]};
   return {content:'メモを作る係に頼みました。'};
  }
  if(!tools.length)return {calls:[{name:'write',args:{path:'memo.txt',content:'牛乳を買う'}}]};
  return {content:'memo.txt を作りました。'};
 });
 const main=f.rt.main();
 f.rt.send(main.id,{text:'買い物メモを作って',from:'user'});
 await until(()=>replies(f.events).includes('メモができました。'));
 const worker=f.rt.sessions.list({kind:'worker'})[0];
 assert.equal(worker.status,'done');assert.equal(worker.result,'memo.txt を作りました。');
 assert.equal(await readFile(path.join(worker.cwd,'memo.txt'),'utf8'),'牛乳を買う');
 assert.deepEqual(replies(f.events),['メモを作る係に頼みました。','メモができました。']);
 const report=f.rt.sessions.entries(main.id,{types:['input']}).find(e=>e.kind==='report');
 assert.match(report.header,/report from "メモ"/);
});

test('a reply cut off at the output limit is continued instead of failing the session',async t=>{
 const f=await agentFixture(t,(body,{index})=>{
  if(index===0)return {content:'前半',finish:'length'};
  if(index===1){assert.match(userText(last(body,'user')),/cut off at the output limit/);return {content:'後半です'};}
  return {content:'?'};
 });
 const main=f.rt.main();f.rt.send(main.id,{text:'長い文を書いて',from:'user'});
 await until(()=>replies(f.events).length===1);
 assert.equal(replies(f.events)[0],'後半です');
 assert.equal(f.rt.sessions.get(main.id).status,'idle');
});

test('a malformed tool call is answered with the error and the model resends it',async t=>{
 const f=await agentFixture(t,(body,{index})=>{
  if(isMain(body))return {content:'ok'};
  if(index===0)return {calls:[{name:'write',arguments:'{"path":"a.txt","content":"x"'}]};
  if(index===1){const r=toolResults(body).at(-1);assert.match(r.content,/repaired automatically|Wrote/);return {content:'done'};}
  return {content:'done'};
 });
 const s=await f.rt.spawn(null,{task:'write a.txt'});
 await until(()=>f.rt.sessions.get(s.id).status==='done');
 assert.equal(await readFile(path.join(s.cwd,'a.txt'),'utf8'),'x');
});

test('a model server that is down puts the session in waiting and it resumes by itself',async t=>{
 const f=await agentFixture(t,body=>({content:'復帰しました'}));
 f.model.setDown(true);
 const main=f.rt.main();f.rt.send(main.id,{text:'こんにちは',from:'user'});
 await until(()=>f.rt.sessions.get(main.id).status==='waiting',15000);
 assert.ok(f.rt.sessions.get(main.id).retryAt);
 f.model.setDown(false);f.registry.health.clear();f.rt.wake(main.id);
 await until(()=>replies(f.events).includes('復帰しました'));
});

test('unknown tools and invalid arguments become tool errors the model can fix',async t=>{
 const f=await agentFixture(t,(body,{index})=>{
  if(index===0)return {calls:[{name:'writ',args:{path:'b.txt'}},{name:'write',args:{path:'b.txt'}}]};
  if(index===1){const [a,b]=toolResults(body);assert.match(a.content,/Unknown tool "writ".*write/s);assert.match(b.content,/arguments.content is required/);return {calls:[{name:'write',args:{path:'b.txt',content:'ok'}}]};}
  return {content:'fixed'};
 });
 const s=await f.rt.spawn(null,{task:'make b.txt'});
 await until(()=>f.rt.sessions.get(s.id).status==='done');
 assert.equal(await readFile(path.join(s.cwd,'b.txt'),'utf8'),'ok');
});

test('a worker with open checklist items is nudged once before it may finish',async t=>{
 const f=await agentFixture(t,(body,{index})=>{
  if(index===0)return {calls:[{name:'todo',args:{items:[{text:'調べる',status:'done'},{text:'まとめる',status:'in_progress'}]}}]};
  if(index===1)return {content:'終わりました'};
  if(index===2){assert.match(userText(last(body,'user')),/open items/);return {calls:[{name:'todo',args:{items:[{text:'調べる',status:'done'},{text:'まとめる',status:'done'}]}}]};}
  return {content:'すべて終わりました'};
 });
 const s=await f.rt.spawn(null,{task:'research'});
 await until(()=>f.rt.sessions.get(s.id).status==='done');
 assert.equal(f.rt.sessions.get(s.id).result,'すべて終わりました');
});

test('the prompt prefix is byte-identical from one step to the next while nothing is compacted',async t=>{
 const f=await agentFixture(t,(body,{index})=>index<4?{calls:[{name:'write',args:{path:`f${index}.txt`,content:'x'.repeat(50)}}]}:{content:'done'});
 const s=await f.rt.spawn(null,{task:'write files'});
 await until(()=>f.rt.sessions.get(s.id).status==='done');
 const reqs=f.model.requests.map(r=>JSON.stringify({tools:r.tools,messages:r.messages}));
 for(let i=1;i<reqs.length;i++){
  const prev=f.model.requests[i-1],next=f.model.requests[i];
  assert.equal(JSON.stringify(next.tools),JSON.stringify(prev.tools));
  assert.deepEqual(next.messages.slice(0,prev.messages.length),prev.messages,`step ${i} changed earlier messages`);
 }
});

test('a tool interrupted by a restart is reported as unknown and the session continues',async t=>{
 let release;const gate=new Promise(r=>{release=r;});
 const handler=async(body,{index})=>{
  const results=toolResults(body);
  if(!results.length)return {calls:[{name:'exec',args:{command:'sleep 30',yield:60}}]};
  return {content:/restarted|interrupted/.test(results.at(-1).content)?'状態を確認しました':'?'};
 };
 const f=await agentFixture(t,handler);
 const s=await f.rt.spawn(null,{task:'run something long'});
 await until(()=>f.rt.sessions.tail(s.id,5).some(e=>e.type==='assistant'&&e.toolCalls?.length));
 await wait(200);
 const g=await f.restart();
 await until(()=>g.rt.sessions.get(s.id).status==='done');
 assert.equal(g.rt.sessions.get(s.id).result,'状態を確認しました');
 release();
});

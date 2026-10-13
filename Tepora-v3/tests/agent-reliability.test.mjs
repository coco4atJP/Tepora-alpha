import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,unlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {Compactor} from '../core/agent/compaction.mjs';
import {ModelDispatch} from '../core/model-usage.mjs';

const summary=`## Goal\nPreserve the release task.\n## Work completed\nFiles were inspected.\n## Constraints\nDo not publish.\n## Current work\nTests remain pending.\n## Next step\nCheck the final artifact.`;

test('the first worker request inherits repository and cwd instructions, then notices edits without replacing the cached prefix',async t=>{
 const f=await agentFixture(t,()=>({content:'done'})),project=path.join(f.dir,'project'),nested=path.join(project,'src');
 await mkdir(path.join(project,'.git'),{recursive:true});await mkdir(nested);await mkdir(path.join(project,'.agents'));
 await writeFile(path.join(f.dir,'AGENTS.md'),'UNRELATED_OUTSIDE_INSTRUCTION');
 await writeFile(path.join(project,'.agents','AGENTS.md'),'ROOT_INSTRUCTION: run the project checks.');
 const instructions=path.join(nested,'AGENTS.md');await writeFile(instructions,'NESTED_INSTRUCTION: preserve public names.');
 const s=await f.rt.spawn(null,{task:'Inspect this project',cwd:nested});await until(()=>f.rt.sessions.get(s.id).status==='done');
 const initial=f.model.requests[0].messages[0].content;
 assert.match(initial,/ROOT_INSTRUCTION/);assert.match(initial,/NESTED_INSTRUCTION/);assert.doesNotMatch(initial,/UNRELATED_OUTSIDE_INSTRUCTION/);
 await writeFile(instructions,'UPDATED_INSTRUCTION: run the new checks.');
 f.rt.loop.prompt(f.rt.sessions.get(s.id));f.rt.loop.prompt(f.rt.sessions.get(s.id));
 let notices=f.rt.sessions.entries(s.id,{types:['notice']}).filter(e=>e.promptUpdate);
 assert.equal(notices.filter(e=>e.text.includes('UPDATED_INSTRUCTION')).length,1);
 assert.equal(f.rt.sessions.get(s.id).system,initial);
 await unlink(instructions);f.rt.loop.prompt(f.rt.sessions.get(s.id));
 notices=f.rt.sessions.entries(s.id,{types:['notice']}).filter(e=>e.promptUpdate);
 assert.equal(notices.length,2);assert.doesNotMatch(notices.at(-1).text,/UPDATED_INSTRUCTION/);
 assert.match(f.rt.loop.prompt(f.rt.sessions.get(s.id),{refresh:true}).system,/ROOT_INSTRUCTION/);
 assert.doesNotMatch(f.rt.sessions.get(s.id).system,/NESTED_INSTRUCTION|UPDATED_INSTRUCTION/);
});
async function compactFixture(t,answers,{large=false}={}){
 const f=await agentFixture(t,()=>({content:'unused'}));
 let s=f.rt.sessions.create({kind:'worker',cwd:f.dir,role:'work',toolset:'worker',task:'Prepare a release note.'});
 s=f.rt.loop.prompt(s);
 f.rt.sessions.append(s.id,'input',{kind:'task',from:'user',text:'Prepare a release note. Do not publish.'});
 for(let i=0;i<(large?20:1);i++)f.rt.sessions.append(s.id,'assistant',{content:'Inspected the source files. '.repeat(80)});
 f.rt.sessions.append(s.id,'input',{kind:'message',from:'user',text:'Keep my staged changes.'});
 f.rt.sessions.append(s.id,'assistant',{content:'Verification remains pending.'});
 const built=f.rt.assembler.build(s.id,{system:s.system});let calls=0;
 const compactor=new Compactor({sessions:f.rt.sessions,assembler:f.rt.assembler,registry:{invoke:async()=>answers[Math.min(calls++,answers.length-1)]}});
 const cp=await compactor.compact(s,{built,B:8192,ratio:1,system:s.system,toolDefs:[],chain:['unused'],reason:'overflow'});
 return {cp,calls,f,s};
}

test('overflow compaction rejects a well-formed but truncated summary and retains exact instructions',async t=>{
 const {cp,f,s}=await compactFixture(t,[{content:summary,finish:'length'}]);
 assert.equal(cp.method,'deterministic');
 assert.notEqual(cp.summary,summary);
 assert.match(cp.text,/Do not publish/);
 assert.equal(f.rt.sessions.entries(s.id,{types:['input']}).length,2);
});

test('overflow compaction accepts a completed summary',async t=>{
 const {cp}=await compactFixture(t,[{content:summary,finish:'stop'}]);
 assert.equal(cp.method,'rolling');assert.equal(cp.summary,summary);
});

test('a later truncated chunk cannot commit an incomplete rolling summary',async t=>{
 const {cp,calls}=await compactFixture(t,[{content:summary,finish:'stop'},{content:summary,finish:'length'}],{large:true});
 assert.ok(calls>=2,'exercise more than one chunk');assert.equal(cp.method,'deterministic');
});

async function readTwice(t,text,{budget=4096,limit=800}={}){
 const f=await agentFixture(t,()=>({content:'unused'}));
 await writeFile(path.join(f.dir,'file.txt'),text);
 let s=f.rt.sessions.create({kind:'worker',cwd:f.dir,role:'work',toolset:'worker',task:'Read the file.'});s=f.rt.loop.prompt(s);
 for(const id of ['first','second']){
  const call={id,name:'read',arguments:JSON.stringify({path:'file.txt',limit})};
  f.rt.sessions.append(s.id,'assistant',{content:'',toolCalls:[call]});await f.rt.loop.runTools(s,[call],{B:budget});
 }
 return {f,s,entries:f.rt.sessions.entries(s.id,{types:['tool']})};
}

test('a clipped read is returned again instead of claiming the hidden middle was fully displayed',async t=>{
 const marker='important middle fact';
 const text=Array.from({length:800},(_,i)=>i===399?marker:`line ${i+1} ${'x'.repeat(180)}`).join('\n');
 const {f,s,entries:[first,second]}=await readTwice(t,text);
 assert.ok(first.evidenceId);assert.ok(!first.content.includes(marker));
 assert.ok(f.rt.sessions.evidence(first.evidenceId).content.includes(marker));
 assert.doesNotMatch(second.content,/shown in full above/);assert.ok(second.evidenceId);
 const call={id:'middle',name:'read',arguments:JSON.stringify({path:'file.txt',offset:400,limit:1})};
 f.rt.sessions.append(s.id,'assistant',{content:'',toolCalls:[call]});await f.rt.loop.runTools(s,[call],{B:4096});
 assert.match(f.rt.sessions.entries(s.id,{types:['tool']}).at(-1).content,/important middle fact/);
});

test('line-level clipping is disclosed and never remembered as a complete read',async t=>{
 const {entries:[first,second]}=await readTwice(t,'x'.repeat(2100)+'hidden tail',{budget:100000});
 assert.equal(first.data.truncatedLines,true);assert.match(first.content,/truncated/);
 assert.doesNotMatch(second.content,/shown in full above/);
});

test('a fully displayed unchanged read still reuses the visible transcript',async t=>{
 const {entries:[first,second]}=await readTwice(t,'a short file');
 assert.match(first.content,/a short file/);assert.match(second.content,/shown in full above/);
});

const until=async fn=>{const end=Date.now()+8000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out');};
for(const mode of ['followup','steer'])test(`${mode} respects the current turn boundary`,async t=>{
 let entered,release;const first=new Promise(r=>entered=r),resume=new Promise(r=>release=r);t.after(()=>release());
 const marker='SECOND_REQUEST_MARKER';
 const f=await agentFixture(t,async(body,{index})=>{
  if(index===0){entered();await resume;return {calls:[{name:'write',args:{path:'first.txt',content:'first result'}}]};}
  return {content:'完了しました。'};
 },{profile:{contextTokens:16384},settings:{verifyCompletion:'off'}});
 const s=await f.rt.spawn(null,{task:'Create the first result.'});await first;
 f.rt.send(s.id,{text:marker,mode});release();
 await until(()=>f.rt.sessions.pending(s.id).length===0&&f.rt.sessions.get(s.id).status==='done'&&!f.rt.runs.has(s.id));
 assert.equal(JSON.stringify(f.model.requests[1].messages).includes(marker),mode==='steer');
 const entries=f.rt.sessions.entries(s.id),input=entries.find(e=>e.type==='input'&&e.text===marker);
 assert.equal(entries.some(e=>e.seq<input.seq&&e.type==='assistant'&&!e.toolCalls?.length),mode==='followup');
});

test('summary spending reaches the session and daily budget without double counting normal calls',async t=>{
 const f=await agentFixture(t,()=>({content:'unused'}),{settings:{budget:{sessionUsd:0.01,dailyUsd:0.01}}});
 const s=f.rt.sessions.create({kind:'worker',cwd:f.dir,role:'work',toolset:'worker',task:'Budget test'});
 const receipt=new ModelDispatch(f.store,{id:'synthetic',model:'fixture',protocol:'chat-completions'},{sessionId:s.id,purpose:'summary',price:{input:10,output:10}});
 receipt.start();receipt.finish({usage:{input:10000,output:10000},usageStatus:{status:'complete',input:'reported',output:'reported'}},'completed');
 assert.match(f.rt.overBudget(f.rt.sessions.get(s.id)),/この仕事/);
 f.store.value('agent-settings',{budget:{sessionUsd:0,dailyUsd:0.01}});
 assert.match(f.rt.overBudget(f.rt.sessions.get(s.id)),/今日/);
});

test('a failed scheduled admission remains retryable and creates one worker after recovery',async t=>{
 const f=await agentFixture(t,()=>({content:'完了しました。'}),{profile:{contextTokens:16384}});
 let now=Date.now();f.rt.clock=()=>now;
 const obstruction=path.join(f.rt.workRoot,'sessions');await writeFile(obstruction,'fixture obstruction');
 const d=f.rt.scheduler.add({text:'Check the scheduled work.',in_minutes:0,mode:'task'});
 f.rt.scheduler.tick();f.rt.scheduler.tick();
 await until(()=>f.store.get('schedule',d.id)?.lastError);
 assert.equal(f.rt.sessions.list({kind:'worker'}).length,0);
 assert.equal(f.store.get('schedule',d.id).fired,0);
 await unlink(obstruction);now+=61000;
 f.rt.scheduler.tick();f.rt.scheduler.tick();
 await until(()=>!f.store.get('schedule',d.id));
 assert.equal(f.rt.sessions.list({kind:'worker'}).length,1);
});

test('retry after schedule acknowledgement failure reuses the admitted worker',async t=>{
 const f=await agentFixture(t,()=>({content:'完了しました。'}),{profile:{contextTokens:16384}});
 let now=Date.now();f.rt.clock=()=>now;
 const remove=f.store.remove.bind(f.store);let fail=true;
 f.store.remove=(kind,id)=>{if(kind==='schedule'&&fail){fail=false;throw new Error('injected acknowledgement failure');}return remove(kind,id);};
 const d=f.rt.scheduler.add({text:'Check the scheduled work.',in_minutes:0,mode:'task'});
 f.rt.scheduler.tick();await until(()=>f.store.get('schedule',d.id)?.lastError);
 const first=f.rt.sessions.list({kind:'worker'});assert.equal(first.length,1);
 now+=61000;f.rt.scheduler.tick();await until(()=>!f.store.get('schedule',d.id));
 assert.deepEqual(f.rt.sessions.list({kind:'worker'}).map(s=>s.id),first.map(s=>s.id));
 const id=first[0].id;
 assert.equal(f.rt.sessions.pending(id).filter(i=>i.kind==='task').length+f.rt.sessions.entries(id,{types:['input']}).filter(i=>i.kind==='task').length,1);
});

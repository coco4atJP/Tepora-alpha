import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {last} from './helpers/scripted-model.mjs';
import {memoryOp} from '../core/agent/episodes.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=15000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
const text=m=>typeof m?.content==='string'?m.content:'';
const isLabeling=body=>text(last(body,'user')).startsWith('[harness] Episode labeling.');
const isDream=body=>text(body.messages[0]).includes('Dreaming')||text(last(body,'user')).startsWith('## Episodes since the last consolidation');
async function turn(f,id,q){const n=f.rt.sessions.entries(id,{types:['assistant']}).length;f.rt.send(id,{text:q,from:'user'});await until(()=>f.rt.sessions.get(id).status==='idle'&&!f.rt.runs.has(id)&&f.rt.sessions.entries(id,{types:['assistant']}).length===n+1);}
const tool=name=>f=>f.rt.tools.get(name);

test('the <memory> block sits between the system prompt and the conversation, has no clock, and changes only at a handoff',async t=>{
 const f=await agentFixture(t,()=>({content:'はい'}),{context:32000});
 f.store.value('memory-core',{facts:'- 好きな飲み物は緑茶',engagement:'- 短く答える',revision:0,contextTokens:32000});
 f.store.put('skill',{id:'s1',name:'tea',description:'お茶の淹れ方',content:'お湯は80度',enabled:true});
 const main=f.rt.main();
 await turn(f,main.id,'こんにちは');
 const first=f.model.requests.at(-1).messages;
 assert.equal(first[0].role,'system');assert.equal(first[1].role,'user');
 assert.match(text(first[1]),/^<memory>\n[\s\S]*# Skills[\s\S]*- tea: お茶の淹れ方[\s\S]*# About the user\n- 好きな飲み物は緑茶[\s\S]*# How to engage with the user\n- 短く答える\n<\/memory>$/);
 assert.doesNotMatch(text(first[1]),/\d{4}-\d{2}-\d{2}/,'no clock in the stable block');
 assert.ok(!text(first[0]).includes('好きな飲み物'),'core memory is not in the system prompt');
 assert.ok(!text(first[0]).includes('# Skills'),'the main skill index lives in the memory block');
 // Dreaming rewrites core memory on disk; the running conversation keeps its prefix until the next handoff.
 f.store.value('memory-core',{facts:'- 好きな飲み物はほうじ茶',engagement:'',revision:1,contextTokens:32000});
 f.store.put('skill',{id:'s2',name:'coffee',description:'コーヒー',content:'豆を挽く',enabled:true});
 await turn(f,main.id,'元気？');
 const second=f.model.requests.at(-1).messages;
 assert.deepEqual(second.slice(0,2),first.slice(0,2),'the cached prefix did not move');
 assert.ok(!second.map(text).join('\n').includes('Your instructions changed'),'no mid-session instruction notice for the main session');
});

test('labels: every entry gets an episode, a stretch without usable labels continues the open episode, done ones leave the topic list',async t=>{
 const f=await agentFixture(t,()=>({content:'はい'}));
 const main=f.rt.main(),ep=f.rt.episodes;
 const add=(type,data)=>f.rt.sessions.append(main.id,type,data);
 const a=[add('input',{text:'旅行の計画を立てたい',from:'user'}),add('assistant',{text:'どこへ？'}),add('input',{text:'京都',from:'user'})];
 let r=ep.apply(main.id,{text:'',entries:a});
 assert.equal(r.fallback,true);assert.equal(r.cards.length,1);assert.equal(r.cards[0].title,'旅行の計画を立てたい');
 assert.ok(f.rt.sessions.entries(main.id).filter(e=>a.some(x=>x.seq===e.seq)).every(e=>e.episodeId==='E1'));
 const b=[add('input',{text:'ところで夕飯は？',from:'user'}),add('assistant',{text:'カレー'}),add('input',{text:'京都の宿も',from:'user'})];
 r=ep.apply(main.id,{text:[`E1 | open | 京都旅行 | 京都の旅程と宿 | #${b[2].seq} | 京都`,`Enew | done | 夕飯 | カレーに決めた | #${b[0].seq}-#${b[1].seq} | カレー`].join('\n'),entries:b});
 const byId=Object.fromEntries(f.store.list('episode').map(c=>[c.id,c]));
 assert.equal(byId.E2.state,'done');assert.equal(byId.E1.title,'京都旅行');
 assert.deepEqual(byId.E1.ranges,[[a[0].seq,a[2].seq],[b[2].seq,b[2].seq]],'an episode may be non-contiguous');
 const labels=Object.fromEntries(f.rt.sessions.entries(main.id).map(e=>[e.seq,e.episodeId]));
 assert.equal(labels[b[0].seq],'E2');assert.equal(labels[b[2].seq],'E1');
 const topics=ep.topics(main.id);
 assert.match(topics,/^- E1 京都旅行 — 京都の旅程と宿 \(#\d+-#\d+, #\d+\)$/);assert.ok(!topics.includes('E2'),'a done episode is reached only by search');
 // At most seven stay open: the least recently active is paused.
 const many=Array.from({length:8},(_,i)=>add('input',{text:`話題${i}`,from:'user'}));
 ep.apply(main.id,{text:many.map((e,i)=>`Enew | open | 話題${i} | s${i} | #${e.seq}`).join('\n'),entries:many});
 const open=f.store.list('episode').filter(c=>c.state==='open');assert.equal(open.length,7);
 assert.equal(f.store.list('episode').find(c=>c.id==='E1').state,'paused');
});

test('episode_search finds cards by words, by day (in the user\'s calendar) and a range recall reads the exact entries',async t=>{
 const f=await agentFixture(t,()=>({content:'はい'}));
 const main=f.rt.main(),ep=f.rt.episodes;
 const add=(type,data)=>f.rt.sessions.append(main.id,type,data);
 const e=[add('input',{text:'猫の名前を考えて',from:'user'}),add('assistant',{content:'タマはどう？'}),add('input',{text:'税金の書類',from:'user'})];
 ep.apply(main.id,{text:[`Enew | done | 猫の名前 | タマに決めた | #${e[0].seq}-#${e[1].seq} | 猫`,`Enew | open | 確定申告 | 書類の準備 | #${e[2].seq} | 税金`].join('\n'),entries:e});
 const ctx={session:f.rt.sessions.get(main.id)};
 const hit=await tool('episode_search')(f).run({query:'猫'},ctx);
 assert.match(hit.text,/^E1 · 猫の名前 \[done\]/);assert.ok(!hit.text.includes('確定申告'));
 const d=new Date(),day=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const daily=await tool('episode_search')(f).run({date:day},ctx);
 assert.ok(daily.text.includes('猫の名前')&&daily.text.includes('確定申告'),'a date gives that day\'s list');
 assert.equal((await tool('episode_search')(f).run({date:'2001-01-01'},ctx)).text,'No episodes found.');
 await assert.rejects(tool('episode_search')(f).run({date:'yesterday'},ctx),/date must look like/);
 const range=await tool('recall')(f).run({ref:`#${e[0].seq}-#${e[1].seq}`},ctx);
 assert.match(range.text,/\(2 entries\)/);assert.ok(range.text.includes('猫の名前を考えて')&&range.text.includes('タマはどう？'));
 assert.ok(!range.text.includes('税金'));
 assert.ok(f.rt.tools.toolset('main').includes('episode_search'));
});

test('a finished work agent is archived under its episode: out of the session list, still readable by id',async t=>{
 const f=await agentFixture(t,()=>({content:'Done.'}));
 const main=f.rt.main();
 const w=await f.rt.spawn(f.rt.sessions.get(main.id),{task:'Look something up.'});
 await until(()=>['done','stopped'].includes(f.rt.sessions.get(w.id).status)&&!f.rt.runs.has(w.id));
 const e=[f.rt.sessions.append(main.id,'input',{text:'調べて',from:'user'}),f.rt.sessions.append(main.id,'tool',{name:'sessions_spawn',content:'started',data:{sessionId:w.id}})];
 f.rt.episodes.apply(main.id,{text:`Enew | open | 調べ物 | 調査を頼んだ | #${e[0].seq}-#${e[1].seq}`,entries:e});
 const card=f.store.list('episode')[0];assert.deepEqual(card.children,[w.id]);
 assert.ok(!f.rt.sessions.list().some(s=>s.id===w.id),'archived out of the live list');
 const archived=f.rt.sessions.get(w.id);assert.equal(archived.archivedIn,card.id);
 assert.equal(f.rt.resolveSession(f.rt.sessions.get(main.id),w.id).id,w.id,'the card\'s id still resolves');
 assert.ok(f.rt.sessions.entries(w.id).length>0,'its transcript is kept');
});

test('Dreaming consolidates on the idle lease: adds and corrects memories, never touches the user\'s own, rewrites core memory within caps',async t=>{
 let dreams=0;
 const f=await agentFixture(t,body=>{
  if(isDream(body)){dreams++;const prompt=text(last(body,'user'));const m=/([0-9a-f-]{8,})[^\n]*\| *[^|\n]*\| *京都に住んでいる/.exec(prompt);
   const u=/([0-9a-f-]{8,})[^\n]*\| *[^|\n]*\| *緑茶が好き/.exec(prompt);
   return {content:`## Memory changes\n+ 猫の名前はタマ\n~ ${m?.[1]||'x'} 大阪に住んでいる\n- ${u?.[1]||'x'}\n## Facts\n- 大阪に住んでいる\n- 猫はタマ\n## How to engage\n- 短く答える`};}
  return {content:'はい'};
 },{context:32000});
 const main=f.rt.main();
 const user=f.store.memory('緑茶が好き',{source:'user'}),dreamt=f.store.memory('京都に住んでいる',{source:'dream'});
 const e=[f.rt.sessions.append(main.id,'input',{text:'引っ越した',from:'user'})];
 f.rt.episodes.apply(main.id,{text:`Enew | open | 引っ越し | 大阪へ | #${e[0].seq} | 大阪`,entries:e});
 assert.equal(f.rt.episodes.dreamDue(),true);
 const before=f.model.requests.length;
 assert.equal(await f.rt.dreamer.idle(main.id,new AbortController().signal),true);
 assert.equal(dreams,1);assert.equal(f.model.requests.length,before+1);
 const mem=f.store.list('memory');
 assert.equal(mem.find(m=>m.id===user.id)?.content,'緑茶が好き','the user\'s memory is neither changed nor deleted');
 assert.equal(mem.find(m=>m.id===dreamt.id)?.content,'大阪に住んでいる');
 assert.equal(mem.find(m=>m.content==='猫の名前はタマ')?.source,'dream');
 const core=f.store.value('memory-core');assert.equal(core.facts,'- 大阪に住んでいる\n- 猫はタマ');assert.equal(core.engagement,'- 短く答える');
 assert.equal(f.rt.episodes.dreamDue(),false,'nothing new to consolidate');
 // Caps follow the window.
 assert.deepEqual(memoryOp('caps',{contextTokens:32000}),{facts:1280,engagement:480,skills:960});
 // The dream setting turns Dreaming off.
 f.store.value('agent-settings',{dream:false});
 f.rt.episodes.apply(main.id,{text:'',entries:[f.rt.sessions.append(main.id,'input',{text:'また',from:'user'})]});
 assert.equal(await f.rt.dreamer.idle(main.id,new AbortController().signal),false);assert.equal(dreams,1);
});

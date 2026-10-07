import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry,ResourceGate} from '../core/provider-registry.mjs';
import {encodeRequest} from '../core/provider-protocols.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';
import {imageInfo,imageTokens} from '../core/agent/images.mjs';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {scriptedModel,last,toolResults} from './helpers/scripted-model.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
const isMain=body=>body.messages[0].content.includes('chief of staff');
const text=m=>typeof m?.content==='string'?m.content:Array.isArray(m?.content)?m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'):'';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const plain=messages=>JSON.stringify(messages.map(({cache,...m})=>m));

async function bare(t,settings=null){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-fix-'));const store=new Store(dir),network=new NetworkPolicy(store);
 if(settings)store.value('agent-settings',settings);
 const rt=new AgentRuntime(store,{registry:new ProviderRegistry(store,network),network,workRoot:path.join(dir,'work'),autoStart:false});
 t.after(async()=>{await rt.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {rt,store,dir};
}
function step(rt,id,i,name,args,content,extra={}){
 rt.sessions.append(id,'assistant',{content:'',toolCalls:[{id:'c'+i,name,arguments:JSON.stringify(args)}]});
 return rt.sessions.append(id,'tool',{callId:'c'+i,name,content,stub:`${name} ${i}`,keep:false,...extra});
}

test('cache: a todo update leaves the earlier prompt byte-identical; superseded results shrink only at the next batch clear',async t=>{
 const {rt}=await bare(t);const s=rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()});
 rt.sessions.append(s.id,'input',{text:'task',kind:'task',from:'user'});
 step(rt,s.id,0,'todo',{items:[]},'Todo (0/3)\n[ ] a\n[ ] b\n[ ] c',{ephemeralKey:'todo'});
 for(let i=1;i<=6;i++)step(rt,s.id,i,'read',{path:'f'+i},'x'.repeat(3000));
 const before=rt.assembler.build(s.id,{system:'sys'}).messages;
 step(rt,s.id,7,'todo',{items:[]},'Todo (1/3)\n[x] a\n[>] b\n[ ] c',{ephemeralKey:'todo'});
 const after=rt.assembler.build(s.id,{system:'sys'}).messages;
 assert.ok(plain(after).startsWith(plain(before).slice(0,-1)),'the old prompt is a prefix of the new one');
 assert.match(text(after.find(m=>m.tool_call_id==='c0')),/Todo \(0\/3\)/,'the old todo stays verbatim until a clear');
 // A batch clear shrinks everything below the hot window at once, the superseded todo included.
 const built=rt.assembler.build(s.id,{system:'sys'}),cand=rt.compactor.clearCandidate(built,1);
 assert.ok(cand.savings>3000);rt.compactor.clear(s,cand.upTo);
 const cleared=rt.assembler.build(s.id,{system:'sys'}).messages;
 assert.match(text(cleared.find(m=>m.tool_call_id==='c0')),/result cleared/);assert.match(text(cleared.find(m=>m.tool_call_id==='c7')),/Todo \(1\/3\)/,'the latest todo always stays');
});

test('cache: long arguments of old calls (a written file) shrink at a clear and stay readable through recall',async t=>{
 const {rt}=await bare(t);const s=rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()});
 rt.sessions.append(s.id,'input',{text:'Write ten chapters.',kind:'task',from:'user'});
 for(let i=0;i<10;i++)step(rt,s.id,i,'write',{path:`ch${i}.md`,content:`第${i}章\n`+'本文の文章です。'.repeat(500)},`Wrote ch${i}.md`,{keep:true});
 const built=rt.assembler.build(s.id,{system:'sys'}),cand=rt.compactor.clearCandidate(built,1);
 assert.ok(cand&&cand.savings>30000,`a clear frees the arguments (${cand?.savings})`);
 assert.equal(rt.compactor.plan(built,50000,1).action,'clear','a cheap clear instead of a compaction');
 rt.compactor.clear(s,cand.upTo);
 const after=rt.assembler.build(s.id,{system:'sys'});
 assert.ok(after.tokens<built.tokens/4,`${after.tokens} < ${built.tokens}/4 (the last two steps stay verbatim)`);
 const call=after.messages.find(m=>m.tool_calls?.[0]?.id==='c0').tool_calls[0];
 const args=JSON.parse(call.function.arguments);assert.equal(args.path,'ch0.md');assert.match(args.content,/characters omitted from this old call; recall\("#2"\)/);
 const full=await rt.tools.get('recall').run({ref:'#2'},rt.toolContext(s,new AbortController().signal));
 assert.ok(full.text.includes('本文の文章です。'.repeat(500)),'recall returns the full call');
});

test('cache: worker reports in the resident session become one line once handled',async t=>{
 const {rt}=await bare(t);const main=rt.main();
 for(let i=0;i<8;i++){rt.sessions.append(main.id,'input',{text:`調査${i}の結果\n`+'調査結果の詳細です。'.repeat(300),kind:'report',from:'child:x'+i,title:'調査'+i,header:'[report]'});rt.sessions.append(main.id,'assistant',{content:`調査${i}が終わりました。`,toolCalls:[]});}
 const built=rt.assembler.build(main.id,{system:'sys'}),cand=rt.compactor.clearCandidate(built,1);
 assert.ok(cand.savings>15000);rt.compactor.clear(main,cand.upTo);
 const after=rt.assembler.build(main.id,{system:'sys'});
 assert.match(text(after.messages[1]),/report from "調査0" cleared to save context. It began: 調査0の結果/);
 assert.ok(after.tokens<built.tokens/3);
 assert.match(text(after.messages.at(-2)),/調査結果の詳細です。調査結果/,'the newest reports stay verbatim');
});

test('Anthropic: four breakpoints including the previous request end, and the one-hour cache for long retention',()=>{
 const p={protocol:'anthropic',model:'claude',identity:'x',cache:true};
 const calls=[...Array(12).keys()].map(i=>({id:'t'+i,type:'function',function:{name:'read',arguments:'{}'}}));
 const messages=[{role:'system',content:'sys'},{role:'user',content:'checkpoint',cache:true},{role:'user',content:'task'},
  {role:'assistant',content:'',tool_calls:[{id:'a',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:'r',cache:true},
  {role:'assistant',content:'',tool_calls:calls},...calls.map(c=>({role:'tool',tool_call_id:c.id,content:'r'})),];
 messages[messages.length-1]={...messages.at(-1),cache:true};
 const body=encodeRequest(p,messages,{cacheRetention:'long'});
 const marks=JSON.stringify(body).match(/"cache_control"/g).length;assert.equal(marks,4);
 assert.equal(body.system[0].cache_control.ttl,'1h');
 const prevEnd=body.messages[2].content.at(-1);assert.equal(prevEnd.tool_use_id,'a');assert.ok(prevEnd.cache_control,'the previous request end keeps a breakpoint');
 assert.equal(encodeRequest(p,messages,{}).system[0].cache_control.ttl,undefined);
 const oa=encodeRequest({...p,protocol:'responses',domain:'cloud'},messages,{cacheRetention:'long',cacheKey:'k'});assert.equal(oa.prompt_cache_retention,'24h');
});

test('a model that thinks silently past the idle limit gets a longer wait instead of failing forever',async t=>{
 let requests=0;
 const server=http.createServer(async(req,res)=>{
  for await(const _ of req);if(!req.url.endsWith('/chat/completions')){res.writeHead(404);return res.end('{}');}
  requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();await wait(1600);if(res.destroyed)return;
  res.write(`data: ${JSON.stringify({choices:[{delta:{content:'考えました'}}]})}\n\n`);res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`);res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-fix-'));const store=new Store(dir),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network,{detectLimits:false});
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 registry.save({profiles:[{id:'slow',protocol:'chat-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'m',domain:'device',capabilities:{tools:true},firstByteTimeoutMs:10000,idleTimeoutMs:1000}],routes:{main:{primary:'slow'}}},0);
 const answer=await registry.invoke('main',[{role:'user',content:'難問'}]);
 assert.equal(answer.content,'考えました');assert.ok(requests>=2);
 assert.ok(registry.timeouts(registry.get().profiles[0]).idleTimeoutMs>=2000,'the longer wait is remembered');
});

test('NO_REPLY never reaches the screen, with or without punctuation',async t=>{
 for(const reply of ['NO_REPLY','NO_REPLY。','`NO_REPLY` (nothing new)']){
  const f=await agentFixture(t,()=>({content:reply}));
  const deltas=[];f.store.listeners.add(e=>{if(e.type==='agent.delta')deltas.push(e.data.text);});
  f.rt.send(f.rt.main().id,{text:'Check-in.',from:'timer',kind:'heartbeat'});
  const r=await until(()=>f.events.find(e=>e.type==='agent.reply'));
  assert.equal(r.data.silent,true,reply);assert.ok(deltas.every(d=>!/NO_?R/i.test(d)),JSON.stringify(deltas));
  await until(()=>f.rt.sessions.get(f.rt.main().id).status==='idle');
  const said=f.rt.sessions.entries(f.rt.main().id,{types:['assistant']})[0];assert.equal(said.content,reply);
  assert.equal((await import('../core/agent/ui-model.mjs')).messageOf(said,f.rt.main()),null,'not shown in the conversation');
 }
});

test('a work agent waiting for its requester gets the answer sent to it, not the requester\'s next reply to the user',async t=>{
 const f=await agentFixture(t,body=>{
  const results=toolResults(body),lastUser=text(last(body,'user'));
  if(isMain(body)){
   if(body.messages.at(-1).role==='tool')return {content:'NO_REPLY'};
   if(lastUser.includes('report from'))return {content:'答えは42でした。'};
   const asker=/message from "質問係" \(([0-9a-f-]{36})\)/.exec(lastUser)?.[1];
   if(asker)return {content:'ちょっと確認するね。',calls:[{name:'sessions_send',args:{session:asker,message:'答えは42'}}]};
   if(lastUser.includes('調べて'))return {calls:[{name:'sessions_spawn',args:{task:'Ask your requester for the magic number, then report it.',title:'質問係'}}]};
   return {content:'NO_REPLY'};
  }
  if(!results.length)return {calls:[{name:'sessions_send',args:{session:'parent',message:'What is the magic number?',wait:20}}]};
  return {content:`報告: ${results.at(-1).content}`};
 });
 f.rt.send(f.rt.main().id,{text:'数を調べて',from:'user'});
 const workerId=(await until(()=>f.rt.sessions.list({kind:'worker'})[0])).id;
 const worker=await until(()=>{const w=f.rt.sessions.get(workerId);return w.status==='done'&&w;},15000);
 assert.match(worker.result,/答えは42/);assert.doesNotMatch(worker.result,/ちょっと確認/);
 assert.equal(f.rt.sessions.pending(workerId).length,0,'the answer was not delivered a second time');
});

test('an escalated session goes back to its usual model after a stretch of healthy steps',async t=>{
 const {rt}=await bare(t);const s=rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()});
 rt.sessions.update(s.id,{role:'escalation',baseRole:'work'});const mem=rt.loop.state(s.id);
 for(let i=0;i<7;i++){mem.calls.push({sig:'s'+i,outcome:'o'+i,label:'x',error:false});rt.loop.watch(s.id,mem);}
 assert.equal(rt.sessions.get(s.id).role,'escalation');
 mem.calls.push({sig:'s8',outcome:'o8',label:'x',error:false});rt.loop.watch(s.id,mem);
 assert.equal(rt.sessions.get(s.id).role,'work');assert.match(rt.sessions.entries(s.id,{types:['notice']}).at(-1).text,/back on the usual model/);
});

test('check-ins wake the model only when the work changed; schedule delivers reminders and repeats',async t=>{
 const f=await agentFixture(t,()=>({content:'NO_REPLY'}),{settings:{heartbeat:{enabled:true,minutes:60}}});
 const main=f.rt.main(),idle=()=>until(()=>f.rt.sessions.get(main.id).status==='idle'&&!f.rt.runs.has(main.id));
 assert.equal(await f.rt.heartbeat(),false,'nothing going on: no model call');
 const w=f.rt.sessions.create({kind:'worker',title:'調査',parentId:main.id,cwd:os.tmpdir()});f.rt.sessions.update(w.id,{status:'running'});
 assert.equal(await f.rt.heartbeat(),true);await idle();
 assert.equal(await f.rt.heartbeat(),false,'unchanged since the last check-in');
 f.rt.sessions.update(w.id,{status:'done',result:'ok'});assert.equal(await f.rt.heartbeat(),true);await idle();
 const sent=f.rt.sessions.entries(main.id,{types:['input']}).filter(e=>e.kind==='heartbeat');assert.equal(sent.length,2);assert.match(sent[1].text,/"調査" .*done/);
 // schedule: a due reminder becomes an input to the character; a repeating one keeps its rhythm.
 const once=f.rt.scheduler.add({text:'薬を飲む時間',in_minutes:0}),repeat=f.rt.scheduler.add({text:'メールを確認',in_minutes:0,every_minutes:30,mode:'remind'});
 f.rt.scheduler.tick();await idle();
 const reminders=f.rt.sessions.entries(main.id,{types:['input']}).filter(e=>e.kind==='reminder').map(e=>e.text);
 assert.deepEqual(reminders.sort(),['メールを確認','薬を飲む時間']);
 assert.equal(f.store.get('schedule',once.id),null);const next=f.store.get('schedule',repeat.id);assert.equal(next.fired,1);assert.ok(Date.parse(next.at)>Date.now()+29*60000);
 const tool=await f.rt.tools.get('schedule').run({action:'list'},f.rt.toolContext(main,new AbortController().signal));assert.match(tool.text,/every 30 min: メールを確認/);
});

test('local slots: requests spread over free slots, the character keeps a reserved one, workers never overtake it',async()=>{
 const reg=new ProviderRegistry({value:()=>null},{});
 const a=reg.leaseSlot('r',3,'main',true),b=reg.leaseSlot('r',3,'w1',false),c=reg.leaseSlot('r',3,'w2',false);
 assert.deepEqual([a.slot,b.slot,c.slot].sort(),[0,1,2]);b.release();c.release();a.release();
 assert.equal(reg.leaseSlot('r',3,'w1',false).slot,b.slot,'a session gets its previous slot back (its cache)');
 const gate=new ResourceGate(),order=[];
 const w1=await gate.acquire('g',2,{priority:0,reserve:1});
 const w2=gate.acquire('g',2,{priority:0,reserve:1}).then(r=>{order.push('worker');return r;});
 const m=await gate.acquire('g',2,{priority:10,reserve:1});order.push('main');
 assert.deepEqual(order,['main'],'the character got the reserved slot while a worker waits');
 m();w1();(await w2)();assert.deepEqual(order,['main','worker']);
});

test('Ollama: the native API with num_ctx set to the window Tepora budgets for',async t=>{
 const bodies=[];let turn=0;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const json=o=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(o));};
  if(req.url==='/api/version')return json({version:'0.12.0'});
  if(req.url==='/api/show')return json({model_info:{'qwen3.context_length':40960}});
  if(req.url!=='/api/chat'){res.writeHead(404);return res.end('{}');}
  const body=JSON.parse(raw);bodies.push(body);res.writeHead(200,{'Content-Type':'application/x-ndjson'});
  const line=o=>res.write(JSON.stringify(o)+'\n');
  if(turn++===0){line({message:{role:'assistant',content:'',tool_calls:[{function:{name:'write',arguments:{path:'note.txt',content:'ollama'}}}]},done:false});line({done:true,done_reason:'stop',prompt_eval_count:900,eval_count:12});}
  else{line({message:{role:'assistant',thinking:'ok'},done:false});line({message:{role:'assistant',content:'書きました。'},done:false});line({done:true,done_reason:'stop',prompt_eval_count:40,eval_count:5});}
  res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const f=await agentFixture(t,()=>({content:'unused'}),{profile:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,maxTokens:2048}});
 const s=await f.rt.spawn(null,{task:'Write note.txt'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;},10000);
 assert.equal(done.result,'書きました。');assert.equal(await readFile(path.join(s.cwd,'note.txt'),'utf8'),'ollama');
 assert.equal(bodies[0].options.num_ctx,32768);assert.equal(bodies[0].stream,true);assert.ok(bodies[0].tools.length>3);
 assert.equal(bodies[1].messages.at(-1).role,'tool');assert.equal(bodies[1].messages.at(-1).tool_name,'write');
 assert.equal(f.store.value('token-ratio:'+f.registry.get().profiles[0].identity),null,'uncached counts do not calibrate');
});

test('a server that silently cuts the prompt to an unknown smaller window is caught; the window is learnt',async t=>{
 const f=await agentFixture(t,body=>({content:'見えた範囲で答えます',usage:{prompt_tokens:3000,completion_tokens:5}}),{profile:{maxTokens:1024}});
 const p=f.registry.get().profiles[0];
 const s=await f.rt.spawn(null,{task:'長い資料:\n'+'資料の本文です。'.repeat(1500)});
 await until(()=>f.rt.sessions.entries(s.id,{types:['event']}).some(e=>e.event==='input-truncated'));
 assert.ok(f.registry.knownLimits(p).context<=3100,'the real window is learnt');
 assert.equal(f.rt.sessions.entries(s.id,{types:['assistant']}).length,0,'the beheaded answer was dropped');
 f.rt.stop(s.id);
});

test('images: read shows a picture to a seeing model, after all results of the step; a blind model gets placeholders',async t=>{
 const sizes=imageInfo(Buffer.from(PNG,'base64'));assert.deepEqual(sizes,{mime:'image/png',width:1,height:1});assert.equal(imageTokens('data:image/png;base64,'+PNG),85);
 let rejected=0;
 const f=await agentFixture(t,body=>{
  const hasImage=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
  if(hasImage&&!rejected){rejected++;return {status:400,body:{error:{message:'This model does not support image input'}}};}
  const results=toolResults(body);
  if(!results.length)return {calls:[{name:'read',args:{path:'pic.png'}},{name:'read',args:{path:'note.txt'}}]};
  return {content:results.map(r=>r.content).join('\n')};
 });
 const s=f.rt.sessions.create({kind:'worker',title:'w',cwd:path.join(f.dir,'img')});await mkdir(s.cwd,{recursive:true});
 await writeFile(path.join(s.cwd,'pic.png'),Buffer.from(PNG,'base64'));await writeFile(path.join(s.cwd,'note.txt'),'memo');
 f.rt.send(s.id,{text:'Look at pic.png',kind:'task'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;},10000);
 const first=f.model.requests.find(b=>b.messages.some(m=>Array.isArray(m.content)));
 const i=first.messages.findIndex(m=>Array.isArray(m.content));assert.equal(first.messages[i-1].role,'tool');assert.equal(first.messages[i-2].role,'tool','the image follows both results');
 assert.match(done.result,/not shown: this model cannot see images/);assert.equal(f.registry.visionAllowed(f.registry.get().profiles[0]),false);
});

test('changed instructions are appended to the transcript; the system prompt itself waits for the next checkpoint',async t=>{
 const {rt,store}=await bare(t);const s=rt.loop.prompt(rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()}));
 const system=s.system;rt.configure({sandbox:{mode:'workspace',network:false}});
 assert.equal(rt.refreshPrompts(),1);
 const after=rt.sessions.get(s.id);assert.equal(after.system,system,'the cached prefix is untouched');assert.equal(after.promptStale,true);
 const notice=rt.sessions.tail(s.id,1)[0];assert.match(notice.text,/instructions changed[\s\S]*# Environment[\s\S]*workspace without network/);
 assert.equal(rt.refreshPrompts(),0,'a second refresh with no change in between appends nothing');
 const fresh=rt.loop.prompt(rt.sessions.get(s.id),{refresh:true});assert.match(fresh.system,/workspace without network/);assert.equal(fresh.promptStale,false);
 assert.equal(rt.refreshPrompts(),0,'nothing left to tell after the checkpoint re-baselined the prompt');
});

test('exec: Japanese output split across chunks stays intact; progress bars collapse to what a terminal shows',async t=>{
 const {rt}=await bare(t);const s=rt.sessions.create({kind:'worker',title:'p',cwd:path.join(os.tmpdir(),'tepora-fix-cwd')});await mkdir(s.cwd,{recursive:true});
 const ctx=()=>rt.toolContext(s,new AbortController().signal);
 const big=await rt.tools.get('exec').run({command:`node -e "process.stdout.write('あ'.repeat(120000))"`},ctx());
 assert.equal((big.text.match(/�/g)||[]).length,0);
 const bar=await rt.tools.get('exec').run({command:`node -e "for(let i=0;i<=100;i++)process.stdout.write('Downloading '+i+'%\\r');console.log('Downloading 100%');for(let i=0;i<50;i++)console.log('same line')"`},ctx());
 assert.match(bar.text,/^exit 0[^\n]*\nDownloading 100%\nsame line\n… \(line above repeated 49 more times\)/);
});

test('skills: enabled skills are listed by name and loaded in full on demand',async t=>{
 const {rt,store}=await bare(t);
 store.put('skill',{id:'pdf',name:'pdf-tools',description:'Extract text from PDF files. Use when reading PDFs.',content:'# PDF tools\nUse pdftotext -layout.',enabled:true});
 store.put('skill',{id:'off',name:'secret-off',description:'disabled',content:'x',enabled:false});
 const s=rt.loop.prompt(rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()}));
 assert.match(s.system,/# Skills[\s\S]*- pdf-tools: Extract text from PDF files/);assert.doesNotMatch(s.system,/secret-off/);
 const r=await rt.tools.get('skill').run({name:'pdf-tools'},rt.toolContext(s,new AbortController().signal));assert.match(r.text,/pdftotext -layout/);
 await assert.rejects(rt.tools.get('skill').run({name:'secret-off'},rt.toolContext(s,new AbortController().signal)),/No enabled skill/);
});

test('cost: catalog prices turn usage into spending; a spending cap pauses work until it is raised',async t=>{
 const f=await agentFixture(t,()=>({content:'done',usage:{prompt_tokens:1000000,completion_tokens:100000,prompt_tokens_details:{cached_tokens:500000}}}));
 f.store.put('catalog',{id:'models.dev',entries:[{providerId:'x',modelId:'m',cost:{input:2,output:8,cache_read:0.2}}]});
 const p=f.registry.get().profiles[0];
 assert.equal(f.registry.price({...p,domain:'device'}),null,'local models are free');
 f.registry.price=route=>({input:2,output:8,cache_read:0.2});
 const a=await f.rt.spawn(null,{task:'one'});const done=await until(()=>{const x=f.rt.sessions.get(a.id);return x.status==='done'&&x;});
 assert.ok(Math.abs(done.stats.cost-done.stats.steps*(0.5*2+0.5*0.2+0.1*8))<1e-9,`${done.stats.cost} for ${done.stats.steps} calls`);
 f.rt.configure({budget:{dailyUsd:1}});
 const b=await f.rt.spawn(null,{task:'two'});const paused=await until(()=>{const x=f.rt.sessions.get(b.id);return x.status==='waiting'&&x;});
 assert.match(paused.note,/今日の費用が上限/);
 f.rt.configure({budget:{dailyUsd:100}});await until(()=>f.rt.sessions.get(b.id).status==='done');
});

test('reading the same unchanged lines again returns a short pointer to the earlier result',async t=>{
 const f=await agentFixture(t,body=>{const n=toolResults(body).length;if(n<2)return {calls:[{name:'read',args:{path:'notes.txt'}}]};return {content:toolResults(body).map(r=>r.content.split('\n')[0]).join(' | ')};});
 const s=f.rt.sessions.create({kind:'worker',title:'w',cwd:path.join(f.dir,'dedupe')});await mkdir(s.cwd,{recursive:true});
 await writeFile(path.join(s.cwd,'notes.txt'),'line one\nline two\n');
 f.rt.send(s.id,{text:'Read notes.txt twice',kind:'task'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});
 assert.match(done.result,/notes\.txt \(3 lines\) \| .*notes\.txt is unchanged since #\d+/);
});

test('plugin hooks: block or rewrite a call, redact its result, and send an agent back at the end of its turn',async t=>{
 const f=await agentFixture(t,body=>{
  const r=toolResults(body);
  if(r.length===0)return {calls:[{name:'exec',args:{command:'rm -rf /tmp/nothing-here'}}]};
  if(r.length===1)return {calls:[{name:'exec',args:{command:'echo token=SECRET123'}}]};
  return {content:`results: ${r.map(x=>x.content.trim().split('\n').pop()).join(' / ')}${text(body.messages.at(-1)).includes('Add the date')?' (dated)':''}`};
 },{settings:{verifyCompletion:'off'}});
 let ends=0;
 f.rt.tools.addHooks({
  beforeTool:({name,args})=>name==='exec'&&/rm -rf/.test(args.command)?{block:'destructive commands are not allowed by the house rules'}:null,
  afterTool:({text})=>({text:text.replace(/SECRET\w+/g,'[redacted]')}),
  turnEnd:({text})=>ends++===0?{continue:'Add the date to your report.'}:null
 });
 const s=await f.rt.spawn(null,{task:'try things'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});
 assert.match(done.result,/A plugin refused this call: destructive commands/);assert.match(done.result,/token=\[redacted\]/);assert.match(done.result,/\(dated\)$/);
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-plugins-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'house.mjs'),`export default {tools:[{name:'house_time',description:'Time in the house',parameters:{type:'object',properties:{}},run:async()=>'noon'}],hooks:{afterTool:({text})=>({text:text+' (checked)'})}};`);
 const {ToolRegistry}=await import('../core/tools/registry.mjs');const reg=new ToolRegistry({pluginDir:dir});
 assert.deepEqual((await reg.loadPlugins()).hooks,1);assert.ok(reg.has('house_time'));assert.equal((await reg.hook('afterTool',{text:'x'})).text,'x (checked)');
});

test('screenshots past a handful clear in one batch, but only when that actually removes some',async t=>{
 const {rt}=await bare(t);const s=rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()});
 rt.sessions.append(s.id,'input',{text:'operate the screen',kind:'task',from:'user'});
 const shot={mime:'image/png',base64:PNG,width:1,height:1,name:'screen'};
 for(let i=0;i<9;i++)step(rt,s.id,i,'computer',{action:'screenshot'},'Screenshot',{ephemeralKey:'computer:browser',images:[shot]});
 const built=rt.assembler.build(s.id,{system:'sys'});
 assert.equal(built.messages.filter(m=>Array.isArray(m.content)).length,9,'superseded screenshots stay until a clear');
 const plan=rt.compactor.plan(built,100000,1);assert.equal(plan.action,'clear');rt.compactor.clear(s,plan.upTo);
 const after=rt.assembler.build(s.id,{system:'sys'});assert.ok(after.messages.filter(m=>Array.isArray(m.content)).length<=2,'only the newest screenshots remain');
 assert.equal(rt.compactor.plan(after,100000,1).action,'none','no clear while nothing more can be removed');
});

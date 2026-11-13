import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {decisionModel} from './helpers/decision-model.mjs';
import {toolResults} from './helpers/scripted-model.mjs';
import {splitSections,lexicalScores} from '../core/agent/decisions.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000,diagnostics=()=>({})){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out: '+JSON.stringify({elapsedMs:Date.now()-start,...diagnostics()}));await wait(15);}}
const PAGE=`<html><head><title>製品ページ</title></head><body><main><h1>製品ページ</h1>
<h2>概要</h2><p>${'この製品は家庭向けの静かな空気清浄機です。'.repeat(20)}</p>
<h2>価格</h2><p>標準モデルは税込29,800円、上位モデルは39,800円です。</p>
<h2>仕様</h2><p>${'重量4.2kg、消費電力40W、適用床面積30畳。'.repeat(15)}</p>
<h2>保証</h2><p>${'保証期間は購入日から2年間です。'.repeat(15)}</p>
<h2>よくある質問</h2><p>${'フィルターは半年ごとの交換を推奨します。'.repeat(15)}</p></main></body></html>`;
async function site(t){
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(PAGE);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 return `http://127.0.0.1:${server.address().port}/item`;
}

test('sections and keyword scores for question-focused reading',()=>{
 const parts=splitSections('# A\nalpha\n\n## B\n'+'beta '.repeat(1000)+'\n\n'+'gamma '.repeat(500));
 assert.ok(parts.length>=3);assert.ok(parts.every(p=>p.length<=2800));
 const s=lexicalScores('価格はいくら',['価格は29,800円','重量4.2kg']);assert.ok(s[0]>s[1]);
});

test('web_fetch with a question returns only the sections the decision model picks, word for word',async t=>{
 const url=await site(t);
 const d=await decisionModel((q,state,name)=>{const n=Number(name.slice(1));const sec=state.split(/\[Section \d+\]\n/)[n]||'';return /税込/.test(sec)?0.95:0.05;});t.after(d.close);
 const f=await agentFixture(t,()=>({content:'x'}),{decision:d.url});
 const s=f.rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()});
 const r=await f.rt.tools.get('web_fetch').run({url,question:'この製品の価格はいくら？'},f.rt.toolContext(s,new AbortController().signal));
 assert.match(r.text,/question-focused: 1 of \d+ sections, chosen by the decision model/);
 assert.match(r.text,/標準モデルは税込29,800円、上位モデルは39,800円です。/);assert.doesNotMatch(r.text,/フィルターは半年ごと/);
 assert.match(r.text,/Other sections: .*保証/);assert.ok(d.requests.length>=1);
 assert.ok(d.requests[0].body.state.startsWith('Question: この製品の価格はいくら？'));
});

test('without a decision model the same question falls back to keyword matching',async t=>{
 const url=await site(t);const f=await agentFixture(t,()=>({content:'x'}));
 const s=f.rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()});
 const r=await f.rt.tools.get('web_fetch').run({url,question:'保証期間'},f.rt.toolContext(s,new AbortController().signal));
 assert.match(r.text,/chosen by keyword match/);assert.match(r.text,/保証期間は購入日から2年間です。/);
});

// Exercise real tools and receipts without spending the completion deadline on cold shell startup.
// Dedicated exec/process coverage lives in agent-tools.test.mjs.
const worker=(final,steps=3)=>body=>{const n=toolResults(body).length;if(n<steps)return {calls:[{name:'write',args:{path:`step${n}.txt`,content:`step${n}`}}]};return {content:final(body)};};
async function assertSteps(f,session,count=3){
 const receipts=f.rt.sessions.entries(session.id,{types:['tool']});
 assert.deepEqual(receipts.map(({name,args,error})=>({name,args,error})),Array.from({length:count},(_,n)=>({name:'write',args:{path:`step${n}.txt`,content:`step${n}`},error:false})));
 for(let n=0;n<count;n++)assert.equal(await readFile(path.join(session.cwd,`step${n}.txt`),'utf8'),`step${n}`);
 return receipts;
}

test('completion check: the decision model sends an incomplete report back to work, once',async t=>{
 const start=Date.now(),stages={model:[],decision:[]};
 let verdict=0.1;const d=await decisionModel(()=>{stages.decision.push(Date.now()-start);return verdict;});t.after(d.close);
 const respond=worker(body=>body.messages.at(-1).content?.includes?.('check the result against the task')?'全部終わりました（確認済み）':'途中まで');
 const f=await agentFixture(t,body=>{stages.model.push(Date.now()-start);return respond(body);},{decision:d.url});
 const diagnostics=id=>()=>({session:f.rt.sessions.get(id),modelRequests:f.model.requests.length,decisionRequests:d.requests.length,stageElapsedMs:stages,
  lastEntries:f.rt.sessions.tail(id,8).map(e=>({...e,text:String(e.text||'').slice(0,1200)})),lastEvents:f.events.slice(-8)});
 const s=await f.rt.spawn(null,{task:'三つの手順を実行して確認する'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;},8000,diagnostics(s.id));
 assert.equal(done.result,'全部終わりました（確認済み）');
 const receipts=await assertSteps(f,s);
 const notices=f.rt.sessions.entries(s.id,{types:['notice']}).filter(n=>/check the result against the task/.test(n.text));
 assert.equal(notices.length,1);assert.match(notices[0].text,/三つの手順を実行して確認する/);
 const asked=d.requests.find(r=>/every part of the task/.test(r.body.questions.q.instructions))?.body;
 assert.ok(asked);const state=JSON.parse(asked.state);
 assert.match(state.actions,/^(ok|FAILED): /m,'the tool results go with the report, so a claim is judged against evidence');
 assert.deepEqual(state.actions.split('\n'),receipts.map(e=>`ok: ${e.stub}`),'all three completed steps reach the decision model');
 verdict=0.9;const s2=await f.rt.spawn(null,{task:'もう一つ'});
 const done2=await until(()=>{const x=f.rt.sessions.get(s2.id);return x.status==='done'&&x;},8000,diagnostics(s2.id));
 assert.equal(done2.result,'途中まで','a confident verdict lets the report through');
 await assertSteps(f,s2);
});

test('with a decision model, even a one-call task is checked; a report claiming what failed is sent back',async t=>{
 const d=await decisionModel((q,state)=>/FAILED/.test(JSON.parse(state).actions)?0.05:0.95);t.after(d.close);
 const f=await agentFixture(t,body=>{
  const r=toolResults(body),sent=body.messages.some(m=>String(m.content).includes('check the result against the task'));
  if(!r.length)return {calls:[{name:'read',args:{path:'missing.txt'}}]};
  return {content:sent?'読めませんでした（ファイルがありません）':'読みました'};
 },{decision:d.url});
 const s=await f.rt.spawn(null,{task:'missing.txt を読む'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});
 assert.equal(done.result,'読めませんでした（ファイルがありません）');
});

test('completion check without a decision model: one self-check turn for substantial work, none for quick tasks',async t=>{
 const f=await agentFixture(t,worker(body=>body.messages.at(-1).content?.includes?.('check the result against the task')?'確認しました':'できました'));
 const s=await f.rt.spawn(null,{task:'作業する'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});assert.equal(done.result,'確認しました');
 await assertSteps(f,s);
 const quick=await agentFixture(t,worker(()=>'了解',1));
 const q=await quick.rt.spawn(null,{task:'すぐ終わる'});
 const qd=await until(()=>{const x=quick.rt.sessions.get(q.id);return x.status==='done'&&x;});assert.equal(qd.result,'了解');
 await assertSteps(quick,q,1);
 assert.equal(quick.rt.sessions.entries(q.id,{types:['notice']}).filter(n=>/against the task/.test(n.text)).length,0);
});

test('check-ins: the decision model filters changes nobody needs to hear about',async t=>{
 let need=0.05;const d=await decisionModel(()=>need);t.after(d.close);
 const f=await agentFixture(t,()=>({content:'NO_REPLY'}),{decision:d.url,settings:{heartbeat:{enabled:true,minutes:60}}});
 const main=f.rt.main(),w=f.rt.sessions.create({kind:'worker',title:'調査',parentId:main.id,cwd:os.tmpdir()});
 f.rt.sessions.update(w.id,{status:'running'});
 assert.equal(await f.rt.heartbeat(),false,'plain progress: no model call');
 need=0.9;f.rt.sessions.update(w.id,{status:'done',result:'ok'});
 assert.equal(await f.rt.heartbeat(),true);
});

// Decision providers: one internal shape (System One), three wire formats, the same cases as the Rust service.
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {Capabilities} from '../core/capabilities.mjs';
import {Decisions} from '../core/agent/decisions.mjs';
import {ComputerUse} from '../core/computer/index.mjs';
import {INSTRUCTIONS} from '../core/computer/decide.mjs';
import {DEFAULT_SETTINGS,validateSettings} from '../core/policy.mjs';
import {decisionProtocol} from '../web/capability-ui.mjs';
const WIRE=JSON.parse(await readFile(new URL('../native-service/src/capabilities/fixtures/decision-wire.json',import.meta.url),'utf8'));
async function decisionCapability(t,protocol,baseUrl,model='fixture-model'){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-decision-'));const store=new Store(dir),caps=new Capabilities(store,new NetworkPolicy(store));
 t.after(async()=>{caps.close();store.close();await rm(dir,{recursive:true,force:true});});
 caps.save({profiles:[{id:'d',name:'decision',protocol,baseUrl,model,domain:'device'}],routes:{decision:'d'}},0);
 caps.setKey('d','fixture-key',caps.get().profiles[0].identity);
 return caps;
}
for(const c of WIRE.cases)test('decision wire: '+c.name,async t=>{
 const seen=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;seen.push({path:req.url,headers:req.headers,body:JSON.parse(raw)});
  res.writeHead(c.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(c.response));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const caps=await decisionCapability(t,c.protocol,`http://127.0.0.1:${server.address().port}${c.basePath}`,c.model);
 const run=caps.decide(c.state,c.questions);
 if(c.expectError){
  await assert.rejects(run,e=>e.status===c.expectError.status&&!!e.refused===c.expectError.refused&&(!c.expectError.message||e.message===c.expectError.message)&&(!c.expectError.upstreamStatus||e.upstreamStatus===c.expectError.upstreamStatus));
 } else {
  const r=await run;assert.equal(r.model,c.expectModel);assert.equal(JSON.stringify(r.answers),JSON.stringify(c.expectAnswers));assert.equal(r.advisory,true);
 }
 if(!c.expectRequest){assert.equal(seen.length,0,'rejected before sending');return;}
 assert.equal(seen.length,1);assert.equal(seen[0].path,c.expectRequest.path);
 for(const [k,v] of Object.entries(c.expectRequest.headers))assert.equal(seen[0].headers[k],v);
 for(const k of c.expectRequest.absentHeaders||[])assert.equal(seen[0].headers[k],undefined);
 assert.equal(JSON.stringify(seen[0].body),JSON.stringify(c.expectRequest.body));
});
for(const protocol of ['system-one','openai-decisions','gemini-decisions'])test(`decisions through ${protocol}: yes, relevance and a computer choice agree`,async t=>{
 const d=await decisionModel((q,state,name)=>q.type==='choice'?'click_e2':name==='q'?0.8:/税込/.test(state.split(/\[Section \d+\]\n/)[Number(name.slice(1))]||'')?0.95:0.05,{protocol});t.after(d.close);
 const decisions=new Decisions(await decisionCapability(t,protocol,protocol==='gemini-decisions'?d.url+'beta':d.url));
 assert.equal(await decisions.yes('state','Is it done?'),0.8);
 const rel=await decisions.relevance('価格は？',['重量4.2kg','標準モデルは税込29,800円','保証は2年']);
 assert.equal(rel.method,'decision');assert.deepEqual(rel.scores,[0.05,0.95,0.05]);
 const choose=ComputerUse.prototype.chooser.call({decisions,registry:null},{kind:'worker'});
 const pick=await choose({goal:'send'},{click_e1:'click link "Help"',click_e2:'click button "Send"',done:'done'});
 assert.equal(pick.choice,'click_e2');assert.equal(pick.method,'decision model');assert.equal(pick.probabilities.click_e2,0.9);
 const sent=d.requests.at(-1);
 assert.equal(sent.path,protocol==='system-one'?'/v1/systemone':protocol==='gemini-decisions'?'/v1beta/decisions':'/v1/decisions');
 if(protocol==='gemini-decisions'){assert.equal(sent.headers['x-goog-api-key'],'fixture-key');assert.equal(sent.headers.authorization,undefined);}
 else assert.equal(sent.headers.authorization,'Bearer fixture-key');
 if(protocol==='openai-decisions')assert.equal(sent.body.questions[0].instructions,INSTRUCTIONS);
 assert.equal(decisions.failures,0);
});
for(const protocol of ['openai-decisions','gemini-decisions'])test(`a ${protocol} refusal falls back and is not counted as a failure`,async t=>{
 const d=await decisionModel(()=>0.9,{protocol,refuse:true});t.after(d.close);
 const decisions=new Decisions(await decisionCapability(t,protocol,protocol==='gemini-decisions'?d.url+'beta':d.url));
 for(let i=0;i<4;i++)assert.equal(await decisions.yes('state','Is it done?'),null);
 assert.equal(d.requests.length,4,'refusals are not retried');assert.equal(decisions.failures,0);assert.ok(decisions.available());
});
test('a busy decision service (429, TypeSafe 529) is asked again',async t=>{
 const statuses=[429,529];let calls=0;
 const server=http.createServer(async(req,res)=>{for await(const _ of req);calls++;const status=statuses.shift();res.writeHead(status||200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(status?{error:'busy'}:{answers:{q:{type:'noul',noul:0.7}}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const decisions=new Decisions(await decisionCapability(t,'system-one',`http://127.0.0.1:${server.address().port}/v1`));
 assert.equal(await decisions.yes('state','Is it done?'),0.7);assert.equal(calls,3);assert.equal(decisions.failures,0);
});
test('the decision format follows the endpoint host; the old decisionUrl setting is gone',()=>{
 assert.equal(decisionProtocol('https://generativelanguage.googleapis.com/v1beta'),'gemini-decisions');
 assert.equal(decisionProtocol('https://api.openai.com/v1'),'openai-decisions');
 assert.equal(decisionProtocol('https://ai-gateway.vercel.sh/v1'),'openai-decisions');
 for(const url of ['https://api.typesafe.ai/v1','https://api.liquid.ai/decisions/v1','https://api.perplexity.ai/v1/decisions','http://127.0.0.1:8767/v1','not a url'])assert.equal(decisionProtocol(url),'system-one');
 for(const key of ['decisionUrl','decisionModel'])assert.equal(key in DEFAULT_SETTINGS,false);
 const saved=validateSettings({decisionUrl:'http://127.0.0.1:8767/v1/systemone',decisionModel:'multilingual'},DEFAULT_SETTINGS);
 assert.equal('decisionUrl' in saved,false);assert.equal('decisionModel' in saved,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {decisionModel} from './helpers/decision-model.mjs';
import {toolResults} from './helpers/scripted-model.mjs';
import {splitSections,lexicalScores} from '../core/agent/decisions.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
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
 assert.ok(d.requests[0].state.startsWith('Question: この製品の価格はいくら？'));
});

test('without a decision model the same question falls back to keyword matching',async t=>{
 const url=await site(t);const f=await agentFixture(t,()=>({content:'x'}));
 const s=f.rt.sessions.create({kind:'worker',title:'w',cwd:os.tmpdir()});
 const r=await f.rt.tools.get('web_fetch').run({url,question:'保証期間'},f.rt.toolContext(s,new AbortController().signal));
 assert.match(r.text,/chosen by keyword match/);assert.match(r.text,/保証期間は購入日から2年間です。/);
});

const worker=(final)=>body=>{const n=toolResults(body).length;if(n<3)return {calls:[{name:'exec',args:{command:`echo step${n}`}}]};return {content:final(body)};};

test('completion check: the decision model sends an incomplete report back to work, once',async t=>{
 let verdict=0.1;const d=await decisionModel(()=>verdict);t.after(d.close);
 const f=await agentFixture(t,worker(body=>body.messages.at(-1).content?.includes?.('check the result against the task')?'全部終わりました（確認済み）':'途中まで'),{decision:d.url});
 const s=await f.rt.spawn(null,{task:'三つの手順を実行して確認する'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});
 assert.equal(done.result,'全部終わりました（確認済み）');
 const notices=f.rt.sessions.entries(s.id,{types:['notice']}).filter(n=>/check the result against the task/.test(n.text));
 assert.equal(notices.length,1);assert.match(notices[0].text,/三つの手順を実行して確認する/);
 assert.ok(d.requests.some(r=>/every part of the task/.test(r.questions.q.instructions)));
 verdict=0.9;const s2=await f.rt.spawn(null,{task:'もう一つ'});
 const done2=await until(()=>{const x=f.rt.sessions.get(s2.id);return x.status==='done'&&x;});
 assert.equal(done2.result,'途中まで','a confident verdict lets the report through');
});

test('completion check without a decision model: one self-check turn for substantial work, none for quick tasks',async t=>{
 const f=await agentFixture(t,worker(body=>body.messages.at(-1).content?.includes?.('check the result against the task')?'確認しました':'できました'));
 const s=await f.rt.spawn(null,{task:'作業する'});
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});assert.equal(done.result,'確認しました');
 const quick=await agentFixture(t,body=>toolResults(body).length?{content:'了解'}:{calls:[{name:'exec',args:{command:'true'}}]});
 const q=await quick.rt.spawn(null,{task:'すぐ終わる'});
 const qd=await until(()=>{const x=quick.rt.sessions.get(q.id);return x.status==='done'&&x;});assert.equal(qd.result,'了解');
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

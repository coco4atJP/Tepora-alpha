import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {decisionModel} from './helpers/decision-model.mjs';
import {toolResults} from './helpers/scripted-model.mjs';
import {bestThreshold,looCost,QUESTIONS,POLICY_DEFAULTS,DREAM} from '../core/agent/dream.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
/** Labelled completion episodes: complete reports score `hi`, incomplete ones `lo`. */
function seed(rt,{n=12,hi=0.7,lo=0.3,question='c0',threshold=0.5,state=i=>JSON.stringify({task:'t'+i,report:i%2?'complete':'partial'})}={}){
 const s=rt.sessions.create({kind:'worker',title:'history'});
 for(let i=0;i<n;i++){const complete=i%2===1,p=complete?hi:lo;
  const ref=rt.dreamer.record(s.id,'completion',{question,p,threshold,action:p>=threshold?1:0,state:state(i)});
  rt.dreamer.label(s.id,ref,complete?1:0,'eval');}
 return s;
}

test('threshold search: cheapest threshold, ties toward the current one; leave-one-out never grades on fitted data',()=>{
 const eps=[{p:0.2,label:0},{p:0.3,label:0},{p:0.62,label:1},{p:0.7,label:1},{p:0.9,label:1},{p:0.65,label:0}];
 const b=bestThreshold('completion',eps,0.5);assert.equal(b.threshold,0.7);assert.equal(b.cost,1,'one complete report sent back, nothing incomplete accepted');
 assert.equal(bestThreshold('completion',[{p:0.9,label:1},{p:0.1,label:0}],0.5).threshold,0.5,'any threshold between works: keep the current one');
 assert.ok(looCost('completion',eps,0.5)>=b.cost);
 assert.ok(Object.keys(QUESTIONS.route).length>=2&&Object.keys(QUESTIONS.completion).length>=2);
});

test('dreaming moves a threshold toward what the record supports, in a bounded step, and can be reverted',async t=>{
 const f=await agentFixture(t,()=>({content:'x'}));const d=f.rt.dreamer;
 assert.deepEqual(d.policy().completion,POLICY_DEFAULTS.completion);
 // Incomplete reports score 0.55 under the current question: at 0.5 they all pass. 0.6 separates them.
 seed(f.rt,{n:12,hi:0.8,lo:0.55});
 const r=await d.dream({replay:false});
 assert.equal(r.adopted,true,JSON.stringify(r));
 const c=r.changes.find(x=>x.kind==='completion');assert.equal(c.field,'threshold');assert.equal(c.from,0.5);
 assert.ok(c.to>0.55&&c.to<=0.5+DREAM.maxStep+1e-9,`bounded step: ${c.to}`);
 assert.equal(d.policy().completion.threshold,c.to);assert.equal(d.policy().revision,1);
 assert.equal(d.question('completion').threshold,c.to,'the next check uses the new threshold');
 assert.match(d.policy().because,/completion threshold 0.5→/);
 const back=d.revert();assert.equal(back.completion.threshold,0.5);assert.equal(d.policy().completion.threshold,0.5);
 assert.ok(d.status().last.at);
});

test('no change without enough evidence of both kinds',async t=>{
 const f=await agentFixture(t,()=>({content:'x'}));
 const s=f.rt.sessions.create({kind:'worker',title:'few'});
 for(let i=0;i<20;i++){const ref=f.rt.dreamer.record(s.id,'completion',{question:'c0',p:0.9,threshold:0.5,action:1,state:'{}'});f.rt.dreamer.label(s.id,ref,1,'eval');}
 const r=await f.rt.dreamer.dream({replay:false});
 assert.equal(r.adopted,false);assert.match(r.notes.join(' '),/20 labelled episodes \(20 positive, 0 negative\)/);
 assert.equal(f.rt.dreamer.policy().revision,0);
});

test('replay: an alternative question that separates the recorded cases better is adopted with its own threshold',async t=>{
 // The decision model: the current question cannot tell the reports apart; c1 can.
 const dm=await decisionModel((q,state)=>{
  const complete=/"report":"complete"/.test(state);
  if(q.instructions===QUESTIONS.completion.c1.text)return complete?0.9:0.1;
  if(q.instructions===QUESTIONS.completion.c2.text)return complete?0.4:0.6; // inverted, and weak
  return 0.6;
 });t.after(dm.close);
 const f=await agentFixture(t,()=>({content:'x'}),{decision:dm.url});
 seed(f.rt,{n:12,hi:0.6,lo:0.6});
 const r=await f.rt.dreamer.dream({replay:true});
 assert.equal(r.adopted,true,JSON.stringify(r.notes));
 const c=r.changes[0];assert.equal(c.kind,'completion');assert.equal(c.field,'question');assert.equal(c.to,'c1');
 assert.ok(r.replayed.completion.c1.looCost<r.replayed.completion.c0.looCost);
 const q=f.rt.dreamer.question('completion');assert.equal(q.id,'c1');assert.ok(q.threshold>0.1&&q.threshold<=0.9);
});

test('live episodes: the completion check records what it saw, and a sent-back report that was then fixed is labelled incomplete',async t=>{
 const dm=await decisionModel(()=>0.1);t.after(dm.close);
 const f=await agentFixture(t,body=>{
  const r=toolResults(body),sent=body.messages.some(m=>String(m.content).includes('check the result against the task'));
  if(!r.length)return {calls:[{name:'write',args:{path:'a.txt',content:'1'}}]};
  if(sent&&r.length===1)return {calls:[{name:'edit',args:{path:'a.txt',old_string:'1',new_string:'2'}}]};
  return {content:'a.txt を書きました'};
 },{decision:dm.url});
 const s=await f.rt.spawn(null,{task:'a.txt に 2 と書く'});
 await until(()=>f.rt.sessions.get(s.id).status==='done');
 const eps=f.rt.dreamer.episodes().filter(e=>e.sessionId===s.id);
 assert.equal(eps.length,1);const e=eps[0];
 assert.equal(e.kind,'completion');assert.equal(e.question,'c0');assert.equal(e.action,0);assert.equal(e.p,0.1);
 assert.match(e.state,/"task":"a.txt に 2 と書く"/);assert.match(e.state,/"actions":"ok: write/);
 assert.equal(e.label,0,'the report was incomplete: it was changed after being sent back');assert.equal(e.source,'outcome');
 f.rt.dreamer.labelSession(s.id,{final:1,source:'eval'});
 assert.equal(f.rt.dreamer.episodes().find(x=>x.seq===e.seq).label,0,'a change after the sendback still says the checked report was incomplete');
});

test('live episodes: the delegation safety net records each user turn and learns from the worker\'s outcome',async t=>{
 const dm=await decisionModel((q,state)=>/memo/.test(state)?0.95:0.05);t.after(dm.close);
 const f=await agentFixture(t,body=>{
  const sys=String(body.messages[0].content);
  if(sys.includes('work agent inside Tepora'))return toolResults(body).length?{content:'memo.txt を作りました'}:{calls:[{name:'write',args:{path:'memo.txt',content:'x'}}]};
  const said=String(body.messages.at(-1).content);
  if(said.includes('The harness started a work agent'))return {content:'始めました'};
  if(said.includes('report from'))return {content:'NO_REPLY'};
  return {content:said.includes('memo')?'作れません':'こんにちは'};
 },{decision:dm.url});
 const main=f.rt.main();
 f.rt.send(main.id,{text:'こんにちは'});
 await until(()=>f.events.find(e=>e.type==='agent.reply'&&e.data.text==='こんにちは'));
 f.rt.send(main.id,{text:'memo を書いて'});
 await until(()=>f.rt.sessions.list({kind:'worker'}).find(w=>w.status==='done'));
 const eps=await until(()=>{const x=f.rt.dreamer.episodes().filter(e=>e.kind==='route');return x.length===2&&x.every(e=>e.label!==null)&&x;});
 assert.deepEqual(eps.map(e=>[e.action,e.label,e.source]),[[0,0,'answered'],[1,1,'delegated-outcome']]);
 assert.ok(eps.every(e=>e.question==='r0'&&e.state.includes('"message"')));
});

test('a busy free tier (HTTP 429) is waited out and asked again, not counted as a failure',async t=>{
 const http=await import('node:http');let n=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;n++;
  if(n===1){res.writeHead(429,{'Content-Type':'application/json'});return res.end('{"error":{"code":"model_rate_limit_exceeded"}}');}
  const body=JSON.parse(raw);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({model:body.model,answers:{q:{type:'noul',noul:0.8}}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const f=await agentFixture(t,()=>({content:'x'}),{decision:`http://127.0.0.1:${server.address().port}/v1`});
 const p=await f.rt.decisions.yes('{}','Is it?');
 assert.equal(p,0.8);assert.equal(n,2);assert.equal(f.rt.decisions.failures,0);
});

/** Optional model-free scheduling bridge benchmark.
 * source /workspace/.tepora-cloud/env.sh && npm run build:core
 * node tests/bench-runtime-facts.mjs [iterations=60] [--with-store]
 * Synthetic foreground + worker transcripts; no network or providers.
 * --with-store adds temporary Rust SQLite reads and deletes only that fixture.
 */
import {performance} from 'node:perf_hooks';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RuntimeHost} from '../core/agent/runtime-host.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';
import {Store} from '../core/store.mjs';
import {budgetCost} from '../core/model-usage.mjs';

const iterations=Math.max(10,Number(process.argv[2])||60);
function fixture(workers){
 const clock=()=>1792230000000,body='合成ツールの結果です。'.repeat(800),prompt='Synthetic cached system prompt. '.repeat(250);
 const sessions=Array.from({length:workers+1},(_,i)=>({id:i?'worker-'+i:'main',kind:i?'worker':'main',status:'running',role:i?'work':'chat',toolset:i?'worker':'main',stats:{steps:12,cost:0},system:prompt,tools:['read','write','sessions_send']}));
 const tails=new Map(sessions.map(session=>[session.id,Array.from({length:12},(_,i)=>({seq:i+1,type:i%3===0?'input':i%3===1?'assistant':'tool',at:'2026-10-17T09:00:00.000Z',...(i%3===0?{text:body,passive:i===0}:i%3===1?{content:body,toolCalls:i===10?[{id:'c',name:'read',arguments:'{"path":"synthetic.txt"}'}]:[],truncated:false}:{content:body,name:'read',callId:'c',error:false,keep:true})}))]));
 const inbox=new Map(sessions.map(session=>[session.id,[{id:'message-'+session.id,text:body,from:'user',mode:'followup',kind:'message',at:'2026-10-17T09:00:00.000Z'}]]));
 const rt={clock,settings:()=>({concurrency:8,budget:{},idleCompactSeconds:20}),store:{value:()=>null},decisions:{available:()=>false},tools:{hooks:[]},sessions:{list:()=>sessions,tail:id=>tails.get(id),pending:id=>inbox.get(id)}};
 return {rt,tails,inbox};
}
function legacyFacts(rt){const nowMs=rt.clock(),day=new Date(nowMs).toISOString().slice(0,10);return {nowMs,settings:rt.settings(),dailyCost:budgetCost(rt.store.value('agent-usage:'+day)?.cost||0,rt.store.value('model-usage:'+day)),decisionAvailable:rt.decisions.available(),hasHooks:!!rt.tools.hooks.length,sessions:rt.sessions.list().map(session=>{const tail=rt.sessions.tail(session.id,12);return {session,tail,pending:rt.sessions.pending(session.id),lastAtMs:Date.parse(tail.at(-1)?.at)||0};})};}
const percentile=(samples,p)=>[...samples].sort((a,b)=>a-b)[Math.min(samples.length-1,Math.floor(samples.length*p))];
const rows=[];
const scenarios=[{workers:8,storage:'memory'},{workers:32,storage:'memory'},...(process.argv.includes('--with-store')?[{workers:8,storage:'native-sqlite'}]:[])];
for(const {workers,storage} of scenarios){
 const {rt,tails,inbox}=fixture(workers);let dir,store;
 try{
 if(storage==='native-sqlite'){
  dir=await mkdtemp(path.join(os.tmpdir(),'tepora-runtime-facts-bench-'));store=new Store(dir);const persisted=new SessionStore(store);
  for(const session of rt.sessions.list()){
   persisted.create({...session,extra:session});for(const {type,...body} of tails.get(session.id))persisted.append(session.id,type,body);for(const item of inbox.get(session.id))persisted.enqueue(session.id,item);
  }
  rt.store=store;rt.sessions=persisted;
 }
 const before=new RuntimeHost(rt),after=new RuntimeHost(rt);before.facts=()=>legacyFacts(rt);
 const event={type:'markVerified',sessionId:'main'},beforeBytes=Buffer.byteLength(JSON.stringify(before.facts())),afterBytes=Buffer.byteLength(JSON.stringify(after.facts()));
 for(let i=0;i<5;i++){before.dispatch(event);after.dispatch(event);}
 const samples={before:[],after:[]},cpu={before:0,after:0};
 for(let i=0;i<iterations;i++)for(const name of i%2?['after','before']:['before','after']){
  const host=name==='before'?before:after,startCpu=process.cpuUsage(),started=performance.now();host.dispatch(event);samples[name].push(performance.now()-started);const used=process.cpuUsage(startCpu);cpu[name]+=used.user+used.system;
 }
 rows.push({workers,foregroundSessions:1,iterations,storage,includesDatabaseReads:storage==='native-sqlite',payloadBytes:{before:beforeBytes,after:afterBytes,reductionPercent:+((1-afterBytes/beforeBytes)*100).toFixed(2)},dispatchMs:{beforeMedian:+percentile(samples.before,.5).toFixed(3),afterMedian:+percentile(samples.after,.5).toFixed(3),beforeP95:+percentile(samples.before,.95).toFixed(3),afterP95:+percentile(samples.after,.95).toFixed(3)},cpuMsPerDispatch:{before:+(cpu.before/iterations/1000).toFixed(3),after:+(cpu.after/iterations/1000).toFixed(3)}});
 }finally{store?.close();if(dir)await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({node:process.version,platform:process.platform,architecture:process.arch,synthetic:true,includesModelLatency:false,rows},null,2));

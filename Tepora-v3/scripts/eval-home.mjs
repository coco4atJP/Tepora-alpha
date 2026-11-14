#!/usr/bin/env node
/** Home-assistant evaluation without real models. Replays the days in evals/home-days.json against the Node host and
 * the Rust host through their real HTTP routes: synthetic utterance audio → /api/voice/transcribe → /api/agent/input
 * → reply → speech job. A scripted model, a fake transcriber and a fake speech engine answer on loopback; each charges
 * the scenario's simulated cost, so wake→first-audio is deterministic and grows with every extra round a host makes.
 * The host restarts between days (cross-day memory; recall turns also note whether the fact was already in the
 * model's context), a barge-in stops a reply mid-stream, and quiet time between days
 * counts unsolicited model calls or messages. The Node host is the oracle: any difference from it fails the run.
 * Mechanisms only, never model quality. Wake detection is simulated (its cost is charged, no detector runs).
 *
 *   node scripts/eval-home.mjs [--hosts node,native] [--out DIR]
 */
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../core/server.mjs';
import {invariant} from '../core/policy.mjs';
import {validateScenario,utteranceAudio,digest,sttCost,llmCost,summarize,compare} from './home-scenario.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),get=k=>{const i=args.lastIndexOf(k);return i<0?undefined:args[i+1];};
const hosts=(get('--hosts')||'node,native').split(',');invariant(hosts.length&&hosts.every(h=>['node','native'].includes(h)),'--hosts takes node and/or native');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const scenario=validateScenario(JSON.parse(await readFile(path.join(root,'evals/home-days.json'),'utf8'))),costs=scenario.costs;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(label,read,ms=15000){const end=Date.now()+ms;for(;;){const v=await read();if(v)return v;invariant(Date.now()<end,`Timed out: ${label}`);await pause(20);}}
const textOf=c=>typeof c==='string'?c:Array.isArray(c)?c.map(p=>p?.text||'').join(''):'';
const SPEECH=utteranceAudio({id:'speech',seconds:0.3});

/** One loopback server plays every model: chat completions (scripted per turn), transcriptions and speech. */
async function fakes(){
 const byDigest=new Map(),f={sim:0,turn:null,unsolicited:0,byDigest};
 const charge=(kind,ms)=>{if(!f.turn){f.unsolicited++;return;}f.turn.calls[kind]++;f.sim+=ms;};
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);
  const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/props')return json({default_generation_settings:{n_ctx:32768},total_slots:2});
  if(req.url==='/v1/audio/transcriptions'){
   const at=raw.indexOf('RIFF'),hit=at<0?null:byDigest.get(digest(raw.subarray(at,at+8+raw.readUInt32LE(at+4))));
   charge('stt',hit?sttCost(costs,hit.seconds):0);return json({text:hit?.say||''});
  }
  if(req.url==='/v1/audio/speech'){charge('tts',costs.ttsFirstAudio);res.writeHead(200,{'Content-Type':'audio/wav'});return res.end(SPEECH);}
  if(req.url!=='/v1/chat/completions')return json({error:{message:'unknown fixture endpoint'}},404);
  const body=JSON.parse(raw.toString()||'{}'),turn=f.turn,t=turn?.current;
  let content='',calls=[],hold=false;
  if(t){
   const messages=body.messages||[],at=messages.findLastIndex(m=>m.role==='user'&&textOf(m.content).includes(t.say));
   const tools=at<0?'':messages.slice(at+1).filter(m=>m.role==='tool').map(m=>textOf(m.content)).join('\n');
   if(at<0){turn.heard=false;content='聞き取れませんでした。';}
   else if(!tools&&t.remember)calls=[{name:'memory_write',args:{content:t.remember}}];
   else if(!tools&&t.recall){calls=[{name:'memory_search',args:{query:t.recall.query}}];turn.inContext=messages.some((m,i)=>i!==at&&textOf(m.content).includes(t.recall.expect));}
   else if(!tools&&t.interruptedBy&&!turn.held){hold=true;content=t.reply;}
   else content=t.recall&&!tools.includes(t.recall.expect)?'思い出せませんでした。':t.reply;
  }
  charge('llm',llmCost(costs,content));
  const finish=calls.length?'tool_calls':'stop',toolCalls=calls.map((c,i)=>({index:i,id:`home_${Date.now()}_${i}`,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}));
  if(body.stream===false&&!hold)return json({choices:[{message:{role:'assistant',content:content||null,...(calls.length?{tool_calls:toolCalls}:{})},finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:10}});
  res.writeHead(200,{'Content-Type':'text/event-stream'});const send=o=>res.write(`data: ${JSON.stringify(o)}\n\n`);
  if(hold){
   // Speak a little of the long reply, then keep the stream open until the host aborts it (barge-in).
   const held={closed:false};res.once('close',()=>{held.closed=true;});send({choices:[{delta:{content:[...content].slice(0,12).join('')}}]});turn.held=held;return;
  }
  if(content)send({choices:[{delta:{content}}]});
  for(const c of toolCalls)send({choices:[{delta:{tool_calls:[c]}}]});
  send({choices:[{delta:{},finish_reason:finish}]});send({choices:[],usage:{prompt_tokens:100,completion_tokens:10}});res.end('data: [DONE]\n\n');
 });
 const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 f.origin=`http://127.0.0.1:${server.address().port}`;
 f.close=async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));};
 return f;
}

async function client(launchUrl,close){
 const launch=await fetch(launchUrl,{redirect:'manual'});invariant(launch.status===303,`launch ${launch.status}`);
 const cookie=launch.headers.get('set-cookie').split(';')[0],origin=new URL(launchUrl).origin;
 const boot=await(await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',body,headers={})=>fetch(origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':boot.csrf,...(Buffer.isBuffer(body)?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const json=async(route,method,body,status=200)=>{const r=await request(route,method,body);const v=await r.json();invariant(r.status===status,`${method||'GET'} ${route} ${r.status}: ${JSON.stringify(v)}`);return v;};
 return {request,json,close};
}
async function start(host,data,dir){
 if(host==='node'){const app=await startServer({dir:data});return client(app.launchUrl,()=>app.close());}
 const empty=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');await mkdir(empty,{recursive:true});await writeFile(bundle,'// home evaluation\n');
 const child=spawn(binary,['--dev-native','--agent','--sidecar','--port','0','--data-dir',data,'--web-dir',path.join(root,'web'),'--bundle',bundle],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:empty,HOME:dir,USERPROFILE:dir,TMPDIR:dir,TEMP:dir,TMP:dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
 let stderr='';child.stderr.on('data',v=>{stderr=(stderr+v).slice(-20000);});child.stdin.on('error',()=>{});
 const exited=new Promise(r=>{child.once('error',e=>r({error:e}));child.once('exit',code=>r({code}));}),lines=createInterface({input:child.stdout});
 const ready=await Promise.race([new Promise((resolve,reject)=>lines.once('line',l=>{try{resolve(JSON.parse(l));}catch(e){reject(e);}})),exited.then(e=>{throw new Error(`Native host exited before ready: ${e.error?.message||e.code} ${stderr}`);})]);
 return client(ready.url,async()=>{child.stdin.write('shutdown\n');const timer=setTimeout(()=>child.kill('SIGKILL'),15000);try{const e=await exited;invariant(e.code===0,`Native host shutdown ${e.code}: ${stderr}`);}finally{clearTimeout(timer);lines.close();}});
}
async function configure(c,f){
 const providers=await c.json('/api/providers'),model={id:'home-model',protocol:'chat-completions',baseUrl:f.origin+'/v1',domain:'device',model:'home-scripted',contextTokens:32768,capabilities:{text:true,tools:true}};
 await c.json('/api/providers','PUT',{expectedRevision:providers.revision,config:{profiles:[model],routes:{main:{primary:model.id,fallbacks:[]}}}});
 const caps=await c.json('/api/capabilities');
 await c.json('/api/capabilities','PUT',{expectedRevision:caps.revision,config:{profiles:[
  {id:'home-stt',name:'Home fake transcriber',protocol:'openai-transcriptions',baseUrl:f.origin+'/v1',domain:'device',model:'home-asr',enabled:true},
  {id:'home-tts',name:'Home fake speech',protocol:'openai-speech',baseUrl:f.origin+'/v1',domain:'device',model:'home-tts',voice:'home',audioFormat:'wav',enabled:true}],routes:{stt:'home-stt',tts:'home-tts'}}});
}
async function identities(c){const caps=await c.json('/api/capabilities'),id=role=>caps.profiles.find(p=>p.id===`home-${role}`).identity;return {stt:id('stt'),tts:id('tts')};}
const replies=async c=>(await c.json('/api/agent/dialogue')).messages.filter(m=>m.role==='character'||m.role==='assistant').map(m=>m.content);

/** One spoken exchange: wake → transcribe → input → reply → speech. Returns the reply and the simulated latency. */
async function exchange(c,f,ids,t,host,{interrupt}={}){
 const from=f.sim;f.sim+=costs.wake;const turn=f.turn={current:t,calls:{stt:0,llm:0,tts:0},heard:true,held:null};
 const wav=utteranceAudio(t);f.byDigest.set(digest(wav),t);
 const heard=await c.request('/api/voice/transcribe','POST',wav,{'Content-Type':'audio/wav','X-Tepora-Audio-Profile':ids.stt});
 const said=heard.ok?(await heard.json()).text:'';if(said!==t.say)turn.heard=false;
 const before=(await replies(c)).length;
 await c.json('/api/agent/input','POST',{text:said||'(無音)',requestId:`home-${host}-${t.id}`},202);
 if(interrupt){const held=await until(`${t.id} reply streaming`,()=>turn.held);return {turn,held,before};}
 const reply=await until(`${t.id} reply`,async()=>(await replies(c)).slice(before).at(-1)).catch(()=>null);
 let audio=false;
 if(reply){
  const job=await c.json('/api/media/jobs','POST',{kind:'tts',prompt:reply,requestId:`home-speech-${host}-${t.id}`,profileIdentity:ids.tts,consent:true},202);
  audio=!!await until(`${t.id} speech`,async()=>(await c.json('/api/media/jobs')).jobs.find(j=>j.id===job.id&&j.status==='ready')).catch(()=>null);
 }
 f.turn=null;
 return {turn,reply,audio,wakeToAudioMs:audio?f.sim-from:null};
}

async function day(c,f,ids,turns,host,out){
 for(const t of turns){
  const wall=Date.now();
  if(!t.interruptedBy){
   const r=await exchange(c,f,ids,t,host),kind=t.recall?'recall':t.remember?'remember':'talk';
   out.push({id:t.id,kind,...(t.recall?{inContext:!!r.turn.inContext}:{}),heard:r.turn.heard,answered:r.reply===t.reply,audio:r.audio,modelCalls:r.turn.calls.llm,wakeToAudioMs:r.wakeToAudioMs,ok:r.turn.heard&&r.reply===t.reply&&r.audio,wallMs:Date.now()-wall});continue;
  }
  // Barge-in: the user speaks again while the long reply is still streaming; the client stops it, then talks.
  const cut=await exchange(c,f,ids,t,host,{interrupt:true});
  await c.json('/api/stop','POST',{});
  const aborted=!!await until(`${t.id} model stream aborted`,()=>cut.held.closed,5000).catch(()=>false);f.turn=null;
  const next=await exchange(c,f,ids,t.interruptedBy,host),stale=(await replies(c)).includes(t.reply);
  const ok=aborted&&!stale&&next.turn.heard&&next.reply===t.interruptedBy.reply&&next.audio;
  out.push({id:t.id,kind:'barge-in',aborted,staleReply:stale,heard:next.turn.heard,answered:next.reply===t.interruptedBy.reply,audio:next.audio,modelCalls:cut.turn.calls.llm+next.turn.calls.llm,wakeToAudioMs:next.wakeToAudioMs,ok,wallMs:Date.now()-wall});
 }
 // Quiet time: nothing was asked, so nothing should be said or computed.
 const quiet=(await replies(c)).length,before=f.unsolicited;await pause(400);
 return f.unsolicited-before+Math.max(0,(await replies(c)).length-quiet);
}

async function run(host,dir){
 if(host==='native')await access(binary).catch(()=>{throw new Error(`Build the native host first (node scripts/build-native.mjs): ${binary}`);});
 const f=await fakes(),data=path.join(dir,host),turns=[],started=Date.now();let unsolicited=0,c=null;
 try{
  for(const [i,d] of scenario.days.entries()){
   c=await start(host,data,dir);if(i===0)await configure(c,f);
   unsolicited+=await day(c,f,await identities(c),d.turns,host,turns);
   await c.close();c=null;
  }
 }finally{await c?.close().catch(()=>{});await f.close();}
 return {...summarize(host,turns,{unsolicited,budget:scenario.budget.wakeToAudioMs}),wallMs:Date.now()-started};
}

const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-home-eval-')),results=[];
try{for(const host of hosts)results.push(await run(host,dir));}finally{await rm(dir,{recursive:true,force:true}).catch(()=>{});}
const diff=results.length===2?compare(results[0],results[1]):[];
const report={scenario:'evals/home-days.json',realModel:false,audio:'synthetic waveforms with a fake transcriber',passed:results.every(r=>r.passed)&&diff.length===0,diff,results,finishedAt:new Date().toISOString()};
if(get('--out')){const out=path.resolve(get('--out'));await mkdir(out,{recursive:true});await writeFile(path.join(out,'home-evals.json'),JSON.stringify(report,null,2));}
for(const r of results){const m=r.metrics;console.log(`${r.host}: ${r.passed?'PASS':'FAIL'} turns ${m.ok}/${m.turns} · wake→audio p50 ${m.wakeToAudioMs.p50} max ${m.wakeToAudioMs.max} (budget ${m.wakeToAudioMs.budget}) · barge-in ${m.bargeIn.ok}/${m.bargeIn.tried} · recall ${m.recall.ok}/${m.recall.tried} · unsolicited ${m.proactive.unsolicited}`);
 for(const t of r.turns.filter(t=>!t.ok))console.log(`  ${t.id}: ${JSON.stringify(t)}`);}
for(const d of diff)console.log(`diff ${JSON.stringify(d)}`);
console.log(report.passed?'PASS':'FAIL');
process.exitCode=report.passed?0:1;

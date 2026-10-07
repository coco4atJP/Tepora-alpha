/** Agent → capability endpoints → files, end to end, with deterministic local fixtures (NOT learned models):
 * semantic memory search through an embedding endpoint, image and speech generation saved into the work folder,
 * and an artifact. No API credentials, public sites, downloads or paid calls are used.
 * usage: node scripts/check-capabilities.mjs [output folder]
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry} from '../core/provider-registry.mjs';
import {Capabilities} from '../core/capabilities.mjs';
import {MediaJobs} from '../core/media-jobs.mjs';
import {SemanticMemory} from '../core/semantic.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';

const out=path.resolve(process.argv[2]||'validation/capability-live');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-capability-live-'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
const traffic=[];
const server=http.createServer(async(req,res)=>{
 const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};traffic.push(req.url);
 const json=v=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
 if(req.url==='/v1/embeddings')return json({data:body.input.map((input,index)=>({index,embedding:/coffee|drink|飲み物|コーヒー/.test(input)?[1,0,0]:[0,1,0]}))});
 if(req.url==='/v1/images/generations')return json({data:[{b64_json:png.toString('base64')}]});
 if(req.url==='/v1/audio/speech'){res.writeHead(200,{'Content-Type':'audio/wav'});return res.end(wav);}
 if(req.url==='/v1/chat/completions'){
  // The scripted "model": a work agent that recalls a preference, makes a picture and a voice line, then reports.
  const tools=(body.messages||[]).filter(m=>m.role==='tool'),n=tools.length;
  const call=(name,args)=>json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'c'+n,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]});
  if(n===0)return call('memory_search',{query:'好きな飲み物'});
  if(n===1)return call('media',{action:'generate',kind:'image',prompt:'A cup of coffee (fixture, not a quality test)',wait:30});
  if(n===2)return call('media',{action:'generate',kind:'tts',prompt:'コーヒーの絵ができました。',wait:30});
  if(n===3)return call('artifact',{action:'publish',title:'できたもの',kind:'text',content:`記憶: ${tools[0].content}\n画像: ${tools[1].content}\n音声: ${tools[2].content}`});
  return json({choices:[{message:{role:'assistant',content:'画像と音声を作り、artifactにまとめました。'},finish_reason:'stop'}]});
 }
 res.writeHead(404);res.end('{}');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/v1`;
const store=new Store(dir),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network),capabilities=new Capabilities(store,network);
registry.save({profiles:[{id:'local',protocol:'chat-completions',baseUrl:base,model:'fixture',domain:'device',capabilities:{tools:true}}],routes:{main:{primary:'local'}}},0);
capabilities.save({profiles:[['emb','openai-embeddings'],['img','openai-images'],['voice','openai-speech']].map(([id,protocol])=>({id,name:id,protocol,baseUrl:base,model:'fixture',domain:'device'})),routes:{embedding:'emb',image:'img',tts:'voice'}},0);
const media=new MediaJobs(store,capabilities,{pollMs:20}),semantic=new SemanticMemory(store,capabilities);
const rt=new AgentRuntime(store,{registry,network,capabilities,media,semantic,workRoot:path.join(dir,'work'),autoStart:false});
const checks=[];const record=(name,ok,detail)=>checks.push({name,ok,detail});
try{
 store.memory('The user likes coffee in the morning.',{confirmed:true});store.memory('The office is in Osaka.',{confirmed:true});await semantic.index();
 const s=await rt.spawn(null,{task:'好きな飲み物の絵と、ひと言の音声を作って'});rt.wake(s.id);
 const start=Date.now();while(rt.sessions.get(s.id).status!=='done'){if(Date.now()-start>60000)throw new Error('timed out: '+rt.sessions.get(s.id).note);await new Promise(r=>setTimeout(r,50));}
 const tools=rt.sessions.entries(s.id,{types:['tool']});
 record('semantic memory search',/coffee/.test(tools[0].content),tools[0].content.split('\n')[0]);
 const image=tools[1].data?.path,speech=tools[2].data?.path;
 record('image saved and shown',!!image&&(await stat(image)).size===png.length&&tools[1].images?.length===1,image);
 record('speech saved',!!speech&&(await stat(speech)).size===wav.length,speech);
 const art=store.list('artifact')[0];record('artifact',!!art&&/画像: Ready/.test(art.content),art?.title);
 record('endpoints used',['/v1/embeddings','/v1/images/generations','/v1/audio/speech'].every(u=>traffic.includes(u)),[...new Set(traffic)].join(' '));
}catch(e){record('flow',false,e.message);}
finally{
 await rt.close();await media.close();capabilities.close();store.close();server.close();await rm(dir,{recursive:true,force:true});
 const report={checks,passed:checks.filter(c=>c.ok).length,total:checks.length,fixture:'deterministic local endpoints, not learned models',createdAt:new Date().toISOString()};
 await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({report:path.join(out,'report.json'),passed:report.passed,total:report.total,failed:checks.filter(c=>!c.ok)}));
 if(report.passed!==report.total)process.exitCode=1;
}

/** Actual Harness -> local capability HTTP -> SQLite/files -> independent result checks.
 * The inference/generation service is an explicitly deterministic fixture, NOT a learned model.
 * No API credentials, public sites, model downloads, or paid calls are used.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Store} from '../core/store.mjs';
import {Harness} from '../core/harness.mjs';
import {Connectors} from '../core/connectors.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
const out=path.resolve(process.argv[2]||'validation/capability-live');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-capability-live-'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
const traffic=[],approved=[],checks=[];let step=0,holdImage,releaseImage;
const server=http.createServer(async(req,res)=>{
 try{const chunks=[];for await(const b of req)chunks.push(b);const raw=Buffer.concat(chunks),body=raw.length?JSON.parse(raw):{};traffic.push({route:req.url,method:req.method});
  if(req.url==='/v1/embeddings') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:body.input.map((input,index)=>({index,embedding:input.includes('coffee')||input.includes('drink')?[1,0,0]:[0,1,0]}))}));}
  else if(req.url==='/v1/images/generations') {holdImage=true;await new Promise(r=>releaseImage=r);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}
  else if(req.url==='/v1/audio/speech'){res.setHeader('Content-Type','audio/wav');res.end(wav);}
  else{res.writeHead(404);res.end('{}');}
 }catch{res.writeHead(500);res.end('{}');}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const store=new Store(dir),network=new NetworkPolicy(store);
let imageJob=null,speechJob=null;
const tool=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:'c'+(++step),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const h=new Harness(store,new Connectors(store,network),{network,runtimeFactory:()=>({chat:async messages=>{
 const results=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
 if(!results.length)return tool('memory_search',{query:'drink'});
 if(results.length===1){assert.match(JSON.stringify(results[0]),/coffee/);return tool('media_generate',{kind:'image',prompt:'A test image, not a quality benchmark',requestId:'image-once'});}
 if(results.length===2){imageJob=results[1];assert.ok(['queued','submitting'].includes(imageJob.status));return tool('media_generate',{kind:'tts',prompt:'The image is being prepared.',requestId:'speech-once'});}
 if(results.length===3){speechJob=results[2];return tool('artifact_publish',{title:'Accepted requests',kind:'text',content:`Image request ${imageJob.id}; speech request ${speechJob.id}. Accepted is not finished.`});}
 return {role:'assistant',content:'生成の受付を保存しました。画像の完成を待つ間も会話できます。'};
}})});
async function until(fn){const start=Date.now();while(!fn()){if(Date.now()-start>10000)throw Error('Capability flow timed out');await new Promise(r=>setTimeout(r,10));}}
try{
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 const profiles=[['emb','openai-embeddings'],['img','openai-images'],['voice','openai-speech']].map(([id,protocol])=>({id,name:id,protocol,baseUrl,model:'deterministic-fixture',domain:'device'}));
 h.capabilities.save({profiles,routes:{embedding:'emb',image:'img',tts:'voice'}},0);
 const memory=store.memory('My favorite beverage is coffee.');store.memory('The document is a contract.');
 await h.semantic.index();network.change({mode:'offline'},0);
 store.listeners.add(e=>{if(e.type==='job.updated'&&e.data.approval){const a=e.data.approval;assert.equal(a.name,'generate_media');assert.equal(a.args.domain,'device');assert.ok(['image','tts'].includes(a.args.kind));approved.push(a.args.kind);queueMicrotask(()=>h.approve(a.id,true));}});
 const job=h.submit('Use my remembered drink preference; create an image and spoken acknowledgement.','work',{checks:[{type:'artifact',any:true,contains:'Accepted is not finished'}]});
 await until(()=>!h.active.size);
 assert.equal(store.get('job',job.id).status,'review');assert.equal(store.get('job',job.id).verification.checks.status,'checks-passed');
 await until(()=>holdImage);assert.equal(holdImage,true);assert.equal(h.media.list().find(j=>j.id===imageJob.id).status,'submitting');
 assert.match(store.get('job',job.id).note,/継続/);checks.push('Semantic search can match a differently worded memory using a fixture embedding endpoint; original memory remains the evidence.');
 checks.push('The actual agent job yields an accepted media handle and reaches review while image generation is still in progress, without claiming it completed.');
 releaseImage();await until(()=>h.media.list().every(j=>j.status==='ready'));
 const image=await h.media.readAsset(h.media.list().find(j=>j.kind==='image').asset.id);const audio=await h.media.readAsset(h.media.list().find(j=>j.kind==='tts').asset.id);
 assert.deepEqual(image.bytes,png);assert.deepEqual(audio.bytes,wav);assert.deepEqual(approved,['image','tts']);
 await writeFile(path.join(out,'fixture-image.png'),image.bytes);await writeFile(path.join(out,'fixture-audio.wav'),audio.bytes);
 checks.push('Generated image and audio bytes traverse actual HTTP, validation, local persistence and byte-identical retrieval after prompt-specific approvals.');
 const count=traffic.filter(r=>r.route==='/v1/images/generations').length;
 const duplicate=h.media.create({kind:'image',prompt:'A test image, not a quality benchmark',requestId:'image-once',profileIdentity:h.capabilities.pin('image').identity},job);
 assert.equal(duplicate.id,imageJob.id);assert.equal(traffic.filter(r=>r.route==='/v1/images/generations').length,count);
 checks.push('Repeating the same generation request ID returns the existing result rather than creating a second paid request.');
 store.remove('memory',memory.id);assert.equal((await h.semantic.search('drink')).hits.some(m=>m.id===memory.id),false);checks.push('Deleted memories are excluded even when vectors have been created previously.');
 await until(()=>h.media.active.size===0);assert.equal(network.active.size,0);assert.equal(h.media.active.size,0);
 const report={passed:true,checks,approvals:approved,traffic,externalNetworkCalls:0,model:'deterministic fixture, not a trained model',embeddingQualityTested:false,generationQualityTested:false,realExecution:'Node harness, HTTP, SQLite, file persistence, state and byte validation',at:new Date().toISOString()};
 await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{releaseImage?.();h.close();while(h.active.size)await new Promise(r=>setTimeout(r,10));await h.media.close();h.capabilities.close();network.close();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}

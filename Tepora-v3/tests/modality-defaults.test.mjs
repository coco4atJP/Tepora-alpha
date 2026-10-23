import test from 'node:test';
import assert from 'node:assert/strict';
import {Capabilities,validateCapability} from '../core/capabilities.mjs';
import {embeddingIdentity,embeddingInputs,QWEN_RETRIEVAL_PREFIX} from '../core/embedding-space.mjs';
import {MODALITY_PRESETS,modalityPreset} from '../web/modality-presets.mjs';
import {TranscriptionRequest} from '../web/transcription.mjs';
import {MediaJobs} from '../core/media-jobs.mjs';
import {SemanticMemory} from '../core/semantic.mjs';

function fixture(respond=()=>({text:'合成の認識結果',languages:[]})){
 let registry;const calls=[],documents=new Map();
 const store={value(_key,value){if(value!==undefined)registry=value;return registry;},emit(){},list:kind=>[...documents.values()].filter(v=>v.kind===kind),get:(kind,id)=>documents.get(kind+':'+id),put:(kind,v)=>documents.set(kind+':'+v.id,{...v,kind})};
 const network={active:new Map(),request:async(url,init,scope)=>{calls.push({url,init,scope});const answer=await respond(url,init,scope);return answer instanceof Response?answer:new Response(JSON.stringify(answer),{headers:{'content-type':'application/json'}});}};
 const caps=new Capabilities(store,network);
 const install=(preset,patch={})=>{const raw={...modalityPreset(preset),apiKeyEnv:'',...patch};caps.save({profiles:[raw],routes:{[MODALITY_PRESETS.find(p=>p.id===preset).role]:raw.id}},caps.get().revision);return caps.pin(MODALITY_PRESETS.find(p=>p.id===preset).role);};
 return {store,caps,calls,install};
}
const wav=()=>{const b=Buffer.alloc(48);b.write('RIFF');b.write('WAVE',8);return b;};
test('every suggested model is a valid inert profile; no retired OpenAI audio default',()=>{
 const f=fixture();for(const preset of MODALITY_PRESETS){const profile=validateCapability(modalityPreset(preset.id));assert.equal(profile.role,preset.role);}
 assert.equal(f.calls.length,0);assert.deepEqual(f.caps.get().routes,{});
 assert.ok(!MODALITY_PRESETS.some(p=>/^(gpt-4o-|tts-1|whisper-1)/.test(p.model)));
 assert.equal(modalityPreset('tts-qwen').voice,'Ono_Anna');assert.equal(modalityPreset('tts-inworld').voice,'Dennis');
});
for(const [preset,field] of [['stt-openai','languages[]'],['stt-groq','language'],['stt-qwen','language']])test(`${preset} sends the correct bounded multipart shape only after admission`,async()=>{
 const f=fixture(),p=f.install(preset);
 await assert.rejects(f.caps.transcribe(wav(),{profileIdentity:'stale',consent:true}),/変わりました/);assert.equal(f.calls.length,0);
 if(p.domain!=='device'){await assert.rejects(f.caps.transcribe(wav(),{profileIdentity:p.identity}),/確認/);assert.equal(f.calls.length,0);}
 const result=await f.caps.transcribe(wav(),{profileIdentity:p.identity,consent:true});assert.equal(result.text,'合成の認識結果');
 const call=f.calls[0];assert.equal(call.url,p.baseUrl+'/audio/transcriptions');assert.equal(call.init.body.get(field),'ja');
 assert.equal(call.init.body.has(field==='language'?'languages[]':'language'),false);assert.equal(call.init.body.get('response_format'),'json');
 assert.equal(call.init.body.get('model'),p.model);assert.equal(call.init.body.get('file').size,48);
});
test('ASR malformed replies, upstream errors, cancellation and endpoint changes fail closed',async()=>{
 for(const answer of [{text:42},{text:'a'.repeat(32001)},new Response('synthetic rejection',{status:401})]){
  const f=fixture(()=>answer),p=f.install('stt-openai');await assert.rejects(f.caps.transcribe(wav(),{profileIdentity:p.identity,consent:true}));
 }
 const f=fixture((_url,init)=>{init.signal.throwIfAborted();return {text:'late'};}),p=f.install('stt-openai'),controller=new AbortController();controller.abort();
 await assert.rejects(f.caps.transcribe(wav(),{profileIdentity:p.identity,consent:true,signal:controller.signal}));
 const g=fixture(()=>{g.install('stt-groq');return {text:'old recipient'};}),old=g.install('stt-openai');await assert.rejects(g.caps.transcribe(wav(),{profileIdentity:old.identity,consent:true}),/changed/);
});
test('Qwen embedding query/document recipes, context and revision have separate spaces',async()=>{
 const f=fixture((_url,init)=>{const input=JSON.parse(init.body).input;return {embeddings:input.map(()=>[1,0])};}),p=f.install('embedding-qwen',{dimensions:2,modelRevision:'synthetic-revision-1'});
 await f.caps.embed(['質問'],{purpose:'query'});assert.deepEqual(JSON.parse(f.calls[0].init.body).input,[QWEN_RETRIEVAL_PREFIX+'質問']);assert.deepEqual(JSON.parse(f.calls[0].init.body).options,{num_ctx:2048});
 assert.deepEqual(embeddingInputs(p,['質問','原文'],'ranking'),[QWEN_RETRIEVAL_PREFIX+'質問','原文']);
 const sem=new SemanticMemory(f.store,f.caps);f.store.put('memory',{id:'one',content:'原文',confirmed:true,scope:'private'});await sem.index();
 assert.deepEqual(JSON.parse(f.calls.at(-1).init.body).input,['原文']);const old=f.store.get('memory-vector','one');assert.equal(old.identity,embeddingIdentity(p));
 f.install('embedding-qwen',{dimensions:2,modelRevision:'synthetic-revision-2'});assert.equal((await sem.search('一致しない質問')).indexed,0);assert.strictEqual(f.store.get('memory-vector','one'),old,'selecting a new space must preserve the old cache until reindex');
 assert.equal(f.store.get('memory','one').content,'原文');
});
test('external embedding presets do not authorize background indexing or disclose private memories',async()=>{
 const f=fixture(),p=f.install('embedding-openai');f.store.put('memory',{id:'private',content:'private fixture',scope:'private',confirmed:true});
 const sem=new SemanticMemory(f.store,f.caps);await assert.rejects(sem.index(),/許可/);await sem.index({allowExternal:true});assert.equal(f.calls.length,0);
 assert.notEqual(embeddingIdentity(p),embeddingIdentity({...p,identity:'different'}));assert.equal(embeddingIdentity({identity:'legacy'}),'legacy');
});
test('cloud recording review cancels without sending; repeated confirm sends once',async()=>{
 const calls=[],review=[];let finish;const request=new TranscriptionRequest((audio,headers,signal)=>{calls.push({audio,headers,signal});return new Promise(r=>{finish=r;});});
 const profile={identity:'exact',domain:'cloud'},audio=new Blob(['fixture']);
 const pending=request.run(audio,profile,{owns:()=>true,onReview:(...args)=>review.push(args)});const cancelled=assert.rejects(pending,{name:'AbortError'});assert.equal(calls.length,0);request.cancel();await cancelled;
 const next=request.run(audio,profile,{owns:()=>true,onReview(){}});assert.equal(request.confirm(),true);assert.equal(request.confirm(),false);assert.equal(calls.length,1);
 assert.equal(calls[0].headers['X-Tepora-Audio-Profile'],'exact');assert.equal(calls[0].headers['X-Tepora-Audio-Consent'],'true');finish({text:'合成'});assert.deepEqual(await next,{text:'合成'});
});
test('changed draft refuses dispatch, and cancellation aborts an admitted request and drops late text',async()=>{
 let owned=false,finish,calls=0;const request=new TranscriptionRequest((_a,_h,signal)=>{calls++;assert.ok(!signal.aborted);return new Promise(r=>{finish=r;});});
 const pending=request.run(new Blob(['fixture']),{domain:'cloud',identity:'one'},{owns:()=>owned,onReview(){}});assert.throws(()=>request.confirm(),/変わりました/);assert.equal(calls,0);
 owned=true;request.confirm();const cancelled=assert.rejects(pending,{name:'AbortError'});request.cancel();await cancelled;finish({text:'stale'});await new Promise(r=>setImmediate(r));assert.equal(request.pending,null);
});

test('MOSS placeholder cannot dispatch; supported speech presets enforce text budgets before queueing',()=>{
 const f=fixture(),media=Object.assign(Object.create(MediaJobs.prototype),{store:f.store,capabilities:f.caps});
 const p=f.install('tts-moss');assert.throws(()=>media.create({kind:'tts',prompt:'合成',requestId:'synthetic-moss',profileIdentity:p.identity}),/built-in voice/);
 for(const id of ['tts-qwen','tts-kokoro','tts-inworld']){const p=f.install(id);assert.throws(()=>media.create({kind:'tts',prompt:'a'.repeat(4001),requestId:'synthetic-budget',profileIdentity:p.identity}),/4000 characters/);}
 assert.equal(f.calls.length,0);
});

test('semantic review identity refuses a changed query/index recipient before dispatch',async()=>{
 const f=fixture(),p=f.install('embedding-qwen'),sem=new SemanticMemory(f.store,f.caps);
 f.install('embedding-openai');await assert.rejects(sem.index({profileIdentity:p.identity,allowExternal:true}),/変わりました/);
 await assert.rejects(sem.search('合成',{profileIdentity:p.identity,allowExternal:true}),/変わりました/);assert.equal(f.calls.length,0);
});

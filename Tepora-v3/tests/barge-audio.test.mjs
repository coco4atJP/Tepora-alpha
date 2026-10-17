import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {HandsFreeMicrophone} from '../web/hands-free-voice.mjs';

// Synthetic buffers and Web Audio fakes only: no devices, network or models.
const frame=(value=0,length=3200)=>new Float32Array(length).fill(value);
const source=await readFile(new URL('../web/pcm-worklet.js',import.meta.url),'utf8');
function worklet(rate,{bounded=true,referenceCapable=true}={}){
 let Processor;const messages=[],transfers=[];
 vm.runInNewContext(source,{sampleRate:rate,Float32Array,AudioWorkletProcessor:class{constructor(){this.port={postMessage:(data,transfer)=>{messages.push(data);transfers.push(transfer);}};}},registerProcessor(name,Type){assert.equal(name,'tepora-stream-pcm');Processor=Type;}});
 const processor=new Processor({processorOptions:{bounded,referenceCapable}});
 return {processor,messages,transfers,send:data=>processor.port.onmessage({data})};
}
for(const rate of [16000,44100,48000,96000])test(`paired ${rate}Hz capture shares every fractional resampling boundary`,()=>{
 const w=worklet(rate);w.send({reference:true,referenceRevision:7});let supplied=0,ack=0,inputSum=0;
 while(supplied<rate){
  const length=Math.min([17,128,53,256][supplied%4],rate-supplied),input=new Float32Array(length);
  for(let i=0;i<length;i++){input[i]=Math.sin((supplied+i)*.07)*.4;inputSum+=input[i];}
  assert.equal(w.processor.process([[input],[input,input]]),true);supplied+=length;
  while(ack<w.messages.length){w.send({ack:true});ack++;}
 }
 assert.equal(w.messages.length,5);let sum=0;
 for(let i=0;i<5;i++){
  const m=w.messages[i];assert.equal(m.pcm.length,3200);assert.equal(m.reference.length,3200);assert.equal(m.referenceRevision,7);
  assert.deepEqual(m.pcm,m.reference);assert.equal(w.transfers[i].length,2);assert.equal(w.transfers[i][0],m.pcm.buffer);assert.equal(w.transfers[i][1],m.reference.buffer);sum+=m.pcm.reduce((a,b)=>a+b,0);
 }
 assert.ok(Math.abs(sum-inputSum/(rate/16000))<1e-4);assert.equal(w.processor.outstanding,0);
});

test('reference stereodownmix is separate from microphone and reference-only input emits nothing',()=>{
 const w=worklet(48000);w.send({reference:true,referenceRevision:1});
 assert.equal(w.processor.process([[],[frame(.9),frame(.7)]]),true);assert.equal(w.processor.frames,0);assert.equal(w.messages.length,0);
 w.processor.process([[frame(.1,9600)],[frame(.8,9600),frame(-.4,9600)]]);
 assert.equal(w.messages.length,1);assert.ok(w.messages[0].pcm.every(v=>Math.abs(v-.1)<1e-6));assert.ok(w.messages[0].reference.every(v=>Math.abs(v-.2)<1e-6));
});

test('missing reference input becomes aligned silence without affecting microphone',()=>{
 const w=worklet(44100);w.send({reference:true});w.processor.process([[frame(.3,8820)]]);
 assert.equal(w.messages.length,1);assert.ok(w.messages[0].reference.every(v=>v===0));assert.ok(w.messages[0].pcm.every(v=>Math.abs(v-.3)<1e-6));
});

test('reference toggles discard complete partial frames and fractional old-mode samples',()=>{
 const w=worklet(44100);w.processor.process([[frame(.9,101)]]);assert.ok(w.processor.frames>0);assert.ok(w.processor.weight>0);
 w.send({reference:true,referenceRevision:1});assert.equal(w.processor.frames,0);assert.equal(w.processor.weight,0);
 w.processor.process([[frame(.2,8820)],[frame(.4,8820)]]);assert.equal(w.messages.length,1);assert.ok(w.messages[0].pcm.every(v=>Math.abs(v-.2)<1e-6));
 w.processor.process([[frame(.9,101)],[frame(.8,101)]]);w.send({reference:false});assert.equal(w.processor.frames,0);assert.equal(w.processor.referenceSum,0);
 w.processor.process([[frame(.1,8820)],[frame(.8,8820)]]);assert.equal(w.messages.length,2);assert.equal(w.messages[1].reference,undefined);assert.ok(w.messages[1].pcm.every(v=>Math.abs(v-.1)<1e-6));
});

test('paired tail flush transfers equal short buffers once',()=>{
 const w=worklet(48000);w.send({reference:true,referenceRevision:2});w.processor.process([[frame(.1,381)],[frame(.2,381),frame(.4,381)]]);w.send({flush:true});
 assert.equal(w.messages[0].pcm.length,127);assert.equal(w.messages[0].reference.length,127);assert.ok(w.messages[0].reference.every(v=>Math.abs(v-.3)<1e-6));assert.equal(w.messages[1].flushed,true);
 w.send({flush:true});assert.equal(w.messages.filter(m=>m.pcm).length,1);
});

for(const rate of [44100,48000])test(`paired ${rate}Hz capture bounds all queued payloads and fails closed once`,()=>{
 const w=worklet(rate);w.send({reference:true});let stopped=false;
 for(let i=0;i<60*rate;i+=128)if(!w.processor.process([[frame(.1,128)],[frame(.2,128),frame(.4,128)]]))stopped=true;
 assert.equal(stopped,true);assert.equal(w.messages.filter(m=>m.pcm).length,2);assert.equal(w.messages.filter(m=>m.overflow).length,1);
 assert.equal(w.messages.reduce((sum,m)=>sum+(m.pcm?.byteLength||0)+(m.reference?.byteLength||0),0),51200);
 assert.equal(w.processor.buffer.byteLength+w.processor.referenceBuffer.byteLength,25600);assert.equal(w.processor.frames,0);
 for(let i=0;i<5;i++){w.send({ack:true});w.send({reference:false});w.send({flush:true});assert.equal(w.processor.process([[frame(.3)],[frame(.5)]]),false);}assert.equal(w.messages.length,3);
});

test('toggling modes does not replenish outstanding message credits',()=>{
 const w=worklet(16000);w.processor.process([[frame(.1)]]);w.send({reference:true});w.processor.process([[frame(.2)],[frame(.3)]]);w.send({reference:false});
 assert.equal(w.processor.outstanding,2);assert.equal(w.processor.process([[frame(.4)]]),false);assert.equal(w.messages.length,3);assert.equal(w.messages[2].overflow,true);
});

test('default worklet stays mono and ignores reference enable messages',()=>{
 const w=worklet(16000,{referenceCapable:false});w.send({reference:true});w.processor.process([[frame(.1)],[frame(.5)]]);
 assert.equal(w.processor.referenceBuffer,null);assert.equal(w.messages[0].reference,undefined);assert.equal(w.transfers[0].length,1);
});

function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};}
function media(t,{aec=true,permission}={}){
 const env={contexts:[],nodes:[],tracks:[],elementCalls:0,created:[],createFail:false,referenceFail:false,destinationFail:false};
 function replace(key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);}
 const graph=()=>({connections:[],disconnects:[],connect(...args){if(args[2]===1&&env.referenceFail)throw Error('reference refused');if(args[0]?.destination&&env.destinationFail)throw Error('destination refused');this.connections.push(args);},disconnect(...args){this.disconnects.push(args);this.connections=this.connections.filter(c=>args.length&&!(c[0]===args[0]&&(args.length<3||c[2]===args[2])));}});
 function stream(){const listeners=new Map(),track={stops:0,getSettings:()=>({echoCancellation:aec}),stop(){this.stops++;},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},emit:name=>listeners.get(name)?.(),listeners};env.tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};}
 replace('navigator',{mediaDevices:{getUserMedia:()=>permission?.promise||Promise.resolve(stream())}});
 replace('AudioContext',class{
  constructor(){this.state='running';this.destination={destination:true};this.graph=[];this.closes=0;this.audioWorklet={addModule:async()=>{}};env.contexts.push(this);}
  createMediaStreamSource(){const n=graph();this.graph.push(n);return n;}
  createGain(){const n={...graph(),gain:{value:1}};this.graph.push(n);return n;}
  createMediaElementSource(audio){env.elementCalls++;if(env.createFail)throw Error('element unavailable');const n={...graph(),audio,context:this};env.created.push(n);return n;}
  async resume(){}async close(){this.closes++;this.state='closed';}
 });
 replace('AudioWorkletNode',class{constructor(context,name,options){Object.assign(this,graph(),{context,name,options,messages:[]});this.port={postMessage:data=>this.messages.push(data)};env.nodes.push(this);}});
 env.stream=stream;return env;
}
async function microphone(t,env){const mic=new HandsFreeMicrophone({bargeIn:true}),frames=[],errors=[];t.after(()=>mic.close());await mic.start((...args)=>frames.push(args),error=>errors.push(error));return {mic,frames,errors};}

test('barge microphone requires actual AEC settings, with actionable fallback',async t=>{
 for(const aec of [false,undefined,'true']){
  const env=media(t,{aec}),mic=new HandsFreeMicrophone({bargeIn:true});
  // Undefined is explicitly supplied below; fixture's destructuring default is true.
  if(aec===undefined){const stream=env.stream();stream.getAudioTracks()[0].getSettings=()=>({});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream}}});}
  await assert.rejects(mic.start(()=>{},()=>{}),/音声割り込みを無効/);assert.equal(mic.closed,true);assert.equal(env.contexts.length,0);assert.equal(env.tracks.at(-1).stops,1);
 }
});

test('barge microphone captures playback with the same context and only input 1',async t=>{
 const env=media(t),{mic,frames}=await microphone(t,env),node=env.nodes[0],context=env.contexts[0],audio={};
 assert.deepEqual(node.options,{numberOfInputs:2,processorOptions:{bounded:true,referenceCapable:true}});assert.equal(mic.attachOutput(audio),true);
 const output=env.created[0];assert.equal(output.context,context);assert.deepEqual(output.connections,[[context.destination],[node,0,1]]);
 assert.deepEqual(context.graph[0].connections,[[node]]);assert.equal(context.graph[1].gain.value,0);
 const pcm=frame(.1),reference=frame(.3),revision=mic.referenceRevision;
 node.port.onmessage({data:{pcm,reference,referenceRevision:revision}});assert.deepEqual(frames,[[pcm,reference]]);assert.deepEqual(node.messages.at(-1),{ack:true});
 assert.equal(mic.releaseOutput(),true);assert.deepEqual(output.connections,[[context.destination]]);assert.deepEqual(output.disconnects,[[node,0,1]]);
 node.port.onmessage({data:{pcm,reference,referenceRevision:revision}});assert.equal(frames.length,1);node.port.onmessage({data:{pcm}});assert.deepEqual(frames[1],[pcm]);
 assert.equal(mic.attachOutput(audio),true);assert.equal(env.elementCalls,1);assert.deepEqual(output.connections,[[context.destination],[node,0,1]]);
 node.port.onmessage({data:{pcm,reference,referenceRevision:revision}});node.port.onmessage({data:{pcm}});assert.equal(frames.length,2,'old output/mono messages are acknowledged and discarded');
 node.port.onmessage({data:{pcm,reference,referenceRevision:mic.referenceRevision}});assert.equal(frames.length,3);
 mic.close();mic.close();assert.equal(context.closes,1);assert.equal(output.connections.length,0);assert.equal(env.tracks[0].stops,1);assert.equal(mic.releaseOutput(),false);assert.equal(mic.attachOutput(audio),false);
});

test('switching playback elements retires the previous source and releases every graph on close',async t=>{
 const env=media(t),{mic}=await microphone(t,env);assert.equal(mic.attachOutput({}),true);assert.equal(mic.attachOutput({}),true);
 assert.deepEqual(env.created[0].connections,[]);assert.equal(env.created[1].connections.length,2);assert.equal(mic.outputSources.size,1);assert.equal(mic.audibleSources.size,1);
 mic.close();assert.ok(env.created.every(n=>n.connections.length===0));assert.equal(mic.outputSources.size,0);
});

test('many readouts retain at most one source, and retirement clears both strong Sets',async t=>{
 const env=media(t),{mic}=await microphone(t,env);let previous;
 for(let i=0;i<500;i++){
  const audio={clip:i};assert.equal(mic.attachOutput(audio),true);assert.equal(mic.outputSources.size,1);assert.equal(mic.audibleSources.size,1);assert.equal(mic.outputAudio,audio);
  if(previous)assert.equal(previous.connections.length,0);previous=env.created.at(-1);
  if(i%2===0){
   assert.equal(mic.releaseOutput(),true);assert.equal(mic.outputSources.size,1);assert.equal(previous.connections.length,1,'paused playback keeps its destination');
   assert.equal(mic.retireOutput(audio),true);assert.equal(previous.connections.length,0);assert.equal(mic.outputSources.size,0);assert.equal(mic.audibleSources.size,0);assert.equal(mic.outputAudio,null);
  }
 }
 mic.retireOutput(mic.outputAudio);assert.equal(mic.outputSources.size,0);assert.equal(mic.audibleSources.size,0);assert.ok(env.created.every(n=>n.connections.length===0));
});

test('retired elements reuse their single cached source and reconnect audible playback',async t=>{
 const env=media(t),{mic}=await microphone(t,env),audio={};assert.equal(mic.attachOutput(audio),true);const source=env.created[0],revision=mic.referenceRevision;
 assert.equal(mic.retireOutput(audio),true);assert.equal(mic.referenceAttached,false);assert.equal(source.connections.length,0);assert.equal(mic.outputAudio,null);assert.equal(mic.outputs.get(audio),source);
 assert.equal(mic.retireOutput(audio),true,'retirement is idempotent');assert.equal(mic.retireOutput({}),false);
 assert.equal(mic.attachOutput(audio),true);assert.equal(env.elementCalls,1);assert.equal(mic.outputSources.size,1);assert.equal(mic.audibleSources.size,1);assert.deepEqual(source.connections,[[env.contexts[0].destination],[env.nodes[0],0,1]]);assert.ok(mic.referenceRevision>revision);
 mic.close();assert.equal(source.connections.length,0);assert.equal(mic.retireOutput(audio),false);
});

test('stale retirement cannot detach a replacement or change its playback revision',async t=>{
 const env=media(t),{mic,frames}=await microphone(t,env),old={},replacement={};mic.attachOutput(old);mic.releaseOutput();mic.attachOutput(replacement);
 const revision=mic.referenceRevision,current=env.created[1],messageCount=env.nodes[0].messages.length;assert.equal(mic.retireOutput(old),true);
 assert.equal(mic.referenceRevision,revision);assert.equal(mic.outputAudio,replacement);assert.equal(mic.outputSource,current);assert.equal(mic.referenceAttached,true);assert.equal(env.nodes[0].messages.length,messageCount);assert.equal(current.connections.length,2);assert.equal(mic.outputSources.size,1);
 env.nodes[0].port.onmessage({data:{pcm:frame(.1),reference:frame(.2),referenceRevision:revision}});assert.equal(frames.length,1);
});

test('reference attachment failures return false without disconnecting normal playback',async t=>{
 const env=media(t),{mic}=await microphone(t,env);env.createFail=true;assert.equal(mic.attachOutput({}),false);env.createFail=false;env.referenceFail=true;
 const audio={};assert.equal(mic.attachOutput(audio),false);assert.deepEqual(env.created[0].connections,[[env.contexts[0].destination]]);assert.equal(mic.referenceAttached,undefined);
 env.referenceFail=false;assert.equal(mic.attachOutput(audio),true);assert.equal(env.elementCalls,2);
 mic.track.getSettings=()=>({echoCancellation:false});assert.equal(mic.attachOutput({}),false);
});

test('a destination connection failure cannot be reported as an attached reference',async t=>{
 const env=media(t),{mic}=await microphone(t,env),audio={};env.destinationFail=true;assert.equal(mic.attachOutput(audio),false);assert.equal(env.created[0].connections.length,0);
 env.destinationFail=false;assert.equal(mic.attachOutput(audio),true);assert.equal(env.elementCalls,1);assert.equal(env.created[0].connections.length,2);
});

test('default microphone remains mono and never creates a media element source',async t=>{
 const env=media(t,{aec:false}),mic=new HandsFreeMicrophone();t.after(()=>mic.close());await mic.start(()=>{},()=>{});assert.deepEqual(env.nodes[0].options,{processorOptions:{bounded:true}});assert.equal(mic.attachOutput({}),false);assert.equal(env.elementCalls,0);
});

test('late barge microphone permission is stopped without creating a graph',async t=>{
 const permission=deferred(),env=media(t,{permission}),mic=new HandsFreeMicrophone({bargeIn:true}),start=assert.rejects(mic.start(()=>{},()=>{}),{name:'AbortError'});
 mic.close();permission.resolve(env.stream());await start;assert.equal(env.tracks[0].stops,1);assert.equal(env.contexts.length,0);assert.equal(mic.attachOutput({}),false);
});

for(const event of ['mute','ended'])test(`device ${event} releases active reference when controller handles the failure`,async t=>{
 const env=media(t),mic=new HandsFreeMicrophone({bargeIn:true}),errors=[];t.after(()=>mic.close());await mic.start(()=>{},error=>{errors.push(error);mic.close();});mic.attachOutput({});env.tracks[0].emit(event);
 assert.equal(errors.length,1);assert.equal(mic.closed,true);assert.equal(env.tracks[0].listeners.size,0);assert.equal(env.contexts[0].closes,1);assert.equal(env.created[0].connections.length,0);assert.equal(mic.attachOutput({}),false);
});

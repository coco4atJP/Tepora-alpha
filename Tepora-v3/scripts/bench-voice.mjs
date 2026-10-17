/** Synthetic PCM preprocessing benchmark; no microphone, model, network or disk writes.
 * Optional --baseline /path/to/pcm-worklet.js compares an explicitly supplied source.
 */
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {performance} from 'node:perf_hooks';
const benchVoiceArgs=process.argv.slice(2),benchVoiceBaseline=benchVoiceArgs.indexOf('--baseline');
const benchVoiceSources=[['current',new URL('../web/pcm-worklet.js',import.meta.url)],...(benchVoiceBaseline<0?[]:[['baseline',benchVoiceArgs[benchVoiceBaseline+1]]])];
const benchVoiceResults=[];
for(const [version,file] of benchVoiceSources){
 const source=await readFile(file,'utf8');
 for(const rate of [16000,44100,48000,96000]){
  let Processor,count=0,samples=0,largest=0;
  const context=vm.createContext({sampleRate:rate,Float32Array,AudioWorkletProcessor:class{constructor(){this.port={postMessage:message=>{if(message.pcm){count++;samples+=message.pcm.length;largest=Math.max(largest,message.pcm.length);}}};}},registerProcessor:(_name,type)=>{Processor=type;}});
  new vm.Script(source).runInContext(context);
  const block=new Float32Array(128).fill(.1),processor=new Processor(),start=performance.now(),cpuStart=process.cpuUsage();
  for(let offset=0;offset<rate*60;offset+=128)processor.process([[block.subarray(0,Math.min(128,rate*60-offset))]]);
  processor.port.onmessage({data:{flush:true}});
  const cpu=process.cpuUsage(cpuStart);
  benchVoiceResults.push({version,sampleRate:rate,audioSeconds:60,elapsedMs:Math.round((performance.now()-start)*100)/100,cpuMs:Math.round((cpu.user+cpu.system)/10)/100,chunks:count,outputSamples:samples,largestChunkSamples:largest});
 }
}
console.log(JSON.stringify({node:process.version,synthetic:true,inferenceMeasured:false,results:benchVoiceResults},null,2));

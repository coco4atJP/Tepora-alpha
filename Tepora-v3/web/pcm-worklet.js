/* Native-rate input to 16 kHz Float32 PCM, in 200 ms chunks.
 * Uses area averaging when downsampling. No audio is persisted.
 */
class TeporaStreamPCM extends AudioWorkletProcessor {
  constructor() {
    super();this.buffer=[];this.frames=0;
    this.port.onmessage=e=>{if(e.data.flush){this.flush();this.port.postMessage({flushed:true});}};
  }
  flush() {
    if(!this.frames)return;
    const input=new Float32Array(this.frames);let offset=0;
    for(const block of this.buffer){input.set(block,offset);offset+=block.length;}
    const count=Math.floor(input.length*16000/sampleRate),out=new Float32Array(count);
    for(let i=0;i<count;i++){
      const begin=i*sampleRate/16000,end=(i+1)*sampleRate/16000;let sum=0,weight=0;
      for(let j=Math.floor(begin);j<Math.ceil(end)&&j<input.length;j++){
        const width=Math.max(0,Math.min(end,j+1)-Math.max(begin,j));sum+=input[j]*width;weight+=width;
      }
      out[i]=Math.max(-1,Math.min(1,weight?sum/weight:0));
    }
    this.buffer=[];this.frames=0;
    this.port.postMessage({pcm:out},[out.buffer]);
  }
  process(inputs) {
    const samples=inputs[0]?.[0];
    if(samples){this.buffer.push(samples.slice());this.frames+=samples.length;}
    if(this.frames>=sampleRate*.2)this.flush();
    return true;
  }
}
registerProcessor('tepora-stream-pcm',TeporaStreamPCM);

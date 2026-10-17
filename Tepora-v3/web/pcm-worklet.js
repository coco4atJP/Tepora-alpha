/* Native-rate input to 16 kHz Float32 PCM, in 200 ms chunks.
 * Streaming area averaging keeps fractional boundaries between render blocks.
 * A fixed 3200-sample output buffer also works at 44.1 kHz. No audio is persisted.
 */
class TeporaStreamPCM extends AudioWorkletProcessor {
  constructor(options={}) {
    super();this.buffer=new Float32Array(3200);this.frames=0;this.weight=0;this.sum=0;
    // Hands-free opts into two unacknowledged messages (25.6 kB mono,
    // 51.2 kB paired), plus fixed producer buffers (12.8/25.6 kB). Default
    // realtime capture retains its existing delivery and explicit tail flush.
    this.bounded=options.processorOptions?.bounded===true;this.outstanding=0;this.overflow=false;
    this.referenceCapable=options.processorOptions?.referenceCapable===true;
    this.reference=false;this.referenceRevision=0;this.referenceSum=0;
    this.referenceBuffer=this.referenceCapable?new Float32Array(3200):null;
    this.port.onmessage=e=>{
      if(this.overflow)return;
      if(this.bounded&&e.data.ack===true)this.outstanding=Math.max(0,this.outstanding-1);
      if(this.referenceCapable&&typeof e.data.reference==='boolean'){
        this.reference=e.data.reference;this.referenceRevision=e.data.referenceRevision;
        // Never pair fractions or frames captured under another output mode.
        this.frames=0;this.sum=0;this.weight=0;this.referenceSum=0;
      }
      if(e.data.flush&&this.flush())this.port.postMessage({flushed:true});
    };
  }
  flush() {
    if(this.overflow)return false;
    if(!this.frames)return true;
    if(this.bounded&&this.outstanding>=2){
      this.overflow=true;this.frames=0;this.sum=0;this.weight=0;this.referenceSum=0;
      this.port.postMessage({overflow:true});return false;
    }
    const out=this.buffer.slice(0,this.frames);this.frames=0;
    if(this.bounded)this.outstanding++;
    if(this.reference){
      const reference=this.referenceBuffer.slice(0,out.length);
      this.port.postMessage({pcm:out,reference,referenceRevision:this.referenceRevision},[out.buffer,reference.buffer]);
    }else this.port.postMessage({pcm:out},[out.buffer]);
    return true;
  }
  process(inputs) {
    if(this.overflow)return false;
    const samples=inputs[0]?.[0];
    if(samples){const ratio=sampleRate/16000,referenceChannels=this.reference?(inputs[1]||[]):null;
      for(let i=0;i<samples.length;i++){const value=samples[i];let remaining=1,reference=0;
        if(this.reference){for(const channel of referenceChannels)reference+=channel[i]??0;reference/=referenceChannels.length||1;}
        while(remaining>1e-9){
          const width=Math.min(remaining,ratio-this.weight);
          this.sum+=value*width;this.weight+=width;remaining-=width;
          if(this.reference)this.referenceSum+=reference*width;
          if(this.weight>=ratio-1e-9){
            this.buffer[this.frames]=Math.max(-1,Math.min(1,this.sum/ratio));
            if(this.reference)this.referenceBuffer[this.frames]=Math.max(-1,Math.min(1,this.referenceSum/ratio));
            this.frames++;this.sum=0;this.weight=0;this.referenceSum=0;if(this.frames===3200&&!this.flush())return false;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('tepora-stream-pcm',TeporaStreamPCM);

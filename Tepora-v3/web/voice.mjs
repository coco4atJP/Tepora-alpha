/** User-initiated PCM capture only. Never use browser SpeechRecognition (may send audio to a cloud). */
export class VoiceCapture {
 constructor(){this.session=null;this.generation=0;}
 get stream(){return this.session?.stream||null;}
 get context(){return this.session?.context||null;}
 get node(){return this.session?.node||null;}
 get frames(){return this.session?.frames||[];}
 get timer(){return this.session?.timer||null;}
 current(session){return this.session===session&&session.generation===this.generation;}
 cancelled(){const error=new Error('音声入力は取り消されました。');error.name='AbortError';return error;}
 check(session){if(!this.current(session))throw this.cancelled();}
 stopTracks(stream){for(const track of stream?.getTracks()||[])try{track.stop();}catch{}}
 releaseURL(session){if(session.url){URL.revokeObjectURL(session.url);session.url=null;}}
 cleanup(session){
  if(session.cleanup)return session.cleanup;
  clearTimeout(session.timer);session.timer=null;this.releaseURL(session);
  if(session.node)session.node.port.onmessage=null;
  for(const node of [session.source,session.node,session.mute])try{node?.disconnect();}catch{}
  this.stopTracks(session.stream);
  const context=session.context;
  session.stream=null;session.context=null;session.source=null;session.node=null;session.mute=null;
  session.cleanup=(async()=>{try{if(context&&context.state!=='closed')await context.close();}catch{}})();
  return session.cleanup;
 }
 async start(onLimit){
  if(this.session)throw new Error('録音中です。');
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('この表示環境ではマイクを利用できません。ローカルアプリを起動してください。');
  const session={generation:++this.generation,frames:[],ready:false};this.session=session;
  try{
   const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
   // Permission can resolve after cancel, or after another recording has started.
   if(!this.current(session)){this.stopTracks(stream);throw this.cancelled();}
   session.stream=stream;
   const context=new AudioContext();session.context=context;
   await context.resume();this.check(session);
   const code=`class TeporaPCM extends AudioWorkletProcessor{process(inputs){const a=inputs[0]?.[0];if(a)this.port.postMessage(a.slice());return true;}}registerProcessor('tepora-pcm',TeporaPCM);`;
   session.url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
   try{await context.audioWorklet.addModule(session.url);}finally{this.releaseURL(session);}
   this.check(session);
   session.node=new AudioWorkletNode(context,'tepora-pcm');
   session.node.port.onmessage=e=>{if(this.current(session)&&session.ready&&!session.stopping)session.frames.push(e.data);};
   session.source=context.createMediaStreamSource(stream);session.mute=context.createGain();session.mute.gain.value=0;
   session.source.connect(session.node);session.node.connect(session.mute);session.mute.connect(context.destination);
   session.ready=true;
   session.timer=setTimeout(()=>{if(this.current(session)&&!session.stopping)onLimit?.();},60000);
  }catch(error){
   const current=this.current(session);
   if(current)this.session=null;
   session.frames=[];await this.cleanup(session);
   throw current?error:this.cancelled();
  }
 }
 async stop(){
  const session=this.session;
  if(!session?.ready)throw new Error('録音を開始してください。');
  if(session.stopping)return session.stopping;
  const frames=session.frames,rate=session.context.sampleRate;session.frames=[];
  session.stopping=(async()=>{
   await this.cleanup(session);this.check(session);this.session=null;
   const length=frames.reduce((n,a)=>n+a.length,0);
   if(length<rate*.2)throw new Error('録音が短すぎます。もう一度お話しください。');
   const out=new ArrayBuffer(44+length*2),v=new DataView(out);
   const str=(p,s)=>{for(let i=0;i<s.length;i++)v.setUint8(p+i,s.charCodeAt(i));};
   str(0,'RIFF');v.setUint32(4,36+length*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,length*2,true);
   let offset=44;for(const a of frames)for(const f of a){v.setInt16(offset,Math.max(-1,Math.min(1,f))*(f<0?32768:32767),true);offset+=2;}
   return new Blob([out],{type:'audio/wav'});
  })();
  return session.stopping;
 }
 async cancel(){
  const session=this.session;this.session=null;++this.generation;
  if(session){session.frames=[];await this.cleanup(session);}
 }
}

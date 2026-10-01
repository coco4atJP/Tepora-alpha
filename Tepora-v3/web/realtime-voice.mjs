/** Local PCM transport only. Partial text is presentation, never an executable instruction. */
export class RealtimeVoiceCapture {
  constructor(bridge){this.bridge=bridge;this.session=null;this.generation=0;}
  get running(){return this.session?.running||false;}
  get stopping(){return !!this.session?.stopping;}
  get failing(){return !!this.session?.failing;}
  get id(){return this.session?.id||null;}
  get stream(){return this.session?.stream||null;}
  get context(){return this.session?.context||null;}
  get node(){return this.session?.node||null;}
  get source(){return this.session?.source||null;}
  get mute(){return this.session?.mute||null;}
  get queue(){return this.session?.queue||[];}
  get sequence(){return this.session?.sequence||0;}
  get pumping(){return this.session?.pumping||null;}
  get timer(){return this.session?.timer||null;}
  current(session){return !!session&&this.session===session&&session.generation===this.generation;}
  cancelled(){const error=new Error('音声入力は取り消されました。');error.name='AbortError';return error;}
  check(session){if(!this.current(session))throw this.cancelled();}
  stopTracks(stream){for(const track of stream?.getTracks()||[])try{track.stop();}catch{}}
  async start({onPartial=()=>{},onFinal=()=>{},onError=()=>{}}={}){
    if(this.session)throw new Error('音声入力は既に起動しています。');
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('この表示環境ではマイクを利用できません。文字入力は使えます。');
    const session={generation:++this.generation,running:false,queue:[],sequence:0,onPartial,onFinal,onError};
    this.session=session;
    try{
      const remote=await this.bridge.request('/api/voice/start','POST',{});
      // Even a late response belongs to this session and must be cancelled remotely.
      session.id=remote.id;this.check(session);
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(!this.current(session)){this.stopTracks(stream);throw this.cancelled();}
      session.stream=stream;
      const context=new AudioContext();session.context=context;
      await context.audioWorklet.addModule('/pcm-worklet.js');this.check(session);
      const node=new AudioWorkletNode(context,'tepora-stream-pcm');session.node=node;
      node.port.onmessage=e=>{
        if(!this.current(session)||!session.running)return;
        const data=e.data;
        if(data.pcm?.length){
          if(session.queue.length>=25){void this.fail(new Error('音声処理が追いついていません。入力を停止し、下書きを保護しました。'),session);return;}
          session.queue.push(data.pcm);void this.pump(session);
        }
        if(data.flushed)session.flushResolve?.();
      };
      session.source=context.createMediaStreamSource(stream);session.mute=context.createGain();session.mute.gain.value=0;
      session.source.connect(node);node.connect(session.mute);session.mute.connect(context.destination);
      await context.resume();this.check(session);session.running=true;
      session.timer=setTimeout(()=>{if(this.current(session))void this.stop(session).catch(()=>{});},118000);
      session.track=stream.getAudioTracks()[0];
      session.onEnded=()=>{if(this.current(session)&&session.running&&!session.stopping)void this.fail(new Error('マイクが切断されました。既存の下書きは保持しています。'),session);};
      session.track?.addEventListener('ended',session.onEnded);
    }catch(error){
      const current=this.current(session);
      if(current)this.session=null;
      session.running=false;session.queue=[];
      await this.cleanup(session);await this.cancelRemote(session);
      throw current?error:this.cancelled();
    }
  }
  pump(session=this.session){
    if(!this.current(session)||!session.running)return Promise.resolve();
    if(session.pumping)return session.pumping;
    session.pumping=(async()=>{
      while(this.current(session)&&session.queue.length&&session.running){
        const pcm=session.queue.shift(),bytes=new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength);
        const encoded=btoa(String.fromCharCode(...bytes));
        const result=await this.bridge.request('/api/voice/chunk','POST',{id:session.id,sequence:session.sequence,pcm:encoded});
        if(!this.current(session)||!session.running)return;
        session.sequence++;session.onPartial(result.text);
      }
    })().catch(error=>{if(this.current(session)&&session.running)return this.fail(error,session);}).finally(()=>{session.pumping=null;});
    return session.pumping;
  }
  async stop(session=this.session){
    if(!this.current(session)||!session.running)return;
    if(session.stopping)return session.stopping;
    clearTimeout(session.timer);session.timer=null;
    session.stopping=(async()=>{
      try{
        // Preserve the tail shorter than 200 ms before disconnecting the audio graph.
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>session.flushResolve?.(),1000);
          session.flushResolve=()=>{clearTimeout(timer);session.flushResolve=null;resolve();};
          try{session.node.port.postMessage({flush:true});}catch(error){clearTimeout(timer);session.flushResolve=null;reject(error);}
        });
        if(!this.current(session)||!session.running)return;
        await this.cleanup(session);
        if(!this.current(session)||!session.running)return;
        while(session.queue.length||session.pumping){await this.pump(session);if(!this.current(session)||!session.running)return;}
        const result=await this.bridge.request('/api/voice/finish','POST',{id:session.id});
        if(!this.current(session)||!session.running)return;
        session.running=false;session.id=null;this.session=null;
        session.onFinal(result.text);
      }catch(error){
        if(!this.current(session))return;
        await this.fail(error,session);throw error;
      }finally{await this.cleanup(session);}
    })();
    return session.stopping;
  }
  fail(error,session=this.session){
    if(!this.current(session))return Promise.resolve();
    if(session.failing)return session.failing;
    session.running=false;session.queue=[];
    session.failing=(async()=>{
      await this.cleanup(session);await this.cancelRemote(session);
      // Explicit cancellation or replacement during cleanup suppresses the old error too.
      if(!this.current(session))return;
      this.session=null;++this.generation;session.onError(error);
    })();
    return session.failing;
  }
  cleanup(session=this.session){
    if(!session)return Promise.resolve();
    if(session.cleanup)return session.cleanup;
    clearTimeout(session.timer);session.timer=null;session.flushResolve?.();
    session.track?.removeEventListener('ended',session.onEnded);
    if(session.node)session.node.port.onmessage=null;
    for(const node of [session.source,session.node,session.mute])try{node?.disconnect();}catch{}
    this.stopTracks(session.stream);
    const context=session.context;
    session.stream=null;session.context=null;session.node=null;session.source=null;session.mute=null;
    session.cleanup=(async()=>{try{if(context&&context.state!=='closed')await context.close();}catch{}})();
    return session.cleanup;
  }
  async cancelRemote(session){
    const id=session.id;session.id=null;
    if(id)session.remoteCancel=Promise.resolve().then(()=>this.bridge.request('/api/voice/cancel','POST',{id})).catch(()=>{});
    await session.remoteCancel;
  }
  async cancel(){
    const session=this.session;this.session=null;++this.generation;
    if(!session)return;
    session.running=false;session.queue=[];
    await this.cleanup(session);await this.cancelRemote(session);
  }
}

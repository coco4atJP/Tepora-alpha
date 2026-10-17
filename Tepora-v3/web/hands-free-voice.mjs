/** One opt-in microphone, one local worker request at a time. No audio storage.
 * Wake inference is separate from ASR; the latter receives only an awake turn.
 * Default half duplex; opt-in interruption pairs local playback with live PCM.
 */
export class HandsFreeMicrophone {
 constructor({bargeIn=false}={}){this.closed=false;this.bargeIn=bargeIn===true;this.outputs=new WeakMap();this.outputSources=new Set();this.audibleSources=new Set();this.outputAudio=null;this.referenceRevision=0;}
 async start(onFrame,onError){
  try{
   if(!navigator.mediaDevices?.getUserMedia)throw Error('この環境ではマイクを利用できません。');
   const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   this.stream=stream;if(this.closed){this.close();throw this.abort();}
   this.track=stream.getAudioTracks()[0];
   if(this.bargeIn&&!this.echoCancelled())throw Error('エコー除去が有効なマイクを確認できません。音声割り込みを無効にして待機を開始し直してください。');
   const context=new AudioContext();this.context=context;
   await context.audioWorklet.addModule('/pcm-worklet.js');if(this.closed)throw this.abort();
   this.node=new AudioWorkletNode(context,'tepora-stream-pcm',this.bargeIn?{numberOfInputs:2,processorOptions:{bounded:true,referenceCapable:true}}:{processorOptions:{bounded:true}});
   this.node.port.onmessage=e=>{
    if(this.closed)return;
    if(e.data.overflow){this.close();onError(Error('音声の受信が追いつかないためミュートしました。待機を開始し直してください。'));return;}
    if(e.data.pcm?.length){
     this.node.port.postMessage({ack:true});
     // A posted frame can outlive a reference detach/reattach. Return its
     // credit, but never use an earlier playback's samples for this output.
     if(this.referenceAttached){if(e.data.reference?.length&&e.data.referenceRevision===this.referenceRevision)onFrame(e.data.pcm,e.data.reference);}
     else if(!e.data.reference)onFrame(e.data.pcm);
    }
   };
   this.source=context.createMediaStreamSource(stream);this.mute=context.createGain();this.mute.gain.value=0;
   this.source.connect(this.node);this.node.connect(this.mute);this.mute.connect(context.destination);
   await context.resume();if(this.closed)throw this.abort();
   this.onEnded=()=>onError(Error('マイクが切断または停止されました。待機を開始し直してください。'));
   this.track?.addEventListener('ended',this.onEnded);this.track?.addEventListener('mute',this.onEnded);
   context.onstatechange=()=>{if(!this.closed&&context.state!=='running')onError(Error('音声処理が休止しました。待機を開始し直してください。'));};
  }catch(error){this.close();throw error;}
 }
 echoCancelled(){try{return this.track?.getSettings?.().echoCancellation===true;}catch{return false;}}
 attachOutput(audio){
  if(this.closed||!this.bargeIn||!this.node||this.context?.state!=='running'||!this.echoCancelled())return false;
  if(this.outputAudio&&this.outputAudio!==audio)this.retireOutput(this.outputAudio);
  else this.releaseOutput();
  try{
   let source=this.outputs.get(audio);
   if(!source){
    source=this.context.createMediaElementSource(audio);this.outputs.set(audio,source);
    // Creating a media element source reroutes playback through this graph.
    // Keep the audible destination connected even after reference release.
   }
   this.outputAudio=audio;this.outputSources.add(source);
   if(!this.audibleSources.has(source)){source.connect(this.context.destination);this.audibleSources.add(source);}
   source.connect(this.node,0,1);this.outputSource=source;this.referenceAttached=true;
   this.node.port.postMessage({reference:true,referenceRevision:++this.referenceRevision});return true;
  }catch{
   this.releaseOutput();return false;
  }
 }
 releaseOutput(){
  if(this.closed)return false;
  const source=this.outputSource;this.outputSource=null;
  if(source)try{source.disconnect(this.node,0,1);}catch{}
  if(this.referenceAttached){this.referenceAttached=false;try{this.node?.port.postMessage({reference:false,referenceRevision:++this.referenceRevision});}catch{}}
  return true;
 }
 retireOutput(audio){
  if(this.closed)return false;
  const source=this.outputs.get(audio);if(!source)return false;
  if(this.outputAudio===audio){this.releaseOutput();this.outputAudio=null;}
  // Keep only a weak cache: the browser permits one source per element, but
  // completed clips must not accumulate in the live microphone's graph/Sets.
  try{source.disconnect();}catch{}
  this.outputSources.delete(source);this.audibleSources.delete(source);return true;
 }
 abort(){return Object.assign(Error('音声待機を取り消しました。'),{name:'AbortError'});}
 close(){
  this.releaseOutput();
  this.closed=true;
  for(const track of this.stream?.getTracks()||[]){track.removeEventListener('ended',this.onEnded);track.removeEventListener('mute',this.onEnded);try{track.stop();}catch{}}
  this.stream=null;if(this.node)this.node.port.onmessage=null;
  for(const node of [this.source,this.node,this.mute])try{node?.disconnect();}catch{}
  for(const source of this.outputSources)try{source.disconnect();}catch{}
  this.outputSources.clear();this.audibleSources.clear();this.outputs=new WeakMap();this.outputAudio=null;this.track=null;
  this.source=this.node=this.mute=null;
  const context=this.context;this.context=null;if(context){context.onstatechange=null;if(context.state!=='closed')void context.close().catch(()=>{});}
 }
}

export class HandsFreeVoice {
 constructor({bridge,audioFactory=options=>new HandsFreeMicrophone(options),onState=()=>{},onWake=()=>true,onPartial=()=>{},onUtterance=async()=>{},onError=()=>{},stopOutput=()=>{},pauseOutput=()=>null,now=()=>Date.now(),setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id)}={}){
  Object.assign(this,{bridge,audioFactory,onState,onWake,onPartial,onUtterance,onError,stopOutput,pauseOutput,now,setTimer,clearTimer});
  this.session=null;this.state='off';this.draining=Promise.resolve();this.output=false;this.outputRevision=0;
  this.stats={frames:0,wakes:0,utterances:0,maxQueued:0,overflows:0,bargeCandidates:0,bargeConfirmed:0};
 }
 get active(){return !!this.session;}
 current(s){return this.session===s&&!s.abort.signal.aborted;}
 stateTo(state){this.state=state;this.onState(state);}
 timer(s,key,ms,fn){this.clearTimer(s.timers.get(key));const id=this.setTimer(()=>{if(s.timers.get(key)!==id)return;s.timers.delete(key);if(this.current(s))fn();},ms);s.timers.set(key,id);}
 clearTimers(s){for(const timer of s.timers.values())this.clearTimer(timer);s.timers.clear();}
 async request(s,route,body){
  const value=await this.bridge.request('/api/voice/'+route,'POST',body,{}, {signal:AbortSignal.any([s.abort.signal,AbortSignal.timeout(20000)])});
  if(!this.current(s))throw Object.assign(Error('Cancelled'),{name:'AbortError'});return value;
 }
 async open(s,wake){
  // Keep start response ownership even after mute so a late worker id is freed.
  const remote=await this.bridge.request('/api/voice/'+(wake==='barge'?'barge/start':wake?'wake/start':'start'),'POST',{});
  if(!this.current(s)){await this.closeId(remote.id);throw Object.assign(Error('Cancelled'),{name:'AbortError'});}
  s.id=remote.id;s.sequence=0;s.wake=wake;
 }
 closeId(id){return id?this.bridge.request('/api/voice/cancel','POST',{id},{},{signal:AbortSignal.timeout(20000)}).catch(()=>{}):Promise.resolve();}
 async closeRemote(s){const id=s.id;s.id=null;await this.closeId(id);}
 async enable({bargeIn=false,echoTailMs=1200,confirmationMs=5000}={}){
  if(this.active)return;
  if(typeof bargeIn!=='boolean'||!Number.isInteger(echoTailMs)||echoTailMs<800||echoTailMs>3000||!Number.isInteger(confirmationMs)||confirmationMs<2000||confirmationMs>10000)throw Error('音声割り込みの待ち時間が不正です。');
  const s={abort:new AbortController(),queue:[],timers:new Map(),id:null,lastFrame:this.now(),lastTick:this.now(),bargeIn,echoTailMs,confirmationMs};
  this.session=s;this.stateTo('starting');
  try{
   await this.draining;if(!this.current(s))return;
   await this.open(s,true);s.audio=this.audioFactory({bargeIn});
   await s.audio.start((pcm,reference)=>this.receive(s,pcm,reference),error=>this.fail(s,error));
   if(!this.current(s)){s.audio.close();return;}
   // Permission, module loading and context resume can take arbitrarily long.
   // Heartbeat/sleep checks begin when capture is actually ready.
   s.lastFrame=s.lastTick=this.now();
   if(this.state==='starting')this.stateTo(this.output?'speaking':'idle');this.renew(s);this.watch(s);
  }catch(error){if(this.current(s))this.fail(s,error);}
 }
 disable(state='off'){
  const s=this.session;this.session=null;this.output=false;this.stateTo(state);this.stopOutput();
  if(!s)return this.draining;
  s.abort.abort();s.queue=[];this.clearTimers(s);s.audio?.close();
  this.draining=Promise.allSettled([this.draining,this.closeRemote(s)]);return this.draining;
 }
 fail(s,error){if(this.current(s)){void this.disable('error');this.onError(error);}}
 watch(s){this.timer(s,'watch',1000,()=>{
  const time=this.now();if(time-s.lastTick>10000||time-s.lastFrame>5000){void this.disable('suspended');return;}
  s.lastTick=time;this.watch(s);
 });}
 renew(s){this.timer(s,'renew',110000,()=>{s.renew=true;if(['idle','barge-listening'].includes(this.state))void this.pump(s);});}
 receive(s,pcm,reference){
  if(!this.current(s))return;s.lastFrame=this.now();this.stats.frames++;
  const barge=this.state==='barge-listening';
  if(this.output&&!barge||!['idle','waking','listening','barge-listening','barge-confirm'].includes(this.state))return;
  if(!(pcm instanceof Float32Array)||!pcm.length||pcm.length>4000||pcm.some(v=>!Number.isFinite(v)||Math.abs(v)>1.01)){this.fail(s,Error('マイクの音声形式が不正です。'));return;}
  // A pending mono block from before reference attachment cannot establish
  // near-end speech. Wait for an aligned pair from the same render clock.
  if(barge&&reference===undefined)return;
  if(barge&&(!(reference instanceof Float32Array)||reference.length!==pcm.length||reference.some(v=>!Number.isFinite(v)||Math.abs(v)>1.01))){this.fail(s,Error('再生音の参照信号が不正です。'));return;}
  if(s.queue.length>=10){this.stats.overflows++;this.fail(s,Error('音声処理が追いつかないためミュートしました。待機を開始し直してください。'));return;}
  s.queue.push(barge?{pcm,reference}:pcm);this.stats.maxQueued=Math.max(this.stats.maxQueued,s.queue.length);void this.pump(s);
 }
 async arm(s,afterTail=false){
  if(!this.current(s))return;s.queue=[];
  await this.closeRemote(s);if(!this.current(s))return;
  if(this.output){this.stateTo('speaking');if(s.bargeIn&&s.outputAudio)this.prepareBarge(s,s.outputAudio);return;}
  if(this.state==='cooldown'&&!afterTail)return;
  this.stateTo('starting');await this.open(s,true);if(!this.current(s))return;
  if(this.output||this.state!=='starting')return;
  s.renew=false;this.stateTo('idle');this.renew(s);
 }
 prepareBarge(s,audio){
  if(!this.current(s)||!s.bargeIn||!this.output||!audio)return;
  s.outputAudio=audio;
  const start=()=>{
   if(!this.output||s.outputAudio!==audio||s.confirming)return;
   if(s.pumping){this.timer(s,'barge-start',100,start);return;}
   s.pumping=true;s.queue=[];
   void (async()=>{
    await this.closeRemote(s);if(!this.current(s)||!this.output||s.outputAudio!==audio)return;
    if(!s.audio.attachOutput?.(audio))throw Error('再生音の参照を取得できないため、音声割り込みを開始できません。');
    await this.open(s,'barge');if(!this.current(s)||!this.output||s.outputAudio!==audio)return;
    s.renew=false;this.stateTo('barge-listening');this.renew(s);
   })().catch(error=>this.fail(s,error)).finally(()=>{s.pumping=false;});
  };
  this.timer(s,'barge-start',0,start);
 }
 clearBargeTimers(s){for(const key of ['barge-start','barge-tail','barge-confirm']){this.clearTimer(s.timers.get(key));s.timers.delete(key);}}
 async candidate(s){
  const audio=s.outputAudio,revision=this.outputRevision;
  s.queue=[];s.confirming=true;this.stateTo('barge-quiet');this.stats.bargeCandidates++;
  if(!this.current(s)||!s.confirming||s.outputAudio!==audio||this.outputRevision!==revision)return;
  const handle=this.pauseOutput();
  if(!handle){s.confirming=false;await this.closeRemote(s);if(this.current(s))this.prepareBarge(s,s.outputAudio);return;}
  if(!this.current(s)||!s.confirming||s.outputAudio!==audio||this.outputRevision!==revision)return;
  // HTMLMediaElement.pause() changes `paused` now and queues its event. A fast
  // worker response must not depend on that later event establishing quiet.
  if(audio?.paused!==true)throw Error('読み上げの一時停止を確認できません。');
  s.bargePause=handle;this.output=false;
  await this.closeRemote(s);if(!this.current(s)||!s.confirming||s.bargePause!==handle||this.output)return;
  s.audio.releaseOutput?.();
  const confirm=()=>{
   if(this.output||s.outputAudio?.paused!==true){void this.resumeBarge(s).catch(error=>this.fail(s,error));return;}
   if(s.pumping){this.timer(s,'barge-tail',100,confirm);return;}
   s.pumping=true;
   void (async()=>{
    await this.open(s,true);if(!this.current(s)||!s.confirming||s.bargePause!==handle||this.output)return;
    this.stateTo('barge-confirm');
    this.timer(s,'barge-confirm',s.confirmationMs,()=>{void this.resumeBarge(s).catch(error=>this.fail(s,error));});
   })().catch(error=>this.fail(s,error)).finally(()=>{s.pumping=false;});
  };
  this.timer(s,'barge-tail',s.echoTailMs,confirm);
 }
 async resumeBarge(s){
  if(!this.current(s)||!s.confirming)return;
  if(s.pumping){this.timer(s,'barge-confirm',100,()=>{void this.resumeBarge(s).catch(error=>this.fail(s,error));});return;}
  s.pumping=true;
  const handle=s.bargePause,audio=s.outputAudio,revision=this.outputRevision;
  try{
   this.clearBargeTimers(s);s.queue=[];await this.closeRemote(s);
   if(!this.current(s)||!s.confirming||s.bargePause!==handle||this.outputRevision!==revision||this.output)return;
   s.bargePause=null;s.confirming=false;this.stateTo('speaking');
   const resumed=await handle?.resume();if(!this.current(s))return;
   if(!resumed&&!this.output&&s.outputAudio===audio){s.audio.retireOutput?.(audio);s.outputAudio=null;await this.arm(s,true);}
  }finally{s.pumping=false;}
 }
 async beginListening(s,revision){
  if(this.onWake()===false){await this.arm(s);return;}
  if(!this.current(s)||this.output||this.outputRevision!==revision)return;
  this.stats.wakes++;this.stateTo('waking');await this.closeRemote(s);
  if(!this.current(s))return;await this.open(s,false);
  if(this.output||['speaking','cooldown'].includes(this.state))return;
  s.samples=0;s.voiced=0;s.silence=0;this.stateTo('listening');
  this.timer(s,'utterance',22000,()=>this.fail(s,Error('音声入力が時間内に完了しなかったためミュートしました。')));
 }
 async pump(s){
  if(s.pumping||!this.current(s))return;s.pumping=true;
  try{
   if(s.renew&&this.state==='idle')await this.arm(s);
   if(s.renew&&this.state==='barge-listening'){this.prepareBarge(s,s.outputAudio);return;}
   while(this.current(s)&&s.queue.length&&['idle','listening','barge-listening','barge-confirm'].includes(this.state)&&(!this.output||this.state==='barge-listening')){
    const queued=s.queue.shift(),pcm=queued.pcm||queued,phase=this.state,outputRevision=this.outputRevision;
    let transport=pcm;
    if(phase==='barge-listening'){transport=new Float32Array(pcm.length*2);for(let i=0;i<pcm.length;i++){transport[i*2]=pcm[i];transport[i*2+1]=queued.reference[i];}}
    const bytes=new Uint8Array(transport.buffer,transport.byteOffset,transport.byteLength);
    const result=await this.request(s,'chunk',{id:s.id,sequence:s.sequence++,pcm:btoa(String.fromCharCode(...bytes))});
    if(this.output&&phase!=='barge-listening'||this.outputRevision!==outputRevision||this.state!==phase)break;
    if(phase!=='listening'){
     if(typeof result.detected!=='boolean')throw Error('ローカル検出ワーカーの応答が不正です。');
     if(!result.detected)continue;
     if(phase==='barge-listening'){await this.candidate(s);break;}
     if(phase==='barge-confirm'){
      this.clearBargeTimers(s);s.bargePause?.cancel();s.audio.retireOutput?.(s.outputAudio);s.bargePause=null;s.confirming=false;s.outputAudio=null;this.output=false;this.stats.bargeConfirmed++;
     }
     await this.beginListening(s,outputRevision);break;
    }else{
     this.onPartial(typeof result.text==='string'?result.text:'');
     if(!this.current(s))return;if(this.output||this.outputRevision!==outputRevision)break;
     const energy=Math.sqrt(pcm.reduce((sum,v)=>sum+v*v,0)/pcm.length);
     s.samples+=pcm.length;
     if(energy>=.012){s.voiced+=pcm.length;s.silence=0;}else s.silence+=pcm.length;
     if(s.voiced>=4800&&s.silence>=12800||s.samples>=320000){await this.finish(s);break;}
     if(s.voiced<4800&&s.samples>=96000){this.clearTimer(s.timers.get('utterance'));s.timers.delete('utterance');await this.arm(s);break;}
    }
   }
  }catch(error){this.fail(s,error);}finally{s.pumping=false;if(['speaking','cooldown'].includes(this.state)){this.clearTimer(s.timers.get('utterance'));s.timers.delete('utterance');}}
 }
 async finish(s){
  const outputRevision=this.outputRevision;
  this.stateTo('endpointing');s.queue=[];this.clearTimer(s.timers.get('utterance'));s.timers.delete('utterance');
  const result=await this.request(s,'finish',{id:s.id});s.id=null;
  if(this.output||this.outputRevision!==outputRevision){await this.arm(s);return;}
  if(typeof result.text!=='string'||result.text.length>32000)throw Error('音声認識の応答が不正です。');
  this.stateTo('processing');
  if(result.text.trim()){this.stats.utterances++;await this.onUtterance(result.text,s.abort.signal);}
  if(this.current(s))await this.arm(s);
 }
 setSpeaking(active,audio=null){
  const previous=this.output;this.output=active;if(active)this.outputRevision++;const s=this.session;if(!s||!active&&!previous)return;
  if(s.confirming&&!active)return;
  if(active){
   if(s.outputAudio&&s.outputAudio!==audio)s.audio.retireOutput?.(s.outputAudio);
   this.clearBargeTimers(s);s.confirming=false;s.bargePause=null;s.outputAudio=audio;
   s.queue=[];if(!s.pumping){this.clearTimer(s.timers.get('utterance'));s.timers.delete('utterance');}this.stateTo('speaking');
   if(s.bargeIn&&audio)this.prepareBarge(s,audio);
  }
  else{
   this.clearBargeTimers(s);s.audio.retireOutput?.(s.outputAudio);s.outputAudio=null;s.audio.releaseOutput?.();
   this.stateTo('cooldown');
   const rearm=()=>{if(s.pumping){this.timer(s,'tail',100,rearm);return;}void this.arm(s,true).catch(error=>this.fail(s,error));};
   this.timer(s,'tail',800,rearm);
  }
 }
 /** Explicit interruption mutes immediately; rearming requires a fresh user action. */
 interrupt(){return this.disable('interrupted');}
}

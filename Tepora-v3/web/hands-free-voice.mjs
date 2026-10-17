/** One opt-in microphone, one local worker request at a time. No audio storage.
 * Wake inference is separate from ASR; the latter receives only an awake turn.
 * Half duplex: output is gated in software and followed by an acoustic tail.
 */
export class HandsFreeMicrophone {
 constructor(){this.closed=false;}
 async start(onFrame,onError){
  try{
   if(!navigator.mediaDevices?.getUserMedia)throw Error('この環境ではマイクを利用できません。');
   const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   this.stream=stream;if(this.closed){this.close();throw this.abort();}
   const context=new AudioContext();this.context=context;
   await context.audioWorklet.addModule('/pcm-worklet.js');if(this.closed)throw this.abort();
   this.node=new AudioWorkletNode(context,'tepora-stream-pcm',{processorOptions:{bounded:true}});
   this.node.port.onmessage=e=>{
    if(this.closed)return;
    if(e.data.overflow){this.close();onError(Error('音声の受信が追いつかないためミュートしました。待機を開始し直してください。'));return;}
    if(e.data.pcm?.length){this.node.port.postMessage({ack:true});onFrame(e.data.pcm);}
   };
   this.source=context.createMediaStreamSource(stream);this.mute=context.createGain();this.mute.gain.value=0;
   this.source.connect(this.node);this.node.connect(this.mute);this.mute.connect(context.destination);
   await context.resume();if(this.closed)throw this.abort();
   this.track=stream.getAudioTracks()[0];this.onEnded=()=>onError(Error('マイクが切断または停止されました。待機を開始し直してください。'));
   this.track?.addEventListener('ended',this.onEnded);this.track?.addEventListener('mute',this.onEnded);
   context.onstatechange=()=>{if(!this.closed&&context.state!=='running')onError(Error('音声処理が休止しました。待機を開始し直してください。'));};
  }catch(error){this.close();throw error;}
 }
 abort(){return Object.assign(Error('音声待機を取り消しました。'),{name:'AbortError'});}
 close(){
  this.closed=true;
  for(const track of this.stream?.getTracks()||[]){track.removeEventListener('ended',this.onEnded);track.removeEventListener('mute',this.onEnded);try{track.stop();}catch{}}
  this.stream=null;if(this.node)this.node.port.onmessage=null;
  for(const node of [this.source,this.node,this.mute])try{node?.disconnect();}catch{}
  this.source=this.node=this.mute=null;
  const context=this.context;this.context=null;if(context){context.onstatechange=null;if(context.state!=='closed')void context.close().catch(()=>{});}
 }
}

export class HandsFreeVoice {
 constructor({bridge,audioFactory=()=>new HandsFreeMicrophone(),onState=()=>{},onWake=()=>true,onPartial=()=>{},onUtterance=async()=>{},onError=()=>{},stopOutput=()=>{},now=()=>Date.now(),setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id)}={}){
  Object.assign(this,{bridge,audioFactory,onState,onWake,onPartial,onUtterance,onError,stopOutput,now,setTimer,clearTimer});
  this.session=null;this.state='off';this.draining=Promise.resolve();this.output=false;this.outputRevision=0;
  this.stats={frames:0,wakes:0,utterances:0,maxQueued:0,overflows:0};
 }
 get active(){return !!this.session;}
 current(s){return this.session===s&&!s.abort.signal.aborted;}
 stateTo(state){this.state=state;this.onState(state);}
 timer(s,key,ms,fn){this.clearTimer(s.timers.get(key));s.timers.set(key,this.setTimer(()=>{s.timers.delete(key);if(this.current(s))fn();},ms));}
 clearTimers(s){for(const timer of s.timers.values())this.clearTimer(timer);s.timers.clear();}
 async request(s,route,body){
  const value=await this.bridge.request('/api/voice/'+route,'POST',body,{}, {signal:AbortSignal.any([s.abort.signal,AbortSignal.timeout(20000)])});
  if(!this.current(s))throw Object.assign(Error('Cancelled'),{name:'AbortError'});return value;
 }
 async open(s,wake){
  // Keep start response ownership even after mute so a late worker id is freed.
  const remote=await this.bridge.request('/api/voice/'+(wake?'wake/start':'start'),'POST',{});
  if(!this.current(s)){await this.closeId(remote.id);throw Object.assign(Error('Cancelled'),{name:'AbortError'});}
  s.id=remote.id;s.sequence=0;s.wake=wake;
 }
 closeId(id){return id?this.bridge.request('/api/voice/cancel','POST',{id},{},{signal:AbortSignal.timeout(20000)}).catch(()=>{}):Promise.resolve();}
 async closeRemote(s){const id=s.id;s.id=null;await this.closeId(id);}
 async enable(){
  if(this.active)return;
  const s={abort:new AbortController(),queue:[],timers:new Map(),id:null,lastFrame:this.now(),lastTick:this.now()};
  this.session=s;this.stateTo('starting');
  try{
   await this.draining;if(!this.current(s))return;
   await this.open(s,true);s.audio=this.audioFactory();
   await s.audio.start(pcm=>this.receive(s,pcm),error=>this.fail(s,error));
   if(!this.current(s)){s.audio.close();return;}
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
 renew(s){this.timer(s,'renew',110000,()=>{s.renew=true;if(this.state==='idle')void this.pump(s);});}
 receive(s,pcm){
  if(!this.current(s))return;s.lastFrame=this.now();this.stats.frames++;
  if(this.output||!['idle','waking','listening'].includes(this.state))return;
  if(!(pcm instanceof Float32Array)||!pcm.length||pcm.length>4000||pcm.some(v=>!Number.isFinite(v)||Math.abs(v)>1.01)){this.fail(s,Error('マイクの音声形式が不正です。'));return;}
  if(s.queue.length>=10){this.stats.overflows++;this.fail(s,Error('音声処理が追いつかないためミュートしました。待機を開始し直してください。'));return;}
  s.queue.push(pcm);this.stats.maxQueued=Math.max(this.stats.maxQueued,s.queue.length);void this.pump(s);
 }
 async arm(s,afterTail=false){
  if(!this.current(s))return;s.queue=[];
  await this.closeRemote(s);if(!this.current(s))return;
  if(this.output){this.stateTo('speaking');return;}
  if(this.state==='cooldown'&&!afterTail)return;
  this.stateTo('starting');await this.open(s,true);if(!this.current(s))return;
  if(this.output||this.state!=='starting')return;
  s.renew=false;this.stateTo('idle');this.renew(s);
 }
 async pump(s){
  if(s.pumping||!this.current(s))return;s.pumping=true;
  try{
   if(s.renew&&this.state==='idle')await this.arm(s);
   while(this.current(s)&&s.queue.length&&['idle','listening'].includes(this.state)&&!this.output){
    const pcm=s.queue.shift(),bytes=new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength),phase=this.state,outputRevision=this.outputRevision;
    const result=await this.request(s,'chunk',{id:s.id,sequence:s.sequence++,pcm:btoa(String.fromCharCode(...bytes))});
    if(this.output||this.outputRevision!==outputRevision||this.state!==phase)break;
    if(this.state==='idle'){
     if(typeof result.detected!=='boolean')throw Error('ローカル検出ワーカーの応答が不正です。');
     if(!result.detected)continue;
     if(this.onWake()===false){await this.arm(s);break;}
     if(!this.current(s))return;if(this.output||this.outputRevision!==outputRevision)break;
     this.stats.wakes++;this.stateTo('waking');await this.closeRemote(s);
     if(!this.current(s))return;await this.open(s,false);
     if(this.output||['speaking','cooldown'].includes(this.state))break;
     s.samples=0;s.voiced=0;s.silence=0;this.stateTo('listening');
     this.timer(s,'utterance',22000,()=>this.fail(s,Error('音声入力が時間内に完了しなかったためミュートしました。')));
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
 setSpeaking(active){
  const previous=this.output;this.output=active;if(active)this.outputRevision++;const s=this.session;if(!s||!active&&!previous)return;
  if(active){s.queue=[];if(!s.pumping){this.clearTimer(s.timers.get('utterance'));s.timers.delete('utterance');}this.stateTo('speaking');}
  else{
   this.stateTo('cooldown');
   const rearm=()=>{if(s.pumping){this.timer(s,'tail',100,rearm);return;}void this.arm(s,true).catch(error=>this.fail(s,error));};
   this.timer(s,'tail',800,rearm);
  }
 }
 /** Explicit interruption mutes immediately; rearming requires a fresh user action. */
 interrupt(){return this.disable('interrupted');}
}

import {randomUUID} from 'node:crypto';
import {endpoint,invariant} from './policy.mjs';

/** One microphone session, ordered PCM chunks, bounded memory, loopback only. */
export class SpeechStream {
  constructor(store,fetchImpl=fetch) {this.store=store;this.fetch=fetchImpl;this.sessions=new Map();this.starting=false;}
  async upstream(base,route,body) {
    const response=await this.fetch(`${base}${route}`,{
      method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json',...(process.env.TEPORA_SPEECH_TOKEN?{Authorization:`Bearer ${process.env.TEPORA_SPEECH_TOKEN}`}:{})},
      signal:AbortSignal.timeout(15000),body:JSON.stringify(body)
    });
    invariant(response.ok,`Local speech worker returned HTTP ${response.status}`,502);
    return response.json();
  }
  async start() {
    invariant(this.store.settings.voiceEnabled!==false,'Microphone is disabled',403);
    invariant(!this.starting&&!this.sessions.size,'A microphone session is already active',409);
    const base=endpoint(this.store.settings.asrStreamUrl,false).href.replace(/\/$/,'');
    this.starting=true;
    try {
      const result=await this.upstream(base,'/api/start',{sample_rate:16000});
      invariant(typeof result.session_id==='string'&&result.session_id.length<200,'Invalid speech session',502);
      const id=randomUUID();
      const session={id,base,upstreamId:result.session_id,next:0,samples:0,busy:false,text:'',last:null};
      session.timer=setTimeout(()=>this.cancel(id).catch(()=>{}),120000);
      session.timer.unref?.();
      this.sessions.set(id,session);
      return {id,sampleRate:16000,chunkMs:200,maxAudioSeconds:120};
    } finally {this.starting=false;}
  }
  session(id) {const s=this.sessions.get(id);invariant(s,'Speech session expired',409);return s;}
  async chunk({id,sequence,pcm}) {
    const s=this.session(id);
    invariant(Number.isSafeInteger(sequence)&&sequence>=0,'Invalid audio sequence');
    invariant(typeof pcm==='string'&&pcm.length>0&&pcm.length<=90000&&/^[A-Za-z0-9+/]*={0,2}$/.test(pcm),'Invalid PCM');
    // Retries acknowledge the same chunk only. Same sequence with different bytes is a conflict.
    if(s.last?.sequence===sequence) {
      invariant(s.last.pcm===pcm,'Audio sequence reused with different content',409);
      return s.last.reply;
    }
    invariant(!s.busy&&sequence===s.next,'Out-of-order or concurrent audio chunk',409);
    const data=Buffer.from(pcm,'base64');
    invariant(data.length>0&&data.length%4===0&&data.length<=64000,'Use at most one second of Float32 PCM');
    for(let i=0;i<data.length;i+=4) invariant(Number.isFinite(data.readFloatLE(i))&&Math.abs(data.readFloatLE(i))<=1.01,'Invalid audio sample');
    invariant(s.samples+data.length/4<=16000*120,'Speech session reached its two-minute budget',413);
    s.busy=true;
    try {
      const result=await this.upstream(s.base,'/api/chunk',{session_id:s.upstreamId,sequence,pcm});
      invariant(typeof result.text==='string'&&result.text.length<=32000,'Invalid partial transcript',502);
      s.samples+=data.length/4;s.next++;s.text=result.text;
      const reply={id,sequence,text:s.text,final:false};
      s.last={sequence,pcm,reply};return reply;
    } finally {s.busy=false;}
  }
  async finish(id) {
    const s=this.session(id);invariant(!s.busy,'Wait for the last audio chunk before finishing',409);
    s.busy=true;
    try {
      const result=await this.upstream(s.base,'/api/finish',{session_id:s.upstreamId});
      invariant(typeof result.text==='string'&&result.text.length<=32000,'Invalid final transcript',502);
      return {id,text:result.text,final:true,submitted:false};
    } finally {clearTimeout(s.timer);this.sessions.delete(id);}
  }
  async cancel(id) {
    const s=this.sessions.get(id);if(!s)return {cancelled:true};
    clearTimeout(s.timer);this.sessions.delete(id);
    try {await this.upstream(s.base,'/api/cancel',{session_id:s.upstreamId});} catch {}
    return {cancelled:true};
  }
  async close() {await Promise.all([...this.sessions.keys()].map(id=>this.cancel(id)));}
}

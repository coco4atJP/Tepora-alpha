import {validateRegistry} from './provider-registry.mjs';
import {boundedJSON} from './transport.mjs';
import {randomUUID,createHash} from 'node:crypto';
import os from 'node:os';
import {Runtime,PROVIDERS} from './runtime.mjs';
import {probeRuntime} from './probe.mjs';
import {destination} from './context.mjs';
import {endpoint,invariant,safeError,validateSettings} from './policy.mjs';

// These are download-size options, NOT a ranking or a claim of measured task quality.
export const MODEL_CATALOG=Object.freeze([
 {id:'compact',model:'qwen3:4b-instruct-2507-q4_K_M',label:'テキスト中心・小さめ',approxBytes:2_500_000_000,maxBytes:4_000_000_000,minRamGiB:8,source:'https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M'},
 {id:'general',model:'qwen3.5:4b',label:'画像も扱える候補',approxBytes:3_400_000_000,maxBytes:5_000_000_000,minRamGiB:12,source:'https://ollama.com/library/qwen3.5:4b'}
]);
const stamp=()=>new Date().toISOString();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const local=s=>['127.0.0.1','localhost','[::1]'].includes(new URL(s.baseUrl).hostname);
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const configuration=s=>hash([destination(s),s.apiKeyEnv,s.allowCloud,s.shareMemory,s.codexEnabled]);
export async function* pullPackets(body){
 invariant(body,'Download progress stream is missing',502);
 const decoder=new TextDecoder('utf-8',{fatal:true});let pending='';
 for await(const chunk of body){
  pending+=decoder.decode(chunk,{stream:true});invariant(pending.length<=262144,'Download progress frame is too large',502);
  let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).trim();pending=pending.slice(end+1);if(line)yield JSON.parse(line);}
 }
 pending+=decoder.decode();if(pending.trim())yield JSON.parse(pending);
}

/** Safe first-run setup; only a user action starts discovery, downloads, or inference.
 * No OS install script, arbitrary endpoint, credential harvesting, or unattended model launch.
 */
export class SetupManager{
 constructor(store,harness,{fetchImpl=fetch,providers=PROVIDERS,runtimeFactory,timeoutMs=45000}={}){
  Object.assign(this,{store,harness,fetch:fetchImpl,providers,runtimeFactory,timeoutMs});this.candidates=new Map();this.engines=new Map();this.active=null;this.probing=null;this.scanning=false;this.closed=false;
  const previous=store.value('setup-transfer');
  if(previous&&['downloading','checking'].includes(previous.status))this.setTransfer({...previous,status:'interrupted',note:'前回の取得は中断しました。再開するまでは通信しません。'});
 }
 snapshot(){
  const s=this.store.settings,p=this.store.value('model-probe');
  const verified=Boolean((local(s)||s.allowCloud)&&p?.passed&&p.destination===destination(s)&&Date.now()-Date.parse(p.checkedAt)<86400000);
  const first=this.store.list('session').find(x=>x.kind!=='main'&&['done','idle'].includes(x.status)&&x.result);
  return {dismissed:!!this.store.value('setup-dismissed'),configured:!!s.model,verified,checkedAt:verified?p.checkedAt:null,
   model:s.model,provider:s.provider,local:local(s),stage:first?'first-result':verified?'connected':'connect',firstResult:first?{id:first.id,title:first.title}:null,
   candidates:[...this.candidates.values()].map(({expiresAt,...c})=>c),engines:[...this.engines.values()].map(({expiresAt,...e})=>e),
   transfer:this.store.value('setup-transfer'),checking:!!this.probing,catalog:MODEL_CATALOG,ramGiB:Math.floor(os.totalmem()/2**30),
   note:verified?'この接続で道具の呼び出しを確認しました。依頼全体の品質・速度の保証ではありません。':'モデル未確認でも画面の表示設定は使えます。'};
 }
 emit(){if(this.closed||this.store.closed)return null;const value=this.snapshot();this.store.emit('setup.updated',value);return value;}
 dismiss(){this.store.value('setup-dismissed',true);return this.emit();}
 async getJSON(url,{signal,body}={}){
  const r=await this.fetch(url,{method:body?'POST':'GET',redirect:'error',headers:body?{'Content-Type':'application/json'}:{},
   signal:signal||AbortSignal.timeout(5000),...(body?{body:JSON.stringify(body)}:{})});
  invariant(r.ok,`接続先が応答しませんでした (HTTP ${r.status})`,502);
  return boundedJSON(r);
 }
 async scan(){
  invariant(!this.scanning,'接続先を確認しています。',429);this.scanning=true;
  const candidates=new Map(),engines=new Map();
  try{
   await Promise.all(this.providers.map(async p=>{
    try{
     const base=endpoint(p.url,false).href.replace(/\/$/,'');let models=[];
     if(p.id==='ollama'){
      const root=base.replace(/\/v1$/,''),data=await this.getJSON(`${root}/api/tags`);
      invariant(Array.isArray(data.models),'Invalid Ollama model list');
      const id=hash([p.id,root]);engines.set(id,{id,provider:p.id,name:p.name,baseUrl:root,expiresAt:Date.now()+600000});
      models=data.models.filter(m=>plain(m)&&typeof m.name==='string'&&!m.remote_host&&!m.remote_model&&!/(?:cloud|:latest-cloud)$/i.test(m.name))
       .map(m=>({model:m.name,digest:m.digest||null,bytes:m.size||null}));
     }else{
      const data=await this.getJSON(`${base}/models`);invariant(Array.isArray(data.data),'Invalid model list');
      models=data.data.filter(m=>typeof m.id==='string').map(m=>({model:m.id}));
     }
     for(const m of models.slice(0,100)){
      if(!m.model||m.model.length>500)continue;
      const id=hash([p.id,base,m.model,m.digest]);candidates.set(id,{id,provider:p.id,name:p.name,baseUrl:base,...m,expiresAt:Date.now()+600000});
     }
    }catch{/* Discovery failures are displayed as no ready candidates, never as invented connections. */}
   }));
   this.candidates=candidates;this.engines=engines;return this.emit();
  }finally{this.scanning=false;}
 }
 async select(id,{consentTest=false}={}){
  invariant(!this.harness.registry?.configured,'名前付きの接続が設定されています。接続先の変更は「知能と通信の使い分け」から行ってください。',409);
  invariant(consentTest===true,'接続確認には短いモデル呼び出しを行います。確認を許可してください。',403);
  invariant(!this.probing&&!this.active,'準備中の処理を終了してから接続を選んでください。',409);
  invariant(!this.harness.busy(),'仕事が進行中です。接続を切り替える前に停止してください。',409);
  const c=this.candidates.get(id);invariant(c&&c.expiresAt>Date.now(),'候補を再検索してください。',409);
  const registryRevision=this.harness.registry?.get().revision;
  const previous=configuration(this.store.settings),cancel=new AbortController();this.probing=cancel;this.emit();
  const settings=validateSettings({provider:c.provider,baseUrl:c.baseUrl,model:c.model,apiKeyEnv:''},this.store.settings);
  try{
   const runtime=this.runtimeFactory?this.runtimeFactory(settings,''):new Runtime(settings,'',this.fetch);
   const report=await probeRuntime(runtime,settings,AbortSignal.any([cancel.signal,AbortSignal.timeout(this.timeoutMs)]));
   cancel.signal.throwIfAborted();
   if(c.provider==='ollama'&&c.digest){
    const listing=await this.getJSON(`${c.baseUrl.replace(/\/v1$/,'')}/api/tags`,{signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(5000)])});
    invariant(listing.models?.some(m=>m.name===c.model&&m.digest===c.digest&&!m.remote_host&&!m.remote_model),'確認中にモデルが変更されました。再検索してください。',409);
   }
   invariant(previous===configuration(this.store.settings),'設定が変更されました。現在の設定を上書きしていません。',409);
   invariant(!this.harness.busy(),'確認中に仕事が始まったため切り替えていません。',409);
   let preset;
   if(this.harness.registry){
    invariant(this.harness.registry.get().revision===registryRevision,'接続設定が変更されました。現在の経路を上書きしません。',409);
    preset={profiles:[{id:'local-default',name:c.model,model:c.model,protocol:'chat-completions',baseUrl:c.baseUrl,domain:'device',capabilities:{text:true,tools:true,vision:null,structured:null}}],routes:{main:{primary:'local-default',fallbacks:[]}}};validateRegistry(preset);
   }
   this.store.db.exec('BEGIN IMMEDIATE');
   try{this.store.settings=settings;this.store.value('model-probe',report);
    if(preset){this.harness.registry.save(preset,registryRevision);const p=this.harness.registry.get().profiles[0];this.store.put('provider-probe',{...report,id:p.identity,profileId:p.id,ok:true,scope:'first-use safe tool roundtrip, not model quality'});}
    this.store.db.exec('COMMIT');
   }catch(e){this.store.db.exec('ROLLBACK');throw e;}
   this.store.emit('settings.updated',settings);if(preset)this.store.emit('providers.updated',this.harness.registry.publicSnapshot());return {activated:true,report};
  }finally{this.probing=null;this.emit();}
 }
 setTransfer(t){if(this.closed||this.store.closed)return t;this.store.value('setup-transfer',t);this.store.emit('setup.transfer',t);return t;}
 install({engineId,catalogId,consentDownload=false}){
  invariant(consentDownload===true,'モデル取得には外部通信と保存容量が必要です。',403);
  invariant(!this.active&&!this.probing,'別の準備処理が進行中です。',409);
  const e=this.engines.get(engineId),m=MODEL_CATALOG.find(m=>m.id===catalogId);
  invariant(e&&e.expiresAt>Date.now()&&m,'モデルと接続先をもう一度選んでください。',409);
  endpoint(e.baseUrl,false);const cancel=new AbortController();this.active=cancel;
  const t={id:randomUUID(),engineId,catalogId,model:m.model,baseUrl:e.baseUrl,status:'downloading',createdAt:stamp(),completedBytes:0,totalBytes:null,
   note:'モデルを取得しています。個人の会話やファイルは送信しません。保存先はOllamaが管理します。'};
  this.setTransfer(t);this.running=this.pull(t,m,cancel).finally(()=>{if(this.active===cancel)this.active=null;this.emit();});return t;
 }
 async pull(t,m,cancel){
  let idle;const heartbeat=()=>{clearTimeout(idle);idle=setTimeout(()=>cancel.abort(new Error('進捗が止まったため取得を中断しました。再開できます。')),60000);idle.unref?.();};
  try{
   heartbeat();
   const r=await this.fetch(`${t.baseUrl}/api/pull`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:m.model,stream:true,insecure:false}),signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(2*3600000)])});
   invariant(r.ok,`モデル取得を開始できません (HTTP ${r.status})`,502);
   const layers=new Map();let success=false,lastEmit=0;
   for await(const packet of pullPackets(r.body)){
    heartbeat();cancel.signal.throwIfAborted();invariant(plain(packet),'Invalid download progress',502);
    invariant(!packet.error,`モデル取得に失敗しました: ${String(packet.error).slice(0,200)}`,502);
    if(typeof packet.digest==='string'&&Number.isSafeInteger(packet.total)&&packet.total>=0){
     const done=packet.completed??0;invariant(Number.isSafeInteger(done)&&done>=0&&done<=packet.total,'Invalid download byte counts',502);
     invariant(packet.digest.length<200&&layers.size<128,'Too many download layers',502);layers.set(packet.digest,{total:packet.total,done});
     const total=[...layers.values()].reduce((n,l)=>n+l.total,0);invariant(total<=m.maxBytes,'表示した取得予算を超えたため停止しました。別の構成を確認してください。',413);
     Object.assign(t,{totalBytes:total,completedBytes:[...layers.values()].reduce((n,l)=>n+l.done,0)});
    }
    if(packet.status==='success')success=true;
    if(Date.now()-lastEmit>200){this.setTransfer({...t});lastEmit=Date.now();}
   }
   cancel.signal.throwIfAborted();invariant(success,'取得完了の応答がありません。再開して確認してください。',502);
   t.status='checking';this.setTransfer({...t});
   const data=await this.getJSON(`${t.baseUrl}/api/tags`,{signal:cancel.signal});
   invariant(data.models?.some(x=>x.name===m.model&&!x.remote_model&&!x.remote_host),'取得したモデルがローカル一覧にありません。',502);
   cancel.signal.throwIfAborted();
   this.setTransfer({...t,status:'downloaded',endedAt:stamp(),note:'取得しました。次にこのモデルの道具呼び出しを確認して接続します。'});await this.scan();
  }catch(error){
   this.setTransfer({...t,status:cancel.signal.aborted?'interrupted':'failed',endedAt:stamp(),note:safeError(error),
    recovery:'同じモデルを選ぶと、Ollamaに残る取得済みデータを利用して再取得します。他のアプリが使うモデルは削除しません。'});
  }finally{clearTimeout(idle);}
 }
 stop(){this.active?.abort(new Error('取得を中断しました。保存済みの部分はOllama側に残ります。'));this.probing?.abort(new Error('接続確認を取り消しました。'));return {stopping:!!this.active||!!this.probing};}
 async close(){this.stop();this.closed=true;await this.running;}
}

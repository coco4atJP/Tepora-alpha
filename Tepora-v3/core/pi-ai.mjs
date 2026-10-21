/** Pi owns provider protocols/catalogs/OAuth; Tepora owns permissions, storage and execution.
 * Workers isolate SDK globals. Every fetch crosses back through NetworkPolicy, including refresh.
 * The Store's exclusive data-directory lease provides cross-process credential ownership. */
import {Worker} from 'node:worker_threads';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {existsSync,lstatSync,readFileSync,openSync,closeSync,constants} from 'node:fs';
import {teporaPiModels} from './pi-catalog.mjs';
import {invariant} from './policy.mjs';
import {insideEndpoint,normalURL,NetworkBlocked} from './network-policy.mjs';
import {ProviderError,classifyResponse} from './provider-protocols.mjs';
import {atomicVault} from './provider-auth.mjs';
import {checkedPiModels,storedPiCatalog,supportedPiApi} from './pi-model-catalog.mjs';

export const PI_VERSION='1.3.0';
const catalog=teporaPiModels();
const accountPattern=/^pi-[a-f0-9-]{36}$/;
const authOrigins={
 openai:['https://auth.openai.com'], 'openai-codex':['https://auth.openai.com'],
 anthropic:['https://platform.claude.com'],
 'github-copilot':['https://github.com','https://api.github.com','https://api.individual.githubcopilot.com','https://api.business.githubcopilot.com','https://api.enterprise.githubcopilot.com'],
 openrouter:['https://openrouter.ai'], 'kimi-coding':['https://auth.kimi.com'],
 meta:['https://auth.meta.com','https://api.meta.ai'], xai:['https://auth.x.ai'],radius:['https://radius.pi.dev']
};
const protocolFor=api=>api==='anthropic-messages'?'anthropic':api==='google-generative-ai'?'gemini':/responses/.test(api)?'responses':'chat-completions';
const modelInfo=m=>({id:m.id,name:m.name,api:m.api,protocol:protocolFor(m.api),baseUrl:m.baseUrl||'',contextTokens:m.contextWindow,maxTokens:m.maxTokens,reasoning:!!m.reasoning,vision:m.input?.includes('image')===true,cost:m.cost,available:supportedPiApi(m.api)&&m.enabled!==false});
export function piProviders(){return {engine:'pi-ai',version:PI_VERSION,providers:catalog.getProviders().map(p=>({id:p.id,name:p.name,baseUrl:p.baseUrl||'',modelCount:p.getModels().length,oauth:p.auth.oauth?{name:p.auth.oauth.name,subscription:p.auth.oauth.isSubscription===true}:null,apiKey:!!p.auth.apiKey,apiKeyLogin:!!p.auth.apiKey?.login,available:p.getModels().some(m=>supportedPiApi(m.api)),note:p.getModels().some(m=>!supportedPiApi(m.api))?'このアダプターの専用通信は未接続です。通常APIの別プロバイダーを使用してください。':p.getModels().length?'カタログ掲載は利用権限・実モデルでの動作確認を意味しません。':'チャットモデルがありません（別の操作専用）。'}))};}
export function piModel(provider,id){return catalog.getModel(provider,id);}
export function validatePiProfile(p,resolveModel=piModel){
 const provider=catalog.getProvider(p.piProvider),model=provider&&resolveModel(p.piProvider,p.model,p.accountId||null);
 invariant(!p.authMode||['api-key','pi-oauth','pi-key'].includes(p.authMode),'pi-aiの認証方式が不正です。');
 invariant(provider&&model,'pi-aiのプロバイダーとモデルを選択してください。');
 invariant(supportedPiApi(model.api)&&model.enabled!==false,'このpi-aiアダプターの専用通信はまだ接続していません。');
 invariant(p.protocol===protocolFor(model.api),'pi-aiモデルのAPI形式が一致しません。');
 if(p.authMode?.startsWith('pi-')){
  invariant(accountPattern.test(p.accountId||''),'pi-aiの認証アカウントを選択してください。');
  invariant(p.domain==='cloud'&&!p.apiKeyEnv,'アカウント認証と環境変数のキーを混在できません。');
  if(p.authMode==='pi-oauth'){
   invariant(provider.auth.oauth,'このプロバイダーにはOAuthがありません。');
   invariant(p.baseUrl.replace(/\/$/,'')===(model.baseUrl||provider.baseUrl||'').replace(/\/$/,''),'OAuthの送信先はpi-aiのモデル定義に固定します。');
  }
 }
}
const publicAccount=a=>({id:a.id,provider:a.provider,type:a.type,label:a.label,connected:!!a.credential,error:a.error||null});
const safeLink=s=>{try{const u=normalURL(s,{query:true});return u.protocol==='https:'?u.href:null;}catch{return null;}};
function readVault(file){
 if(!existsSync(file))return {schema:1,deviceId:randomUUID(),accounts:{}};
 const d=lstatSync(path.dirname(file)),s=lstatSync(file);invariant(d.isDirectory()&&!d.isSymbolicLink()&&s.isFile()&&!s.isSymbolicLink(),'Unsafe Pi credential storage');
 const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let v;
 try{invariant(s.size<=4_000_000,'Pi credential file is too large');v=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 invariant(v.schema===1&&typeof v.deviceId==='string'&&v.accounts&&Object.keys(v.accounts).length<=128,'Invalid Pi credential store');
 for(const [id,a] of Object.entries(v.accounts)){invariant(accountPattern.test(id)&&a.id===id&&catalog.getProvider(a.provider)&&['oauth','api_key'].includes(a.type),'Invalid Pi account');storedPiCatalog(a.catalog,a.provider,catalog,PI_VERSION);}
 return v;
}
export class PiAIService{
 constructor(store,network,{refreshDrainMs=20000}={}){
  invariant(Number.isInteger(refreshDrainMs)&&refreshDrainMs>=100&&refreshDrainMs<=20000,'Invalid refresh drain timeout');this.refreshDrainMs=refreshDrainMs;
  this.store=store;this.network=network;this.file=path.join(store.dir,'credentials','pi-ai.json');this.jobs=new Set();this.locks=new Map();this.closed=false;this.pending=null;this.catalogEpochs=new Map();this.catalogRefreshes=new Map();
  try{this.vault=readVault(this.file);}catch{this.vault={schema:1,deviceId:randomUUID(),accounts:{}};this.storageError='pi-aiの認証ファイルを読み込めません。ファイルを保全して停止しています。';}
  this.onNetwork=()=>{for(const j of this.jobs)if(!network.permitted(j.data.profile?.domain||'cloud','model'))j.abort();};network.listeners.add(this.onNetwork);
 }
 snapshot(){const p=this.pending;return {supported:!this.storageError,version:PI_VERSION,note:this.storageError||'OAuthとAPIキー、異なる登録アカウントへの自動切替はしません。',accounts:Object.values(this.vault.accounts).map(publicAccount),pending:p?{id:p.id,provider:p.provider,accountId:p.accountId,status:p.status,prompt:p.prompt||null,event:p.event||null,error:p.error||null}:null};}
 status(id){const a=this.vault.accounts[id];return a?publicAccount(a):{connected:false,error:'pi-aiへログインしてください。'};}
 persist(){invariant(!this.storageError,'認証ファイルを保全するため変更できません。');invariant(Buffer.byteLength(JSON.stringify(this.vault))<4_000_000,'pi-ai保存データが大きすぎます。');atomicVault(this.file,this.vault);}
 changed(){if(!this.closed)this.store.broadcast?.('pi.updated',{version:PI_VERSION});}
 account(id,provider){const a=this.vault.accounts[id];invariant(a&&a.provider===provider,'pi-aiのアカウントとプロバイダーが一致しません。',409);return a;}
 model(provider,id,accountId=null){
  const def=catalog.getProvider(provider);if(!def)return undefined;
  if(!accountId){const model=catalog.getModel(provider,id);return model?.enabled===false?undefined:model;}
  const a=this.account(accountId,provider),saved=a.catalog?.version===PI_VERSION?a.catalog:null;
  const models=saved?saved.models:catalog.getModels(provider);
  return (def.filterModels?.(models,a.credential)||models).find(m=>m.id===id&&m.enabled!==false);
 }
 assertProfile(p){validatePiProfile(p,(provider,id,accountId)=>this.model(provider,id,accountId));if(p.accountId){const a=this.account(p.accountId,p.piProvider);invariant(a.type===(p.authMode==='pi-oauth'?'oauth':'api_key'),'pi-aiの認証方式が一致しません。');}}
 models(provider,accountId=null){
  const def=catalog.getProvider(provider);invariant(def,'Unknown pi-ai provider');
  let models=catalog.getModels(provider),saved=null;
  if(accountId){const a=this.account(accountId,provider);saved=a.catalog?.version===PI_VERSION?a.catalog:null;models=saved?saved.models:models;models=def.filterModels?.(models,a.credential)||models;}
  return {models:models.map(modelInfo),verified:false,...(saved?{refreshedAt:saved.at}:{}),note:saved?'このアカウントが取得した保存済みpi-ai一覧です。現在の利用資格・推論品質は未検証です。':'pi-aiのカタログです。実際の利用権限・応答品質は未検証です。'};
 }
 async refreshModels(provider,accountId,consent,signal){
  invariant(consent===true,'モデル一覧の外部取得を許可してください。',403);
  const a=this.account(accountId,provider);invariant(a.credential,'ログインしてください。');
  const epoch=this.catalogEpochs.get(accountId)||0,sequence=(this.catalogRefreshes.get(accountId)||0)+1;this.catalogRefreshes.set(accountId,sequence);
  const result=await this.run({operation:'models',provider,accountId},{signal});signal?.throwIfAborted();
  invariant(!this.closed&&!this.storageError&&this.network.permitted('cloud','model')&&this.account(accountId,provider)===a&&a.credential&&(this.catalogEpochs.get(accountId)||0)===epoch&&this.catalogRefreshes.get(accountId)===sequence,'pi-aiモデル一覧の取得状態が更新されています。',409);
  const models=checkedPiModels(provider,result,catalog),previous=a.catalog;
  a.catalog={schema:1,version:PI_VERSION,at:new Date().toISOString(),models};
  try{this.persist();}catch(e){if(previous===undefined)delete a.catalog;else a.catalog=previous;throw e;}
  this.changed();return this.models(provider,accountId);
 }
 async lock(accountId,signal){
  const previous=this.locks.get(accountId)||Promise.resolve();let release;const held=new Promise(r=>release=r);const tail=previous.catch(()=>{}).then(()=>held);this.locks.set(accountId,tail);
  await previous.catch(()=>{});if(signal.aborted){release();if(this.locks.get(accountId)===tail)this.locks.delete(accountId);throw signal.reason;}
  return ()=>{release();if(this.locks.get(accountId)===tail)this.locks.delete(accountId);};
 }
 begin({provider,type='oauth',accountId=null,consent=false}={}){
  invariant(consent===true,'選択したサービスへの認証と利用条件を確認してください。',403);
  invariant(!this.closed&&!this.storageError,'pi-ai認証を利用できません。');invariant(this.network.permitted('cloud','model'),'オンラインにしてください。',403);
  const def=catalog.getProvider(provider);invariant(def&&['oauth','api_key'].includes(type)&&def.auth[type==='oauth'?'oauth':'apiKey']?.login,'この認証方式は利用できません。');
  invariant(!['pending','cancelling'].includes(this.pending?.status),'別のログインを完了または取り消してください。',409);
  let a=accountId?this.account(accountId,provider):null;invariant(!a||a.type===type,'再ログインの方式を変更できません。');
  if(!a){invariant(Object.keys(this.vault.accounts).length<128,'認証アカウントは128件までです。');accountId='pi-'+randomUUID();a={id:accountId,provider,type,label:def.name+' · '+accountId.slice(-6)};this.vault.accounts[accountId]=a;}
  this.invalidate(accountId);const previousCatalog=a.catalog;delete a.catalog;try{this.persist();}catch(e){if(previousCatalog!==undefined)a.catalog=previousCatalog;throw e;}
  const p={id:randomUUID(),provider,accountId,status:'pending',cancel:new AbortController()};this.pending=p;
  const timer=setTimeout(()=>p.cancel.abort(),600000);timer.unref?.();
  p.task=this.run({operation:'login',provider,accountId,authType:type,deviceId:this.vault.deviceId},{signal:p.cancel.signal,pending:p}).then(()=>{p.status='connected';delete a.error;this.changed();}).catch(()=>{p.status=p.cancel.signal.aborted?'cancelled':'error';p.error=p.cancel.signal.aborted?'ログインを取り消しました。':'認証に失敗しました。利用条件・入力内容を確認して再試行してください。';}).finally(()=>{clearTimeout(timer);delete p.prompt;delete p.event;this.changed();});
  return this.snapshot();
 }
 respond({id,promptId,value}={}){const p=this.pending;invariant(p?.id===id&&p.status==='pending'&&p.prompt?.id===promptId,'認証の入力待ちが更新されています。',409);invariant(typeof value==='string'&&value.length<=64000,'認証入力が不正です。');if(p.prompt.type==='select')invariant(p.prompt.options.some(x=>x.id===value),'選択肢が不正です。');p.worker.postMessage({type:'reply',id:promptId,value});delete p.prompt;return this.snapshot();}
 cancel(id){const p=this.pending;if(p&&(!id||p.id===id)){p.cancel.abort();if(p.status==='pending')p.status='cancelling';delete p.prompt;delete p.event;}return this.snapshot();}
 invalidate(id){this.catalogEpochs.set(id,(this.catalogEpochs.get(id)||0)+1);for(const j of this.jobs)if(j.data.accountId===id)j.abort();}
 async disconnect(id){const a=this.vault.accounts[id];invariant(a,'Unknown pi-ai account',404);this.invalidate(id);const release=await this.lock(id,new AbortController().signal);try{const previous=a.credential;delete a.credential;delete a.error;try{this.persist();}catch(e){a.credential=previous;throw e;}}finally{release();}this.changed();return this.snapshot();}
 /** Explicit profile egress, plus provider-owned auth endpoints; no ambient SDK HTTP. */
 scope(url,data){
  const u=normalURL(url,{query:true}),profile=data.profile,provider=catalog.getProvider(data.provider);
  if(data.provider==='github-copilot'&&/\/models\/[^/]+\/policy$/.test(u.pathname))throw new NetworkBlocked('Copilotのモデル利用設定はサービス側で明示的に有効化してください。');
  if(profile&&insideEndpoint(u,profile.baseUrl))return {profile,inference:true};
  const origins=new Set(authOrigins[data.provider]||[]);
  if(!profile){for(const m of provider.getModels()){try{origins.add(new URL(m.baseUrl).origin);}catch{}}if(provider.baseUrl)origins.add(new URL(provider.baseUrl).origin);}
  // Copilot selects its account's API origin after refresh; never arbitrary proxy hosts.
  if(profile&&data.provider==='github-copilot'&&data.accountId&&/^https:\/\/api\.(individual|business|enterprise)\.githubcopilot\.com$/.test(u.origin))return {profile:{...profile,baseUrl:u.origin},inference:true};
  if(!origins.has(u.origin)||u.protocol!=='https:')throw new NetworkBlocked('pi-aiが登録外の送信先へ接続しようとしました。');
  return {profile:null,inference:false};
 }
 async run(data,{signal,onDelta,onReasoning,onDispatch,pending:p}={}){
  invariant(!this.closed&&!this.storageError,'pi-aiサービスを利用できません。');
  invariant(this.network.permitted(data.profile?.domain||'cloud','model'),'この通信モードではpi-ai接続を利用できません。',403);
  signal?.throwIfAborted();if(data.accountId)this.account(data.accountId,data.provider);
  // No process.env copy: OAuth-host overrides, ambient keys and proxy vars cannot change credential scope.
  const worker=new Worker(new URL('./pi-worker.mjs',import.meta.url),{workerData:data,env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:256}});
  const hardCancel=new AbortController(),callerCancel=new AbortController(),leases=new Map(),ports=new Set();
  const durableRefresh=!!data.accountId&&data.operation!=='login'&&this.account(data.accountId,data.provider).type==='oauth';
  let lastError=null,settled=false,delivered=false,abortTimer,rejectCancelled;
  const cancelled=new Promise((_,reject)=>{rejectCancelled=reject;});cancelled.catch(()=>{});
  const job={data,abort:(hard=true,reason=new ProviderError('auth','pi-aiの処理を取り消しました。'))=>{
   if(!callerCancel.signal.aborted){callerCancel.abort(reason);rejectCancelled(reason);}
   if(hard)hardCancel.abort(reason);
   worker.postMessage({type:'abort',hard});
   // Only an already-leased OAuth mutation can drain after caller cancellation.
   if(hard){clearTimeout(abortTimer);abortTimer=setTimeout(()=>worker.terminate(),100);}
   else abortTimer??=setTimeout(()=>{hardCancel.abort(reason);worker.terminate();},this.refreshDrainMs);
  }};
  const onAbort=()=>job.abort(!durableRefresh,signal.reason);
  this.jobs.add(job);if(p)p.worker=worker;signal?.addEventListener('abort',onAbort,{once:true});
  const cleanup=async()=>{signal?.removeEventListener('abort',onAbort);hardCancel.abort();clearTimeout(abortTimer);for(const lease of leases.values())lease.release();leases.clear();for(const port of ports)port.close();try{await worker.terminate();}finally{this.jobs.delete(job);}};
  const operation=new Promise((resolve,reject)=>{
   const finish=(error,value)=>{if(settled)return;settled=true;if(callerCancel.signal.aborted)error=callerCancel.signal.reason;if(error&&delivered)error.partialOutput=true;error?reject(error):resolve(value);};
   worker.on('error',()=>finish(new ProviderError('unavailable','pi-ai Workerを起動できません。依存パッケージとNodeのバージョンを確認してください。')));
   worker.on('exit',()=>{if(!settled)finish(hardCancel.signal.aborted?hardCancel.signal.reason:new ProviderError('unavailable','pi-ai Workerが終了しました。'));});
   worker.on('message',m=>{
    if(m.type==='fetch'){
     const port=m.port;ports.add(port);let reader,busy=false;const requestCancel=new AbortController();
     const stop=()=>{requestCancel.abort();reader?.cancel().catch(()=>{});port.close();ports.delete(port);};port.on('close',stop);
     port.on('message',async command=>{if(command.type==='cancel')return stop();if(command.type==='pull'&&reader&&!busy){busy=true;try{const x=await reader.read();port.postMessage(x.done?{type:'end'}:{type:'chunk',bytes:x.value});if(x.done){port.close();ports.delete(port);}}catch{port.postMessage({type:'error',message:'Provider stream failed'});stop();}finally{busy=false;}}});
     (async()=>{
      const durable=durableRefresh&&leases.get(m.credentialLease)?.durable===true;
      if(!durable)callerCancel.signal.throwIfAborted();
      const s=this.scope(m.url,data),requestSignal=AbortSignal.any([hardCancel.signal,requestCancel.signal,...(!durable?[callerCancel.signal]:[])]);
      if(s.inference)callerCancel.signal.throwIfAborted();
      const response=await this.network.request(m.url,{...m.init,signal:requestSignal,redirect:'error'},{profile:s.profile,purpose:'model',allowCloud:true,asset:true,maxBytes:s.inference?64_000_000:4_000_000,
       ...(s.inference?{firstByteTimeoutMs:data.profile.firstByteTimeoutMs,idleTimeoutMs:data.profile.idleTimeoutMs,onDispatch}: {timeoutMs:30000})});
      if(!response.ok){const error=await classifyResponse(response.clone());lastError=new ProviderError(error.kind,`pi-ai接続先がHTTP ${response.status}を返しました。`,{status:response.status,retryAfterMs:error.retryAfterMs,limit:error.limit});}
      reader=response.body?.getReader();port.postMessage({type:'headers',status:response.status,headers:[...response.headers],noBody:!reader});
     })().catch(e=>{lastError=e;try{port.postMessage({type:'error',message:'Checked provider request failed'});}finally{stop();}});return;
    }
    if(m.type==='rpc'){
     (async()=>{
      hardCancel.signal.throwIfAborted();
      const held=leases.get(m.value?.lease),durableWrite=held?.durable&&['credential-commit','credential-unlock'].includes(m.kind);
      if(!durableWrite)callerCancel.signal.throwIfAborted();
      const a=this.account(data.accountId,data.provider);let value;
      if(m.kind==='credential-read')value=a.credential;
      else if(m.kind==='credential-lock'){const release=await this.lock(a.id,AbortSignal.any([hardCancel.signal,callerCancel.signal])),lease=randomUUID();leases.set(lease,{release,durable:durableRefresh});value={lease,credential:a.credential};}
      else if(m.kind==='credential-commit'){
       invariant(held,'Invalid Pi credential lease');
       try{if(m.value.credential!==undefined){invariant(m.value.credential?.type===a.type&&JSON.stringify(m.value.credential).length<256000,'Invalid Pi credential');const previous=a.credential;a.credential=m.value.credential;try{this.persist();}catch(e){a.credential=previous;throw e;}}value=a.credential;}finally{held.release();leases.delete(m.value.lease);}
      }else if(m.kind==='credential-unlock'){held?.release();leases.delete(m.value.lease);}
      else throw new Error('Unknown Pi RPC');
      if(!settled)worker.postMessage({type:'reply',id:m.id,value});
     })().catch(()=>{if(!settled)worker.postMessage({type:'reply',id:m.id,error:'Pi credential operation failed'});});return;
    }
    if(m.type==='delta'){if(callerCancel.signal.aborted)return;delivered=true;try{(m.kind==='text_delta'?onDelta:onReasoning)?.(m.text);}catch(e){finish(e);}return;}
    if(p&&m.type==='prompt'){if(callerCancel.signal.aborted)return;p.prompt={id:m.id,...m.prompt};this.changed();return;}
    if(p&&m.type==='prompt-cancel'){if(p.prompt?.id===m.id)delete p.prompt;return;}
    if(p&&m.type==='auth-event'){
     if(callerCancel.signal.aborted)return;const e=m.event;
     p.event=e.type==='auth_url'?{type:e.type,url:safeLink(e.url),instructions:String(e.instructions||'').slice(0,2000)}:e.type==='device_code'?{type:e.type,userCode:String(e.userCode).slice(0,100),verificationUri:safeLink(e.verificationUri)}:{type:e.type,message:String(e.message||'').slice(0,2000)};
     this.changed();return;
    }
    if(m.type==='result')finish(null,m.value);
    if(m.type==='failure')finish(lastError||new ProviderError(['oauth','auth'].includes(m.code)?'auth':'invalid-output','pi-aiの認証またはモデル応答を処理できませんでした。'));
   });
  });
  // Release the caller promptly while logout/close retain ownership of the drain.
  const drained=operation.finally(cleanup);job.done=drained;drained.catch(()=>{});
  if(signal?.aborted)onAbort();
  return data.operation==='login'?drained:Promise.race([drained,cancelled]);
 }
 chat(profile,key,messages,options={},onDispatch){
  this.assertProfile(profile);if(profile.accountId&&!this.status(profile.accountId).connected)throw new ProviderError('auth','pi-aiへログインしてください。',{status:401});
  const sessionHeader=profile.sessionHeader&&options.cacheKey?{[profile.sessionHeader]:'tepora-'+createHash('sha256').update(String(options.cacheKey)).digest('hex').slice(0,32)}:null;
  const sampling={...options.sampling};for(const k of options.compat?.drop||[])delete sampling[k];
  const streamOptions={tools:options.tools||[],maxTokens:options.maxTokens,toolChoice:options.toolChoice||'auto',samplingParams:sampling,temperature:sampling.temperature,
   sessionId:options.cacheKey||undefined,cacheRetention:profile.cache===false?'none':options.cacheRetention||'short',reasoning:profile.reasoningEffort||undefined,
   ...(profile.thinkingBudget?{thinkingBudgets:{minimal:profile.thinkingBudget,low:profile.thinkingBudget,medium:profile.thinkingBudget,high:profile.thinkingBudget}}:{})};
  return this.run({operation:'chat',model:this.model(profile.piProvider,profile.model,profile.accountId||null),provider:profile.piProvider,profile,key:profile.accountId?'':key,accountId:profile.accountId||null,messages,options:streamOptions,sessionHeader},
   {signal:options.signal,onDelta:options.onDelta,onReasoning:options.onReasoning,onDispatch});
 }
 async close(){this.closed=true;this.network.listeners.delete(this.onNetwork);this.cancel();for(const j of this.jobs)j.abort();await Promise.allSettled([this.pending?.task]);while(this.jobs.size)await new Promise(r=>setTimeout(r,10));}
}

import {DecisionClient} from './decision.mjs';
import {createHash} from 'node:crypto';
import {normalURL,ipDomain,NetworkBlocked} from './network-policy.mjs';
import {ProtocolClient,PROTOCOLS} from './provider-protocols.mjs';
import {invariant,text} from './policy.mjs';
import {probeRuntime} from './probe.mjs';

const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const ROUTE_ROLES=['main','chat','work','vision','dictation'];
export class RouteUnavailable extends Error {
 constructor(message='使用可能なモデルがありません。仕事を保存して待機します。'){super(message);this.name='RouteUnavailable';this.status=409;this.blocked=true;this.reason='provider-unavailable';}
}
const profileFields=['id','name','protocol','baseUrl','model','domain','pinnedAddress','allowPlainHttp','privateContext','enabled','apiKeyEnv','capabilities','maxTokens','contextChars','timeoutMs','maxParallel','resource','reasoningEffort'];
export function validateProfile(raw) {
 invariant(raw&&Object.keys(raw).every(k=>profileFields.includes(k)),'Unknown provider field');
 invariant(idPattern.test(raw.id),'Use a short alphanumeric provider ID');
 const u=normalURL(raw.baseUrl),host=u.hostname.replace(/^\[|\]$/g,''),lex=host==='localhost'?'device':ipDomain(host);
 invariant(PROTOCOLS.includes(raw.protocol),'Select an explicit API protocol');
 invariant(['device','lan','cloud'].includes(raw.domain),'Select device / LAN / cloud');
 invariant(raw.domain==='device'?lex==='device':raw.domain==='lan'?lex==='lan'||lex==='name':lex==='cloud'||lex==='name','Provider domain does not match its address');
 if(raw.domain==='cloud')invariant(u.protocol==='https:','Cloud APIs require HTTPS');
 if(raw.domain==='lan'){
  invariant(ipDomain(raw.pinnedAddress||'')==='lan','Pin the LAN machine to an RFC1918/ULA address');
  invariant(lex==='name'||raw.pinnedAddress===host,'LAN pin and URL do not match');
  invariant(u.protocol==='https:'||raw.allowPlainHttp===true,'LAN HTTP needs explicit plaintext consent');
 }
 const caps={text:true,tools:null,vision:null,structured:null};
 for(const [k,v] of Object.entries(raw.capabilities||{})){invariant(Object.hasOwn(caps,k)&&[true,false,null].includes(v),'Invalid capability declaration');caps[k]=v;}
 const number=(name,defaultValue,min,max)=>{const x=raw[name]??defaultValue;invariant(Number.isInteger(x)&&x>=min&&x<=max,`Invalid ${name}`);return x;};
 invariant(!raw.apiKeyEnv||/^[A-Z_][A-Z0-9_]{0,100}$/.test(raw.apiKeyEnv),'Invalid API key environment variable');
 invariant(raw.enabled===undefined||typeof raw.enabled==='boolean','Invalid enabled');
 invariant(!raw.resource||idPattern.test(raw.resource),'Invalid resource group');
 invariant(!raw.reasoningEffort||['low','medium','high'].includes(raw.reasoningEffort),'Invalid reasoning effort');
 const p={id:raw.id,name:text(raw.name||raw.id,'name',100),protocol:raw.protocol,baseUrl:u.href.replace(/\/$/,''),model:text(raw.model,'model',160),domain:raw.domain,
  enabled:raw.enabled!==false,apiKeyEnv:raw.apiKeyEnv||'',capabilities:caps,
  pinnedAddress:raw.domain==='lan'?raw.pinnedAddress:'',allowPlainHttp:raw.domain==='lan'&&raw.allowPlainHttp===true,
  privateContext:raw.domain==='device'||raw.domain==='lan'&&raw.privateContext===true,
  maxTokens:number('maxTokens',4096,128,32768),contextChars:number('contextChars',96000,8000,512000),
  timeoutMs:number('timeoutMs',60000,1000,300000),maxParallel:number('maxParallel',raw.domain==='cloud'?4:1,1,32),
  resource:raw.resource||raw.id,...(raw.reasoningEffort?{reasoningEffort:raw.reasoningEffort}:{})};
 p.identity=digest(p);return p;
}
export function validateRegistry(raw) {
 invariant(raw&&Object.keys(raw).every(k=>['profiles','routes'].includes(k)),'Invalid provider configuration');
 invariant(Array.isArray(raw.profiles)&&raw.profiles.length<=32,'At most 32 named providers');
 const profiles=raw.profiles.map(validateProfile),ids=new Set(profiles.map(p=>p.id));invariant(ids.size===profiles.length,'Duplicate provider IDs');
 const routes={};
 for(const [role,r] of Object.entries(raw.routes||{})){
  invariant(ROUTE_ROLES.includes(role)&&r&&Object.keys(r).every(k=>['primary','fallbacks'].includes(k)),'Invalid route');
  const chain=[r.primary,...(r.fallbacks||[])];invariant(chain.length<=8&&new Set(chain).size===chain.length,'Invalid fallback chain');
  for(const id of chain){const p=profiles.find(p=>p.id===id);invariant(p?.enabled,'Route refers to a missing or disabled profile');if(role==='vision')invariant(p.capabilities.vision===true,'Vision routes need an explicitly vision-capable model');if(role==='dictation')invariant(p.domain==='device','Dictation routes and their fallbacks must stay on this PC');}
  routes[role]={primary:r.primary,fallbacks:r.fallbacks||[]};
 }
 invariant(!profiles.length||routes.main,'A main route is required');
 return {profiles,routes};
}

/** Bounded admission with priority + ageing; no claimed GPU preemption. */
export class ResourceGate {
 constructor(){this.groups=new Map();}
 acquire(key,limit,{signal,priority=0}={}){
  signal?.throwIfAborted();for(const [k,v] of this.groups)if(!v.active&&!v.queue.length)this.groups.delete(k);let g=this.groups.get(key);if(!g){g={key,active:0,queue:[],limit};this.groups.set(key,g);}
  g.limit=Math.min(g.limit,limit);
  invariant(g.queue.length<64,'Inference queue is full',429);
  return new Promise((resolve,reject)=>{
   const entry={resolve,reject,priority,at:Date.now(),signal};
   entry.abort=()=>{const i=g.queue.indexOf(entry);if(i>=0)g.queue.splice(i,1);reject(signal.reason);this.drain(g);};
   signal?.addEventListener('abort',entry.abort,{once:true});g.queue.push(entry);this.drain(g);
  });
 }
 drain(g){while(g.active<g.limit&&g.queue.length){
  g.queue.sort((a,b)=>(b.priority+(Date.now()-b.at)/2000)-(a.priority+(Date.now()-a.at)/2000));
  const entry=g.queue.shift();entry.signal?.removeEventListener('abort',entry.abort);if(entry.signal?.aborted){entry.reject(entry.signal.reason);continue;}
  g.active++;let released=false;entry.resolve(()=>{if(released)return;released=true;g.active--;this.drain(g);});
 }}
 snapshot(){return [...this.groups].map(([resource,g])=>({resource,active:g.active,queued:g.queue.length,limit:g.limit}));}
 close(){for(const g of this.groups.values())for(const e of g.queue.splice(0)){e.signal?.removeEventListener('abort',e.abort);e.reject(new RouteUnavailable('Service closed'));}this.groups.clear();}
}
export class ProviderRegistry {
 constructor(store,network,{clientFactory=(p,k,f)=>new ProtocolClient(p,k,f),clock=()=>Date.now()}={}){
  Object.assign(this,{store,network,clientFactory,clock});this.keys=new Map();this.health=new Map();this.gate=new ResourceGate();
 }
 get(){return this.store.value('provider-registry')||{schema:1,revision:0,profiles:[],routes:{}};}
 get configured(){return this.get().profiles.length>0;}
 publicSnapshot(){const c=this.get();return {...c,profiles:c.profiles.map(p=>({...p,keyPresent:!!this.keyFor(p),health:this.health.get(p.id)||null,probe:this.store.get('provider-probe',p.identity)||null})),resources:this.gate.snapshot(),offlineFloor:this.offlineFloor()};}
 save(raw,expectedRevision){
  const old=this.get();invariant(old.revision===expectedRevision,'接続設定が更新されています。',409);
  const c={schema:1,revision:old.revision+1,...validateRegistry(raw)};
  for(const [id,key] of this.keys){const a=old.profiles.find(p=>p.id===id),b=c.profiles.find(p=>p.id===id);
   if(!a||!b||a.baseUrl!==b.baseUrl||a.protocol!==b.protocol||a.pinnedAddress!==b.pinnedAddress)this.keys.delete(id);}
  for(const [controller,entry] of this.network.active)if(old.profiles.some(p=>p.id===entry.profileId)&&!c.profiles.some(p=>p.id===entry.profileId&&p.enabled&&p.identity===old.profiles.find(x=>x.id===entry.profileId)?.identity))controller.abort(new NetworkBlocked('Provider changed or disabled'));
  for(const id of this.health.keys())if(!c.profiles.some(p=>p.id===id))this.health.delete(id);
  this.store.value('provider-registry',c);this.store.emit('providers.updated',this.publicSnapshot());return this.publicSnapshot();
 }
 keyFor(p){const current=this.get().profiles.find(x=>x.id===p.id);if(!current||current.identity!==p.identity)return '';
  return this.keys.get(p.id)|| (p.apiKeyEnv?process.env[p.apiKeyEnv]:'')||'';}
 setKey(id,key,expectedIdentity){const p=this.get().profiles.find(p=>p.id===id);invariant(p&&p.identity===expectedIdentity,'接続先が変わっています。',409);invariant(typeof key==='string'&&key.length<=4000,'Invalid key');if(key)this.keys.set(id,key);else this.keys.delete(id);return {id,keyPresent:!!this.keyFor(p)};}
 chain(role,c=this.get()){const r=c.routes[role]||c.routes.main;if(!r)return [];return [r.primary,...r.fallbacks].map(id=>c.profiles.find(p=>p.id===id)).filter(Boolean);}
 pin(role='work') {
  const config=this.get(),profiles=this.chain(role,config);if(!profiles.length)throw new RouteUnavailable('会話・仕事の接続先を登録してください。');
  // Configured fallbacks are the user's explicit data-destination set for this job.
  const vision=this.chain('vision',{...config,routes:{vision:config.routes.vision}});
  const delegatedWork=role==='chat'?this.chain('work',config):[];
  return this.makeSnapshot(role,profiles,vision,delegatedWork,config.revision);
 }
 makeSnapshot(role,profiles,vision,delegatedWork=[],revision=0){
  return {schema:1,role,revision,profiles:structuredClone(profiles),vision:structuredClone(vision),delegatedWork:structuredClone(delegatedWork),
   id:digest([role,profiles.map(p=>p.identity),vision.map(p=>p.identity),delegatedWork.map(p=>p.identity)]),
   privateContext:[...profiles,...delegatedWork,...vision].every(p=>p.privateContext),createdAt:new Date().toISOString()};
 }
 delegated(snapshot){
  if(!snapshot)return null;
  const profiles=snapshot.role==='chat'?(snapshot.delegatedWork??snapshot.profiles):snapshot.profiles;
  if(!profiles.length)throw new RouteUnavailable('現在許可された仕事用モデルがありません。');
  // Use the parent's already consented recipients, never today's changed route.
  return this.makeSnapshot('work',profiles,snapshot.vision,[],snapshot.revision);
 }
 admit(snapshot){
  const profiles=snapshot.profiles.filter(p=>this.permitted(p));
  if(!profiles.length)throw new RouteUnavailable('この通信モードで使う接続先を準備してください。依頼の下書きは保持します。');
  return this.makeSnapshot(snapshot.role,profiles,snapshot.vision.filter(p=>this.permitted(p,'vision')),(snapshot.delegatedWork||[]).filter(p=>this.permitted(p)),snapshot.revision);
 }
 current(p){return this.get().profiles.some(now=>now.enabled&&now.identity===p.identity);}
 permitted(p,purpose='model'){return this.current(p)&&this.network.permitted(p.domain,purpose);}
 capable(p,requirement){return p.capabilities[requirement]===true||requirement==='tools'&&p.capabilities.tools!==false&&this.store.get('provider-probe',p.identity)?.ok===true;}
 usable(snapshot,requirement='text') {return snapshot.profiles.filter(p=>this.permitted(p)&&this.capable(p,requirement));}
 effective(snapshot){return this.usable(snapshot)[0]||null;}
 settingsFor(snapshot,base=this.store.settings){const p=this.effective(snapshot)||snapshot.profiles[0];return {...base,provider:'compatible',baseUrl:p.baseUrl,model:p.model,allowCloud:p.domain!=='device',maxTokens:p.maxTokens};}
 offlineFloor(){const profiles=this.chain('work'),local=profiles.filter(p=>p.domain==='device'&&p.enabled&&this.capable(p,'tools'));return {
  configured:local.length>0,providers:local.map(p=>p.id),verified:local.some(p=>this.store.get('provider-probe',p.identity)?.ok),
  note:'事前に導入した同一PCモデルが必要です。設定・疎通確認は能力や速度の保証ではありません。'};}
 runtime(snapshot,{job,onRoute=()=>{},onReset=()=>{}}={}) {
  return {chat:(messages,options)=>this.invoke(snapshot,messages,{...options,jobId:job?.id,onRoute,onReset:options?.onReset||onReset,priority:job?.kind==='chat'?10:0}),
   models:async()=>snapshot.profiles.map(p=>p.model),
   decide:async(state,signal)=>{const s=this.store.settings;if(!s.decisionUrl)return null;
    const result=await new DecisionClient({url:s.decisionUrl,model:s.decisionModel||'multilingual'},this.network.fetch({purpose:'worker'})).decide(state,undefined,signal);
    return result?{...result.answers.intent,model:result.model,advisory:true}:null;}};
 }
 async invoke(snapshot,messages,{tools=[],signal,onDelta=()=>{},onReset=()=>{},onRoute=()=>{},jobId,priority=0,maxTokens,requirement=tools.length?'tools':'text'}={}) {
  let last=null,attempted=0;const deadline=AbortSignal.timeout(300000),allSignal=AbortSignal.any([signal||new AbortController().signal,deadline]);
  for(const p of snapshot.profiles){
   allSignal.throwIfAborted();
   if(!this.permitted(p,requirement==='vision'?'vision':'model')||!this.capable(p,requirement))continue;
   const h=this.health.get(p.id);if(h?.identity===p.identity&&h.until>this.clock())continue;
   let release;
   try {
    release=await this.gate.acquire(p.resource,p.maxParallel,{signal:allSignal,priority});
    if(!this.permitted(p,requirement==='vision'?'vision':'model'))continue;
    const attempt=++attempted;
    const event={jobId,profileId:p.id,model:p.model,domain:p.domain,protocol:p.protocol,attempt,reason:attempt>1?'fallback':p.identity===snapshot.profiles[0].identity?'selected':'policy-or-capability',networkMode:this.network.get().mode,at:new Date().toISOString()};
    this.store.emit('route.selected',event);onRoute(event);
    const start=this.clock(),requestSignal=AbortSignal.any([allSignal,AbortSignal.timeout(p.timeoutMs)]);
    const client=this.clientFactory(p,this.keyFor(p),this.network.fetch({profile:p,purpose:requirement==='vision'?'vision':'model',timeoutMs:p.timeoutMs,maxBytes:8_000_000}));
    const answer=await client.chat(messages,{tools,signal:requestSignal,maxTokens,onDelta});
    allSignal.throwIfAborted();if(!this.permitted(p,requirement==='vision'?'vision':'model'))throw new NetworkBlocked();
    this.health.set(p.id,{identity:p.identity,failures:0,until:0,lastMs:this.clock()-start});
    return {...answer,_route:event};
   }catch(e){
    allSignal.throwIfAborted();last=e;
    // Cancellation from a policy change can only continue to remaining already-authorized destinations.
    const policyChanged=!this.permitted(p,requirement==='vision'?'vision':'model');
    const retry=policyChanged||e.retryable===true||e.name==='TimeoutError'||e.name==='TypeError'&&e.message==='fetch failed'||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ENOTFOUND'].includes(e.code)||e.cause&&['ECONNREFUSED','ENETUNREACH'].includes(e.cause.code);
    if(!retry)throw e;
    if(!policyChanged){const failures=(h?.failures||0)+1;this.health.set(p.id,{identity:p.identity,failures,until:this.clock()+Math.min(60000,1000*2**Math.min(failures,6)),lastError:e.upstreamStatus||e.name});}
    this.store.emit('route.failed',{jobId,profileId:p.id,reason:policyChanged?'policy-changed':'provider-unavailable',status:e.upstreamStatus||null});
    onReset({from:p.id});
   }finally{release?.();}
  }
  throw new RouteUnavailable(last?'許可済みの代替モデルも使用できません。仕事と文脈を保存しています。':'現在の通信モード・能力条件に合うモデルがありません。ローカルモデルを設定して再開できます。');
 }
 async probe(id,signal) {
  const p=this.get().profiles.find(p=>p.id===id);invariant(p?.enabled,'Unknown enabled provider',404);
  const client=this.clientFactory(p,this.keyFor(p),this.network.fetch({profile:p,purpose:'model',timeoutMs:p.timeoutMs}));
  const result=await probeRuntime(client,{provider:p.protocol,baseUrl:p.baseUrl,model:p.model},signal);
  const doc={...result,id:p.identity,profileId:id,ok:result.passed===true,at:new Date().toISOString(),scope:'safe tool roundtrip only, not quality or vision'};
  this.store.put('provider-probe',doc);this.store.emit('providers.updated',this.publicSnapshot());return doc;
 }
 close(){this.keys.clear();this.gate.close();}
}

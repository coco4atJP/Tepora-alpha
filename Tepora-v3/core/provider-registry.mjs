import {createHash} from 'node:crypto';
import {validatePiProfile,piModel} from './pi-ai.mjs';
import {normalURL,ipDomain,NetworkBlocked} from './network-policy.mjs';
import {ProtocolClient,PROTOCOLS,ProviderError} from './provider-protocols.mjs';
import {invariant,text} from './policy.mjs';
import {probeRuntime} from './probe.mjs';
import {ModelDispatch,modelPrice} from './model-usage.mjs';

const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{signal?.throwIfAborted();const t=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(t);reject(signal.reason);}signal?.addEventListener('abort',abort,{once:true});});
/** chat: the character (orchestrator). work: workers. compaction/grounding/escalation fall back to work. */
export const ROUTE_ROLES=['main','chat','work','compaction','grounding','vision','escalation','dictation'];
const FALLBACK={chat:['chat','main'],work:['work','main'],compaction:['compaction','work','main'],grounding:['grounding','work','main'],escalation:['escalation'],vision:['vision'],dictation:['dictation'],main:['main']};
export const SERVERS=['auto','llama.cpp','ollama','vllm','lmstudio','openai','other'];
export class RouteUnavailable extends Error{
 constructor(message='使用できるモデルがありません。時間を置いて再試行します。',{retryAfterMs=30000,kind='unavailable'}={}){super(message);this.name='RouteUnavailable';this.status=409;this.kind=kind;this.retryAfterMs=retryAfterMs;this.retryable=kind!=='unconfigured';}
}
const SAMPLING={temperature:[0,2],top_p:[0,1],top_k:[1,1000,true],min_p:[0,1],presence_penalty:[-2,2],frequency_penalty:[-2,2],repeat_penalty:[0.5,2],seed:[0,2**31-1,true]};
function validateSampling(raw){
 if(raw===undefined)return {};invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid sampling');const out={};
 for(const [k,v] of Object.entries(raw)){const r=SAMPLING[k];invariant(r&&typeof v==='number'&&v>=r[0]&&v<=r[1]&&(!r[2]||Number.isInteger(v)),`Invalid sampling ${k}`);out[k]=v;}
 return out;
}
export const credentialClass=p=>p.authMode?.startsWith('pi-')?p.authMode+':'+p.accountId:p.authMode==='chatgpt'?'chatgpt:'+p.accountId:'api-key';
const profileFields=['engine','piProvider','authMode','accountId','id','name','protocol','baseUrl','model','domain','pinnedAddress','allowPlainHttp','enabled','apiKeyEnv','capabilities','maxTokens','contextTokens','timeoutMs','firstByteTimeoutMs','idleTimeoutMs','maxParallel','resource','reasoningEffort','thinkingBudget','sampling','server','cache','sessionHeader','thinking'];
/** Gateways that route by conversation (and keep its prompt cache warm on one backend) when told which one a request
 * belongs to. OpenCode Go requires it; anyone else can set `sessionHeader` on the profile. */
function sessionHeaderFor(u){return /(^|\.)opencode\.ai$/.test(u.hostname)?'x-opencode-session':'';}
export function validateProfile(raw,options={}){
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
 const authMode=raw.authMode||'api-key';
 invariant(['api-key','chatgpt','pi-oauth','pi-key'].includes(authMode),'Invalid authentication mode');
 invariant(raw.engine===undefined||raw.engine==='pi-ai','Invalid provider engine');
 if(authMode.startsWith('pi-'))invariant(raw.engine==='pi-ai','pi-ai認証にはpi-aiエンジンを指定してください。');
 if(raw.piProvider)invariant(raw.engine==='pi-ai','piProvider requires pi-ai');
 if(authMode==='chatgpt'){
  invariant(raw.protocol==='responses'&&raw.domain==='cloud'&&u.href.replace(/\/$/,'')==='https://api.openai.com/v1','ChatGPT認証は公式Responses APIにだけ使用できます。');
  invariant(/^chatgpt-[a-f0-9-]{36}$/.test(raw.accountId||''),'ChatGPTアカウントを選択してください。');
  invariant(!raw.apiKeyEnv&&!raw.sessionHeader,'ChatGPT認証にAPIキーや追加認証ヘッダーは使えません。');
 }else if(!authMode.startsWith('pi-'))invariant(!raw.accountId,'APIキー接続にアカウントは指定できません。');
 const caps={text:true,tools:null,vision:null,structured:null};
 for(const [k,v] of Object.entries(raw.capabilities||{})){invariant(Object.hasOwn(caps,k)&&[true,false,null].includes(v),'Invalid capability declaration');caps[k]=v;}
 const number=(name,fallback,min,max)=>{const x=raw[name]??fallback;invariant(x===null||Number.isInteger(x)&&x>=min&&x<=max,`Invalid ${name}`);return x;};
 invariant(!raw.apiKeyEnv||/^[A-Z_][A-Z0-9_]{0,100}$/.test(raw.apiKeyEnv),'Invalid API key environment variable');
 invariant(raw.enabled===undefined||typeof raw.enabled==='boolean','Invalid enabled');
 invariant(!raw.resource||idPattern.test(raw.resource),'Invalid resource group');
 invariant(!raw.reasoningEffort||['minimal','low','medium','high'].includes(raw.reasoningEffort),'Invalid reasoning effort');
 invariant(raw.server===undefined||SERVERS.includes(raw.server),'Invalid server kind');
 invariant(!raw.sessionHeader||/^x-[a-z0-9-]{1,60}$/.test(raw.sessionHeader),'Invalid session header name');
 invariant(!raw.thinking||raw.thinking==='off','Invalid thinking mode');
 invariant(raw.thinking!=='off'||!raw.reasoningEffort&&!raw.thinkingBudget,'思考オフは推論の強さや思考予算と同時に指定できません。');
 const slow=raw.domain==='device'?600000:raw.domain==='lan'?300000:180000;
 const p={id:raw.id,name:text(raw.name||raw.id,'name',100),protocol:raw.protocol,baseUrl:u.href.replace(/\/$/,''),model:text(raw.model,'model',160),domain:raw.domain,
  enabled:raw.enabled!==false,apiKeyEnv:raw.apiKeyEnv||'',capabilities:caps,
  pinnedAddress:raw.domain==='lan'?raw.pinnedAddress:'',allowPlainHttp:raw.domain==='lan'&&raw.allowPlainHttp===true,
  maxTokens:number('maxTokens',8192,128,131072),contextTokens:number('contextTokens',null,2048,4_000_000),
  timeoutMs:number('timeoutMs',60000,1000,600000),firstByteTimeoutMs:number('firstByteTimeoutMs',slow,1000,3600000),idleTimeoutMs:number('idleTimeoutMs',120000,1000,3600000),
  maxParallel:number('maxParallel',raw.domain==='cloud'?4:1,1,64),resource:raw.resource||raw.id,
  thinkingBudget:number('thinkingBudget',null,1024,128000),sampling:validateSampling(raw.sampling),server:raw.server||'auto',cache:raw.cache!==false,sessionHeader:raw.sessionHeader||sessionHeaderFor(u),
  ...(raw.reasoningEffort?{reasoningEffort:raw.reasoningEffort}:{}),...(raw.thinking==='off'?{thinking:'off'}:{})};
 if(authMode==='chatgpt'||authMode.startsWith('pi-')){p.authMode=authMode;p.accountId=raw.accountId;}
 if(raw.engine==='pi-ai'){p.engine='pi-ai';p.piProvider=raw.piProvider;validatePiProfile(p,options.resolvePiModel||piModel);}
 p.identity=digest(p);return p;
}
export function validateRegistry(raw,options={}){
 invariant(raw&&Object.keys(raw).every(k=>['profiles','routes'].includes(k)),'Invalid provider configuration');
 invariant(Array.isArray(raw.profiles)&&raw.profiles.length<=32,'At most 32 named providers');
 const profiles=raw.profiles.map(p=>validateProfile(p,options)),ids=new Set(profiles.map(p=>p.id));invariant(ids.size===profiles.length,'Duplicate provider IDs');
 const routes={};
 for(const [role,r] of Object.entries(raw.routes||{})){
  invariant(ROUTE_ROLES.includes(role)&&r&&Object.keys(r).every(k=>['primary','fallbacks'].includes(k)),'Invalid route');
  const chain=[r.primary,...(r.fallbacks||[])];invariant(chain.length<=8&&new Set(chain).size===chain.length,'Invalid fallback chain');
  for(const id of chain){const p=profiles.find(p=>p.id===id);invariant(p?.enabled,'Route refers to a missing or disabled profile');if(role==='vision')invariant(p.capabilities.vision!==false,'Vision routes need a vision-capable model');if(role==='dictation')invariant(p.domain==='device','Dictation stays on this PC');}
  invariant(new Set(chain.map(id=>credentialClass(profiles.find(p=>p.id===id)))).size===1,'ChatGPTアカウントとAPI課金の境界を跨ぐ自動切替はできません。');
  routes[role]={primary:r.primary,fallbacks:r.fallbacks||[]};
 }
 invariant(!profiles.length||routes.main||routes.chat||routes.work,'A main route is required');
 return {profiles,routes};
}

/** Bounded admission with priority + ageing; no claimed GPU preemption. */
export class ResourceGate{
 constructor(){this.groups=new Map();}
 /** `reserve` slots stay free for urgent work (priority ≥ 10, the resident character): background work waits
  * rather than take the last slot, so a spoken reply never queues behind a long worker generation. */
 acquire(key,limit,{signal,priority=0,reserve=0}={}){
  signal?.throwIfAborted();for(const [k,v] of this.groups)if(!v.active&&!v.queue.length)this.groups.delete(k);
  let g=this.groups.get(key);if(!g){g={key,active:0,queue:[],limit,reserve:0};this.groups.set(key,g);}
  g.limit=limit;g.reserve=Math.min(reserve,Math.max(0,limit-1));invariant(g.queue.length<256,'Inference queue is full',429);
  return new Promise((resolve,reject)=>{
   const entry={resolve,reject,priority,at:Date.now(),signal};
   entry.abort=()=>{const i=g.queue.indexOf(entry);if(i>=0)g.queue.splice(i,1);reject(signal.reason);this.drain(g);};
   signal?.addEventListener('abort',entry.abort,{once:true});g.queue.push(entry);this.drain(g);
  });
 }
 drain(g){
  // Waiting raises priority, but never past the next class: a worker cannot overtake the character.
  const rank=e=>e.priority+Math.min(9,(Date.now()-e.at)/2000);
  while(g.active<g.limit&&g.queue.length){
   g.queue.sort((a,b)=>rank(b)-rank(a));
   const urgentRoom=g.active<g.limit,normalRoom=g.active<g.limit-g.reserve;
   const i=g.queue.findIndex(e=>e.priority>=10?urgentRoom:normalRoom);if(i<0)return;
   const [entry]=g.queue.splice(i,1);entry.signal?.removeEventListener('abort',entry.abort);if(entry.signal?.aborted){entry.reject(entry.signal.reason);continue;}
   g.active++;let released=false;entry.resolve(()=>{if(released)return;released=true;g.active--;this.drain(g);});
  }
 }
 snapshot(){return [...this.groups].map(([resource,g])=>({resource,active:g.active,queued:g.queue.length,limit:g.limit}));}
 close(){for(const g of this.groups.values())for(const e of g.queue.splice(0)){e.signal?.removeEventListener('abort',e.abort);e.reject(new RouteUnavailable('Service closed'));}this.groups.clear();}
}
const DEFAULT_CONTEXT={anthropic:200000,gemini:1000000,responses:200000,'chat-completions':128000};
export class ProviderRegistry{
 constructor(store,network,{auth=null,pi=null,clientFactory=(p,k,f)=>new ProtocolClient(p,k,f),clock=()=>Date.now(),detectLimits=true}={}){
  Object.assign(this,{store,network,clientFactory,clock,detectLimits,auth,pi});this.active=new Map();this.keys=new Map();this.health=new Map();this.gate=new ResourceGate();this.limitCache=new Map();this.pendingLimits=new Map();this.slotState=new Map();
  for(const [id,key] of Object.entries(store.value('provider-keys')||{}))if(typeof key==='string')this.keys.set(id,key);
 }
 get(){return this.store.value('provider-registry')||{schema:2,revision:0,profiles:[],routes:{}};}
 get configured(){return this.get().profiles.length>0;}
 publicSnapshot(){const c=this.get();return {...c,profiles:c.profiles.map(p=>({...p,...(p.authMode?.startsWith('pi-')?{authStatus:this.pi?.status(p.accountId)||{connected:false}}:{}),keyPresent:p.authMode?.startsWith('pi-')?!!this.pi?.status(p.accountId).connected:p.authMode==='chatgpt'?!!this.auth?.status(p.accountId).connected:!!this.keyFor(p),...(p.authMode==='chatgpt'?{authStatus:this.auth?.status(p.accountId)||{connected:false,error:'通常起動でChatGPTへ接続してください。'}}:{}),health:this.health.get(p.id)||null,limits:this.knownLimits(p),probe:this.store.get('provider-probe',p.identity)||null})),resources:this.gate.snapshot()};}
 save(raw,expectedRevision){
  const old=this.get();invariant(old.revision===expectedRevision,'接続設定が更新されています。',409);
  const c={schema:2,revision:old.revision+1,...validateRegistry(raw,{resolvePiModel:(provider,id,accountId)=>this.pi?this.pi.model(provider,id,accountId):piModel(provider,id)})};
  for(const p of c.profiles)if(p.engine==='pi-ai'){invariant(this.pi,'このホストにはpi-ai接続がありません。');this.pi.assertProfile(p);}
  for(const [id] of this.keys){const a=old.profiles.find(p=>p.id===id),b=c.profiles.find(p=>p.id===id);if(!a||!b||a.baseUrl!==b.baseUrl||a.protocol!==b.protocol||a.engine!==b.engine||a.piProvider!==b.piProvider||credentialClass(a)!==credentialClass(b))this.keys.delete(id);}
  this.persistKeys();
  for(const [controller,p] of this.active)if(!c.profiles.some(x=>x.identity===p.identity&&x.enabled))controller.abort(new ProviderError('auth','接続設定が変更されました。'));
  for(const id of this.health.keys())if(!c.profiles.some(p=>p.id===id))this.health.delete(id);
  this.store.value('provider-registry',c);this.store.emit('providers.updated',this.publicSnapshot());return this.publicSnapshot();
 }
 persistKeys(){this.store.value('provider-keys',Object.fromEntries(this.keys));}
 keyFor(p){const current=this.get().profiles.find(x=>x.id===p.id);if(!current||current.identity!==p.identity||p.authMode==='chatgpt'||p.authMode?.startsWith('pi-'))return '';return this.keys.get(p.id)||(p.apiKeyEnv?process.env[p.apiKeyEnv]:'')||'';}
 setKey(id,key,identity){const p=this.get().profiles.find(p=>p.id===id);invariant(p,'接続先が見つかりません。',404);invariant(!identity||identity===p.identity,'接続設定が変更されています。',409);invariant(p.authMode!=='chatgpt'&&!p.authMode?.startsWith('pi-'),'ChatGPT接続にはAPIキーを設定できません。');invariant(typeof key==='string'&&key.length<=8000,'Invalid key');if(key)this.keys.set(id,key);else this.keys.delete(id);this.persistKeys();for(const [controller,x]of this.active)if(x.id===id)controller.abort(new ProviderError('auth','接続先の認証が変更されました。'));this.health.delete(id);return {id,keyPresent:!!this.keyFor(p)};}
 /** Profiles for one role, primary first, following role fallbacks (e.g. compaction → work → main). */
 chain(role='work',c=this.get()){
  for(const r of FALLBACK[role]||[role]){const route=c.routes[r];if(route)return [route.primary,...route.fallbacks].map(id=>c.profiles.find(p=>p.id===id)).filter(p=>p?.enabled);}
  return [];
 }
 hasRoute(role){return (FALLBACK[role]||[role]).some(r=>this.get().routes[r]);}
 permitted(p,purpose='model'){return this.get().profiles.some(x=>x.enabled&&x.identity===p.identity)&&this.network.permitted(p.domain,purpose);}
 knownLimits(p){
  const known=this.limitCache.get(p.identity)||this.store.value('provider-limits:'+p.identity)||null;
  if(p.engine!=='pi-ai')return known;
  const model=this.pi?.model(p.piProvider,p.model,p.accountId||null);if(!model)return null;
  const value={context:p.contextTokens||model.contextWindow,server:'other',slots:null,source:p.contextTokens?'configured':'pi-ai',at:known?.at||new Date(this.clock()).toISOString()};
  if(known?.learned&&known.context<value.context)Object.assign(value,{context:known.context,learned:true,source:'overflow'});
  return value;
 }
 /** Context window, output ceiling and server kind. Detected once, cached, corrected by overflow errors. */
 async limits(p,signal){
  const known=this.knownLimits(p),fresh=known&&(known.source!=='guess'||this.clock()-Date.parse(known.at)<120000);
  if(fresh){this.limitCache.set(p.identity,known);return known;}
  if(this.pendingLimits.has(p.identity))return this.pendingLimits.get(p.identity);
  const job=this.detect(p,signal).catch(()=>({context:p.contextTokens||DEFAULT_CONTEXT[p.protocol],server:p.server==='auto'?'other':p.server,slots:null,source:'default'}))
   .then(found=>{const value={context:p.contextTokens||found.context||DEFAULT_CONTEXT[p.protocol],server:p.server==='auto'?found.server||'other':p.server,slots:found.slots||null,source:p.contextTokens?'configured':found.source||'default',at:new Date().toISOString()};
    if(found.modelMax)value.modelMax=found.modelMax;
    if(known?.learned&&known.context<value.context)Object.assign(value,{context:known.context,learned:true});
    this.limitCache.set(p.identity,value);this.store.value('provider-limits:'+p.identity,value);return value;})
   .finally(()=>this.pendingLimits.delete(p.identity));
  this.pendingLimits.set(p.identity,job);return job;
 }
 learnLimit(p,limit){
  const old=this.knownLimits(p)||{context:DEFAULT_CONTEXT[p.protocol],server:p.server};
  const value={...old,context:Math.max(1024,Math.min(old.context||limit,limit)),learned:true,source:'overflow',at:new Date().toISOString()};
  this.limitCache.set(p.identity,value);this.store.value('provider-limits:'+p.identity,value);return value;
 }
 async detect(p,signal){
  if(p.engine==='pi-ai')return {context:this.pi?.model(p.piProvider,p.model,p.accountId||null)?.contextWindow||p.contextTokens||128000,server:'other',source:'pi-ai'};
  if(!this.detectLimits||p.authMode==='chatgpt')return {};
  const origin=new URL(p.baseUrl).origin,scope=base=>this.network.fetch({profile:{...p,baseUrl:base},purpose:'model',timeoutMs:4000,maxBytes:2_000_000});
  const get=async(url,base=origin,init={})=>{const r=await scope(base)(url,{signal,...init});if(!r.ok){await r.body?.cancel();return null;}try{return await r.json();}catch{return null;}};
  if(p.protocol==='chat-completions'&&p.domain!=='cloud'){
   const props=await get(origin+'/props').catch(()=>null);
   const n=props?.default_generation_settings?.n_ctx??props?.n_ctx;
   if(Number.isInteger(n)&&n>0)return {context:n,server:'llama.cpp',slots:props.total_slots||null,source:'llama.cpp /props'};
   const version=await get(origin+'/api/version').catch(()=>null);
   if(version?.version){
    // Tepora talks to Ollama through its native API and sets num_ctx on every request, so the window is the one
    // it asks for (up to 32k unless the profile says otherwise), not whatever the model was loaded with before.
    const show=await get(origin+'/api/show',origin,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:p.model})}).catch(()=>null);
    const max=Object.entries(show?.model_info||{}).find(([k])=>k.endsWith('.context_length'))?.[1];
    return {context:Math.min(Number.isInteger(max)&&max>=2048?max:32768,32768),server:'ollama',modelMax:Number.isInteger(max)?max:null,source:'ollama /api/show'};
   }
   const lm=await get(`${origin}/api/v0/models/${encodeURIComponent(p.model)}`).catch(()=>null);
   if(lm&&(lm.loaded_context_length||lm.max_context_length))return {context:lm.loaded_context_length||lm.max_context_length,server:'lmstudio',source:'lmstudio'};
   const models=await get(p.baseUrl+'/models',p.baseUrl).catch(()=>null),entry=models?.data?.find(m=>m.id===p.model)||models?.data?.[0];
   if(Number.isInteger(entry?.max_model_len))return {context:entry.max_model_len,server:'vllm',source:'vllm /models'};
   return {};
  }
  const catalog=this.store.get('catalog','models.dev')?.entries?.find(m=>m.modelId===p.model||m.modelId.endsWith('/'+p.model));
  return catalog?.context?{context:catalog.context,server:p.domain==='cloud'?'openai':'other',source:'models.dev'}:{server:p.domain==='cloud'?'openai':'other'};
 }
 /** Waits learnt per model: one that thinks silently past the limit gets twice the limit from then on. */
 timeouts(p){const t=this.store.value('provider-timeouts:'+p.identity)||{};return {firstByteTimeoutMs:Math.max(p.firstByteTimeoutMs,t.firstByteTimeoutMs||0),idleTimeoutMs:Math.max(p.idleTimeoutMs,t.idleTimeoutMs||0)};}
 learnTimeout(p){
  const t=this.timeouts(p),next={firstByteTimeoutMs:Math.min(3600000,Math.max(t.firstByteTimeoutMs,t.idleTimeoutMs*2)),idleTimeoutMs:Math.min(1800000,t.idleTimeoutMs*2),at:new Date().toISOString()};
  this.store.value('provider-timeouts:'+p.identity,next);this.store.emit('route.timeout',{profileId:p.id,idleTimeoutMs:next.idleTimeoutMs});return next;
 }
 /** Images go to a model unless it is declared blind or has rejected images before. */
 visionAllowed(p){return !!p&&p.capabilities?.vision!==false&&!this.store.value('provider-novision:'+p.identity);}
 learnNoVision(p){this.store.value('provider-novision:'+p.identity,{at:new Date().toISOString()});}
 /** llama.cpp slots, handed out per request: the session's previous slot when free (its KV cache is there),
  * otherwise a free one, avoiding the character's slot. Pinning by hash made two sessions wait for one slot
  * while another sat idle (llama.cpp defers a request whose requested slot is busy). */
 leaseSlot(resource,slots,key,urgent){
  let st=this.slotState.get(resource);if(!st){st={busy:new Set(),last:new Map(),urgent:null};this.slotState.set(resource,st);}
  let slot=st.last.get(key);
  if(slot===undefined||slot>=slots||st.busy.has(slot)){
   const free=[...Array(slots).keys()].filter(i=>!st.busy.has(i));
   slot=(urgent?free:free.filter(i=>i!==st.urgent)).concat(free)[0];
  }
  if(slot===undefined)return null;
  st.busy.add(slot);if(urgent)st.urgent=slot;
  if(key){st.last.delete(key);st.last.set(key,slot);if(st.last.size>500)st.last.delete(st.last.keys().next().value);}
  return {slot,release:()=>st.busy.delete(slot)};
 }
 /** Conservative catalog estimate; absent or conflicting prices remain unknown. */
 price(route){if(route.authMode==='chatgpt'||route.authMode==='pi-oauth')return null;if(route.engine==='pi-ai'){const cost=this.pi?.model(route.piProvider,route.model,route.accountId||null)?.cost;return cost?{input:cost.input,output:cost.output,cache_read:cost.cacheRead,cache_write:cost.cacheWrite}:null;}return modelPrice(this.store,route);}
 compat(p){return this.store.value('provider-compat:'+p.identity)||{drop:[]};}
 addCompat(p,param){const c=this.compat(p);if(!c.drop.includes(param)){c.drop.push(param);this.store.value('provider-compat:'+p.identity,c);}return c;}
 /** One model call with retries, parameter self-healing and failover. Overflow is returned to the caller,
  * which compacts and retries; when every destination is down, RouteUnavailable carries a retry delay. */
 async invoke(role,messages,{tools=[],signal,onDelta,onReasoning,onProgress,onRoute=()=>{},priority=0,maxTokens,toolChoice='auto',cacheKey=null,slotKey=null,cacheRetention='short',requirement=tools.length?'tools':'text',accountingSessionId=null,accountingPurpose='normal',accountingAttempt=1}={}){
  const chain=Array.isArray(role)?role:this.chain(role);
  if(!chain.length)throw new RouteUnavailable('会話・作業に使うモデルを「AIとの接続」で登録してください。',{kind:'unconfigured',retryAfterMs:60000});
  const purpose=requirement==='vision'?'vision':'model';let last=null,attempted=0,soonest=Infinity;
  for(const p of chain){
   if(credentialClass(p)!==credentialClass(chain[0]))throw new ProviderError('auth','認証・課金が異なる接続先へ自動切替しません。');
   if(!this.permitted(p,purpose)){last||=new RouteUnavailable('現在の通信モードでは使える接続先がありません。');continue;}
   if(requirement==='vision'&&!this.visionAllowed(p))continue;
   const h=this.health.get(p.id);if(h?.identity===p.identity&&h.until>this.clock()){soonest=Math.min(soonest,h.until-this.clock());continue;}
   let learned=0;
   for(let attempt=0;attempt<3;attempt++){
    let release,lease,receipt,controller;
    try{
     const limits=await this.limits(p,signal),compat=this.compat(p);
     // A llama.cpp server with several slots serves that many requests at once; one slot stays free for the character.
     const slots=limits.server==='llama.cpp'&&limits.slots>1?limits.slots:0,parallel=Math.max(p.maxParallel,slots);
     release=await this.gate.acquire(p.resource,parallel,{signal,priority,reserve:parallel>1&&p.domain!=='cloud'?1:0});
     lease=slots&&slotKey?this.leaseSlot(p.resource,slots,slotKey,priority>=10):null;
     const outputCap=Math.max(256,Math.min(maxTokens||p.maxTokens,p.maxTokens,Math.floor(limits.context/2)));
     const event={profileId:p.id,model:p.model,domain:p.domain,protocol:p.protocol,identity:p.identity,attempt:++attempted,contextTokens:limits.context,server:limits.server,at:new Date().toISOString()};
     onRoute(event);
     const t=this.timeouts(p);
     // Ollama's native API lives beside /v1 on the same server, so its scope is the server's origin.
     const scope=limits.server==='ollama'&&p.protocol==='chat-completions'?{...p,baseUrl:new URL(p.baseUrl).origin}:p;
     receipt=new ModelDispatch(this.store,p,{sessionId:accountingSessionId,purpose:accountingPurpose,attempt:attempted+Math.max(0,accountingAttempt-1),price:this.price(p)});
     controller=new AbortController();this.active.set(controller,p);
     let callSignal=AbortSignal.any([controller.signal,...(signal?[signal]:[])]),key=this.keyFor(p);
     if(p.authMode==='chatgpt'){
      if(!this.auth)throw new ProviderError('auth','このホストではChatGPT認証が利用できません。');
      const credential=await this.auth.acquire(p.accountId,callSignal);key=credential.key;callSignal=credential.signal;
     }
     callSignal.throwIfAborted();invariant(this.permitted(p,purpose),'接続先が変更されています。',409);
     const client=p.engine==='pi-ai'?{chat:(m,o)=>{invariant(this.pi,'pi-aiを通常起動で使用してください。');return this.pi.chat(p,key,m,o,()=>receipt.start());}}:this.clientFactory({...p,server:limits.server},key,this.network.fetch({profile:scope,purpose,firstByteTimeoutMs:t.firstByteTimeoutMs,idleTimeoutMs:t.idleTimeoutMs,maxBytes:64_000_000,onDispatch:()=>receipt.start()}));
     const answer=await client.chat(messages,{tools,signal:callSignal,maxTokens:outputCap,toolChoice,cacheKey,cacheRetention,sampling:p.sampling,compat,slot:lease?.slot??null,numCtx:limits.server==='ollama'?limits.context:null,onDelta,onReasoning,onProgress,onUsageSnapshot:usage=>receipt.observe(usage)});
     callSignal.throwIfAborted();
     receipt.finish(answer,'completed');
     this.health.set(p.id,{identity:p.identity,failures:0,until:0});
     return {...answer,route:{...event,maxTokens:outputCap}};
    }catch(e){
     receipt?.finish(null,signal?.aborted?'cancelled':'error');
     if(e.kind==='accounting'||e.partialOutput)throw e;
     if(signal?.aborted)throw signal.reason??e;
     last=e;
     // Silent past the idle limit (long thinking, slow prompt loading): wait twice as long from now on and retry.
     if(e.idle&&learned<3){learned++;this.learnTimeout(p);attempt--;continue;}
     if(e.kind==='bad-request'&&e.param&&!this.compat(p).drop.includes(e.param)){this.addCompat(p,e.param);attempt--;continue;}
     if(e.kind==='overflow'){if(e.limit)this.learnLimit(p,e.limit);throw e;}
     if(e instanceof NetworkBlocked||e.blocked)break;
     if(e.kind==='rate'){this.markDown(p,e.retryAfterMs||15000,e);soonest=Math.min(soonest,e.retryAfterMs||15000);break;}
     if(e.kind==='auth'||e.kind==='bad-request'||e.kind==='invalid-output')break;
     if(attempt<2){await sleep(1000*3**attempt,signal);continue;}
     const failures=(h?.failures||0)+1,wait=Math.min(300000,5000*2**Math.min(failures,6));this.markDown(p,wait,e,failures);soonest=Math.min(soonest,wait);
    }finally{if(controller)this.active.delete(controller);lease?.release();release?.();}
   }
  }
  if(last&&['auth','bad-request','invalid-output'].includes(last.kind))throw last;
  throw new RouteUnavailable(last?`接続先が応答しません（${String(last.message).slice(0,160)}）。時間を置いて再試行します。`:'使える接続先がありません。',{retryAfterMs:Number.isFinite(soonest)?Math.max(1000,soonest):30000});
 }
 markDown(p,ms,e,failures){this.health.set(p.id,{identity:p.identity,failures:failures??(this.health.get(p.id)?.failures||0),until:this.clock()+ms,lastError:e?.kind||e?.name});this.store.emit('route.failed',{profileId:p.id,kind:e?.kind||null,retryAfterMs:ms});}
 async models(id,{identity,consent=false,signal}={}){
  invariant(consent===true,'モデル一覧の取得を許可してください。',403);
  const p=this.get().profiles.find(x=>x.id===id);invariant(p?.enabled,'Unknown enabled provider',404);
  invariant(identity===p.identity,'接続設定が更新されています。',409);invariant(this.permitted(p),'この接続先は現在の通信モードで使用できません。',403);
  if(p.engine==='pi-ai'){invariant(this.pi,'pi-aiを通常起動で使用してください。');return this.pi.models(p.piProvider,p.accountId);}
  if(p.authMode==='chatgpt')return this.auth.models(p.accountId,{consent,signal});
  const headers=p.protocol==='anthropic'?{'anthropic-version':'2023-06-01',...(this.keyFor(p)?{'x-api-key':this.keyFor(p)}:{})}:p.protocol==='gemini'?(this.keyFor(p)?{'x-goog-api-key':this.keyFor(p)}:{}):(this.keyFor(p)?{Authorization:'Bearer '+this.keyFor(p)}:{});
  const r=await this.network.fetch({profile:p,purpose:'model',timeoutMs:15000,maxBytes:2_000_000})(p.baseUrl+'/models',{headers,signal,redirect:'error'});
  invariant(r.ok,`モデル一覧を取得できません（HTTP ${r.status}）。モデルIDを手入力できます。`,502);
  const data=await r.json(),items=data.data||data.models;invariant(Array.isArray(items),'モデル一覧の形式を確認できません。モデルIDを手入力してください。',502);
  invariant(this.permitted(p),'取得中に接続先が変更されました。',409);
  const models=items.filter(x=>x&&typeof (x.id||x.name)==='string').slice(0,500).map(x=>({id:(x.id||x.name).replace(/^models\//,''),name:x.displayName||x.display_name||x.id||x.name})).filter(x=>x.id.length<=160&&typeof x.name==='string').map(x=>({...x,name:x.name.slice(0,200)}));
  return {profileId:id,models,verified:false,note:'一覧への掲載は推論成功や品質の保証ではありません。'};
 }
 async probe(id,signal){
  const p=this.get().profiles.find(p=>p.id===id);invariant(p?.enabled,'Unknown enabled provider',404);
  const limits=await this.limits(p,signal).catch(()=>null);
  const client={chat:(messages,options)=>this.invoke([p],messages,{...options,signal,accountingPurpose:'probe'})};
  const result=await probeRuntime(client,{provider:p.protocol,baseUrl:p.baseUrl,model:p.model},signal);
  const doc={...result,id:p.identity,profileId:id,ok:result.passed===true,limits,at:new Date().toISOString(),scope:'safe tool roundtrip only, not quality or vision'};
  this.store.put('provider-probe',doc);this.store.emit('providers.updated',this.publicSnapshot());return doc;
 }
 close(){for(const controller of this.active.keys())controller.abort(new ProviderError('auth','Service closed'));this.active.clear();this.gate.close();}
}
export {ProviderError};

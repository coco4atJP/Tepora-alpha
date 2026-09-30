import {createHash} from 'node:crypto';
import {validateProfile,ResourceGate} from './provider-registry.mjs';
import {invariant,text} from './policy.mjs';
import {normalURL,NetworkBlocked} from './network-policy.mjs';
import {DecisionClient} from './decision.mjs';

/** Modality endpoints are NOT chat models. No dependency on Vercel or a hosted gateway. */
export const CAPABILITY_PROTOCOLS={
 'system-one':'decision','openai-embeddings':'embedding','ollama-embed':'embedding',
 'openai-speech':'tts','openai-images':'image','openai-image-edit':'image_edit','xai-video':'video'
};
export const CAPABILITY_ROLES=['decision','embedding','tts','image','image_edit','video'];
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fields=new Set(['id','name','protocol','baseUrl','model','domain','pinnedAddress','allowPlainHttp',
 'enabled','apiKeyEnv','timeoutMs','maxParallel','resource','voice','dimensions','assetOrigins']);
export function validateCapability(raw){
 invariant(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).every(k=>fields.has(k)),'Unknown capability setting');
 invariant(Object.hasOwn(CAPABILITY_PROTOCOLS,raw.protocol),'Choose a supported modality protocol');
 const base={};for(const k of ['id','name','baseUrl','model','domain','pinnedAddress','allowPlainHttp','enabled','apiKeyEnv','timeoutMs','maxParallel','resource'])if(k in raw)base[k]=raw[k];
 const p=validateProfile({...base,protocol:'chat-completions'});
 const assetOrigins=raw.assetOrigins||[];
 invariant(Array.isArray(assetOrigins)&&assetOrigins.length<=8,'At most eight media download origins');
 for(const value of assetOrigins){const u=normalURL(value);invariant(u.protocol==='https:'&&u.pathname==='/'&&!u.port,'Media origins must be exact HTTPS origins');}
 invariant(raw.voice===undefined||typeof raw.voice==='string'&&raw.voice.length<=120,'Invalid voice');
 invariant(raw.dimensions===undefined||Number.isInteger(raw.dimensions)&&raw.dimensions>0&&raw.dimensions<=8192,'Invalid embedding dimensions');
 const result={id:p.id,name:p.name,baseUrl:p.baseUrl,model:p.model,domain:p.domain,enabled:p.enabled,
  pinnedAddress:p.pinnedAddress,allowPlainHttp:p.allowPlainHttp,apiKeyEnv:p.apiKeyEnv,timeoutMs:p.timeoutMs,
  maxParallel:p.maxParallel,resource:p.resource,protocol:raw.protocol,role:CAPABILITY_PROTOCOLS[raw.protocol],
  voice:raw.voice||'alloy',dimensions:raw.dimensions||null,assetOrigins:assetOrigins.map(x=>new URL(x).origin)};
 result.identity=hash(result);return result;
}
export class Capabilities{
 constructor(store,network){Object.assign(this,{store,network});this.keys=new Map();this.gate=new ResourceGate();this.closed=false;}
 get(){return this.store.value('capabilities')||{schema:1,revision:0,profiles:[],routes:{}};}
 snapshot(){const c=this.get();return {...c,profiles:c.profiles.map(p=>({...p,keyPresent:!!this.keyFor(p)}))};}
 save(input,expectedRevision){
  invariant(expectedRevision===this.get().revision,'Capability settings changed. Reload before saving.',409);
  invariant(input&&Object.keys(input).every(k=>['profiles','routes'].includes(k))&&Array.isArray(input.profiles)&&input.profiles.length<=64,'Invalid capability registry');
  const profiles=input.profiles.map(validateCapability),ids=new Set(profiles.map(p=>p.id));invariant(ids.size===profiles.length,'Duplicate capability ID');
  const routes={};for(const [role,id]of Object.entries(input.routes||{})){
   invariant(CAPABILITY_ROLES.includes(role),'Unknown capability role');const p=profiles.find(p=>p.id===id);
   invariant(p?.enabled&&p.role===role,'Route and endpoint capability do not match');routes[role]=id;
  }
  const previous=this.get(),next={schema:1,revision:previous.revision+1,profiles,routes};
  for(const p of previous.profiles){const n=profiles.find(n=>n.id===p.id);
   if(!n||p.baseUrl!==n.baseUrl||p.protocol!==n.protocol||p.pinnedAddress!==n.pinnedAddress)this.keys.delete(p.id);
   if(!n||n.identity!==p.identity||!n.enabled)for(const [c,e]of this.network.active)if(e.profileId==='cap:'+p.id)c.abort(new NetworkBlocked('Capability endpoint changed'));
  }
  this.store.value('capabilities',next);this.store.emit('capabilities.updated',this.snapshot());return this.snapshot();
 }
 current(p){return !this.closed&&this.get().profiles.some(x=>x.enabled&&x.identity===p.identity);}
 pin(role){const c=this.get(),p=c.profiles.find(x=>x.id===c.routes[role]);invariant(p?.enabled&&p.role===role,`${role} の接続先を選んでください。`,409);return structuredClone(p);}
 keyFor(p){if(!this.current(p))return '';return this.keys.get(p.id)||(p.apiKeyEnv?process.env[p.apiKeyEnv]:'')||'';}
 setKey(id,key,identity){const p=this.get().profiles.find(p=>p.id===id);invariant(p?.identity===identity,'Capability changed',409);invariant(typeof key==='string'&&key.length<=4000,'Invalid key');if(key)this.keys.set(id,key);else this.keys.delete(id);return {id,keyPresent:!!this.keyFor(p)};}
 async request(p,route,{method='POST',json,body,signal,maxBytes=8_000_000}={}){
  invariant(this.current(p),'The capability endpoint changed or was disabled',409);
  invariant(typeof route==='string'&&/^\/[a-z0-9_/-]+$/i.test(route)&&!route.includes('..'),'Invalid modality route');
  const release=await this.gate.acquire('cap:'+p.resource,p.maxParallel,{signal,priority:p.role==='tts'?10:0});
  try{
   invariant(this.current(p),'Capability changed while queued',409);
   const key=this.keyFor(p),headers={...(key?{Authorization:`Bearer ${key}`}:{})};if(json!==undefined)headers['Content-Type']='application/json';
   const response=await this.network.request(p.baseUrl.replace(/\/$/,'')+route,{method,headers,signal,body:json!==undefined?JSON.stringify(json):body},
    {profile:{...p,id:'cap:'+p.id},purpose:'model',timeoutMs:p.timeoutMs,maxBytes});
   if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`能力接続 HTTP ${response.status}`),{status:502,upstreamStatus:response.status,knownRejected:response.status<500});}
   // Consume under the resource lease, not only until headers arrive.
   const bytes=Buffer.from(await response.arrayBuffer());invariant(this.current(p),'Capability changed during response',409);
   return new Response(bytes,{status:response.status,headers:response.headers});
  }finally{release();}
 }
 async decide(state,questions,signal,p=this.pin('decision')){
  invariant(p.role==='decision','Not a decision endpoint');
  // DecisionClient validates exact typed outputs; this adapter supplies the transport/auth policy.
  const client=new DecisionClient({url:'http://127.0.0.1/v1/systemone',model:p.model,timeoutMs:p.timeoutMs},async(_url,init)=>{
   return this.request(p,'/systemone',{json:JSON.parse(init.body),signal:init.signal});
  });
  return client.decide(state,questions,signal);
 }
 async embed(inputs,{signal,profile=this.pin('embedding')}={}){
  const p=profile;invariant(p.role==='embedding','Not an embedding endpoint');
  invariant(Array.isArray(inputs)&&inputs.length>=1&&inputs.length<=32&&inputs.every(s=>typeof s==='string'&&s.length>0&&s.length<=12000),'Embedding input budget exceeded');
  const json={model:p.model,input:inputs};if(p.protocol==='openai-embeddings'){json.encoding_format='float';if(p.dimensions)json.dimensions=p.dimensions;}
  const r=await this.request(p,p.protocol==='ollama-embed'?'/embed':'/embeddings',{json,signal});const data=await r.json();
  let vectors;
  if(p.protocol==='ollama-embed')vectors=data.embeddings;
  else{invariant(Array.isArray(data.data)&&data.data.length===inputs.length,'Missing embeddings',502);
   vectors=new Array(inputs.length);for(const row of data.data){invariant(Number.isInteger(row.index)&&row.index>=0&&row.index<inputs.length&&!vectors[row.index],'Invalid embedding indices',502);vectors[row.index]=row.embedding;}}
  invariant(Array.isArray(vectors)&&vectors.length===inputs.length,'Embedding count mismatch',502);
  const dimensions=vectors[0]?.length;invariant(Number.isInteger(dimensions)&&dimensions>0&&dimensions<=8192&&(!p.dimensions||p.dimensions===dimensions),'Embedding dimension mismatch',502);
  for(const v of vectors)invariant(Array.isArray(v)&&v.length===dimensions&&v.every(Number.isFinite)&&v.some(x=>x!==0),'Invalid embedding vector',502);
  return {vectors,dimensions,model:p.model,identity:p.identity};
 }
 async download(p,url,signal){
  invariant(this.current(p),'Capability changed',409);const u=normalURL(url,{query:true});
  invariant(u.origin===new URL(p.baseUrl).origin||p.assetOrigins.includes(u.origin),'生成済みファイルの配信元を接続設定で許可してください。',403);
  // Download origins are explicit. Never forward API credentials or private headers to them.
  const profile={...p,id:'cap:'+p.id,baseUrl:u.origin,domain:u.origin===new URL(p.baseUrl).origin?p.domain:'cloud'};
  const r=await this.network.request(u,{signal},{profile,purpose:'model',asset:true,maxBytes:32*1024*1024,timeoutMs:p.timeoutMs});
  invariant(r.ok,'Generated media download failed',502);const bytes=Buffer.from(await r.arrayBuffer());invariant(this.current(p),'Capability changed during download',409);
  return {bytes,contentType:r.headers.get('content-type')};
 }
 close(){this.closed=true;this.keys.clear();this.gate.close();}
}

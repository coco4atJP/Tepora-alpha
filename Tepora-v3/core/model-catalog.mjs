import {invariant,text} from './policy.mjs';
import {createHash} from 'node:crypto';
/** models.dev is metadata, not trusted executable code, a provider probe, or a billing promise. */
export function parseCatalog(raw){
 invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid models.dev catalog');const entries=[];
 for(const [providerId,provider]of Object.entries(raw)){
  if(!provider||typeof provider!=='object'||!provider.models)continue;
  for(const [modelId,m]of Object.entries(provider.models)){
   invariant(entries.length<30000,'Catalog exceeds model budget',413);if(!m||typeof m!=='object')continue;
   const str=(v,max)=>typeof v==='string'?v.slice(0,max):'';
   const modalities=v=>Array.isArray(v)?v.filter(x=>['text','image','audio','video','pdf'].includes(x)):[];
   entries.push({providerId:str(providerId,160),provider:str(provider.name||providerId,160),modelId:str(modelId,240),name:str(m.name||modelId,240),
    tools:typeof m.tool_call==='boolean'?m.tool_call:null,input:modalities(m.modalities?.input),output:modalities(m.modalities?.output),
    context:Number.isFinite(m.limit?.context)&&m.limit.context>0?m.limit.context:null,
    updated:str(m.last_updated,30),source:'models.dev',verified:false});
  }
 }
 invariant(entries.length>0,'No models in catalog');return entries;
}
export class ModelCatalog{
 constructor(store,network){Object.assign(this,{store,network});}
 import(raw){const entries=parseCatalog(raw),snapshot={id:'models.dev',entries,at:new Date().toISOString(),sha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex')};this.store.put('catalog',snapshot);return {count:entries.length,at:snapshot.at,verified:false};}
 async refresh(signal){const r=await this.network.request('https://models.dev/api.json',{signal},{purpose:'web',allowCloud:true,maxBytes:24*1024*1024});invariant(r.ok,'Model catalog is unavailable',502);return this.import(await r.json());}
 search(query=''){invariant(typeof query==='string'&&query.length<=300,'Invalid catalog query');const c=this.store.get('catalog','models.dev');const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
  return {models:(c?.entries||[]).filter(m=>terms.every(t=>(m.provider+' '+m.name+' '+m.modelId+' '+m.input.join(' ')+' '+m.output.join(' ')).toLowerCase().includes(t))).slice(0,80),count:c?.entries.length||0,at:c?.at||null,verified:false};}
}

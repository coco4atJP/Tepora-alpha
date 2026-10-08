/** Host lifecycle only: Rust owns receipt shaping, estimates and atomic storage. */
import {randomUUID} from 'node:crypto';
import {nativeCompute} from './native-state.mjs';

const pending=new WeakMap();
const bounded=(value,n)=>typeof value==='string'?[...value.slice(0,n*2)].slice(0,n).join(''):null;
const counter=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
// Only bounded, content-free usage crosses the accounting N-API boundary.
export function usageMetadata(answer){
 const u=answer?.usage,s=answer?.usageStatus;
 return {usage:Object.fromEntries(['input','output','cacheRead','cacheWrite'].filter(k=>u&&Object.hasOwn(u,k)).map(k=>[k,counter(u[k])]).concat(u?.uncachedOnly===true?[['uncachedOnly',true]]:[])),
  usageStatus:{status:['complete','partial','missing'].includes(s?.status)?s.status:'missing',input:s?.input==='reported'?'reported':'missing',output:s?.output==='reported'?'reported':'missing'}};
}
export function estimateModelUsage(answer,price){
 const {usage,usageStatus:status}=usageMetadata(answer);
 return nativeCompute('model.estimate',{usage,status,price:priceMetadata(price)});
}
const priceMetadata=price=>price&&typeof price==='object'?Object.fromEntries(['input','output','cache_read','cache_write'].filter(k=>Object.hasOwn(price,k)).map(k=>[k,counter(price[k])])):null;
export function modelPrice(store,route){
 if(route?.domain!=='cloud')return null;
 // The catalog's import contract caps 30,000 rows and 240-character model IDs.
 // Fail unknown on malformed legacy metadata rather than invent/truncate a match.
 const rows=store.get('catalog','models.dev')?.entries||[];
 if(!Array.isArray(rows)||rows.length>30000||rows.some(e=>typeof e?.modelId!=='string'||e.modelId.length>240))return null;
 const entries=rows.map(e=>({modelId:e.modelId,cost:priceMetadata(e.cost)}));
 return nativeCompute('model.price',{route:{domain:route?.domain,model:route?.model},entries});
}
export class ModelDispatch{
 constructor(store,profile,{sessionId=null,purpose='normal',attempt=1,price=null}={}){
  this.store=store;this.metadata={id:randomUUID(),profile:{id:bounded(profile.id,128),model:bounded(profile.model,256),protocol:bounded(profile.protocol,40)},sessionId:bounded(sessionId,128),purpose:['normal','summary','decision','probe'].includes(purpose)?purpose:'normal',attempt:Number.isSafeInteger(attempt)&&attempt>0?attempt:1,price:priceMetadata(price)};
  this.started=null;this.finished=false;this.usage=null;
 }
 start(){
  if(this.started!==null||this.finished)return;
  this.started=performance.now();
  let active=pending.get(this.store);if(!active){active=new Set();pending.set(this.store,active);}
  this.done=new Promise(resolve=>{this.resolve=resolve;});active.add(this.done);
 }
 observe(answer){this.usage=usageMetadata(answer);}
 finish(answer,outcome){
  if(this.started===null||this.finished)return;
  this.finished=true;
  try{
   const receipt=nativeCompute('model.receipt',{...this.metadata,answer:answer?usageMetadata(answer):this.usage,outcome,at:new Date().toISOString(),elapsedMs:Math.max(0,Math.floor(performance.now()-this.started))});
   this.store.db.call('model.record',{receipt});
  }catch{
   // A completed transport must never be reissued to recover a local write.
   throw Object.assign(new Error('Model dispatch accounting could not be persisted'),{kind:'accounting',status:500});
  }finally{pending.get(this.store)?.delete(this.done);this.resolve();}
 }
}
/** Called after network cancellation and before closing the sole SQLite owner. */
export async function drainModelCalls(store){await Promise.all([...pending.get(store)||[]]);}
export function modelUsageSnapshot(store,days,today){
 const measured=Object.fromEntries(days.map(day=>[day,store.value('model-usage:'+day)||null]));
 return {today:measured[today]||null,days:measured,total:store.value('model-usage-total')||null,coverage:'provider-and-typed-decision-dispatches',excluded:['embedding','speech','image','video','isolated-setup-probes'],receiptRetention:512,dayRetention:90};
}

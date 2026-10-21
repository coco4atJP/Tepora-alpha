/** A short-lived, isolated SDK worker. All SDK fetches go through the host's checked transport.
 * No ambient credentials, SDK telemetry sinks, shell tools or global fetch mutation in the app. */
import {parentPort,workerData,MessageChannel} from 'node:worker_threads';
import {toPiContext,fromPiMessage,observePiUsage} from './pi-message-codec.mjs';
const controller=new AbortController(),hardController=new AbortController(),pending=new Map(),mutations=new Set();let sequence=0,credentialLease=null;
const send=x=>parentPort.postMessage(x);
function rpc(kind,value,{durable=false}={}){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,durable});send({type:'rpc',id,kind,value});});}
parentPort.on('message',m=>{
 if(m.type==='abort'){controller.abort(new Error('Pi operation cancelled'));if(m.hard)hardController.abort(controller.signal.reason);for(const [id,p] of pending)if(m.hard||!p.durable){pending.delete(id);p.reject(controller.signal.reason);}}
 if(m.type==='reply'){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.value);}}
});
async function checkedFetch(input,init={}){
 const request=new Request(input,init),bytes=request.body?new Uint8Array(await request.arrayBuffer()):null;
 if(bytes&&bytes.length>16*1024*1024)throw new Error('Request body exceeds budget');
 const lease=credentialLease,signal=AbortSignal.any([lease?hardController.signal:controller.signal,request.signal]);signal.throwIfAborted();
 const {port1,port2}=new MessageChannel();
 return new Promise((resolve,reject)=>{
  let bodyController,settled=false,closed=false;
  const close=()=>{closed=true;signal.removeEventListener('abort',abort);port1.close();};
  const fail=e=>{if(!settled){settled=true;reject(e);}else{try{bodyController?.error(e);}catch{}}close();};
  const abort=()=>{port1.postMessage({type:'cancel'});fail(signal.reason||new Error('Cancelled'));};
  signal.addEventListener('abort',abort,{once:true});
  port1.on('message',m=>{
   if(closed)return;
   if(m.type==='error')return fail(new Error(m.message));
   if(m.type==='headers'){
    settled=true;
    const body=m.noBody?null:new ReadableStream({start(c){bodyController=c;},pull(){port1.postMessage({type:'pull'});},cancel(){port1.postMessage({type:'cancel'});close();}});
    resolve(new Response(body,{status:m.status,headers:m.headers}));if(!body)close();
   }else if(m.type==='chunk'){bodyController.enqueue(m.bytes);}
   else if(m.type==='end'){bodyController.close();close();}
  });
  parentPort.postMessage({type:'fetch',credentialLease:lease,url:request.url,init:{method:request.method,headers:[...request.headers],body:bytes},port:port2},[port2]);
 });
}
globalThis.fetch=checkedFetch;
// Suppress raw SDK errors (some upstream SDKs include request bodies in diagnostic logs).
console.log=console.warn=console.error=()=>{};
const {teporaPiModels}=await import('./pi-catalog.mjs');
const data=workerData;
const credentialStore={
 read:async()=>data.accountId?rpc('credential-read'):data.key?{type:'api_key',key:data.key}:undefined,
 list:async()=>[],
 async modify(provider,fn){
  if(!data.accountId)return fn(await this.read());
  const mutation=(async()=>{
   const {lease,credential}=await rpc('credential-lock');
   const durable=data.operation!=='login'&&credential?.type==='oauth';
   if(durable)credentialLease=lease;
   try{const next=await fn(credential);return await rpc('credential-commit',{lease,credential:next},{durable});}
   catch(e){await rpc('credential-unlock',{lease},{durable}).catch(()=>{});throw e;}
   finally{if(credentialLease===lease)credentialLease=null;}
  })();
  mutations.add(mutation);mutation.finally(()=>mutations.delete(mutation)).catch(()=>{});
  return mutation;
 },
 delete:async()=>{throw new Error('Logout is owned by the Tepora host');}
};
const models=teporaPiModels({credentials:credentialStore,authContext:{env:async()=>undefined,fileExists:async()=>false}});
try{
 let result;
 if(data.operation==='login'){
  await models.login(data.provider,data.authType,{signal:controller.signal,
   notify:event=>send({type:'auth-event',event}),
   prompt:async prompt=>{
    const {signal,...publicPrompt}=prompt;const id=++sequence;
    const onAbort=()=>{send({type:'prompt-cancel',id});const p=pending.get(id);pending.delete(id);p?.reject(new Error('Prompt cancelled'));};
    signal?.throwIfAborted();signal?.addEventListener('abort',onAbort,{once:true});
    try{return await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({type:'prompt',id,prompt:publicPrompt});});}
    finally{signal?.removeEventListener('abort',onAbort);}
   }
  },{getDeviceId:()=>data.deviceId,agentName:'Tepora'});
  result={connected:true};
 }else if(data.operation==='models'){
  const refreshed=await models.refresh({providers:[data.provider],allowNetwork:true,force:true,signal:controller.signal});
  if(refreshed.errors.size)throw [...refreshed.errors.values()][0];
  result=(await models.getAvailable(data.provider,{signal:controller.signal}));
 }else{
  const selected=data.model;
  if(!selected||selected.provider!==data.provider||selected.id!==data.profile.model)throw new Error('Model is not in the selected Pi account catalog');
  const model={...selected,...(data.profile.authMode==='pi-oauth'?{}:{baseUrl:data.profile.baseUrl})};
  const seen={input:false,output:false};
  const stream=models.streamSimple(model,toPiContext(data.messages,data.options.tools||[],model,data.profile.identity),{
   ...data.options,signal:controller.signal,fetch:checkedFetch,transport:'sse',maxRetries:0,timeoutMs:data.profile.firstByteTimeoutMs,
   onProviderStreamEvent:e=>observePiUsage(e,seen),
   transformHeaders:headers=>({...headers,'User-Agent':'Tepora/3.0 pi-ai/1.3.0',...(data.sessionHeader||{})})
  });
  for await(const event of stream){
   if(event.type==='text_delta'||event.type==='thinking_delta')send({type:'delta',kind:event.type,text:event.delta});
   if(event.type==='error')throw new Error(event.error.errorMessage||'Pi inference failed');
  }
  const message=await stream.result();
  if(['error','aborted','pending','deferred'].includes(message.stopReason))throw new Error(message.errorMessage||'Pi did not complete a synchronous response');
  result=fromPiMessage(message,data.profile.identity,seen);
 }
 await Promise.allSettled([...mutations]);
 send({type:'result',value:result});
}catch(e){await Promise.allSettled([...mutations]);send({type:'failure',code:e.code||'',message:'Pi operation failed'});}

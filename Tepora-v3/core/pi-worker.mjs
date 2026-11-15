/** A short-lived, isolated SDK child process shared by the Node and Rust hosts.
 * Protocol: one JSON object per line. The host writes `start`, replies and fetch responses to stdin;
 * the worker writes fetch/rpc/progress/result messages to stdout. Bytes travel as base64.
 * All SDK fetches go through the host's checked transport. No ambient credentials, environment,
 * SDK telemetry sinks or shell tools; closing stdin ends the process. */
import {createInterface} from 'node:readline';
import {toPiContext,fromPiMessage,observePiUsage} from './pi-message-codec.mjs';
const out=process.stdout.write.bind(process.stdout);
// Suppress raw SDK diagnostics (some upstream SDKs include request bodies in logs). stdout is the protocol.
console.log=console.info=console.debug=console.warn=console.error=()=>{};
const controller=new AbortController(),hardController=new AbortController(),pending=new Map(),fetches=new Map(),mutations=new Set();
let sequence=0,fetchSequence=0,credentialLease=null,started;
const startup=new Promise(resolve=>{started=resolve;});
const send=x=>out(JSON.stringify(x)+'\n');
function rpc(kind,value,{durable=false}={}){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,durable});send({type:'rpc',id,kind,value});});}
function receive(m){
 if(m.type==='start')return started(m.data);
 if(m.type==='abort'){controller.abort(new Error('Pi operation cancelled'));if(m.hard)hardController.abort(controller.signal.reason);for(const [id,p] of pending)if(m.hard||!p.durable){pending.delete(id);p.reject(controller.signal.reason);}return;}
 if(m.type==='reply'){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.value);}return;}
 if(m.type?.startsWith('fetch-'))fetches.get(m.id)?.(m);
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{process.exit(2);}receive(m);});
// The host owns this process; losing it ends the operation without draining.
lines.on('close',()=>process.exit(1));
async function checkedFetch(input,init={}){
 const request=new Request(input,init),bytes=request.body?new Uint8Array(await request.arrayBuffer()):null;
 if(bytes&&bytes.length>16*1024*1024)throw new Error('Request body exceeds budget');
 const lease=credentialLease,signal=AbortSignal.any([lease?hardController.signal:controller.signal,request.signal]);signal.throwIfAborted();
 const id=++fetchSequence;
 return new Promise((resolve,reject)=>{
  let bodyController,settled=false,closed=false;
  const close=()=>{closed=true;fetches.delete(id);signal.removeEventListener('abort',abort);};
  const fail=e=>{if(!settled){settled=true;reject(e);}else{try{bodyController?.error(e);}catch{}}close();};
  const abort=()=>{send({type:'fetch-cancel',id});fail(signal.reason||new Error('Cancelled'));};
  signal.addEventListener('abort',abort,{once:true});
  fetches.set(id,m=>{
   if(closed)return;
   if(m.type==='fetch-error')return fail(new Error(m.message));
   if(m.type==='fetch-headers'){
    settled=true;
    const body=m.noBody?null:new ReadableStream({start(c){bodyController=c;},pull(){send({type:'fetch-pull',id});},cancel(){send({type:'fetch-cancel',id});close();}});
    resolve(new Response(body,{status:m.status,headers:m.headers}));if(!body)close();
   }else if(m.type==='fetch-chunk'){bodyController.enqueue(new Uint8Array(Buffer.from(m.bytes,'base64')));}
   else if(m.type==='fetch-end'){bodyController.close();close();}
  });
  send({type:'fetch',id,credentialLease:lease,url:request.url,init:{method:request.method,headers:[...request.headers],body:bytes?Buffer.from(bytes).toString('base64'):null}});
 });
}
globalThis.fetch=checkedFetch;
const data=await startup;
const {teporaPiModels,PI_VERSION}=await import('./pi-catalog.mjs');
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
const finish=x=>{send(x);process.stdout.write('',()=>process.exit(0));};
try{
 let result;
 if(data.operation==='catalog'){
  // Inert metadata for hosts that cannot import the SDK. Functions (auth flows, filters) stay here.
  result={version:PI_VERSION,providers:models.getProviders().map(p=>({id:p.id,name:p.name,baseUrl:p.baseUrl||'',
   oauth:p.auth.oauth?{name:p.auth.oauth.name,subscription:p.auth.oauth.isSubscription===true,login:!!p.auth.oauth.login}:null,
   apiKey:!!p.auth.apiKey,apiKeyLogin:!!p.auth.apiKey?.login,filtersModels:typeof p.filterModels==='function',models:p.getModels()}))};
 }else if(data.operation==='login'){
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
  // Account-specific availability (e.g. Copilot policy) is decided by the SDK with the live credential.
  const def=models.getProvider(data.provider),available=data.accountId&&def?.filterModels?def.filterModels([selected],await credentialStore.read()):null;
  if(available&&!available.some(m=>m.id===selected.id))throw new Error('Model is not available to the selected Pi account');
  const model={...selected,...(data.profile.authMode==='pi-oauth'?{}:{baseUrl:data.profile.baseUrl})};
  const seen={input:false,output:false};
  const stream=models.streamSimple(model,toPiContext(data.messages,data.options.tools||[],model,data.profile.identity),{
   ...data.options,signal:controller.signal,fetch:checkedFetch,transport:'sse',maxRetries:0,timeoutMs:data.profile.firstByteTimeoutMs,
   onProviderStreamEvent:e=>observePiUsage(e,seen),
   transformHeaders:headers=>({...headers,'User-Agent':`Tepora/3.0 pi-ai/${PI_VERSION}`,...(data.sessionHeader||{})})
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
 finish({type:'result',value:result});
}catch(e){await Promise.allSettled([...mutations]);finish({type:'failure',code:e.code||'',message:'Pi operation failed'});}

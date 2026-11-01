import {checkedRequest} from '../core/network-policy.mjs';

// Prices checked against the official provider docs on 2026-10-21. Per million tokens.
export const BENCHMARK_MODELS=[
 {id:'deepseek-v4.1-flash',input:0.30,output:1.20,cache:0.006},
 {id:'minimax-m3.1-flash-free',input:0,output:0,cache:0},
 {id:'step-5-preview',input:1,output:2.70,cache:0.10},
 {id:'mimo-v2.6-flash',input:.14,output:.28,cache:.0028},
 {id:'muse-spark-1.3-contributor',input:.10,output:.20,cache:.002,protocol:'responses'}
];
export const CHAT_BASE='https://opencode.ai/inference/go/openai/v1';
export const DECISION_BASE='https://api.typesafe.ai/v1';
export function redact(value,secrets=[]){
 let text=typeof value==='string'?value:JSON.stringify(value);
 for(const secret of secrets.filter(Boolean))text=text.split(secret).join('[REDACTED]');
 return text.replace(/(?:oc_sk_|apikey_)[A-Za-z0-9_-]+/g,'[REDACTED]');
}
export function summarizeCases(cases,expected){
 const passed=cases.filter(x=>x.status==='passed').length,failed=cases.filter(x=>x.status==='failed').length,blocked=cases.filter(x=>x.status==='blocked').length;
 const durations=cases.filter(x=>x.status==='passed').map(x=>x.latencyMs).sort((a,b)=>a-b);
 const quantile=p=>durations.length?durations[Math.max(0,Math.ceil(durations.length*p)-1)]:null;
 return {expected,executed:cases.length,passed,failed,blocked,missing:Math.max(0,expected-cases.length),passRate:expected?passed/expected:0,p50Ms:quantile(.5),p95Ms:quantile(.95),complete:expected>0&&cases.length===expected&&passed===expected};
}

/** NetworkPolicy admits/pins every request. OpenCode credentials must come from
 * Pi's real login, never transport injection. Jev uses the capability transport. */
export function benchmarkMeter({keys,maxUsd=3,maxRequests=240,transport=checkedRequest,onCall=()=>{}}={}){
 if(!Number.isFinite(maxUsd)||maxUsd<=0||!Number.isInteger(maxRequests)||maxRequests<1)throw Error('Invalid benchmark budget');
 const calls=[];let reservedUsd=0,label={},blockedReason=null;
 const request=async(admitted,init,scope)=>{
  const url=new URL(admitted.url),isResponses=url.href===CHAT_BASE+'/responses',isChat=isResponses||url.href===CHAT_BASE+'/chat/completions',isDecision=url.href===DECISION_BASE+'/systemone';
  if(!isChat&&!isDecision)throw Error('Benchmark transport permits only the configured inference endpoints');
  const body=JSON.parse(typeof init.body==='string'?init.body:Buffer.from(init.body).toString()),rate=isDecision?{input:.042,output:0,cache:.042}:BENCHMARK_MODELS.find(m=>m.id===body.model);
  if(!rate)throw Error('No benchmark price bound for this model');
  if(isChat&&isResponses!==(rate.protocol==='responses'))throw Error('Benchmark model API does not match its registered protocol');
  const key=isDecision?keys.typesafe:keys.opencode;if(!key)throw Error('Missing benchmark credential');
  const outputLimit=isChat?Number(body.max_output_tokens||body.max_tokens||body.max_completion_tokens||8192):0;
  if(isChat&&(!Number.isInteger(outputLimit)||outputLimit<1||outputLimit>8192))throw Error('Invalid output limit');
  const reserve=((Buffer.byteLength(init.body)+4096)*rate.input+outputLimit*rate.output)/1e6;
  if(calls.length>=maxRequests||reservedUsd+reserve>maxUsd){blockedReason='Benchmark dispatch budget exhausted';throw Error(blockedReason);}
  reservedUsd+=reserve;
  const call={...label,kind:isDecision?'decision':'chat',...(isDecision?{decisionRole:body.questions?.action?.type==='choice'?'computer-action':'harness-decision'}:{}),requestedModel:body.model,status:null,startedAt:Date.now(),reservedUsd:reserve,inputTokens:null,outputTokens:null,cachedTokens:0};calls.push(call);onCall({...call,event:'dispatch'});
  const headers=new Headers(init.headers);
  if(isDecision){headers.set('Authorization','Bearer '+key);headers.set('User-Agent','Tepora/3.0 benchmark');}
  else{
   if(headers.get('authorization')!=='Bearer '+key||!headers.get('x-opencode-session')||!headers.get('user-agent')?.startsWith('Tepora/'))throw Error('Pi credential/session/client identity missing at dispatch');
   call.credentialMatches=true;call.sessionHeader=headers.get('x-opencode-session');call.userAgent=headers.get('user-agent');
  }
  call.url=url.href;
  try{
   const response=await transport(admitted,{...init,headers},scope);call.status=response.status;
   call.receipt=Object.fromEntries(['x-opencode-log-id','x-request-id','cf-ray'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v));
   if(!response.ok){try{const error=await response.clone().json();call.providerError=redact(String(error.error?.message||error.message||'Provider rejected request'),Object.values(keys)).slice(0,300);}catch{}}
   onCall({...call,event:'headers'});
   let tail='',settled=false;const decoder=new TextDecoder();
   const usage=event=>{const value=event?.response||event;if(value?.model)call.resolvedModel=value.model;const u=value?.usage;if(!u)return;
    call.inputTokens=u.prompt_tokens??u.input_tokens??call.inputTokens;call.outputTokens=u.completion_tokens??u.output_tokens??call.outputTokens;
    call.cachedTokens=u.prompt_tokens_details?.cached_tokens??u.input_tokens_details?.cached_tokens??u.cache_read_input_tokens??0;
   };
   const finish=()=>{try{usage(JSON.parse(tail));}catch{}for(const line of tail.split('\n'))if(line.startsWith('data: '))try{usage(JSON.parse(line.slice(6)));}catch{}
    call.latencyMs=Date.now()-call.startedAt;
    call.estimatedUsd=call.inputTokens===null||call.outputTokens===null?null:((Math.max(0,call.inputTokens-call.cachedTokens)*rate.input)+call.cachedTokens*rate.cache+call.outputTokens*rate.output)/1e6;
    if(!settled&&call.estimatedUsd!==null&&response.ok){reservedUsd+=call.estimatedUsd-reserve;settled=true;}
   };
   if(!response.body){finish();return response;}
   const reader=response.body.getReader();
   const stream=new ReadableStream({async pull(controller){try{const {done,value}=await reader.read();if(done){tail+=decoder.decode();finish();controller.close();return;}tail=(tail+decoder.decode(value,{stream:true})).slice(-131072);controller.enqueue(value);}catch(e){call.cancelled=!!init.signal?.aborted;finish();controller.error(e);}},async cancel(reason){call.cancelled=true;await reader.cancel(reason);finish();}});
   return new Response(stream,{status:response.status,headers:response.headers});
  }catch(e){call.cancelled=!!init.signal?.aborted;call.latencyMs=Date.now()-call.startedAt;call.error=e.name;throw e;}
 };
 return {request,setLabel(next){label={...next};},get blockedReason(){return blockedReason;},calls,snapshot(){return {maxUsd,maxRequests,reservedUsd,usageEstimateUsd:calls.reduce((n,c)=>n+(c.estimatedUsd||0),0),unknownUsageCalls:calls.filter(c=>c.estimatedUsd==null).length,calls:structuredClone(calls)};}};
}

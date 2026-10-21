/** Audit the real Pi login/profile/SDK path. Only synthetic prompts leave this process. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../core/server.mjs';
import {checkedRequest} from '../core/network-policy.mjs';
import {redact,BENCHMARK_MODELS} from './benchmark-meter.mjs';

const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
assert.ok(args.includes('--run')&&args.includes('--allow-cloud')&&args.includes('--key-file'),'Pass --run --allow-cloud --key-file PRIVATE_JSON');
const ids=args.includes('--models')?value('--models').split(','):BENCHMARK_MODELS.map(m=>m.id);
assert.ok(ids.length&&new Set(ids).size===ids.length&&ids.every(id=>BENCHMARK_MODELS.some(m=>m.id===id)),'Unknown or duplicate benchmark model');
const keys=JSON.parse(await readFile(value('--key-file'),'utf8')),out=path.resolve(args.includes('--out')?value('--out'):'validation/pi-connection');
await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-pi-connection-')),dispatches=[],checks=[];
let app,cookie,csrf,current;
const secretValues=Object.values(keys);
const transport=async(admitted,init,scope)=>{
 const u=new URL(admitted.url);assert.equal(u.origin,'https://opencode.ai');assert.match(u.pathname,/^\/inference\/(?:go\/)?(?:openai\/)?v1\/(?:chat\/completions|responses)$/);
 const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer '+keys.opencode,'SDK must send the registered credential');
 assert.ok(headers.get('x-opencode-session'),'SDK must send a conversation ID');
 const body=JSON.parse(Buffer.from(init.body).toString()),entry={...current,url:u.href,model:body.model,stream:body.stream,tools:body.tools?.length||0,credentialMatches:true,sessionHeader:headers.get('x-opencode-session'),userAgent:headers.get('user-agent'),at:new Date().toISOString()};
 dispatches.push(entry);const r=await checkedRequest(admitted,init,scope);
 entry.status=r.status;entry.receipt=Object.fromEntries(['x-opencode-log-id','x-request-id','request-id','cf-ray','x-zen-model'].map(k=>[k,r.headers.get(k)]).filter(([,v])=>v));
 if(!r.ok){const text=await r.clone().text();entry.error=redact(text,secretValues).slice(0,600);}return r;
};
try{
 app=await startServer({dir,registryOptions:{detectLimits:false},networkOptions:{transport}});
 const launch=await fetch(app.launchUrl,{redirect:'manual'});await launch.text();cookie=launch.headers.get('set-cookie').split(';')[0];csrf=app.csrf;
 const api=async(route,method='GET',data)=>{const r=await fetch(app.origin+route,{method,signal:AbortSignal.timeout(30000),headers:{Cookie:cookie,'X-Tepora-CSRF':csrf,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();assert.ok(r.ok,route+': '+redact(v,secretValues));return v;};
 await api('/api/agent/settings','PATCH',{dream:false,heartbeat:{enabled:false}});
 const auth=await api('/api/pi/auth/start','POST',{provider:'opencode-go',type:'api_key',consent:true});
 const deadline=Date.now()+10000;while(!app.pi.snapshot().pending?.prompt){assert.ok(Date.now()<deadline,'Pi login prompt timeout');await new Promise(r=>setTimeout(r,20));}
 const p=app.pi.snapshot().pending;await api('/api/pi/auth/respond','POST',{id:p.id,promptId:p.prompt.id,value:keys.opencode});await app.pi.pending.task;
 const account=(await api('/api/pi/auth')).accounts.find(a=>a.id===auth.pending.accountId);assert.ok(account?.connected);
 const refreshed=await api('/api/pi/models/refresh','POST',{provider:'opencode-go',accountId:account.id,consent:true});
 for(const id of ids){
  const m=refreshed.models.find(x=>x.id===id);
  if(!m){checks.push({model:id,status:'blocked',reason:'Not in pi-ai 1.3.0 catalog, including explicit refresh',related:refreshed.models.filter(x=>x.id.includes(id.split('-')[0])).map(x=>({id:x.id,baseUrl:x.baseUrl}))});continue;}
  for(const baseUrl of [...new Set([m.baseUrl,'https://opencode.ai/inference/go/openai/v1'])]){
   const profile={id:'pi-audit',name:'Pi connection audit',engine:'pi-ai',piProvider:'opencode-go',authMode:'pi-key',accountId:account.id,protocol:m.protocol,model:id,baseUrl,domain:'cloud',maxTokens:512,timeoutMs:30000,firstByteTimeoutMs:30000,idleTimeoutMs:30000,capabilities:{tools:true}};
   const old=await api('/api/providers');await api('/api/providers','PUT',{expectedRevision:old.revision,config:{profiles:[profile],routes:{main:{primary:profile.id}}}});
   current={model:id,baseUrl,engine:'pi-ai',provider:'opencode-go'};const check={...current,status:'passed'};
   try{const result=await app.registry.invoke('main',[{role:'user',content:'This is a synthetic coding-agent connection test. Call bench_echo with value BENCH_OK.'}],{signal:AbortSignal.timeout(35000),cacheKey:'pi-audit-'+id,maxTokens:512,tools:[{type:'function',function:{name:'bench_echo',description:'Echo a synthetic test value',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}}]});
    assert.equal(result._native?.engine,'pi-ai');assert.equal(result.tool_calls?.[0]?.function?.name,'bench_echo');check.nativeEngine=result._native.engine;check.resolvedModel=result._native.meta?.model;check.toolCalls=result.tool_calls;
   }catch(e){check.status='failed';check.error=redact(e.message,secretValues);}
   checks.push(check);console.log(JSON.stringify(check));
  }
 }
 const report={at:new Date().toISOString(),engine:'pi-ai',sdkVersion:'1.3.0',account:{provider:account.provider,type:account.type,connected:account.connected},credentialFingerprint:createHash('sha256').update(keys.opencode).digest('hex').slice(0,12),catalogCount:refreshed.models.length,checks,dispatches,consoleLogsVerified:false};
 await writeFile(path.join(out,'connection.json'),redact(report,secretValues));console.log(JSON.stringify({report:path.join(out,'connection.json'),dispatches:dispatches.length}));
}finally{if(app){await app.computer.close();await app.close();}await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}

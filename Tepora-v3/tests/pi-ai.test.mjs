import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {PiAIService,piProviders,piModel} from '../core/pi-ai.mjs';
import {ProviderRegistry,validateProfile} from '../core/provider-registry.mjs';
const sse=events=>new Response(events.map(x=>`data: ${typeof x==='string'?x:JSON.stringify(x)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
async function fixture(t,transport){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-pi-'));const store=new Store(dir),network=new NetworkPolicy(store,{lookup:async()=>[{address:'8.8.8.8'}],transport}),pi=new PiAIService(store,network),registry=new ProviderRegistry(store,network,{pi});t.after(async()=>{await pi.close();network.close();registry.close();store.close();await rm(dir,{recursive:true,force:true});});return {store,network,pi,registry,dir};}
const selected=piModel('groq','llama-3.3-70b-versatile');
const profile=()=>({id:'pi-groq',name:'Groq through Pi',engine:'pi-ai',piProvider:'groq',protocol:'chat-completions',baseUrl:selected.baseUrl,model:selected.id,domain:'cloud',maxTokens:512});
test('real SDK catalogs: all built-ins and all OAuth methods are exposed',()=>{const p=piProviders();assert.equal(p.version,'1.3.0');assert.equal(p.providers.length,42);assert.equal(p.providers.filter(x=>x.oauth).length,9);assert.ok(p.providers.reduce((n,x)=>n+x.modelCount,0)>1600);});
test('real pi-ai SDK performs streamed inference through Tepora registry and checked transport',async t=>{
 const seen=[],deltas=[];const f=await fixture(t,async(admitted,init)=>{seen.push({url:admitted.url.href,body:JSON.parse(Buffer.from(init.body).toString()),headers:Object.fromEntries(new Headers(init.headers))});return sse([{id:'chatcmpl-fixture',choices:[{delta:{role:'assistant',content:'Hello Pi'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:3}},'[DONE]']);});
 const snapshot=f.registry.save({profiles:[profile()],routes:{main:{primary:'pi-groq',fallbacks:[]}}},0);f.registry.setKey('pi-groq','synthetic-pi-key',snapshot.profiles[0].identity);
 const answer=await f.registry.invoke('main',[{role:'user',content:'Hello'}],{onDelta:d=>deltas.push(d),signal:AbortSignal.timeout(15000)});
 assert.equal(answer.content,'Hello Pi');assert.equal(deltas.join(''),'Hello Pi');assert.equal(seen.length,1);assert.equal(seen[0].headers.authorization,'Bearer synthetic-pi-key');assert.equal(answer._native.engine,'pi-ai');assert.equal(answer.usage.input,12);assert.equal(answer.usageStatus.status,'complete');
});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const bodyText=init=>Buffer.from(init.body||'').toString();
async function until(predicate,timeout=8000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('Fixture state deadline exceeded');await new Promise(r=>setTimeout(r,20));}}
const complete=()=>sse([{choices:[{delta:{role:'assistant',content:'done'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:9,completion_tokens:1}},'[DONE]']);
for(const provider of ['xai','kimi-coding','meta'])test(`real ${provider} OAuth device login uses the checked transport and a private vault`,async t=>{
 const requests=[];const f=await fixture(t,async({url},init)=>{requests.push(url.href);
  if(/device\/(code|authorization)\/?$|device_authorization$/.test(url.pathname))return json({device_code:'synthetic-device',user_code:'FIXTURE-123',verification_uri:'https://'+url.host+'/activate',verification_uri_complete:'https://'+url.host+'/activate?code=FIXTURE-123',expires_in:60,interval:1});
  if(url.pathname==='/muse-code/key'){assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-access');return json({api_key:'synthetic-meta-key'});}
  if(/token\/?$/.test(url.pathname))return json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,token_type:'Bearer'});
  throw Error('Unexpected fixture endpoint');
 });
 const begin=f.pi.begin({provider,consent:true});assert.equal(begin.pending.status,'pending');await f.pi.pending.task;
 assert.equal(f.pi.snapshot().pending.status,'connected');const account=f.pi.snapshot().accounts[0];assert.equal(account.provider,provider);assert.equal(account.connected,true);
 assert.equal(JSON.stringify(f.pi.snapshot()).includes('synthetic-'),false);assert.ok(requests.length>=2);await f.pi.disconnect(account.id);assert.equal(f.pi.status(account.id).connected,false);
});
test('real SDK API-key login prompts generically, persists outside SQLite and powers inference',async t=>{
 const f=await fixture(t,async({url},init)=>{assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-key-vault');return complete();});
 f.pi.begin({provider:'groq',type:'api_key',consent:true});await until(()=>f.pi.snapshot().pending?.prompt);
 let p=f.pi.snapshot().pending;assert.equal(p.prompt.type,'secret');f.pi.respond({id:p.id,promptId:p.prompt.id,value:'synthetic-key-vault'});await f.pi.pending.task;
 const account=f.pi.snapshot().accounts[0];assert.equal(account.connected,true);
 const config=f.registry.save({profiles:[{...profile(),authMode:'pi-key',accountId:account.id}],routes:{main:{primary:'pi-groq',fallbacks:[]}}},0);
 assert.throws(()=>f.registry.setKey('pi-groq','wrong'),/API/);const answer=await f.registry.invoke('main',[{role:'user',content:'fixture'}]);assert.equal(answer.content,'done');
 assert.equal(JSON.stringify(config).includes('synthetic-key'),false);assert.equal(JSON.stringify(f.store.export()).includes('synthetic-key'),false);
});
test('actual tool-call stream and continuation round-trip through the SDK',async t=>{
 const requests=[];const f=await fixture(t,async({url},init)=>{const b=JSON.parse(bodyText(init));requests.push(b);if(requests.length>1)return complete();return sse([
 {choices:[{delta:{role:'assistant',tool_calls:[{index:0,id:'call_fixture',type:'function',function:{name:'inspect',arguments:'{"x":'}}]},finish_reason:null}]},
 {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:'tool_calls'}]},'[DONE]']);});
 f.registry.save({profiles:[profile()],routes:{main:{primary:'pi-groq',fallbacks:[]}}},0);f.registry.setKey('pi-groq','synthetic');const tools=[{type:'function',function:{name:'inspect',description:'Fixture',parameters:{type:'object',properties:{x:{type:'number'}}}}}];
 const user={role:'user',content:'Inspect'},answer=await f.registry.invoke('main',[user],{tools});assert.equal(answer.finish,'tool_calls');assert.deepEqual(JSON.parse(answer.tool_calls[0].function.arguments),{x:1});assert.equal(answer.usageStatus.status,'missing');
 const next=await f.registry.invoke('main',[user,{role:'assistant',content:answer.content,tool_calls:answer.tool_calls,_native:answer._native},{role:'tool',tool_call_id:answer.tool_calls[0].id,content:'{"ok":true}'}],{tools});
 assert.equal(next.content,'done');assert.equal(requests[1].messages.at(-1).role,'tool');assert.equal(requests[1].messages.at(-2).tool_calls[0].function.name,'inspect');
});
test('SDK refresh is serialized per account; two real model calls reuse one refreshed token',async t=>{
 let refreshes=0,calls=0;const f=await fixture(t,async({url},init)=>{
  if(url.hostname==='auth.kimi.com'){refreshes++;assert.equal(new URLSearchParams(bodyText(init)).get('grant_type'),'refresh_token');await new Promise(r=>setTimeout(r,40));return json({access_token:'synthetic-renewed',refresh_token:'synthetic-next',expires_in:3600});}
  calls++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-renewed');return complete();
 });
 const id='pi-11111111-1111-4111-8111-111111111111';f.pi.vault.accounts[id]={id,provider:'kimi-coding',type:'oauth',label:'Fixture',credential:{type:'oauth',access:'synthetic-expired',refresh:'synthetic-refresh',expires:0}};f.pi.persist();
 const m=f.pi.models('kimi-coding').models[0],p={...profile(),id:'kimi',piProvider:'kimi-coding',protocol:m.protocol,baseUrl:m.baseUrl,model:m.id,authMode:'pi-oauth',accountId:id};f.registry.save({profiles:[p],routes:{main:{primary:'kimi',fallbacks:[]}}},0);
 const results=await Promise.all([1,2].map(()=>f.registry.invoke('main',[{role:'user',content:'fixture'}])));assert.equal(refreshes,1);assert.equal(calls,2);assert.equal(results[0].content,'done');
});
test('cancelled generic login does not retain a credential or a Worker',async t=>{
 const f=await fixture(t,()=>{throw Error('No network expected');});f.pi.begin({provider:'groq',type:'api_key',consent:true});await until(()=>f.pi.snapshot().pending?.prompt);f.pi.cancel();await f.pi.pending.task;
 assert.equal(f.pi.snapshot().pending.status,'cancelled');assert.equal(f.pi.snapshot().accounts[0].connected,false);assert.equal(f.pi.jobs.size,0);
});
test('restricted network, account mismatch, egress overrides and billing fallback fail closed',async t=>{
 const f=await fixture(t,()=>{throw Error('Must not send');});f.network.change({mode:'offline'},0);assert.throws(()=>f.pi.begin({provider:'xai',consent:true}),/オンライン/);
 assert.throws(()=>f.pi.scope('https://evil.invalid/steal',{provider:'openai',profile:{...profile(),baseUrl:'https://api.openai.com/v1'}}),/登録外/);
 assert.throws(()=>validateProfile({...profile(),authMode:'pi-oauth',accountId:'pi-11111111-1111-4111-8111-111111111111',piProvider:'xai',model:f.pi.models('xai').models[0].id}),/API形式|固定/);
 const account='pi-11111111-1111-4111-8111-111111111111';f.pi.vault.accounts[account]={id:account,provider:'groq',type:'api_key'};
 assert.throws(()=>f.registry.save({profiles:[{...profile(),id:'a',authMode:'pi-key',accountId:account},{...profile(),id:'b'}],routes:{main:{primary:'a',fallbacks:['b']}}},0),/境界/);
});
test('OpenAI ChatGPT sign-in uses the real SDK callback/PKCE and public token flow',async t=>{
 let exchanges=0;const f=await fixture(t,async({url},init)=>{assert.equal(url.href,'https://auth.openai.com/api/accounts/oauth/token');const form=new URLSearchParams(bodyText(init));assert.equal(form.get('client_id'),'oaiapp_fixture');assert.equal(form.get('resource'),'https://api.openai.com/v1');assert.ok(form.get('code_verifier').length>20);exchanges++;return json({access_token:'synthetic-openai-access',refresh_token:'synthetic-openai-refresh',id_token:'synthetic-presence-only',expires_in:3600,scope:'openid resource.invoke chatgpt.tokens.use.direct'});});
 f.pi.begin({provider:'openai',consent:true});await until(()=>f.pi.snapshot().pending?.event?.type==='auth_url');const event=f.pi.snapshot().pending.event,url=new URL(event.url);assert.equal(url.searchParams.get('agent_name_hint'),'Tepora');
 const callback=new URL(url.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({code:'fixture-code',state:url.searchParams.get('state'),client_id:'oaiapp_fixture'}).toString();const response=await fetch(callback);assert.equal(response.status,200);await response.text();await f.pi.pending.task;
 assert.equal(f.pi.snapshot().pending.status,'connected');assert.equal(exchanges,1);assert.equal(f.pi.snapshot().accounts[0].connected,true);assert.equal(f.pi.snapshot().pending.prompt,null);
});
test('OpenRouter real SDK browser/manual-code login completes through generic prompts',async t=>{
 const f=await fixture(t,async({url},init)=>{assert.equal(url.href,'https://openrouter.ai/api/v1/auth/keys');assert.equal(JSON.parse(bodyText(init)).code,'fixture-code');return json({key:'synthetic-openrouter-key'});});
 f.pi.begin({provider:'openrouter',consent:true});await until(()=>f.pi.snapshot().pending?.prompt?.type==='manual_code');const p=f.pi.snapshot().pending;f.pi.respond({id:p.id,promptId:p.prompt.id,value:'fixture-code'});await f.pi.pending.task;assert.equal(f.pi.snapshot().pending.status,'connected');
});
test('GitHub Copilot real SDK prompts, token exchange and available-model filtering',async t=>{
 const f=await fixture(t,async({url})=>{
  if(url.pathname==='/login/device/code')return json({device_code:'synthetic-device',user_code:'FIXTURE',verification_uri:'https://github.com/login/device',expires_in:60,interval:1});
  if(url.pathname==='/login/oauth/access_token')return json({access_token:'synthetic-github-access',token_type:'bearer',scope:'read:user'});
  if(url.pathname==='/copilot_internal/v2/token')return json({token:'synthetic-copilot-access',expires_at:Math.floor(Date.now()/1000)+3600});
  if(url.pathname==='/models')return json({data:[{id:'gpt-5-mini',model_picker_enabled:true,capabilities:{type:'chat'},policy:{state:'enabled'}}]});
  throw Error('No model policy mutation permitted');
 });f.pi.begin({provider:'github-copilot',consent:true});await until(()=>f.pi.snapshot().pending?.prompt);const p=f.pi.snapshot().pending;assert.equal(p.prompt.type,'text');f.pi.respond({id:p.id,promptId:p.prompt.id,value:''});await f.pi.pending.task;assert.equal(f.pi.snapshot().pending.status,'connected');
 const account=f.pi.snapshot().accounts[0];assert.equal(account.connected,true);const list=f.pi.models('github-copilot',account.id).models;assert.deepEqual(list.map(m=>m.id),['gpt-5-mini']);
});
test('in-flight logout cannot resurrect credentials after an SDK refresh',async t=>{
 let refreshStarted=false;const f=await fixture(t,async({url},init)=>{refreshStarted=true;return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));});
 const id='pi-11111111-1111-4111-8111-111111111111';f.pi.vault.accounts[id]={id,provider:'kimi-coding',type:'oauth',label:'Fixture',credential:{type:'oauth',access:'old',refresh:'old',expires:0}};f.pi.persist();const m=f.pi.models('kimi-coding').models[0];
 const p=validateProfile({...profile(),id:'kimi',piProvider:'kimi-coding',protocol:m.protocol,baseUrl:m.baseUrl,model:m.id,authMode:'pi-oauth',accountId:id});
 const call=f.pi.chat(p,'',[{role:'user',content:'fixture'}]).then(()=>{throw Error('Unexpected success');},()=>{});await until(()=>refreshStarted);await f.pi.disconnect(id);await call;
 assert.equal(f.pi.status(id).connected,false);assert.equal(f.pi.jobs.size,0);assert.equal(f.pi.locks.size,0);
});
test('legacy Codex real SDK device auth is a distinct OAuth provider',async t=>{
 const access='synthetic.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64')+'.signature';
 const f=await fixture(t,async({url})=>{
  if(url.pathname.endsWith('/deviceauth/usercode'))return json({device_auth_id:'fixture-device',user_code:'FIXTURE',interval:1});
  if(url.pathname.endsWith('/deviceauth/token'))return json({authorization_code:'fixture-code',code_verifier:'fixture-verifier'});
  if(url.pathname==='/oauth/token')return json({access_token:access,refresh_token:'synthetic-refresh',expires_in:3600});
  throw Error('Unknown Codex fixture request');
 });f.pi.begin({provider:'openai-codex',consent:true});await until(()=>f.pi.snapshot().pending?.prompt);let p=f.pi.snapshot().pending;
 f.pi.respond({id:p.id,promptId:p.prompt.id,value:'device_code'});await f.pi.pending.task;assert.equal(f.pi.snapshot().pending.status,'connected');assert.equal(f.pi.snapshot().accounts[0].provider,'openai-codex');
});
test('Anthropic real SDK selection and copy-code prompt are wired without bespoke login code',async t=>{
 const f=await fixture(t,async({url})=>{assert.equal(url.href,'https://platform.claude.com/v1/oauth/token');return json({access_token:'synthetic-anthropic',refresh_token:'synthetic-refresh',expires_in:3600});});
 f.pi.begin({provider:'anthropic',consent:true});await until(()=>f.pi.snapshot().pending?.prompt);let p=f.pi.snapshot().pending;
 const method=p.prompt.options.find(o=>o.label.includes('Copy code'));f.pi.respond({id:p.id,promptId:p.prompt.id,value:method.id});await until(()=>f.pi.snapshot().pending?.prompt?.type==='manual_code');p=f.pi.snapshot().pending;
 const state=new URL(p.event.url).searchParams.get('state');f.pi.respond({id:p.id,promptId:p.prompt.id,value:'fixture-code#'+state});await f.pi.pending.task;assert.equal(f.pi.snapshot().pending.status,'connected');
});
test('Radius real SDK device flow reaches its registered gateway only',async t=>{
 const f=await fixture(t,async({url})=>{assert.equal(url.origin,'https://radius.pi.dev');if(url.pathname.endsWith('/device'))return json({device_code:'synthetic-device',user_code:'FIXTURE',verification_uri:'https://radius.pi.dev/activate',expires_in:60,interval:1});if(url.pathname.endsWith('/token'))return json({access_token:'synthetic-radius',refresh_token:'synthetic-refresh',expires_in:3600,scope:'gateway'});throw Error('Unexpected Radius fixture');});
 f.pi.begin({provider:'radius',consent:true});await until(()=>f.pi.snapshot().pending?.prompt);const p=f.pi.snapshot().pending;f.pi.respond({id:p.id,promptId:p.prompt.id,value:'device-code'});await f.pi.pending.task;assert.equal(f.pi.snapshot().pending.status,'connected');
});
test('a broken real SDK stream after visible output never retries or changes models',async t=>{
 let sent=0;const f=await fixture(t,async()=>{sent++;let count=0;return new Response(new ReadableStream({async pull(c){if(count++===0)c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{role:'assistant',content:'partial'},finish_reason:null}]})+'\n\n'));else{await new Promise(r=>setTimeout(r,50));c.error(new Error('fixture stream closed'));}}}),{headers:{'content-type':'text/event-stream'}});});
 f.registry.save({profiles:[profile(),{...profile(),id:'alternate'}],routes:{main:{primary:'pi-groq',fallbacks:['alternate']}}},0);f.registry.setKey('pi-groq','synthetic');f.registry.setKey('alternate','synthetic');let text='';
 await assert.rejects(f.registry.invoke('main',[{role:'user',content:'fixture'}],{onDelta:d=>text+=d,signal:AbortSignal.timeout(15000)}),e=>e.partialOutput===true);
 assert.equal(text,'partial');assert.equal(sent,1);
});
test('cancelling login holds admission until the SDK worker has closed',async t=>{
 const f=await fixture(t,()=>{throw Error('No network expected');});f.pi.begin({provider:'groq',type:'api_key',consent:true});await until(()=>f.pi.snapshot().pending?.prompt);f.pi.cancel();assert.throws(()=>f.pi.begin({provider:'groq',type:'api_key',consent:true}),/別のログイン/);await f.pi.pending.task;assert.equal(f.pi.locks.size,0);f.pi.begin({provider:'groq',type:'api_key',consent:true});f.pi.cancel();await f.pi.pending.task;
});
for(const [provider,protocol,events] of [
 ['anthropic','anthropic',[
  {type:'message_start',message:{id:'msg_fixture',role:'assistant',content:[],model:'fixture',usage:{input_tokens:7,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'native protocol'}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}]],
 ['google','gemini',[{candidates:[{index:0,content:{role:'model',parts:[{text:'native protocol'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:2,totalTokenCount:9}}]],
 ['openai','responses',[
  {type:'response.created',response:{id:'resp_fixture',status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{type:'message',id:'msg_fixture',role:'assistant',content:[],status:'in_progress'}},
  {type:'response.content_part.added',item_id:'msg_fixture',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
  {type:'response.output_text.delta',item_id:'msg_fixture',output_index:0,content_index:0,delta:'native protocol'},
  {type:'response.output_item.done',output_index:0,item:{type:'message',id:'msg_fixture',role:'assistant',content:[{type:'output_text',text:'native protocol',annotations:[]}],status:'completed'}},
  {type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[],usage:{input_tokens:7,output_tokens:2,total_tokens:9}}}]]
])test(`real SDK ${provider} native protocol streams and records wire usage`,async t=>{
 const f=await fixture(t,async()=>new Response(events.map(e=>`${e.type?'event: '+e.type+'\n':''}data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}}));
 const m=f.pi.models(provider).models.find(x=>x.protocol===protocol&&x.available);assert.ok(m,provider);
 const p={...profile(),id:'native-protocol',piProvider:provider,protocol,baseUrl:m.baseUrl,model:m.id};f.registry.save({profiles:[p],routes:{main:{primary:p.id,fallbacks:[]}}},0);f.registry.setKey(p.id,'synthetic-key');let text='';
 const a=await f.registry.invoke('main',[{role:'user',content:'fixture'}],{onDelta:d=>text+=d,signal:AbortSignal.timeout(15000)});
 assert.equal(a.content,'native protocol');assert.equal(text,a.content);assert.equal(a.usageStatus.status,'complete');assert.equal(a.usage.input,7);assert.equal(a.usage.output,2);
});

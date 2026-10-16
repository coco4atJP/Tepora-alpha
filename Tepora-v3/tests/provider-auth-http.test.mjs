import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {startServer} from '../core/server.mjs';
import {CHATGPT_ISSUER,CHATGPT_RESOURCE} from '../core/provider-auth.mjs';

// Exercise the real cookie/CSRF HTTP host, egress policy and Rust Responses codec.
// Only OAuth issuer and model-service responses are fixtures; no external I/O.
test('HTTP authentication, model selection and inference retain session, origin and billing boundaries',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-auth-http-'));
 const keys=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...keys.publicKey.export({format:'jwk'}),kid:'http-fixture',alg:'RS256',use:'sig'};
 const client='oaiapp_http_fixture',requests=[];let nonce;
 const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 const app=await startServer({dir,registryOptions:{detectLimits:false},networkOptions:{
  lookup:async()=>[{address:'8.8.8.8',family:4}],
  transport:async({url},init)=>{
   requests.push({url:url.href,method:init.method||'GET'});
   if(url.href===CHATGPT_ISSUER+'/api/accounts/oauth/token'){
    const form=new URLSearchParams(init.body);assert.equal(form.get('client_id'),client);assert.equal(form.get('resource'),CHATGPT_RESOURCE);
    const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const now=Math.floor(Date.now()/1000),input=b64({alg:'RS256',kid:jwk.kid})+'.'+b64({iss:CHATGPT_ISSUER,aud:client,sub:'http-subject',nonce,iat:now,exp:now+3600});
    return json({access_token:'synthetic-http-access',refresh_token:'synthetic-http-refresh',id_token:input+'.'+sign('sha256',Buffer.from(input),keys.privateKey).toString('base64url'),token_type:'Bearer',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});
   }
   if(url.href===CHATGPT_ISSUER+'/.well-known/jwks.json')return json({keys:[jwk]});
   if(url.href===CHATGPT_RESOURCE+'/models'){
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-http-access');
    return json({models:[{slug:'fixture-visible',display_name:'Fixture model',visibility:'list'},{slug:'fixture-hidden',visibility:'hide'}]});
   }
   if(url.href===CHATGPT_RESOURCE+'/responses'){
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-http-access');
    const body=JSON.parse(init.body);assert.equal(body.model,'fixture-visible');assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(Object.hasOwn(body,'max_output_tokens'),false);
    assert.equal(body.tools[0].type,'namespace');assert.equal(body.tools[0].name,'tepora');
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'fixture-response',status:'completed',output:[{type:'function_call',call_id:'fixture-call',name:'inspect',namespace:'tepora',arguments:'{}'}],usage:{input_tokens:5,output_tokens:2}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
   }
   if(url.href===CHATGPT_ISSUER+'/.well-known/openid-configuration')return json({issuer:CHATGPT_ISSUER,revocation_endpoint:CHATGPT_ISSUER+'/fixture/revoke'});
   if(url.href===CHATGPT_ISSUER+'/fixture/revoke')return new Response('');
   throw Error('Unapproved upstream in HTTP fixture');
  }
 }});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 let r=await fetch(app.origin+'/api/provider-auth');assert.equal(r.status,401);await r.text();
 const launch=await fetch(app.launchUrl,{redirect:'manual'});await launch.text();
 const cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',data,headers={})=>fetch(app.origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,'Content-Type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 for(const headers of [{'X-Tepora-CSRF':'wrong'},{Origin:'https://attacker.invalid'}]){
  r=await request('/api/provider-auth/start','POST',{consent:true},headers);assert.equal(r.status,403);await r.text();
 }
 r=await request('/api/provider-auth/start','POST',{});assert.equal(r.status,403);await r.text();assert.equal(requests.length,0);
 r=await request('/api/provider-auth/start','POST',{consent:true});assert.equal(r.status,200);const start=await r.json(),authorize=new URL(start.authorizationUrl);nonce=authorize.searchParams.get('nonce');
 const callback=new URL(authorize.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({code:'fixture-code',state:authorize.searchParams.get('state'),client_id:client}).toString();
 r=await fetch(callback);assert.equal(r.status,200);await r.text();
 const state=await(await request('/api/provider-auth')).json();assert.equal(state.accounts.length,1);const accountId=state.accounts[0].id;
 assert.equal(JSON.stringify(state).includes('synthetic-http-'),false);
 r=await request(`/api/provider-auth/${accountId}/models`,'POST',{consent:true});assert.equal(r.status,200);const models=await r.json();assert.deepEqual(models.models.map(x=>x.id),['fixture-visible']);assert.equal(models.verified,false);
 const profile={id:'plan',name:'Plan fixture',protocol:'responses',baseUrl:CHATGPT_RESOURCE,model:'fixture-visible',domain:'cloud',authMode:'chatgpt',accountId};
 r=await request('/api/providers','PUT',{expectedRevision:0,config:{profiles:[profile],routes:{main:{primary:'plan',fallbacks:[]}}}});assert.equal(r.status,200);const config=await r.json();
 assert.equal(config.profiles[0].authStatus.connected,true);assert.equal(JSON.stringify(config).includes('synthetic-http-'),false);
 r=await request('/api/providers/plan/models','POST',{consent:true,identity:'stale'});assert.equal(r.status,409);await r.text();
 r=await request('/api/providers/plan/key','POST',{key:'must-not-store',identity:config.profiles[0].identity});assert.equal(r.status,400);await r.text();
 const answer=await app.registry.invoke('main',[{role:'user',content:'Inspect a fixture'}],{tools:[{type:'function',function:{name:'inspect',description:'Inspect fixture',parameters:{type:'object',properties:{}}}}]});
 assert.equal(answer.tool_calls[0].function.name,'inspect');assert.equal(answer._native.items[0].namespace,'tepora');assert.equal(app.registry.price(config.profiles[0]),null);
 r=await request(`/api/provider-auth/${accountId}/disconnect`,'POST',{});assert.equal(r.status,200);assert.equal((await r.json()).remoteRevocation,'confirmed');
 const disconnected=await(await request('/api/provider-auth')).json();assert.equal(disconnected.accounts[0].connected,false);
 await assert.rejects(app.registry.invoke('main',[{role:'user',content:'must not dispatch'}]),/ログイン/);
 assert.equal(requests.filter(x=>x.url===CHATGPT_RESOURCE+'/responses').length,1);
});

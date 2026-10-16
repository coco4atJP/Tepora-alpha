import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,writeFile,symlink,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {ProviderAuth,verifyIdentity,CHATGPT_ISSUER,CHATGPT_RESOURCE} from '../core/provider-auth.mjs';
import {ProviderRegistry,validateProfile,validateRegistry} from '../core/provider-registry.mjs';
import {PROVIDER_PRESETS,editableProvider} from '../web/provider-presets.mjs';
import {Store} from '../core/store.mjs';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...keys.publicKey.export({format:'jwk'}),kid:'fixture-rsa',alg:'RS256',use:'sig'};
const NOW=Date.UTC(2026,9,16,7,0,0),CLIENT='oaiapp_tepora_fixture',SUBJECT='fixture-subject';
const scopes='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims={},header={}){const value=b64({alg:'RS256',kid:jwk.kid,...header})+'.'+b64({iss:CHATGPT_ISSUER,aud:CLIENT,sub:SUBJECT,exp:NOW/1000+3600,iat:NOW/1000,nonce:'fixture-nonce',email:'fixture@example.invalid',...claims});return value+'.'+sign('sha256',Buffer.from(value),keys.privateKey).toString('base64url');}
const issued=nonce=>({access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:jwt({nonce}),token_type:'Bearer',expires_in:3600,scope:scopes});
async function fixture(t,{reply,attemptMs=10000,initialNow=NOW}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-auth-'));const events=[],requests=[];let now=initialNow,online=true;
 const store={dir,closed:false,broadcast:(type,data)=>events.push({type,data})};
 const network={listeners:new Set(),permitted:()=>online,request:async(url,init,scope)=>{assert.equal(scope.purpose,'model');assert.equal(scope.allowCloud,true);assert.equal(init.redirect,'error');init.signal?.throwIfAborted();requests.push({url,init,scope});return reply?reply(url,init):new Response(JSON.stringify({keys:[jwk]}));}};
 const auth=new ProviderAuth(store,network,{clock:()=>now,attemptMs});
 t.after(async()=>{await auth.close();await rm(dir,{recursive:true,force:true});});
 return {auth,store,network,events,requests,dir,setTime:x=>now=x,offline:()=>{online=false;for(const f of network.listeners)f({mode:'offline'});}};
}
async function signin(f,{claims={},tokenOverrides={},clientId=CLIENT,accountId=null}={}){
 const start=await f.auth.begin({consent:true,accountId}),url=new URL(start.authorizationUrl),nonce=url.searchParams.get('nonce');
 f.network.request=async(endpoint,init,scope)=>{f.requests.push({url:endpoint,init,scope});if(endpoint.endsWith('/oauth/token')){const form=new URLSearchParams(init.body);assert.equal(form.get('client_id'),clientId);assert.equal(form.get('redirect_uri'),url.searchParams.get('redirect_uri'));assert.equal(form.get('resource'),CHATGPT_RESOURCE);assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),url.searchParams.get('code_challenge'));return new Response(JSON.stringify({...issued(nonce),id_token:jwt({nonce,aud:clientId,...claims}),...tokenOverrides}));}return new Response(JSON.stringify({keys:[jwk]}));};
 const callback=new URL(url.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({code:'fixture-code',state:url.searchParams.get('state'),client_id:clientId}).toString();
 const response=await fetch(callback);await response.text();return {start,url,callback,response,id:f.auth.snapshot().pending?.accountId};
}
test('ID token validation verifies signature, issuer, audience, expiry, nonce and returning identity',()=>{
 const expected={clientId:CLIENT,nonce:'fixture-nonce',now:NOW};assert.equal(verifyIdentity(jwt(),{keys:[jwk]},expected).sub,SUBJECT);
 for(const patch of [{iss:'https://attacker.invalid'},{aud:'other'},{exp:NOW/1000-20},{iat:NOW/1000+60},{nonce:'wrong'},{sub:''},{nbf:NOW/1000+60},{aud:[CLIENT,'other'],azp:'other'}])assert.throws(()=>verifyIdentity(jwt(patch),{keys:[jwk]},expected));
 assert.throws(()=>verifyIdentity(jwt(),{keys:[jwk]},{...expected,subject:'different'}));
 assert.throws(()=>verifyIdentity(jwt({}, {alg:'HS256'}),{keys:[jwk]},expected));
 assert.throws(()=>verifyIdentity(jwt({}, {crit:['jku'],jku:'https://attacker.invalid'}),{keys:[jwk]},expected));
 const token=jwt(),parts=token.split('.');parts[1]=b64({...JSON.parse(Buffer.from(parts[1],'base64url')),email:'forged@example.invalid'});assert.throws(()=>verifyIdentity(parts.join('.'),{keys:[jwk]},expected),/署名/);
 assert.throws(()=>verifyIdentity(token,{keys:[jwk,jwk]},expected));
});
test('dynamic registration, loopback PKCE, saved client reuse and protected secret-free projections',async t=>{
 const f=await fixture(t),{url,response,id,callback}=await signin(f);assert.equal(response.status,200);assert.ok(id);
 assert.equal(url.origin,CHATGPT_ISSUER);assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('agent_name_hint'),'Tepora');assert.equal(url.searchParams.get('scope'),scopes);assert.equal(callback.hostname,'127.0.0.1');assert.equal(callback.pathname,'/auth/callback');
 const disk=JSON.parse(await readFile(path.join(f.dir,'credentials/chatgpt.json'),'utf8'));assert.equal(disk.accounts[id].clientId,CLIENT);assert.equal(disk.accounts[id].accessToken,'fixture-access');
 if(process.platform!=='win32'){assert.equal((await stat(path.join(f.dir,'credentials/chatgpt.json'))).mode&0o777,0o600);assert.equal((await stat(path.join(f.dir,'credentials'))).mode&0o777,0o700);}
 const visible=JSON.stringify([f.auth.snapshot(),f.events]);for(const secret of ['fixture-access','fixture-refresh','fixture-code','code_verifier','idToken'])assert.ok(!visible.includes(secret),secret);
 const again=new URL((await f.auth.begin({consent:true,accountId:id})).authorizationUrl);assert.equal(again.searchParams.get('client_id'),CLIENT);assert.equal(again.searchParams.get('ext_agent_host_id'),url.searchParams.get('ext_agent_host_id'));assert.equal(again.searchParams.has('agent_name_hint'),false);assert.equal(again.searchParams.has('id_token_hint'),false);assert.notEqual(again.searchParams.get('state'),url.searchParams.get('state'));f.auth.cancel();
 const restarted=new ProviderAuth(f.store,f.network,{clock:()=>NOW});t.after(()=>restarted.close());assert.equal(restarted.snapshot().accounts[0].id,id);assert.equal((await restarted.acquire(id)).key,'fixture-access');
});
test('invalid, duplicate and replayed callbacks never exchange credentials',async t=>{
 const f=await fixture(t),start=await f.auth.begin({consent:true}),u=new URL(start.authorizationUrl),callback=new URL(u.searchParams.get('redirect_uri'));
 callback.search=new URLSearchParams({state:'wrong',code:'nope',client_id:CLIENT}).toString();let r=await fetch(callback);assert.equal(r.status,400);await r.text();assert.equal(f.requests.length,0);assert.equal(f.auth.snapshot().pending.status,'pending');
 callback.search=new URLSearchParams({state:u.searchParams.get('state'),code:'nope',client_id:CLIENT}).toString()+'&state=duplicate';r=await fetch(callback);assert.equal(r.status,400);await r.text();assert.equal(f.requests.length,0);
 f.auth.cancel();await assert.rejects(fetch(callback));assert.equal(f.requests.length,0);
});
test('missing plan scope or wrong returning subject does not activate or overwrite an account',async t=>{
 const f=await fixture(t);const denied=await signin(f,{tokenOverrides:{scope:'openid profile email'}});assert.equal(denied.response.status,400);assert.equal(f.auth.snapshot().accounts.length,0);
 const good=await signin(f);const before=JSON.stringify(f.auth.vault.accounts[good.id]);const wrong=await signin(f,{accountId:good.id,claims:{sub:'another-account'}});assert.equal(wrong.response.status,400);assert.equal(JSON.stringify(f.auth.vault.accounts[good.id]),before);
});
test('two workspace registrations with the same email remain separate',async t=>{
 const f=await fixture(t),a=await signin(f),b=await signin(f,{clientId:'oaiapp_other_workspace'});assert.notEqual(a.id,b.id);const accounts=f.auth.snapshot().accounts;assert.equal(accounts.length,2);assert.equal(accounts[0].email,accounts[1].email);assert.notEqual(accounts[0].label,accounts[1].label);
});
test('concurrent refresh is single-flight, rotates credentials atomically and respects cancellation',async t=>{
 const f=await fixture(t),{id}=await signin(f);f.setTime(NOW+3550_000);let calls=0,resolve;
 f.network.request=async(url,init)=>{assert.ok(url.endsWith('/oauth/token'));calls++;assert.equal(new URLSearchParams(init.body).get('refresh_token'),'fixture-refresh');await new Promise(r=>resolve=r);return new Response(JSON.stringify({...issued('unused'),id_token:undefined,access_token:'rotated-access',refresh_token:'rotated-refresh'}));};
 const cancel=new AbortController();const first=f.auth.acquire(id,cancel.signal),second=f.auth.acquire(id);await new Promise(r=>setImmediate(r));cancel.abort(new Error('cancelled caller'));await assert.rejects(first,/cancelled caller/);resolve();assert.equal((await second).key,'rotated-access');assert.equal(calls,1);
 const disk=JSON.parse(await readFile(f.auth.file,'utf8'));assert.equal(disk.accounts[id].refreshToken,'rotated-refresh');assert.equal((await f.auth.acquire(id)).key,'rotated-access');assert.equal(calls,1);
});
test('disconnect aborts model leases, cannot be undone by a late refresh, and retains registration',async t=>{
 const f=await fixture(t),{id}=await signin(f),lease=await f.auth.acquire(id);f.setTime(NOW+3550_000);let release;
 f.network.request=async(url)=>{if(url.endsWith('/oauth/token')){await new Promise(r=>release=r);return new Response(JSON.stringify({...issued('unused'),id_token:undefined,access_token:'too-late'}));}if(url.endsWith('openid-configuration'))return new Response(JSON.stringify({issuer:CHATGPT_ISSUER,revocation_endpoint:CHATGPT_ISSUER+'/revoke'}));return new Response('');};
 const pending=f.auth.acquire(id);await new Promise(r=>setImmediate(r));const result=await f.auth.disconnect(id);assert.equal(result.remoteRevocation,'confirmed');assert.equal(lease.signal.aborted,true);release();await assert.rejects(pending);assert.equal(f.auth.status(id).connected,false);
 const disk=JSON.parse(await readFile(f.auth.file,'utf8'));assert.equal(disk.accounts[id].clientId,CLIENT);assert.ok(!JSON.stringify(disk).includes('fixture-refresh'));assert.ok(!JSON.stringify(disk).includes('too-late'));
});
test('offline, invalid_grant and unconfirmed revocation fail closed without credential resurrection',async t=>{
 const f=await fixture(t),{id}=await signin(f);f.setTime(NOW+3550_000);f.network.request=async()=>new Response(JSON.stringify({error:'invalid_grant',error_description:'secret must never be logged'}),{status:400});await assert.rejects(f.auth.acquire(id),/再ログイン/);assert.equal(f.auth.status(id).connected,false);assert.ok(!JSON.stringify(f.events).includes('secret must never'));
 await signin(f,{accountId:id});f.offline();await assert.rejects(f.auth.begin({consent:true}),/オンライン/);const r=await f.auth.disconnect(id);assert.equal(r.remoteRevocation,'unconfirmed');assert.equal(f.auth.status(id).connected,false);
});
test('model picker uses account catalog visibility/order; tokens are only in the Authorization header',async t=>{
 const f=await fixture(t),{id}=await signin(f);f.network.request=async(url,init)=>{assert.equal(url,CHATGPT_RESOURCE+'/models');assert.equal(init.headers.Authorization,'Bearer fixture-access');return new Response(JSON.stringify({models:[{slug:'second',display_name:'Second',visibility:'list'},{slug:'hidden',visibility:'hide'},{slug:'first',display_name:'First',visibility:'list'},{slug:'second',visibility:'list'}]}));};
 await assert.rejects(f.auth.models(id),/OpenAI/);const result=await f.auth.models(id,{consent:true});assert.deepEqual(result.models.map(x=>x.id),['second','first']);assert.equal(result.verified,false);assert.ok(!JSON.stringify(result).includes('fixture-access'));
});
test('corrupt credential storage is preserved; symlink directories are rejected',async t=>{
 const f=await fixture(t);await mkdir(path.dirname(f.auth.file),{recursive:true});await writeFile(f.auth.file,'not-json');const other=new ProviderAuth(f.store,f.network);t.after(()=>other.close());assert.equal(other.snapshot().supported,false);await assert.rejects(other.begin({consent:true}));assert.equal(await readFile(f.auth.file,'utf8'),'not-json');
 if(process.platform!=='win32'){const g=await fixture(t),outside=await mkdtemp(path.join(os.tmpdir(),'tepora-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await symlink(outside,path.dirname(g.auth.file));await assert.rejects(g.auth.begin({consent:true}),/安全/);}
});
const aid='chatgpt-11111111-1111-4111-8111-111111111111';
const profile=(extra={})=>({id:'chatgpt',protocol:'responses',baseUrl:CHATGPT_RESOURCE,model:'fixture',domain:'cloud',authMode:'chatgpt',accountId:aid,...extra});
test('profile validation pins subscription credentials and prevents cross-billing/account fallbacks',()=>{
 const good=validateProfile(profile());assert.equal(good.authMode,'chatgpt');
 for(const extra of [{baseUrl:'https://proxy.invalid/v1'},{baseUrl:CHATGPT_RESOURCE+'?x=1'},{protocol:'chat-completions'},{domain:'device'},{apiKeyEnv:'OPENAI_API_KEY'},{sessionHeader:'x-bad'},{authMode:'bad'},{accountId:'../escape'}])assert.throws(()=>validateProfile(profile(extra)));
 const api=profile({id:'paid',authMode:'api-key',accountId:undefined});assert.throws(()=>validateRegistry({profiles:[profile(),api],routes:{main:{primary:'chatgpt',fallbacks:['paid']}}}),/自動切替/);
 const other=profile({id:'other',accountId:'chatgpt-22222222-2222-4222-8222-222222222222'});assert.throws(()=>validateRegistry({profiles:[profile(),other],routes:{main:{primary:'chatgpt',fallbacks:['other']}}}));
 assert.doesNotThrow(()=>validateRegistry({profiles:[profile(),profile({id:'other'})],routes:{main:{primary:'chatgpt',fallbacks:['other']}}}));
});
test('presets use supported protocols and edits preserve hidden provider controls without retired fields',()=>{
 assert.ok(Object.keys(PROVIDER_PRESETS).length>=20);
 for(const [id,[name,protocol,domain,baseUrl]] of Object.entries(PROVIDER_PRESETS)){assert.doesNotThrow(()=>validateProfile({id,name,protocol,domain,baseUrl,model:'user-selected'}));}
 const p=validateProfile({id:'api',protocol:'responses',baseUrl:CHATGPT_RESOURCE,model:'m',domain:'cloud',contextTokens:128000,firstByteTimeoutMs:55000,idleTimeoutMs:66000,cache:false,sampling:{temperature:0.4},sessionHeader:'x-session',reasoningEffort:'high'});const edited=editableProvider({...p,health:{},contextChars:1,privateContext:true,keyPresent:true});assert.ok(!('identity'in edited));assert.ok(!('contextChars'in edited));assert.ok(!('privateContext'in edited));assert.equal(validateProfile(edited).identity,p.identity);
});
test('registry never exposes/reuses subscription tokens as API keys and rejects stale key saves',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-auth-reg-'));const store=new Store(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});const network={permitted:()=>true,fetch:()=>async()=>new Response('{}')};
 const r=new ProviderRegistry(store,network,{auth:{status:()=>({connected:true}),acquire:async()=>({key:'secret-oauth',signal:new AbortController().signal})},detectLimits:false,clientFactory:(_p,key)=>({chat:async()=>{assert.equal(key,'secret-oauth');return {content:'ok',usage:{input:0,output:0},finish:'stop'};}})});r.save({profiles:[profile()],routes:{main:{primary:'chatgpt'}}},0);
 const p=r.get().profiles[0];assert.equal(r.keyFor(p),'');assert.throws(()=>r.setKey('chatgpt','paid-secret'),/APIキー/);assert.ok(!JSON.stringify(r.publicSnapshot()).includes('secret-oauth'));const answer=await r.invoke('main',[{role:'user',content:'fixture'}]);assert.equal(answer.content,'ok');
 assert.equal(r.price(p),null);
 const api=profile({authMode:undefined,accountId:undefined});r.save({profiles:[api],routes:{main:{primary:'chatgpt'}}},1);assert.throws(()=>r.setKey('chatgpt','paid-secret',p.identity),/変更/);r.setKey('chatgpt','paid-secret');r.save({profiles:[profile()],routes:{main:{primary:'chatgpt'}}},2);assert.equal(store.value('provider-keys').chatgpt,undefined);
});

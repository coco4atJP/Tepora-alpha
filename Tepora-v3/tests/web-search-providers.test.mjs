import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WebTools,SEARCH_PROVIDERS,SEARCH_KEY_ENVS,webSearchConfig} from '../core/tools/web.mjs';
const fixtures=JSON.parse(await readFile(new URL('./fixtures/web-search-providers.json',import.meta.url),'utf8'));
const key='fixture-search-key';
function fixture(provider,{response={},status=200,fail,browser=null,keys=()=>key}={}){
 const calls=[];
 const network={async request(url,init,scope){calls.push({url,init,scope});if(fail)throw fail;return new Response(typeof response==='string'?response:JSON.stringify(response),{status,headers:{'Content-Type':'application/json'}});}};
 return {calls,web:new WebTools({network,settings:()=>({webSearch:{provider}}),keys,browser})};
}
for(const f of fixtures)test(`${f.provider}: official request shape and normalized results`,async()=>{
 const {web,calls}=fixture(f.provider,{response:f.response});
 assert.deepEqual(await web.search('日本語 a&b',{count:2}),{provider:f.provider,results:f.expected});
 assert.equal(calls.length,1);const {url,init,scope}=calls[0],u=new URL(url);
 assert.equal(u.origin+u.pathname,f.url);assert.equal(init.method,f.method);
 assert.equal(scope.purpose,'web-tool');assert.equal(scope.timeoutMs,30000);assert.equal(scope.maxBytes,2_000_000);assert.equal(scope.redirects,false);
 if(f.body){assert.deepEqual(JSON.parse(init.body),f.body);assert.equal(new Headers(init.headers).get(f.header),f.auth);assert.ok(!url.includes(key));}
 else {assert.equal(u.searchParams.get('engine'),'google');assert.equal(u.searchParams.get('q'),'日本語 a&b');assert.equal(u.searchParams.get('api_key'),key);assert.equal(init.body,undefined);}
});
for(const provider of fixtures.map(f=>f.provider))test(`${provider}: no fallback, missing keys, empty, malformed, HTTP, timeout and cancellation`,async()=>{
 const browser={render(){assert.fail('An explicitly selected service must not send the query elsewhere');}};
 const missing=fixture(provider,{browser,keys:()=>''});
 // Explicit absent env names avoid reading any actual user credential.
 missing.web.config=()=>webSearchConfig({provider,[`${provider}KeyEnv`]:'TEPORA_WEB_TEST_ABSENT_649213'});
 await assert.rejects(missing.web.search('test'),/APIキー/);assert.equal(missing.calls.length,0);
 const field=provider==='serper'?'organic':provider==='serpapi'?'organic_results':'results';
 assert.deepEqual((await fixture(provider,{response:{[field]:[]},browser}).web.search('empty')).results,[]);
 for(const opts of [{status:401,response:{error:key}},{status:429},{status:500},{response:`not json ${key}`},{response:{error:key}},{response:{[field]:{bad:key}}},{fail:new Error(`GET https://example.org/?api_key=${key}`)},{fail:Object.assign(new Error(key),{name:'TimeoutError'})}]){
  const {web,calls}=fixture(provider,{...opts,browser});await assert.rejects(web.search('test'),e=>!e.message.includes(key)&&e.message.includes(provider));assert.equal(calls.length,1);
 }
 const controller=new AbortController();controller.abort(new Error('Stopped'));
 await assert.rejects(fixture(provider,{fail:controller.signal.reason}).web.search('test',{signal:controller.signal}),/Stopped/);
});
test('provider/settings contract preserves defaults, auto routing and partial custom environment names',()=>{
 assert.deepEqual(SEARCH_PROVIDERS,['auto','brave','searxng','duckduckgo','tavily','exa','serper','serpapi']);
 for(const provider of fixtures.map(f=>f.provider))assert.equal(webSearchConfig({provider})[`${provider}KeyEnv`],SEARCH_KEY_ENVS[provider]);
 assert.equal(webSearchConfig({provider:'exa'},{exaKeyEnv:'CUSTOM_EXA'}).exaKeyEnv,'CUSTOM_EXA');
 for(const value of [null,[],{provider:'google-cse'},{tavilyKeyEnv:8},{exaKeyEnv:'x'.repeat(2001)}])assert.throws(()=>webSearchConfig(value));
 const web=new WebTools({settings:()=>({webSearch:{braveKeyEnv:'TEPORA_WEB_TEST_ABSENT_649213'}}),keys:p=>p==='brave'?'':key});
 assert.equal(web.provider(),'duckduckgo');
});

test('saved additional keys take precedence over custom environment names',async()=>{
 const env='TEPORA_WEB_TEST_KEY_649213';process.env[env]='fixture-env-key';
 try{for(const provider of fixtures.map(f=>f.provider)){
  const {web,calls}=fixture(provider,{keys:()=>''});web.config=()=>webSearchConfig({provider,[`${provider}KeyEnv`]:env});
  await web.search('environment');const first=calls[0];
  assert.equal(provider==='serpapi'?new URL(first.url).searchParams.get('api_key'):new Headers(first.init.headers).get(provider==='tavily'?'authorization':'x-api-key'),provider==='tavily'?'Bearer fixture-env-key':'fixture-env-key');
  web.keys=()=>key;assert.equal(web.key(provider),key);
 }}finally{delete process.env[env];}
});

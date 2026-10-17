import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedPiModels,storedPiCatalog,supportedPiApi} from '../core/pi-model-catalog.mjs';
const original={id:'baseline',name:'Synthetic baseline',provider:'fixture',api:'openai-completions',baseUrl:'https://provider.invalid/v1',input:['text'],reasoning:false,contextWindow:64000,maxTokens:8192,cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0.2}};
const catalog={getProvider:id=>id==='fixture'?{baseUrl:original.baseUrl,getModels:()=>[original]}:undefined};
const model=()=>({...structuredClone(original),id:'new-model',thinkingLevelMap:{low:'small',high:'large'},compat:{supportsDeveloperRole:false},headers:{'x-fixture-version':'1'}});
test('catalog keeps exact inert SDK metadata without filling in absent fields',()=>{
 const input=model(),output=checkedPiModels('fixture',[input],catalog);assert.deepEqual(output,[input]);assert.notEqual(output[0],input);assert.equal(Object.hasOwn(output[0],'promptCache'),false);output[0].compat.supportsDeveloperRole=true;assert.equal(input.compat.supportsDeveloperRole,false);
});
test('catalog rejects unsupported APIs and provider/operation mismatches',()=>{
 for(const api of ['bedrock-converse-stream','google-vertex','unknown-native','anthropic-messages'])assert.throws(()=>checkedPiModels('fixture',[{...model(),api}],catalog));
 assert.equal(supportedPiApi('bedrock-converse-stream'),false);assert.equal(supportedPiApi('google-vertex'),false);assert.equal(supportedPiApi('unknown-native'),false);
 for(const change of [{provider:'other'},{type:'image'},{type:'classifier'},{type:null},{type:''},{transport:'websocket'}])assert.throws(()=>checkedPiModels('fixture',[{...model(),...change}],catalog));
});
test('model metadata cannot expand registered endpoint or credential scope',()=>{
 for(const baseUrl of ['http://provider.invalid/v1','https://evil.invalid/v1','https://provider.invalid/v2','https://user:password@provider.invalid/v1','https://provider.invalid/v1?key=secret','https://provider.invalid/v1#fragment'])assert.throws(()=>checkedPiModels('fixture',[{...model(),baseUrl}],catalog));
 for(const key of ['authorization','cookie','x-api-key','proxy-authorization','host','content-length'])assert.throws(()=>checkedPiModels('fixture',[{...model(),headers:{[key]:'synthetic-secret'}}],catalog));
 assert.throws(()=>checkedPiModels('fixture',[{...model(),compat:JSON.parse('{"__proto__":{"polluted":true}}')}],catalog));assert.equal({}.polluted,undefined);
});
test('malformed, duplicate and oversized metadata fails before publication',()=>{
 for(const change of [{id:''},{id:'x'.repeat(161)},{contextWindow:NaN},{contextWindow:0},{maxTokens:0},{input:['audio']},{input:['text','text']},{reasoning:undefined},{cost:{input:1,output:2}},{cost:{...original.cost,tiers:null}},{cost:{...original.cost,tiers:false}},{cost:{input:Infinity,output:2,cacheRead:0,cacheWrite:0}}])assert.throws(()=>checkedPiModels('fixture',[{...model(),...change}],catalog));
 assert.throws(()=>checkedPiModels('fixture',[model(),model()],catalog));assert.throws(()=>checkedPiModels('fixture',Array.from({length:2049},(_,i)=>({...model(),id:String(i)})),catalog));
 assert.throws(()=>checkedPiModels('fixture',[{...model(),compat:{huge:'x'.repeat(16001)}}],catalog));
});
test('empty snapshots stay authoritative and SDK version changes require refresh',()=>{
 const snapshot={schema:1,version:'1.3.0',at:'2026-10-17T00:00:00.000Z',models:[]};assert.deepEqual(storedPiCatalog(snapshot,'fixture',catalog,'1.3.0'),snapshot);
 assert.equal(storedPiCatalog(snapshot,'fixture',catalog,'2.0.0'),null);assert.equal(storedPiCatalog(undefined,'fixture',catalog,'1.3.0'),null);
 for(const change of [{schema:2},{at:'bad-date'},{models:null},{extra:true}])assert.throws(()=>storedPiCatalog({...snapshot,...change},'fixture',catalog,'1.3.0'));
});
test('Azure empty endpoint sentinel stays inert and never authorizes a new endpoint',()=>{
 const azure={...original,provider:'azure',baseUrl:''},azureCatalog={getProvider:id=>id==='azure'?{auth:{apiKey:{}},getModels:()=>[azure]}:catalog.getProvider(id)};
 assert.deepEqual(checkedPiModels('azure',[azure],azureCatalog),[azure]);
 for(const baseUrl of ['https://unregistered.azure.invalid/v1','http://localhost:1234'])assert.throws(()=>checkedPiModels('azure',[{...azure,baseUrl}],azureCatalog));
 assert.throws(()=>checkedPiModels('fixture',[{...model(),baseUrl:''}],catalog));
 const oauthCatalog={getProvider:()=>({auth:{oauth:{}},getModels:()=>[azure]})};assert.throws(()=>checkedPiModels('azure',[azure],oauthCatalog));
});
test('Radius gateway labels remain inert and cannot contain credentials or endpoint instructions',()=>{
 const radius={...original,provider:'radius',lab:'Synthetic lab',enabled:true,providers:[{id:'fireworks',name:'Fireworks AI',credential:'radius',source:'radius'}]},radiusCatalog={getProvider:id=>id==='radius'?{getModels:()=>[radius]}:catalog.getProvider(id)};
 assert.deepEqual(checkedPiModels('radius',[radius],radiusCatalog),[radius]);
 for(const change of [{credential:'synthetic-token'},{source:'evil'},{baseUrl:'https://evil.invalid'},{token:'synthetic-token'}])assert.throws(()=>checkedPiModels('radius',[{...radius,providers:[{...radius.providers[0],...change}]}],radiusCatalog));
 assert.throws(()=>checkedPiModels('radius',[{...radius,baseUrl:''}],radiusCatalog));
 assert.throws(()=>checkedPiModels('radius',[{...radius,enabled:'yes'}],radiusCatalog));
 for(const extra of [{lab:'Synthetic lab'},{enabled:true},{providers:[]}])assert.throws(()=>checkedPiModels('fixture',[{...model(),...extra}],catalog));
});

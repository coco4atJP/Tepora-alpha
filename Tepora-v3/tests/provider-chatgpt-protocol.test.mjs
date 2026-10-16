import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeRequest,decodeResponse,ProtocolClient} from '../core/provider-protocols.mjs';
import {validateProfile} from '../core/provider-registry.mjs';
const p=validateProfile({id:'chatgpt',protocol:'responses',model:'fixture',baseUrl:'https://api.openai.com/v1',domain:'cloud',authMode:'chatgpt',accountId:'chatgpt-11111111-1111-4111-8111-111111111111',sampling:{temperature:0.5,top_p:0.8},reasoningEffort:'high'});
const tools=[{type:'function',function:{name:'read',description:'Read a local fixture',parameters:{type:'object',properties:{}}}}];
test('ChatGPT uses public Responses, complete history, namespaces, and only supported parameters',()=>{
 const input=[{role:'system',content:'trusted instructions'},{role:'user',content:'hello'},{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'c1',content:'fixture result'}];
 const body=encodeRequest(p,input,{tools,maxTokens:1000,sampling:{temperature:0.5,top_p:0.8},cacheKey:'fixture-cache',cacheRetention:'long'});
 assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.instructions,'trusted instructions');assert.ok(body.input.every(x=>x.role!=='system'));
 assert.equal(body.tools[0].type,'namespace');assert.equal(body.tools[0].name,'tepora');assert.equal(body.tools[0].tools[0].name,'read');assert.equal(body.input.find(x=>x.type==='function_call').namespace,'tepora');
 for(const key of ['max_output_tokens','temperature','top_p','prompt_cache_retention','previous_response_id','background','metadata'])assert.equal(Object.hasOwn(body,key),false,key);
 assert.equal(body.reasoning.effort,'high');assert.equal(body.prompt_cache_key,'fixture-cache');
 assert.throws(()=>encodeRequest({...p,baseUrl:'https://attacker.invalid/v1'},input,{tools}));
});
test('subscription completion keeps replay items and rejects foreign namespaces/incomplete output',async()=>{
 const response={status:'completed',output:[{type:'function_call',call_id:'a',name:'read',namespace:'tepora',arguments:'{}'}]};const result=await decodeResponse(p,response);assert.equal(result.tool_calls[0].function.name,'read');assert.equal(result._native.items[0].namespace,'tepora');
 await assert.rejects(decodeResponse(p,{...response,output:[{...response.output[0],namespace:'other'}]}),/namespace/);
 await assert.rejects(decodeResponse(p,{...response,status:'incomplete'}),/complete/);
 const stream=new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',{headers:{'content-type':'text/event-stream'}});
 await assert.rejects(new ProtocolClient(p,'fixture',async()=>stream).chat([{role:'user',content:'x'}]),/completion/);
});
test('ordinary paid Responses retain existing parameter behavior',()=>{
 const api=validateProfile({id:'api',protocol:'responses',model:'fixture',baseUrl:'https://api.openai.com/v1',domain:'cloud'});
 const body=encodeRequest(api,[{role:'user',content:'fixture'}],{tools,maxTokens:1000,sampling:{temperature:0.5},cacheRetention:'long'});assert.equal(body.max_output_tokens,1000);assert.equal(body.temperature,0.5);assert.equal(body.tools[0].type,'function');assert.equal(body.prompt_cache_retention,'24h');
});

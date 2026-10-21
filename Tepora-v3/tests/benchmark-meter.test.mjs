import test from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkMeter,CHAT_BASE,redact,summarizeCases} from '../scripts/benchmark-meter.mjs';

test('benchmark does not turn a missing or blocked case into a success',()=>{
 const r=summarizeCases([{status:'passed',latencyMs:10},{status:'blocked',latencyMs:2}],3);
 assert.equal(r.complete,false);assert.equal(r.passRate,1/3);assert.equal(r.missing,1);assert.equal(r.blocked,1);
 assert.equal(summarizeCases([],0).complete,false);
});
test('benchmark credentials stay at the allowlisted dispatch boundary and budgets block before sending',async()=>{
 let sent=0;const meter=benchmarkMeter({keys:{opencode:'private-test-key'},maxUsd:.01,maxRequests:1,transport:async(_a,init)=>{
  sent++;assert.equal(new Headers(init.headers).get('Authorization'),'Bearer private-test-key');
  return new Response('data: {"model":"step-5-preview","usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":100}}}\n\ndata: [DONE]\n\n');
 }});
 const body=JSON.stringify({model:'step-5-preview',max_tokens:1000,messages:[]}),admitted={url:new URL(CHAT_BASE+'/chat/completions')};
 const headers={Authorization:'Bearer private-test-key','x-opencode-session':'fixture','User-Agent':'Tepora/3.0 test'};
 await (await meter.request(admitted,{body,headers},{})).text();
 assert.equal(meter.snapshot().usageEstimateUsd,.00145);assert.equal(meter.calls[0].cachedTokens,100);
 assert.ok(Math.abs(meter.snapshot().reservedUsd-.00145)<1e-12,'unused dispatch reservation is released after known usage');
 await assert.rejects(meter.request(admitted,{body,headers},{}),/budget exhausted/);assert.equal(sent,1);
 await assert.rejects(meter.request({url:new URL('https://example.org/steal')},{body},{}),/permits only/);assert.equal(sent,1);
 assert.ok(!JSON.stringify(meter.snapshot()).includes('private-test-key'));
});
test('benchmark redacts exact secrets and known credential prefixes in report errors',()=>{
 assert.equal(redact({error:'private-test-key oc_sk_fake_123 apikey_fake_456'},['private-test-key']),'{"error":"[REDACTED] [REDACTED] [REDACTED]"}');
});
test('Responses models use their own endpoint and nested streamed usage for budget settlement',async()=>{
 let sent=0;const meter=benchmarkMeter({keys:{opencode:'synthetic-key'},maxUsd:.01,transport:async()=>{
  sent++;return new Response('data: '+JSON.stringify({type:'response.completed',response:{model:'muse-spark-1.3-contributor',usage:{input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:100}}}})+'\n\n');
 }});
 const headers={Authorization:'Bearer synthetic-key','x-opencode-session':'fixture','User-Agent':'Tepora/3.0 test'},body=JSON.stringify({model:'muse-spark-1.3-contributor',max_output_tokens:4096,input:[]});
 await (await meter.request({url:new URL(CHAT_BASE+'/responses')},{body,headers},{})).text();
 assert.ok(Math.abs(meter.snapshot().usageEstimateUsd-.0001302)<1e-12);assert.ok(Math.abs(meter.snapshot().reservedUsd-.0001302)<1e-12);assert.equal(meter.calls[0].resolvedModel,'muse-spark-1.3-contributor');
 await assert.rejects(meter.request({url:new URL(CHAT_BASE+'/chat/completions')},{body,headers},{}),/registered protocol/);
 await assert.rejects(meter.request({url:new URL(CHAT_BASE+'/responses')},{body:JSON.stringify({model:'mimo-v2.6-flash',max_output_tokens:4096}),headers},{}),/registered protocol/);
 await assert.rejects(meter.request({url:new URL(CHAT_BASE+'/responses')},{body:JSON.stringify({model:'muse-spark-1.3-contributor',max_output_tokens:8193}),headers},{}),/Invalid output limit/);assert.equal(sent,1);
});

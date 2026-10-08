// Read-only JavaScript oracle generation. Production native service never runs Node.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {validateProfile} from '../../core/provider-registry.mjs';
const cases=[];
const protocols=['chat-completions','responses','anthropic','gemini'];
const addresses=[['device','http://LOCALHOST:80/v1/'],['device','http://[::1]:12345/v1'],['device','http://127.0.0.2:8080/api'],['cloud','https://EXAMPLE.com:443/v1/'],['cloud','https://go.opencode.ai/v1'],['lan','http://192.168.1.2:9999/v1'],['lan','https://inference.lan/api']];
for(const protocol of protocols)for(const [domain,baseUrl] of addresses)for(const variant of [0,1,2,3]){
 const raw={id:`p${cases.length}`,protocol,baseUrl,model:variant===2?'  モデル😀\uD800\uE000  ':'model',domain};
 if(domain==='lan')Object.assign(raw,{pinnedAddress:'192.168.1.2',allowPlainHttp:true});
 if(variant===1)Object.assign(raw,{name:'\uFEFF name \uFEFF',sampling:{top_p:1,temperature:0.3,seed:2147483647},contextTokens:4096,maxTokens:256,maxParallel:2,capabilities:{vision:false,tools:true}});
 if(variant===2)Object.assign(raw,{sampling:{seed:0,repeat_penalty:0.5,top_k:1000,min_p:0},cache:false,apiKeyEnv:'TEPORA_TEST_KEY',resource:'shared',reasoningEffort:'high',thinkingBudget:1024,sessionHeader:'x-tepora-test'});
 if(variant===3)Object.assign(raw,{name:'a\u0085',maxTokens:null,contextTokens:null,firstByteTimeoutMs:3600000,idleTimeoutMs:1000,server:'llama.cpp',enabled:false});
 cases.push({raw,expected:validateProfile(raw)});
}
const fixture={source:'core/provider-registry.mjs',sourceHash:createHash('sha256').update(readFileSync(new URL('../../core/provider-registry.mjs',import.meta.url))).digest('hex'),cases};
writeFileSync(new URL('../src/provider/fixtures/profiles.json',import.meta.url),JSON.stringify(fixture,null,2)+'\n');
console.log(`Wrote ${cases.length} provider profile cases`);

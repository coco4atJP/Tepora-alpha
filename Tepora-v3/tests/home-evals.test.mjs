import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateScenario,utteranceAudio,digest,llmCost,summarize,compare} from '../scripts/home-scenario.mjs';

const scenario=JSON.parse(await readFile(new URL('../evals/home-days.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(scenario);

test('home scenario: the shipped days are valid and exercise memory, recall and barge-in',()=>{
 assert.equal(validateScenario(clone()).days.length,3);
 const broken=[
  s=>{s.days=[s.days[0]];},
  s=>{s.costs.wake=-1;},
  s=>{s.days[1].turns[0].id=s.days[0].turns[0].id;},
  s=>{s.days[0].turns[0].seconds=10;},
  s=>{s.days[2].turns[0].recall.expect='麦茶';},
  s=>{s.days=[s.days[2],s.days[1],s.days[0]];},
  s=>{s.days[0].turns[2].interruptedBy.recall={query:'a',expect:'b'};},
 ];
 for(const change of broken){const s=clone();change(s);assert.throws(()=>validateScenario(s));}
});

test('home scenario: utterance audio is a small deterministic WAV, distinct per utterance',()=>{
 const [a,b]=scenario.days[0].turns,wav=utteranceAudio(a);
 assert.equal(wav.toString('latin1',0,4),'RIFF');assert.equal(wav.toString('latin1',8,12),'WAVE');
 assert.equal(wav.length,44+Math.round(a.seconds*8000)*2);assert.ok(wav.length<64000);
 assert.equal(digest(utteranceAudio(a)),digest(wav));assert.notEqual(digest(utteranceAudio(b)),digest(wav));
 assert.equal(llmCost({llmFirstToken:300,llmPerChar:2},'日本😀'),306);
});

test('home summary: budget, failures and unsolicited speech fail; wall time never counts as a host difference',()=>{
 const turns=[{id:'a',kind:'talk',ok:true,wakeToAudioMs:900,wallMs:10},{id:'b',kind:'recall',ok:true,wakeToAudioMs:1200,wallMs:20}];
 const node=summarize('node',turns,{unsolicited:0,budget:1600});
 assert.equal(node.passed,true);assert.deepEqual(node.metrics.wakeToAudioMs,{p50:900,max:1200,budget:1600,over:0});assert.deepEqual(node.metrics.recall,{tried:1,ok:1});
 assert.equal(summarize('node',turns,{unsolicited:0,budget:1000}).passed,false);
 assert.equal(summarize('node',turns,{unsolicited:1,budget:1600}).passed,false);
 assert.equal(summarize('node',[{...turns[0],ok:false}],{unsolicited:0,budget:1600}).passed,false);
 assert.deepEqual(compare(node,summarize('native',turns.map(t=>({...t,wallMs:t.wallMs*9})),{unsolicited:0,budget:1600})),[]);
 const slower=summarize('native',[turns[0],{...turns[1],wakeToAudioMs:1550}],{unsolicited:0,budget:1600});
 assert.deepEqual(compare(node,slower),[{path:'metrics.wakeToAudioMs.max',node:1200,native:1550},{path:'turns.1.wakeToAudioMs',node:1200,native:1550}]);
});

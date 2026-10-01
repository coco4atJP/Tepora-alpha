/** Optional real-worker integration. Uses deterministic model/decision fixtures, real Chromium,
 * Python RPC, controlled UI actions and filesystem artifacts. Does not log in or access public sites.
 * Requires Python+Playwright and an existing Chromium/Chrome/Edge binary. No automatic downloads.
 */
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {Store} from '../core/store.mjs';
import {Harness} from '../core/harness.mjs';
import {Connectors} from '../core/connectors.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
const out=path.resolve(process.argv[2]||'validation/computer-live');await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-live-computer-')),store=new Store(dir),network=new NetworkPolicy(store),checks=[],approvals=[];
const pngDecoderChecks=[];let decisionCalls=0,lastObservation,selected=null,fullResult='',step=0;
const modelTool=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:`fixture-${++step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const decisionServer=http.createServer(async(req,res)=>{let body='';for await(const bytes of req)body+=bytes;
 const q=JSON.parse(body);decisionCalls++;const nodes=q.state.controls;
 const choice=nodes.find(n=>n.role==='input').id,labels=Object.keys(q.questions.target.criteria),probabilities=Object.fromEntries(labels.map(l=>[l,l===choice?1:0]));
 res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'deterministic-decision-fixture',answers:{target:{type:'choice',choice,probabilities,confidence:1}}}));
});await new Promise(r=>decisionServer.listen(0,'127.0.0.1',r));
store.settings={...store.settings,decisionUrl:`http://127.0.0.1:${decisionServer.address().port}/v1/systemone`,decisionModel:'multilingual'};
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline form fixture</title><body><label>Name<input name="name" aria-label="Name"></label><button onclick="document.querySelector('output').textContent='Hello '+document.querySelector('input').value">Greet</button><input type="password" value="not-observable" aria-label="Password"><output></output></body></html>`;
const h=new Harness(store,new Connectors(store,network),{network,runtimeFactory:()=>({chat:async messages=>{
 const results=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
 if(!results.length)return modelTool('artifact_publish',{title:'Local form',kind:'html',content:html});
 if(results.length===1)return modelTool('computer_open',{htmlArtifactId:results[0].id});
 if(results.length===2){lastObservation=results[1];return modelTool('computer_choose',{question:'Enter a name',candidateIds:lastObservation.nodes.filter(n=>n.role==='input'&&n.actions.length).map(n=>n.id)});}
 if(results.length===3){assert.equal(results[2].permission,false);assert.equal(results[2].executed,false);selected=results[2].answers.target.choice;return modelTool('computer_action',{revision:lastObservation.revision,target:selected,operation:'fill',value:'Tepora'});}
 if(results.length===4){lastObservation=results[3].observation;return modelTool('computer_action',{revision:lastObservation.revision,target:lastObservation.nodes.find(n=>n.role==='button').id,operation:'click'});}
 if(results.length===5){lastObservation=results[4].observation;assert.match(lastObservation.text,/Hello Tepora/);const shot=await h.computer.session.rpc.request('screenshot',{});await writeFile(path.join(out,'controlled-form.png'),Buffer.from(shot.base64,'base64'));return modelTool('code_compute',{code:'return input.values.reduce((a,b)=>a+b,0)',input:{values:[2,3,5]}});}
 if(results.length===6){assert.equal(results[5].result,10);fullResult=lastObservation.text+'; computed total '+results[5].result;return modelTool('artifact_publish',{title:'Verified form result',kind:'text',content:fullResult});}
 return {role:'assistant',content:'操作結果を観測し、合計10を計算しました。'};
}})});
try{
 h.computer.save({enabled:true,headless:true,python:process.env.TEPORA_TEST_PYTHON||'python',browserExecutable:process.env.CHROMIUM_PATH||''},0);
 network.change({mode:'offline'},0);
 store.listeners.add(e=>{if(e.type==='job.updated'&&e.data.approval){const p=e.data.approval;
  // Only exact deterministic fixture operations, never general approval automation for real tasks.
  assert.ok(['computer_open','computer_action'].includes(p.name));approvals.push(p.name);queueMicrotask(()=>h.approve(p.id,true));}});
 const job=h.submit('Use the provided local form, compute 2+3+5, publish the actual observed result','work',{checks:[{type:'artifact',any:true,contains:'computed total 10'}]});
 const start=Date.now();while(h.active.size){if(Date.now()-start>45000)throw new Error('Live harness did not finish');await new Promise(r=>setTimeout(r,30));}
 const result=store.get('job',job.id);assert.equal(result.status,'review',JSON.stringify(result));assert.equal(result.verification.checks.status,'checks-passed');
 assert.equal(decisionCalls,1);assert.deepEqual(approvals,['computer_open']);
 assert.equal(h.computer.session,null);assert.equal(h.computer.computing.size,0);assert.equal(network.active.size,0);
 checks.push('harness → local HTML → observed controls → local decision fixture → bounded delegated offline fill/click → post-action observation → offline compute → checked artifact');
 const password=lastObservation.nodes.find(n=>n.type==='password');assert.deepEqual(password.actions,[]);assert.equal(password.value,'[protected]');assert.ok(!JSON.stringify(lastObservation).includes('not-observable'));
 checks.push('password content is masked and excluded from action candidates');
 const compute=await h.computer.compute({code:'return [typeof process,typeof require,typeof document,typeof window]',input:null},AbortSignal.timeout(15000));
 assert.deepEqual(compute.result,['undefined','undefined','undefined','undefined']);checks.push('contained JavaScript exposes no Node process/require or browser document/window');
 const noNet=await h.computer.compute({code:'try { await fetch("https://example.org/"); return "unexpected-network"; } catch { return "blocked"; }',input:null},AbortSignal.timeout(15000));
 assert.equal(noNet.result,'blocked');checks.push('offline computation cannot fetch an external URL');
 await assert.rejects(h.computer.compute({code:'while(true){}',input:null,timeoutMs:100},AbortSignal.timeout(15000)),/deadline/);
 assert.equal(h.computer.computing.size,0);checks.push('infinite JavaScript terminates at its time budget and releases the worker');
 // Actual worker rejects stale observations, including when bypassing the cached Node precheck in this test.
 const j={id:'manual-fixture'};store.artifact('Fixture',html,{id:'local-fixture',kind:'html',jobId:j.id});
 let observation=await h.computer.open(j,{htmlArtifactId:'local-fixture'},AbortSignal.timeout(15000));const first=observation;
 observation=(await h.computer.act(j,{revision:observation.revision,target:observation.nodes.find(n=>n.role==='input'&&n.actions.length).id,operation:'fill',value:'Changed'},AbortSignal.timeout(10000))).observation;
 await assert.rejects(h.computer.session.rpc.request('act',{revision:first.revision,target:first.nodes.find(n=>n.role==='button').id,operation:'click'},AbortSignal.timeout(10000)),/STALE_OBSERVATION/);
 h.computer.close(j.id);checks.push('Python worker independently rejects a stale observed screen before acting');
 const report={passed:true,checks,approvals,model:'deterministic fixture, NOT a learned model',decision:'deterministic System One fixture, NOT Laya weights',execution:'actual Python+Chromium, Node harness, HTTP and SQLite',networkMode:'offline',externalNetworkCalls:0,windowsUIATested:false,at:new Date().toISOString()};
 await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));await writeFile(path.join(out,'artifact.txt'),fullResult);console.log(JSON.stringify(report,null,2));
}finally{h.close();while(h.active.size)await new Promise(r=>setTimeout(r,20));network.close();store.close();decisionServer.closeAllConnections();await new Promise(r=>decisionServer.close(r));await rm(dir,{recursive:true,force:true});}

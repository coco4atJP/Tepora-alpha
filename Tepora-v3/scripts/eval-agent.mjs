/** Opt-in real local-model evaluation. This script never uses a cloud endpoint or host commands. */
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Store} from '../core/store.mjs';
import {Harness} from '../core/harness.mjs';
import {Connectors} from '../core/connectors.mjs';
import {endpoint,invariant} from '../core/policy.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),get=key=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
const cases=JSON.parse(await readFile(path.join(root,'evals/workflows.json'),'utf8'));
if(args.includes('--list')){console.log(JSON.stringify(cases,null,2));process.exit(0);}
invariant(args.includes('--run'),'Pass --list to inspect the tasks or --run to use your local model.');
const url=get('--url'),model=get('--model');endpoint(url,false);invariant(model,'Select an explicit model');
const directory=await mkdtemp(path.join(os.tmpdir(),'tepora-real-eval-'));
const store=new Store(directory);store.settings={...store.settings,baseUrl:url,model,maxSteps:20,maxTokens:2048,concurrency:1};
const h=new Harness(store,new Connectors(store));
const original=h.toolsFor.bind(h);const permitted=new Set(['artifact_publish','artifact_read','workspace_write','workspace_read','workspace_list','task_note','evidence_read']);
h.toolsFor=job=>original(job).filter(t=>permitted.has(t.function.name));
const results=[];
try{
 for(const c of cases){
  const started=performance.now();const j=h.submit(c.input,'work',{checks:c.checks,isolated:true});
  while(h.active.has(j.id)||h.queue.some(x=>x.id===j.id)){
   if(performance.now()-started>180000){h.cancel(j.id);break;}
   await new Promise(r=>setTimeout(r,50));
  }
  while(h.active.has(j.id))await new Promise(r=>setTimeout(r,20));
  const end=store.get('job',j.id);
  const result={id:c.id,jobId:j.id,status:end.status,passed:end.verification?.checks?.passed===true,checks:end.verification?.checks,
    latencyMs:Math.round(performance.now()-started),modelSteps:end.step,error:end.status==='failed'?end.note:undefined};
  results.push(result);console.log(JSON.stringify(result));
 }
}finally{
 h.close();while(h.active.size)await new Promise(r=>setTimeout(r,20));
 const report={schema:1,version:'3.0.0-beta.11',model,url,platform:process.platform,architecture:process.arch,
  realModel:true,localOnly:true,hostCommandsAllowed:false,createdAt:new Date().toISOString(),
  passed:results.filter(r=>r.passed).length,total:cases.length,results,
  limitations:'A small, unblinded regression suite. Not a comparison with other agents or proof of general capability.'};
 const output=get('--out')||path.join(directory,'report.json');await writeFile(output,JSON.stringify(report,null,2));store.close();
 console.log(JSON.stringify({report:output,workspace:directory,passed:report.passed,total:report.total}));
}
